import { Router } from "express";
import { db, modelStateTable, insertModelStateSchema } from "@workspace/db";
import { desc } from "drizzle-orm";

const router = Router();

router.get("/model-state", async (req, res) => {
  const rows = await db.select().from(modelStateTable).orderBy(desc(modelStateTable.createdAt));
  res.json(rows);
});

router.get("/model-state/latest", async (req, res) => {
  const [latest] = await db.select().from(modelStateTable).orderBy(desc(modelStateTable.createdAt)).limit(1);
  if (!latest) {
    res.status(404).json({ error: "No model state found" });
    return;
  }
  res.json(latest);
});

router.post("/model-state", async (req, res) => {
  const parsed = insertModelStateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const [state] = await db.insert(modelStateTable).values(parsed.data).returning();
  res.status(201).json(state);
});

export default router;
