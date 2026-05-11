/**
 * Task 11 — Smarkets public-API client (Phase 3d.1).
 *
 * Smarkets exposes events and prices via its public REST endpoints:
 *   GET https://api.smarkets.com/v3/events/
 *   GET https://api.smarkets.com/v3/events/{event_id}/markets/
 *   GET https://api.smarkets.com/v3/markets/{market_id}/quotes/
 *
 * No auth required for read-only price data — same data that powers the
 * smarkets.com odds-comparison pages. Rate-limited but generous for
 * polite use.
 *
 * Coverage: UK/EU football primarily. ~150 leagues. Lower-tier and
 * non-English markets are spotty; for those we fall back to Matchbook
 * + Pinnacle.
 *
 * Output schema: returns one record per (event, market_type, selection)
 * with the current best back odds. Caller persists via
 * sharpConsensus.persistSourceSnapshot.
 */

import { logger } from "../../lib/logger";
import { resilientFetch } from "../resilientFetch";

const BASE_URL = "https://api.smarkets.com/v3";
const USER_AGENT = "BetAgentOS/1.0 (research; chris.mcg@hotmail.co.uk)";

export interface SmarketsEvent {
  id: string;
  name: string;
  type_domain: string; // 'sport-soccer'
  competition_id?: string;
  competition_name?: string;
  start_datetime: string; // ISO
  home_team?: string;
  away_team?: string;
}

export interface SmarketsMarket {
  id: string;
  event_id: string;
  market_type: string; // 'one_x_two', 'over_under', 'asian_handicap', etc.
  name: string;
  parameters?: Record<string, unknown>;
}

export interface SmarketsContract {
  id: string;
  market_id: string;
  name: string; // 'Home', 'Draw', 'Away', 'Over 2.5', etc.
  best_back_price?: number; // decimal odds
  best_lay_price?: number;
}

export interface SmarketsQuote {
  market_id: string;
  contracts: Array<{
    contract_id: string;
    best_back: { price: number; quantity: number } | null;
    best_lay: { price: number; quantity: number } | null;
  }>;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    return await resilientFetch<T>(`${BASE_URL}${path}`, {
      service: "smarkets",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  } catch (err) {
    logger.warn({ err, path }, "Smarkets fetch failed");
    return null;
  }
}

/**
 * Fetch upcoming football events from Smarkets. Returns events kicking off
 * within `[now, now + lookaheadMs]`.
 *
 * 2026-05-11 diagnostic note: the previous `type_scope=single_event`
 * parameter is not actually a documented Smarkets v3 filter and the API
 * may silently ignore it (or 400 — unverified from this environment).
 * Live tests against /events/ show the basic response is paginated and
 * mostly returns top-level sport categories. To reach individual matches
 * the proper navigation is a three-step parent_id walk:
 *   1. /events/ (root) -> "Football" category (id 121005)
 *   2. /events/?parent_id=121005 -> competitions list
 *   3. /events/?parent_id={competition_id}&state=upcoming -> matches
 *
 * The current single-call shortcut is a best-effort; we log the response
 * size + first-event shape so the VPS logs reveal exactly what comes
 * back. If `events.length === 0` consistently in production, the
 * follow-up bundle should ship the parent_id walk.
 */
/** Smarkets root Football category. Confirmed via live API probe
 *  2026-05-11 — `/events/` returns "Football" with id=121005 at the
 *  top level. Competitions live as children of this node. */
const FOOTBALL_ROOT_PARENT_ID = 121005;
const COMPETITION_WALK_CAP = 60;
const PER_COMPETITION_CAP = 200;

export async function listUpcomingFootballEvents(lookaheadMs = 48 * 60 * 60 * 1000): Promise<SmarketsEvent[]> {
  const now = new Date();
  const until = new Date(Date.now() + lookaheadMs);
  const nowIso = now.toISOString();
  const untilIso = until.toISOString();

  // Attempt 1 — legacy single-call shortcut. `type_scope=single_event`
  // is the original code path; live verification 2026-05-11 showed it
  // returns 0 events, but we keep it in case Smarkets fixes it server-side.
  const legacy = new URLSearchParams({
    type_scope: "single_event",
    type_domain: "sport-soccer",
    state: "upcoming",
    start_datetime_min: nowIso,
    start_datetime_max: untilIso,
    limit: "200",
  });
  const legacyResp = await fetchJson<{ events: SmarketsEvent[] }>(`/events/?${legacy}`);
  const legacyEvents = legacyResp?.events ?? [];
  if (legacyEvents.length > 0) {
    logger.info(
      { count: legacyEvents.length, path: "legacy_single_call" },
      "Smarkets: legacy filter returned events",
    );
    return legacyEvents;
  }

  // Attempt 2 — parent_id walk. Smarkets v3 organises events as a tree:
  //   Football (121005)
  //   └── competitions (Premier League, Liga 1, …)
  //       └── individual matches (the rows we want)
  // Iterate competitions under Football, then matches under each.
  logger.info(
    "Smarkets: legacy filter returned 0 — falling back to parent_id walk under Football category",
  );

  const compsResp = await fetchJson<{ events: SmarketsEvent[] }>(
    `/events/?parent_id=${FOOTBALL_ROOT_PARENT_ID}&limit=${COMPETITION_WALK_CAP}`,
  );
  const competitions = compsResp?.events ?? [];
  logger.info(
    {
      competitionsFound: competitions.length,
      sample: competitions.slice(0, 5).map((c) => ({ id: c.id, name: c.name })),
    },
    "Smarkets: competitions under Football",
  );
  if (competitions.length === 0) return [];

  const allMatches: SmarketsEvent[] = [];
  for (const comp of competitions) {
    const matchesResp = await fetchJson<{ events: SmarketsEvent[] }>(
      `/events/?parent_id=${comp.id}&state=upcoming&limit=${PER_COMPETITION_CAP}`,
    );
    const matches = matchesResp?.events ?? [];
    if (matches.length === 0) continue;

    // Filter to events kicking off within the lookahead window. Smarkets
    // returns start_datetime on the event row.
    for (const m of matches) {
      const startStr = m.start_datetime ?? null;
      if (!startStr) continue;
      const startMs = Date.parse(startStr);
      if (!Number.isFinite(startMs)) continue;
      if (startMs >= now.getTime() && startMs <= until.getTime()) {
        allMatches.push(m);
      }
    }
  }

  logger.info(
    {
      path: "parent_id_walk",
      competitionsScanned: competitions.length,
      matchesInWindow: allMatches.length,
      firstName: allMatches[0]?.name ?? null,
      firstKeys: allMatches[0] ? Object.keys(allMatches[0] as object).slice(0, 15) : [],
    },
    "Smarkets listUpcomingFootballEvents (parent_id walk) complete",
  );
  return allMatches;
}

/** List markets for a given event. */
export async function listMarkets(eventId: string): Promise<SmarketsMarket[]> {
  const data = await fetchJson<{ markets: SmarketsMarket[] }>(`/events/${eventId}/markets/`);
  return data?.markets ?? [];
}

/** Get the current best back/lay quote for a market (all contracts in one call). */
export async function getMarketQuote(marketId: string): Promise<SmarketsQuote | null> {
  return await fetchJson<SmarketsQuote>(`/markets/${marketId}/quotes/`);
}

/**
 * Smarkets market_type values mapped to internal MARKET_TYPE_MAP keys.
 * Internal codes are what `paper_bets.market_type` uses.
 */
export const SMARKETS_MARKET_TYPE_MAP: Record<string, string> = {
  one_x_two: "MATCH_ODDS",
  both_teams_to_score: "BTTS",
  over_under_goals: "OVER_UNDER", // resolves to specific line via market parameters
  asian_handicap: "ASIAN_HANDICAP",
};
