import cron from "node-cron";
import { logger } from "../lib/logger";
import { runDataIngestion } from "./dataIngestion";
import { runFeatureEngineForUpcomingMatches } from "./featureEngine";
import { detectValueBets } from "./valueDetection";
import { placePaperBet, settleBets, getAgentStatus } from "./paperTrading";
import { runAllRiskChecks } from "./riskManager";
import { getModelVersion } from "./predictionEngine";
import { runLearningLoop } from "./learningLoop";
import {
  fetchAndStoreOddsForAllUpcoming,
  fetchTeamStatsForUpcomingMatches,
} from "./apiFootball";
import { db, agentConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ===================== Status tracking =====================

export interface JobStatus {
  lastRunAt: Date | null;
  lastRunResult: "success" | "error" | "skipped" | null;
  isRunning: boolean;
  runCount: number;
}

const jobStatus: Record<string, JobStatus> = {
  ingestion: { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  features:  { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  trading:   { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  learning:  { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
};

export function getSchedulerStatus(): Record<string, JobStatus> {
  return { ...jobStatus };
}

function markRun(job: string, result: "success" | "error" | "skipped") {
  const s = jobStatus[job];
  if (s) {
    s.lastRunAt = new Date();
    s.lastRunResult = result;
    s.runCount += 1;
    s.isRunning = false;
  }
}

function markStart(job: string) {
  const s = jobStatus[job];
  if (s) s.isRunning = true;
}

// ===================== Guard flags =====================
let ingestionRunning = false;
let featureRunning = false;
let tradingCycleRunning = false;

// ===================== Safe wrappers =====================

async function safeRunIngestion(): Promise<void> {
  if (ingestionRunning) {
    logger.warn("Data ingestion already in progress — skipping this run");
    markRun("ingestion", "skipped");
    return;
  }
  ingestionRunning = true;
  markStart("ingestion");
  try {
    await runDataIngestion();
    markRun("ingestion", "success");
    // Always recompute features right after ingestion so upcoming match vectors
    // are fresh for the next trading cycle
    void safeRunFeatures();
  } catch (err) {
    logger.error({ err }, "Scheduled data ingestion run failed");
    markRun("ingestion", "error");
  } finally {
    ingestionRunning = false;
  }
}

async function safeRunFeatures(): Promise<void> {
  if (featureRunning) {
    logger.warn("Feature computation already in progress — skipping this run");
    markRun("features", "skipped");
    return;
  }
  featureRunning = true;
  markStart("features");
  try {
    await runFeatureEngineForUpcomingMatches();
    markRun("features", "success");
  } catch (err) {
    logger.error({ err }, "Scheduled feature computation run failed");
    markRun("features", "error");
  } finally {
    featureRunning = false;
  }
}

// ===================== Trading cycle =====================

export async function runTradingCycle(): Promise<{
  betsPlaced: number;
  betsSettled: number;
  riskTriggered: boolean;
}> {
  if (tradingCycleRunning) {
    logger.warn("Trading cycle already in progress — skipping this run");
    markRun("trading", "skipped");
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false };
  }
  tradingCycleRunning = true;
  markStart("trading");

  try {
    logger.info("Starting trading cycle");

    // 1. Settle any finished bets first
    const settlement = await settleBets();
    logger.info(
      { settled: settlement.settled, won: settlement.won, lost: settlement.lost, pnl: settlement.totalPnl },
      "Settlement complete",
    );

    // 2. Run risk checks
    const riskResult = await runAllRiskChecks();
    if (riskResult.anyTriggered) {
      logger.warn("Risk check triggered — skipping bet placement this cycle");
      markRun("trading", "success");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: true };
    }

    // 3. Check agent is running
    const agentStatus = await getAgentStatus();
    if (agentStatus !== "running") {
      logger.info({ agentStatus }, "Agent not running — skipping bet placement");
      markRun("trading", "skipped");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    // 4. Check model is available
    const modelVersion = getModelVersion();
    if (!modelVersion) {
      logger.info("No model loaded — skipping value detection");
      markRun("trading", "skipped");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    // 5. Detect value bets for matches kicking off in 1h – 96h
    const now = new Date();
    const earliest = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    const latest   = new Date(now.getTime() + 96 * 60 * 60 * 1000);

    const valueSummary = await detectValueBets();
    const timely = valueSummary.valueBets.filter(
      (b) => new Date(b.kickoffTime) >= earliest && new Date(b.kickoffTime) <= latest,
    );

    logger.info(
      {
        totalValueBets: valueSummary.valueBets.length,
        timelyBets: timely.length,
        realOdds: valueSummary.realOddsCount,
        syntheticOdds: valueSummary.syntheticOddsCount,
        byMarketType: valueSummary.byMarketType,
        window: "1h-96h before kickoff",
      },
      "Value detection complete for trading cycle",
    );

    if (timely.length === 0) {
      markRun("trading", "success");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    // 6. Load diversity limits from config
    const configRows = await db.select().from(agentConfigTable);
    const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));
    const maxPerCycle = Number(cfg.max_bets_per_cycle ?? "5");
    const maxPerLeague = Number(cfg.max_bets_per_league ?? "2");
    const maxPerMarket = Number(cfg.max_bets_per_market ?? "2");

    // 7. Apply diversity rules and place up to maxPerCycle best bets
    let betsPlaced = 0;
    const leagueCounts: Record<string, number> = {};
    const marketCounts: Record<string, number> = {};

    for (const bet of timely) {
      if (betsPlaced >= maxPerCycle) break;

      const leagueCount = leagueCounts[bet.league] ?? 0;
      if (leagueCount >= maxPerLeague) {
        logger.debug({ league: bet.league, limit: maxPerLeague }, "Skipping bet — league diversity limit");
        continue;
      }

      const marketCount = marketCounts[bet.marketType] ?? 0;
      if (marketCount >= maxPerMarket) {
        logger.debug({ marketType: bet.marketType, limit: maxPerMarket }, "Skipping bet — market diversity limit");
        continue;
      }

      const result = await placePaperBet(
        bet.matchId,
        bet.marketType,
        bet.selectionName,
        bet.backOdds,
        bet.modelProbability,
        bet.edge,
        modelVersion,
        bet.opportunityScore,
        bet.oddsSource,
      );

      if (result.placed) {
        betsPlaced++;
        leagueCounts[bet.league] = leagueCount + 1;
        marketCounts[bet.marketType] = marketCount + 1;
        logger.info(
          {
            matchId: bet.matchId,
            homeTeam: bet.homeTeam,
            awayTeam: bet.awayTeam,
            marketType: bet.marketType,
            selectionName: bet.selectionName,
            edge: bet.edge.toFixed(4),
            stake: result.stake,
            oddsSource: bet.oddsSource,
            opportunityScore: bet.opportunityScore,
          },
          "Automated bet placed",
        );
      }
    }

    logger.info({ betsPlaced, betsSettled: settlement.settled }, "Trading cycle complete");
    markRun("trading", "success");
    return { betsPlaced, betsSettled: settlement.settled, riskTriggered: false };
  } catch (err) {
    logger.error({ err }, "Trading cycle failed");
    markRun("trading", "error");
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false };
  } finally {
    tradingCycleRunning = false;
  }
}

// ===================== Scheduler =====================

export function startScheduler(): void {
  logger.info("Starting schedulers");

  // Data ingestion: every 30 min, 06:00–23:30 UTC
  cron.schedule("*/30 6-23 * * *", () => { void safeRunIngestion(); }, { timezone: "UTC" });
  logger.info("Ingestion scheduler active — every 30 min, 06:00–23:30 UTC");

  // Feature computation: every 6 hours
  cron.schedule("0 */6 * * *", () => { void safeRunFeatures(); }, { timezone: "UTC" });
  logger.info("Feature scheduler active — every 6 hours UTC");

  // Trading cycle: every 15 minutes
  cron.schedule("*/15 * * * *", () => { void runTradingCycle(); }, { timezone: "UTC" });
  logger.info("Trading cycle scheduler active — every 15 minutes");

  // API-Football: fetch real odds every 8 hours (biggest budget item ~30 req)
  cron.schedule("0 */8 * * *", () => {
    logger.info("API-Football odds refresh triggered by scheduler");
    void fetchAndStoreOddsForAllUpcoming().catch((err) => {
      logger.error({ err }, "API-Football odds refresh failed");
    });
  }, { timezone: "UTC" });
  logger.info("API-Football odds scheduler active — every 8 hours UTC");

  // API-Football: fetch team stats every 12 hours (~20 req)
  cron.schedule("0 */12 * * *", () => {
    logger.info("API-Football team stats refresh triggered by scheduler");
    void fetchTeamStatsForUpcomingMatches().catch((err) => {
      logger.error({ err }, "API-Football team stats refresh failed");
    });
  }, { timezone: "UTC" });
  logger.info("API-Football team stats scheduler active — every 12 hours UTC");

  // Learning loop: daily at 03:00 UTC
  cron.schedule("0 3 * * *", () => {
    logger.info("Daily learning loop triggered by scheduler");
    markStart("learning");
    void runLearningLoop()
      .then(() => markRun("learning", "success"))
      .catch((err) => {
        logger.error({ err }, "Scheduled learning loop failed");
        markRun("learning", "error");
      });
  }, { timezone: "UTC" });
  logger.info("Learning loop scheduler active — daily at 03:00 UTC");
}

// ===================== Manual triggers (for API routes) =====================

export async function runIngestionNow(): Promise<void> {
  return safeRunIngestion();
}

export async function runFeaturesNow(): Promise<
  ReturnType<typeof runFeatureEngineForUpcomingMatches>
> {
  if (featureRunning) {
    logger.warn("Feature computation already in progress");
    return { processed: 0, skipped: 0, failed: 0 };
  }
  featureRunning = true;
  try {
    return await runFeatureEngineForUpcomingMatches();
  } finally {
    featureRunning = false;
  }
}
