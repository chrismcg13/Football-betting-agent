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

import { db } from "@workspace/db";
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
