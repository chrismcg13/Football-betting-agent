import { db, paperBetsTable, learningNarrativesTable, complianceLogsTable } from "@workspace/db";
import { sql, desc, and, inArray, isNotNull, gte } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getConfigValue } from "./paperTrading";

export interface AgentRecommendation {
  id: string;
  category: "resource" | "data_quality" | "model" | "strategy" | "risk" | "enhancement";
  title: string;
  description: string;
  impact: string;
  estimatedClvImpact: string;
  estimatedRoiImpact: string;
  estimatedCost: string;
  priority: "critical" | "high" | "medium" | "low";
  actionRequired: "user_decision" | "monitoring" | "informational";
  createdAt: string;
}

export interface PerformanceAttribution {
  dataSource: string;
  contribution: string;
  clvImpact: number;
  betCount: number;
  recommendation: string;
}

export interface AgentRecommendationReport {
  generatedAt: string;
  recommendations: AgentRecommendation[];
  performanceAttribution: PerformanceAttribution[];
  resourceUtilization: {
    apiFootball: { used: number; limit: number; pct: number; alert: boolean };
    oddsPapi: { used: number; limit: number; pct: number; alert: boolean };
  };
}

async function checkApiFootballBudget(): Promise<{ used: number; limit: number; pct: number; alert: boolean }> {
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(request_count), 0)::int AS used
    FROM api_usage
    WHERE endpoint NOT LIKE 'oddspapi_%'
    AND date LIKE ${monthPrefix + "%"}
  `);
  const used = Number((result.rows[0] as Record<string, unknown>)?.used ?? 0);
  const limit = 75000;
  const pct = Math.round((used / limit) * 100);
  return { used, limit, pct, alert: pct >= 80 };
}

async function checkOddsPapiBudget(): Promise<{ used: number; limit: number; pct: number; alert: boolean }> {
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(request_count), 0)::int AS used
    FROM api_usage
    WHERE endpoint LIKE 'oddspapi_%'
    AND date LIKE ${monthPrefix + "%"}
  `);
  const used = Number((result.rows[0] as Record<string, unknown>)?.used ?? 0);
  const limit = 100000;
  const pct = Math.round((used / limit) * 100);
  return { used, limit, pct, alert: pct >= 80 };
}

async function analyzeDataSourceContribution(): Promise<PerformanceAttribution[]> {
  const attributions: PerformanceAttribution[] = [];

  const pinnacleResult = await db.execute(sql`
    SELECT
      COUNT(*) AS bets,
      COALESCE(AVG(clv_pct::numeric) FILTER (WHERE clv_pct IS NOT NULL), 0) AS avg_clv,
      COALESCE(SUM(settlement_pnl::numeric) / NULLIF(SUM(stake::numeric), 0) * 100, 0) AS roi
    FROM paper_bets
    WHERE status IN ('won', 'lost')
    AND closing_pinnacle_odds IS NOT NULL
  `);
  const pinnRow = pinnacleResult.rows[0] as Record<string, unknown>;

  const noPinnacleResult = await db.execute(sql`
    SELECT
      COUNT(*) AS bets,
      COALESCE(AVG(clv_pct::numeric) FILTER (WHERE clv_pct IS NOT NULL), 0) AS avg_clv,
      COALESCE(SUM(settlement_pnl::numeric) / NULLIF(SUM(stake::numeric), 0) * 100, 0) AS roi
    FROM paper_bets
    WHERE status IN ('won', 'lost')
    AND closing_pinnacle_odds IS NULL
  `);
  const noPinnRow = noPinnacleResult.rows[0] as Record<string, unknown>;

  const pinnClv = Number(pinnRow?.avg_clv ?? 0);
  const noPinnClv = Number(noPinnRow?.avg_clv ?? 0);
  const pinnBets = Number(pinnRow?.bets ?? 0);
  const noPinnBets = Number(noPinnRow?.bets ?? 0);

  attributions.push({
    dataSource: "Pinnacle Odds (OddsPapi)",
    contribution: pinnBets > 0 ? `${pinnBets} bets with Pinnacle data, CLV ${pinnClv.toFixed(1)}%` : "No bets with Pinnacle data yet",
    clvImpact: Math.round(pinnClv * 100) / 100,
    betCount: pinnBets,
    recommendation: pinnClv > noPinnClv
      ? "Pinnacle data improves CLV — consider expanding OddsPapi coverage"
      : "Pinnacle data shows no CLV advantage — review integration value",
  });

  attributions.push({
    dataSource: "Model Only (no Pinnacle)",
    contribution: noPinnBets > 0 ? `${noPinnBets} bets without Pinnacle data, CLV ${noPinnClv.toFixed(1)}%` : "N/A",
    clvImpact: Math.round(noPinnClv * 100) / 100,
    betCount: noPinnBets,
    recommendation: noPinnClv > pinnClv
      ? "Model alone performs well — Pinnacle adds validation but core edge comes from features"
      : "Pinnacle data is key differentiator — protect OddsPapi budget",
  });

  try {
    const lineupResult = await db.execute(sql`
      SELECT
        COUNT(*) AS bets,
        COALESCE(AVG(pb.clv_pct::numeric) FILTER (WHERE pb.clv_pct IS NOT NULL), 0) AS avg_clv
      FROM paper_bets pb
      WHERE pb.status IN ('won', 'lost')
      AND pb.pinnacle_odds IS NOT NULL
    `);
    const lineupRow = lineupResult.rows[0] as Record<string, unknown>;
    const lineupBets = Number(lineupRow?.bets ?? 0);
    const lineupClv = Number(lineupRow?.avg_clv ?? 0);

    if (lineupBets > 0) {
      attributions.push({
        dataSource: "Pinnacle-validated bets",
        contribution: `${lineupBets} bets with Pinnacle pre-bet validation, CLV ${lineupClv.toFixed(1)}%`,
        clvImpact: Math.round(lineupClv * 100) / 100,
        betCount: lineupBets,
        recommendation: lineupClv > 2 ? "Pinnacle validation adds edge — maintain pre-bet filter" : "Pinnacle validation showing limited CLV impact — review filter thresholds",
      });
    }
  } catch { /* features table may not be joinable — skip */ }

  return attributions;
}

function generateResourceRecommendations(
  apiFootball: { used: number; limit: number; pct: number; alert: boolean },
  oddsPapi: { used: number; limit: number; pct: number; alert: boolean },
): AgentRecommendation[] {
  const recs: AgentRecommendation[] = [];

  if (apiFootball.alert) {
    recs.push({
      id: `res-af-${Date.now()}`,
      category: "resource",
      title: "API-Football budget approaching limit",
      description: `Used ${apiFootball.used.toLocaleString()} of ${apiFootball.limit.toLocaleString()} requests (${apiFootball.pct}%). Current pace may exhaust budget before month end.`,
      impact: "If budget is exhausted: no odds updates, no settlement, no lineup capture for remaining days",
      estimatedClvImpact: "Loss of real-time odds → stale predictions → estimated -2-5% CLV degradation",
      estimatedRoiImpact: "Settlement delays + missed value opportunities → -3-8% ROI impact",
      estimatedCost: "Free — requires reallocation of existing requests, not new budget",
      priority: apiFootball.pct >= 90 ? "critical" : "high",
      actionRequired: "user_decision",
      createdAt: new Date().toISOString(),
    });
  }

  if (oddsPapi.alert) {
    recs.push({
      id: `res-op-${Date.now()}`,
      category: "resource",
      title: "OddsPapi budget approaching limit",
      description: `Used ${oddsPapi.used.toLocaleString()} of ${oddsPapi.limit.toLocaleString()} requests (${oddsPapi.pct}%). Pinnacle coverage may be reduced.`,
      impact: "Reduced Pinnacle coverage → weaker pre-bet validation → more bets without sharp-line confirmation",
      estimatedClvImpact: "Without Pinnacle filter: estimated -1-3% CLV on unvalidated bets",
      estimatedRoiImpact: "Lower confidence bets placed → -2-5% ROI risk",
      estimatedCost: "Consider budget increase or reallocate from P4 (exploratory) to P1 (pre-bet)",
      priority: oddsPapi.pct >= 90 ? "critical" : "high",
      actionRequired: "user_decision",
      createdAt: new Date().toISOString(),
    });
  }

  return recs;
}

function generateEnhancementOpportunities(): AgentRecommendation[] {
  return [
    {
      id: "enh-weather",
      category: "enhancement",
      title: "Weather data integration",
      description: "Extreme weather (heavy rain, snow, wind) affects goal scoring patterns, especially Over/Under markets. Free weather APIs available.",
      impact: "Could improve Over/Under market predictions in weather-affected leagues",
      estimatedClvImpact: "+0.5-1.5% CLV on O/U markets during extreme weather matches",
      estimatedRoiImpact: "+1-3% ROI on weather-sensitive bets",
      estimatedCost: "Free API (OpenWeatherMap) + ~2 hours development",
      priority: "low",
      actionRequired: "informational",
      createdAt: new Date().toISOString(),
    },
    {
      id: "enh-referee",
      category: "enhancement",
      title: "Referee data for cards markets",
      description: "Referee identity strongly correlates with card frequency. Some referees issue 2× more cards than average.",
      impact: "Could significantly improve Cards market predictions",
      estimatedClvImpact: "+1-3% CLV on cards markets specifically",
      estimatedRoiImpact: "+2-5% ROI on cards bets",
      estimatedCost: "API-Football already provides referee data — ~1 hour to integrate into features",
      priority: "medium",
      actionRequired: "informational",
      createdAt: new Date().toISOString(),
    },
  ];
}

export async function generateAgentRecommendations(): Promise<AgentRecommendationReport> {
  logger.info("Generating agent recommendations report");

  const apiFootball = await checkApiFootballBudget();
  const oddsPapi = await checkOddsPapiBudget();
  const performanceAttribution = await analyzeDataSourceContribution();

  const recommendations: AgentRecommendation[] = [
    ...generateResourceRecommendations(apiFootball, oddsPapi),
    ...generateEnhancementOpportunities(),
  ];

  const settledCount = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM paper_bets WHERE status IN ('won', 'lost')
  `).then(r => Number((r.rows[0] as Record<string, unknown>)?.cnt ?? 0));

  if (settledCount < 50) {
    recommendations.push({
      id: `strat-sample-${Date.now()}`,
      category: "strategy",
      title: "Insufficient sample size for reliable conclusions",
      description: `Only ${settledCount} settled bets. Most statistical conclusions require 50+ bets. Recommendations below are provisional.`,
      impact: "All performance metrics have wide confidence intervals",
      estimatedClvImpact: "Unknown — need more data",
      estimatedRoiImpact: "Unknown — need more data",
      estimatedCost: "Time — continue operating and collecting data",
      priority: "informational" as "low",
      actionRequired: "monitoring",
      createdAt: new Date().toISOString(),
    });
  }

  const report: AgentRecommendationReport = {
    generatedAt: new Date().toISOString(),
    recommendations,
    performanceAttribution,
    resourceUtilization: { apiFootball, oddsPapi },
  };

  await db.insert(complianceLogsTable).values({
    actionType: "agent_recommendations",
    details: {
      recommendationCount: recommendations.length,
      apiFootballPct: apiFootball.pct,
      oddsPapiPct: oddsPapi.pct,
      attributionSources: performanceAttribution.length,
    },
    timestamp: new Date(),
  });

  logger.info(
    { recommendations: recommendations.length, attributions: performanceAttribution.length },
    "Agent recommendations generated",
  );

  return report;
}
