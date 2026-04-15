import { Router } from "express";
import { runLaunchActivation } from "../services/launchActivation";
import { logger } from "../lib/logger";

const router = Router();

router.post("/launch-activation", async (_req, res) => {
  logger.info("Launch activation triggered via API");
  try {
    const report = await runLaunchActivation();
    res.json(report);
  } catch (err) {
    logger.error({ err }, "Launch activation failed");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/launch-activation/preflight", async (_req, res) => {
  try {
    const { isLiveMode } = await import("../services/betfairLive");
    const { getEffectiveLimits, getCurrentLiveRiskLevel } = await import("../services/liveRiskManager");
    const { getLiveOppScoreThreshold } = await import("../services/liveThresholdReview");
    const { getCommissionRate } = await import("../services/commissionService");

    const isLive = isLiveMode();
    const limits = await getEffectiveLimits();
    const riskLevel = await getCurrentLiveRiskLevel();
    const oppThreshold = await getLiveOppScoreThreshold();
    const commRate = await getCommissionRate();

    res.json({
      mode: isLive ? "LIVE" : "PAPER",
      riskLevel,
      oppThreshold,
      commissionRate: commRate,
      limits,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
