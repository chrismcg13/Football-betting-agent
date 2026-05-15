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

// ──────────────────────────────────────────────────────────────────────────────
// 2026-05-15 — structural audits.
//
// Four permanent periodic checks for "assumed-working" surfaces that nothing
// else audits. Per CLAUDE.md Principle #6: every metric the system relies on
// must have an automated audit; absence of audit = assumed-untrusted.
//
// Each audit writes data_quality_alerts rows on threshold breach. Idempotent
// per (audit_id, day) — one alert per audit per day window.
//
// Audits:
//   structural_clv_anchor_binding — for each (market_type), what fraction of
//     settled live bets in the last 24h with closing_pinnacle_odds populated
//     have a matching oddspapi_pinnacle / api_football_real:Pinnacle snapshot
//     for (match_id, market_type, selection_name) within (-4h, +1h) of kickoff.
//     Alert when fraction < 0.30 (Tier-1 anchor missing for the cohort).
//
//   structural_betfair_partial_match — for each settled live bet in last 24h,
//     was betfair_size_matched within 95 pct of stake? Alert when partial-match
//     rate > 15 pct cohort-wide — indicates liquidity or slippage issues
//     producing under-stake fills that distort realised ROI.
//
//   structural_match_results_completeness — matches with kickoff > 6h ago that
//     still have NULL final score AND betfair_event_id IS NOT NULL. Alert if
//     count > 25. Settlement timeout precondition.
//
//   structural_closing_odds_timing — for settled bets in last 24h with
//     closing_pinnacle_odds populated, the nearest matching oddspapi_pinnacle
//     snapshot time vs kickoff_time. Alert if median |snap-kickoff| > 30 min
//     for any market_type — strict pre-kickoff snap is the intended semantics.
// ──────────────────────────────────────────────────────────────────────────────

export interface StructuralAuditResult {
  evaluatedAt: string;
  audits: Array<{
    audit_id: string;
    market_type?: string;
    observed_value: number;
    threshold: number;
    threshold_direction: "max" | "min";
    breach: boolean;
    detail: Record<string, unknown>;
  }>;
  alertsFired: number;
}

async function writeStructuralAlert(args: {
  audit_id: string;
  market_type?: string;
  observed: number;
  threshold: number;
  direction: "max" | "min";
  severity: "warn" | "critical";
  detail: Record<string, unknown>;
}): Promise<boolean> {
  // Dedupe: one unack alert per (audit_id, market_type) per 24h.
  const sourceTag = args.market_type ? `${args.audit_id}:${args.market_type}` : args.audit_id;
  const existing = await db.execute(sql`
    SELECT 1 FROM data_quality_alerts
    WHERE source = ${sourceTag}
      AND metric = ${args.audit_id}
      AND detected_at > NOW() - INTERVAL '24 hours'
      AND acknowledged_at IS NULL
    LIMIT 1
  `);
  if ((((existing as any).rows ?? []) as unknown[]).length > 0) return false;

  await db.execute(sql`
    INSERT INTO data_quality_alerts (
      source, metric, observed_value, baseline_value,
      baseline_window_start, baseline_window_end,
      ratio, threshold_ratio, severity, manifest
    ) VALUES (
      ${sourceTag}, ${args.audit_id},
      ${args.observed}, ${args.threshold},
      (NOW() - INTERVAL '24 hours')::date, NOW()::date,
      ${args.observed}, ${args.threshold}, ${args.severity},
      ${JSON.stringify({
        audit_id: args.audit_id,
        market_type: args.market_type ?? null,
        direction: args.direction,
        observed: args.observed,
        threshold: args.threshold,
        detail: args.detail,
      })}::jsonb
    )
  `);
  return true;
}

export async function runStructuralAudits(): Promise<StructuralAuditResult> {
  const result: StructuralAuditResult = {
    evaluatedAt: new Date().toISOString(),
    audits: [],
    alertsFired: 0,
  };

  // ── Audit 1 — CLV anchor binding ──────────────────────────────────────────
  // For each market_type, fraction of settled live bets in last 24h with
  // closing_pinnacle_odds populated that have a matching Pinnacle snapshot
  // near kickoff. Below 0.30 = anchor binding suspect for that cohort.
  try {
    const rows = await db.execute(sql`
      WITH bets AS (
        SELECT pb.id, pb.match_id, pb.market_type, pb.selection_name,
               pb.closing_pinnacle_odds::numeric AS recorded,
               m.kickoff_time
        FROM paper_bets pb
        JOIN matches m ON pb.match_id = m.id
        WHERE pb.bet_track = 'live'
          AND pb.legacy_regime = false AND pb.deleted_at IS NULL
          AND pb.status IN ('won','lost','void')
          AND pb.settled_at >= NOW() - INTERVAL '24 hours'
          AND pb.closing_pinnacle_odds IS NOT NULL
      ),
      matched AS (
        SELECT
          b.market_type,
          b.id,
          EXISTS (
            SELECT 1 FROM odds_snapshots os
            WHERE os.match_id = b.match_id
              AND os.market_type = b.market_type
              AND os.selection_name = b.selection_name
              AND os.source IN ('oddspapi_pinnacle','api_football_real:Pinnacle')
              AND os.snapshot_time BETWEEN b.kickoff_time - INTERVAL '4 hours' AND b.kickoff_time + INTERVAL '1 hour'
          ) AS has_match
        FROM bets b
      )
      SELECT market_type,
             COUNT(*) AS n_bets,
             COUNT(*) FILTER (WHERE has_match) AS n_matched,
             ROUND(COUNT(*) FILTER (WHERE has_match)::numeric / NULLIF(COUNT(*), 0), 3) AS match_rate
      FROM matched
      GROUP BY market_type
      HAVING COUNT(*) >= 10
    `);
    for (const r of ((rows as any).rows ?? []) as Array<{
      market_type: string; n_bets: number | string;
      n_matched: number | string; match_rate: number | string;
    }>) {
      const rate = Number(r.match_rate ?? 0);
      const breach = rate < 0.30;
      result.audits.push({
        audit_id: "structural_clv_anchor_binding",
        market_type: r.market_type,
        observed_value: rate,
        threshold: 0.30,
        threshold_direction: "min",
        breach,
        detail: { n_bets: Number(r.n_bets), n_matched: Number(r.n_matched) },
      });
      if (breach) {
        const fired = await writeStructuralAlert({
          audit_id: "structural_clv_anchor_binding",
          market_type: r.market_type,
          observed: rate,
          threshold: 0.30,
          direction: "min",
          severity: rate < 0.15 ? "critical" : "warn",
          detail: { n_bets: Number(r.n_bets), n_matched: Number(r.n_matched), interpretation: "Pinnacle snapshot anchor missing for >70% of bets in cohort" },
        });
        if (fired) result.alertsFired += 1;
      }
    }
  } catch (err) {
    logger.error({ err }, "structural_clv_anchor_binding audit failed");
  }

  // ── Audit 2 — Betfair partial-match rate ──────────────────────────────────
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS n_bets,
        COUNT(*) FILTER (
          WHERE betfair_size_matched IS NULL
             OR betfair_size_matched::numeric < (stake::numeric * 0.95)
        ) AS n_partial,
        ROUND(
          COUNT(*) FILTER (
            WHERE betfair_size_matched IS NULL
               OR betfair_size_matched::numeric < (stake::numeric * 0.95)
          )::numeric / NULLIF(COUNT(*), 0), 3
        ) AS partial_rate
      FROM paper_bets
      WHERE bet_track = 'live'
        AND legacy_regime = false AND deleted_at IS NULL
        AND status IN ('won','lost','void')
        AND settled_at >= NOW() - INTERVAL '24 hours'
        AND stake::numeric > 0
    `);
    const r = ((rows as any).rows ?? [])[0] as { n_bets: number | string; n_partial: number | string; partial_rate: number | string } | undefined;
    if (r && Number(r.n_bets) >= 10) {
      const rate = Number(r.partial_rate ?? 0);
      const breach = rate > 0.15;
      result.audits.push({
        audit_id: "structural_betfair_partial_match",
        observed_value: rate,
        threshold: 0.15,
        threshold_direction: "max",
        breach,
        detail: { n_bets: Number(r.n_bets), n_partial: Number(r.n_partial) },
      });
      if (breach) {
        const fired = await writeStructuralAlert({
          audit_id: "structural_betfair_partial_match",
          observed: rate,
          threshold: 0.15,
          direction: "max",
          severity: rate > 0.30 ? "critical" : "warn",
          detail: { n_bets: Number(r.n_bets), n_partial: Number(r.n_partial), interpretation: "Liquidity / slippage producing under-stake fills — realised ROI distorted by partial matches" },
        });
        if (fired) result.alertsFired += 1;
      }
    }
  } catch (err) {
    logger.error({ err }, "structural_betfair_partial_match audit failed");
  }

  // ── Audit 3 — Match-results ingestion completeness ────────────────────────
  try {
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS n_stale
      FROM matches
      WHERE kickoff_time < NOW() - INTERVAL '6 hours'
        AND kickoff_time > NOW() - INTERVAL '7 days'
        AND betfair_event_id IS NOT NULL
        AND home_score IS NULL
        AND status NOT IN ('cancelled','postponed','abandoned')
    `);
    const n = Number(((rows as any).rows ?? [])[0]?.n_stale ?? 0);
    const breach = n > 25;
    result.audits.push({
      audit_id: "structural_match_results_completeness",
      observed_value: n,
      threshold: 25,
      threshold_direction: "max",
      breach,
      detail: { n_stale: n, window: "kickoff_time < NOW() - 6h, > NOW() - 7d, score NULL, not cancelled/postponed" },
    });
    if (breach) {
      const fired = await writeStructuralAlert({
        audit_id: "structural_match_results_completeness",
        observed: n,
        threshold: 25,
        direction: "max",
        severity: n > 75 ? "critical" : "warn",
        detail: { n_stale: n, interpretation: "Match results ingestion lagging — settlement timeout precondition. Bets on these matches will route through 72h-timeout path and may force-settle as losses." },
      });
      if (fired) result.alertsFired += 1;
    }
  } catch (err) {
    logger.error({ err }, "structural_match_results_completeness audit failed");
  }

  // ── Audit 4 — closing_pinnacle_odds write timing ──────────────────────────
  // For settled bets with closing_pinnacle_odds, find the nearest matching
  // oddspapi_pinnacle snapshot for (match, market, selection) and compare
  // its time to kickoff_time. Strict pre-kickoff = small absolute delta.
  try {
    const rows = await db.execute(sql`
      WITH bets AS (
        SELECT pb.id, pb.match_id, pb.market_type, pb.selection_name,
               pb.closing_pinnacle_odds::numeric AS recorded,
               m.kickoff_time
        FROM paper_bets pb
        JOIN matches m ON pb.match_id = m.id
        WHERE pb.bet_track = 'live'
          AND pb.legacy_regime = false AND pb.deleted_at IS NULL
          AND pb.status IN ('won','lost','void')
          AND pb.settled_at >= NOW() - INTERVAL '24 hours'
          AND pb.closing_pinnacle_odds IS NOT NULL
      ),
      nearest AS (
        SELECT
          b.market_type,
          b.id,
          MIN(ABS(EXTRACT(EPOCH FROM (os.snapshot_time - b.kickoff_time)))) AS delta_secs
        FROM bets b
        LEFT JOIN odds_snapshots os
          ON os.match_id = b.match_id
         AND os.market_type = b.market_type
         AND os.selection_name = b.selection_name
         AND os.source IN ('oddspapi_pinnacle','api_football_real:Pinnacle')
         AND os.snapshot_time BETWEEN b.kickoff_time - INTERVAL '6 hours' AND b.kickoff_time + INTERVAL '2 hours'
        GROUP BY b.market_type, b.id
      )
      SELECT
        market_type,
        COUNT(*) AS n,
        ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY delta_secs)::numeric, 0) AS median_delta_secs
      FROM nearest
      WHERE delta_secs IS NOT NULL
      GROUP BY market_type
      HAVING COUNT(*) >= 10
    `);
    for (const r of ((rows as any).rows ?? []) as Array<{
      market_type: string; n: number | string; median_delta_secs: number | string | null;
    }>) {
      const median = Number(r.median_delta_secs ?? 0);
      const breach = median > 1800; // 30 min
      result.audits.push({
        audit_id: "structural_closing_odds_timing",
        market_type: r.market_type,
        observed_value: median,
        threshold: 1800,
        threshold_direction: "max",
        breach,
        detail: { n: Number(r.n), median_delta_secs: median, median_delta_minutes: Math.round(median / 60) },
      });
      if (breach) {
        const fired = await writeStructuralAlert({
          audit_id: "structural_closing_odds_timing",
          market_type: r.market_type,
          observed: median,
          threshold: 1800,
          direction: "max",
          severity: median > 7200 ? "critical" : "warn",
          detail: { n: Number(r.n), median_delta_minutes: Math.round(median / 60), interpretation: "Pinnacle close snapshot taken >30 min from kickoff — CLV anchor may include in-play movement or stale pre-match price" },
        });
        if (fired) result.alertsFired += 1;
      }
    }
  } catch (err) {
    logger.error({ err }, "structural_closing_odds_timing audit failed");
  }

  logger.info(result, "structural_audits evaluated");
  return result;
}
