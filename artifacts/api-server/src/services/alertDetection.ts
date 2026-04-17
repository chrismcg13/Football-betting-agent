import { db, paperBetsTable, matchesTable, alertsTable } from "@workspace/db";
import { eq, and, gte, desc, sql, lte, count } from "drizzle-orm";
import { logger } from "../lib/logger";
import { createAlert, type AlertSeverity, type AlertCategory } from "./alerting";
import { getBankroll, getConfigValue } from "./paperTrading";
import { isLiveMode, getAccountFunds } from "./betfairLive";
import { getStartingDeposit, getCurrentLiveRiskLevel } from "./liveRiskManager";
import { getApiBudgetStatus, checkAndUpdateThrottle } from "./apiFootball";

function alert(
  severity: AlertSeverity,
  category: AlertCategory,
  code: string,
  title: string,
  message: string,
  metadata?: Record<string, unknown>,
) {
  return createAlert({ severity, category, code, title, message, metadata });
}

export async function runAlertDetection(): Promise<void> {
  logger.info("Running alert detection scan");
  try {
    await checkAndUpdateThrottle().catch(() => {});
    await Promise.allSettled([
      checkConnectivity(),
      checkRiskLimits(),
      checkConsecutiveLosses(),
      checkPerformanceMetrics(),
      checkApiBudget(),
      checkExecutionQuality(),
      checkNoBets(),
      checkCronHealth(),
    ]);
    logger.info("Alert detection scan complete");
  } catch (err) {
    logger.error({ err }, "Alert detection scan failed");
  }
}

async function checkConnectivity(): Promise<void> {
  if (!isLiveMode()) return;

  const vpsUrl = process.env["VPS_RELAY_URL"];
  if (vpsUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${vpsUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        await alert("critical", "connectivity", "VPS_DOWN",
          "VPS Relay Offline",
          `VPS relay at ${vpsUrl} returned status ${res.status}. Bet placement is unavailable.`,
          { url: vpsUrl, status: res.status });
      }
    } catch {
      await alert("critical", "connectivity", "VPS_DOWN",
        "VPS Relay Unreachable",
        `Cannot connect to VPS relay at ${vpsUrl}. Bet placement is unavailable.`,
        { url: vpsUrl });
    }
  }

  try {
    const funds = await getAccountFunds();
    if (!funds) {
      const lastFetchStr = await getConfigValue("last_balance_fetch_at");
      const lastFetch = lastFetchStr ? new Date(lastFetchStr).getTime() : 0;
      if (Date.now() - lastFetch > 60 * 60 * 1000) {
        await alert("critical", "connectivity", "BALANCE_STALE",
          "Betfair Balance Stale",
          "Haven't been able to fetch your Betfair balance for over an hour. Check API auth.",
          { lastFetchAt: lastFetchStr });
      }
    }
  } catch {
    // getAccountFunds throws on auth failure
    await alert("critical", "connectivity", "BETFAIR_AUTH_FAIL",
      "Betfair Authentication Failed",
      "Unable to authenticate with Betfair API. Check your session token and VPS connectivity.");
  }
}

async function checkRiskLimits(): Promise<void> {
  const bankroll = await getBankroll();
  // Apr 17 2026: replaced percentage-based floor with absolute £50 emergency
  // stop (Chris-authorised). The kill-switch lives in liveRiskManager.ts;
  // this is a critical-severity alert mirror so operators get notified.
  const ABSOLUTE_FLOOR = 50;

  if (bankroll < ABSOLUTE_FLOOR) {
    await alert("critical", "risk", "BANKROLL_FLOOR",
      "Available Cash Below Absolute Floor",
      `Available Betfair balance £${bankroll.toFixed(2)} is below the absolute £${ABSOLUTE_FLOOR} emergency stop. Trading halted.`,
      { bankroll, floor: ABSOLUTE_FLOOR });
  }

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [dailyResult] = await db.select({
    loss: sql<string>`COALESCE(SUM(CASE WHEN settlement_pnl < 0 THEN ABS(settlement_pnl) ELSE 0 END), 0)`,
  }).from(paperBetsTable).where(
    and(
      gte(paperBetsTable.settledAt, dayAgo),
      sql`${paperBetsTable.status} IN ('won', 'lost')`,
    ),
  );

  const dailyLoss = Number(dailyResult?.loss ?? 0);
  const dailyLimitPct = Number(await getConfigValue("daily_loss_limit_pct") ?? "0.15");
  const dailyLimit = bankroll * dailyLimitPct;

  if (dailyLoss > dailyLimit) {
    await alert("warning", "risk", "DAILY_LOSS_HIT",
      "Daily Loss Limit Reached",
      `Today's losses £${dailyLoss.toFixed(2)} exceed the ${(dailyLimitPct * 100).toFixed(0)}% daily limit (£${dailyLimit.toFixed(2)}).`,
      { dailyLoss, dailyLimit, dailyLimitPct, bankroll });
  }

  const [weeklyResult] = await db.select({
    loss: sql<string>`COALESCE(SUM(CASE WHEN settlement_pnl < 0 THEN ABS(settlement_pnl) ELSE 0 END), 0)`,
  }).from(paperBetsTable).where(
    and(
      gte(paperBetsTable.settledAt, weekAgo),
      sql`${paperBetsTable.status} IN ('won', 'lost')`,
    ),
  );

  const weeklyLoss = Number(weeklyResult?.loss ?? 0);
  const weeklyLimitPct = Number(await getConfigValue("weekly_loss_limit_pct") ?? "0.30");
  const weeklyLimit = bankroll * weeklyLimitPct;

  if (weeklyLoss > weeklyLimit) {
    await alert("critical", "risk", "WEEKLY_LOSS_HIT",
      "Weekly Loss Limit Reached",
      `This week's losses £${weeklyLoss.toFixed(2)} exceed the ${(weeklyLimitPct * 100).toFixed(0)}% weekly limit (£${weeklyLimit.toFixed(2)}).`,
      { weeklyLoss, weeklyLimit, weeklyLimitPct, bankroll });
  }
}

async function checkConsecutiveLosses(): Promise<void> {
  const recentBets = await db
    .select({ status: paperBetsTable.status })
    .from(paperBetsTable)
    .where(sql`${paperBetsTable.status} IN ('won', 'lost')`)
    .orderBy(desc(paperBetsTable.settledAt))
    .limit(8);

  if (recentBets.length < 5) return;

  const last5 = recentBets.slice(0, 5);
  const last8 = recentBets.slice(0, 8);

  if (last8.length >= 8 && last8.every((b) => b.status === "lost")) {
    await alert("critical", "risk", "CONSEC_LOSS_8",
      "8 Consecutive Losses",
      "The last 8 settled bets were all losses. Circuit breaker conditions may be triggered.",
      { streak: 8 });
  } else if (last5.every((b) => b.status === "lost")) {
    await alert("warning", "risk", "CONSEC_LOSS_5",
      "5 Consecutive Losses",
      "The last 5 settled bets were all losses. Monitor closely.",
      { streak: 5 });
  }
}

async function checkPerformanceMetrics(): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [clv7d] = await db.select({
    avg: sql<string>`AVG(clv_pct)`,
    count: count(),
  }).from(paperBetsTable).where(
    and(
      gte(paperBetsTable.settledAt, sevenDaysAgo),
      sql`clv_pct IS NOT NULL`,
    ),
  );

  if (Number(clv7d?.count ?? 0) >= 5) {
    const avgClv = Number(clv7d?.avg ?? 0);
    if (avgClv < 0) {
      await alert("warning", "performance", "CLV_NEGATIVE_7D",
        "CLV Negative (7-Day)",
        `Your 7-day rolling CLV is ${avgClv.toFixed(2)}%. You're consistently getting worse odds than the closing line.`,
        { avgClv, period: "7d", scored: Number(clv7d?.count) });
    }
  }

  const [roi14d] = await db.select({
    pnl: sql<string>`COALESCE(SUM(settlement_pnl), 0)`,
    staked: sql<string>`COALESCE(SUM(stake), 0)`,
  }).from(paperBetsTable).where(
    and(
      gte(paperBetsTable.settledAt, fourteenDaysAgo),
      sql`${paperBetsTable.status} IN ('won', 'lost')`,
    ),
  );

  const staked = Number(roi14d?.staked ?? 0);
  if (staked > 0) {
    const roi = (Number(roi14d?.pnl ?? 0) / staked) * 100;
    if (roi < 0) {
      await alert("warning", "performance", "ROI_NEGATIVE_14D",
        "ROI Negative (14-Day)",
        `Your 14-day rolling ROI is ${roi.toFixed(1)}%. Recent betting is losing money.`,
        { roi, pnl: Number(roi14d?.pnl), staked, period: "14d" });
    }
  }

  const [voidStats] = await db.select({
    total: count(),
    voids: sql<string>`COUNT(*) FILTER (WHERE status = 'void')`,
  }).from(paperBetsTable).where(
    sql`${paperBetsTable.id} IN (
      SELECT id FROM paper_bets ORDER BY placed_at DESC LIMIT 50
    )`,
  );

  if (Number(voidStats?.total ?? 0) >= 20) {
    const voidRate = (Number(voidStats?.voids ?? 0) / Number(voidStats?.total)) * 100;
    if (voidRate > 10) {
      await alert("warning", "execution", "VOID_RATE_HIGH",
        "High Void Rate",
        `${voidRate.toFixed(1)}% of your last 50 bets were voided. Check for data issues or market timing.`,
        { voidRate, voids: Number(voidStats?.voids), total: Number(voidStats?.total) });
    }
  }
}

async function checkApiBudget(): Promise<void> {
  try {
    const budget = await getApiBudgetStatus();
    const usedPct = budget.dailyBudget > 0
      ? (budget.usedToday / budget.dailyBudget) * 100
      : 0;

    if (usedPct > 80) {
      await alert("warning", "system", "API_BUDGET_HIGH",
        "API Budget Usage High",
        `API-Football budget is at ${usedPct.toFixed(0)}% (${budget.usedToday}/${budget.dailyBudget} daily requests).`,
        { usedPct, used: budget.usedToday, limit: budget.dailyBudget });
    }
  } catch {
    // budget check is best-effort
  }
}

async function checkExecutionQuality(): Promise<void> {
  if (!isLiveMode()) return;

  const [slippageStats] = await db.select({
    avgSlippage: sql<string>`AVG(ABS(
      CASE WHEN betfair_avg_price_matched IS NOT NULL AND odds_at_placement > 0
      THEN ((betfair_avg_price_matched - odds_at_placement) / odds_at_placement) * 100
      ELSE NULL END
    ))`,
    count: count(),
  }).from(paperBetsTable).where(
    sql`betfair_avg_price_matched IS NOT NULL
    AND ${paperBetsTable.id} IN (
      SELECT id FROM paper_bets WHERE betfair_avg_price_matched IS NOT NULL
      ORDER BY placed_at DESC LIMIT 50
    )`,
  );

  if (Number(slippageStats?.count ?? 0) >= 10) {
    const avgSlippage = Number(slippageStats?.avgSlippage ?? 0);
    if (avgSlippage > 3) {
      await alert("warning", "execution", "SLIPPAGE_HIGH",
        "High Average Slippage",
        `Average slippage over the last 50 matched bets is ${avgSlippage.toFixed(1)}%. Your execution price differs significantly from your intended odds.`,
        { avgSlippage });
    }
  }
}

async function checkNoBets(): Promise<void> {
  const [lastBet] = await db
    .select({ placedAt: paperBetsTable.placedAt })
    .from(paperBetsTable)
    .orderBy(desc(paperBetsTable.placedAt))
    .limit(1);

  if (!lastBet) return;

  const hoursSinceBet = (Date.now() - new Date(lastBet.placedAt).getTime()) / (60 * 60 * 1000);

  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [fixtureCheck] = await db.select({ count: count() }).from(matchesTable).where(
    and(
      eq(matchesTable.status, "scheduled"),
      gte(matchesTable.kickoffTime, twentyFourHoursAgo),
      lte(matchesTable.kickoffTime, now),
    ),
  );
  const hadFixtures = Number(fixtureCheck?.count ?? 0) > 0;

  if (hoursSinceBet >= 48) {
    await alert("critical", "no_bets", "NO_BETS_48H",
      "No Bets for 48 Hours",
      `No bets placed in ${Math.floor(hoursSinceBet)} hours. This may indicate a system issue. ${hadFixtures ? "There were fixtures during this period." : "There were no fixtures — this may be normal."}`,
      { hoursSinceBet: Math.floor(hoursSinceBet), hadFixtures });
  } else if (hoursSinceBet >= 24) {
    await alert("warning", "no_bets", "NO_BETS_24H",
      "No Bets for 24 Hours",
      `No bets placed in ${Math.floor(hoursSinceBet)} hours. ${hadFixtures ? "Fixtures were available — the model may be finding no value." : "No fixtures were available during this period."}`,
      { hoursSinceBet: Math.floor(hoursSinceBet), hadFixtures });
  } else if (hoursSinceBet >= 12 && hadFixtures) {
    await alert("warning", "no_bets", "NO_BETS_12H",
      "No Bets During Active Period",
      `No bets placed in ${Math.floor(hoursSinceBet)} hours despite ${fixtureCheck?.count} fixtures being played. The model may need attention.`,
      { hoursSinceBet: Math.floor(hoursSinceBet), fixtureCount: Number(fixtureCheck?.count) });
  }
}

export async function runAnomalyDetection(): Promise<void> {
  logger.info("Running anomaly detection");
  try {
    await Promise.allSettled([
      checkVolumeAnomaly(),
      checkStakeAnomaly(),
      checkDistributionAnomaly(),
      checkConcentrationAnomaly(),
    ]);
    logger.info("Anomaly detection complete");
  } catch (err) {
    logger.error({ err }, "Anomaly detection failed");
  }
}

async function checkVolumeAnomaly(): Promise<void> {
  const rows = await db.select({
    day: sql<string>`DATE(placed_at)`,
    count: count(),
  }).from(paperBetsTable).where(
    gte(paperBetsTable.placedAt, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)),
  ).groupBy(sql`DATE(placed_at)`);

  if (rows.length < 7) return;

  const counts = rows.map((r) => Number(r.count));
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const stdDev = Math.sqrt(counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayRow = rows.find((r) => r.day === todayStr);
  const todayCount = todayRow ? Number(todayRow.count) : 0;

  if (stdDev > 0 && Math.abs(todayCount - mean) > 2 * stdDev) {
    await alert("info", "anomaly", "ANOMALY_VOLUME",
      "Unusual Bet Volume",
      `Today's bet count (${todayCount}) deviates significantly from the 30-day average (${mean.toFixed(1)} ± ${stdDev.toFixed(1)}).`,
      { todayCount, mean, stdDev, direction: todayCount > mean ? "high" : "low" });
  }
}

async function checkStakeAnomaly(): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [avg30d] = await db.select({
    avg: sql<string>`AVG(stake)`,
  }).from(paperBetsTable).where(gte(paperBetsTable.placedAt, thirtyDaysAgo));

  const [avg1d] = await db.select({
    avg: sql<string>`AVG(stake)`,
    count: count(),
  }).from(paperBetsTable).where(gte(paperBetsTable.placedAt, oneDayAgo));

  const avg30 = Number(avg30d?.avg ?? 0);
  const avg1 = Number(avg1d?.avg ?? 0);
  const count1 = Number(avg1d?.count ?? 0);

  if (avg30 > 0 && count1 >= 3) {
    const changePct = ((avg1 - avg30) / avg30) * 100;
    if (Math.abs(changePct) > 20) {
      await alert("info", "anomaly", "ANOMALY_STAKE",
        "Stake Size Shift",
        `Average stake today (£${avg1.toFixed(2)}) differs by ${changePct > 0 ? "+" : ""}${changePct.toFixed(0)}% from the 30-day average (£${avg30.toFixed(2)}).`,
        { avg1d: avg1, avg30d: avg30, changePct });
    }
  }
}

async function checkDistributionAnomaly(): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const historical = await db.select({
    marketType: paperBetsTable.marketType,
    count: count(),
  }).from(paperBetsTable).where(gte(paperBetsTable.placedAt, thirtyDaysAgo)).groupBy(paperBetsTable.marketType);

  const recent = await db.select({
    marketType: paperBetsTable.marketType,
    count: count(),
  }).from(paperBetsTable).where(gte(paperBetsTable.placedAt, threeDaysAgo)).groupBy(paperBetsTable.marketType);

  const histTotal = historical.reduce((a, r) => a + Number(r.count), 0);
  const recentTotal = recent.reduce((a, r) => a + Number(r.count), 0);

  if (histTotal < 20 || recentTotal < 5) return;

  for (const r of recent) {
    const recentPct = (Number(r.count) / recentTotal) * 100;
    const histRow = historical.find((h) => h.marketType === r.marketType);
    const histPct = histRow ? (Number(histRow.count) / histTotal) * 100 : 0;

    if (recentPct - histPct > 40) {
      await alert("info", "anomaly", "ANOMALY_DISTRIBUTION",
        "Bet Type Distribution Shift",
        `${r.marketType} is ${recentPct.toFixed(0)}% of recent bets vs ${histPct.toFixed(0)}% historically — a sudden concentration.`,
        { marketType: r.marketType, recentPct, histPct });
    }
  }
}

async function checkConcentrationAnomaly(): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const leagueStats = await db.select({
    league: paperBetsTable.league,
    count: count(),
  }).from(paperBetsTable).where(gte(paperBetsTable.placedAt, sevenDaysAgo)).groupBy(paperBetsTable.league);

  const total = leagueStats.reduce((a, r) => a + Number(r.count), 0);
  if (total < 10) return;

  for (const row of leagueStats) {
    const pct = (Number(row.count) / total) * 100;
    if (pct > 40) {
      await alert("info", "anomaly", "ANOMALY_CONCENTRATION",
        "League Over-Concentration",
        `${row.league} accounts for ${pct.toFixed(0)}% of bets in the last 7 days (${row.count}/${total}). Consider diversifying.`,
        { league: row.league, pct, count: Number(row.count), total });
    }
  }
}

export async function checkMilestones(): Promise<void> {
  const [stats] = await db.select({
    settled: sql<string>`COUNT(*) FILTER (WHERE status IN ('won','lost'))`,
    totalPnl: sql<string>`COALESCE(SUM(settlement_pnl) FILTER (WHERE status IN ('won','lost')), 0)`,
  }).from(paperBetsTable);

  const settled = Number(stats?.settled ?? 0);
  const totalPnl = Number(stats?.totalPnl ?? 0);

  const betMilestones = [50, 100, 250, 500, 1000];
  for (const m of betMilestones) {
    if (settled >= m && settled < m + 5) {
      await alert("info", "milestone", `MILESTONE_BETS_${m}`,
        `${m} Bets Settled!`,
        `You've reached ${settled} settled bets. ${totalPnl >= 0 ? `Sitting at £${totalPnl.toFixed(2)} profit.` : `Currently at -£${Math.abs(totalPnl).toFixed(2)}.`}`,
        { settled, totalPnl, milestone: m });
    }
  }

  const profitMilestones = [100, 250, 500, 1000];
  for (const m of profitMilestones) {
    if (totalPnl >= m && totalPnl < m + 50) {
      await alert("info", "milestone", `MILESTONE_PROFIT_${m}`,
        `£${m} Profit Milestone!`,
        `Total profit has reached £${totalPnl.toFixed(2)} across ${settled} settled bets.`,
        { totalPnl, settled, milestone: m });
    }
  }
}

export async function fireTestAlert(severity: AlertSeverity): Promise<number | null> {
  const messages: Record<AlertSeverity, { title: string; message: string; code: string }> = {
    critical: {
      code: "TEST_CRITICAL",
      title: "Test Critical Alert",
      message: "This is a test critical alert. If you see this, your alerting system is working correctly.",
    },
    warning: {
      code: "TEST_WARNING",
      title: "Test Warning Alert",
      message: "This is a test warning alert. The dashboard notification badge and alerts page should reflect this.",
    },
    info: {
      code: "TEST_INFO",
      title: "Test Info Alert",
      message: "This is a test informational alert. Your alerting pipeline is end-to-end functional.",
    },
  };

  const m = messages[severity];
  return createAlert({
    severity,
    category: "system",
    code: m.code,
    title: m.title,
    message: m.message,
    metadata: { test: true, firedAt: new Date().toISOString() },
  });
}

const CRON_EXPECTED_INTERVALS: Record<string, number> = {
  trading_near: 5 * 60 * 1000,
  trading_far: 30 * 60 * 1000,
  ingestion: 30 * 60 * 1000,
  features: 6 * 60 * 60 * 1000,
};

async function checkCronHealth(): Promise<void> {
  try {
    const { cronExecutionsTable } = await import("@workspace/db");
    const { desc, eq } = await import("drizzle-orm");

    for (const [jobName, expectedIntervalMs] of Object.entries(CRON_EXPECTED_INTERVALS)) {
      const lastExec = await db
        .select({
          completedAt: cronExecutionsTable.completedAt,
          success: cronExecutionsTable.success,
        })
        .from(cronExecutionsTable)
        .where(eq(cronExecutionsTable.jobName, jobName))
        .orderBy(desc(cronExecutionsTable.startedAt))
        .limit(1);

      if (lastExec.length === 0) continue;

      const last = lastExec[0]!;
      const lastTime = last.completedAt?.getTime() ?? 0;
      const elapsed = Date.now() - lastTime;
      const missedThreshold = expectedIntervalMs * 2;

      if (elapsed > missedThreshold) {
        const missedRuns = Math.floor(elapsed / expectedIntervalMs);
        const isTradingCritical = jobName.startsWith("trading_") && missedRuns >= 2;

        await alert(
          isTradingCritical ? "critical" : "warning",
          "system",
          `CRON_MISSED_${jobName.toUpperCase()}`,
          `Cron job "${jobName}" missed ${missedRuns} runs`,
          `Job "${jobName}" last completed ${Math.round(elapsed / 60000)} minutes ago (expected every ${Math.round(expectedIntervalMs / 60000)} min). ${isTradingCritical ? "CRITICAL: Trading cron missed 2+ consecutive runs." : ""}`,
          { jobName, missedRuns, elapsedMinutes: Math.round(elapsed / 60000), lastRunAt: last.completedAt?.toISOString() },
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "Cron health check failed");
  }
}
