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
} from "@workspace/db";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { ensureExperimentRegistered, getExperimentTier } from "./promotionEngine";
import {
  predictOutcome,
  predictBtts,
  predictOverUnder,
  predictCards,
  predictCorners,
  getModelVersion,
} from "./predictionEngine";

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
}): number {
  const { edge, modelProbability, backOdds, segmentStats, hotStreakBonus, isSynthetic, leagueEdgeScore, marketSpread, bookmakerCount } = params;

  // 1. Edge size: (edge / 0.15) × 25, max 25
  const edgeScore = Math.min((edge / 0.15) * 25, 25);

  // 2. Model confidence: abs(prob - 0.5) × 50, max 25
  const confidenceScore = Math.min(Math.abs(modelProbability - 0.5) * 50, 25);

  // 3. Historical segment ROI (max 20) — only when positive
  let segmentScore = 0;
  if (segmentStats.betCount >= 3 && segmentStats.roi > 0) {
    segmentScore = Math.min(segmentStats.roi, 20);
  }

  // 4. Sample reliability: min(count/20, 1) × 15, max 15
  const reliabilityScore = Math.min(segmentStats.betCount / 20, 1) * 15;

  // 5. Odds sweet spot: 1.9–3.2 → 15pts, 1.5–1.9 or 3.2–4.5 → 8pts, outside → 0
  let oddsScore = 0;
  if (backOdds >= 1.9 && backOdds <= 3.2) oddsScore = 15;
  else if ((backOdds >= 1.5 && backOdds < 1.9) || (backOdds > 3.2 && backOdds <= 4.5)) oddsScore = 8;

  // 6. League edge bonus: (leagueEdgeScore - 50) / 5, capped at ±10
  const leagueBonus = leagueEdgeScore !== undefined
    ? Math.max(-10, Math.min(10, (leagueEdgeScore - 50) / 5))
    : 0;

  // 7. Market spread bonus — bookmaker disagreement = inefficient market = edge opportunity
  //    Large spread (>5%) means bookmakers disagree significantly → bonus up to 8pts
  //    Scaled by bookmaker count (more bookmakers = more reliable spread)
  let marketSpreadBonus = 0;
  if (marketSpread !== undefined && marketSpread > 0) {
    const bmFactor = Math.min((bookmakerCount ?? 3) / 5, 1); // scale with bookmaker count
    marketSpreadBonus = Math.min(marketSpread * 80 * bmFactor, 8);
  }

  const raw = edgeScore + confidenceScore + segmentScore + reliabilityScore + oddsScore + hotStreakBonus + leagueBonus + marketSpreadBonus;
  const score = Math.min(Math.round(raw * 100) / 100, 100);

  // Synthetic-only odds are capped at 55 — below the default 50 min score
  if (isSynthetic) return Math.min(score, 55);

  return score;
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
// Markets with base-rate win probabilities so extreme that the model cannot
// generate genuine edge — they distort performance statistics.
const BANNED_MARKETS = new Set([
  "OVER_UNDER_05",     // Over 0.5 wins ~92% of the time — no edge signal
  "OVER_UNDER_15",     // Over 1.5 wins ~75% of the time — no edge signal
  "TOTAL_CARDS_55",    // Under 5.5 wins ~85% of the time — no edge signal
  "TOTAL_CARDS_45",    // Near-certainty; unreliable settlement data
  "TOTAL_CORNERS_85",  // Too predictable; only 9.5/10.5 corners have genuine edge
  "TOTAL_CORNERS_115", // Too predictable; only 9.5/10.5 corners have genuine edge
  "FIRST_HALF_OU_05",  // Too easy; only FIRST_HALF_OU_15 retained
]);

// ─── Main detection function ──────────────────────────────────────────────────

export async function detectValueBets(): Promise<EvaluationSummary> {
  const modelVersion = getModelVersion();
  logger.info({ modelVersion }, "Running value detection");

  const configRows = await db.select().from(agentConfigTable);
  const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));

  const minEdge = Number(cfg.min_edge_threshold ?? "0.03");
  const minOppScore = Number(cfg.min_opportunity_score ?? "58");
  const minOddsThreshold = Number(cfg.min_odds_threshold ?? "1.40");
  const coldThreshold = Number(cfg.cold_market_threshold ?? "-10");
  const coldMinBets = Number(cfg.cold_market_min_bets ?? "10");
  const coldCooldownDays = Number(cfg.cold_market_cooldown_days ?? "14");
  const hotWeeks = Number(cfg.hot_streak_weeks ?? "3");
  const hotMinBets = Number(cfg.hot_streak_min_bets_per_week ?? "5");
  const hotBonus = Number(cfg.hot_streak_bonus ?? "15");

  discoveryCountsLoaded = false;

  const matches = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.status, "scheduled"));

  const valueBets: ValueBet[] = [];
  let selectionsEvaluated = 0;
  let syntheticOddsCount = 0;
  let realOddsCount = 0;
  const byMarketType: Record<string, number> = {};

  for (const match of matches) {
    const oddsRows = await db
      .select()
      .from(oddsSnapshotsTable)
      .where(eq(oddsSnapshotsTable.matchId, match.id))
      .orderBy(desc(oddsSnapshotsTable.snapshotTime));

    const featureRows = await db
      .select()
      .from(featuresTable)
      .where(eq(featuresTable.matchId, match.id));

    const publicFeatures = featureRows.filter((f) => !f.featureName.startsWith("_"));
    if (publicFeatures.length < 8) continue;

    const featureMap: Record<string, number> = {};
    for (const f of publicFeatures) {
      featureMap[f.featureName] = Number(f.featureValue);
    }

    // Determine odds source priority — both api_football_real and oddspapi are real market odds
    const realOddsRows = oddsRows.filter(
      (r) => r.source?.startsWith("api_football_real") || r.source?.startsWith("oddspapi"),
    );
    const isSynthetic = realOddsRows.length === 0;

    if (isSynthetic) {
      syntheticOddsCount++;
    } else {
      realOddsCount++;
    }

    type OddsRow = { marketType: string; selectionName: string; backOdds: string | number | null; source?: string | null };
    const oddsSource: OddsRow[] = isSynthetic ? generateSyntheticOdds(featureMap) : oddsRows;

    // Log which odds source was used
    const oddsSourceLabel = isSynthetic
      ? "synthetic"
      : (realOddsRows[0]?.source ?? "api_football_real").replace("api_football_real:", "");

    await db.insert(complianceLogsTable).values({
      actionType: "value_detection_odds_source",
      details: {
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        oddsSource: oddsSourceLabel,
        isSynthetic,
        oddsRowCount: oddsSource.length,
      },
      timestamp: new Date(),
    });

    const latestOdds = new Map<string, OddsRow>();
    for (const row of oddsSource) {
      const key = `${row.marketType}:${row.selectionName}`;
      if (!latestOdds.has(key)) latestOdds.set(key, row);
    }

    for (const [, oddsRow] of latestOdds) {
      if (!oddsRow.backOdds) continue;
      const backOdds = Number(oddsRow.backOdds);
      if (backOdds <= 1.01) continue;

      // Fix 1: Skip banned near-certainty markets — they have no genuine edge
      if (BANNED_MARKETS.has(oddsRow.marketType)) continue;

      // Fix 2: Minimum odds floor — below this the reward doesn't justify the risk
      if (backOdds < minOddsThreshold) continue;

      const impliedProb = 1 / backOdds;

      const modelProb = getModelProbability(oddsRow.marketType, oddsRow.selectionName, featureMap);
      if (modelProb === null) continue;

      selectionsEvaluated++;
      const edge = modelProb - impliedProb;

      if (edge <= minEdge) continue;

      const { commissionAdjustedEV, getCommissionRate } = await import("./commissionService");
      const commRate = await getCommissionRate("betfair");
      const evCheck = commissionAdjustedEV(modelProb, backOdds, commRate);
      if (evCheck.netEV <= 0) {
        logger.debug(
          { matchId: match.id, market: oddsRow.marketType, selection: oddsRow.selectionName, grossEV: evCheck.grossEV, netEV: evCheck.netEV, commRate },
          "Skipping bet: positive gross EV but negative net EV after commission",
        );
        continue;
      }

      const segmentStats = await getSegmentStats(match.league, oddsRow.marketType);

      const cold = await isColdMarket(match.league, oddsRow.marketType, segmentStats, coldMinBets, coldThreshold, coldCooldownDays);
      if (cold) continue;

      const streakBonus = await getHotStreakBonus(match.league, oddsRow.marketType, hotWeeks, hotMinBets, hotBonus);
      const leagueEdgeScore = await getLeagueEdgeScore(match.league ?? "");
      const discoveryBonus = await getDiscoveryBonus(match.league ?? "");

      // Pull market spread features (computed from all-bookmaker odds)
      const marketSpread = featureMap["avg_market_spread"] ?? featureMap["market_spread_home"] ?? undefined;
      const bookmakerCount = featureMap["bookmaker_count_home"] ? Math.round(featureMap["bookmaker_count_home"]) : undefined;

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
      });
      const opportunityScore = Math.min(baseOpportunityScore + discoveryBonus, 100);
      const wasBoosted = discoveryBonus > 0;
      if (wasBoosted) {
        logger.info({ matchId: match.id, league: match.league, marketType: oddsRow.marketType, baseScore: baseOpportunityScore, discoveryBonus, finalScore: opportunityScore }, "Discovery bonus applied");
      }

      const expTag = `${(match.league ?? "unknown").toLowerCase().replace(/[^a-z0-9]/g, "-")}-${oddsRow.marketType.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
      const settledCount = segmentStats.betCount;
      const isExperimental = settledCount < 50;
      let dataTier: string;
      if (isExperimental) {
        dataTier = "experiment";
        await ensureExperimentRegistered(expTag, match.league ?? "unknown", oddsRow.marketType);
      } else {
        dataTier = await getExperimentTier(expTag);
        if (dataTier === "experiment" || dataTier === "abandoned" || dataTier === "demoted") dataTier = "experiment";
      }
      const syncEligible = dataTier === "promoted";

      // Both real and synthetic odds must meet the configured min_opportunity_score floor
      const effectiveMinScore = minOppScore;
      const decision = opportunityScore >= effectiveMinScore ? "value_bet" : "skip_low_score";

      await db.insert(complianceLogsTable).values({
        actionType: "value_detection_evaluation",
        details: {
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
          segmentStats,
          hotStreakBonus: streakBonus,
          decision,
          isSynthetic,
          oddsSource: oddsSourceLabel,
          modelVersion,
        },
        timestamp: new Date(),
      });

      if (opportunityScore >= effectiveMinScore) {
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
        });
      }
    }
  }

  // Sort by opportunity score descending
  valueBets.sort((a, b) => b.opportunityScore - a.opportunityScore);

  logger.info(
    { matchesEvaluated: matches.length, selectionsEvaluated, valueBetsFound: valueBets.length, realOddsCount, syntheticOddsCount },
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
  };
}
