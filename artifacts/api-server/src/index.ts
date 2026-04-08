import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { startScheduler, runIngestionNow, runFeaturesNow } from "./services/scheduler";
import { loadLatestModel, bootstrapModels } from "./services/predictionEngine";
import { db, complianceLogsTable, matchesTable } from "@workspace/db";
import { sql, count } from "drizzle-orm";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

// ─── Connection tests ─────────────────────────────────────────────────────────

async function testDatabase(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    logger.info("Database connection OK");
    return true;
  } catch (err) {
    logger.error({ err }, "Database connection FAILED");
    return false;
  }
}

async function testBetfair(): Promise<boolean> {
  const hasCreds =
    !!process.env["BETFAIR_APP_KEY"] &&
    !!process.env["BETFAIR_USERNAME"] &&
    !!process.env["BETFAIR_PASSWORD"];
  if (!hasCreds) {
    logger.warn("Betfair credentials not set — will use football-data.org fallback");
    return false;
  }
  logger.info("Betfair credentials present — session will be established on first use");
  return true;
}

async function testFootballData(): Promise<boolean> {
  const apiKey = process.env["FOOTBALL_DATA_API_KEY"];
  if (!apiKey) {
    logger.warn("FOOTBALL_DATA_API_KEY not set — data ingestion may fail");
    return false;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch("https://api.football-data.org/v4/competitions", {
      signal: controller.signal,
      headers: { "X-Auth-Token": apiKey },
    });
    clearTimeout(timeout);
    if (resp.ok) {
      logger.info("football-data.org connection OK");
      return true;
    }
    logger.warn({ status: resp.status }, "football-data.org returned non-OK status");
    return false;
  } catch (err) {
    logger.warn({ err }, "football-data.org connection test failed — will retry on first scheduled run");
    return false;
  }
}

// ─── Initial data bootstrap ───────────────────────────────────────────────────

async function bootstrapDataIfEmpty(): Promise<void> {
  try {
    const [result] = await db.select({ count: count() }).from(matchesTable);
    const matchCount = result?.count ?? 0;

    if (matchCount === 0) {
      logger.info("Database is empty — running initial data ingestion and feature computation");
      await runIngestionNow();
      await runFeaturesNow();
      logger.info("Initial data bootstrap complete");
    } else {
      // DB has data — still run features on startup so upcoming matches have fresh
      // feature vectors available for the trading cycle
      logger.info({ matchCount }, "Database has data — running startup feature computation for upcoming matches");
      try {
        await runFeaturesNow();
        logger.info("Startup feature computation complete");
      } catch (featureErr) {
        logger.warn({ err: featureErr }, "Startup feature computation failed — will retry on next scheduled run");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Initial data bootstrap failed — will retry on first scheduled run");
  }
}

// ─── Compliance startup log ───────────────────────────────────────────────────

async function logAgentStarted(details: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(complianceLogsTable).values({
      actionType: "agent_control",
      details: {
        action: "start",
        initiatedBy: "system",
        previousStatus: "stopped",
        newStatus: "running",
        ...details,
      },
      timestamp: new Date(),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to write startup compliance log");
  }
}

// ─── Main startup sequence ────────────────────────────────────────────────────

async function main() {
  logger.info("=== BET_AGENT_OS starting ===");

  // 1. Database migrations (will throw and abort if DB is unreachable)
  await runMigrations();

  // 2. Connection checks — non-fatal (warn + continue)
  const [dbOk, betfairOk, footballDataOk] = await Promise.all([
    testDatabase(),
    testBetfair(),
    testFootballData(),
  ]);

  if (!dbOk) {
    logger.error("Cannot start without database — aborting");
    process.exit(1);
  }

  // 3. Start all cron jobs
  startScheduler();

  // 4. Load or bootstrap the ML model
  const modelLoaded = await loadLatestModel();
  if (!modelLoaded) {
    logger.info("No existing model found — triggering bootstrap training in background");
    void bootstrapModels().catch((err) =>
      logger.error({ err }, "Background bootstrap training failed"),
    );
  }

  // 5. Fetch initial data if the database is empty (non-blocking)
  void bootstrapDataIfEmpty();

  // 6. Log agent started to compliance audit trail
  await logAgentStarted({
    nodeVersion: process.version,
    port,
    dbConnected: dbOk,
    betfairConfigured: betfairOk,
    footballDataConfigured: footballDataOk,
    modelLoaded,
    startedAt: new Date().toISOString(),
  });

  // 7. Start the HTTP server
  app.listen(port, () => {
    logger.info(
      {
        port,
        dbConnected: dbOk,
        betfairConfigured: betfairOk,
        footballDataConfigured: footballDataOk,
        modelLoaded,
      },
      "=== BET_AGENT_OS ready ===",
    );
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
