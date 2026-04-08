import cron from "node-cron";
import { logger } from "../lib/logger";
import { runDataIngestion } from "./dataIngestion";
import { runFeatureEngineForUpcomingMatches } from "./featureEngine";
import { detectValueBets } from "./valueDetection";
import { placePaperBet, settleBets, getAgentStatus } from "./paperTrading";
import { runAllRiskChecks } from "./riskManager";
import { getModelVersion } from "./predictionEngine";
import { matchesTable, db } from "@workspace/db";
import { eq, gte, lte, and } from "drizzle-orm";

// ===================== Guard flags =====================
let ingestionRunning = false;
let featureRunning = false;
let tradingCycleRunning = false;

// ===================== Safe wrappers =====================

async function safeRunIngestion(): Promise<void> {
  if (ingestionRunning) {
    logger.warn("Data ingestion already in progress — skipping this run");
    return;
  }
  ingestionRunning = true;
  try {
    await runDataIngestion();
  } catch (err) {
    logger.error({ err }, "Scheduled data ingestion run failed");
  } finally {
    ingestionRunning = false;
  }
}

async function safeRunFeatures(): Promise<void> {
  if (featureRunning) {
    logger.warn("Feature computation already in progress — skipping this run");
    return;
  }
  featureRunning = true;
  try {
    await runFeatureEngineForUpcomingMatches();
  } catch (err) {
    logger.error({ err }, "Scheduled feature computation run failed");
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
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false };
  }
  tradingCycleRunning = true;

  try {
    logger.info("Starting trading cycle");

    // 1. Settle any finished bets first
    const settlement = await settleBets();
    logger.info(
      {
        settled: settlement.settled,
        won: settlement.won,
        lost: settlement.lost,
        pnl: settlement.totalPnl,
      },
      "Settlement complete",
    );

    // 2. Run risk checks
    const riskResult = await runAllRiskChecks();
    if (riskResult.anyTriggered) {
      logger.warn("Risk check triggered — skipping bet placement this cycle");
      return {
        betsPlaced: 0,
        betsSettled: settlement.settled,
        riskTriggered: true,
      };
    }

    // 3. Check agent is running
    const agentStatus = await getAgentStatus();
    if (agentStatus !== "running") {
      logger.info({ agentStatus }, "Agent not running — skipping bet placement");
      return {
        betsPlaced: 0,
        betsSettled: settlement.settled,
        riskTriggered: false,
      };
    }

    // 4. Check model is available
    const modelVersion = getModelVersion();
    if (!modelVersion) {
      logger.info("No model loaded — skipping value detection");
      return {
        betsPlaced: 0,
        betsSettled: settlement.settled,
        riskTriggered: false,
      };
    }

    // 5. Detect value bets for matches kicking off in 2-24 hours
    const now = new Date();
    const earliest = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const latest = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const valueSummary = await detectValueBets();
    const timely = valueSummary.valueBets.filter(
      (b) =>
        new Date(b.kickoffTime) >= earliest &&
        new Date(b.kickoffTime) <= latest,
    );

    logger.info(
      {
        totalValueBets: valueSummary.valueBets.length,
        timelyBets: timely.length,
        window: "2-24h before kickoff",
      },
      "Value detection complete for trading cycle",
    );

    if (timely.length === 0) {
      return {
        betsPlaced: 0,
        betsSettled: settlement.settled,
        riskTriggered: false,
      };
    }

    // 6. Place up to 3 best value bets
    const candidates = timely.slice(0, 3);
    let betsPlaced = 0;

    for (const bet of candidates) {
      const result = await placePaperBet(
        bet.matchId,
        bet.marketType,
        bet.selectionName,
        bet.backOdds,
        bet.modelProbability,
        bet.edge,
        modelVersion,
      );
      if (result.placed) {
        betsPlaced++;
        logger.info(
          {
            matchId: bet.matchId,
            homeTeam: bet.homeTeam,
            awayTeam: bet.awayTeam,
            marketType: bet.marketType,
            selectionName: bet.selectionName,
            edge: bet.edge.toFixed(4),
            stake: result.stake,
          },
          "Automated bet placed",
        );
      }
    }

    logger.info(
      { betsPlaced, betsSettled: settlement.settled },
      "Trading cycle complete",
    );
    return {
      betsPlaced,
      betsSettled: settlement.settled,
      riskTriggered: false,
    };
  } catch (err) {
    logger.error({ err }, "Trading cycle failed");
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false };
  } finally {
    tradingCycleRunning = false;
  }
}

// ===================== Scheduler =====================

export function startScheduler(): void {
  logger.info("Starting schedulers");

  // Data ingestion: every 30 min, 06:00–23:30 UTC
  cron.schedule(
    "*/30 6-23 * * *",
    () => {
      void safeRunIngestion();
    },
    { timezone: "UTC" },
  );
  logger.info("Ingestion scheduler active — every 30 min, 06:00–23:30 UTC");

  // Feature computation: every 6 hours
  cron.schedule(
    "0 */6 * * *",
    () => {
      void safeRunFeatures();
    },
    { timezone: "UTC" },
  );
  logger.info("Feature scheduler active — every 6 hours UTC");

  // Trading cycle: every 15 minutes
  cron.schedule(
    "*/15 * * * *",
    () => {
      void runTradingCycle();
    },
    { timezone: "UTC" },
  );
  logger.info("Trading cycle scheduler active — every 15 minutes");
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
