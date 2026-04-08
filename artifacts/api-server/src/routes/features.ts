import { Router } from "express";
import { db, featuresTable, insertFeatureSchema } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

router.get("/features", async (req, res) => {
  const { matchId, featureName } = req.query;
  let rows = await db.select().from(featuresTable).orderBy(desc(featuresTable.computedAt));

  if (matchId) {
    rows = rows.filter((f) => f.matchId === Number(matchId));
  }
  if (featureName) {
    rows = rows.filter((f) => f.featureName === String(featureName));
  }

  res.json(rows);
});

router.post("/features", async (req, res) => {
  const parsed = insertFeatureSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const [feature] = await db.insert(featuresTable).values(parsed.data).returning();
  res.status(201).json(feature);
});

export default router;
