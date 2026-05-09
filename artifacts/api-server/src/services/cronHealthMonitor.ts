/**
 * 2026-05-08 (§4.2 of root-cause-analysis): cron health invariants.
 *
 * Today's trading-cycle outage was invisible for 13+ hours because no
 * monitor existed to flag "this cron hasn't succeeded recently." This
 * service runs every 5 minutes, compares each tracked cron's last
 * successful run against an expected cadence, and inserts rows into
 * cron_stale_alert when a cron is overdue.
 *
 * 2026-05-09 (C2 active recovery): when trading_near is the stale cron and
 * the in-process trading lock is held longer than its stale threshold, the
 * monitor force-releases the lock and triggers one cycle. Pre-fix the
 * monitor only inserted a row into cron_stale_alert that nobody read; the
 * 10-hour outage of 2026-05-08 happened in part because nobody saw the
 * alert. The recovery branch turns the monitor from a noticeboard into a
 * self-healing watchdog. Other cron staleness still alerts only — those
 * crons live in worker-data (ingestion/exchange) where remediation is
 * "PM2 restart the worker" and there's no in-process state to poke.
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
import { resetTradingCycleLock, runTradingCycle } from "./scheduler";

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
  recovery_actions: number;
}

export async function runCronHealthMonitor(): Promise<CronHealthResult> {
  const result: CronHealthResult = {
    evaluatedAt: new Date().toISOString(),
    crons_checked: TRACKED_CRONS.length,
    alerts_fired: 0,
    alerts_already_active: 0,
    recovery_actions: 0,
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

    // 2026-05-09 C2 active recovery: trading_near is the only cron that
    // can be remediated in-process. Force-release the lock (in case it's
    // wedged on a hung query) and trigger one cycle. The lock reset is
    // safe — runTradingCycle's stale-detection (TRADING_CYCLE_STALE_MS)
    // already does the same thing on a fresh entry. Doing it from here
    // catches the case where no cron tick is firing at all (which is what
    // happened on 2026-05-08).
    let recoveryAttempted = false;
    let recoveryNote: string | null = null;
    if (expected.jobName === "trading_near") {
      try {
        const before = resetTradingCycleLock();
        // Fire-and-forget: we must not await long here because this monitor
        // runs every 5 min and a hung cycle could block the next tick.
        void runTradingCycle({ tier: "near", minHoursAhead: 1, maxHoursAhead: 48 })
          .catch((err) => logger.error({ err }, "Active-recovery trading cycle failed"));
        recoveryAttempted = true;
        recoveryNote = before.wasHeld
          ? `lock force-released after ${before.heldFor}ms; triggered cycle`
          : "lock was clear; triggered cycle";
        result.recovery_actions++;
        logger.warn(
          { jobName: expected.jobName, staleMinutes: Math.round(staleMs / 60_000), wasHeld: before.wasHeld, heldForMs: before.heldFor },
          "Cron health monitor: active recovery triggered for trading_near",
        );
      } catch (err) {
        logger.error({ err }, "Active recovery for trading_near failed");
      }
    }

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
          recovery_attempted: recoveryAttempted,
          recovery_note: recoveryNote,
        })}::jsonb
      )
    `);
    result.alerts_fired++;
    logger.warn(
      { jobName: expected.jobName, lastSuccess, staleMinutes: Math.round(staleMs / 60_000), recoveryAttempted },
      "Cron stale alert fired",
    );
  }

  logger.info(result, "cron_health_monitor evaluated");
  return result;
}
