import { Router } from "express";
import { db, matchesTable, featuresTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  predictOutcome,
  predictBtts,
  predictOverUnder,
  bootstrapModels,
  loadLatestModel,
  retrainIfNeeded,
  getModelVersion,
  isModelLoaded,
} from "../services/predictionEngine";
import { detectValueBets } from "../services/valueDetection";
import { logger } from "../lib/logger";

const router = Router();

// GET /predictions/status — model status summary (must be before /:matchId)
router.get("/predictions/status", (req, res) => {
  res.json({
    modelLoaded: isModelLoaded(),
    modelVersion: getModelVersion(),
  });
});

// GET /value-bets — detect value bets across all upcoming matches
router.get("/value-bets", async (req, res) => {
  if (!isModelLoaded()) {
    res.status(503).json({
      error:
        "No trained model available. Run POST /predictions/bootstrap first.",
    });
    return;
  }
  const summary = await detectValueBets();
  res.json(summary);
});

// POST /predictions/bootstrap — trigger historical bootstrap training
router.post("/predictions/bootstrap", async (req, res) => {
  logger.info("Bootstrap training triggered via API");
  res.json({
    message:
      "Bootstrap training started. This will take several minutes due to API rate limits. Check model-state for completion.",
  });
  void bootstrapModels().catch((err) =>
    logger.error({ err }, "Bootstrap training failed"),
  );
});

// POST /predictions/retrain — check if retraining threshold is met and retrain
router.post("/predictions/retrain", async (req, res) => {
  const retrained = await retrainIfNeeded();
  if (retrained) {
    res.json({
      retrained: true,
      message: "Models retrained successfully",
      modelVersion: getModelVersion(),
    });
  } else {
    res.json({
      retrained: false,
      message: `Retraining not needed yet. Need ${20} new settled bets.`,
      modelVersion: getModelVersion(),
    });
  }
});

// POST /predictions/load — load the latest saved model from the database
router.post("/predictions/load", async (req, res) => {
  const loaded = await loadLatestModel();
  if (loaded) {
    res.json({ loaded: true, modelVersion: getModelVersion() });
  } else {
    res.status(404).json({
      loaded: false,
      error: "No trained model found in database.",
    });
  }
});

// GET /predictions/:matchId — predict outcomes for a single match
router.get("/predictions/:matchId", async (req, res) => {
  const matchId = parseInt(req.params.matchId ?? "", 10);
  if (isNaN(matchId)) {
    res.status(400).json({ error: "Invalid matchId" });
    return;
  }

  const [match] = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.id, matchId));
  if (!match) {
    res.status(404).json({ error: "Match not found" });
    return;
  }

  const featureRows = await db
    .select()
    .from(featuresTable)
    .where(eq(featuresTable.matchId, matchId));
  const publicFeatures = featureRows.filter(
    (f) => !f.featureName.startsWith("_"),
  );

  if (publicFeatures.length < 8) {
    res.status(422).json({
      error:
        "Insufficient features for this match. Run POST /features/compute first.",
    });
    return;
  }

  const featureMap: Record<string, number> = {};
  for (const f of publicFeatures) {
    featureMap[f.featureName] = Number(f.featureValue);
  }

  if (!isModelLoaded()) {
    res.status(503).json({
      error:
        "No trained model available. Run POST /predictions/bootstrap first.",
    });
    return;
  }

  const outcome = predictOutcome(featureMap);
  const btts = predictBtts(featureMap);
  const overUnder = predictOverUnder(featureMap);

  res.json({
    matchId,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    league: match.league,
    kickoffTime: match.kickoffTime,
    modelVersion: getModelVersion(),
    predictions: {
      outcome,
      btts,
      overUnder,
    },
    features: Object.fromEntries(
      publicFeatures.map((f) => [f.featureName, Number(f.featureValue)]),
    ),
  });
});

export default router;
