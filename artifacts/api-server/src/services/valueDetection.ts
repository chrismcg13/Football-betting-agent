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
import { eq, desc, and, gte, lt, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  predictOutcome,
  predictBtts,
  predictOverUnder,
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
}

export interface EvaluationSummary {
  matchesEvaluated: number;
  selectionsEvaluated: number;
  valueBetsFound: number;
  modelVersion: string | null;
  valueBets: ValueBet[];
}

// ─── Segment stats (for scoring and filters) ──────────────────────────────────

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
  const settled = await db
    .select({
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
      matchId: paperBetsTable.matchId,
    })
    .from(paperBetsTable)
    .where(
      and(
        eq(paperBetsTable.marketType, marketType),
        eq(paperBetsTable.status, "won"),
      ),
    );

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

interface ColdMarketEntry {
  excludedUntil: Date;
}

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
    if (new Date() < cached.excludedUntil) {
      return true;
    }
    coldMarketCache.delete(key);
  }

  if (stats.betCount >= minBets && stats.roi < threshold) {
    const excludedUntil = new Date();
    excludedUntil.setDate(excludedUntil.getDate() + cooldownDays);
    coldMarketCache.set(key, { excludedUntil });

    await db.insert(learningNarrativesTable).values({
      narrativeType: "strategy_shift",
      narrativeText: `Temporarily excluding ${league} ${marketType} after ${stats.betCount} bets at ${stats.roi.toFixed(1)}% ROI. Will re-evaluate in ${cooldownDays} days.`,
      relatedData: { league, marketType, betCount: stats.betCount, roi: stats.roi, excludedUntil },
      createdAt: new Date(),
    });

    await db.insert(complianceLogsTable).values({
      actionType: "decision",
      details: {
        action: "cold_market_excluded",
        league,
        marketType,
        betCount: stats.betCount,
        roi: stats.roi,
        excludedUntil,
        reason: `ROI ${stats.roi.toFixed(1)}% below threshold ${threshold}% after ${stats.betCount} bets`,
      },
      timestamp: new Date(),
    });

    logger.warn(
      { league, marketType, roi: stats.roi, excludedUntil },
      "Cold market excluded",
    );
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
    .select({
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
      settledAt: paperBetsTable.settledAt,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(matchesTable.league, league),
        eq(paperBetsTable.marketType, marketType),
        gte(paperBetsTable.settledAt, weeksAgo),
      ),
    );

  const finalBets = recentBets.filter(
    (b) => b.status === "won" || b.status === "lost",
  );
  if (finalBets.length === 0) return 0;

  // Group by ISO week
  const weekMap = new Map<string, { bets: number; pnl: number; stake: number }>();
  for (const b of finalBets) {
    if (!b.settledAt) continue;
    const d = new Date(b.settledAt);
    const dayOfWeek = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((dayOfWeek + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    const entry = weekMap.get(key) ?? { bets: 0, pnl: 0, stake: 0 };
    entry.bets++;
    entry.pnl += Number(b.settlementPnl ?? 0);
    entry.stake += Number(b.stake ?? 0);
    weekMap.set(key, entry);
  }

  const weeks = [...weekMap.values()];
  const profitableWeeks = weeks.filter(
    (w) => w.bets >= minBetsPerWeek && w.pnl > 0,
  );

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

// ─── Opportunity scoring ──────────────────────────────────────────────────────

function computeOpportunityScore(params: {
  edge: number;
  modelProbability: number;
  backOdds: number;
  segmentStats: SegmentStats;
  hotStreakBonus: number;
}): number {
  const { edge, modelProbability, backOdds, segmentStats, hotStreakBonus } = params;

  // 1. Edge size: (edge / 0.15) * 25, max 25
  const edgeScore = Math.min((edge / 0.15) * 25, 25);

  // 2. Model confidence: distance from 50% × 50, max 25
  const confidenceScore = Math.min(Math.abs(modelProbability - 0.5) * 50, 25);

  // 3. Historical segment ROI (max 20)
  let segmentScore = 0;
  if (segmentStats.betCount >= 3 && segmentStats.roi > 0) {
    segmentScore = Math.min(segmentStats.roi, 20);
  }

  // 4. Sample reliability: min(count/20, 1) × 15, max 15
  const reliabilityScore = Math.min(segmentStats.betCount / 20, 1) * 15;

  // 5. Odds sweet spot
  let oddsScore = 0;
  if (backOdds >= 1.8 && backOdds <= 3.5) {
    oddsScore = 15;
  } else if (
    (backOdds >= 1.5 && backOdds < 1.8) ||
    (backOdds > 3.5 && backOdds <= 5.0)
  ) {
    oddsScore = 8;
  }

  const raw =
    edgeScore + confidenceScore + segmentScore + reliabilityScore + oddsScore + hotStreakBonus;

  return Math.min(Math.round(raw * 100) / 100, 100);
}

// ─── Synthetic odds generator (paper-trading fallback) ───────────────────────
//
// When no exchange odds exist for a match, we generate a realistic bookmaker
// market using Poisson goal models and team-form features.  A 7% vig is
// applied so the market is slightly priced against us — the ML model only
// finds +EV when it has genuine conviction beyond the baseline.

interface SyntheticOddsRow {
  marketType: string;
  selectionName: string;
  backOdds: number;
  source: "synthetic";
}

function poissonCdf(lambda: number, k: number): number {
  let p = 0;
  let fac = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) fac *= i;
    p += (Math.pow(lambda, i) * Math.exp(-lambda)) / fac;
  }
  return p;
}

function generateSyntheticOdds(
  featureMap: Record<string, number>,
): SyntheticOddsRow[] {
  const VIG = 1.07;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  const homeForm = featureMap["home_form_last5"] ?? 0.4;
  const awayForm = featureMap["away_form_last5"] ?? 0.35;
  const homeScoredAvg = featureMap["home_goals_scored_avg"] ?? 1.5;
  const awayScoredAvg = featureMap["away_goals_scored_avg"] ?? 1.2;
  const homeConcededAvg = featureMap["home_goals_conceded_avg"] ?? 1.2;
  const awayConcededAvg = featureMap["away_goals_conceded_avg"] ?? 1.5;

  // 1X2 market via form-adjusted Elo-like strengths
  const homeStrength = clamp(homeForm + 0.08, 0.05, 0.9); // +8% home advantage
  const awayStrength = clamp(awayForm, 0.05, 0.85);
  const rawDraw = clamp(0.28 - 0.15 * Math.abs(homeStrength - awayStrength), 0.05, 0.4);
  const total = homeStrength + awayStrength + rawDraw;
  const homeProb = homeStrength / total;
  const drawProb = rawDraw / total;
  const awayProb = awayStrength / total;

  const homeOdds = clamp((1 / homeProb) / VIG, 1.05, 20);
  const drawOdds = clamp((1 / drawProb) / VIG, 1.05, 20);
  const awayOdds = clamp((1 / awayProb) / VIG, 1.05, 20);

  // BTTS market via Poisson
  const expHome = clamp((homeScoredAvg + awayConcededAvg) / 2, 0.3, 5);
  const expAway = clamp((awayScoredAvg + homeConcededAvg) / 2, 0.3, 5);
  const pHomeSc = 1 - Math.exp(-expHome);
  const pAwaySc = 1 - Math.exp(-expAway);
  const bttsYesProb = clamp(pHomeSc * pAwaySc, 0.05, 0.95);
  const bttsYesOdds = clamp((1 / bttsYesProb) / VIG, 1.05, 20);
  const bttsNoOdds = clamp((1 / (1 - bttsYesProb)) / VIG, 1.05, 20);

  // Over/Under 2.5 via Poisson CDF
  const totalLambda = expHome + expAway;
  const under25Prob = clamp(poissonCdf(totalLambda, 2), 0.05, 0.95);
  const over25Prob = 1 - under25Prob;
  const over25Odds = clamp((1 / over25Prob) / VIG, 1.05, 20);
  const under25Odds = clamp((1 / under25Prob) / VIG, 1.05, 20);

  return [
    { marketType: "MATCH_ODDS", selectionName: "Home", backOdds: homeOdds, source: "synthetic" },
    { marketType: "MATCH_ODDS", selectionName: "Draw", backOdds: drawOdds, source: "synthetic" },
    { marketType: "MATCH_ODDS", selectionName: "Away", backOdds: awayOdds, source: "synthetic" },
    { marketType: "BTTS", selectionName: "Yes", backOdds: bttsYesOdds, source: "synthetic" },
    { marketType: "BTTS", selectionName: "No", backOdds: bttsNoOdds, source: "synthetic" },
    { marketType: "OVER_UNDER_25", selectionName: "Over 2.5 Goals", backOdds: over25Odds, source: "synthetic" },
    { marketType: "OVER_UNDER_25", selectionName: "Under 2.5 Goals", backOdds: under25Odds, source: "synthetic" },
  ];
}

// ─── Main detection function ──────────────────────────────────────────────────

export async function detectValueBets(): Promise<EvaluationSummary> {
  const modelVersion = getModelVersion();
  logger.info({ modelVersion }, "Running value detection");

  const configKeys = [
    "min_edge_threshold",
    "min_opportunity_score",
    "cold_market_threshold",
    "cold_market_min_bets",
    "cold_market_cooldown_days",
    "hot_streak_weeks",
    "hot_streak_min_bets_per_week",
    "hot_streak_bonus",
  ];

  const configRows = await db.select().from(agentConfigTable);
  const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));

  const minEdge = Number(cfg.min_edge_threshold ?? "0.03");
  const minOppScore = Number(cfg.min_opportunity_score ?? "60");
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

  let syntheticOddsUsed = 0;
  let realOddsUsed = 0;

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

    const publicFeatures = featureRows.filter(
      (f) => !f.featureName.startsWith("_"),
    );
    if (publicFeatures.length < 8) continue;

    const featureMap: Record<string, number> = {};
    for (const f of publicFeatures) {
      featureMap[f.featureName] = Number(f.featureValue);
    }

    const outcomePreds = predictOutcome(featureMap);
    const bttsPreds = predictBtts(featureMap);
    const ouPreds = predictOverUnder(featureMap);

    // Use real odds if available, otherwise generate synthetic odds from features
    type OddsRow = { marketType: string; selectionName: string; backOdds: string | number | null; source?: string };
    let oddsSource: OddsRow[];
    if (oddsRows.length > 0) {
      realOddsUsed++;
      oddsSource = oddsRows;
    } else {
      syntheticOddsUsed++;
      oddsSource = generateSyntheticOdds(featureMap);
    }

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

      let modelProb: number | null = null;
      if (oddsRow.marketType === "MATCH_ODDS" && outcomePreds) {
        if (oddsRow.selectionName === "Home") modelProb = outcomePreds.home;
        else if (oddsRow.selectionName === "Draw") modelProb = outcomePreds.draw;
        else if (oddsRow.selectionName === "Away") modelProb = outcomePreds.away;
      } else if (oddsRow.marketType === "BTTS" && bttsPreds) {
        if (oddsRow.selectionName === "Yes") modelProb = bttsPreds.yes;
        else if (oddsRow.selectionName === "No") modelProb = bttsPreds.no;
      } else if (oddsRow.marketType === "OVER_UNDER_25" && ouPreds) {
        if (oddsRow.selectionName === "Over 2.5 Goals") modelProb = ouPreds.over;
        else if (oddsRow.selectionName === "Under 2.5 Goals") modelProb = ouPreds.under;
      }

      if (modelProb === null) continue;
      selectionsEvaluated++;

      const edge = modelProb - impliedProb;
      if (edge <= minEdge) {
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
            minEdgeThreshold: minEdge,
            decision: "skip_low_edge",
            modelVersion,
          },
          timestamp: new Date(),
        });
        continue;
      }

      const segmentStats = await getSegmentStats(match.league, oddsRow.marketType);

      const cold = await isColdMarket(
        match.league,
        oddsRow.marketType,
        segmentStats,
        coldMinBets,
        coldThreshold,
        coldCooldownDays,
      );
      if (cold) {
        await db.insert(complianceLogsTable).values({
          actionType: "value_detection_evaluation",
          details: {
            matchId: match.id,
            marketType: oddsRow.marketType,
            selectionName: oddsRow.selectionName,
            decision: "skip_cold_market",
            league: match.league,
            segmentRoi: segmentStats.roi,
          },
          timestamp: new Date(),
        });
        continue;
      }

      const streakBonus = await getHotStreakBonus(
        match.league,
        oddsRow.marketType,
        hotWeeks,
        hotMinBets,
        hotBonus,
      );

      const opportunityScore = computeOpportunityScore({
        edge,
        modelProbability: modelProb,
        backOdds,
        segmentStats,
        hotStreakBonus: streakBonus,
      });

      const decision =
        opportunityScore >= minOppScore ? "value_bet" : "skip_low_score";

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
          modelVersion,
        },
        timestamp: new Date(),
      });

      if (opportunityScore >= minOppScore) {
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
        });
      }
    }
  }

  // Sort by opportunity score descending
  valueBets.sort((a, b) => b.opportunityScore - a.opportunityScore);

  logger.info(
    {
      matchesEvaluated: matches.length,
      selectionsEvaluated,
      valueBetsFound: valueBets.length,
      realOddsUsed,
      syntheticOddsUsed,
    },
    "Value detection complete",
  );

  return {
    matchesEvaluated: matches.length,
    selectionsEvaluated,
    valueBetsFound: valueBets.length,
    modelVersion,
    valueBets,
  };
}
