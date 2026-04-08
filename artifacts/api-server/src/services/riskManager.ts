import {
  db,
  paperBetsTable,
  complianceLogsTable,
  learningNarrativesTable,
  agentConfigTable,
} from "@workspace/db";
import { eq, inArray, desc, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getConfigValue,
  setConfigValue,
  getBankroll,
  getAgentStatus,
} from "./paperTrading";

// ===================== Helpers =====================

async function setAgentStatus(
  status: string,
  reason: string,
  details: Record<string, unknown>,
): Promise<void> {
  const previous = await getAgentStatus();
  if (previous === status) return; // already in this state

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

// ===================== Individual checks =====================

export async function checkDailyLoss(): Promise<boolean> {
  const bankroll = await getBankroll();
  const limitPct = Number(
    (await getConfigValue("daily_loss_limit_pct")) ?? "0.05",
  );
  const dailyLossLimit = bankroll * limitPct;
  const dailyLoss = await getTodaysSettledLoss();

  if (dailyLoss >= dailyLossLimit) {
    await setAgentStatus("paused_daily", "Daily loss limit reached", {
      dailyLoss,
      dailyLossLimit,
      limitPct,
      bankroll,
    });
    return true; // circuit breaker fired
  }
  return false;
}

export async function checkWeeklyLoss(): Promise<boolean> {
  const bankroll = await getBankroll();
  const limitPct = Number(
    (await getConfigValue("weekly_loss_limit_pct")) ?? "0.10",
  );
  const weeklyLossLimit = bankroll * limitPct;
  const weeklyLoss = await getWeeklySettledLoss();

  if (weeklyLoss >= weeklyLossLimit) {
    await setAgentStatus("paused_weekly", "Weekly loss limit reached", {
      weeklyLoss,
      weeklyLossLimit,
      limitPct,
      bankroll,
    });
    return true;
  }
  return false;
}

export async function checkBankrollFloor(): Promise<boolean> {
  const bankroll = await getBankroll();
  const floor = Number((await getConfigValue("bankroll_floor")) ?? "200");

  if (bankroll <= floor) {
    await setAgentStatus("stopped", "Bankroll at or below floor", {
      bankroll,
      floor,
    });
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

  if (lastFive.length < 5) return false; // not enough history

  const allLost = lastFive.every((b) => b.status === "lost");
  if (allLost) {
    const totalLoss = lastFive.reduce(
      (sum, b) => sum + Math.abs(Number(b.settlementPnl ?? 0)),
      0,
    );
    await setAgentStatus(
      "paused_streak",
      "5 consecutive losses detected",
      {
        consecutiveLosses: 5,
        totalLossInStreak: totalLoss,
      },
    );
    return true;
  }
  return false;
}

// ===================== Run all checks =====================

export interface RiskCheckResult {
  bankrollFloor: boolean;
  dailyLoss: boolean;
  weeklyLoss: boolean;
  consecutiveLosses: boolean;
  anyTriggered: boolean;
}

export async function runAllRiskChecks(): Promise<RiskCheckResult> {
  logger.debug("Running risk checks");
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
      { bankrollFloor, dailyLoss, weeklyLoss, consecutiveLosses },
      "Risk check triggered a circuit breaker",
    );
  }

  return { bankrollFloor, dailyLoss, weeklyLoss, consecutiveLosses, anyTriggered };
}

// ===================== Resume agent =====================

export async function resumeAgent(): Promise<void> {
  const currentStatus = await getAgentStatus();
  if (currentStatus === "running") return;
  if (currentStatus === "stopped") {
    logger.warn("Cannot resume a stopped agent — bankroll below floor");
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
