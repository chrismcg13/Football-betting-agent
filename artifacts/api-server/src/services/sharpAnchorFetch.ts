/**
 * Sharp-anchor fetch — Bundle 1 E.3
 *
 * At placement decision time, augments Pinnacle (paid, always-on, zero-lag)
 * with niche-aligned sharp books drawn from the free-tier OddsPapi account
 * (250 requests/month, multi-book per request). Result is stored in
 * pinnacle_odds_snapshots with bookmaker_slug ∈ {singbet, sbobet, bet365,
 * 1xbet}; Pinnacle itself is NOT requested here (paid prefetch is the
 * authoritative source — avoids race conditions).
 *
 * Niche assignments (see docs/bundle-1-sharp-coverage-plan.md §C revised):
 *  - ASIAN_HANDICAP   → singbet (G5 primary). +sbobet on high conviction (≥5pp).
 *  - PINNACLE-ABSENT (pinnacle_implied == null) on MO/OU/BTTS → bet365 + 1xbet
 *    to fill the coverage gap on leagues Pinnacle skips.
 *  - Top-conviction non-AH (≥5pp Pinnacle edge) on covered league → singbet
 *    + bet365 sweep.
 *
 * Budget: 9/day, 250/month, enforced by canMakeOddspapiFreeRequest. When
 * exhausted, returns degradeReason='free_tier_budget_exhausted' and callers
 * fall back to single-sharp (Pinnacle-only) gating per R3 — 0.5× Kelly.
 *
 * Cache: a (match × market) tuple within 5 minutes reuses the existing
 * pinnacle_odds_snapshots rows (the OddsPapi /odds endpoint cost is per
 * request, not per selection — one call covers every selection in the
 * market for all requested books, so within-cycle same-match candidates
 * share a single budget slot).
 */

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, oddspapiFixtureMapTable, pinnacleOddsSnapshotsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  fetchOddsPapiFree,
  MARKET_IDS,
  extractBookmakers,
  extractSelections,
  getSelectionOdds,
  getBookmakerSlug,
  type RawOddsResponse,
} from "./oddsPapi";

export type SharpBookSlug = "singbet" | "sbobet" | "bet365" | "1xbet";

export interface SharpAnchorPrice {
  bookmakerSlug: SharpBookSlug | "pinnacle";
  odds: number;
  rawImplied: number; // 1/odds — overround NOT stripped. Consumers de-vig as needed.
  capturedAt: Date;
}

export type SharpAnchorOutcome =
  | "fetched"
  | "cached"
  | "budget_exhausted"
  | "free_tier_disabled"
  | "no_niche_qualifies"
  | "fetch_failed";

export interface SharpAnchorResult {
  outcome: SharpAnchorOutcome;
  niches: SharpBookSlug[]; // slugs we tried to fetch (or reused from cache)
  prices: SharpAnchorPrice[]; // one per book × THIS selection
  budgetSpent: 0 | 1; // 1 if a new free-tier request was burned
}

interface SharpAnchorInput {
  matchId: number;
  marketType: string;
  selectionName: string;
  pinnacleImplied: number | null;
  pinnacleEdgePp: number; // (betfair_odds * pinnacle_implied - 1) * 100
  oddspapiFixtureId: string | null;
}

const CACHE_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes
const MO_OU_BTTS_MARKETS = new Set([
  "MATCH_ODDS",
  "OVER_UNDER_05",
  "OVER_UNDER_15",
  "OVER_UNDER_25",
  "OVER_UNDER_35",
  "OVER_UNDER_45",
  "BTTS",
]);

// Niche-aligned slug selection. Returns [] if the candidate doesn't qualify
// for any free-tier supplement; callers then proceed on Pinnacle alone.
function pickNiches(input: SharpAnchorInput): SharpBookSlug[] {
  const { marketType, pinnacleImplied, pinnacleEdgePp } = input;
  const pinnacleAvailable = pinnacleImplied != null && pinnacleImplied > 0;
  const niches: SharpBookSlug[] = [];

  if (marketType === "ASIAN_HANDICAP" && pinnacleAvailable && pinnacleEdgePp >= 3) {
    niches.push("singbet");
    if (pinnacleEdgePp >= 5) niches.push("sbobet");
    return niches;
  }

  if (!pinnacleAvailable && MO_OU_BTTS_MARKETS.has(marketType)) {
    // PINNACLE-ABSENT coverage-gap fill
    niches.push("bet365", "1xbet");
    return niches;
  }

  if (pinnacleAvailable && pinnacleEdgePp >= 5) {
    // Top-conviction non-AH: bring in Bet365 + Singbet for cross-check
    niches.push("singbet", "bet365");
    return niches;
  }

  return [];
}

async function readCachedSnapshots(
  matchId: number,
  marketType: string,
  selectionName: string,
  niches: SharpBookSlug[],
): Promise<SharpAnchorPrice[]> {
  const cutoff = new Date(Date.now() - CACHE_FRESHNESS_MS);
  const rows = await db
    .select({
      bookmakerSlug: pinnacleOddsSnapshotsTable.bookmakerSlug,
      pinnacleOdds: pinnacleOddsSnapshotsTable.pinnacleOdds,
      pinnacleImplied: pinnacleOddsSnapshotsTable.pinnacleImplied,
      capturedAt: pinnacleOddsSnapshotsTable.capturedAt,
    })
    .from(pinnacleOddsSnapshotsTable)
    .where(
      and(
        eq(pinnacleOddsSnapshotsTable.matchId, matchId),
        eq(pinnacleOddsSnapshotsTable.marketType, marketType),
        eq(pinnacleOddsSnapshotsTable.selectionName, selectionName),
        inArray(pinnacleOddsSnapshotsTable.bookmakerSlug, niches as unknown as string[]),
        gte(pinnacleOddsSnapshotsTable.capturedAt, cutoff),
      ),
    )
    .orderBy(desc(pinnacleOddsSnapshotsTable.capturedAt));

  // Dedupe to latest per book within the window
  const latest = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    if (!latest.has(r.bookmakerSlug)) latest.set(r.bookmakerSlug, r);
  }
  return [...latest.values()].map((r) => ({
    bookmakerSlug: r.bookmakerSlug as SharpBookSlug,
    odds: Number(r.pinnacleOdds),
    rawImplied: r.pinnacleImplied ? Number(r.pinnacleImplied) : 1 / Number(r.pinnacleOdds),
    capturedAt: r.capturedAt,
  }));
}

async function persistSnapshots(
  matchId: number,
  marketType: string,
  selectionName: string,
  prices: SharpAnchorPrice[],
): Promise<void> {
  if (prices.length === 0) return;
  await db.insert(pinnacleOddsSnapshotsTable).values(
    prices.map((p) => ({
      matchId,
      marketType,
      selectionName,
      snapshotType: "sharp_anchor_free",
      pinnacleOdds: String(p.odds),
      pinnacleImplied: String(p.rawImplied),
      bookmakerSlug: p.bookmakerSlug,
      capturedAt: p.capturedAt,
    })),
  );
}

/**
 * Niche-aligned sharp confirmation at placement-decision time.
 *
 * Synchronous in the placement cycle. Non-qualifying candidates skip the
 * IO entirely (outcome='no_niche_qualifies'). Qualifying candidates with
 * fresh cache get outcome='cached' (no budget burn). Else one free-tier
 * request, 200-400ms typical, all niches in one call.
 */
export async function fetchSharpAnchors(input: SharpAnchorInput): Promise<SharpAnchorResult> {
  const niches = pickNiches(input);

  if (niches.length === 0) {
    return { outcome: "no_niche_qualifies", niches: [], prices: [], budgetSpent: 0 };
  }

  // ── Cache check: any (match, market, selection, book) within 5 minutes? ──
  const cached = await readCachedSnapshots(
    input.matchId,
    input.marketType,
    input.selectionName,
    niches,
  );
  if (cached.length === niches.length) {
    return { outcome: "cached", niches, prices: cached, budgetSpent: 0 };
  }

  // ── Need a fresh fetch. Require a fixtureId mapping. ──
  if (!input.oddspapiFixtureId) {
    logger.debug(
      { matchId: input.matchId, marketType: input.marketType },
      "sharpAnchorFetch: no oddspapi_fixture_id, falling back to Pinnacle only",
    );
    return { outcome: "fetch_failed", niches, prices: cached, budgetSpent: 0 };
  }

  const marketId = MARKET_IDS[input.marketType];
  if (!marketId) {
    return { outcome: "fetch_failed", niches, prices: cached, budgetSpent: 0 };
  }

  // ODDSPAPI_FREE_KEY absent or budget exhausted → graceful degrade.
  const raw = await fetchOddsPapiFree<RawOddsResponse>(
    "/odds",
    {
      fixtureId: input.oddspapiFixtureId,
      marketId,
      bookmakers: niches.join(","),
    },
    "sharp_anchor",
  );
  if (!raw) {
    // fetchOddsPapiFree already logged the specific reason (key missing OR
    // budget exhausted OR network failure). Distinguish budget vs other by
    // checking the env var presence — coarse but fits the result enum.
    const outcome: SharpAnchorOutcome = process.env.ODDSPAPI_FREE_KEY
      ? "budget_exhausted"
      : "free_tier_disabled";
    return { outcome, niches, prices: cached, budgetSpent: 0 };
  }

  // ── Parse the multi-book response. One row per (book × this selection). ──
  const now = new Date();
  const books = extractBookmakers(raw);
  const fresh: SharpAnchorPrice[] = [];
  for (const bm of books) {
    const slug = getBookmakerSlug(bm) as SharpBookSlug;
    if (!niches.includes(slug)) continue;
    const selections = extractSelections(bm);
    const odds = getSelectionOdds(selections, input.marketType, input.selectionName);
    if (!odds || odds <= 1) continue;
    fresh.push({
      bookmakerSlug: slug,
      odds,
      rawImplied: 1 / odds,
      capturedAt: now,
    });
  }

  if (fresh.length === 0) {
    // Response was OK but no matching selection — the line might not exist for
    // this book or the parser slug mapping is off. Don't write anything.
    logger.warn(
      {
        matchId: input.matchId,
        marketType: input.marketType,
        selectionName: input.selectionName,
        niches,
        booksInResponse: books.map(getBookmakerSlug),
      },
      "sharpAnchorFetch: no matching selection in free-tier response",
    );
    return { outcome: "fetch_failed", niches, prices: cached, budgetSpent: 1 };
  }

  await persistSnapshots(input.matchId, input.marketType, input.selectionName, fresh);

  return {
    outcome: "fetched",
    niches,
    // Merge fresh fetches over any cached partials so callers always see latest.
    prices: [...cached.filter((c) => !fresh.find((f) => f.bookmakerSlug === c.bookmakerSlug)), ...fresh],
    budgetSpent: 1,
  };
}

/**
 * Lightweight read-only resolver for the oddspapi_fixture_id mapping. Pulled
 * from oddspapi_fixture_map (the writer-cached table that backs prefetch).
 * Returns null if no mapping exists — caller falls back to Pinnacle-only.
 *
 * Uses typed Drizzle select. The earlier raw-SQL version of this function
 * (E.3 initial commit) returned null for every call because
 * `db.execute<T>(sql...)` doesn't expose a `.rows` array at runtime under
 * our Drizzle/pg combo — the shape is iterable but doesn't match the
 * cast. Fixed by using the schema-typed table.
 */
export async function lookupOddspapiFixtureId(matchId: number): Promise<string | null> {
  const rows = await db
    .select({ oddspapiFixtureId: oddspapiFixtureMapTable.oddspapiFixtureId })
    .from(oddspapiFixtureMapTable)
    .where(eq(oddspapiFixtureMapTable.matchId, matchId))
    .limit(1);
  return rows[0]?.oddspapiFixtureId ?? null;
}
