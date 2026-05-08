// ============================================================================
// Model self-audit (2026-05-07, v2 with tier-ladder mobility)
// ----------------------------------------------------------------------------
// Daily 03:30 UTC cron that maintains a continuous tier assignment for every
// (market) / (league × market) / (league) / (archetype) scope, moving each
// scope up and down a Kelly-fraction ladder based on rolling-window
// Kelly-growth-rate evidence.
//
// Tier ladder
//   SHADOW_ONLY        kelly_fraction_override = 0      (real blocked, shadow
//                                                        on Tier B/C continues)
//   TRIAL              kelly_fraction_override = 0.25   (real at quarter Kelly)
//   STANDARD_REDUCED   kelly_fraction_override = 0.5    (real at half Kelly)
//   DEFAULT            no override                      (sub-phase 9 v2 takes
//                                                        over with per-tag
//                                                        kelly_fraction)
//   BOOSTED            kelly_fraction_override = 1.5    (high-confidence
//                                                        scope, amplified)
//
// The shadow track ALWAYS continues. Demoting a scope to SHADOW_ONLY just
// blocks Tier A real-stake placement; Tier B/C shadow capture on that same
// market keeps flowing so the model continues learning, can detect when the
// regime improves, and promote the scope back up the ladder.
//
// Movement criteria (rolling 30-day window of settled bets):
//
// DEMOTIONS (capital protection)
//   any tier → SHADOW_ONLY   real ROI < -25% with n >= 10           (severe)
//   any tier → SHADOW_ONLY   Pinnacle coverage < 20% with n >= 5    (data gap)
//   higher → next-lower      real ROI < -15% with n >= 20
//   higher → next-lower      log-growth/bet < -0.005 with n >= 30
//
// PROMOTIONS (edge confirmed)
//   SHADOW_ONLY → TRIAL      shadow log-growth/bet > +0.005, n >= 50
//                            (shadow edge — even without CLV — initiates
//                            small real-stake to confirm)
//   TRIAL → STANDARD_REDUCED real log-growth/bet > +0.005, n >= 20
//   STANDARD_REDUCED → DEFAULT real log-growth/bet > +0.005, n >= 30
//   DEFAULT → BOOSTED        real log-growth > +0.01 AND ROI > +10%, n >= 50
//
// Shadow bets generate the upward path's evidence. Without shadow flow, a
// demoted scope can never come back. That's why the shadow track on Tier B/C
// is architecturally untouchable — it's the model's exploration arm.
//
// Audit-log writes
//   Every transition writes a model_decision_audit_log row with decision_type
//   matching the movement direction (e.g. tier_promoted_from_shadow,
//   tier_demoted_to_shadow, tier_boosted, tier_recovered_to_default). Every
//   scope-evaluation also writes a self_audit_observation when no transition
//   warranted, so the audit log is a complete record of what was checked.
//
// Database
//   autonomous_pauses table is the active-tier registry. Only one active
//   row per scope (resumed_at IS NULL). On transition, we set the prior
//   row's resumed_at = NOW() and INSERT the new tier as a fresh row, so
//   the table doubles as the full historical ladder for any scope.
// ============================================================================

import {
  db,
  paperBetsTable,
  matchesTable,
  competitionConfigTable,
  modelDecisionAuditLogTable,
  complianceLogsTable,
  agentConfigTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const ANALYSIS_WINDOW_DAYS = 30;

async function readEnabledFlag(key: string): Promise<boolean> {
  const rows = await db.select({ value: agentConfigTable.value }).from(agentConfigTable).where(eq(agentConfigTable.key, key));
  const v = rows[0]?.value;
  if (v == null) return true;
  return v.toLowerCase() !== "false";
}

// ── Demotion thresholds ─────────────────────────────────────────────────────
const SEVERE_ROI_THRESHOLD = -0.25;
const SEVERE_ROI_MIN_SAMPLE = 10;

const ROI_ANOMALY_THRESHOLD = -0.15;
const ROI_ANOMALY_MIN_SAMPLE = 20;

const KELLY_GROWTH_NEGATIVE_THRESHOLD = -0.005;
const KELLY_GROWTH_MIN_SAMPLE = 30;

const COVERAGE_GAP_THRESHOLD = 0.2;
const COVERAGE_GAP_MIN_SAMPLE = 5;

// ── Promotion thresholds ────────────────────────────────────────────────────
const SHADOW_EDGE_THRESHOLD = 0.005; // log-growth per bet
const SHADOW_EDGE_MIN_SAMPLE = 50;

const TRIAL_RECOVERY_THRESHOLD = 0.005;
const TRIAL_RECOVERY_MIN_SAMPLE = 20;

const STANDARD_RECOVERY_THRESHOLD = 0.005;
const STANDARD_RECOVERY_MIN_SAMPLE = 30;

const BOOST_KELLY_GROWTH_THRESHOLD = 0.01;
const BOOST_ROI_THRESHOLD = 0.1;
const BOOST_MIN_SAMPLE = 50;

// ── Tier definitions ────────────────────────────────────────────────────────
type Tier = "SHADOW_ONLY" | "TRIAL" | "STANDARD_REDUCED" | "DEFAULT" | "BOOSTED";

const TIER_ORDER: Record<Tier, number> = {
  SHADOW_ONLY: 0,
  TRIAL: 1,
  STANDARD_REDUCED: 2,
  DEFAULT: 3,
  BOOSTED: 4,
};

function tierFromOverride(override: number | null): Tier {
  if (override === null || override === undefined) return "DEFAULT";
  if (override === 0) return "SHADOW_ONLY";
  if (override <= 0.3) return "TRIAL";
  if (override <= 0.6) return "STANDARD_REDUCED";
  if (override > 1.0) return "BOOSTED";
  return "DEFAULT";
}

function overrideFromTier(tier: Tier): number | null {
  switch (tier) {
    case "SHADOW_ONLY":
      return 0;
    case "TRIAL":
      return 0.25;
    case "STANDARD_REDUCED":
      return 0.5;
    case "DEFAULT":
      return null;
    case "BOOSTED":
      return 1.5;
  }
}

function nextLowerTier(tier: Tier): Tier {
  switch (tier) {
    case "BOOSTED":
      return "DEFAULT";
    case "DEFAULT":
      return "STANDARD_REDUCED";
    case "STANDARD_REDUCED":
      return "TRIAL";
    case "TRIAL":
    case "SHADOW_ONLY":
      return "SHADOW_ONLY";
  }
}

function durationDaysForTier(tier: Tier, severity: "severe" | "standard"): number {
  if (tier === "SHADOW_ONLY") return severity === "severe" ? 30 : 90;
  if (tier === "TRIAL") return 14;
  if (tier === "STANDARD_REDUCED") return 14;
  if (tier === "BOOSTED") return 30; // boosted re-evaluation
  return 30;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface SelfAuditResult {
  scopesAnalyzed: number;
  observationsLogged: number;
  promotions: number;
  demotions: number;
  unchanged: number;
  durationMs: number;
}

interface ScopeStats {
  scope_value: string;
  // Real-stake metrics
  real_count: number;
  real_stake: number;
  real_pnl: number;
  real_roi: number | null;
  log_growth_per_bet: number | null; // real-bet log-growth
  clv_measured: number;
  coverage_rate: number | null;
  // Shadow metrics (the upward-path evidence)
  shadow_count: number;
  shadow_stake_total: number;
  shadow_pnl_total: number;
  shadow_log_growth_per_bet: number | null;
}

interface TierDecision {
  fromTier: Tier;
  toTier: Tier;
  reason: string;
  metricType: "roi" | "kelly_growth" | "clv_coverage" | "shadow_kelly_growth";
  metricValue: number;
  thresholdValue: number;
  sampleSize: number;
  durationDays: number;
  direction: "promotion" | "demotion";
}

// ── Public entry point ──────────────────────────────────────────────────────

export async function runModelSelfAudit(): Promise<SelfAuditResult> {
  const startedAt = Date.now();
  logger.info("Model self-audit (tier-ladder) starting");

  const result: SelfAuditResult = {
    scopesAnalyzed: 0,
    observationsLogged: 0,
    promotions: 0,
    demotions: 0,
    unchanged: 0,
    durationMs: 0,
  };

  // Phase 3 Track A kill switch (2026-05-08): modelSelfAudit suspended. This
  // cron fired 4 wrongful demotions on 2026-05-08 03:30 (3 of which hit
  // profitable scopes) using the same broken Kelly-growth proxy as Z4 — the
  // AVG(LN(GREATEST(0.0001, 1 + pnl/stake))) formula on lines 240/268/296/324.
  // Re-enable only after metric is rebuilt. See plan §1.4 / §3 Track A.
  const enabled = await readEnabledFlag("model_self_audit_enabled");
  if (!enabled) {
    logger.info("Model self-audit skipped (model_self_audit_enabled=false)");
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  await analyzeMarketScope(result);
  await analyzeLeagueMarketScope(result);
  await analyzeLeagueScope(result);
  await analyzeArchetypeScope(result);

  result.durationMs = Date.now() - startedAt;
  logger.info(result, "Model self-audit complete");

  await db
    .insert(complianceLogsTable)
    .values({
      actionType: "model_self_audit",
      details: result as unknown as Record<string, unknown>,
      timestamp: new Date(),
    })
    .catch(() => {});

  return result;
}

// ── Analysis passes (one per scope shape) ───────────────────────────────────

async function analyzeMarketScope(result: SelfAuditResult): Promise<void> {
  const rows = await db.execute(sql`
    SELECT
      pb.market_type AS scope_value,
      COUNT(*) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0) AS real_count,
      ROUND(COALESCE(SUM(pb.stake::numeric) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0), 0), 2) AS real_stake,
      ROUND(COALESCE(SUM(pb.settlement_pnl::numeric) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0), 0), 2) AS real_pnl,
      AVG(LN(GREATEST(0.0001, 1 + (pb.settlement_pnl::numeric / NULLIF(pb.stake::numeric, 0)))))
        FILTER (WHERE pb.stake::numeric > 0 AND (pb.shadow_stake IS NULL OR pb.shadow_stake = 0)) AS log_growth_per_bet,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL AND (pb.shadow_stake IS NULL OR pb.shadow_stake = 0)) AS clv_measured,
      COUNT(*) FILTER (WHERE pb.shadow_stake > 0) AS shadow_count,
      ROUND(COALESCE(SUM(pb.shadow_stake::numeric) FILTER (WHERE pb.shadow_stake > 0), 0), 2) AS shadow_stake_total,
      ROUND(COALESCE(SUM(pb.shadow_pnl::numeric) FILTER (WHERE pb.shadow_stake > 0), 0), 2) AS shadow_pnl_total,
      AVG(LN(GREATEST(0.0001, 1 + (pb.shadow_pnl::numeric / NULLIF(pb.shadow_stake::numeric, 0)))))
        FILTER (WHERE pb.shadow_stake::numeric > 0 AND pb.shadow_pnl IS NOT NULL) AS shadow_log_growth_per_bet
    FROM paper_bets pb
    WHERE pb.deleted_at IS NULL
      AND pb.legacy_regime = false
      AND pb.status IN ('won','lost')
      AND pb.placed_at >= NOW() - (${ANALYSIS_WINDOW_DAYS}::int * INTERVAL '1 day')
    GROUP BY pb.market_type
    HAVING COUNT(*) >= 5
  `);
  for (const r of (rows as any).rows ?? []) {
    await processScope("market", normaliseStats(r), result);
  }
}

async function analyzeLeagueMarketScope(result: SelfAuditResult): Promise<void> {
  const rows = await db.execute(sql`
    SELECT
      m.league || ':' || pb.market_type AS scope_value,
      COUNT(*) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0) AS real_count,
      ROUND(COALESCE(SUM(pb.stake::numeric) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0), 0), 2) AS real_stake,
      ROUND(COALESCE(SUM(pb.settlement_pnl::numeric) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0), 0), 2) AS real_pnl,
      AVG(LN(GREATEST(0.0001, 1 + (pb.settlement_pnl::numeric / NULLIF(pb.stake::numeric, 0)))))
        FILTER (WHERE pb.stake::numeric > 0 AND (pb.shadow_stake IS NULL OR pb.shadow_stake = 0)) AS log_growth_per_bet,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL AND (pb.shadow_stake IS NULL OR pb.shadow_stake = 0)) AS clv_measured,
      COUNT(*) FILTER (WHERE pb.shadow_stake > 0) AS shadow_count,
      ROUND(COALESCE(SUM(pb.shadow_stake::numeric) FILTER (WHERE pb.shadow_stake > 0), 0), 2) AS shadow_stake_total,
      ROUND(COALESCE(SUM(pb.shadow_pnl::numeric) FILTER (WHERE pb.shadow_stake > 0), 0), 2) AS shadow_pnl_total,
      AVG(LN(GREATEST(0.0001, 1 + (pb.shadow_pnl::numeric / NULLIF(pb.shadow_stake::numeric, 0)))))
        FILTER (WHERE pb.shadow_stake::numeric > 0 AND pb.shadow_pnl IS NOT NULL) AS shadow_log_growth_per_bet
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
      AND pb.status IN ('won','lost')
      AND pb.placed_at >= NOW() - (${ANALYSIS_WINDOW_DAYS}::int * INTERVAL '1 day')
    GROUP BY m.league, pb.market_type
    HAVING COUNT(*) >= 5
  `);
  for (const r of (rows as any).rows ?? []) {
    await processScope("league_market", normaliseStats(r), result);
  }
}

async function analyzeLeagueScope(result: SelfAuditResult): Promise<void> {
  const rows = await db.execute(sql`
    SELECT
      m.league AS scope_value,
      COUNT(*) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0) AS real_count,
      ROUND(COALESCE(SUM(pb.stake::numeric) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0), 0), 2) AS real_stake,
      ROUND(COALESCE(SUM(pb.settlement_pnl::numeric) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0), 0), 2) AS real_pnl,
      AVG(LN(GREATEST(0.0001, 1 + (pb.settlement_pnl::numeric / NULLIF(pb.stake::numeric, 0)))))
        FILTER (WHERE pb.stake::numeric > 0 AND (pb.shadow_stake IS NULL OR pb.shadow_stake = 0)) AS log_growth_per_bet,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL AND (pb.shadow_stake IS NULL OR pb.shadow_stake = 0)) AS clv_measured,
      COUNT(*) FILTER (WHERE pb.shadow_stake > 0) AS shadow_count,
      ROUND(COALESCE(SUM(pb.shadow_stake::numeric) FILTER (WHERE pb.shadow_stake > 0), 0), 2) AS shadow_stake_total,
      ROUND(COALESCE(SUM(pb.shadow_pnl::numeric) FILTER (WHERE pb.shadow_stake > 0), 0), 2) AS shadow_pnl_total,
      AVG(LN(GREATEST(0.0001, 1 + (pb.shadow_pnl::numeric / NULLIF(pb.shadow_stake::numeric, 0)))))
        FILTER (WHERE pb.shadow_stake::numeric > 0 AND pb.shadow_pnl IS NOT NULL) AS shadow_log_growth_per_bet
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
      AND pb.status IN ('won','lost')
      AND pb.placed_at >= NOW() - (${ANALYSIS_WINDOW_DAYS}::int * INTERVAL '1 day')
    GROUP BY m.league
    HAVING COUNT(*) >= 10
  `);
  for (const r of (rows as any).rows ?? []) {
    await processScope("league", normaliseStats(r), result);
  }
}

async function analyzeArchetypeScope(result: SelfAuditResult): Promise<void> {
  const rows = await db.execute(sql`
    SELECT
      COALESCE(cc.archetype, 'unmapped') AS scope_value,
      COUNT(*) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0) AS real_count,
      ROUND(COALESCE(SUM(pb.stake::numeric) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0), 0), 2) AS real_stake,
      ROUND(COALESCE(SUM(pb.settlement_pnl::numeric) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0), 0), 2) AS real_pnl,
      AVG(LN(GREATEST(0.0001, 1 + (pb.settlement_pnl::numeric / NULLIF(pb.stake::numeric, 0)))))
        FILTER (WHERE pb.stake::numeric > 0 AND (pb.shadow_stake IS NULL OR pb.shadow_stake = 0)) AS log_growth_per_bet,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL AND (pb.shadow_stake IS NULL OR pb.shadow_stake = 0)) AS clv_measured,
      COUNT(*) FILTER (WHERE pb.shadow_stake > 0) AS shadow_count,
      ROUND(COALESCE(SUM(pb.shadow_stake::numeric) FILTER (WHERE pb.shadow_stake > 0), 0), 2) AS shadow_stake_total,
      ROUND(COALESCE(SUM(pb.shadow_pnl::numeric) FILTER (WHERE pb.shadow_stake > 0), 0), 2) AS shadow_pnl_total,
      AVG(LN(GREATEST(0.0001, 1 + (pb.shadow_pnl::numeric / NULLIF(pb.shadow_stake::numeric, 0)))))
        FILTER (WHERE pb.shadow_stake::numeric > 0 AND pb.shadow_pnl IS NOT NULL) AS shadow_log_growth_per_bet
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    LEFT JOIN competition_config cc ON cc.name = m.league
    WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
      AND pb.status IN ('won','lost')
      AND pb.placed_at >= NOW() - (${ANALYSIS_WINDOW_DAYS}::int * INTERVAL '1 day')
    GROUP BY COALESCE(cc.archetype, 'unmapped')
    HAVING COUNT(*) >= 10
  `);
  for (const r of (rows as any).rows ?? []) {
    await processScope("archetype", normaliseStats(r), result);
  }
}

function normaliseStats(r: Record<string, unknown>): ScopeStats {
  const realCount = Number(r["real_count"] ?? 0);
  const realStake = Number(r["real_stake"] ?? 0);
  const realPnl = Number(r["real_pnl"] ?? 0);
  const logGrowthRaw = r["log_growth_per_bet"];
  const shadowCount = Number(r["shadow_count"] ?? 0);
  const shadowStakeTotal = Number(r["shadow_stake_total"] ?? 0);
  const shadowPnlTotal = Number(r["shadow_pnl_total"] ?? 0);
  const shadowLogRaw = r["shadow_log_growth_per_bet"];
  const clvMeasured = Number(r["clv_measured"] ?? 0);

  return {
    scope_value: String(r["scope_value"] ?? "unknown"),
    real_count: realCount,
    real_stake: realStake,
    real_pnl: realPnl,
    real_roi: realStake > 0 ? realPnl / realStake : null,
    log_growth_per_bet:
      logGrowthRaw === null || logGrowthRaw === undefined ? null : Number(logGrowthRaw),
    clv_measured: clvMeasured,
    coverage_rate: realCount > 0 ? clvMeasured / realCount : null,
    shadow_count: shadowCount,
    shadow_stake_total: shadowStakeTotal,
    shadow_pnl_total: shadowPnlTotal,
    shadow_log_growth_per_bet:
      shadowLogRaw === null || shadowLogRaw === undefined ? null : Number(shadowLogRaw),
  };
}

// ── Per-scope tier decision and persistence ─────────────────────────────────

async function processScope(
  scopeType: "market" | "league_market" | "league" | "archetype",
  stats: ScopeStats,
  result: SelfAuditResult,
): Promise<void> {
  result.scopesAnalyzed++;

  // Find current active tier (most recent unresolved row)
  const activeRows = await db.execute(sql`
    SELECT id, kelly_fraction_override::text AS override
    FROM autonomous_pauses
    WHERE scope_type = ${scopeType}
      AND scope_value = ${stats.scope_value}
      AND resumed_at IS NULL
    ORDER BY paused_at DESC
    LIMIT 1
  `);
  const activeRow = ((activeRows as any).rows ?? [])[0];
  const currentOverride =
    activeRow?.override === undefined || activeRow?.override === null
      ? null
      : Number(activeRow.override);
  const currentTier = tierFromOverride(currentOverride);

  const decision = decideTier(currentTier, stats);

  if (!decision) {
    // No transition warranted — log observation and move on
    await db
      .insert(modelDecisionAuditLogTable)
      .values({
        decisionType: "self_audit_observation",
        subject: `${scopeType}:${stats.scope_value}`,
        priorState: { tier: currentTier, kelly_fraction_override: currentOverride } as any,
        newState: { tier: currentTier, kelly_fraction_override: currentOverride } as any,
        reasoning: `${scopeType} ${stats.scope_value} stays at ${currentTier} (real n=${stats.real_count}, ROI=${formatPct(stats.real_roi)}, kelly_growth=${formatNum(stats.log_growth_per_bet)}/bet, shadow n=${stats.shadow_count}, shadow_kelly_growth=${formatNum(stats.shadow_log_growth_per_bet)}/bet)`,
        supportingMetrics: { ...stats } as any,
        reviewStatus: "automatic",
      })
      .catch(() => {});
    result.observationsLogged++;
    result.unchanged++;
    return;
  }

  // Persist transition: supersede prior active row, INSERT new tier
  if (activeRow?.id) {
    await db.execute(sql`
      UPDATE autonomous_pauses SET resumed_at = NOW()
      WHERE id = ${activeRow.id}
    `);
  }

  const auditRows = await db
    .insert(modelDecisionAuditLogTable)
    .values({
      decisionType: decisionTypeFor(decision),
      subject: `${scopeType}:${stats.scope_value}`,
      priorState: {
        tier: decision.fromTier,
        kelly_fraction_override: overrideFromTier(decision.fromTier),
      } as any,
      newState: {
        tier: decision.toTier,
        kelly_fraction_override: overrideFromTier(decision.toTier),
        duration_days: decision.durationDays,
      } as any,
      reasoning: buildReasoning(scopeType, stats, decision),
      supportingMetrics: {
        scope_type: scopeType,
        scope_value: stats.scope_value,
        ...stats,
        threshold: decision.thresholdValue,
        observed: decision.metricValue,
      } as any,
      expectedImpact: estimateExpectedImpact(stats, decision),
      reviewStatus: "automatic",
    })
    .returning({ id: modelDecisionAuditLogTable.id });

  const auditLogId = auditRows[0]?.id ?? null;
  const newOverride = overrideFromTier(decision.toTier);

  if (decision.toTier === "DEFAULT") {
    // Returning to DEFAULT just supersedes — no new active row needed.
    // No-op besides the audit-log row already written.
  } else {
    await db.execute(sql`
      INSERT INTO autonomous_pauses (
        scope_type, scope_value, paused_until,
        reason, metric_type, metric_value, threshold_value, sample_size,
        kelly_fraction_override, pause_duration_days, escalation_level, audit_log_id
      ) VALUES (
        ${scopeType},
        ${stats.scope_value},
        NOW() + (${decision.durationDays}::int * INTERVAL '1 day'),
        ${decision.reason},
        ${decision.metricType},
        ${decision.metricValue},
        ${decision.thresholdValue},
        ${decision.sampleSize},
        ${newOverride},
        ${decision.durationDays},
        1,
        ${auditLogId}
      )
    `);
  }

  if (decision.direction === "promotion") result.promotions++;
  else result.demotions++;

  logger.info(
    {
      scopeType,
      scopeValue: stats.scope_value,
      from: decision.fromTier,
      to: decision.toTier,
      reason: decision.reason,
      direction: decision.direction,
    },
    `Self-audit ${decision.direction}`,
  );
}

// ── Decision logic ──────────────────────────────────────────────────────────

function decideTier(currentTier: Tier, stats: ScopeStats): TierDecision | null {
  // ===== Demotion priority (capital protection first) =====

  // Severe ROI: drop straight to SHADOW_ONLY regardless of current tier
  if (
    stats.real_count >= SEVERE_ROI_MIN_SAMPLE &&
    stats.real_roi !== null &&
    stats.real_roi < SEVERE_ROI_THRESHOLD &&
    currentTier !== "SHADOW_ONLY"
  ) {
    return {
      fromTier: currentTier,
      toTier: "SHADOW_ONLY",
      reason: "SEVERE_ROI_ANOMALY",
      metricType: "roi",
      metricValue: stats.real_roi,
      thresholdValue: SEVERE_ROI_THRESHOLD,
      sampleSize: stats.real_count,
      durationDays: durationDaysForTier("SHADOW_ONLY", "severe"),
      direction: "demotion",
    };
  }

  // Coverage gap: structural data deficit, drop to SHADOW_ONLY
  if (
    stats.real_count >= COVERAGE_GAP_MIN_SAMPLE &&
    stats.coverage_rate !== null &&
    stats.coverage_rate < COVERAGE_GAP_THRESHOLD &&
    currentTier !== "SHADOW_ONLY"
  ) {
    return {
      fromTier: currentTier,
      toTier: "SHADOW_ONLY",
      reason: "DATA_COVERAGE_GAP",
      metricType: "clv_coverage",
      metricValue: stats.coverage_rate,
      thresholdValue: COVERAGE_GAP_THRESHOLD,
      sampleSize: stats.real_count,
      durationDays: durationDaysForTier("SHADOW_ONLY", "standard"),
      direction: "demotion",
    };
  }

  // Standard ROI demotion: one rung down
  if (
    stats.real_count >= ROI_ANOMALY_MIN_SAMPLE &&
    stats.real_roi !== null &&
    stats.real_roi < ROI_ANOMALY_THRESHOLD &&
    currentTier !== "SHADOW_ONLY"
  ) {
    const target = nextLowerTier(currentTier);
    return {
      fromTier: currentTier,
      toTier: target,
      reason: "ROI_ANOMALY",
      metricType: "roi",
      metricValue: stats.real_roi,
      thresholdValue: ROI_ANOMALY_THRESHOLD,
      sampleSize: stats.real_count,
      durationDays: durationDaysForTier(target, "standard"),
      direction: "demotion",
    };
  }

  // Kelly-growth demotion: one rung down on log-growth
  if (
    stats.real_count >= KELLY_GROWTH_MIN_SAMPLE &&
    stats.log_growth_per_bet !== null &&
    stats.log_growth_per_bet < KELLY_GROWTH_NEGATIVE_THRESHOLD &&
    currentTier !== "SHADOW_ONLY"
  ) {
    const target = nextLowerTier(currentTier);
    return {
      fromTier: currentTier,
      toTier: target,
      reason: "KELLY_GROWTH_ANOMALY",
      metricType: "kelly_growth",
      metricValue: stats.log_growth_per_bet,
      thresholdValue: KELLY_GROWTH_NEGATIVE_THRESHOLD,
      sampleSize: stats.real_count,
      durationDays: durationDaysForTier(target, "standard"),
      direction: "demotion",
    };
  }

  // ===== Promotion ladder (positive evidence) =====

  // SHADOW_ONLY → TRIAL: shadow Kelly-growth shows edge even without CLV.
  // This is the architectural primitive — shadow data is the upward path's
  // evidence, lets the model rediscover edge on previously-failed scopes.
  if (
    currentTier === "SHADOW_ONLY" &&
    stats.shadow_count >= SHADOW_EDGE_MIN_SAMPLE &&
    stats.shadow_log_growth_per_bet !== null &&
    stats.shadow_log_growth_per_bet > SHADOW_EDGE_THRESHOLD
  ) {
    return {
      fromTier: currentTier,
      toTier: "TRIAL",
      reason: "SHADOW_EDGE_PROMOTION",
      metricType: "shadow_kelly_growth",
      metricValue: stats.shadow_log_growth_per_bet,
      thresholdValue: SHADOW_EDGE_THRESHOLD,
      sampleSize: stats.shadow_count,
      durationDays: durationDaysForTier("TRIAL", "standard"),
      direction: "promotion",
    };
  }

  // TRIAL → STANDARD_REDUCED: real-stake at quarter-Kelly is recovering
  if (
    currentTier === "TRIAL" &&
    stats.real_count >= TRIAL_RECOVERY_MIN_SAMPLE &&
    stats.log_growth_per_bet !== null &&
    stats.log_growth_per_bet > TRIAL_RECOVERY_THRESHOLD
  ) {
    return {
      fromTier: currentTier,
      toTier: "STANDARD_REDUCED",
      reason: "TRIAL_RECOVERY",
      metricType: "kelly_growth",
      metricValue: stats.log_growth_per_bet,
      thresholdValue: TRIAL_RECOVERY_THRESHOLD,
      sampleSize: stats.real_count,
      durationDays: durationDaysForTier("STANDARD_REDUCED", "standard"),
      direction: "promotion",
    };
  }

  // STANDARD_REDUCED → DEFAULT: full Kelly restored
  if (
    currentTier === "STANDARD_REDUCED" &&
    stats.real_count >= STANDARD_RECOVERY_MIN_SAMPLE &&
    stats.log_growth_per_bet !== null &&
    stats.log_growth_per_bet > STANDARD_RECOVERY_THRESHOLD
  ) {
    return {
      fromTier: currentTier,
      toTier: "DEFAULT",
      reason: "STANDARD_RECOVERY",
      metricType: "kelly_growth",
      metricValue: stats.log_growth_per_bet,
      thresholdValue: STANDARD_RECOVERY_THRESHOLD,
      sampleSize: stats.real_count,
      durationDays: 0,
      direction: "promotion",
    };
  }

  // DEFAULT → BOOSTED: high-confidence amplification
  if (
    currentTier === "DEFAULT" &&
    stats.real_count >= BOOST_MIN_SAMPLE &&
    stats.log_growth_per_bet !== null &&
    stats.log_growth_per_bet > BOOST_KELLY_GROWTH_THRESHOLD &&
    stats.real_roi !== null &&
    stats.real_roi > BOOST_ROI_THRESHOLD
  ) {
    return {
      fromTier: currentTier,
      toTier: "BOOSTED",
      reason: "BOOSTED_EDGE",
      metricType: "kelly_growth",
      metricValue: stats.log_growth_per_bet,
      thresholdValue: BOOST_KELLY_GROWTH_THRESHOLD,
      sampleSize: stats.real_count,
      durationDays: durationDaysForTier("BOOSTED", "standard"),
      direction: "promotion",
    };
  }

  return null;
}

// ── Reporting helpers ───────────────────────────────────────────────────────

function decisionTypeFor(decision: TierDecision): string {
  if (decision.direction === "promotion") {
    if (decision.fromTier === "SHADOW_ONLY") return "tier_promoted_from_shadow";
    if (decision.toTier === "BOOSTED") return "tier_boosted";
    return "tier_promoted";
  }
  if (decision.toTier === "SHADOW_ONLY") return "tier_demoted_to_shadow";
  return "tier_demoted";
}

function buildReasoning(
  scopeType: string,
  stats: ScopeStats,
  decision: TierDecision,
): string {
  const arrow = decision.direction === "promotion" ? "↑" : "↓";
  return `${scopeType} ${stats.scope_value} ${arrow} ${decision.fromTier} → ${decision.toTier} (${decision.reason}). real n=${stats.real_count} ROI=${formatPct(stats.real_roi)} kelly_growth=${formatNum(stats.log_growth_per_bet)}/bet | shadow n=${stats.shadow_count} kelly_growth=${formatNum(stats.shadow_log_growth_per_bet)}/bet | clv_coverage=${formatPct(stats.coverage_rate)}. Threshold ${decision.thresholdValue} ${decision.metricType}.`;
}

function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "n/a";
  return `${(v * 100).toFixed(2)}%`;
}

function formatNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "n/a";
  return v.toFixed(4);
}

function estimateExpectedImpact(
  stats: ScopeStats,
  decision: TierDecision,
): string | null {
  if (decision.direction === "promotion") {
    return null; // expected positive but uncertain magnitude
  }
  if (stats.real_count <= 0) return null;
  const projected = -(stats.real_pnl / stats.real_count);
  return projected.toFixed(4);
}

// ── Placement-time check ────────────────────────────────────────────────────

export interface PauseCheckResult {
  paused: boolean;
  pauseRow: {
    scopeType: string;
    scopeValue: string;
    reason: string;
    pausedUntil: string;
  } | null;
  kellyFractionOverride: number | null;
}

export async function checkAutonomousPauses(params: {
  marketType: string;
  league: string | null;
  archetype: string | null;
  isShadowBet: boolean;
}): Promise<PauseCheckResult> {
  // Shadow bets bypass tier-based capital gates entirely. The model needs
  // continuous shadow capture across all markets/leagues to feed the
  // upward-promotion path.
  if (params.isShadowBet) {
    return { paused: false, pauseRow: null, kellyFractionOverride: null };
  }

  const scopeKeys: Array<{ type: string; value: string }> = [
    { type: "market", value: params.marketType },
  ];
  if (params.league) {
    scopeKeys.push({
      type: "league_market",
      value: `${params.league}:${params.marketType}`,
    });
    scopeKeys.push({ type: "league", value: params.league });
  }
  if (params.archetype) {
    scopeKeys.push({ type: "archetype", value: params.archetype });
  }

  const conditions = scopeKeys
    .map(
      (k) =>
        `(scope_type = '${k.type.replace(/'/g, "''")}' AND scope_value = '${k.value.replace(/'/g, "''")}')`,
    )
    .join(" OR ");

  // If multiple scopes match, take the MOST RESTRICTIVE override (lowest
  // kelly_fraction). This composes the demotion logic — a scope demoted at
  // market level is not "rescued" by a non-demoted league.
  const rows = await db.execute(sql.raw(`
    SELECT scope_type, scope_value, reason, paused_until::text AS paused_until,
           kelly_fraction_override::text AS kelly_fraction_override
    FROM autonomous_pauses
    WHERE resumed_at IS NULL
      AND (${conditions})
  `));

  const candidates = ((rows as any).rows ?? []) as Array<{
    scope_type: string;
    scope_value: string;
    reason: string;
    paused_until: string;
    kelly_fraction_override: string | null;
  }>;

  if (candidates.length === 0) {
    return { paused: false, pauseRow: null, kellyFractionOverride: null };
  }

  // Pick most restrictive: lowest kelly_fraction_override (treating null as
  // no constraint = 1.0). Override of 0 = SHADOW_ONLY = fully blocked.
  let mostRestrictive = candidates[0]!;
  let mostRestrictiveOverride =
    mostRestrictive.kelly_fraction_override === null
      ? 1.0
      : Number(mostRestrictive.kelly_fraction_override);
  for (const c of candidates) {
    const k = c.kelly_fraction_override === null ? 1.0 : Number(c.kelly_fraction_override);
    if (k < mostRestrictiveOverride) {
      mostRestrictive = c;
      mostRestrictiveOverride = k;
    }
  }

  const fullyPaused = mostRestrictiveOverride === 0;

  return {
    paused: fullyPaused,
    pauseRow: {
      scopeType: mostRestrictive.scope_type,
      scopeValue: mostRestrictive.scope_value,
      reason: mostRestrictive.reason,
      pausedUntil: mostRestrictive.paused_until,
    },
    kellyFractionOverride: mostRestrictiveOverride,
  };
}
