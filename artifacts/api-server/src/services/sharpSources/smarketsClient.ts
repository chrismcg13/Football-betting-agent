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
 */
export async function listUpcomingFootballEvents(lookaheadMs = 48 * 60 * 60 * 1000): Promise<SmarketsEvent[]> {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + lookaheadMs).toISOString();
  const params = new URLSearchParams({
    type_scope: "single_event",
    type_domain: "sport-soccer",
    state: "upcoming",
    start_datetime_min: now,
    start_datetime_max: until,
    limit: "200",
  });
  const data = await fetchJson<{ events: SmarketsEvent[] }>(`/events/?${params}`);
  return data?.events ?? [];
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
