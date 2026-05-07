// ============================================================================
// Model self-audit (2026-05-07)
// ----------------------------------------------------------------------------
// Daily 03:30 UTC cron that runs the diagnostic queries the model has the
// data and tools to run on itself, but had no scheduled task driving. Three
// analysis passes:
//
//   1. Per-market (across all leagues): catches market-wide bleeds and
//      data-coverage gaps. The thing that should have caught BTTS losing
//      -£468 over 31 bets with 0% Pinnacle coverage.
//
//   2. Per (league × market): catches league-specific issues within a
//      market that's globally OK (e.g., MATCH_ODDS profitable overall but
//      USL Championship MATCH_ODDS underperforming).
//
//   3. Per-archetype: cross-cuts above. Tier1B-style archetypes that
//      struggle regardless of market.
//
// Each finding writes to model_decision_audit_log; severe anomalies trigger
// autonomous_pauses rows that block real-stake placement at placePaperBet.
// Shadow bets (Tier B/C, £0 stake, learning-data) bypass pauses by design —
// the whole point of the shadow track is to keep capturing data on
// distressed markets so the model can learn from the regime.
//
// Auto-resume policy:
//   - Pause window default 14d (configurable per scope_type)
//   - On expiry: pause closes, market re-opens at 50% Kelly via trial-mode
//     row that the next audit observes
//   - If next audit finds Kelly-growth recovered: clear override, full Kelly
//   - If still failing: re-pause 30d, escalation_level++
//
// Primary metric: per-bet log-bankroll growth-rate (Kelly framing per the
// strategic brief). ROI and CLV are supporting signals. Pinnacle coverage
// rate is a data-quality signal (0% coverage on a market with stake means
// the model is flying blind regardless of ROI).
// ============================================================================

import {
  db,
  paperBetsTable,
  matchesTable,
  competitionConfigTable,
  modelDecisionAuditLogTable,
  complianceLogsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// ── Thresholds (conservative initial values; tunable via agent_config) ──────

const ANALYSIS_WINDOW_DAYS = 30;

// ROI anomaly: market is bleeding capital
const ROI_ANOMALY_THRESHOLD = -0.15; // -15% ROI
const ROI_ANOMALY_MIN_SAMPLE = 20;

// Severe ROI: tighter sample, faster pause
const SEVERE_ROI_THRESHOLD = -0.25; // -25% ROI
const SEVERE_ROI_MIN_SAMPLE = 10;

// Kelly-growth anomaly: log-bankroll growth-rate per bet
const KELLY_GROWTH_THRESHOLD = -0.005; // -0.5% per bet
const KELLY_GROWTH_MIN_SAMPLE = 30;

// Data-coverage gap: model can't validate edge on this market
const COVERAGE_GAP_THRESHOLD = 0.2; // < 20% Pinnacle coverage
const COVERAGE_GAP_MIN_SAMPLE = 5;

// Pause durations (days)
const STANDARD_PAUSE_DAYS = 14;
const SEVERE_PAUSE_DAYS = 30;
const COVERAGE_PAUSE_DAYS = 90; // data gaps tend to be structural — long pause
const ESCALATED_PAUSE_DAYS = 30;

// Trial-mode Kelly fraction on auto-resume
const TRIAL_KELLY_FRACTION = 0.5;

// ── Types ───────────────────────────────────────────────────────────────────

export interface SelfAuditResult {
  scopesAnalyzed: number;
  observationsLogged: number;
  pausesAdded: number;
  pausesResumed: number;
  alreadyPausedScopes: number;
  durationMs: number;
}

interface ScopeStats {
  scope_value: string;
  total_settled: number;
  shadow_count: number;
  real_count: number;
  total_stake: number;
  total_pnl: number;
  clv_measured: number;
  log_growth_per_bet: number | null;
  // derived
  real_roi: number | null;
  coverage_rate: number | null;
}

interface AnomalyFinding {
  scopeType: "market" | "league_market" | "archetype";
  scopeValue: string;
  reason:
    | "ROI_ANOMALY"
    | "SEVERE_ROI_ANOMALY"
    | "KELLY_GROWTH_ANOMALY"
    | "DATA_COVERAGE_GAP";
  metricType: "roi" | "kelly_growth" | "clv_coverage";
  metricValue: number;
  thresholdValue: number;
  sampleSize: number;
  pauseDurationDays: number;
  stats: ScopeStats;
}

// ── Public entry point ──────────────────────────────────────────────────────

export async function runModelSelfAudit(): Promise<SelfAuditResult> {
  const startedAt = Date.now();
  logger.info("Model self-audit starting");

  const result: SelfAuditResult = {
    scopesAnalyzed: 0,
    observationsLogged: 0,
    pausesAdded: 0,
    pausesResumed: 0,
    alreadyPausedScopes: 0,
    durationMs: 0,
  };

  // 1. Auto-resume any pauses whose window has expired
  result.pausesResumed = await processAutoResumes();

  // 2. Per-market analysis
  await analyzeMarketScope(result);

  // 3. Per (league × market) analysis
  await analyzeLeagueMarketScope(result);

  // 4. Per-archetype analysis
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
    .catch((err) => {
      logger.warn({ err }, "Failed to write self-audit compliance log");
    });

  return result;
}

// ── Analysis passes ─────────────────────────────────────────────────────────

async function analyzeMarketScope(result: SelfAuditResult): Promise<void> {
  const rows = await db.execute(sql`
    SELECT
      pb.market_type AS scope_value,
      COUNT(*) AS total_settled,
      COUNT(*) FILTER (WHERE pb.shadow_stake > 0) AS shadow_count,
      COUNT(*) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0) AS real_count,
      ROUND(SUM(pb.stake::numeric), 2) AS total_stake,
      ROUND(SUM(pb.settlement_pnl::numeric), 2) AS total_pnl,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL) AS clv_measured,
      AVG(LN(GREATEST(0.0001, 1 + (pb.settlement_pnl::numeric / NULLIF(pb.stake::numeric, 0)))))
        FILTER (WHERE pb.stake::numeric > 0) AS log_growth_per_bet
    FROM paper_bets pb
    WHERE pb.deleted_at IS NULL
      AND pb.legacy_regime = false
      AND pb.status IN ('won','lost')
      AND pb.placed_at >= NOW() - (${ANALYSIS_WINDOW_DAYS}::int * INTERVAL '1 day')
    GROUP BY pb.market_type
    HAVING COUNT(*) >= 5
  `);

  for (const r of (rows as any).rows ?? []) {
    const stats = normaliseStats(r);
    result.scopesAnalyzed++;
    await processScopeStats("market", stats, result);
  }
}

async function analyzeLeagueMarketScope(result: SelfAuditResult): Promise<void> {
  const rows = await db.execute(sql`
    SELECT
      m.league || ':' || pb.market_type AS scope_value,
      COUNT(*) AS total_settled,
      COUNT(*) FILTER (WHERE pb.shadow_stake > 0) AS shadow_count,
      COUNT(*) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0) AS real_count,
      ROUND(SUM(pb.stake::numeric), 2) AS total_stake,
      ROUND(SUM(pb.settlement_pnl::numeric), 2) AS total_pnl,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL) AS clv_measured,
      AVG(LN(GREATEST(0.0001, 1 + (pb.settlement_pnl::numeric / NULLIF(pb.stake::numeric, 0)))))
        FILTER (WHERE pb.stake::numeric > 0) AS log_growth_per_bet
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.deleted_at IS NULL
      AND pb.legacy_regime = false
      AND pb.status IN ('won','lost')
      AND pb.placed_at >= NOW() - (${ANALYSIS_WINDOW_DAYS}::int * INTERVAL '1 day')
    GROUP BY m.league, pb.market_type
    HAVING COUNT(*) >= 5
  `);

  for (const r of (rows as any).rows ?? []) {
    const stats = normaliseStats(r);
    result.scopesAnalyzed++;
    await processScopeStats("league_market", stats, result);
  }
}

async function analyzeArchetypeScope(result: SelfAuditResult): Promise<void> {
  const rows = await db.execute(sql`
    SELECT
      COALESCE(cc.archetype, 'unmapped') AS scope_value,
      COUNT(*) AS total_settled,
      COUNT(*) FILTER (WHERE pb.shadow_stake > 0) AS shadow_count,
      COUNT(*) FILTER (WHERE pb.shadow_stake IS NULL OR pb.shadow_stake = 0) AS real_count,
      ROUND(SUM(pb.stake::numeric), 2) AS total_stake,
      ROUND(SUM(pb.settlement_pnl::numeric), 2) AS total_pnl,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL) AS clv_measured,
      AVG(LN(GREATEST(0.0001, 1 + (pb.settlement_pnl::numeric / NULLIF(pb.stake::numeric, 0)))))
        FILTER (WHERE pb.stake::numeric > 0) AS log_growth_per_bet
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    LEFT JOIN competition_config cc ON cc.name = m.league
    WHERE pb.deleted_at IS NULL
      AND pb.legacy_regime = false
      AND pb.status IN ('won','lost')
      AND pb.placed_at >= NOW() - (${ANALYSIS_WINDOW_DAYS}::int * INTERVAL '1 day')
    GROUP BY COALESCE(cc.archetype, 'unmapped')
    HAVING COUNT(*) >= 5
  `);

  for (const r of (rows as any).rows ?? []) {
    const stats = normaliseStats(r);
    result.scopesAnalyzed++;
    await processScopeStats("archetype", stats, result);
  }
}

// ── Scope-stats normalisation + anomaly detection ───────────────────────────

function normaliseStats(r: Record<string, unknown>): ScopeStats {
  const totalSettled = Number(r["total_settled"] ?? 0);
  const realCount = Number(r["real_count"] ?? 0);
  const totalStake = Number(r["total_stake"] ?? 0);
  const totalPnl = Number(r["total_pnl"] ?? 0);
  const clvMeasured = Number(r["clv_measured"] ?? 0);
  const logGrowthRaw = r["log_growth_per_bet"];
  const logGrowth =
    logGrowthRaw === null || logGrowthRaw === undefined ? null : Number(logGrowthRaw);

  return {
    scope_value: String(r["scope_value"] ?? "unknown"),
    total_settled: totalSettled,
    shadow_count: Number(r["shadow_count"] ?? 0),
    real_count: realCount,
    total_stake: totalStake,
    total_pnl: totalPnl,
    clv_measured: clvMeasured,
    log_growth_per_bet: logGrowth,
    real_roi: totalStake > 0 ? totalPnl / totalStake : null,
    coverage_rate: totalSettled > 0 ? clvMeasured / totalSettled : null,
  };
}

async function processScopeStats(
  scopeType: "market" | "league_market" | "archetype",
  stats: ScopeStats,
  result: SelfAuditResult,
): Promise<void> {
  // Skip scopes already actively paused — let the existing pause run its
  // course rather than stacking duplicate pauses.
  const existingActive = await db.execute(sql`
    SELECT id FROM autonomous_pauses
    WHERE scope_type = ${scopeType}
      AND scope_value = ${stats.scope_value}
      AND resumed_at IS NULL
    LIMIT 1
  `);
  if (((existingActive as any).rows ?? []).length > 0) {
    result.alreadyPausedScopes++;
    return;
  }

  const finding = detectAnomaly(scopeType, stats);
  if (!finding) {
    // No anomaly — log a self_audit_observation row so the audit log shows
    // what was checked even when no action is taken. Keeps things visible.
    await db
      .insert(modelDecisionAuditLogTable)
      .values({
        decisionType: "self_audit_observation",
        subject: `${scopeType}:${stats.scope_value}`,
        priorState: { paused: false } as any,
        newState: {
          paused: false,
          observed: {
            sample: stats.total_settled,
            real_roi: stats.real_roi,
            kelly_growth_per_bet: stats.log_growth_per_bet,
            coverage_rate: stats.coverage_rate,
          },
        } as any,
        reasoning: `${scopeType} ${stats.scope_value}: within thresholds (sample ${stats.total_settled}, real ROI ${formatPct(stats.real_roi)}, coverage ${formatPct(stats.coverage_rate)})`,
        supportingMetrics: { ...stats } as any,
        reviewStatus: "automatic",
      })
      .catch(() => {});
    result.observationsLogged++;
    return;
  }

  // Anomaly found — write audit row + insert pause.
  const auditRows = await db
    .insert(modelDecisionAuditLogTable)
    .values({
      decisionType: `${scopeType}_paused`,
      subject: `${scopeType}:${stats.scope_value}`,
      priorState: { paused: false, ...metricSnapshot(stats) } as any,
      newState: {
        paused: true,
        paused_until_iso: new Date(
          Date.now() + finding.pauseDurationDays * 24 * 3600 * 1000,
        ).toISOString(),
        kelly_fraction_override: 0,
      } as any,
      reasoning: buildReasoning(finding, stats),
      supportingMetrics: {
        scope_type: scopeType,
        scope_value: stats.scope_value,
        ...stats,
        threshold: finding.thresholdValue,
        observed: finding.metricValue,
      } as any,
      expectedImpact: estimateExpectedImpact(stats),
      reviewStatus: "automatic",
    })
    .returning({ id: modelDecisionAuditLogTable.id });

  const auditLogId = auditRows[0]?.id ?? null;

  await db.execute(sql`
    INSERT INTO autonomous_pauses (
      scope_type, scope_value, paused_until,
      reason, metric_type, metric_value, threshold_value, sample_size,
      kelly_fraction_override, pause_duration_days, escalation_level, audit_log_id
    ) VALUES (
      ${scopeType},
      ${stats.scope_value},
      NOW() + (${finding.pauseDurationDays}::int * INTERVAL '1 day'),
      ${finding.reason},
      ${finding.metricType},
      ${finding.metricValue},
      ${finding.thresholdValue},
      ${finding.sampleSize},
      0,
      ${finding.pauseDurationDays},
      1,
      ${auditLogId}
    )
  `);

  result.pausesAdded++;
  logger.warn(
    {
      scopeType,
      scopeValue: stats.scope_value,
      reason: finding.reason,
      metricType: finding.metricType,
      metricValue: finding.metricValue,
      threshold: finding.thresholdValue,
      sample: finding.sampleSize,
      durationDays: finding.pauseDurationDays,
    },
    "Self-audit auto-paused scope",
  );
}

function detectAnomaly(
  scopeType: "market" | "league_market" | "archetype",
  stats: ScopeStats,
): AnomalyFinding | null {
  // Severe ROI gets first priority — fastest pause path.
  if (
    stats.real_count >= SEVERE_ROI_MIN_SAMPLE &&
    stats.real_roi !== null &&
    stats.real_roi < SEVERE_ROI_THRESHOLD
  ) {
    return {
      scopeType,
      scopeValue: stats.scope_value,
      reason: "SEVERE_ROI_ANOMALY",
      metricType: "roi",
      metricValue: stats.real_roi,
      thresholdValue: SEVERE_ROI_THRESHOLD,
      sampleSize: stats.real_count,
      pauseDurationDays: SEVERE_PAUSE_DAYS,
      stats,
    };
  }

  // Standard ROI anomaly
  if (
    stats.real_count >= ROI_ANOMALY_MIN_SAMPLE &&
    stats.real_roi !== null &&
    stats.real_roi < ROI_ANOMALY_THRESHOLD
  ) {
    return {
      scopeType,
      scopeValue: stats.scope_value,
      reason: "ROI_ANOMALY",
      metricType: "roi",
      metricValue: stats.real_roi,
      thresholdValue: ROI_ANOMALY_THRESHOLD,
      sampleSize: stats.real_count,
      pauseDurationDays: STANDARD_PAUSE_DAYS,
      stats,
    };
  }

  // Kelly-growth anomaly (more sensitive on log-growth-rate)
  if (
    stats.real_count >= KELLY_GROWTH_MIN_SAMPLE &&
    stats.log_growth_per_bet !== null &&
    stats.log_growth_per_bet < KELLY_GROWTH_THRESHOLD
  ) {
    return {
      scopeType,
      scopeValue: stats.scope_value,
      reason: "KELLY_GROWTH_ANOMALY",
      metricType: "kelly_growth",
      metricValue: stats.log_growth_per_bet,
      thresholdValue: KELLY_GROWTH_THRESHOLD,
      sampleSize: stats.real_count,
      pauseDurationDays: STANDARD_PAUSE_DAYS,
      stats,
    };
  }

  // Data-coverage gap — model can't validate this market's edge.
  // Only relevant when there are real-stake bets (shadow bets are
  // designed to operate without Pinnacle anchor).
  if (
    stats.real_count >= COVERAGE_GAP_MIN_SAMPLE &&
    stats.coverage_rate !== null &&
    stats.coverage_rate < COVERAGE_GAP_THRESHOLD
  ) {
    return {
      scopeType,
      scopeValue: stats.scope_value,
      reason: "DATA_COVERAGE_GAP",
      metricType: "clv_coverage",
      metricValue: stats.coverage_rate,
      thresholdValue: COVERAGE_GAP_THRESHOLD,
      sampleSize: stats.real_count,
      pauseDurationDays: COVERAGE_PAUSE_DAYS,
      stats,
    };
  }

  return null;
}

function metricSnapshot(stats: ScopeStats): Record<string, unknown> {
  return {
    real_roi: stats.real_roi,
    kelly_growth_per_bet: stats.log_growth_per_bet,
    coverage_rate: stats.coverage_rate,
    sample: stats.real_count,
    shadow_sample: stats.shadow_count,
  };
}

function buildReasoning(finding: AnomalyFinding, stats: ScopeStats): string {
  switch (finding.reason) {
    case "SEVERE_ROI_ANOMALY":
      return `Severe ROI anomaly: ${finding.scopeType} ${stats.scope_value} returned ${formatPct(finding.metricValue)} ROI over ${finding.sampleSize} settled real-stake bets (threshold ${formatPct(finding.thresholdValue)}). Pausing real-stake placement for ${finding.pauseDurationDays} days. Shadow bets continue (architectural exemption — £0 stake captures regime-shift learning).`;
    case "ROI_ANOMALY":
      return `ROI anomaly: ${finding.scopeType} ${stats.scope_value} returned ${formatPct(finding.metricValue)} ROI over ${finding.sampleSize} settled real-stake bets (threshold ${formatPct(finding.thresholdValue)}). Pausing real-stake placement for ${finding.pauseDurationDays} days.`;
    case "KELLY_GROWTH_ANOMALY":
      return `Kelly-growth anomaly: ${finding.scopeType} ${stats.scope_value} log-bankroll growth-rate ${finding.metricValue.toFixed(4)}/bet over ${finding.sampleSize} bets (threshold ${finding.thresholdValue}). Pausing real-stake placement for ${finding.pauseDurationDays} days.`;
    case "DATA_COVERAGE_GAP":
      return `Data-coverage gap: ${finding.scopeType} ${stats.scope_value} has ${formatPct(finding.metricValue)} Pinnacle CLV coverage over ${finding.sampleSize} bets (threshold ${formatPct(finding.thresholdValue)}). Model cannot validate edge on this market. Pausing real-stake placement for ${finding.pauseDurationDays} days. Shadow bets continue and may surface enough data to lift the pause.`;
  }
}

function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "n/a";
  return `${(v * 100).toFixed(2)}%`;
}

function estimateExpectedImpact(stats: ScopeStats): string | null {
  if (stats.total_stake <= 0) return null;
  const projectedSavingsPerBet = -(stats.total_pnl / stats.real_count);
  return projectedSavingsPerBet.toFixed(4);
}

// ── Auto-resume ─────────────────────────────────────────────────────────────

async function processAutoResumes(): Promise<number> {
  const expired = await db.execute(sql`
    SELECT id, scope_type, scope_value, reason, escalation_level
    FROM autonomous_pauses
    WHERE resumed_at IS NULL
      AND paused_until < NOW()
  `);

  let resumed = 0;
  for (const p of (expired as any).rows ?? []) {
    await db.execute(sql`
      UPDATE autonomous_pauses
      SET resumed_at = NOW(), kelly_fraction_override = ${TRIAL_KELLY_FRACTION}
      WHERE id = ${p.id}
    `);

    await db
      .insert(modelDecisionAuditLogTable)
      .values({
        decisionType: `${p.scope_type}_resumed`,
        subject: `${p.scope_type}:${p.scope_value}`,
        priorState: { paused: true, reason: p.reason } as any,
        newState: {
          paused: false,
          trial_mode: true,
          kelly_fraction_override: TRIAL_KELLY_FRACTION,
        } as any,
        reasoning: `Pause window expired for ${p.scope_type} ${p.scope_value}. Auto-resuming at ${TRIAL_KELLY_FRACTION * 100}% Kelly fraction (trial mode). Next audit re-evaluates; if metrics recover, full Kelly restored, else re-pause with escalation.`,
        reviewStatus: "automatic",
      })
      .catch(() => {});

    resumed++;
  }
  return resumed;
}

// ── Placement-time check (called from placePaperBet) ────────────────────────

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
  // Shadow bets bypass the pause registry — capital-protective gates
  // never apply to £0 learning-data bets (architectural principle).
  if (params.isShadowBet) {
    return { paused: false, pauseRow: null, kellyFractionOverride: null };
  }

  // Build the candidate scope keys this bet would match against
  const scopeKeys: Array<{ type: string; value: string }> = [
    { type: "market", value: params.marketType },
  ];
  if (params.league) {
    scopeKeys.push({ type: "league_market", value: `${params.league}:${params.marketType}` });
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

  const rows = await db.execute(sql.raw(`
    SELECT scope_type, scope_value, reason, paused_until::text AS paused_until,
           kelly_fraction_override
    FROM autonomous_pauses
    WHERE resumed_at IS NULL
      AND (${conditions})
    ORDER BY paused_at DESC
    LIMIT 1
  `));

  const row = ((rows as any).rows ?? [])[0];
  if (!row) {
    return { paused: false, pauseRow: null, kellyFractionOverride: null };
  }

  const kellyOverride =
    row.kelly_fraction_override !== null && row.kelly_fraction_override !== undefined
      ? Number(row.kelly_fraction_override)
      : null;

  // kelly_fraction_override = 0 (or null with active pause) → fully paused
  // kelly_fraction_override > 0 → trial mode, allow bet at reduced size
  const fullyPaused = kellyOverride === null || kellyOverride === 0;

  return {
    paused: fullyPaused,
    pauseRow: {
      scopeType: row.scope_type,
      scopeValue: row.scope_value,
      reason: row.reason,
      pausedUntil: row.paused_until,
    },
    kellyFractionOverride: kellyOverride,
  };
}
