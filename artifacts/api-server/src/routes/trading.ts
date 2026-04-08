import { Router } from "express";
import { db, paperBetsTable, agentConfigTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { settleBets, placePaperBet, getAgentStatus, getBankroll } from "../services/paperTrading";
import { runAllRiskChecks, resumeAgent } from "../services/riskManager";
import { runTradingCycle } from "../services/scheduler";
import { logger } from "../lib/logger";

const router = Router();

// GET /trading/status — bankroll, agent status, open bets
router.get("/trading/status", async (req, res) => {
  const [status, bankroll, openBets] = await Promise.all([
    getAgentStatus(),
    getBankroll(),
    db
      .select()
      .from(paperBetsTable)
      .where(eq(paperBetsTable.status, "pending"))
      .orderBy(desc(paperBetsTable.placedAt)),
  ]);

  res.json({
    agentStatus: status,
    bankroll,
    openBetsCount: openBets.length,
    openBets,
  });
});

// POST /trading/settle — manually trigger settlement of finished bets
router.post("/trading/settle", async (req, res) => {
  logger.info("Manual bet settlement triggered via API");
  const result = await settleBets();
  res.json(result);
});

// POST /trading/risk-check — manually run all risk checks
router.post("/trading/risk-check", async (req, res) => {
  const result = await runAllRiskChecks();
  res.json(result);
});

// POST /trading/resume — manually resume a paused agent
router.post("/trading/resume", async (req, res) => {
  await resumeAgent();
  const status = await getAgentStatus();
  res.json({ agentStatus: status });
});

// POST /trading/cycle — manually trigger a full trading cycle (fire-and-forget)
router.post("/trading/cycle", async (req, res) => {
  logger.info("Manual trading cycle triggered via API");
  res.json({ message: "Trading cycle started" });
  void runTradingCycle();
});

// POST /trading/run — manually trigger and AWAIT a full trading cycle
router.post("/trading/run", async (req, res) => {
  logger.info("Manual trading cycle triggered via API — awaiting completion");
  try {
    const result = await runTradingCycle();
    res.json({ success: true, message: "Trading cycle complete", result });
  } catch (err) {
    logger.error({ err }, "Manual trading cycle failed");
    res.status(500).json({ success: false, message: String(err) });
  }
});

// GET /trading/history — recent settled bets with P&L summary
router.get("/trading/history", async (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? "50"), 200);

  const bets = await db
    .select()
    .from(paperBetsTable)
    .orderBy(desc(paperBetsTable.placedAt))
    .limit(limit);

  const won = bets.filter((b) => b.status === "won");
  const lost = bets.filter((b) => b.status === "lost");
  const pending = bets.filter((b) => b.status === "pending");

  const totalPnl = [...won, ...lost].reduce(
    (sum, b) => sum + Number(b.settlementPnl ?? 0),
    0,
  );
  const roi =
    [...won, ...lost].reduce((sum, b) => sum + Number(b.stake), 0) > 0
      ? (totalPnl /
          [...won, ...lost].reduce((sum, b) => sum + Number(b.stake), 0)) *
        100
      : 0;

  res.json({
    summary: {
      totalBets: won.length + lost.length,
      won: won.length,
      lost: lost.length,
      pending: pending.length,
      winRate:
        won.length + lost.length > 0
          ? ((won.length / (won.length + lost.length)) * 100).toFixed(1) + "%"
          : "n/a",
      totalPnl: Math.round(totalPnl * 100) / 100,
      roi: roi.toFixed(2) + "%",
    },
    bets,
  });
});

export default router;
