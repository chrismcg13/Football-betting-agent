// Sub-phase 10: ongoing audit cron.
// Per docs/phase-2-subphase-10-plan.md.
//
// Weekly job that computes per-league settlement-bias z-scores from settled
// bets, writes observations to model_decision_audit_log, and conditionally
// auto-demotes leagues with two consecutive breaching observations
// (|bias_z| > 1.5). Feature-coverage summary stats logged for visibility.
//
// Auto-demote action is env-gated (ONGOING_AUDIT_AUTO_DEMOTE_ENABLED, default
// false) so the user can observe at least one week of bias readings before
// authorising the cron to actually move tiers. Mirrors the 6.5 flag-on
// pattern.

import { db } from "@workspace/db";
import { modelDecisionAuditLogTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const BIAS_THRESHOLD = 1.5;
const BIAS_LOOKBACK_DAYS = 30;
const BIAS_MIN_SAMPLE = 30;
const PRIOR_BREACH_LOOKBACK_DAYS = 14;

interface LeagueBias {
  league: string;
  nBets: number;
  actualWins: number;
  expectedWins: number;
  biasZ: number;
  breaching: boolean;
}

interface DemotionPlan {
  league: string;
  fromTier: string;
  toTier: string;
  currentBiasZ: number;
  priorBiasZ: number;
  priorObservedAt: string;
}

interface DemotionResult extends DemotionPlan {
  applied: boolean;
  reason?: string;
}

interface FeatureCoverageRow {
  league: string;
  upcomingMatches: number;
  avgFeaturesPerMatch: number;
}

export interface OngoingAuditOpts {
  dryRun?: boolean;
  lookbackDays?: number;
}

export interface OngoingAuditResult {
  observationsWritten: number;
  breachingLeagues: number;
  demotionsPlanned: number;
  demotionsApplied: number;
  demotions: DemotionResult[];
  observations: LeagueBias[];
  featureCoverage: FeatureCoverageRow[];
  dryRun: boolean;
  autoDemoteFlagEnabled: boolean;
}

// ─── Bias computation ───────────────────────────────────────────────────────

async function computeLeagueSettlementBias(lookbackDays: number): Promise<LeagueBias[]> {
  const rows = await db.execute(sql`
    SELECT
      m.league,
      COUNT(*) AS n_bets,
      SUM(CASE WHEN pb.status = 'won' THEN 1 ELSE 0 END) AS actual_wins,
      SUM(pb.model_probability::numeric) AS expected_wins,
      SUM(pb.model_probability::numeric * (1 - pb.model_probability::numeric)) AS variance_sum
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status IN ('won','lost')
      AND pb.placed_at >= NOW() - (${lookbackDays}::int * INTERVAL '1 day')
      AND pb.legacy_regime = false
      AND pb.deleted_at IS NULL
      AND pb.model_probability IS NOT NULL
    GROUP BY m.league
    HAVING COUNT(*) >= ${BIAS_MIN_SAMPLE}
  `);

  const out: LeagueBias[] = [];
  for (const r of (rows as any).rows ?? []) {
    const nBets = parseInt(r.n_bets ?? "0");
    const actualWins = parseFloat(r.actual_wins ?? "0");
    const expectedWins = parseFloat(r.expected_wins ?? "0");
    const varianceSum = parseFloat(r.variance_sum ?? "0");
    const biasZ = varianceSum > 0 ? (actualWins - expectedWins) / Math.sqrt(varianceSum) : 0;
    out.push({
      league: r.league as string,
      nBets,
      actualWins,
      expectedWins,
      biasZ,
      breaching: Math.abs(biasZ) > BIAS_THRESHOLD,
    });
  }
  return out;
}

async function findPriorBreach(
  league: string,
  excludeAfter: Date,
): Promise<{ biasZ: number; observedAt: Date } | null> {
  const cutoff = new Date(Date.now() - PRIOR_BREACH_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db.execute(sql`
    SELECT decision_at, supporting_metrics
    FROM model_decision_audit_log
    WHERE decision_type = 'settlement_bias_observation'
      AND subject = ${`league:${league}`}
      AND decision_at >= ${cutoff}
      AND decision_at < ${excludeAfter}
    ORDER BY decision_at DESC
    LIMIT 1
  `);
  const r = (rows as any).rows?.[0];
  if (!r) return null;
  const biasZ = Number((r.supporting_metrics as any)?.bias_z);
  if (!Number.isFinite(biasZ)) return null;
  if (Math.abs(biasZ) <= BIAS_THRESHOLD) return null; // prior not breaching
  return { biasZ, observedAt: r.decision_at instanceof Date ? r.decision_at : new Date(r.decision_at) };
}

async function getCurrentTier(league: string): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT universe_tier
    FROM competition_config
    WHERE LOWER(REPLACE(name, '-', ' ')) = LOWER(REPLACE(${league}, '-', ' '))
    LIMIT 1
  `);
  const t = (rows as any).rows?.[0]?.universe_tier;
  return typeof t === "string" ? t : null;
}

function nextTierDown(currentTier: string): string | null {
  if (currentTier === "A") return "B";
  if (currentTier === "B") return "D";
  if (currentTier === "C") return "D";
  return null; // D, E, unmapped — already at bottom
}

// ─── Feature coverage ───────────────────────────────────────────────────────

async function computeFeatureCoverage(): Promise<FeatureCoverageRow[]> {
  const rows = await db.execute(sql`
    SELECT
      m.league,
      COUNT(DISTINCT m.id) AS upcoming_matches,
      COALESCE(AVG(fc.cnt), 0) AS avg_features_per_match
    FROM matches m
    LEFT JOIN (
      SELECT match_id, COUNT(*) AS cnt
      FROM features
      GROUP BY match_id
    ) fc ON fc.match_id = m.id
    WHERE m.status = 'scheduled'
      AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '7 days'
    GROUP BY m.league
    ORDER BY upcoming_matches DESC
    LIMIT 50
  `);
  return ((rows as any).rows ?? []).map((r: any) => ({
    league: r.league as string,
    upcomingMatches: parseInt(r.upcoming_matches ?? "0"),
    avgFeaturesPerMatch: parseFloat(r.avg_features_per_match ?? "0"),
  }));
}

// ─── Main orchestrator ──────────────────────────────────────────────────────

export async function runOngoingAudit(opts: OngoingAuditOpts = {}): Promise<OngoingAuditResult> {
  const dryRun = opts.dryRun ?? false;
  const lookbackDays = opts.lookbackDays ?? BIAS_LOOKBACK_DAYS;
  const flagRaw = process.env.ONGOING_AUDIT_AUTO_DEMOTE_ENABLED ?? "false";
  const autoDemoteFlagEnabled = flagRaw.toLowerCase() === "true";
  const willActuallyDemote = autoDemoteFlagEnabled && !dryRun;

  const observations = await computeLeagueSettlementBias(lookbackDays);
  const observationStartedAt = new Date();

  let observationsWritten = 0;
  const demotions: DemotionResult[] = [];

  for (const obs of observations) {
    const currentTier = await getCurrentTier(obs.league);
    const supportingMetrics = {
      n_bets: obs.nBets,
      actual_wins: obs.actualWins,
      expected_wins: Number(obs.expectedWins.toFixed(4)),
      bias_z: Number(obs.biasZ.toFixed(4)),
      breaching: obs.breaching,
      lookback_days: lookbackDays,
    };
    const reasoning = `Settlement-bias z=${obs.biasZ.toFixed(3)} over ${obs.nBets} bets in last ${lookbackDays}d (actual_wins=${obs.actualWins}, expected_wins=${obs.expectedWins.toFixed(2)}). ${obs.breaching ? "BREACHING |z|>1.5" : "Within tolerance"}.`;

    if (!dryRun) {
      await db.insert(modelDecisionAuditLogTable).values({
        decisionType: "settlement_bias_observation",
        subject: `league:${obs.league}`,
        priorState: { universe_tier: currentTier ?? "unknown" } as any,
        newState: { universe_tier: currentTier ?? "unknown", bias_z: obs.biasZ } as any,
        reasoning,
        supportingMetrics: supportingMetrics as any,
        expectedImpact: obs.biasZ,
        reviewStatus: "automatic",
      });
      // Also persist the latest bias on competition_config (single-source-of-truth column).
      await db.execute(sql`
        UPDATE competition_config
        SET settlement_bias_index = ${obs.biasZ}
        WHERE LOWER(REPLACE(name, '-', ' ')) = LOWER(REPLACE(${obs.league}, '-', ' '))
      `);
      observationsWritten++;
    }

    // Demotion check — independent of dryRun for the PLAN; gated by flag for ACTION.
    if (!obs.breaching) continue;

    const prior = await findPriorBreach(obs.league, observationStartedAt);
    if (!prior) continue;

    if (!currentTier) continue;
    const toTier = nextTierDown(currentTier);
    if (!toTier) continue;

    const plan: DemotionPlan = {
      league: obs.league,
      fromTier: currentTier,
      toTier,
      currentBiasZ: obs.biasZ,
      priorBiasZ: prior.biasZ,
      priorObservedAt: prior.observedAt.toISOString(),
    };

    if (!willActuallyDemote) {
      demotions.push({ ...plan, applied: false, reason: dryRun ? "dryRun" : "flag_disabled" });
      continue;
    }

    // Apply demotion: tier change + audit row.
    await db.execute(sql`
      UPDATE competition_config
      SET universe_tier = ${toTier},
          universe_tier_decided_at = NOW()
      WHERE LOWER(REPLACE(name, '-', ' ')) = LOWER(REPLACE(${obs.league}, '-', ' '))
        AND universe_tier = ${currentTier}
    `);
    await db.insert(modelDecisionAuditLogTable).values({
      decisionType: "league_auto_demoted",
      subject: `league:${obs.league}`,
      priorState: { universe_tier: currentTier } as any,
      newState: { universe_tier: toTier, demotion_reason: "consecutive_bias_breach" } as any,
      reasoning: `Two consecutive weekly observations with |bias_z| > ${BIAS_THRESHOLD} — auto-demoted ${currentTier} → ${toTier}. Current z=${obs.biasZ.toFixed(3)}, prior z=${prior.biasZ.toFixed(3)} on ${prior.observedAt.toISOString()}.`,
      supportingMetrics: {
        current_bias_z: obs.biasZ,
        prior_bias_z: prior.biasZ,
        prior_observed_at: prior.observedAt.toISOString(),
        bias_threshold: BIAS_THRESHOLD,
      } as any,
      expectedImpact: null,
      reviewStatus: "automatic",
    });
    demotions.push({ ...plan, applied: true });
  }

  const featureCoverage = await computeFeatureCoverage();

  const breachingLeagues = observations.filter((o) => o.breaching).length;
  const demotionsPlanned = demotions.length;
  const demotionsApplied = demotions.filter((d) => d.applied).length;

  logger.info(
    {
      observationsWritten,
      breachingLeagues,
      demotionsPlanned,
      demotionsApplied,
      autoDemoteFlagEnabled,
      dryRun,
      featureCoverageLeagues: featureCoverage.length,
    },
    "Ongoing audit complete",
  );

  return {
    observationsWritten,
    breachingLeagues,
    demotionsPlanned,
    demotionsApplied,
    demotions,
    observations,
    featureCoverage,
    dryRun,
    autoDemoteFlagEnabled,
  };
}
