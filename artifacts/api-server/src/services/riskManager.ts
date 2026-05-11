import {
  db,
  paperBetsCurrentView,
  complianceLogsTable,
  learningNarrativesTable,
  agentConfigTable,
  drawdownEventsTable,
} from "@workspace/db";
import { eq, inArray, desc, gte, sql, and } from "drizzle-orm";
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

// 2026-05-10: split paper vs live high-water mark tracking. Pre-fix, both
// modes shared agent_config.high_water_mark, contaminating live circuit
// breakers with paper-era virtual values. Concrete failure: paper-trading
// HWM grew to £31,641 (accumulated paper P&L); when live mode kicked in,
// live totalWealth = £854 but HWM stayed at £31k, computing as 97%
// drawdown → catastrophic_drawdown breaker fired → agent_status='stopped'
// → all live placement halted. Splitting the HWM by mode prevents the
// paper ledger from poisoning live decisions.
async function getHwmKey(): Promise<{ valueKey: string; updatedAtKey: string }> {
  try {
    const { isLiveMode } = await import("./betfairLive");
    if (isLiveMode()) {
      return { valueKey: "live_high_water_mark", updatedAtKey: "live_hwm_updated_at" };
    }
  } catch {
    // Fall through to paper key if betfairLive import fails.
  }
  return { valueKey: "high_water_mark", updatedAtKey: "hwm_updated_at" };
}

async function getHighWaterMark(): Promise<number> {
  const { valueKey } = await getHwmKey();
  const val = await getConfigValue(valueKey);
  // Live HWM defaults to 0 so the first updateHighWaterMark() call
  // establishes a sane baseline from current totalWealth (rather than
  // computing drawdown against a hardcoded 5000 default that may
  // wildly mismatch a small live account).
  if (val) return Number(val);
  return valueKey === "live_high_water_mark" ? 0 : 5000;
}

async function updateHighWaterMark(bankroll: number): Promise<number> {
  const { valueKey, updatedAtKey } = await getHwmKey();
  const current = await getHighWaterMark();
  if (bankroll > current) {
    await setConfigValue(valueKey, String(bankroll));
    await setConfigValue(updatedAtKey, new Date().toISOString());
    logger.info({ oldHwm: current, newHwm: bankroll, key: valueKey }, "High-water mark updated");
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

// 2026-05-11 BUG FIX: all four functions previously summed settlement_pnl
// across paperBetsCurrentView with NO bet_track filter. Paper-rail history
// (£7,750+ of pre-cutover paper-bet losses on a virtual bankroll) was
// being counted as if it were live loss — the weekly check at 19:10 UTC
// fired WEEKLY_LOSS_HIT alleging £9,570 of weekly loss when the actual
// live loss was ~£100. The breaker subsequently flipped live_placement_
// enabled to false at 20:15 UTC, four minutes after the operator turned
// live on. Paper rail is deprecated (cutover 2026-05-09); live-mode risk
// must only consider live bets. Adding bet_track='live' filter to all
// loss/pnl queries restores correct semantics.
const LIVE_TRACK_FILTER = eq(paperBetsCurrentView.betTrack, "live");

async function getTodaysSettledLoss(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(ABS(SUM(${paperBetsCurrentView.settlementPnl}::numeric) FILTER (WHERE ${paperBetsCurrentView.settlementPnl}::numeric < 0)), 0)`,
    })
    .from(paperBetsCurrentView)
    .where(and(gte(paperBetsCurrentView.settledAt, todayStart), LIVE_TRACK_FILTER));
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
      total: sql<number>`COALESCE(ABS(SUM(${paperBetsCurrentView.settlementPnl}::numeric) FILTER (WHERE ${paperBetsCurrentView.settlementPnl}::numeric < 0)), 0)`,
    })
    .from(paperBetsCurrentView)
    .where(and(gte(paperBetsCurrentView.settledAt, weekStart), LIVE_TRACK_FILTER));
  return result[0]?.total ?? 0;
}

async function getTodaysNetPnl(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${paperBetsCurrentView.settlementPnl}::numeric), 0)`,
    })
    .from(paperBetsCurrentView)
    .where(and(gte(paperBetsCurrentView.settledAt, todayStart), LIVE_TRACK_FILTER));
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
      total: sql<number>`COALESCE(SUM(${paperBetsCurrentView.settlementPnl}::numeric), 0)`,
    })
    .from(paperBetsCurrentView)
    .where(and(gte(paperBetsCurrentView.settledAt, weekStart), LIVE_TRACK_FILTER));
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

// 2026-05-10 (Fix B): consecutive-losses threshold raised 5 → 15 and made
// config-driven. The pre-fix hardcoded 5 was hair-trigger sensitive for
// the current bet cadence (mostly £2 min-stake-fallback bets, large daily
// volume) — a 5-loss swing of ~£20 would trip the breaker, halt placement,
// and require manual operator intervention to resume. 15 gives realistic
// short-term variance room without losing the catastrophic-streak signal.
// Operator can tune via:
//   INSERT INTO agent_config (key, value, updated_at)
//     VALUES ('consecutive_losses_threshold', '<N>', NOW())
//     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
const DEFAULT_CONSECUTIVE_LOSSES_THRESHOLD = 15;

async function getConsecutiveLossesThreshold(): Promise<number> {
  const raw = await getConfigValue("consecutive_losses_threshold");
  const n = raw ? Number(raw) : DEFAULT_CONSECUTIVE_LOSSES_THRESHOLD;
  return Number.isFinite(n) && n >= 1
    ? Math.floor(n)
    : DEFAULT_CONSECUTIVE_LOSSES_THRESHOLD;
}

export async function checkConsecutiveLosses(): Promise<boolean> {
  const threshold = await getConsecutiveLossesThreshold();
  // 2026-05-11 BUG FIX: filter to live track only — paper-rail losing
  // streaks from pre-cutover history were being counted as if live.
  const lastN = await db
    .select({
      settlementPnl: paperBetsCurrentView.settlementPnl,
      status: paperBetsCurrentView.status,
    })
    .from(paperBetsCurrentView)
    .where(and(inArray(paperBetsCurrentView.status, ["won", "lost"]), LIVE_TRACK_FILTER))
    .orderBy(desc(paperBetsCurrentView.settledAt))
    .limit(threshold);

  if (lastN.length < threshold) return false;

  const allLost = lastN.every((b) => b.status === "lost");
  if (allLost) {
    const totalLoss = lastN.reduce(
      (sum, b) => sum + Math.abs(Number(b.settlementPnl ?? 0)),
      0,
    );

    if (isDevMode) {
      logger.warn(
        { consecutiveLosses: threshold, totalLossInStreak: totalLoss, mode: "paper" },
        `DEV: ${threshold} consecutive losses WOULD have triggered — logging only, not pausing`,
      );
      const bankroll = await getBankroll();
      await logDrawdownEvent("consecutive_losses", await getHighWaterMark(), bankroll,
        (totalLoss / bankroll) * 100, 0, true,
        { consecutiveLosses: threshold, totalLossInStreak: totalLoss });
      return false;
    }

    await setAgentStatus(
      "paused_streak",
      `${threshold} consecutive losses detected`,
      { consecutiveLosses: threshold, totalLossInStreak: totalLoss, threshold },
    );
    return true;
  }
  return false;
}

// 2026-05-10 (Fix C): auto-resume from paused_streak after a cooldown.
// Pre-fix, paused_streak required explicit operator action to clear (only
// resumeAgent() flips it, and that's not called automatically). Once the
// streak triggered, the agent stayed paused indefinitely until SQL was run.
// The cooldown gives the agent room to retry on its own — if losses are
// genuinely catastrophic, the next checkConsecutiveLosses() will trip again
// and pause for another cooldown window. Default 30 minutes; tune via:
//   INSERT INTO agent_config (key, value, updated_at)
//     VALUES ('paused_streak_cooldown_minutes', '<N>', NOW())
//     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
//
// Only resumes paused_streak. Other paused statuses (paused_daily,
// paused_weekly, stopped) are left alone — they have different semantics
// and recovery requirements.
//
// Uses agent_config.updated_at for the cooldown clock. setAgentStatus()
// is no-op when status is unchanged, so updated_at reflects the original
// pause transition (not subsequent re-trips while already paused).
const DEFAULT_PAUSED_STREAK_COOLDOWN_MIN = 30;

async function maybeAutoResumePausedStreak(): Promise<void> {
  const status = await getAgentStatus();
  if (status !== "paused_streak") return;

  const cooldownRaw = await getConfigValue("paused_streak_cooldown_minutes");
  const cooldownMin = cooldownRaw ? Number(cooldownRaw) : DEFAULT_PAUSED_STREAK_COOLDOWN_MIN;
  if (!Number.isFinite(cooldownMin) || cooldownMin <= 0) return;

  const result = await db.execute(sql`
    SELECT updated_at FROM agent_config WHERE key = 'agent_status' LIMIT 1
  `);
  const updatedAtRaw = (((result as any).rows ?? [])[0]?.updated_at ?? null) as string | Date | null;
  if (updatedAtRaw == null) return;

  const elapsedMin = (Date.now() - new Date(updatedAtRaw).getTime()) / 60_000;
  if (elapsedMin < cooldownMin) return;

  logger.warn(
    { elapsedMinutes: Math.round(elapsedMin), cooldownMin },
    "Auto-resuming agent: paused_streak cooldown elapsed",
  );

  await setConfigValue("agent_status", "running");

  await db.insert(complianceLogsTable).values({
    actionType: "agent_auto_resumed",
    details: {
      previousStatus: "paused_streak",
      newStatus: "running",
      reason: `Auto-resume after ${Math.round(elapsedMin)}min cooldown (threshold: ${cooldownMin}min)`,
      elapsedMinutes: Math.round(elapsedMin),
      cooldownThresholdMinutes: cooldownMin,
    },
    timestamp: new Date(),
  });
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

  // 2026-05-10 (Fix C): auto-resume paused_streak after cooldown (default
  // 30min). Fires before the regular risk checks so a fresh check can run
  // with a clean status. If consecutive losses are still occurring, the
  // breaker will trip again — that's the correct behavior (gives the
  // system room to retry but still protects against true catastrophes).
  // Skipped in dev (the dev-mode block below auto-resumes anyway).
  if (!isDevMode) {
    await maybeAutoResumePausedStreak();
  }

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
