import cron from "node-cron";
import { logger } from "../lib/logger";
import { runDataIngestion } from "./dataIngestion";

let isRunning = false;

async function safeRun(): Promise<void> {
  if (isRunning) {
    logger.warn("Data ingestion already in progress — skipping this run");
    return;
  }
  isRunning = true;
  try {
    await runDataIngestion();
  } catch (err) {
    logger.error({ err }, "Scheduled data ingestion run failed");
  } finally {
    isRunning = false;
  }
}

export function startScheduler(): void {
  logger.info("Starting Betfair data ingestion scheduler");

  cron.schedule(
    "*/30 6-23 * * *",
    () => {
      void safeRun();
    },
    {
      timezone: "UTC",
    },
  );

  logger.info(
    "Scheduler active — runs every 30 minutes between 06:00 and 23:30 UTC",
  );
}

export async function runIngestionNow(): Promise<void> {
  return safeRun();
}
