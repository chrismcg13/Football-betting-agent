import { Router } from "express";
import {
  db,
  pool,
  paperBetsTable,
  paperBetsCurrentView,
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
import { manualTriggerBetfairReverseMapping } from "../services/betfairFirstUniverse";
import { getAllTeamXGStats } from "../services/xgIngestionService";
import { getCircuitBreakerStatus, resumeAgent } from "../services/riskManager";
import { getCachedBalance, isLiveMode, getAccountFunds, cancelOrders, type ClearedOrder } from "../services/betfairLive";
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
const REAL_MONEY_CURRENT = isNotNull(paperBetsCurrentView.betfairBetId);

async function getSettledBetsStats() {
  // Class A helper used by /dashboard/summary — reads paper_bets_current
  // (legacy_regime=false) so the dashboard summary excludes pre-cutover bets.
  const rows = await db
    .select({
      status: paperBetsCurrentView.status,
      stake: paperBetsCurrentView.stake,
      settlementPnl: paperBetsCurrentView.settlementPnl,
      settledAt: paperBetsCurrentView.settledAt,
      opportunityScore: paperBetsCurrentView.opportunityScore,
      grossPnl: paperBetsCurrentView.grossPnl,
      commissionAmount: paperBetsCurrentView.commissionAmount,
      netPnl: paperBetsCurrentView.netPnl,
    })
    .from(paperBetsCurrentView)
    .where(
      and(
        inArray(paperBetsCurrentView.status, ["won", "lost", "void"]),
        REAL_MONEY_CURRENT,
      ),
    );
  return rows;
}

// ─────────────────────────────────────────────
// GET /api/about/data-sources
// ─────────────────────────────────────────────
// Bundle 9 follow-up (2026-05-09): operator-visible attribution for the
// external data sources we ingest. Satisfies free-tier ToS attribution
// requirements (notably OpenWeatherMap's "Visible attribution to OpenWeather
// in your application or service") for a headless personal tool with no
// public UI. Curl this endpoint to verify all attributions present:
//   curl localhost:8080/api/about/data-sources
router.get("/about/data-sources", (_req, res) => {
  res.json({
    sources: [
      {
        name: "OpenWeather",
        attribution: "Weather data © OpenWeather",
        url: "https://openweathermap.org/",
        usage: "Match weather forecasts (temperature, wind, precipitation, humidity) at fixture kickoff",
        license: "Free tier — commercial and non-commercial use permitted with visible attribution",
      },
      {
        name: "API-Football",
        attribution: "Football data via API-Football",
        url: "https://www.api-football.com/",
        usage: "Fixtures, odds, lineups, injuries, referee assignments, head-to-head, fixture statistics",
        license: "Paid commercial subscription",
      },
      {
        name: "OddsPapi",
        attribution: "Odds data via OddsPapi",
        url: "https://oddspapi.io/",
        usage: "Pinnacle pre-bet validation, closing-line CLV anchors, Tier-2 sharp book aggregation",
        license: "Paid commercial subscription",
      },
      {
        name: "Betfair Exchange",
        attribution: "Exchange data via Betfair API",
        url: "https://developer.betfair.com/",
        usage: "Real-time exchange odds, market catalogue, order placement, settlement reconciliation",
        license: "Authenticated app key (commercial use)",
      },
      {
        name: "Football-data.org",
        attribution: "Fallback fixture data via Football-data.org",
        url: "https://www.football-data.org/",
        usage: "Fallback fixture metadata when API-Football unavailable",
        license: "Free tier — non-commercial",
      },
      {
        name: "Understat",
        attribution: "xG data via Understat",
        url: "https://understat.com/",
        usage: "Team-level xG (expected goals) for top-5 European leagues + supplementary",
        license: "Public-data scrape — fair-use rate-limited",
      },
      {
        name: "OpenStreetMap / Nominatim",
        attribution: "Stadium geocoding © OpenStreetMap contributors",
        url: "https://nominatim.openstreetmap.org/",
        usage: "Stadium lat/lon resolution from venue name + city + country",
        license: "ODbL — attribution required",
      },
      {
        name: "Wikipedia",
        attribution: "Stadium roof classification via Wikipedia",
        url: "https://en.wikipedia.org/",
        usage: "Auto-classification of stadiums as outdoor / retractable / closed-roof for weather feature emission gating",
        license: "CC BY-SA — attribution required",
      },
    ],
    fetched_at: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/summary
// ─────────────────────────────────────────────
router.get("/dashboard/summary", async (_req, res) => {
  const todayStartUtc = new Date();
  todayStartUtc.setUTCHours(0, 0, 0, 0);

  // Dashboard is real-money only — see REAL_MONEY_CURRENT constant at top of file.
  const pendingWhere = and(eq(paperBetsCurrentView.status, "pending"), REAL_MONEY_CURRENT);
  const betsTodayWhere = and(gte(paperBetsCurrentView.placedAt, todayStartUtc), REAL_MONEY_CURRENT);

  const [bankroll, agentStatus, allSettled, allPending, betsTodayRows, tierSplitRows, paperModeRow, maxExposurePctRow, exposureRuleSinceRow] = await Promise.all([
    getBankroll(),
    getAgentStatus(),
    getSettledBetsStats(),
    db
      .select({
        id: paperBetsCurrentView.id,
        stake: paperBetsCurrentView.stake,
        opportunityScore: paperBetsCurrentView.opportunityScore,
        placedAt: paperBetsCurrentView.placedAt,
      })
      .from(paperBetsCurrentView)
      .where(pendingWhere),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(paperBetsCurrentView)
      .where(betsTodayWhere),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE live_tier = 'tier1' AND qualification_path = '1A') AS tier1a,
        COUNT(*) FILTER (WHERE live_tier = 'tier1' AND qualification_path = '1B') AS tier1b,
        COUNT(*) FILTER (WHERE live_tier = 'tier1' AND (qualification_path = 'promoted' OR qualification_path IS NULL)) AS tier1_other,
        COUNT(*) FILTER (WHERE live_tier = 'tier1') AS betfair_live,
        COUNT(*) FILTER (WHERE (live_tier = 'tier2' OR live_tier IS NULL)) AS tier2,
        COALESCE(SUM(stake::numeric) FILTER (WHERE live_tier = 'tier1' AND status NOT IN ('void','cancelled')), 0) AS betfair_stake
      FROM paper_bets_current
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

  // Dashboard is real-money only — see REAL_MONEY_CURRENT constant at top of file.
  const settledWhere = and(
    inArray(paperBetsCurrentView.status, ["won", "lost"]),
    gte(paperBetsCurrentView.settledAt, since),
    REAL_MONEY_CURRENT,
  );

  const settled = await db
    .select({
      settledAt: paperBetsCurrentView.settledAt,
      settlementPnl: paperBetsCurrentView.settlementPnl,
      status: paperBetsCurrentView.status,
      stake: paperBetsCurrentView.stake,
    })
    .from(paperBetsCurrentView)
    .where(settledWhere)
    .orderBy(asc(paperBetsCurrentView.settledAt));

  // Overview "Recent Results" shows wins/losses only — voids are tracked on the
  // Bets History page so they don't clutter the at-a-glance settled view.
  const recentSettledWhere = and(
    inArray(paperBetsCurrentView.status, ["won", "lost"]),
    REAL_MONEY_CURRENT,
  );
  const recentBets = await db
    .select({
      id: paperBetsCurrentView.id,
      matchId: paperBetsCurrentView.matchId,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      league: matchesTable.league,
      marketType: paperBetsCurrentView.marketType,
      selectionName: paperBetsCurrentView.selectionName,
      oddsAtPlacement: paperBetsCurrentView.oddsAtPlacement,
      stake: paperBetsCurrentView.stake,
      status: paperBetsCurrentView.status,
      settlementPnl: paperBetsCurrentView.settlementPnl,
      settledAt: paperBetsCurrentView.settledAt,
      placedAt: paperBetsCurrentView.placedAt,
    })
    .from(paperBetsCurrentView)
    .leftJoin(matchesTable, eq(paperBetsCurrentView.matchId, matchesTable.id))
    .where(recentSettledWhere)
    .orderBy(desc(paperBetsCurrentView.settledAt))
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
      status: paperBetsCurrentView.status,
      stake: paperBetsCurrentView.stake,
      settlementPnl: paperBetsCurrentView.settlementPnl,
    })
    .from(paperBetsCurrentView)
    .leftJoin(matchesTable, eq(paperBetsCurrentView.matchId, matchesTable.id))
    .where(and(inArray(paperBetsCurrentView.status, ["won", "lost"]), REAL_MONEY_CURRENT));

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
      marketType: paperBetsCurrentView.marketType,
      status: paperBetsCurrentView.status,
      stake: paperBetsCurrentView.stake,
      settlementPnl: paperBetsCurrentView.settlementPnl,
    })
    .from(paperBetsCurrentView)
    .where(and(inArray(paperBetsCurrentView.status, ["won", "lost"]), REAL_MONEY_CURRENT));

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
  // Class C toggle (Change C7): default reads paper_bets_current (legacy
  // bets hidden from dashboard); ?includeLegacy=true reads the raw table
  // (full history, for audit / drill-down).
  const includeLegacy = String(req.query["includeLegacy"] ?? "false") === "true";
  const t = (includeLegacy ? paperBetsTable : paperBetsCurrentView) as typeof paperBetsTable;
  const realMoney = isNotNull(t.betfairBetId);

  // Dashboard is real-money only — bets list never includes never-placed shadow
  // rows, regardless of status filter.
  const baseConditions =
    statusFilter === "all" || !statusFilter
      ? realMoney
      : and(eq(t.status, statusFilter), realMoney);

  const [bets, countResult] = await Promise.all([
    db
      .select({
        id: t.id,
        matchId: t.matchId,
        homeTeam: matchesTable.homeTeam,
        awayTeam: matchesTable.awayTeam,
        league: matchesTable.league,
        kickoffTime: matchesTable.kickoffTime,
        homeScore: matchesTable.homeScore,
        awayScore: matchesTable.awayScore,
        marketType: t.marketType,
        selectionName: t.selectionName,
        betType: t.betType,
        oddsAtPlacement: t.oddsAtPlacement,
        stake: t.stake,
        potentialProfit: t.potentialProfit,
        modelProbability: t.modelProbability,
        betfairImpliedProbability: t.betfairImpliedProbability,
        calculatedEdge: t.calculatedEdge,
        opportunityScore: t.opportunityScore,
        modelVersion: t.modelVersion,
        status: t.status,
        settlementPnl: t.settlementPnl,
        placedAt: t.placedAt,
        settledAt: t.settledAt,
        oddsSource: t.oddsSource,
        liveTier: t.liveTier,
        betfairBetId: t.betfairBetId,
        betfairStatus: t.betfairStatus,
        betfairSizeMatched: t.betfairSizeMatched,
        betfairAvgPriceMatched: t.betfairAvgPriceMatched,
        betfairPnl: t.betfairPnl,
        dataTier: t.dataTier,
        experimentTag: t.experimentTag,
        clvPct: t.clvPct,
        pinnacleOdds: t.pinnacleOdds,
        isContrarian: t.isContrarian,
        betThesis: t.betThesis,
      })
      .from(t)
      .leftJoin(matchesTable, eq(t.matchId, matchesTable.id))
      .where(baseConditions)
      .orderBy(desc(t.placedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(t)
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
      stake: paperBetsCurrentView.stake,
      settlementPnl: paperBetsCurrentView.settlementPnl,
      calculatedEdge: paperBetsCurrentView.calculatedEdge,
      placedAt: paperBetsCurrentView.placedAt,
      settledAt: paperBetsCurrentView.settledAt,
    })
    .from(paperBetsCurrentView)
    .where(and(inArray(paperBetsCurrentView.status, ["won", "lost"]), REAL_MONEY_CURRENT))
    .orderBy(asc(paperBetsCurrentView.placedAt));

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
        id: paperBetsCurrentView.id,
        matchId: paperBetsCurrentView.matchId,
        marketType: paperBetsCurrentView.marketType,
        selectionName: paperBetsCurrentView.selectionName,
        stake: paperBetsCurrentView.stake,
        settlementPnl: paperBetsCurrentView.settlementPnl,
        status: paperBetsCurrentView.status,
        opportunityScore: paperBetsCurrentView.opportunityScore,
        oddsAtPlacement: paperBetsCurrentView.oddsAtPlacement,
      })
      .from(paperBetsCurrentView)
      .where(inArray(paperBetsCurrentView.status, ["won", "lost"]));

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
        clvPct: paperBetsCurrentView.clvPct,
        placedAt: paperBetsCurrentView.placedAt,
        marketType: paperBetsCurrentView.marketType,
        status: paperBetsCurrentView.status,
        pinnacleOdds: paperBetsCurrentView.pinnacleOdds,
        closingPinnacleOdds: (paperBetsCurrentView as any).closingPinnacleOdds,
        isContrarian: paperBetsCurrentView.isContrarian,
        stake: paperBetsCurrentView.stake,
        settlementPnl: paperBetsCurrentView.settlementPnl,
      })
      .from(paperBetsCurrentView)
      .where(
        and(
          sql`${paperBetsCurrentView.clvPct} IS NOT NULL`,
          sql`${paperBetsCurrentView.status} IN ('won','lost')`,
          REAL_MONEY_CURRENT,
        ),
      )
      .orderBy(asc(paperBetsCurrentView.placedAt))
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
      .from(paperBetsCurrentView)
      .where(and(sql`${paperBetsCurrentView.status} IN ('won','lost')`, REAL_MONEY_CURRENT));
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

    return res.json({
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
    return res.status(500).json({ error: "Failed to compute CLV stats" });
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
// POST /api/admin/reconcile-stale-pending — manually trigger the post-kickoff
// stale-pending escalator. Normally runs hourly; this is for on-demand
// triage. Idempotent (alert dedup + state checks make repeat calls safe).
// ─────────────────────────────────────────────
router.post("/admin/reconcile-stale-pending", async (_req, res) => {
  logger.info("Manual stale-pending reconciliation triggered via API");
  try {
    const { reconcileStalePending } = await import("../services/paperTrading");
    const result = await reconcileStalePending();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Manual stale-pending reconciliation failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/admin/reconcile-live-balance — on-demand balance vs ledger check.
// Returns drift diagnostics; alerts at warning/critical thresholds. No-op
// outside live mode (returns null result).
// ─────────────────────────────────────────────
router.post("/admin/reconcile-live-balance", async (_req, res) => {
  logger.info("Manual live balance reconciliation triggered via API");
  try {
    const { reconcileLiveBalance } = await import("../services/liveReconciliation");
    const result = await reconcileLiveBalance();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual live balance reconciliation failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// POST /api/admin/reconcile-live-statement — on-demand account-statement walk.
// Optional `lookbackHours` body param (default 48). Detects orphans, missing
// entries, and per-bet P&L drift. No-op outside live mode.
// ─────────────────────────────────────────────
router.post("/admin/reconcile-live-statement", async (req, res) => {
  logger.info("Manual live statement reconciliation triggered via API");
  try {
    const lookbackHours = Number((req.body as { lookbackHours?: number })?.lookbackHours ?? 48);
    if (!Number.isFinite(lookbackHours) || lookbackHours <= 0 || lookbackHours > 720) {
      return res.status(400).json({ success: false, message: "lookbackHours must be between 1 and 720" });
    }
    const { reconcileLiveAccountStatement } = await import("../services/liveReconciliation");
    const result = await reconcileLiveAccountStatement(lookbackHours);
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual live statement reconciliation failed");
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
// POST /api/leagues/betfair-reverse-mapping/run — sub-phase 2 cron (manual trigger).
// Honours BETFAIR_REVERSE_MAPPING_DRY_RUN env (default 'false' since Wave 3 — set true to log diff only).
// ─────────────────────────────────────────────
router.post("/leagues/betfair-reverse-mapping/run", async (_req, res) => {
  try {
    const result = await manualTriggerBetfairReverseMapping();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual Betfair reverse-mapping failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Y1 (2026-05-07): manual trigger for Tier E re-evaluation pass.
// Re-runs assignTier with category-aware Y2 rules on Tier E rows;
// auto-promotes women's/youth/internationals/friendlies that should now
// qualify for active tiers. Full audit log written.
router.post("/leagues/tier-e-reevaluate/run", async (_req, res) => {
  try {
    const { reevaluateExcludedLeagues } = await import("../services/betfairFirstUniverse");
    const result = await reevaluateExcludedLeagues();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual Tier E re-evaluation failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Sub-phase 4.A (2026-05-08): manual trigger for exchange book sweep.
// Captures betfair_exchange odds for the 27 verified market types
// (incl. ASIAN_HANDICAP, DRAW_NO_BET, HTFT, ODD_OR_EVEN, TEAM_A/B_*,
// WIN_TO_NIL, OVER_UNDER 0.5/5.5/6.5/7.5/8.5, FH_GOALS_*).
router.post("/admin/run-exchange-sweep", async (_req, res) => {
  try {
    const { runExchangeBookSweep } = await import("../services/exchangeBookSweep");
    const result = await runExchangeBookSweep({ hoursAhead: 48 });
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual exchange book sweep failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Phase 3 Track A (2026-05-08): one-shot disable + revert.
//
// Sets z3_enabled, z4_enabled, model_self_audit_enabled = 'false' in
// agent_config (belt-and-braces alongside scheduler.ts comment-outs in
// case the next deploy reverts the file edits, and to also block manual
// triggers via /admin/run-tier-ladder etc.).
//
// Reverts the 4 demotions from 2026-05-08 03:30:
//   id=1 market:BTTS              audit_log_id=1241  (was DEFAULT → SHADOW_ONLY)
//   id=2 market:MATCH_ODDS        audit_log_id=1242  (was DEFAULT → STANDARD_REDUCED)
//   id=3 archetype:top_flight_men audit_log_id=1251  (was DEFAULT → STANDARD_REDUCED)
//   id=4 archetype:lower_division audit_log_id=1252  (was DEFAULT → STANDARD_REDUCED)
//
// Three of four demotions hit profitable scopes (lower_division ROI +18.21%
// on n=385; top_flight_men ROI +12.75% on n=41; BTTS ROI +69.72% on n=8)
// because the underlying Kelly-growth proxy is unit-stake-of-bankroll
// arithmetic with thresholds calibrated to true bankroll-fraction Kelly.
// See docs/phase-3-paper-to-live-switchover-plan-v2.md §1.4.
//
// Idempotent: running twice has no additional effect. Each step checks
// current state before acting.
router.post("/admin/phase3-track-a-execute", async (_req, res) => {
  try {
    const { db, agentConfigTable, modelDecisionAuditLogTable } = await import("@workspace/db");
    const { sql, eq } = await import("drizzle-orm");

    const result = {
      flags_set: [] as string[],
      flags_already_set: [] as string[],
      pauses_resolved: [] as Array<{ id: number; scope_type: string; scope_value: string }>,
      pauses_already_resolved: [] as number[],
      reversals_logged: [] as number[],
      reversals_already_logged: [] as number[],
    };

    // 1. Set kill-switch flags (idempotent UPSERT)
    const flagKeys = ["z3_enabled", "z4_enabled", "model_self_audit_enabled"];
    for (const key of flagKeys) {
      const existing = await db
        .select({ value: agentConfigTable.value })
        .from(agentConfigTable)
        .where(eq(agentConfigTable.key, key));
      const current = existing[0]?.value ?? null;
      if (current === "false") {
        result.flags_already_set.push(key);
        continue;
      }
      if (existing.length === 0) {
        await db.insert(agentConfigTable).values({ key, value: "false" });
      } else {
        await db
          .update(agentConfigTable)
          .set({ value: "false", updatedAt: new Date() })
          .where(eq(agentConfigTable.key, key));
      }
      result.flags_set.push(key);
    }

    // 2. Revert the 4 specific autonomous_pauses rows from 2026-05-08 03:30.
    // IDs are hardcoded constants (1,2,3,4 from the audit query); using a
    // literal IN-list rather than parameterised ANY(...::int[]) because
    // drizzle's sql tag binds JS arrays as separate params, producing a row
    // constructor that postgres can't cast to int[].
    const targetRows = await db.execute(sql`
      SELECT id, scope_type, scope_value, resumed_at, audit_log_id, kelly_fraction_override::text AS override
      FROM autonomous_pauses
      WHERE id IN (1, 2, 3, 4)
        AND paused_at >= '2026-05-08 03:30:00'::timestamptz
        AND paused_at <= '2026-05-08 03:31:00'::timestamptz
    `);
    const rows = ((targetRows as any).rows ?? []) as Array<{
      id: number;
      scope_type: string;
      scope_value: string;
      resumed_at: string | null;
      audit_log_id: number | null;
      override: string | null;
    }>;

    for (const r of rows) {
      // Step 1: resolve pause if not already (idempotent on its own).
      // Pre-existing partial state from a prior failed run is fine — the
      // audit-log write below is independent.
      if (r.resumed_at == null) {
        await db.execute(sql`
          UPDATE autonomous_pauses
          SET resumed_at = NOW(),
              notes = COALESCE(notes, '') || ' | Phase 3 Track A revert 2026-05-08: demotion fired on broken Kelly-growth proxy'
          WHERE id = ${r.id} AND resumed_at IS NULL
        `);
        result.pauses_resolved.push({ id: r.id, scope_type: r.scope_type, scope_value: r.scope_value });
      } else {
        result.pauses_already_resolved.push(r.id);
      }

      // Step 2: log reversal in model_decision_audit_log if not already logged.
      // Idempotency key: decision_type='tier_demotion_reverted' AND
      // supporting_metrics.reverted_pause_id = r.id. Independent of step 1
      // so partial state from a prior crashed run gets healed here.
      const existing = await db.execute(sql`
        SELECT id FROM model_decision_audit_log
        WHERE decision_type = 'tier_demotion_reverted'
          AND supporting_metrics->>'reverted_pause_id' = ${String(r.id)}
        LIMIT 1
      `);
      if ((((existing as any).rows ?? []) as Array<unknown>).length > 0) {
        result.reversals_already_logged.push(r.id);
        continue;
      }
      const insertedRows = await db
        .insert(modelDecisionAuditLogTable)
        .values({
          decisionType: "tier_demotion_reverted",
          subject: `${r.scope_type}:${r.scope_value}`,
          priorState: { tier_after_demotion_kelly_fraction: r.override } as any,
          newState: { tier: "DEFAULT", kelly_fraction_override: null } as any,
          reasoning:
            `Phase 3 Track A revert (2026-05-08): demotion fired on broken Kelly-growth proxy ` +
            `(unit-stake arithmetic with bankroll-fraction-calibrated threshold). ` +
            `Reversal restores scope to DEFAULT pending Kelly-growth metric replacement on bankroll_snapshots. ` +
            `Original autonomous_pauses row id=${r.id}; original audit_log_id=${r.audit_log_id ?? "null"}.`,
          supportingMetrics: {
            track: "phase3_track_a",
            reverted_pause_id: r.id,
            reverted_audit_log_id: r.audit_log_id,
            scope_type: r.scope_type,
            scope_value: r.scope_value,
          } as any,
          reviewStatus: "user_overridden",
        })
        .returning({ id: modelDecisionAuditLogTable.id });
      const newId = insertedRows[0]?.id;
      if (newId != null) result.reversals_logged.push(newId);
    }

    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Phase 3 Track A execute failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Phase 3 Track B (2026-05-08): backfill endpoint covering B3, B5, B6
// (the bet_track migration backfills run inside migrate.ts but a manual
// re-run is exposed here too), plus B8 diagnoses and the 1 NULL
// shadow_pnl heal.
//
// Idempotent — each backfill reads current state and only writes where
// missing/incorrect. Safe to run multiple times.
router.post("/admin/phase3-track-b-backfill", async (_req, res) => {
  try {
    const { db, paperBetsTable, complianceLogsTable, agentConfigTable } = await import("@workspace/db");
    const { sql, eq } = await import("drizzle-orm");
    const { calculateSettlementWithCommission } = await import("../services/commissionService");

    const result = {
      b3_gross_pnl_backfilled: 0,
      b5_clv_pinnacle_backfilled: 0,
      b5_clv_none_backfilled: 0,
      b6_bet_track_backfilled: 0,
      b8_placement_failed_diagnosed: 0,
      b8_null_shadow_pnl_healed: 0,
      blockers_validated_at_set: false,
    };

    // ── B3 backfill: gross_pnl / commission_amount / net_pnl on settled
    //    rows where these columns are null. Use commissionService to
    //    derive consistent values from stake + odds + status. settlement_pnl
    //    is already net of commission so DON'T trust it for gross.
    const b3Rows = await db.execute(sql`
      SELECT id, status, stake::numeric AS stk, odds_at_placement::numeric AS odds
      FROM paper_bets
      WHERE deleted_at IS NULL AND legacy_regime = false
        AND status IN ('won','lost','void')
        AND stake::numeric > 0
        AND (gross_pnl IS NULL OR commission_amount IS NULL OR net_pnl IS NULL)
    `);
    const COMMISSION_RATE = 0.05;
    for (const r of (((b3Rows as any).rows ?? []) as Array<{
      id: number; status: string; stk: string | number; odds: string | number;
    }>)) {
      const stk = Number(r.stk);
      const odds = Number(r.odds);
      const isVoid = r.status === "void";
      const betWon = r.status === "won";
      const comm = isVoid
        ? { grossPnl: 0, commissionRate: 0, commissionAmount: 0, netPnl: 0 }
        : calculateSettlementWithCommission(stk, odds, betWon, COMMISSION_RATE);
      await db.update(paperBetsTable).set({
        grossPnl: String(comm.grossPnl),
        commissionRate: String(comm.commissionRate),
        commissionAmount: String(comm.commissionAmount),
        netPnl: String(comm.netPnl),
      }).where(eq(paperBetsTable.id, r.id));
      result.b3_gross_pnl_backfilled++;
    }

    // ── B5 backfill: tag clv_source on settled rows. 'pinnacle' if
    //    closing_pinnacle_odds is set, 'none' otherwise. Only updates
    //    rows where clv_source is currently null/empty.
    // Tag any settled row with closing_pinnacle_odds as 'pinnacle', regardless
    // of any prior tag. Rationale: Path P evaluation pool is filtered on
    // clv_source='pinnacle' AND clv_pct IS NOT NULL — rows previously tagged
    // 'market_proxy' but which DO have a Pinnacle close should count, because
    // the Pinnacle anchor IS the stronger signal whenever it exists. The
    // market_proxy tag was set by an older code path (paperTrading.ts pre-fix)
    // that never re-promoted to pinnacle even when close was captured.
    const b5Pinn = await db.execute(sql`
      UPDATE paper_bets
      SET clv_source = 'pinnacle'
      WHERE legacy_regime = false AND deleted_at IS NULL
        AND status IN ('won','lost')
        AND closing_pinnacle_odds IS NOT NULL
        AND (clv_source IS NULL OR clv_source != 'pinnacle')
      RETURNING id
    `);
    result.b5_clv_pinnacle_backfilled = (((b5Pinn as any).rows ?? []) as unknown[]).length;

    const b5None = await db.execute(sql`
      UPDATE paper_bets
      SET clv_source = 'none'
      WHERE legacy_regime = false AND deleted_at IS NULL
        AND status IN ('won','lost')
        AND closing_pinnacle_odds IS NULL
        AND (clv_source IS NULL OR clv_source = '')
      RETURNING id
    `);
    result.b5_clv_none_backfilled = (((b5None as any).rows ?? []) as unknown[]).length;

    // ── B6 backfill: heal any rows where bet_track is still null after
    //    migration ran. Migration handles the bulk; this is a safety net.
    const b6Shadow = await db.execute(sql`
      UPDATE paper_bets SET bet_track = 'shadow'
      WHERE bet_track IS NULL
        AND COALESCE(stake::numeric, 0) = 0
        AND shadow_stake IS NOT NULL AND shadow_stake::numeric > 0
      RETURNING id
    `);
    const b6Paper = await db.execute(sql`
      UPDATE paper_bets SET bet_track = 'paper'
      WHERE bet_track IS NULL
        AND stake::numeric > 0 AND betfair_bet_id IS NULL
      RETURNING id
    `);
    const b6Live = await db.execute(sql`
      UPDATE paper_bets SET bet_track = 'live'
      WHERE bet_track IS NULL AND betfair_bet_id IS NOT NULL
      RETURNING id
    `);
    result.b6_bet_track_backfilled =
      (((b6Shadow as any).rows ?? []) as unknown[]).length +
      (((b6Paper as any).rows ?? []) as unknown[]).length +
      (((b6Live as any).rows ?? []) as unknown[]).length;

    // ── B8: diagnose the 9 placement_failed rows (and any others) +
    //    heal the 1 NULL shadow_pnl row.
    const failedRows = await db.execute(sql`
      SELECT pb.id, pb.match_id, pb.market_type, pb.selection_name,
             pb.placed_at, m.betfair_event_id
      FROM paper_bets pb LEFT JOIN matches m ON m.id = pb.match_id
      WHERE pb.status = 'placement_failed'
        AND pb.legacy_regime = false AND pb.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM compliance_logs cl
          WHERE cl.action_type = 'placement_failure_diagnosed'
            AND (cl.details::jsonb->>'paper_bet_id')::int = pb.id
        )
    `);
    for (const r of (((failedRows as any).rows ?? []) as Array<{
      id: number; match_id: number; market_type: string; selection_name: string;
      placed_at: string; betfair_event_id: string | null;
    }>)) {
      // Classify. All 9 known rows are pre-Phase-2.A MATCH_ODDS Draw/Away
      // with universe_tier_at_placement IS NULL — Betfair market resolution
      // failed at placement time. Sub-phase 4.A improved discovery; these
      // are recoverable (would not recur on current pipeline).
      const cause = r.betfair_event_id == null ? "no_betfair_event_id" : "market_resolution_failed";
      const disposition = "recoverable_pre_4a_pipeline";
      await db.insert(complianceLogsTable).values({
        actionType: "placement_failure_diagnosed",
        details: {
          paper_bet_id: r.id, match_id: r.match_id, market_type: r.market_type,
          selection_name: r.selection_name, placed_at: r.placed_at,
          betfair_event_id: r.betfair_event_id,
          cause, disposition,
          note: "Pre-Phase-2.A pipeline; sub-phase 4.A market discovery resolves this class of failure on current builds.",
        } as Record<string, unknown>,
        timestamp: new Date(),
      } as any).catch(() => undefined);
      result.b8_placement_failed_diagnosed++;
    }

    // Heal the 1 NULL shadow_pnl row (id=924) — recompute shadow_pnl
    // from outcome × shadow_stake using the same formula settlement uses.
    const nullShadowRows = await db.execute(sql`
      SELECT id, status, shadow_stake::numeric AS sstake,
             odds_at_placement::numeric AS odds
      FROM paper_bets
      WHERE shadow_stake IS NOT NULL AND shadow_stake::numeric > 0
        AND status IN ('won','lost') AND shadow_pnl IS NULL
        AND legacy_regime = false AND deleted_at IS NULL
    `);
    for (const r of (((nullShadowRows as any).rows ?? []) as Array<{
      id: number; status: string; sstake: string | number; odds: string | number;
    }>)) {
      const sstake = Number(r.sstake);
      const odds = Number(r.odds);
      const won = r.status === "won";
      const comm = calculateSettlementWithCommission(sstake, odds, won, COMMISSION_RATE);
      await db.update(paperBetsTable).set({
        shadowPnl: String(comm.netPnl),
      }).where(eq(paperBetsTable.id, r.id));
      result.b8_null_shadow_pnl_healed++;
    }

    // ── Set blockers_validated_at if all blockers pass. Caller can also
    //    set evaluation_start_at separately when ready.
    // We don't auto-set blockers_validated_at here — Chris signs off after
    // running the validation SQLs. Leave as a no-op for now.

    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Phase 3 Track B backfill failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 URGENT: manually clear the in-process tradingCycleRunning
// lock. Used when a prior cycle hung (e.g. vps-relay timeout) and left
// the lock held. Returns whether the lock was actually held + how long.
// Stale-lock auto-release at 5 min is the steady-state mitigation; this
// endpoint is for immediate manual recovery.
router.post("/admin/reset-trading-lock", async (_req, res) => {
  try {
    const { resetTradingCycleLock } = await import("../services/scheduler");
    const result = resetTradingCycleLock();
    logger.warn(result, "Trading-cycle lock manually reset");
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "reset-trading-lock failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08: reset ALL in-process cron locks at once. Returns which were
// held. Used for emergency unblock when the stale-detection threshold is
// too long for the current incident.
router.post("/admin/reset-all-cron-locks", async (_req, res) => {
  try {
    const sched = await import("../services/scheduler");
    const lockMgr = await import("../lib/lockManager");
    const result = {
      trading: sched.resetTradingCycleLock(),
      ingestion: sched.resetIngestionLock(),
      feature: sched.resetFeatureLock(),
      exchange_book_sweep: sched.resetExchangeBookSweepLock(),
      all_locks_status: lockMgr.getAllLockStatus(),
    };
    logger.warn(result, "All in-process cron locks manually reset");
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "reset-all-cron-locks failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 (post-RCA): manual triggers for the new data-quality and
// recommender crons. Used to seed initial state and to validate
// behaviour without waiting for the scheduled slot.
router.post("/admin/run-data-quality-monitor", async (_req, res) => {
  try {
    const { runDataQualityMonitor } = await import("../services/dataQualityMonitor");
    const r = await runDataQualityMonitor();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual data quality monitor failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-15 — four structural audits (CLAUDE.md Principle #6). Runs daily
// at 02:00 UTC alongside the existing data-quality monitor; this endpoint
// triggers on demand for verification without waiting for the cron tick.
router.post("/admin/run-structural-audits", async (_req, res) => {
  try {
    const { runStructuralAudits } = await import("../services/dataQualityMonitor");
    const r = await runStructuralAudits();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual structural audits failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-15 — #62 Path A. Flips stale-scheduled matches to
// 'no_result_available' and void-settles attached pending bets.
// Runs daily 02:00 UTC alongside the data quality monitor; this endpoint
// triggers on demand to clear the chronic baseline immediately.
router.post("/admin/auto-transition-stale-matches", async (_req, res) => {
  try {
    const { autoTransitionStaleMatches } = await import("../services/dataQualityMonitor");
    const r = await autoTransitionStaleMatches();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual auto-transition stale matches failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/run-adaptive-recommender", async (_req, res) => {
  try {
    const { runAdaptiveThresholdRecommender } = await import("../services/adaptiveThresholdRecommender");
    const r = await runAdaptiveThresholdRecommender();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual adaptive recommender failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08: Z4-v2 manual trigger. Used to validate the Bayesian tier
// ladder behaves correctly before enabling the cron via z4_v2_enabled.
router.post("/admin/run-tier-ladder-v2", async (_req, res) => {
  try {
    const { runAutonomousTierLadderV2 } = await import("../services/autonomousTierLadderV2");
    const r = await runAutonomousTierLadderV2();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual Z4-v2 tier ladder failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 (CLV multi-source): one-shot backfill that walks every settled
// paper bet missing closing_pinnacle_odds and runs the multi-source resolver
// (api_football_real:Pinnacle for BTTS/DC/FH/TEAM_TOTAL, derived_from_match_
// odds for DC fallback). Idempotent. Body: { limit?: number }.
router.post("/admin/backfill-closing-pinnacle", async (req, res) => {
  try {
    const limit = Number((req.body ?? {}).limit ?? 5000);
    const { backfillClosingPinnacleFromMultiSource } = await import("../services/oddsPapi");
    const r = await backfillClosingPinnacleFromMultiSource({ limit });
    return res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "backfill-closing-pinnacle failed");
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 (CLV diagnostic v2): exposes the raw market->outcome->player
// KEY structure that the production parser flattens away. Used to verify
// whether OddsPapi's outcome KEYS for BTTS/DC/FH/TEAM_TOTAL are readable
// (e.g. "yes"/"no"/"1x") even when the bookmakerOutcomeId is a numeric
// internal ID. If keys ARE readable we can fix the parser to use
// Object.entries over Object.values and unlock OddsPapi for ALL markets.
router.post("/admin/debug-oddspapi-raw", async (req, res) => {
  try {
    const matchId = Number((req.body ?? {}).matchId);
    const marketType = String((req.body ?? {}).marketType ?? "");
    if (!matchId || !marketType) {
      return res.status(400).json({ success: false, message: "Body requires { matchId: number, marketType: string }" });
    }
    const { debugOddsPapiRawStructure } = await import("../services/oddsPapi");
    const r = await debugOddsPapiRawStructure({ matchId, marketType });
    return res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "debug-oddspapi-raw failed");
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 (CLV diagnostic): inspect raw OddsPapi response for a specific
// (matchId, marketType). Used to diagnose why BTTS/DC/FH/TEAM_TOTAL show
// zero oddspapi_pinnacle snapshots — reveals whether the API genuinely
// has no Pinnacle data, or returns Pinnacle in a label format we don't
// decode. Body: { matchId: number, marketType: string }.
router.post("/admin/debug-oddspapi-fetch", async (req, res) => {
  try {
    const matchId = Number((req.body ?? {}).matchId);
    const marketType = String((req.body ?? {}).marketType ?? "");
    if (!matchId || !marketType) {
      return res.status(400).json({ success: false, message: "Body requires { matchId: number, marketType: string }" });
    }
    const { debugOddsPapiFetch } = await import("../services/oddsPapi");
    const r = await debugOddsPapiFetch({ matchId, marketType });
    return res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "debug-oddspapi-fetch failed");
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 OddsPapi maximisation bundle endpoints.
router.post("/admin/run-sharp-move-detector", async (_req, res) => {
  try {
    const { runPinnacleSharpMoveDetector } = await import("../services/pinnacleSharpMoveDetector");
    const r = await runPinnacleSharpMoveDetector();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual sharp-move detector failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/run-oddspapi-cross-check", async (_req, res) => {
  try {
    const { runOddsPapiCrossCheck } = await import("../services/oddsPapiCrossCheck");
    const r = await runOddsPapiCrossCheck();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual cross-check failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.get("/admin/oddspapi-bookmaker-catalog", async (_req, res) => {
  try {
    const { summariseBookmakerCatalog } = await import("../services/oddsPapiBookmakerCatalog");
    const r = await summariseBookmakerCatalog();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Bookmaker catalog summary failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 Neon cost audit follow-up: VACUUM FULL endpoint. Rewrites
// the table to reclaim disk space — VACUUM ANALYZE alone marks dead
// rows but doesn't return disk to Neon's storage layer, so the logical-
// storage billing metric stays elevated. VACUUM FULL takes an
// AccessExclusive lock per table for 1-3 minutes (3GB table). Operator-
// triggered only. Body optional: { tables?: string[] }.
router.post("/admin/run-vacuum-full", async (req, res) => {
  try {
    const tables = (req.body ?? {}).tables;
    const { runVacuumFull } = await import("../services/storageCleanup");
    const r = await runVacuumFull({ tables });
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "VACUUM FULL failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 Neon cost audit: manual trigger for storage cleanup. Returns
// row counts deleted by category. Body optional: { oddsSnapshotsBatchSize?,
// oddsHistoryBatchSize?, oddsSnapshotsMaxIterations?, oddsHistoryMaxIterations? }.
router.post("/admin/run-storage-cleanup", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // 2026-05-14 Phase 5 fix: the previous body params (BatchLimit) were
    // typo'd vs the function signature (BatchSize / MaxIterations) and so
    // never plumbed through. Accept both names for compat; coerce to the
    // function's expected fields.
    const oddsSnapshotsBatchSize =
      body.oddsSnapshotsBatchSize ?? body.oddsSnapshotsBatchLimit;
    const oddsSnapshotsMaxIterations =
      body.oddsSnapshotsMaxIterations ?? body.oddsSnapshotsBatchLimit;
    const oddsHistoryBatchSize =
      body.oddsHistoryBatchSize ?? body.oddsHistoryBatchLimit;
    const oddsHistoryMaxIterations =
      body.oddsHistoryMaxIterations ?? body.oddsHistoryBatchLimit;
    const { runStorageCleanup, vacuumCleanedTables } = await import("../services/storageCleanup");
    const cleanup = await runStorageCleanup({
      oddsSnapshotsBatchSize: oddsSnapshotsBatchSize ? Number(oddsSnapshotsBatchSize) : undefined,
      oddsSnapshotsMaxIterations: oddsSnapshotsMaxIterations ? Number(oddsSnapshotsMaxIterations) : undefined,
      oddsHistoryBatchSize: oddsHistoryBatchSize ? Number(oddsHistoryBatchSize) : undefined,
      oddsHistoryMaxIterations: oddsHistoryMaxIterations ? Number(oddsHistoryMaxIterations) : undefined,
    });
    const vacuum = await vacuumCleanedTables();
    res.json({ success: true, cleanup, vacuum });
  } catch (err) {
    logger.error({ err }, "Manual storage cleanup failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/find-best-price", async (req, res) => {
  try {
    const matchId = Number((req.body ?? {}).matchId);
    const marketType = String((req.body ?? {}).marketType ?? "");
    const selectionName = String((req.body ?? {}).selectionName ?? "");
    const restrict = (req.body ?? {}).restrictToIntegratable !== false;
    if (!matchId || !marketType || !selectionName) {
      return res.status(400).json({ success: false, message: "Body requires { matchId, marketType, selectionName }" });
    }
    const { findBestPrice } = await import("../services/bestPriceFinder");
    const r = await findBestPrice({ matchId, marketType, selectionName, restrictToIntegratable: restrict });
    return res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "find-best-price failed");
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 (Lever 2): manual trigger for dead-letter sweep + registry
// completeness check. Auto-voids bets stuck >7d post-kickoff with >50
// attempts and raises data_quality_alerts for any unregistered market types.
router.post("/admin/run-dead-letter-sweep", async (_req, res) => {
  try {
    const { runDeadLetterSweep } = await import("../services/deadLetterSweep");
    const r = await runDeadLetterSweep();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual dead-letter sweep failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/run-daily-discovery-sweep", async (_req, res) => {
  try {
    const { runDailyDiscoverySweep } = await import("../services/oddsPapi");
    const r = await runDailyDiscoverySweep();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual discovery sweep failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Phase 3 A5 (2026-05-08): pre-flip live canary. Places ONE real Betfair
// bet at £0.10 to validate the entire live placement chain end-to-end
// (Betfair API, settlement, reconciliation, commission attribution) BEFORE
// the actual switchover. De-risks doc §R7 — failed first live bet halt-
// and-investigate cycle that could delay live operation by days.
//
// Bypasses live_placement_enabled kill switch + live_whitelist scope check
// because the canary is by definition pre-flip with no whitelist yet.
//
// Hard-armed: requires agent_config.live_canary_enabled='true' (operator
// must explicitly arm). One-shot: refuses if agent_config.live_canary_used
// is already 'true' (manual reset required to re-fire).
//
// Stake: hard-coded £0.10 regardless of body.stake. The canary is
// infrastructure validation, not capital deployment.
//
// Body: { matchId: number, marketType: string, selectionName: string, odds: number }
//
// Operator picks the match — the canary doesn't try to auto-select a
// "high-liquidity Premier League fixture" because picking that
// algorithmically is fraught (Betfair liquidity varies hourly). Operator
// reviews available fixtures via Neon (matches WHERE betfair_event_id ~
// '^[0-9]+$' AND kickoff_time BETWEEN NOW() AND NOW()+'24 hours') and
// supplies the (matchId, marketType, selectionName, odds) tuple.
router.post("/admin/live-canary", async (req, res) => {
  try {
    // 2026-05-08: TRADING_MODE=LIVE check removed. The dev-on-prod startup
    // guard (startupChecks.ts:129) refuses to boot when NODE_ENV=development
    // AND TRADING_MODE=LIVE — that's by design to keep the dev workspace
    // out of live trading. The canary is a deliberate one-shot real-bet
    // test that should work in paper-on-prod mode. The two remaining
    // safety gates (live_canary_enabled='true' + one-shot live_canary_used
    // lock) are sufficient — operator must explicitly arm AND the endpoint
    // refuses to re-fire after one successful placement.
    const armed = (await getConfigValue("live_canary_enabled")) === "true";
    if (!armed) {
      return res.status(400).json({
        success: false,
        message: "agent_config.live_canary_enabled != 'true' — operator must explicitly arm",
      });
    }
    const used = (await getConfigValue("live_canary_used")) === "true";
    if (used) {
      return res.status(400).json({
        success: false,
        message: "Canary already fired — set agent_config.live_canary_used='false' to re-arm",
      });
    }
    const { matchId, marketType, selectionName, odds } = req.body ?? {};
    if (typeof matchId !== "number" || !marketType || !selectionName || typeof odds !== "number") {
      return res.status(400).json({
        success: false,
        message: "Body required: { matchId: number, marketType: string, selectionName: string, odds: number }",
      });
    }
    if (!(odds >= 1.01 && odds <= 1000)) {
      return res.status(400).json({
        success: false,
        message: `odds=${odds} outside [1.01, 1000] sanity range`,
      });
    }
    const match = (
      await db.select().from(matchesTable).where(eq(matchesTable.id, matchId))
    )[0];
    if (!match) {
      return res.status(404).json({ success: false, message: `match ${matchId} not found` });
    }
    if (!match.betfairEventId || !/^[0-9]+$/.test(match.betfairEventId)) {
      return res.status(400).json({
        success: false,
        message: `match ${matchId} has betfair_event_id='${match.betfairEventId}' — must be numeric (real Betfair event)`,
      });
    }
    if (!match.kickoffTime || match.kickoffTime <= new Date()) {
      return res.status(400).json({
        success: false,
        message: `match ${matchId} kickoff in past or null — must be upcoming`,
      });
    }
    // £2 = Betfair Exchange minimum stake. Lower stakes get rejected by
    // Betfair before reaching our codepath, so the canary can't validate
    // the full chain at smaller sizes. Hard-capped at £2 — operator can't
    // accidentally place a larger bet via this endpoint.
    const STAKE = 2.00;
    const potentialProfit = Math.round(STAKE * (odds - 1) * 100) / 100;

    // Insert paper_bets row tagged as canary live bet.
    const inserted = await db
      .insert(paperBetsTable)
      .values({
        matchId,
        marketType,
        selectionName,
        betType: "back",
        oddsAtPlacement: String(odds),
        stake: String(STAKE),
        potentialProfit: String(potentialProfit),
        modelProbability: String(1 / odds), // sentinel — canary not a model bet
        impliedProbability: String(1 / odds),
        edge: "0",
        status: "pending_placement",
        legacyRegime: false,
        betTrack: "live",
        universeTierAtPlacement: "A",
      } as any)
      .returning();
    const bet = inserted[0];
    if (!bet?.id) {
      return res.status(500).json({ success: false, message: "Failed to insert canary paper_bets row" });
    }

    const { placeLiveBetOnBetfair } = await import("../services/betfairLive");
    const result = await placeLiveBetOnBetfair({
      internalBetId: bet.id,
      betfairEventId: match.betfairEventId,
      marketType,
      selectionName,
      odds,
      stake: STAKE,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
    });

    await db.insert(complianceLogsTable).values({
      actionType: "live_canary",
      details: {
        canary: true,
        betId: bet.id,
        matchId,
        marketType,
        selectionName,
        odds,
        stake: STAKE,
        result,
      } as any,
      timestamp: new Date(),
    });

    if (result.success) {
      await setConfigValue("live_canary_used", "true");
      await setConfigValue("live_canary_at", new Date().toISOString());
      await db
        .update(paperBetsTable)
        .set({
          status: "pending",
          betfairBetId: result.betfairBetId ?? null,
          betfairMarketId: result.betfairMarketId ?? null,
          betfairStatus: result.betfairStatus ?? null,
        } as any)
        .where(eq(paperBetsTable.id, bet.id));
      logger.info(
        { betId: bet.id, betfairBetId: result.betfairBetId, matchId, marketType, selectionName, odds, stake: STAKE },
        "Live canary placed successfully — pre-flip placement chain validated",
      );
      return res.json({ success: true, betId: bet.id, result });
    } else {
      await db
        .update(paperBetsTable)
        .set({ status: "placement_failed", betfairStatus: `CANARY_FAILED: ${result.error ?? "unknown"}` } as any)
        .where(eq(paperBetsTable.id, bet.id));
      logger.warn(
        { betId: bet.id, error: result.error, matchId, marketType, selectionName },
        "Live canary placement failed",
      );
      return res.status(500).json({ success: false, betId: bet.id, result });
    }
  } catch (err) {
    logger.error({ err }, "Live canary failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// 2026-05-08 URGENT: manual trigger for runTradingCycle. Used to diagnose
// trading_near silence post-deploy. Returns the cycle result directly so
// we can see which exit path was taken (lock skip / risk triggered /
// agent paused / actual completion).
router.post("/admin/run-trading-near", async (_req, res) => {
  try {
    const { runTradingCycle } = await import("../services/scheduler");
    const result = await runTradingCycle({ tier: "near", minHoursAhead: 1, maxHoursAhead: 48 });
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual run-trading-near failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Phase 3 §5 (2026-05-08): atomic paper→live switchover. Called by
// scripts/src/flip-to-live.ts after Chris confirms the manifest hash.
// Body shape:
//   {"manifestHash": "<sha256>", "confirm": true}
//
// Server-side flow (all in one logical transaction-equivalent sequence —
// individual writes are not wrapped in a single Postgres transaction
// because we need to call applyPendingCapsToLive() which has its own
// queries, but the order is designed so partial failures leave the
// system either fully paper or fully live, never half-flipped):
//
//   1. Fetch the latest unresolved gate_clear_pending_review row.
//      Abort if none.
//   2. Recompute the manifest from current gate_components + path_s_aggregate_status
//      + switchover_whitelist. Hash it. Compare to client-provided hash.
//      Abort on mismatch.
//   3. Re-run the gate triggers. Abort if neither Path P nor Path S is
//      currently passing (defense against stale pending-review row).
//   4. Apply bankroll-tier caps to live agent_config.
//   5. Insert live_whitelist snapshot rows.
//   6. Flip the four mode flags atomically (paper_mode, live_mode_active,
//      paper_bet_generation_enabled, live_mode_activated_at).
//   7. Insert compliance_logs row with full manifest.
//   8. Mark pending_review row resolved='flipped'.
router.post("/admin/flip-to-live", async (req, res) => {
  try {
    const { db, agentConfigTable, complianceLogsTable } = await import("@workspace/db");
    const { sql, eq } = await import("drizzle-orm");
    const { applyPendingCapsToLive } = await import("../services/bankrollTierCaps");
    const { createHash } = await import("node:crypto");

    const body = (req.body ?? {}) as { manifestHash?: string; confirm?: boolean };
    if (body.confirm !== true) {
      res.status(400).json({
        success: false,
        message: "{\"confirm\": true} required to execute the flip. Without it the request is refused.",
      });
      return;
    }
    if (!body.manifestHash || !/^[0-9a-f]{64}$/.test(body.manifestHash)) {
      res.status(400).json({
        success: false,
        message: "manifestHash (sha256 hex) required",
      });
      return;
    }

    // Step 1: latest unresolved pending review
    const pendingRows = await db.execute(sql`
      SELECT id, manifest_hash, manifest::text AS manifest_text, manifest
      FROM gate_clear_pending_review
      WHERE resolved_at IS NULL
      ORDER BY id DESC LIMIT 1
    `);
    const pending = (((pendingRows as any).rows ?? []) as Array<{
      id: number; manifest_hash: string; manifest_text: string; manifest: Record<string, unknown>;
    }>)[0];
    if (!pending) {
      res.status(409).json({
        success: false,
        message: "No unresolved gate_clear_pending_review row. The gate has not currently fired, or the manifest has expired.",
      });
      return;
    }

    // Step 2: hash check against the manifest as stored at gate-clear time
    if (pending.manifest_hash !== body.manifestHash) {
      res.status(409).json({
        success: false,
        message: "manifestHash mismatch — the pending-review manifest hash does not match the value provided. This is a safety check; refresh the manifest from gate_clear_pending_review and retry.",
        provided: body.manifestHash,
        expected: pending.manifest_hash,
      });
      return;
    }

    // Step 3: re-verify the gate is currently true. The pending-review row
    // was inserted when the cron last ran; state could have changed (e.g.
    // a new bet voided pushed the aggregate ROI under threshold). We DO
    // NOT compare a freshly-recomputed hash against the provided one —
    // that would force the user to re-fetch every cron tick. Instead we
    // verify the gate STILL passes; the manifest hash is the integrity
    // check that the user is acting on the manifest they reviewed.
    const gcRows = await db.execute(sql`SELECT * FROM gate_components`);
    const gc = (((gcRows as any).rows ?? []) as Array<{
      pool_size: number | string;
      aggregate_net_roi: number | string | null;
      aggregate_net_clv: number | string | null;
    }>)[0];
    const sStatusRows = await db.execute(sql`SELECT * FROM path_s_aggregate_status`);
    const sStatus = (((sStatusRows as any).rows ?? []) as Array<{
      path_s_aggregate_pass: boolean;
    }>)[0];
    const wlRows = await db.execute(sql`SELECT * FROM switchover_whitelist`);
    const wl = (((wlRows as any).rows ?? []) as Array<{
      path: string; market_type: string; league: string;
      n: number | string;
      scope_net_roi: number | string | null;
      scope_net_clv: number | string | null;
      share_of_agg_pnl: number | string | null;
    }>);

    // Phase 3 Path C (2026-05-08): CLV is no longer a gate condition. Only
    // pool size + net ROI required for Path P clearance. CLV still recorded
    // in the manifest for diagnostic / learning purposes.
    const pPass = !!gc
      && Number(gc.pool_size ?? 0) >= 200
      && Number(gc.aggregate_net_roi ?? 0) >= 0.03;
    const sPass = !!sStatus?.path_s_aggregate_pass;
    const wlOk = wl.length >= 1 && Math.max(0, ...wl.map((r) => Number(r.share_of_agg_pnl ?? 0))) <= 0.80;
    const trigger: "P" | "S" | null = pPass && wlOk ? "P" : sPass && wlOk ? "S" : null;
    if (!trigger) {
      res.status(409).json({
        success: false,
        message: "Gate no longer clearing at execution time. State changed between gate-clear and flip. Manifest hash matched but post-check failed.",
        path_p_pass: pPass, path_s_pass: sPass, whitelist_ok: wlOk, whitelist_size: wl.length,
      });
      return;
    }

    // Step 3a (Phase 3 §4.5, 2026-05-08): re-validate the 8 blockers. The
    // pending-review manifest was generated when the cron last ran (could
    // be hours ago); the underlying blocker conditions could have regressed
    // since. Refuse flip if any sentinel check fails.
    const blockerChecks = await db.execute(sql`
      SELECT
        -- B1: recent MATCH_ODDS bets have betfair_market_id (>=90%)
        (
          SELECT
            CASE WHEN COUNT(*) = 0 THEN true
                 ELSE (100.0 * COUNT(*) FILTER (WHERE pb.betfair_market_id IS NOT NULL)
                       / NULLIF(COUNT(*), 0)) >= 90.0
            END
          FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
          WHERE pb.market_type='MATCH_ODDS' AND pb.legacy_regime=false AND pb.deleted_at IS NULL
            AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
        ) AS b1_pass,
        -- B4: Z3/Z4/modelSelfAudit suspended
        (
          (SELECT value FROM agent_config WHERE key='z4_enabled') = 'false'
          AND (SELECT value FROM agent_config WHERE key='z3_enabled') = 'false'
          AND (SELECT value FROM agent_config WHERE key='model_self_audit_enabled') = 'false'
        ) AS b4_pass,
        -- B6: bet_track populated, no live rows pre-flip
        (
          NOT EXISTS (
            SELECT 1 FROM paper_bets WHERE deleted_at IS NULL AND bet_track IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM paper_bets WHERE deleted_at IS NULL AND bet_track='live'
              AND legacy_regime=false
              AND placed_at < (SELECT value::timestamptz FROM agent_config WHERE key='evaluation_start_at')
          )
        ) AS b6_pass,
        -- B5: post-eval-start settled bets with closing-line have clv_source tagged
        (
          NOT EXISTS (
            SELECT 1 FROM paper_bets pb
            WHERE pb.legacy_regime=false AND pb.deleted_at IS NULL
              AND pb.status IN ('won','lost')
              AND pb.closing_pinnacle_odds IS NOT NULL
              AND (pb.clv_source IS NULL OR pb.clv_source = 'none')
              AND pb.placed_at >= (SELECT value::timestamptz FROM agent_config WHERE key='evaluation_start_at')
          )
        ) AS b5_pass
    `);
    const bRow = (((blockerChecks as any).rows ?? []) as Array<{
      b1_pass: boolean; b4_pass: boolean; b5_pass: boolean; b6_pass: boolean;
    }>)[0];
    if (!bRow || !bRow.b1_pass || !bRow.b4_pass || !bRow.b5_pass || !bRow.b6_pass) {
      res.status(409).json({
        success: false,
        message: "Blocker re-validation failed at flip time. One or more of B1/B4/B5/B6 has regressed since gate-clear. Refusing flip.",
        blockers: bRow,
      });
      return;
    }

    // Step 3b: refuse if any unresolved gate_status_review_required rows.
    // 8-week diagnostic, drawdown halt, or Path P+ clear all surface here.
    // Operator must explicitly acknowledge_at before flip can proceed.
    const reviewRows = await db.execute(sql`
      SELECT id, reason, detected_at FROM gate_status_review_required
      WHERE acknowledged_at IS NULL ORDER BY id DESC LIMIT 5
    `);
    const unresolvedReviews = (((reviewRows as any).rows ?? []) as Array<{
      id: number; reason: string; detected_at: string;
    }>);
    if (unresolvedReviews.length > 0) {
      res.status(409).json({
        success: false,
        message: "Unresolved gate_status_review_required rows present. Operator must acknowledge each (UPDATE gate_status_review_required SET acknowledged_at=NOW() WHERE id=...) before the flip will proceed.",
        unresolved: unresolvedReviews,
      });
      return;
    }

    // Step 4: apply bankroll-tier caps to live config
    const capsApplied = await applyPendingCapsToLive();
    const bankrollAtFlip =
      ((await db.select({ value: agentConfigTable.value }).from(agentConfigTable).where(eq(agentConfigTable.key, "bankroll")))[0]?.value) ?? null;

    // Steps 5-8 (Phase 3 §5, 2026-05-08): atomic transaction. Whitelist
    // snapshot + mode-flag flip + compliance log + pending-review resolve
    // either ALL commit or ALL roll back. Pre-fix these were sequential
    // separate writes — a mid-step failure could leave the system half-
    // flipped (e.g. whitelist inserted but mode flags not set, or vice
    // versa). The capsApplied call above stays outside the transaction
    // because it's reversible via the same setConfig codepath if needed.
    let whitelistInserted = 0;
    let activeCountReadback = 0;
    await db.transaction(async (tx) => {
      // Step 5: snapshot whitelist (idempotent — only insert if no active rows
      // exist yet, to prevent double-flip from duplicating)
      const existingActive = await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM live_whitelist WHERE active = true
      `);
      const activeCount = Number((((existingActive as any).rows ?? []) as Array<{ n: number }>)[0]?.n ?? 0);
      activeCountReadback = activeCount;
      if (activeCount === 0) {
        for (const r of wl) {
          await tx.execute(sql`
            INSERT INTO live_whitelist (
              path, market_type, league, n,
              scope_net_roi, scope_net_clv, share_of_agg_pnl,
              kelly_fraction_override, live_bet_count, active
            ) VALUES (
              ${r.path}, ${r.market_type}, ${r.league}, ${Number(r.n)},
              ${r.scope_net_roi != null ? Number(r.scope_net_roi) : null},
              ${r.scope_net_clv != null ? Number(r.scope_net_clv) : null},
              ${r.share_of_agg_pnl != null ? Number(r.share_of_agg_pnl) : null},
              0.5, 0, true
            )
          `);
          whitelistInserted++;
        }
      }

      // Step 6: flip mode flags (in-tx)
      async function setOrInsertTx(key: string, value: string) {
        const existing = await tx.select().from(agentConfigTable).where(eq(agentConfigTable.key, key));
        if (existing.length === 0) {
          await tx.insert(agentConfigTable).values({ key, value });
        } else {
          await tx.update(agentConfigTable).set({ value, updatedAt: new Date() }).where(eq(agentConfigTable.key, key));
        }
      }
      await setOrInsertTx("paper_mode", "false");
      await setOrInsertTx("live_mode_active", "true");
      await setOrInsertTx("paper_bet_generation_enabled", "false");
      await setOrInsertTx("live_mode_activated_at", new Date().toISOString());
      // Phase 3 §1.8 (drawdown halt): pin bankroll_at_flip so
      // stopConditionMonitor has a stable baseline. Without this it falls
      // back to compliance_logs.live_mode_activated.details.bankroll_at_flip
      // which is also written below — belt-and-braces.
      if (bankrollAtFlip != null) {
        await setOrInsertTx("bankroll_at_flip", String(bankrollAtFlip));
      }

      // Step 7: compliance log (in-tx)
      await tx.insert(complianceLogsTable).values({
        actionType: "live_mode_activated",
        details: {
          trigger,
          manifest_hash: body.manifestHash,
          manifest_at_clear: pending.manifest,
          whitelist_size: wl.length,
          whitelist: wl,
          caps_applied: capsApplied,
          bankroll_at_flip: bankrollAtFlip,
        } as Record<string, unknown>,
        timestamp: new Date(),
      } as any);

      // Step 8: resolve pending-review row (in-tx)
      await tx.execute(sql`
        UPDATE gate_clear_pending_review
        SET resolved_at = NOW(), resolution = 'flipped'
        WHERE id = ${pending.id}
      `);
    });

    res.json({
      success: true,
      result: {
        trigger,
        whitelist_inserted: whitelistInserted,
        whitelist_already_active: activeCountReadback,
        caps_applied: capsApplied,
        flipped_at: new Date().toISOString(),
        compliance_log_written: true,
        pending_review_resolved: pending.id,
      },
    });
  } catch (err) {
    logger.error({ err }, "flip-to-live failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// GET version of the same logic — preview only, no writes. Used by the
// CLI to fetch and display the pending manifest before the user confirms.
router.get("/admin/flip-to-live-preview", async (_req, res) => {
  try {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");

    const pendingRows = await db.execute(sql`
      SELECT id, detected_at::text, manifest_hash, manifest, resolved_at::text, resolution
      FROM gate_clear_pending_review
      ORDER BY id DESC LIMIT 5
    `);
    const pending = ((pendingRows as any).rows ?? []) as Array<unknown>;

    const gcRows = await db.execute(sql`SELECT * FROM gate_components`);
    const sStatusRows = await db.execute(sql`SELECT * FROM path_s_aggregate_status`);
    const wlRows = await db.execute(sql`SELECT * FROM switchover_whitelist`);

    res.json({
      success: true,
      result: {
        pending_review_rows: pending,
        current_gate_components: ((gcRows as any).rows ?? [])[0] ?? null,
        current_path_s_status: ((sStatusRows as any).rows ?? [])[0] ?? null,
        current_whitelist: (wlRows as any).rows ?? [],
      },
    });
  } catch (err) {
    logger.error({ err }, "flip-to-live-preview failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Phase 3 (2026-05-08): set evaluation_start_at — the timestamp that
// activates the gate-monitoring pool filters. Once set, both Path P
// (evaluation_pool view) and Path S (shadow_evaluation_pool view) start
// admitting rows whose placed_at >= this timestamp. The daily 04:00 UTC
// gateMonitor cron then begins evaluating Path P + Path S aggregate
// triggers and writing gate_status / gate_clear_pending_review rows.
//
// Set-once semantics: refuses to overwrite an existing value unless
// {"force": true} is in the body. Body shape:
//   {"timestamp": "now" | "<ISO 8601>", "force"?: true}
router.post("/admin/set-evaluation-start", async (req, res) => {
  try {
    const { db, agentConfigTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");

    const body = (req.body ?? {}) as { timestamp?: string; force?: boolean };
    const force = body.force === true;
    const tsRaw = body.timestamp ?? "now";
    const ts = tsRaw === "now"
      ? new Date()
      : new Date(tsRaw);
    if (Number.isNaN(ts.getTime())) {
      res.status(400).json({ success: false, message: `Invalid timestamp: ${tsRaw}` });
      return;
    }

    const existing = await db
      .select({ value: agentConfigTable.value, updatedAt: agentConfigTable.updatedAt })
      .from(agentConfigTable)
      .where(eq(agentConfigTable.key, "evaluation_start_at"));

    if (existing.length > 0 && existing[0]!.value && !force) {
      res.status(409).json({
        success: false,
        message: "evaluation_start_at already set; pass {\"force\": true} to overwrite",
        existing: existing[0],
      });
      return;
    }

    const isoStr = ts.toISOString();
    if (existing.length === 0) {
      await db.insert(agentConfigTable).values({ key: "evaluation_start_at", value: isoStr });
    } else {
      await db.update(agentConfigTable)
        .set({ value: isoStr, updatedAt: new Date() })
        .where(eq(agentConfigTable.key, "evaluation_start_at"));
    }

    // Also stamp blockers_validated_at to the same moment so the gate
    // monitor manifest can show "blockers passed → evaluation begins".
    const blockersExisting = await db
      .select().from(agentConfigTable)
      .where(eq(agentConfigTable.key, "blockers_validated_at"));
    if (blockersExisting.length === 0) {
      await db.insert(agentConfigTable).values({ key: "blockers_validated_at", value: isoStr });
    } else {
      await db.update(agentConfigTable)
        .set({ value: isoStr, updatedAt: new Date() })
        .where(eq(agentConfigTable.key, "blockers_validated_at"));
    }

    res.json({
      success: true,
      result: {
        evaluation_start_at: isoStr,
        blockers_validated_at: isoStr,
        previous_value: existing[0]?.value ?? null,
        forced: force,
      },
    });
  } catch (err) {
    logger.error({ err }, "set-evaluation-start failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Phase 3 (2026-05-08): manual trigger for bankrollTierCaps. Cron runs
// daily 03:00 UTC; this lets us produce a pending_caps row immediately
// after deploy for blocker validation.
router.post("/admin/run-bankroll-tier-caps", async (_req, res) => {
  try {
    const { runBankrollTierCaps } = await import("../services/bankrollTierCaps");
    const r = await runBankrollTierCaps();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual bankrollTierCaps trigger failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Pre-flip blocker #7: locked_reserve admin endpoints. The CLI in
// scripts/src/reserve.ts wraps these. All lock/unlock/withdrawal events
// are recorded in reserve_events for audit.
router.get("/admin/reserve/status", async (_req, res) => {
  try {
    const { getLockedReserve, getRecentReserveEvents } = await import("../services/lockedReserve");
    const { getCachedBalance } = await import("../services/betfairLive");
    const locked = await getLockedReserve();
    const events = await getRecentReserveEvents(20);
    const cached = getCachedBalance();
    res.json({
      success: true,
      result: {
        current_locked: locked,
        betfair_available_cached: cached?.available ?? null,
        active_bankroll_estimate: cached ? Math.max(0, cached.available - locked) : null,
        recent_events: events,
      },
    });
  } catch (err) {
    logger.error({ err }, "reserve/status failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/reserve/event", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      event_type?: string; amount?: number; notes?: string | null;
      betfair_balance_at_event?: number | null;
    };
    const validTypes = ["lock", "unlock", "withdrawal_recorded", "reconcile_adjust"] as const;
    if (!body.event_type || !validTypes.includes(body.event_type as any)) {
      res.status(400).json({ success: false, message: `event_type must be one of ${validTypes.join(",")}` });
      return;
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ success: false, message: "amount must be a positive finite number" });
      return;
    }

    // Lock safeguard: refuse if it would push active bankroll below 2× bankroll_floor.
    if (body.event_type === "lock") {
      const { getCachedBalance } = await import("../services/betfairLive");
      const { getLockedReserve } = await import("../services/lockedReserve");
      const cached = getCachedBalance();
      const currentLocked = await getLockedReserve();
      if (cached) {
        const floor = await (async () => {
          const r = await db.execute(sql`SELECT value FROM agent_config WHERE key='bankroll_floor' LIMIT 1`);
          const v = (((r as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
          return Number(v ?? 0);
        })();
        const after = cached.available - currentLocked - amount;
        if (floor > 0 && after < 2 * floor) {
          res.status(400).json({
            success: false,
            message: `Lock would leave £${after.toFixed(2)} active, below 2× bankroll_floor (£${(2 * floor).toFixed(2)}). Reduce lock or unlock first.`,
          });
          return;
        }
      }
    }

    const { applyReserveEvent } = await import("../services/lockedReserve");
    const result = await applyReserveEvent({
      eventType: body.event_type as any,
      amount,
      notes: body.notes ?? null,
      betfairBalanceAtEvent: body.betfair_balance_at_event ?? null,
    });
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "reserve/event failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Pre-flip blocker #14: flip atomic transaction. Single endpoint that runs
// the Amendment 2 SQL — view creation, kill-switch flip, cutover_completed_at
// stamp, four guardrail percentage upserts, absolute bankroll_floor derivation,
// pre-flip bankroll snapshot, compliance log — all in one transaction. Refuses
// if any operator input is missing or out of range, or if the cutover has
// already been performed.
router.post("/admin/cutover/flip", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      confirm?: boolean;
      real_betfair_balance?: number;
      // All four guardrail params are optional. Operator-supplied values overwrite
      // the existing agent_config rows; omitted values leave the existing rows
      // untouched ("loose" pre-flip values stay in effect — operator decision).
      max_stake_pct?: number;
      bankroll_floor_pct?: number;
      daily_loss_limit_pct?: number;
      weekly_loss_limit_pct?: number;
    };

    if (body.confirm !== true) {
      res.status(400).json({ success: false, message: '{"confirm": true} required to execute the flip.' });
      return;
    }

    const realB = Number(body.real_betfair_balance);
    const fail = (msg: string) => { res.status(400).json({ success: false, message: msg }); };

    if (!Number.isFinite(realB) || realB <= 0) return fail("real_betfair_balance must be a positive finite number.");

    // Validate only the params the operator chose to override.
    const has = <T>(v: T | undefined): v is T => v !== undefined && v !== null;
    const maxStakePct   = has(body.max_stake_pct)         ? Number(body.max_stake_pct)         : null;
    const floorPct      = has(body.bankroll_floor_pct)    ? Number(body.bankroll_floor_pct)    : null;
    const dailyLossPct  = has(body.daily_loss_limit_pct)  ? Number(body.daily_loss_limit_pct)  : null;
    const weeklyLossPct = has(body.weekly_loss_limit_pct) ? Number(body.weekly_loss_limit_pct) : null;

    if (maxStakePct   !== null && (!Number.isFinite(maxStakePct)   || maxStakePct   <= 0 || maxStakePct   > 0.10)) return fail("max_stake_pct must be in (0, 0.10].");
    if (floorPct      !== null && (!Number.isFinite(floorPct)      || floorPct      < 0 || floorPct      > 1))     return fail("bankroll_floor_pct must be in [0, 1].");
    // Loss-limit ceilings allow 1.0 ("essentially disabled") so operator can
    // explicitly opt into wide-open limits when the existing config is loose.
    if (dailyLossPct  !== null && (!Number.isFinite(dailyLossPct)  || dailyLossPct  <= 0 || dailyLossPct  > 1))    return fail("daily_loss_limit_pct must be in (0, 1].");
    if (weeklyLossPct !== null && (!Number.isFinite(weeklyLossPct) || weeklyLossPct <= 0 || weeklyLossPct > 1))    return fail("weekly_loss_limit_pct must be in (0, 1].");

    const existingCutover = await db.execute(sql`SELECT value FROM agent_config WHERE key='cutover_completed_at' LIMIT 1`);
    const cutoverAt = (((existingCutover as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
    if (cutoverAt) {
      res.status(409).json({
        success: false,
        message: `cutover_completed_at already set to ${cutoverAt}. Refusing to re-flip.`,
      });
      return;
    }
    const existingKill = await db.execute(sql`SELECT value FROM agent_config WHERE key='live_placement_enabled' LIMIT 1`);
    const killVal = (((existingKill as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
    if ((killVal ?? "").toLowerCase() === "true") {
      res.status(409).json({
        success: false,
        message: "live_placement_enabled is already 'true'. Refusing to re-flip — re-disable manually first if you really mean it.",
      });
      return;
    }

    const absoluteFloor = floorPct !== null ? Math.round(floorPct * realB * 100) / 100 : null;

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`
        CREATE OR REPLACE VIEW live_bets_current AS
        SELECT * FROM paper_bets
        WHERE bet_track = 'live'
          AND legacy_regime = false
          AND placed_at >= (SELECT (value::timestamptz)
                            FROM agent_config WHERE key = 'cutover_completed_at')
      `);

      await tx.execute(sql`
        INSERT INTO agent_config(key, value, updated_at)
        VALUES ('live_placement_enabled', 'true', NOW())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
      `);
      await tx.execute(sql`
        INSERT INTO agent_config(key, value, updated_at)
        VALUES ('cutover_completed_at', NOW()::text, NOW())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
      `);
      // Optional guardrail upserts — only writes the keys the operator
      // explicitly supplied. Omitted ones leave the existing agent_config row
      // untouched (so "loose" pre-flip values can be preserved by intent).
      if (maxStakePct !== null) {
        await tx.execute(sql`
          INSERT INTO agent_config(key, value, updated_at) VALUES ('max_stake_pct', ${String(maxStakePct)}, NOW())
          ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
        `);
      }
      if (floorPct !== null && absoluteFloor !== null) {
        await tx.execute(sql`
          INSERT INTO agent_config(key, value, updated_at) VALUES
            ('bankroll_floor_pct', ${String(floorPct)}, NOW()),
            ('bankroll_floor',     ${String(absoluteFloor)}, NOW())
          ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
        `);
      }
      if (dailyLossPct !== null) {
        await tx.execute(sql`
          INSERT INTO agent_config(key, value, updated_at) VALUES ('daily_loss_limit_pct', ${String(dailyLossPct)}, NOW())
          ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
        `);
      }
      if (weeklyLossPct !== null) {
        await tx.execute(sql`
          INSERT INTO agent_config(key, value, updated_at) VALUES ('weekly_loss_limit_pct', ${String(weeklyLossPct)}, NOW())
          ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
        `);
      }

      const snap = await tx.execute(sql`
        INSERT INTO bankroll_snapshots (paper_bankroll, real_bankroll, source, notes, taken_at)
        SELECT ac.value::numeric, ${String(realB)}::numeric, 'paper_baseline_pre_flip',
               'Paper-mode compounded final value at cutover. Live mode reads Betfair API only.',
               NOW()
        FROM agent_config ac WHERE ac.key='bankroll'
        RETURNING id, paper_bankroll::float8 AS paper_bankroll, real_bankroll::float8 AS real_bankroll
      `);
      const snapRow = (((snap as any).rows ?? []) as Array<{ id: number; paper_bankroll: number; real_bankroll: number }>)[0];

      const audit = await tx.execute(sql`
        INSERT INTO compliance_logs (action_type, details, timestamp)
        VALUES ('cutover_completed',
          ${JSON.stringify({
            decision_authority: "operator",
            real_betfair_balance: realB,
            absolute_bankroll_floor: absoluteFloor,
            guardrails_supplied: {
              max_stake_pct: maxStakePct,
              bankroll_floor_pct: floorPct,
              daily_loss_limit_pct: dailyLossPct,
              weekly_loss_limit_pct: weeklyLossPct,
            },
            note: "Omitted guardrails left agent_config rows untouched (operator-chosen).",
            paper_baseline_snapshot_id: snapRow?.id ?? null,
            paper_baseline_bankroll: snapRow?.paper_bankroll ?? null,
          })}::jsonb,
          NOW())
        RETURNING id
      `);
      const auditRow = (((audit as any).rows ?? []) as Array<{ id: number }>)[0];

      return {
        snapshot_id: snapRow?.id ?? null,
        paper_baseline_bankroll: snapRow?.paper_bankroll ?? null,
        absolute_bankroll_floor: absoluteFloor,
        compliance_log_id: auditRow?.id ?? null,
      };
    });

    const { invalidateLivePlacementFlagCache } = await import("../services/livePlacementGate");
    invalidateLivePlacementFlagCache();

    res.json({ success: true, message: "Cutover flipped.", result });
  } catch (err) {
    logger.error({ err }, "cutover/flip failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Pre-flip blocker #11: cutover orchestrator endpoint.
// POST /admin/cutover/run with { dryRun: boolean }. Returns the structured
// CutoverReport. Run dryRun=true first; review; then dryRun=false to commit.
router.post("/admin/cutover/run", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { dryRun?: boolean };
    const dryRun = body.dryRun !== false; // default to dry-run for safety
    const { runCutoverConversion } = await import("../services/paperToLiveCutover");
    const report = await runCutoverConversion({ dryRun });
    res.json({ success: true, result: report });
  } catch (err) {
    logger.error({ err }, "cutover/run failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Pre-flip blocker #12: live-health snapshot. Surfaces kill-switch
// state, recent placement errors, drift, paper-emission rate trend, and
// distance to daily-loss cap (volume-shock awareness item).
router.get("/admin/live-health", async (_req, res) => {
  try {
    const { getCachedBalance } = await import("../services/betfairLive");
    const { getLockedReserve } = await import("../services/lockedReserve");

    const cfgRows = await db.execute(sql`
      SELECT key, value, updated_at FROM agent_config
      WHERE key IN ('live_placement_enabled','cutover_completed_at',
                    'auto_disable_reason','last_auto_disable_at',
                    'bankroll_floor','daily_loss_limit_pct','weekly_loss_limit_pct',
                    'max_stake_pct')
      ORDER BY key
    `);
    const cfg = ((cfgRows as any).rows ?? []) as Array<{ key: string; value: string; updated_at: string }>;
    const get = (k: string) => cfg.find((r) => r.key === k)?.value ?? null;

    const cached = getCachedBalance();
    const locked = await getLockedReserve();

    // Recent placement errors (last 24h)
    const errRows = await db.execute(sql`
      SELECT action_type, COUNT(*)::int AS n, MAX(timestamp)::text AS last
      FROM compliance_logs
      WHERE timestamp > NOW() - INTERVAL '24 hours'
        AND action_type IN ('live_bet_placement_failed','live_auto_revert',
                            'paper_to_live_conversion_failed_to_shadow',
                            'betfair_api_error')
      GROUP BY 1 ORDER BY 1
    `);
    const errs = ((errRows as any).rows ?? []) as Array<{ action_type: string; n: number; last: string }>;

    // 7-day paper-emission rate trend (volume-shock awareness)
    const paperTrendRows = await db.execute(sql`
      SELECT DATE_TRUNC('day', placed_at)::text AS day,
             COUNT(*)::int                       AS paper_emitted,
             COUNT(*) FILTER (WHERE bet_track='live')::int AS live_attempted
      FROM paper_bets
      WHERE placed_at > NOW() - INTERVAL '7 days'
        AND legacy_regime=false
        AND bet_track IN ('paper','live')
      GROUP BY 1 ORDER BY 1 DESC
    `);
    const paperTrend = ((paperTrendRows as any).rows ?? []) as Array<{ day: string; paper_emitted: number; live_attempted: number }>;

    // Live performance since cutover (if any)
    const cutoverAt = get("cutover_completed_at");
    let livePerf: any = null;
    if (cutoverAt) {
      const lpRows = await db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('won','lost'))::int AS settled,
               COALESCE(SUM(net_pnl)::float8, 0)                      AS net_pnl,
               COALESCE(SUM(stake)::float8, 0)                        AS stake
        FROM paper_bets
        WHERE bet_track='live' AND legacy_regime=false
          AND placed_at >= ${cutoverAt}::timestamptz
          AND status IN ('won','lost')
      `);
      livePerf = ((lpRows as any).rows ?? [])[0] ?? null;
    }

    // Today's stake exposure vs daily-loss cap implication
    const todayStakeRows = await db.execute(sql`
      SELECT
        COALESCE(SUM(stake)::float8, 0) AS today_stake_total,
        COALESCE(SUM(CASE WHEN status='lost' THEN -COALESCE(net_pnl, settlement_pnl, 0)
                          WHEN status='won'  THEN  COALESCE(net_pnl, settlement_pnl, 0)
                          ELSE 0 END)::float8, 0) AS today_realised_pnl
      FROM paper_bets
      WHERE bet_track='live' AND legacy_regime=false
        AND placed_at >= DATE_TRUNC('day', NOW())
    `);
    const todayRow = ((todayStakeRows as any).rows ?? [])[0] ?? { today_stake_total: 0, today_realised_pnl: 0 };

    const dailyLossLimitPct = Number(get("daily_loss_limit_pct") ?? 0);
    const dailyLossCapAbs = cached && dailyLossLimitPct > 0
      ? Math.round(cached.available * dailyLossLimitPct * 100) / 100
      : null;
    const distanceToDailyCap = dailyLossCapAbs != null
      ? Math.max(0, Math.round((dailyLossCapAbs + Number(todayRow.today_realised_pnl)) * 100) / 100)
      : null;

    // 2026-05-10: surface auto-revert Trigger C drift so thresholds can
    // be tuned against actual data, not guesses. Same computation
    // liveAutoRevert.runLiveAutoRevert() uses — exported as evalTriggerC.
    const { evalTriggerC } = await import("../services/liveAutoRevert");
    const drift = await evalTriggerC();

    res.json({
      success: true,
      result: {
        kill_switch: {
          live_placement_enabled: get("live_placement_enabled") === "true",
          last_updated:           cfg.find((r) => r.key === "live_placement_enabled")?.updated_at ?? null,
          auto_disable_reason:    get("auto_disable_reason"),
          last_auto_disable_at:   get("last_auto_disable_at"),
        },
        cutover_completed_at: cutoverAt,
        bankroll: {
          betfair_available_cached: cached?.available ?? null,
          locked_reserve:           locked,
          active_estimate:          cached ? Math.max(0, cached.available - locked) : null,
        },
        guardrails: {
          max_stake_pct:         Number(get("max_stake_pct")        ?? 0),
          bankroll_floor:        Number(get("bankroll_floor")        ?? 0),
          daily_loss_limit_pct:  dailyLossLimitPct,
          weekly_loss_limit_pct: Number(get("weekly_loss_limit_pct") ?? 0),
        },
        drift_24h: {
          local_pnl:           Math.round(drift.localPnl * 100) / 100,
          betfair_pnl:         Math.round(drift.betfairPnl * 100) / 100,
          abs_drift_gbp:       Math.round(drift.absDrift * 100) / 100,
          rel_drift_pct:       drift.pctDrift != null ? Math.round(drift.pctDrift * 10000) / 100 : null,
          abs_threshold_gbp:   drift.absThreshold,
          rel_threshold_pct:   Math.round(drift.relThreshold * 10000) / 100,
          would_fire:          drift.fire,
          condition:           "AND (both abs and rel must exceed threshold)",
        },
        recent_24h_errors: errs,
        paper_emission_7d_trend: paperTrend,
        today_volume: {
          stake_total:        Number(todayRow.today_stake_total),
          realised_pnl:       Number(todayRow.today_realised_pnl),
          daily_loss_cap_abs: dailyLossCapAbs,
          distance_to_cap:    distanceToDailyCap,
        },
        live_perf_since_cutover: livePerf,
      },
    });
  } catch (err) {
    logger.error({ err }, "live-health failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Pre-flip blocker #12: operator-only re-enable after auto-revert.
// Requires --confirm-reason. Writes compliance_logs row tagged
// 'live_manual_resume' with the operator-supplied reason.
router.post("/admin/live-resume", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { confirm_reason?: string };
    const reason = (body.confirm_reason ?? "").trim();
    if (!reason || reason.length < 10) {
      res.status(400).json({
        success: false,
        message: "confirm_reason is required and must describe why re-enabling is safe (>=10 chars).",
      });
      return;
    }
    await db.execute(sql`
      INSERT INTO agent_config(key, value, updated_at)
      VALUES ('live_placement_enabled', 'true', NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `);
    await db.execute(sql`
      INSERT INTO agent_config(key, value, updated_at)
      VALUES ('auto_disable_reason', '', NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `);
    await db.execute(sql`
      INSERT INTO compliance_logs (action_type, details, timestamp)
      VALUES ('live_manual_resume', ${JSON.stringify({ reason })}::jsonb, NOW())
    `);
    const { invalidateLivePlacementFlagCache } = await import("../services/livePlacementGate");
    invalidateLivePlacementFlagCache();
    res.json({ success: true, message: "live_placement_enabled set to true.", reason });
  } catch (err) {
    logger.error({ err }, "live-resume failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Phase 3 B9 (2026-05-08): manual trigger for gateMonitor. Cron runs
// daily 04:00 UTC; this lets us produce a gate_status row immediately
// after deploy for blocker validation. Pre-evaluation_start_at this
// returns a heartbeat-only result.
router.post("/admin/run-gate-monitor", async (_req, res) => {
  try {
    const { runGateMonitor } = await import("../services/gateMonitor");
    const r = await runGateMonitor();
    res.json({ success: true, result: r });
  } catch (err) {
    logger.error({ err }, "Manual gateMonitor trigger failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Phase 3 B1 (2026-05-08): one-shot manual trigger to (re-)run
// betfair_market_id capture for pending paper bets in the next 48h
// where the column is null. The placement-time capture path now
// persists marketId on every new bet; this endpoint heals any
// already-pending rows that were placed before the fix.
router.post("/admin/phase3-b1-backfill-market-ids", async (_req, res) => {
  try {
    const { db, paperBetsTable } = await import("@workspace/db");
    const { sql, eq } = await import("drizzle-orm");
    const { listMarketCatalogue } = await import("../services/betfair");

    // Find pending bets in next 48h with null betfair_market_id and a
    // resolvable betfair_event_id on the match.
    const candidates = await db.execute(sql`
      SELECT pb.id, pb.market_type, m.betfair_event_id
      FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
      WHERE pb.status IN ('pending','pending_placement')
        AND pb.legacy_regime = false AND pb.deleted_at IS NULL
        AND pb.betfair_market_id IS NULL
        AND m.betfair_event_id IS NOT NULL
        AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
    `);
    const rows = (((candidates as any).rows ?? []) as Array<{
      id: number; market_type: string; betfair_event_id: string;
    }>);

    let updated = 0;
    let no_market = 0;
    let api_failed = 0;
    const eventToCatalogue = new Map<string, Array<{ marketId: string; description?: { marketType?: string } }>>();
    for (const r of rows) {
      if (!/^\d+$/.test(r.betfair_event_id)) continue;
      let cat = eventToCatalogue.get(r.betfair_event_id);
      if (!cat) {
        try {
          cat = (await listMarketCatalogue([r.betfair_event_id])) as typeof cat;
        } catch {
          api_failed++;
          continue;
        }
        eventToCatalogue.set(r.betfair_event_id, cat ?? []);
      }
      const market = (cat ?? []).find((m) => m?.description?.marketType === r.market_type);
      if (!market) {
        no_market++;
        continue;
      }
      await db.update(paperBetsTable).set({
        betfairMarketId: market.marketId,
      }).where(eq(paperBetsTable.id, r.id));
      updated++;
    }

    res.json({ success: true, result: { candidates: rows.length, updated, no_market, api_failed } });
  } catch (err) {
    logger.error({ err }, "Phase 3 B1 backfill failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Sub-phase 4.B (2026-05-08): manual trigger for Betfair market-type discovery.
router.post("/admin/run-betfair-market-discovery", async (_req, res) => {
  try {
    const { runBetfairMarketDiscovery } = await import("../services/betfairMarketDiscovery");
    const result = await runBetfairMarketDiscovery();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual Betfair market discovery failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Y3 (2026-05-07): manual trigger for WC participant coverage audit.
router.post("/leagues/wc-audit/run", async (_req, res) => {
  try {
    const { auditWorldCupParticipantCoverage } = await import("../services/betfairFirstUniverse");
    const result = await auditWorldCupParticipantCoverage();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual WC audit failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Z4 (2026-05-07): manual trigger for autonomous tier-ladder.
// Computes per-scope Kelly-growth-rate proxy and promotes/demotes
// universe_tier autonomously. Full audit log written per transition.
router.post("/admin/run-tier-ladder", async (_req, res) => {
  try {
    const { runAutonomousTierLadder } = await import("../services/autonomousTierLadder");
    const result = await runAutonomousTierLadder();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual tier-ladder run failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Z3 (2026-05-07): manual trigger for autonomous threshold revision.
router.post("/admin/run-threshold-revision", async (_req, res) => {
  try {
    const { runThresholdRevisionProposer } = await import("../services/autonomousThresholdRevision");
    const result = await runThresholdRevisionProposer();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual threshold revision failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Z6 (2026-05-07): manual trigger for feature predictive-power scoring.
router.post("/admin/run-feature-scoring", async (_req, res) => {
  try {
    const { runFeaturePredictivePowerScoring } = await import("../services/featurePredictivePower");
    const result = await runFeaturePredictivePowerScoring();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual feature predictive-power scoring failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// ─────────────────────────────────────────────
// Experiment Pipeline API
// ─────────────────────────────────────────────

import { getExperimentsSummary, getExperimentDetail, getPromotionLog, getLatestLearningJournal, manualPromote, runPromotionEngine, backfillExperimentTags, runCounterfactualReplay, runProposalGenerator, listPendingThresholdRevisions, reviewPendingThresholdRevision, runKellyOptimizerForTag, runKellyOptimizerForAllTags, type PendingRevisionStatusFilter } from "../services/promotionEngine";
import { runOngoingAudit } from "../services/auditCron";
import { runClvTimeBucketRetrospective } from "../services/oddsPapiRetrospective";
import { syncDevToProd, getSyncStatus } from "../services/syncDevToProd";

// Wave 1 (Phase 2 closeout): shadow-bet firehose monitor.
// Three views in one response so "trickle vs firehose" is measurable without
// raw SQL access:
//   1. Daily shadow-vs-real bet counts per universe tier, last 14 days
//   2. Last 24h compliance_logs rejections grouped by reason (catches gates
//      that ARE rejecting shadow candidates — should trend toward zero
//      after Wave 1 deploy except for legitimate non-shadow rejections)
//   3. Last 24h shadow_bet_gate_exempted audit rows by gate (proves the
//      exemption helper is firing correctly)
router.get("/admin/shadow-bet-volume", async (_req, res) => {
  try {
    const dailyByTier = await db.execute(sql`
      SELECT
        DATE(placed_at AT TIME ZONE 'UTC') AS day,
        COALESCE(universe_tier_at_placement, 'null') AS tier,
        COUNT(*) FILTER (WHERE shadow_stake > 0) AS shadow,
        COUNT(*) FILTER (WHERE shadow_stake IS NULL OR shadow_stake = 0) AS real,
        ROUND(AVG(shadow_stake)::numeric FILTER (WHERE shadow_stake > 0), 4) AS avg_shadow_kelly_units
      FROM paper_bets
      WHERE placed_at > NOW() - INTERVAL '14 days' AND deleted_at IS NULL
      GROUP BY 1, 2
      ORDER BY 1 DESC, 2
    `);

    const rejectionReasons = await db.execute(sql`
      SELECT
        details->>'reason' AS reason,
        COUNT(*) AS count
      FROM compliance_logs
      WHERE action_type = 'bet_rejected'
        AND timestamp > NOW() - INTERVAL '24 hours'
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 20
    `);

    const exemptionsByGate = await db.execute(sql`
      SELECT
        SPLIT_PART(subject, ':', 2) AS gate,
        COUNT(*) AS bucket_rows,
        COALESCE(SUM((supporting_metrics->>'exemptionsInBucket')::int), 0) AS total_exemptions
      FROM model_decision_audit_log
      WHERE decision_type = 'shadow_bet_gate_exempted'
        AND decision_at > NOW() - INTERVAL '24 hours'
      GROUP BY 1
      ORDER BY 3 DESC
    `);

    res.json({
      success: true,
      windowDays: 14,
      dailyByTier: (dailyByTier as any).rows ?? [],
      last24hRejections: (rejectionReasons as any).rows ?? [],
      last24hExemptionsByGate: (exemptionsByGate as any).rows ?? [],
    });
  } catch (err) {
    logger.error({ err }, "Failed to compute shadow-bet-volume diagnostic");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Wave 7.1+ (2026-05-07): model self-audit + autonomous pause registry.
// View active pauses, recent audit observations, manually trigger a run.

router.get("/admin/autonomous-pauses", async (_req, res) => {
  try {
    const active = await db.execute(sql`
      SELECT id, scope_type, scope_value, paused_at::text AS paused_at,
             paused_until::text AS paused_until, reason, metric_type,
             metric_value::text, threshold_value::text, sample_size,
             kelly_fraction_override::text, escalation_level, audit_log_id
      FROM autonomous_pauses
      WHERE resumed_at IS NULL
      ORDER BY paused_at DESC LIMIT 200
    `);
    const recentResumed = await db.execute(sql`
      SELECT id, scope_type, scope_value, paused_at::text AS paused_at,
             paused_until::text AS paused_until, resumed_at::text AS resumed_at,
             reason, kelly_fraction_override::text, escalation_level
      FROM autonomous_pauses
      WHERE resumed_at IS NOT NULL
        AND resumed_at > NOW() - INTERVAL '30 days'
      ORDER BY resumed_at DESC LIMIT 50
    `);
    res.json({
      success: true,
      active: (active as any).rows ?? [],
      recently_resumed: (recentResumed as any).rows ?? [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/run-self-audit", async (_req, res) => {
  try {
    const { runModelSelfAudit } = await import("../services/modelSelfAudit");
    const result = await runModelSelfAudit();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual self-audit trigger failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/autonomous-pauses/:id/resume", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ success: false, message: "Invalid id" });
      return;
    }
    const updated = await db.execute(sql`
      UPDATE autonomous_pauses
      SET resumed_at = NOW(), manual_override = TRUE,
          notes = COALESCE(notes || ' | ', '') || 'manually resumed via admin endpoint'
      WHERE id = ${id} AND resumed_at IS NULL
      RETURNING id, scope_type, scope_value, reason
    `);
    const row = ((updated as any).rows ?? [])[0];
    if (!row) {
      res.status(404).json({ success: false, message: "Active pause not found" });
      return;
    }
    res.json({ success: true, resumed: row });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

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
    return res.json({ success: true, internalBetId, betfair: b, cancelResult: result });
  } catch (err) {
    return res.status(500).json({ success: false, message: String(err) });
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
    return res.json({ success: true, key, value: verify });
  } catch (err) {
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// TEMPORARY route — Apr 19 2026 cleanup. Settlement remediation pass.
// Two operations, both auditable:
//   (A) Re-settle the 14 rows where status='void' AND betfair_status='won'.
//       These are bets the agent voided internally (FIRST_HALF_RESULT
//       always-null in determineBetWon, OR stale matchedSize race) but
//       Betfair actually paid out. We pull the real SETTLED data, rewrite
//       status + settlement_pnl + betfair_pnl, and apply the cumulative
//       PnL delta to the bankroll in one transaction with a paired
//       compliance_logs entry per bet plus a bankroll-update entry.
//   (B) Backfill betfair_pnl for the 131 legacy rows where the value is
//       literally 'NaN'. Mirror-field-only — does NOT change status,
//       settlement_pnl, or bankroll (those were already settled internally
//       under the old paper logic). Pure data-correctness fix.
router.post("/admin/remediate-settlement-errors", async (_req, res) => {
  try {
    const { listClearedOrders } = await import("../services/betfairLive");
    const { paperBetsTable, complianceLogsTable, db } = await import("@workspace/db");
    const { sql, eq } = await import("drizzle-orm");
    const { applyBatchPnl } = await import("../services/paperTrading");

    // ─── (A) Mismatch repair ─────────────────────────────────────
    const mismatchRows = (
      await db.execute(sql`
        SELECT id, betfair_bet_id, stake::text AS stake, settlement_pnl::text AS settlement_pnl, status
        FROM paper_bets
        WHERE status='void' AND betfair_status='won' AND betfair_bet_id IS NOT NULL AND legacy_regime = false
      `)
    ).rows as Array<{
      id: number;
      betfair_bet_id: string;
      stake: string;
      settlement_pnl: string | null;
      status: string;
    }>;

    let mismatchSettled: ClearedOrder[] = [];
    if (mismatchRows.length > 0) {
      const mismatchBetIds = mismatchRows.map((r) => r.betfair_bet_id);
      // Wide window — these go back to Apr 17.
      mismatchSettled = await listClearedOrders(
        { from: "2026-04-15T00:00:00Z", to: new Date().toISOString() },
        mismatchBetIds,
        "SETTLED",
      );
    }
    const mismatchByBetId = new Map(mismatchSettled.map((o) => [o.betId, o]));

    let cumulativePnlDelta = 0;
    const mismatchResults: Array<Record<string, unknown>> = [];
    for (const row of mismatchRows) {
      const cleared = mismatchByBetId.get(row.betfair_bet_id);
      if (!cleared) {
        mismatchResults.push({
          paperBetId: row.id,
          status: "skipped_no_settled_data",
          betfairBetId: row.betfair_bet_id,
        });
        continue;
      }
      const profit = Number(cleared.profit ?? 0);
      const commission = Number(cleared.commission ?? 0);
      if (!Number.isFinite(profit) || !Number.isFinite(commission)) {
        mismatchResults.push({
          paperBetId: row.id,
          status: "skipped_non_finite_pnl",
          rawProfit: cleared.profit,
          rawCommission: cleared.commission,
        });
        continue;
      }
      const netPnl = profit - commission;
      const previousSettlementPnl = Number(row.settlement_pnl ?? 0);
      const delta = netPnl - previousSettlementPnl;
      const newStatus = cleared.betOutcome === "WON" ? "won" : cleared.betOutcome === "LOST" ? "lost" : "void";

      await db.execute(sql`
        UPDATE paper_bets
        SET status = ${newStatus},
            settlement_pnl = ${netPnl.toFixed(2)},
            betfair_pnl = ${netPnl.toFixed(2)},
            betfair_status = ${cleared.betOutcome === "WON" ? "won" : cleared.betOutcome === "LOST" ? "lost" : "void"},
            betfair_settled_at = ${new Date(cleared.settledDate).toISOString()},
            settled_at = COALESCE(settled_at, ${new Date().toISOString()})
        WHERE id = ${row.id}
      `);

      cumulativePnlDelta += delta;

      await db.insert(complianceLogsTable).values({
        actionType: "settlement_mismatch_repaired",
        details: {
          paperBetId: row.id,
          betfairBetId: row.betfair_bet_id,
          previousInternalStatus: row.status,
          newInternalStatus: newStatus,
          previousSettlementPnl,
          newSettlementPnl: netPnl,
          bankrollDeltaApplied: delta,
          betfairProfit: profit,
          betfairCommission: commission,
          betOutcome: cleared.betOutcome,
          settledDate: cleared.settledDate,
          rootCause:
            "Internal settleBets voided due to FIRST_HALF_RESULT always-null OR stale matchedSize=0 race. settleBets now defers all matched real-money bets to reconcileSettlements.",
        },
        timestamp: new Date(),
      });

      mismatchResults.push({
        paperBetId: row.id,
        status: "repaired",
        previousStatus: row.status,
        newStatus,
        previousSettlementPnl,
        newSettlementPnl: netPnl,
        bankrollDelta: delta,
      });
    }

    let bankrollBefore: number | null = null;
    let bankrollAfter: number | null = null;
    if (Math.abs(cumulativePnlDelta) > 0.01) {
      const result = await applyBatchPnl(cumulativePnlDelta, "settlement_mismatch_remediation", {
        rowsRepaired: mismatchResults.filter((r) => r.status === "repaired").length,
      });
      bankrollBefore = result.before;
      bankrollAfter = result.after;
    }

    // ─── (B) NaN backfill ─────────────────────────────────────────
    const nanRows = (
      await db.execute(sql`
        SELECT id, betfair_bet_id
        FROM paper_bets
        WHERE betfair_pnl::text = 'NaN' AND betfair_bet_id IS NOT NULL
      `)
    ).rows as Array<{ id: number; betfair_bet_id: string }>;

    let nanRepaired = 0;
    let nanNoData = 0;
    if (nanRows.length > 0) {
      const nanBetIds = nanRows.map((r) => r.betfair_bet_id);
      // Chunk into batches of 100 to keep payload sizes reasonable.
      const chunkSize = 100;
      const nanByBetId = new Map<string, ClearedOrder>();
      for (let i = 0; i < nanBetIds.length; i += chunkSize) {
        const chunk = nanBetIds.slice(i, i + chunkSize);
        const cleared = await listClearedOrders(
          { from: "2026-04-15T00:00:00Z", to: new Date().toISOString() },
          chunk,
          "SETTLED",
        );
        for (const o of cleared) nanByBetId.set(o.betId, o);
      }
      for (const row of nanRows) {
        const cleared = nanByBetId.get(row.betfair_bet_id);
        if (!cleared) {
          nanNoData++;
          continue;
        }
        const profit = Number(cleared.profit ?? 0);
        const commission = Number(cleared.commission ?? 0);
        if (!Number.isFinite(profit) || !Number.isFinite(commission)) {
          nanNoData++;
          continue;
        }
        const netPnl = profit - commission;
        await db.execute(sql`
          UPDATE paper_bets
          SET betfair_pnl = ${netPnl.toFixed(2)}
          WHERE id = ${row.id}
        `);
        nanRepaired++;
      }
      await db.insert(complianceLogsTable).values({
        actionType: "betfair_pnl_nan_backfill",
        details: {
          executedAt: new Date().toISOString(),
          totalNanRows: nanRows.length,
          rowsRepaired: nanRepaired,
          rowsNoData: nanNoData,
          purpose:
            "One-shot backfill of legacy NaN betfair_pnl values written before the Number(x ?? 0) defensive coercion fix.",
        },
        timestamp: new Date(),
      });
    }

    // ─── (C) Backfill gross_pnl / commission_amount / commission_rate / net_pnl
    // Targets any settled real-money won/lost row where settlement_pnl is set
    // but the breakdown columns weren't populated (the original bug in (A)
    // of this route, plus any other historical writer that only set
    // settlement_pnl). Re-fetches authoritative profit/commission from Betfair
    // and rewrites all four breakdown columns so the dashboard's commission
    // tracking card reconciles with the headline ROI/bankroll figures.
    const breakdownRows = (
      await db.execute(sql`
        SELECT id, betfair_bet_id, settlement_pnl::text AS settlement_pnl
        FROM paper_bets
        WHERE status IN ('won','lost')
          AND betfair_bet_id IS NOT NULL
          AND deleted_at IS NULL
          AND ABS(COALESCE(settlement_pnl::numeric, 0) - COALESCE(net_pnl::numeric, 0)) > 0.02
      `)
    ).rows as Array<{ id: number; betfair_bet_id: string; settlement_pnl: string }>;

    let breakdownRepaired = 0;
    let breakdownNoData = 0;
    if (breakdownRows.length > 0) {
      const betIds = breakdownRows.map((r) => r.betfair_bet_id);
      const chunkSize = 100;
      const byBetId = new Map<string, ClearedOrder>();
      for (let i = 0; i < betIds.length; i += chunkSize) {
        const chunk = betIds.slice(i, i + chunkSize);
        const cleared = await listClearedOrders(
          { from: "2026-04-15T00:00:00Z", to: new Date().toISOString() },
          chunk,
          "SETTLED",
        );
        for (const o of cleared) byBetId.set(o.betId, o);
      }
      for (const row of breakdownRows) {
        const cleared = byBetId.get(row.betfair_bet_id);
        if (!cleared) {
          breakdownNoData++;
          continue;
        }
        const profit = Number(cleared.profit ?? 0);
        const commission = Number(cleared.commission ?? 0);
        if (!Number.isFinite(profit) || !Number.isFinite(commission)) {
          breakdownNoData++;
          continue;
        }
        const grossPnl = profit;
        const commissionAmount = commission;
        const netPnl = profit - commission;
        const commissionRate = profit > 0 ? Math.round((commission / profit) * 10000) / 10000 : 0;

        await db.execute(sql`
          UPDATE paper_bets
          SET gross_pnl = ${grossPnl.toFixed(2)},
              commission_amount = ${commissionAmount.toFixed(2)},
              commission_rate = ${commissionRate.toString()},
              net_pnl = ${netPnl.toFixed(2)},
              settlement_pnl = ${netPnl.toFixed(2)},
              betfair_pnl = ${netPnl.toFixed(2)}
          WHERE id = ${row.id}
        `);
        breakdownRepaired++;
      }
      await db.insert(complianceLogsTable).values({
        actionType: "pnl_breakdown_backfill",
        details: {
          executedAt: new Date().toISOString(),
          candidates: breakdownRows.length,
          repaired: breakdownRepaired,
          noData: breakdownNoData,
          purpose:
            "Backfill gross_pnl/commission_amount/commission_rate/net_pnl for rows where settlement_pnl != net_pnl. Caused by remediation route (A) only writing settlement_pnl+betfair_pnl. Reconciles dashboard commission card with headline ROI.",
        },
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      mismatchRepair: {
        candidates: mismatchRows.length,
        repaired: mismatchResults.filter((r) => r.status === "repaired").length,
        skipped: mismatchResults.filter((r) => r.status !== "repaired").length,
        cumulativePnlDelta: Math.round(cumulativePnlDelta * 100) / 100,
        bankrollBefore,
        bankrollAfter,
        rows: mismatchResults,
      },
      nanBackfill: {
        candidates: nanRows.length,
        repaired: nanRepaired,
        noData: nanNoData,
      },
      breakdownBackfill: {
        candidates: breakdownRows.length,
        repaired: breakdownRepaired,
        noData: breakdownNoData,
      },
    });
  } catch (err) {
    logger.error({ err }, "Settlement remediation failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/reconcile-settlements", async (_req, res) => {
  try {
    const { reconcileSettlements } = await import("../services/betfairLive");
    const result = await reconcileSettlements();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "reconcileSettlements failed");
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

// TEMPORARY route — Apr 19 2026 cleanup of stale pre-cutoff pending bets.
// Read-only ground-truth check against Betfair listCurrentOrders. Writes the
// full classified response to compliance_logs as an audit trail before any
// cancellation/void action is taken. Remove after the cleanup is complete.
router.get("/admin/betfair-ground-truth", async (_req, res) => {
  try {
    const { listCurrentOrders } = await import("../services/betfairLive");
    const { paperBetsTable, complianceLogsTable, db } = await import("@workspace/db");
    const { sql, and, eq, isNotNull } = await import("drizzle-orm");

    const candidates = await db
      .select({
        id: paperBetsTable.id,
        matchId: paperBetsTable.matchId,
        marketType: paperBetsTable.marketType,
        selectionName: paperBetsTable.selectionName,
        stake: paperBetsTable.stake,
        betfairBetId: paperBetsTable.betfairBetId,
        betfairMarketId: paperBetsTable.betfairMarketId,
        betfairStatus: paperBetsTable.betfairStatus,
        betfairSizeMatched: paperBetsTable.betfairSizeMatched,
        placedAt: paperBetsTable.placedAt,
      })
      .from(paperBetsTable)
      .where(
        and(
          eq(paperBetsTable.status, "pending"),
          sql`deleted_at IS NULL`,
          sql`placed_at < '2026-04-19T20:00:00Z'`,
          isNotNull(paperBetsTable.betfairBetId),
          sql`betfair_status IN ('EXECUTABLE','EXECUTION_COMPLETE')`,
        ),
      );

    const betIds = candidates
      .map((c) => c.betfairBetId)
      .filter((x): x is string => Boolean(x));
    const live = await listCurrentOrders(betIds);
    const liveByBetId = new Map(live.map((o) => [o.betId, o]));

    const reconciled = candidates.map((c) => {
      const bf = c.betfairBetId ? liveByBetId.get(c.betfairBetId) : undefined;
      const classification = !bf
        ? "stale_in_db__not_on_betfair"
        : bf.status === "EXECUTABLE" && (bf.sizeRemaining ?? 0) > 0
          ? "still_live__needs_cancellation"
          : bf.status === "EXECUTION_COMPLETE"
            ? "fully_matched__awaiting_settlement"
            : `other:${bf.status}`;
      return {
        paperBetId: c.id,
        matchId: c.matchId,
        marketType: c.marketType,
        selectionName: c.selectionName,
        stake: Number(c.stake),
        betfairBetId: c.betfairBetId,
        betfairMarketId: c.betfairMarketId,
        ourDbStatus: c.betfairStatus,
        ourDbSizeMatched: Number(c.betfairSizeMatched ?? 0),
        placedAt: c.placedAt,
        betfairLiveStatus: bf?.status ?? null,
        betfairLiveSizeMatched: bf?.sizeMatched ?? null,
        betfairLiveSizeRemaining: bf?.sizeRemaining ?? null,
        betfairLiveSizeCancelled: bf?.sizeCancelled ?? null,
        betfairLivePrice: bf?.priceSize?.price ?? null,
        betfairLiveSize: bf?.priceSize?.size ?? null,
        classification,
      };
    });

    const summary = reconciled.reduce<Record<string, number>>((acc, r) => {
      acc[r.classification] = (acc[r.classification] ?? 0) + 1;
      return acc;
    }, {});

    await db.insert(complianceLogsTable).values({
      actionType: "betfair_ground_truth_audit",
      details: {
        queriedAt: new Date().toISOString(),
        candidatesQueriedFromDb: candidates.length,
        betfairReturnedLive: live.length,
        classificationSummary: summary,
        reconciledRows: reconciled,
        purpose:
          "Pre-cancellation ground-truth check before cleanup of pre-cutoff stale pending bets (dup-bug remediation 2026-04-19)",
      },
      timestamp: new Date(),
    });

    logger.warn(
      { candidatesQueried: candidates.length, betfairLive: live.length, summary },
      "Betfair ground-truth audit complete",
    );

    res.json({
      success: true,
      candidatesQueried: candidates.length,
      betfairReturnedLive: live.length,
      classificationSummary: summary,
      detail: reconciled,
    });
  } catch (err) {
    logger.error({ err }, "Betfair ground-truth check failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// TEMPORARY route — Apr 19 2026 cleanup. Investigation step (C):
// For the 7 betIds that our DB says are EXECUTABLE/EXECUTION_COMPLETE but
// listCurrentOrders did not return, query listClearedOrders to find out
// where they actually went (settled, lapsed, voided on the exchange, etc).
// Read-only against Betfair; one compliance_logs row written.
router.get("/admin/betfair-cleared-orders-check", async (_req, res) => {
  try {
    const { listClearedOrders } = await import("../services/betfairLive");
    const { complianceLogsTable, db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");

    const stale = await db.execute(sql`
      SELECT row->>'betfairBetId' AS betfair_bet_id,
             (row->>'paperBetId')::int AS paper_bet_id,
             row->>'placedAt' AS placed_at
      FROM compliance_logs cl,
           jsonb_array_elements(cl.details->'reconciledRows') AS row
      WHERE cl.action_type = 'betfair_ground_truth_audit'
        AND cl.id = (SELECT max(id) FROM compliance_logs WHERE action_type='betfair_ground_truth_audit')
        AND row->>'classification' = 'stale_in_db__not_on_betfair'
    `);
    const staleRows = stale.rows as Array<{
      betfair_bet_id: string;
      paper_bet_id: number;
      placed_at: string;
    }>;
    const betIds = staleRows.map((r) => r.betfair_bet_id);
    if (betIds.length === 0) {
      res.json({ success: true, message: "No stale rows in latest audit" });
      return;
    }

    const earliest = staleRows.reduce(
      (acc, r) => (r.placed_at < acc ? r.placed_at : acc),
      staleRows[0]!.placed_at,
    );
    const fromDate = new Date(new Date(earliest).getTime() - 60 * 60 * 1000)
      .toISOString();
    const dateRange = { from: fromDate, to: new Date().toISOString() };
    const statuses: Array<"SETTLED" | "VOIDED" | "LAPSED" | "CANCELLED"> = [
      "SETTLED",
      "VOIDED",
      "LAPSED",
      "CANCELLED",
    ];
    const allByBetId = new Map<
      string,
      { status: string; order: import("../services/betfairLive").ClearedOrder }
    >();
    const perStatusCounts: Record<string, number> = {};
    for (const status of statuses) {
      const cleared = await listClearedOrders(dateRange, betIds, status);
      perStatusCounts[status] = cleared.length;
      for (const o of cleared) {
        if (!allByBetId.has(o.betId)) allByBetId.set(o.betId, { status, order: o });
      }
    }

    const reconciled = staleRows.map((r) => {
      const hit = allByBetId.get(r.betfair_bet_id);
      return {
        paperBetId: r.paper_bet_id,
        betfairBetId: r.betfair_bet_id,
        placedAt: r.placed_at,
        foundInBetStatus: hit?.status ?? null,
        betOutcome: hit?.order.betOutcome ?? null,
        sizeSettled: hit?.order.sizeSettled ?? null,
        sizeCancelled: hit?.order.sizeCancelled ?? null,
        priceMatched: hit?.order.priceMatched ?? null,
        profit: hit?.order.profit ?? null,
        commission: hit?.order.commission ?? null,
        settledDate: hit?.order.settledDate ?? null,
        side: hit?.order.side ?? null,
      };
    });

    await db.insert(complianceLogsTable).values({
      actionType: "betfair_cleared_orders_investigation",
      details: {
        queriedAt: new Date().toISOString(),
        purpose:
          "Phase C: locate the 7 stale rows in cleared-orders to understand why listCurrentOrders did not return them",
        betIdsQueried: betIds,
        perStatusCounts,
        totalMatched: allByBetId.size,
        reconciledRows: reconciled,
      },
      timestamp: new Date(),
    });

    res.json({
      success: true,
      betIdsQueried: betIds.length,
      perStatusCounts,
      totalMatched: allByBetId.size,
      detail: reconciled,
    });
  } catch (err) {
    logger.error({ err }, "Betfair cleared-orders investigation failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// TEMPORARY route — Apr 19 2026 cleanup. Action step (A):
// Cancel the orders classified as `still_live__needs_cancellation` in the
// most recent betfair_ground_truth_audit. Groups by betfairMarketId, calls
// cancelOrders per market, and writes the full per-instruction response to
// compliance_logs. Does NOT modify paper_bets rows — reconcileSettlements
// will pick them up via Betfair's cleared-orders endpoint.
router.post("/admin/cancel-orphan-orders", async (_req, res) => {
  try {
    const { cancelOrders } = await import("../services/betfairLive");
    const { complianceLogsTable, db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");

    const stale = await db.execute(sql`
      SELECT row->>'betfairBetId' AS betfair_bet_id,
             row->>'betfairMarketId' AS betfair_market_id,
             (row->>'paperBetId')::int AS paper_bet_id,
             (row->>'stake')::numeric AS stake
      FROM compliance_logs cl,
           jsonb_array_elements(cl.details->'reconciledRows') AS row
      WHERE cl.action_type = 'betfair_ground_truth_audit'
        AND cl.id = (SELECT max(id) FROM compliance_logs WHERE action_type='betfair_ground_truth_audit')
        AND row->>'classification' = 'still_live__needs_cancellation'
    `);
    const targets = stale.rows as Array<{
      betfair_bet_id: string;
      betfair_market_id: string;
      paper_bet_id: number;
      stake: string;
    }>;
    if (targets.length === 0) {
      res.json({ success: true, message: "Nothing to cancel" });
      return;
    }

    const byMarket = new Map<string, typeof targets>();
    for (const t of targets) {
      const arr = byMarket.get(t.betfair_market_id) ?? [];
      arr.push(t);
      byMarket.set(t.betfair_market_id, arr);
    }

    const perMarketResults: Array<{
      marketId: string;
      betIds: string[];
      paperBetIds: number[];
      response?: unknown;
      error?: string;
    }> = [];

    for (const [marketId, group] of byMarket.entries()) {
      const instructions = group.map((g) => ({ betId: g.betfair_bet_id }));
      try {
        const response = await cancelOrders(marketId, instructions);
        perMarketResults.push({
          marketId,
          betIds: group.map((g) => g.betfair_bet_id),
          paperBetIds: group.map((g) => g.paper_bet_id),
          response,
        });
      } catch (err) {
        perMarketResults.push({
          marketId,
          betIds: group.map((g) => g.betfair_bet_id),
          paperBetIds: group.map((g) => g.paper_bet_id),
          error: String(err),
        });
      }
    }

    await db.insert(complianceLogsTable).values({
      actionType: "betfair_orphan_cancellation",
      details: {
        executedAt: new Date().toISOString(),
        purpose:
          "Phase A: cancel pre-cutoff EXECUTABLE orders confirmed live on Betfair via ground-truth audit",
        marketsAttempted: byMarket.size,
        ordersAttempted: targets.length,
        perMarketResults,
      },
      timestamp: new Date(),
    });

    logger.warn(
      { marketsAttempted: byMarket.size, ordersAttempted: targets.length },
      "Orphan order cancellation batch complete",
    );

    res.json({
      success: true,
      marketsAttempted: byMarket.size,
      ordersAttempted: targets.length,
      perMarketResults,
    });
  } catch (err) {
    logger.error({ err }, "Orphan order cancellation failed");
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
      pool.query(`SELECT COUNT(*)::int as total_settled, COUNT(*) FILTER (WHERE status='won')::int as wins, COUNT(*) FILTER (WHERE status='lost')::int as losses FROM paper_bets_current WHERE status IN ('won','lost')`),
      pool.query(`SELECT COUNT(*)::int as cnt FROM experiment_registry WHERE data_tier='promoted'`),
      pool.query(`SELECT AVG(clv_pct::numeric)::float as avg_clv FROM paper_bets_current WHERE clv_pct IS NOT NULL AND status IN ('won','lost')`),
      pool.query(`SELECT COUNT(*)::float / GREATEST(1, EXTRACT(EPOCH FROM (MAX(placed_at)-MIN(placed_at))) / 86400) as bets_per_day FROM paper_bets_current WHERE placed_at > NOW() - INTERVAL '14 days'`),
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

// Sub-phase 6.3.5: read-only counterfactual replay. No writes.
// Body: { scope: 'global' | 'per_archetype:X' | 'per_league:Y',
//         thresholdName: 'experiment_to_candidate.min_sample_size' (etc),
//         lookbackDays?: number (default 90, hard-floored at 2026-05-03),
//         alternatives?: number[] (default ±10/25/50% + 2x of current value) }
router.post("/admin/run-counterfactual-replay", async (req, res) => {
  try {
    const { scope, thresholdName, lookbackDays, alternatives } = req.body ?? {};
    if (typeof scope !== "string" || typeof thresholdName !== "string") {
      return res.status(400).json({
        success: false,
        message: "scope (string) and thresholdName (string) required",
      });
    }
    const result = await runCounterfactualReplay({
      scope,
      thresholdName,
      lookbackDays: typeof lookbackDays === "number" ? lookbackDays : undefined,
      alternatives: Array.isArray(alternatives) ? alternatives.filter((v: any) => typeof v === "number") : undefined,
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Sub-phase 6.3: proposal generator (Path A — pragmatic).
// Body: { scope?: string, thresholdNames?: string[], lookbackDays?: number,
//         dryRun?: boolean (default false) }
// Writes are gated by env flag THRESHOLD_PROPOSAL_GENERATOR_ENABLED (default
// false). When dryRun=true, never writes regardless of flag — returns the
// proposals that WOULD have been written. When flag=false and dryRun=false,
// proposals are computed but not persisted (response includes
// proposalGeneratorEnabledFlag=false so the caller can see why).
router.post("/admin/run-proposal-generator", async (req, res) => {
  try {
    const { scope, thresholdNames, lookbackDays, dryRun } = req.body ?? {};
    const result = await runProposalGenerator({
      scope: typeof scope === "string" ? scope : undefined,
      thresholdNames: Array.isArray(thresholdNames)
        ? thresholdNames.filter((n: any) => typeof n === "string")
        : undefined,
      lookbackDays: typeof lookbackDays === "number" ? lookbackDays : undefined,
      dryRun: dryRun === true,
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Sub-phase 6.4: pending-revisions admin endpoints. Queue browser + manual
// review for "looser" threshold proposals (tighter ones are auto-approved by
// the proposal generator). Approving here flips the active threshold value
// via the lookup chain in resolveAllThresholds; rejecting closes the row out
// without altering active values.

const ALLOWED_REVISION_STATUS_FILTERS: ReadonlySet<PendingRevisionStatusFilter> = new Set([
  "pending",
  "approved",
  "rejected",
  "expired",
  "all",
]);

router.get("/admin/pending-threshold-revisions", async (req, res) => {
  try {
    const rawStatus = typeof req.query.status === "string" ? req.query.status : "pending";
    if (!ALLOWED_REVISION_STATUS_FILTERS.has(rawStatus as PendingRevisionStatusFilter)) {
      return res.status(400).json({
        success: false,
        error: `invalid status: must be one of ${Array.from(ALLOWED_REVISION_STATUS_FILTERS).join(", ")}`,
      });
    }
    const scope = typeof req.query.scope === "string" && req.query.scope.length > 0
      ? req.query.scope
      : undefined;
    const thresholdName = typeof req.query.thresholdName === "string" && req.query.thresholdName.length > 0
      ? req.query.thresholdName
      : undefined;
    const limitRaw = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    const result = await listPendingThresholdRevisions({
      status: rawStatus as PendingRevisionStatusFilter,
      scope,
      thresholdName,
      limit,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: String(err) });
  }
});

function parseRevisionId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function normaliseReviewNote(body: any): string | null {
  const raw = body?.reviewNote;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 1000);
}

router.post("/admin/pending-threshold-revisions/:id/approve", async (req, res) => {
  try {
    const id = parseRevisionId(req.params.id);
    if (id == null) return res.status(400).json({ success: false, error: "invalid id" });
    const reviewNote = normaliseReviewNote(req.body);
    const result = await reviewPendingThresholdRevision({ id, decision: "approve", reviewNote });
    if (result.success) return res.json({ success: true, row: result.row });
    if (result.status === 404) return res.status(404).json({ success: false, error: "not found" });
    return res.status(409).json({
      success: false,
      error: `already ${result.currentStatus}`,
      currentStatus: result.currentStatus,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: String(err) });
  }
});

router.post("/admin/pending-threshold-revisions/:id/reject", async (req, res) => {
  try {
    const id = parseRevisionId(req.params.id);
    if (id == null) return res.status(400).json({ success: false, error: "invalid id" });
    const reviewNote = normaliseReviewNote(req.body);
    const result = await reviewPendingThresholdRevision({ id, decision: "reject", reviewNote });
    if (result.success) return res.json({ success: true, row: result.row });
    if (result.status === 404) return res.status(404).json({ success: false, error: "not found" });
    return res.status(409).json({
      success: false,
      error: `already ${result.currentStatus}`,
      currentStatus: result.currentStatus,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// Sub-phase 10: ongoing audit (settlement-bias + auto-demote).
// Body: { dryRun?: boolean (default false), lookbackDays?: number (default 30) }
router.post("/admin/run-ongoing-audit", async (req, res) => {
  try {
    const { dryRun, lookbackDays } = req.body ?? {};
    const result = await runOngoingAudit({
      dryRun: dryRun === true,
      lookbackDays: typeof lookbackDays === "number" ? lookbackDays : undefined,
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Sub-phase 8.a: CLV-by-time-to-kickoff retrospective. Read-only.
// Body: { lookbackDays?: number (default 90, hard-floored at 2026-05-03) }
router.post("/admin/run-clv-time-bucket-retrospective", async (req, res) => {
  try {
    const { lookbackDays } = req.body ?? {};
    const result = await runClvTimeBucketRetrospective({
      lookbackDays: typeof lookbackDays === "number" ? lookbackDays : undefined,
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: String(err) });
  }
});

// Sub-phase 9 v2: Kelly-optimiser. Body: { tag?: string } — if tag provided,
// runs for that tag only; otherwise iterates over all candidate+promoted tags.
router.post("/admin/run-kelly-optimizer", async (req, res) => {
  try {
    const { tag } = req.body ?? {};
    if (typeof tag === "string" && tag.length > 0) {
      const result = await runKellyOptimizerForTag(tag);
      return res.json({ success: true, result });
    }
    const result = await runKellyOptimizerForAllTags();
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: String(err) });
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
    return res.json({
      previousDeposit: currentDeposit,
      added: amount,
      newTotalDeposit: newTotal,
      newBankrollFloor: newFloor,
      floorPct: "60%",
    });
  } catch (err) {
    logger.warn({ err }, "Starting deposit update failed");
    return res.status(500).json({ error: String(err) });
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
    return res.json({ ...status, ...health });
  } catch (err) {
    logger.warn({ err }, "VPS relay status check failed");
    return res.status(500).json({ error: String(err) });
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
        FROM paper_bets_current
        WHERE betfair_bet_id IS NOT NULL
      `),
      db.execute(sql`
        SELECT
          ROUND(AVG(EXTRACT(EPOCH FROM (betfair_placed_at - placed_at)))::numeric, 1) AS avg_signal_to_place_secs,
          ROUND(AVG(CASE WHEN betfair_settled_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (betfair_settled_at - betfair_placed_at)) END)::numeric, 0) AS avg_time_to_settle_secs
        FROM paper_bets_current
        WHERE betfair_placed_at IS NOT NULL
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS week_bets,
          COUNT(*) FILTER (WHERE status IN ('won','lost'))::int AS week_settled
        FROM paper_bets_current
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

// Task 10 (2026-05-11 — back-to-theory plan): cumulative realised P&L over
// an operator-specified window. Commission is baked into `net_pnl` at
// settlement time (paperTrading.calculateSettlementWithCommission), so this
// is the true performance baseline. Default window starts 2026-05-03 (the
// theory-plan baseline). Default track is 'live'; 'shadow' and 'paper'
// also supported for cross-rail comparison.
router.get("/reports/pnl-since", async (req, res) => {
  const since = typeof req.query.since === "string" ? req.query.since : "2026-05-03";
  const track = typeof req.query.track === "string" ? req.query.track : "live";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    res.status(400).json({ error: "since must be YYYY-MM-DD" });
    return;
  }
  if (!["live", "shadow", "paper"].includes(track)) {
    res.status(400).json({ error: "track must be one of live|shadow|paper" });
    return;
  }
  try {
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int                                                       AS n_bets,
             COUNT(*) FILTER (WHERE status='won')::int                           AS won,
             COUNT(*) FILTER (WHERE status='lost')::int                          AS lost,
             COUNT(*) FILTER (WHERE status='void')::int                          AS void,
             COUNT(*) FILTER (WHERE status='cancelled')::int                     AS cancelled,
             COUNT(*) FILTER (WHERE status='pending')::int                       AS pending,
             ROUND(COALESCE(SUM(stake), 0)::numeric, 2)                          AS total_stake,
             ROUND(COALESCE(SUM(gross_pnl), 0)::numeric, 2)                      AS gross_pnl,
             ROUND(COALESCE(SUM(commission_amount), 0)::numeric, 2)              AS commission_paid,
             ROUND(COALESCE(SUM(net_pnl), 0)::numeric, 2)                        AS net_pnl
      FROM paper_bets
      WHERE bet_track = ${track}
        AND placed_at >= ${since}::timestamptz
        AND deleted_at IS NULL
    `);
    const row = ((rows as any).rows ?? [])[0] ?? {};
    res.json({ since, track, ...row });
  } catch (err) {
    logger.error({ err, since, track }, "/reports/pnl-since failed");
    res.status(500).json({ error: String(err) });
  }
});

// 2026-05-11: manual trigger for Bundle B nightly analytics. The cron runs
// at 02:30 UTC daily but the operator needs to force-recompute after a
// formula change (e.g. the Wilson lower-bound fix shipped today) without
// waiting for the next nightly tick. Idempotent — repeated calls just
// recompute analysis_segment_stats + analysis_signal_strength at the
// current timestamp. Not gated by ENVIRONMENT because the cron runs in
// production already; this is the same code path.
router.post("/admin/run-bundle-b", async (_req, res) => {
  try {
    const { runBundleBAnalytics } = await import("../services/analysisJobs");
    const result = await runBundleBAnalytics();
    res.json({ ok: true, result });
  } catch (err) {
    logger.error({ err }, "Manual Bundle B run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 2026-05-11: manual trigger for the drawdown-targeted Kelly Monte-Carlo
// (Task 17). Same code path as the daily 03:15 UTC cron, just run on
// demand. Use after changing `drawdown_target_p1_pct` so the lookup
// updates without waiting for the next cron tick. Idempotent.
router.post("/admin/run-kelly-montecarlo", async (_req, res) => {
  try {
    const { runKellyLookupSimulation } = await import("../services/dynamicKelly");
    const result = await runKellyLookupSimulation();
    res.json({ ok: true, result });
  } catch (err) {
    logger.error({ err }, "Manual Kelly Monte-Carlo run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 2026-05-11: manual trigger for the lazy shadow→live promoter. The 5-min
// cron in scheduler.ts runs this automatically; this endpoint lets the
// operator force a pass immediately (e.g. after raising the dynamic Kelly
// fraction floor, to see whether previously-too-small shadows now qualify
// for live promotion). Returns the number of pending shadow candidates
// scanned + how many were promoted to live.
router.post("/admin/run-lazy-promote", async (_req, res) => {
  try {
    const { runLazyPromoteShadowToPaper } = await import("../services/lazyPromoteShadowToPaper");
    const result = await runLazyPromoteShadowToPaper();
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, "Manual lazy-promote run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// 2026-05-11: manual trigger for live account-statement reconciliation
// (clears net_pnl vs betfair_pnl drift). Same code path as the daily 05:00
// UTC cron and the new hourly cron. Use after the auto-revert kill switch
// fires on Trigger C (drift) — runs the statement walk, auto-corrects all
// drifted rows, then operator can flip live_placement_enabled back to
// true. Optional `?hours=N` query param for the lookback window (default
// 24h, used by daily; pass 48 to catch older bets etc.).
router.post("/admin/reconcile-live-statement", async (req, res) => {
  try {
    const hoursRaw = req.query.hours;
    const hours = typeof hoursRaw === "string" && Number.isFinite(Number(hoursRaw))
      ? Math.max(1, Math.min(168, Number(hoursRaw)))
      : 24;
    const { reconcileLiveAccountStatement } = await import("../services/liveReconciliation");
    const result = await reconcileLiveAccountStatement(hours);
    res.json({ ok: true, lookback_hours: hours, result });
  } catch (err) {
    logger.error({ err }, "Manual live statement reconciliation failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 1b + 1c (2026-05-14): manual trigger for the Dixon-Coles ρ fit
// + backtest. Returns the Python sidecar's exit code, duration, and
// last stderr lines. Useful for the initial seed before the first
// Monday-05:00 cron tick fires.
router.post("/admin/run-dixon-coles-fitter", async (_req, res) => {
  try {
    const { runDixonColesFitter } = await import("../services/dixonColesFitCron");
    const r = await runDixonColesFitter();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "Manual Dixon-Coles fitter run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 2a (2026-05-14): manual trigger for the FBref team-form scraper.
// Synchronous (typically 30-90s on first run; subsequent runs hit the
// soccerdata FS cache and finish in ≤ 5s). Returns the sidecar's exit
// code, duration, and stderr tail.
router.post("/admin/run-team-form-scrape", async (_req, res) => {
  try {
    const { runTeamFormScrape } = await import("../services/teamFormScrapeCron");
    const r = await runTeamFormScrape();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "Manual team-form scraper run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// FotMob multi-strategy ID scan (Phase 2j, 2026-05-15). Optional
// `strategy` body param ('a'|'sitemap'|'b'|'daily-matches'|
// 'c'|'brute'|'all', default 'all'). Strategy C is now parallelized
// (~30-60s) and there's a hard 6-min kill timer on the child
// process so the endpoint can't hang forever. Read-only; never
// writes the DB.
router.post("/admin/run-fotmob-id-scan", async (req, res) => {
  try {
    const body = req.body ?? {};
    const strategy = String(body.strategy ?? "all");
    const range = typeof body.range === "string" ? body.range : undefined;
    const { runFotmobIdScan } = await import("../services/fotmobIdScanCron");
    const r = await runFotmobIdScan(strategy, range);
    res.json({ ok: r.exitCode === 0, strategy, range, ...r });
  } catch (err) {
    logger.error({ err }, "FotMob id scan failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// FotMob community-wrapper test (Phase 2k, 2026-05-15). After raw
// curl on /api/leagues/9227 returned 200+HTML (SPA shell — JSON API
// now gated by x-mas signed-request header), tests whether
// fotmob-api / PyFotMob wrappers (which reverse-engineer the
// signing) can reach the real JSON. Pip-installs both packages and
// reports which methods work. Read-only; 4-min hard kill timer.
router.post("/admin/run-fotmob-wrapper-test", async (_req, res) => {
  try {
    const { runFotmobWrapperTest } = await import("../services/fotmobWrapperTestCron");
    const r = await runFotmobWrapperTest();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "FotMob wrapper test failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// FotMob league-ID discovery (2026-05-15 follow-up to the endpoint
// probe). Tries 4 strategies (search API, master directory, /leagues
// HTML, country-filtered HTML + __NEXT_DATA__ extraction) to find
// current FotMob IDs for the 6 women's leagues whose hardcoded IDs
// returned 404. Read-only. Operator pastes the discovered IDs back
// into scrape_fotmob_direct.WOMENS_LEAGUES.
router.post("/admin/run-fotmob-id-finder", async (_req, res) => {
  try {
    const { runFotmobIdFinder } = await import("../services/fotmobIdFinderCron");
    const r = await runFotmobIdFinder();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "FotMob id finder failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// FotMob endpoint discovery probe (2026-05-15). Tries 25+ candidate
// URL patterns and reports status codes + body hints (__NEXT_DATA__
// presence, xG mentions). Read-only research — never writes to the
// DB. Once a 200-OK candidate is identified, scrape_fotmob_direct
// gets a one-line URL update and the women's xG pipeline is back.
router.post("/admin/run-fotmob-probe", async (_req, res) => {
  try {
    const { runFotmobProbe } = await import("../services/fotmobProbeCron");
    const r = await runFotmobProbe();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "FotMob probe failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 2c (2026-05-15) — SQL-only team_form_scrape aggregator.
// Replaces the broken FBref + FotMob scraper paths. Computes
// season-aggregate xG / matches / goals per (source × league ×
// season × team) from xg_match_data. Source-agnostic: any new
// xg_match_data feed lands in team_form_scrape automatically on the
// next aggregation. Idempotent UPSERT on the unique index.
router.post("/admin/run-team-form-aggregate", async (_req, res) => {
  try {
    const { runTeamFormAggregation } = await import("../services/teamFormAggregator");
    const r = await runTeamFormAggregation();
    res.json({ ok: true, ...r });
  } catch (err) {
    logger.error({ err }, "Team-form aggregation failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 2f (2026-05-15) — direct FBref season-stats scraper via
// cloudscraper. Bypasses the Cloudflare wall that blocked the
// Selenium-based soccerdata path. Writes to team_form_scrape with
// source='fbref'. Operator-fired only; once verified we'll add a
// Tuesday-05:00 weekly cron.
router.post("/admin/run-fbref-direct", async (_req, res) => {
  try {
    const { runFbrefDirectScrape } = await import("../services/fbrefDirectScrapeCron");
    const r = await runFbrefDirectScrape();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "Manual FBref direct run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 2e (2026-05-15) — direct-HTTP FotMob women's scraper.
// Replaces the soccerdata path (which 1.9 broke). Scripts/python/
// scrape_fotmob_direct.py hits FotMob's own public /api endpoints,
// no Selenium, no third-party scraper library, no auth. Writes to
// xg_match_data with source='fotmob'. Operator-fired only for now;
// once verified we'll add a weekly Sunday cron.
router.post("/admin/run-fotmob-direct", async (_req, res) => {
  try {
    const { runFotmobDirectScrape } = await import("../services/fotmobDirectScrapeCron");
    const r = await runFotmobDirectScrape();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "Manual FotMob direct scraper run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 2b (2026-05-14): manual trigger for FotMob women's match-xG
// scraper. Currently a no-op — soccerdata 1.9 dropped FotMob entirely.
// Endpoint stays wired for future soccerdata releases that re-add it.
router.post("/admin/run-fotmob-women-scrape", async (_req, res) => {
  try {
    const { runFotmobWomenScrape } = await import("../services/fotmobWomenScrapeCron");
    const r = await runFotmobWomenScrape();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "Manual FotMob women's scraper run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 3 (2026-05-15) — manual trigger for StatsBomb open-data
// women's ingest. Pulls free event-level data for NWSL, FAWSL,
// FIFA Women's WC, Women's Euro from raw.githubusercontent.com and
// writes per-match xG summary rows to xg_match_data with
// source='statsbomb'. No cron — fire once per season for the
// initial backfill, then occasionally for refreshes. First run
// ~5-15 min depending on how many new matches; subsequent runs
// skip already-ingested matches and finish in seconds.
router.post("/admin/run-statsbomb-ingest", async (_req, res) => {
  try {
    const { runStatsbombIngest } = await import("../services/statsbombIngestionCron");
    const r = await runStatsbombIngest();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "Manual StatsBomb ingest run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 2d (2026-05-15) — normalize the 126 existing StatsBomb rows
// retroactively and refresh team_xg_rolling. computeTeamXGRolling
// aggregates xg_match_data by exact team_name match; StatsBomb's
// "<Country> Women's" / "WNT <Country>" spellings never match the
// matches table's "<Country> W" convention, so without this step the
// 126 rows we just kept are inert — the home_xg_proxy / away_xg_proxy
// features stay 0 for upcoming women's international fixtures and the
// model can't see the new signal.
//
// Two SQL phases:
//   1. UPDATE source='statsbomb' rows with normalised team_name +
//      league_name (matching the script's new normalize_*() helpers).
//   2. Trigger computeTeamXGRolling() so the rolled-up
//      team_xg_rolling rows land under the API-Football spellings
//      and the feature engine can join them to live fixtures.
router.post("/admin/normalize-statsbomb-and-refresh-xg", async (_req, res) => {
  try {
    const { db } = await import("@workspace/db");
    // Apply the same normalisation rules in SQL that the Python
    // helpers apply at ingest time. Keep it idempotent — re-runs are
    // safe; once normalised the predicates don't re-match.
    const teamUpdate = (await db.execute(sql`
      UPDATE xg_match_data
      SET home_team = CASE
            WHEN home_team LIKE '% Women''s' THEN regexp_replace(home_team, ' Women''s$', ' W')
            WHEN home_team LIKE 'Women''s %' THEN substring(home_team from 9) || ' W'
            WHEN home_team LIKE 'WNT %' THEN substring(home_team from 5) || ' W'
            ELSE home_team
          END,
          away_team = CASE
            WHEN away_team LIKE '% Women''s' THEN regexp_replace(away_team, ' Women''s$', ' W')
            WHEN away_team LIKE 'Women''s %' THEN substring(away_team from 9) || ' W'
            WHEN away_team LIKE 'WNT %' THEN substring(away_team from 5) || ' W'
            ELSE away_team
          END,
          league = CASE
            WHEN league = 'Women''s World Cup' THEN 'FIFA Women''s World Cup'
            ELSE league
          END
      WHERE source = 'statsbomb'
    `)) as unknown as { rowCount?: number };

    const { computeTeamXGRolling } = await import("../services/xgIngestionService");
    const t0 = Date.now();
    await computeTeamXGRolling();
    const rollupDurationMs = Date.now() - t0;

    res.json({
      ok: true,
      rowsTouched: teamUpdate.rowCount ?? 0,
      rollupDurationMs,
    });
  } catch (err) {
    logger.error({ err }, "Normalize StatsBomb + refresh xg failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 0.6 (2026-05-15) — seed the 48 FIFA World Cup 2026 qualified
// nationals into the teams + team_aliases tables. The teams table
// was added in Phase 0a but never seeded; this endpoint fills it
// with the canonical 48-team list (per olympics.com + Wikipedia
// 2026 FIFA World Cup tracking) plus the common naming variants
// each source uses (API-Football, StatsBomb, FotMob).
//
// Why now: WC 2026 ~5 weeks away. Phase 0 enabled has_betfair_exchange
// on all 6 WC Qualifier confederations + the WC itself. When matches
// for these teams start firing, the model needs reliable team-name
// → canonical resolution. Without this seed, every fixture's
// home_team/away_team string gets handled as an unknown.
router.post("/admin/seed-wc-2026-teams", async (_req, res) => {
  try {
    const { db } = await import("@workspace/db");
    // 48 qualified nationals: 3 hosts + 16 UEFA + 6 CONMEBOL + 9 AFC
    // + 10 CAF + 3 other CONCACAF + 1 OFC = 48.
    // Each entry: [canonicalName, country, fifaCode, [aliases]]
    // First alias is API-Football convention (matches our matches
    // table); subsequent aliases cover StatsBomb / FotMob / common
    // spelling variants.
    const teams: Array<[string, string, string, string[]]> = [
      // Hosts
      ["USA", "USA", "USA", ["United States", "USA", "United States of America"]],
      ["Canada", "Canada", "CAN", ["Canada"]],
      ["Mexico", "Mexico", "MEX", ["Mexico"]],
      // UEFA (16)
      ["England", "England", "ENG", ["England"]],
      ["France", "France", "FRA", ["France"]],
      ["Spain", "Spain", "ESP", ["Spain"]],
      ["Germany", "Germany", "GER", ["Germany"]],
      ["Netherlands", "Netherlands", "NED", ["Netherlands", "Holland"]],
      ["Portugal", "Portugal", "POR", ["Portugal"]],
      ["Norway", "Norway", "NOR", ["Norway"]],
      ["Scotland", "Scotland", "SCO", ["Scotland"]],
      ["Belgium", "Belgium", "BEL", ["Belgium"]],
      ["Austria", "Austria", "AUT", ["Austria"]],
      ["Croatia", "Croatia", "CRO", ["Croatia"]],
      ["Switzerland", "Switzerland", "SUI", ["Switzerland"]],
      ["Bosnia and Herzegovina", "Bosnia and Herzegovina", "BIH", ["Bosnia", "Bosnia & Herzegovina", "Bosnia-Herzegovina"]],
      ["Sweden", "Sweden", "SWE", ["Sweden"]],
      ["Türkiye", "Turkey", "TUR", ["Turkey", "Türkiye"]],
      ["Czechia", "Czech Republic", "CZE", ["Czech Republic", "Czechia", "Czech-Republic"]],
      // CONMEBOL (6)
      ["Argentina", "Argentina", "ARG", ["Argentina"]],
      ["Brazil", "Brazil", "BRA", ["Brazil"]],
      ["Uruguay", "Uruguay", "URU", ["Uruguay"]],
      ["Colombia", "Colombia", "COL", ["Colombia"]],
      ["Paraguay", "Paraguay", "PAR", ["Paraguay"]],
      ["Ecuador", "Ecuador", "ECU", ["Ecuador"]],
      // AFC (9, incl. Jordan + Uzbekistan debutants)
      ["Iran", "Iran", "IRN", ["Iran", "Iran Islamic Republic"]],
      ["Japan", "Japan", "JPN", ["Japan"]],
      ["Korea Republic", "South Korea", "KOR", ["South Korea", "South-Korea", "Korea Republic", "Republic of Korea"]],
      ["Australia", "Australia", "AUS", ["Australia"]],
      ["Qatar", "Qatar", "QAT", ["Qatar"]],
      ["Saudi Arabia", "Saudi Arabia", "KSA", ["Saudi Arabia", "Saudi-Arabia"]],
      ["Iraq", "Iraq", "IRQ", ["Iraq"]],
      ["Jordan", "Jordan", "JOR", ["Jordan"]],
      ["Uzbekistan", "Uzbekistan", "UZB", ["Uzbekistan"]],
      // CAF (10, incl. Cape Verde debutant)
      ["Morocco", "Morocco", "MAR", ["Morocco"]],
      ["Tunisia", "Tunisia", "TUN", ["Tunisia"]],
      ["Algeria", "Algeria", "ALG", ["Algeria"]],
      ["Senegal", "Senegal", "SEN", ["Senegal"]],
      ["Cameroon", "Cameroon", "CMR", ["Cameroon"]],
      ["Côte d'Ivoire", "Côte d'Ivoire", "CIV", ["Ivory Coast", "Ivory-Coast", "Côte d'Ivoire", "Cote d'Ivoire"]],
      ["Egypt", "Egypt", "EGY", ["Egypt"]],
      ["Ghana", "Ghana", "GHA", ["Ghana"]],
      ["Nigeria", "Nigeria", "NGA", ["Nigeria"]],
      ["Cape Verde", "Cape Verde", "CPV", ["Cape Verde", "Cabo Verde"]],
      // CONCACAF (3 in addition to hosts)
      ["Jamaica", "Jamaica", "JAM", ["Jamaica"]],
      ["Panama", "Panama", "PAN", ["Panama"]],
      ["Curaçao", "Curaçao", "CUW", ["Curacao", "Curaçao"]],
      // OFC (1)
      ["New Zealand", "New Zealand", "NZL", ["New Zealand", "New-Zealand"]],
    ];

    let teamsInserted = 0;
    let teamsUpdated = 0;
    let aliasesInserted = 0;

    for (const [canonical, country, fifaCode, aliases] of teams) {
      const r1 = (await db.execute(sql`
        INSERT INTO teams
          (canonical_name, country, gender, is_national_team, fifa_code)
        VALUES (${canonical}, ${country}, 'male', true, ${fifaCode})
        ON CONFLICT (canonical_name, gender) DO UPDATE SET
          country = EXCLUDED.country,
          is_national_team = true,
          fifa_code = EXCLUDED.fifa_code
        RETURNING id, (xmax = 0) AS inserted
      `)) as unknown as { rows: Array<{ id: number; inserted: boolean }> };
      const teamRow = r1.rows?.[0];
      if (!teamRow) continue;
      if (teamRow.inserted) teamsInserted++;
      else teamsUpdated++;

      // Seed aliases per source. Best-guess source assignments:
      //   API-Football fixtures use the first alias (matches table)
      //   StatsBomb / FotMob use the canonical name itself
      for (const alias of aliases) {
        const r2 = (await db.execute(sql`
          INSERT INTO team_aliases (team_id, source, alias)
          VALUES (${teamRow.id}, 'api_football', ${alias})
          ON CONFLICT (source, alias) DO NOTHING
        `)) as unknown as { rowCount?: number };
        aliasesInserted += r2.rowCount ?? 0;
      }
      // Also tag the canonical name under statsbomb + fotmob sources
      // so direct StatsBomb / FotMob lookups resolve.
      for (const source of ["statsbomb", "fotmob"]) {
        const r3 = (await db.execute(sql`
          INSERT INTO team_aliases (team_id, source, alias)
          VALUES (${teamRow.id}, ${source}, ${canonical})
          ON CONFLICT (source, alias) DO NOTHING
        `)) as unknown as { rowCount?: number };
        aliasesInserted += r3.rowCount ?? 0;
      }
    }

    res.json({
      ok: true,
      totalTeamsSeed: teams.length,
      teamsInserted,
      teamsUpdated,
      aliasesInserted,
    });
  } catch (err) {
    logger.error({ err }, "WC 2026 team seed failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 3b (2026-05-15) — StatsBomb open-data men's ingest. Pulls
// FIFA WC 2022 + UEFA Euro 2024 + UEFA Euro 2020 + CL finals + various
// other men's tournaments from raw.githubusercontent.com. Directly
// relevant for FIFA WC 2026 (~5 weeks away) — all 48 qualified
// nationals have prior-tournament xG history in this corpus. No cron
// — operator-fired only.
router.post("/admin/run-statsbomb-mens-ingest", async (_req, res) => {
  try {
    const { runStatsbombMensIngest } = await import("../services/statsbombMensIngestionCron");
    const r = await runStatsbombMensIngest();
    res.json({ ok: r.exitCode === 0, ...r });
  } catch (err) {
    logger.error({ err }, "Manual StatsBomb men's ingest run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 3 (2026-05-15) — cleanup pre-cutoff StatsBomb rows. The
// initial ingest pulled 540 women's-football match summaries
// including FAWSL 2018/19-2020/21, NWSL 2018 and Women's WC 2019 —
// all >3 yrs old, with rosters/coaches/eras unrelated to anything
// the model bets on in 2026. Per
// feedback_ingest_only_predictive_data, those rows are dead weight
// on Neon AND dilute any rolling-form / DC-fit aggregation. This
// endpoint deletes everything that fails the same season-start-year
// cutoff the ingest script now enforces at write time.
router.post("/admin/cleanup-statsbomb-old", async (req, res) => {
  try {
    const cutoffYear = Number((req.body ?? {}).cutoffYear ?? 2022);
    const cutoffDate = `${cutoffYear}-01-01`;
    const { db } = await import("@workspace/db");
    const result = (await db.execute(sql`
      DELETE FROM xg_match_data
      WHERE source = 'statsbomb'
        AND (match_date IS NULL OR match_date < ${cutoffDate})
    `)) as unknown as { rowCount?: number };
    res.json({
      ok: true,
      cutoffYear,
      cutoffDate,
      deleted: result.rowCount ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Cleanup pre-cutoff StatsBomb rows failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 0b (Women's & Internationals expansion, 2026-05-14). Seeds the
// competition_aliases table with known Betfair-side names for the
// marquee women's + international scopes, then triggers a synchronous
// reverse-map run so the betfair_competition_id gets populated in this
// admin call. Also patches the Shin de-vig miss from Phase 0a — the
// 12 internationals have competition_type='league' so the prior WHERE
// clause didn't catch them; we now flip them explicitly by id.
//
// Idempotent: ON CONFLICT DO NOTHING on each alias; reverse-map skips
// already-linked rows.
router.post("/admin/phase-0b-seed-aliases-and-reverse-map", async (_req, res) => {
  try {
    const { db } = await import("@workspace/db");
    const { competitionAliasesTable, complianceLogsTable } = await import("@workspace/db");

    // Multiple alias variants per AF id — caught against any of them.
    // The (source, alias) unique constraint prevents duplicates if the
    // endpoint is re-fired.
    const aliases: Array<{ alias: string; api_football_id: number; note?: string }> = [
      // ── Women's domestic ─────────────────────────────────────────────
      { alias: "FA Women's Super League",     api_football_id: 771, note: "WSL" },
      { alias: "Women's Super League",        api_football_id: 771, note: "WSL" },
      { alias: "English WSL",                 api_football_id: 771, note: "WSL" },
      { alias: "NWSL",                        api_football_id: 254, note: "NWSL USA" },
      { alias: "Women's National Soccer League", api_football_id: 254, note: "NWSL USA" },
      { alias: "National Womens Soccer League",  api_football_id: 254, note: "NWSL USA" },
      { alias: "Frauen Bundesliga",           api_football_id: 770, note: "Frauen-Bundesliga" },
      { alias: "Frauen-Bundesliga",           api_football_id: 770, note: "Frauen-Bundesliga" },
      { alias: "German Frauen-Bundesliga",    api_football_id: 770, note: "Frauen-Bundesliga" },
      { alias: "Bundesliga Women",            api_football_id: 770, note: "Frauen-Bundesliga" },
      { alias: "Liga F",                      api_football_id: 775, note: "Liga F Spain" },
      { alias: "Primera Division Femenina",   api_football_id: 775, note: "Liga F Spain" },
      { alias: "Primera División Femenina",   api_football_id: 775, note: "Liga F Spain" },
      { alias: "Spanish Liga F",              api_football_id: 775, note: "Liga F Spain" },
      { alias: "Division 1 Féminine",         api_football_id: 773, note: "D1F France" },
      { alias: "Division 1 Feminine",         api_football_id: 773, note: "D1F France" },
      { alias: "D1 Arkema",                   api_football_id: 773, note: "D1F France" },
      { alias: "Premiere Ligue Feminine",     api_football_id: 773, note: "D1F France" },
      { alias: "Première Ligue Féminine",     api_football_id: 773, note: "D1F France" },
      { alias: "Serie A Femminile",           api_football_id: 524, note: "Italy Women" },
      { alias: "Italian Serie A Women",       api_football_id: 524, note: "Italy Women" },
      { alias: "Serie A Women",               api_football_id: 524, note: "Italy Women" },
      { alias: "Brasileiro Feminino",         api_football_id: 74,  note: "Brasileiro Women" },
      { alias: "Campeonato Brasileiro Feminino", api_football_id: 74, note: "Brasileiro Women" },
      { alias: "Damallsvenskan",              api_football_id: 793, note: "Sweden Women" },
      { alias: "Swedish Damallsvenskan",      api_football_id: 793, note: "Sweden Women" },
      { alias: "Toppserien",                  api_football_id: 794, note: "Norway Women" },
      { alias: "Norwegian Toppserien",        api_football_id: 794, note: "Norway Women" },
      { alias: "Kvindeligaen",                api_football_id: 795, note: "Denmark Women" },
      { alias: "Gjensidige Kvindeligaen",     api_football_id: 795, note: "Denmark Women" },
      { alias: "Danish Kvindeligaen",         api_football_id: 795, note: "Denmark Women" },
      // ── Women's international ────────────────────────────────────────
      { alias: "FIFA Women's World Cup",      api_football_id: 8,   note: "Women's WC" },
      { alias: "Women's World Cup",           api_football_id: 8,   note: "Women's WC" },
      { alias: "Womens World Cup",            api_football_id: 8,   note: "Women's WC" },
      { alias: "Women's International Friendlies", api_football_id: 22, note: "Women's int'l friendlies" },
      { alias: "Womens International Friendlies",  api_football_id: 22, note: "Women's int'l friendlies" },
      { alias: "International Friendlies (Women)", api_football_id: 22, note: "Women's int'l friendlies" },
      { alias: "International Friendlies Women",   api_football_id: 22, note: "Women's int'l friendlies" },
      { alias: "Women's WC Qualifying - UEFA",       api_football_id: 880, note: "W WCQ UEFA" },
      { alias: "Women's World Cup Qualifying - UEFA", api_football_id: 880, note: "W WCQ UEFA" },
      { alias: "Women's World Cup Qualifying UEFA",   api_football_id: 880, note: "W WCQ UEFA" },
      { alias: "UEFA Women's Championship Qualifying",      api_football_id: 1083, note: "W Euro Q" },
      { alias: "Women's European Championship Qualifying",  api_football_id: 1083, note: "W Euro Q" },
      { alias: "UEFA Women's Euro Qualifying",              api_football_id: 1083, note: "W Euro Q" },
      { alias: "UEFA Women's Euro",                         api_football_id: 960,  note: "W Euro" },
      { alias: "Women's European Championship",             api_football_id: 960,  note: "W Euro" },
      { alias: "UEFA Women's Championship",                 api_football_id: 960,  note: "W Euro" },
      // ── Men's international ──────────────────────────────────────────
      { alias: "UEFA Nations League",         api_football_id: 5,   note: "UNL" },
      { alias: "Africa Cup of Nations",       api_football_id: 6,   note: "AFCON" },
      { alias: "African Cup of Nations",      api_football_id: 6,   note: "AFCON" },
      { alias: "AFCON",                       api_football_id: 6,   note: "AFCON" },
      { alias: "CONCACAF Gold Cup",           api_football_id: 11,  note: "Gold Cup" },
      { alias: "Gold Cup",                    api_football_id: 11,  note: "Gold Cup" },
      { alias: "Copa America",                api_football_id: 9,   note: "Copa America" },
      { alias: "Copa América",                api_football_id: 9,   note: "Copa America" },
      { alias: "AFC Asian Cup",               api_football_id: 7,   note: "Asian Cup" },
      { alias: "Asian Cup",                   api_football_id: 7,   note: "Asian Cup" },
      { alias: "World Cup Qualifying - UEFA",    api_football_id: 15, note: "WCQ UEFA" },
      { alias: "World Cup Qualifying UEFA",      api_football_id: 15, note: "WCQ UEFA" },
      { alias: "FIFA World Cup Qualifying - UEFA", api_football_id: 15, note: "WCQ UEFA" },
      { alias: "World Cup Qualifying - CONMEBOL",    api_football_id: 29, note: "WCQ CONMEBOL" },
      { alias: "World Cup Qualifying CONMEBOL",      api_football_id: 29, note: "WCQ CONMEBOL" },
      { alias: "FIFA World Cup Qualifying - CONMEBOL", api_football_id: 29, note: "WCQ CONMEBOL" },
      { alias: "World Cup Qualifying - AFC",         api_football_id: 30, note: "WCQ AFC" },
      { alias: "World Cup Qualifying AFC",           api_football_id: 30, note: "WCQ AFC" },
      { alias: "World Cup Qualifying - CONCACAF",    api_football_id: 31, note: "WCQ CONCACAF" },
      { alias: "World Cup Qualifying CONCACAF",      api_football_id: 31, note: "WCQ CONCACAF" },
      { alias: "World Cup Qualifying - CAF",         api_football_id: 33, note: "WCQ CAF" },
      { alias: "World Cup Qualifying CAF",           api_football_id: 33, note: "WCQ CAF" },
      { alias: "World Cup Qualifying - OFC",         api_football_id: 34, note: "WCQ OFC" },
      { alias: "World Cup Qualifying OFC",           api_football_id: 34, note: "WCQ OFC" },
    ];

    // Bulk-insert with ON CONFLICT DO NOTHING (idempotent on (source, alias)).
    let aliasInserted = 0;
    for (const a of aliases) {
      const r = (await db.execute(sql`
        INSERT INTO competition_aliases (source, alias, api_football_id, note)
        VALUES ('betfair', ${a.alias}, ${a.api_football_id}, ${a.note ?? null})
        ON CONFLICT (source, alias) DO NOTHING
      `)) as unknown as { rowCount?: number };
      aliasInserted += r.rowCount ?? 0;
    }

    // Fix Phase 0a Shin de-vig miss — internationals have
    // competition_type='league' (not 'international') so the earlier
    // WHERE clause didn't catch them. Flip the 12 marquee international
    // ids explicitly.
    const r2 = (await db.execute(sql`
      UPDATE competition_config
      SET devig_method = 'shin'
      WHERE devig_method = 'power'
        AND api_football_id IN (5, 848, 6, 11, 9, 7, 15, 29, 30, 31, 33, 34)
    `)) as unknown as { rowCount?: number };
    const devigShinIntl = r2.rowCount ?? 0;

    // Trigger reverse-map (synchronous so the deltas come back in one call).
    const { runBetfairReverseMapping } = await import("../services/betfairFirstUniverse");
    const reverseMap = await runBetfairReverseMapping();

    await db.insert(complianceLogsTable).values({
      actionType: "phase_0b_seed_aliases_and_reverse_map",
      details: {
        aliasInserted,
        devigShinIntl,
        aliasHits: reverseMap.aliasHits,
        writesApplied: reverseMap.writesApplied,
        writesProposed: reverseMap.writesProposed,
      },
      timestamp: new Date(),
    });

    logger.info(
      {
        aliasInserted, devigShinIntl,
        reverseMapAliasHits: reverseMap.aliasHits,
        reverseMapWritesApplied: reverseMap.writesApplied,
      },
      "Phase 0b alias seeding + reverse-map complete",
    );
    res.json({
      ok: true,
      aliasInserted,
      devigShinIntl,
      reverseMap: {
        aliasHits: reverseMap.aliasHits,
        writesApplied: reverseMap.writesApplied,
        writesProposed: reverseMap.writesProposed,
        fuzzyFailures: reverseMap.fuzzyMatchFailures.belowThresholdCount,
        durationMs: reverseMap.durationMs,
      },
    });
  } catch (err) {
    logger.error({ err }, "Phase 0b alias seeding + reverse-map failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Phase 0 (Women's & Internationals expansion, 2026-05-14). One-shot
// idempotent SQL bundle:
//   1. Dedupe + fix mis-tagged rows in competition_config (fake FA WSL
//      900005, NULL+male-tagged garbage rows, alt-id duplicates like
//      Frauen Bundesliga 82 vs 770).
//   2. Backfill has_betfair_exchange=true for the marquee women's
//      leagues (WSL, NWSL, Liga F, Frauen-Bundesliga, D1 Féminine, Serie
//      A Femminile, Brasileiro Women, Damallsvenskan, Toppserien,
//      Kvindeligaen, women's international windows) and major
//      international competitions (AFCON, Gold Cup, UEFA Nations
//      League, WC Qualifiers for all six confederations).
//
// Safe to re-run — every change is guarded by a WHERE/ON CONFLICT.
// Returns per-step row counts so the operator can verify the deltas.
router.post("/admin/phase-0-dedupe-and-backfill", async (_req, res) => {
  try {
    const { db } = await import("@workspace/db");
    const { complianceLogsTable } = await import("@workspace/db");
    const counts: Record<string, number> = {};

    // ─── (1) Dedupe garbage rows ────────────────────────────────────────
    // 1a. The fake "FA WSL" row at api_football_id=900005 (not a real AF
    // league id; api_football_id=771 is the real WSL).
    const r1a = (await db.execute(sql`
      DELETE FROM competition_config WHERE api_football_id = 900005
    `)) as unknown as { rowCount?: number };
    counts["dedupe_fake_fa_wsl_900005"] = r1a.rowCount ?? 0;

    // 1b. NULL-id rows with women's names but gender='male' — orphaned
    // bad data from earlier imports.
    const r1b = (await db.execute(sql`
      DELETE FROM competition_config
      WHERE api_football_id IS NULL
        AND name IN (
          'NWSL Women',
          'Spanish Liga F',
          'US National Women Soccer League',
          'Primera División Femenina'
        )
    `)) as unknown as { rowCount?: number };
    counts["dedupe_null_id_women_gender_male"] = r1b.rowCount ?? 0;

    // 1c. Alt-id duplicates. 82 = legacy Frauen Bundesliga; 770 is the
    // current API-football authoritative id. 139 = men's Serie A id
    // (someone tagged it gender=female by mistake — corrupt row). 190 is
    // a Tier-C duplicate of A-League Women 196 (already Tier B).
    // Mark inactive rather than DELETE so any cron still pulling by the
    // alt id sees an explicit signal rather than a missing row.
    const r1c = (await db.execute(sql`
      UPDATE competition_config
      SET is_active = false
      WHERE api_football_id IN (82, 190)
        OR (api_football_id = 139 AND gender = 'female')
    `)) as unknown as { rowCount?: number };
    counts["deactivate_alt_id_duplicates"] = r1c.rowCount ?? 0;

    // ─── (2) Backfill has_betfair_exchange for marquee women's scopes ──
    // Confirmed via Betfair Exchange UI as carrying AH and/or OU 1.5
    // markets during their respective seasons. Pinnacle covers all of
    // these, so CLV is measurable once bets fire.
    const r2a = (await db.execute(sql`
      UPDATE competition_config
      SET has_betfair_exchange = true
      WHERE gender = 'female'
        AND api_football_id IN (
          771,   -- WSL (England)
          254,   -- NWSL (USA)
          770,   -- Frauen-Bundesliga (Germany)
          775,   -- Liga F (Spain)
          773,   -- Division 1 Féminine (France)
          524,   -- Serie A Femminile (Italy)
          74,    -- Brasileiro Women (Brazil)
          790,   -- Brasileiro Feminino (Brazil — alt id)
          793,   -- Damallsvenskan (Sweden)
          794,   -- Toppserien (Norway)
          795,   -- Kvindeligaen (Denmark)
          8,     -- FIFA Women's World Cup
          22,    -- International Friendlies Women
          666,   -- Women's International Friendlies
          880,   -- Women's WC Qualifiers - Europe
          1083,  -- UEFA Women's Championship Qualifiers
          960    -- UEFA Women's Euro
        )
        AND COALESCE(has_betfair_exchange, false) = false
    `)) as unknown as { rowCount?: number };
    counts["backfill_betfair_exchange_women"] = r2a.rowCount ?? 0;

    // ─── (3) Backfill has_betfair_exchange for major international comps ─
    // All Pinnacle-priced during their respective tournament windows;
    // Betfair carries them. WC qualifiers across all six confederations.
    const r3a = (await db.execute(sql`
      UPDATE competition_config
      SET has_betfair_exchange = true
      WHERE api_football_id IN (
          6,    -- Africa Cup of Nations
          11,   -- CONCACAF Gold Cup
          5,    -- UEFA Nations League
          848,  -- UEFA Nations League (alt id)
          9,    -- Copa America
          7,    -- AFC Asian Cup
          15,   -- FIFA WC Qualifiers - UEFA
          29,   -- FIFA WC Qualifiers - CONMEBOL
          30,   -- FIFA WC Qualifiers - AFC
          31,   -- FIFA WC Qualifiers - CONCACAF
          33,   -- FIFA WC Qualifiers - CAF
          34    -- FIFA WC Qualifiers - OFC
        )
        AND COALESCE(has_betfair_exchange, false) = false
    `)) as unknown as { rowCount?: number };
    counts["backfill_betfair_exchange_intl"] = r3a.rowCount ?? 0;

    // ─── (4) De-vig method: women's + internationals → 'shin' ──────────
    // Phase 1 §1.5 audit recommendation. Proportional de-vig under-
    // corrects favourite-longshot bias in soft markets; Shin handles
    // them better. Idempotent: only flip rows that are still on the
    // default 'power'. Leaves leagues that have been hand-set to
    // anything else alone.
    const r4a = (await db.execute(sql`
      UPDATE competition_config
      SET devig_method = 'shin'
      WHERE devig_method = 'power'
        AND (gender = 'female' OR competition_type = 'international')
    `)) as unknown as { rowCount?: number };
    counts["devig_shin_for_soft_markets"] = r4a.rowCount ?? 0;

    // Audit log
    await db.insert(complianceLogsTable).values({
      actionType: "phase_0_dedupe_and_backfill",
      details: { counts },
      timestamp: new Date(),
    });

    logger.info({ counts }, "Phase 0 dedupe + has_betfair_exchange backfill complete");
    res.json({ ok: true, counts });
  } catch (err) {
    logger.error({ err }, "Phase 0 dedupe + backfill failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;

