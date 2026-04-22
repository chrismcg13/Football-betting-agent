import { db, paperBetsCurrentView, matchesTable, modelStateTable, learningNarrativesTable, complianceLogsTable } from "@workspace/db";
import { inArray, desc, sql, gte, and, isNotNull, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getMarketFamily } from "./edgeConcentration";

export interface TrendMetrics {
  last7d: { clv: number; roi: number; winRate: number; bets: number };
  last30d: { clv: number; roi: number; winRate: number; bets: number };
  allTime: { clv: number; roi: number; winRate: number; bets: number };
}

export interface LeagueMarketPerformance {
  league: string;
  marketFamily: string;
  bets: number;
  roi: number;
  clv: number;
  winRate: number;
  pnl: number;
}

export interface CalibrationBucket {
  predictedRange: string;
  predictedAvg: number;
  actualWinRate: number;
  bets: number;
  drift: number;
}

export interface FeatureImportanceChange {
  feature: string;
  current: number;
  previous: number;
  change: number;
  direction: "increased" | "decreased" | "stable";
}

export interface ParameterRecommendation {
  parameter: string;
  currentValue: string;
  recommendedAction: string;
  reason: string;
  expectedImpact: string;
  priority: "high" | "medium" | "low";
}

export interface ModelHealthReport {
  generatedAt: string;
  trends: TrendMetrics;
  bestPerformers: LeagueMarketPerformance[];
  worstPerformers: LeagueMarketPerformance[];
  featureChanges: FeatureImportanceChange[];
  calibration: CalibrationBucket[];
  calibrationScore: number;
  recommendations: ParameterRecommendation[];
  northStarVerdict: {
    clvHealthy: boolean;
    roiConfirming: boolean;
    diagnosis: string;
  };
}

async function computeTrends(): Promise<TrendMetrics> {
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d30 = new Date(now.getTime() - 30 * 86400000);

  const periods = [
    { label: "7d", since: d7 },
    { label: "30d", since: d30 },
    { label: "all", since: null },
  ] as const;

  const results: Record<string, { clv: number; roi: number; winRate: number; bets: number }> = {};

  for (const period of periods) {
    const whereClause = period.since
      ? and(
          inArray(paperBetsCurrentView.status, ["won", "lost"]),
          gte(paperBetsCurrentView.settledAt, period.since),
        )
      : inArray(paperBetsCurrentView.status, ["won", "lost"]);

    const result = await db.execute(sql`
      SELECT
        COUNT(*) AS bets,
        COALESCE(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) AS win_rate,
        COALESCE(SUM(settlement_pnl::numeric) / NULLIF(SUM(stake::numeric), 0) * 100, 0) AS roi,
        COALESCE(AVG(clv_pct::numeric) FILTER (WHERE clv_pct IS NOT NULL), 0) AS clv
      FROM paper_bets_current
      WHERE status IN ('won', 'lost')
      ${period.since ? sql`AND settled_at >= ${period.since}` : sql``}
    `);

    const row = result.rows[0] as Record<string, unknown>;
    results[period.label] = {
      bets: Number(row?.bets ?? 0),
      winRate: Math.round(Number(row?.win_rate ?? 0) * 10000) / 100,
      roi: Math.round(Number(row?.roi ?? 0) * 100) / 100,
      clv: Math.round(Number(row?.clv ?? 0) * 100) / 100,
    };
  }

  return {
    last7d: results["7d"]!,
    last30d: results["30d"]!,
    allTime: results["all"]!,
  };
}

async function computeLeagueMarketPerformance(): Promise<{
  best: LeagueMarketPerformance[];
  worst: LeagueMarketPerformance[];
}> {
  const result = await db.execute(sql`
    SELECT
      m.league,
      pb.market_type,
      COUNT(*) AS bets,
      COALESCE(SUM(pb.settlement_pnl::numeric), 0) AS pnl,
      COALESCE(SUM(pb.stake::numeric), 0) AS total_stake,
      COALESCE(SUM(CASE WHEN pb.status = 'won' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0), 0) AS win_rate,
      COALESCE(AVG(pb.clv_pct::numeric) FILTER (WHERE pb.clv_pct IS NOT NULL), 0) AS clv
    FROM paper_bets_current pb
    JOIN matches m ON pb.match_id = m.id
    WHERE pb.status IN ('won', 'lost')
    GROUP BY m.league, pb.market_type
    HAVING COUNT(*) >= 3
    ORDER BY COALESCE(SUM(pb.settlement_pnl::numeric), 0) / NULLIF(SUM(pb.stake::numeric), 0) DESC
  `);

  const all: LeagueMarketPerformance[] = (result.rows as Record<string, unknown>[]).map((r) => ({
    league: String(r.league),
    marketFamily: getMarketFamily(String(r.market_type)),
    bets: Number(r.bets),
    roi: Math.round((Number(r.pnl) / Math.max(Number(r.total_stake), 1)) * 10000) / 100,
    clv: Math.round(Number(r.clv) * 100) / 100,
    winRate: Math.round(Number(r.win_rate) * 10000) / 100,
    pnl: Math.round(Number(r.pnl) * 100) / 100,
  }));

  return {
    best: all.slice(0, 5),
    worst: all.slice(-5).reverse(),
  };
}

async function computeCalibration(): Promise<{ buckets: CalibrationBucket[]; score: number }> {
  const result = await db.execute(sql`
    SELECT
      model_probability,
      status
    FROM paper_bets_current
    WHERE status IN ('won', 'lost')
    AND model_probability IS NOT NULL
  `);

  const rows = result.rows as Record<string, unknown>[];
  if (rows.length < 10) {
    return { buckets: [], score: 100 };
  }

  const bucketDefs = [
    { label: "0-20%", lo: 0, hi: 0.2 },
    { label: "20-30%", lo: 0.2, hi: 0.3 },
    { label: "30-40%", lo: 0.3, hi: 0.4 },
    { label: "40-50%", lo: 0.4, hi: 0.5 },
    { label: "50-60%", lo: 0.5, hi: 0.6 },
    { label: "60-70%", lo: 0.6, hi: 0.7 },
    { label: "70-80%", lo: 0.7, hi: 0.8 },
    { label: "80-100%", lo: 0.8, hi: 1.0 },
  ];

  const buckets: CalibrationBucket[] = [];
  let totalDriftSquared = 0;
  let bucketCount = 0;

  for (const def of bucketDefs) {
    const inBucket = rows.filter((r) => {
      const p = Number(r.model_probability);
      return p >= def.lo && p < def.hi;
    });

    if (inBucket.length < 3) continue;

    const predictedAvg = inBucket.reduce((s, r) => s + Number(r.model_probability), 0) / inBucket.length;
    const wins = inBucket.filter((r) => String(r.status) === "won").length;
    const actualWinRate = wins / inBucket.length;
    const drift = Math.round((actualWinRate - predictedAvg) * 10000) / 100;

    buckets.push({
      predictedRange: def.label,
      predictedAvg: Math.round(predictedAvg * 10000) / 100,
      actualWinRate: Math.round(actualWinRate * 10000) / 100,
      bets: inBucket.length,
      drift,
    });

    totalDriftSquared += (actualWinRate - predictedAvg) ** 2;
    bucketCount++;
  }

  const rmse = bucketCount > 0 ? Math.sqrt(totalDriftSquared / bucketCount) : 0;
  const score = Math.round(Math.max(0, (1 - rmse * 5)) * 100);

  return { buckets, score };
}

async function computeFeatureChanges(): Promise<FeatureImportanceChange[]> {
  const states = await db
    .select({
      featureImportances: modelStateTable.featureImportances,
      createdAt: modelStateTable.createdAt,
    })
    .from(modelStateTable)
    .orderBy(desc(modelStateTable.createdAt))
    .limit(2);

  if (states.length < 2) return [];

  const current = (states[0]?.featureImportances as Record<string, number>) ?? {};
  const previous = (states[1]?.featureImportances as Record<string, number>) ?? {};

  const allFeatures = new Set([...Object.keys(current), ...Object.keys(previous)]);
  const changes: FeatureImportanceChange[] = [];

  for (const feature of allFeatures) {
    const curr = current[feature] ?? 0;
    const prev = previous[feature] ?? 0;
    const change = Math.round((curr - prev) * 10000) / 10000;
    const absChange = Math.abs(change);

    changes.push({
      feature,
      current: Math.round(curr * 10000) / 10000,
      previous: Math.round(prev * 10000) / 10000,
      change,
      direction: absChange < 0.01 ? "stable" : change > 0 ? "increased" : "decreased",
    });
  }

  return changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

function generateRecommendations(
  trends: TrendMetrics,
  calibration: { buckets: CalibrationBucket[]; score: number },
  featureChanges: FeatureImportanceChange[],
  best: LeagueMarketPerformance[],
  worst: LeagueMarketPerformance[],
): ParameterRecommendation[] {
  const recs: ParameterRecommendation[] = [];

  if (trends.last30d.clv > 3 && trends.last30d.roi > 5 && trends.last30d.bets >= 30) {
    recs.push({
      parameter: "live_risk_level",
      currentValue: "evaluate current",
      recommendedAction: "Consider level promotion evaluation",
      reason: `30-day CLV ${trends.last30d.clv}% and ROI ${trends.last30d.roi}% both strong with ${trends.last30d.bets} bets`,
      expectedImpact: "Higher stakes → proportionally larger returns if edge persists",
      priority: "medium",
    });
  }

  if (trends.last7d.clv < 0 && trends.last30d.clv > 0) {
    recs.push({
      parameter: "betting_pace",
      currentValue: "normal",
      recommendedAction: "Monitor closely — short-term CLV dip",
      reason: `7-day CLV ${trends.last7d.clv}% is negative but 30-day ${trends.last30d.clv}% is positive — likely variance, not edge loss`,
      expectedImpact: "No action needed unless 30-day CLV also turns negative",
      priority: "low",
    });
  }

  if (trends.last30d.clv < 0 && trends.last30d.bets >= 20) {
    recs.push({
      parameter: "model_confidence",
      currentValue: "standard",
      recommendedAction: "Tighten edge threshold — model may be losing calibration",
      reason: `30-day CLV is ${trends.last30d.clv}% — the model is consistently on the wrong side of closing lines`,
      expectedImpact: "Fewer bets but higher expected quality. CLV should recover.",
      priority: "high",
    });
  }

  if (trends.last30d.clv > 2 && trends.last30d.roi < 0 && trends.last30d.bets >= 20) {
    recs.push({
      parameter: "none",
      currentValue: "n/a",
      recommendedAction: "HEALTHY model with temporary negative ROI — hold course",
      reason: `CLV ${trends.last30d.clv}% is positive (beating closing lines), ROI ${trends.last30d.roi}% is just variance. This is expected.`,
      expectedImpact: "ROI should converge to CLV over time. No intervention needed.",
      priority: "low",
    });
  }

  if (calibration.score < 60) {
    recs.push({
      parameter: "model_retraining",
      currentValue: `calibration score: ${calibration.score}`,
      recommendedAction: "Force model retrain — calibration drift detected",
      reason: `Calibration score ${calibration.score}/100 indicates predicted probabilities don't match actual outcomes`,
      expectedImpact: "Better edge estimates → fewer false-positive value bets",
      priority: "high",
    });
  }

  for (const w of worst) {
    if (w.bets >= 10 && w.roi < -20 && w.clv < -2) {
      recs.push({
        parameter: "market_focus",
        currentValue: `${w.league} / ${w.marketFamily}`,
        recommendedAction: `Consider reducing exposure to ${w.league} ${w.marketFamily}`,
        reason: `${w.bets} bets, ${w.roi}% ROI, ${w.clv}% CLV — consistent negative edge`,
        expectedImpact: `Removing ~${w.bets} low-quality bets. Reallocation to profitable segments.`,
        priority: "medium",
      });
    }
  }

  for (const b of best) {
    if (b.bets >= 10 && b.roi > 10 && b.clv > 2) {
      recs.push({
        parameter: "market_focus",
        currentValue: `${b.league} / ${b.marketFamily}`,
        recommendedAction: `Expand exposure to ${b.league} ${b.marketFamily}`,
        reason: `${b.bets} bets, ${b.roi}% ROI, ${b.clv}% CLV — consistent genuine edge`,
        expectedImpact: `More volume in proven profitable segment`,
        priority: "medium",
      });
    }
  }

  return recs;
}

export async function generateModelHealthReport(): Promise<ModelHealthReport> {
  logger.info("Generating weekly model health report");

  const trends = await computeTrends();
  const { best, worst } = await computeLeagueMarketPerformance();
  const calibration = await computeCalibration();
  const featureChanges = await computeFeatureChanges();
  const recommendations = generateRecommendations(trends, calibration, featureChanges, best, worst);

  const clvHealthy = trends.last30d.clv > 0;
  const roiConfirming = trends.last30d.roi > 0;

  let diagnosis: string;
  if (clvHealthy && roiConfirming) {
    diagnosis = "HEALTHY — positive CLV confirmed by positive ROI. Edge is real and materializing.";
  } else if (clvHealthy && !roiConfirming) {
    diagnosis = "HEALTHY (variance) — positive CLV with temporary negative ROI. Model has edge, results will converge. Hold course.";
  } else if (!clvHealthy && roiConfirming) {
    diagnosis = "WARNING (lucky) — negative CLV but positive ROI. Results are running above expectation. Edge may not be real. Investigate.";
  } else {
    diagnosis = "UNHEALTHY — negative CLV and negative ROI. Model is not finding edge. Tighten parameters or review data quality.";
  }

  const report: ModelHealthReport = {
    generatedAt: new Date().toISOString(),
    trends,
    bestPerformers: best,
    worstPerformers: worst,
    featureChanges,
    calibration: calibration.buckets,
    calibrationScore: calibration.score,
    recommendations,
    northStarVerdict: { clvHealthy, roiConfirming, diagnosis },
  };

  await db.insert(learningNarrativesTable).values({
    narrativeType: "model_health_report",
    narrativeText: `Weekly Model Health Report — ${diagnosis}`,
    relatedData: report,
    createdAt: new Date(),
  });

  await db.insert(complianceLogsTable).values({
    actionType: "model_health_report",
    details: {
      calibrationScore: calibration.score,
      clv30d: trends.last30d.clv,
      roi30d: trends.last30d.roi,
      bets30d: trends.last30d.bets,
      recommendationCount: recommendations.length,
      verdict: diagnosis,
    },
    timestamp: new Date(),
  });

  logger.info(
    {
      calibrationScore: calibration.score,
      clv30d: trends.last30d.clv,
      roi30d: trends.last30d.roi,
      verdict: clvHealthy ? "HEALTHY" : "NEEDS_ATTENTION",
      recommendations: recommendations.length,
    },
    "Model health report generated",
  );

  return report;
}
