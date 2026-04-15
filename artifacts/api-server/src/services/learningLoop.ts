import {
  db,
  paperBetsTable,
  matchesTable,
  modelStateTable,
  leagueEdgeScoresTable,
  learningNarrativesTable,
  complianceLogsTable,
} from "@workspace/db";
import {
  inArray,
  desc,
  and,
  isNotNull,
  sql,
  eq,
} from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  forceRetrain,
  type RetrainResult,
} from "./predictionEngine";
import {
  generateNarratives,
  type StrategySegment,
  type StrategyPerformanceSummary,
} from "./narrativeEngine";

// ===================== Strategy performance =====================

export async function calculateStrategyPerformance(): Promise<StrategyPerformanceSummary> {
  const settledBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      calculatedEdge: paperBetsTable.calculatedEdge,
      status: paperBetsTable.status,
    })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost"]));

  if (settledBets.length === 0) {
    return { segments: [], best: null, worst: null };
  }

  const uniqueMatchIds = [...new Set(settledBets.map((b) => b.matchId))];
  const matches = await db
    .select({ id: matchesTable.id, league: matchesTable.league })
    .from(matchesTable)
    .where(inArray(matchesTable.id, uniqueMatchIds));

  const leagueMap = new Map(matches.map((m) => [m.id, m.league]));

  // Group by league + marketType
  const groups = new Map<string, {
    league: string;
    marketType: string;
    bets: number;
    wins: number;
    totalStake: number;
    totalPnl: number;
    edgeSum: number;
  }>();

  for (const bet of settledBets) {
    const league = leagueMap.get(bet.matchId) ?? "Unknown";
    const key = `${league}::${bet.marketType}`;

    const existing = groups.get(key) ?? {
      league,
      marketType: bet.marketType,
      bets: 0,
      wins: 0,
      totalStake: 0,
      totalPnl: 0,
      edgeSum: 0,
    };

    existing.bets++;
    if (bet.status === "won") existing.wins++;
    existing.totalStake += Number(bet.stake);
    existing.totalPnl += Number(bet.settlementPnl ?? 0);
    existing.edgeSum += Number(bet.calculatedEdge ?? 0);

    groups.set(key, existing);
  }

  const segments: StrategySegment[] = Array.from(groups.entries()).map(
    ([key, g]) => ({
      key,
      league: g.league,
      marketType: g.marketType,
      bets: g.bets,
      wins: g.wins,
      totalStake: Math.round(g.totalStake * 100) / 100,
      totalPnl: Math.round(g.totalPnl * 100) / 100,
      winRate: g.bets > 0 ? g.wins / g.bets : 0,
      roi: g.totalStake > 0 ? (g.totalPnl / g.totalStake) * 100 : 0,
      avgEdge: g.bets > 0 ? g.edgeSum / g.bets : 0,
    }),
  );

  // Sort by ROI descending
  const sorted = [...segments].sort((a, b) => b.roi - a.roi);
  const qualified = sorted.filter((s) => s.bets >= 2);

  return {
    segments,
    best: qualified[0] ?? null,
    worst: qualified[qualified.length - 1] ?? null,
  };
}

// ===================== League edge score self-learning =====================

export async function updateLeagueEdgeScores(): Promise<void> {
  // Load all settled bets with league data
  const settledBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      stake: paperBetsTable.stake,
      settlementPnl: paperBetsTable.settlementPnl,
      calculatedEdge: paperBetsTable.calculatedEdge,
      clvPct: paperBetsTable.clvPct,
      status: paperBetsTable.status,
    })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost"]));

  if (settledBets.length === 0) {
    logger.info("updateLeagueEdgeScores: no settled bets — using seed data only");
    return;
  }

  const uniqueMatchIds = [...new Set(settledBets.map((b) => b.matchId))];
  const matchRows = await db
    .select({ id: matchesTable.id, league: matchesTable.league })
    .from(matchesTable)
    .where(inArray(matchesTable.id, uniqueMatchIds));
  const leagueMap = new Map(matchRows.map((m) => [m.id, m.league]));

  // Group by league (ALL market type for aggregate)
  const groups = new Map<string, {
    league: string;
    bets: number;
    wins: number;
    totalStake: number;
    totalPnl: number;
    edgeSum: number;
    clvSum: number;
    clvCount: number;
  }>();

  for (const bet of settledBets) {
    const league = leagueMap.get(bet.matchId) ?? null;
    if (!league) continue;

    const existing = groups.get(league) ?? {
      league,
      bets: 0,
      wins: 0,
      totalStake: 0,
      totalPnl: 0,
      edgeSum: 0,
      clvSum: 0,
      clvCount: 0,
    };

    existing.bets++;
    if (bet.status === "won") existing.wins++;
    existing.totalStake += Number(bet.stake);
    existing.totalPnl += Number(bet.settlementPnl ?? 0);
    existing.edgeSum += Number(bet.calculatedEdge ?? 0);
    if (bet.clvPct !== null && bet.clvPct !== undefined) {
      existing.clvSum += Number(bet.clvPct);
      existing.clvCount++;
    }
    groups.set(league, existing);
  }

  // Load seed confidence scores for blending
  const seedRows = await db
    .select({ league: leagueEdgeScoresTable.league, confidenceScore: leagueEdgeScoresTable.confidenceScore })
    .from(leagueEdgeScoresTable);
  const seedScoreMap = new Map(seedRows.map((r) => [r.league, r.confidenceScore]));

  for (const [league, g] of groups.entries()) {
    if (g.bets < 3) continue; // Need at least 3 bets to start updating

    const roi = g.totalStake > 0 ? (g.totalPnl / g.totalStake) * 100 : 0;
    const winRate = g.bets > 0 ? g.wins / g.bets : 0;
    const avgEdge = g.bets > 0 ? (g.edgeSum / g.bets) * 100 : 0;
    const avgClv = g.clvCount > 0 ? g.clvSum / g.clvCount : 0;

    // Sample reliability: 0 → 1 as bets grow from 0 → 20+
    const sampleReliability = Math.min(g.bets / 20, 1);

    // Actual performance score: 50 baseline + adjustments for ROI, CLV, win rate
    // roi: each % of ROI adds/subtracts 2 pts
    // avgClv: each % of CLV adds/subtracts 3 pts
    // winRate: 50% = neutral, 60% = +2, 40% = -2
    const actualScore = Math.max(0, Math.min(100,
      50 +
      (roi * 2) +
      (avgClv * 3) +
      ((winRate - 0.5) * 20)
    ));

    // Blend: seed score fades out as sample grows; actual score fades in
    const seedScore = seedScoreMap.get(league) ?? 50;
    const confidenceScore = seedScore * (1 - sampleReliability) + actualScore * sampleReliability;

    const prevScore = seedScoreMap.get(league) ?? 50;
    const scoreDelta = confidenceScore - prevScore;

    // Update the DB
    await db
      .insert(leagueEdgeScoresTable)
      .values({
        league,
        marketType: "ALL",
        totalBets: g.bets,
        wins: g.wins,
        losses: g.bets - g.wins,
        roiPct: Math.round(roi * 100) / 100,
        avgClv: Math.round(avgClv * 100) / 100,
        avgEdge: Math.round(avgEdge * 100) / 100,
        confidenceScore: Math.round(confidenceScore * 10) / 10,
        isSeedData: 0,
        lastUpdated: new Date(),
      })
      .onConflictDoUpdate({
        target: [leagueEdgeScoresTable.league, leagueEdgeScoresTable.marketType],
        set: {
          totalBets: g.bets,
          wins: g.wins,
          losses: g.bets - g.wins,
          roiPct: Math.round(roi * 100) / 100,
          avgClv: Math.round(avgClv * 100) / 100,
          avgEdge: Math.round(avgEdge * 100) / 100,
          confidenceScore: Math.round(confidenceScore * 10) / 10,
          isSeedData: 0,
          lastUpdated: new Date(),
        },
      });

    // Generate narrative if score changed significantly
    if (Math.abs(scoreDelta) >= 3 && g.bets >= 5) {
      const direction = scoreDelta > 0 ? "promoted" : "demoted";
      const clvStr = avgClv > 0 ? `+${avgClv.toFixed(1)}%` : `${avgClv.toFixed(1)}%`;
      let narrativeText: string;

      if (scoreDelta > 0) {
        narrativeText = `League focus shifting: ${league} ${direction} — ${roi.toFixed(1)}% ROI and ${clvStr} CLV over ${g.bets} bets. Edge score: ${prevScore.toFixed(0)} → ${confidenceScore.toFixed(0)}. Allocating more OddsPapi budget here.`;
      } else if (avgClv < 0) {
        narrativeText = `League deprioritised: ${league} ${direction} — negative CLV of ${clvStr} suggests bookmaker odds are already efficient. Edge score: ${prevScore.toFixed(0)} → ${confidenceScore.toFixed(0)}. Reducing exposure.`;
      } else {
        narrativeText = `${league} edge score adjusted to ${confidenceScore.toFixed(0)} based on ${g.bets} settled bets (${roi.toFixed(1)}% ROI, ${clvStr} CLV).`;
      }

      await db.insert(learningNarrativesTable).values({
        narrativeType: "league_allocation",
        narrativeText,
        relatedData: { league, prevScore, newScore: confidenceScore, bets: g.bets, roi, avgClv, avgEdge, winRate },
        createdAt: new Date(),
      });

      await db.insert(complianceLogsTable).values({
        actionType: "league_score_update",
        details: { league, prevScore, newScore: confidenceScore, bets: g.bets, roi, avgClv, avgEdge, sampleReliability },
        timestamp: new Date(),
      });

      logger.info({ league, prevScore, newScore: confidenceScore, bets: g.bets, roi, avgClv }, "League edge score updated");
    }

    // New discovery narrative
    if (g.bets >= 5 && avgEdge > 0.10 && roi > 0) {
      const hasPriorNarrative = (await db
        .select({ id: learningNarrativesTable.id })
        .from(learningNarrativesTable)
        .where(and(
          eq(learningNarrativesTable.narrativeType, "league_discovery"),
          eq(learningNarrativesTable.narrativeText, `NEW_DISCOVERY_${league}`),
        ))
        .limit(1)).length > 0;

      if (!hasPriorNarrative) {
        await db.insert(learningNarrativesTable).values({
          narrativeType: "league_discovery",
          narrativeText: `New discovery: ${league} showing ${avgEdge.toFixed(1)}% average edge over ${g.bets} bets. This is the model's current strongest opportunity in this league.`,
          relatedData: { league, avgEdge, bets: g.bets, roi },
          createdAt: new Date(),
        });
      }
    }
  }

  logger.info({ leaguesUpdated: groups.size }, "League edge scores updated from actual performance data");
}

// ===================== Main learning loop =====================

let learningLoopRunning = false;

export interface LearningLoopResult {
  skipped?: boolean;
  reason?: string;
  retrainResult?: RetrainResult | null;
  strategySegments?: number;
  narrativesGenerated: boolean;
}

export async function runLearningLoop(): Promise<LearningLoopResult> {
  if (learningLoopRunning) {
    logger.warn("Learning loop already in progress — skipping");
    return { skipped: true, reason: "already_running", narrativesGenerated: false };
  }
  learningLoopRunning = true;

  try {
    logger.info("Learning loop started");

    // 1. Fetch previous model state's feature importances for narrative comparison
    const prevState = await db
      .select({
        featureImportances: modelStateTable.featureImportances,
        accuracyScore: modelStateTable.accuracyScore,
      })
      .from(modelStateTable)
      .orderBy(desc(modelStateTable.createdAt))
      .limit(1);

    const previousFeatureImportances =
      (prevState[0]?.featureImportances as Record<string, number> | null) ??
      null;

    // 2. Retrain models with 80/20 train/val split
    logger.info("Retraining models with train/val split");
    const retrainResult = await forceRetrain();

    if (!retrainResult) {
      logger.warn("Retraining skipped — insufficient data");
      return {
        skipped: true,
        reason: "insufficient_data",
        retrainResult: null,
        narrativesGenerated: false,
      };
    }

    // 3. Calculate strategy performance by segment
    logger.info("Calculating strategy performance");
    const strategyPerformance = await calculateStrategyPerformance();

    // Update strategy_weights in the newly saved model state with segment data
    await db
      .update(modelStateTable)
      .set({
        strategyWeights: {
          ...(await db
            .select({ strategyWeights: modelStateTable.strategyWeights })
            .from(modelStateTable)
            .orderBy(desc(modelStateTable.createdAt))
            .limit(1)
            .then((r) => (r[0]?.strategyWeights as Record<string, unknown>) ?? {})),
          strategyPerformance: {
            segments: strategyPerformance.segments,
            best: strategyPerformance.best,
            worst: strategyPerformance.worst,
            generatedAt: new Date().toISOString(),
          },
        },
      })
      .where(eq(modelStateTable.modelVersion, retrainResult.version));

    // 4. Update league edge scores from actual performance data
    logger.info("Updating league edge scores from settled bets");
    await updateLeagueEdgeScores();

    // 5. Generate and persist narratives
    logger.info("Generating learning narratives");
    await generateNarratives(
      retrainResult,
      strategyPerformance,
      previousFeatureImportances,
    );

    // 6. Generate model health report (weekly deep analysis)
    try {
      const { generateModelHealthReport } = await import("./modelHealthReport");
      const healthReport = await generateModelHealthReport();
      logger.info(
        { calibration: healthReport.calibrationScore, verdict: healthReport.northStarVerdict.diagnosis.slice(0, 40) },
        "Model health report generated as part of learning loop",
      );
    } catch (err) {
      logger.error({ err }, "Model health report generation failed (non-blocking)");
    }

    // 7. Edge decay analysis
    try {
      const { analyzeEdgeDecay } = await import("./edgeDecay");
      const edgeDecay = await analyzeEdgeDecay();
      logger.info(
        { overallDecay: edgeDecay.overallAvgDecay, fastDecaying: edgeDecay.fastDecayingMarkets.length },
        "Edge decay analysis complete as part of learning loop",
      );
    } catch (err) {
      logger.error({ err }, "Edge decay analysis failed (non-blocking)");
    }

    // 8. Agent recommendations
    try {
      const { generateAgentRecommendations } = await import("./agentRecommendations");
      const recs = await generateAgentRecommendations();
      logger.info(
        { recommendations: recs.recommendations.length },
        "Agent recommendations generated as part of learning loop",
      );
    } catch (err) {
      logger.error({ err }, "Agent recommendations generation failed (non-blocking)");
    }

    logger.info(
      {
        version: retrainResult.version,
        valAccuracy: retrainResult.valAccuracy.avg,
        segments: strategyPerformance.segments.length,
      },
      "Learning loop complete",
    );

    return {
      retrainResult,
      strategySegments: strategyPerformance.segments.length,
      narrativesGenerated: true,
    };
  } catch (err) {
    logger.error({ err }, "Learning loop failed");
    return { skipped: true, reason: "error", narrativesGenerated: false };
  } finally {
    learningLoopRunning = false;
  }
}
