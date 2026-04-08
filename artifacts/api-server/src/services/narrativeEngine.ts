import { db, learningNarrativesTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { RetrainResult } from "./predictionEngine";

export interface StrategySegment {
  key: string;
  league: string;
  marketType: string;
  bets: number;
  wins: number;
  totalStake: number;
  totalPnl: number;
  winRate: number;
  roi: number;
  avgEdge: number;
}

export interface StrategyPerformanceSummary {
  segments: StrategySegment[];
  best: StrategySegment | null;
  worst: StrategySegment | null;
}

// ===================== Narrative helpers =====================

function pct(n: number, dp = 1): string {
  return (n * 100).toFixed(dp) + "%";
}

function rank(
  importances: Record<string, number>,
  feature: string,
): number {
  const sorted = Object.entries(importances).sort((a, b) => b[1] - a[1]);
  return sorted.findIndex(([k]) => k === feature) + 1;
}

// ===================== Generate and persist narratives =====================

async function persist(
  narrativeType: string,
  narrativeText: string,
  relatedData: unknown,
): Promise<void> {
  await db.insert(learningNarrativesTable).values({
    narrativeType,
    narrativeText,
    relatedData: relatedData as Record<string, unknown>,
  });
  logger.info({ narrativeType }, "Narrative stored");
}

export async function generateNarratives(
  result: RetrainResult,
  strategy: StrategyPerformanceSummary,
  previousFeatureImportances: Record<string, number> | null,
): Promise<void> {
  const newAcc = result.valAccuracy.avg;
  const oldAcc = result.previousAccuracy;

  // ── Accuracy change ──────────────────────────────────────────────────────
  if (oldAcc !== null) {
    const delta = newAcc - oldAcc;
    const dir = delta >= 0 ? "improved" : "decreased";
    const deltaPct = Math.abs(delta * 100).toFixed(1);
    await persist(
      "model_accuracy_change",
      `Model accuracy ${dir} from ${pct(oldAcc)} to ${pct(newAcc)} (${dir === "improved" ? "+" : "-"}${deltaPct}pp) after retraining on ${result.trainSize + result.valSize} bets. ${
        delta >= 0.01
          ? "The agent is getting better at predicting outcomes."
          : delta <= -0.02
            ? "Performance dipped — may need more diverse training data."
            : "Accuracy is broadly stable."
      }`,
      {
        previousAccuracy: oldAcc,
        newAccuracy: newAcc,
        delta,
        trainSize: result.trainSize,
        valSize: result.valSize,
        calibrationScore: result.calibrationScore,
        version: result.version,
        previousVersion: result.previousVersion,
      },
    );
  } else {
    await persist(
      "model_first_retrain",
      `First live-bet retraining completed using ${result.trainSize + result.valSize} settled bets. ` +
        `Validation accuracy: ${pct(newAcc)} (outcome ${pct(result.valAccuracy.outcome)}, BTTS ${pct(result.valAccuracy.btts)}, O/U ${pct(result.valAccuracy.overUnder)}). ` +
        `Calibration (Brier score): ${result.calibrationScore.toFixed(4)} — lower is better.`,
      result,
    );
  }

  // ── Calibration ──────────────────────────────────────────────────────────
  const calibDesc =
    result.calibrationScore < 0.18
      ? "excellent — model probabilities closely match real outcomes"
      : result.calibrationScore < 0.25
        ? "acceptable — some overconfidence may exist"
        : "poor — model may be overfit or underfit; consider more diverse data";

  await persist(
    "calibration_report",
    `Calibration (Brier score) after retraining: ${result.calibrationScore.toFixed(4)} — ${calibDesc}. ` +
      `Train accuracy: ${pct(result.trainAccuracy.avg)}, validation accuracy: ${pct(result.valAccuracy.avg)}. ` +
      `Gap: ${((result.trainAccuracy.avg - result.valAccuracy.avg) * 100).toFixed(1)}pp ` +
      `(${result.trainAccuracy.avg - result.valAccuracy.avg > 0.05 ? "possible overfitting" : "healthy generalisation"}).`,
    {
      calibrationScore: result.calibrationScore,
      trainAccuracy: result.trainAccuracy,
      valAccuracy: result.valAccuracy,
    },
  );

  // ── Feature importance changes ───────────────────────────────────────────
  if (previousFeatureImportances) {
    const newImportances = result.featureImportances;
    const allFeatures = Object.keys(newImportances);

    for (const feature of allFeatures) {
      const oldVal = previousFeatureImportances[feature];
      const newVal = newImportances[feature];
      if (oldVal === undefined || newVal === undefined) continue;

      const newRank = rank(newImportances, feature);
      const oldRank = rank(previousFeatureImportances, feature);
      const rankChange = oldRank - newRank; // positive = moved up (better rank)

      if (Math.abs(rankChange) >= 2) {
        const dir = rankChange > 0 ? "risen" : "dropped";
        await persist(
          "feature_importance_change",
          `Feature '${feature}' has ${dir} in importance for match outcome predictions. ` +
            `Current rank: #${newRank} (was #${oldRank}). ` +
            `Weight change: ${oldVal.toFixed(4)} → ${newVal.toFixed(4)}.`,
          { feature, oldRank, newRank, rankChange, oldWeight: oldVal, newWeight: newVal },
        );
      }
    }
  }

  // ── Strategy performance by segment ──────────────────────────────────────
  if (strategy.best && strategy.best.bets >= 3) {
    const b = strategy.best;
    const conf =
      b.bets >= 10 ? "HIGH" : b.bets >= 5 ? "MEDIUM" : "LOW";
    await persist(
      "strategy_best_segment",
      `${b.marketType} in ${b.league} is the best performing segment. ` +
        `${b.bets} bets, win rate ${pct(b.winRate)}, ROI ${b.roi.toFixed(1)}%, avg edge ${pct(b.avgEdge, 2)}. ` +
        `Confidence: ${conf}.`,
      b,
    );
  }

  if (strategy.worst && strategy.worst.bets >= 3 && strategy.worst.roi < -5) {
    const w = strategy.worst;
    await persist(
      "strategy_worst_segment",
      `${w.marketType} in ${w.league} is underperforming. ` +
        `${w.bets} bets, win rate ${pct(w.winRate)}, ROI ${w.roi.toFixed(1)}%. ` +
        `Consider reducing stake allocation for this segment.`,
      w,
    );
  }

  // ── Profitable sustained edge ─────────────────────────────────────────────
  const sustained = strategy.segments.filter(
    (s) => s.bets >= 5 && s.roi > 5,
  );
  for (const seg of sustained.slice(0, 3)) {
    const conf = seg.bets >= 20 ? "HIGH" : seg.bets >= 10 ? "MEDIUM" : "LOW";
    await persist(
      "sustained_positive_edge",
      `${seg.marketType} in ${seg.league} has been profitable across ${seg.bets} bets ` +
        `(ROI ${seg.roi.toFixed(1)}%, avg edge ${pct(seg.avgEdge, 2)}). Confidence: ${conf}.`,
      seg,
    );
  }

  logger.info(
    { narrativesGenerated: true, version: result.version },
    "Narrative generation complete",
  );
}

// ===================== Retrieve recent narratives =====================

export async function getRecentNarratives(limit = 20): Promise<
  {
    id: number;
    narrativeType: string;
    narrativeText: string;
    relatedData: unknown;
    createdAt: Date;
  }[]
> {
  return db
    .select()
    .from(learningNarrativesTable)
    .orderBy(desc(learningNarrativesTable.createdAt))
    .limit(Math.min(limit, 100));
}
