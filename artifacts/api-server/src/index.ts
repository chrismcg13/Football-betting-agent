import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { startScheduler, startSettlementCron, runIngestionNow, runFeaturesNow } from "./services/scheduler";
import { loadLatestModel, bootstrapModels } from "./services/predictionEngine";
import { db, complianceLogsTable, matchesTable, leagueEdgeScoresTable } from "@workspace/db";
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

// ─── League edge score seeding ────────────────────────────────────────────────
// Seeds initial edge scores for leagues not yet in the DB.
// The learning loop will refine these dynamically as bets settle.

const INITIAL_LEAGUE_EDGE_SCORES: Record<string, number> = {
  // Tier 1 — heavily scrutinised, lower edge
  "Premier League": 60,
  "Bundesliga": 62,
  "La Liga": 62,
  "Primera Division": 62,
  "Serie A": 63,
  "Ligue 1": 65,
  "Eredivisie": 68,
  "Primeira Liga": 69,
  "Campeonato Brasileiro Série A": 72,
  "Brasileirão": 72,
  "Championship": 70,
  "EFL Championship": 70,
  "UEFA Champions League": 55,
  "Champions League": 55,
  "Europa League": 60,
  "UEFA Europa League": 60,
  // Tier 2 — less scrutinised, higher edge opportunity
  "Ligue 2": 82,
  "2. Bundesliga": 82,
  "Serie B": 82,
  "Segunda División": 82,
  "La Liga 2": 82,
  "Segunda Division": 82,
  // Tier 3 — smaller top flights
  "Scottish Premiership": 78,
  "Belgian Pro League": 70,
  "Swiss Super League": 70,
  "Austrian Football Bundesliga": 70,
  "Danish Superliga": 70,
  "Norwegian Eliteserien": 70,
  "Swedish Allsvenskan": 70,
  "Süper Lig": 72,
  "Super League Greece": 72,
  "Super League 1": 72,
};

async function seedLeagueEdgeScores(): Promise<void> {
  try {
    const existing = await db
      .select({ league: leagueEdgeScoresTable.league })
      .from(leagueEdgeScoresTable);
    const existingLeagues = new Set(existing.map((r) => r.league));

    const toSeed = Object.entries(INITIAL_LEAGUE_EDGE_SCORES).filter(
      ([league]) => !existingLeagues.has(league),
    );

    if (toSeed.length > 0) {
      await db.insert(leagueEdgeScoresTable).values(
        toSeed.map(([league, score]) => ({
          league,
          marketType: "ALL",
          totalBets: 0,
          wins: 0,
          losses: 0,
          roiPct: 0,
          avgClv: 0,
          avgEdge: 0,
          confidenceScore: score,
          isSeedData: 1,
          lastUpdated: new Date(),
        })),
      );
      logger.info({ count: toSeed.length, leagues: toSeed.map(([l]) => l) }, "Seeded league edge scores for new leagues");
    } else {
      logger.debug("All league edge scores already present — no seeding needed");
    }
  } catch (err) {
    logger.warn({ err }, "League edge score seeding failed — non-fatal");
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

  // 3. Seed league edge scores for expanded league coverage
  await seedLeagueEdgeScores();

  // 4. Start schedulers
  // Settlement cron always runs (dev + prod) — it is a lightweight DB operation,
  // no API quota is consumed beyond the minimal syncMatchResults calls for past fixtures.
  startSettlementCron();
  logger.info("Settlement cron started (every 5 min, all environments)");

  // All other crons (ingestion, trading, odds, learning) are production-only to
  // prevent this dev environment from racing the production VM for API quota.
  if (process.env["NODE_ENV"] === "production") {
    startScheduler();
    logger.info("Autonomous scheduler started (production mode)");
  } else {
    logger.info("Expensive schedulers DISABLED in development — use manual API triggers (/api/trading/run, /api/ingestion/run, etc.)");
  }

  // 5. Load or bootstrap the ML model
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

    // 8. Self-ping keepalive — prevents idle shutdown by calling the health
    //    endpoint every 5 minutes. Must start inside the listen callback so
    //    the server is guaranteed to be accepting connections first.
    const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
    const keepaliveUrl = `http://localhost:${port}/api/health`;
    setInterval(() => {
      fetch(keepaliveUrl)
        .then((r) => {
          if (!r.ok) logger.warn({ status: r.status }, "Keepalive ping returned non-OK");
        })
        .catch((err) => {
          logger.warn({ err }, "Keepalive ping failed — server may be under load");
        });
    }, KEEPALIVE_INTERVAL_MS);
    logger.info({ intervalMs: KEEPALIVE_INTERVAL_MS }, "Keepalive ping active — GET /api/health every 5 min");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
