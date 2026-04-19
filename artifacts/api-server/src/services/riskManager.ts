import {
  db,
  paperBetsTable,
  complianceLogsTable,
  learningNarrativesTable,
  agentConfigTable,
  drawdownEventsTable,
} from "@workspace/db";
import { eq, inArray, desc, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getConfigValue,
  setConfigValue,
  getBankroll,
  getAgentStatus,
} from "./paperTrading";

const currentEnv = process.env["ENVIRONMENT"] ?? "development";
const isDevMode = currentEnv !== "production";

async function setAgentStatus(
  status: string,
  reason: string,
  details: Record<string, unknown>,
): Promise<void> {
  const previous = await getAgentStatus();
  if (previous === status) return;

  await setConfigValue("agent_status", status);

  await db.insert(complianceLogsTable).values({
    actionType: "risk_event",
    details: {
      previousStatus: previous,
      newStatus: status,
      reason,
      ...details,
    },
    timestamp: new Date(),
  });

  await db.insert(learningNarrativesTable).values({
    narrativeType: "risk_circuit_breaker",
    narrativeText: `Agent status changed from "${previous}" to "${status}": ${reason}`,
    relatedData: details,
  });

  logger.warn({ previous, newStatus: status, reason }, "Circuit breaker fired");
}

async function logDrawdownEvent(
  eventType: string,
  hwm: number,
  bankroll: number,
  drawdownPct: number,
  limitPct: number,
  wouldHaveTriggered: boolean,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(drawdownEventsTable).values({
    environment: currentEnv,
    eventType,
    highWaterMark: String(hwm),
    currentBankroll: String(bankroll),
    drawdownPct: String(drawdownPct),
    limitPct: String(limitPct),
    wouldHaveTriggered: wouldHaveTriggered ? "true" : "false",
    details,
  });
}

async function getHighWaterMark(): Promise<number> {
  const val = await getConfigValue("high_water_mark");
  return val ? Number(val) : 5000;
}

async function updateHighWaterMark(bankroll: number): Promise<number> {
  const current = await getHighWaterMark();
  if (bankroll > current) {
    await setConfigValue("high_water_mark", String(bankroll));
    await setConfigValue("hwm_updated_at", new Date().toISOString());
    logger.info({ oldHwm: current, newHwm: bankroll }, "High-water mark updated");
    return bankroll;
  }
  return current;
}

// Returns TOTAL WEALTH (available + |exposure|) in live mode, falling back to
// the configured paper bankroll. This is the correct denominator for HWM /
// drawdown checks — counting only "available" treats normal in-flight
// exposure as if it were a realised loss and mis-fires daily/weekly breakers
// (same bug pattern as the catastrophic-drawdown fix at line 244-249, and
// the available-vs-total bugs fixed across the codebase on Apr 17-18 2026).
async function getTotalWealthForRisk(): Promise<number> {
  try {
    const { isLiveMode, getAccountFunds } = await import("./betfairLive");
    if (isLiveMode()) {
      const funds = await getAccountFunds();
      return (funds.availableToBetBalance ?? 0) + Math.abs(funds.exposure ?? 0);
    }
  } catch {
    // Fall through to paper bankroll
  }
  return await getBankroll();
}

async function getTodaysSettledLoss(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(ABS(SUM(${paperBetsTable.settlementPnl}::numeric) FILTER (WHERE ${paperBetsTable.settlementPnl}::numeric < 0)), 0)`,
    })
    .from(paperBetsTable)
    .where(gte(paperBetsTable.settledAt, todayStart));
  return result[0]?.total ?? 0;
}

async function getWeeklySettledLoss(): Promise<number> {
  const weekStart = new Date();
  const day = weekStart.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  weekStart.setUTCDate(weekStart.getUTCDate() - daysToMonday);
  weekStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(ABS(SUM(${paperBetsTable.settlementPnl}::numeric) FILTER (WHERE ${paperBetsTable.settlementPnl}::numeric < 0)), 0)`,
    })
    .from(paperBetsTable)
    .where(gte(paperBetsTable.settledAt, weekStart));
  return result[0]?.total ?? 0;
}

async function getTodaysNetPnl(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${paperBetsTable.settlementPnl}::numeric), 0)`,
    })
    .from(paperBetsTable)
    .where(gte(paperBetsTable.settledAt, todayStart));
  return Number(result[0]?.total ?? 0);
}

async function getWeeklyNetPnl(): Promise<number> {
  const weekStart = new Date();
  const day = weekStart.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  weekStart.setUTCDate(weekStart.getUTCDate() - daysToMonday);
  weekStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${paperBetsTable.settlementPnl}::numeric), 0)`,
    })
    .from(paperBetsTable)
    .where(gte(paperBetsTable.settledAt, weekStart));
  return Number(result[0]?.total ?? 0);
}

export async function checkDailyLoss(): Promise<boolean> {
  const bankroll = await getBankroll();

  if (isDevMode) {
    const limitPct = Number((await getConfigValue("daily_loss_limit_pct")) ?? "0.15");
    const dailyLossLimit = bankroll * limitPct;
    const dailyLoss = await getTodaysSettledLoss();
    if (dailyLoss >= dailyLossLimit) {
      logger.warn(
        { dailyLoss, dailyLossLimit, limitPct, bankroll, mode: "paper" },
        "DEV: Daily loss limit WOULD have triggered — logging only, not pausing",
      );
      await logDrawdownEvent("daily_gross_loss", await getHighWaterMark(), bankroll,
        (dailyLoss / bankroll) * 100, limitPct * 100, true,
        { dailyLoss, dailyLossLimit });
    }
    return false;
  }

  // Use TOTAL WEALTH as the denominator. Available cash alone treats normal
  // in-flight exposure as a realised loss and mis-fires the breaker.
  const totalWealth = await getTotalWealthForRisk();
  const hwm = await updateHighWaterMark(totalWealth);
  const drawdown = hwm > 0 ? ((hwm - totalWealth) / hwm) * 100 : 0;
  const stratExpiresStr = await getConfigValue("strategy_overrides_expire_at");
  const stratActive = stratExpiresStr ? new Date(stratExpiresStr).getTime() > Date.now() : false;
  const dailyOverride = stratActive ? await getConfigValue("strategy_daily_drawdown_limit_pct") : null;
  const dailyLimitPct = Number(dailyOverride ?? (await getConfigValue("daily_drawdown_limit_pct")) ?? "10");

  if (drawdown >= dailyLimitPct) {
    const todayNet = await getTodaysNetPnl();
    if (todayNet < 0) {
      await setAgentStatus("paused_daily", "Daily net drawdown limit reached", {
        highWaterMark: hwm,
        currentTotalWealth: totalWealth,
        currentBankroll: bankroll,
        drawdownPct: drawdown,
        dailyLimitPct,
        todayNetPnl: todayNet,
      });
      await logDrawdownEvent("daily_drawdown_trigger", hwm, totalWealth, drawdown, dailyLimitPct, false,
        { todayNetPnl: todayNet });
      return true;
    }
  }
  return false;
}

export async function checkWeeklyLoss(): Promise<boolean> {
  const bankroll = await getBankroll();

  if (isDevMode) {
    const limitPct = Number((await getConfigValue("weekly_loss_limit_pct")) ?? "0.30");
    const weeklyLossLimit = bankroll * limitPct;
    const weeklyLoss = await getWeeklySettledLoss();
    if (weeklyLoss >= weeklyLossLimit) {
      logger.warn(
        { weeklyLoss, weeklyLossLimit, limitPct, bankroll, mode: "paper" },
        "DEV: Weekly loss limit WOULD have triggered — logging only, not pausing",
      );
      await logDrawdownEvent("weekly_gross_loss", await getHighWaterMark(), bankroll,
        (weeklyLoss / bankroll) * 100, limitPct * 100, true,
        { weeklyLoss, weeklyLossLimit });
    }
    return false;
  }

  // Use TOTAL WEALTH as the denominator (see checkDailyLoss for rationale).
  const totalWealth = await getTotalWealthForRisk();
  const hwm = await updateHighWaterMark(totalWealth);
  const drawdown = hwm > 0 ? ((hwm - totalWealth) / hwm) * 100 : 0;
  const stratExpiresStrW = await getConfigValue("strategy_overrides_expire_at");
  const stratActiveW = stratExpiresStrW ? new Date(stratExpiresStrW).getTime() > Date.now() : false;
  const weeklyOverride = stratActiveW ? await getConfigValue("strategy_weekly_drawdown_limit_pct") : null;
  const weeklyLimitPct = Number(weeklyOverride ?? (await getConfigValue("weekly_drawdown_limit_pct")) ?? "20");

  if (drawdown >= weeklyLimitPct) {
    const weeklyNet = await getWeeklyNetPnl();
    if (weeklyNet < 0) {
      await setAgentStatus("paused_weekly", "Weekly net drawdown limit reached", {
        highWaterMark: hwm,
        currentTotalWealth: totalWealth,
        currentBankroll: bankroll,
        drawdownPct: drawdown,
        weeklyLimitPct,
        weeklyNetPnl: weeklyNet,
      });
      await logDrawdownEvent("weekly_drawdown_trigger", hwm, totalWealth, drawdown, weeklyLimitPct, false,
        { weeklyNetPnl: weeklyNet });
      return true;
    }
  }
  return false;
}

export async function checkBankrollFloor(): Promise<boolean> {
  const bankroll = await getBankroll();

  if (isDevMode) {
    const floor = Number((await getConfigValue("bankroll_floor")) ?? "150");
    if (bankroll <= floor) {
      logger.warn(
        { bankroll, floor, mode: "paper" },
        "DEV: Bankroll floor WOULD have triggered — logging only, not pausing",
      );
      await logDrawdownEvent("bankroll_floor", await getHighWaterMark(), bankroll,
        100, 0, true, { bankroll, floor });
    }
    return false;
  }

  // Use TOTAL WEALTH (available + exposure) for HWM / drawdown — exposure is
  // deployed capital, not a loss. Comparing only "available" causes the
  // breaker to misread normal exposure as catastrophic drawdown (this was
  // halting trading at ~57% exposure on Apr 17 2026 despite being up £14).
  let totalWealth = bankroll;
  try {
    const { isLiveMode, getAccountFunds } = await import("./betfairLive");
    if (isLiveMode()) {
      const funds = await getAccountFunds();
      totalWealth = funds.availableToBetBalance + Math.abs(funds.exposure);
    }
  } catch {
    // Fall back to bankroll (available) if Betfair fetch fails.
  }

  const hwm = await updateHighWaterMark(totalWealth);
  const drawdown = hwm > 0 ? ((hwm - totalWealth) / hwm) * 100 : 0;
  // Threshold raised 50% → 90%: this is a last-resort emergency stop, not a
  // routine exposure limiter. Daily loss (5%) and weekly loss (10%) limits
  // remain the real drawdown controls and are unchanged.
  if (drawdown >= 90) {
    await setAgentStatus("stopped", "Catastrophic drawdown: >90% from high-water mark", {
      highWaterMark: hwm,
      currentBankroll: bankroll,
      currentTotalWealth: totalWealth,
      drawdownPct: drawdown,
    });
    await logDrawdownEvent("catastrophic_drawdown", hwm, totalWealth, drawdown, 90, false);
    return true;
  }
  return false;
}

export async function checkConsecutiveLosses(): Promise<boolean> {
  const lastFive = await db
    .select({
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
    })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost"]))
    .orderBy(desc(paperBetsTable.settledAt))
    .limit(5);

  if (lastFive.length < 5) return false;

  const allLost = lastFive.every((b) => b.status === "lost");
  if (allLost) {
    const totalLoss = lastFive.reduce(
      (sum, b) => sum + Math.abs(Number(b.settlementPnl ?? 0)),
      0,
    );

    if (isDevMode) {
      logger.warn(
        { consecutiveLosses: 5, totalLossInStreak: totalLoss, mode: "paper" },
        "DEV: 5 consecutive losses WOULD have triggered — logging only, not pausing",
      );
      const bankroll = await getBankroll();
      await logDrawdownEvent("consecutive_losses", await getHighWaterMark(), bankroll,
        (totalLoss / bankroll) * 100, 0, true,
        { consecutiveLosses: 5, totalLossInStreak: totalLoss });
      return false;
    }

    await setAgentStatus(
      "paused_streak",
      "5 consecutive losses detected",
      { consecutiveLosses: 5, totalLossInStreak: totalLoss },
    );
    return true;
  }
  return false;
}

export interface RiskCheckResult {
  bankrollFloor: boolean;
  dailyLoss: boolean;
  weeklyLoss: boolean;
  consecutiveLosses: boolean;
  anyTriggered: boolean;
}

export async function runAllRiskChecks(): Promise<RiskCheckResult> {
  logger.debug({ environment: currentEnv, isDevMode }, "Running risk checks");

  if (isDevMode) {
    const agentStatus = await getAgentStatus();
    if (agentStatus !== "running") {
      logger.info({ agentStatus }, "DEV: Auto-resuming agent (circuit breakers disabled in dev)");
      await setConfigValue("agent_status", "running");
    }
  }

  const [bankrollFloor, dailyLoss, weeklyLoss, consecutiveLosses] =
    await Promise.all([
      checkBankrollFloor(),
      checkDailyLoss(),
      checkWeeklyLoss(),
      checkConsecutiveLosses(),
    ]);

  const anyTriggered =
    bankrollFloor || dailyLoss || weeklyLoss || consecutiveLosses;

  if (anyTriggered) {
    logger.warn(
      { bankrollFloor, dailyLoss, weeklyLoss, consecutiveLosses, environment: currentEnv },
      "Risk check triggered a circuit breaker",
    );
  }

  if (isDevMode) {
    await updateHighWaterMark(await getBankroll());
  }

  return { bankrollFloor, dailyLoss, weeklyLoss, consecutiveLosses, anyTriggered };
}

export async function resumeAgent(): Promise<void> {
  const currentStatus = await getAgentStatus();
  if (currentStatus === "running") return;

  if (currentStatus === "stopped" && !isDevMode) {
    logger.warn("Cannot resume a stopped agent in prod — catastrophic drawdown");
    return;
  }

  await setConfigValue("agent_status", "running");

  await db.insert(complianceLogsTable).values({
    actionType: "risk_event",
    details: {
      event: "agent_resumed",
      previousStatus: currentStatus,
      newStatus: "running",
    },
    timestamp: new Date(),
  });

  await db.insert(learningNarrativesTable).values({
    narrativeType: "agent_resumed",
    narrativeText: `Agent manually resumed from status "${currentStatus}"`,
    relatedData: { previousStatus: currentStatus },
  });

  logger.info({ previousStatus: currentStatus }, "Agent resumed");
}

export async function getCircuitBreakerStatus(): Promise<{
  mode: string;
  environment: string;
  agentStatus: string;
  bankroll: number;
  highWaterMark: number;
  hwmUpdatedAt: string | null;
  currentDrawdownPct: number;
  dailyLimit: number;
  weeklyLimit: number;
  todayGrossLoss: number;
  weeklyGrossLoss: number;
  todayNetPnl: number;
  weeklyNetPnl: number;
  recentEvents: Array<Record<string, unknown>>;
}> {
  const [bankroll, hwm, hwmUpdatedAt, agentStatus] = await Promise.all([
    getBankroll(),
    getHighWaterMark(),
    getConfigValue("hwm_updated_at"),
    getAgentStatus(),
  ]);

  const drawdown = hwm > 0 ? ((hwm - bankroll) / hwm) * 100 : 0;

  const [todayGross, weeklyGross, todayNet, weeklyNet] = await Promise.all([
    getTodaysSettledLoss(),
    getWeeklySettledLoss(),
    getTodaysNetPnl(),
    getWeeklyNetPnl(),
  ]);

  const dailyLimit = isDevMode
    ? Number((await getConfigValue("daily_loss_limit_pct")) ?? "0.15") * 100
    : Number((await getConfigValue("daily_drawdown_limit_pct")) ?? "10");
  const weeklyLimit = isDevMode
    ? Number((await getConfigValue("weekly_loss_limit_pct")) ?? "0.30") * 100
    : Number((await getConfigValue("weekly_drawdown_limit_pct")) ?? "20");

  const recentEvents = await db
    .select()
    .from(drawdownEventsTable)
    .where(eq(drawdownEventsTable.environment, currentEnv))
    .orderBy(desc(drawdownEventsTable.createdAt))
    .limit(20);

  const distanceToDailyLimit = Math.max(0, dailyLimit - Math.round(drawdown * 100) / 100);
  const distanceToWeeklyLimit = Math.max(0, weeklyLimit - Math.round(drawdown * 100) / 100);

  return {
    mode: isDevMode ? "paper" : "live",
    environment: currentEnv,
    agentStatus,
    bankroll,
    highWaterMark: hwm,
    hwmUpdatedAt,
    currentDrawdownPct: Math.round(drawdown * 100) / 100,
    dailyLimit,
    weeklyLimit,
    distanceToDailyLimit: Math.round(distanceToDailyLimit * 100) / 100,
    distanceToWeeklyLimit: Math.round(distanceToWeeklyLimit * 100) / 100,
    todayGrossLoss: Number(todayGross),
    weeklyGrossLoss: Number(weeklyGross),
    todayNetPnl: todayNet,
    weeklyNetPnl: weeklyNet,
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      highWaterMark: Number(e.highWaterMark),
      currentBankroll: Number(e.currentBankroll),
      drawdownPct: Number(e.drawdownPct),
      limitPct: Number(e.limitPct),
      wouldHaveTriggered: e.wouldHaveTriggered === "true",
      details: e.details,
      createdAt: e.createdAt,
    })),
  };
}

export { getHighWaterMark, updateHighWaterMark };
