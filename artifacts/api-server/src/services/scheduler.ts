import cron from "node-cron";
import { logger } from "../lib/logger";
import { runDataIngestion } from "./dataIngestion";
import { runFeatureEngineForUpcomingMatches } from "./featureEngine";

let ingestionRunning = false;
let featureRunning = false;

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

export function startScheduler(): void {
  logger.info("Starting schedulers");

  cron.schedule(
    "*/30 6-23 * * *",
    () => { void safeRunIngestion(); },
    { timezone: "UTC" },
  );
  logger.info("Ingestion scheduler active — every 30 min, 06:00–23:30 UTC");

  cron.schedule(
    "0 */6 * * *",
    () => { void safeRunFeatures(); },
    { timezone: "UTC" },
  );
  logger.info("Feature scheduler active — every 6 hours UTC");
}

export async function runIngestionNow(): Promise<void> {
  return safeRunIngestion();
}

export async function runFeaturesNow(): Promise<ReturnType<typeof runFeatureEngineForUpcomingMatches>> {
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
