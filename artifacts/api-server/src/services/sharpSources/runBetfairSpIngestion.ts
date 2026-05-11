/**
 * Task 11 — Betfair "SP" (closing-book) ingestion (Phase 3d.2).
 *
 * Strictly speaking, this captures the Betfair Exchange CLOSING BOOK at
 * kickoff, not the formal Starting Price. The Betfair SP is a settled
 * average computed at in-play start; capturing it requires the SP-specific
 * `priceData=['SP_AVAILABLE','SP_TRADED']` request flag which the VPS
 * relay does not currently expose. The closing book at T+0 is the standard
 * closing-line proxy used by sharps and serves the same purpose for the
 * CLV consensus.
 *
 * Algorithm: every minute, find matches that have kicked off in the last
 * 90 seconds (kickoff_time ∈ [now-90s, now]). For each, look up the
 * Betfair market list, then fetch liquidity for the market types we
 * trade, and persist the top-of-book back price as a 'betfair_sp'
 * consensus snapshot.
 *
 * Gated behind agent_config.betfair_sp_ingestion_enabled = 'true'.
 * Default false. The narrow time window keeps relay traffic to ~1-2
 * matches per minute on a normal football evening.
 *
 * Selection-name mapping is the tricky bit: Betfair runner names
 * (e.g. "Manchester United", "Draw", "Over 2.5 Goals") need to align
 * with paper_bets.selection_name for the Phase 3d.3 CLV wiring to
 * join correctly. For Phase 3d.2 we persist Betfair's runner name as-is
 * and defer the mapping pass.
 */

import { db, matchesTable, agentConfigTable, competitionConfigTable } from "@workspace/db";
import { and, gte, lte, eq, isNotNull, sql as drizzleSql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { relayGetMarket, relayGetLiquidity, isRelayConfigured } from "../vpsRelay";
import { persistSourceSnapshot } from "../sharpConsensus";
import type { DevigMethod } from "../devig";

const CAPTURE_WINDOW_MS = 90 * 1000; // matches that kicked off in the last 90s
const SUPPORTED_BETFAIR_MARKETS = new Set([
  "MATCH_ODDS",
  "BTTS",
  "ASIAN_HANDICAP",
  "OVER_UNDER_25",
]);

// Map our internal market types to Betfair market-name patterns.
// (Best effort — Betfair's marketName varies slightly across competitions.)
const BETFAIR_MARKET_NAME_PATTERNS: Record<string, RegExp> = {
  MATCH_ODDS: /^Match Odds$/i,
  BTTS: /^Both Teams To Score\??$/i,
  ASIAN_HANDICAP: /^Asian Handicap/i,
  OVER_UNDER_25: /^Over\/Under 2\.5 Goals$/i,
};

export interface BetfairSpIngestResult {
  enabled: boolean;
  matches_in_window: number;
  matches_with_events: number;
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

export async function runBetfairSpIngestion(): Promise<BetfairSpIngestResult> {
  const startedAt = Date.now();
  const result: BetfairSpIngestResult = {
    enabled: false,
    matches_in_window: 0,
    matches_with_events: 0,
    markets_fetched: 0,
    snapshots_persisted: 0,
    duration_ms: 0,
  };

  const enabled = (await getConfigValue("betfair_sp_ingestion_enabled")) === "true";
  if (!enabled) {
    result.duration_ms = Date.now() - startedAt;
    return result;
  }
  result.enabled = true;

  if (!isRelayConfigured()) {
    logger.warn("Betfair SP ingestion enabled but VPS relay not configured — skipping");
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  const lo = new Date(Date.now() - CAPTURE_WINDOW_MS);
  const hi = new Date();
  const justKickedOff = await db
    .select({
      id: matchesTable.id,
      league: matchesTable.league,
      betfairEventId: matchesTable.betfairEventId,
      kickoffTime: matchesTable.kickoffTime,
    })
    .from(matchesTable)
    .where(
      and(
        gte(matchesTable.kickoffTime, lo),
        lte(matchesTable.kickoffTime, hi),
        isNotNull(matchesTable.betfairEventId),
        drizzleSql`${matchesTable.betfairEventId} ~ '^[0-9]+$'`,
      ),
    );

  result.matches_in_window = justKickedOff.length;
  if (justKickedOff.length === 0) {
    result.duration_ms = Date.now() - startedAt;
    return result;
  }

  const devigCfgRows = await db
    .select({
      name: competitionConfigTable.name,
      devigMethod: competitionConfigTable.devigMethod,
    })
    .from(competitionConfigTable);
  const devigByLeague = new Map<string, DevigMethod>(
    devigCfgRows.map((r) => [r.name, (r.devigMethod ?? "power") as DevigMethod]),
  );

  for (const match of justKickedOff) {
    try {
      const marketData = await relayGetMarket(match.betfairEventId!);
      if (!marketData?.markets?.length) continue;
      result.matches_with_events++;

      for (const internalType of SUPPORTED_BETFAIR_MARKETS) {
        const pattern = BETFAIR_MARKET_NAME_PATTERNS[internalType];
        if (!pattern) continue;
        const betfairMarket = marketData.markets.find((m) =>
          m.marketName && pattern.test(m.marketName),
        );
        if (!betfairMarket) continue;
        result.markets_fetched++;

        const liquidity = await relayGetLiquidity(betfairMarket.marketId);
        if (!liquidity?.runners?.length) continue;

        // Build runnerName → best back odds from the runners list + liquidity.
        const runnerIdToName = new Map<number, string>(
          betfairMarket.runners.map((r) => [r.selectionId, r.name]),
        );
        const oddsBySelection: Record<string, number> = {};
        for (const r of liquidity.runners) {
          const name = runnerIdToName.get(r.selectionId);
          const bestBack = r.backPrices?.[0]?.price;
          if (name && bestBack && bestBack > 1) {
            oddsBySelection[name] = bestBack;
          }
        }
        if (Object.keys(oddsBySelection).length === 0) continue;

        const devigMethod = devigByLeague.get(match.league) ?? "power";
        const { rowsInserted } = await persistSourceSnapshot({
          matchId: match.id,
          marketType: internalType,
          source: "betfair_sp",
          snapshotAt: match.kickoffTime ?? new Date(),
          oddsBySelection,
          devigMethod,
          rawPayload: {
            betfair_event_id: match.betfairEventId,
            betfair_market_id: betfairMarket.marketId,
            note: "closing-book proxy at kickoff (not true SP)",
          },
        });
        result.snapshots_persisted += rowsInserted;
      }
    } catch (err) {
      logger.warn({ err, matchId: match.id }, "Betfair SP ingestion: per-match capture failed");
    }
  }

  result.duration_ms = Date.now() - startedAt;
  logger.info(result, "Betfair SP ingestion complete");
  return result;
}
