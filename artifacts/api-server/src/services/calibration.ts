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
): Promise<{ calibrated: number; bucketId: number | null }> {
  if (!Number.isFinite(rawProb)) return { calibrated: rawProb, bucketId: null };

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
    return { calibrated: rawProb, bucketId: null };
  }

  if (bucket.method !== "isotonic") {
    // Beta calibration not yet supported on the apply side — log & passthrough.
    logger.warn(
      { method: bucket.method, league, marketType, bucketId: bucket.bucketId },
      "Calibration bucket method not supported on apply path — returning raw prob",
    );
    return { calibrated: rawProb, bucketId: bucket.bucketId };
  }

  const calibrated = interpolateIsotonic(rawProb, bucket.params);
  // Defensive clamp.
  const clamped = Math.max(0, Math.min(1, calibrated));
  return { calibrated: clamped, bucketId: bucket.bucketId };
}

/** Drop the in-memory cache. Called after a fit run if explicit refresh is needed. */
export function invalidateCalibrationCache(): void {
  cache.clear();
}
