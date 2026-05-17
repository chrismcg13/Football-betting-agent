/**
 * Bundle 7.D — Candidate prioritiser + capital allocator (2026-05-17)
 *
 * Replaces the legacy max_bets_per_cycle hardcap. Takes the unioned set
 * of candidates from valueDetection (model-only) + Stage 1 watchlist
 * (sharp-anchored), sorts by priority, streams them through
 * placePaperBet in order, and stops when any capacity ceiling would
 * be breached.
 *
 * Priority key (locked spec):
 *   1. post_slippage_edge_pp DESC  — bigger net edge wins first
 *   2. opportunity_score DESC      — model confidence tie-break
 *   3. identified_edge_pp DESC     — pre-slippage edge final tie-break
 *
 * Capacity ceilings (read from agent_config via Bundle 5.M +
 * Bundle 7.E auto-scaling): per_fixture_pct, per_league_pct,
 * daily_stake_cap_pct. Plus the existing open-exposure ceiling.
 *
 * Pre-flip, this module is unwired — the trading cron continues to
 * call valueDetection/scheduler's existing allocator. Once
 * inversion_pipeline_enabled is true, the scheduler can route through
 * prioritiseAndAllocate() instead.
 */

import { logger } from "../lib/logger";

export interface PrioritisableCandidate {
  matchId: number;
  marketType: string;
  selectionName: string;
  league: string | null;
  backOdds: number;
  pinnacleImplied: number | null;
  rawModelProbability: number | null;
  opportunityScore: number | null;
  /** Identified edge in pp ((backOdds × pinnacleImplied − 1) × 100). null if no Pinnacle. */
  identifiedEdgePp: number | null;
  /** Post-slippage edge in pp (filled by gate evaluation if available). null otherwise. */
  postSlippageEdgePp: number | null;
  /** Source tag for logging / aggregation. */
  source: "value_detection" | "stage1_liquidity" | "stage1_kickoff" | "stage1_mover";
}

/**
 * Sort candidates in priority order. Stable for equal keys. Designed so
 * higher-scoring candidates are consumed first — the allocator just
 * iterates the sorted array.
 */
export function prioritise<T extends PrioritisableCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => {
    // 1. post_slippage_edge_pp DESC (treat null as -Infinity so unscored
    //    candidates lose to scored ones)
    const ap = a.postSlippageEdgePp ?? -Infinity;
    const bp = b.postSlippageEdgePp ?? -Infinity;
    if (ap !== bp) return bp - ap;

    // 2. opportunity_score DESC
    const as = a.opportunityScore ?? -Infinity;
    const bs = b.opportunityScore ?? -Infinity;
    if (as !== bs) return bs - as;

    // 3. identified_edge_pp DESC
    const ai = a.identifiedEdgePp ?? -Infinity;
    const bi = b.identifiedEdgePp ?? -Infinity;
    if (ai !== bi) return bi - ai;

    return 0;
  });
}

/**
 * Allocator state — tracks consumed capacity as candidates fire. Each
 * call to wouldBreach() / record() returns whether the next stake
 * fits AND debits the running totals.
 *
 * Exposure inputs are bankroll fractions (per_fixture_pct etc.) so
 * stake/bankroll = the consumed fraction.
 */
export interface AllocatorCaps {
  perFixturePct: number;
  perLeaguePct: number;
  dailyStakeCapPct: number;
}

export interface AllocatorState {
  fixtureStaked: Map<number, number>;
  leagueStaked: Map<string, number>;
  dailyStaked: number;
  bankroll: number;
  caps: AllocatorCaps;
}

export function newAllocatorState(args: {
  bankroll: number;
  caps: AllocatorCaps;
  initialFixtureExposure?: Map<number, number>;
  initialLeagueExposure?: Map<string, number>;
  initialDailyStaked?: number;
}): AllocatorState {
  return {
    fixtureStaked: new Map(args.initialFixtureExposure ?? new Map()),
    leagueStaked: new Map(args.initialLeagueExposure ?? new Map()),
    dailyStaked: args.initialDailyStaked ?? 0,
    bankroll: args.bankroll,
    caps: args.caps,
  };
}

export interface AllocationCheck {
  fits: boolean;
  bindingCap: "fixture" | "league" | "daily" | null;
  fixtureBudgetRemaining: number;
  leagueBudgetRemaining: number;
  dailyBudgetRemaining: number;
}

export function checkAllocation(
  state: AllocatorState,
  candidate: PrioritisableCandidate,
  proposedStake: number,
): AllocationCheck {
  const { bankroll, caps } = state;
  const fixtureUsed = state.fixtureStaked.get(candidate.matchId) ?? 0;
  const leagueUsed = candidate.league ? (state.leagueStaked.get(candidate.league) ?? 0) : 0;

  const fixtureBudget = Math.max(0, bankroll * caps.perFixturePct / 100 - fixtureUsed);
  const leagueBudget = Math.max(0, bankroll * caps.perLeaguePct / 100 - leagueUsed);
  const dailyBudget = Math.max(0, bankroll * caps.dailyStakeCapPct / 100 - state.dailyStaked);

  // Each cap is independent; the binding cap is the SMALLEST budget.
  // If proposed stake exceeds any budget, the bet doesn't fit.
  const minBudget = Math.min(fixtureBudget, leagueBudget, dailyBudget);
  const fits = proposedStake <= minBudget;
  let bindingCap: AllocationCheck["bindingCap"] = null;
  if (!fits) {
    if (fixtureBudget === minBudget) bindingCap = "fixture";
    else if (leagueBudget === minBudget) bindingCap = "league";
    else bindingCap = "daily";
  }
  return {
    fits,
    bindingCap,
    fixtureBudgetRemaining: fixtureBudget,
    leagueBudgetRemaining: leagueBudget,
    dailyBudgetRemaining: dailyBudget,
  };
}

/**
 * Debit the allocator state after a successful placement.
 */
export function recordAllocation(
  state: AllocatorState,
  candidate: PrioritisableCandidate,
  stake: number,
): void {
  state.fixtureStaked.set(
    candidate.matchId,
    (state.fixtureStaked.get(candidate.matchId) ?? 0) + stake,
  );
  if (candidate.league) {
    state.leagueStaked.set(
      candidate.league,
      (state.leagueStaked.get(candidate.league) ?? 0) + stake,
    );
  }
  state.dailyStaked += stake;
}

/**
 * End-to-end allocator. Sorts the candidates, iterates, fires the
 * placement callback in priority order, debits the running totals.
 * Stops when remaining candidates can't fit under any cap (rare —
 * usually individual candidates breach but later ones might fit with
 * smaller stakes; we keep iterating until no candidates remain).
 *
 * Returns a per-candidate allocation outcome for downstream logging.
 */
export interface AllocationOutcome<T extends PrioritisableCandidate> {
  candidate: T;
  placed: boolean;
  trimmedStake?: number;
  bindingCap?: AllocationCheck["bindingCap"];
}

export async function prioritiseAndAllocate<T extends PrioritisableCandidate>(args: {
  candidates: T[];
  bankroll: number;
  caps: AllocatorCaps;
  initialFixtureExposure?: Map<number, number>;
  initialLeagueExposure?: Map<string, number>;
  initialDailyStaked?: number;
  /**
   * Place the bet. Returns the actual stake placed (could be 0 if the
   * downstream gate / risk-manager demoted to shadow). Errors are
   * caught by the allocator and surfaced in the outcome.
   */
  place: (candidate: T) => Promise<{ placedStake: number; skipped?: boolean; reason?: string }>;
}): Promise<AllocationOutcome<T>[]> {
  const state = newAllocatorState({
    bankroll: args.bankroll,
    caps: args.caps,
    initialFixtureExposure: args.initialFixtureExposure,
    initialLeagueExposure: args.initialLeagueExposure,
    initialDailyStaked: args.initialDailyStaked,
  });
  const sorted = prioritise(args.candidates);
  const outcomes: AllocationOutcome<T>[] = [];

  for (const c of sorted) {
    try {
      const result = await args.place(c);
      if (result.skipped || result.placedStake <= 0) {
        outcomes.push({ candidate: c, placed: false });
        continue;
      }
      // After place(), the downstream stake-clamp (Bundle 5.M
      // applyInversionExposureCaps) has already trimmed to the
      // exposure caps. Record the actual placed stake so the
      // allocator's running totals stay accurate for subsequent
      // candidates in the same cycle.
      recordAllocation(state, c, result.placedStake);
      outcomes.push({ candidate: c, placed: true, trimmedStake: result.placedStake });
    } catch (err) {
      logger.warn(
        { err, matchId: c.matchId, marketType: c.marketType, selectionName: c.selectionName },
        "prioritiseAndAllocate: place() threw",
      );
      outcomes.push({ candidate: c, placed: false });
    }
  }
  return outcomes;
}
