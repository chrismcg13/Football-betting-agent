import {
  db,
  matchesTable,
  oddsSnapshotsTable,
  featuresTable,
  complianceLogsTable,
  agentConfigTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  predictOutcome,
  predictBtts,
  predictOverUnder,
  getModelVersion,
} from "./predictionEngine";

export interface ValueBet {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoffTime: Date;
  marketType: string;
  selectionName: string;
  modelProbability: number;
  impliedProbability: number;
  edge: number;
  backOdds: number;
  modelVersion: string | null;
}

export interface EvaluationSummary {
  matchesEvaluated: number;
  selectionsEvaluated: number;
  valueBetsFound: number;
  modelVersion: string | null;
  valueBets: ValueBet[];
}

export async function detectValueBets(): Promise<EvaluationSummary> {
  const modelVersion = getModelVersion();
  logger.info({ modelVersion }, "Running value detection");

  // Read min_edge_threshold from agent_config
  const configRows = await db
    .select()
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, "min_edge_threshold"));
  const minEdge = Number(configRows[0]?.value ?? "0.03");

  const matches = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.status, "scheduled"));

  const valueBets: ValueBet[] = [];
  let selectionsEvaluated = 0;

  for (const match of matches) {
    // Fetch latest odds snapshots (all markets)
    const oddsRows = await db
      .select()
      .from(oddsSnapshotsTable)
      .where(eq(oddsSnapshotsTable.matchId, match.id))
      .orderBy(desc(oddsSnapshotsTable.snapshotTime));
    if (oddsRows.length === 0) continue;

    // Fetch features for this match
    const featureRows = await db
      .select()
      .from(featuresTable)
      .where(eq(featuresTable.matchId, match.id));

    const publicFeatures = featureRows.filter(
      (f) => !f.featureName.startsWith("_"),
    );
    if (publicFeatures.length < 8) continue;

    const featureMap: Record<string, number> = {};
    for (const f of publicFeatures) {
      featureMap[f.featureName] = Number(f.featureValue);
    }

    // Get model predictions
    const outcomePreds = predictOutcome(featureMap);
    const bttsPreds = predictBtts(featureMap);
    const ouPreds = predictOverUnder(featureMap);

    // De-duplicate: keep only the latest odds per market+selection
    const latestOdds = new Map<
      string,
      (typeof oddsRows)[0]
    >();
    for (const row of oddsRows) {
      const key = `${row.marketType}:${row.selectionName}`;
      if (!latestOdds.has(key)) latestOdds.set(key, row);
    }

    for (const [, oddsRow] of latestOdds) {
      if (!oddsRow.backOdds) continue;
      const backOdds = Number(oddsRow.backOdds);
      if (backOdds <= 1.01) continue;
      const impliedProb = 1 / backOdds;

      // Map market+selection to model probability
      let modelProb: number | null = null;
      if (oddsRow.marketType === "MATCH_ODDS" && outcomePreds) {
        if (oddsRow.selectionName === "Home") modelProb = outcomePreds.home;
        else if (oddsRow.selectionName === "Draw") modelProb = outcomePreds.draw;
        else if (oddsRow.selectionName === "Away") modelProb = outcomePreds.away;
      } else if (oddsRow.marketType === "BTTS" && bttsPreds) {
        if (oddsRow.selectionName === "Yes") modelProb = bttsPreds.yes;
        else if (oddsRow.selectionName === "No") modelProb = bttsPreds.no;
      } else if (oddsRow.marketType === "OVER_UNDER_25" && ouPreds) {
        if (oddsRow.selectionName === "Over 2.5 Goals") modelProb = ouPreds.over;
        else if (oddsRow.selectionName === "Under 2.5 Goals")
          modelProb = ouPreds.under;
      }

      if (modelProb === null) continue;
      selectionsEvaluated++;

      const edge = modelProb - impliedProb;
      const isValueBet = edge > minEdge;
      const decision = isValueBet ? "value_bet" : "skip";

      // Log every evaluation to compliance_logs
      await db.insert(complianceLogsTable).values({
        actionType: "value_detection_evaluation",
        details: {
          matchId: match.id,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          marketType: oddsRow.marketType,
          selectionName: oddsRow.selectionName,
          backOdds,
          impliedProbability: impliedProb,
          modelProbability: modelProb,
          calculatedEdge: edge,
          minEdgeThreshold: minEdge,
          decision,
          modelVersion,
        },
        timestamp: new Date(),
      });

      if (isValueBet) {
        valueBets.push({
          matchId: match.id,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league,
          kickoffTime: match.kickoffTime,
          marketType: oddsRow.marketType,
          selectionName: oddsRow.selectionName,
          modelProbability: modelProb,
          impliedProbability: impliedProb,
          edge,
          backOdds,
          modelVersion,
        });
      }
    }
  }

  // Sort by edge descending
  valueBets.sort((a, b) => b.edge - a.edge);

  logger.info(
    {
      matchesEvaluated: matches.length,
      selectionsEvaluated,
      valueBetsFound: valueBets.length,
    },
    "Value detection complete",
  );

  return {
    matchesEvaluated: matches.length,
    selectionsEvaluated,
    valueBetsFound: valueBets.length,
    modelVersion,
    valueBets,
  };
}
