/**
 * Bundle F2.B.B (2026-05-19): Pinnacle line-movement velocity tracker.
 *
 * Cron loop computes velocity (Δimplied_pp / Δhour) over a TTK-bucketed
 * rolling window for every (match × market × selection) that has at
 * least one pending paper_bet inside an 8h kickoff horizon.
 *
 * TTK-adaptive window so the n_snapshots floor stays reachable under the
 * Bundle F2.B.A post-deploy poll cadence (where near-kickoff matches
 * snapshot every 30–60s and 4h+ matches snapshot every ~10min):
 *
 *   TTK bucket         window   n_snapshots floor
 *   < 30m              5 min    3
 *   30–60m             10 min   4
 *   1–4h               30 min   4
 *   4h+                60 min   4
 *
 * Stability rule (Bundle B.2 will consume this for early_clv_estimate):
 *   is_stable iff n_snapshots ≥ floor AND max_abs_delta_pp < 0.3pp
 *
 * Direction classifier:
 *   rising   iff velocity > +0.5 pp/hr
 *   falling  iff velocity < -0.5 pp/hr
 *   stable   otherwise
 *
 * UPSERT key (match, market, selection, window_seconds, window_end) —
 * window_end is rounded to the 2-minute cron tick so back-to-back runs
 * land on the same row instead of duplicating.
 *
 * Direction interpretation (for the lazy promoter in Bundle B.2):
 * "rising" = Pinnacle implied probability of this selection going UP =
 * Pinnacle thinks the selection more likely to win. The bet's BACK side
 * benefits when implied prob falls (we get longer odds at closing); so
 * "rising" against a back bet = walking away, and "falling" = converging.
 */

import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface BucketSpec {
  /** Applies when hoursToKickoff < maxHrs. */
  maxHrs: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Minimum snapshots in window for stability. */
  nFloor: number;
}

const BUCKETS: ReadonlyArray<BucketSpec> = [
  { maxHrs: 0.5, windowSeconds: 300,  nFloor: 3 }, // <30m
  { maxHrs: 1,   windowSeconds: 600,  nFloor: 4 }, // 30–60m
  { maxHrs: 4,   windowSeconds: 1800, nFloor: 4 }, // 1–4h
  { maxHrs: 8,   windowSeconds: 3600, nFloor: 4 }, // 4h+
];

const PINNACLE_SOURCES = ["oddspapi_pinnacle", "api_football_real:Pinnacle"];

// Velocity sign thresholds. Anything inside ±0.5 pp/hr is "stable" —
// Pinnacle does drift slowly even on cold markets; we only want to flag
// directional moves bigger than that.
const VELOCITY_RISING_PPH = 0.5;
const VELOCITY_FALLING_PPH = -0.5;

// Max horizon — beyond 8h Pinnacle moves are too slow to give a velocity
// signal that matters before kickoff. Saves cost.
const KO_HORIZON_HOURS = 8;

// Stability max_abs_delta_pp ceiling — windows with any single-step jump
// above this are "not stable" regardless of velocity.
const STABILITY_MAX_ABS_DELTA_PP = 0.3;

// Cron tick rounding — we run every 2 min. window_end aligns to the same
// 2-min boundary so the UPSERT key collides between adjacent runs.
const CRON_TICK_SECONDS = 120;

function pickBucket(hoursToKickoff: number): BucketSpec | null {
  if (!Number.isFinite(hoursToKickoff) || hoursToKickoff <= 0) return null;
  if (hoursToKickoff > KO_HORIZON_HOURS) return null;
  for (const b of BUCKETS) {
    if (hoursToKickoff < b.maxHrs) return b;
  }
  return null;
}

function roundedWindowEnd(now: Date): Date {
  const ts = Math.floor(now.getTime() / 1000 / CRON_TICK_SECONDS) * CRON_TICK_SECONDS;
  return new Date(ts * 1000);
}

interface ScopeRow {
  match_id: number;
  market_type: string;
  selection_name: string;
  kickoff_time: string;
}

interface SnapshotRow {
  back_odds: number;
  snapshot_time: string;
}

interface ComputedRow {
  matchId: number;
  marketType: string;
  selectionName: string;
  windowSeconds: number;
  windowEnd: Date;
  nSnapshots: number;
  velocityPpPerHour: number | null;
  maxAbsDeltaPp: number | null;
  lastSnapshotAgeS: number | null;
  direction: "rising" | "falling" | "stable" | null;
  isStable: boolean;
}

function classify(velocityPpPerHour: number | null): "rising" | "falling" | "stable" | null {
  if (velocityPpPerHour == null || !Number.isFinite(velocityPpPerHour)) return null;
  if (velocityPpPerHour > VELOCITY_RISING_PPH) return "rising";
  if (velocityPpPerHour < VELOCITY_FALLING_PPH) return "falling";
  return "stable";
}

function computeWindow(
  scope: ScopeRow,
  snapshots: SnapshotRow[],
  bucket: BucketSpec,
  windowEnd: Date,
): ComputedRow | null {
  const windowStartMs = windowEnd.getTime() - bucket.windowSeconds * 1000;
  // snapshots are sorted ASC by snapshot_time; filter to the window.
  const inWindow = snapshots.filter((s) => {
    const t = new Date(s.snapshot_time).getTime();
    return t >= windowStartMs && t <= windowEnd.getTime();
  });

  if (inWindow.length === 0) return null;

  const implied = inWindow.map((s) => {
    const odds = Number(s.back_odds);
    return odds > 1.01 ? (1 / odds) * 100 : null;
  }).filter((v): v is number => v != null);

  if (implied.length === 0) return null;

  // Velocity: slope from first to last in pp/hour.
  let velocityPpPerHour: number | null = null;
  if (inWindow.length >= 2 && implied.length >= 2) {
    const firstTs = new Date(inWindow[0]!.snapshot_time).getTime();
    const lastTs = new Date(inWindow[inWindow.length - 1]!.snapshot_time).getTime();
    const hoursDelta = (lastTs - firstTs) / 3_600_000;
    if (hoursDelta > 0) {
      const first = implied[0]!;
      const last = implied[implied.length - 1]!;
      velocityPpPerHour = (last - first) / hoursDelta;
    }
  }

  // Max single-step delta in pp — used for stability check.
  let maxAbsDeltaPp = 0;
  for (let i = 1; i < implied.length; i += 1) {
    const d = Math.abs(implied[i]! - implied[i - 1]!);
    if (d > maxAbsDeltaPp) maxAbsDeltaPp = d;
  }

  const lastSnapshotMs = new Date(inWindow[inWindow.length - 1]!.snapshot_time).getTime();
  const lastSnapshotAgeS = Math.max(0, Math.round((Date.now() - lastSnapshotMs) / 1000));

  const direction = classify(velocityPpPerHour);
  const isStable =
    inWindow.length >= bucket.nFloor &&
    maxAbsDeltaPp < STABILITY_MAX_ABS_DELTA_PP;

  return {
    matchId: scope.match_id,
    marketType: scope.market_type,
    selectionName: scope.selection_name,
    windowSeconds: bucket.windowSeconds,
    windowEnd,
    nSnapshots: inWindow.length,
    velocityPpPerHour,
    maxAbsDeltaPp,
    lastSnapshotAgeS,
    direction,
    isStable,
  };
}

export interface VelocityComputationResult {
  scopes_scanned: number;
  rows_written: number;
  skipped_no_snapshots: number;
  skipped_out_of_horizon: number;
  duration_ms: number;
}

export async function runPinnacleVelocityComputation(): Promise<VelocityComputationResult> {
  const startedAt = Date.now();

  // 1. Scopes to compute: any pending paper_bet with kickoff inside the
  //    8h horizon. Distinct on (match, market, selection) — multiple bets
  //    on the same selection share the same Pinnacle trajectory.
  const scopesQ = await db.execute(sql`
    SELECT DISTINCT pb.match_id, pb.market_type, pb.selection_name,
           m.kickoff_time::text AS kickoff_time
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status = 'pending'
      AND pb.deleted_at IS NULL
      AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '${sql.raw(String(KO_HORIZON_HOURS))} hours'
  `);
  const scopes = (((scopesQ as any).rows ?? []) as ScopeRow[]);

  const windowEnd = roundedWindowEnd(new Date());
  let rowsWritten = 0;
  let skippedNoSnapshots = 0;
  let skippedOutOfHorizon = 0;

  // 2. Pre-build IN-list for Pinnacle sources (Drizzle array-binding
  //    bug — see feedback_drizzle_array_binding_bug).
  const sourceList = sql.join(
    PINNACLE_SOURCES.map((s) => sql`${s}`),
    sql`, `,
  );

  for (const scope of scopes) {
    const ko = new Date(scope.kickoff_time);
    const hoursToKo = (ko.getTime() - Date.now()) / 3_600_000;
    const bucket = pickBucket(hoursToKo);
    if (!bucket) {
      skippedOutOfHorizon += 1;
      continue;
    }

    // 3. Pull Pinnacle snapshots in the window. Ordered ASC for the
    //    velocity slope; we accept the extra rows cost so the IN clause
    //    stays cheap.
    const snapsQ = await db.execute(sql`
      SELECT back_odds::float8 AS back_odds, snapshot_time::text AS snapshot_time
      FROM odds_snapshots
      WHERE match_id = ${scope.match_id}
        AND market_type = ${scope.market_type}
        AND selection_name = ${scope.selection_name}
        AND source IN (${sourceList})
        AND back_odds > 1.01
        AND snapshot_time >= ${windowEnd.toISOString()}::timestamptz - INTERVAL '1 second' * ${bucket.windowSeconds}
        AND snapshot_time <= ${windowEnd.toISOString()}::timestamptz
      ORDER BY snapshot_time ASC
    `);
    const snapshots = (((snapsQ as any).rows ?? []) as SnapshotRow[]);

    if (snapshots.length === 0) {
      skippedNoSnapshots += 1;
      continue;
    }

    const computed = computeWindow(scope, snapshots, bucket, windowEnd);
    if (!computed) {
      skippedNoSnapshots += 1;
      continue;
    }

    // 4. UPSERT — composite key matches the unique index. Adjacent cron
    //    ticks rounded to the same window_end will refresh the same row.
    await db.execute(sql`
      INSERT INTO pinnacle_line_movement
        (match_id, market_type, selection_name, window_seconds, window_end,
         n_snapshots, velocity_implied_pp_per_hour, max_abs_delta_pp,
         last_snapshot_age_s, direction, is_stable, computed_at)
      VALUES
        (${computed.matchId},
         ${computed.marketType},
         ${computed.selectionName},
         ${computed.windowSeconds},
         ${computed.windowEnd.toISOString()}::timestamptz,
         ${computed.nSnapshots},
         ${computed.velocityPpPerHour},
         ${computed.maxAbsDeltaPp},
         ${computed.lastSnapshotAgeS},
         ${computed.direction},
         ${computed.isStable},
         NOW())
      ON CONFLICT (match_id, market_type, selection_name, window_seconds, window_end) DO UPDATE SET
        n_snapshots                  = EXCLUDED.n_snapshots,
        velocity_implied_pp_per_hour = EXCLUDED.velocity_implied_pp_per_hour,
        max_abs_delta_pp             = EXCLUDED.max_abs_delta_pp,
        last_snapshot_age_s          = EXCLUDED.last_snapshot_age_s,
        direction                    = EXCLUDED.direction,
        is_stable                    = EXCLUDED.is_stable,
        computed_at                  = EXCLUDED.computed_at
    `);
    rowsWritten += 1;
  }

  const durationMs = Date.now() - startedAt;
  const result: VelocityComputationResult = {
    scopes_scanned: scopes.length,
    rows_written: rowsWritten,
    skipped_no_snapshots: skippedNoSnapshots,
    skipped_out_of_horizon: skippedOutOfHorizon,
    duration_ms: durationMs,
  };

  logger.info(result, "Pinnacle velocity computation complete");
  // Cron health row — operator can query for "is the velocity tracker
  // alive and what is it processing".
  void db.insert(complianceLogsTable).values({
    actionType: "pinnacle_velocity_compute",
    details: result as unknown as Record<string, unknown>,
    timestamp: new Date(),
  });

  return result;
}
