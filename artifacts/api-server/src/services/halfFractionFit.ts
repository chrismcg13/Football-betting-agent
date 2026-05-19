/**
 * Bundle F2.B.F (2026-05-19): per-league half-time goal-fraction fit.
 *
 * Empirical posterior of (ht_goals / ft_goals) per league, used by
 * predictHalfTimeMatchOdds + predictSecondHalfMatchOdds to split
 * xGoals between halves more accurately than the hardcoded 0.45.
 *
 * Bayesian shrinkage toward global 0.45 with prior strength k=100:
 *   posterior = (k_prior × 0.45 + n × mle) / (k_prior + n)
 * Global prior dominates until ~100 matches; per-league signal takes
 * over above that. Rolling 12-month window for the MLE.
 *
 * Season carry-forward (prior = season-N-1 posterior, shrunk by time
 * since season ended) deferred — matches table has no season_id column.
 *
 * Refit via POST /api/admin/fit-half-fractions. No automatic cron in
 * v1 — operator-driven so we can observe shifts post-fit. Add cron
 * once a stable cadence emerges.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const GLOBAL_HT_FRACTION = 0.45;
const PRIOR_STRENGTH_K = 100;
const ROLLING_MONTHS = 12;
const MIN_MATCHES_PER_LEAGUE = 30;

// In-process cache for predictor reads. 5-min TTL — matches the
// calibration_buckets cache pattern. Refit invalidates by setting
// cachedAt to 0 so the next read reloads.
let cache: { rows: Map<string, number>; cachedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface FitResult {
  leagues_fitted: number;
  global_fraction: number;
  rows_written: number;
  duration_ms: number;
}

export async function runHalfFractionFit(): Promise<FitResult> {
  const startedAt = Date.now();

  // Fit per-league MLE on the rolling window. status='finished' matches
  // the actual matches.status value (NOT 'FT' — see Bundle F.0 audit).
  const rowsQ = await db.execute(sql`
    SELECT league,
           COUNT(*)::int AS n,
           (AVG(home_score_ht + away_score_ht)
            / NULLIF(AVG(home_score + away_score), 0))::numeric AS mle
    FROM matches
    WHERE status = 'finished'
      AND home_score_ht IS NOT NULL
      AND kickoff_time >= NOW() - INTERVAL '${sql.raw(String(ROLLING_MONTHS))} months'
      AND home_score IS NOT NULL
      AND (home_score + away_score) > 0  -- exclude 0-0 matches (NULL fraction)
    GROUP BY league
    HAVING COUNT(*) >= ${MIN_MATCHES_PER_LEAGUE}
  `);
  const rows = ((rowsQ as any).rows ?? []) as Array<{
    league: string;
    n: number;
    mle: string | number | null;
  }>;

  let rowsWritten = 0;
  for (const r of rows) {
    const mle = r.mle == null ? null : Number(r.mle);
    if (mle == null || !Number.isFinite(mle) || mle <= 0 || mle >= 1) continue;
    const posterior =
      (PRIOR_STRENGTH_K * GLOBAL_HT_FRACTION + r.n * mle) /
      (PRIOR_STRENGTH_K + r.n);

    await db.execute(sql`
      INSERT INTO league_half_fractions
        (league, n_matches, ht_fraction_mle, ht_fraction_posterior, fit_at)
      VALUES (${r.league}, ${r.n}, ${mle}, ${posterior}, NOW())
      ON CONFLICT (league) DO UPDATE SET
        n_matches              = EXCLUDED.n_matches,
        ht_fraction_mle        = EXCLUDED.ht_fraction_mle,
        ht_fraction_posterior  = EXCLUDED.ht_fraction_posterior,
        fit_at                 = EXCLUDED.fit_at
    `);
    rowsWritten += 1;
  }

  // Invalidate cache so predictors pick up new values on next read.
  cache = null;

  const result: FitResult = {
    leagues_fitted: rows.length,
    global_fraction: GLOBAL_HT_FRACTION,
    rows_written: rowsWritten,
    duration_ms: Date.now() - startedAt,
  };
  logger.info(result, "Per-league half-fraction fit complete");
  return result;
}

/**
 * Returns the HT goal fraction for the given league. Uses cached posterior
 * if available (5-min TTL); falls back to global 0.45 when no row exists
 * yet for the league (newly-discovered leagues or pre-first-fit).
 */
export async function getHalfFractionForLeague(
  league: string | null | undefined,
): Promise<number> {
  if (!league) return GLOBAL_HT_FRACTION;

  const now = Date.now();
  if (cache == null || now - cache.cachedAt > CACHE_TTL_MS) {
    const q = await db.execute(sql`
      SELECT league, ht_fraction_posterior::float8 AS p
      FROM league_half_fractions
    `);
    const map = new Map<string, number>();
    for (const r of (((q as any).rows ?? []) as Array<{ league: string; p: number }>)) {
      if (Number.isFinite(r.p) && r.p > 0 && r.p < 1) {
        map.set(r.league, r.p);
      }
    }
    cache = { rows: map, cachedAt: now };
  }
  return cache.rows.get(league) ?? GLOBAL_HT_FRACTION;
}

// Exported so tests / admin endpoints can inspect.
export function _invalidateHalfFractionCacheForTests(): void {
  cache = null;
}
