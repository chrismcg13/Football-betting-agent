import { db, matchesTable, oddsSnapshotsTable, complianceLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  listCompetitions,
  listEvents,
  listMarketCatalogue,
  listMarketBook,
  MARKET_TYPES,
} from "./betfair";

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

function parseTeams(eventName: string): { home: string; away: string } {
  const parts = eventName.split(" v ");
  if (parts.length === 2) {
    return { home: parts[0]!.trim(), away: parts[1]!.trim() };
  }
  const vsParts = eventName.split(" vs ");
  if (vsParts.length === 2) {
    return { home: vsParts[0]!.trim(), away: vsParts[1]!.trim() };
  }
  return { home: eventName, away: "Unknown" };
}

export async function runDataIngestion(): Promise<void> {
  const startedAt = new Date();
  logger.info("Starting Betfair data ingestion run");

  await logCompliance("decision", {
    action: "data_ingestion_start",
    timestamp: startedAt.toISOString(),
    data_sources: ["betfair_delayed"],
  });

  try {
    const competitions = await listCompetitions("1");
    logger.info({ count: competitions.length }, "Fetched competitions");

    const competitionIds = competitions.map((c) => c.competition.id);

    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 7);

    const events = await listEvents(competitionIds, from, to);
    logger.info({ count: events.length }, "Fetched upcoming events");

    let newMatches = 0;

    for (const ev of events) {
      if (!ev.event.openDate) continue;

      const existing = await db
        .select({ id: matchesTable.id })
        .from(matchesTable)
        .where(eq(matchesTable.betfairEventId, ev.event.id))
        .limit(1);

      if (existing.length === 0) {
        const { home, away } = parseTeams(ev.event.name);
        await db.insert(matchesTable).values({
          homeTeam: home,
          awayTeam: away,
          league: "Unknown",
          country: ev.event.countryCode ?? "Unknown",
          kickoffTime: new Date(ev.event.openDate),
          status: "scheduled",
          betfairEventId: ev.event.id,
        });
        newMatches++;
      }
    }

    logger.info({ newMatches }, "Saved new matches");

    const upcomingMatches = await db
      .select()
      .from(matchesTable)
      .where(eq(matchesTable.status, "scheduled"));

    if (upcomingMatches.length === 0) {
      logger.info("No upcoming matches — skipping odds fetch");
      return;
    }

    const eventIds = upcomingMatches
      .map((m) => m.betfairEventId)
      .filter((id): id is string => id !== null);

    if (eventIds.length === 0) {
      logger.info("No Betfair event IDs — skipping odds fetch");
      return;
    }

    const CHUNK_SIZE = 50;
    const marketItems: Awaited<ReturnType<typeof listMarketCatalogue>> = [];

    for (let i = 0; i < eventIds.length; i += CHUNK_SIZE) {
      const chunk = eventIds.slice(i, i + CHUNK_SIZE);
      const items = await listMarketCatalogue(chunk, [...MARKET_TYPES]);
      marketItems.push(...items);
    }

    logger.info({ count: marketItems.length }, "Fetched market catalogue");

    const marketIds = marketItems.map((m) => m.marketId);
    const marketBooks = await listMarketBook(marketIds);

    const marketBookMap = new Map(marketBooks.map((b) => [b.marketId, b]));
    const marketCatalogueMap = new Map(marketItems.map((m) => [m.marketId, m]));

    const snapshotTime = new Date();
    let snapshotCount = 0;

    for (const marketId of marketIds) {
      const catalogue = marketCatalogueMap.get(marketId);
      const book = marketBookMap.get(marketId);

      if (!catalogue || !book) continue;

      const eventId = catalogue.event.id;
      const match = upcomingMatches.find((m) => m.betfairEventId === eventId);
      if (!match) continue;

      const marketType =
        catalogue.description?.marketType ?? "UNKNOWN";

      const runnerNames = new Map(
        (catalogue.runners ?? []).map((r) => [r.selectionId, r.runnerName]),
      );

      for (const runner of book.runners) {
        if (runner.status !== "ACTIVE") continue;

        const selectionName =
          runnerNames.get(runner.selectionId) ?? String(runner.selectionId);

        const bestBack = runner.ex?.availableToBack?.[0];
        const bestLay = runner.ex?.availableToLay?.[0];

        if (!bestBack && !bestLay) continue;

        await db.insert(oddsSnapshotsTable).values({
          matchId: match.id,
          marketType,
          selectionName,
          backOdds: bestBack ? String(bestBack.price) : null,
          layOdds: bestLay ? String(bestLay.price) : null,
          snapshotTime,
          source: "betfair_delayed",
        });

        snapshotCount++;
      }
    }

    logger.info({ snapshotCount }, "Saved odds snapshots");

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    await logCompliance("decision", {
      action: "data_ingestion_complete",
      timestamp: finishedAt.toISOString(),
      duration_ms: durationMs,
      new_matches: newMatches,
      markets_processed: marketItems.length,
      snapshots_saved: snapshotCount,
      data_sources: ["betfair_delayed"],
    });

    logger.info({ durationMs }, "Data ingestion complete");
  } catch (err) {
    logger.error({ err }, "Data ingestion failed");

    await logCompliance("circuit_breaker", {
      action: "data_ingestion_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      data_sources: ["betfair_delayed"],
    });

    throw err;
  }
}
