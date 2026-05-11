/**
 * Task 11 — Matchbook ingestion cron job (Phase 3d.2).
 *
 * Every 15 minutes (offset off the Smarkets cron):
 *   1. List Matchbook upcoming football events in the next 48h
 *   2. Map them to our internal match_id via team-name fuzzy match
 *   3. For each matched event, list markets and fetch best back/lay
 *      for the market types we trade
 *   4. Persist each (match, market, selection) snapshot via
 *      sharpConsensus.persistSourceSnapshot
 *
 * Gated behind agent_config.matchbook_ingestion_enabled = 'true'.
 * Defaults to false so the first deploy is a no-op until the operator
 * flips it on. Mirrors the Smarkets path 1:1.
 */

import { db, matchesTable, agentConfigTable, competitionConfigTable } from "@workspace/db";
import { and, gte, lte, eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import {
  listUpcomingFootballEvents,
  listMarkets,
  getMarketWithPrices,
  parseTeamsFromEventName,
  MATCHBOOK_MARKET_TYPE_MAP,
} from "./matchbookClient";
import { persistSourceSnapshot } from "../sharpConsensus";
import type { DevigMethod } from "../devig";
import { teamNameMatch } from "../apiFootball";

const LOOKAHEAD_MS = 48 * 60 * 60 * 1000;
const SUPPORTED_MARKET_TYPES = new Set([
  "MATCH_ODDS",
  "BTTS",
  "ASIAN_HANDICAP",
]);

export interface MatchbookIngestResult {
  enabled: boolean;
  events_fetched: number;
  events_matched: number;
  markets_fetched: number;
  snapshots_persisted: number;
  duration_ms: number;
}

async function getConfigValue(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function runMatchbookIngestion(): Promise<MatchbookIngestResult> {
  const startedAt = Date.now();
  const result: MatchbookIngestResult = {
    enabled: false,
    events_fetched: 0,
    events_matched: 0,
    markets_fetched: 0,
    snapshots_persisted: 0,
    duration_ms: 0,
  };

  const enabled = (await getConfigValue("matchbook_ingestion_enabled")) === "true";
  if (!enabled) {
    logger.debug("matchbook_ingestion_enabled != true — skipping");
    result.duration_ms = Date.now() - startedAt;
    return result;
  }
  result.enabled = true;

  const events = await listUpcomingFootballEvents(LOOKAHEAD_MS);
  result.events_fetched = events.length;
  if (events.length === 0) {
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  const now = new Date();
  const until = new Date(Date.now() + LOOKAHEAD_MS);
  const ourMatches = await db
    .select({
      id: matchesTable.id,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      league: matchesTable.league,
      kickoffTime: matchesTable.kickoffTime,
    })
    .from(matchesTable)
    .where(
      and(
        gte(matchesTable.kickoffTime, now),
        lte(matchesTable.kickoffTime, until),
        eq(matchesTable.status, "scheduled"),
      ),
    );

  const devigCfgRows = await db
    .select({
      name: competitionConfigTable.name,
      devigMethod: competitionConfigTable.devigMethod,
    })
    .from(competitionConfigTable);
  const devigByLeague = new Map<string, DevigMethod>(
    devigCfgRows.map((r) => [r.name, (r.devigMethod ?? "power") as DevigMethod]),
  );

  for (const ev of events) {
    const teams = parseTeamsFromEventName(ev.name);
    if (!teams) continue;
    const matched = ourMatches.find(
      (m) => teamNameMatch(m.homeTeam, teams.home) && teamNameMatch(m.awayTeam, teams.away),
    );
    if (!matched) continue;
    result.events_matched++;

    const markets = await listMarkets(ev.id);
    for (const m of markets) {
      const internalType = MATCHBOOK_MARKET_TYPE_MAP[m.market_type];
      if (!internalType || !SUPPORTED_MARKET_TYPES.has(internalType)) continue;
      result.markets_fetched++;

      const detailed = await getMarketWithPrices(m.id);
      if (!detailed?.runners?.length) continue;

      // Build { runner_name → best_back_odds }
      const oddsBySelection: Record<string, number> = {};
      for (const r of detailed.runners) {
        const bestBack = r.prices?.find((p) => p.side === "back" && p.odds > 1)?.odds;
        if (bestBack && bestBack > 1) {
          oddsBySelection[r.name] = bestBack;
        }
      }
      if (Object.keys(oddsBySelection).length === 0) continue;

      const devigMethod = devigByLeague.get(matched.league) ?? "power";
      const { rowsInserted } = await persistSourceSnapshot({
        matchId: matched.id,
        marketType: internalType,
        source: "matchbook",
        snapshotAt: new Date(),
        oddsBySelection,
        devigMethod,
        rawPayload: { matchbook_event_id: ev.id, matchbook_market_id: m.id },
      });
      result.snapshots_persisted += rowsInserted;
    }
  }

  result.duration_ms = Date.now() - startedAt;
  logger.info(result, "Matchbook ingestion complete");
  return result;
}
