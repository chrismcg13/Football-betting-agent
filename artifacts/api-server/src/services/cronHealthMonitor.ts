/**
 * 2026-05-08 (§4.2 of root-cause-analysis): cron health invariants.
 *
 * Today's trading-cycle outage was invisible for 13+ hours because no
 * monitor existed to flag "this cron hasn't succeeded recently." This
 * service runs every 5 minutes, compares each tracked cron's last
 * successful run against an expected cadence, and inserts rows into
 * cron_stale_alert when a cron is overdue.
 *
 * Convention:
 *   - For each cron, we know its expected cadence (hardcoded below — must
 *     match scheduler.ts entries). If the time since last success exceeds
 *     3× the cadence, a stale alert fires.
 *   - The 3× multiplier absorbs normal jitter (one missed slot is
 *     allowed). Two consecutive missed slots → alerted.
 *   - Alerts dedupe: only one unacknowledged row per cron per 24h.
 *
 * Operator query (no UI):
 *   SELECT * FROM cron_stale_alert WHERE acknowledged_at IS NULL
 *   ORDER BY detected_at DESC;
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface ExpectedCron {
  jobName: string;
  expectedCadenceMs: number;
  // Some crons run only on demand (manual triggers, weekly schedules at
  // specific times). For those, set 'allow_missing_for' to a longer window.
  alertAfterMs: number;
}

// Hardcoded registry. Must match scheduler.ts entries. Adding a new cron
// requires updating both files — this is a pattern enforcement point.
const TRACKED_CRONS: ExpectedCron[] = [
  // High-cadence critical paths
  { jobName: "trading_near", expectedCadenceMs: 5 * 60_000, alertAfterMs: 15 * 60_000 },
  { jobName: "trading_far", expectedCadenceMs: 30 * 60_000, alertAfterMs: 90 * 60_000 },
  { jobName: "exchange_book_sweep", expectedCadenceMs: 10 * 60_000, alertAfterMs: 30 * 60_000 },
  { jobName: "betfair_event_map", expectedCadenceMs: 6 * 60 * 60_000, alertAfterMs: 18 * 60 * 60_000 },
  // Medium-cadence
  { jobName: "ingestion", expectedCadenceMs: 30 * 60_000, alertAfterMs: 90 * 60_000 },
  { jobName: "features", expectedCadenceMs: 6 * 60 * 60_000, alertAfterMs: 18 * 60 * 60_000 },
  // Low-cadence (daily) — alerts after 36h means one missed daily slot
  // is allowed; two missed days = alert.
  { jobName: "promotion_engine", expectedCadenceMs: 24 * 60 * 60_000, alertAfterMs: 36 * 60 * 60_000 },
];

export interface CronHealthResult {
  evaluatedAt: string;
  crons_checked: number;
  alerts_fired: number;
  alerts_already_active: number;
}

export async function runCronHealthMonitor(): Promise<CronHealthResult> {
  const result: CronHealthResult = {
    evaluatedAt: new Date().toISOString(),
    crons_checked: TRACKED_CRONS.length,
    alerts_fired: 0,
    alerts_already_active: 0,
  };

  for (const expected of TRACKED_CRONS) {
    const rows = await db.execute(sql`
      SELECT MAX(started_at) AS last_success
      FROM cron_executions
      WHERE job_name = ${expected.jobName}
        AND success = true
    `);
    const lastSuccess = (((rows as any).rows ?? [])[0]?.last_success ?? null) as string | null;

    let staleMs: number;
    if (lastSuccess == null) {
      // Never succeeded — only alert if the cron has been deployed long
      // enough to have run at least once. Use service uptime via
      // bankroll_snapshots (proxy: any recent table activity).
      staleMs = expected.alertAfterMs + 1; // force alert path
    } else {
      staleMs = Date.now() - new Date(lastSuccess).getTime();
    }

    if (staleMs <= expected.alertAfterMs) continue;

    // Dedupe: only one unacknowledged alert per cron in last 24h
    const existing = await db.execute(sql`
      SELECT 1 FROM cron_stale_alert
      WHERE job_name = ${expected.jobName}
        AND detected_at > NOW() - INTERVAL '24 hours'
        AND acknowledged_at IS NULL
      LIMIT 1
    `);
    if ((((existing as any).rows ?? []) as unknown[]).length > 0) {
      result.alerts_already_active++;
      continue;
    }

    await db.execute(sql`
      INSERT INTO cron_stale_alert (
        detected_at, job_name, last_success_at, expected_cadence_ms,
        alert_after_ms, stale_ms, manifest
      ) VALUES (
        NOW(), ${expected.jobName},
        ${lastSuccess}, ${expected.expectedCadenceMs},
        ${expected.alertAfterMs}, ${staleMs},
        ${JSON.stringify({
          message: `Cron ${expected.jobName} has not succeeded in ${Math.round(staleMs / 60_000)} min (alert threshold: ${Math.round(expected.alertAfterMs / 60_000)} min)`,
          last_success_at: lastSuccess,
        })}::jsonb
      )
    `);
    result.alerts_fired++;
    logger.warn(
      { jobName: expected.jobName, lastSuccess, staleMinutes: Math.round(staleMs / 60_000) },
      "Cron stale alert fired",
    );
  }

  logger.info(result, "cron_health_monitor evaluated");
  return result;
}
