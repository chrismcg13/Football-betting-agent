import {
  db,
  paperBetsTable,
  matchesTable,
  modelStateTable,
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

    // 4. Generate and persist narratives
    logger.info("Generating learning narratives");
    await generateNarratives(
      retrainResult,
      strategyPerformance,
      previousFeatureImportances,
    );

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
