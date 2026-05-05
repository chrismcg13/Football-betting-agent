import {
  db,
  pool,
  experimentRegistryTable,
  promotionAuditLogTable,
  experimentLearningJournalTable,
  paperBetsTable,
  graduationEvaluationLogTable,
  modelDecisionAuditLogTable,
} from "@workspace/db";
import { eq, and, sql, inArray, desc, gt } from "drizzle-orm";
import { logger } from "../lib/logger";
import crypto from "crypto";

const THRESHOLDS = {
  experimentToCandidate: {
    minSampleSize: parseInt(process.env.PROMO_MIN_SAMPLE_SIZE ?? "25"),
    minRoi: parseFloat(process.env.PROMO_MIN_ROI ?? "3.0"),
    minClv: parseFloat(process.env.PROMO_MIN_CLV ?? "1.5"),
    minWinRate: parseFloat(process.env.PROMO_MIN_WIN_RATE ?? "52.0"),
    maxPValue: parseFloat(process.env.PROMO_MAX_P_VALUE ?? "0.10"),
    minWeeksActive: parseInt(process.env.PROMO_MIN_WEEKS_ACTIVE ?? "3"),
    minEdge: parseFloat(process.env.PROMO_MIN_EDGE ?? "2.0"),
  },
  candidateToPromoted: {
    minSampleSize: parseInt(process.env.PROMO_CANDIDATE_MIN_SAMPLE ?? "20"),
    minRoi: parseFloat(process.env.PROMO_CANDIDATE_MIN_ROI ?? "2.0"),
    minClv: parseFloat(process.env.PROMO_CANDIDATE_MIN_CLV ?? "1.0"),
    maxPValue: parseFloat(process.env.PROMO_CANDIDATE_MAX_P_VALUE ?? "0.05"),
    minWeeksActive: parseInt(process.env.PROMO_CANDIDATE_MIN_WEEKS ?? "2"),
  },
  demotionPromotedToCandidate: {
    rollingWindow: 30,
    minRoi: 0,
    minClv: 0,
    maxConsecutiveNegativeWeeks: 3,
  },
  demotionCandidateToExperiment: {
    minRoi: -5,
    minClv: 0,
  },
  abandonThreshold: {
    minSample: 50,
    maxRoi: -10,
    maxPValue: 0.10,
  },
};

export const CANDIDATE_STAKE_MULTIPLIER = 0.25;

// Sub-phase 5 (Refinement 2): Kelly-fraction placeholders per v2 §3.3.
// Sub-phase 6 will override these with per-league dynamic values based on
// Kelly-growth retrospective analysis. Schema accepts [0, 1.0] per Phase 2.A
// CHECK constraint (migrate.ts:992-997).
const TIER_TO_KELLY_FRACTION: Record<string, number> = {
  experiment: 0,
  candidate: 0.25,
  promoted: 1.0,
  abandoned: 0,
};

// Sub-phase 5: dedupe window for event-driven evaluation (Refinement: idempotency).
// Within this window, repeat calls on the same tag with non-transition outcomes
// are skipped. Transitions always re-evaluate (state changed; new gates apply).
const EVAL_DEDUPE_WINDOW_MS = 15_000;

// Distribution-shift A(archetype) computation cache. Per-archetype, 5-min TTL.
const DISTRIBUTION_SHIFT_CACHE_MS = 5 * 60 * 1000;
const distributionShiftCache = new Map<string, { computedAt: number }>();

interface ExperimentMetrics {
  sampleSize: number;
  roi: number;                          // %, e.g. 8.4 for +8.4%
  clv: number;
  winRate: number;                      // %, e.g. 55.6 for 55.6%
  pValue: number;
  edge: number;
  weeksActive: number;
  weeklyRois: number[];
  // Sub-phase 5 (Refinement 2): Kelly-growth as first-class metric.
  // Per-bet log-return: g_i = ln(max(0.001, (effective_stake + pnl) / effective_stake))
  // effective_stake = stake > 0 ? stake : shadow_stake
  // pnl = settlement_pnl ?? shadow_pnl ?? 0
  // realisedKellyGrowthRate = mean(g_i) over all settled bets in tag
  // kellyGrowth30dRolling   = mean(g_i) over last 30 days only
  realisedKellyGrowthRate: number;
  kellyGrowth30dRolling: number;
}

function computePValue(wins: number, total: number, impliedWinRate: number): number {
  if (total === 0 || impliedWinRate <= 0 || impliedWinRate >= 1) return 1;
  const observed = wins / total;
  const se = Math.sqrt((impliedWinRate * (1 - impliedWinRate)) / total);
  if (se === 0) return 1;
  const z = (observed - impliedWinRate) / se;
  const p = 1 - normalCdf(z);
  return Math.max(0, Math.min(1, p));
}

function normalCdf(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

async function computeMetricsForExperiment(experimentTag: string, tierFilter?: string): Promise<ExperimentMetrics> {
  const tierClause = tierFilter ? sql` AND data_tier = ${tierFilter}` : sql``;
  
  const rows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('won', 'lost')) as settled,
      COUNT(*) FILTER (WHERE status = 'won') as wins,
      COALESCE(SUM(settlement_pnl::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as total_pnl,
      COALESCE(SUM(stake::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as total_staked,
      -- R14 winsorization (v2.5 calibration): clip individual clv_pct to ±50pp
      -- before averaging so single long-shot outliers (e.g. +1500% on a 26.0
      -- placement vs 1.55 close) don't corrupt the league average. Outliers
      -- like Bundesliga's +85% mean and Serie A's +416% mean in the original
      -- diagnostic were each driven by 1-3 such rows.
      COALESCE(AVG(LEAST(50, GREATEST(-50, clv_pct::numeric))) FILTER (WHERE status IN ('won', 'lost') AND clv_pct IS NOT NULL), 0) as avg_clv,
      COALESCE(AVG(calculated_edge::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as avg_edge,
      COALESCE(AVG(
        CASE WHEN odds_at_placement::numeric > 0 THEN 1.0 / odds_at_placement::numeric ELSE NULL END
      ) FILTER (WHERE status IN ('won', 'lost')), 0.5) as avg_implied_prob,
      COUNT(DISTINCT date_trunc('week', placed_at)) as weeks_active,
      -- Sub-phase 5 (Refinement 2): Kelly-growth-rate per-bet log-return.
      -- effective_stake handles shadow bets: stake>0 ? stake : shadow_stake.
      -- pnl: settlement_pnl > 0 ? settlement_pnl : shadow_pnl ?? 0 (covers both real + shadow).
      -- LN clip at 0.001 prevents -∞ on full losses.
      COALESCE(SUM(
        LN(GREATEST(0.001,
          (COALESCE(NULLIF(stake::numeric, 0), shadow_stake::numeric, 1) +
           COALESCE(NULLIF(settlement_pnl::numeric, 0), shadow_pnl::numeric, 0)) /
          COALESCE(NULLIF(stake::numeric, 0), shadow_stake::numeric, 1)
        ))
      ) FILTER (WHERE status IN ('won', 'lost')), 0) as sum_log_growth,
      COUNT(*) FILTER (
        WHERE status IN ('won', 'lost')
        AND placed_at >= NOW() - INTERVAL '30 days'
      ) as settled_30d,
      COALESCE(SUM(
        LN(GREATEST(0.001,
          (COALESCE(NULLIF(stake::numeric, 0), shadow_stake::numeric, 1) +
           COALESCE(NULLIF(settlement_pnl::numeric, 0), shadow_pnl::numeric, 0)) /
          COALESCE(NULLIF(stake::numeric, 0), shadow_stake::numeric, 1)
        ))
      ) FILTER (
        WHERE status IN ('won', 'lost')
        AND placed_at >= NOW() - INTERVAL '30 days'
      ), 0) as sum_log_growth_30d
    FROM paper_bets
    WHERE experiment_tag = ${experimentTag} ${tierClause}
  `);

  const r = (rows as any).rows?.[0] ?? {};
  const settled = parseInt(r.settled ?? "0");
  const wins = parseInt(r.wins ?? "0");
  const totalPnl = parseFloat(r.total_pnl ?? "0");
  const totalStaked = parseFloat(r.total_staked ?? "0");
  const avgClv = parseFloat(r.avg_clv ?? "0");
  const avgEdge = parseFloat(r.avg_edge ?? "0");
  const avgImpliedProb = parseFloat(r.avg_implied_prob ?? "0.5");
  const weeksActive = parseInt(r.weeks_active ?? "0");
  const sumLogGrowth = parseFloat(r.sum_log_growth ?? "0");
  const settled30d = parseInt(r.settled_30d ?? "0");
  const sumLogGrowth30d = parseFloat(r.sum_log_growth_30d ?? "0");

  const roi = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0;
  const winRate = settled > 0 ? (wins / settled) * 100 : 0;
  const pValue = computePValue(wins, settled, avgImpliedProb);
  const realisedKellyGrowthRate = settled > 0 ? sumLogGrowth / settled : 0;
  const kellyGrowth30dRolling = settled30d > 0 ? sumLogGrowth30d / settled30d : 0;

  const weeklyRows = await db.execute(sql`
    SELECT 
      date_trunc('week', placed_at) as wk,
      COALESCE(SUM(settlement_pnl::numeric), 0) as week_pnl,
      COALESCE(SUM(stake::numeric), 0) as week_staked
    FROM paper_bets
    WHERE experiment_tag = ${experimentTag}
      AND status IN ('won', 'lost')
      ${tierClause}
    GROUP BY date_trunc('week', placed_at)
    ORDER BY wk DESC
    LIMIT 10
  `);

  const weeklyRois = ((weeklyRows as any).rows ?? []).map((wr: any) => {
    const staked = parseFloat(wr.week_staked ?? "0");
    return staked > 0 ? (parseFloat(wr.week_pnl ?? "0") / staked) * 100 : 0;
  });

  return {
    sampleSize: settled,
    roi,
    clv: avgClv,
    winRate,
    pValue,
    edge: avgEdge * 100,
    weeksActive,
    weeklyRois,
    realisedKellyGrowthRate,
    kellyGrowth30dRolling,
  };
}

function generateId(): string {
  return crypto.randomUUID();
}

async function logPromotion(
  experimentTag: string,
  previousTier: string,
  newTier: string,
  reason: string,
  metrics: ExperimentMetrics,
  thresholds: Record<string, unknown>,
  decidedBy = "auto_promotion_engine"
): Promise<string> {
  const id = generateId();
  await db.insert(promotionAuditLogTable).values({
    id,
    experimentTag,
    previousTier,
    newTier,
    decisionReason: reason,
    metricsSnapshot: metrics as any,
    thresholdsUsed: thresholds as any,
    decidedAt: new Date(),
    decidedBy,
  });
  return id;
}

// ─── Sub-phase 5: event-driven graduation evaluator ──────────────────────────
// Per docs/phase-2-wave-3-subphase-5-plan.md.
//
// evaluateExperimentTag is the per-experiment evaluation function called from
// BOTH the daily 04:00 cron (runPromotionEngine, now a thin loop) and the
// settlement-time hook in paperTrading._settleBetsInner. Single source of
// truth for tier-transition logic.

export type EvaluateTriggeredBy = "settlement" | "cron" | "manual";

export interface EvaluateExperimentOpts {
  triggeredBy: EvaluateTriggeredBy;
  triggerBetId?: number;
}

export type ThresholdOutcome = "promote" | "demote" | "hold" | "warmup" | "insufficient_data" | "skipped_dedupe";

export interface EvaluateExperimentResult {
  tag: string;
  evaluated: boolean;
  outcome: ThresholdOutcome;
  newTier?: string;
  metrics?: ExperimentMetrics;
}

async function recentEvaluationExists(tag: string, windowMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowMs);
  const rows = await db
    .select({ outcome: graduationEvaluationLogTable.thresholdOutcome })
    .from(graduationEvaluationLogTable)
    .where(
      and(
        eq(graduationEvaluationLogTable.experimentTag, tag),
        gt(graduationEvaluationLogTable.evaluatedAt, cutoff),
      ),
    )
    .orderBy(desc(graduationEvaluationLogTable.evaluatedAt))
    .limit(1);
  if (rows.length === 0) return false;
  // Transitions invalidate dedupe — registry state changed; re-evaluate.
  const outcome = rows[0]?.outcome;
  return outcome !== "promote" && outcome !== "demote";
}

async function writeGraduationEvaluationLog(
  tag: string,
  outcome: ThresholdOutcome,
  metrics: ExperimentMetrics,
  opts: EvaluateExperimentOpts,
): Promise<void> {
  await db.insert(graduationEvaluationLogTable).values({
    id: generateId(),
    experimentTag: tag,
    triggeredBy: opts.triggeredBy,
    triggerBetId: opts.triggerBetId ?? null,
    metricsSnapshot: metrics as any,
    thresholdOutcome: outcome,
    evaluatedAt: new Date(),
  });
}

async function writeAuditLogForTransition(
  tag: string,
  prevTier: string,
  newTier: string,
  reason: string,
  metrics: ExperimentMetrics,
): Promise<void> {
  const prevKelly = TIER_TO_KELLY_FRACTION[prevTier] ?? 0;
  const newKelly = TIER_TO_KELLY_FRACTION[newTier] ?? 0;
  await db.insert(modelDecisionAuditLogTable).values({
    decisionType: "tier_transition",
    subject: `experiment_tag:${tag}`,
    priorState: { data_tier: prevTier, kelly_fraction: prevKelly } as any,
    newState: { data_tier: newTier, kelly_fraction: newKelly } as any,
    reasoning: reason,
    supportingMetrics: {
      sample_size: metrics.sampleSize,
      realised_roi: metrics.roi / 100, // store as fraction not %
      realised_kelly_growth_rate: metrics.realisedKellyGrowthRate,
      kelly_growth_30d_rolling: metrics.kellyGrowth30dRolling,
      clv: metrics.clv,
      win_rate: metrics.winRate / 100,
      p_value: metrics.pValue,
      edge: metrics.edge,
      weeks_active: metrics.weeksActive,
    } as any,
    expectedImpact: null, // sub-phase 6 populates with predicted Kelly-growth delta
    reviewStatus: "automatic",
  });
}

export async function evaluateExperimentTag(
  tag: string,
  opts: EvaluateExperimentOpts,
): Promise<EvaluateExperimentResult> {
  // Dedupe: skip if a recent evaluation on this tag had non-transition outcome.
  if (opts.triggeredBy === "settlement" && (await recentEvaluationExists(tag, EVAL_DEDUPE_WINDOW_MS))) {
    return { tag, evaluated: false, outcome: "skipped_dedupe" };
  }

  // Load registry row.
  const existing = await db.execute(sql`
    SELECT * FROM experiment_registry WHERE experiment_tag = ${tag} LIMIT 1
  `);
  const exp = (existing as any).rows?.[0];
  if (!exp) {
    // Tag not registered. Cron path skips silently; settlement path may need
    // ensureExperimentRegistered upstream. Don't auto-register here — we lack
    // leagueCode + marketType context.
    return { tag, evaluated: false, outcome: "insufficient_data" };
  }

  if (exp.data_tier === "abandoned") {
    return { tag, evaluated: false, outcome: "hold" };
  }

  const metrics = await computeMetricsForExperiment(tag);
  const t = THRESHOLDS;

  // Update registry with current metrics (same behaviour as legacy cron).
  await db.update(experimentRegistryTable).set({
    currentSampleSize: metrics.sampleSize,
    currentRoi: metrics.roi,
    currentClv: metrics.clv,
    currentWinRate: metrics.winRate,
    currentPValue: metrics.pValue,
    currentEdge: metrics.edge,
    lastEvaluatedAt: new Date(),
  }).where(eq(experimentRegistryTable.id, exp.id));

  let outcome: ThresholdOutcome = "hold";
  let newTier: string | undefined;

  // ─── experiment → candidate / abandoned ─────────────────────────────────
  if (exp.data_tier === "experiment") {
    const thresh = t.experimentToCandidate;
    if (
      metrics.sampleSize >= thresh.minSampleSize &&
      metrics.roi >= thresh.minRoi &&
      metrics.clv >= thresh.minClv &&
      metrics.winRate >= thresh.minWinRate &&
      metrics.pValue <= thresh.maxPValue &&
      metrics.weeksActive >= thresh.minWeeksActive &&
      metrics.edge >= thresh.minEdge
    ) {
      const reason = `Met all experiment→candidate thresholds: sample=${metrics.sampleSize}/${thresh.minSampleSize}, realised_roi=${metrics.roi.toFixed(1)}%/${thresh.minRoi}%, kelly_growth=${metrics.realisedKellyGrowthRate.toFixed(4)}/bet, CLV=${metrics.clv.toFixed(2)}/${thresh.minClv}, winRate=${metrics.winRate.toFixed(1)}%/${thresh.minWinRate}%, p=${metrics.pValue.toFixed(3)}/${thresh.maxPValue}, weeks=${metrics.weeksActive}/${thresh.minWeeksActive}, edge=${metrics.edge.toFixed(1)}%/${thresh.minEdge}%`;
      await logPromotion(tag, "experiment", "candidate", reason, metrics, thresh as any);
      await writeAuditLogForTransition(tag, "experiment", "candidate", reason, metrics);
      await db.update(experimentRegistryTable).set({
        dataTier: "candidate",
        kellyFraction: TIER_TO_KELLY_FRACTION.candidate,
        tierChangedAt: new Date(),
      }).where(eq(experimentRegistryTable.id, exp.id));
      outcome = "promote";
      newTier = "candidate";
      logger.info({ tag, triggeredBy: opts.triggeredBy }, "Experiment promoted to candidate");
    } else if (
      metrics.sampleSize >= t.abandonThreshold.minSample &&
      metrics.roi <= t.abandonThreshold.maxRoi &&
      metrics.pValue <= t.abandonThreshold.maxPValue
    ) {
      const reason = `Experiment abandoned: ${metrics.sampleSize} bets, realised_roi=${metrics.roi.toFixed(1)}% (threshold ${t.abandonThreshold.maxRoi}%), kelly_growth=${metrics.realisedKellyGrowthRate.toFixed(4)}/bet, p=${metrics.pValue.toFixed(3)} — statistically significantly bad`;
      await logPromotion(tag, "experiment", "abandoned", reason, metrics, t.abandonThreshold as any);
      await writeAuditLogForTransition(tag, "experiment", "abandoned", reason, metrics);
      const cooldownDate = new Date();
      cooldownDate.setDate(cooldownDate.getDate() + 90);
      await db.update(experimentRegistryTable).set({
        dataTier: "abandoned",
        kellyFraction: TIER_TO_KELLY_FRACTION.abandoned,
        abandonedAt: new Date(),
        cooldownEligibleAt: cooldownDate,
        tierChangedAt: new Date(),
      }).where(eq(experimentRegistryTable.id, exp.id));
      outcome = "promote"; // direction-agnostic — it's a transition
      newTier = "abandoned";
      logger.warn({ tag, triggeredBy: opts.triggeredBy }, "Experiment abandoned — statistically bad");
    }
  }

  // ─── candidate → promoted / experiment ──────────────────────────────────
  if (exp.data_tier === "candidate") {
    const candidateMetrics = await computeMetricsForExperiment(tag, "candidate");
    const thresh = t.candidateToPromoted;
    if (
      candidateMetrics.sampleSize >= thresh.minSampleSize &&
      candidateMetrics.roi >= thresh.minRoi &&
      candidateMetrics.clv >= thresh.minClv &&
      candidateMetrics.pValue <= thresh.maxPValue &&
      candidateMetrics.weeksActive >= thresh.minWeeksActive
    ) {
      const reason = `Met all candidate→promoted thresholds: candidateSample=${candidateMetrics.sampleSize}/${thresh.minSampleSize}, realised_roi=${candidateMetrics.roi.toFixed(1)}%/${thresh.minRoi}%, kelly_growth=${candidateMetrics.realisedKellyGrowthRate.toFixed(4)}/bet, CLV=${candidateMetrics.clv.toFixed(2)}/${thresh.minClv}, p=${candidateMetrics.pValue.toFixed(3)}/${thresh.maxPValue}`;
      const auditId = await logPromotion(tag, "candidate", "promoted", reason, candidateMetrics, thresh as any);
      await writeAuditLogForTransition(tag, "candidate", "promoted", reason, candidateMetrics);
      await db.update(experimentRegistryTable).set({
        dataTier: "promoted",
        kellyFraction: TIER_TO_KELLY_FRACTION.promoted,
        tierChangedAt: new Date(),
      }).where(eq(experimentRegistryTable.id, exp.id));
      await db.execute(sql`
        UPDATE paper_bets
        SET data_tier = 'promoted', sync_eligible = true, promoted_at = NOW(), promotion_audit_id = ${auditId}
        WHERE experiment_tag = ${tag} AND status IN ('won', 'lost')
      `);
      outcome = "promote";
      newTier = "promoted";
      logger.info({ tag, triggeredBy: opts.triggeredBy }, "Candidate promoted to full promotion");
    } else if (candidateMetrics.roi < t.demotionCandidateToExperiment.minRoi || candidateMetrics.clv < t.demotionCandidateToExperiment.minClv) {
      const reason = `Candidate demoted: realised_roi=${candidateMetrics.roi.toFixed(1)}% (min ${t.demotionCandidateToExperiment.minRoi}%), kelly_growth=${candidateMetrics.realisedKellyGrowthRate.toFixed(4)}/bet, CLV=${candidateMetrics.clv.toFixed(2)} (min ${t.demotionCandidateToExperiment.minClv})`;
      await logPromotion(tag, "candidate", "experiment", reason, candidateMetrics, t.demotionCandidateToExperiment as any);
      await writeAuditLogForTransition(tag, "candidate", "experiment", reason, candidateMetrics);
      await db.update(experimentRegistryTable).set({
        dataTier: "experiment",
        kellyFraction: TIER_TO_KELLY_FRACTION.experiment,
        tierChangedAt: new Date(),
      }).where(eq(experimentRegistryTable.id, exp.id));
      outcome = "demote";
      newTier = "experiment";
      logger.warn({ tag, triggeredBy: opts.triggeredBy }, "Candidate demoted back to experiment");
    }
  }

  // ─── promoted → candidate ───────────────────────────────────────────────
  if (exp.data_tier === "promoted") {
    const rollingMetrics = await computeRollingMetrics(tag, t.demotionPromotedToCandidate.rollingWindow);
    const consecutiveNegWeeks = countConsecutiveNegativeWeeks(metrics.weeklyRois);
    await db.update(experimentRegistryTable).set({
      consecutiveNegativeWeeks: consecutiveNegWeeks,
    }).where(eq(experimentRegistryTable.id, exp.id));
    if (
      rollingMetrics.roi < t.demotionPromotedToCandidate.minRoi ||
      rollingMetrics.clv < t.demotionPromotedToCandidate.minClv ||
      consecutiveNegWeeks >= t.demotionPromotedToCandidate.maxConsecutiveNegativeWeeks
    ) {
      const reason = `Promoted demoted to candidate: rolling30 realised_roi=${rollingMetrics.roi.toFixed(1)}%, kelly_growth_30d=${metrics.kellyGrowth30dRolling.toFixed(4)}/bet, CLV=${rollingMetrics.clv.toFixed(2)}, negWeeks=${consecutiveNegWeeks}`;
      await logPromotion(tag, "promoted", "candidate", reason, metrics, t.demotionPromotedToCandidate as any);
      await writeAuditLogForTransition(tag, "promoted", "candidate", reason, metrics);
      await db.update(experimentRegistryTable).set({
        dataTier: "candidate",
        kellyFraction: TIER_TO_KELLY_FRACTION.candidate,
        tierChangedAt: new Date(),
      }).where(eq(experimentRegistryTable.id, exp.id));
      outcome = "demote";
      newTier = "candidate";
      logger.warn({ tag, triggeredBy: opts.triggeredBy }, "Promoted demoted to candidate");
    }
  }

  await writeGraduationEvaluationLog(tag, outcome === "skipped_dedupe" ? "hold" : outcome, metrics, opts);

  return { tag, evaluated: true, outcome, newTier, metrics };
}

// ─── Sub-phase 5: distribution-shift detector A(archetype) ──────────────────
// Per Refinement 3: structured findings written to BOTH model_decision_audit_log
// AND experiment_learning_journal so sub-phase 6's autonomous threshold-management
// evaluator can consume programmatically.

export async function computeArchetypeDistributionShift(): Promise<void> {
  const now = Date.now();

  // Fetch archetypes from competition_config (post-sub-phase-2: 6 canonical values).
  const archetypeRows = await db.execute(sql`
    SELECT DISTINCT archetype FROM competition_config
    WHERE archetype IS NOT NULL AND universe_tier IN ('A','B','C')
  `);
  const archetypes = ((archetypeRows as any).rows ?? []).map((r: any) => r.archetype as string).filter(Boolean);

  if (archetypes.length === 0) return;

  // Global 30d aggregate — same Kelly-growth formula as per-experiment.
  const globalRows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE pb.status IN ('won','lost')) as n,
      COALESCE(SUM(pb.settlement_pnl::numeric) FILTER (WHERE pb.status IN ('won','lost')), 0) as pnl,
      COALESCE(SUM(pb.stake::numeric) FILTER (WHERE pb.status IN ('won','lost')), 0) as staked,
      COALESCE(SUM(
        LN(GREATEST(0.001,
          (COALESCE(NULLIF(pb.stake::numeric, 0), pb.shadow_stake::numeric, 1) +
           COALESCE(NULLIF(pb.settlement_pnl::numeric, 0), pb.shadow_pnl::numeric, 0)) /
          COALESCE(NULLIF(pb.stake::numeric, 0), pb.shadow_stake::numeric, 1)
        ))
      ) FILTER (WHERE pb.status IN ('won','lost')), 0) as sum_log_growth
    FROM paper_bets pb
    WHERE pb.placed_at >= NOW() - INTERVAL '30 days'
      AND pb.deleted_at IS NULL
      AND pb.legacy_regime = false
  `);
  const g = (globalRows as any).rows?.[0] ?? {};
  const nGlobal = parseInt(g.n ?? "0");
  const roiGlobal = parseFloat(g.staked ?? "0") > 0 ? parseFloat(g.pnl ?? "0") / parseFloat(g.staked ?? "0") : 0;
  const kellyGrowthGlobal = nGlobal > 0 ? parseFloat(g.sum_log_growth ?? "0") / nGlobal : 0;

  for (const archetype of archetypes) {
    // Cache: skip if computed within window.
    const cached = distributionShiftCache.get(archetype);
    if (cached && now - cached.computedAt < DISTRIBUTION_SHIFT_CACHE_MS) continue;
    distributionShiftCache.set(archetype, { computedAt: now });

    const archetypeRowsResult = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE pb.status IN ('won','lost')) as n,
        COALESCE(SUM(pb.settlement_pnl::numeric) FILTER (WHERE pb.status IN ('won','lost')), 0) as pnl,
        COALESCE(SUM(pb.stake::numeric) FILTER (WHERE pb.status IN ('won','lost')), 0) as staked,
        COALESCE(SUM(
          LN(GREATEST(0.001,
            (COALESCE(NULLIF(pb.stake::numeric, 0), pb.shadow_stake::numeric, 1) +
             COALESCE(NULLIF(pb.settlement_pnl::numeric, 0), pb.shadow_pnl::numeric, 0)) /
            COALESCE(NULLIF(pb.stake::numeric, 0), pb.shadow_stake::numeric, 1)
          ))
        ) FILTER (WHERE pb.status IN ('won','lost')), 0) as sum_log_growth
      FROM paper_bets pb
      JOIN matches m ON m.id = pb.match_id
      JOIN competition_config cc ON LOWER(cc.name) = LOWER(m.league)
      WHERE pb.placed_at >= NOW() - INTERVAL '30 days'
        AND pb.deleted_at IS NULL
        AND pb.legacy_regime = false
        AND cc.archetype = ${archetype}
    `);
    const a = (archetypeRowsResult as any).rows?.[0] ?? {};
    const nArchetype = parseInt(a.n ?? "0");
    if (nArchetype === 0) continue; // skip archetypes with no recent settled bets
    const roiArchetype = parseFloat(a.staked ?? "0") > 0 ? parseFloat(a.pnl ?? "0") / parseFloat(a.staked ?? "0") : 0;
    const kellyGrowthArchetype = parseFloat(a.sum_log_growth ?? "0") / nArchetype;
    const aScore = nArchetype > 0 ? (roiArchetype - roiGlobal) / Math.sqrt(nArchetype) : 0;

    // Look up consecutive_windows_breaching from past distribution_shift_observation rows
    const breachLookup = await db
      .select({ supportingMetrics: modelDecisionAuditLogTable.supportingMetrics })
      .from(modelDecisionAuditLogTable)
      .where(
        and(
          eq(modelDecisionAuditLogTable.decisionType, "distribution_shift_observation"),
          eq(modelDecisionAuditLogTable.subject, `archetype:${archetype}`),
        ),
      )
      .orderBy(desc(modelDecisionAuditLogTable.decisionAt))
      .limit(1);
    const prevBreaching = (breachLookup[0]?.supportingMetrics as any)?.consecutive_windows_breaching ?? 0;
    const isBreaching = Math.abs(aScore) > 1.5;
    const consecutiveWindowsBreaching = isBreaching ? prevBreaching + 1 : 0;

    const findings = {
      archetype,
      n_archetype_30d: nArchetype,
      roi_archetype_30d: roiArchetype,
      n_global_30d: nGlobal,
      roi_global_30d: roiGlobal,
      a_score: aScore,
      consecutive_windows_breaching: consecutiveWindowsBreaching,
      kelly_growth_archetype_30d: kellyGrowthArchetype,
      kelly_growth_global_30d: kellyGrowthGlobal,
    };

    // Write to BOTH model_decision_audit_log + experiment_learning_journal.
    await db.insert(modelDecisionAuditLogTable).values({
      decisionType: "distribution_shift_observation",
      subject: `archetype:${archetype}`,
      priorState: null,
      newState: null,
      reasoning: `30d distribution-shift for archetype ${archetype}: A=${aScore.toFixed(3)}, n_arch=${nArchetype}, n_global=${nGlobal}, breaching_windows=${consecutiveWindowsBreaching}`,
      supportingMetrics: findings as any,
      expectedImpact: null,
      reviewStatus: "automatic",
    });

    await db.insert(experimentLearningJournalTable).values({
      id: generateId(),
      analysisDate: new Date(),
      analysisType: "distribution_drift",
      experimentTag: null,
      findings: findings as any,
      recommendations: null,
      actionsTaken: null,
    });

    if (consecutiveWindowsBreaching >= 2) {
      logger.warn(
        { archetype, aScore, nArchetype, consecutiveWindowsBreaching },
        "Distribution-shift alert: archetype shows persistent |A| > 1.5 — investigate model bug, NOT threshold tightening",
      );
    }
  }
}

export async function runPromotionEngine(): Promise<{
  promoted: number;
  demoted: number;
  abandoned: number;
  evaluated: number;
}> {
  logger.info("Promotion engine cron starting (reconciler — sub-phase 5 event-driven path is primary)");
  let promoted = 0, demoted = 0, abandoned = 0, evaluated = 0;

  const experiments = await db.select().from(experimentRegistryTable);

  for (const exp of experiments) {
    if (exp.dataTier === "abandoned") continue;
    evaluated++;
    try {
      const result = await evaluateExperimentTag(exp.experimentTag, { triggeredBy: "cron" });
      if (result.outcome === "promote" && result.newTier === "abandoned") abandoned++;
      else if (result.outcome === "promote") promoted++;
      else if (result.outcome === "demote") demoted++;
    } catch (err) {
      logger.warn({ err, tag: exp.experimentTag }, "Cron evaluator failed for tag — continuing");
    }
  }

  // Run distribution-shift detector once per cron pass (cache absorbs duplicate calls).
  try {
    await computeArchetypeDistributionShift();
  } catch (err) {
    logger.warn({ err }, "Distribution-shift compute failed during cron — non-fatal");
  }

  await db.insert(experimentLearningJournalTable).values({
    id: generateId(),
    analysisDate: new Date(),
    analysisType: "promotion_readiness",
    findings: { evaluated, promoted, demoted, abandoned } as any,
    recommendations: null,
    actionsTaken: { type: "promotion_engine_run" } as any,
  });

  logger.info({ evaluated, promoted, demoted, abandoned }, "Promotion engine cron complete");
  return { promoted, demoted, abandoned, evaluated };
}

async function computeRollingMetrics(tag: string, window: number): Promise<{ roi: number; clv: number }> {
  const rows = await db.execute(sql`
    SELECT 
      COALESCE(SUM(settlement_pnl::numeric), 0) as pnl,
      COALESCE(SUM(stake::numeric), 0) as staked,
      -- R14 winsorization (v2.5 calibration): same ±50pp clip as
      -- computeMetricsForExperiment for consistent rolling-window CLV.
      COALESCE(AVG(LEAST(50, GREATEST(-50, clv_pct::numeric))), 0) as clv
    FROM (
      SELECT settlement_pnl, stake, clv_pct
      FROM paper_bets
      WHERE experiment_tag = ${tag} AND status IN ('won', 'lost')
      ORDER BY settled_at DESC
      LIMIT ${window}
    ) sub
  `);
  const r = (rows as any).rows?.[0] ?? {};
  const staked = parseFloat(r.staked ?? "0");
  return {
    roi: staked > 0 ? (parseFloat(r.pnl ?? "0") / staked) * 100 : 0,
    clv: parseFloat(r.clv ?? "0"),
  };
}

function countConsecutiveNegativeWeeks(weeklyRois: number[]): number {
  let count = 0;
  for (const roi of weeklyRois) {
    if (roi < 0) count++;
    else break;
  }
  return count;
}

export async function ensureExperimentRegistered(experimentTag: string, leagueCode: string, marketType: string): Promise<void> {
  const id = `${leagueCode}-${marketType}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  await db.execute(sql`
    INSERT INTO experiment_registry (id, experiment_tag, league_code, market_type, data_tier, created_at, tier_changed_at)
    VALUES (${id}, ${experimentTag}, ${leagueCode}, ${marketType}, 'experiment', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `);
}

export async function getExperimentTier(experimentTag: string): Promise<string> {
  const rows = await db.execute(sql`
    SELECT data_tier FROM experiment_registry WHERE experiment_tag = ${experimentTag} LIMIT 1
  `);
  return ((rows as any).rows?.[0]?.data_tier as string) ?? "experiment";
}

export async function manualPromote(experimentTag: string, targetTier: string, reason: string): Promise<{ success: boolean; message: string }> {
  const validTiers = ["experiment", "candidate", "promoted", "demoted", "abandoned"];
  if (!validTiers.includes(targetTier)) {
    return { success: false, message: `Invalid tier: ${targetTier}` };
  }

  const existing = await db.execute(sql`
    SELECT * FROM experiment_registry WHERE experiment_tag = ${experimentTag} LIMIT 1
  `);
  const exp = (existing as any).rows?.[0];
  if (!exp) {
    return { success: false, message: `Experiment not found: ${experimentTag}` };
  }

  const metrics = await computeMetricsForExperiment(experimentTag);
  const auditId = await logPromotion(experimentTag, exp.data_tier, targetTier, `Manual override: ${reason}`, metrics, {}, "manual_override");

  await db.execute(sql`
    UPDATE experiment_registry
    SET data_tier = ${targetTier}, tier_changed_at = NOW()
    WHERE experiment_tag = ${experimentTag}
  `);

  if (targetTier === "promoted") {
    await db.execute(sql`
      UPDATE paper_bets
      SET data_tier = 'promoted', sync_eligible = true, promoted_at = NOW(), promotion_audit_id = ${auditId}
      WHERE experiment_tag = ${experimentTag} AND status IN ('won', 'lost')
    `);
  }

  logger.info({ experimentTag, from: exp.data_tier, to: targetTier, reason }, "Manual promotion/demotion applied");
  return { success: true, message: `${experimentTag}: ${exp.data_tier} → ${targetTier}` };
}

export async function getExperimentsSummary(): Promise<any[]> {
  const rows = await db.select().from(experimentRegistryTable);
  return rows;
}

export async function getExperimentDetail(tag: string): Promise<any> {
  const registry = await db.execute(sql`
    SELECT * FROM experiment_registry WHERE experiment_tag = ${tag} LIMIT 1
  `);
  const metrics = await computeMetricsForExperiment(tag);
  const bets = await db.execute(sql`
    SELECT id, market_type, status, settlement_pnl, placed_at, data_tier, opportunity_boosted
    FROM paper_bets WHERE experiment_tag = ${tag}
    ORDER BY placed_at DESC LIMIT 50
  `);
  const auditLog = await db.execute(sql`
    SELECT * FROM promotion_audit_log WHERE experiment_tag = ${tag}
    ORDER BY decided_at DESC LIMIT 20
  `);
  return {
    registry: (registry as any).rows?.[0] ?? null,
    metrics,
    recentBets: (bets as any).rows ?? [],
    auditLog: (auditLog as any).rows ?? [],
  };
}

export async function getPromotionLog(): Promise<any[]> {
  const rows = await db.execute(sql`
    SELECT * FROM promotion_audit_log ORDER BY decided_at DESC LIMIT 100
  `);
  return (rows as any).rows ?? [];
}

export async function getLatestLearningJournal(): Promise<any> {
  const rows = await db.execute(sql`
    SELECT * FROM experiment_learning_journal ORDER BY analysis_date DESC LIMIT 1
  `);
  return (rows as any).rows?.[0] ?? null;
}

export async function backfillExperimentTags(): Promise<{ tagged: number; registered: number; skipped: number }> {
  logger.info("Starting experiment tag backfill for untagged bets");

  const untagged = await db.execute(sql`
    SELECT pb.id, pb.match_id, pb.market_type, m.league
    FROM paper_bets pb
    JOIN matches m ON pb.match_id = m.id
    WHERE pb.experiment_tag IS NULL
  `);

  const rows = (untagged as any).rows ?? [];
  let tagged = 0, skipped = 0, registeredSet = new Set<string>();

  for (const row of rows) {
    const league = row.league ?? "unknown";
    const marketType = row.market_type ?? "unknown";
    const expTag = `${league.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${marketType.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

    await db.execute(sql`
      UPDATE paper_bets
      SET experiment_tag = ${expTag}, data_tier = 'experiment'
      WHERE id = ${row.id}
    `);
    tagged++;

    if (!registeredSet.has(expTag)) {
      await ensureExperimentRegistered(expTag, league, marketType);
      registeredSet.add(expTag);
    }
  }

  logger.info({ tagged, registered: registeredSet.size, skipped }, "Experiment tag backfill complete");
  return { tagged, registered: registeredSet.size, skipped };
}

export function getSettledBetCountForLeagueMarket(league: string, marketType: string): Promise<number> {
  return db.execute(sql`
    SELECT COUNT(*) as cnt FROM paper_bets
    WHERE experiment_tag = ${`${league}-${marketType}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")}
      AND status IN ('won', 'lost')
  `).then(r => parseInt(((r as any).rows?.[0]?.cnt) ?? "0"));
}
