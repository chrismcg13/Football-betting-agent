/**
 * Task 17 — Drawdown-targeted dynamic Kelly fraction (Phase 5b).
 *
 * Replaces the fixed 25%-Kelly candidate fraction with a fraction chosen
 * to keep the 1st-percentile 90-day drawdown ≤ a target (default 15%).
 * Implemented as a Monte-Carlo lookup table refreshed daily.
 *
 * Each run:
 *   1. Pull realised per-bet log returns over the last N settled bets
 *      (combine paper+live+shadow_pnl for max sample size).
 *   2. Compute mean (mu) and stdev (sigma) — the empirical edge / variance.
 *   3. For each kelly_fraction f in {0.05, 0.10, …, 1.0}:
 *        Simulate `paths` (default 5000) forward paths of `betsPerPath`
 *        (default 450 ≈ 90 days × 5 bets/day). Bankroll multiplier per
 *        bet: (1 + f × R) where R ~ N(mu, sigma).
 *        Track max-to-min drawdown ratio for each path.
 *      Compute the 1st-percentile drawdown across paths.
 *   4. Pick the LARGEST f whose p1_drawdown ≤ target.
 *   5. Persist (mu, sigma, full curve, selected_fraction).
 *
 * The reader getDynamicKellyFraction() returns the latest selected
 * fraction or null when no row exists. Caller falls back to a default
 * (e.g. 0.25 for candidate-tier bets) when null.
 *
 * Phase 5b ships this as a SHADOW change — the lookup populates but
 * stake-sizing isn't wired to read it yet. That's Phase 5b.2 after
 * operator review of the produced curves.
 */

import { db, kellyFractionLookupTable, paperBetsTable, agentConfigTable } from "@workspace/db";
import { and, eq, sql, isNull, gte } from "drizzle-orm";
import { logger } from "../lib/logger";

const SAMPLE_BETS = 500;        // last N settled bets for (mu, sigma) estimation
const DEFAULT_TARGET_P1_PCT = 15;
const FRACTIONS = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.75, 1.0];
const DEFAULT_PATHS = 5000;
const DEFAULT_BETS_PER_PATH = 450;

interface SimResult {
  fraction: number;
  p1_drawdown: number;
  median_terminal_growth: number;
}

/** Box-Muller standard normal sample. */
function randn(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2);
}

async function getConfigNumber(key: string, fallback: number): Promise<number> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, key));
  const raw = rows[0]?.value;
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function loadRealisedReturns(limit: number): Promise<number[]> {
  // Use settled bets across the live + shadow tracks; per-bet
  // "return" = pnl / stake. For shadow track, treat shadow_stake /
  // shadow_pnl as the unit. Paper rail is deprecated post-2026-05-09
  // and its residual rows are 100% wins on extreme +4 AH lines (Path
  // P/S artefact) — they would massively bias the realised-return
  // distribution that feeds the Monte-Carlo drawdown target.
  const result = await db.execute(sql`
    SELECT
      CASE WHEN bet_track = 'shadow' THEN COALESCE(shadow_stake, 0)
           ELSE stake END                          AS stake_used,
      CASE WHEN bet_track = 'shadow' THEN COALESCE(shadow_pnl, 0)
           ELSE COALESCE(net_pnl, settlement_pnl, 0) END AS pnl_used
    FROM paper_bets
    WHERE status IN ('won','lost')
      AND deleted_at IS NULL
      AND bet_track IN ('live','shadow')
    ORDER BY placed_at DESC
    LIMIT ${limit}
  `);
  const rows = ((result as unknown) as { rows?: Array<{ stake_used: string | number; pnl_used: string | number }> }).rows ?? [];
  const returns: number[] = [];
  for (const r of rows) {
    const stake = Number(r.stake_used);
    const pnl = Number(r.pnl_used);
    if (Number.isFinite(stake) && stake > 0 && Number.isFinite(pnl)) {
      returns.push(pnl / stake);
    }
  }
  return returns;
}

function meanStd(xs: number[]): { mean: number; stdev: number } {
  if (xs.length === 0) return { mean: 0, stdev: 0 };
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1);
  return { mean, stdev: Math.sqrt(variance) };
}

function simulateFraction(args: {
  fraction: number;
  mu: number;
  sigma: number;
  paths: number;
  betsPerPath: number;
}): SimResult {
  const { fraction: f, mu, sigma, paths, betsPerPath } = args;
  const drawdowns = new Float64Array(paths);
  const terminals = new Float64Array(paths);

  for (let p = 0; p < paths; p++) {
    let bankroll = 1.0;
    let peak = 1.0;
    let maxDD = 0;
    for (let t = 0; t < betsPerPath; t++) {
      const r = mu + sigma * randn();
      bankroll *= 1 + f * r;
      if (bankroll <= 0) {
        bankroll = 1e-12; // ruin floor
        maxDD = 1; // ~100%
        break;
      }
      if (bankroll > peak) peak = bankroll;
      const dd = (peak - bankroll) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    drawdowns[p] = maxDD;
    terminals[p] = bankroll;
  }

  const sortedDD = Array.from(drawdowns).sort((a, b) => a - b);
  const p1Index = Math.max(0, Math.floor(paths * 0.99) - 1); // 1st pct = upper tail of drawdown
  const p1_drawdown = sortedDD[p1Index]!;
  const sortedTerm = Array.from(terminals).sort((a, b) => a - b);
  const median_terminal_growth = sortedTerm[Math.floor(paths / 2)]!;
  return { fraction: f, p1_drawdown, median_terminal_growth };
}

export interface KellyLookupResult {
  realisedRoi: number;
  realisedStdev: number;
  sampleN: number;
  targetP1Pct: number;
  selectedFraction: number;
  curve: SimResult[];
  durationMs: number;
}

export async function runKellyLookupSimulation(opts: {
  paths?: number;
  betsPerPath?: number;
} = {}): Promise<KellyLookupResult | null> {
  const startedAt = Date.now();
  const paths = opts.paths ?? DEFAULT_PATHS;
  const betsPerPath = opts.betsPerPath ?? DEFAULT_BETS_PER_PATH;

  const targetP1Pct = await getConfigNumber("drawdown_target_p1_pct", DEFAULT_TARGET_P1_PCT);
  const returns = await loadRealisedReturns(SAMPLE_BETS);
  if (returns.length < 50) {
    logger.warn({ n: returns.length }, "Kelly Monte-Carlo skipped — < 50 settled-bet returns available");
    return null;
  }

  const { mean: mu, stdev: sigma } = meanStd(returns);
  if (!Number.isFinite(mu) || !Number.isFinite(sigma) || sigma <= 0) {
    logger.warn({ mu, sigma }, "Kelly Monte-Carlo skipped — degenerate (mu, sigma)");
    return null;
  }

  const curve: SimResult[] = [];
  for (const f of FRACTIONS) {
    const sim = simulateFraction({ fraction: f, mu, sigma, paths, betsPerPath });
    curve.push(sim);
  }

  // Pick the LARGEST f whose p1_drawdown ≤ target (as a fraction 0–1).
  const targetFraction = targetP1Pct / 100;
  let selected = FRACTIONS[0]!;
  for (const sim of curve) {
    if (sim.p1_drawdown <= targetFraction) selected = sim.fraction;
  }

  const result: KellyLookupResult = {
    realisedRoi: mu,
    realisedStdev: sigma,
    sampleN: returns.length,
    targetP1Pct,
    selectedFraction: selected,
    curve,
    durationMs: Date.now() - startedAt,
  };

  await db.insert(kellyFractionLookupTable).values({
    realisedRoi: String(mu),
    realisedStdev: String(sigma),
    sampleN: returns.length,
    targetP1Pct: String(targetP1Pct),
    selectedFraction: String(selected),
    curve: curve as never,
    paths,
    betsPerPath,
  });

  logger.info(
    {
      mu, sigma, sampleN: returns.length, targetP1Pct,
      selectedFraction: selected, durationMs: result.durationMs,
    },
    "Kelly Monte-Carlo lookup written",
  );
  return result;
}

/**
 * Reader. Returns the latest fraction or null if no row exists yet.
 * Caller is responsible for the fallback (compliance log + default
 * fraction). 5-min in-process cache so high-frequency stake calls
 * don't hammer the DB.
 */
let cachedFraction: { value: number | null; fetchedAt: number } | null = null;
const READER_TTL_MS = 5 * 60 * 1000;

export async function getDynamicKellyFraction(): Promise<number | null> {
  if (cachedFraction && Date.now() - cachedFraction.fetchedAt < READER_TTL_MS) {
    return cachedFraction.value;
  }
  const rows = await db
    .select({ selectedFraction: kellyFractionLookupTable.selectedFraction })
    .from(kellyFractionLookupTable)
    .orderBy(sql`${kellyFractionLookupTable.computedAt} DESC`)
    .limit(1);
  const value = rows[0]?.selectedFraction != null ? Number(rows[0].selectedFraction) : null;
  cachedFraction = { value, fetchedAt: Date.now() };
  return value;
}
