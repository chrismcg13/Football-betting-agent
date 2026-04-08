import { Router } from "express";
import { db, featuresTable, insertFeatureSchema } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { runFeaturesNow } from "../services/scheduler";
import { logger } from "../lib/logger";

const router = Router();

router.get("/features", async (req, res) => {
  const { matchId, featureName } = req.query;
  let rows = await db
    .select()
    .from(featuresTable)
    .orderBy(desc(featuresTable.computedAt));

  if (matchId) {
    rows = rows.filter((f) => f.matchId === Number(matchId));
  }
  if (featureName) {
    rows = rows.filter((f) => f.featureName === String(featureName));
  }

  const filtered = rows.filter((f) => !f.featureName.startsWith("_"));

  res.json(filtered);
});

router.post("/features", async (req, res) => {
  const parsed = insertFeatureSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const [feature] = await db
    .insert(featuresTable)
    .values(parsed.data)
    .returning();
  res.status(201).json(feature);
});

router.post("/features/compute", async (req, res) => {
  logger.info("Manual feature computation triggered via API");
  res.json({ message: "Feature computation started" });
  void runFeaturesNow();
});

export default router;
