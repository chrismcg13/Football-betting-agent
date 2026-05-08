import {
  db,
  matchesTable,
  oddsSnapshotsTable,
  featuresTable,
  complianceLogsTable,
  agentConfigTable,
  paperBetsTable,
  learningNarrativesTable,
  leagueEdgeScoresTable,
  competitionConfigTable,
  experimentRegistryTable,
} from "@workspace/db";
import { eq, desc, and, gte, lte, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sqlIntList } from "../lib/dbHelpers";
import { ensureExperimentRegistered, getExperimentTier } from "./promotionEngine";
import { MARKET_TYPE_MAP } from "./betfairLive";

// Sub-phase 4.B (2026-05-08): set of internal market type keys that have
// a Betfair Exchange placement path. Pricing pipeline uses this to decide
// whether to allow Pinnacle-as-actionable shadow capture for markets
// without an exchange odds row. Markets not in this set are still rejected
// at the pricing gate so we don't write dead-end shadow rows.
const MARKET_TYPE_MAP_KEYS: Set<string> = new Set(Object.keys(MARKET_TYPE_MAP));
import {
  predictOutcome,
  predictBtts,
  predictOverUnder,
  predictCards,
  predictCorners,
  predictDrawNoBet,
  predictTeamTotalGoals,
  predictWinToNil,
  predictOddEven,
  predictAsianHandicap,
  predictHtFt,
  predictBttsHalf,
  predictSecondHalfResult,
  predictAsianTotalGoals,
  getModelVersion,
} from "./predictionEngine";
import { shouldBlockBet, getSoftLineBonus, detectSeasonalPhase } from "./tournamentMode";
import { commissionAdjustedEV, getCommissionRate } from "./commissionService";

export interface ValueBet {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoffTime: Date;
  marketType: string;
  selectionName: string;
  modelProbability: number;
  impliedProbability: number;
  edge: number;
  backOdds: number;
  modelVersion: string | null;
  opportunityScore: number;
  oddsSource: string;
  segmentBetCount: number;
  segmentRoi: number;
  hotStreakBonus: number;
  experimentTag: string;
  dataTier: string;
  opportunityBoosted: boolean;
  originalOpportunityScore: number;
  boostedOpportunityScore: number;
  syncEligible: boolean;
  // Pricing-pipeline fix (Prompt 5): the price we will place on, the sharp
  // consensus reference, and which sources each came from. actionablePrice
  // is always sourced from betfair_exchange. fairValueOdds is the highest-
  // priority sharp source available (oddspapi_pinnacle > AF Pinnacle > exchange).
  actionablePrice: number;
  actionableSource: string;
  fairValueOdds: number;
  fairValueSource: string;
  // B1+B2 (2026-05-07): every positive-EV opportunity is captured. Tier A bets
  // meeting full production thresholds (min_opportunity_score / min_edge_threshold)
  // route to the real-stake rail; everything else (Tier A near-misses + any Tier
  // B/C bet) routes to shadow at £0 stake. The placement track is decided here
  // so paperTrading.ts can branch deterministically.
  placementTrack: "production" | "shadow";
}

export interface EvaluationSummary {
  matchesEvaluated: number;
  selectionsEvaluated: number;
  valueBetsFound: number;
  modelVersion: string | null;
  valueBets: ValueBet[];
  realOddsCount: number;
  syntheticOddsCount: number;
  byMarketType: Record<string, number>;
  // Pricing-pipeline rejection counters (Prompt 5)
  pricingRejectNoBetfairExchange: number;
  pricingRejectNoFairValueSource: number;
}

// ─── Segment stats ────────────────────────────────────────────────────────────

interface SegmentStats {
  betCount: number;
  wins: number;
  losses: number;
  totalPnl: number;
  roi: number;
}

async function getSegmentStats(
  league: string,
  marketType: string,
): Promise<SegmentStats> {
  const leagueSettled = await db
    .select({
      id: paperBetsTable.id,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(matchesTable.league, league),
        eq(paperBetsTable.marketType, marketType),
      ),
    );

  const finalBets = leagueSettled.filter(
    (b) => b.status === "won" || b.status === "lost",
  );
  if (finalBets.length === 0) {
    return { betCount: 0, wins: 0, losses: 0, totalPnl: 0, roi: 0 };
  }

  const wins = finalBets.filter((b) => b.status === "won").length;
  const losses = finalBets.filter((b) => b.status === "lost").length;
  const totalPnl = finalBets.reduce(
    (sum, b) => sum + Number(b.settlementPnl ?? 0),
    0,
  );
  const totalStake = finalBets.reduce(
    (sum, b) => sum + Number(b.stake ?? 0),
    0,
  );
  const roi = totalStake > 0 ? (totalPnl / totalStake) * 100 : 0;

  return { betCount: finalBets.length, wins, losses, totalPnl, roi };
}

// ─── League edge score lookup ─────────────────────────────────────────────────

const leagueEdgeCache = new Map<string, { score: number; fetchedAt: number }>();

export async function getLeagueEdgeScore(league: string): Promise<number> {
  const cached = leagueEdgeCache.get(league);
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
    return cached.score;
  }
  const rows = await db
    .select({ confidenceScore: leagueEdgeScoresTable.confidenceScore })
    .from(leagueEdgeScoresTable)
    .where(eq(leagueEdgeScoresTable.league, league))
    .limit(1);
  const score = rows[0]?.confidenceScore ?? 50;
  leagueEdgeCache.set(league, { score, fetchedAt: Date.now() });
  return score;
}

// ─── Cold-market exclusion ────────────────────────────────────────────────────

interface ColdMarketEntry { excludedUntil: Date }
const coldMarketCache = new Map<string, ColdMarketEntry>();

async function isColdMarket(
  league: string,
  marketType: string,
  stats: SegmentStats,
  minBets: number,
  threshold: number,
  cooldownDays: number,
): Promise<boolean> {
  const key = `${league}::${marketType}`;
  const cached = coldMarketCache.get(key);
  if (cached) {
    if (new Date() < cached.excludedUntil) return true;
    coldMarketCache.delete(key);
  }

  if (stats.betCount >= minBets && stats.roi < threshold) {
    const excludedUntil = new Date();
    excludedUntil.setDate(excludedUntil.getDate() + cooldownDays);
    coldMarketCache.set(key, { excludedUntil });

    await db.insert(learningNarrativesTable).values({
      narrativeType: "strategy_shift",
      narrativeText: `Pausing ${league} ${marketType} after ${stats.betCount} bets at ${stats.roi.toFixed(1)}% ROI. Reassessing in ${cooldownDays} days.`,
      relatedData: { league, marketType, betCount: stats.betCount, roi: stats.roi, excludedUntil },
      createdAt: new Date(),
    });
    await db.insert(complianceLogsTable).values({
      actionType: "decision",
      details: { action: "cold_market_excluded", league, marketType, betCount: stats.betCount, roi: stats.roi, excludedUntil },
      timestamp: new Date(),
    });
    logger.warn({ league, marketType, roi: stats.roi }, "Cold market excluded");
    return true;
  }
  return false;
}

// ─── Hot streak detection ─────────────────────────────────────────────────────

const hotStreakNotified = new Set<string>();

async function getHotStreakBonus(
  league: string,
  marketType: string,
  hotStreakWeeks: number,
  minBetsPerWeek: number,
  bonus: number,
): Promise<number> {
  const weeksAgo = new Date();
  weeksAgo.setDate(weeksAgo.getDate() - hotStreakWeeks * 7);

  const recentBets = await db
    .select({ stake: paperBetsTable.stake, settlementPnl: paperBetsTable.settlementPnl, status: paperBetsTable.status, settledAt: paperBetsTable.settledAt })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(and(eq(matchesTable.league, league), eq(paperBetsTable.marketType, marketType), gte(paperBetsTable.settledAt, weeksAgo)));

  const finalBets = recentBets.filter((b) => b.status === "won" || b.status === "lost");
  if (finalBets.length === 0) return 0;

  const weekMap = new Map<string, { bets: number; pnl: number }>();
  for (const b of finalBets) {
    if (!b.settledAt) continue;
    const d = new Date(b.settledAt);
    const dayOfWeek = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((dayOfWeek + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    const entry = weekMap.get(key) ?? { bets: 0, pnl: 0 };
    entry.bets++;
    entry.pnl += Number(b.settlementPnl ?? 0);
    weekMap.set(key, entry);
  }

  const weeks = [...weekMap.values()];
  const profitableWeeks = weeks.filter((w) => w.bets >= minBetsPerWeek && w.pnl > 0);

  if (profitableWeeks.length >= hotStreakWeeks) {
    const streakKey = `${league}::${marketType}`;
    if (!hotStreakNotified.has(streakKey)) {
      hotStreakNotified.add(streakKey);
      await db.insert(learningNarrativesTable).values({
        narrativeType: "sustained_positive_edge",
        narrativeText: `Hot streak: ${league} ${marketType} profitable for ${profitableWeeks.length} consecutive weeks. Boosting opportunity score by ${bonus} points.`,
        relatedData: { league, marketType, weeks: profitableWeeks.length, bonus },
        createdAt: new Date(),
      });
    }
    return bonus;
  }

  hotStreakNotified.delete(`${league}::${marketType}`);
  return 0;
}

// ─── Opportunity scoring (revised formula) ────────────────────────────────────

const DERIVED_MARKETS = new Set(["DOUBLE_CHANCE", "FIRST_HALF_RESULT"]);

function computeOpportunityScore(params: {
  edge: number;
  modelProbability: number;
  backOdds: number;
  segmentStats: SegmentStats;
  hotStreakBonus: number;
  isSynthetic: boolean;
  leagueEdgeScore?: number;
  marketSpread?: number;
  bookmakerCount?: number;
  marketType?: string;
  constituentMaxConfidence?: number;
}): number {
  const { edge, modelProbability, backOdds, segmentStats, hotStreakBonus, isSynthetic, leagueEdgeScore, marketSpread, bookmakerCount, marketType, constituentMaxConfidence } = params;
  const isDerived = marketType ? DERIVED_MARKETS.has(marketType) : false;

  const effectiveEdge = isDerived ? edge * 0.55 : edge;

  const edgeScore = Math.min((effectiveEdge / 0.15) * 25, 25);

  let confidenceScore: number;
  if (isDerived && constituentMaxConfidence !== undefined) {
    confidenceScore = Math.min(constituentMaxConfidence * 50, 15);
  } else {
    confidenceScore = Math.min(Math.abs(modelProbability - 0.5) * 50, 25);
  }

  let segmentScore = 0;
  if (segmentStats.betCount >= 3 && segmentStats.roi > 0) {
    segmentScore = Math.min(segmentStats.roi, 20);
  }

  const reliabilityScore = Math.min(segmentStats.betCount / 20, 1) * 15;

  let oddsScore = 0;
  if (backOdds >= 1.9 && backOdds <= 3.2) oddsScore = 15;
  else if ((backOdds >= 1.5 && backOdds < 1.9) || (backOdds > 3.2 && backOdds <= 4.5)) oddsScore = 8;

  const leagueBonus = leagueEdgeScore !== undefined
    ? Math.max(-10, Math.min(10, (leagueEdgeScore - 50) / 5))
    : 0;

  let marketSpreadBonus = 0;
  if (marketSpread !== undefined && marketSpread > 0) {
    const bmFactor = Math.min((bookmakerCount ?? 3) / 5, 1);
    marketSpreadBonus = Math.min(marketSpread * 80 * bmFactor, 8);
  }

  const raw = edgeScore + confidenceScore + segmentScore + reliabilityScore + oddsScore + hotStreakBonus + leagueBonus + marketSpreadBonus;
  const score = Math.min(Math.round(raw * 100) / 100, 100);

  if (isSynthetic) return Math.min(score, 55);

  return score;
}

const leagueIdCache = new Map<string, number>();

async function getLeagueIdForMatch(leagueName: string): Promise<number> {
  if (leagueIdCache.has(leagueName)) return leagueIdCache.get(leagueName)!;
  try {
    const { competitionConfigTable } = await import("@workspace/db");
    const rows = await db
      .select({ apiFootballId: competitionConfigTable.apiFootballId })
      .from(competitionConfigTable)
      .where(eq(competitionConfigTable.name, leagueName))
      .limit(1);
    const id = rows.length > 0 ? rows[0]!.apiFootballId : 0;
    leagueIdCache.set(leagueName, id);
    return id;
  } catch {
    return 0;
  }
}

const DISCOVERY_LEAGUES = new Set([
  "EFL League One", "EFL League Two",
  "South Africa PSL", "Saudi Pro League", "Ukrainian Premier League",
  "CONMEBOL Libertadores", "Europa League", "Norwegian Eliteserien",
]);

const discoveryBetCounts: Map<string, number> = new Map();
let discoveryCountsLoaded = false;

async function getDiscoveryBonus(league: string): Promise<number> {
  if (!DISCOVERY_LEAGUES.has(league)) return 0;

  if (!discoveryCountsLoaded) {
    const rows = await db
      .select({ league: matchesTable.league, cnt: sql<number>`count(*)` })
      .from(paperBetsTable)
      .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
      .where(sql`${matchesTable.league} IN (${sql.join(
        [...DISCOVERY_LEAGUES].map(l => sql`${l}`), sql`, `
      )})`)
      .groupBy(matchesTable.league);
    for (const r of rows) {
      discoveryBetCounts.set(r.league, Number(r.cnt));
    }
    discoveryCountsLoaded = true;
  }

  const count = discoveryBetCounts.get(league) ?? 0;
  if (count >= 10) return 0;
  return Math.round((10 - count) * 3);
}

// ─── Synthetic odds generator (fallback only — capped at score 55) ────────────

interface SyntheticOddsRow {
  marketType: string;
  selectionName: string;
  backOdds: number;
  source: "synthetic";
}

function poissonCdf(lambda: number, k: number): number {
  let p = 0, fac = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) fac *= i;
    p += (Math.pow(lambda, i) * Math.exp(-lambda)) / fac;
  }
  return p;
}

function generateSyntheticOdds(featureMap: Record<string, number>): SyntheticOddsRow[] {
  const VIG = 1.07;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  const homeForm = featureMap["home_form_last5"] ?? 0.4;
  const awayForm = featureMap["away_form_last5"] ?? 0.35;
  const homeScoredAvg = featureMap["home_goals_scored_avg"] ?? 1.5;
  const awayScoredAvg = featureMap["away_goals_scored_avg"] ?? 1.2;
  const homeConcededAvg = featureMap["home_goals_conceded_avg"] ?? 1.2;
  const awayConcededAvg = featureMap["away_goals_conceded_avg"] ?? 1.5;

  const homeStrength = clamp(homeForm + 0.08, 0.05, 0.9);
  const awayStrength = clamp(awayForm, 0.05, 0.85);
  const rawDraw = clamp(0.28 - 0.15 * Math.abs(homeStrength - awayStrength), 0.05, 0.4);
  const total = homeStrength + awayStrength + rawDraw;
  const homeProb = homeStrength / total;
  const drawProb = rawDraw / total;
  const awayProb = awayStrength / total;

  const expHome = clamp((homeScoredAvg + awayConcededAvg) / 2, 0.3, 5);
  const expAway = clamp((awayScoredAvg + homeConcededAvg) / 2, 0.3, 5);
  const pHomeSc = 1 - Math.exp(-expHome);
  const pAwaySc = 1 - Math.exp(-expAway);
  const bttsYesProb = clamp(pHomeSc * pAwaySc, 0.05, 0.95);
  const totalLambda = expHome + expAway;
  const under25Prob = clamp(poissonCdf(totalLambda, 2), 0.05, 0.95);
  const over25Prob = 1 - under25Prob;

  return [
    { marketType: "MATCH_ODDS", selectionName: "Home", backOdds: clamp((1 / homeProb) / VIG, 1.05, 20), source: "synthetic" },
    { marketType: "MATCH_ODDS", selectionName: "Draw", backOdds: clamp((1 / drawProb) / VIG, 1.05, 20), source: "synthetic" },
    { marketType: "MATCH_ODDS", selectionName: "Away", backOdds: clamp((1 / awayProb) / VIG, 1.05, 20), source: "synthetic" },
    { marketType: "BTTS", selectionName: "Yes", backOdds: clamp((1 / bttsYesProb) / VIG, 1.05, 20), source: "synthetic" },
    { marketType: "BTTS", selectionName: "No", backOdds: clamp((1 / (1 - bttsYesProb)) / VIG, 1.05, 20), source: "synthetic" },
    { marketType: "OVER_UNDER_25", selectionName: "Over 2.5 Goals", backOdds: clamp((1 / over25Prob) / VIG, 1.05, 20), source: "synthetic" },
    { marketType: "OVER_UNDER_25", selectionName: "Under 2.5 Goals", backOdds: clamp((1 / under25Prob) / VIG, 1.05, 20), source: "synthetic" },
  ];
}

// ─── Model probability dispatcher ────────────────────────────────────────────

// Pre-process feature map: substitute xg_proxy for missing goal averages
// This prevents Poisson models from using lambda=0 when goals data isn't yet loaded
function enrichFeaturesWithXgProxy(raw: Record<string, number>): Record<string, number> {
  const m = { ...raw };
  if ((m["home_goals_scored_avg"] ?? 0) < 0.3) {
    m["home_goals_scored_avg"] = m["home_xg_proxy"] ?? 1.2;
  }
  if ((m["away_goals_scored_avg"] ?? 0) < 0.3) {
    m["away_goals_scored_avg"] = m["away_xg_proxy"] ?? 1.1;
  }
  if ((m["home_goals_conceded_avg"] ?? 0) < 0.3) {
    m["home_goals_conceded_avg"] = m["away_xg_proxy"] ?? 1.1;
  }
  if ((m["away_goals_conceded_avg"] ?? 0) < 0.3) {
    m["away_goals_conceded_avg"] = m["home_xg_proxy"] ?? 1.2;
  }
  // Derive over25/btts rates from xg-based lambda if still at default 0.5
  const homeLambda = m["home_goals_scored_avg"]!;
  const awayLambda = m["away_goals_scored_avg"]!;
  const totalLambda = homeLambda + awayLambda;
  // Only override if still at exactly 0.5 (unset default) — don't override real data
  if (m["home_over25_rate"] === 0.5 && m["away_over25_rate"] === 0.5) {
    const under25 = poissonCdf(totalLambda, 2);
    m["home_over25_rate"] = Math.max(0.1, Math.min(0.9, 1 - under25));
    m["away_over25_rate"] = m["home_over25_rate"];
  }
  return m;
}

function getModelProbability(
  marketType: string,
  selectionName: string,
  featureMap: Record<string, number>,
): number | null {
  // Substitute xg_proxy for zero goal averages before feeding models
  const enriched = enrichFeaturesWithXgProxy(featureMap);
  const outcomePreds = predictOutcome(enriched);
  const bttsPreds = predictBtts(enriched);
  const ouPreds = predictOverUnder(enriched);
  const cardsPreds = predictCards(enriched);
  const cornersPreds = predictCorners(enriched);

  if (marketType === "MATCH_ODDS" && outcomePreds) {
    if (selectionName === "Home") return outcomePreds.home;
    if (selectionName === "Draw") return outcomePreds.draw;
    if (selectionName === "Away") return outcomePreds.away;
  }
  if (marketType === "BTTS" && bttsPreds) {
    if (selectionName === "Yes") return bttsPreds.yes;
    if (selectionName === "No") return bttsPreds.no;
  }
  if ((marketType === "OVER_UNDER_25" || marketType === "OVER_UNDER") && ouPreds) {
    if (selectionName.startsWith("Over")) return ouPreds.over;
    if (selectionName.startsWith("Under")) return ouPreds.under;
  }
  if (marketType === "OVER_UNDER_15" && ouPreds) {
    // enriched already has xg_proxy substituted for zero goals
    const homeGoals = enriched["home_goals_scored_avg"] ?? 1.2;
    const awayGoals = enriched["away_goals_scored_avg"] ?? 1.1;
    const lambda = homeGoals + awayGoals;
    const p0 = Math.exp(-lambda);
    const p1 = lambda * Math.exp(-lambda);
    const under15 = Math.max(0.01, Math.min(0.99, p0 + p1));
    if (selectionName.startsWith("Over")) return 1 - under15;
    if (selectionName.startsWith("Under")) return under15;
  }
  if (marketType === "OVER_UNDER_35" && ouPreds) {
    const homeGoals = enriched["home_goals_scored_avg"] ?? 1.2;
    const awayGoals = enriched["away_goals_scored_avg"] ?? 1.1;
    const lambda = homeGoals + awayGoals;
    const under35 = Math.max(0.01, Math.min(0.99, poissonCdf(lambda, 3)));
    if (selectionName.startsWith("Over")) return 1 - under35;
    if (selectionName.startsWith("Under")) return under35;
  }
  if (marketType === "TOTAL_CARDS_35" && cardsPreds) {
    if (selectionName.startsWith("Over")) return cardsPreds.over35;
    if (selectionName.startsWith("Under")) return cardsPreds.under35;
  }
  if (marketType === "TOTAL_CARDS_45" && cardsPreds) {
    if (selectionName.startsWith("Over")) return cardsPreds.over45;
    if (selectionName.startsWith("Under")) return cardsPreds.under45;
  }
  if (marketType === "TOTAL_CORNERS_95" && cornersPreds) {
    if (selectionName.startsWith("Over")) return cornersPreds.over95;
    if (selectionName.startsWith("Under")) return cornersPreds.under95;
  }
  if (marketType === "TOTAL_CORNERS_105" && cornersPreds) {
    if (selectionName.startsWith("Over")) return cornersPreds.over105;
    if (selectionName.startsWith("Under")) return cornersPreds.under105;
  }
  if (marketType === "TOTAL_CORNERS_85" && cornersPreds) {
    const lambda = (enriched["home_corners_avg"] ?? 5.0) + (enriched["away_corners_avg"] ?? 4.5);
    const under85 = Math.max(0.01, Math.min(0.99, poissonCdf(lambda, 8)));
    if (selectionName.startsWith("Over")) return 1 - under85;
    if (selectionName.startsWith("Under")) return under85;
  }
  if (marketType === "TOTAL_CORNERS_115" && cornersPreds) {
    const lambda = (enriched["home_corners_avg"] ?? 5.0) + (enriched["away_corners_avg"] ?? 4.5);
    const under115 = Math.max(0.01, Math.min(0.99, poissonCdf(lambda, 11)));
    if (selectionName.startsWith("Over")) return 1 - under115;
    if (selectionName.startsWith("Under")) return under115;
  }
  // Over/Under 0.5 goals
  if (marketType === "OVER_UNDER_05") {
    const homeGoals = enriched["home_goals_scored_avg"] ?? 1.2;
    const awayGoals = enriched["away_goals_scored_avg"] ?? 1.1;
    const lambda = homeGoals + awayGoals;
    const under05 = Math.max(0.01, Math.min(0.99, Math.exp(-lambda))); // P(0 goals)
    if (selectionName.startsWith("Over")) return 1 - under05;
    if (selectionName.startsWith("Under")) return under05;
  }
  // Over/Under 4.5 goals
  if (marketType === "OVER_UNDER_45") {
    const homeGoals = enriched["home_goals_scored_avg"] ?? 1.2;
    const awayGoals = enriched["away_goals_scored_avg"] ?? 1.1;
    const lambda = homeGoals + awayGoals;
    const under45 = Math.max(0.01, Math.min(0.99, poissonCdf(lambda, 4)));
    if (selectionName.startsWith("Over")) return 1 - under45;
    if (selectionName.startsWith("Under")) return under45;
  }
  // Double Chance — derived from match winner probabilities
  if (marketType === "DOUBLE_CHANCE" && outcomePreds) {
    if (selectionName === "1X") return Math.min(0.98, outcomePreds.home + outcomePreds.draw);
    if (selectionName === "X2") return Math.min(0.98, outcomePreds.draw + outcomePreds.away);
    if (selectionName === "12") return Math.min(0.98, outcomePreds.home + outcomePreds.away);
  }
  // First Half Result — scaled from full-match outcome (halves closer to 50/50)
  if (marketType === "FIRST_HALF_RESULT" && outcomePreds) {
    const scale = 0.7; // first half probabilities converge toward uniform
    const mean = 1 / 3;
    if (selectionName === "Home") return Math.max(0.05, Math.min(0.85, mean + (outcomePreds.home - mean) * scale));
    if (selectionName === "Draw") return Math.max(0.15, Math.min(0.75, mean + (outcomePreds.draw - mean) * scale));
    if (selectionName === "Away") return Math.max(0.05, Math.min(0.85, mean + (outcomePreds.away - mean) * scale));
  }
  // First Half O/U 0.5 goals
  if (marketType === "FIRST_HALF_OU_05") {
    const homeGoals = enriched["home_goals_scored_avg"] ?? 1.2;
    const awayGoals = enriched["away_goals_scored_avg"] ?? 1.1;
    const halfLambda = (homeGoals + awayGoals) * 0.45; // roughly 45% of goals in first half
    const under05 = Math.max(0.01, Math.min(0.99, Math.exp(-halfLambda)));
    if (selectionName.startsWith("Over")) return 1 - under05;
    if (selectionName.startsWith("Under")) return under05;
  }
  // First Half O/U 1.5 goals
  if (marketType === "FIRST_HALF_OU_15") {
    const homeGoals = enriched["home_goals_scored_avg"] ?? 1.2;
    const awayGoals = enriched["away_goals_scored_avg"] ?? 1.1;
    const halfLambda = (homeGoals + awayGoals) * 0.45;
    const under15 = Math.max(0.01, Math.min(0.99, poissonCdf(halfLambda, 1)));
    if (selectionName.startsWith("Over")) return 1 - under15;
    if (selectionName.startsWith("Under")) return under15;
  }
  // Cards 2.5 and 5.5
  if (marketType === "TOTAL_CARDS_25" && cardsPreds) {
    const lambda = (enriched["home_yellow_cards_avg"] ?? 2.0) + (enriched["away_yellow_cards_avg"] ?? 2.0);
    const under25 = Math.max(0.01, Math.min(0.99, poissonCdf(lambda, 2)));
    if (selectionName.startsWith("Over")) return 1 - under25;
    if (selectionName.startsWith("Under")) return under25;
  }
  if (marketType === "TOTAL_CARDS_55" && cardsPreds) {
    const lambda = (enriched["home_yellow_cards_avg"] ?? 2.0) + (enriched["away_yellow_cards_avg"] ?? 2.0);
    const under55 = Math.max(0.01, Math.min(0.99, poissonCdf(lambda, 5)));
    if (selectionName.startsWith("Over")) return 1 - under55;
    if (selectionName.startsWith("Under")) return under55;
  }
  // ─── C1 (2026-05-07): TIER S free markets — derived from existing models ───
  // Draw No Bet — pure renormalisation of MATCH_ODDS over (home, away).
  if (marketType === "DRAW_NO_BET") {
    const dnb = predictDrawNoBet(enriched);
    if (!dnb) return null;
    if (selectionName === "Home") return dnb.home;
    if (selectionName === "Away") return dnb.away;
  }
  // Win-to-Nil (each side) — joint Poisson scoreline.
  if (marketType === "WIN_TO_NIL_HOME") {
    const p = predictWinToNil(enriched, "home");
    if (p == null) return null;
    if (selectionName === "Yes") return p;
    if (selectionName === "No") return 1 - p;
  }
  if (marketType === "WIN_TO_NIL_AWAY") {
    const p = predictWinToNil(enriched, "away");
    if (p == null) return null;
    if (selectionName === "Yes") return p;
    if (selectionName === "No") return 1 - p;
  }
  // Goals odd/even — closed-form Poisson identity.
  if (marketType === "GOALS_ODD_EVEN") {
    const oe = predictOddEven(enriched);
    if (!oe) return null;
    if (selectionName === "Odd") return oe.odd;
    if (selectionName === "Even") return oe.even;
  }
  // Over/Under high lines — Poisson over total scoring rate.
  if (marketType === "OVER_UNDER_55" || marketType === "OVER_UNDER_65") {
    const homeGoals = enriched["home_goals_scored_avg"] ?? 1.2;
    const awayGoals = enriched["away_goals_scored_avg"] ?? 1.1;
    const lambda = homeGoals + awayGoals;
    const k = marketType === "OVER_UNDER_55" ? 5 : 6;
    const under = Math.max(0.01, Math.min(0.99, poissonCdf(lambda, k)));
    if (selectionName.startsWith("Over")) return 1 - under;
    if (selectionName.startsWith("Under")) return under;
  }
  // Team-total goals — per-side Poisson.
  if (marketType.startsWith("TEAM_TOTAL_HOME_") || marketType.startsWith("TEAM_TOTAL_AWAY_")) {
    const side = marketType.startsWith("TEAM_TOTAL_HOME_") ? "home" : "away";
    const lineSuffix = marketType.split("_").pop()!;        // "05" | "15" | "25" | "35"
    const t = lineSuffix === "05" ? 0.5
            : lineSuffix === "15" ? 1.5
            : lineSuffix === "25" ? 2.5
            : lineSuffix === "35" ? 3.5
            : null;
    if (t == null) return null;
    const tt = predictTeamTotalGoals(enriched, side, t);
    if (!tt) return null;
    if (selectionName.startsWith("Over")) return tt.over;
    if (selectionName.startsWith("Under")) return tt.under;
  }
  // ─── C2 (2026-05-07): Asian Handicap — Poisson scoreline ───────────────────
  // Selection format: "Home -1.5", "Away +0.25", etc. Parse line from name.
  if (marketType === "ASIAN_HANDICAP") {
    const m = selectionName.match(/^(Home|Away)\s+([-+]?[\d.]+)$/);
    if (!m) return null;
    const side = m[1].toLowerCase() as "home" | "away";
    const line = parseFloat(m[2]);
    if (!Number.isFinite(line)) return null;
    return predictAsianHandicap(enriched, side, line);
  }
  // ─── C4 (2026-05-07): Half-Time / Full-Time joint outcome ──────────────────
  // Selection format: "Home/Home", "Home/Draw", ..., "Away/Away".
  if (marketType === "HALF_TIME_FULL_TIME") {
    const htft = predictHtFt(enriched);
    if (!htft) return null;
    return htft[selectionName] ?? null;
  }
  // ─── C4: BTTS in first / second half ────────────────────────────────────────
  if (marketType === "BTTS_FIRST_HALF") {
    const r = predictBttsHalf(enriched, "first");
    if (!r) return null;
    if (selectionName === "Yes") return r.yes;
    if (selectionName === "No") return r.no;
  }
  if (marketType === "BTTS_SECOND_HALF") {
    const r = predictBttsHalf(enriched, "second");
    if (!r) return null;
    if (selectionName === "Yes") return r.yes;
    if (selectionName === "No") return r.no;
  }
  // ─── C4: 2nd-half 1X2 — Poisson on second-half-only goal lambdas ──────────
  if (marketType === "SECOND_HALF_RESULT") {
    const r = predictSecondHalfResult(enriched);
    if (!r) return null;
    if (selectionName === "Home") return r.home;
    if (selectionName === "Draw") return r.draw;
    if (selectionName === "Away") return r.away;
  }
  // ─── C4: Asian Total Goals (quarter lines) ─────────────────────────────────
  // Selection format: "Over 2.75", "Under 2.25", etc. Parse line from name.
  if (marketType.startsWith("ASIAN_GOALS_")) {
    const m = selectionName.match(/^(Over|Under)\s+([\d.]+)$/);
    if (!m) return null;
    const side = m[1].toLowerCase() as "over" | "under";
    const line = parseFloat(m[2]);
    if (!Number.isFinite(line)) return null;
    return predictAsianTotalGoals(enriched, side, line);
  }
  return null;
}

// ─── Enhanced opportunity scoring (OddsPapi-validated bets) ──────────────────

export interface EnhancedScoringParams {
  edge: number;
  modelProbability: number;
  backOdds: number;
  segmentBetCount: number;
  segmentRoi: number;
  hotStreakBonus: number;
  pinnacleImplied: number | null;
  sharpSoftSpread: number | null;
  oddsUpliftPct: number | null;
}

export interface EnhancedScoringResult {
  score: number;
  isContrarian: boolean;
  pinnacleAligned: boolean;
}

export function computeEnhancedOpportunityScore(params: EnhancedScoringParams): EnhancedScoringResult {
  const { edge, modelProbability, backOdds, segmentBetCount, segmentRoi, hotStreakBonus,
          pinnacleImplied, sharpSoftSpread, oddsUpliftPct } = params;

  // 1. Edge size using BEST available odds: (edge / 0.12) × 20, cap 20
  const edgeScore = Math.min((edge / 0.12) * 20, 20);

  // 2. Model confidence: abs(prob - 0.5) × 50, cap 18
  const confidenceScore = Math.min(Math.abs(modelProbability - 0.5) * 50, 18);

  // 3. Pinnacle alignment
  let pinnacleScore = 0;
  let isContrarian = false;
  let pinnacleAligned = false;

  if (pinnacleImplied !== null) {
    const diff = modelProbability - pinnacleImplied;
    // Positive diff = model more optimistic than Pinnacle (contrarian lean)
    // Negative diff = Pinnacle more bullish than model (Pinnacle-backed)
    if (diff < 0) {
      // Pinnacle is more bullish — sharp line agrees our selection has value
      pinnacleAligned = true;
      pinnacleScore = 15;
    } else if (Math.abs(diff) <= 0.03) {
      // Very close — within 3%, effectively aligned
      pinnacleAligned = true;
      pinnacleScore = 10;
    } else if (diff > 0.08) {
      // Model well above Pinnacle — contrarian bet
      isContrarian = true;
      pinnacleScore = -10;
    }
    // 3-8% divergence: neutral (0 points)
  }

  // 4. Sharp-soft spread: min(spread × 200, 12)
  const spreadScore = sharpSoftSpread !== null ? Math.min(sharpSoftSpread * 200, 12) : 0;

  // 5. Best-odds uplift
  let upliftScore = 0;
  if (oddsUpliftPct !== null) {
    if (oddsUpliftPct >= 10) upliftScore = 12;
    else if (oddsUpliftPct >= 5) upliftScore = 8;
  }

  // 6. Historical segment ROI: if positive history, up to +13
  let segmentScore = 0;
  if (segmentBetCount >= 3 && segmentRoi > 0) {
    segmentScore = Math.min(segmentRoi * 0.65, 13);
  }

  // 7. Odds sweet spot: 1.9–3.2 → +10, 1.5–1.9 or 3.2–4.5 → +5
  let oddsScore = 0;
  if (backOdds >= 1.9 && backOdds <= 3.2) oddsScore = 10;
  else if ((backOdds >= 1.5 && backOdds < 1.9) || (backOdds > 3.2 && backOdds <= 4.5)) oddsScore = 5;

  // 8. Sample reliability: min(count/20, 1) × 8
  const reliabilityScore = Math.min(segmentBetCount / 20, 1) * 8;

  const raw = edgeScore + confidenceScore + pinnacleScore + spreadScore + upliftScore +
              segmentScore + oddsScore + reliabilityScore + hotStreakBonus;
  const score = Math.max(0, Math.min(Math.round(raw * 100) / 100, 100));

  return { score, isContrarian, pinnacleAligned };
}

// ─── Near-certainty market blocklist ─────────────────────────────────────────
// Single source of truth: imported from paperTrading.ts so detection and
// placement always agree on what's banned.
import { BANNED_MARKETS } from "./paperTrading";

// ─── Pricing-pipeline picker (Prompt 5) ───────────────────────────────────
// Separate the price we PLACE ON (actionable, exchange-only) from the price
// we use to ESTIMATE FAIR VALUE (sharp consensus). The CLV-style edge is
// then (1/fairValueOdds) - (1/actionablePrice): positive iff the exchange
// back price beats sharp implied probability.
//
// Caller MUST pass rows pre-sorted by snapshotTime DESC so first-seen wins.

type PriceQuote = { backOdds: number; source: string };
type FairValueSource = "oddspapi_pinnacle" | "api_football_real:Pinnacle" | "betfair_exchange";
type ActionableSource = "betfair_exchange" | "oddspapi_pinnacle" | "api_football_real:Pinnacle";
type RejectReason = "no_actionable_source" | "no_fair_value_source";
type PricingResult =
  | {
      ok: true;
      actionablePrice: number;
      actionableSource: ActionableSource;
      fairValueOdds: number;
      fairValueSource: FairValueSource;
      shadowOnly: boolean;
    }
  | { ok: false; reason: RejectReason };

// Sub-phase 4.B (2026-05-08): pricing pipeline with gated shadow-only path.
// betfair_exchange row → use it as actionable (real-stake placeable).
// No exchange row but marketType IS in MARKET_TYPE_MAP (graduation path
// exists) → fall through to Pinnacle as actionable + return shadowOnly=true.
// Markets NOT in MARKET_TYPE_MAP have no graduation path → still rejected
// to avoid dead-end Neon writes for un-placeable markets.
function selectPricingSources(
  rows: Array<{ source?: string | null; backOdds: string | number | null }>,
  marketType: string,
  placeableMarketTypes: Set<string>,
): PricingResult {
  let exchange: PriceQuote | null = null;
  let oddspapiPinnacle: PriceQuote | null = null;
  let afPinnacle: PriceQuote | null = null;

  for (const r of rows) {
    if (r.backOdds == null) continue;
    const bo = Number(r.backOdds);
    if (!(bo > 1.01)) continue;
    const src = r.source ?? "";
    if (src === "betfair_exchange") {
      if (!exchange) exchange = { backOdds: bo, source: "betfair_exchange" };
    } else if (src === "oddspapi_pinnacle") {
      if (!oddspapiPinnacle) oddspapiPinnacle = { backOdds: bo, source: "oddspapi_pinnacle" };
    } else if (src === "api_football_real:Pinnacle") {
      if (!afPinnacle) afPinnacle = { backOdds: bo, source: "api_football_real:Pinnacle" };
    }
  }

  const fv = oddspapiPinnacle ?? afPinnacle ?? exchange;
  if (!fv) return { ok: false, reason: "no_fair_value_source" };

  if (exchange) {
    return {
      ok: true,
      actionablePrice: exchange.backOdds,
      actionableSource: "betfair_exchange",
      fairValueOdds: fv.backOdds,
      fairValueSource: fv.source as FairValueSource,
      shadowOnly: false,
    };
  }

  // No exchange row. Allow Pinnacle as actionable ONLY if marketType has
  // a graduation path. Otherwise reject — shadow rows on never-placeable
  // markets are dead-end (no path to real-stake → no Kelly-growth value).
  if (!placeableMarketTypes.has(marketType)) {
    return { ok: false, reason: "no_actionable_source" };
  }
  const actionable = oddspapiPinnacle ?? afPinnacle;
  if (!actionable) return { ok: false, reason: "no_actionable_source" };
  return {
    ok: true,
    actionablePrice: actionable.backOdds,
    actionableSource: actionable.source as ActionableSource,
    fairValueOdds: fv.backOdds,
    fairValueSource: fv.source as FairValueSource,
    shadowOnly: true,
  };
}

// ─── Main detection function ──────────────────────────────────────────────────

export async function detectValueBets(options?: {
  earliestKickoff?: Date;
  latestKickoff?: Date;
}): Promise<EvaluationSummary> {
  const modelVersion = getModelVersion();
  logger.info({ modelVersion }, "Running value detection");

  const configRows = await db.select().from(agentConfigTable);
  const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));

  // 2026-05-08: minEdge / minOppScore now sourced via adaptive recommender
  // with fallback chain (tier_market → market_type → global → agent_config
  // → hardcoded). The agent_config values become last-resort defaults; the
  // adaptive recommender overrides them weekly based on Bayesian Kelly-
  // growth posterior. Per-bet resolveScoped() further refines per-scope.
  // The hardcoded "0.03" / "58" defaults are preserved as ultimate fallbacks
  // if both adaptive_thresholds and agent_config are empty.
  const { getActiveThreshold } = await import("./adaptiveThresholdRecommender");
  const adaptiveMinEdge = await getActiveThreshold({
    thresholdName: "min_edge_threshold",
    marketType: "_global", universeTier: null,
  });
  const adaptiveMinOpp = await getActiveThreshold({
    thresholdName: "min_opportunity_score",
    marketType: "_global", universeTier: null,
  });
  const minEdge = Number.isFinite(adaptiveMinEdge.value) && adaptiveMinEdge.value > 0
    ? adaptiveMinEdge.value
    : Number(cfg.min_edge_threshold ?? "0.03");
  const minOppScore = Number.isFinite(adaptiveMinOpp.value) && adaptiveMinOpp.value > 0
    ? adaptiveMinOpp.value
    : Number(cfg.min_opportunity_score ?? "58");
  logger.info(
    { minEdge, minOppScore, edgeSource: adaptiveMinEdge.source, oppSource: adaptiveMinOpp.source },
    "Value detection: adaptive thresholds resolved",
  );

  // Z1+Z5 (2026-05-07): pre-load all scoped threshold overrides into
  // in-memory maps. Auto-tuned weekly by autonomousThresholdRevision Z3
  // cron. Lookup precedence: per_league > per_market > per_archetype >
  // global. Single DB query at function start; per-bet lookup is O(1)
  // map access.
  const scopedScoreMap = new Map<string, number>();
  const scopedEdgeMap = new Map<string, number>();
  for (const r of configRows) {
    if (!r.key.startsWith("min_opportunity_score:") && !r.key.startsWith("min_edge_threshold:")) continue;
    const n = parseFloat(r.value);
    if (!Number.isFinite(n)) continue;
    if (r.key.startsWith("min_opportunity_score:")) scopedScoreMap.set(r.key, n);
    else scopedEdgeMap.set(r.key, n);
  }
  const resolveScoped = (base: string, league: string, market: string, fallback: number): number => {
    const map = base === "min_opportunity_score" ? scopedScoreMap : scopedEdgeMap;
    const leagueKey = `${base}:per_league:${league.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
    if (map.has(leagueKey)) return map.get(leagueKey)!;
    const marketKey = `${base}:per_market:${market.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
    if (map.has(marketKey)) return map.get(marketKey)!;
    const globalKey = `${base}:global`;
    if (map.has(globalKey)) return map.get(globalKey)!;
    return fallback;
  };
  // B1+B2 shadow-track floors: positive-EV near-misses below the production
  // thresholds still flow through as £0 shadow bets (learning data). The
  // shadow floors prevent pure noise — anything below these is dropped, but
  // they're set low enough that almost every identified opportunity passes.
  const shadowMinEdge = Number(cfg.shadow_min_edge_threshold ?? "0.005");
  const shadowMinOppScore = Number(cfg.shadow_min_opportunity_score ?? "0");
  const minOddsThreshold = Number(cfg.min_odds_threshold ?? "1.40");
  const coldThreshold = Number(cfg.cold_market_threshold ?? "-10");
  const coldMinBets = Number(cfg.cold_market_min_bets ?? "10");
  const coldCooldownDays = Number(cfg.cold_market_cooldown_days ?? "14");
  const hotWeeks = Number(cfg.hot_streak_weeks ?? "3");
  const hotMinBets = Number(cfg.hot_streak_min_bets_per_week ?? "5");
  const hotBonus = Number(cfg.hot_streak_bonus ?? "15");

  discoveryCountsLoaded = false;

  const conditions = [eq(matchesTable.status, "scheduled")];
  if (options?.earliestKickoff) {
    conditions.push(gte(matchesTable.kickoffTime, options.earliestKickoff));
  }
  if (options?.latestKickoff) {
    conditions.push(lte(matchesTable.kickoffTime, options.latestKickoff));
  }

  const matches = await db
    .select()
    .from(matchesTable)
    .where(and(...conditions));

  logger.info({ matchCount: matches.length, earliest: options?.earliestKickoff, latest: options?.latestKickoff }, "Value detection: matches to evaluate");

  const valueBets: ValueBet[] = [];
  let selectionsEvaluated = 0;
  let syntheticOddsCount = 0;
  let realOddsCount = 0;
  // Pricing-pipeline rejection counters (Prompt 5) — accumulated per (match, market, selection)
  let pricingRejectNoBetfairExchange = 0;
  let pricingRejectNoFairValueSource = 0;
  const byMarketType: Record<string, number> = {};

  // Buffer compliance log inserts and bulk-flush at the end. Per-row inserts
  // through Neon serverless were ~100ms each and dominated cycle latency
  // (1466 inserts / cycle previously kept the cycle running 15+ minutes).
  const complianceBuffer: Array<typeof complianceLogsTable.$inferInsert> = [];

  // ─── Bulk pre-load all per-(league, marketType) and per-league data ─────
  // Previously the inner loop did 7+ sequential DB round-trips per selection
  // (~1500 iterations × 7 queries × 50ms = 8-10 minutes of pure DB latency).
  // Pre-load everything once into Maps for O(1) lookups inside the loop.
  const preloadStart = Date.now();

  // 1. Competitions config (per league: apiFootballId, seasonalStart, seasonalEnd, universeTier)
  // universeTier added Wave 2 #4 — used to gate the per-selection BANNED_MARKETS
  // filter so experiment-track candidates (Tier B/C) flow through; production-
  // track (Tier A) keeps the bans.
  const competitionRows = await db
    .select({
      name: competitionConfigTable.name,
      apiFootballId: competitionConfigTable.apiFootballId,
      seasonalStart: competitionConfigTable.seasonalStart,
      seasonalEnd: competitionConfigTable.seasonalEnd,
      universeTier: competitionConfigTable.universeTier,
    })
    .from(competitionConfigTable);
  const competitionMap = new Map<string, { apiFootballId: number; seasonalStart: string | null; seasonalEnd: string | null; universeTier: string | null }>();
  for (const c of competitionRows) {
    competitionMap.set(c.name, {
      apiFootballId: c.apiFootballId ?? 0,
      seasonalStart: c.seasonalStart,
      seasonalEnd: c.seasonalEnd,
      universeTier: c.universeTier ?? null,
    });
  }

  // 2. League edge scores
  const edgeRows = await db
    .select({ league: leagueEdgeScoresTable.league, score: leagueEdgeScoresTable.confidenceScore })
    .from(leagueEdgeScoresTable);
  const leagueEdgeMap = new Map<string, number>();
  for (const r of edgeRows) leagueEdgeMap.set(r.league, r.score);

  // 3. Segment stats per (league, marketType) — single GROUP BY query
  const segStatsRows = await db.execute(sql`
    SELECT m.league AS league,
           pb.market_type AS market_type,
           COUNT(*) FILTER (WHERE pb.status IN ('won','lost')) AS bet_count,
           COUNT(*) FILTER (WHERE pb.status = 'won') AS wins,
           COUNT(*) FILTER (WHERE pb.status = 'lost') AS losses,
           COALESCE(SUM(CASE WHEN pb.status IN ('won','lost') THEN pb.settlement_pnl::numeric ELSE 0 END), 0) AS total_pnl,
           COALESCE(SUM(CASE WHEN pb.status IN ('won','lost') THEN pb.stake::numeric ELSE 0 END), 0) AS total_stake
    FROM paper_bets pb
    JOIN matches m ON pb.match_id = m.id
    GROUP BY m.league, pb.market_type
  `);
  const segmentStatsMap = new Map<string, SegmentStats>();
  for (const row of (segStatsRows as any).rows ?? []) {
    const betCount = Number(row.bet_count ?? 0);
    if (betCount === 0) continue;
    const totalPnl = Number(row.total_pnl ?? 0);
    const totalStake = Number(row.total_stake ?? 0);
    const roi = totalStake > 0 ? (totalPnl / totalStake) * 100 : 0;
    segmentStatsMap.set(`${row.league}::${row.market_type}`, {
      betCount,
      wins: Number(row.wins ?? 0),
      losses: Number(row.losses ?? 0),
      totalPnl,
      roi,
    });
  }

  // 4. Hot-streak data per (league, marketType) — settled bets in window grouped by week
  const weeksAgo = new Date();
  weeksAgo.setDate(weeksAgo.getDate() - hotWeeks * 7);
  const hotRows = await db.execute(sql`
    SELECT m.league AS league,
           pb.market_type AS market_type,
           date_trunc('week', pb.settled_at) AS week_start,
           COUNT(*) AS bets,
           COALESCE(SUM(pb.settlement_pnl::numeric), 0) AS pnl
    FROM paper_bets pb
    JOIN matches m ON pb.match_id = m.id
    WHERE pb.settled_at >= ${weeksAgo}
      AND pb.status IN ('won','lost')
    GROUP BY m.league, pb.market_type, date_trunc('week', pb.settled_at)
  `);
  const hotStreakBonusMap = new Map<string, number>();
  const hotWeeksMap = new Map<string, Array<{ bets: number; pnl: number }>>();
  for (const row of (hotRows as any).rows ?? []) {
    const key = `${row.league}::${row.market_type}`;
    const arr = hotWeeksMap.get(key) ?? [];
    arr.push({ bets: Number(row.bets ?? 0), pnl: Number(row.pnl ?? 0) });
    hotWeeksMap.set(key, arr);
  }
  for (const [key, weeks] of hotWeeksMap) {
    const profitable = weeks.filter((w) => w.bets >= hotMinBets && w.pnl > 0).length;
    if (profitable >= hotWeeks) {
      hotStreakBonusMap.set(key, hotBonus);
      if (!hotStreakNotified.has(key)) {
        hotStreakNotified.add(key);
        const [league, marketType] = key.split("::");
        await db.insert(learningNarrativesTable).values({
          narrativeType: "sustained_positive_edge",
          narrativeText: `Hot streak: ${league} ${marketType} profitable for ${profitable} consecutive weeks. Boosting opportunity score by ${hotBonus} points.`,
          relatedData: { league, marketType, weeks: profitable, bonus: hotBonus },
          createdAt: new Date(),
        });
      }
    } else {
      hotStreakNotified.delete(key);
    }
  }

  // 5. Experiment registry tier per experimentTag
  const expRows = await db
    .select({ experimentTag: experimentRegistryTable.experimentTag, dataTier: experimentRegistryTable.dataTier })
    .from(experimentRegistryTable);
  const experimentTierMap = new Map<string, string>();
  for (const r of expRows) experimentTierMap.set(r.experimentTag, r.dataTier);
  const newExperiments: Array<{ tag: string; league: string; market: string }> = [];

  // 6. Discovery counts (for boosting under-explored leagues) — uses existing module-level cache
  discoveryCountsLoaded = false;

  // 7. Commission rate — fetch once
  const commRate = await getCommissionRate("betfair");

  // 8. Cold-market exclusions evaluated up-front from segmentStatsMap
  const coldMarkets = new Set<string>();
  for (const [key, stats] of segmentStatsMap) {
    if (stats.betCount >= coldMinBets && stats.roi < coldThreshold) {
      const cached = coldMarketCache.get(key);
      if (cached && new Date() < cached.excludedUntil) {
        coldMarkets.add(key);
        continue;
      }
      const excludedUntil = new Date();
      excludedUntil.setDate(excludedUntil.getDate() + coldCooldownDays);
      coldMarketCache.set(key, { excludedUntil });
      coldMarkets.add(key);
      const [league, marketType] = key.split("::");
      await db.insert(learningNarrativesTable).values({
        narrativeType: "strategy_shift",
        narrativeText: `Pausing ${league} ${marketType} after ${stats.betCount} bets at ${stats.roi.toFixed(1)}% ROI. Reassessing in ${coldCooldownDays} days.`,
        relatedData: { league, marketType, betCount: stats.betCount, roi: stats.roi, excludedUntil },
        createdAt: new Date(),
      });
      complianceBuffer.push({
        actionType: "decision",
        details: { action: "cold_market_excluded", league, marketType, betCount: stats.betCount, roi: stats.roi, excludedUntil },
        timestamp: new Date(),
      });
      logger.warn({ league, marketType, roi: stats.roi }, "Cold market excluded");
    } else {
      // Re-include if previously cold but cooldown expired
      const cached = coldMarketCache.get(key);
      if (cached && new Date() < cached.excludedUntil) coldMarkets.add(key);
    }
  }
  // Also carry over any still-active cold-market entries that didn't appear in stats
  for (const [key, entry] of coldMarketCache) {
    if (new Date() < entry.excludedUntil) coldMarkets.add(key);
  }

  logger.info(
    {
      competitions: competitionMap.size,
      leagueEdgeScores: leagueEdgeMap.size,
      segmentStats: segmentStatsMap.size,
      hotStreakBonuses: hotStreakBonusMap.size,
      experiments: experimentTierMap.size,
      coldMarkets: coldMarkets.size,
      durationMs: Date.now() - preloadStart,
    },
    "Value detection bulk preload complete",
  );

  // 9. Bulk pre-fetch matches' odds + features.
  //
  // 2026-05-08 URGENT (revision 2): tightened from 24h → 2h, AND switched
  // to DISTINCT ON to fetch only the LATEST snapshot per (match × market
  // × selection × source). This is what the downstream selectPricingSources
  // logic actually needs.
  //
  // Numbers (Neon-billed compute):
  //   - 24h unfiltered: 2.9M rows from a 20M-row table → 700k+ heap fetches
  //   - 2h with DISTINCT ON: ~30k rows max (one per group)
  //   - ~100x reduction in compute and heap traffic per cron tick
  //
  // Slowest ingestion source (oddspapi_pinnacle ~hourly) still refreshes
  // within the 2h window. Faster sources (betfair_exchange every 10 min)
  // are well within. The ORDER BY in the DISTINCT ON ensures we keep the
  // latest snapshot per group when multiple exist within the window.
  const matchIds = matches.map((m) => m.id);
  const ODDS_LOOKBACK_HOURS = 2;
  const oddsCutoff = new Date(Date.now() - ODDS_LOOKBACK_HOURS * 60 * 60 * 1000);
  // 2026-05-08 (§4.4 of root-cause-analysis): use the sqlIntList helper.
  // The helper validates that all elements are integers and renders a
  // literal `1,2,3` SQL fragment, sidestepping drizzle's array-bind
  // footgun. Lint rule scripts/src/lint-no-raw-array-bind.ts catches
  // future regressions in CI.
  const allOddsRows = matchIds.length > 0
    ? (await db.execute(sql`
        SELECT DISTINCT ON (match_id, market_type, selection_name, source)
          id, match_id AS "matchId", market_type AS "marketType",
          selection_name AS "selectionName",
          back_odds AS "backOdds", lay_odds AS "layOdds",
          snapshot_time AS "snapshotTime", source
        FROM odds_snapshots
        WHERE match_id IN (${sqlIntList(matchIds)})
          AND snapshot_time >= ${oddsCutoff}
        ORDER BY match_id, market_type, selection_name, source, snapshot_time DESC
      `)).rows as unknown as Array<{
        id: number; matchId: number; marketType: string; selectionName: string;
        backOdds: string | null; layOdds: string | null;
        snapshotTime: Date; source: string;
      }>
    : [];
  const oddsByMatch = new Map<number, typeof allOddsRows>();
  for (const r of allOddsRows) {
    const arr = oddsByMatch.get(r.matchId) ?? [];
    arr.push(r);
    oddsByMatch.set(r.matchId, arr);
  }

  const allFeatureRows = matchIds.length > 0
    ? await db
        .select()
        .from(featuresTable)
        .where(inArray(featuresTable.matchId, matchIds))
    : [];
  const featuresByMatch = new Map<number, typeof allFeatureRows>();
  for (const r of allFeatureRows) {
    const arr = featuresByMatch.get(r.matchId) ?? [];
    arr.push(r);
    featuresByMatch.set(r.matchId, arr);
  }

  for (const match of matches) {
    const ccRow = competitionMap.get(match.league);
    const matchLeagueId = ccRow?.apiFootballId ?? 0;
    // Wave 2 #4 (2026-05-05): match-level universe_tier so per-selection
    // BANNED_MARKETS filter can gate by data_tier. Tier A keeps bans;
    // Tier B/C (experiment track) bypasses to admit relearning candidates.
    const matchUniverseTier = ccRow?.universeTier ?? null;
    const isExperimentTrack = matchUniverseTier === "B" || matchUniverseTier === "C";
    const seasonalPhase = ccRow
      ? detectSeasonalPhase(ccRow.seasonalStart, ccRow.seasonalEnd, match.league)
      : ("unknown" as const);
    const blockCheck = shouldBlockBet(matchLeagueId, match.league, seasonalPhase);
    if (blockCheck.blocked) {
      logger.debug({ matchId: match.id, league: match.league, seasonalPhase, reason: blockCheck.reason }, "Skipping match — seasonal/friendly block");
      continue;
    }

    const oddsRows = oddsByMatch.get(match.id) ?? [];
    const featureRows = featuresByMatch.get(match.id) ?? [];

    const publicFeatures = featureRows.filter((f) => !f.featureName.startsWith("_"));
    if (publicFeatures.length < 8) continue;

    const featureMap: Record<string, number> = {};
    for (const f of publicFeatures) {
      featureMap[f.featureName] = Number(f.featureValue);
    }

    // ── Pricing-pipeline picker (Prompt 5) ────────────────────────────────
    // Group oddsRows (already snapshotTime DESC) by (market, selection), then
    // run selectPricingSources per group: actionable = betfair_exchange only;
    // fair value = oddspapi_pinnacle > AF Pinnacle > exchange. Synthetic odds
    // are no longer used as a fallback — without an exchange row we cannot
    // place at a real market price, so the candidate is rejected.
    type OddsRow = { marketType: string; selectionName: string; backOdds: string | number | null; source?: string | null };

    const hasAnyRealOdds = oddsRows.some(
      (r) =>
        r.source === "betfair_exchange" ||
        r.source?.startsWith("api_football_real") ||
        r.source?.startsWith("oddspapi"),
    );
    if (hasAnyRealOdds) realOddsCount++;
    else syntheticOddsCount++;

    const groups = new Map<string, OddsRow[]>();
    for (const r of oddsRows) {
      const key = `${r.marketType}\u0000${r.selectionName}`;
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }

    for (const [groupKey, groupRows] of groups) {
      const sep = groupKey.indexOf("\u0000");
      const marketType = groupKey.slice(0, sep);
      const selectionName = groupKey.slice(sep + 1);

      // Banned-market hardstop (cheap check before pricing selection).
      // Wave 2 #4 (2026-05-05): experiment-track (Tier B/C) bypasses bans —
      // candidates flow through to placement where the data_tier-gated
      // hardstop at paperTrading.ts:683 confirms £0 stake. Production
      // track (Tier A) keeps the bans untouched.
      if (BANNED_MARKETS.has(marketType) && !isExperimentTrack) continue;

      const pricing = selectPricingSources(groupRows, marketType, MARKET_TYPE_MAP_KEYS);
      if (!pricing.ok) {
        if (pricing.reason === "no_actionable_source") {
          pricingRejectNoBetfairExchange++; // legacy counter — repurposed
        } else {
          pricingRejectNoFairValueSource++;
        }
        continue;
      }
      const { actionablePrice, actionableSource, fairValueOdds, fairValueSource, shadowOnly } = pricing;

      // Minimum odds floor on the actionable (placed) price
      if (actionablePrice < minOddsThreshold) continue;

      const modelProb = getModelProbability(marketType, selectionName, featureMap);
      if (modelProb === null) continue;

      selectionsEvaluated++;

      // Legacy-compat oddsRow adapter so downstream code (scoring, logging,
      // etc.) keeps the same shape it had before the pricing-pipeline split.
      const oddsRow: OddsRow = {
        marketType,
        selectionName,
        backOdds: actionablePrice,
        source: actionableSource,
      };
      const backOdds = actionablePrice;
      const impliedProb = 1 / actionablePrice;
      const isSynthetic = false;
      const oddsSourceLabel = actionableSource;

      // CLV-style edge: positive iff the exchange back price beats sharp
      // consensus implied probability. Replaces the legacy modelProb-based
      // edge formula which conflated forecast accuracy with price quality.
      //
      // Wave 1.5 (2026-05-05): Tier B/C / non-Pinnacle leagues have no
      // sharp reference — selectPricingSources() falls back to the
      // betfair_exchange row as fairValueSource, which IS the actionable
      // price. That gives edge = 0 always and structurally rejects every
      // experiment-track selection. For the degenerate case, fall back to
      // the legacy model-prob-vs-market edge so the experiment track can
      // produce candidates. Tier A behaviour byte-identical because fv
      // comes from oddspapi_pinnacle or api_football_real:Pinnacle
      // (≠ exchange) — the degenerate branch never fires there.
      const fvDegenerate = fairValueSource === actionableSource;
      const edge = fvDegenerate
        ? modelProb - (1 / actionablePrice)
        : (1 / fairValueOdds) - (1 / actionablePrice);

      const effectiveMinEdge = DERIVED_MARKETS.has(oddsRow.marketType)
        ? Math.max(minEdge, 0.08)
        : minEdge;
      // B1+B2: drop only below the absolute shadow floor. Above-floor but
      // below-production candidates fall through to the placement-track
      // decision below and route to £0 shadow capture.
      const effectiveShadowMinEdge = DERIVED_MARKETS.has(oddsRow.marketType)
        ? Math.max(shadowMinEdge, 0.02)
        : shadowMinEdge;
      if (edge < effectiveShadowMinEdge) continue;

      const evCheck = commissionAdjustedEV(modelProb, backOdds, commRate);
      if (evCheck.netEV <= 0) {
        logger.debug(
          { matchId: match.id, market: oddsRow.marketType, selection: oddsRow.selectionName, grossEV: evCheck.grossEV, netEV: evCheck.netEV, commRate },
          "Skipping bet: positive gross EV but negative net EV after commission",
        );
        continue;
      }

      const segKey = `${match.league}::${oddsRow.marketType}`;
      const segmentStats = segmentStatsMap.get(segKey) ?? { betCount: 0, wins: 0, losses: 0, totalPnl: 0, roi: 0 };

      // B1+B2 (2026-05-07): cold-market cooldown moved to AFTER the
      // placement-track decision below. The cooldown is a capital-risk
      // gate (avoid stake on chronically-losing segments) — production-
      // track bets keep it, shadow-track bets (£0, learning data) bypass
      // it because they are exactly how the model relearns whether the
      // segment has recovered. We compute the score first so we know
      // whether this candidate routes to production or shadow.
      const isColdSegment = coldMarkets.has(segKey);

      const streakBonus = hotStreakBonusMap.get(segKey) ?? 0;
      const leagueEdgeScore = leagueEdgeMap.get(match.league ?? "") ?? 50;
      const discoveryBonus = await getDiscoveryBonus(match.league ?? "");

      // Pull market spread features (computed from all-bookmaker odds)
      const marketSpread = featureMap["avg_market_spread"] ?? featureMap["market_spread_home"] ?? undefined;
      const bookmakerCount = featureMap["bookmaker_count_home"] ? Math.round(featureMap["bookmaker_count_home"]) : undefined;

      let constituentMaxConfidence: number | undefined;
      if (DERIVED_MARKETS.has(oddsRow.marketType)) {
        const outcomePreds = predictOutcome(enrichFeaturesWithXgProxy(featureMap));
        if (outcomePreds) {
          if (oddsRow.marketType === "FIRST_HALF_RESULT") {
            const scale = 0.7;
            const mean = 1 / 3;
            const fhHome = mean + (outcomePreds.home - mean) * scale;
            const fhDraw = mean + (outcomePreds.draw - mean) * scale;
            const fhAway = mean + (outcomePreds.away - mean) * scale;
            constituentMaxConfidence = Math.max(
              Math.abs(fhHome - 0.5),
              Math.abs(fhDraw - 0.5),
              Math.abs(fhAway - 0.5),
            );
          } else {
            constituentMaxConfidence = Math.max(
              Math.abs(outcomePreds.home - 0.5),
              Math.abs(outcomePreds.draw - 0.5),
              Math.abs(outcomePreds.away - 0.5),
            );
          }
        }
      }

      const baseOpportunityScore = computeOpportunityScore({
        edge,
        modelProbability: modelProb,
        backOdds,
        segmentStats,
        hotStreakBonus: streakBonus,
        isSynthetic,
        leagueEdgeScore,
        marketSpread,
        bookmakerCount,
        marketType: oddsRow.marketType,
        constituentMaxConfidence,
      });
      const softLine = await getSoftLineBonus(match.homeTeam, match.awayTeam, matchLeagueId, match.kickoffTime);
      const totalBonus = discoveryBonus + softLine.bonus;
      const opportunityScore = Math.min(baseOpportunityScore + totalBonus, 100);
      const wasBoosted = totalBonus > 0;
      if (discoveryBonus > 0) {
        logger.info({ matchId: match.id, league: match.league, marketType: oddsRow.marketType, baseScore: baseOpportunityScore, discoveryBonus, finalScore: opportunityScore }, "Discovery bonus applied");
      }
      if (softLine.bonus > 0) {
        logger.info({ matchId: match.id, league: match.league, homeTeam: match.homeTeam, awayTeam: match.awayTeam, softLineBonus: softLine.bonus, reason: softLine.reason, finalScore: opportunityScore }, "Soft-line bonus applied");
      }

      const expTag = `${(match.league ?? "unknown").toLowerCase().replace(/[^a-z0-9]/g, "-")}-${oddsRow.marketType.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
      const settledCount = segmentStats.betCount;
      const isExperimental = settledCount < 50;
      let dataTier: string;
      if (isExperimental) {
        dataTier = "experiment";
        if (!experimentTierMap.has(expTag)) {
          experimentTierMap.set(expTag, "experiment");
          newExperiments.push({ tag: expTag, league: match.league ?? "unknown", market: oddsRow.marketType });
        }
      } else {
        dataTier = experimentTierMap.get(expTag) ?? "experiment";
        if (dataTier === "experiment" || dataTier === "abandoned" || dataTier === "demoted") dataTier = "experiment";
      }
      const syncEligible = dataTier === "promoted";

      // B1+B2 (2026-05-07): tier-aware placement-track decision. Every
      // positive-EV opportunity above the shadow floor flows through —
      // production-rail bets must be Tier A AND meet full production
      // thresholds; everything else (Tier A near-misses + any Tier B/C bet
      // that cleared the shadow floor) routes to £0 shadow capture so the
      // tier-ladder gets continuous learning evidence.
      // Z1+Z5 (2026-05-07): use scoped threshold (per-league > per-market >
      // global). Auto-tuned by Z3 weekly retrospective cron.
      // Sub-phase 4.B (2026-05-08): when actionable price comes from a
      // non-exchange source (shadowOnly=true), the bet has no real-stake
      // placement path — force placementTrack='shadow' regardless of tier
      // or score. The graduation pathway is preserved because the
      // marketType is in MARKET_TYPE_MAP (gate enforced by
      // selectPricingSources).
      const effectiveMinScore = resolveScoped("min_opportunity_score", match.league ?? "", oddsRow.marketType, minOppScore);
      const meetsProduction =
        !shadowOnly &&
        matchUniverseTier === "A" &&
        opportunityScore >= effectiveMinScore &&
        edge >= effectiveMinEdge;
      const meetsShadow = opportunityScore >= shadowMinOppScore;
      // Production-track bets respect the cold-market cooldown (capital-risk
      // gate). Shadow-track bypasses — that's how the model relearns whether
      // a chronically-losing segment has recovered.
      const productionAllowed = meetsProduction && !isColdSegment;
      const placementTrack: "production" | "shadow" | null = productionAllowed
        ? "production"
        : meetsShadow
          ? "shadow"
          : null;
      const decision = placementTrack === "production"
        ? "value_bet"
        : placementTrack === "shadow"
          ? "shadow_bet"
          : "skip_low_score";

      // Runtime telemetry (not audit). Was being persisted into compliance_logs
      // at ~5k rows/cycle and bloating that table; now goes to file logs only.
      logger.debug(
        {
          matchId: match.id,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          marketType: oddsRow.marketType,
          selectionName: oddsRow.selectionName,
          backOdds,
          impliedProbability: impliedProb,
          modelProbability: modelProb,
          calculatedEdge: edge,
          opportunityScore,
          minOppScore: effectiveMinScore,
          shadowMinOppScore,
          universeTier: matchUniverseTier,
          placementTrack,
          segmentStats,
          hotStreakBonus: streakBonus,
          decision,
          isSynthetic,
          oddsSource: oddsSourceLabel,
          modelVersion,
        },
        "value_detection_evaluation",
      );

      if (placementTrack !== null) {
        byMarketType[oddsRow.marketType] = (byMarketType[oddsRow.marketType] ?? 0) + 1;
        valueBets.push({
          matchId: match.id,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league,
          kickoffTime: match.kickoffTime,
          marketType: oddsRow.marketType,
          selectionName: oddsRow.selectionName,
          modelProbability: modelProb,
          impliedProbability: impliedProb,
          edge,
          backOdds,
          modelVersion,
          opportunityScore,
          oddsSource: oddsSourceLabel,
          segmentBetCount: segmentStats.betCount,
          segmentRoi: segmentStats.roi,
          hotStreakBonus: streakBonus,
          experimentTag: expTag,
          dataTier,
          opportunityBoosted: wasBoosted,
          originalOpportunityScore: baseOpportunityScore,
          boostedOpportunityScore: opportunityScore,
          syncEligible,
          actionablePrice,
          actionableSource,
          fairValueOdds,
          fairValueSource,
          placementTrack,
        });
      }
    }
  }

  // Sort by opportunity score descending
  valueBets.sort((a, b) => b.opportunityScore - a.opportunityScore);

  // Bulk-register newly discovered experiments (one INSERT per new tag — typically <50/cycle)
  if (newExperiments.length > 0) {
    const regStart = Date.now();
    let registered = 0;
    for (const e of newExperiments) {
      try {
        await ensureExperimentRegistered(e.tag, e.league, e.market);
        registered++;
      } catch {
        // Non-fatal: another concurrent process may have registered it
      }
    }
    logger.info({ registered, attempted: newExperiments.length, durationMs: Date.now() - regStart }, "New experiments registered");
  }

  // Bulk-flush buffered compliance logs in chunks. Failures here must not
  // block the trading cycle from returning value bets to the placement step.
  if (complianceBuffer.length > 0) {
    const flushStart = Date.now();
    const CHUNK = 500;
    let flushed = 0;
    try {
      for (let i = 0; i < complianceBuffer.length; i += CHUNK) {
        const chunk = complianceBuffer.slice(i, i + CHUNK);
        await db.insert(complianceLogsTable).values(chunk);
        flushed += chunk.length;
      }
      logger.info(
        { rows: flushed, durationMs: Date.now() - flushStart },
        "Value detection compliance logs flushed",
      );
    } catch (err) {
      logger.warn(
        { err, attempted: complianceBuffer.length, flushed },
        "Failed to flush value detection compliance logs (non-fatal)",
      );
    }
  }

  logger.info(
    {
      matchesEvaluated: matches.length,
      selectionsEvaluated,
      valueBetsFound: valueBets.length,
      realOddsCount,
      syntheticOddsCount,
      pricingRejectNoBetfairExchange,
      pricingRejectNoFairValueSource,
    },
    "Value detection complete",
  );

  return {
    matchesEvaluated: matches.length,
    selectionsEvaluated,
    valueBetsFound: valueBets.length,
    modelVersion,
    valueBets,
    realOddsCount,
    syntheticOddsCount,
    byMarketType,
    pricingRejectNoBetfairExchange,
    pricingRejectNoFairValueSource,
  };
}
