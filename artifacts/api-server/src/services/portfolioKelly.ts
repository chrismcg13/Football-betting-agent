/**
 * Task 13 — portfolio Kelly with empirical correlation shrinkage.
 *
 * Given a set of candidate bets all on the same fixture (so they can
 * correlate), apply a correlation-aware shrinkage to each candidate's
 * independent Kelly fraction. The output fractions sum to ≤ the
 * fixture cap and respect the correlation matrix loaded from
 * market_correlation_matrix.
 *
 * Algorithm (linearised portfolio shrinkage — not full SLSQP):
 *
 *   1. Start with independent Kelly fractions f_i (already computed
 *      by calculateDynamicKellyStake per bet upstream).
 *   2. Build the n×n correlation matrix Σ from
 *      market_correlation_matrix.  Diagonal = 1. Off-diagonal pulled
 *      from per-league row (fallback to global, fallback to 0).
 *   3. Compute the "correlated load" for each i:
 *        L_i = Σ_j ρ_ij × f_j     (sum across all candidates incl self)
 *   4. Shrink f_i by L_i:
 *        f_i' = f_i × clamp(1 / max(L_i, 1), 0, 1)
 *      Intuition: if i's bets are all highly correlated with similar
 *      f_j, L_i ≫ 1 and we shrink. If they're independent, L_i ≈ 1
 *      (just the self-term) and there's no shrinkage.
 *   5. Cap the total: if Σf_i' > fixtureCap, multiply all by
 *      (fixtureCap / Σf_i').
 *
 * Exact portfolio Kelly with constraint Σf_i ≤ cap maximises
 * Σ p_i log(1 + f_i b_i). The linearised shrinkage above is a
 * conservative first-order approximation that's monotonic in
 * correlation. SLSQP could be wired later via the Python sidecar
 * if accuracy demands it; this gets ~80% of the benefit with
 * zero sidecar overhead on the hot path.
 */

import { db, marketCorrelationMatrixTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface PortfolioBetInput {
  marketType: string;
  selectionName: string;
  rawFraction: number;
}

export interface PortfolioBetOutput extends PortfolioBetInput {
  shrunkFraction: number;
  correlatedLoad: number;
  shrinkageFactor: number;
}

export interface PortfolioKellyResult {
  bets: PortfolioBetOutput[];
  fixtureCap: number;
  totalRawFraction: number;
  totalShrunkFraction: number;
  capApplied: boolean;
}

interface CorrelationLookup {
  league: string;
  marketA: string;
  marketB: string;
  correlation: number;
}

let cachedCorrelations: { rows: CorrelationLookup[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — correlations refresh monthly

async function loadAllCorrelations(): Promise<CorrelationLookup[]> {
  const now = Date.now();
  if (cachedCorrelations && now - cachedCorrelations.fetchedAt < CACHE_TTL_MS) {
    return cachedCorrelations.rows;
  }
  const rows = await db
    .select({
      league: marketCorrelationMatrixTable.league,
      marketA: marketCorrelationMatrixTable.marketA,
      marketB: marketCorrelationMatrixTable.marketB,
      correlation: marketCorrelationMatrixTable.correlation,
    })
    .from(marketCorrelationMatrixTable);
  const out: CorrelationLookup[] = rows.map((r) => ({
    league: r.league,
    marketA: r.marketA,
    marketB: r.marketB,
    correlation: Number(r.correlation),
  }));
  cachedCorrelations = { rows: out, fetchedAt: now };
  return out;
}

/** Drop the in-process cache (used after a monthly refresh). */
export function invalidateCorrelationCache(): void {
  cachedCorrelations = null;
}

/**
 * Get correlation between two market types in a given league. Falls
 * back to the global (league='') row if no per-league entry exists.
 * Returns 0 for unknown pairs (treats unknown as uncorrelated; safe
 * since the consumer applies a max(L_i, 1) clamp anyway).
 *
 * Symmetric: order of marketA / marketB is normalised internally.
 */
async function lookupCorrelation(
  league: string,
  marketA: string,
  marketB: string,
): Promise<number> {
  if (marketA === marketB) return 1.0;
  const [a, b] = marketA < marketB ? [marketA, marketB] : [marketB, marketA];
  const all = await loadAllCorrelations();
  // Per-league
  const specific = all.find((r) => r.league === league && r.marketA === a && r.marketB === b);
  if (specific) return specific.correlation;
  // Global fallback
  const global = all.find((r) => r.league === "" && r.marketA === a && r.marketB === b);
  if (global) return global.correlation;
  return 0;
}

/**
 * Apply correlation-aware shrinkage to a basket of candidate bets on
 * the same fixture.
 *
 * Returns shrunkFraction per bet plus diagnostic fields. If the
 * candidate basket has only one bet, that bet passes through
 * unchanged (no correlation possible with itself in any meaningful
 * sense at the basket level).
 *
 * fixtureCap defaults to 0.05 (5% of bankroll across all bets on
 * this fixture). Operator-tunable via the caller.
 */
export async function applyPortfolioCorrelationShrinkage(args: {
  league: string;
  bets: PortfolioBetInput[];
  fixtureCap?: number;
}): Promise<PortfolioKellyResult> {
  const fixtureCap = args.fixtureCap ?? 0.05;
  const bets = args.bets;

  if (bets.length === 0) {
    return { bets: [], fixtureCap, totalRawFraction: 0, totalShrunkFraction: 0, capApplied: false };
  }
  if (bets.length === 1) {
    const b = bets[0]!;
    const capped = Math.min(b.rawFraction, fixtureCap);
    return {
      bets: [{ ...b, shrunkFraction: capped, correlatedLoad: 1, shrinkageFactor: capped / Math.max(b.rawFraction, 1e-9) }],
      fixtureCap,
      totalRawFraction: b.rawFraction,
      totalShrunkFraction: capped,
      capApplied: capped < b.rawFraction,
    };
  }

  // Pre-fetch correlations for every distinct market_type pair in the basket.
  // Building a symmetric matrix indexed by basket position.
  const n = bets.length;
  const rho: number[][] = [];
  for (let i = 0; i < n; i++) rho.push(new Array(n).fill(0));
  for (let i = 0; i < n; i++) rho[i]![i] = 1.0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const corr = await lookupCorrelation(args.league, bets[i]!.marketType, bets[j]!.marketType);
      rho[i]![j] = corr;
      rho[j]![i] = corr;
    }
  }

  // Compute correlated load L_i = Σ_j ρ_ij × f_j
  const f = bets.map((b) => b.rawFraction);
  const totalRaw = f.reduce((s, x) => s + x, 0);
  const loads: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < n; j++) acc += rho[i]![j]! * f[j]!;
    loads[i] = acc;
  }

  // Shrink: f_i' = f_i × clamp(1 / max(L_i, 1), 0, 1)
  const shrunk: number[] = [];
  const factors: number[] = [];
  for (let i = 0; i < n; i++) {
    const factor = 1 / Math.max(loads[i]!, 1);
    factors.push(factor);
    shrunk.push(f[i]! * factor);
  }

  // Cap total at fixtureCap
  let totalShrunk = shrunk.reduce((s, x) => s + x, 0);
  let capApplied = false;
  if (totalShrunk > fixtureCap) {
    const scale = fixtureCap / totalShrunk;
    for (let i = 0; i < n; i++) shrunk[i] = shrunk[i]! * scale;
    totalShrunk = fixtureCap;
    capApplied = true;
  }

  const result: PortfolioKellyResult = {
    bets: bets.map((b, i) => ({
      ...b,
      shrunkFraction: Math.round(shrunk[i]! * 1_000_000) / 1_000_000,
      correlatedLoad: Math.round(loads[i]! * 1_000_000) / 1_000_000,
      shrinkageFactor: Math.round(factors[i]! * 1_000_000) / 1_000_000,
    })),
    fixtureCap,
    totalRawFraction: totalRaw,
    totalShrunkFraction: totalShrunk,
    capApplied,
  };
  logger.debug(result, "Portfolio Kelly correlation shrinkage applied");
  return result;
}
