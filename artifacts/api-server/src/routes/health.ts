import { Router, type IRouter } from "express";
import { db, paperBetsTable, oddsSnapshotsTable, complianceLogsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { getSchedulerStatus } from "../services/scheduler";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─── GET /api/health ──────────────────────────────────────────────────────────
// Comprehensive health check: DB, Betfair session, football-data, cron statuses

router.get("/health", async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let overallOk = true;

  // 1. Database connectivity
  try {
    await db.execute(sql`SELECT 1`);
    checks["database"] = { status: "ok" };
  } catch (err) {
    overallOk = false;
    checks["database"] = { status: "error", message: (err as Error).message };
  }

  // 2. Betfair session — just check env vars + whether we have a session token
  //    (avoid a live login call on every health check)
  const hasBetfairCreds =
    !!process.env["BETFAIR_APP_KEY"] &&
    !!process.env["BETFAIR_USERNAME"] &&
    !!process.env["BETFAIR_PASSWORD"];
  checks["betfair"] = hasBetfairCreds
    ? { status: "configured", note: "Credentials present — session established on first use" }
    : { status: "unconfigured", note: "BETFAIR_APP_KEY / USERNAME / PASSWORD not set — using football-data fallback" };

  // 3. Football-data.org connectivity
  const hasFootballDataKey = !!process.env["FOOTBALL_DATA_API_KEY"];
  if (hasFootballDataKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const resp = await fetch("https://api.football-data.org/v4/competitions", {
        signal: controller.signal,
        headers: { "X-Auth-Token": process.env["FOOTBALL_DATA_API_KEY"]! },
      });
      clearTimeout(timeout);
      checks["footballData"] = {
        status: resp.ok ? "ok" : "degraded",
        httpStatus: resp.status,
      };
      if (!resp.ok) overallOk = false;
    } catch (err) {
      // Network error or timeout — don't mark overall as failed, data may be cached
      checks["footballData"] = { status: "unreachable", message: (err as Error).message };
    }
  } else {
    checks["footballData"] = { status: "unconfigured", note: "FOOTBALL_DATA_API_KEY not set" };
  }

  // 4. Last odds fetch time (most recent odds snapshot)
  try {
    const [latestOdds] = await db
      .select({ snapshotTime: oddsSnapshotsTable.snapshotTime })
      .from(oddsSnapshotsTable)
      .orderBy(desc(oddsSnapshotsTable.snapshotTime))
      .limit(1);
    checks["lastOddsFetch"] = latestOdds?.snapshotTime ?? null;
  } catch {
    checks["lastOddsFetch"] = null;
  }

  // 5. Last bet placed time
  try {
    const [latestBet] = await db
      .select({ placedAt: paperBetsTable.placedAt })
      .from(paperBetsTable)
      .orderBy(desc(paperBetsTable.placedAt))
      .limit(1);
    checks["lastBetPlaced"] = latestBet?.placedAt ?? null;
  } catch {
    checks["lastBetPlaced"] = null;
  }

  // 6. Cron job statuses
  checks["cronJobs"] = getSchedulerStatus();

  // 7. Process uptime
  checks["uptimeSeconds"] = Math.floor(process.uptime());
  checks["nodeVersion"] = process.version;
  checks["timestamp"] = new Date().toISOString();

  res.status(overallOk ? 200 : 503).json({
    status: overallOk ? "ok" : "degraded",
    ...checks,
  });
});

// Keep the legacy /healthz alive for any existing monitors
router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

export default router;
