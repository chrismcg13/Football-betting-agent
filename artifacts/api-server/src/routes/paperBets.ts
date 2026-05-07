import { Router } from "express";
import { db, paperBetsTable, insertPaperBetSchema } from "@workspace/db";
import { and, eq, desc, type SQL } from "drizzle-orm";

const router = Router();

// Cost-control fix (2026-05-07): push filters to SQL + cap result set. Same
// pattern as the other list routes — was filtering full-table fetch in JS.
router.get("/paper-bets", async (req, res) => {
  const { status, matchId, limit } = req.query;
  const cap = Math.min(Math.max(Number(limit ?? 500), 1), 5000);

  const conditions: SQL[] = [];
  if (status) conditions.push(eq(paperBetsTable.status, String(status)));
  if (matchId) conditions.push(eq(paperBetsTable.matchId, Number(matchId)));

  const rows = await db
    .select()
    .from(paperBetsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(paperBetsTable.placedAt))
    .limit(cap);

  res.json(rows);
});

router.get("/paper-bets/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [bet] = await db.select().from(paperBetsTable).where(eq(paperBetsTable.id, id));
  if (!bet) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }
  res.json(bet);
});

router.post("/paper-bets", async (req, res) => {
  const parsed = insertPaperBetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const [bet] = await db.insert(paperBetsTable).values(parsed.data).returning();
  res.status(201).json(bet);
});

router.patch("/paper-bets/:id/settle", async (req, res) => {
  const id = Number(req.params.id);
  const { status, settlementPnl } = req.body as {
    status: "won" | "lost" | "void";
    settlementPnl: string;
  };

  const [updated] = await db
    .update(paperBetsTable)
    .set({ status, settlementPnl, settledAt: new Date() })
    .where(eq(paperBetsTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Bet not found" });
    return;
  }
  res.json(updated);
});

export default router;
