import { Router } from "express";
import { db, oddsSnapshotsTable, insertOddsSnapshotSchema } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

router.get("/odds-snapshots", async (req, res) => {
  const { matchId, marketType } = req.query;
  let rows = await db.select().from(oddsSnapshotsTable).orderBy(desc(oddsSnapshotsTable.snapshotTime));

  if (matchId) {
    rows = rows.filter((s) => s.matchId === Number(matchId));
  }
  if (marketType) {
    rows = rows.filter((s) => s.marketType === String(marketType));
  }

  res.json(rows);
});

router.post("/odds-snapshots", async (req, res) => {
  const parsed = insertOddsSnapshotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const [snapshot] = await db.insert(oddsSnapshotsTable).values(parsed.data).returning();
  res.status(201).json(snapshot);
});

export default router;
