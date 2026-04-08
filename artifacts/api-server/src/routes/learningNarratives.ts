import { Router } from "express";
import { db, learningNarrativesTable, insertLearningNarrativeSchema } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

router.get("/learning-narratives", async (req, res) => {
  const { narrativeType } = req.query;
  let rows = await db.select().from(learningNarrativesTable).orderBy(desc(learningNarrativesTable.createdAt));

  if (narrativeType) {
    rows = rows.filter((n) => n.narrativeType === String(narrativeType));
  }

  res.json(rows);
});

router.post("/learning-narratives", async (req, res) => {
  const parsed = insertLearningNarrativeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const [narrative] = await db.insert(learningNarrativesTable).values(parsed.data).returning();
  res.status(201).json(narrative);
});

export default router;
