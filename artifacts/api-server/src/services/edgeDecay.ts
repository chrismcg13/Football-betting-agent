import { db, paperBetsTable, learningNarrativesTable } from "@workspace/db";
import { sql, and, inArray, isNotNull, gte } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getMarketFamily } from "./edgeConcentration";

export interface EdgeDecayMetrics {
  marketFamily: string;
  bets: number;
  avgEdgeAtIdentification: number;
  avgClvAtClose: number;
  avgDecayPct: number;
  medianDecayHours: number | null;
  edgePersistenceScore: number;
  recommendation: string;
}

export interface EdgeDecaySummary {
  generatedAt: string;
  overallAvgDecay: number;
  byMarketFamily: EdgeDecayMetrics[];
  fastDecayingMarkets: string[];
  alerts: string[];
}

export async function analyzeEdgeDecay(): Promise<EdgeDecaySummary> {
  const result = await db.execute(sql`
    SELECT
      market_type,
      calculated_edge::float AS edge_at_ident,
      clv_pct::float AS clv_at_close,
      odds_at_placement::float AS odds_placed,
      pinnacle_odds::float AS pinnacle_at_ident,
      closing_pinnacle_odds::float AS pinnacle_at_close,
      placed_at,
      settled_at
    FROM paper_bets
    WHERE status IN ('won', 'lost')
    AND calculated_edge IS NOT NULL
    AND clv_pct IS NOT NULL
    ORDER BY settled_at DESC
    LIMIT 500
  `);

  const rows = result.rows as Record<string, unknown>[];

  if (rows.length < 10) {
    return {
      generatedAt: new Date().toISOString(),
      overallAvgDecay: 0,
      byMarketFamily: [],
      fastDecayingMarkets: [],
      alerts: ["Insufficient data for edge decay analysis (need 10+ settled bets with CLV)"],
    };
  }

  const familyGroups = new Map<string, {
    bets: number;
    edgeSum: number;
    clvSum: number;
    decayPctSum: number;
  }>();

  for (const row of rows) {
    const marketType = String(row.market_type);
    const family = getMarketFamily(marketType);
    const edgeAtIdent = Number(row.edge_at_ident) * 100;
    const clvAtClose = Number(row.clv_at_close);

    const decayPct = edgeAtIdent > 0 ? ((edgeAtIdent - clvAtClose) / edgeAtIdent) * 100 : 0;

    const existing = familyGroups.get(family) ?? { bets: 0, edgeSum: 0, clvSum: 0, decayPctSum: 0 };
    existing.bets++;
    existing.edgeSum += edgeAtIdent;
    existing.clvSum += clvAtClose;
    existing.decayPctSum += decayPct;
    familyGroups.set(family, existing);
  }

  const byMarketFamily: EdgeDecayMetrics[] = [];
  const fastDecayingMarkets: string[] = [];
  const alerts: string[] = [];
  let totalDecay = 0;
  let totalBets = 0;

  for (const [family, data] of familyGroups.entries()) {
    if (data.bets < 3) continue;

    const avgEdge = data.edgeSum / data.bets;
    const avgClv = data.clvSum / data.bets;
    const avgDecay = data.decayPctSum / data.bets;
    const persistenceScore = Math.round(Math.max(0, Math.min(100, 100 - avgDecay)));

    let recommendation: string;
    if (avgDecay > 80 && avgClv < 0.5) {
      recommendation = "DEPRIORITIZE — edge decays to near-zero before close. Consider timing optimization or market exit.";
      fastDecayingMarkets.push(family);
    } else if (avgDecay > 60) {
      recommendation = "OPTIMIZE TIMING — significant edge decay. Place bets faster or focus on less efficient markets.";
    } else if (avgDecay > 40) {
      recommendation = "MONITOR — moderate edge decay. Current timing is acceptable but could improve.";
    } else {
      recommendation = "HEALTHY — edge persists well to close. This market has good retention.";
    }

    byMarketFamily.push({
      marketFamily: family,
      bets: data.bets,
      avgEdgeAtIdentification: Math.round(avgEdge * 100) / 100,
      avgClvAtClose: Math.round(avgClv * 100) / 100,
      avgDecayPct: Math.round(avgDecay * 100) / 100,
      medianDecayHours: null,
      edgePersistenceScore: persistenceScore,
      recommendation,
    });

    totalDecay += avgDecay * data.bets;
    totalBets += data.bets;
  }

  const overallAvgDecay = totalBets > 0 ? Math.round((totalDecay / totalBets) * 100) / 100 : 0;

  if (fastDecayingMarkets.length > 0) {
    alerts.push(`Fast-decaying markets detected: ${fastDecayingMarkets.join(", ")}. Edge approaches zero before market close.`);
  }

  if (overallAvgDecay > 60) {
    alerts.push(`High overall edge decay (${overallAvgDecay}%). Consider optimizing bet timing across all markets.`);
  }

  byMarketFamily.sort((a, b) => a.edgePersistenceScore - b.edgePersistenceScore);

  const summary: EdgeDecaySummary = {
    generatedAt: new Date().toISOString(),
    overallAvgDecay,
    byMarketFamily,
    fastDecayingMarkets,
    alerts,
  };

  if (alerts.length > 0) {
    await db.insert(learningNarrativesTable).values({
      narrativeType: "edge_decay_analysis",
      narrativeText: `Edge Decay Analysis: Overall decay ${overallAvgDecay}%. ${alerts.join(" ")}`,
      relatedData: summary,
      createdAt: new Date(),
    });
  }

  logger.info(
    { overallAvgDecay, marketCount: byMarketFamily.length, fastDecaying: fastDecayingMarkets.length },
    "Edge decay analysis complete",
  );

  return summary;
}
