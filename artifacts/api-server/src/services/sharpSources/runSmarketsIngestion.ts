/**
 * Task 11 — Smarkets ingestion cron job (Phase 3d.1).
 *
 * Every 15 minutes:
 *   1. List Smarkets upcoming football events in the next 48h
 *   2. Map them to our internal match_id via team-name fuzzy match
 *   3. For each matched event, list markets and fetch quotes for the
 *      market types we trade (MATCH_ODDS, BTTS, OVER_UNDER, ASIAN_HANDICAP)
 *   4. Persist each (match, market, selection) snapshot via
 *      sharpConsensus.persistSourceSnapshot
 *
 * The persist call runs de-vig (per-league configured method from Task 14)
 * and stores fair_probability + trust_weight for later consensus
 * aggregation by computeConsensusForSnapshot.
 *
 * Match identity resolution: re-uses teamNameMatch from apiFootball.ts
 * for fuzzy matching. A Smarkets event with team names that don't fuzzy-
 * match any upcoming match in our DB is silently skipped (logged at
 * debug level only).
 *
 * Gated behind agent_config.smarkets_ingestion_enabled = 'true'. Defaults
 * to false so the first deploy is a no-op until the operator flips it on.
 */

import { db, matchesTable, agentConfigTable, competitionConfigTable } from "@workspace/db";
import { and, gte, lte, eq, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import {
  listUpcomingFootballEvents,
  listMarkets,
  getMarketQuote,
  SMARKETS_MARKET_TYPE_MAP,
  type SmarketsContract,
} from "./smarketsClient";
import { persistSourceSnapshot } from "../sharpConsensus";
import type { DevigMethod } from "../devig";
import { teamNameMatch } from "../apiFootball";

// 2026-05-11 evening — direct API probe revealed that Smarkets-listed
// fixtures sit 3–30+ days out on most football competitions (e.g. UEFA
// Champions League final 19 days out). The original 48-hour lookahead
// dropped every event silently — 0 snapshots persisted across 1,500+
// cron runs. 14 days covers the CLV-relevant horizon (sharp money
// converges in the final ~96h pre-kickoff but the price drift starts
// earlier on big fixtures).
const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const SUPPORTED_MARKET_TYPES = new Set([
  "MATCH_ODDS",
  "BTTS",
  "ASIAN_HANDICAP",
]);

export interface SmarketsIngestResult {
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

export async function runSmarketsIngestion(): Promise<SmarketsIngestResult> {
  const startedAt = Date.now();
  const result: SmarketsIngestResult = {
    enabled: false,
    events_fetched: 0,
    events_matched: 0,
    markets_fetched: 0,
    snapshots_persisted: 0,
    duration_ms: 0,
  };

  const enabled = (await getConfigValue("smarkets_ingestion_enabled")) === "true";
  if (!enabled) {
    logger.debug("smarkets_ingestion_enabled != true — skipping");
    result.duration_ms = Date.now() - startedAt;
    return result;
  }
  result.enabled = true;

  // 1. Fetch upcoming Smarkets events.
  const events = await listUpcomingFootballEvents(LOOKAHEAD_MS);
  result.events_fetched = events.length;
  // 2026-05-11 diagnostic: log a sample of the actual event shape because
  // Smarkets v3 does NOT return home_team / away_team as top-level fields —
  // the previous filter (line 124) silently dropped 100% of events for
  // weeks. Sample lets us see the real field shape from VPS logs without
  // adding an auth-required test path.
  if (events.length > 0) {
    const sample = events.slice(0, 3).map((e) => ({
      id: e.id,
      name: e.name,
      type_domain: e.type_domain,
      start: e.start_datetime,
      keys: Object.keys(e as object).slice(0, 20),
    }));
    logger.info({ count: events.length, sample }, "Smarkets: events sample");
  }
  if (events.length === 0) {
    logger.info({ result }, "Smarkets: no upcoming events returned");
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  // 2. Load our upcoming matches with their league info (for de-vig method).
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

  // 3. For each Smarkets event, find our match. Smarkets does not return
  // home_team / away_team as top-level fields — instead the event `name`
  // is a string like "Arsenal vs Chelsea" or "Real Madrid v Barcelona" or
  // "Bayern Munich - Dortmund". Parse the two halves and run them through
  // the same teamNameMatch fuzzy resolver we use for API-Football.
  let parseAttempted = 0;
  let parseSucceeded = 0;
  for (const ev of events) {
    parseAttempted++;
    const parsed = parseEventTeams(ev.name, ev.home_team, ev.away_team);
    if (!parsed) continue;
    parseSucceeded++;
    const matched = ourMatches.find(
      (m) =>
        teamNameMatch(m.homeTeam, parsed.home) &&
        teamNameMatch(m.awayTeam, parsed.away),
    );
    if (!matched) continue;
    result.events_matched++;

    // 4. List markets on the Smarkets event.
    const markets = await listMarkets(ev.id);
    for (const market of markets) {
      const internalType = SMARKETS_MARKET_TYPE_MAP[market.market_type];
      if (!internalType || !SUPPORTED_MARKET_TYPES.has(internalType)) continue;
      result.markets_fetched++;

      const quote = await getMarketQuote(market.id);
      if (!quote?.contracts?.length) continue;

      // Build { selection_name → back_odds } for this market.
      const oddsBySelection: Record<string, number> = {};
      for (const c of quote.contracts) {
        const price = c.best_back?.price;
        if (price && price > 1) {
          // Look up contract metadata to get the selection name.
          // (Quotes endpoint returns contract_id only; the markets-list
          // endpoint earlier carries names. For now use contract_id as
          // the selection key — the consumer side will need a mapping
          // pass in Phase 3d.2 when wiring CLV.)
          oddsBySelection[c.contract_id] = price;
        }
      }
      if (Object.keys(oddsBySelection).length === 0) continue;

      const devigMethod = devigByLeague.get(matched.league) ?? "power";
      const { rowsInserted } = await persistSourceSnapshot({
        matchId: matched.id,
        marketType: internalType,
        source: "smarkets",
        snapshotAt: new Date(),
        oddsBySelection,
        devigMethod,
        rawPayload: { smarkets_event_id: ev.id, smarkets_market_id: market.id },
      });
      result.snapshots_persisted += rowsInserted;
    }
  }

  // Diagnostic counters surfaced alongside the standard result fields so
  // the VPS logs show where the pipeline drops events on each run.
  logger.info(
    {
      ...result,
      parse_attempted: parseAttempted,
      parse_succeeded: parseSucceeded,
    },
    "Smarkets ingestion complete",
  );
  result.duration_ms = Date.now() - startedAt;
  return result;
}

/**
 * Parse home + away team names from a Smarkets event. Tries the
 * (currently always-empty) top-level home_team / away_team fields
 * first, then falls back to splitting the event `name` on common
 * separators used by Smarkets' public listings:
 *   "Arsenal vs Chelsea"
 *   "Arsenal v Chelsea"
 *   "Arsenal - Chelsea"
 *   "Arsenal @ Chelsea"
 * Returns null if no plausible split can be made (e.g. "Match Odds"
 * which is a market label, not a fixture).
 */
function parseEventTeams(
  name: string | null | undefined,
  topHome: string | null | undefined,
  topAway: string | null | undefined,
): { home: string; away: string } | null {
  if (topHome && topAway) return { home: topHome, away: topAway };
  if (!name) return null;

  const separators = [" vs ", " v ", " - ", " — ", " @ "];
  for (const sep of separators) {
    const idx = name.toLowerCase().indexOf(sep.toLowerCase());
    if (idx > 0 && idx < name.length - sep.length) {
      const home = name.slice(0, idx).trim();
      const away = name.slice(idx + sep.length).trim();
      // Require both halves to have at least one alphabetic char so we
      // don't accept market labels like "0 - 1" as a fixture.
      if (/[a-zA-Z]/.test(home) && /[a-zA-Z]/.test(away)) {
        return { home, away };
      }
    }
  }
  return null;
}
