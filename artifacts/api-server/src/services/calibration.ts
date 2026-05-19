/**
 * Task 12 — calibration apply (hot path).
 *
 * The weekly Python fitter (scripts/python/fit_calibration.py) writes
 * IsotonicRegression breakpoints/values to calibration_buckets. This
 * module reads the active row for the requested (league, market_type)
 * and performs piecewise-linear interpolation in-process to map a raw
 * probability to a calibrated one.
 *
 * Lookup order:
 *   1. (league, market_type) — most specific
 *   2. (NULL,   market_type) — market-type global fallback
 *   3. no bucket → return the raw probability unchanged
 *
 * Cache: keyed by (league_or_null, market_type) with a 5-minute TTL so
 * a weekly refit lands on the hot path within 5 minutes without the
 * scheduler needing to invalidate explicitly.
 */

import { db, calibrationBucketsTable } from "@workspace/db";
import { and, eq, sql, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";

type IsotonicParams = {
  breakpoints: number[];
  values: number[];
};

interface CachedBucket {
  bucketId: number;
  method: string;
  params: IsotonicParams;
  fetchedAt: number;
  nSamples: number;
  // Bundle F2.B.H (2026-05-19): version-pinning + posterior. version is
  // bumped on every settled-bet update so paper_bets can record the
  // exact bucket state under which it was placed (no retroactive Kelly
  // adjustment from sibling-bet outcomes).
  version: number;
  posteriorAlpha: number;
  posteriorBeta: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedBucket | null>(); // null = no bucket found (negative cache)

// 2026-05-15 — Finding 7 / #61 Path 4. Per-league isotonic fits on thin
// samples are actively harmful (e.g. PL × MO at n=38 had ECE 0.45 — 45 pct
// expected calibration error vs the global fit's 7 pct). Below this threshold
// the per-league fit is rejected and the calibrate() flow falls through to
// the market-type-global bucket.
const PER_LEAGUE_MIN_SAMPLES = 100;

function cacheKey(league: string | null, marketType: string): string {
  return `${league ?? "__GLOBAL__"}::${marketType}`;
}

async function loadActiveBucket(
  league: string | null,
  marketType: string,
): Promise<CachedBucket | null> {
  const whereClause = league
    ? and(
        eq(calibrationBucketsTable.scopeLeague, league),
        eq(calibrationBucketsTable.marketType, marketType),
        eq(calibrationBucketsTable.active, true),
      )
    : and(
        isNull(calibrationBucketsTable.scopeLeague),
        eq(calibrationBucketsTable.marketType, marketType),
        eq(calibrationBucketsTable.active, true),
      );
  const rows = await db
    .select({
      bucketId: calibrationBucketsTable.bucketId,
      method: calibrationBucketsTable.method,
      params: calibrationBucketsTable.params,
      nSamples: calibrationBucketsTable.nSamples,
      version: calibrationBucketsTable.version,
      posteriorAlpha: calibrationBucketsTable.posteriorAlpha,
      posteriorBeta: calibrationBucketsTable.posteriorBeta,
    })
    .from(calibrationBucketsTable)
    .where(whereClause)
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    bucketId: row.bucketId,
    method: row.method,
    params: row.params as IsotonicParams,
    fetchedAt: Date.now(),
    nSamples: row.nSamples,
    version: row.version,
    posteriorAlpha: Number(row.posteriorAlpha),
    posteriorBeta: Number(row.posteriorBeta),
  };
}

async function getBucket(
  league: string | null,
  marketType: string,
): Promise<CachedBucket | null> {
  const key = cacheKey(league, marketType);
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - (cached?.fetchedAt ?? 0) < CACHE_TTL_MS) {
    return cached;
  }
  const fresh = await loadActiveBucket(league, marketType);
  cache.set(key, fresh);
  return fresh;
}

/**
 * Piecewise-linear interpolation against sorted breakpoints. Mirrors
 * sklearn IsotonicRegression `predict()` with `out_of_bounds='clip'`.
 *
 * Returns NaN only if the params arrays are empty / malformed; otherwise
 * always returns a probability in [0, 1] (caller can rely on this).
 */
export function interpolateIsotonic(p: number, params: IsotonicParams): number {
  const xs = params.breakpoints;
  const ys = params.values;
  if (!xs.length || xs.length !== ys.length) return p;
  if (p <= xs[0]) return ys[0];
  if (p >= xs[xs.length - 1]) return ys[ys.length - 1];
  // Binary search for the segment containing p.
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= p) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo];
  const x1 = xs[hi];
  const y0 = ys[lo];
  const y1 = ys[hi];
  if (x1 === x0) return y0;
  return y0 + ((p - x0) * (y1 - y0)) / (x1 - x0);
}

/**
 * Apply calibration to a raw model probability for the given scope.
 *
 * Returns:
 *   { calibrated, bucketId } when a bucket was found and applied
 *   { calibrated: rawProb, bucketId: null } when no bucket exists
 *
 * Never throws. Lookup failures cache as negatives for CACHE_TTL_MS so
 * we don't hammer the DB looking for missing buckets.
 */
export async function calibrate(
  rawProb: number,
  league: string | null | undefined,
  marketType: string,
): Promise<{
  calibrated: number;
  bucketId: number | null;
  // Bundle F2.B.H (2026-05-19): version of the bucket used. Callers persist
  // this on paper_bets.calibration_bucket_version_at_placement so the
  // settlement path can resolve "what was the bucket state when this bet
  // was placed" without needing the bucket's full state history.
  bucketVersion: number | null;
}> {
  if (!Number.isFinite(rawProb)) return { calibrated: rawProb, bucketId: null, bucketVersion: null };

  // 1. Try (league, marketType).
  let bucket: CachedBucket | null = null;
  if (league) {
    bucket = await getBucket(league, marketType);
    // 2026-05-15 — Finding 7 / #61 Path 4. Reject per-league fits on thin
    // samples — they're worse than the market-type-global fit at n<100
    // (observed PL × MO ECE 0.45 vs global MO ECE 0.07).
    if (bucket && bucket.nSamples < PER_LEAGUE_MIN_SAMPLES) {
      logger.info(
        { league, marketType, nSamples: bucket.nSamples, threshold: PER_LEAGUE_MIN_SAMPLES, bucketId: bucket.bucketId },
        "Calibration: rejecting thin per-league isotonic — falling back to market-type-global",
      );
      bucket = null;
    }
  }
  // 2. Fall back to market-type global.
  if (!bucket) {
    bucket = await getBucket(null, marketType);
  }
  if (!bucket) {
    return { calibrated: rawProb, bucketId: null, bucketVersion: null };
  }

  if (bucket.method !== "isotonic") {
    // Beta calibration not yet supported on the apply side — log & passthrough.
    logger.warn(
      { method: bucket.method, league, marketType, bucketId: bucket.bucketId },
      "Calibration bucket method not supported on apply path — returning raw prob",
    );
    return { calibrated: rawProb, bucketId: bucket.bucketId, bucketVersion: bucket.version };
  }

  const calibrated = interpolateIsotonic(rawProb, bucket.params);
  // Defensive clamp.
  const clamped = Math.max(0, Math.min(1, calibrated));
  return { calibrated: clamped, bucketId: bucket.bucketId, bucketVersion: bucket.version };
}

// ── Bundle F2.B.H (2026-05-19): Beta-Binomial posterior updater ─────────
//
// Called from settlement paths after a batch of bets resolves. Walks
// the batch, increments posterior_alpha (wins) / posterior_beta (losses)
// per bucket, bumps version, invalidates cache.
//
// Version-pin contract: pending bets keep their placement-time version
// in paper_bets.calibration_bucket_version_at_placement — this update
// only affects FUTURE placement decisions. No retroactive change to
// pending Kelly fractions.
//
// Two-step batch query so a single settlement run that touches many
// buckets doesn't serialise N UPDATE round-trips.
export interface CalibrationUpdateResult {
  buckets_updated: number;
  wins_applied: number;
  losses_applied: number;
}

export async function updateBucketFromSettledBet(
  betIds: ReadonlyArray<number>,
): Promise<CalibrationUpdateResult> {
  if (betIds.length === 0) {
    return { buckets_updated: 0, wins_applied: 0, losses_applied: 0 };
  }
  // 1. Group settled outcomes by bucket. The bet's calibration_bucket_id
  //    is stamped at placement time (paperTrading.ts), so it's the right
  //    bucket to credit regardless of whether the active bucket has
  //    changed since.
  const rows = (await db.execute(sql`
    SELECT calibration_bucket_id AS bucket_id, status, MAX(id) AS last_bet_id
    FROM paper_bets
    WHERE id IN (${sql.join(betIds.map((id) => sql`${id}`), sql`, `)})
      AND calibration_bucket_id IS NOT NULL
      AND status IN ('won', 'lost')
    GROUP BY calibration_bucket_id, status
  `)) as unknown as {
    rows?: Array<{ bucket_id: number; status: string; last_bet_id: number }>;
  };
  const list = rows.rows ?? [];
  if (list.length === 0) {
    return { buckets_updated: 0, wins_applied: 0, losses_applied: 0 };
  }

  // 2. Bucket deltas — aggregate wins + losses per bucket_id.
  const perBucket = new Map<number, { wins: number; losses: number; lastBetId: number }>();
  for (const r of list) {
    const cur = perBucket.get(r.bucket_id) ?? { wins: 0, losses: 0, lastBetId: 0 };
    if (r.status === "won") cur.wins += 1; // each (bucket_id, status) row already groups; relying on COUNT below
    else if (r.status === "lost") cur.losses += 1;
    if (r.last_bet_id > cur.lastBetId) cur.lastBetId = r.last_bet_id;
    perBucket.set(r.bucket_id, cur);
  }
  // NOTE: the GROUP BY above gives ONE row per (bucket, status) but each
  // row's "+1" is a single row of the group, not its count. Re-do with a
  // COUNT to get correct deltas.
  const countsQ = (await db.execute(sql`
    SELECT calibration_bucket_id AS bucket_id, status, COUNT(*)::int AS n, MAX(id) AS last_bet_id
    FROM paper_bets
    WHERE id IN (${sql.join(betIds.map((id) => sql`${id}`), sql`, `)})
      AND calibration_bucket_id IS NOT NULL
      AND status IN ('won', 'lost')
    GROUP BY calibration_bucket_id, status
  `)) as unknown as {
    rows?: Array<{ bucket_id: number; status: string; n: number; last_bet_id: number }>;
  };
  perBucket.clear();
  for (const r of countsQ.rows ?? []) {
    const cur = perBucket.get(r.bucket_id) ?? { wins: 0, losses: 0, lastBetId: 0 };
    if (r.status === "won") cur.wins += r.n;
    else if (r.status === "lost") cur.losses += r.n;
    if (r.last_bet_id > cur.lastBetId) cur.lastBetId = r.last_bet_id;
    perBucket.set(r.bucket_id, cur);
  }

  // 3. Update each bucket in one UPDATE round-trip per bucket. Bump
  //    version + last_settled_bet_id; alpha += wins, beta += losses.
  let winsApplied = 0;
  let lossesApplied = 0;
  for (const [bucketId, delta] of perBucket) {
    if (delta.wins === 0 && delta.losses === 0) continue;
    await db.execute(sql`
      UPDATE calibration_buckets
         SET posterior_alpha     = posterior_alpha + ${delta.wins},
             posterior_beta      = posterior_beta + ${delta.losses},
             version             = version + 1,
             last_settled_bet_id = GREATEST(COALESCE(last_settled_bet_id, 0), ${delta.lastBetId}),
             last_updated_at     = NOW()
       WHERE bucket_id = ${bucketId}
    `);
    winsApplied += delta.wins;
    lossesApplied += delta.losses;
  }

  // 4. Invalidate cache so the next calibrate() call sees the new version
  //    + posterior. Negligible cost — buckets reload on demand.
  invalidateCalibrationCache();

  return {
    buckets_updated: perBucket.size,
    wins_applied: winsApplied,
    losses_applied: lossesApplied,
  };
}

/** Drop the in-memory cache. Called after a fit run if explicit refresh is needed. */
export function invalidateCalibrationCache(): void {
  cache.clear();
}
