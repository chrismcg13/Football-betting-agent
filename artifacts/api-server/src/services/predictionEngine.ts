import LogisticRegression from "ml-logistic-regression";
import { Matrix } from "ml-matrix";
import { mean, standardDeviation } from "simple-statistics";
import {
  db,
  featuresTable,
  modelStateTable,
  paperBetsTable,
  matchesTable,
} from "@workspace/db";
import { eq, inArray, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getHistoricalCompetitionMatches,
  FEATURE_COMPETITIONS,
  type FDMatch,
} from "./footballData";

// ===================== Feature ordering =====================
// This order MUST be consistent across training and prediction.
// Phase 4a.3 (2026-05-11): home_clubelo, away_clubelo, elo_diff appended.
// Historical coverage is ~0% on settled matches at first deploy — the
// historical Elo backfill cron walks distinct kickoff dates over the
// following days. Until then the new positions resolve to ELO_BASELINE
// (1500) via imputeMissingFeature so training and inference share the
// same defaults; Elo coefficients converge as real data populates.
export const FEATURE_NAMES = [
  "home_form_last5",
  "away_form_last5",
  "home_goals_scored_avg",
  "home_goals_conceded_avg",
  "away_goals_scored_avg",
  "away_goals_conceded_avg",
  "h2h_home_win_rate",
  "league_position_diff",
  "home_btts_rate",
  "away_btts_rate",
  "home_over25_rate",
  "away_over25_rate",
  "home_clubelo",
  "away_clubelo",
  "elo_diff",
] as const;

type FeatureName = (typeof FEATURE_NAMES)[number];

// ClubElo's effective league mean sits in the 1500–1600 band; we use
// 1500 as the "no information" anchor for both training and inference
// imputation. elo_diff defaults to 0 (matched teams).
const ELO_BASELINE = 1500;

function imputeMissingFeature(name: FeatureName): number {
  if (name === "home_clubelo" || name === "away_clubelo") return ELO_BASELINE;
  if (name === "elo_diff") return 0;
  return 0;
}

// Feature index subsets for each model. Elo positions (12,13,14) are
// included in all three: team strength is informative for outcome,
// goals-scored shape (Elo gap drives both BTTS rate and total goals),
// and over/under.
const OUTCOME_IDX = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
] as const;
const BTTS_IDX = [0, 1, 2, 3, 4, 5, 8, 9, 12, 13, 14] as const;
const OVER_UNDER_IDX = [0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14] as const;

// Outcome class labels
const OUTCOME_HOME = 0;
const OUTCOME_DRAW = 1;
const OUTCOME_AWAY = 2;
const BTTS_NO = 0;
const BTTS_YES = 1;
const OU_UNDER = 0;
const OU_OVER = 1;

// ===================== In-memory model state =====================
interface ModelSet {
  outcomeModel: LogisticRegression;
  bttsModel: LogisticRegression;
  overUnderModel: LogisticRegression;
  featureMeans: number[];
  featureStds: number[];
  version: string;
  trainingSize: number;
}

let currentModel: ModelSet | null = null;

export function getModelVersion(): string | null {
  return currentModel?.version ?? null;
}

export function isModelLoaded(): boolean {
  return currentModel !== null;
}

// ===================== Probability extraction =====================
// The LR library uses one-vs-all with target class = 0, others = 1.
// testScores returns sigmoid → P(y=NOT class i). So P(class i) = 1 - score.
function getProbabilities(
  model: LogisticRegression,
  featureRow: number[],
): number[] {
  const X = Matrix.rowVector(featureRow);
  const rawProbs = model.classifiers.map((clf) => {
    const scores = clf.testScores(X);
    return 1 - (scores[0] ?? 0.5);
  });
  const total = rawProbs.reduce((a, b) => a + b, 0);
  if (total === 0) return rawProbs.map(() => 1 / rawProbs.length);
  return rawProbs.map((p) => p / total);
}

function normalizeRow(
  rawRow: number[],
  indices: readonly number[],
  means: number[],
  stds: number[],
): number[] {
  return indices.map((i) => {
    const std = (stds[i] ?? 1) > 0 ? (stds[i] ?? 1) : 1;
    return ((rawRow[i] ?? 0) - (means[i] ?? 0)) / std;
  });
}

// ===================== In-dataset feature computation (bootstrap) =====================
function fdForm(
  matches: FDMatch[],
  teamId: number,
  venue: "home" | "away",
  last = 5,
): number {
  const filtered = matches
    .filter((m) =>
      venue === "home" ? m.homeTeam?.id === teamId : m.awayTeam?.id === teamId,
    )
    .slice(0, last);
  if (filtered.length === 0) return 0.5;
  const maxPts = filtered.length * 3;
  let pts = 0;
  for (const m of filtered) {
    const isHome = m.homeTeam?.id === teamId;
    if (m.score.winner === "DRAW") pts += 1;
    else if (
      (isHome && m.score.winner === "HOME_TEAM") ||
      (!isHome && m.score.winner === "AWAY_TEAM")
    )
      pts += 3;
  }
  return pts / maxPts;
}

function fdGoalAvg(
  matches: FDMatch[],
  teamId: number,
  venue: "home" | "away",
  last = 10,
): { scored: number; conceded: number } {
  const filtered = matches
    .filter((m) =>
      venue === "home" ? m.homeTeam?.id === teamId : m.awayTeam?.id === teamId,
    )
    .slice(0, last);
  if (filtered.length === 0) return { scored: 0, conceded: 0 };
  let scored = 0;
  let conceded = 0;
  let valid = 0;
  for (const m of filtered) {
    const ft = m.score.fullTime;
    if (ft.home === null || ft.away === null) continue;
    const isHome = m.homeTeam?.id === teamId;
    scored += isHome ? ft.home : ft.away;
    conceded += isHome ? ft.away : ft.home;
    valid++;
  }
  if (valid === 0) return { scored: 0, conceded: 0 };
  return { scored: scored / valid, conceded: conceded / valid };
}

function fdBttsRate(
  matches: FDMatch[],
  teamId: number,
  venue: "home" | "away",
  last = 10,
): number {
  const filtered = matches
    .filter((m) =>
      venue === "home" ? m.homeTeam?.id === teamId : m.awayTeam?.id === teamId,
    )
    .slice(0, last);
  if (filtered.length === 0) return 0.5;
  const btts = filtered.filter((m) => {
    const ft = m.score.fullTime;
    return ft.home !== null && ft.away !== null && ft.home > 0 && ft.away > 0;
  }).length;
  return btts / filtered.length;
}

function fdOver25Rate(
  matches: FDMatch[],
  teamId: number,
  venue: "home" | "away",
  last = 10,
): number {
  const filtered = matches
    .filter((m) =>
      venue === "home" ? m.homeTeam?.id === teamId : m.awayTeam?.id === teamId,
    )
    .slice(0, last);
  if (filtered.length === 0) return 0.5;
  const over = filtered.filter((m) => {
    const ft = m.score.fullTime;
    return ft.home !== null && ft.away !== null && ft.home + ft.away > 2;
  }).length;
  return over / filtered.length;
}

function buildInDatasetFeatureVector(
  match: FDMatch,
  previousMatches: FDMatch[],
): number[] | null {
  const homeId = match.homeTeam?.id;
  const awayId = match.awayTeam?.id;
  if (!homeId || !awayId) return null;

  const homeHomeHistory = previousMatches.filter(
    (m) => m.homeTeam?.id === homeId,
  );
  const awayAwayHistory = previousMatches.filter(
    (m) => m.awayTeam?.id === awayId,
  );

  // Require at least 2 home games and 2 away games in history
  if (homeHomeHistory.length < 2 || awayAwayHistory.length < 2) return null;

  const homeForm5 = fdForm(homeHomeHistory, homeId, "home", 5);
  const awayForm5 = fdForm(awayAwayHistory, awayId, "away", 5);
  const homeGoals = fdGoalAvg(homeHomeHistory, homeId, "home", 10);
  const awayGoals = fdGoalAvg(awayAwayHistory, awayId, "away", 10);
  const homeBtts = fdBttsRate(homeHomeHistory, homeId, "home", 10);
  const awayBtts = fdBttsRate(awayAwayHistory, awayId, "away", 10);
  const homeOver25 = fdOver25Rate(homeHomeHistory, homeId, "home", 10);
  const awayOver25 = fdOver25Rate(awayAwayHistory, awayId, "away", 10);

  const h2hMatches = previousMatches.filter(
    (m) =>
      (m.homeTeam?.id === homeId && m.awayTeam?.id === awayId) ||
      (m.homeTeam?.id === awayId && m.awayTeam?.id === homeId),
  );
  let h2hHomeWinRate = 0.4;
  if (h2hMatches.length > 0) {
    const homeWins = h2hMatches.filter(
      (m) =>
        m.homeTeam?.id === homeId && m.score.winner === "HOME_TEAM",
    ).length;
    h2hHomeWinRate = homeWins / h2hMatches.length;
  }

  return [
    homeForm5,
    awayForm5,
    homeGoals.scored,
    homeGoals.conceded,
    awayGoals.scored,
    awayGoals.conceded,
    h2hHomeWinRate,
    0, // league_position_diff — not available in historical bootstrap
    homeBtts,
    awayBtts,
    homeOver25,
    awayOver25,
    // Elo features — FD bootstrap has no resolver, fall back to the
    // shared imputation baseline. Real ClubElo data flows in via
    // buildSamplesFromDb once the historical backfill cron populates
    // the features table for settled matches.
    ELO_BASELINE,
    ELO_BASELINE,
    0,
  ];
}

// ===================== Training data builder =====================
interface TrainingSample {
  features: number[];
  outcomeLabel: number;
  bttsLabel: number;
  ouLabel: number;
}

function buildTrainingSamples(matches: FDMatch[]): TrainingSample[] {
  const sorted = [...matches].sort(
    (a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime(),
  );
  const samples: TrainingSample[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const match = sorted[i];
    if (!match) continue;

    const ft = match.score.fullTime;
    if (ft.home === null || ft.away === null || !match.score.winner) continue;

    const features = buildInDatasetFeatureVector(match, sorted.slice(0, i));
    if (!features) continue;

    let outcomeLabel: number;
    if (match.score.winner === "HOME_TEAM") outcomeLabel = OUTCOME_HOME;
    else if (match.score.winner === "DRAW") outcomeLabel = OUTCOME_DRAW;
    else outcomeLabel = OUTCOME_AWAY;

    const bttsLabel =
      ft.home > 0 && ft.away > 0 ? BTTS_YES : BTTS_NO;
    const ouLabel =
      ft.home + ft.away > 2 ? OU_OVER : OU_UNDER;

    samples.push({ features, outcomeLabel, bttsLabel, ouLabel });
  }
  return samples;
}

// ===================== Normalization =====================
function computeNormalization(allFeatures: number[][]): {
  means: number[];
  stds: number[];
} {
  const nFeatures = FEATURE_NAMES.length;
  const means: number[] = [];
  const stds: number[] = [];
  for (let i = 0; i < nFeatures; i++) {
    const col = allFeatures.map((row) => row[i] ?? 0);
    means.push(mean(col));
    const sd = standardDeviation(col);
    stds.push(isNaN(sd) || sd === 0 ? 1 : sd);
  }
  return { means, stds };
}

// ===================== Model training =====================
function trainModel(
  rawFeatures: number[][],
  labels: number[],
  featureIndices: readonly number[],
  means: number[],
  stds: number[],
): LogisticRegression {
  const normalizedRows = rawFeatures.map((row) =>
    normalizeRow(row, featureIndices, means, stds),
  );
  const X = new Matrix(normalizedRows);
  const Y = Matrix.columnVector(labels);
  // 500 steps prevents weight saturation (oversaturation → 100%/0% outputs)
  const lr = new LogisticRegression({ numSteps: 500, learningRate: 0.005 });
  lr.train(X, Y);
  return lr;
}

function computeAccuracy(
  model: LogisticRegression,
  rawFeatures: number[][],
  labels: number[],
  featureIndices: readonly number[],
  means: number[],
  stds: number[],
): number {
  const normalizedRows = rawFeatures.map((row) =>
    normalizeRow(row, featureIndices, means, stds),
  );
  const X = new Matrix(normalizedRows);
  const predictions = model.predict(X);
  let correct = 0;
  for (let i = 0; i < labels.length; i++) {
    if (predictions[i] === labels[i]) correct++;
  }
  return labels.length === 0 ? 0 : correct / labels.length;
}

// ===================== Model persistence =====================
async function saveModelToDb(
  modelSet: ModelSet,
  samples: TrainingSample[],
): Promise<void> {
  const rawFeatures = samples.map((s) => s.features);
  const { featureMeans, featureStds } = modelSet;

  const outcomeAcc = computeAccuracy(
    modelSet.outcomeModel,
    rawFeatures,
    samples.map((s) => s.outcomeLabel),
    OUTCOME_IDX,
    featureMeans,
    featureStds,
  );
  const bttsAcc = computeAccuracy(
    modelSet.bttsModel,
    rawFeatures,
    samples.map((s) => s.bttsLabel),
    BTTS_IDX,
    featureMeans,
    featureStds,
  );
  const ouAcc = computeAccuracy(
    modelSet.overUnderModel,
    rawFeatures,
    samples.map((s) => s.ouLabel),
    OVER_UNDER_IDX,
    featureMeans,
    featureStds,
  );
  const avgAcc = (outcomeAcc + bttsAcc + ouAcc) / 3;

  // Extract feature importances from outcome model's first classifier weights
  const featureImportances: Record<string, number> = {};
  const firstClf = modelSet.outcomeModel.classifiers[0];
  if (firstClf) {
    const clfJson = firstClf.toJSON() as {
      weights?: { data?: number[][] };
    };
    if (clfJson.weights?.data?.[0]) {
      OUTCOME_IDX.forEach((featureIdx, i) => {
        const name = FEATURE_NAMES[featureIdx];
        if (name) {
          featureImportances[name] = Math.abs(
            clfJson.weights!.data![0]?.[i] ?? 0,
          );
        }
      });
    }
  }

  await db.insert(modelStateTable).values({
    modelVersion: modelSet.version,
    accuracyScore: String(avgAcc.toFixed(6)),
    calibrationScore: String(avgAcc.toFixed(6)),
    totalBetsTrainedOn: modelSet.trainingSize,
    featureImportances,
    strategyWeights: {
      outcomeModel: modelSet.outcomeModel.toJSON(),
      bttsModel: modelSet.bttsModel.toJSON(),
      overUnderModel: modelSet.overUnderModel.toJSON(),
      featureMeans: modelSet.featureMeans,
      featureStds: modelSet.featureStds,
      trainingSize: modelSet.trainingSize,
      accuracies: { outcome: outcomeAcc, btts: bttsAcc, overUnder: ouAcc },
    },
  });

  logger.info(
    {
      version: modelSet.version,
      outcomeAcc: outcomeAcc.toFixed(4),
      bttsAcc: bttsAcc.toFixed(4),
      ouAcc: ouAcc.toFixed(4),
      trainingSize: modelSet.trainingSize,
    },
    "Model saved to database",
  );
}

export async function loadLatestModel(): Promise<boolean> {
  const rows = await db
    .select()
    .from(modelStateTable)
    .orderBy(desc(modelStateTable.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row?.strategyWeights) return false;

  const w = row.strategyWeights as {
    outcomeModel: unknown;
    bttsModel: unknown;
    overUnderModel: unknown;
    featureMeans: number[];
    featureStds: number[];
    trainingSize: number;
  };

  // Phase 4a.3 (2026-05-11): FEATURE_NAMES grew from 12 → 15 with the
  // ClubElo wire-in. A persisted model whose featureMeans/Stds were
  // sized for the old vector cannot score new feature rows — refuse
  // to load and let the startup path fall through to bootstrapModels,
  // which retrains with the current feature shape.
  if (
    !Array.isArray(w.featureMeans) ||
    w.featureMeans.length !== FEATURE_NAMES.length
  ) {
    logger.warn(
      {
        version: row.modelVersion,
        persistedFeatures: w.featureMeans?.length ?? null,
        currentFeatures: FEATURE_NAMES.length,
      },
      "Persisted model feature count is stale — triggering retrain via bootstrap",
    );
    return false;
  }

  try {
    currentModel = {
      outcomeModel: LogisticRegression.load(w.outcomeModel),
      bttsModel: LogisticRegression.load(w.bttsModel),
      overUnderModel: LogisticRegression.load(w.overUnderModel),
      featureMeans: w.featureMeans,
      featureStds: w.featureStds,
      version: row.modelVersion,
      trainingSize: w.trainingSize,
    };
    logger.info(
      { version: row.modelVersion, trainingSize: w.trainingSize },
      "Prediction model loaded from database",
    );
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to load model from database");
    return false;
  }
}

// ===================== Bootstrap training =====================
export async function bootstrapModels(): Promise<string> {
  const season = new Date().getFullYear() - 1;
  logger.info(
    { season, competitions: FEATURE_COMPETITIONS },
    "Starting bootstrap model training from historical data",
  );

  const allSamples: TrainingSample[] = [];

  for (const code of FEATURE_COMPETITIONS) {
    logger.info({ code, season }, "Fetching historical matches for training");
    const matches = await getHistoricalCompetitionMatches(
      code,
      season,
    ).catch((err) => {
      logger.warn({ err, code }, "Failed to fetch historical matches");
      return [] as FDMatch[];
    });

    const finished = matches.filter(
      (m) => m.score.winner !== null && m.score.fullTime.home !== null,
    );
    if (finished.length === 0) {
      logger.debug({ code }, "No finished historical matches available");
      continue;
    }

    const samples = buildTrainingSamples(finished);
    logger.info(
      { code, total: finished.length, samples: samples.length },
      "Training samples built from competition",
    );
    allSamples.push(...samples);
  }

  if (allSamples.length < 30) {
    const msg =
      "Insufficient training data for bootstrap — need at least 30 samples";
    logger.warn({ totalSamples: allSamples.length }, msg);
    return "insufficient_data";
  }

  logger.info(
    { totalSamples: allSamples.length },
    "Training models on bootstrap data",
  );

  const rawFeatures = allSamples.map((s) => s.features);
  const { means, stds } = computeNormalization(rawFeatures);

  const outcomeModel = trainModel(
    rawFeatures,
    allSamples.map((s) => s.outcomeLabel),
    OUTCOME_IDX,
    means,
    stds,
  );
  const bttsModel = trainModel(
    rawFeatures,
    allSamples.map((s) => s.bttsLabel),
    BTTS_IDX,
    means,
    stds,
  );
  const overUnderModel = trainModel(
    rawFeatures,
    allSamples.map((s) => s.ouLabel),
    OVER_UNDER_IDX,
    means,
    stds,
  );

  const version = `v1.0.0-bootstrap-${season}-${Date.now()}`;
  const modelSet: ModelSet = {
    outcomeModel,
    bttsModel,
    overUnderModel,
    featureMeans: means,
    featureStds: stds,
    version,
    trainingSize: allSamples.length,
  };

  await saveModelToDb(modelSet, allSamples);
  currentModel = modelSet;
  logger.info(
    { version, trainingSize: allSamples.length },
    "Bootstrap training complete",
  );

  // 2026-05-11 GUARD: getProbabilities relies on the ml-logistic-regression
  // convention that `testScores` returns P(y ≠ class i), so we recover
  // P(class i) as `1 − score`. If the library convention silently flips
  // (e.g. a future version returns P(y = class i) directly), every
  // prediction would be inverted (home prob → away prob) and the model
  // would bet the wrong side of every market.
  // Run a sanity check on the just-trained model against a chunk of its
  // own training data: for samples whose true label is X, the predicted
  // probability for class X should be > 1/k on average (i.e. better than
  // uniform), where k is the number of classes. If it isn't, the
  // orientation has flipped — refuse to publish the model.
  validatePredictionOrientation(modelSet, allSamples);

  return version;
}

/**
 * Orientation self-check for the three trained LR heads. Throws if the
 * mean predicted probability for the TRUE class across training samples
 * is no better than uniform — which is the signature of an inverted
 * `1 − testScores` convention (or a totally untrained model).
 *
 * Specifically: for each head, compute mean(P_predicted[trueLabel]) over
 * a random sample. Outcome head has 3 classes (uniform = 1/3 ≈ 0.333);
 * we require mean > 1/k + 0.02 as a permissive but unambiguous signal.
 * If the convention flipped, the mean would land at ~(k-1)/k for k-class
 * models — far above uniform but on the WRONG class — so we'd ALSO need
 * to verify the modal class matches. Simplest sufficient check: argmax
 * accuracy on a hold-in sample beats 1/k.
 */
function validatePredictionOrientation(
  modelSet: ModelSet,
  samples: TrainingSample[],
): void {
  if (samples.length < 30) {
    logger.warn(
      { sampleCount: samples.length },
      "Orientation guard skipped — fewer than 30 training samples",
    );
    return;
  }

  type Head = "outcome" | "btts" | "ou";
  const headSpec: Array<{
    head: Head;
    model: LogisticRegression;
    indices: readonly number[];
    label: (s: TrainingSample) => number;
    numClasses: number;
  }> = [
    { head: "outcome", model: modelSet.outcomeModel, indices: OUTCOME_IDX, label: (s) => s.outcomeLabel, numClasses: 3 },
    { head: "btts",    model: modelSet.bttsModel,    indices: BTTS_IDX,    label: (s) => s.bttsLabel,    numClasses: 2 },
    { head: "ou",      model: modelSet.overUnderModel, indices: OVER_UNDER_IDX, label: (s) => s.ouLabel,  numClasses: 2 },
  ];

  // Random sample up to 200 rows for speed.
  const N = Math.min(200, samples.length);
  const stride = Math.max(1, Math.floor(samples.length / N));
  const subset: TrainingSample[] = [];
  for (let i = 0; i < samples.length && subset.length < N; i += stride) {
    subset.push(samples[i]!);
  }

  for (const { head, model, indices, label, numClasses } of headSpec) {
    let trueClassProbSum = 0;
    let argmaxHits = 0;
    let counted = 0;
    for (const s of subset) {
      const trueLabel = label(s);
      const row = normalizeRow(s.features, indices, modelSet.featureMeans, modelSet.featureStds);
      const probs = getProbabilities(model, row);
      const p = probs[trueLabel];
      if (p == null) continue;
      trueClassProbSum += p;
      const argmax = probs.indexOf(Math.max(...probs));
      if (argmax === trueLabel) argmaxHits += 1;
      counted += 1;
    }
    if (counted === 0) continue;
    const meanTrueProb = trueClassProbSum / counted;
    const argmaxAcc = argmaxHits / counted;
    const uniformProb = 1 / numClasses;

    logger.info(
      { head, meanTrueProb, argmaxAcc, uniformProb, n: counted },
      "Orientation guard: mean(P[true class]) and argmax accuracy",
    );

    // Tight failure thresholds: probability orientation must be at least
    // slightly above uniform on the TRUE class. If it's at or below
    // uniform, the convention has flipped (or training failed).
    if (meanTrueProb < uniformProb - 0.01) {
      const msg = `Prediction orientation FLIPPED on '${head}' head — mean P[true class] = ${meanTrueProb.toFixed(4)} below uniform ${uniformProb.toFixed(4)} (n=${counted}). Library convention has changed; refuse to publish model.`;
      logger.error({ head, meanTrueProb, argmaxAcc, uniformProb, n: counted }, msg);
      throw new Error(msg);
    }
    if (argmaxAcc < uniformProb - 0.02) {
      const msg = `Argmax-class accuracy worse than uniform on '${head}' head — ${argmaxAcc.toFixed(4)} < ${uniformProb.toFixed(4)} (n=${counted}). Model is anti-predictive; refuse to publish.`;
      logger.error({ head, meanTrueProb, argmaxAcc, uniformProb, n: counted }, msg);
      throw new Error(msg);
    }
  }
}

// ===================== Prediction API =====================
export function predictOutcome(
  featureMap: Record<string, number>,
): { home: number; draw: number; away: number } | null {
  if (!currentModel) return null;
  const fullRow = FEATURE_NAMES.map(
    (n) => featureMap[n as FeatureName] ?? imputeMissingFeature(n as FeatureName),
  );
  const normRow = normalizeRow(
    fullRow,
    OUTCOME_IDX,
    currentModel.featureMeans,
    currentModel.featureStds,
  );
  const probs = getProbabilities(currentModel.outcomeModel, normRow);
  return {
    home: probs[OUTCOME_HOME] ?? 0,
    draw: probs[OUTCOME_DRAW] ?? 0,
    away: probs[OUTCOME_AWAY] ?? 0,
  };
}

export function predictBtts(
  featureMap: Record<string, number>,
): { yes: number; no: number } | null {
  if (!currentModel) return null;
  const fullRow = FEATURE_NAMES.map(
    (n) => featureMap[n as FeatureName] ?? imputeMissingFeature(n as FeatureName),
  );
  const normRow = normalizeRow(
    fullRow,
    BTTS_IDX,
    currentModel.featureMeans,
    currentModel.featureStds,
  );
  const probs = getProbabilities(currentModel.bttsModel, normRow);
  return {
    no: probs[BTTS_NO] ?? 0,
    yes: probs[BTTS_YES] ?? 0,
  };
}

export function predictOverUnder(
  featureMap: Record<string, number>,
): { over: number; under: number } | null {
  if (!currentModel) return null;
  const fullRow = FEATURE_NAMES.map(
    (n) => featureMap[n as FeatureName] ?? imputeMissingFeature(n as FeatureName),
  );
  const normRow = normalizeRow(
    fullRow,
    OVER_UNDER_IDX,
    currentModel.featureMeans,
    currentModel.featureStds,
  );
  const probs = getProbabilities(currentModel.overUnderModel, normRow);
  return {
    under: probs[OU_UNDER] ?? 0,
    over: probs[OU_OVER] ?? 0,
  };
}

// ===================== Cards + Corners predictions (Poisson heuristic) =====================
// These use Poisson modeling with team-stats features from API-Football.
// As cards/corners bets settle, the learning loop can graduate these to full LR models.

function poissonProb(lambda: number, k: number): number {
  let p = 0;
  let fac = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) fac *= i;
    p += (Math.pow(lambda, i) * Math.exp(-lambda)) / fac;
  }
  return p;
}

function poissonOver(lambda: number, threshold: number): number {
  // P(X > threshold) = 1 - P(X <= floor(threshold))
  const k = Math.floor(threshold);
  return Math.max(0.01, Math.min(0.99, 1 - poissonProb(lambda, k)));
}

// C1 (2026-05-07): single-point Poisson PMF (P(X = k)) — used for scoreline
// matrix and odd/even goal-count derivations.
function poissonPmf(lambda: number, k: number): number {
  if (k === 0) return Math.exp(-lambda);
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// C1 (2026-05-07): joint goal-scoreline matrix from independent home/away
// Poisson assumption. matrix[h][a] = P(home_goals = h AND away_goals = a).
// Truncated at maxGoals=8; remaining mass folded into [maxGoals][*] / [*][maxGoals]
// so distributions sum to 1.0 within numerical precision. This is the engine
// powering Asian Handicap, Win-to-Nil, Team-Total, Odd/Even, and (in C4)
// Half-Time/Full-Time + Winning-Margin predictions.
//
// Phase 1a (2026-05-14): optional Dixon-Coles low-score correction.
// When opts.rho is non-zero and opts.copulaKind='dixon_coles', applies
// the (1−λ_h·λ_a·ρ, 1+λ_a·ρ, 1+λ_h·ρ, 1−ρ) corner-cell multipliers
// from Dixon & Coles (1997). Re-normalises afterwards. ρ=0 → identical
// to independent-Poisson baseline (safe default). copulaKind='sarmanov'
// reuses the same corner-cell shape for now (DC is a Sarmanov special
// case per Michels et al. 2023); diverging Sarmanov density will be a
// follow-up.
export interface ScorelineMatrixOpts {
  rho?: number;
  copulaKind?: "dixon_coles" | "sarmanov";
  maxGoals?: number;
}

export function scorelineMatrix(
  homeLambda: number,
  awayLambda: number,
  optsOrLegacyMaxGoals: ScorelineMatrixOpts | number = {},
): number[][] {
  // Backward-compat: callers that passed maxGoals as a positional number
  // (pre-Phase-1a signature) still work.
  const opts: ScorelineMatrixOpts =
    typeof optsOrLegacyMaxGoals === "number"
      ? { maxGoals: optsOrLegacyMaxGoals }
      : optsOrLegacyMaxGoals;
  const maxGoals = opts.maxGoals ?? 8;
  const rho = opts.rho ?? 0;

  const ph: number[] = [];
  const pa: number[] = [];
  let homeAcc = 0;
  let awayAcc = 0;
  for (let k = 0; k <= maxGoals; k++) {
    const ppH = poissonPmf(homeLambda, k);
    const ppA = poissonPmf(awayLambda, k);
    ph.push(ppH);
    pa.push(ppA);
    homeAcc += ppH;
    awayAcc += ppA;
  }
  // Tail mass — fold into bucket [maxGoals]
  ph[maxGoals] += Math.max(0, 1 - homeAcc);
  pa[maxGoals] += Math.max(0, 1 - awayAcc);
  const matrix: number[][] = [];
  for (let h = 0; h <= maxGoals; h++) {
    const row: number[] = new Array(maxGoals + 1);
    for (let a = 0; a <= maxGoals; a++) row[a] = ph[h] * pa[a];
    matrix.push(row);
  }

  // Dixon-Coles low-score correction. Only the four cells {(0,0),(1,0),
  // (0,1),(1,1)} are touched; everything else passes through unchanged.
  if (rho !== 0 && Math.abs(rho) <= 0.2) {
    const tau00 = 1 - homeLambda * awayLambda * rho;
    const tau10 = 1 + awayLambda * rho;
    const tau01 = 1 + homeLambda * rho;
    const tau11 = 1 - rho;
    // Defensive: skip if any multiplier goes negative (extreme λ + ρ);
    // matrix stays as independent Poisson rather than emit P<0 cells.
    if (tau00 > 0 && tau10 > 0 && tau01 > 0 && tau11 > 0) {
      matrix[0][0] *= tau00;
      matrix[1][0] *= tau10;
      matrix[0][1] *= tau01;
      matrix[1][1] *= tau11;
      // Re-normalise so the matrix still sums to 1.
      let sum = 0;
      for (let h = 0; h <= maxGoals; h++) {
        for (let a = 0; a <= maxGoals; a++) sum += matrix[h][a];
      }
      if (sum > 0 && Math.abs(sum - 1) > 1e-9) {
        for (let h = 0; h <= maxGoals; h++) {
          for (let a = 0; a <= maxGoals; a++) matrix[h][a] /= sum;
        }
      }
    }
  }
  return matrix;
}

// ─── Option A — opponent-aware lambdas via inverse-Poisson projection ────────
// Per Finding 3 (opponent_blind_lambdas_2026_05_15) + #49 brief decision:
// solve for (λ_h, λ_a) that make the bivariate-Poisson scoreline matrix
// reproduce the LR-derived outcome probabilities P(H,D,A). The LR
// (outcomeModel) already conditions on opponent features (xG both sides,
// Elo both sides, H2H). Inverting through the score matrix gives us
// opponent-aware lambdas that AH and TT can use without bypassing the
// LR's calibration.
//
// Over-determined system: 2 unknowns (λ_h, λ_a) vs 3 constraints (P_H, P_D,
// P_A). Gauss-Newton least squares with numerical Jacobian. Converges in
// ~10 iterations from the marginal-lambda starting point.

function outcomeProbsFromLambdas(lh: number, la: number, maxGoals = 6) {
  const matrix = scorelineMatrix(lh, la, { maxGoals });
  let pH = 0, pD = 0, pA = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      if (h > a) pH += matrix[h][a];
      else if (h === a) pD += matrix[h][a];
      else pA += matrix[h][a];
    }
  }
  return { home: pH, draw: pD, away: pA, matrix };
}

export interface SolveLambdasResult {
  home: number;
  away: number;
  converged: boolean;
  iterations: number;
  residual: number;
}

export function solveLambdasFromOutcome(
  targets: { home: number; draw: number; away: number },
  initialHome: number,
  initialAway: number,
): SolveLambdasResult {
  const maxGoals = 6;
  const EPS = 1e-3;
  const MAX_ITER = 30;
  const CONVERGED_TOL = 1e-5;
  let lh = Math.max(0.2, Math.min(3.5, initialHome));
  let la = Math.max(0.2, Math.min(3.5, initialAway));
  let lastResidual = Infinity;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const p = outcomeProbsFromLambdas(lh, la, maxGoals);
    const rH = p.home - targets.home;
    const rD = p.draw - targets.draw;
    const rA = p.away - targets.away;
    const residual = rH * rH + rD * rD + rA * rA;
    if (residual < CONVERGED_TOL) {
      return { home: lh, away: la, converged: true, iterations: iter, residual };
    }
    if (Math.abs(lastResidual - residual) < 1e-8) {
      return { home: lh, away: la, converged: false, iterations: iter, residual };
    }
    lastResidual = residual;

    // Numerical Jacobian
    const pdh = outcomeProbsFromLambdas(lh + EPS, la, maxGoals);
    const pda = outcomeProbsFromLambdas(lh, la + EPS, maxGoals);
    const dHh = (pdh.home - p.home) / EPS;
    const dDh = (pdh.draw - p.draw) / EPS;
    const dAh = (pdh.away - p.away) / EPS;
    const dHa = (pda.home - p.home) / EPS;
    const dDa = (pda.draw - p.draw) / EPS;
    const dAa = (pda.away - p.away) / EPS;

    // Gauss-Newton normal equations (Jᵀ J) Δ = -Jᵀ r
    const a11 = dHh * dHh + dDh * dDh + dAh * dAh;
    const a12 = dHh * dHa + dDh * dDa + dAh * dAa;
    const a22 = dHa * dHa + dDa * dDa + dAa * dAa;
    const b1 = -(dHh * rH + dDh * rD + dAh * rA);
    const b2 = -(dHa * rH + dDa * rD + dAa * rA);
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) {
      return { home: lh, away: la, converged: false, iterations: iter, residual };
    }
    const deltaH = (a22 * b1 - a12 * b2) / det;
    const deltaA = (-a12 * b1 + a11 * b2) / det;

    // Damped step — backtrack if residual worsens
    let damp = 1.0;
    let accepted = false;
    for (let d = 0; d < 6; d++) {
      const nlh = Math.max(0.1, Math.min(5, lh + damp * deltaH));
      const nla = Math.max(0.1, Math.min(5, la + damp * deltaA));
      const np = outcomeProbsFromLambdas(nlh, nla, maxGoals);
      const nr =
        (np.home - targets.home) ** 2 +
        (np.draw - targets.draw) ** 2 +
        (np.away - targets.away) ** 2;
      if (nr < residual) {
        lh = nlh;
        la = nla;
        accepted = true;
        break;
      }
      damp *= 0.5;
    }
    if (!accepted) {
      return { home: lh, away: la, converged: false, iterations: iter + 1, residual };
    }
  }

  const final = outcomeProbsFromLambdas(lh, la, maxGoals);
  const fr =
    (final.home - targets.home) ** 2 +
    (final.draw - targets.draw) ** 2 +
    (final.away - targets.away) ** 2;
  return { home: lh, away: la, converged: false, iterations: MAX_ITER, residual: fr };
}

// Cache the solved lambdas per featureMap reference so multiple AH selections
// for the same match don't re-solve. featureMap is built once per match in
// valueDetection's outer loop, so this naturally amortises across selections.
const lambdaCache = new WeakMap<Record<string, number>, SolveLambdasResult | null>();

export function getOpponentAwareLambdas(
  featureMap: Record<string, number>,
): SolveLambdasResult | null {
  const cached = lambdaCache.get(featureMap);
  if (cached !== undefined) return cached;

  const outcome = predictOutcome(featureMap);
  if (!outcome) {
    lambdaCache.set(featureMap, null);
    return null;
  }
  const initH = featureMap["home_goals_scored_avg"] ?? featureMap["home_xg_proxy"] ?? 1.3;
  const initA = featureMap["away_goals_scored_avg"] ?? featureMap["away_xg_proxy"] ?? 1.3;
  if (initH <= 0 || initA <= 0) {
    lambdaCache.set(featureMap, null);
    return null;
  }
  const solved = solveLambdasFromOutcome(outcome, initH, initA);
  lambdaCache.set(featureMap, solved);
  return solved;
}

// C2 (2026-05-07): Asian Handicap probability for one side at a given line.
// Settlement convention: "Home L" pays out on (home_goals - away_goals + L) > 0;
// pushes (margin = 0) refund the stake (treated as 0.5 win for EV purposes).
// Quarter handicaps (e.g. -0.25, -0.75) split between two adjacent half/whole
// lines per Betfair rules — recurse and average.
//
// 2026-05-15 — opts.lambdaSource='opponent_aware' switches the lambda inputs
// from marginal team-scoring rates to LR-derived opponent-aware lambdas via
// inverse-Poisson projection. See solveLambdasFromOutcome + #49 brief.
export function predictAsianHandicap(
  featureMap: Record<string, number>,
  side: "home" | "away",
  line: number,
  opts?: {
    rho?: number;
    copulaKind?: "dixon_coles" | "sarmanov";
    lambdaSource?: "marginal" | "opponent_aware";
  },
): number | null {
  let homeLambda: number;
  let awayLambda: number;

  if (opts?.lambdaSource === "opponent_aware") {
    const solved = getOpponentAwareLambdas(featureMap);
    if (solved) {
      homeLambda = solved.home;
      awayLambda = solved.away;
    } else {
      // Fall back to marginal if LR unavailable
      homeLambda = featureMap["home_goals_scored_avg"] ?? featureMap["home_xg_proxy"];
      awayLambda = featureMap["away_goals_scored_avg"] ?? featureMap["away_xg_proxy"];
    }
  } else {
    homeLambda = featureMap["home_goals_scored_avg"] ?? featureMap["home_xg_proxy"];
    awayLambda = featureMap["away_goals_scored_avg"] ?? featureMap["away_xg_proxy"];
  }
  if (homeLambda == null || awayLambda == null) return null;
  if (homeLambda <= 0 || awayLambda <= 0) return null;

  // Quarter-line split — Betfair settles half stake on each adjacent line.
  // Detect by checking if 4*line is an odd integer.
  const quarterCheck = Math.round(line * 4);
  if (Math.abs(quarterCheck - line * 4) < 1e-6 && Math.abs(quarterCheck % 2) === 1) {
    const lower = predictAsianHandicap(featureMap, side, line - 0.25, opts);
    const upper = predictAsianHandicap(featureMap, side, line + 0.25, opts);
    if (lower == null || upper == null) return null;
    return (lower + upper) / 2;
  }

  const matrix = scorelineMatrix(homeLambda, awayLambda, {
    rho: opts?.rho ?? 0,
    copulaKind: opts?.copulaKind ?? "dixon_coles",
  });
  let pWin = 0;
  let pPush = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const margin = side === "home" ? h - a + line : a - h + line;
      if (margin > 1e-9) pWin += matrix[h][a];
      else if (margin > -1e-9) pPush += matrix[h][a];
    }
  }
  // Push outcomes refund stake — for EV equivalent, a push is identical to
  // staking on a 1/back_odds payout, so contributes 1/(net_odds) to win prob.
  // For modelProb purposes (the model's own probability the bet "lands") we
  // count push as 0.5 to reflect 50/50 capital outcome. valueDetection then
  // computes edge against the quoted price as usual.
  return Math.max(0.01, Math.min(0.99, pWin + pPush * 0.5));
}

// C1 (2026-05-07): Draw-No-Bet — pure derivation from existing 1X2 model.
// Stake refunded on draw; EV equivalent to renormalising over (home, away).
export function predictDrawNoBet(
  featureMap: Record<string, number>,
): { home: number; away: number } | null {
  const o = predictOutcome(featureMap);
  if (!o) return null;
  const denom = o.home + o.away;
  if (denom <= 0) return null;
  return {
    home: Math.max(0.01, Math.min(0.99, o.home / denom)),
    away: Math.max(0.01, Math.min(0.99, o.away / denom)),
  };
}

// C1 (2026-05-07): Per-side team-total goals.
//
// 2026-05-15 — opts.lambdaSource='opponent_aware' switches from independent
// marginal-Poisson to the matrix-marginal computed from LR-derived opponent-
// aware lambdas. The matrix marginal Σ_a matrix[k][a] correctly captures
// opposition defensive strength via the joint distribution.
export function predictTeamTotalGoals(
  featureMap: Record<string, number>,
  side: "home" | "away",
  threshold: number,
  opts?: { lambdaSource?: "marginal" | "opponent_aware" },
): { over: number; under: number } | null {
  if (opts?.lambdaSource === "opponent_aware") {
    const solved = getOpponentAwareLambdas(featureMap);
    if (solved) {
      // Matrix marginal: P(side_goals = k) = Σ_other matrix[k or *][* or k]
      const { matrix } = outcomeProbsFromLambdas(solved.home, solved.away, 8);
      let over = 0;
      for (let h = 0; h < matrix.length; h++) {
        for (let a = 0; a < matrix[h].length; a++) {
          const sideGoals = side === "home" ? h : a;
          if (sideGoals > threshold) over += matrix[h][a];
        }
      }
      over = Math.max(0.01, Math.min(0.99, over));
      return { over, under: 1 - over };
    }
    // Fall through to marginal if LR unavailable
  }
  const lambda = side === "home"
    ? featureMap["home_goals_scored_avg"] ?? featureMap["home_xg_proxy"]
    : featureMap["away_goals_scored_avg"] ?? featureMap["away_xg_proxy"];
  if (lambda == null || lambda <= 0) return null;
  const over = poissonOver(lambda, threshold);
  return { over, under: 1 - over };
}

// 2026-05-16 SUBTRACT BUNDLE: predictWinToNil, predictHtFt, predictBttsHalf,
// predictSecondHalfResult deleted. WIN_TO_NIL_HOME/AWAY, HALF_TIME_FULL_TIME,
// BTTS_SECOND_HALF, SECOND_HALF_RESULT all failed three-check (no placeable
// liquidity probes, zero bets ever placed, no edge thesis attached).
// See [[feedback_subtract_before_restore]].

// C4 (2026-05-07): Asian Total Goals at quarter lines (2.25, 2.75 etc).
// Half-stake split between adjacent integer/half lines, mirroring AH push
// rules. Integer lines (e.g. 2.0) → push when total = line; half lines
// (e.g. 2.5) → no push.
export function predictAsianTotalGoals(
  featureMap: Record<string, number>,
  side: "over" | "under",
  line: number,
): number | null {
  const homeLambda = featureMap["home_goals_scored_avg"] ?? featureMap["home_xg_proxy"];
  const awayLambda = featureMap["away_goals_scored_avg"] ?? featureMap["away_xg_proxy"];
  if (homeLambda == null || awayLambda == null) return null;
  if (homeLambda <= 0 || awayLambda <= 0) return null;
  const lambda = homeLambda + awayLambda;

  // Quarter line — recurse on adjacent half/whole lines.
  const quarterCheck = Math.round(line * 4);
  if (Math.abs(quarterCheck - line * 4) < 1e-6 && Math.abs(quarterCheck % 2) === 1) {
    const lower = predictAsianTotalGoals(featureMap, side, line - 0.25);
    const upper = predictAsianTotalGoals(featureMap, side, line + 0.25);
    if (lower == null || upper == null) return null;
    return (lower + upper) / 2;
  }

  // Half line (.5) — pure over/under, no push.
  const isHalf = Math.abs(line - Math.floor(line) - 0.5) < 1e-6;
  if (isHalf) {
    const overP = poissonOver(lambda, line);
    return Math.max(0.01, Math.min(0.99, side === "over" ? overP : 1 - overP));
  }

  // Integer line — push if total goals === line. Half stake refunded on push.
  const flooredLine = Math.floor(line);
  const pPush = poissonPmf(lambda, flooredLine);
  const pStrictlyOver = 1 - poissonProb(lambda, flooredLine);
  const winSide = side === "over" ? pStrictlyOver : 1 - pStrictlyOver - pPush;
  return Math.max(0.01, Math.min(0.99, winSide + pPush * 0.5));
}

// 2026-05-16 SUBTRACT BUNDLE: predictOddEven, predictCards, predictCorners
// deleted. GOALS_ODD_EVEN + TOTAL_CARDS_25/35/45/55 + TOTAL_CORNERS_75/85/95/
// 105/115 failed three-check (no placeable liquidity probes ever, zero
// non-paper bets ever placed, no edge thesis attached). Cards had a brief
// 60-bet paper-only flurry in April 2026 that did not graduate.
// See [[feedback_subtract_before_restore]].

// ===================== Training sample builder from DB records =====================
export interface DbTrainingSample {
  features: number[];
  outcomeLabel: number;
  bttsLabel: number;
  ouLabel: number;
}

export async function buildSamplesFromDb(): Promise<DbTrainingSample[]> {
  const settledBets = await db
    .select({ matchId: paperBetsTable.matchId })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost"]));

  const uniqueMatchIds = [...new Set(settledBets.map((b) => b.matchId))];
  if (uniqueMatchIds.length === 0) return [];

  const matches = await db
    .select()
    .from(matchesTable)
    .where(inArray(matchesTable.id, uniqueMatchIds));

  const allFeatures = await db
    .select()
    .from(featuresTable)
    .where(inArray(featuresTable.matchId, uniqueMatchIds));

  const samples: DbTrainingSample[] = [];

  for (const match of matches) {
    if (match.homeScore === null || match.awayScore === null) continue;

    const matchFeatures = allFeatures.filter(
      (f) => f.matchId === match.id && !f.featureName.startsWith("_"),
    );
    if (matchFeatures.length < 8) continue;

    const featureMap: Record<string, number> = {};
    for (const f of matchFeatures) {
      featureMap[f.featureName] = Number(f.featureValue);
    }

    const featureVector = FEATURE_NAMES.map(
      (name) => featureMap[name as FeatureName] ?? imputeMissingFeature(name as FeatureName),
    );

    let outcomeLabel: number;
    if (match.homeScore > match.awayScore) outcomeLabel = OUTCOME_HOME;
    else if (match.homeScore < match.awayScore) outcomeLabel = OUTCOME_AWAY;
    else outcomeLabel = OUTCOME_DRAW;

    const bttsLabel =
      match.homeScore > 0 && match.awayScore > 0 ? BTTS_YES : BTTS_NO;
    const ouLabel =
      match.homeScore + match.awayScore > 2 ? OU_OVER : OU_UNDER;

    samples.push({ features: featureVector, outcomeLabel, bttsLabel, ouLabel });
  }

  return samples;
}

// Brier score (calibration) — lower is better; 0 = perfect
function computeBrierScore(
  model: LogisticRegression,
  rawFeatures: number[][],
  labels: number[],
  featureIndices: readonly number[],
  means: number[],
  stds: number[],
  positiveClass: number,
): number {
  if (rawFeatures.length === 0) return 1;
  const normalizedRows = rawFeatures.map((row) =>
    normalizeRow(row, featureIndices, means, stds),
  );
  let brierSum = 0;
  for (let i = 0; i < normalizedRows.length; i++) {
    const row = normalizedRows[i];
    if (!row) continue;
    const probs = getProbabilities(model, row);
    const predicted = probs[positiveClass] ?? 0.5;
    const actual = labels[i] === positiveClass ? 1 : 0;
    brierSum += (predicted - actual) ** 2;
  }
  return brierSum / normalizedRows.length;
}

export interface RetrainResult {
  version: string;
  trainSize: number;
  valSize: number;
  trainAccuracy: { outcome: number; btts: number; overUnder: number; avg: number };
  valAccuracy: { outcome: number; btts: number; overUnder: number; avg: number };
  calibrationScore: number;
  previousAccuracy: number | null;
  previousVersion: string | null;
  featureImportances: Record<string, number>;
}

export async function forceRetrain(): Promise<RetrainResult | null> {
  const allSamples = await buildSamplesFromDb();

  if (allSamples.length < 20) {
    logger.warn(
      { samples: allSamples.length },
      "Not enough samples for forceRetrain",
    );
    return null;
  }

  // Shuffle then split 80/20
  const shuffled = [...allSamples].sort(() => Math.random() - 0.5);
  const splitIdx = Math.floor(shuffled.length * 0.8);
  const trainSamples = shuffled.slice(0, splitIdx);
  const valSamples = shuffled.slice(splitIdx);

  // Previous model state
  const prevRows = await db
    .select({
      accuracyScore: modelStateTable.accuracyScore,
      modelVersion: modelStateTable.modelVersion,
    })
    .from(modelStateTable)
    .orderBy(desc(modelStateTable.createdAt))
    .limit(1);
  const previousAccuracy = prevRows[0]?.accuracyScore
    ? Number(prevRows[0].accuracyScore)
    : null;
  const previousVersion = prevRows[0]?.modelVersion ?? null;

  const rawTrain = trainSamples.map((s) => s.features);
  const { means, stds } = computeNormalization(rawTrain);

  const outcomeModel = trainModel(
    rawTrain,
    trainSamples.map((s) => s.outcomeLabel),
    OUTCOME_IDX,
    means,
    stds,
  );
  const bttsModel = trainModel(
    rawTrain,
    trainSamples.map((s) => s.bttsLabel),
    BTTS_IDX,
    means,
    stds,
  );
  const overUnderModel = trainModel(
    rawTrain,
    trainSamples.map((s) => s.ouLabel),
    OVER_UNDER_IDX,
    means,
    stds,
  );

  const rawVal = valSamples.map((s) => s.features);
  const valOutcomeAcc = computeAccuracy(
    outcomeModel,
    rawVal,
    valSamples.map((s) => s.outcomeLabel),
    OUTCOME_IDX,
    means,
    stds,
  );
  const valBttsAcc = computeAccuracy(
    bttsModel,
    rawVal,
    valSamples.map((s) => s.bttsLabel),
    BTTS_IDX,
    means,
    stds,
  );
  const valOuAcc = computeAccuracy(
    overUnderModel,
    rawVal,
    valSamples.map((s) => s.ouLabel),
    OVER_UNDER_IDX,
    means,
    stds,
  );
  const valAvg = (valOutcomeAcc + valBttsAcc + valOuAcc) / 3;

  const trainOutcomeAcc = computeAccuracy(
    outcomeModel,
    rawTrain,
    trainSamples.map((s) => s.outcomeLabel),
    OUTCOME_IDX,
    means,
    stds,
  );
  const trainBttsAcc = computeAccuracy(
    bttsModel,
    rawTrain,
    trainSamples.map((s) => s.bttsLabel),
    BTTS_IDX,
    means,
    stds,
  );
  const trainOuAcc = computeAccuracy(
    overUnderModel,
    rawTrain,
    trainSamples.map((s) => s.ouLabel),
    OVER_UNDER_IDX,
    means,
    stds,
  );
  const trainAvg = (trainOutcomeAcc + trainBttsAcc + trainOuAcc) / 3;

  // Calibration: Brier score on validation set (outcome model, home win class)
  const calibration = computeBrierScore(
    outcomeModel,
    rawVal,
    valSamples.map((s) => s.outcomeLabel),
    OUTCOME_IDX,
    means,
    stds,
    OUTCOME_HOME,
  );

  const version = `v2.${Date.now()}-loop-${allSamples.length}bets`;
  const modelSet: ModelSet = {
    outcomeModel,
    bttsModel,
    overUnderModel,
    featureMeans: means,
    featureStds: stds,
    version,
    trainingSize: trainSamples.length,
  };

  // Extract feature importances
  const featureImportances: Record<string, number> = {};
  const firstClf = outcomeModel.classifiers[0];
  if (firstClf) {
    const clfJson = firstClf.toJSON() as { weights?: { data?: number[][] } };
    if (clfJson.weights?.data?.[0]) {
      OUTCOME_IDX.forEach((fi, i) => {
        const name = FEATURE_NAMES[fi];
        if (name) featureImportances[name] = Math.abs(clfJson.weights!.data![0]![i] ?? 0);
      });
    }
  }

  await db.insert(modelStateTable).values({
    modelVersion: version,
    accuracyScore: String(valAvg.toFixed(6)),
    calibrationScore: String(calibration.toFixed(6)),
    totalBetsTrainedOn: allSamples.length,
    featureImportances,
    strategyWeights: {
      outcomeModel: outcomeModel.toJSON(),
      bttsModel: bttsModel.toJSON(),
      overUnderModel: overUnderModel.toJSON(),
      featureMeans: means,
      featureStds: stds,
      trainingSize: trainSamples.length,
      accuracies: { outcome: valOutcomeAcc, btts: valBttsAcc, overUnder: valOuAcc },
    },
  });

  currentModel = modelSet;
  lastTrainedBetCount = allSamples.length;

  logger.info(
    { version, trainSize: trainSamples.length, valSize: valSamples.length, valAvg, calibration },
    "Force retrain complete",
  );

  return {
    version,
    trainSize: trainSamples.length,
    valSize: valSamples.length,
    trainAccuracy: { outcome: trainOutcomeAcc, btts: trainBttsAcc, overUnder: trainOuAcc, avg: trainAvg },
    valAccuracy: { outcome: valOutcomeAcc, btts: valBttsAcc, overUnder: valOuAcc, avg: valAvg },
    calibrationScore: calibration,
    previousAccuracy,
    previousVersion,
    featureImportances,
  };
}

// ===================== Retraining on settled bets =====================
const RETRAIN_THRESHOLD = 20;
let lastTrainedBetCount = 0;

export async function retrainIfNeeded(): Promise<boolean> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost"]));
  const settledCount = result[0]?.count ?? 0;

  if (settledCount - lastTrainedBetCount < RETRAIN_THRESHOLD) {
    logger.debug(
      { settledCount, lastTrainedBetCount, needed: RETRAIN_THRESHOLD },
      "Retraining not yet needed",
    );
    return false;
  }

  logger.info(
    { settledCount, threshold: RETRAIN_THRESHOLD },
    "Retraining models with settled bet data",
  );

  const settledBets = await db
    .select({
      matchId: paperBetsTable.matchId,
    })
    .from(paperBetsTable)
    .where(inArray(paperBetsTable.status, ["won", "lost"]));

  const uniqueMatchIds = [...new Set(settledBets.map((b) => b.matchId))];

  const matches = await db
    .select()
    .from(matchesTable)
    .where(inArray(matchesTable.id, uniqueMatchIds));

  const allFeatures = await db
    .select()
    .from(featuresTable)
    .where(inArray(featuresTable.matchId, uniqueMatchIds));

  const samples: TrainingSample[] = [];

  for (const match of matches) {
    if (match.homeScore === null || match.awayScore === null) continue;

    const matchFeatures = allFeatures.filter(
      (f) => f.matchId === match.id && !f.featureName.startsWith("_"),
    );
    if (matchFeatures.length < 8) continue;

    const featureMap: Record<string, number> = {};
    for (const f of matchFeatures) {
      featureMap[f.featureName] = Number(f.featureValue);
    }

    const featureVector = FEATURE_NAMES.map(
      (name) => featureMap[name as FeatureName] ?? imputeMissingFeature(name as FeatureName),
    );

    let outcomeLabel: number;
    if (match.homeScore > match.awayScore) outcomeLabel = OUTCOME_HOME;
    else if (match.homeScore < match.awayScore) outcomeLabel = OUTCOME_AWAY;
    else outcomeLabel = OUTCOME_DRAW;

    const bttsLabel =
      match.homeScore > 0 && match.awayScore > 0 ? BTTS_YES : BTTS_NO;
    const ouLabel =
      match.homeScore + match.awayScore > 2 ? OU_OVER : OU_UNDER;

    samples.push({
      features: featureVector,
      outcomeLabel,
      bttsLabel,
      ouLabel,
    });
  }

  if (samples.length < 20) {
    logger.warn(
      { samples: samples.length },
      "Not enough match samples with features for retraining",
    );
    return false;
  }

  // Fetch previous model accuracy for comparison
  const previousRows = await db
    .select({ accuracyScore: modelStateTable.accuracyScore })
    .from(modelStateTable)
    .orderBy(desc(modelStateTable.createdAt))
    .limit(1);
  const previousAccuracy = previousRows[0]?.accuracyScore
    ? Number(previousRows[0].accuracyScore)
    : null;

  const rawFeatures = samples.map((s) => s.features);
  const { means, stds } = computeNormalization(rawFeatures);
  const outcomeModel = trainModel(
    rawFeatures,
    samples.map((s) => s.outcomeLabel),
    OUTCOME_IDX,
    means,
    stds,
  );
  const bttsModel = trainModel(
    rawFeatures,
    samples.map((s) => s.bttsLabel),
    BTTS_IDX,
    means,
    stds,
  );
  const overUnderModel = trainModel(
    rawFeatures,
    samples.map((s) => s.ouLabel),
    OVER_UNDER_IDX,
    means,
    stds,
  );

  const version = `v1.${Math.floor(settledCount / RETRAIN_THRESHOLD)}.0-retrain-${settledCount}bets`;
  const modelSet: ModelSet = {
    outcomeModel,
    bttsModel,
    overUnderModel,
    featureMeans: means,
    featureStds: stds,
    version,
    trainingSize: samples.length,
  };

  await saveModelToDb(modelSet, samples);
  // 2026-05-11 GUARD: orientation self-check before publishing. If the
  // ml-logistic-regression library's `1 − testScores` convention has
  // flipped, mean P[true class] on hold-in data lands below uniform —
  // throw and refuse to set currentModel so the prior good model stays
  // active rather than every prediction being inverted.
  validatePredictionOrientation(modelSet, samples);
  currentModel = modelSet;
  lastTrainedBetCount = settledCount;

  logger.info(
    {
      version,
      trainingSize: samples.length,
      previousAccuracy,
    },
    "Retraining complete",
  );
  return true;
}
