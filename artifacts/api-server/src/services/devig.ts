/**
 * Task 14 (theory-plan rebake) — power-method + Shin de-vig.
 *
 * Replaces the proportional method `p_i / Σp_j` used previously in
 * oddsPapi.ts. Both methods normalise a vector of book-implied
 * probabilities (`π_i = 1 / odds_i`) to a fair-probability vector that
 * sums to 1, but with different assumptions about *how* the bookmaker
 * built their over-round:
 *
 *  - **Proportional** (legacy): assumes overround is allocated in
 *    proportion to implied probability. Closed-form, fast, but biased
 *    against favourites — favourites get over-discounted.
 *  - **Power**: assumes overround is multiplicative on log-odds.
 *    Solves `Σ π_i^k = 1` for `k` via Newton iteration. Better
 *    calibration on top-tier markets where bookmaker margin is
 *    spread evenly.
 *  - **Shin**: explicitly models adverse selection (insider trading).
 *    Solves for a hidden-information parameter `z ∈ [0, 1)` such that
 *    `p_i = [√(z² + 4(1-z)·π_i²/Σπ) − z] / [2(1-z)]` sums to 1.
 *    Recommended for lower-tier / thinly-traded markets.
 *
 * All three return a probability vector that sums to 1; the caller can
 * compute fair odds as `1 / p_i`.
 *
 * Fallback: if either iterative method fails to converge (numerically
 * pathological inputs), we fall back to the proportional method so the
 * caller always gets a valid probability vector.
 */

export type DevigMethod = "proportional" | "power" | "shin";

const MAX_ITERATIONS = 30;
const CONVERGENCE_EPSILON = 1e-9;

/**
 * Proportional de-vig (legacy baseline). Always succeeds.
 *
 * For each i: p_i = (1 / odds_i) / Σ(1 / odds_j)
 */
export function devigProportional(odds: number[]): number[] {
  const implied = odds.map((o) => (o > 1 ? 1 / o : 0));
  const sum = implied.reduce((s, p) => s + p, 0);
  if (sum <= 0) return implied;
  return implied.map((p) => p / sum);
}

/**
 * Power-method de-vig. Solves Σ π_i^k = 1 for k via Newton iteration.
 *
 * For an over-rounded book (Σπ_i > 1), k < 1 and shrinks each implied;
 * for an under-rounded book (rare; longshot-bias markets), k > 1.
 *
 * Returns proportional fallback if Newton fails to converge.
 */
export function devigPower(odds: number[]): number[] {
  const implied = odds.map((o) => (o > 1 ? 1 / o : 0));
  if (implied.length === 0 || implied.some((p) => p <= 0)) {
    return devigProportional(odds);
  }
  const sum0 = implied.reduce((s, p) => s + p, 0);
  if (Math.abs(sum0 - 1) < CONVERGENCE_EPSILON) {
    return implied.slice();
  }

  // Newton: f(k) = Σπ_i^k − 1; f'(k) = Σπ_i^k · ln(π_i).
  // Start at k=1 (proportional baseline) and iterate.
  let k = 1.0;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let f = -1;
    let fp = 0;
    for (const p of implied) {
      const term = Math.pow(p, k);
      f += term;
      fp += term * Math.log(p);
    }
    if (Math.abs(f) < CONVERGENCE_EPSILON) break;
    if (Math.abs(fp) < CONVERGENCE_EPSILON) {
      return devigProportional(odds);
    }
    const next = k - f / fp;
    if (!Number.isFinite(next) || next <= 0 || next > 10) {
      return devigProportional(odds);
    }
    if (Math.abs(next - k) < CONVERGENCE_EPSILON) {
      k = next;
      break;
    }
    k = next;
  }

  const result = implied.map((p) => Math.pow(p, k));
  const total = result.reduce((s, p) => s + p, 0);
  // Renormalise to defend against rounding drift.
  if (total <= 0 || !Number.isFinite(total)) return devigProportional(odds);
  return result.map((p) => p / total);
}

/**
 * Shin de-vig. Models adverse selection with a single insider-info
 * parameter z ∈ [0, 1). For each i:
 *
 *   p_i(z) = [√(z² + 4(1 − z) · π_i² / Σπ) − z] / [2(1 − z)]
 *
 * Iterate on z (bisection on Σp_i(z) − 1 = 0) until convergence.
 *
 * Returns proportional fallback if convergence fails.
 */
export function devigShin(odds: number[]): number[] {
  const implied = odds.map((o) => (o > 1 ? 1 / o : 0));
  if (implied.length === 0 || implied.some((p) => p <= 0)) {
    return devigProportional(odds);
  }
  const sumPi = implied.reduce((s, p) => s + p, 0);
  if (sumPi <= 1 + CONVERGENCE_EPSILON) {
    // Under-rounded or perfectly-rounded book — Shin is degenerate at z=0
    // (collapses to proportional). Return proportional directly.
    return devigProportional(odds);
  }

  // Bisection on z ∈ [0, 0.5). Upper bound 0.5 is conservative — Shin
  // values in real football books rarely exceed 0.05.
  let lo = 0;
  let hi = 0.5;

  function sumOfShinProbs(z: number): number {
    const oneMinusZ = 1 - z;
    if (oneMinusZ <= 0) return Number.POSITIVE_INFINITY;
    let s = 0;
    for (const pi of implied) {
      const inner = z * z + 4 * oneMinusZ * (pi * pi) / sumPi;
      if (inner < 0) return NaN;
      s += (Math.sqrt(inner) - z) / (2 * oneMinusZ);
    }
    return s;
  }

  const sLo = sumOfShinProbs(lo);   // = √Σπ at z=0 — > 1 for overround books
  const sHi = sumOfShinProbs(hi);
  if (!Number.isFinite(sLo) || !Number.isFinite(sHi) || sLo === sHi) {
    return devigProportional(odds);
  }
  // We want s(z) = 1. At z=0, s=sumPi > 1 (overround). As z grows, s decreases.
  if (sHi > 1) {
    // Even at z=0.5 the sum exceeds 1 — pathological. Fall back.
    return devigProportional(odds);
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const sMid = sumOfShinProbs(mid);
    if (!Number.isFinite(sMid)) return devigProportional(odds);
    if (Math.abs(sMid - 1) < CONVERGENCE_EPSILON) {
      lo = mid;
      break;
    }
    if (sMid > 1) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  const oneMinusZ = 1 - z;

  const result: number[] = [];
  for (const pi of implied) {
    const inner = z * z + 4 * oneMinusZ * (pi * pi) / sumPi;
    result.push((Math.sqrt(inner) - z) / (2 * oneMinusZ));
  }
  const total = result.reduce((s, p) => s + p, 0);
  if (total <= 0 || !Number.isFinite(total)) return devigProportional(odds);
  // Tiny renormalisation to clean up any rounding drift.
  return result.map((p) => p / total);
}

/**
 * Dispatcher. Picks one of the three methods. Per-league selection is
 * the responsibility of the caller (read competition_config.devig_method
 * and pass the value).
 */
export function devig(odds: number[], method: DevigMethod): number[] {
  switch (method) {
    case "shin":
      return devigShin(odds);
    case "power":
      return devigPower(odds);
    case "proportional":
    default:
      return devigProportional(odds);
  }
}
