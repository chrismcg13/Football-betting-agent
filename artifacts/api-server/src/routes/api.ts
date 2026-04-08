import { Router } from "express";
import {
  db,
  paperBetsTable,
  matchesTable,
  complianceLogsTable,
  learningNarrativesTable,
  modelStateTable,
  agentConfigTable,
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
} from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getConfigValue,
  setConfigValue,
  getBankroll,
  getAgentStatus,
} from "../services/paperTrading";
import {
  runIngestionNow,
  runFeaturesNow,
  runTradingCycle,
  getSchedulerStatus,
  runOddspapiMappingNow,
} from "../services/scheduler";
import {
  getOddspapiStatus,
} from "../services/oddsPapi";
import {
  getApiBudgetStatus,
  fetchAndStoreOddsForAllUpcoming,
} from "../services/apiFootball";

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

async function getSettledBetsStats() {
  const rows = await db
    .select({
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      settledAt: paperBetsTable.settledAt,
      opportunityScore: paperBetsTable.opportunityScore,
    })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost", "void"]));
  return rows;
}

// ─────────────────────────────────────────────
// GET /api/dashboard/summary
// ─────────────────────────────────────────────
router.get("/dashboard/summary", async (req, res) => {
  const [bankroll, agentStatus, allSettled, allPending] = await Promise.all([
    getBankroll(),
    getAgentStatus(),
    getSettledBetsStats(),
    db
      .select({
        id: paperBetsTable.id,
        stake: paperBetsTable.stake,
        opportunityScore: paperBetsTable.opportunityScore,
      })
      .from(paperBetsTable)
      .where(eq(paperBetsTable.status, "pending")),
  ]);

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

  // Today P&L
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayPnl = allSettled
    .filter((b) => b.settledAt && new Date(b.settledAt) >= todayStart)
    .reduce((sum, b) => sum + Number(b.settlementPnl ?? 0), 0);

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

  res.json({
    currentBankroll: Math.round(bankroll * 100) / 100,
    startingBankroll: STARTING_BANKROLL,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalPnlPct:
      totalStake > 0
        ? Math.round((totalPnl / totalStake) * 10000) / 100
        : 0,
    agentStatus,
    totalBets: total,
    wins,
    losses,
    voids,
    pending: allPending.length,
    winPercentage:
      wins + losses > 0
        ? Math.round((wins / (wins + losses)) * 10000) / 100
        : 0,
    overallRoiPct:
      totalStake > 0
        ? Math.round((totalPnl / totalStake) * 10000) / 100
        : 0,
    todayPnl: Math.round(todayPnl * 100) / 100,
    thisWeekPnl: Math.round(weekPnl * 100) / 100,
    activeBetsCount: allPending.length,
    avgOpportunityScore,
  });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/performance
// ─────────────────────────────────────────────
router.get("/dashboard/performance", async (req, res) => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 30);
  since.setUTCHours(0, 0, 0, 0);

  const settled = await db
    .select({
      settledAt: paperBetsTable.settledAt,
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
    })
    .from(paperBetsTable)
    .where(
      and(
        inArray(paperBetsTable.status, ["won", "lost"]),
        gte(paperBetsTable.settledAt, since),
      ),
    )
    .orderBy(asc(paperBetsTable.settledAt));

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

  res.json({ dailyPnl, cumulativeProfit: cumulative, weeklyWinRate });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/bets/by-league  (before /:id or ?page style)
// ─────────────────────────────────────────────
router.get("/dashboard/bets/by-league", async (req, res) => {
  const settled = await db
    .select({
      league: matchesTable.league,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(inArray(paperBetsTable.status, ["won", "lost"]));

  const groups = new Map<
    string,
    { wins: number; losses: number; stake: number; pnl: number }
  >();

  for (const bet of settled) {
    const key = bet.league;
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
// GET /api/dashboard/bets/by-market
// ─────────────────────────────────────────────
router.get("/dashboard/bets/by-market", async (req, res) => {
  const settled = await db
    .select({
      marketType: paperBetsTable.marketType,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
    })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost"]));

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
  );
  const statusFilter = String(req.query["status"] ?? "all");

  const baseConditions =
    statusFilter === "all" || !statusFilter
      ? undefined
      : eq(paperBetsTable.status, statusFilter);

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
      })
      .from(paperBetsTable)
      .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
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
    })),
  });
});

// ─────────────────────────────────────────────
// GET /api/dashboard/viability
// ─────────────────────────────────────────────
router.get("/dashboard/viability", async (req, res) => {
  const allSettled = await db
    .select({
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      calculatedEdge: paperBetsTable.calculatedEdge,
      placedAt: paperBetsTable.placedAt,
      settledAt: paperBetsTable.settledAt,
    })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost"]))
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

  // Weekly volume at current stake
  const weeklyVolume = avgStake * betsPerWeek;

  // Projected monthly profits (4 weeks)
  const monthlyProfitOptimistic =
    (weeklyVolume * (avgRoiPerBet / 100)) * 4;
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
  "max_concurrent_bets",
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
// GET /api/dashboard/api-budget
// ─────────────────────────────────────────────
router.get("/dashboard/api-budget", async (_req, res) => {
  const budget = await getApiBudgetStatus();
  res.json(budget);
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
    const rows = await db
      .select({
        clvPct: paperBetsTable.clvPct,
        placedAt: paperBetsTable.placedAt,
        marketType: paperBetsTable.marketType,
        status: paperBetsTable.status,
        pinnacleOdds: paperBetsTable.pinnacleOdds,
        isContrarian: paperBetsTable.isContrarian,
      })
      .from(paperBetsTable)
      .where(
        and(
          sql`${paperBetsTable.clvPct} IS NOT NULL`,
          sql`${paperBetsTable.status} IN ('won','lost')`,
        ),
      )
      .orderBy(asc(paperBetsTable.placedAt))
      .limit(200);

    if (rows.length === 0) {
      return res.json({ count: 0, avgClv: null, trend: [] });
    }

    const clvValues = rows.map((r) => Number(r.clvPct));
    const avgClv = clvValues.reduce((a, b) => a + b, 0) / clvValues.length;
    const pinnacleCount = rows.filter((r) => r.pinnacleOdds != null).length;
    const contrarianCount = rows.filter((r) => r.isContrarian === "true").length;

    const trend = rows.map((r) => ({
      date: new Date(r.placedAt).toISOString().slice(0, 10),
      clv: Number(r.clvPct),
      market: r.marketType,
    }));

    res.json({
      count: rows.length,
      avgClv: Math.round(avgClv * 1000) / 1000,
      pinnacleCount,
      contrarianCount,
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

export default router;
