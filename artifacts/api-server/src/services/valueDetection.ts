import {
  db,
  matchesTable,
  oddsSnapshotsTable,
  featuresTable,
  complianceLogsTable,
  agentConfigTable,
  paperBetsTable,
  learningNarrativesTable,
} from "@workspace/db";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
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
}): number {
  const { edge, modelProbability, backOdds, segmentStats, hotStreakBonus, isSynthetic } = params;

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

  const raw = edgeScore + confidenceScore + segmentScore + reliabilityScore + oddsScore + hotStreakBonus;
  const score = Math.min(Math.round(raw * 100) / 100, 100);

  // KEY FIX: Synthetic-only odds are capped at 55 — below the 65 threshold
  // This prevents placing bets based solely on our own Poisson model
  if (isSynthetic) return Math.min(score, 55);

  return score;
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

function getModelProbability(
  marketType: string,
  selectionName: string,
  featureMap: Record<string, number>,
): number | null {
  const outcomePreds = predictOutcome(featureMap);
  const bttsPreds = predictBtts(featureMap);
  const ouPreds = predictOverUnder(featureMap);
  const cardsPreds = predictCards(featureMap);
  const cornersPreds = predictCorners(featureMap);

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
    // Adjust for 1.5 line using goals averages
    const homeGoals = featureMap["home_goals_scored_avg"] ?? 1.4;
    const awayGoals = featureMap["away_goals_scored_avg"] ?? 1.1;
    const lambda = homeGoals + awayGoals;
    const p0 = Math.exp(-lambda);
    const p1 = lambda * Math.exp(-lambda);
    const under15 = Math.max(0.01, Math.min(0.99, p0 + p1));
    if (selectionName.startsWith("Over")) return 1 - under15;
    if (selectionName.startsWith("Under")) return under15;
  }
  if (marketType === "OVER_UNDER_35" && ouPreds) {
    const homeGoals = featureMap["home_goals_scored_avg"] ?? 1.4;
    const awayGoals = featureMap["away_goals_scored_avg"] ?? 1.1;
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

// ─── Main detection function ──────────────────────────────────────────────────

export async function detectValueBets(): Promise<EvaluationSummary> {
  const modelVersion = getModelVersion();
  logger.info({ modelVersion }, "Running value detection");

  const configRows = await db.select().from(agentConfigTable);
  const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));

  const minEdge = Number(cfg.min_edge_threshold ?? "0.03");
  const minOppScore = Number(cfg.min_opportunity_score ?? "65");
  const coldThreshold = Number(cfg.cold_market_threshold ?? "-10");
  const coldMinBets = Number(cfg.cold_market_min_bets ?? "10");
  const coldCooldownDays = Number(cfg.cold_market_cooldown_days ?? "14");
  const hotWeeks = Number(cfg.hot_streak_weeks ?? "3");
  const hotMinBets = Number(cfg.hot_streak_min_bets_per_week ?? "5");
  const hotBonus = Number(cfg.hot_streak_bonus ?? "15");

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
      const impliedProb = 1 / backOdds;

      const modelProb = getModelProbability(oddsRow.marketType, oddsRow.selectionName, featureMap);
      if (modelProb === null) continue;

      selectionsEvaluated++;
      const edge = modelProb - impliedProb;

      if (edge <= minEdge) continue;

      const segmentStats = await getSegmentStats(match.league, oddsRow.marketType);

      const cold = await isColdMarket(match.league, oddsRow.marketType, segmentStats, coldMinBets, coldThreshold, coldCooldownDays);
      if (cold) continue;

      const streakBonus = await getHotStreakBonus(match.league, oddsRow.marketType, hotWeeks, hotMinBets, hotBonus);

      const opportunityScore = computeOpportunityScore({
        edge,
        modelProbability: modelProb,
        backOdds,
        segmentStats,
        hotStreakBonus: streakBonus,
        isSynthetic,
      });

      const decision = opportunityScore >= minOppScore ? "value_bet" : "skip_low_score";

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
          minOppScore,
          segmentStats,
          hotStreakBonus: streakBonus,
          decision,
          isSynthetic,
          oddsSource: oddsSourceLabel,
          modelVersion,
        },
        timestamp: new Date(),
      });

      if (opportunityScore >= minOppScore) {
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
