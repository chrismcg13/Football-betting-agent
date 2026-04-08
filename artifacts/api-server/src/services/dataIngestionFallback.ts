import {
  db,
  matchesTable,
  oddsSnapshotsTable,
  complianceLogsTable,
  featuresTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  listUpcomingMatches,
  extractOddsFromMatch,
  mapMatchStatus,
} from "./footballData";

async function logCompliance(
  actionType: string,
  details: Record<string, unknown>,
) {
  try {
    await db.insert(complianceLogsTable).values({
      actionType,
      details,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error({ err }, "Failed to write compliance log");
  }
}

async function upsertTeamIdFeature(
  matchId: number,
  featureName: string,
  teamId: number,
): Promise<void> {
  const existing = await db
    .select({ id: featuresTable.id })
    .from(featuresTable)
    .where(
      and(
        eq(featuresTable.matchId, matchId),
        eq(featuresTable.featureName, featureName),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    await db.insert(featuresTable).values({
      matchId,
      featureName,
      featureValue: String(teamId),
      computedAt: new Date(),
    });
  }
}

export async function runFallbackIngestion(): Promise<void> {
  const startedAt = new Date();
  logger.info("Starting football-data.org fallback ingestion run");

  await logCompliance("decision", {
    action: "data_ingestion_start",
    timestamp: startedAt.toISOString(),
    data_sources: ["football_data_fallback"],
  });

  try {
    const matches = await listUpcomingMatches(7);
    logger.info(
      { count: matches.length },
      "Fetched matches from football-data.org",
    );

    let newMatches = 0;
    let updatedMatches = 0;

    for (const match of matches) {
      if (!match.homeTeam?.name || !match.awayTeam?.name) continue;

      const fdId = String(match.id);
      const status = mapMatchStatus(match.status);

      const existing = await db
        .select({ id: matchesTable.id })
        .from(matchesTable)
        .where(eq(matchesTable.betfairEventId, `fd_${fdId}`))
        .limit(1);

      let dbMatchId: number;

      if (existing.length === 0) {
        const [inserted] = await db
          .insert(matchesTable)
          .values({
            homeTeam: match.homeTeam.name,
            awayTeam: match.awayTeam.name,
            league: match.competition.name,
            country: match.competition.area?.name ?? "Unknown",
            kickoffTime: new Date(match.utcDate),
            status,
            betfairEventId: `fd_${fdId}`,
          })
          .returning({ id: matchesTable.id });

        dbMatchId = inserted!.id;
        newMatches++;
      } else {
        dbMatchId = existing[0]!.id;
        await db
          .update(matchesTable)
          .set({ status })
          .where(eq(matchesTable.betfairEventId, `fd_${fdId}`));
        updatedMatches++;
      }

      if (match.homeTeam.id) {
        await upsertTeamIdFeature(dbMatchId, "_home_team_id", match.homeTeam.id);
      }
      if (match.awayTeam.id) {
        await upsertTeamIdFeature(dbMatchId, "_away_team_id", match.awayTeam.id);
      }
    }

    logger.info({ newMatches, updatedMatches }, "Matches upserted");

    const snapshotTime = new Date();
    let snapshotCount = 0;

    for (const match of matches) {
      if (!match.homeTeam?.name || !match.awayTeam?.name) continue;

      const fdId = `fd_${String(match.id)}`;
      const dbMatch = await db
        .select({ id: matchesTable.id })
        .from(matchesTable)
        .where(eq(matchesTable.betfairEventId, fdId))
        .limit(1);

      if (dbMatch.length === 0 || !dbMatch[0]) continue;
      const matchId = dbMatch[0].id;

      const odds = extractOddsFromMatch(match);
      if (!odds) continue;

      const runners: Array<{ name: string; odds: number | null }> = [
        { name: match.homeTeam.name, odds: odds.homeWin },
        { name: "Draw", odds: odds.draw },
        { name: match.awayTeam.name, odds: odds.awayWin },
      ];

      for (const runner of runners) {
        if (runner.odds === null) continue;

        const backOdds = String(runner.odds);
        const layOdds = String(Math.round(runner.odds * 1.02 * 100) / 100);

        await db.insert(oddsSnapshotsTable).values({
          matchId,
          marketType: "MATCH_ODDS",
          selectionName: runner.name,
          backOdds,
          layOdds,
          snapshotTime,
          source: "football_data",
        });

        snapshotCount++;
      }
    }

    logger.info({ snapshotCount }, "Odds snapshots saved");

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    await logCompliance("decision", {
      action: "data_ingestion_complete",
      timestamp: finishedAt.toISOString(),
      duration_ms: durationMs,
      new_matches: newMatches,
      updated_matches: updatedMatches,
      snapshots_saved: snapshotCount,
      data_sources: ["football_data_fallback"],
    });

    logger.info({ durationMs }, "Fallback ingestion complete");
  } catch (err) {
    logger.error({ err }, "Fallback ingestion failed");

    await logCompliance("circuit_breaker", {
      action: "data_ingestion_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      data_sources: ["football_data_fallback"],
    });

    throw err;
  }
}
