import { Router } from "express";
import { runLaunchActivation } from "../services/launchActivation";
import { runThresholdAssessment } from "../services/thresholdAssessment";
import {
  backfillPinnacleOnPendingBets,
  derivePinnacleDCFromMatchOdds,
  backfillPinnacleUnified,
  runDedicatedBulkPrefetch,
} from "../services/oddsPapi";
import { backfillAfTeamIds, fetchTeamStatsForUpcomingMatches } from "../services/apiFootball";
import { runFeatureEngineForUpcomingMatches } from "../services/featureEngine";
import { logger } from "../lib/logger";

const router = Router();

function requireDevEnvironment(req: any, res: any, next: any) {
  const env = (process.env.ENVIRONMENT || "").toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || "").toLowerCase();
  const isExplicitlyDev = env === "development" || nodeEnv === "development";
  if (!isExplicitlyDev) {
    return res.status(403).json({ error: "Admin endpoints require ENVIRONMENT=development" });
  }
  next();
}

router.use(requireDevEnvironment);

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

router.get("/launch-activation/threshold-assessment", async (req, res) => {
  const low = Number(req.query.low ?? 65);
  const high = Number(req.query.high ?? 68);
  logger.info({ low, high }, "Threshold assessment requested");
  try {
    const result = await runThresholdAssessment(low, high);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Threshold assessment failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/backfill-pinnacle", async (_req, res) => {
  logger.info("Pinnacle backfill triggered via API");
  try {
    const result = await backfillPinnacleOnPendingBets();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Pinnacle backfill failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/backfill-team-ids", async (_req, res) => {
  logger.info("AF team ID backfill triggered via API");
  try {
    const result = await backfillAfTeamIds();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "AF team ID backfill failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/enrich-team-stats", async (_req, res) => {
  logger.info("Team stats enrichment triggered via API");
  try {
    const result = await fetchTeamStatsForUpcomingMatches();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Team stats enrichment failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/recompute-features", async (req, res) => {
  const force = req.query.force === "true";
  logger.info({ force }, "Feature recomputation triggered via API");
  try {
    const result = await runFeatureEngineForUpcomingMatches(force);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Feature recomputation failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/derive-dc-pinnacle", async (_req, res) => {
  logger.info("Derive DC Pinnacle from MATCH_ODDS triggered via API");
  try {
    const result = await derivePinnacleDCFromMatchOdds();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "DC Pinnacle derivation failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/backfill-pinnacle-unified", async (_req, res) => {
  logger.info("Unified Pinnacle backfill triggered via API");
  try {
    const updated = await backfillPinnacleUnified();
    res.json({ updated });
  } catch (err) {
    logger.error({ err }, "Unified Pinnacle backfill failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/bulk-prefetch-oddspapi", async (req, res) => {
  const windowDays = Number(req.query.windowDays ?? 7);
  const maxFetches = Number(req.query.maxFetches ?? 1000);
  logger.info({ windowDays, maxFetches }, "Bulk OddsPapi prefetch triggered via API");
  try {
    const result = await runDedicatedBulkPrefetch(windowDays, maxFetches);
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Bulk OddsPapi prefetch failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
