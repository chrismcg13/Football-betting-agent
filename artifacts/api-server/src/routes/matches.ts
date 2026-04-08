import { Router } from "express";
import { db, matchesTable, insertMatchSchema } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

router.get("/matches", async (req, res) => {
  const { status } = req.query;
  let query = db.select().from(matchesTable).orderBy(desc(matchesTable.kickoffTime));
  const rows = status
    ? await db.select().from(matchesTable).where(eq(matchesTable.status, String(status))).orderBy(desc(matchesTable.kickoffTime))
    : await query;
  res.json(rows);
});

router.get("/matches/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [match] = await db.select().from(matchesTable).where(eq(matchesTable.id, id));
  if (!match) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  res.json(match);
});

router.post("/matches", async (req, res) => {
  const parsed = insertMatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const [match] = await db.insert(matchesTable).values(parsed.data).returning();
  res.status(201).json(match);
});

router.patch("/matches/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [updated] = await db
    .update(matchesTable)
    .set(req.body as Partial<typeof matchesTable.$inferInsert>)
    .where(eq(matchesTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  res.json(updated);
});

export default router;
