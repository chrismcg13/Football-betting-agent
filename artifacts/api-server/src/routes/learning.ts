import { Router } from "express";
import { db, modelStateTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { runLearningLoop, calculateStrategyPerformance } from "../services/learningLoop";
import { getRecentNarratives } from "../services/narrativeEngine";
import { logger } from "../lib/logger";

const router = Router();

// POST /learning/run — manually trigger the full learning loop
router.post("/learning/run", async (req, res) => {
  logger.info("Learning loop manually triggered via API");
  // Respond immediately; loop runs in background
  res.json({ message: "Learning loop started" });
  void runLearningLoop().catch((err) =>
    logger.error({ err }, "Manual learning loop failed"),
  );
});

// GET /learning/narratives — recent learning narratives
router.get("/learning/narratives", async (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? "20"), 100);
  const narratives = await getRecentNarratives(limit);
  res.json({ count: narratives.length, narratives });
});

// GET /learning/strategy — strategy performance by segment
router.get("/learning/strategy", async (req, res) => {
  const performance = await calculateStrategyPerformance();
  res.json(performance);
});

// GET /learning/model-history — last N model versions with accuracy progression
router.get("/learning/model-history", async (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? "10"), 50);
  const rows = await db
    .select({
      id: modelStateTable.id,
      modelVersion: modelStateTable.modelVersion,
      accuracyScore: modelStateTable.accuracyScore,
      calibrationScore: modelStateTable.calibrationScore,
      totalBetsTrainedOn: modelStateTable.totalBetsTrainedOn,
      featureImportances: modelStateTable.featureImportances,
      createdAt: modelStateTable.createdAt,
    })
    .from(modelStateTable)
    .orderBy(desc(modelStateTable.createdAt))
    .limit(limit);

  res.json({
    count: rows.length,
    models: rows.map((r) => ({
      ...r,
      accuracyScore: r.accuracyScore ? Number(r.accuracyScore) : null,
      calibrationScore: r.calibrationScore ? Number(r.calibrationScore) : null,
    })),
  });
});

export default router;
