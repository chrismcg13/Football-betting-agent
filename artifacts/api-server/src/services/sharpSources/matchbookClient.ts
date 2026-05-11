/**
 * Task 11 — Matchbook public-API client (Phase 3d.2).
 *
 * Matchbook exposes events and prices via:
 *   GET https://api.matchbook.com/edge/rest/events
 *   GET https://api.matchbook.com/edge/rest/events/{event_id}/markets
 *   GET https://api.matchbook.com/edge/rest/markets/{market_id}
 *
 * Public read API, no auth required for price data. Same JSON shape
 * served to matchbook.com's public pages. Rate-limited but generous
 * for polite use.
 *
 * Coverage: UK / EU / US football. Strongest on commission-only exchange
 * markets where the matched volume is real. Weaker than Smarkets on
 * lower-tier domestic leagues.
 */

import { logger } from "../../lib/logger";
import { resilientFetch } from "../resilientFetch";

const BASE_URL = "https://api.matchbook.com/edge/rest";
const USER_AGENT = "BetAgentOS/1.0 (research; chris.mcg@hotmail.co.uk)";

export interface MatchbookEvent {
  id: number;
  name: string;
  sport_id: number; // 15 = Soccer
  category_id?: number;
  start: string; // ISO
  in_running_flag?: boolean;
  meta_tags?: Array<{ id: number; type: string; name: string }>;
}

export interface MatchbookMarket {
  id: number;
  event_id: number;
  name: string;
  market_type: string; // 'one_x_two', 'total', 'handicap', etc.
  type?: string;
  in_running_flag?: boolean;
  runners?: MatchbookRunner[];
}

export interface MatchbookRunner {
  id: number;
  market_id: number;
  name: string; // 'Manchester United', 'Draw', 'Over 2.5', etc.
  prices?: Array<{
    odds_type: string; // 'DECIMAL'
    odds: number;
    side: "back" | "lay";
    available_amount: number;
  }>;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    return await resilientFetch<T>(`${BASE_URL}${path}`, {
      service: "matchbook",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  } catch (err) {
    logger.warn({ err, path }, "Matchbook fetch failed");
    return null;
  }
}

/** Soccer sport_id = 15 on Matchbook. */
const MATCHBOOK_SOCCER_SPORT_ID = 15;

/**
 * List upcoming Matchbook soccer events. Matchbook paginates; we ask for
 * a generous page-size (per-page=500) since lookahead is bounded.
 */
export async function listUpcomingFootballEvents(lookaheadMs = 48 * 60 * 60 * 1000): Promise<MatchbookEvent[]> {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + lookaheadMs).toISOString();
  const params = new URLSearchParams({
    "sport-ids": String(MATCHBOOK_SOCCER_SPORT_ID),
    states: "open",
    "before": until,
    "after": now,
    "per-page": "500",
    "offset": "0",
  });
  const data = await fetchJson<{ events: MatchbookEvent[] }>(`/events?${params}`);
  return data?.events ?? [];
}

/** Get a single market including its runners + current best prices. */
export async function getMarketWithPrices(marketId: number): Promise<MatchbookMarket | null> {
  // Matchbook's per-market endpoint embeds runners and their prices.
  // We request the deepest price detail (top-3) but only need the top of book.
  return await fetchJson<MatchbookMarket>(`/markets/${marketId}?include-prices=true&depth=1&odds-type=DECIMAL`);
}

/** List markets on an event (lightweight — no prices). */
export async function listMarkets(eventId: number): Promise<MatchbookMarket[]> {
  const data = await fetchJson<{ markets: MatchbookMarket[] }>(`/events/${eventId}/markets?states=open`);
  return data?.markets ?? [];
}

/**
 * Matchbook market_type → internal market_type. Their `market_type`
 * field uses snake_case strings; map to our paper_bets.market_type
 * domain.
 */
export const MATCHBOOK_MARKET_TYPE_MAP: Record<string, string> = {
  one_x_two: "MATCH_ODDS",
  match_odds: "MATCH_ODDS",
  total: "OVER_UNDER",
  goals_over_under: "OVER_UNDER",
  handicap: "ASIAN_HANDICAP",
  asian_handicap: "ASIAN_HANDICAP",
  both_teams_to_score: "BTTS",
};

/** Extract the home and away team names from a Matchbook event name. */
export function parseTeamsFromEventName(name: string): { home: string; away: string } | null {
  // Matchbook event names follow "Team A vs Team B" or "Team A v Team B".
  const m = name.match(/^(.+?)\s+(?:vs?\.?|@)\s+(.+)$/i);
  if (!m) return null;
  return { home: m[1]!.trim(), away: m[2]!.trim() };
}
