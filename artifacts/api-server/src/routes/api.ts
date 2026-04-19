import { Router } from "express";
import {
  db,
  pool,
  paperBetsTable,
  matchesTable,
  complianceLogsTable,
  learningNarrativesTable,
  modelStateTable,
  agentConfigTable,
  leagueEdgeScoresTable,
  oddspapiLeagueCoverageTable,
  oddspapiFixtureMapTable,
  pinnacleOddsSnapshotsTable,
  lineMovementsTable,
  filteredBetsTable,
} from "@workspace/db";
import {
  eq,
  desc,
  and,
  gte,
  lte,
  inArray,
  sql,
  asc,
  like,
  ne,
  isNotNull,
} from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getConfigValue,
  setConfigValue,
  getBankroll,
  getAgentStatus,
  backfillCornersCardsStats,
  deduplicatePendingBets,
  voidBetsOnBannedMarkets,
} from "../services/paperTrading";
import {
  runIngestionNow,
  runFeaturesNow,
  runTradingCycle,
  getSchedulerStatus,
  runOddspapiMappingNow,
  runXGIngestionNow,
  runLeagueDiscoveryNow,
  runIngestDiscoveredFixturesNow,
  runSettlementNow,
} from "../services/scheduler";
import { getDiscoveredLeagues, getDiscoveryStats, getCompetitionCoverageStats } from "../services/leagueDiscovery";
import { getAllTeamXGStats } from "../services/xgIngestionService";
import { getCircuitBreakerStatus, resumeAgent } from "../services/riskManager";
import { getCachedBalance, isLiveMode, getAccountFunds, cancelOrders } from "../services/betfairLive";
import { getDataRichnessSummary } from "../services/dataRichness";
import { getLiveOppScoreThreshold } from "../services/liveThresholdReview";
import {
  getOddspapiStatus,
  prefetchAndStoreOddsPapiOdds,
  runDedicatedBulkPrefetch,
  runMatchDiagnostic,
} from "../services/oddsPapi";
import {
  getApiBudgetStatus,
  fetchAndStoreOddsForAllUpcoming,
  getScanStats,
  calculateLeaguePerformanceScores,
  deactivateLowValueLeagues,
  capturePreKickoffLineups,
} from "../services/apiFootball";
import { getTodayLineMovements } from "../services/lineMovement";
import { getThresholdCategory } from "../services/correlationDetector";

const router = Router();

const STARTING_BANKROLL = 500;
const SYSTEM_COST = 499;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function paginate(page: unknown, limit: unknown, max = 200) {
  const p = Math.max(1, Number(page ?? 1));
  const l = Math.min(Number(limit ?? 20), max);
  return { page: p, limit: l, offset: (p - 1) * l };
}

// "Real money" filter for dashboard reads.
//   A row in paper_bets only represents real money on the exchange when the
//   placement actually reached Betfair and we got back a bet id. Rows with
//   betfair_bet_id IS NULL are model decisions that never executed (network
//   failure, pre-placement filtering, paper-mode legacy, etc.) and must NOT
//   appear in dashboard totals, PnL, ROI, CLV, upcoming/live/settled views.
//   This is applied to every dashboard endpoint below.
const REAL_MONEY = isNotNull(paperBetsTable.betfairBetId);

async function getSettledBetsStats() {
  const rows = await db
    .select({
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      settledAt: paperBetsTable.settledAt,
      opportunityScore: paperBetsTable.opportunityScore,
      grossPnl: paperBetsTable.grossPnl,
      commissionAmount: paperBetsTable.commissionAmount,
      netPnl: paperBetsTable.netPnl,
    })
    .from(paperBetsTable)
    .where(
      and(
        inArray(paperBetsTable.status, ["won", "lost", "void"]),
        REAL_MONEY,
      ),
    );
  return rows;
}

// ─────────────────────────────────────────────
// GET /api/dashboard/summary
// ─────────────────────────────────────────────
router.get("/dashboard/summary", async (_req, res) => {
  const todayStartUtc = new Date();
  todayStartUtc.setUTCHours(0, 0, 0, 0);

  // Dashboard is real-money only — see REAL_MONEY constant at top of file.
  const pendingWhere = and(eq(paperBetsTable.status, "pending"), REAL_MONEY);
  const betsTodayWhere = and(gte(paperBetsTable.placedAt, todayStartUtc), REAL_MONEY);

  const [bankroll, agentStatus, allSettled, allPending, betsTodayRows, tierSplitRows, paperModeRow, maxExposurePctRow, exposureRuleSinceRow] = await Promise.all([
    getBankroll(),
    getAgentStatus(),
    getSettledBetsStats(),
    db
      .select({
        id: paperBetsTable.id,
        stake: paperBetsTable.stake,
        opportunityScore: paperBetsTable.opportunityScore,
        placedAt: paperBetsTable.placedAt,
      })
      .from(paperBetsTable)
      .where(pendingWhere),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(paperBetsTable)
      .where(betsTodayWhere),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE live_tier = 'tier1' AND qualification_path = '1A') AS tier1a,
        COUNT(*) FILTER (WHERE live_tier = 'tier1' AND qualification_path = '1B') AS tier1b,
        COUNT(*) FILTER (WHERE live_tier = 'tier1' AND (qualification_path = 'promoted' OR qualification_path IS NULL)) AS tier1_other,
        COUNT(*) FILTER (WHERE live_tier = 'tier1') AS betfair_live,
        COUNT(*) FILTER (WHERE (live_tier = 'tier2' OR live_tier IS NULL)) AS tier2,
        COALESCE(SUM(stake::numeric) FILTER (WHERE live_tier = 'tier1' AND status != 'void'), 0) AS betfair_stake
      FROM paper_bets
      WHERE placed_at >= ${todayStartUtc} AND deleted_at IS NULL
        AND betfair_bet_id IS NOT NULL
    `),
    db
      .select({ value: agentConfigTable.value })
      .from(agentConfigTable)
      .where(eq(agentConfigTable.key, "paper_mode"))
      .limit(1),
    db
      .select({ value: agentConfigTable.value })
      .from(agentConfigTable)
      .where(eq(agentConfigTable.key, "max_unsettled_exposure_pct"))
      .limit(1),
    db
      .select({ value: agentConfigTable.value })
      .from(agentConfigTable)
      .where(eq(agentConfigTable.key, "exposure_rule_since"))
      .limit(1),
  ]);

  const betsToday = betsTodayRows[0]?.count ?? 0;
  const tsRow = (tierSplitRows as any).rows?.[0] ?? (tierSplitRows as any)[0] ?? {};
  const tierSplit = {
    tier1a: Number(tsRow.tier1a ?? 0),
    tier1b: Number(tsRow.tier1b ?? 0),
    tier1Other: Number(tsRow.tier1_other ?? 0),
    betfairLive: Number(tsRow.betfair_live ?? 0),
    tier2: Number(tsRow.tier2 ?? 0),
    betfairStake: Math.round(Number(tsRow.betfair_stake ?? 0) * 100) / 100,
  };
  const paperMode = paperModeRow[0]?.value === "true";
  const maxExposurePct = Number(maxExposurePctRow[0]?.value ?? "0.40");
  const exposureRuleSince = exposureRuleSinceRow[0]?.value ? new Date(exposureRuleSinceRow[0].value) : null;
  // Only count bets placed after the exposure rule went live (pre-rule bets are grandfathered)
  const pendingExposure = Math.round(
    allPending
      .filter((b) => !exposureRuleSince || (b.placedAt && new Date(b.placedAt) >= exposureRuleSince))
      .reduce((sum, b) => sum + Number(b.stake), 0) * 100,
  ) / 100;
  const maxExposure = Math.round(bankroll * maxExposurePct * 100) / 100;
  const exposurePct = maxExposure > 0 ? Math.round((pendingExposure / maxExposure) * 1000) / 10 : 0;

  const wins = allSettled.filter((b) => b.status === "won").length;
  const losses = allSettled.filter((b) => b.status === "lost").length;
  const voids = allSettled.filter((b) => b.status === "void").length;
  const settledTotal = wins + losses + voids;
  // totalBets counts all bets (settled + pending)
  const total = settledTotal + allPending.length;

  const totalPnl = allSettled.reduce(
    (sum, b) => sum + Number(b.settlementPnl ?? 0),
    0,
  );
  const totalGrossPnl = allSettled.reduce(
    (sum, b) => sum + Number(b.grossPnl ?? b.settlementPnl ?? 0),
    0,
  );
  const totalCommission = allSettled.reduce(
    (sum, b) => sum + Number(b.commissionAmount ?? 0),
    0,
  );

  // Today P&L
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todaySettled = allSettled.filter((b) => b.settledAt && new Date(b.settledAt) >= todayStart);
  const todayPnl = todaySettled.reduce((sum, b) => sum + Number(b.settlementPnl ?? 0), 0);

  // This week P&L
  const weekStart = new Date();
  const day = weekStart.getUTCDay();
  weekStart.setUTCDate(weekStart.getUTCDate() - (day === 0 ? 6 : day - 1));
  weekStart.setUTCHours(0, 0, 0, 0);
  const weekPnl = allSettled
    .filter((b) => b.settledAt && new Date(b.settledAt) >= weekStart)
    .reduce((sum, b) => sum + Number(b.settlementPnl ?? 0), 0);

  const totalStake = allSettled.reduce((sum, b) => sum + Number(b.stake), 0);

  // avgOpportunityScore across ALL bets (settled + pending)
  const allBetsWithScore = [
    ...allSettled.filter((b) => b.opportunityScore != null),
    ...allPending.filter((b) => b.opportunityScore != null),
  ];
  const avgOpportunityScore =
    allBetsWithScore.length > 0
      ? Math.round(
          (allBetsWithScore.reduce(
            (sum, b) => sum + Number(b.opportunityScore ?? 0),
            0,
          ) /
            allBetsWithScore.length) *
            10,
        ) / 10
      : null;

  const tradingMode = process.env["TRADING_MODE"] ?? "PAPER";
  const balance = getCachedBalance();
  let riskLevel = null;
  try {
    const { getCurrentLiveRiskLevel } = await import("../services/liveRiskManager");
    riskLevel = await getCurrentLiveRiskLevel();
  } catch {}

  res.json({
    currentBankroll: Math.round(bankroll * 100) / 100,
    startingBankroll: STARTING_BANKROLL,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalGrossPnl: Math.round(totalGrossPnl * 100) / 100,
    totalCommission: Math.round(totalCommission * 100) / 100,
    totalPnlPct:
      totalStake > 0
        ? Math.round((totalPnl / totalStake) * 10000) / 100
        : 0,
    agentStatus,
    totalBets: total,
    settledBets: wins + losses,
    wins,
    losses,
    voids,
    pending: allPending.length,
    betsToday,
    tierSplit,
    paperMode,
    tradingMode,
    isLive: tradingMode === "LIVE",
    winPercentage:
      wins + losses > 0
        ? Math.round((wins / (wins + losses)) * 10000) / 100
        : 0,
    overallRoiPct:
      totalStake > 0
        ? Math.round((totalPnl / totalStake) * 10000) / 100
        : 0,
    grossRoiPct:
      totalStake > 0
        ? Math.round((totalGrossPnl / totalStake) * 10000) / 100
        : 0,
    todayPnl: Math.round(todayPnl * 100) / 100,
    thisWeekPnl: Math.round(weekPnl * 100) / 100,
    activeBetsCount: allPending.length,
    avgOpportunityScore,
    pendingExposure,
    maxExposure,
    exposurePct,
    betfairBalance: balance ? {
      available: balance.available,
      exposure: balance.exposure,
      total: balance.total,
      stale: (Date.now() - balance.fetchedAt) > 300000,
    } : null,
    riskLevel,
  });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/performance
// ─────────────────────────────────────────────
router.get("/dashboard/performance", async (_req, res) => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);
  since.setUTCHours(0, 0, 0, 0);

  // Dashboard is real-money only — see REAL_MONEY constant at top of file.
  const settledWhere = and(
    inArray(paperBetsTable.status, ["won", "lost"]),
    gte(paperBetsTable.settledAt, since),
    REAL_MONEY,
  );

  const settled = await db
    .select({
      settledAt: paperBetsTable.settledAt,
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
    })
    .from(paperBetsTable)
    .where(settledWhere)
    .orderBy(asc(paperBetsTable.settledAt));

  // Overview "Recent Results" shows wins/losses only — voids are tracked on the
  // Bets History page so they don't clutter the at-a-glance settled view.
  const recentSettledWhere = and(
    inArray(paperBetsTable.status, ["won", "lost"]),
    REAL_MONEY,
  );
  const recentBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      league: matchesTable.league,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      oddsAtPlacement: paperBetsTable.oddsAtPlacement,
      stake: paperBetsTable.stake,
      status: paperBetsTable.status,
      settlementPnl: paperBetsTable.settlementPnl,
      settledAt: paperBetsTable.settledAt,
      placedAt: paperBetsTable.placedAt,
    })
    .from(paperBetsTable)
    .leftJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(recentSettledWhere)
    .orderBy(desc(paperBetsTable.settledAt))
    .limit(15);

  // Daily P&L
  const dailyMap = new Map<
    string,
    { pnl: number; wins: number; losses: number; stake: number }
  >();

  for (const bet of settled) {
    if (!bet.settledAt) continue;
    const key = bet.settledAt.toISOString().slice(0, 10);
    const entry = dailyMap.get(key) ?? {
      pnl: 0,
      wins: 0,
      losses: 0,
      stake: 0,
    };
    entry.pnl += Number(bet.settlementPnl ?? 0);
    entry.stake += Number(bet.stake);
    if (bet.status === "won") entry.wins++;
    else entry.losses++;
    dailyMap.set(key, entry);
  }

  // Fill all 30 days (even days with no bets)
  const dailyPnl: { date: string; pnl: number; bets: number; stake: number }[] = [];
  const cumulative: { date: string; cumPnl: number }[] = [];
  let cumPnl = 0;

  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    d.setUTCHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    const entry = dailyMap.get(key);
    const pnl = entry?.pnl ?? 0;
    cumPnl += pnl;
    dailyPnl.push({
      date: key,
      pnl: Math.round(pnl * 100) / 100,
      bets: (entry?.wins ?? 0) + (entry?.losses ?? 0),
      stake: Math.round((entry?.stake ?? 0) * 100) / 100,
    });
    cumulative.push({ date: key, cumPnl: Math.round(cumPnl * 100) / 100 });
  }

  // Weekly win rate
  const weeklyMap = new Map<
    string,
    { wins: number; losses: number; pnl: number }
  >();
  for (const bet of settled) {
    if (!bet.settledAt) continue;
    const d = new Date(bet.settledAt);
    // ISO week: year-W## format
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const weekNum = Math.ceil(
      ((d.getTime() - jan4.getTime()) / 86400000 + jan4.getUTCDay() + 1) / 7,
    );
    const key = `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    const entry = weeklyMap.get(key) ?? { wins: 0, losses: 0, pnl: 0 };
    if (bet.status === "won") entry.wins++;
    else entry.losses++;
    entry.pnl += Number(bet.settlementPnl ?? 0);
    weeklyMap.set(key, entry);
  }

  const weeklyWinRate = Array.from(weeklyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, { wins, losses, pnl }]) => ({
      week,
      wins,
      losses,
      bets: wins + losses,
      winRate:
        wins + losses > 0
          ? Math.round((wins / (wins + losses)) * 10000) / 100
          : 0,
      pnl: Math.round(pnl * 100) / 100,
    }));

  const recentBetsOut = recentBets.map((b) => ({
    ...b,
    oddsAtPlacement: Number(b.oddsAtPlacement),
    stake: Number(b.stake),
    settlementPnl: b.settlementPnl != null ? Number(b.settlementPnl) : null,
  }));

  res.json({ dailyPnl, cumulativeProfit: cumulative, weeklyWinRate, recentBets: recentBetsOut });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/bets/by-league  (before /:id or ?page style)
// ─────────────────────────────────────────────
router.get("/dashboard/bets/by-league", async (_req, res) => {
  const settled = await db
    .select({
      league: matchesTable.league,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
    })
    .from(paperBetsTable)
    .leftJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(and(inArray(paperBetsTable.status, ["won", "lost"]), REAL_MONEY));

  const groups = new Map<
    string,
    { wins: number; losses: number; stake: number; pnl: number }
  >();

  for (const bet of settled) {
    const key = bet.league ?? "Unknown";
    const entry = groups.get(key) ?? {
      wins: 0,
      losses: 0,
      stake: 0,
      pnl: 0,
    };
    if (bet.status === "won") entry.wins++;
    else entry.losses++;
    entry.stake += Number(bet.stake);
    entry.pnl += Number(bet.settlementPnl ?? 0);
    groups.set(key, entry);
  }

  const result = Array.from(groups.entries())
    .map(([league, g]) => ({
      league,
      count: g.wins + g.losses,
      wins: g.wins,
      losses: g.losses,
      winRate:
        g.wins + g.losses > 0
          ? Math.round((g.wins / (g.wins + g.losses)) * 10000) / 100
          : 0,
      totalPnl: Math.round(g.pnl * 100) / 100,
      roi:
        g.stake > 0 ? Math.round((g.pnl / g.stake) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.roi - a.roi);

  res.json(result);
});

// ─────────────────────────────────────────────
// GET /api/dashboard/league-softness
// ─────────────────────────────────────────────
// Per-league CLV-weighted view of where our edge actually exists on the
// exchange. CLV is the cleanest soft-money signal: high CLV means the market
// subsequently agreed with our price = soft counterparty. Live bets only.
// Query params: ?days=30  ?minBets=3
router.get("/dashboard/league-softness", async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const minBets = Math.max(1, Number(req.query.minBets) || 1);
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      league: matchesTable.league,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      clvPct: paperBetsTable.clvPct,
      clvDataQuality: paperBetsTable.clvDataQuality,
      calculatedEdge: paperBetsTable.calculatedEdge,
      betfairBetId: paperBetsTable.betfairBetId,
      placementOdds: paperBetsTable.oddsAtPlacement,
      matchedOdds: paperBetsTable.betfairAvgPriceMatched,
    })
    .from(paperBetsTable)
    .leftJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        gte(paperBetsTable.placedAt, sinceDate),
        isNotNull(paperBetsTable.betfairBetId), // live bets only
      ),
    );

  type Agg = {
    placed: number;
    settled: number;
    wins: number;
    losses: number;
    stake: number;
    pnl: number;
    clvSum: number;
    clvCount: number;
    clvCompleteCount: number;
    edgeSum: number;
    edgeCount: number;
    slipSum: number;
    slipCount: number;
  };

  const groups = new Map<string, Agg>();
  for (const r of rows) {
    const key = r.league ?? "Unknown";
    const a = groups.get(key) ?? {
      placed: 0, settled: 0, wins: 0, losses: 0, stake: 0, pnl: 0,
      clvSum: 0, clvCount: 0, clvCompleteCount: 0,
      edgeSum: 0, edgeCount: 0, slipSum: 0, slipCount: 0,
    };
    a.placed += 1;
    if (r.status === "won" || r.status === "lost") {
      a.settled += 1;
      if (r.status === "won") a.wins += 1; else a.losses += 1;
      a.stake += Number(r.stake);
      a.pnl += Number(r.settlementPnl ?? 0);
    }
    if (r.clvPct != null) {
      a.clvSum += Number(r.clvPct);
      a.clvCount += 1;
    }
    if (r.clvDataQuality === "complete") a.clvCompleteCount += 1;
    if (r.calculatedEdge != null) {
      a.edgeSum += Number(r.calculatedEdge) * 100;
      a.edgeCount += 1;
    }
    const matched = Number(r.matchedOdds);
    const placement = Number(r.placementOdds);
    // Skip slippage for unmatched (matched=0) anomalies
    if (matched > 0 && placement > 0) {
      a.slipSum += matched - placement;
      a.slipCount += 1;
    }
    groups.set(key, a);
  }

  const result = Array.from(groups.entries())
    .filter(([, a]) => a.placed >= minBets)
    .map(([league, a]) => {
      const winRate = a.settled > 0 ? (a.wins / a.settled) * 100 : 0;
      const roi = a.stake > 0 ? (a.pnl / a.stake) * 100 : 0;
      const avgClv = a.clvCount > 0 ? a.clvSum / a.clvCount : null;
      const clvCoverage = a.placed > 0 ? (a.clvCompleteCount / a.placed) * 100 : 0;
      const avgEdge = a.edgeCount > 0 ? a.edgeSum / a.edgeCount : null;
      const avgSlip = a.slipCount > 0 ? a.slipSum / a.slipCount : null;
      // Softness score: weighted combination of CLV (primary) + ROI fragments + sample
      // CLV in [-50, +50] mapped to score; absent CLV penalised; small sample penalised
      const sampleWeight = Math.min(1, a.placed / 20);
      const clvScore = avgClv != null ? Math.max(-50, Math.min(80, avgClv)) : -10;
      const roiBonus = a.settled >= 5 ? Math.max(-30, Math.min(30, roi / 2)) : 0;
      const softness = Math.round((clvScore * 0.7 + roiBonus * 0.3) * sampleWeight * 10) / 10;
      return {
        league,
        placed: a.placed,
        settled: a.settled,
        wins: a.wins,
        losses: a.losses,
        winRate: Math.round(winRate * 10) / 10,
        stake: Math.round(a.stake * 100) / 100,
        pnl: Math.round(a.pnl * 100) / 100,
        roi: Math.round(roi * 10) / 10,
        avgClv: avgClv != null ? Math.round(avgClv * 100) / 100 : null,
        clvCoveragePct: Math.round(clvCoverage * 10) / 10,
        avgEdgePct: avgEdge != null ? Math.round(avgEdge * 10) / 10 : null,
        avgSlippage: avgSlip != null ? Math.round(avgSlip * 1000) / 1000 : null,
        softnessScore: softness,
      };
    })
    .sort((a, b) => b.softnessScore - a.softnessScore);

  res.json({
    windowDays: days,
    minBets,
    totalLeagues: result.length,
    leagues: result,
  });
});

// ─────────────────────────────────────────────
// POST /api/admin/capture-pinnacle-snapshots
// Manual trigger for the multi-snapshot Pinnacle ingestion (T-60/30/15/5)
// ─────────────────────────────────────────────
router.post("/admin/capture-pinnacle-snapshots", async (_req, res) => {
  try {
    const { captureAllPendingSnapshots } = await import("../services/oddsPapi");
    const result = await captureAllPendingSnapshots();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual capture-pinnacle-snapshots failed");
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/bets/by-market
// ─────────────────────────────────────────────
router.get("/dashboard/bets/by-market", async (_req, res) => {
  const settled = await db
    .select({
      marketType: paperBetsTable.marketType,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
    })
    .from(paperBetsTable)
    .where(and(inArray(paperBetsTable.status, ["won", "lost"]), REAL_MONEY));

  const groups = new Map<
    string,
    { wins: number; losses: number; stake: number; pnl: number }
  >();

  for (const bet of settled) {
    const key = bet.marketType;
    const entry = groups.get(key) ?? {
      wins: 0,
      losses: 0,
      stake: 0,
      pnl: 0,
    };
    if (bet.status === "won") entry.wins++;
    else entry.losses++;
    entry.stake += Number(bet.stake);
    entry.pnl += Number(bet.settlementPnl ?? 0);
    groups.set(key, entry);
  }

  const result = Array.from(groups.entries())
    .map(([marketType, g]) => ({
      marketType,
      count: g.wins + g.losses,
      wins: g.wins,
      losses: g.losses,
      winRate:
        g.wins + g.losses > 0
          ? Math.round((g.wins / (g.wins + g.losses)) * 10000) / 100
          : 0,
      totalPnl: Math.round(g.pnl * 100) / 100,
      roi:
        g.stake > 0 ? Math.round((g.pnl / g.stake) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.roi - a.roi);

  res.json(result);
});

// ─────────────────────────────────────────────
// GET /api/dashboard/bets
// ─────────────────────────────────────────────
router.get("/dashboard/bets", async (req, res) => {
  const { page, limit, offset } = paginate(
    req.query["page"],
    req.query["limit"],
    500,
  );
  const statusFilter = String(req.query["status"] ?? "all");

  // Dashboard is real-money only — bets list never includes never-placed shadow
  // rows, regardless of status filter.
  const baseConditions =
    statusFilter === "all" || !statusFilter
      ? REAL_MONEY
      : and(eq(paperBetsTable.status, statusFilter), REAL_MONEY);

  const [bets, countResult] = await Promise.all([
    db
      .select({
        id: paperBetsTable.id,
        matchId: paperBetsTable.matchId,
        homeTeam: matchesTable.homeTeam,
        awayTeam: matchesTable.awayTeam,
        league: matchesTable.league,
        kickoffTime: matchesTable.kickoffTime,
        homeScore: matchesTable.homeScore,
        awayScore: matchesTable.awayScore,
        marketType: paperBetsTable.marketType,
        selectionName: paperBetsTable.selectionName,
        betType: paperBetsTable.betType,
        oddsAtPlacement: paperBetsTable.oddsAtPlacement,
        stake: paperBetsTable.stake,
        potentialProfit: paperBetsTable.potentialProfit,
        modelProbability: paperBetsTable.modelProbability,
        betfairImpliedProbability: paperBetsTable.betfairImpliedProbability,
        calculatedEdge: paperBetsTable.calculatedEdge,
        opportunityScore: paperBetsTable.opportunityScore,
        modelVersion: paperBetsTable.modelVersion,
        status: paperBetsTable.status,
        settlementPnl: paperBetsTable.settlementPnl,
        placedAt: paperBetsTable.placedAt,
        settledAt: paperBetsTable.settledAt,
        oddsSource: paperBetsTable.oddsSource,
        liveTier: paperBetsTable.liveTier,
        betfairBetId: paperBetsTable.betfairBetId,
        betfairStatus: paperBetsTable.betfairStatus,
        betfairSizeMatched: paperBetsTable.betfairSizeMatched,
        betfairAvgPriceMatched: paperBetsTable.betfairAvgPriceMatched,
        betfairPnl: paperBetsTable.betfairPnl,
        dataTier: paperBetsTable.dataTier,
        experimentTag: paperBetsTable.experimentTag,
        clvPct: paperBetsTable.clvPct,
        pinnacleOdds: paperBetsTable.pinnacleOdds,
        isContrarian: paperBetsTable.isContrarian,
        betThesis: paperBetsTable.betThesis,
      })
      .from(paperBetsTable)
      .leftJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
      .where(baseConditions)
      .orderBy(desc(paperBetsTable.placedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(paperBetsTable)
      .where(baseConditions),
  ]);

  const total = countResult[0]?.count ?? 0;

  res.json({
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    bets: bets.map((b) => ({
      ...b,
      oddsAtPlacement: Number(b.oddsAtPlacement),
      stake: Number(b.stake),
      potentialProfit: b.potentialProfit ? Number(b.potentialProfit) : null,
      modelProbability: b.modelProbability ? Number(b.modelProbability) : null,
      betfairImpliedProbability: b.betfairImpliedProbability
        ? Number(b.betfairImpliedProbability)
        : null,
      calculatedEdge: b.calculatedEdge ? Number(b.calculatedEdge) : null,
      opportunityScore: b.opportunityScore ? Number(b.opportunityScore) : null,
      settlementPnl: b.settlementPnl ? Number(b.settlementPnl) : null,
      betfairSizeMatched: b.betfairSizeMatched ? Number(b.betfairSizeMatched) : null,
      betfairAvgPriceMatched: b.betfairAvgPriceMatched ? Number(b.betfairAvgPriceMatched) : null,
      betfairPnl: b.betfairPnl ? Number(b.betfairPnl) : null,
      clvPct: b.clvPct ? Number(b.clvPct) : null,
      pinnacleOdds: b.pinnacleOdds ? Number(b.pinnacleOdds) : null,
    })),
  });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/viability
// ─────────────────────────────────────────────
router.get("/dashboard/viability", async (_req, res) => {
  const allSettled = await db
    .select({
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      calculatedEdge: paperBetsTable.calculatedEdge,
      placedAt: paperBetsTable.placedAt,
      settledAt: paperBetsTable.settledAt,
    })
    .from(paperBetsTable)
    .where(and(inArray(paperBetsTable.status, ["won", "lost"]), REAL_MONEY))
    .orderBy(asc(paperBetsTable.placedAt));

  const totalSettledBets = allSettled.length;

  if (totalSettledBets === 0) {
    res.json({
      avgRoiPerBet: 0,
      betsPerWeek: 0,
      avgStake: 0,
      projectedMonthlyProfitConservative: 0,
      projectedMonthlyProfitModerate: 0,
      projectedMonthlyProfitOptimistic: 0,
      monthsToRecoupConservative: null,
      monthsToRecoupModerate: null,
      monthsToRecoupOptimistic: null,
      minimumBankrollFor2MonthRecoup: null,
      trafficLightSignal: "RED",
      totalSettledBets: 0,
      paperTradingDays: 0,
      systemCost: SYSTEM_COST,
    });
    return;
  }

  const firstBet = allSettled[0];
  const firstDate = firstBet?.placedAt
    ? new Date(firstBet.placedAt)
    : new Date();
  const paperTradingDays = Math.max(
    1,
    Math.ceil(
      (Date.now() - firstDate.getTime()) / (1000 * 60 * 60 * 24),
    ),
  );

  const totalStake = allSettled.reduce(
    (sum, b) => sum + Number(b.stake),
    0,
  );
  const totalPnl = allSettled.reduce(
    (sum, b) => sum + Number(b.settlementPnl ?? 0),
    0,
  );

  const avgStake = totalStake / totalSettledBets;
  const overallRoi = totalStake > 0 ? (totalPnl / totalStake) * 100 : 0;
  const avgRoiPerBet = overallRoi; // net of 2% Betfair commission (already deducted in settlement)
  const betsPerWeek = totalSettledBets / (paperTradingDays / 7);

  // Average profit per bet and monthly projection
  // Monthly profit = avgProfitPerBet × betsPerWeek × 4.3 (average weeks per month)
  const avgProfitPerBet = totalSettledBets > 0 ? totalPnl / totalSettledBets : 0;
  const monthlyProfitOptimistic = avgProfitPerBet * betsPerWeek * 4.3;
  const monthlyProfitModerate = monthlyProfitOptimistic * 0.75;
  const monthlyProfitConservative = monthlyProfitOptimistic * 0.5;

  const safeRecoup = (profit: number) =>
    profit > 0.01 ? SYSTEM_COST / profit : null;

  const monthsConservative = safeRecoup(monthlyProfitConservative);
  const monthsModerate = safeRecoup(monthlyProfitModerate);
  const monthsOptimistic = safeRecoup(monthlyProfitOptimistic);

  // Traffic light
  let trafficLightSignal: "GREEN" | "AMBER" | "RED";
  if (monthsConservative !== null && monthsConservative < 2) {
    trafficLightSignal = "GREEN";
  } else if (monthsModerate !== null && monthsModerate < 2) {
    trafficLightSignal = "AMBER";
  } else {
    trafficLightSignal = "RED";
  }

  // Minimum bankroll needed for 2-month recoup at conservative rate
  // Need: monthly_profit >= SYSTEM_COST / 2 = 249.50
  // monthly_profit = avgStake_needed * betsPerWeek * 4 * (avgRoi * 0.5 / 100)
  // avgStake_needed = 249.50 / (betsPerWeek * 4 * avgRoi * 0.5 / 100)
  const roiFactor = (avgRoiPerBet * 0.5) / 100;
  const minimumBankrollFor2MonthRecoup =
    betsPerWeek > 0 && roiFactor > 0
      ? Math.ceil((SYSTEM_COST / 2) / (betsPerWeek * 4 * roiFactor))
      : null;

  res.json({
    avgRoiPerBet: Math.round(avgRoiPerBet * 100) / 100,
    betsPerWeek: Math.round(betsPerWeek * 10) / 10,
    avgStake: Math.round(avgStake * 100) / 100,
    projectedMonthlyProfitConservative:
      Math.round(monthlyProfitConservative * 100) / 100,
    projectedMonthlyProfitModerate:
      Math.round(monthlyProfitModerate * 100) / 100,
    projectedMonthlyProfitOptimistic:
      Math.round(monthlyProfitOptimistic * 100) / 100,
    monthsToRecoupConservative:
      monthsConservative !== null
        ? Math.round(monthsConservative * 10) / 10
        : null,
    monthsToRecoupModerate:
      monthsModerate !== null
        ? Math.round(monthsModerate * 10) / 10
        : null,
    monthsToRecoupOptimistic:
      monthsOptimistic !== null
        ? Math.round(monthsOptimistic * 10) / 10
        : null,
    minimumBankrollFor2MonthRecoup,
    trafficLightSignal,
    totalSettledBets,
    paperTradingDays,
    systemCost: SYSTEM_COST,
  });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/narratives
// ─────────────────────────────────────────────
router.get("/dashboard/narratives", async (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? "20"), 100);
  const rows = await db
    .select()
    .from(learningNarrativesTable)
    .orderBy(desc(learningNarrativesTable.createdAt))
    .limit(limit);
  res.json({ count: rows.length, narratives: rows });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/model
// ─────────────────────────────────────────────
router.get("/dashboard/model", async (req, res) => {
  const latest = await db
    .select()
    .from(modelStateTable)
    .orderBy(desc(modelStateTable.createdAt))
    .limit(1);

  const history = await db
    .select({
      modelVersion: modelStateTable.modelVersion,
      accuracyScore: modelStateTable.accuracyScore,
      calibrationScore: modelStateTable.calibrationScore,
      totalBetsTrainedOn: modelStateTable.totalBetsTrainedOn,
      createdAt: modelStateTable.createdAt,
    })
    .from(modelStateTable)
    .orderBy(asc(modelStateTable.createdAt));

  const current = latest[0];
  if (!current) {
    res.json({ modelLoaded: false });
    return;
  }

  // Sort feature importances and take top 10
  const fi = (current.featureImportances as Record<string, number> | null) ?? {};
  const topFeatures = Object.entries(fi)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([feature, weight], i) => ({ rank: i + 1, feature, weight }));

  res.json({
    modelLoaded: true,
    currentVersion: current.modelVersion,
    accuracyScore: current.accuracyScore ? Number(current.accuracyScore) : null,
    calibrationScore: current.calibrationScore
      ? Number(current.calibrationScore)
      : null,
    totalBetsTrainedOn: current.totalBetsTrainedOn,
    createdAt: current.createdAt,
    topFeatureImportances: topFeatures,
    accuracyHistory: history.map((h) => ({
      version: h.modelVersion,
      accuracy: h.accuracyScore ? Number(h.accuracyScore) : null,
      calibration: h.calibrationScore ? Number(h.calibrationScore) : null,
      trainedOn: h.totalBetsTrainedOn,
      date: h.createdAt,
    })),
  });
});

// ─────────────────────────────────────────────
// GET /api/compliance/logs
// ─────────────────────────────────────────────
router.get("/compliance/logs", async (req, res) => {
  const { page, limit, offset } = paginate(
    req.query["page"],
    req.query["limit"],
    500,
  );
  const actionTypeFilter = String(req.query["action_type"] ?? "all");
  const dateFrom = req.query["date_from"] ? new Date(String(req.query["date_from"])) : null;
  const dateTo = req.query["date_to"] ? new Date(String(req.query["date_to"])) : null;

  const conditions = [];
  if (actionTypeFilter !== "all" && actionTypeFilter) {
    conditions.push(eq(complianceLogsTable.actionType, actionTypeFilter));
  }
  if (dateFrom && !isNaN(dateFrom.getTime())) {
    conditions.push(gte(complianceLogsTable.timestamp, dateFrom));
  }
  if (dateTo && !isNaN(dateTo.getTime())) {
    const endOfDay = new Date(dateTo);
    endOfDay.setHours(23, 59, 59, 999);
    conditions.push(lte(complianceLogsTable.timestamp, endOfDay));
  }
  const condition = conditions.length > 0 ? and(...conditions) : undefined;

  const [logs, countResult] = await Promise.all([
    db
      .select()
      .from(complianceLogsTable)
      .where(condition)
      .orderBy(desc(complianceLogsTable.timestamp))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(complianceLogsTable)
      .where(condition),
  ]);

  res.json({
    page,
    limit,
    total: countResult[0]?.count ?? 0,
    totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
    logs,
  });
});

// ─────────────────────────────────────────────
// GET /api/compliance/stats
// ─────────────────────────────────────────────
router.get("/compliance/stats", async (_req, res) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [totalResult, todayResult, riskResult] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(complianceLogsTable),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(complianceLogsTable)
      .where(gte(complianceLogsTable.timestamp, todayStart)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(complianceLogsTable)
      .where(eq(complianceLogsTable.actionType, "risk_event")),
  ]);

  res.json({
    totalEvents: totalResult[0]?.count ?? 0,
    eventsToday: todayResult[0]?.count ?? 0,
    circuitBreakerActivations: riskResult[0]?.count ?? 0,
  });
});

// ─────────────────────────────────────────────
// GET /api/compliance/export?format=csv
// ─────────────────────────────────────────────
router.get("/compliance/export", async (req, res) => {
  const format = String(req.query["format"] ?? "csv").toLowerCase();

  const logs = await db
    .select()
    .from(complianceLogsTable)
    .orderBy(desc(complianceLogsTable.timestamp));

  if (format === "csv") {
    const csvEscape = (v: unknown): string => {
      const str = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
      // Wrap in quotes and escape internal quotes
      return `"${str.replace(/"/g, '""')}"`;
    };

    const headers = ["id", "action_type", "timestamp", "details"];
    const rows = logs.map((l) =>
      [
        csvEscape(l.id),
        csvEscape(l.actionType),
        csvEscape(l.timestamp?.toISOString()),
        csvEscape(l.details),
      ].join(","),
    );

    const csv = [headers.join(","), ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="compliance_log_${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
    return;
  }

  res.status(400).json({ error: 'Unsupported format. Use ?format=csv' });
});

// ─────────────────────────────────────────────
// POST /api/agent/control
// ─────────────────────────────────────────────
router.post("/agent/control", async (req, res) => {
  const { action } = req.body as { action?: string };

  if (!action || !["start", "pause", "stop"].includes(action)) {
    res.status(400).json({
      error: "Invalid action. Must be one of: start, pause, stop",
    });
    return;
  }

  const currentStatus = await getAgentStatus();

  let newStatus: string;
  if (action === "start") {
    if (currentStatus === "stopped") {
      res
        .status(400)
        .json({ error: "Cannot start a stopped agent — bankroll below floor" });
      return;
    }
    newStatus = "running";
  } else if (action === "pause") {
    newStatus = "paused_manual";
  } else {
    newStatus = "stopped_manual";
  }

  await setConfigValue("agent_status", newStatus);

  await db.insert(complianceLogsTable).values({
    actionType: "agent_control",
    details: {
      action,
      previousStatus: currentStatus,
      newStatus,
      initiatedBy: "api",
    },
    timestamp: new Date(),
  });

  logger.info({ action, previousStatus: currentStatus, newStatus }, "Agent control action");

  res.json({
    success: true,
    action,
    previousStatus: currentStatus,
    newStatus,
  });
});

// ─────────────────────────────────────────────
// POST /api/agent/config
// ─────────────────────────────────────────────
const ALLOWED_CONFIG_KEYS = new Set([
  "bankroll",
  "max_stake_pct",
  "min_edge_threshold",
  "daily_loss_limit_pct",
  "weekly_loss_limit_pct",
  "bankroll_floor",
  "max_exposure_pct",
  "paper_mode",
]);

router.post("/agent/config", async (req, res) => {
  const updates = req.body as Record<string, unknown>;
  const changed: Record<string, { from: string | null; to: string }> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      rejected.push(key);
      continue;
    }

    // Boolean string keys (paper_mode) don't go through numeric validation
    if (key === "paper_mode") {
      const strVal = String(value).toLowerCase();
      if (strVal !== "true" && strVal !== "false") {
        rejected.push(`${key} (must be "true" or "false")`);
        continue;
      }
      const previous = await getConfigValue(key);
      await setConfigValue(key, strVal);
      changed[key] = { from: previous, to: strVal };
      continue;
    }

    const numVal = Number(value);
    if (isNaN(numVal) || numVal < 0) {
      rejected.push(`${key} (invalid value: ${value})`);
      continue;
    }

    // Specific guards
    if (key === "max_stake_pct" && numVal > 0.1) {
      rejected.push(`${key} (max 10%)`);
      continue;
    }
    if (key === "bankroll" && numVal < 10) {
      rejected.push(`${key} (minimum £10)`);
      continue;
    }

    const previous = await getConfigValue(key);
    await setConfigValue(key, String(numVal));
    changed[key] = { from: previous, to: String(numVal) };
  }

  if (Object.keys(changed).length > 0) {
    await db.insert(complianceLogsTable).values({
      actionType: "config_change",
      details: { changed, rejected, initiatedBy: "api" },
      timestamp: new Date(),
    });

    logger.info({ changed }, "Agent config updated via API");
  }

  res.json({
    success: true,
    changed,
    rejected: rejected.length > 0 ? rejected : undefined,
  });
});

// ─────────────────────────────────────────────
// POST /api/ingestion/run  — manual trigger
// ─────────────────────────────────────────────
router.post("/ingestion/run", async (req, res) => {
  const before = getSchedulerStatus();
  if (before["ingestion"]?.isRunning) {
    res.status(409).json({ success: false, message: "Ingestion already in progress" });
    return;
  }
  logger.info("Manual ingestion triggered via API");
  try {
    await runIngestionNow();
    const after = getSchedulerStatus();
    res.json({
      success: true,
      message: "Ingestion complete",
      job: after["ingestion"],
    });
  } catch (err) {
    logger.error({ err }, "Manual ingestion failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/features/run  — manual trigger
// ─────────────────────────────────────────────
router.post("/features/run", async (req, res) => {
  const before = getSchedulerStatus();
  if (before["features"]?.isRunning) {
    res.status(409).json({ success: false, message: "Feature computation already in progress" });
    return;
  }
  logger.info("Manual feature computation triggered via API");
  try {
    const result = await runFeaturesNow();
    const after = getSchedulerStatus();
    res.json({
      success: true,
      message: "Feature computation complete",
      result,
      job: after["features"],
    });
  } catch (err) {
    logger.error({ err }, "Manual feature computation failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/trading/run  — manual trigger
// ─────────────────────────────────────────────
router.post("/trading/run", async (req, res) => {
  const before = getSchedulerStatus();
  if (before["trading"]?.isRunning) {
    res.status(409).json({ success: false, message: "Trading cycle already in progress" });
    return;
  }
  logger.info("Manual trading cycle triggered via API");
  try {
    const result = await runTradingCycle();
    const after = getSchedulerStatus();
    res.json({
      success: true,
      message: "Trading cycle complete",
      result,
      job: after["trading"],
    });
  } catch (err) {
    logger.error({ err }, "Manual trading cycle failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/trading/backfill-stats
// Fetch real corners/cards stats for already-finished matches and re-settle
// any voided bets that can now be determined
// ─────────────────────────────────────────────
router.post("/trading/backfill-stats", async (_req, res) => {
  logger.info("Manual corners/cards stats backfill triggered");
  try {
    const result = await backfillCornersCardsStats();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Corners/cards stats backfill failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/trading/dedup-pending
// Remove correlated duplicate pending bets (threshold dedup + cross-market + max 2/match)
// ─────────────────────────────────────────────
router.post("/trading/dedup-pending", async (_req, res) => {
  logger.info("Manual pending-bet deduplication triggered");
  try {
    const result = await deduplicatePendingBets();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Pending bet deduplication failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/trading/corrected-stats
// Compute settled-bet stats excluding correlated threshold duplicates.
// For each match, within each market category (goals_ou / corners / cards),
// only the bet with the highest opportunity score is counted.
// ─────────────────────────────────────────────
router.get("/trading/corrected-stats", async (_req, res) => {
  try {
    // Get all settled bets (won/lost) with opportunity scores
    const rows = await db
      .select({
        id: paperBetsTable.id,
        matchId: paperBetsTable.matchId,
        marketType: paperBetsTable.marketType,
        selectionName: paperBetsTable.selectionName,
        stake: paperBetsTable.stake,
        settlementPnl: paperBetsTable.settlementPnl,
        status: paperBetsTable.status,
        opportunityScore: paperBetsTable.opportunityScore,
        oddsAtPlacement: paperBetsTable.oddsAtPlacement,
      })
      .from(paperBetsTable)
      .where(inArray(paperBetsTable.status, ["won", "lost"]));

    // Group by match+category, keep highest-scored
    const keptBetIds = new Set<number>();
    const byMatchCategory = new Map<string, typeof rows>();

    for (const bet of rows) {
      const cat = getThresholdCategory(bet.marketType);
      const groupKey = cat ? `${bet.matchId}:${cat}` : `${bet.matchId}:${bet.marketType}:${bet.selectionName}`;
      const arr = byMatchCategory.get(groupKey) ?? [];
      arr.push(bet);
      byMatchCategory.set(groupKey, arr);
    }

    for (const [, group] of byMatchCategory) {
      // Keep the one with the highest opportunity score
      group.sort((a, b) => (Number(b.opportunityScore) || 0) - (Number(a.opportunityScore) || 0));
      keptBetIds.add(group[0]!.id);
      // For non-threshold single-bet groups, all are unique — they're already added
      if (group.length === 1) keptBetIds.add(group[0]!.id);
    }

    const correctedBets = rows.filter((b) => keptBetIds.has(b.id));
    const allBets = rows;

    const computeStats = (bets: typeof rows) => {
      const won = bets.filter((b) => b.status === "won").length;
      const lost = bets.filter((b) => b.status === "lost").length;
      const total = won + lost;
      const winRate = total > 0 ? Math.round((won / total) * 1000) / 10 : 0;
      const totalStake = bets.reduce((s, b) => s + Number(b.stake), 0);
      const totalPnl = bets.reduce((s, b) => s + Number(b.settlementPnl), 0);
      const roi = totalStake > 0 ? Math.round((totalPnl / totalStake) * 1000) / 10 : 0;
      return { total, won, lost, winRate, totalStake: Math.round(totalStake * 100) / 100, totalPnl: Math.round(totalPnl * 100) / 100, roi };
    };

    const raw = computeStats(allBets);
    const corrected = computeStats(correctedBets);

    const removedCount = allBets.length - correctedBets.length;
    const corruptedBetIds = allBets.filter((b) => !keptBetIds.has(b.id)).map((b) => b.id);

    res.json({
      raw,
      corrected,
      removedCorrelatedCount: removedCount,
      corruptedBetIds,
      note: "Corrected stats count only one bet per match per market category (threshold dedup). Cross-market correlation dedup not applied to historical settled bets — apply manually if needed.",
    });
  } catch (err) {
    logger.error({ err }, "Corrected stats calculation failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/api-budget
// ─────────────────────────────────────────────
router.get("/dashboard/api-budget", async (_req, res) => {
  const budget = await getApiBudgetStatus();
  res.json(budget);
});

// ─────────────────────────────────────────────
// GET /api/dashboard/commission — commission tracking stats
// ─────────────────────────────────────────────
router.get("/dashboard/commission", async (_req, res) => {
  try {
    const { getCommissionStats, getExchanges } = await import("../services/commissionService");
    const [stats, exchanges] = await Promise.all([
      getCommissionStats(),
      getExchanges(),
    ]);
    res.json({ ...stats, exchanges });
  } catch (err) {
    logger.error({ err }, "Failed to fetch commission stats");
    res.status(500).json({ error: "Failed to fetch commission stats" });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/tournament — tournament mode & seasonal awareness
// ─────────────────────────────────────────────
router.get("/dashboard/tournament", async (_req, res) => {
  try {
    const { getTournamentStatus, isTransferWindowActive, getTransferWindowUncertainty } = await import("../services/tournamentMode");
    const status = await getTournamentStatus();
    const transferWindow = {
      isActive: isTransferWindowActive(),
      ...getTransferWindowUncertainty(),
    };
    res.json({ ...status, transferWindow });
  } catch (err) {
    logger.error({ err }, "Failed to fetch tournament status");
    res.status(500).json({ error: "Failed to fetch tournament status" });
  }
});

// ─────────────────────────────────────────────
// POST /api/odds/fetch — trigger API-Football odds ingestion
// ─────────────────────────────────────────────
router.post("/odds/fetch", async (_req, res) => {
  logger.info("Manual API-Football odds ingestion triggered");
  try {
    const result = await fetchAndStoreOddsForAllUpcoming();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "API-Football odds ingestion failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/clv-stats
// ─────────────────────────────────────────────
router.get("/dashboard/clv-stats", async (_req, res) => {
  try {
    // All settled bets with CLV data (proxy or Pinnacle closing line)
    const rows = await db
      .select({
        clvPct: paperBetsTable.clvPct,
        placedAt: paperBetsTable.placedAt,
        marketType: paperBetsTable.marketType,
        status: paperBetsTable.status,
        pinnacleOdds: paperBetsTable.pinnacleOdds,
        closingPinnacleOdds: (paperBetsTable as any).closingPinnacleOdds,
        isContrarian: paperBetsTable.isContrarian,
        stake: paperBetsTable.stake,
        settlementPnl: paperBetsTable.settlementPnl,
      })
      .from(paperBetsTable)
      .where(
        and(
          sql`${paperBetsTable.clvPct} IS NOT NULL`,
          sql`${paperBetsTable.status} IN ('won','lost')`,
          REAL_MONEY,
        ),
      )
      .orderBy(asc(paperBetsTable.placedAt))
      .limit(500);

    if (rows.length === 0) {
      return res.json({ count: 0, avgClv: null, trend: [], pinnacleCount: 0, contrarianCount: 0, pinnacleClosingCount: 0, pinnacleAlignedStats: null, contrarianStats: null, pinnacleClosingCoveragePct: 0 });
    }

    const clvValues = rows.map((r) => Number(r.clvPct));
    const avgClv = clvValues.reduce((a, b) => a + b, 0) / clvValues.length;

    // Pinnacle data counts
    const pinnacleCount = rows.filter((r) => r.pinnacleOdds != null).length;
    const pinnacleClosingCount = rows.filter((r) => (r as any).closingPinnacleOdds != null).length;
    const contrarianCount = rows.filter((r) => r.isContrarian === "true").length;

    // Total settled (won + lost) for coverage % — real-money only
    const totalSettledRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(paperBetsTable)
      .where(and(sql`${paperBetsTable.status} IN ('won','lost')`, REAL_MONEY));
    const totalSettled = Number(totalSettledRows[0]?.count ?? rows.length);
    const pinnacleClosingCoveragePct = totalSettled > 0 ? Math.round((pinnacleClosingCount / totalSettled) * 100) : 0;

    // Pinnacle-aligned vs contrarian win rate, ROI, avg CLV
    const pinnacleAlignedRows = rows.filter((r) => r.isContrarian !== "true" && r.pinnacleOdds != null);
    const contrarianRows = rows.filter((r) => r.isContrarian === "true");

    function groupStats(bets: typeof rows) {
      if (bets.length === 0) return null;
      const won = bets.filter((b) => b.status === "won").length;
      const lost = bets.filter((b) => b.status === "lost").length;
      const totalStake = bets.reduce((s, b) => s + Number(b.stake), 0);
      const totalPnl = bets.reduce((s, b) => s + Number(b.settlementPnl ?? 0), 0);
      const clvs = bets.map((b) => Number(b.clvPct));
      const avgClvGroup = clvs.reduce((a, b) => a + b, 0) / clvs.length;
      return {
        count: bets.length,
        won,
        lost,
        winRatePct: Math.round((won / (won + lost)) * 1000) / 10,
        totalPnl: Math.round(totalPnl * 100) / 100,
        roiPct: totalStake > 0 ? Math.round((totalPnl / totalStake) * 1000) / 10 : 0,
        avgClv: Math.round(avgClvGroup * 1000) / 1000,
      };
    }

    const trend = rows.map((r) => ({
      date: new Date(r.placedAt).toISOString().slice(0, 10),
      clv: Number(r.clvPct),
      market: r.marketType,
      pinnacleClosing: (r as any).closingPinnacleOdds != null,
    }));

    res.json({
      count: rows.length,
      avgClv: Math.round(avgClv * 1000) / 1000,
      pinnacleCount,
      pinnacleClosingCount,
      contrarianCount,
      pinnacleClosingCoveragePct,
      totalSettled,
      pinnacleAlignedStats: groupStats(pinnacleAlignedRows),
      contrarianStats: groupStats(contrarianRows),
      trend,
    });
  } catch (err) {
    logger.error({ err }, "CLV stats query failed");
    res.status(500).json({ error: "Failed to compute CLV stats" });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/oddspapi-budget
// ─────────────────────────────────────────────
router.get("/dashboard/oddspapi-budget", async (_req, res) => {
  try {
    const status = await getOddspapiStatus();
    res.json(status);
  } catch (err) {
    logger.error({ err }, "Failed to get OddsPapi budget status");
    res.status(500).json({ error: "Failed to retrieve OddsPapi budget status" });
  }
});

// ─────────────────────────────────────────────
// GET /api/leagues/edge-scores — league edge scores with coverage info
// ─────────────────────────────────────────────
router.get("/leagues/edge-scores", async (_req, res) => {
  try {
    const [edgeRows, coverageRows] = await Promise.all([
      db
        .select()
        .from(leagueEdgeScoresTable)
        .orderBy(desc(leagueEdgeScoresTable.confidenceScore)),
      db
        .select()
        .from(oddspapiLeagueCoverageTable),
    ]);

    const coverageMap = new Map(coverageRows.map((r) => [r.league, r]));

    const rows = edgeRows.map((r) => {
      const cov = coverageMap.get(r.league);
      const leagueBonus = Math.max(-10, Math.min(10, (r.confidenceScore - 50) / 5));
      return {
        league: r.league,
        marketType: r.marketType,
        confidenceScore: r.confidenceScore,
        leagueBonus: Math.round(leagueBonus * 10) / 10,
        totalBets: r.totalBets,
        wins: r.wins,
        losses: r.losses,
        roiPct: r.roiPct,
        avgClv: r.avgClv,
        avgEdge: r.avgEdge,
        isSeedData: r.isSeedData === 1,
        lastUpdated: r.lastUpdated,
        oddsPapiCoverage: cov ? (cov.hasOdds === 1 ? "covered" : "no-coverage") : "unknown",
      };
    });

    res.json({ rows, count: rows.length });
  } catch (err) {
    logger.error({ err }, "Failed to fetch league edge scores");
    res.status(500).json({ error: "Failed to retrieve league edge scores" });
  }
});

// ─────────────────────────────────────────────
// POST /api/oddspapi/prefetch — manually trigger multi-market odds prefetch
// Accepts optional JSON body: { maxFetches: number } (default 40)
// ─────────────────────────────────────────────
router.post("/oddspapi/prefetch", async (req, res) => {
  const maxFetches = Number((req.body as Record<string, unknown>)?.maxFetches ?? 40);
  const now = new Date();
  const earliest = new Date(now.getTime() + 1 * 60 * 60 * 1000);
  const latest   = new Date(now.getTime() + 168 * 60 * 60 * 1000);
  logger.info({ maxFetches }, "Manual OddsPapi multi-market prefetch triggered");
  try {
    const cache = await prefetchAndStoreOddsPapiOdds(earliest, latest, maxFetches);
    const totalSelections = [...cache.values()].reduce((n, m) => n + Object.keys(m).length, 0);
    res.json({ success: true, fixturesFetched: cache.size, totalSelections });
  } catch (err) {
    logger.error({ err }, "OddsPapi prefetch failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/oddspapi/map-fixtures — manually trigger fixture mapping
// ─────────────────────────────────────────────
router.post("/oddspapi/map-fixtures", async (_req, res) => {
  logger.info("Manual OddsPapi fixture mapping triggered");
  try {
    const result = await runOddspapiMappingNow();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "OddsPapi fixture mapping failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/oddspapi/bulk-prefetch — trigger a dedicated bulk prefetch
// Body: { windowDays?: number, maxFetches?: number }
// Defaults: windowDays=7, maxFetches=80
// ─────────────────────────────────────────────
router.post("/oddspapi/bulk-prefetch", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const windowDays = Math.min(Number(body?.windowDays ?? 7), 14);
  const maxFetches = Math.min(Number(body?.maxFetches ?? 80), 150);
  logger.info({ windowDays, maxFetches }, "Manual OddsPapi bulk prefetch triggered");
  try {
    const result = await runDedicatedBulkPrefetch(windowDays, maxFetches);
    res.json({ success: true, windowDays, maxFetches, ...result });
  } catch (err) {
    logger.error({ err }, "Manual OddsPapi bulk prefetch failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/oddspapi/coverage-report — per-league fixture mapping coverage
// ─────────────────────────────────────────────
router.get("/oddspapi/coverage-report", async (_req, res) => {
  try {
    const window7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [totalUpcoming, mappedRows] = await Promise.all([
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(matchesTable)
        .where(
          and(
            eq(matchesTable.status, "scheduled"),
            gte(matchesTable.kickoffTime, new Date()),
            lte(matchesTable.kickoffTime, window7d),
          ),
        ),
      db
        .select({
          matchId: oddspapiFixtureMapTable.matchId,
          oddspapiFixtureId: oddspapiFixtureMapTable.oddspapiFixtureId,
        })
        .from(oddspapiFixtureMapTable),
    ]);

    const mappedMatchIds = new Set(mappedRows.map((r) => r.matchId));
    const allUpcoming = await db
      .select({ id: matchesTable.id, league: matchesTable.league, homeTeam: matchesTable.homeTeam, awayTeam: matchesTable.awayTeam, kickoffTime: matchesTable.kickoffTime })
      .from(matchesTable)
      .where(
        and(
          eq(matchesTable.status, "scheduled"),
          gte(matchesTable.kickoffTime, new Date()),
          lte(matchesTable.kickoffTime, window7d),
        ),
      );

    const perLeague: Record<string, { total: number; mapped: number; fixtures: Array<{ home: string; away: string; kickoff: string; mapped: boolean }> }> = {};
    for (const m of allUpcoming) {
      const lg = m.league ?? "Unknown";
      if (!perLeague[lg]) perLeague[lg] = { total: 0, mapped: 0, fixtures: [] };
      perLeague[lg].total++;
      const isMapped = mappedMatchIds.has(m.id);
      if (isMapped) perLeague[lg].mapped++;
      perLeague[lg].fixtures.push({ home: m.homeTeam, away: m.awayTeam, kickoff: m.kickoffTime.toISOString(), mapped: isMapped });
    }

    const summary = Object.entries(perLeague)
      .map(([league, data]) => ({
        league,
        total: data.total,
        mapped: data.mapped,
        unmapped: data.total - data.mapped,
        coveragePct: Math.round(data.mapped / data.total * 100),
        fixtures: data.fixtures,
      }))
      .sort((a, b) => b.total - a.total);

    res.json({
      totalUpcoming: Number(totalUpcoming[0]?.count ?? 0),
      totalMapped: mappedMatchIds.size,
      overallCoveragePct: totalUpcoming[0]?.count
        ? Math.round(mappedMatchIds.size / Number(totalUpcoming[0].count) * 100)
        : 0,
      perLeague: summary,
    });
  } catch (err) {
    logger.error({ err }, "OddsPapi coverage report failed");
    res.status(500).json({ error: "Failed to retrieve coverage report" });
  }
});

// GET /api/oddspapi/match-diagnostic — deep near-miss analysis for all unmapped fixtures
router.get("/oddspapi/match-diagnostic", async (_req, res) => {
  try {
    const result = await runMatchDiagnostic();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Match diagnostic failed");
    res.status(500).json({ error: "Failed to run match diagnostic" });
  }
});

// ─────────────────────────────────────────────
// POST /api/admin/settle — run full settlement pipeline (sync results + settle + backfill)
// ─────────────────────────────────────────────
router.post("/admin/settle", async (_req, res) => {
  try {
    const result = await runSettlementNow();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Manual settlement failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/admin/void-banned-bets — void all pending bets on banned markets
// Refunds stakes to bankroll. Safe to run multiple times (idempotent).
// ─────────────────────────────────────────────
router.post("/admin/void-banned-bets", async (_req, res) => {
  logger.info("Manual void-banned-bets triggered via API");
  try {
    const result = await voidBetsOnBannedMarkets();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "void-banned-bets failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/xg/teams — latest xG rolling stats for all teams
// ─────────────────────────────────────────────
router.get("/xg/teams", async (_req, res) => {
  try {
    const teams = await getAllTeamXGStats();
    res.json({ count: teams.length, teams });
  } catch (err) {
    logger.error({ err }, "xG teams fetch failed");
    res.status(500).json({ message: "Failed to fetch xG team stats" });
  }
});

// ─────────────────────────────────────────────
// POST /api/xg/refresh — manually trigger xG ingestion
// ─────────────────────────────────────────────
router.post("/xg/refresh", async (_req, res) => {
  logger.info("Manual xG ingestion triggered via API");
  try {
    const result = await runXGIngestionNow();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Manual xG ingestion failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/scan-stats — league, fixture, market coverage stats
// ─────────────────────────────────────────────
router.get("/dashboard/scan-stats", async (_req, res) => {
  try {
    const stats = await getScanStats();
    res.json(stats);
  } catch (err) {
    logger.error({ err }, "Scan stats query failed");
    res.status(500).json({ error: "Failed to retrieve scan stats" });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/line-movements — line movements detected today
// ─────────────────────────────────────────────
router.get("/dashboard/line-movements", async (_req, res) => {
  try {
    const movements = await getTodayLineMovements();
    res.json({ count: movements.length, movements });
  } catch (err) {
    logger.error({ err }, "Line movements query failed");
    res.status(500).json({ error: "Failed to retrieve line movements" });
  }
});

// ─────────────────────────────────────────────
// GET /api/leagues/discovered — all discovered leagues with status
// ─────────────────────────────────────────────
router.get("/leagues/discovered", async (_req, res) => {
  try {
    const leagues = await getDiscoveredLeagues();
    res.json(leagues);
  } catch (err) {
    logger.error({ err }, "Discovered leagues query failed");
    res.status(500).json({ error: "Failed to retrieve discovered leagues" });
  }
});

// ─────────────────────────────────────────────
// GET /api/leagues/discovery-stats — summary stats for league discovery
// ─────────────────────────────────────────────
router.get("/leagues/discovery-stats", async (_req, res) => {
  try {
    const stats = await getDiscoveryStats();
    res.json(stats);
  } catch (err) {
    logger.error({ err }, "Discovery stats query failed");
    res.status(500).json({ error: "Failed to retrieve discovery stats" });
  }
});

// ─────────────────────────────────────────────
// POST /api/leagues/discovery/run — trigger league discovery now
// ─────────────────────────────────────────────
router.post("/leagues/discovery/run", async (_req, res) => {
  try {
    logger.info("Manual league discovery triggered via API");
    const result = await runLeagueDiscoveryNow();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual league discovery failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/leagues/ingest-fixtures — ingest fixtures for all discovered active leagues
// ─────────────────────────────────────────────
router.post("/leagues/ingest-fixtures", async (_req, res) => {
  try {
    logger.info("Manual discovered-league fixture ingestion triggered via API");
    const result = await runIngestDiscoveredFixturesNow();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual fixture ingestion failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// Experiment Pipeline API
// ─────────────────────────────────────────────

import { getExperimentsSummary, getExperimentDetail, getPromotionLog, getLatestLearningJournal, manualPromote, runPromotionEngine, backfillExperimentTags } from "../services/promotionEngine";
import { syncDevToProd, getSyncStatus } from "../services/syncDevToProd";

router.get("/admin/experiments", async (_req, res) => {
  try {
    const experiments = await getExperimentsSummary();
    const thresholds = {
      minSampleSize: parseInt(process.env.PROMO_MIN_SAMPLE_SIZE ?? "30"),
      minRoi: parseFloat(process.env.PROMO_MIN_ROI ?? "3.0"),
      minClv: parseFloat(process.env.PROMO_MIN_CLV ?? "1.5"),
      minWinRate: parseFloat(process.env.PROMO_MIN_WIN_RATE ?? "52.0"),
      maxPValue: parseFloat(process.env.PROMO_MAX_P_VALUE ?? "0.10"),
      minWeeksActive: parseInt(process.env.PROMO_MIN_WEEKS_ACTIVE ?? "3"),
      minEdge: parseFloat(process.env.PROMO_MIN_EDGE ?? "2.0"),
    };
    const betsPerWeekByTag: Record<string, number> = {};
    try {
      const bpw = await pool.query(`
        SELECT experiment_tag, COUNT(*)::int as cnt
        FROM paper_bets
        WHERE placed_at > NOW() - INTERVAL '14 days' AND experiment_tag IS NOT NULL
        GROUP BY experiment_tag
      `);
      for (const r of bpw.rows) {
        betsPerWeekByTag[r.experiment_tag] = Math.round((r.cnt / 2) * 10) / 10;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to fetch bets/week by tag for experiments enrichment");
    }

    const mostRecentBetByTag: Record<string, string> = {};
    try {
      const mrb = await pool.query(`
        SELECT experiment_tag, MAX(placed_at) as latest
        FROM paper_bets
        WHERE experiment_tag IS NOT NULL
        GROUP BY experiment_tag
      `);
      for (const r of mrb.rows) {
        mostRecentBetByTag[r.experiment_tag] = r.latest;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to fetch most recent bet by tag for experiments enrichment");
    }

    const enriched = experiments
      .map(e => {
        const tag = e.experimentTag ?? e.id;
        const sample = e.currentSampleSize ?? 0;
        const betsPerWeek = betsPerWeekByTag[tag] ?? 0;
        const betsNeeded = Math.max(0, thresholds.minSampleSize - sample);
        const estWeeks = betsPerWeek > 0 ? Math.ceil(betsNeeded / betsPerWeek) : null;

        const tierChangedMs = e.tierChangedAt ? new Date(e.tierChangedAt).getTime() : 0;
        const weeksActive = tierChangedMs > 0 ? Math.floor((Date.now() - tierChangedMs) / (7 * 24 * 3600 * 1000)) : 0;

        const pSample = Math.min(100, Math.round((sample / thresholds.minSampleSize) * 100));
        const pWeeks = Math.min(100, Math.round((weeksActive / thresholds.minWeeksActive) * 100));
        const pRoi = Math.min(100, Math.round(Math.max(0, (e.currentRoi ?? 0) / thresholds.minRoi) * 100));
        const pClv = Math.min(100, Math.round(Math.max(0, (e.currentClv ?? 0) / thresholds.minClv) * 100));
        const pWinRate = Math.min(100, Math.round(Math.max(0, (e.currentWinRate ?? 0) / thresholds.minWinRate) * 100));
        const pPValue = (e.currentPValue ?? 1) <= thresholds.maxPValue ? 100 : Math.min(100, Math.round(Math.max(0, (1 - (e.currentPValue ?? 1)) / (1 - thresholds.maxPValue)) * 100));
        const pEdge = Math.min(100, Math.round(Math.max(0, (e.currentEdge ?? 0) / thresholds.minEdge) * 100));

        const overall = Math.min(100, Math.max(0, Math.round(
          pSample * 0.50 + pWeeks * 0.15 + pRoi * 0.10 + pClv * 0.10 + pWinRate * 0.05 + pPValue * 0.05 + pEdge * 0.05
        )));

        return {
          experimentTag: tag,
          leagueCode: e.leagueCode,
          marketType: e.marketType,
          dataTier: e.dataTier,
          sampleSize: sample,
          roi: e.currentRoi ?? 0,
          clv: e.currentClv ?? 0,
          winRate: e.currentWinRate ?? 0,
          pValue: e.currentPValue ?? 1,
          edge: e.currentEdge ?? 0,
          consecutiveNegativeWeeks: e.consecutiveNegativeWeeks ?? 0,
          tierChangedAt: e.tierChangedAt,
          betsPerWeek,
          estWeeksToEval: estWeeks,
          lastBetAt: mostRecentBetByTag[tag] ?? null,
          progress: { sampleSize: pSample, roi: pRoi, clv: pClv, winRate: pWinRate, pValue: pPValue, edge: pEdge, weeks: pWeeks, overall },
          distance: {
            betsNeeded,
            roiNeeded: Math.max(0, thresholds.minRoi - (e.currentRoi ?? 0)),
            clvNeeded: Math.max(0, thresholds.minClv - (e.currentClv ?? 0)),
            winRateNeeded: Math.max(0, thresholds.minWinRate - (e.currentWinRate ?? 0)),
          },
        };
      })
      .sort((a, b) => b.sampleSize - a.sampleSize);
    const grouped = {
      experiment: enriched.filter(e => e.dataTier === "experiment" && e.sampleSize > 0),
      candidate: enriched.filter(e => e.dataTier === "candidate"),
      promoted: enriched.filter(e => e.dataTier === "promoted"),
      demoted: enriched.filter(e => e.dataTier === "demoted"),
      abandoned: enriched.filter(e => e.dataTier === "abandoned"),
    };
    res.json({ success: true, grouped, total: enriched.length, thresholds });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/experiments/:tag", async (req, res) => {
  try {
    const detail = await getExperimentDetail(req.params.tag);
    res.json({ success: true, ...detail });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/promotion-log", async (_req, res) => {
  try {
    const log = await getPromotionLog();
    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/circuit-breaker-status", async (_req, res) => {
  try {
    const { getCircuitStatus } = await import("../services/resilientFetch");
    const status = await getCircuitBreakerStatus();
    res.json({
      success: true,
      ...status,
      apiCircuitBreakers: {
        apiFootball: getCircuitStatus("api-football"),
        oddsPapi: getCircuitStatus("oddspapi"),
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to get circuit breaker status");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/cancel-bet", async (req, res) => {
  try {
    const { internalBetId } = req.body;
    if (!internalBetId) return res.status(400).json({ error: "internalBetId required" });
    const result0 = await db.execute(sql`SELECT betfair_market_id, betfair_bet_id, betfair_status, betfair_size_matched, stake FROM paper_bets WHERE id=${internalBetId}`);
    const rows = (result0 as any).rows ?? result0;
    if (!rows || rows.length === 0) return res.status(404).json({ error: "bet not found" });
    const b = rows[0];
    if (!b.betfair_bet_id || !b.betfair_market_id) return res.status(400).json({ error: "no betfair ids" });
    const result = await cancelOrders(b.betfair_market_id, [{ betId: b.betfair_bet_id }]);
    res.json({ success: true, internalBetId, betfair: b, cancelResult: result });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/set-config", async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ error: "key and value required" });
    }
    await setConfigValue(key, String(value));
    const verify = await getConfigValue(key);
    res.json({ success: true, key, value: verify });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/resume-agent", async (_req, res) => {
  try {
    await resumeAgent();
    const status = await getAgentStatus();
    res.json({ success: true, agentStatus: status });
  } catch (err) {
    logger.error({ err }, "Failed to resume agent");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/map-betfair-events", async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, Number(req.query["hours"] ?? req.body?.hours ?? 72)));
    const { mapBetfairEventsToFixtures, analysePaperOnlyCoverage } = await import("../services/betfairEventMapping");
    const before = await analysePaperOnlyCoverage();
    const stats = await mapBetfairEventsToFixtures(hours);
    const after = await analysePaperOnlyCoverage();
    res.json({ success: true, hours, mapping: stats, paperOnlyBefore: before, paperOnlyAfter: after });
  } catch (err) {
    logger.error({ err }, "Betfair event mapping failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/paper-only-coverage", async (_req, res) => {
  try {
    const { analysePaperOnlyCoverage } = await import("../services/betfairEventMapping");
    res.json({ success: true, coverage: await analysePaperOnlyCoverage() });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/market-availability-analysis", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(300, Number(req.query["limit"] ?? 100)));
    const { analyseMarketAvailability } = await import("../services/betfairEventMapping");
    const report = await analyseMarketAvailability(limit);
    res.json({ success: true, report });
  } catch (err) {
    logger.error({ err }, "Market availability analysis failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/run-near-cycle", async (_req, res) => {
  try {
    const { runTradingCycle } = await import("../services/scheduler");
    const { deduplicatePendingBets } = await import("../services/paperTrading");
    const result = await runTradingCycle({ tier: "near", minHoursAhead: 1, maxHoursAhead: 48 });
    const dedup = await deduplicatePendingBets().catch((e) => ({ error: String(e) }));
    res.json({ success: true, result, dedup });
  } catch (err) {
    logger.error({ err }, "run-near-cycle failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/rescue-pinnacle-mapping", async (req, res) => {
  try {
    const dryRun = String(req.query["dryRun"] ?? req.body?.dryRun ?? "false") === "true";
    const minCombined = Number(req.query["minCombined"] ?? req.body?.minCombined ?? 0.50);
    const minPerSide = Number(req.query["minPerSide"] ?? req.body?.minPerSide ?? 0.40);
    const windowDays = Number(req.query["windowDays"] ?? req.body?.windowDays ?? 2);
    const { rescueUnmappedPinnacleFixtures } = await import("../services/oddsPapi");
    const result = await rescueUnmappedPinnacleFixtures({ dryRun, minCombined, minPerSide, dateWindowDays: windowDays });
    res.json({ success: true, params: { dryRun, minCombined, minPerSide, windowDays }, result });
  } catch (err) {
    logger.error({ err }, "Pinnacle rescue mapping failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/live-balance", async (_req, res) => {
  try {
    const balance = getCachedBalance();
    res.json({
      success: true,
      isLive: isLiveMode(),
      tradingMode: process.env["TRADING_MODE"] ?? "PAPER",
      balance: balance
        ? {
            available: balance.available,
            exposure: balance.exposure,
            total: balance.total,
            fetchedAt: new Date(balance.fetchedAt).toISOString(),
            ageSeconds: Math.round((Date.now() - balance.fetchedAt) / 1000),
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/live-tier-stats", async (_req, res) => {
  try {
    const threshold = await getLiveOppScoreThreshold();
    const richnessSummary = await getDataRichnessSummary();

    const tierCounts = await db.execute(sql`
      SELECT
        live_tier,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE status IN ('won', 'lost')) as settled,
        ROUND(COALESCE(SUM(CASE WHEN status IN ('won','lost') THEN settlement_pnl::numeric ELSE 0 END), 0)::numeric, 2) as pnl,
        ROUND(COALESCE(SUM(CASE WHEN status IN ('won','lost') THEN stake::numeric ELSE 0 END), 0)::numeric, 2) as staked,
        ROUND(AVG(CASE WHEN status IN ('won','lost') AND clv_pct IS NOT NULL THEN clv_pct::numeric END)::numeric, 2) as avg_clv
      FROM paper_bets
      WHERE live_tier IS NOT NULL
      GROUP BY live_tier
    `);
    const tiers = ((tierCounts as any).rows ?? tierCounts).reduce((acc: any, r: any) => {
      acc[r.live_tier] = {
        total: Number(r.count),
        settled: Number(r.settled),
        pnl: Number(r.pnl),
        staked: Number(r.staked),
        roi: Number(r.staked) > 0 ? Math.round((Number(r.pnl) / Number(r.staked)) * 10000) / 100 : 0,
        avgClv: r.avg_clv != null ? Number(r.avg_clv) : null,
      };
      return acc;
    }, {});

    res.json({
      success: true,
      tradingMode: process.env["TRADING_MODE"] ?? "PAPER",
      currentThreshold: threshold,
      tiers,
      dataRichness: richnessSummary,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/go-live-readiness", async (_req, res) => {
  try {
    const thresholds = {
      minSampleSize: parseInt(process.env.PROMO_MIN_SAMPLE_SIZE ?? "30"),
      minRoi: parseFloat(process.env.PROMO_MIN_ROI ?? "3.0"),
      minClv: parseFloat(process.env.PROMO_MIN_CLV ?? "1.5"),
      minWinRate: parseFloat(process.env.PROMO_MIN_WIN_RATE ?? "52.0"),
      minWeeksActive: parseInt(process.env.PROMO_MIN_WEEKS_ACTIVE ?? "3"),
      minEdge: parseFloat(process.env.PROMO_MIN_EDGE ?? "2.0"),
    };

    const [bankroll, summaryResult, promotedResult, clvResult, betsPerDayResult] = await Promise.all([
      getBankroll(),
      pool.query(`SELECT COUNT(*)::int as total_settled, COUNT(*) FILTER (WHERE status='won')::int as wins, COUNT(*) FILTER (WHERE status='lost')::int as losses FROM paper_bets WHERE status IN ('won','lost')`),
      pool.query(`SELECT COUNT(*)::int as cnt FROM experiment_registry WHERE data_tier='promoted'`),
      pool.query(`SELECT AVG(clv_pct::numeric)::float as avg_clv FROM paper_bets WHERE clv_pct IS NOT NULL AND status IN ('won','lost')`),
      pool.query(`SELECT COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(placed_at)-MIN(placed_at))) / 86400) as bets_per_day FROM paper_bets WHERE placed_at > NOW() - INTERVAL '14 days'`),
    ]);

    const totalSettled = summaryResult.rows[0]?.total_settled ?? 0;
    const wins = summaryResult.rows[0]?.wins ?? 0;
    const losses = summaryResult.rows[0]?.losses ?? 0;
    const winRate = totalSettled > 0 ? (wins / totalSettled) * 100 : 0;
    const promotedCount = promotedResult.rows[0]?.cnt ?? 0;
    const avgClv = clvResult.rows[0]?.avg_clv ?? 0;
    const betsPerDay = betsPerDayResult.rows[0]?.bets_per_day ?? 0;
    const totalPnl = bankroll - 500;
    const roi = totalSettled > 0 ? (totalPnl / 500) * 100 : 0;

    const TARGET_SETTLED = 500;

    const checks = [
      { id: "sample_size", label: `${TARGET_SETTLED}+ settled bets`, met: totalSettled >= TARGET_SETTLED, current: totalSettled, target: TARGET_SETTLED, weight: 0.30 },
      { id: "promoted_strategy", label: "1+ promoted strategy", met: promotedCount >= 1, current: promotedCount, target: 1, weight: 0.25 },
      { id: "positive_clv", label: `CLV > ${thresholds.minClv}%`, met: avgClv >= thresholds.minClv, current: Number(avgClv.toFixed(2)), target: thresholds.minClv, weight: 0.15 },
      { id: "positive_roi", label: `ROI > ${thresholds.minRoi}%`, met: roi >= thresholds.minRoi, current: Number(roi.toFixed(2)), target: thresholds.minRoi, weight: 0.10 },
      { id: "win_rate", label: `Win rate > ${thresholds.minWinRate}%`, met: winRate >= thresholds.minWinRate, current: Number(winRate.toFixed(1)), target: thresholds.minWinRate, weight: 0.10 },
      { id: "bankroll_growth", label: "Bankroll above starting", met: bankroll > 500, current: Number(bankroll), target: 500, weight: 0.10 },
    ];

    const overallScore = Math.min(100, Math.max(0, Math.round(checks.reduce((acc, c) => acc + (c.met ? c.weight * 100 : Math.max(0, Math.min(c.weight * 100, (c.current / c.target) * c.weight * 100))), 0))));
    const betsRemaining = Math.max(0, TARGET_SETTLED - totalSettled);
    const estDaysToTarget = betsPerDay > 0 ? Math.ceil(betsRemaining / betsPerDay) : null;

    res.json({
      success: true,
      overallScore,
      checks,
      totalSettled,
      betsPerDay: Number(betsPerDay.toFixed(1)),
      estDaysToTarget,
      promotedCount,
      ready: checks.every(c => c.met),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/learning-journal/latest", async (_req, res) => {
  try {
    const entry = await getLatestLearningJournal();
    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/promote", async (req, res) => {
  try {
    const { experiment_tag, target_tier, reason } = req.body ?? {};
    if (!experiment_tag || !target_tier || !reason) {
      res.status(400).json({ success: false, message: "experiment_tag, target_tier, and reason are required" });
      return;
    }
    const result = await manualPromote(experiment_tag, target_tier, reason);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/run-promotion-engine", async (_req, res) => {
  try {
    const result = await runPromotionEngine();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/sync-to-prod", async (_req, res) => {
  try {
    const result = await syncDevToProd();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/sync-status", async (_req, res) => {
  try {
    const status = await getSyncStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/backfill-experiment-tags", async (_req, res) => {
  try {
    const result = await backfillExperimentTags();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.patch("/admin/bets/:id/sync-eligible", async (req, res) => {
  try {
    const betId = parseInt(req.params.id);
    const { sync_eligible } = req.body ?? {};
    if (typeof sync_eligible !== "boolean") {
      res.status(400).json({ success: false, message: "sync_eligible (boolean) required" });
      return;
    }
    await db.execute(sql`UPDATE paper_bets SET sync_eligible = ${sync_eligible} WHERE id = ${betId}`);
    res.json({ success: true, betId, sync_eligible });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/experiment-analysis", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT * FROM experiment_learning_journal ORDER BY analysis_date DESC LIMIT 20
    `);
    res.json({ success: true, entries: (rows as any).rows ?? [] });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/coverage", async (_req, res) => {
  try {
    const coverage = await getCompetitionCoverageStats();

    const budgetResult = await db.execute(sql`
      SELECT
        COALESCE((SELECT SUM(request_count)::int FROM api_usage WHERE created_at >= CURRENT_DATE), 0) AS today_calls,
        COALESCE((SELECT SUM(request_count)::int FROM api_usage WHERE created_at >= NOW() - INTERVAL '30 days'), 0) AS month_calls
    `);
    const budgetRow = (budgetResult as any).rows?.[0] ?? {};
    const todayCalls = budgetRow.today_calls ?? 0;
    const monthCalls = budgetRow.month_calls ?? 0;

    const MONTHLY_LIMIT = 75000;
    const DAILY_TARGET = 2500;

    res.json({
      success: true,
      ...coverage,
      apiBudget: {
        dailyUsed: todayCalls,
        dailyTarget: DAILY_TARGET,
        monthlyUsed: monthCalls,
        monthlyLimit: MONTHLY_LIMIT,
        dailyUtilisation: Math.round((todayCalls / DAILY_TARGET) * 100),
        monthlyUtilisation: Math.round((monthCalls / MONTHLY_LIMIT) * 100),
      },
    });
  } catch (err) {
    logger.warn({ err }, "Coverage stats failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─── Pinnacle Data Upgrade endpoints ──────────────────────────────────────────

router.get("/dashboard/pinnacle-coverage", async (_req, res) => {
  try {
    // Dashboard is real-money only.
    const totalSettled = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(paperBetsTable)
      .where(and(sql`${paperBetsTable.status} IN ('won', 'lost')`, REAL_MONEY));

    const withClv = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(paperBetsTable)
      .where(and(sql`${paperBetsTable.status} IN ('won', 'lost')`, sql`${paperBetsTable.clvPct} IS NOT NULL`, REAL_MONEY));

    const withPinnacleClosing = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(paperBetsTable)
      .where(and(sql`${paperBetsTable.status} IN ('won', 'lost')`, sql`${paperBetsTable.closingPinnacleOdds} IS NOT NULL`, REAL_MONEY));

    const byQuality = await db.execute(sql`
      SELECT clv_data_quality, count(*)::int as count
      FROM paper_bets
      WHERE status IN ('won', 'lost')
        AND betfair_bet_id IS NOT NULL
      GROUP BY clv_data_quality
    `);

    const snapshotCounts = await db
      .select({
        snapshotType: pinnacleOddsSnapshotsTable.snapshotType,
        count: sql<number>`count(*)::int`,
      })
      .from(pinnacleOddsSnapshotsTable)
      .groupBy(pinnacleOddsSnapshotsTable.snapshotType);

    const total = totalSettled[0]?.count ?? 0;
    const clvCount = withClv[0]?.count ?? 0;
    const pinnClosingCount = withPinnacleClosing[0]?.count ?? 0;

    res.json({
      settledBets: total,
      withClv: clvCount,
      withPinnacleClosing: pinnClosingCount,
      clvCoveragePct: total > 0 ? Math.round((clvCount / total) * 100) : 0,
      pinnacleCoveragePct: total > 0 ? Math.round((pinnClosingCount / total) * 100) : 0,
      byDataQuality: byQuality,
      snapshots: Object.fromEntries(snapshotCounts.map((s) => [s.snapshotType, s.count])),
    });
  } catch (err) {
    logger.warn({ err }, "Pinnacle coverage endpoint failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/dashboard/filtered-bets", async (_req, res) => {
  try {
    const recent = await db
      .select()
      .from(filteredBetsTable)
      .orderBy(desc(filteredBetsTable.createdAt))
      .limit(50);

    const summary = await db.execute(sql`
      SELECT
        filter_reason,
        count(*)::int as total,
        count(*) FILTER (WHERE actual_outcome = 'won')::int as would_have_won,
        count(*) FILTER (WHERE actual_outcome = 'lost')::int as would_have_lost,
        count(*) FILTER (WHERE actual_outcome IS NULL)::int as pending
      FROM filtered_bets
      GROUP BY filter_reason
      ORDER BY total DESC
    `);

    res.json({ recent, summary });
  } catch (err) {
    logger.warn({ err }, "Filtered bets endpoint failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/dashboard/line-movements", async (_req, res) => {
  try {
    const recentSharp = await db
      .select()
      .from(lineMovementsTable)
      .where(eq(lineMovementsTable.isSharpMovement, true))
      .orderBy(desc(lineMovementsTable.capturedAt))
      .limit(30);

    const totalMovements = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(lineMovementsTable);

    const sharpCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(lineMovementsTable)
      .where(eq(lineMovementsTable.isSharpMovement, true));

    res.json({
      totalMovements: totalMovements[0]?.count ?? 0,
      sharpMovements: sharpCount[0]?.count ?? 0,
      recentSharp,
    });
  } catch (err) {
    logger.warn({ err }, "Line movements endpoint failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/dashboard/league-scores", async (_req, res) => {
  try {
    const scores = await calculateLeaguePerformanceScores();
    res.json({ scores, count: scores.length });
  } catch (err) {
    logger.warn({ err }, "League scores endpoint failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/admin/deactivate-low-value-leagues", async (_req, res) => {
  try {
    const result = await deactivateLowValueLeagues();
    res.json(result);
  } catch (err) {
    logger.warn({ err }, "League deactivation failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/admin/capture-lineups", async (_req, res) => {
  try {
    const result = await capturePreKickoffLineups();
    res.json(result);
  } catch (err) {
    logger.warn({ err }, "Lineup capture failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/edge-segments — edge concentration segmentation
// ─────────────────────────────────────────────
router.get("/dashboard/edge-segments", async (_req, res) => {
  try {
    const { calculateEdgeSegments, calculateOddsRangeSegments } = await import("../services/edgeConcentration");
    const [segments, oddsRanges] = await Promise.all([
      calculateEdgeSegments(),
      calculateOddsRangeSegments(),
    ]);

    const exploit = segments.filter(s => s.segmentClass === "exploit");
    const explore = segments.filter(s => s.segmentClass === "explore");
    const avoid = segments.filter(s => s.segmentClass === "avoid");

    res.json({
      segments,
      oddsRanges,
      summary: {
        totalSegments: segments.length,
        exploit: exploit.length,
        explore: explore.length,
        avoid: avoid.length,
        exploitPnl: Math.round(exploit.reduce((s, e) => s + e.totalPnl, 0) * 100) / 100,
        avoidPnl: Math.round(avoid.reduce((s, e) => s + e.totalPnl, 0) * 100) / 100,
      },
    });
  } catch (err) {
    logger.warn({ err }, "Edge segment calculation failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/admin/void-corners — void all pending corners bets
// ─────────────────────────────────────────────
router.post("/admin/void-corners", async (_req, res) => {
  try {
    const { voidPendingCornersBets } = await import("../services/edgeConcentration");
    const result = await voidPendingCornersBets();
    res.json(result);
  } catch (err) {
    logger.warn({ err }, "Corners voiding failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/admin/live-risk-status — full live risk management status
// ─────────────────────────────────────────────
router.get("/admin/live-risk-status", async (_req, res) => {
  try {
    const { getLiveRiskStatus } = await import("../services/liveRiskManager");
    const status = await getLiveRiskStatus();
    res.json(status);
  } catch (err) {
    logger.warn({ err }, "Live risk status failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/admin/live-risk-level — manually set or evaluate risk level
// ─────────────────────────────────────────────
router.post("/admin/live-risk-level", async (req, res) => {
  try {
    const { action, level } = req.body as { action?: string; level?: number };
    const {
      applyLevelTransition,
      evaluateLevelProgression,
      getCurrentLiveRiskLevel,
    } = await import("../services/liveRiskManager");
    const { setConfigValue } = await import("../services/paperTrading");

    if (action === "evaluate") {
      const result = await evaluateLevelProgression();
      res.json(result);
    } else if (action === "apply") {
      const result = await applyLevelTransition();
      res.json(result);
    } else if (action === "set" && typeof level === "number" && level >= 1 && level <= 4) {
      await setConfigValue("live_risk_level", String(level));
      res.json({ success: true, level, message: `Risk level manually set to ${level}` });
    } else {
      const current = await getCurrentLiveRiskLevel();
      res.json({ currentLevel: current, usage: "POST with action: 'evaluate' | 'apply' | 'set' (with level 1-4)" });
    }
  } catch (err) {
    logger.warn({ err }, "Live risk level action failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/admin/starting-deposit — set/update cumulative total deposited
// ─────────────────────────────────────────────
router.post("/admin/starting-deposit", async (req, res) => {
  try {
    const { amount } = req.body as { amount?: number };
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }
    const { setConfigValue } = await import("../services/paperTrading");
    const { getStartingDeposit, getBankrollFloorFromDeposit } = await import("../services/liveRiskManager");

    const currentDeposit = await getStartingDeposit();
    const newTotal = currentDeposit + amount;
    await setConfigValue("starting_deposit", String(newTotal));

    const newFloor = await getBankrollFloorFromDeposit();
    res.json({
      previousDeposit: currentDeposit,
      added: amount,
      newTotalDeposit: newTotal,
      newBankrollFloor: newFloor,
      floorPct: "60%",
    });
  } catch (err) {
    logger.warn({ err }, "Starting deposit update failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/liquidity — liquidity snapshot summary
// ─────────────────────────────────────────────
router.get("/dashboard/liquidity", async (req, res) => {
  try {
    const days = Number(req.query.days ?? 7);
    const result = await db.execute(sql`
      SELECT
        ls.market_type,
        m.league,
        COUNT(*)::int AS snapshots,
        ROUND(AVG(ls.available_at_price::numeric), 2) AS avg_available,
        ROUND(AVG(ls.liquidity_shortfall::numeric), 2) AS avg_shortfall,
        ROUND(AVG(ls.total_market_volume::numeric), 0) AS avg_volume,
        COUNT(*) FILTER (WHERE ls.liquidity_shortfall::numeric > 0)::int AS shortfall_count
      FROM liquidity_snapshots ls
      JOIN matches m ON m.id = ls.match_id
      WHERE ls.captured_at > NOW() - INTERVAL '1 day' * ${days}
      GROUP BY ls.market_type, m.league
      ORDER BY avg_shortfall DESC NULLS LAST
      LIMIT 50
    `);
    res.json({
      days,
      summary: result.rows,
      totalSnapshots: result.rows.reduce((s: number, r: any) => s + (r.snapshots ?? 0), 0),
    });
  } catch (err) {
    logger.warn({ err }, "Liquidity dashboard failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/vps-relay — VPS relay status
// ─────────────────────────────────────────────
router.get("/dashboard/vps-relay", async (_req, res) => {
  try {
    const { getRelayStatus, checkRelayHealth, isRelayConfigured } = await import("../services/vpsRelay");
    const status = getRelayStatus();
    if (!status.configured) {
      return res.json({ ...status, message: "VPS relay not configured — set VPS_RELAY_URL" });
    }
    const health = await checkRelayHealth();
    res.json({ ...status, ...health });
  } catch (err) {
    logger.warn({ err }, "VPS relay status check failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/model-health — latest model health report
// ─────────────────────────────────────────────
router.get("/dashboard/model-health", async (_req, res) => {
  try {
    const { generateModelHealthReport } = await import("../services/modelHealthReport");
    const report = await generateModelHealthReport();
    res.json(report);
  } catch (err) {
    logger.warn({ err }, "Model health report failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/market-regime — current market regime
// ─────────────────────────────────────────────
router.get("/dashboard/market-regime", async (_req, res) => {
  try {
    const { detectCurrentRegime } = await import("../services/marketRegime");
    const regime = await detectCurrentRegime();
    res.json(regime);
  } catch (err) {
    logger.warn({ err }, "Market regime detection failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/edge-decay — edge decay analysis
// ─────────────────────────────────────────────
router.get("/dashboard/edge-decay", async (_req, res) => {
  try {
    const { analyzeEdgeDecay } = await import("../services/edgeDecay");
    const decay = await analyzeEdgeDecay();
    res.json(decay);
  } catch (err) {
    logger.warn({ err }, "Edge decay analysis failed");
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────
// GET /api/dashboard/agent-recommendations — self-advocacy & recommendations
// ─────────────────────────────────────────────
router.get("/dashboard/agent-recommendations", async (_req, res) => {
  try {
    const { generateAgentRecommendations } = await import("../services/agentRecommendations");
    const report = await generateAgentRecommendations();
    res.json(report);
  } catch (err) {
    logger.warn({ err }, "Agent recommendations failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/dashboard/execution-metrics", async (_req, res) => {
  try {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86400000);
    const weekAgo = new Date(now.getTime() - 7 * 86400000);

    const [fillStats, timingStats, recentBets] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE betfair_bet_id IS NOT NULL)::int AS live_placed,
          COUNT(*) FILTER (WHERE betfair_status = 'EXECUTION_COMPLETE')::int AS fully_filled,
          COUNT(*) FILTER (WHERE betfair_status = 'EXECUTABLE' AND betfair_size_matched::numeric > 0)::int AS partial_filled,
          COUNT(*) FILTER (WHERE betfair_status = 'CANCELLED')::int AS cancelled,
          ROUND(AVG(CASE WHEN betfair_size_matched IS NOT NULL AND stake::numeric > 0
            THEN (betfair_size_matched::numeric / stake::numeric) * 100 END)::numeric, 1) AS avg_fill_pct,
          COUNT(*) FILTER (WHERE placed_at >= ${dayAgo} AND betfair_bet_id IS NOT NULL)::int AS placed_24h
        FROM paper_bets
        WHERE betfair_bet_id IS NOT NULL
      `),
      db.execute(sql`
        SELECT
          ROUND(AVG(EXTRACT(EPOCH FROM (betfair_placed_at - placed_at)))::numeric, 1) AS avg_signal_to_place_secs,
          ROUND(AVG(CASE WHEN betfair_settled_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (betfair_settled_at - betfair_placed_at)) END)::numeric, 0) AS avg_time_to_settle_secs
        FROM paper_bets
        WHERE betfair_placed_at IS NOT NULL
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS week_bets,
          COUNT(*) FILTER (WHERE status IN ('won','lost'))::int AS week_settled
        FROM paper_bets
        WHERE placed_at >= ${weekAgo}
          AND betfair_bet_id IS NOT NULL
      `),
    ]);

    const fill = (fillStats as any).rows?.[0] ?? {};
    const timing = (timingStats as any).rows?.[0] ?? {};
    const recent = (recentBets as any).rows?.[0] ?? {};

    const { getRelayStatus, checkRelayHealth } = await import("../services/vpsRelay");
    const relayStatus = getRelayStatus();
    let relayHealth = null;
    if (relayStatus.configured) {
      try { relayHealth = await checkRelayHealth(); } catch {}
    }

    res.json({
      fillRate: {
        livePlaced: Number(fill.live_placed ?? 0),
        fullyFilled: Number(fill.fully_filled ?? 0),
        partialFilled: Number(fill.partial_filled ?? 0),
        cancelled: Number(fill.cancelled ?? 0),
        avgFillPct: fill.avg_fill_pct != null ? Number(fill.avg_fill_pct) : null,
        placed24h: Number(fill.placed_24h ?? 0),
      },
      timing: {
        avgSignalToPlaceSecs: timing.avg_signal_to_place_secs != null ? Number(timing.avg_signal_to_place_secs) : null,
        avgTimeToSettleSecs: timing.avg_time_to_settle_secs != null ? Number(timing.avg_time_to_settle_secs) : null,
      },
      weekActivity: {
        bets: Number(recent.week_bets ?? 0),
        settled: Number(recent.week_settled ?? 0),
      },
      relay: {
        configured: relayStatus.configured,
        healthy: relayStatus.healthy,
        lastLatencyMs: relayStatus.lastLatencyMs ?? null,
        betfairConnected: relayHealth?.betfairConnected ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err }, "Execution metrics failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/dashboard/in-play", async (_req, res) => {
  try {
    const now = new Date();
    // Dashboard is real-money only.
    const whereParts = [
      eq(paperBetsTable.status, "pending"),
      lte(matchesTable.kickoffTime, now),
      REAL_MONEY,
    ];
    const bets = await db
      .select({
        id: paperBetsTable.id,
        matchId: paperBetsTable.matchId,
        homeTeam: matchesTable.homeTeam,
        awayTeam: matchesTable.awayTeam,
        league: matchesTable.league,
        kickoffTime: matchesTable.kickoffTime,
        homeScore: matchesTable.homeScore,
        awayScore: matchesTable.awayScore,
        matchStatus: matchesTable.status,
        marketType: paperBetsTable.marketType,
        selectionName: paperBetsTable.selectionName,
        oddsAtPlacement: paperBetsTable.oddsAtPlacement,
        stake: paperBetsTable.stake,
        potentialProfit: paperBetsTable.potentialProfit,
        calculatedEdge: paperBetsTable.calculatedEdge,
        opportunityScore: paperBetsTable.opportunityScore,
        placedAt: paperBetsTable.placedAt,
        liveTier: paperBetsTable.liveTier,
        betfairBetId: paperBetsTable.betfairBetId,
        betfairStatus: paperBetsTable.betfairStatus,
        betfairSizeMatched: paperBetsTable.betfairSizeMatched,
      })
      .from(paperBetsTable)
      .leftJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
      .where(and(...whereParts))
      .orderBy(desc(matchesTable.kickoffTime));

    res.json({
      count: bets.length,
      bets: bets.map((b) => ({
        ...b,
        oddsAtPlacement: Number(b.oddsAtPlacement),
        stake: Number(b.stake),
        potentialProfit: b.potentialProfit ? Number(b.potentialProfit) : null,
        calculatedEdge: b.calculatedEdge ? Number(b.calculatedEdge) : null,
        opportunityScore: b.opportunityScore ? Number(b.opportunityScore) : null,
        betfairSizeMatched: b.betfairSizeMatched ? Number(b.betfairSizeMatched) : null,
        minutesInPlay: b.kickoffTime ? Math.max(0, Math.round((now.getTime() - new Date(b.kickoffTime).getTime()) / 60000)) : null,
      })),
    });
  } catch (err) {
    logger.warn({ err }, "In-play bets failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/dashboard/upcoming-bets", async (_req, res) => {
  try {
    const now = new Date();
    // Dashboard is real-money only.
    const whereParts = [
      eq(paperBetsTable.status, "pending"),
      gte(matchesTable.kickoffTime, now),
      REAL_MONEY,
    ];
    const bets = await db
      .select({
        id: paperBetsTable.id,
        matchId: paperBetsTable.matchId,
        homeTeam: matchesTable.homeTeam,
        awayTeam: matchesTable.awayTeam,
        league: matchesTable.league,
        kickoffTime: matchesTable.kickoffTime,
        marketType: paperBetsTable.marketType,
        selectionName: paperBetsTable.selectionName,
        oddsAtPlacement: paperBetsTable.oddsAtPlacement,
        stake: paperBetsTable.stake,
        potentialProfit: paperBetsTable.potentialProfit,
        calculatedEdge: paperBetsTable.calculatedEdge,
        opportunityScore: paperBetsTable.opportunityScore,
        placedAt: paperBetsTable.placedAt,
        liveTier: paperBetsTable.liveTier,
        betfairBetId: paperBetsTable.betfairBetId,
        betfairStatus: paperBetsTable.betfairStatus,
      })
      .from(paperBetsTable)
      .leftJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
      .where(and(...whereParts))
      .orderBy(asc(matchesTable.kickoffTime));

    res.json({
      count: bets.length,
      bets: bets.map((b) => {
        const ko = b.kickoffTime ? new Date(b.kickoffTime) : null;
        const minsUntil = ko ? Math.max(0, Math.round((ko.getTime() - now.getTime()) / 60000)) : null;
        return {
          ...b,
          oddsAtPlacement: Number(b.oddsAtPlacement),
          stake: Number(b.stake),
          potentialProfit: b.potentialProfit ? Number(b.potentialProfit) : null,
          calculatedEdge: b.calculatedEdge ? Number(b.calculatedEdge) : null,
          opportunityScore: b.opportunityScore ? Number(b.opportunityScore) : null,
          minutesUntilKickoff: minsUntil,
          countdownLabel: minsUntil != null
            ? minsUntil < 60 ? `${minsUntil}min`
            : minsUntil < 1440 ? `${Math.floor(minsUntil / 60)}h ${minsUntil % 60}m`
            : `${Math.floor(minsUntil / 1440)}d ${Math.floor((minsUntil % 1440) / 60)}h`
            : null,
        };
      }),
    });
  } catch (err) {
    logger.warn({ err }, "Upcoming bets failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/dashboard/live-summary", async (_req, res) => {
  try {
    const tradingMode = process.env["TRADING_MODE"] ?? "PAPER";

    let balance = getCachedBalance();
    if (!balance || (Date.now() - balance.fetchedAt > 120000)) {
      try {
        await getAccountFunds();
        balance = getCachedBalance();
      } catch (err) {
        logger.warn({ err }, "Live summary: failed to refresh Betfair balance");
      }
    }

    let riskStatus = null;
    try {
      const { getLiveRiskStatus } = await import("../services/liveRiskManager");
      riskStatus = await getLiveRiskStatus();
    } catch {}

    let threshold = null;
    try {
      threshold = await getLiveOppScoreThreshold();
    } catch {}

    const { getRelayStatus } = await import("../services/vpsRelay");
    const relay = getRelayStatus();

    res.json({
      tradingMode,
      isLive: tradingMode === "LIVE",
      betfairBalance: balance ? {
        available: balance.available,
        exposure: balance.exposure,
        total: balance.total,
        fetchedAt: new Date(balance.fetchedAt).toISOString(),
        stale: (Date.now() - balance.fetchedAt) > 300000,
      } : null,
      riskLevel: riskStatus?.level ?? null,
      riskLimits: riskStatus?.limits ?? null,
      qualityGate: threshold,
      relayHealthy: relay.healthy,
      relayConfigured: relay.configured,
    });
  } catch (err) {
    logger.warn({ err }, "Live summary failed");
    res.status(500).json({ error: String(err) });
  }
});

// ===================== Alerts =====================

import {
  getAlerts,
  getUnreadCount,
  acknowledgeAlert,
  acknowledgeAllAlerts,
} from "../services/alerting";
import {
  runAlertDetection,
  runAnomalyDetection,
  fireTestAlert,
} from "../services/alertDetection";

router.get("/alerts", async (req, res) => {
  try {
    const page = parseInt(String(req.query["page"] ?? "1"), 10);
    const limit = parseInt(String(req.query["limit"] ?? "50"), 10);
    const severity = req.query["severity"] as string | undefined;
    const ackParam = req.query["acknowledged"] as string | undefined;
    const acknowledged = ackParam === "true" ? true : ackParam === "false" ? false : undefined;

    const result = await getAlerts({ page, limit, severity, acknowledged });
    res.json(result);
  } catch (err) {
    logger.warn({ err }, "Fetch alerts failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/alerts/unread-count", async (_req, res) => {
  try {
    const counts = await getUnreadCount();
    res.json(counts);
  } catch (err) {
    logger.warn({ err }, "Unread count failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/alerts/:id/acknowledge", async (req, res) => {
  try {
    const id = parseInt(req.params["id"]!, 10);
    const ok = await acknowledgeAlert(id);
    res.json({ acknowledged: ok });
  } catch (err) {
    logger.warn({ err }, "Acknowledge alert failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/alerts/acknowledge-all", async (_req, res) => {
  try {
    const count = await acknowledgeAllAlerts();
    res.json({ acknowledged: count });
  } catch (err) {
    logger.warn({ err }, "Acknowledge all alerts failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/alerts/test", async (req, res) => {
  try {
    const severity = (req.body as any)?.severity ?? "info";
    if (!["critical", "warning", "info"].includes(severity)) {
      res.status(400).json({ error: "Invalid severity" });
      return;
    }
    const id = await fireTestAlert(severity);
    res.json({ alertId: id, severity });
  } catch (err) {
    logger.warn({ err }, "Fire test alert failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/alerts/run-detection", async (_req, res) => {
  try {
    await runAlertDetection();
    await runAnomalyDetection();
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err }, "Manual alert detection failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;

