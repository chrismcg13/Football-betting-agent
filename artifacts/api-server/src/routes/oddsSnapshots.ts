import { Router } from "express";
import { db, oddsSnapshotsTable, insertOddsSnapshotSchema } from "@workspace/db";
import { and, eq, desc, type SQL } from "drizzle-orm";

const router = Router();

// Cost-control fix (2026-05-07): odds_snapshots is 2.2 GB / 17M rows. The
// previous unbounded `.from(...).orderBy(...)` then JS filter pulled the
// whole table on every request — likely the dominant Neon egress driver.
// Filters now push to SQL WHERE; default LIMIT 200 caps the result-set.
router.get("/odds-snapshots", async (req, res) => {
  const { matchId, marketType, limit } = req.query;
  const cap = Math.min(Math.max(Number(limit ?? 200), 1), 1000);

  const conditions: SQL[] = [];
  if (matchId) conditions.push(eq(oddsSnapshotsTable.matchId, Number(matchId)));
  if (marketType) conditions.push(eq(oddsSnapshotsTable.marketType, String(marketType)));

  const rows = await db
    .select()
    .from(oddsSnapshotsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(oddsSnapshotsTable.snapshotTime))
    .limit(cap);

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
