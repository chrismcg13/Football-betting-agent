import { Router } from "express";
import { db, paperBetsTable, insertPaperBetSchema } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

router.get("/paper-bets", async (req, res) => {
  const { status, matchId } = req.query;
  let rows = await db.select().from(paperBetsTable).orderBy(desc(paperBetsTable.placedAt));

  if (status) {
    rows = rows.filter((b) => b.status === String(status));
  }
  if (matchId) {
    rows = rows.filter((b) => b.matchId === Number(matchId));
  }

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
