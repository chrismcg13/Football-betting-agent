import { db, experimentRegistryTable, experimentLearningJournalTable, paperBetsCurrentView } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import crypto from "crypto";

export async function runWeeklyExperimentAnalysis(): Promise<void> {
  logger.info("Weekly experiment self-analysis starting");

  const experiments = await db.select().from(experimentRegistryTable);
  const perExperimentFindings: Record<string, unknown>[] = [];

  for (const exp of experiments) {
    if (exp.dataTier === "abandoned") continue;

    const weekMetrics = await db.execute(sql`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('won', 'lost')) as settled,
        COUNT(*) FILTER (WHERE status = 'won') as wins,
        COALESCE(SUM(settlement_pnl::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as pnl,
        COALESCE(SUM(stake::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as staked,
        COALESCE(AVG(clv_pct::numeric) FILTER (WHERE status IN ('won', 'lost') AND clv_pct IS NOT NULL), 0) as clv
      FROM paper_bets_current
      WHERE experiment_tag = ${exp.experimentTag}
        AND placed_at > NOW() - INTERVAL '7 days'
    `);

    const monthMetrics = await db.execute(sql`
      SELECT 
        COUNT(*) FILTER (WHERE status IN ('won', 'lost')) as settled,
        COUNT(*) FILTER (WHERE status = 'won') as wins,
        COALESCE(SUM(settlement_pnl::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as pnl,
        COALESCE(SUM(stake::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as staked,
        COALESCE(AVG(clv_pct::numeric) FILTER (WHERE status IN ('won', 'lost') AND clv_pct IS NOT NULL), 0) as clv
      FROM paper_bets_current
      WHERE experiment_tag = ${exp.experimentTag}
        AND placed_at > NOW() - INTERVAL '30 days'
    `);

    const boostedVsOrganic = await db.execute(sql`
      SELECT 
        opportunity_boosted as boosted,
        COUNT(*) FILTER (WHERE status IN ('won', 'lost')) as settled,
        COALESCE(SUM(settlement_pnl::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as pnl,
        COALESCE(SUM(stake::numeric) FILTER (WHERE status IN ('won', 'lost')), 0) as staked
      FROM paper_bets_current
      WHERE experiment_tag = ${exp.experimentTag}
      GROUP BY opportunity_boosted
    `);

    const latestBet = await db.execute(sql`
      SELECT placed_at FROM paper_bets_current
      WHERE experiment_tag = ${exp.experimentTag}
      ORDER BY placed_at DESC LIMIT 1
    `);

    const lastBetDate = (latestBet as any).rows?.[0]?.placed_at;
    const daysSinceLastBet = lastBetDate ? Math.floor((Date.now() - new Date(lastBetDate).getTime()) / 86400000) : null;
    const stalled = daysSinceLastBet !== null && daysSinceLastBet >= 14;

    const wr = (weekMetrics as any).rows?.[0] ?? {};
    const mr = (monthMetrics as any).rows?.[0] ?? {};
    const weekStaked = parseFloat(wr.staked ?? "0");
    const monthStaked = parseFloat(mr.staked ?? "0");

    const thresholds = {
      minSampleSize: 30, minRoi: 3.0, minClv: 1.5, minWinRate: 52.0, maxPValue: 0.10, minEdge: 2.0
    };
    const distanceToPromotion: Record<string, string> = {};
    if (exp.dataTier === "experiment") {
      const remaining = thresholds.minSampleSize - (exp.currentSampleSize ?? 0);
      if (remaining > 0) distanceToPromotion.sampleSize = `needs ${remaining} more bets`;
      if ((exp.currentRoi ?? 0) < thresholds.minRoi) distanceToPromotion.roi = `needs +${(thresholds.minRoi - (exp.currentRoi ?? 0)).toFixed(1)}% ROI`;
      if ((exp.currentClv ?? 0) < thresholds.minClv) distanceToPromotion.clv = `needs +${(thresholds.minClv - (exp.currentClv ?? 0)).toFixed(2)} CLV`;
    }

    const boostData = ((boostedVsOrganic as any).rows ?? []);
    const boostedRow = boostData.find((r: any) => r.boosted === true);
    const organicRow = boostData.find((r: any) => r.boosted === false);
    const boostedRoi = boostedRow && parseFloat(boostedRow.staked ?? "0") > 0
      ? (parseFloat(boostedRow.pnl ?? "0") / parseFloat(boostedRow.staked ?? "0")) * 100 : null;
    const organicRoi = organicRow && parseFloat(organicRow.staked ?? "0") > 0
      ? (parseFloat(organicRow.pnl ?? "0") / parseFloat(organicRow.staked ?? "0")) * 100 : null;
    const boostGap = boostedRoi !== null && organicRoi !== null ? organicRoi - boostedRoi : null;

    perExperimentFindings.push({
      experimentTag: exp.experimentTag,
      dataTier: exp.dataTier,
      lifetime: { sampleSize: exp.currentSampleSize, roi: exp.currentRoi, clv: exp.currentClv, winRate: exp.currentWinRate, pValue: exp.currentPValue },
      last7d: { settled: parseInt(wr.settled ?? "0"), roi: weekStaked > 0 ? (parseFloat(wr.pnl ?? "0") / weekStaked * 100) : 0, clv: parseFloat(wr.clv ?? "0") },
      last30d: { settled: parseInt(mr.settled ?? "0"), roi: monthStaked > 0 ? (parseFloat(mr.pnl ?? "0") / monthStaked * 100) : 0, clv: parseFloat(mr.clv ?? "0") },
      boostedVsOrganic: { boostedRoi, organicRoi, gap: boostGap },
      stalled,
      daysSinceLastBet,
      distanceToPromotion,
    });

    await db.insert(experimentLearningJournalTable).values({
      id: crypto.randomUUID(),
      analysisDate: new Date(),
      experimentTag: exp.experimentTag,
      analysisType: "performance_review",
      findings: perExperimentFindings[perExperimentFindings.length - 1] as any,
      recommendations: boostGap !== null && boostGap > 5 ? { action: "reduce_boost", reason: `Boosted bets underperforming organic by ${boostGap.toFixed(1)}%` } as any : null,
      actionsTaken: null,
    });
  }

  const closestToPromotion = perExperimentFindings
    .filter((f: any) => f.dataTier === "experiment")
    .sort((a: any, b: any) => (b.lifetime?.sampleSize ?? 0) - (a.lifetime?.sampleSize ?? 0))[0];

  const closestToDemotion = perExperimentFindings
    .filter((f: any) => f.dataTier === "promoted")
    .sort((a: any, b: any) => (a.last30d?.roi ?? 0) - (b.last30d?.roi ?? 0))[0];

  const systemSummary = {
    totalExperiments: experiments.length,
    byTier: {
      experiment: experiments.filter(e => e.dataTier === "experiment").length,
      candidate: experiments.filter(e => e.dataTier === "candidate").length,
      promoted: experiments.filter(e => e.dataTier === "promoted").length,
      abandoned: experiments.filter(e => e.dataTier === "abandoned").length,
    },
    closestToPromotion: closestToPromotion ? (closestToPromotion as any).experimentTag : null,
    closestToDemotion: closestToDemotion ? (closestToDemotion as any).experimentTag : null,
    stalledExperiments: perExperimentFindings.filter((f: any) => f.stalled).map((f: any) => f.experimentTag),
  };

  await db.insert(experimentLearningJournalTable).values({
    id: crypto.randomUUID(),
    analysisDate: new Date(),
    experimentTag: null,
    analysisType: "performance_review",
    findings: systemSummary as any,
    recommendations: null,
    actionsTaken: null,
  });

  logger.info(systemSummary, "Weekly experiment self-analysis complete");
}
