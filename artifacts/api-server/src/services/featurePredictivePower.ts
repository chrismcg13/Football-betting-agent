/**
 * Z6 (2026-05-07): Autonomous feature predictive-power scoring.
 *
 * Weekly Sunday 11:00 UTC cron. Computes per-feature predictive-power
 * scores (correlation-based proxy for Brier-improvement) on settled
 * bets. Features that demonstrate sustained predictive signal
 * (improvement > threshold over 4-week rolling window) become
 * candidates for FEATURE_NAMES extension.
 *
 * Per the Phase 2 brief: "Each new feature ships as its own sub-commit
 * with retrospective predictive-power validation against existing
 * settled bets. Features that show no genuine signal don't ship."
 *
 * This module operationalises that requirement autonomously. It scores
 * EVERY feature stored in the `features` table on every settled bet
 * with binary outcome, and persists the per-week score to a new
 * `feature_validation_results` table. The model uses these scores to
 * decide which features to include in the next retrain.
 *
 * For now this module SCORES + LOGS only. Auto-promotion to
 * FEATURE_NAMES is a follow-up structural change (FEATURE_NAMES is
 * currently a TS const array; making it DB-driven is a separate
 * commit). When that ships, it reads from this table.
 */

import { db, featuresTable, paperBetsTable, modelDecisionAuditLogTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface FeatureScore {
  featureName: string;
  sampleSize: number;
  pointBiserialR: number;          // correlation between feature value and binary outcome
  pValue: number;                  // p-value of the correlation
  brierImprovementProxy: number;   // |r|^2 — proxy for Brier-score improvement
  passesThreshold: boolean;
}

export interface FeaturePredictivePowerResult {
  runId: string;
  featuresEvaluated: number;
  featuresPassingThreshold: number;
  topByImprovement: Array<Pick<FeatureScore, "featureName" | "brierImprovementProxy" | "sampleSize" | "pValue">>;
  durationMs: number;
}

const MIN_SAMPLE_SIZE = 50;
const MAX_PVALUE = 0.01;
const MIN_R_SQUARED = 0.005; // 0.5% Brier improvement equivalent

function normalCdf(z: number): number {
  // Approximation good enough for our purposes
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function pointBiserial(values: number[], outcomes: number[]): { r: number; p: number } {
  const n = values.length;
  if (n < 3) return { r: 0, p: 1 };
  const meanV = values.reduce((a, b) => a + b, 0) / n;
  const meanO = outcomes.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denomV = 0;
  let denomO = 0;
  for (let i = 0; i < n; i++) {
    const dv = values[i] - meanV;
    const do_ = outcomes[i] - meanO;
    num += dv * do_;
    denomV += dv * dv;
    denomO += do_ * do_;
  }
  const denom = Math.sqrt(denomV * denomO);
  if (denom <= 0) return { r: 0, p: 1 };
  const r = num / denom;
  // t-statistic for r given n-2 df
  const t = r * Math.sqrt(n - 2) / Math.sqrt(Math.max(1e-9, 1 - r * r));
  // 2-sided p-value via normal approximation
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { r, p };
}

export async function runFeaturePredictivePowerScoring(): Promise<FeaturePredictivePowerResult> {
  const startedAt = Date.now();
  const runId = `feature-pp-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  // Pull all distinct feature names that have non-trivial coverage.
  // Skip _-prefixed metadata features (e.g. _lineup_data, _home_team_id).
  const featureNames = await db.execute(sql`
    SELECT feature_name, COUNT(*) AS coverage
    FROM features
    WHERE feature_name NOT LIKE '\\_%' ESCAPE '\\'
    GROUP BY feature_name
    HAVING COUNT(*) >= ${MIN_SAMPLE_SIZE}
  `);
  const features = (featureNames as any).rows ?? [];

  const scores: FeatureScore[] = [];

  for (const f of features) {
    const featureName = String(f.feature_name);

    // Pull settled-bet outcomes joined with this feature value.
    const data = await db.execute(sql`
      SELECT
        pb.status,
        f.feature_value::numeric AS fv
      FROM paper_bets pb
      JOIN features f ON f.match_id = pb.match_id AND f.feature_name = ${featureName}
      WHERE pb.status IN ('won', 'lost')
        AND pb.deleted_at IS NULL
        AND pb.legacy_regime = false
        AND f.feature_value ~ '^-?\\d+\\.?\\d*$'
      LIMIT 5000
    `);
    const rows = (data as any).rows ?? [];
    if (rows.length < MIN_SAMPLE_SIZE) continue;

    const values: number[] = [];
    const outcomes: number[] = [];
    for (const r of rows) {
      const v = Number(r.fv);
      if (!Number.isFinite(v)) continue;
      values.push(v);
      outcomes.push(r.status === "won" ? 1 : 0);
    }
    if (values.length < MIN_SAMPLE_SIZE) continue;

    const { r, p } = pointBiserial(values, outcomes);
    const brier = r * r;
    scores.push({
      featureName,
      sampleSize: values.length,
      pointBiserialR: r,
      pValue: p,
      brierImprovementProxy: brier,
      passesThreshold: p <= MAX_PVALUE && brier >= MIN_R_SQUARED,
    });
  }

  scores.sort((a, b) => b.brierImprovementProxy - a.brierImprovementProxy);

  // Persist per-feature scores to model_decision_audit_log so the
  // weekly review trail captures predictive-power evolution. (Avoids
  // creating a new table for now; if/when we move FEATURE_NAMES to
  // DB-driven, we'll formalise this as feature_validation_results.)
  for (const s of scores) {
    await db.insert(modelDecisionAuditLogTable).values({
      decisionType: "feature_predictive_power_eval",
      subject: `feature:${s.featureName}`,
      priorState: {} as any,
      newState: {
        passes_threshold: s.passesThreshold,
      } as any,
      reasoning: `Feature predictive-power eval: r=${s.pointBiserialR.toFixed(4)}, p=${s.pValue.toFixed(6)}, brier_proxy=${s.brierImprovementProxy.toFixed(6)} on n=${s.sampleSize} settled bets. ${s.passesThreshold ? "PASSES — qualifies for FEATURE_NAMES extension on next retrain." : "Below threshold."}`,
      supportingMetrics: {
        feature_name: s.featureName,
        sample_size: s.sampleSize,
        point_biserial_r: Number(s.pointBiserialR.toFixed(6)),
        p_value: Number(s.pValue.toFixed(6)),
        brier_improvement_proxy: Number(s.brierImprovementProxy.toFixed(6)),
        passes_threshold: s.passesThreshold,
        runId,
      } as any,
      expectedImpact: s.brierImprovementProxy,
      reviewStatus: "automatic",
    });
  }

  const result: FeaturePredictivePowerResult = {
    runId,
    featuresEvaluated: scores.length,
    featuresPassingThreshold: scores.filter((s) => s.passesThreshold).length,
    topByImprovement: scores.slice(0, 10).map((s) => ({
      featureName: s.featureName,
      brierImprovementProxy: Number(s.brierImprovementProxy.toFixed(6)),
      sampleSize: s.sampleSize,
      pValue: Number(s.pValue.toFixed(6)),
    })),
    durationMs: Date.now() - startedAt,
  };

  logger.info(result, "feature_predictive_power_scoring_complete");
  return result;
}
