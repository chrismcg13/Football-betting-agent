import { db, pool, experimentRegistryTable, promotionAuditLogTable, experimentLearningJournalTable, paperBetsTable } from "@workspace/db";
import { eq, and, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import crypto from "crypto";

const THRESHOLDS = {
  experimentToCandidate: {
    minSampleSize: parseInt(process.env.PROMO_MIN_SAMPLE_SIZE ?? "30"),
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

interface ExperimentMetrics {
  sampleSize: number;
  roi: number;
  clv: number;
  winRate: number;
  pValue: number;
  edge: number;
  weeksActive: number;
  weeklyRois: number[];
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
      COALESCE(AVG(clv_pct::numeric) FILTER (WHERE status IN ('won', 'lost') AND clv_pct IS NOT NULL), 0) as avg_clv,
      COALESCE(AVG(calculated_edge::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as avg_edge,
      COALESCE(AVG(
        CASE WHEN odds_at_placement::numeric > 0 THEN 1.0 / odds_at_placement::numeric ELSE NULL END
      ) FILTER (WHERE status IN ('won', 'lost')), 0.5) as avg_implied_prob,
      COUNT(DISTINCT date_trunc('week', placed_at)) as weeks_active
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

  const roi = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : 0;
  const winRate = settled > 0 ? (wins / settled) * 100 : 0;
  const pValue = computePValue(wins, settled, avgImpliedProb);

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

export async function runPromotionEngine(): Promise<{
  promoted: number;
  demoted: number;
  abandoned: number;
  evaluated: number;
}> {
  logger.info("Promotion engine starting");
  let promoted = 0, demoted = 0, abandoned = 0, evaluated = 0;

  const experiments = await db.select().from(experimentRegistryTable);

  for (const exp of experiments) {
    if (exp.dataTier === "abandoned") continue;
    evaluated++;

    const metrics = await computeMetricsForExperiment(exp.experimentTag);
    const t = THRESHOLDS;

    await db.update(experimentRegistryTable).set({
      currentSampleSize: metrics.sampleSize,
      currentRoi: metrics.roi,
      currentClv: metrics.clv,
      currentWinRate: metrics.winRate,
      currentPValue: metrics.pValue,
      currentEdge: metrics.edge,
    }).where(eq(experimentRegistryTable.id, exp.id));

    if (exp.dataTier === "experiment") {
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
        const reason = `Met all experiment→candidate thresholds: sample=${metrics.sampleSize}/${thresh.minSampleSize}, ROI=${metrics.roi.toFixed(1)}%/${thresh.minRoi}%, CLV=${metrics.clv.toFixed(2)}/${thresh.minClv}, winRate=${metrics.winRate.toFixed(1)}%/${thresh.minWinRate}%, p=${metrics.pValue.toFixed(3)}/${thresh.maxPValue}, weeks=${metrics.weeksActive}/${thresh.minWeeksActive}, edge=${metrics.edge.toFixed(1)}%/${thresh.minEdge}%`;
        await logPromotion(exp.experimentTag, "experiment", "candidate", reason, metrics, thresh as any);
        await db.update(experimentRegistryTable).set({
          dataTier: "candidate",
          tierChangedAt: new Date(),
        }).where(eq(experimentRegistryTable.id, exp.id));
        promoted++;
        logger.info({ tag: exp.experimentTag, ...metrics }, "Experiment promoted to candidate");
      }

      if (
        metrics.sampleSize >= t.abandonThreshold.minSample &&
        metrics.roi <= t.abandonThreshold.maxRoi &&
        metrics.pValue <= t.abandonThreshold.maxPValue
      ) {
        const reason = `Experiment abandoned: ${metrics.sampleSize} bets, ROI=${metrics.roi.toFixed(1)}% (threshold ${t.abandonThreshold.maxRoi}%), p=${metrics.pValue.toFixed(3)} — statistically significantly bad`;
        await logPromotion(exp.experimentTag, "experiment", "abandoned", reason, metrics, t.abandonThreshold as any);
        await db.update(experimentRegistryTable).set({
          dataTier: "abandoned",
          tierChangedAt: new Date(),
        }).where(eq(experimentRegistryTable.id, exp.id));
        abandoned++;
        logger.warn({ tag: exp.experimentTag }, "Experiment abandoned — statistically bad");
      }
    }

    if (exp.dataTier === "candidate") {
      const candidateMetrics = await computeMetricsForExperiment(exp.experimentTag, "candidate");
      const thresh = t.candidateToPromoted;

      if (
        candidateMetrics.sampleSize >= thresh.minSampleSize &&
        candidateMetrics.roi >= thresh.minRoi &&
        candidateMetrics.clv >= thresh.minClv &&
        candidateMetrics.pValue <= thresh.maxPValue &&
        candidateMetrics.weeksActive >= thresh.minWeeksActive
      ) {
        const reason = `Met all candidate→promoted thresholds: candidateSample=${candidateMetrics.sampleSize}/${thresh.minSampleSize}, ROI=${candidateMetrics.roi.toFixed(1)}%/${thresh.minRoi}%, CLV=${candidateMetrics.clv.toFixed(2)}/${thresh.minClv}, p=${candidateMetrics.pValue.toFixed(3)}/${thresh.maxPValue}`;
        const auditId = await logPromotion(exp.experimentTag, "candidate", "promoted", reason, candidateMetrics, thresh as any);
        await db.update(experimentRegistryTable).set({
          dataTier: "promoted",
          tierChangedAt: new Date(),
        }).where(eq(experimentRegistryTable.id, exp.id));

        await db.execute(sql`
          UPDATE paper_bets
          SET data_tier = 'promoted', sync_eligible = true, promoted_at = NOW(), promotion_audit_id = ${auditId}
          WHERE experiment_tag = ${exp.experimentTag} AND status IN ('won', 'lost')
        `);
        promoted++;
        logger.info({ tag: exp.experimentTag }, "Candidate promoted to full promotion");
      }

      if (candidateMetrics.roi < t.demotionCandidateToExperiment.minRoi || candidateMetrics.clv < t.demotionCandidateToExperiment.minClv) {
        const reason = `Candidate demoted: ROI=${candidateMetrics.roi.toFixed(1)}% (min ${t.demotionCandidateToExperiment.minRoi}%), CLV=${candidateMetrics.clv.toFixed(2)} (min ${t.demotionCandidateToExperiment.minClv})`;
        await logPromotion(exp.experimentTag, "candidate", "experiment", reason, candidateMetrics, t.demotionCandidateToExperiment as any);
        await db.update(experimentRegistryTable).set({
          dataTier: "experiment",
          tierChangedAt: new Date(),
        }).where(eq(experimentRegistryTable.id, exp.id));
        demoted++;
        logger.warn({ tag: exp.experimentTag }, "Candidate demoted back to experiment");
      }
    }

    if (exp.dataTier === "promoted") {
      const rollingMetrics = await computeRollingMetrics(exp.experimentTag, t.demotionPromotedToCandidate.rollingWindow);
      const consecutiveNegWeeks = countConsecutiveNegativeWeeks(metrics.weeklyRois);

      await db.update(experimentRegistryTable).set({
        consecutiveNegativeWeeks: consecutiveNegWeeks,
      }).where(eq(experimentRegistryTable.id, exp.id));

      if (
        rollingMetrics.roi < t.demotionPromotedToCandidate.minRoi ||
        rollingMetrics.clv < t.demotionPromotedToCandidate.minClv ||
        consecutiveNegWeeks >= t.demotionPromotedToCandidate.maxConsecutiveNegativeWeeks
      ) {
        const reason = `Promoted demoted to candidate: rolling30 ROI=${rollingMetrics.roi.toFixed(1)}%, CLV=${rollingMetrics.clv.toFixed(2)}, negWeeks=${consecutiveNegWeeks}`;
        await logPromotion(exp.experimentTag, "promoted", "candidate", reason, metrics, t.demotionPromotedToCandidate as any);
        await db.update(experimentRegistryTable).set({
          dataTier: "candidate",
          tierChangedAt: new Date(),
        }).where(eq(experimentRegistryTable.id, exp.id));
        demoted++;
        logger.warn({ tag: exp.experimentTag }, "Promoted demoted to candidate");
      }
    }
  }

  await db.insert(experimentLearningJournalTable).values({
    id: generateId(),
    analysisDate: new Date(),
    analysisType: "promotion_readiness",
    findings: { evaluated, promoted, demoted, abandoned } as any,
    recommendations: null,
    actionsTaken: { type: "promotion_engine_run" } as any,
  });

  logger.info({ evaluated, promoted, demoted, abandoned }, "Promotion engine complete");
  return { promoted, demoted, abandoned, evaluated };
}

async function computeRollingMetrics(tag: string, window: number): Promise<{ roi: number; clv: number }> {
  const rows = await db.execute(sql`
    SELECT 
      COALESCE(SUM(settlement_pnl::numeric), 0) as pnl,
      COALESCE(SUM(stake::numeric), 0) as staked,
      COALESCE(AVG(clv_pct::numeric), 0) as clv
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

export function getSettledBetCountForLeagueMarket(league: string, marketType: string): Promise<number> {
  return db.execute(sql`
    SELECT COUNT(*) as cnt FROM paper_bets
    WHERE experiment_tag = ${`${league}-${marketType}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")}
      AND status IN ('won', 'lost')
  `).then(r => parseInt(((r as any).rows?.[0]?.cnt) ?? "0"));
}
