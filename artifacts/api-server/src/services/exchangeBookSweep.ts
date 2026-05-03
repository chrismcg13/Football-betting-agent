import { db, oddsSnapshotsTable, matchesTable } from "@workspace/db";
import { eq, and, gte, lte, isNotNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  listMarketBook,
  type MarketCatalogueItem,
  type MarketBook,
} from "./betfair";
import { getCatalogueForEvent } from "./paperTrading";

// Allowlist matches C1 captureExchangeSnapshot: numeric Betfair event IDs only.
const BETFAIR_EVENT_ID_RE = /^\d+$/;

// Markets the picker actually evaluates AND that Betfair returns under the
// default catalogue MARKET_TYPES set used by getCatalogueForEvent. The picker
// also evaluates DOUBLE_CHANCE and FIRST_HALF_RESULT, but those are not in the
// default catalogue request and would require widening the C1 cache contract;
// for those markets the picker continues to rely on derived/synthetic odds.
// CORRECT_SCORE and ASIAN_HANDICAP returned by the catalogue are intentionally
// skipped — the picker does not price them.
const TARGET_BETFAIR_MARKET_TYPES = new Set<string>([
  "MATCH_ODDS",
  "OVER_UNDER_15",
  "OVER_UNDER_25",
  "OVER_UNDER_35",
  "BOTH_TEAMS_TO_SCORE",
  "FIRST_HALF_RESULT",
]);

function toInternalMarketType(bfMarketType: string): string {
  // Picker uses "BTTS" internally; Betfair calls it "BOTH_TEAMS_TO_SCORE".
  if (bfMarketType === "BOTH_TEAMS_TO_SCORE") return "BTTS";
  return bfMarketType;
}

function deriveSelectionName(
  bfMarketType: string,
  runner: { selectionId: number; runnerName: string; sortPriority: number },
  homeTeam: string,
  awayTeam: string,
): string | null {
  const name = runner.runnerName.trim();
  const lower = name.toLowerCase();

  if (bfMarketType === "MATCH_ODDS") {
    if (lower === "the draw" || lower === "draw") return "Draw";
    if (lower === homeTeam.toLowerCase()) return "Home";
    if (lower === awayTeam.toLowerCase()) return "Away";
    // Fallback to sortPriority (1=Home, 2=Away, 3=Draw on Betfair MATCH_ODDS)
    if (runner.sortPriority === 1) return "Home";
    if (runner.sortPriority === 2) return "Away";
    if (runner.sortPriority === 3) return "Draw";
    return null;
  }

  if (bfMarketType === "BOTH_TEAMS_TO_SCORE") {
    if (lower === "yes") return "Yes";
    if (lower === "no") return "No";
    return null;
  }

  if (bfMarketType.startsWith("OVER_UNDER_")) {
    // Betfair runnerName: "Over 2.5 Goals" / "Under 2.5 Goals" — pass through,
    // matches the picker's stored selection_name format from API-Football.
    if (lower.startsWith("over") || lower.startsWith("under")) return name;
    return null;
  }

  return null;
}

export interface ExchangeBookSweepResult {
  events: number;
  markets: number;
  runners: number;
  snapshotsWritten: number;
  errors: number;
  durationMs: number;
  apiCalls: number;
}

/**
 * Sweep open Betfair markets for upcoming fixtures and write best back/lay
 * snapshots to odds_snapshots with source='betfair_exchange'. Feeds the
 * Prompt 5 venue-anchored pricing picker.
 *
 * Per-event try/catch: a single bad event never aborts the sweep. listMarketBook
 * chunks are individually wrapped so one Betfair hiccup loses at most 40 markets.
 */
export async function runExchangeBookSweep(
  opts?: { hoursAhead?: number },
): Promise<ExchangeBookSweepResult> {
  const startedAt = Date.now();
  const hoursAhead = opts?.hoursAhead ?? 24;
  let apiCalls = 0;
  let markets = 0;
  let runners = 0;
  let snapshotsWritten = 0;
  let errors = 0;

  // 1. Eligible matches: numeric Betfair event ID, scheduled, kickoff in window.
  const now = new Date();
  const horizon = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
  const eligible = await db
    .select({
      id: matchesTable.id,
      betfairEventId: matchesTable.betfairEventId,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
    })
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        isNotNull(matchesTable.betfairEventId),
        sql`${matchesTable.betfairEventId} ~ '^[0-9]+$'`,
        gte(matchesTable.kickoffTime, now),
        lte(matchesTable.kickoffTime, horizon),
      ),
    );

  // Group by unique betfairEventId — defensive against duplicate matches rows.
  const byEvent = new Map<string, (typeof eligible)[number]>();
  for (const m of eligible) {
    if (
      m.betfairEventId &&
      BETFAIR_EVENT_ID_RE.test(m.betfairEventId) &&
      !byEvent.has(m.betfairEventId)
    ) {
      byEvent.set(m.betfairEventId, m);
    }
  }

  // 2. Per-event catalogue fetch (uses paperTrading.ts 5-min TTL cache).
  type MarketCtx = {
    match: (typeof eligible)[number];
    bfMarketType: string;
    internalMarketType: string;
    catalogue: MarketCatalogueItem;
  };
  const marketCtxByMarketId = new Map<string, MarketCtx>();

  for (const match of byEvent.values()) {
    try {
      const catalogue = await getCatalogueForEvent(match.betfairEventId!);
      // Counts conservatively — overcounts when the 5-min cache absorbs the call.
      apiCalls += 1;
      for (const cat of catalogue) {
        const bfMarketType = cat.description?.marketType;
        if (!bfMarketType || !TARGET_BETFAIR_MARKET_TYPES.has(bfMarketType)) continue;
        marketCtxByMarketId.set(cat.marketId, {
          match,
          bfMarketType,
          internalMarketType: toInternalMarketType(bfMarketType),
          catalogue: cat,
        });
        markets += 1;
      }
    } catch (err) {
      errors += 1;
      logger.warn(
        { err, matchId: match.id, betfairEventId: match.betfairEventId },
        "Exchange book sweep: catalogue fetch failed for event",
      );
    }
  }

  // 3. listMarketBook in chunks of 40 (Betfair's per-call limit). Manual
  //    chunking so a single chunk failure doesn't abort the rest.
  const allMarketIds = Array.from(marketCtxByMarketId.keys());
  const CHUNK = 40;
  const snapshotTime = new Date();

  for (let i = 0; i < allMarketIds.length; i += CHUNK) {
    const chunk = allMarketIds.slice(i, i + CHUNK);
    let books: MarketBook[];
    try {
      books = await listMarketBook(chunk);
      apiCalls += 1;
    } catch (err) {
      errors += 1;
      logger.warn(
        { err, chunkSize: chunk.length, firstMarketId: chunk[0] },
        "Exchange book sweep: listMarketBook chunk failed",
      );
      continue;
    }

    for (const book of books) {
      const ctx = marketCtxByMarketId.get(book.marketId);
      if (!ctx) continue;
      if (book.status !== "OPEN") continue;

      for (const runner of book.runners) {
        if (runner.status !== "ACTIVE") continue;
        const back = runner.ex?.availableToBack?.[0]?.price;
        const lay = runner.ex?.availableToLay?.[0]?.price;
        if (back == null && lay == null) continue;

        const catRunner = ctx.catalogue.runners?.find(
          (r) => r.selectionId === runner.selectionId,
        );
        if (!catRunner) continue;

        const selectionName = deriveSelectionName(
          ctx.bfMarketType,
          catRunner,
          ctx.match.homeTeam,
          ctx.match.awayTeam,
        );
        if (!selectionName) continue;

        try {
          await db.insert(oddsSnapshotsTable).values({
            matchId: ctx.match.id,
            marketType: ctx.internalMarketType,
            selectionName,
            backOdds: back != null ? String(back) : null,
            layOdds: lay != null ? String(lay) : null,
            source: "betfair_exchange",
            snapshotTime,
          });
          snapshotsWritten += 1;
          runners += 1;
        } catch (err) {
          errors += 1;
          logger.warn(
            {
              err,
              matchId: ctx.match.id,
              marketId: book.marketId,
              selectionName,
            },
            "Exchange book sweep: odds_snapshots insert failed",
          );
        }
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const summary: ExchangeBookSweepResult = {
    events: byEvent.size,
    markets,
    runners,
    snapshotsWritten,
    errors,
    durationMs,
    apiCalls,
  };
  logger.info(summary, "Exchange book sweep complete");
  return summary;
}
