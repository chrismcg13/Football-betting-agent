/**
 * Bundle 7.0 — Stage 0 watch-priority scoring (2026-05-17)
 *
 * Computes watch_priority_score for every active (fixture × market_type)
 * every 5 minutes. The score determines polling cadence (Tier 1-4) for
 * Stage 1 watchlist + Stage 0 polling jobs. The model's opportunity
 * score is an ACCELERATOR ONLY — it can raise priority but never lower.
 * R1-preserving: Stage 1 watchlist INCLUSION stays model-blind; this
 * scoring only governs HOW OFTEN we poll a fixture, never whether we
 * consider it.
 *
 * Formula (locked 2026-05-17):
 *
 *   base_priority = MAX(
 *       W_edge      × expected_edge_density_score,    // §A frequency
 *       W_release   × pinnacle_release_proximity,     // §B timing
 *       W_liquidity × betfair_liquidity_score,        // matched vol
 *       W_ttk       × time_to_kickoff_score,          // §A.2b weighting
 *       W_clv       × historical_clv_yield_score      // LEARNING LOOP
 *   )
 *   model_boost = W_model × model_opportunity_score   // ≥ 0 always
 *   watch_priority_score = base_priority + model_boost
 *
 * MAX of weighted components for base means: strongest single signal
 * wins. Uniform mediocrity (all components ~50) scores LOWER than a
 * spike (one component at 100, rest at 0). The system pursues the
 * signal it has, not the broad-spectrum noise.
 *
 * Default weights (operator-tunable via agent_config.watch_score_weights):
 *   W_edge=0.20, W_release=0.15, W_liquidity=0.15, W_ttk=0.20,
 *   W_clv=0.20, W_model=0.10
 *
 * The CLV component is the closed learning loop — scopes that produced
 * positive realised CLV in the rolling 100-bet window get higher
 * priority; scopes that didn't, decay. The system discovers its own
 * hot scopes from data.
 *
 * Score range under MAX-base + additive-model:
 *   Max base contribution: 0.20 × 100 = 20 (best component at 100)
 *   Max model contribution: 0.10 × 100 = 10
 *   Total range: [0, 30]
 *
 * Default tier thresholds (calibrated to [0,30] range):
 *   TIER 1 HOT:  score ≥ 20
 *   TIER 2 WARM: 15 ≤ score < 20
 *   TIER 3 COOL: 6  ≤ score < 15
 *   TIER 4 COLD: score < 6
 */

import { logger } from "../lib/logger";

// ──────────────────────────────────────────────────────────────────────────
// Pure scoring functions (no DB access — fully unit-testable)
// ──────────────────────────────────────────────────────────────────────────

export interface WatchScoreWeights {
  W_edge: number;
  W_release: number;
  W_liquidity: number;
  W_ttk: number;
  W_clv: number;
  W_model: number;
}

export const DEFAULT_WEIGHTS: WatchScoreWeights = {
  W_edge: 0.20,
  W_release: 0.15,
  W_liquidity: 0.15,
  W_ttk: 0.20,
  W_clv: 0.20,
  W_model: 0.10,
};

export interface WatchTierThresholds {
  TIER_1_MIN: number;
  TIER_2_MIN: number;
  TIER_3_MIN: number;
}

export const DEFAULT_TIER_THRESHOLDS: WatchTierThresholds = {
  TIER_1_MIN: 20,
  TIER_2_MIN: 15,
  TIER_3_MIN: 6,
};

export interface WatchScoreComponents {
  /** Expected edge density per scope (0-100). From scope_edge_density_v. */
  edge_density_score: number;
  /** Pinnacle release-window proximity (0-100). From scope_pinnacle_release_timing_v. */
  release_proximity_score: number;
  /** Current Betfair matched volume bucket (0/30/70/100). */
  liquidity_score: number;
  /** Time-to-kickoff bucket weighting (0-100). */
  ttk_score: number;
  /** Rolling 100-bet stake-weighted CLV yield per scope (0-100). LEARNING LOOP. */
  clv_yield_score: number;
  /**
   * Model's opportunity score (0-100). ACCELERATOR ONLY — can raise
   * priority, never lower. R1: model never excludes a fixture from
   * consideration.
   */
  model_opportunity_score: number;
}

export interface WatchPriorityResult {
  watch_priority_score: number;
  base_priority: number;
  model_boost: number;
  tier: 1 | 2 | 3 | 4;
  components: WatchScoreComponents;
  weights: WatchScoreWeights;
}

/**
 * Locked formula (2026-05-17): max() of weighted base components +
 * non-negative additive model boost.
 *
 * Crucial property: model_opportunity_score = 0 produces the same
 * watch_priority_score as a model that doesn't exist at all. The model
 * can ONLY raise priority, never lower. This is R1-preserving and is
 * verified by the unit test below.
 */
export function computeWatchPriorityScore(
  components: WatchScoreComponents,
  weights: WatchScoreWeights = DEFAULT_WEIGHTS,
): { score: number; basePriority: number; modelBoost: number } {
  const basePriority = Math.max(
    weights.W_edge * components.edge_density_score,
    weights.W_release * components.release_proximity_score,
    weights.W_liquidity * components.liquidity_score,
    weights.W_ttk * components.ttk_score,
    weights.W_clv * components.clv_yield_score,
  );
  // Non-negative clamp — defensive against bad config (e.g. operator
  // accidentally sets W_model negative). The R1 contract is "model
  // cannot subtract"; this clamp guarantees it regardless of inputs.
  const modelBoost = Math.max(0, weights.W_model * components.model_opportunity_score);
  const score = basePriority + modelBoost;
  return { score, basePriority, modelBoost };
}

export function assignTier(
  score: number,
  thresholds: WatchTierThresholds = DEFAULT_TIER_THRESHOLDS,
): 1 | 2 | 3 | 4 {
  if (score >= thresholds.TIER_1_MIN) return 1;
  if (score >= thresholds.TIER_2_MIN) return 2;
  if (score >= thresholds.TIER_3_MIN) return 3;
  return 4;
}

export function evaluateWatchPriority(
  components: WatchScoreComponents,
  weights: WatchScoreWeights = DEFAULT_WEIGHTS,
  thresholds: WatchTierThresholds = DEFAULT_TIER_THRESHOLDS,
): WatchPriorityResult {
  const { score, basePriority, modelBoost } = computeWatchPriorityScore(components, weights);
  const tier = assignTier(score, thresholds);
  return {
    watch_priority_score: score,
    base_priority: basePriority,
    model_boost: modelBoost,
    tier,
    components,
    weights,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Component-score helpers (pure transforms over raw inputs)
// ──────────────────────────────────────────────────────────────────────────

/** Betfair liquidity bucket → 0-100 score per spec. */
export function liquidityScoreFromVolume(matchedVolume: number): number {
  if (!Number.isFinite(matchedVolume) || matchedVolume < 100) return 0;
  if (matchedVolume < 500) return 30;
  if (matchedVolume < 2000) return 70;
  return 100;
}

/** Time-to-kickoff bucket → 0-100 score per memo §A.2b weighting. */
export function ttkScoreFromHours(hoursToKickoff: number): number {
  if (!Number.isFinite(hoursToKickoff) || hoursToKickoff < 0) return 5; // past kickoff = cold
  if (hoursToKickoff < 1) return 100;
  if (hoursToKickoff < 6) return 90;
  if (hoursToKickoff < 12) return 60;
  if (hoursToKickoff < 24) return 40;
  if (hoursToKickoff < 48) return 20;
  return 5;
}

/**
 * Pinnacle release proximity: peaks when current TTK ~ scope's median
 * release timing. Falls off symmetrically on either side. From memo §B,
 * top leagues post lines 45-68h pre-kickoff; this score rewards polling
 * fixtures THAT ARE IN their typical release window.
 *
 * Returns 100 when |ttk - median| = 0; falls to 0 at |ttk - median| ≥ median.
 */
export function releaseProximityScore(
  currentHoursToKickoff: number,
  medianHoursToKickoff: number,
): number {
  if (!Number.isFinite(currentHoursToKickoff) || !Number.isFinite(medianHoursToKickoff)) return 0;
  if (medianHoursToKickoff <= 0) return 0;
  const proximity = 1 - Math.abs(currentHoursToKickoff - medianHoursToKickoff) / medianHoursToKickoff;
  return Math.max(0, Math.min(100, 100 * proximity));
}

/**
 * Historical CLV yield → 0-100. score = 50 + (stake_weighted_clv_pct × 5),
 * clamped [0, 100]. Positive CLV → score > 50; negative CLV → score < 50.
 * The closed learning loop: scopes producing positive realised CLV climb;
 * scopes that don't, decay.
 *
 * Example: stake_weighted_clv_pct = +4 → score = 70 (positive evidence)
 *          stake_weighted_clv_pct = -2 → score = 40 (mild negative)
 *          stake_weighted_clv_pct = +10 → score = 100 (capped)
 */
export function clvYieldScore(stakeWeightedClvPct: number | null): number {
  // No data yet → neutral 50 (don't penalise unfamiliar scopes; they
  // earn their tier via the other components until CLV accumulates).
  if (stakeWeightedClvPct == null || !Number.isFinite(stakeWeightedClvPct)) return 50;
  const raw = 50 + stakeWeightedClvPct * 5;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Edge density score is read directly from scope_edge_density_v.density_score.
 * Identity pass-through; surfaced as a function so the unit-test seam is
 * consistent.
 */
export function edgeDensityScore(rawDensityScore: number | null): number {
  if (rawDensityScore == null || !Number.isFinite(rawDensityScore)) return 0;
  return Math.max(0, Math.min(100, rawDensityScore));
}

// ──────────────────────────────────────────────────────────────────────────
// Config reader — pulls weights + thresholds from agent_config with
// fallbacks to the defaults. Read-through cache via existing
// getAgentConfigCached() pattern. Defaults are returned if the JSON
// parse fails so a bad operator edit doesn't crash the cron.
// ──────────────────────────────────────────────────────────────────────────

interface CachedConfig {
  weights: WatchScoreWeights;
  thresholds: WatchTierThresholds;
  expiresAt: number;
}

let configCache: CachedConfig | null = null;
const CONFIG_TTL_MS = 60_000;

export function _resetConfigCacheForTests(): void {
  configCache = null;
}

export async function readWatchConfig(): Promise<{
  weights: WatchScoreWeights;
  thresholds: WatchTierThresholds;
}> {
  const now = Date.now();
  if (configCache && configCache.expiresAt > now) {
    return { weights: configCache.weights, thresholds: configCache.thresholds };
  }
  const { getConfigValue } = await import("./paperTrading");
  let weights = DEFAULT_WEIGHTS;
  let thresholds = DEFAULT_TIER_THRESHOLDS;
  try {
    const raw = await getConfigValue("watch_score_weights");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WatchScoreWeights>;
      weights = { ...DEFAULT_WEIGHTS, ...parsed };
    }
  } catch (err) {
    logger.warn({ err }, "watch_score_weights JSON parse failed — using defaults");
  }
  try {
    const raw = await getConfigValue("watch_tier_thresholds");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WatchTierThresholds>;
      thresholds = { ...DEFAULT_TIER_THRESHOLDS, ...parsed };
    }
  } catch (err) {
    logger.warn({ err }, "watch_tier_thresholds JSON parse failed — using defaults");
  }
  configCache = { weights, thresholds, expiresAt: now + CONFIG_TTL_MS };
  return { weights, thresholds };
}
