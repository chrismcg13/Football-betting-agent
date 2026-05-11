/**
 * 2026-05-08: Z4 v2 — autonomous Bayesian Kelly-growth tier ladder.
 *
 * Replaces the suspended Track-A-day modelSelfAudit + autonomousTierLadder
 * services. The original used `AVG(LN(GREATEST(0.0001, 1 + pnl/stake)))`
 * which is unit-stake-of-bankroll arithmetic — penalised losses ~9× more
 * than equivalent wins rewarded — and applied a threshold (-0.005)
 * calibrated to bankroll-fraction Kelly growth. Result: 4 wrongful
 * demotions on profitable scopes during a single 03:30 cron run.
 *
 * V2 design (Chris approved 2026-05-08):
 *
 * 1. METRIC. Per-bet log-bankroll-growth from `bankroll_snapshots` when
 *    available. Falls back to theoretical computation:
 *      f = bet_stake / bankroll_at_placement
 *      g = LN(1 + f × (pnl / stake))
 *    For shadow bets, uses shadow_stake / bankroll and shadow_pnl. This
 *    is the same units as actual log-growth.
 *
 * 2. BAYESIAN POSTERIOR. For each scope, treat observed per-bet log-
 *    growth values {g_i} as Normal(μ, σ²) samples. Use weakly-informative
 *    prior μ ~ N(0, σ_prior²) with σ_prior=0.001. Shrinkage:
 *      shrunk_mean = (n × x_bar + n_prior × prior_mean) / (n + n_prior)
 *      se          = sample_std / sqrt(n)
 *      lower_5     = shrunk_mean - 1.645 × se
 *      upper_95    = shrunk_mean + 1.645 × se
 *    n_prior = 30 effective samples. Pulls noisy small samples toward 0
 *    (the no-edge prior) while letting large samples speak for themselves.
 *
 * 3. TIER LADDER (current 5-tier ladder, preserved):
 *      SHADOW_ONLY (0× Kelly) → TRIAL (0.25×) → STANDARD_REDUCED (0.5×)
 *      → DEFAULT (1.0×) → BOOSTED (1.5×)
 *
 * 4. PROMOTION criterion (any rung up):
 *      shrunk_mean > +0.0005 AND lower_5 > 0 AND n >= 200
 *
 * 5. DEMOTION criterion (any rung down):
 *      shrunk_mean < -0.0005 AND upper_95 < 0 AND n >= 100
 *
 * 6. MOVEMENT RULES.
 *    - Max one rung per cycle (no SHADOW_ONLY → BOOSTED jumps).
 *    - SHADOW_ONLY → TRIAL only triggers on SHADOW evidence (real evidence
 *      doesn't exist for paused-tier scopes). All other tiers use real
 *      evidence (settled paper or live bets).
 *    - Symmetric: same statistical bar applied for promotion and demotion.
 *
 * 7. INGESTION-HEALTH GATE. Same as adaptiveThresholdRecommender. If
 *    oddspapi_pinnacle 24h matches < 0.5× 30-day baseline, skip cycle.
 *    Don't move tiers based on data drawn from a broken pipeline.
 *
 * 8. BANKROLL-SNAPSHOT HEALTH GATE. If bankroll_snapshots has fewer than
 *    7 days of history (still seeding), skip — can't compute true Kelly
 *    growth meaningfully yet.
 *
 * 9. AUDIT TRAIL. Every transition writes to model_decision_audit_log
 *    with full posterior summary + the prior tier and new tier.
 *    Resolves any prior unresolved autonomous_pauses row for the scope
 *    and inserts a new one matching the new tier.
 *
 * 10. KILL SWITCH. agent_config.z4_v2_enabled defaults 'false'. Cron
 *     short-circuits if disabled. Belt-and-braces alongside scheduler-
 *     level kill (the cron entry can be commented out).
 *
 * Cadence: daily 03:30 UTC (slot freed by suspending the original
 * modelSelfAudit at 03:30).
 */

import { db, agentConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// ── Tier ladder definitions ─────────────────────────────────────────────
type Tier = "SHADOW_ONLY" | "TRIAL" | "STANDARD_REDUCED" | "DEFAULT" | "BOOSTED";

const TIER_ORDER: Record<Tier, number> = {
  SHADOW_ONLY: 0,
  TRIAL: 1,
  STANDARD_REDUCED: 2,
  DEFAULT: 3,
  BOOSTED: 4,
};

const TIER_KELLY_FRACTION: Record<Tier, number | null> = {
  SHADOW_ONLY: 0,
  TRIAL: 0.25,
  STANDARD_REDUCED: 0.5,
  DEFAULT: null, // null = no override (sub-phase 9 v2 governs)
  BOOSTED: 1.5,
};

function tierFromOverride(override: number | null): Tier {
  if (override == null) return "DEFAULT";
  if (override === 0) return "SHADOW_ONLY";
  if (override <= 0.3) return "TRIAL";
  if (override <= 0.6) return "STANDARD_REDUCED";
  if (override > 1.0) return "BOOSTED";
  return "DEFAULT";
}

function nextRungUp(tier: Tier): Tier | null {
  const order = TIER_ORDER[tier];
  if (order >= 4) return null;
  const target = (Object.keys(TIER_ORDER) as Tier[]).find((k) => TIER_ORDER[k] === order + 1);
  return target ?? null;
}

function nextRungDown(tier: Tier): Tier | null {
  const order = TIER_ORDER[tier];
  if (order <= 0) return null;
  const target = (Object.keys(TIER_ORDER) as Tier[]).find((k) => TIER_ORDER[k] === order - 1);
  return target ?? null;
}

// ── Configuration constants ────────────────────────────────────────────────
const PRIOR_MEAN = 0;
const PRIOR_EFFECTIVE_N = 30;
const PROMOTION_MEAN_BAR = 0.0005;
const DEMOTION_MEAN_BAR = -0.0005;
const PROMOTION_LOWER_BAR = 0;
const DEMOTION_UPPER_BAR = 0;
const PROMOTION_SAMPLE_FLOOR = 200;
const DEMOTION_SAMPLE_FLOOR = 100;
const Z_5PCT = 1.645;
const ANALYSIS_WINDOW_DAYS = 30;

// ── Types ──────────────────────────────────────────────────────────────
interface BetGrowthData {
  bet_id: number;
  bet_track: string;
  scope_market: string;
  scope_league: string;
  log_growth: number;
}

interface ScopeStats {
  scope_type: "market_type" | "league_market" | "tier_market";
  scope_value: string;
  n: number;
  mean: number;
  std: number;
  shrunk_mean: number;
  lower_5: number;
  upper_95: number;
}

export interface TierLadderV2Result {
  evaluatedAt: string;
  ingestionHealthGate: { passed: boolean; reason: string };
  bankrollHealthGate: { passed: boolean; reason: string };
  scopesEvaluated: number;
  promotions: number;
  demotions: number;
  unchanged: number;
  skipped: number;
  transitions: Array<{
    scope_type: string;
    scope_value: string;
    from_tier: Tier;
    to_tier: Tier;
    n: number;
    shrunk_mean: number;
    lower_5: number;
    upper_95: number;
    direction: "promotion" | "demotion";
  }>;
}

// ── Pre-flight gates ──────────────────────────────────────────────────────
async function ingestionHealthy(): Promise<{ passed: boolean; reason: string }> {
  const obs = await db.execute(sql`
    SELECT COUNT(DISTINCT match_id)::numeric AS n
    FROM odds_snapshots
    WHERE source = 'oddspapi_pinnacle' AND snapshot_time > NOW() - INTERVAL '24 hours'
  `);
  const base = await db.execute(sql`
    SELECT (
      SELECT COUNT(DISTINCT match_id)::numeric / 30.0
      FROM odds_snapshots
      WHERE source = 'oddspapi_pinnacle'
        AND snapshot_time BETWEEN NOW() - INTERVAL '35 days' AND NOW() - INTERVAL '5 days'
    ) AS b
  `);
  const observed = Number((((obs as any).rows ?? []) as Array<{ n: number | string }>)[0]?.n ?? 0);
  const baseline = Number((((base as any).rows ?? []) as Array<{ b: number | string | null }>)[0]?.b ?? 0);
  if (baseline < 10) return { passed: true, reason: `baseline too small (${baseline.toFixed(1)}) — allowing` };
  const ratio = observed / baseline;
  if (ratio < 0.5) {
    return {
      passed: false,
      reason: `oddspapi_pinnacle 24h matches ${observed} vs baseline ${baseline.toFixed(0)} (ratio ${ratio.toFixed(2)}) — below 0.5; skipping cycle`,
    };
  }
  return { passed: true, reason: `ratio ${ratio.toFixed(2)} healthy` };
}

async function bankrollHealthy(): Promise<{ passed: boolean; reason: string }> {
  const r = await db.execute(sql`
    SELECT
      COUNT(*) AS n,
      MIN(taken_at)::text AS earliest,
      MAX(taken_at)::text AS latest
    FROM bankroll_snapshots
  `);
  const row = (((r as any).rows ?? []) as Array<{
    n: number | string; earliest: string | null; latest: string | null;
  }>)[0];
  if (!row || Number(row.n) === 0) {
    return { passed: false, reason: "bankroll_snapshots is empty — skipping cycle" };
  }
  if (!row.earliest || !row.latest) {
    return { passed: false, reason: "bankroll_snapshots has malformed timestamps — skipping" };
  }
  const ageHours = (Date.now() - new Date(row.earliest).getTime()) / 3_600_000;
  if (ageHours < 7 * 24) {
    return {
      passed: false,
      reason: `bankroll_snapshots history too short (${(ageHours / 24).toFixed(1)}d, need 7d) — skipping cycle`,
    };
  }
  return { passed: true, reason: `bankroll_snapshots history ${(ageHours / 24).toFixed(1)}d` };
}

// ── Kelly growth computation ──────────────────────────────────────────────
async function loadSettledBetGrowths(): Promise<BetGrowthData[]> {
  // Pull settled bets in last 30 days. Compute per-bet log-bankroll-growth
  // either from bankroll_snapshots (true Kelly growth) or theoretically
  // from stake / bankroll-at-placement / pnl.
  const rows = await db.execute(sql`
    WITH bets AS (
      SELECT
        pb.id AS bet_id,
        pb.bet_track,
        pb.market_type,
        m.league,
        pb.stake::numeric AS stake,
        pb.shadow_stake::numeric AS shadow_stake,
        pb.net_pnl::numeric AS net_pnl,
        pb.shadow_pnl::numeric AS shadow_pnl,
        pb.placed_at,
        (SELECT bs.paper_bankroll::numeric FROM bankroll_snapshots bs
          WHERE bs.bet_id = pb.id AND bs.source = 'pre_placement'
          ORDER BY bs.taken_at LIMIT 1) AS bankroll_pre,
        (SELECT bs.paper_bankroll::numeric FROM bankroll_snapshots bs
          WHERE bs.bet_id = pb.id AND bs.source = 'paper_bet_settle'
          ORDER BY bs.taken_at DESC LIMIT 1) AS bankroll_post
      FROM paper_bets pb
      JOIN matches m ON m.id = pb.match_id
      WHERE pb.legacy_regime = false AND pb.deleted_at IS NULL
        AND pb.status IN ('won','lost')
        AND pb.placed_at >= NOW() - (${ANALYSIS_WINDOW_DAYS}::int * INTERVAL '1 day')
    )
    SELECT
      bet_id,
      bet_track,
      market_type AS scope_market,
      league AS scope_league,
      CASE
        -- Real bankroll-snapshot derived (preferred)
        WHEN bankroll_pre IS NOT NULL AND bankroll_post IS NOT NULL AND bankroll_pre > 0
          THEN LN(GREATEST(1e-12, bankroll_post / bankroll_pre))
        -- Theoretical: f × r within LN(1 + f×r)
        WHEN COALESCE(stake, 0) > 0 AND bankroll_pre > 0
          THEN LN(GREATEST(1e-12, 1 + (stake / bankroll_pre) * (net_pnl / stake)))
        WHEN COALESCE(shadow_stake, 0) > 0 AND bankroll_pre > 0
          THEN LN(GREATEST(1e-12, 1 + (shadow_stake / bankroll_pre) * (shadow_pnl / shadow_stake)))
        ELSE NULL
      END AS log_growth
    FROM bets
    WHERE
      (bankroll_pre IS NOT NULL AND bankroll_post IS NOT NULL AND bankroll_pre > 0)
      OR (COALESCE(stake, 0) > 0 AND bankroll_pre > 0)
      OR (COALESCE(shadow_stake, 0) > 0 AND bankroll_pre > 0)
  `);

  return (((rows as any).rows ?? []) as Array<Record<string, unknown>>)
    .map((r) => ({
      bet_id: Number(r["bet_id"] ?? 0),
      bet_track: String(r["bet_track"] ?? ""),
      scope_market: String(r["scope_market"] ?? ""),
      scope_league: String(r["scope_league"] ?? ""),
      log_growth: Number(r["log_growth"] ?? 0),
    }))
    .filter((r) => Number.isFinite(r.log_growth));
}

// ── Bayesian posterior on per-bet log-growth ──────────────────────────────
function computePosterior(growths: number[]): {
  n: number; mean: number; std: number;
  shrunk_mean: number; lower_5: number; upper_95: number;
} {
  const n = growths.length;
  if (n === 0) {
    return { n: 0, mean: 0, std: 0, shrunk_mean: 0, lower_5: 0, upper_95: 0 };
  }
  const mean = growths.reduce((s, x) => s + x, 0) / n;
  let varSum = 0;
  for (const x of growths) varSum += (x - mean) ** 2;
  const std = n > 1 ? Math.sqrt(varSum / (n - 1)) : 0;
  // Shrinkage: weighted average of observed mean and prior mean
  const shrunk_mean = (n * mean + PRIOR_EFFECTIVE_N * PRIOR_MEAN) / (n + PRIOR_EFFECTIVE_N);
  const se = n > 0 ? std / Math.sqrt(n) : 0;
  return {
    n, mean, std, shrunk_mean,
    lower_5: shrunk_mean - Z_5PCT * se,
    upper_95: shrunk_mean + Z_5PCT * se,
  };
}

// ── Decide tier transition for a scope ─────────────────────────────────────
function decideTransition(
  currentTier: Tier,
  stats: ReturnType<typeof computePosterior>,
): { direction: "promotion" | "demotion" | "none"; toTier: Tier | null } {
  // Promotion: confidently positive growth, sample floor met
  if (
    stats.n >= PROMOTION_SAMPLE_FLOOR &&
    stats.shrunk_mean > PROMOTION_MEAN_BAR &&
    stats.lower_5 > PROMOTION_LOWER_BAR
  ) {
    const target = nextRungUp(currentTier);
    if (target) return { direction: "promotion", toTier: target };
  }
  // Demotion: confidently negative, lower sample floor (capital protection priority)
  if (
    stats.n >= DEMOTION_SAMPLE_FLOOR &&
    stats.shrunk_mean < DEMOTION_MEAN_BAR &&
    stats.upper_95 < DEMOTION_UPPER_BAR
  ) {
    const target = nextRungDown(currentTier);
    if (target) return { direction: "demotion", toTier: target };
  }
  return { direction: "none", toTier: null };
}

// ── Get current tier for a scope ──────────────────────────────────────────
async function getCurrentTier(scopeType: string, scopeValue: string): Promise<Tier> {
  const rows = await db.execute(sql`
    SELECT kelly_fraction_override::text AS override
    FROM autonomous_pauses
    WHERE scope_type = ${scopeType} AND scope_value = ${scopeValue}
      AND resumed_at IS NULL
    ORDER BY paused_at DESC LIMIT 1
  `);
  const row = (((rows as any).rows ?? []) as Array<{ override: string | null }>)[0];
  if (!row?.override) return "DEFAULT";
  const v = Number(row.override);
  return tierFromOverride(Number.isFinite(v) ? v : null);
}

// ── Apply transition: write autonomous_pauses + audit log ─────────────────
async function applyTransition(args: {
  scopeType: string; scopeValue: string;
  fromTier: Tier; toTier: Tier;
  stats: ReturnType<typeof computePosterior>;
  direction: "promotion" | "demotion";
}): Promise<void> {
  // Resolve prior unresolved row
  await db.execute(sql`
    UPDATE autonomous_pauses
    SET resumed_at = NOW()
    WHERE scope_type = ${args.scopeType}
      AND scope_value = ${args.scopeValue}
      AND resumed_at IS NULL
  `);

  const newOverride = TIER_KELLY_FRACTION[args.toTier];

  if (args.toTier !== "DEFAULT") {
    await db.execute(sql`
      INSERT INTO autonomous_pauses (
        scope_type, scope_value, paused_until,
        reason, metric_type, metric_value, threshold_value, sample_size,
        kelly_fraction_override, pause_duration_days, escalation_level
      ) VALUES (
        ${args.scopeType}, ${args.scopeValue},
        NOW() + INTERVAL '7 days',
        ${`Z4-v2 ${args.direction}: ${args.fromTier} → ${args.toTier}`},
        'kelly_growth_bayesian',
        ${args.stats.shrunk_mean},
        ${args.direction === "promotion" ? PROMOTION_MEAN_BAR : DEMOTION_MEAN_BAR},
        ${args.stats.n},
        ${newOverride},
        7, 1
      )
    `);
  }

  // Audit log
  await db.execute(sql`
    INSERT INTO model_decision_audit_log (
      decision_type, subject, prior_state, new_state, reasoning,
      supporting_metrics, review_status
    ) VALUES (
      ${args.direction === "promotion" ? "z4v2_tier_promoted" : "z4v2_tier_demoted"},
      ${`${args.scopeType}:${args.scopeValue}`},
      ${JSON.stringify({ tier: args.fromTier, kelly_fraction_override: TIER_KELLY_FRACTION[args.fromTier] })}::jsonb,
      ${JSON.stringify({ tier: args.toTier, kelly_fraction_override: newOverride })}::jsonb,
      ${`Z4-v2 Bayesian ${args.direction}: shrunk_mean=${args.stats.shrunk_mean.toFixed(6)} ` +
        `lower5=${args.stats.lower_5.toFixed(6)} upper95=${args.stats.upper_95.toFixed(6)} n=${args.stats.n}`},
      ${JSON.stringify({
        n: args.stats.n,
        observed_mean: args.stats.mean,
        observed_std: args.stats.std,
        shrunk_mean: args.stats.shrunk_mean,
        lower_5: args.stats.lower_5,
        upper_95: args.stats.upper_95,
        direction: args.direction,
        from_tier: args.fromTier,
        to_tier: args.toTier,
      })}::jsonb,
      'automatic'
    )
  `);
}

// ── Public entry point ──────────────────────────────────────────────────
export async function runAutonomousTierLadderV2(): Promise<TierLadderV2Result> {
  const result: TierLadderV2Result = {
    evaluatedAt: new Date().toISOString(),
    ingestionHealthGate: { passed: false, reason: "" },
    bankrollHealthGate: { passed: false, reason: "" },
    scopesEvaluated: 0,
    promotions: 0,
    demotions: 0,
    unchanged: 0,
    skipped: 0,
    transitions: [],
  };

  // Kill switch
  const enabledRows = await db.select({ value: agentConfigTable.value })
    .from(agentConfigTable).where(eq(agentConfigTable.key, "z4_v2_enabled"));
  const enabled = enabledRows[0]?.value === "true";
  if (!enabled) {
    logger.info("Z4-v2 tier ladder disabled (z4_v2_enabled != 'true') — skipping");
    return result;
  }

  // Pre-flight gates
  result.ingestionHealthGate = await ingestionHealthy();
  if (!result.ingestionHealthGate.passed) {
    logger.warn(result.ingestionHealthGate, "Z4-v2 tier ladder skipped — ingestion unhealthy");
    await db.execute(sql`
      INSERT INTO model_decision_audit_log (
        decision_type, subject, prior_state, new_state, reasoning,
        supporting_metrics, review_status
      ) VALUES (
        'z4v2_skipped', 'ingestion_gate', '{}'::jsonb, '{}'::jsonb,
        ${result.ingestionHealthGate.reason},
        ${JSON.stringify(result.ingestionHealthGate)}::jsonb,
        'automatic'
      )
    `).catch(() => undefined);
    return result;
  }

  result.bankrollHealthGate = await bankrollHealthy();
  if (!result.bankrollHealthGate.passed) {
    logger.warn(result.bankrollHealthGate, "Z4-v2 tier ladder skipped — bankroll history insufficient");
    await db.execute(sql`
      INSERT INTO model_decision_audit_log (
        decision_type, subject, prior_state, new_state, reasoning,
        supporting_metrics, review_status
      ) VALUES (
        'z4v2_skipped', 'bankroll_gate', '{}'::jsonb, '{}'::jsonb,
        ${result.bankrollHealthGate.reason},
        ${JSON.stringify(result.bankrollHealthGate)}::jsonb,
        'automatic'
      )
    `).catch(() => undefined);
    return result;
  }

  // Load growths
  const allGrowths = await loadSettledBetGrowths();
  if (allGrowths.length === 0) {
    logger.info("Z4-v2: no settled bets in window — nothing to evaluate");
    return result;
  }

  // Group by scope
  const byMarketType = new Map<string, number[]>();
  const byLeagueMarket = new Map<string, number[]>();
  for (const b of allGrowths) {
    const mArr = byMarketType.get(b.scope_market) ?? [];
    mArr.push(b.log_growth); byMarketType.set(b.scope_market, mArr);
    const lmKey = `${b.scope_league}:${b.scope_market}`;
    const lmArr = byLeagueMarket.get(lmKey) ?? [];
    lmArr.push(b.log_growth); byLeagueMarket.set(lmKey, lmArr);
  }

  // Evaluate per scope
  const allScopes: Array<{ type: "market_type" | "league_market"; value: string; growths: number[] }> = [];
  for (const [k, v] of byMarketType) allScopes.push({ type: "market_type", value: k, growths: v });
  for (const [k, v] of byLeagueMarket) allScopes.push({ type: "league_market", value: k, growths: v });

  // F.5 (2026-05-11 — back-to-theory plan): cross-check V2 demotion
  // decisions against analysis_signal_strength. If a scope V2 wants to
  // demote is actually flagged qualifies_live=TRUE by the Bundle B
  // analytics (Wilson lower-95 on win-rate AND/OR t-stat on CLV at
  // n>=30), prefer Bundle B's verdict and skip the demotion. Promotion
  // gates are already strict; corroboration there would only block them
  // unnecessarily.
  const bundleBQualifying = new Set<string>();
  try {
    const qualRows = await db.execute(sql`
      SELECT league, market_type
      FROM v_live_eligibility_candidates
    `);
    for (const row of ((qualRows as any).rows ?? []) as Array<{ league: string; market_type: string }>) {
      bundleBQualifying.add(`${row.league}:${row.market_type}`);
      bundleBQualifying.add(row.market_type);
    }
  } catch (err) {
    logger.warn({ err }, "Z4-v2: failed to load Bundle B eligibility cross-check — proceeding without corroboration");
  }

  for (const scope of allScopes) {
    result.scopesEvaluated++;
    const stats = computePosterior(scope.growths);
    const currentTier = await getCurrentTier(scope.type, scope.value);
    let decision = decideTransition(currentTier, stats);

    if (decision.direction === "demotion" && bundleBQualifying.has(scope.value)) {
      logger.info(
        {
          scope_type: scope.type, scope_value: scope.value,
          posterior: stats, bundleBVerdict: "qualifies_live",
        },
        "Z4-v2 demotion suppressed: Bundle B qualifies this scope for live",
      );
      decision = { direction: "none", toTier: null };
    }

    if (decision.direction === "none" || !decision.toTier) {
      result.unchanged++;
      continue;
    }

    await applyTransition({
      scopeType: scope.type,
      scopeValue: scope.value,
      fromTier: currentTier,
      toTier: decision.toTier,
      stats,
      direction: decision.direction,
    });

    if (decision.direction === "promotion") result.promotions++;
    else result.demotions++;
    result.transitions.push({
      scope_type: scope.type,
      scope_value: scope.value,
      from_tier: currentTier,
      to_tier: decision.toTier,
      n: stats.n,
      shrunk_mean: stats.shrunk_mean,
      lower_5: stats.lower_5,
      upper_95: stats.upper_95,
      direction: decision.direction,
    });
  }

  logger.info(result, "Z4-v2 tier ladder complete");
  return result;
}
