import { Router } from "express";
import { runLaunchActivation, runCrossDbLaunchActivation } from "../services/launchActivation";
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

router.get("/launch-activation/betfair-markets", async (req, res) => {
  const home = String(req.query.home ?? "");
  const away = String(req.query.away ?? "");
  const eventId = String(req.query.eventId ?? "");
  if (!home && !eventId) {
    return res.status(400).json({ error: "home or eventId query param required" });
  }
  try {
    const { listAllMarketsForEvent, listMarketsByEventId } = await import("../services/betfairLive");
    let markets;
    if (eventId) {
      markets = await listMarketsByEventId(eventId);
    } else {
      markets = await listAllMarketsForEvent(home, away || "__SKIP_FILTER__");
    }
    const summary = markets.map((m: any) => ({
      marketId: m.marketId,
      marketName: m.marketName,
      marketType: m.description?.marketType,
      event: m.event?.name,
      eventId: m.event?.id,
      startTime: m.marketStartTime,
      runners: m.runners?.map((r: any) => ({ id: r.selectionId, name: r.runnerName, priority: r.sortPriority })),
    }));
    res.json({ count: summary.length, markets: summary });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/cross-db", async (req, res) => {
  const dryRun = req.query.dryRun !== "false";
  const maxBets = Number(req.query.maxBets ?? 20);
  const maxStakePerBet = Number(req.query.maxStakePerBet ?? 10);
  const excludeParam = String(req.query.excludeBetIds ?? "");
  const excludeBetIds = excludeParam ? excludeParam.split(",").map(Number).filter(n => !isNaN(n)) : [];
  const rawMinOpp = Number(req.query.minOpp ?? 60);
  const minOpportunityScore = Number.isFinite(rawMinOpp) ? Math.max(0, Math.min(100, rawMinOpp)) : 60;
  logger.info({ dryRun, maxBets, maxStakePerBet, excludeBetIds, minOpportunityScore }, "Cross-DB launch activation triggered via API");
  try {
    const report = await runCrossDbLaunchActivation({ dryRun, maxBets, maxStakePerBet, excludeBetIds, minOpportunityScore });
    res.json(report);
  } catch (err) {
    logger.error({ err }, "Cross-DB launch activation failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/launch-activation/backfill-neon", async (req, res) => {
  try {
    const { backfillExistingBetsToNeon } = await import("../services/launchActivation");
    const result = await backfillExistingBetsToNeon();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Backfill to Neon failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
