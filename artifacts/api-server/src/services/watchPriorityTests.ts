/**
 * Bundle 7.0 — Stage 0 watch-priority unit tests (2026-05-17)
 *
 * Self-contained assertion runner exercising the R1-preserving rule:
 * the model can ONLY raise priority, never lower. Invoked from
 * POST /api/admin/run-watch-priority-tests so the test can be re-run
 * against any deployed server, no test-framework infrastructure needed.
 *
 * If any assertion fails, the runner returns a JSON failure with the
 * specific component values that broke the invariant — useful for
 * pinpointing weight / threshold misconfigurations introduced via
 * agent_config.
 */

import {
  computeWatchPriorityScore,
  assignTier,
  evaluateWatchPriority,
  DEFAULT_WEIGHTS,
  DEFAULT_TIER_THRESHOLDS,
  liquidityScoreFromVolume,
  ttkScoreFromHours,
  releaseProximityScore,
  clvYieldScore,
  type WatchScoreComponents,
} from "./watchPriority";

export interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
  fixture?: Record<string, unknown>;
}

export interface TestRunSummary {
  passed: number;
  failed: number;
  total: number;
  results: TestResult[];
}

function makeComponents(overrides: Partial<WatchScoreComponents> = {}): WatchScoreComponents {
  return {
    edge_density_score: 0,
    release_proximity_score: 0,
    liquidity_score: 0,
    ttk_score: 0,
    clv_yield_score: 0,
    model_opportunity_score: 0,
    ...overrides,
  };
}

export function runWatchPriorityTests(): TestRunSummary {
  const results: TestResult[] = [];

  const assert = (
    name: string,
    condition: boolean,
    detail: string,
    fixture?: Record<string, unknown>,
  ): void => {
    results.push({ name, passed: condition, detail: condition ? undefined : detail, fixture });
  };

  // ── R1 invariant #1: model boost is always non-negative ─────────────────
  // Defense against pathological config (W_model accidentally < 0).
  {
    const components = makeComponents({ model_opportunity_score: 100 });
    const r = computeWatchPriorityScore(components);
    assert(
      "R1: model boost ≥ 0 with positive opportunity score",
      r.modelBoost >= 0,
      `Expected modelBoost >= 0 but got ${r.modelBoost}`,
      { components, result: r },
    );
  }

  // ── R1 invariant #2: same base + model=0 vs model=100 → second never lower ───
  // The core rule Chris asked to enforce. Iterate over a sweep of base
  // configurations: identical fixture except model_opportunity_score.
  // The model=100 variant must score >= model=0 variant on every sample.
  const baseSweep: Array<Partial<WatchScoreComponents>> = [
    { edge_density_score: 0 },
    { edge_density_score: 50 },
    { edge_density_score: 100 },
    { release_proximity_score: 80 },
    { liquidity_score: 70 },
    { ttk_score: 100, edge_density_score: 50, clv_yield_score: 60 },
    { clv_yield_score: 100, liquidity_score: 70 },
    {
      edge_density_score: 80,
      release_proximity_score: 80,
      liquidity_score: 80,
      ttk_score: 80,
      clv_yield_score: 80,
    },
  ];
  for (const base of baseSweep) {
    const withZeroModel = evaluateWatchPriority(makeComponents({ ...base, model_opportunity_score: 0 }));
    const withMaxModel = evaluateWatchPriority(makeComponents({ ...base, model_opportunity_score: 100 }));
    assert(
      `R1: model=100 score ≥ model=0 score for base=${JSON.stringify(base)}`,
      withMaxModel.watch_priority_score >= withZeroModel.watch_priority_score,
      `Expected ${withMaxModel.watch_priority_score} >= ${withZeroModel.watch_priority_score}`,
      { base, withZeroModel, withMaxModel },
    );
    assert(
      `R1: model=100 tier ≤ model=0 tier (lower number is higher priority)`,
      withMaxModel.tier <= withZeroModel.tier,
      `Expected ${withMaxModel.tier} (max model) ≤ ${withZeroModel.tier} (zero model)`,
      { base, withZeroModel, withMaxModel },
    );
  }

  // ── Formula #1: score = base + model_boost exactly ──────────────────────
  {
    const components = makeComponents({
      edge_density_score: 80,
      ttk_score: 90,
      model_opportunity_score: 60,
    });
    const r = computeWatchPriorityScore(components);
    const expectedModelBoost = DEFAULT_WEIGHTS.W_model * 60;
    const expectedBase = Math.max(
      DEFAULT_WEIGHTS.W_edge * 80,
      DEFAULT_WEIGHTS.W_release * 0,
      DEFAULT_WEIGHTS.W_liquidity * 0,
      DEFAULT_WEIGHTS.W_ttk * 90,
      DEFAULT_WEIGHTS.W_clv * 0,
    );
    assert(
      "Formula: modelBoost = W_model × opportunity_score",
      Math.abs(r.modelBoost - expectedModelBoost) < 1e-9,
      `Expected ${expectedModelBoost}, got ${r.modelBoost}`,
    );
    assert(
      "Formula: basePriority = max(weighted components)",
      Math.abs(r.basePriority - expectedBase) < 1e-9,
      `Expected ${expectedBase}, got ${r.basePriority}`,
    );
    assert(
      "Formula: score = base + boost",
      Math.abs(r.score - (expectedBase + expectedModelBoost)) < 1e-9,
      `Expected ${expectedBase + expectedModelBoost}, got ${r.score}`,
    );
  }

  // ── Behavioural cases from the spec ────────────────────────────────────
  // Chris's four behavioural assertions on the locked spec:

  // (a) High empirical signals + model silent → still TIER 1
  {
    const r = evaluateWatchPriority(
      makeComponents({ clv_yield_score: 100, release_proximity_score: 100, liquidity_score: 100, model_opportunity_score: 0 }),
    );
    assert(
      "Spec (a): high CLV + release + liquidity, model silent → TIER 1",
      r.tier === 1,
      `Expected TIER 1, got TIER ${r.tier} (score=${r.watch_priority_score})`,
      { result: r },
    );
  }

  // (b) Warm base + model edge flag → promoted to TIER 1
  {
    const warmBaseZeroModel = evaluateWatchPriority(
      makeComponents({ edge_density_score: 75, release_proximity_score: 75, liquidity_score: 75, ttk_score: 75, clv_yield_score: 75, model_opportunity_score: 0 }),
    );
    const warmBaseModelEdge = evaluateWatchPriority(
      makeComponents({ edge_density_score: 75, release_proximity_score: 75, liquidity_score: 75, ttk_score: 75, clv_yield_score: 75, model_opportunity_score: 60 }),
    );
    assert(
      "Spec (b): warm base alone is TIER 2",
      warmBaseZeroModel.tier === 2,
      `Expected TIER 2, got TIER ${warmBaseZeroModel.tier} (score=${warmBaseZeroModel.watch_priority_score})`,
    );
    assert(
      "Spec (b): warm base + model edge → promoted to TIER 1",
      warmBaseModelEdge.tier === 1,
      `Expected TIER 1, got TIER ${warmBaseModelEdge.tier} (score=${warmBaseModelEdge.watch_priority_score})`,
    );
  }

  // (c) HOT base + zero model → still TIER 1
  {
    const r = evaluateWatchPriority(
      makeComponents({ edge_density_score: 100, ttk_score: 100, model_opportunity_score: 0 }),
    );
    assert(
      "Spec (c): HOT base + zero model → TIER 1",
      r.tier === 1,
      `Expected TIER 1, got TIER ${r.tier} (score=${r.watch_priority_score})`,
    );
  }

  // (d) Model edge alone + cold base → TIER 3 at best
  {
    const r = evaluateWatchPriority(
      makeComponents({ model_opportunity_score: 100 }), // every other component = 0
    );
    assert(
      "Spec (d): model alone cannot promote past TIER 3",
      r.tier >= 3,
      `Expected TIER 3 or worse, got TIER ${r.tier} (score=${r.watch_priority_score})`,
      { result: r },
    );
  }

  // ── Component-helper sanity checks ──────────────────────────────────────
  assert("liquidityScoreFromVolume: £50 → 0",   liquidityScoreFromVolume(50) === 0,    "");
  assert("liquidityScoreFromVolume: £300 → 30", liquidityScoreFromVolume(300) === 30,  "");
  assert("liquidityScoreFromVolume: £1000 → 70", liquidityScoreFromVolume(1000) === 70, "");
  assert("liquidityScoreFromVolume: £3000 → 100", liquidityScoreFromVolume(3000) === 100, "");

  assert("ttkScoreFromHours: 0.5h → 100", ttkScoreFromHours(0.5) === 100, "");
  assert("ttkScoreFromHours: 3h → 90",   ttkScoreFromHours(3)   === 90,  "");
  assert("ttkScoreFromHours: 100h → 5",  ttkScoreFromHours(100) === 5,   "");

  assert("releaseProximityScore: exact match → 100", releaseProximityScore(48, 48) === 100, "");
  assert(
    "releaseProximityScore: 24h vs 48h median → 50",
    Math.abs(releaseProximityScore(24, 48) - 50) < 1e-9,
    "",
  );

  assert("clvYieldScore: null → 50 (neutral)", clvYieldScore(null) === 50, "");
  assert("clvYieldScore: 0 → 50",              clvYieldScore(0)    === 50, "");
  assert("clvYieldScore: +4 → 70",             clvYieldScore(4)    === 70, "");
  assert("clvYieldScore: +20 → 100 (capped)",  clvYieldScore(20)   === 100, "");
  assert("clvYieldScore: -10 → 0 (capped)",    clvYieldScore(-10)  === 0,  "");

  // ── Tier-threshold sanity ──────────────────────────────────────────────
  assert("Tier ceiling: score >= 20 → TIER 1", assignTier(20) === 1, "");
  assert("Tier band:    score = 15 → TIER 2", assignTier(15) === 2, "");
  assert("Tier band:    score = 6  → TIER 3", assignTier(6)  === 3, "");
  assert("Tier floor:   score = 0  → TIER 4", assignTier(0)  === 4, "");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  return { passed, failed, total: results.length, results };
}
