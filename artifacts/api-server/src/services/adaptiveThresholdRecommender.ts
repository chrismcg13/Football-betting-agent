/**
 * 2026-05-08: Bayesian adaptive threshold recommender.
 *
 * For each scope (global → market_type → tier_market), examines settled
 * paper bets with valid Pinnacle anchors, buckets them by model-vs-Pinnacle
 * edge, and computes a Beta-Binomial posterior on win rate per bucket.
 * From the posterior on win rate plus observed odds, derives the
 * posterior on per-bet log-bankroll-growth via Monte Carlo.
 *
 * The recommended threshold is the smallest edge bucket where the 5th
 * percentile of the log-growth posterior is positive. Bound by safety
 * rails:
 *   floor:        0.005 (0.5%)
 *   ceiling:      0.05  (5%)
 *   sample-floor: n >= 100 per scope before per-scope override fires
 *   max-move:     ±0.005 per cycle (no oscillation on noisy data)
 *
 * Pre-flight: ingestion-health gate. If oddspapi_pinnacle 24h volume is
 * less than 50% of 30-day baseline (excluding last 5 days), SKIP the
 * recommendation cycle. Don't tune thresholds against data drawn from
 * a broken pipeline.
 *
 * Cadence: weekly Sunday 12:00 UTC. Audit logged.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getBankroll } from "./paperTrading";

// ── Configuration constants ────────────────────────────────────────────────
// Pinnacle-edge specific (legacy — preserved for backward compat). For
// other thresholds, see THRESHOLD_BOUNDS above.
const THRESHOLD_FLOOR = 0.005;          // 0.5%
const THRESHOLD_CEILING = 0.05;         // 5%
const PER_SCOPE_SAMPLE_FLOOR = 100;     // n>=100 before per-scope overrides apply
const MAX_MOVE_PER_CYCLE = 0.005;       // ±0.5pp per week
const MONTE_CARLO_DRAWS = 10_000;
const POSTERIOR_LOWER_PERCENTILE = 0.05; // 5th percentile of log-growth posterior

// Edge buckets, in percentage points (model-vs-Pinnacle edge)
const EDGE_BUCKETS: Array<{ name: string; lower: number; upper: number }> = [
  { name: "0-0.5",  lower: 0,    upper: 0.5  },
  { name: "0.5-1",  lower: 0.5,  upper: 1.0  },
  { name: "1-1.5",  lower: 1.0,  upper: 1.5  },
  { name: "1.5-2",  lower: 1.5,  upper: 2.0  },
  { name: "2-2.5",  lower: 2.0,  upper: 2.5  },
  { name: "2.5-3",  lower: 2.5,  upper: 3.0  },
  { name: "3-4",    lower: 3.0,  upper: 4.0  },
  { name: "4-5",    lower: 4.0,  upper: 5.0  },
  { name: "5+",     lower: 5.0,  upper: Infinity },
];

// 2026-05-08: model-vs-market edge buckets (calculated_edge fractional)
const MARKET_EDGE_BUCKETS: Array<{ name: string; lower: number; upper: number }> = [
  { name: "0-0.5",   lower: 0,      upper: 0.005 },
  { name: "0.5-1",   lower: 0.005,  upper: 0.010 },
  { name: "1-2",     lower: 0.010,  upper: 0.020 },
  { name: "2-3",     lower: 0.020,  upper: 0.030 },
  { name: "3-5",     lower: 0.030,  upper: 0.050 },
  { name: "5-10",    lower: 0.050,  upper: 0.100 },
  { name: "10+",     lower: 0.100,  upper: Infinity },
];

// 2026-05-08: opportunity score buckets
const OPP_SCORE_BUCKETS: Array<{ name: string; lower: number; upper: number }> = [
  { name: "0-20",   lower: 0,   upper: 20  },
  { name: "20-30",  lower: 20,  upper: 30  },
  { name: "30-40",  lower: 30,  upper: 40  },
  { name: "40-50",  lower: 40,  upper: 50  },
  { name: "50-60",  lower: 50,  upper: 60  },
  { name: "60-70",  lower: 60,  upper: 70  },
  { name: "70+",    lower: 70,  upper: Infinity },
];

// 2026-05-08: per-threshold safety bounds. Each threshold gets its own
// floor/ceiling/max-move triple to prevent the recommender from suggesting
// pathological values during low-sample regimes.
const THRESHOLD_BOUNDS: Record<string, { floor: number; ceiling: number; maxMove: number }> = {
  pinnacle_edge_min: { floor: 0.005, ceiling: 0.05,  maxMove: 0.005 },
  min_edge_threshold: { floor: 0.001, ceiling: 0.05,  maxMove: 0.003 },
  min_opportunity_score: { floor: 10, ceiling: 80,   maxMove: 5 },
};

// Soft anchor: weakly-informative prior representing the current 2%
// hardcoded floor. Equivalent to ~30 effective bets at win rate that
// would correspond to break-even Kelly growth at 2% edge.
const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;

// ── Types ────────────────────────────────────────────────────────────────
interface BetData {
  match_id: number;
  market_type: string;
  selection_name: string;
  status: "won" | "lost";
  stake: number;
  shadow_stake: number | null;
  net_pnl: number;
  shadow_pnl: number | null;
  model_p: number;
  pinnacle_implied: number;
  odds: number;
  universe_tier: string | null;
  edge_pct: number;
  // 2026-05-08: additional fields for in-tier threshold recommendations
  calculated_edge: number | null;        // model-vs-market edge (fractional)
  opportunity_score: number | null;
}

interface BucketEvidence {
  bucket: string;
  n: number;
  wins: number;
  avg_odds: number;
  avg_kelly_fraction: number;
  posterior_alpha: number;
  posterior_beta: number;
  log_growth_p5: number;
  log_growth_p50: number;
  log_growth_p95: number;
}

export interface RecommenderResult {
  evaluatedAt: string;
  ingestionHealthGate: { passed: boolean; reason: string };
  recommendations: Array<{
    scope_type: string;
    scope_value: string;
    threshold_name: string;
    sample_size: number;
    prior_value: number;
    recommended_value: number;
    bound_applied: string | null;
  }>;
  skipped: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Sample from Beta(α, β) using gamma-ratio. Marsaglia-Tsang for shape ≥ 1
 *  with shifted method for shape < 1. */
function betaSample(alpha: number, beta: number): number {
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

function gammaSample(shape: number): number {
  // Marsaglia & Tsang shape >= 1
  if (shape >= 1) {
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number;
      let v: number;
      do {
        x = boxMuller();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  // shape < 1: boost to shape+1, then scale
  return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
}

function boxMuller(): number {
  // Standard normal sample
  const u1 = Math.random() || 1e-12;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
}

/** Ingestion-health gate (Chris's §3.4 refinement). */
async function ingestionHealthy(): Promise<{ passed: boolean; reason: string }> {
  const observed = await db.execute(sql`
    SELECT COUNT(DISTINCT match_id)::numeric AS n
    FROM odds_snapshots
    WHERE source = 'oddspapi_pinnacle' AND snapshot_time > NOW() - INTERVAL '24 hours'
  `);
  const baseline = await db.execute(sql`
    SELECT (
      SELECT COUNT(DISTINCT match_id)::numeric / 30.0
      FROM odds_snapshots
      WHERE source = 'oddspapi_pinnacle'
        AND snapshot_time BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '5 days'
    ) AS b
  `);
  const observedN = Number((((observed as any).rows ?? []) as Array<{ n: number | string }>)[0]?.n ?? 0);
  const baselineN = Number((((baseline as any).rows ?? []) as Array<{ b: number | string | null }>)[0]?.b ?? 0);

  if (baselineN < 10) {
    return { passed: true, reason: `baseline too small (${baselineN.toFixed(1)}) to gate; allowing` };
  }
  const ratio = observedN / baselineN;
  if (ratio < 0.5) {
    return {
      passed: false,
      reason: `oddspapi_pinnacle 24h matches ${observedN} vs baseline ${baselineN.toFixed(0)} (ratio ${ratio.toFixed(2)}) — below 0.5 threshold; skipping recommendation cycle`,
    };
  }
  return {
    passed: true,
    reason: `oddspapi_pinnacle 24h matches ${observedN} / baseline ${baselineN.toFixed(0)} (ratio ${ratio.toFixed(2)}) — healthy`,
  };
}

async function getBankrollEstimate(): Promise<number> {
  // Live mode: Betfair availableToBetBalance, not paper-compounded agent_config.bankroll.
  return await getBankroll();
}

async function persistGenericRecommendation(
  thresholdName: string,
  scopeType: string,
  scopeValue: string,
  rec: { recommended: number; prior: number; evidence: Array<unknown>; bound_applied: string | null; applied: boolean },
  sampleSize: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO adaptive_thresholds (
      scope_type, scope_value, threshold_name,
      recommended_value, prior_value,
      evidence_bucket_data, posterior_summary,
      sample_size, applied, reason
    ) VALUES (
      ${scopeType}, ${scopeValue}, ${thresholdName},
      ${rec.recommended}, ${rec.prior},
      ${JSON.stringify(rec.evidence)}::jsonb,
      ${JSON.stringify({ method: "kelly_growth_bucket_lower5", evidence_buckets: rec.evidence.length })}::jsonb,
      ${sampleSize}, ${rec.applied}, ${rec.bound_applied}
    )
  `);
  await db.execute(sql`
    INSERT INTO model_decision_audit_log (
      decision_type, subject, prior_state, new_state, reasoning, supporting_metrics, review_status
    ) VALUES (
      'adaptive_threshold_recommended',
      ${`${thresholdName}:${scopeType}:${scopeValue}`},
      ${JSON.stringify({ value: rec.prior })}::jsonb,
      ${JSON.stringify({ value: rec.recommended })}::jsonb,
      ${`Sample n=${sampleSize}; bound_applied=${rec.bound_applied ?? "none"}`},
      ${JSON.stringify({
        sample_size: sampleSize,
        evidence_buckets: rec.evidence.length,
        bound_applied: rec.bound_applied,
        method: "kelly_growth_bucket_lower5",
      })}::jsonb,
      'automatic'
    )
  `).catch(() => undefined);
}

/** Generic active-threshold lookup — same fallback chain as
 *  getActivePinnacleEdgeMin but for any threshold_name. Used by
 *  valueDetection.ts for min_edge_threshold and min_opportunity_score. */
export async function getActiveThreshold(args: {
  thresholdName: string;
  marketType: string;
  universeTier: string | null;
}): Promise<{ value: number; source: string }> {
  const candidates: Array<{ scopeType: string; scopeValue: string }> = [];
  if (args.universeTier) {
    candidates.push({ scopeType: "tier_market", scopeValue: `${args.universeTier}:${args.marketType}` });
  }
  candidates.push({ scopeType: "market_type", scopeValue: args.marketType });
  candidates.push({ scopeType: "global", scopeValue: "_global" });
  for (const c of candidates) {
    const r = await db.execute(sql`
      SELECT recommended_value::numeric AS v FROM adaptive_thresholds
      WHERE scope_type = ${c.scopeType} AND scope_value = ${c.scopeValue}
        AND threshold_name = ${args.thresholdName} AND applied = true
      ORDER BY evaluated_at DESC LIMIT 1
    `);
    const v = (((r as any).rows ?? []) as Array<{ v: number | string }>)[0]?.v;
    if (v != null) return { value: Number(v), source: `${c.scopeType}:${c.scopeValue}` };
  }
  // agent_config fallback
  const cfg = await db.execute(sql`SELECT value FROM agent_config WHERE key = ${args.thresholdName} LIMIT 1`);
  const cfgV = (((cfg as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
  if (cfgV != null) return { value: Number(cfgV), source: "agent_config" };
  // Hardcoded
  const hardcoded = args.thresholdName === "min_edge_threshold" ? 0.005
                  : args.thresholdName === "min_opportunity_score" ? 30
                  : 0;
  return { value: hardcoded, source: "hardcoded_default" };
}

/** Pull settled bets with computable model-vs-Pinnacle edge AND
 *  model-vs-market edge AND opportunity score. */
async function loadSettledBets(): Promise<BetData[]> {
  const rows = await db.execute(sql`
    SELECT
      pb.match_id,
      pb.market_type,
      pb.selection_name,
      pb.status,
      pb.stake::numeric AS stake,
      pb.shadow_stake::numeric AS shadow_stake,
      pb.net_pnl::numeric AS net_pnl,
      pb.shadow_pnl::numeric AS shadow_pnl,
      pb.model_probability::numeric AS model_p,
      pb.pinnacle_implied::numeric AS pinnacle_implied,
      pb.odds_at_placement::numeric AS odds,
      pb.universe_tier_at_placement AS universe_tier,
      pb.calculated_edge::numeric AS calculated_edge,
      pb.opportunity_score::numeric AS opportunity_score
    FROM paper_bets pb
    WHERE pb.legacy_regime = false
      AND pb.deleted_at IS NULL
      AND pb.status IN ('won','lost')
      AND pb.model_probability IS NOT NULL
      AND COALESCE(pb.clv_data_quality, 'incomplete') != 'partial_fallback'
  `);
  return (((rows as any).rows ?? []) as Array<Record<string, unknown>>).map((r) => {
    const model_p = Number(r["model_p"] ?? 0);
    const pinnacle_implied = r["pinnacle_implied"] != null ? Number(r["pinnacle_implied"]) : 0;
    return {
      match_id: Number(r["match_id"] ?? 0),
      market_type: String(r["market_type"] ?? ""),
      selection_name: String(r["selection_name"] ?? ""),
      status: r["status"] as "won" | "lost",
      stake: Number(r["stake"] ?? 0),
      shadow_stake: r["shadow_stake"] != null ? Number(r["shadow_stake"]) : null,
      net_pnl: Number(r["net_pnl"] ?? 0),
      shadow_pnl: r["shadow_pnl"] != null ? Number(r["shadow_pnl"]) : null,
      model_p,
      pinnacle_implied,
      odds: Number(r["odds"] ?? 0),
      universe_tier: r["universe_tier"] != null ? String(r["universe_tier"]) : null,
      edge_pct: pinnacle_implied > 0 ? (model_p - pinnacle_implied) * 100 : 0,
      calculated_edge: r["calculated_edge"] != null ? Number(r["calculated_edge"]) : null,
      opportunity_score: r["opportunity_score"] != null ? Number(r["opportunity_score"]) : null,
    };
  });
}

/** Compute per-bet log-bankroll-growth using the bet's actual stake +
 *  approximate bankroll at placement (proxy: agent_config.bankroll if
 *  unavailable per-bet). Same units as autonomousTierLadderV2. */
function approxKellyGrowth(bet: BetData, bankrollEst: number): number {
  const stake = bet.stake > 0 ? bet.stake : (bet.shadow_stake ?? 0);
  const pnl = bet.stake > 0 ? bet.net_pnl : (bet.shadow_pnl ?? 0);
  if (stake <= 0 || bankrollEst <= 0) return 0;
  const f = stake / bankrollEst;
  const r = pnl / stake;
  return Math.log(Math.max(1e-12, 1 + f * r));
}

/** Compute Bayesian-shrunk posterior on per-bet log-bankroll-growth for a
 *  bucket of bets. Same Normal-Normal shrinkage as autonomousTierLadderV2.
 *  This replaces the Beta-Binomial-then-Monte-Carlo path for the new
 *  in-tier thresholds (the original Pinnacle-edge path retains MC for
 *  back-compat with existing recommendations). */
function computeBucketGrowthPosterior(
  bets: BetData[],
  bankrollEst: number,
): { n: number; mean: number; std: number; shrunk_mean: number; lower_5: number; upper_95: number } {
  const growths = bets.map((b) => approxKellyGrowth(b, bankrollEst)).filter(Number.isFinite);
  const n = growths.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, shrunk_mean: 0, lower_5: 0, upper_95: 0 };
  const mean = growths.reduce((s, x) => s + x, 0) / n;
  let varSum = 0;
  for (const x of growths) varSum += (x - mean) ** 2;
  const std = n > 1 ? Math.sqrt(varSum / (n - 1)) : 0;
  const PRIOR_N = 30;
  const shrunk_mean = (n * mean + PRIOR_N * 0) / (n + PRIOR_N);
  const se = n > 0 ? std / Math.sqrt(n) : 0;
  const Z = 1.645;
  return { n, mean, std, shrunk_mean, lower_5: shrunk_mean - Z * se, upper_95: shrunk_mean + Z * se };
}

/** Recommend a "minimum X" threshold (e.g., min_edge_threshold,
 *  min_opportunity_score) based on the smallest bucket where the lower-5
 *  percentile of Kelly-growth posterior is positive. Same statistical
 *  principle as the Pinnacle-edge recommender: bet only where confidently
 *  positive expected log-growth. */
async function recommendMinimumThreshold(args: {
  thresholdName: "min_edge_threshold" | "min_opportunity_score";
  scopeType: "global" | "market_type" | "tier_market";
  scopeValue: string;
  bets: BetData[];
  bankrollEst: number;
}): Promise<{
  recommended: number;
  prior: number;
  evidence: Array<{ bucket: string; n: number; shrunk_mean: number; lower_5: number; upper_95: number; bucket_lower: number }>;
  bound_applied: string | null;
  applied: boolean;
}> {
  const buckets = args.thresholdName === "min_edge_threshold" ? MARKET_EDGE_BUCKETS : OPP_SCORE_BUCKETS;
  const valueOf = args.thresholdName === "min_edge_threshold"
    ? (b: BetData) => b.calculated_edge ?? -1
    : (b: BetData) => b.opportunity_score ?? -1;

  const prior = await getPriorValueGeneric(args.thresholdName, args.scopeType, args.scopeValue);

  if (args.scopeType !== "global" && args.bets.length < PER_SCOPE_SAMPLE_FLOOR) {
    return { recommended: prior, prior, evidence: [], bound_applied: "sample_floor_not_met", applied: false };
  }

  const evidence = buckets.map((b) => {
    const inBucket = args.bets.filter((bet) => {
      const v = valueOf(bet);
      return v >= b.lower && v < b.upper;
    });
    const post = computeBucketGrowthPosterior(inBucket, args.bankrollEst);
    return { bucket: b.name, n: post.n, shrunk_mean: post.shrunk_mean, lower_5: post.lower_5, upper_95: post.upper_95, bucket_lower: b.lower };
  });

  // Find smallest bucket where lower_5 > 0 (confident positive growth)
  let recommendedRaw = prior;
  for (const e of evidence) {
    if (e.n >= 10 && e.lower_5 > 0) {
      recommendedRaw = e.bucket_lower;
      break;
    }
  }

  const bounds = THRESHOLD_BOUNDS[args.thresholdName]!;
  let value = recommendedRaw;
  let boundApplied: string | null = null;
  if (value < bounds.floor) { value = bounds.floor; boundApplied = "floor"; }
  else if (value > bounds.ceiling) { value = bounds.ceiling; boundApplied = "ceiling"; }
  if (Math.abs(value - prior) > bounds.maxMove) {
    value = prior + Math.sign(value - prior) * bounds.maxMove;
    boundApplied = boundApplied ? `${boundApplied}+max_move` : "max_move";
  }

  return { recommended: value, prior, evidence, bound_applied: boundApplied, applied: true };
}

async function getPriorValueGeneric(
  thresholdName: string,
  scopeType: string,
  scopeValue: string,
): Promise<number> {
  const last = await db.execute(sql`
    SELECT recommended_value::numeric AS v FROM adaptive_thresholds
    WHERE scope_type = ${scopeType} AND scope_value = ${scopeValue}
      AND threshold_name = ${thresholdName} AND applied = true
    ORDER BY evaluated_at DESC LIMIT 1
  `);
  const v = (((last as any).rows ?? []) as Array<{ v: number | string }>)[0]?.v;
  if (v != null) return Number(v);
  // Fallback: agent_config
  const cfgKey = thresholdName === "min_edge_threshold" ? "min_edge_threshold"
              : thresholdName === "min_opportunity_score" ? "min_opportunity_score"
              : thresholdName;
  const cfg = await db.execute(sql`SELECT value FROM agent_config WHERE key = ${cfgKey} LIMIT 1`);
  const cfgV = (((cfg as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
  if (cfgV != null) return Number(cfgV);
  // Hardcoded defaults
  return thresholdName === "min_edge_threshold" ? 0.005
       : thresholdName === "min_opportunity_score" ? 30
       : 0;
}

/** Compute posterior log-growth distribution for a bucket. */
function computeBucketEvidence(
  bucket: { name: string; lower: number; upper: number },
  bets: BetData[],
  bankrollFraction: number,
): BucketEvidence | null {
  const inBucket = bets.filter((b) => b.edge_pct >= bucket.lower && b.edge_pct < bucket.upper);
  if (inBucket.length === 0) return null;

  const wins = inBucket.filter((b) => b.status === "won").length;
  const n = inBucket.length;
  const avg_odds = inBucket.reduce((sum, b) => sum + b.odds, 0) / n;

  const post_alpha = PRIOR_ALPHA + wins;
  const post_beta = PRIOR_BETA + (n - wins);

  // Monte Carlo on log-growth: G(p, b, f) = p*ln(1 + f*(b-1)) + (1-p)*ln(1 - f)
  // where b = avg_odds (decimal), f = Kelly bankroll fraction.
  const draws: number[] = [];
  for (let i = 0; i < MONTE_CARLO_DRAWS; i++) {
    const p = betaSample(post_alpha, post_beta);
    const b = avg_odds;
    const f = bankrollFraction;
    const winContrib = Math.log(Math.max(1e-12, 1 + f * (b - 1)));
    const lossContrib = Math.log(Math.max(1e-12, 1 - f));
    const g = p * winContrib + (1 - p) * lossContrib;
    draws.push(g);
  }

  return {
    bucket: bucket.name,
    n, wins, avg_odds,
    avg_kelly_fraction: bankrollFraction,
    posterior_alpha: post_alpha,
    posterior_beta: post_beta,
    log_growth_p5: percentile(draws, 0.05),
    log_growth_p50: percentile(draws, 0.50),
    log_growth_p95: percentile(draws, 0.95),
  };
}

/** Find the smallest bucket where p5 log-growth > 0. Returns the bucket's
 *  lower edge as the recommended threshold (in fractional units). */
function pickThresholdFromEvidence(evidence: BucketEvidence[]): number | null {
  for (const e of evidence) {
    if (e.log_growth_p5 > 0) {
      const matchedBucket = EDGE_BUCKETS.find((b) => b.name === e.bucket);
      if (matchedBucket) return matchedBucket.lower / 100; // pct → fractional
    }
  }
  return null;
}

/** Apply safety bounds: floor, ceiling, max-move-per-cycle. */
function applyBounds(
  recommended: number,
  prior: number,
): { value: number; boundApplied: string | null } {
  let value = recommended;
  let boundApplied: string | null = null;

  if (value < THRESHOLD_FLOOR) {
    value = THRESHOLD_FLOOR;
    boundApplied = "floor";
  } else if (value > THRESHOLD_CEILING) {
    value = THRESHOLD_CEILING;
    boundApplied = "ceiling";
  }

  if (Math.abs(value - prior) > MAX_MOVE_PER_CYCLE) {
    const direction = value > prior ? 1 : -1;
    value = prior + direction * MAX_MOVE_PER_CYCLE;
    boundApplied = boundApplied ? `${boundApplied}+max_move` : "max_move";
  }
  return { value, boundApplied };
}

/** Look up prior value from agent_config or last applied recommendation. */
async function getPriorValue(scopeType: string, scopeValue: string): Promise<number> {
  const last = await db.execute(sql`
    SELECT recommended_value::numeric AS v FROM adaptive_thresholds
    WHERE scope_type = ${scopeType}
      AND scope_value = ${scopeValue}
      AND threshold_name = 'pinnacle_edge_min'
      AND applied = true
    ORDER BY evaluated_at DESC LIMIT 1
  `);
  const v = (((last as any).rows ?? []) as Array<{ v: number | string }>)[0]?.v;
  if (v != null) return Number(v);
  // Fallback: agent_config global
  const cfg = await db.execute(sql`
    SELECT value FROM agent_config WHERE key = 'pinnacle_edge_min_global' LIMIT 1
  `);
  const cfgV = (((cfg as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
  if (cfgV != null) return Number(cfgV);
  return 0.02; // hardcoded default — matches current pinnaclePreBetFilter
}

/** Run recommender for one scope. */
async function recommendForScope(args: {
  scopeType: "global" | "market_type" | "tier_market";
  scopeValue: string;
  bets: BetData[];
  bankrollFraction: number;
}): Promise<{
  recommended: number;
  prior: number;
  evidence: BucketEvidence[];
  bound_applied: string | null;
  applied: boolean;
}> {
  const prior = await getPriorValue(args.scopeType, args.scopeValue);

  // Per-scope sample floor (except for global — global always evaluates)
  if (args.scopeType !== "global" && args.bets.length < PER_SCOPE_SAMPLE_FLOOR) {
    return {
      recommended: prior, prior, evidence: [],
      bound_applied: "sample_floor_not_met",
      applied: false,
    };
  }

  const evidence: BucketEvidence[] = [];
  for (const bucket of EDGE_BUCKETS) {
    const b = computeBucketEvidence(bucket, args.bets, args.bankrollFraction);
    if (b) evidence.push(b);
  }

  const recommendedRaw = pickThresholdFromEvidence(evidence) ?? prior;
  const bounded = applyBounds(recommendedRaw, prior);

  return {
    recommended: bounded.value,
    prior,
    evidence,
    bound_applied: bounded.boundApplied,
    applied: true,
  };
}

// ── Public entry point ──────────────────────────────────────────────────

export async function runAdaptiveThresholdRecommender(): Promise<RecommenderResult> {
  const startedAt = new Date().toISOString();
  const result: RecommenderResult = {
    evaluatedAt: startedAt,
    ingestionHealthGate: { passed: false, reason: "" },
    recommendations: [],
    skipped: 0,
  };

  // Pre-flight: ingestion-health gate
  result.ingestionHealthGate = await ingestionHealthy();
  if (!result.ingestionHealthGate.passed) {
    logger.warn(
      { reason: result.ingestionHealthGate.reason },
      "Adaptive threshold recommender skipped — ingestion unhealthy",
    );
    await db.execute(sql`
      INSERT INTO model_decision_audit_log (
        decision_type, subject, prior_state, new_state, reasoning, supporting_metrics, review_status
      ) VALUES (
        'adaptive_recommender_skipped',
        'pinnacle_edge_min:ingestion_gate',
        '{}'::jsonb, '{}'::jsonb,
        ${result.ingestionHealthGate.reason},
        ${JSON.stringify(result.ingestionHealthGate)}::jsonb,
        'automatic'
      )
    `).catch(() => undefined);
    return result;
  }

  const allBets = await loadSettledBets();
  const bankrollFraction = 0.02; // current max_stake_pct — Kelly clamp
  const bankrollEst = await getBankrollEstimate();

  // ── pinnacle_edge_min — only on bets with Pinnacle anchor ──
  const pinnacleBets = allBets.filter((b) => b.pinnacle_implied > 0);
  const globalRec = await recommendForScope({
    scopeType: "global", scopeValue: "_global",
    bets: pinnacleBets, bankrollFraction,
  });
  await persistRecommendation("global", "_global", globalRec, pinnacleBets.length);
  result.recommendations.push({
    scope_type: "global", scope_value: "_global",
    threshold_name: "pinnacle_edge_min",
    sample_size: pinnacleBets.length,
    prior_value: globalRec.prior,
    recommended_value: globalRec.recommended,
    bound_applied: globalRec.bound_applied,
  });

  // ── min_edge_threshold (model-vs-market) — global ──
  const minEdgeRec = await recommendMinimumThreshold({
    thresholdName: "min_edge_threshold",
    scopeType: "global", scopeValue: "_global",
    bets: allBets, bankrollEst,
  });
  if (minEdgeRec.applied) {
    await persistGenericRecommendation("min_edge_threshold", "global", "_global", minEdgeRec, allBets.length);
    result.recommendations.push({
      scope_type: "global", scope_value: "_global",
      threshold_name: "min_edge_threshold",
      sample_size: allBets.length,
      prior_value: minEdgeRec.prior,
      recommended_value: minEdgeRec.recommended,
      bound_applied: minEdgeRec.bound_applied,
    });
  }

  // ── min_opportunity_score — global ──
  const minOppRec = await recommendMinimumThreshold({
    thresholdName: "min_opportunity_score",
    scopeType: "global", scopeValue: "_global",
    bets: allBets, bankrollEst,
  });
  if (minOppRec.applied) {
    await persistGenericRecommendation("min_opportunity_score", "global", "_global", minOppRec, allBets.length);
    result.recommendations.push({
      scope_type: "global", scope_value: "_global",
      threshold_name: "min_opportunity_score",
      sample_size: allBets.length,
      prior_value: minOppRec.prior,
      recommended_value: minOppRec.recommended,
      bound_applied: minOppRec.bound_applied,
    });
  }

  // Per market_type
  const byMarket = new Map<string, BetData[]>();
  for (const b of allBets) {
    const arr = byMarket.get(b.market_type) ?? [];
    arr.push(b);
    byMarket.set(b.market_type, arr);
  }
  for (const [marketType, bets] of byMarket) {
    const rec = await recommendForScope({
      scopeType: "market_type", scopeValue: marketType,
      bets, bankrollFraction,
    });
    if (rec.applied) {
      await persistRecommendation("market_type", marketType, rec, bets.length);
      result.recommendations.push({
        scope_type: "market_type", scope_value: marketType,
        threshold_name: "pinnacle_edge_min",
        sample_size: bets.length,
        prior_value: rec.prior,
        recommended_value: rec.recommended,
        bound_applied: rec.bound_applied,
      });
    } else {
      result.skipped++;
    }
  }

  // Per tier_market (universe_tier × market_type)
  const byTierMarket = new Map<string, BetData[]>();
  for (const b of allBets) {
    if (!b.universe_tier) continue;
    const key = `${b.universe_tier}:${b.market_type}`;
    const arr = byTierMarket.get(key) ?? [];
    arr.push(b);
    byTierMarket.set(key, arr);
  }
  for (const [scope, bets] of byTierMarket) {
    const rec = await recommendForScope({
      scopeType: "tier_market", scopeValue: scope,
      bets, bankrollFraction,
    });
    if (rec.applied) {
      await persistRecommendation("tier_market", scope, rec, bets.length);
      result.recommendations.push({
        scope_type: "tier_market", scope_value: scope,
        threshold_name: "pinnacle_edge_min",
        sample_size: bets.length,
        prior_value: rec.prior,
        recommended_value: rec.recommended,
        bound_applied: rec.bound_applied,
      });
    } else {
      result.skipped++;
    }
  }

  logger.info(
    {
      recommendations: result.recommendations.length,
      skipped: result.skipped,
      sample_total: allBets.length,
    },
    "Adaptive threshold recommender complete",
  );
  return result;
}

async function persistRecommendation(
  scopeType: string,
  scopeValue: string,
  rec: { recommended: number; prior: number; evidence: BucketEvidence[]; bound_applied: string | null; applied: boolean },
  sampleSize: number,
): Promise<void> {
  // Posterior summary: just the bucket-level summary stats
  const posteriorSummary = rec.evidence.map((e) => ({
    bucket: e.bucket,
    n: e.n,
    log_growth_p5: e.log_growth_p5,
    log_growth_p50: e.log_growth_p50,
  }));

  await db.execute(sql`
    INSERT INTO adaptive_thresholds (
      scope_type, scope_value, threshold_name,
      recommended_value, prior_value,
      evidence_bucket_data, posterior_summary,
      sample_size, applied, reason
    ) VALUES (
      ${scopeType}, ${scopeValue}, 'pinnacle_edge_min',
      ${rec.recommended}, ${rec.prior},
      ${JSON.stringify(rec.evidence)}::jsonb,
      ${JSON.stringify(posteriorSummary)}::jsonb,
      ${sampleSize}, ${rec.applied},
      ${rec.bound_applied}
    )
  `);

  await db.execute(sql`
    INSERT INTO model_decision_audit_log (
      decision_type, subject, prior_state, new_state, reasoning, supporting_metrics, review_status
    ) VALUES (
      'adaptive_threshold_recommended',
      ${`pinnacle_edge_min:${scopeType}:${scopeValue}`},
      ${JSON.stringify({ value: rec.prior })}::jsonb,
      ${JSON.stringify({ value: rec.recommended })}::jsonb,
      ${`Sample n=${sampleSize}; bound_applied=${rec.bound_applied ?? "none"}`},
      ${JSON.stringify({
        sample_size: sampleSize,
        evidence_buckets: rec.evidence.length,
        bound_applied: rec.bound_applied,
      })}::jsonb,
      'automatic'
    )
  `).catch(() => undefined);
}

/** Look up the active threshold for a scope. Used by pinnaclePreBetFilter.
 *  Falls back through tier_market → market_type → global → 0.02. */
export async function getActivePinnacleEdgeMin(args: {
  marketType: string;
  universeTier: string | null;
}): Promise<{ value: number; source: string }> {
  const candidates: Array<{ scopeType: string; scopeValue: string }> = [];
  if (args.universeTier) {
    candidates.push({ scopeType: "tier_market", scopeValue: `${args.universeTier}:${args.marketType}` });
  }
  candidates.push({ scopeType: "market_type", scopeValue: args.marketType });
  candidates.push({ scopeType: "global", scopeValue: "_global" });

  for (const c of candidates) {
    const r = await db.execute(sql`
      SELECT recommended_value::numeric AS v FROM adaptive_thresholds
      WHERE scope_type = ${c.scopeType}
        AND scope_value = ${c.scopeValue}
        AND threshold_name = 'pinnacle_edge_min'
        AND applied = true
      ORDER BY evaluated_at DESC LIMIT 1
    `);
    const v = (((r as any).rows ?? []) as Array<{ v: number | string }>)[0]?.v;
    if (v != null) return { value: Number(v), source: `${c.scopeType}:${c.scopeValue}` };
  }
  // Final fallback: agent_config or hardcoded
  const cfg = await db.execute(sql`
    SELECT value FROM agent_config WHERE key = 'pinnacle_edge_min_global' LIMIT 1
  `);
  const cfgV = (((cfg as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
  if (cfgV != null) return { value: Number(cfgV), source: "agent_config" };
  return { value: 0.02, source: "hardcoded_default" };
}
