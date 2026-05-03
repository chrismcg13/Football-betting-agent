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
] as const;

type FeatureName = (typeof FEATURE_NAMES)[number];

// Feature index subsets for each model
const OUTCOME_IDX = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
const BTTS_IDX = [0, 1, 2, 3, 4, 5, 8, 9] as const;
const OVER_UNDER_IDX = [0, 1, 2, 3, 4, 5, 10, 11] as const;

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
  return version;
}

// ===================== Prediction API =====================
export function predictOutcome(
  featureMap: Record<string, number>,
): { home: number; draw: number; away: number } | null {
  if (!currentModel) return null;
  const fullRow = FEATURE_NAMES.map(
    (n) => featureMap[n as FeatureName] ?? 0,
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
    (n) => featureMap[n as FeatureName] ?? 0,
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
    (n) => featureMap[n as FeatureName] ?? 0,
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

export function predictCards(featureMap: Record<string, number>): {
  over35: number; under35: number;
  over45: number; under45: number;
} | null {
  const homeCards = featureMap["home_yellow_cards_avg"];
  const awayCards = featureMap["away_yellow_cards_avg"];
  // Need at least one cards feature
  if (homeCards === undefined && awayCards === undefined) return null;

  const hCards = homeCards ?? 1.8;
  const aCards = awayCards ?? 1.6;
  const lambda = hCards + aCards;

  const over35 = poissonOver(lambda, 3.5);
  const over45 = poissonOver(lambda, 4.5);
  return {
    over35,
    under35: 1 - over35,
    over45,
    under45: 1 - over45,
  };
}

export function predictCorners(featureMap: Record<string, number>): {
  over95: number; under95: number;
  over105: number; under105: number;
} | null {
  const homeCorners = featureMap["home_corners_avg"];
  const awayCorners = featureMap["away_corners_avg"];
  if (homeCorners === undefined && awayCorners === undefined) return null;

  const hCorners = homeCorners ?? 5.2;
  const aCorners = awayCorners ?? 4.8;
  const lambda = hCorners + aCorners;

  const over95 = poissonOver(lambda, 9.5);
  const over105 = poissonOver(lambda, 10.5);
  return {
    over95,
    under95: 1 - over95,
    over105,
    under105: 1 - over105,
  };
}

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
      (name) => featureMap[name as FeatureName] ?? 0,
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
      (name) => featureMap[name as FeatureName] ?? 0,
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
