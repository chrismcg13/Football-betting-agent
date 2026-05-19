/**
 * Bundle F2.B.N (2026-05-19): per-league NegBin dispersion k fit for
 * corners + cards. Method-of-Moments + Bayesian shrinkage toward global
 * prior. Replaces the hardcoded CORNERS_K_GLOBAL=2.5 and CARDS_K_GLOBAL=
 * 2.0 constants with per-league learned values.
 *
 * MoM: k_hat = mean^2 / max(variance - mean, ε)
 *   - When variance ≈ mean (Poisson-like), k_hat → ∞ (no overdispersion).
 *   - When variance >> mean, k_hat is small (heavy overdispersion).
 *   - When variance < mean (under-dispersion, rare), k_hat is undefined
 *     → fall through to global prior.
 *
 * Bayesian shrinkage: posterior = (k_prior × prior_strength + n × k_hat) /
 *                                 (prior_strength + n)
 *   k_prior = 2.5 for corners, 2.0 for cards
 *   prior_strength = 20  (global dominates below ~20 matches; per-league
 *                         signal takes over above that)
 *
 * Refit via POST /api/admin/fit-dispersion-k. Read on the predictor hot
 * path via getDispersionKForLeague(league, family) with 5-min cache.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const K_PRIOR_CORNERS = 2.5;
const K_PRIOR_CARDS = 2.0;
const PRIOR_STRENGTH = 20;
const ROLLING_DAYS = 365; // 12 months — same window as halfFractionFit
const MIN_MATCHES = 30;
const EPSILON = 0.01; // floor for (variance - mean) to avoid divide-by-zero

interface CacheEntry {
  rows: Map<string, number>; // key: `${league}::${family}` → k_posterior
  cachedAt: number;
}
let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface DispersionFitResult {
  leagues_fitted: number;
  corners_rows: number;
  cards_rows: number;
  duration_ms: number;
}

interface AggRow {
  league: string;
  n: number;
  mean: number | null;
  variance: number | null;
}

async function fitFamily(family: "corners" | "cards"): Promise<number> {
  const column = family === "corners" ? "total_corners" : "total_cards";
  const prior = family === "corners" ? K_PRIOR_CORNERS : K_PRIOR_CARDS;

  const rowsQ = await db.execute(sql`
    SELECT league,
           COUNT(*)::int AS n,
           AVG(${sql.raw(column)})::float8 AS mean,
           VAR_SAMP(${sql.raw(column)})::float8 AS variance
    FROM matches
    WHERE status = 'finished'
      AND ${sql.raw(column)} IS NOT NULL
      AND kickoff_time >= NOW() - INTERVAL '${sql.raw(String(ROLLING_DAYS))} days'
    GROUP BY league
    HAVING COUNT(*) >= ${MIN_MATCHES}
  `);
  const rows = (((rowsQ as any).rows ?? []) as AggRow[]);

  let written = 0;
  for (const r of rows) {
    if (r.mean == null || r.variance == null) continue;
    const mean = Number(r.mean);
    const variance = Number(r.variance);
    if (!Number.isFinite(mean) || !Number.isFinite(variance) || mean <= 0) continue;

    // MoM k_hat; falls back to prior when under-dispersed or near-Poisson.
    const overDisp = Math.max(EPSILON, variance - mean);
    const kMle = (mean * mean) / overDisp;
    // Clamp MLE to [0.5, 10] — extreme values are usually noise on n=30.
    const kMleClamped = Math.max(0.5, Math.min(10, kMle));

    // Bayesian shrinkage toward global.
    const kPosterior =
      (prior * PRIOR_STRENGTH + r.n * kMleClamped) /
      (PRIOR_STRENGTH + r.n);

    await db.execute(sql`
      INSERT INTO league_dispersion_k
        (league, family, n_matches, mean, variance, k_mle, k_posterior, fit_at)
      VALUES (${r.league}, ${family}, ${r.n}, ${mean}, ${variance}, ${kMleClamped}, ${kPosterior}, NOW())
      ON CONFLICT (league, family) DO UPDATE SET
        n_matches    = EXCLUDED.n_matches,
        mean         = EXCLUDED.mean,
        variance     = EXCLUDED.variance,
        k_mle        = EXCLUDED.k_mle,
        k_posterior  = EXCLUDED.k_posterior,
        fit_at       = EXCLUDED.fit_at
    `);
    written += 1;
  }
  return written;
}

export async function runDispersionKFit(): Promise<DispersionFitResult> {
  const startedAt = Date.now();
  const corners = await fitFamily("corners");
  const cards = await fitFamily("cards");
  // Invalidate cache so the next read sees fresh values.
  cache = null;
  const result: DispersionFitResult = {
    leagues_fitted: corners + cards,
    corners_rows: corners,
    cards_rows: cards,
    duration_ms: Date.now() - startedAt,
  };
  logger.info(result, "Per-league dispersion k fit complete");
  return result;
}

/**
 * Returns the NegBin k for (league, family). Cached 5-min. Falls back
 * to the global prior when the league hasn't been fitted yet.
 */
export async function getDispersionKForLeague(
  league: string | null | undefined,
  family: "corners" | "cards",
): Promise<number> {
  const fallback = family === "corners" ? K_PRIOR_CORNERS : K_PRIOR_CARDS;
  if (!league) return fallback;
  const now = Date.now();
  if (cache == null || now - cache.cachedAt > CACHE_TTL_MS) {
    const q = await db.execute(sql`
      SELECT league, family, k_posterior::float8 AS k
      FROM league_dispersion_k
    `);
    const map = new Map<string, number>();
    for (const r of (((q as any).rows ?? []) as Array<{ league: string; family: string; k: number }>)) {
      if (Number.isFinite(r.k) && r.k > 0) {
        map.set(`${r.league}::${r.family}`, r.k);
      }
    }
    cache = { rows: map, cachedAt: now };
  }
  return cache.rows.get(`${league}::${family}`) ?? fallback;
}
