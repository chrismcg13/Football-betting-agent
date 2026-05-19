import { db, oddsSnapshotsTable, matchesTable } from "@workspace/db";
import { eq, and, gte, lte, isNotNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  listMarketBook,
  listMarketCatalogue,
  type MarketCatalogueItem,
  type MarketBook,
} from "./betfair";
import { getCatalogueForEvent } from "./paperTrading";
import { findEventIdByTeamNames } from "./betfairLive";

// Allowlist matches C1 captureExchangeSnapshot: numeric Betfair event IDs only.
const BETFAIR_EVENT_ID_RE = /^\d+$/;

// Markets the picker actually evaluates AND that Betfair returns under the
// default catalogue MARKET_TYPES set used by getCatalogueForEvent. The picker
// also evaluates DOUBLE_CHANCE and FIRST_HALF_RESULT, but those are not in the
// default catalogue request and would require widening the C1 cache contract;
// for those markets the picker continues to rely on derived/synthetic odds.
// CORRECT_SCORE and ASIAN_HANDICAP returned by the catalogue are intentionally
// skipped — the picker does not price them.
// Sub-phase 4.A + 4.B (2026-05-08): expanded set of Betfair Exchange market
// types we capture odds for. Verified by betfairMarketDiscovery cron output
// against real listMarketCatalogue responses. Each adds graduation potential
// for shadow bets in that market.
const TARGET_BETFAIR_MARKET_TYPES = new Set<string>([
  "MATCH_ODDS",
  "BOTH_TEAMS_TO_SCORE",
  "OVER_UNDER_05",
  "OVER_UNDER_15",
  "OVER_UNDER_25",
  "OVER_UNDER_35",
  "OVER_UNDER_45",
  "OVER_UNDER_55",
  "OVER_UNDER_65",
  "OVER_UNDER_75",
  "OVER_UNDER_85",
  "DRAW_NO_BET",
  "HALF_TIME",
  // 2026-05-16 subtract bundle: HALF_TIME_FULL_TIME, ODD_OR_EVEN,
  // DOUBLE_CHANCE, TEAM_A_WIN_TO_NIL, TEAM_B_WIN_TO_NIL removed.
  // Zero placeable liquidity probes ever, zero non-paper bets ever placed.
  // See [[feedback_subtract_before_restore]].
  "ASIAN_HANDICAP",         // Sub-phase 4.A — was previously skipped
  "ALT_TOTAL_GOALS",        // 2026-05-09 (Bundle 2): Asian Total Goals
  "FIRST_HALF_GOALS_05",
  "FIRST_HALF_GOALS_15",
  "FIRST_HALF_GOALS_25",
  "TEAM_A_1",
  "TEAM_A_2",
  "TEAM_A_3",
  "TEAM_B_1",
  "TEAM_B_2",
  "TEAM_B_3",
  // ── Bundle F2.A.9.2 (2026-05-19): VERIFIED corner + card Betfair types ───
  // Per Chris pasting the official Betfair Betting Type Definitions:
  // https://betfair-developer-docs.atlassian.net/wiki/spaces/1smk3cen4v3lu3yomq5qye0ni/pages/2687465/Betting+Type+Definitions
  //
  // Corner markets (4 canonical types):
  "TOTAL_CORNERS",          // multi-line: runners "Over 8.5", "Under 8.5", "Over 9.5"...
  "OVER_UNDER_CORNERS",     // multi-line single market
  "MATCH_CORNERS",          // 2-way: "More Corners Home" vs "Away" (handicap-style)
  "FIRST_HALF_CORNERS",     // 1st-half-only version
  // Booking-point (cards) markets (2 canonical types):
  "TOTAL_BOOKING_POINTS",      // multi-line, runners "Over 35", "Under 35", "Over 45"...
                               // NOTE: Betfair uses BOOKING POINTS not raw cards.
                               // Yellow=10, Red=25; line of 35 ≈ "over 3.5 yellows"
  "OVER_UNDER_BOOKING_POINTS", // multi-line alternative naming

  // Additional canonical types from the docs we should also capture:
  "HALF_TIME_MATCH_ODDS",      // 1st half MO (was HALF_TIME, may be either name)
  "SECOND_HALF_MATCH_ODDS",    // 2nd half MO
  "HALF_TIME_FULL_TIME",       // HT/FT combination (9 outcomes)
  "TEAM_A_TOTAL_GOALS",        // multi-line variant of TEAM_A_x
  "TEAM_B_TOTAL_GOALS",
  "EUROPEAN_HANDICAP",         // 3-way handicap (Win/Draw/Lose with handicap)
  "HANDICAP",                  // standard handicap
  // Bundle F2.A.9.3 (2026-05-19): additional non-player match-level
  // markets per Chris's docs paste — exclude all player props.
  "CORRECT_SCORE",             // full-time exact scoreline
  "HALF_TIME_SCORE",           // half-time exact scoreline
  // NEXT_GOAL excluded 2026-05-19 — pre-match agent does not place in-play bets.
  "TO_SCORE_IN_BOTH_HALVES",   // team scores in both halves (per team)
  "TO_WIN_TO_NIL",             // team wins without conceding
  "CLEAN_SHEET_TEAM_A",        // team A keeps clean sheet
  "CLEAN_SHEET_TEAM_B",        // team B keeps clean sheet
]);

function toInternalMarketType(bfMarketType: string): string {
  // Picker uses internal codes that don't always match Betfair codes 1:1.
  // Mappings here are the inverse of MARKET_TYPE_MAP in betfairLive.ts.
  switch (bfMarketType) {
    case "BOTH_TEAMS_TO_SCORE": return "BTTS";
    // 2026-05-16 subtract bundle: ODD_OR_EVEN, TEAM_A/B_WIN_TO_NIL removed.
    case "TEAM_A_1": return "TEAM_TOTAL_HOME_05";
    case "TEAM_A_2": return "TEAM_TOTAL_HOME_15";
    case "TEAM_A_3": return "TEAM_TOTAL_HOME_25";
    case "TEAM_B_1": return "TEAM_TOTAL_AWAY_05";
    case "TEAM_B_2": return "TEAM_TOTAL_AWAY_15";
    case "TEAM_B_3": return "TEAM_TOTAL_AWAY_25";
    case "HALF_TIME": return "FIRST_HALF_RESULT";
    case "FIRST_HALF_GOALS_05": return "FIRST_HALF_OU_05";
    case "FIRST_HALF_GOALS_15": return "FIRST_HALF_OU_15";
    case "FIRST_HALF_GOALS_25": return "FIRST_HALF_OU_25";
    case "ALT_TOTAL_GOALS": return "ASIAN_TOTAL_GOALS";
    // ── Bundle F2.A.9.2 (2026-05-19): VERIFIED corner + card mappings ───
    // Per Chris's Betfair docs paste:
    // Corner markets:
    case "TOTAL_CORNERS":         return "TOTAL_CORNERS_MULTI";
    case "OVER_UNDER_CORNERS":    return "TOTAL_CORNERS_MULTI";
    case "MATCH_CORNERS":         return "MATCH_CORNERS_2WAY";
    case "FIRST_HALF_CORNERS":    return "FIRST_HALF_CORNERS_MULTI";
    // Booking points (Betfair's "cards" — yellow=10pts, red=25pts):
    case "TOTAL_BOOKING_POINTS":     return "TOTAL_BOOKINGS_MULTI";
    case "OVER_UNDER_BOOKING_POINTS": return "TOTAL_BOOKINGS_MULTI";
    // Other canonical types from docs (capture for future model use):
    case "HALF_TIME_MATCH_ODDS":   return "HALF_TIME_RESULT";
    case "SECOND_HALF_MATCH_ODDS": return "SECOND_HALF_RESULT";
    case "TEAM_A_TOTAL_GOALS":    return "TEAM_TOTAL_HOME_MULTI";
    case "TEAM_B_TOTAL_GOALS":    return "TEAM_TOTAL_AWAY_MULTI";
    case "EUROPEAN_HANDICAP":     return "EUROPEAN_HANDICAP";
    case "HANDICAP":              return "STANDARD_HANDICAP";
    // Bundle F2.A.9.3 (2026-05-19): additional match/team-level markets
    case "HALF_TIME_FULL_TIME":   return "HTFT";
    case "CORRECT_SCORE":         return "CORRECT_SCORE";
    case "HALF_TIME_SCORE":       return "HALF_TIME_SCORE";
    // NEXT_GOAL case removed 2026-05-19 — in-play market, excluded.
    case "TO_SCORE_IN_BOTH_HALVES": return "BOTH_HALVES_TEAM_SCORE";
    case "TO_WIN_TO_NIL":         return "WIN_TO_NIL";
    case "CLEAN_SHEET_TEAM_A":    return "CLEAN_SHEET_HOME";
    case "CLEAN_SHEET_TEAM_B":    return "CLEAN_SHEET_AWAY";
    default: return bfMarketType; // OVER_UNDER_*, DRAW_NO_BET, ASIAN_HANDICAP map 1:1
  }
}

function deriveSelectionName(
  bfMarketType: string,
  runner: { selectionId: number; runnerName: string; sortPriority: number; handicap?: number | null },
  homeTeam: string,
  awayTeam: string,
): string | null {
  const name = runner.runnerName.trim();
  const lower = name.toLowerCase();

  if (bfMarketType === "MATCH_ODDS" || bfMarketType === "HALF_TIME") {
    if (lower === "the draw" || lower === "draw") return "Draw";
    if (lower === homeTeam.toLowerCase()) return "Home";
    if (lower === awayTeam.toLowerCase()) return "Away";
    if (runner.sortPriority === 1) return "Home";
    if (runner.sortPriority === 2) return "Away";
    if (runner.sortPriority === 3) return "Draw";
    return null;
  }

  if (
    bfMarketType === "BOTH_TEAMS_TO_SCORE" ||
    bfMarketType === "TEAM_A_1" || bfMarketType === "TEAM_A_2" || bfMarketType === "TEAM_A_3" ||
    bfMarketType === "TEAM_B_1" || bfMarketType === "TEAM_B_2" || bfMarketType === "TEAM_B_3"
  ) {
    if (lower === "yes") return "Yes";
    if (lower === "no") return "No";
    return null;
  }

  // 2026-05-16 subtract bundle: ODD_OR_EVEN, DOUBLE_CHANCE, HALF_TIME_FULL_TIME
  // selection-name parser branches removed alongside TARGET_BETFAIR_MARKET_TYPES
  // deletions. These market types are no longer captured by the sweep.

  if (bfMarketType === "DRAW_NO_BET") {
    if (lower === homeTeam.toLowerCase()) return "Home";
    if (lower === awayTeam.toLowerCase()) return "Away";
    if (runner.sortPriority === 1) return "Home";
    if (runner.sortPriority === 2) return "Away";
    return null;
  }

  if (bfMarketType.startsWith("OVER_UNDER_") || bfMarketType.startsWith("FIRST_HALF_GOALS_")) {
    if (lower.startsWith("over") || lower.startsWith("under")) return name;
    return null;
  }

  // Bundle F2.A.9.2 (2026-05-19): corner + cards runner parsers
  // (verified against Betfair docs).
  if (
    bfMarketType === "TOTAL_CORNERS" || bfMarketType === "OVER_UNDER_CORNERS" ||
    bfMarketType === "FIRST_HALF_CORNERS"
  ) {
    const m = lower.match(/^(over|under)\s+(\d+(?:\.\d+)?)/);
    if (m) {
      const side = m[1] === "over" ? "Over" : "Under";
      return `${side} ${m[2]} Corners`;
    }
    return null;
  }
  if (bfMarketType === "MATCH_CORNERS") {
    // 2-way market: "More Corners <Team>" / handicap-style
    if (lower === homeTeam.toLowerCase()) return "Home";
    if (lower === awayTeam.toLowerCase()) return "Away";
    if (lower === "the draw" || lower === "draw") return "Draw";
    if (runner.sortPriority === 1) return "Home";
    if (runner.sortPriority === 2) return "Away";
    return null;
  }
  if (
    bfMarketType === "TOTAL_BOOKING_POINTS" ||
    bfMarketType === "OVER_UNDER_BOOKING_POINTS"
  ) {
    // Betfair uses BOOKING POINTS (yellow=10, red=25). Lines typically
    // 25, 35, 45, 55 (i.e., "Over 35" = over 35 booking points).
    const m = lower.match(/^(over|under)\s+(\d+(?:\.\d+)?)/);
    if (m) {
      const side = m[1] === "over" ? "Over" : "Under";
      return `${side} ${m[2]} BookingPoints`;
    }
    return null;
  }
  if (
    bfMarketType === "TEAM_A_TOTAL_GOALS" || bfMarketType === "TEAM_B_TOTAL_GOALS"
  ) {
    const m = lower.match(/^(over|under)\s+(\d+(?:\.\d+)?)/);
    if (m) {
      const side = m[1] === "over" ? "Over" : "Under";
      return `${side} ${m[2]}`;
    }
    return null;
  }
  if (bfMarketType === "HALF_TIME_MATCH_ODDS" || bfMarketType === "SECOND_HALF_MATCH_ODDS") {
    if (lower === "the draw" || lower === "draw") return "Draw";
    if (lower === homeTeam.toLowerCase()) return "Home";
    if (lower === awayTeam.toLowerCase()) return "Away";
    if (runner.sortPriority === 1) return "Home";
    if (runner.sortPriority === 2) return "Away";
    if (runner.sortPriority === 3) return "Draw";
    return null;
  }
  if (bfMarketType === "EUROPEAN_HANDICAP" || bfMarketType === "HANDICAP") {
    // 3-way handicap; runnerName carries team + line offset.
    // Pass through the runnerName so we don't lose context. The model
    // doesn't price these yet — captured for future use.
    return name;
  }
  // Bundle F2.A.9.3 (2026-05-19): non-player match/team-level markets.
  if (bfMarketType === "HALF_TIME_FULL_TIME") {
    // Runners are 9 outcomes: "Home/Home", "Home/Draw", "Home/Away", ...
    // Pass through runnerName as selection (model doesn't price yet).
    return name;
  }
  if (bfMarketType === "CORRECT_SCORE" || bfMarketType === "HALF_TIME_SCORE") {
    // Runners are scores like "0 - 0", "1 - 0", "Any Other Home Win" etc.
    return name;
  }
  // NEXT_GOAL runner-derivation removed 2026-05-19 — in-play market, excluded.
  if (bfMarketType === "TO_SCORE_IN_BOTH_HALVES") {
    if (lower === "yes") return "Yes";
    if (lower === "no") return "No";
    return null;
  }
  if (
    bfMarketType === "TO_WIN_TO_NIL" ||
    bfMarketType === "CLEAN_SHEET_TEAM_A" ||
    bfMarketType === "CLEAN_SHEET_TEAM_B"
  ) {
    if (lower === "yes") return "Yes";
    if (lower === "no") return "No";
    return null;
  }

  if (bfMarketType === "ASIAN_HANDICAP") {
    // Sub-phase 4.A (2026-05-08): runnerName is the team name; the handicap
    // line is in runner.handicap. Selection format mirrors what AF returns
    // and what valueDetection's predictAsianHandicap parser expects:
    //   "Home -1.5" / "Away +0.5" etc.
    const handicap = runner.handicap;
    if (handicap == null) return null;
    const sign = handicap > 0 ? "+" : "";
    const lineStr = `${sign}${handicap}`;
    if (lower === homeTeam.toLowerCase()) return `Home ${lineStr}`;
    if (lower === awayTeam.toLowerCase()) return `Away ${lineStr}`;
    if (runner.sortPriority === 1) return `Home ${lineStr}`;
    if (runner.sortPriority === 2) return `Away ${lineStr}`;
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
        if (!bfMarketType) continue;
        // Bundle F2.A.9 (2026-05-19) — discovery logger. If a corner-
        // or card-related market type appears in the catalogue but is
        // NOT in TARGET_BETFAIR_MARKET_TYPES, log it once so we can
        // add it. Helps us learn Betfair's actual naming without
        // running blind catalogue inspections.
        if (!TARGET_BETFAIR_MARKET_TYPES.has(bfMarketType)) {
          const upper = bfMarketType.toUpperCase();
          if (
            upper.includes("CORNER") || upper.includes("CARD") ||
            upper.includes("BKD") || upper.includes("BOOKING") ||
            upper.includes("CRNR")
          ) {
            logger.warn(
              { bfMarketType, marketId: cat.marketId, eventId: match.betfairEventId, marketName: cat.marketName },
              "Bundle F2.A.9 discovery: unmapped Betfair corner/card market type — consider adding to TARGET_BETFAIR_MARKET_TYPES",
            );
          }
          continue;
        }
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

      // 2026-05-15 — AH parser fix from probe data (#step 6).
      //
      // Betfair returns ASIAN_HANDICAP (and ALT_TOTAL_GOALS) as
      // ASIAN_HANDICAP_DOUBLE_LINE: ONE market per event with N×2 runners,
      // each at a distinct (team, handicap) pair. The two unique selectionIds
      // correspond to the two teams; the per-runner handicap field carries
      // the line.
      //
      // Pre-fix bug: the old runner loop used
      //   catalogue.runners.find(r => r.selectionId === book.selectionId)
      // which returned the FIRST runner per selectionId — always sortPriority
      // 1 or 2, always handicap ±maxLine (±4 on Betfair football). Every
      // distinct book runner collapsed onto the ±4 labels. Combined with a
      // strict name-match fallback that only resolved sortPriority 1/2, this
      // produced the chronic odds_snapshots state we observed (only Home -4
      // and Away +4 written, all other lines dropped to null).
      //
      // Fix: for DOUBLE_LINE markets, establish home/away selectionId mapping
      // ONCE per market (name match preferred, sortPriority order fallback),
      // then label each book runner directly from its (selectionId → side,
      // handicap → line) pair. Bypasses deriveSelectionName's catRunner
      // lookup entirely for AH/ATG.
      const isDoubleLineMarket =
        ctx.bfMarketType === "ASIAN_HANDICAP" ||
        ctx.bfMarketType === "ALT_TOTAL_GOALS";

      let homeSelectionId: number | null = null;
      let awaySelectionId: number | null = null;
      if (isDoubleLineMarket) {
        const homeTeamLower = ctx.match.homeTeam.toLowerCase();
        const awayTeamLower = ctx.match.awayTeam.toLowerCase();
        const catRunners = ctx.catalogue.runners ?? [];
        // Pass 1: exact name match. Defensive null-coalesce on runnerName:
        // some Betfair AH runner entries arrive without runnerName populated
        // (handicap-line metadata only) and the previous .trim() call crashed
        // the entire scheduler cron via unhandled rejection (683 restart-loop
        // bursts observed 2026-05-17).
        for (const r of catRunners) {
          const nameLower = (r.runnerName ?? "").trim().toLowerCase();
          if (!nameLower) continue;
          if (homeSelectionId === null && nameLower === homeTeamLower) {
            homeSelectionId = r.selectionId;
          }
          if (awaySelectionId === null && nameLower === awayTeamLower) {
            awaySelectionId = r.selectionId;
          }
        }
        // Pass 2: prefix / contains match (handles "Torque" vs "Atletico Torque")
        if (homeSelectionId === null || awaySelectionId === null) {
          for (const r of catRunners) {
            const nameLower = (r.runnerName ?? "").trim().toLowerCase();
            if (!nameLower) continue;
            if (homeSelectionId === null && (
              homeTeamLower.includes(nameLower) || nameLower.includes(homeTeamLower)
            )) homeSelectionId = r.selectionId;
            if (awaySelectionId === null && (
              awayTeamLower.includes(nameLower) || nameLower.includes(awayTeamLower)
            )) awaySelectionId = r.selectionId;
          }
        }
        // Pass 3: sortPriority order (Betfair convention: first unique
        // selectionId by sortPriority is home, second is away)
        if (homeSelectionId === null || awaySelectionId === null) {
          const sorted = [...catRunners].sort((a, b) => a.sortPriority - b.sortPriority);
          const uniqueIds: number[] = [];
          for (const r of sorted) {
            if (!uniqueIds.includes(r.selectionId)) {
              uniqueIds.push(r.selectionId);
              if (uniqueIds.length === 2) break;
            }
          }
          if (homeSelectionId === null) homeSelectionId = uniqueIds[0] ?? null;
          if (awaySelectionId === null) awaySelectionId = uniqueIds[1] ?? null;
        }
        // Defensive: if we somehow still can't resolve, the same selectionId
        // got assigned to both. Reject — better to skip than mislabel.
        if (homeSelectionId === awaySelectionId) {
          homeSelectionId = null;
          awaySelectionId = null;
        }
      }

      for (const runner of book.runners) {
        if (runner.status !== "ACTIVE") continue;
        const back = runner.ex?.availableToBack?.[0]?.price;
        const lay = runner.ex?.availableToLay?.[0]?.price;
        if (back == null && lay == null) continue;

        let selectionName: string | null = null;

        if (isDoubleLineMarket) {
          if (homeSelectionId === null || awaySelectionId === null) continue;
          const handicap = runner.handicap;
          if (handicap == null) continue;
          const sign = handicap > 0 ? "+" : "";
          const lineStr = `${sign}${handicap}`;
          if (runner.selectionId === homeSelectionId) {
            selectionName = ctx.bfMarketType === "ASIAN_HANDICAP"
              ? `Home ${lineStr}`
              : `Over ${handicap}`;  // ALT_TOTAL_GOALS — over from home/total perspective
          } else if (runner.selectionId === awaySelectionId) {
            selectionName = ctx.bfMarketType === "ASIAN_HANDICAP"
              ? `Away ${lineStr}`
              : `Under ${handicap}`;
          } else {
            continue;
          }
        } else {
          // Non-DOUBLE_LINE markets — original lookup path. selectionId
          // alone identifies the runner.
          const catRunner = ctx.catalogue.runners?.find(
            (r) => r.selectionId === runner.selectionId,
          );
          if (!catRunner) continue;
          selectionName = deriveSelectionName(
            ctx.bfMarketType,
            catRunner,
            ctx.match.homeTeam,
            ctx.match.awayTeam,
          );
        }
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

// 2026-05-14 Fix 2 — on-demand single-event sweep.
//
// When placeLiveBetOnBetfair returns unavailableOnExchange for an event whose
// (league, market_type) is eligibility-proven, this triggers a targeted
// listMarketCatalogue + listMarketBook for that one event — bypassing the
// 5-minute catalogueCache and writing whatever Betfair returns to
// odds_snapshots. Mirrors per-event logic of runExchangeBookSweep.
//
// af_* placeholder event IDs resolve via findEventIdByTeamNames first
// (same fallback path placeLiveBetOnBetfair already uses).
//
// Returns foundMarkets so the caller can populate its 6h "tried — empty"
// cache and avoid re-fetching dead events every 5 min.
export interface OnDemandSweepResult {
  resolvedEventId: string | null;
  marketsDiscovered: number;
  snapshotsWritten: number;
  foundMarkets: boolean;
  reason: string;
}

export async function sweepEventOnDemand(
  matchId: number,
  betfairEventId: string,
  homeTeam: string,
  awayTeam: string,
): Promise<OnDemandSweepResult> {
  let resolvedEventId: string | null = betfairEventId.startsWith("af_")
    ? null
    : betfairEventId;

  if (!resolvedEventId) {
    try {
      resolvedEventId = await findEventIdByTeamNames(homeTeam, awayTeam);
    } catch (err) {
      logger.warn({ err, matchId, betfairEventId }, "sweepEventOnDemand: team-name resolve threw");
      return {
        resolvedEventId: null,
        marketsDiscovered: 0,
        snapshotsWritten: 0,
        foundMarkets: false,
        reason: "team_name_resolve_error",
      };
    }
  }

  if (!resolvedEventId || !BETFAIR_EVENT_ID_RE.test(resolvedEventId)) {
    return {
      resolvedEventId,
      marketsDiscovered: 0,
      snapshotsWritten: 0,
      foundMarkets: false,
      reason: "event_id_unresolvable",
    };
  }

  // Force-bypass the 5-min catalogueCache by calling listMarketCatalogue
  // directly. The cache wouldn't catch fresh markets that Betfair listed
  // since the last sweep; this is the "make the exchange the authority"
  // intent.
  let catalogue: MarketCatalogueItem[];
  try {
    catalogue = await listMarketCatalogue([resolvedEventId]);
  } catch (err) {
    logger.warn(
      { err, matchId, resolvedEventId },
      "sweepEventOnDemand: listMarketCatalogue threw",
    );
    return {
      resolvedEventId,
      marketsDiscovered: 0,
      snapshotsWritten: 0,
      foundMarkets: false,
      reason: "catalogue_api_error",
    };
  }

  const relevant = catalogue.filter((c) => {
    const bf = c.description?.marketType;
    return bf != null && TARGET_BETFAIR_MARKET_TYPES.has(bf);
  });
  if (relevant.length === 0) {
    return {
      resolvedEventId,
      marketsDiscovered: 0,
      snapshotsWritten: 0,
      foundMarkets: false,
      reason: "no_relevant_market_types",
    };
  }

  const marketIdsByCtx = new Map<string, { bfMarketType: string; internalMarketType: string; catalogue: MarketCatalogueItem }>();
  for (const cat of relevant) {
    marketIdsByCtx.set(cat.marketId, {
      bfMarketType: cat.description!.marketType!,
      internalMarketType: toInternalMarketType(cat.description!.marketType!),
      catalogue: cat,
    });
  }

  let books: MarketBook[];
  try {
    books = await listMarketBook(Array.from(marketIdsByCtx.keys()));
  } catch (err) {
    logger.warn(
      { err, matchId, resolvedEventId, marketCount: marketIdsByCtx.size },
      "sweepEventOnDemand: listMarketBook threw",
    );
    return {
      resolvedEventId,
      marketsDiscovered: marketIdsByCtx.size,
      snapshotsWritten: 0,
      foundMarkets: true,
      reason: "book_api_error",
    };
  }

  const snapshotTime = new Date();
  let snapshotsWritten = 0;
  for (const book of books) {
    const ctx = marketIdsByCtx.get(book.marketId);
    if (!ctx) continue;
    if (book.status !== "OPEN") continue;
    for (const runner of book.runners) {
      if (runner.status !== "ACTIVE") continue;
      const back = runner.ex?.availableToBack?.[0]?.price;
      const lay = runner.ex?.availableToLay?.[0]?.price;
      if (back == null && lay == null) continue;
      const catRunner = ctx.catalogue.runners?.find((r) => r.selectionId === runner.selectionId);
      if (!catRunner) continue;
      const selectionName = deriveSelectionName(ctx.bfMarketType, catRunner, homeTeam, awayTeam);
      if (!selectionName) continue;
      try {
        await db.insert(oddsSnapshotsTable).values({
          matchId,
          marketType: ctx.internalMarketType,
          selectionName,
          backOdds: back != null ? String(back) : null,
          layOdds: lay != null ? String(lay) : null,
          source: "betfair_exchange",
          snapshotTime,
        });
        snapshotsWritten += 1;
      } catch (err) {
        logger.warn(
          { err, matchId, marketId: book.marketId, selectionName },
          "sweepEventOnDemand: odds_snapshots insert failed",
        );
      }
    }
  }

  return {
    resolvedEventId,
    marketsDiscovered: marketIdsByCtx.size,
    snapshotsWritten,
    foundMarkets: marketIdsByCtx.size > 0,
    reason: snapshotsWritten > 0 ? "snapshots_written" : "markets_found_no_active_runners",
  };
}
