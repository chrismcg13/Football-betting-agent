/**
 * 2026-05-08 (post-RCA): generalised data-quality monitor.
 *
 * Daily 02:00 UTC cron. For each registered external data source, computes
 * a 24-hour observed metric vs a 30-day rolling baseline (excluding the
 * last 5 days so a pre-existing regression doesn't poison the baseline).
 * If observed/baseline drops below the per-source threshold, inserts a
 * data_quality_alerts row.
 *
 * Genesis: oddspapi_pinnacle ingestion regression on 2026-05-03 ran
 * silently for 5 days. The fix-cycle (Phase 2.A prefetch refocus → paper
 * rail evaporates) was only caught via a placement-side investigation.
 * Want to never have a 5-day blind spot again.
 *
 * Operator query:
 *   SELECT * FROM data_quality_alerts WHERE acknowledged_at IS NULL
 *   ORDER BY detected_at DESC;
 *
 * Acknowledgement (after investigation):
 *   UPDATE data_quality_alerts SET acknowledged_at=NOW(), acknowledged_note='...'
 *   WHERE id = <id>;
 */

import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface TrackedSource {
  source: string;             // identifier (matches odds_snapshots.source where applicable)
  metric: "distinct_matches_24h" | "rows_24h" | "api_calls_24h";
  threshold_ratio: number;    // alert if observed/baseline < this
  query_24h: string;          // SQL returning a single numeric column 'observed'
  query_baseline: string;     // SQL returning a single numeric column 'baseline'
}

const TRACKED_SOURCES: TrackedSource[] = [
  {
    source: "oddspapi_pinnacle",
    metric: "distinct_matches_24h",
    threshold_ratio: 0.5,
    query_24h: `
      SELECT COUNT(DISTINCT match_id)::numeric AS observed
      FROM odds_snapshots
      WHERE source = 'oddspapi_pinnacle' AND snapshot_time > NOW() - INTERVAL '24 hours'
    `,
    query_baseline: `
      SELECT (
        SELECT COUNT(DISTINCT match_id)::numeric
        FROM odds_snapshots
        WHERE source = 'oddspapi_pinnacle'
          AND snapshot_time BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '5 days'
      ) / 30.0 AS baseline
    `,
  },
  {
    source: "api_football_real:Pinnacle",
    metric: "distinct_matches_24h",
    threshold_ratio: 0.5,
    query_24h: `
      SELECT COUNT(DISTINCT match_id)::numeric AS observed
      FROM odds_snapshots
      WHERE source = 'api_football_real:Pinnacle' AND snapshot_time > NOW() - INTERVAL '24 hours'
    `,
    query_baseline: `
      SELECT (
        SELECT COUNT(DISTINCT match_id)::numeric
        FROM odds_snapshots
        WHERE source = 'api_football_real:Pinnacle'
          AND snapshot_time BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '5 days'
      ) / 30.0 AS baseline
    `,
  },
  {
    source: "betfair_exchange",
    metric: "rows_24h",
    threshold_ratio: 0.5,
    query_24h: `
      SELECT COUNT(*)::numeric AS observed
      FROM odds_snapshots
      WHERE source = 'betfair_exchange' AND snapshot_time > NOW() - INTERVAL '24 hours'
    `,
    query_baseline: `
      SELECT (
        SELECT COUNT(*)::numeric
        FROM odds_snapshots
        WHERE source = 'betfair_exchange'
          AND snapshot_time BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '5 days'
      ) / 30.0 AS baseline
    `,
  },
  {
    source: "matches_ingestion",
    metric: "rows_24h",
    threshold_ratio: 0.3,
    query_24h: `
      SELECT COUNT(*)::numeric AS observed
      FROM matches WHERE created_at > NOW() - INTERVAL '24 hours'
    `,
    query_baseline: `
      SELECT (
        SELECT COUNT(*)::numeric FROM matches
        WHERE created_at BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '5 days'
      ) / 30.0 AS baseline
    `,
  },
  {
    source: "settlement_pipeline",
    metric: "rows_24h",
    threshold_ratio: 0.3,
    query_24h: `
      SELECT COUNT(*)::numeric AS observed
      FROM paper_bets
      WHERE settled_at > NOW() - INTERVAL '24 hours'
        AND legacy_regime=false AND deleted_at IS NULL
    `,
    query_baseline: `
      SELECT (
        SELECT COUNT(*)::numeric FROM paper_bets
        WHERE settled_at BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '5 days'
          AND legacy_regime=false AND deleted_at IS NULL
      ) / 30.0 AS baseline
    `,
  },
];

export interface DataQualityResult {
  evaluatedAt: string;
  sourcesChecked: number;
  alertsFired: number;
  alertsAlreadyActive: number;
  details: Array<{
    source: string;
    metric: string;
    observed: number;
    baseline: number;
    ratio: number;
    alertFired: boolean;
  }>;
}

export async function runDataQualityMonitor(): Promise<DataQualityResult> {
  const result: DataQualityResult = {
    evaluatedAt: new Date().toISOString(),
    sourcesChecked: TRACKED_SOURCES.length,
    alertsFired: 0,
    alertsAlreadyActive: 0,
    details: [],
  };

  for (const tracked of TRACKED_SOURCES) {
    try {
      const observedRows = await db.execute(sql.raw(tracked.query_24h));
      const observed = Number((((observedRows as any).rows ?? []) as Array<{ observed: number | string }>)[0]?.observed ?? 0);

      const baselineRows = await db.execute(sql.raw(tracked.query_baseline));
      const baseline = Number((((baselineRows as any).rows ?? []) as Array<{ baseline: number | string | null }>)[0]?.baseline ?? 0);

      // If baseline is too small to be meaningful, skip alerting (new source
      // or insufficient history). Log for diagnostic.
      if (baseline < 10) {
        result.details.push({
          source: tracked.source, metric: tracked.metric,
          observed, baseline, ratio: 0, alertFired: false,
        });
        continue;
      }

      const ratio = observed / baseline;
      const alertNeeded = ratio < tracked.threshold_ratio;

      if (!alertNeeded) {
        result.details.push({
          source: tracked.source, metric: tracked.metric,
          observed, baseline, ratio, alertFired: false,
        });
        continue;
      }

      // Dedupe: only one unack alert per (source, metric) per 24h
      const existing = await db.execute(sql`
        SELECT 1 FROM data_quality_alerts
        WHERE source = ${tracked.source}
          AND metric = ${tracked.metric}
          AND detected_at > NOW() - INTERVAL '24 hours'
          AND acknowledged_at IS NULL
        LIMIT 1
      `);
      if ((((existing as any).rows ?? []) as unknown[]).length > 0) {
        result.alertsAlreadyActive++;
        result.details.push({
          source: tracked.source, metric: tracked.metric,
          observed, baseline, ratio, alertFired: false,
        });
        continue;
      }

      const severity: "warn" | "critical" = ratio < 0.25 ? "critical" : "warn";

      await db.execute(sql`
        INSERT INTO data_quality_alerts (
          source, metric, observed_value, baseline_value,
          baseline_window_start, baseline_window_end,
          ratio, threshold_ratio, severity, manifest
        ) VALUES (
          ${tracked.source}, ${tracked.metric},
          ${observed}, ${baseline},
          (NOW() - INTERVAL '35 days')::date, (NOW() - INTERVAL '5 days')::date,
          ${ratio}, ${tracked.threshold_ratio}, ${severity},
          ${JSON.stringify({
            message: `${tracked.source} ${tracked.metric} observed ${observed.toFixed(0)} vs baseline ${baseline.toFixed(0)} — ratio ${ratio.toFixed(2)} below threshold ${tracked.threshold_ratio}`,
          })}::jsonb
        )
      `);

      result.alertsFired++;
      result.details.push({
        source: tracked.source, metric: tracked.metric,
        observed, baseline, ratio, alertFired: true,
      });

      logger.warn(
        { source: tracked.source, metric: tracked.metric, observed, baseline, ratio, severity },
        "Data quality alert fired",
      );
    } catch (err) {
      logger.error({ err, source: tracked.source }, "Data quality check failed");
    }
  }

  logger.info(result, "data_quality_monitor evaluated");
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// 2026-05-09 (Bundle 6): unban-gate auto-detector.
//
// Plan v3 §3D Bundle 2 deferred OU_25/OU_35/FIRST_HALF_RESULT unban behind a
// metric: oddspapi_pinnacle distinct_matches/24h ≥ 200 sustained 3 consecutive
// days. The 2026-04-20 quarantine of those markets cited a "pricing-pipeline
// fix" — the actual fix was the Phase 2.A prefetch regression remediation
// (Option A KO_BUCKETS rebalance shipped 2026-05-08; Option D allowlist
// shipped 2026-05-09 earlier today). When prefetch coverage normalises, the
// quarantine reason is gone.
//
// This monitor doesn't ship the unban itself (operator-gated by design — see
// "money guardrails" durable policy). It writes a compliance_logs row when
// the gate clears so the operator knows to ship the one-line BANNED_MARKETS
// edit. Idempotent: only one row per (gate_id) within a 7-day window.
//
// Daily cron in scheduler.ts:0 2 * * * runs alongside runDataQualityMonitor().
//
// Operator query to find pending unban actions:
//   SELECT details FROM compliance_logs
//   WHERE action_type = 'gate_metric_cleared' AND timestamp > NOW() - INTERVAL '7 days';
// ──────────────────────────────────────────────────────────────────────────────

interface GateMetricCheck {
  gate_id: string;                 // unique stable id for this gate
  description: string;             // human-readable
  metric_query: string;            // SQL returning rows of (day::date, value::numeric) for last N days
  required_days: number;           // consecutive days required
  required_value: number;          // value threshold per day
  ship_action: string;             // human-readable next-step instruction
}

const GATE_METRIC_CHECKS: GateMetricCheck[] = [
  {
    gate_id: "ou_quarantine_unban_gate",
    description: "OU_25 / OU_35 / FIRST_HALF_RESULT unban gate (Plan v3 Bundle 2 ride-along)",
    metric_query: `
      -- Last 3 complete UTC days only. Excludes today (partial day) and
      -- cuts off at exactly 3 days ago so we always count whole-day buckets.
      SELECT day::date AS day, distinct_matches::numeric AS value
      FROM (
        SELECT date_trunc('day', snapshot_time)::date AS day,
               COUNT(DISTINCT match_id) AS distinct_matches
        FROM odds_snapshots
        WHERE source = 'oddspapi_pinnacle'
          AND snapshot_time >= date_trunc('day', NOW() - INTERVAL '3 days')
          AND snapshot_time < date_trunc('day', NOW())
        GROUP BY 1
      ) d
      ORDER BY day DESC
      LIMIT 3
    `,
    required_days: 3,
    required_value: 200,
    ship_action:
      "Remove OVER_UNDER_25, OVER_UNDER_35, FIRST_HALF_RESULT from BANNED_MARKETS in paperTrading.ts:554-573",
  },
];

export interface UnbanGateResult {
  evaluatedAt: string;
  gatesChecked: number;
  gatesCleared: number;
  details: Array<{
    gate_id: string;
    days_meeting_threshold: number;
    required_days: number;
    daily_values: Array<{ day: string; value: number }>;
    cleared: boolean;
    notification_emitted: boolean;
  }>;
}

export async function runUnbanGateMonitor(): Promise<UnbanGateResult> {
  const result: UnbanGateResult = {
    evaluatedAt: new Date().toISOString(),
    gatesChecked: GATE_METRIC_CHECKS.length,
    gatesCleared: 0,
    details: [],
  };

  for (const check of GATE_METRIC_CHECKS) {
    try {
      const rows = await db.execute(sql.raw(check.metric_query));
      const daily = (((rows as any).rows ?? []) as Array<{ day: string; value: number | string }>)
        .map((r) => ({ day: String(r.day), value: Number(r.value) }));
      const meeting = daily.filter((d) => d.value >= check.required_value);
      const cleared = daily.length >= check.required_days && meeting.length >= check.required_days;

      // Idempotency: don't re-emit if a notification was emitted in the last 7 days
      let notificationEmitted = false;
      if (cleared) {
        const recent = await db.execute(sql`
          SELECT 1 FROM compliance_logs
          WHERE action_type = 'gate_metric_cleared'
            AND details->>'gate_id' = ${check.gate_id}
            AND timestamp > NOW() - INTERVAL '7 days'
          LIMIT 1
        `);
        const alreadyNotified = (((recent as any).rows ?? []) as unknown[]).length > 0;

        if (!alreadyNotified) {
          await db.insert(complianceLogsTable).values({
            actionType: "gate_metric_cleared",
            details: {
              gate_id: check.gate_id,
              description: check.description,
              required_days: check.required_days,
              required_value: check.required_value,
              daily_values: daily,
              ship_action: check.ship_action,
            },
            timestamp: new Date(),
          });
          notificationEmitted = true;
          logger.warn(
            { gate_id: check.gate_id, daily, ship_action: check.ship_action },
            "Gate metric cleared — operator action required",
          );
        }
        result.gatesCleared++;
      }

      result.details.push({
        gate_id: check.gate_id,
        days_meeting_threshold: meeting.length,
        required_days: check.required_days,
        daily_values: daily,
        cleared,
        notification_emitted: notificationEmitted,
      });
    } catch (err) {
      logger.error({ err, gate_id: check.gate_id }, "Unban gate check failed");
    }
  }

  logger.info(result, "unban_gate_monitor evaluated");
  return result;
}
