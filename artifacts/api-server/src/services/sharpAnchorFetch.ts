/**
 * Sharp-anchor fetch — Bundle 1 E.3 + E.5 (subtractive redesign 2026-05-17)
 *
 * At placement decision time, augments Pinnacle (paid, always-on, zero-lag)
 * with a SHARP-only free-tier supplement (Singbet, the global #1 AH sharp).
 * Bet365/1xBet (softs) and SBOBet (sharp but per-book line decoder not yet
 * reliable from a single sample) were removed in E.5 — sharps are
 * edge-finders, softs are what we bet INTO. Treating Bet365 as an edge
 * anchor was a category error.
 *
 * Niche assignments (E.5):
 *  - ASIAN_HANDICAP with Pinnacle present + edge ≥3pp → singbet (cross-sharp).
 *  - ASIAN_HANDICAP with Pinnacle absent              → singbet (primary anchor).
 *  - All other markets                                 → no free-tier supplement.
 *    PINNACLE-ABSENT non-AH bets stay shadow until they prove edge via
 *    Wilson 95% LCB on win-rate + CLV t-stat against the now-bias-corrected
 *    model (Bundle 5.B). Graduation goes via the existing two-path
 *    v_live_eligibility view — no special multi-book signal needed.
 *
 * Why Singbet only:
 *   - Pinnacle responses use clean slash-format outcome IDs ("-0.5/home").
 *   - Singbet uses cryptic-but-decodable IOR_R{H|C}/{line} mnemonics.
 *   - SBOBet uses {h, a} side codes with line encoded in bookmakerMarketId
 *     (decode requires more samples to validate).
 *   - Bet365 uses pure opaque numeric IDs ("1179904266") — undecodable
 *     without an external Bet365 dictionary.
 *
 * Budget: 9/day, 250/month, enforced by canMakeOddspapiFreeRequest.
 * Singbet-only narrows the niche table to one book per AH burst, halving
 * expected burn vs the prior 2-book bursts.
 *
 * Pinnacle fallback: when the free-tier path degrades (cap hit, key
 * missing, decoder miss), the bet still has Pinnacle as its sharp anchor
 * via the paid prefetch path (pinnacle_odds_snapshots rows with
 * bookmaker_slug='pinnacle' already exist). The result outcome is
 * 'pinnacle_fallback' in that case — acceptable degradation, not a
 * failure. Only when Pinnacle is ALSO absent (PINNACLE-ABSENT scopes)
 * does the result become a true degradation (budget_exhausted /
 * free_tier_disabled / fetch_failed), and downstream gating (Bundle 5
 * Stage 2) demotes those candidates to shadow.
 *
 * Cache: a (match × market × selection × book) tuple within 5 minutes
 * reuses the existing pinnacle_odds_snapshots rows.
 */

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, oddspapiFixtureMapTable, pinnacleOddsSnapshotsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  fetchOddsPapiFree,
  MARKET_IDS,
  extractBookmakers,
  extractSelections,
  getBookmakerSlug,
  type RawOddsResponse,
  type RawOddsSelection,
} from "./oddsPapi";

// Sharps only. Softs (bet365/1xbet/williamhill/...) are what we bet INTO,
// not edge anchors. Singbet decodes via IOR_R{H|C}/<line>; SBOBet decodes
// via price-proximity against the bet's Betfair odds (its outcome IDs are
// just "h"/"a" with no line info, and the line-encoding in
// bookmakerMarketId first segment is an opaque SBOBet internal catalog).
export type SharpBookSlug = "singbet" | "sbobet";

export interface SharpAnchorPrice {
  bookmakerSlug: SharpBookSlug | "pinnacle";
  odds: number;
  rawImplied: number; // 1/odds — overround NOT stripped. Consumers de-vig as needed.
  capturedAt: Date;
}

export type SharpAnchorOutcome =
  | "fetched"            // free-tier returned at least one decoded sharp price
  | "cached"             // 5-min cache hit; no budget burn
  | "no_niche_qualifies" // bet doesn't qualify for any free-tier supplement
  | "pinnacle_fallback"  // free-tier path degraded BUT Pinnacle anchors the bet
                          //   (acceptable degradation — paid Pinnacle stream is
                          //   the always-on anchor; free-tier is supplementary)
  | "budget_exhausted"   // free-tier cap hit AND no Pinnacle anchor (PINNACLE-ABSENT)
  | "free_tier_disabled" // ODDSPAPI_FREE_KEY missing AND no Pinnacle anchor
  | "fetch_failed";      // fetched but no per-book decoder matched AND no Pinnacle

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
  /** Bet's Betfair back odds at placement — used by SBOBet price-proximity matcher. */
  backOdds: number;
  pinnacleImplied: number | null;
  pinnacleEdgePp: number; // (betfair_odds * pinnacle_implied - 1) * 100
  oddspapiFixtureId: string | null;
}

const CACHE_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

// Pinnacle is on the always-on paid prefetch path; its data lives in
// pinnacle_odds_snapshots with bookmaker_slug='pinnacle' regardless of
// whether the free-tier supplement succeeds. When the free-tier path
// degrades (budget exhausted, key missing, decoder miss), a bet with a
// Pinnacle anchor still has a valid sharp reference — the system reports
// outcome='pinnacle_fallback' rather than a hard failure. Only when
// Pinnacle is ALSO absent (PINNACLE-ABSENT scopes) does the degradation
// become real.
function hasPinnacleAnchor(input: SharpAnchorInput): boolean {
  return input.pinnacleImplied != null && input.pinnacleImplied > 0;
}

// E.5 (2026-05-17, subtractive): sharps only. Singbet is the global #1 AH
// sharp; SBOBet adds confirmation on high-conviction (≥5pp) AH. Bet365 and
// 1xBet are SOFTS — they're what we bet INTO, not edge anchors; removed.
// PINNACLE-ABSENT non-AH markets stay shadow until they prove edge via
// Wilson 95% LCB + CLV t-stat on the (now bias-corrected) model, then
// graduate via the existing v_live_eligibility two-path gate. All other
// markets (MO/OU/BTTS/corners/cards/etc.) ride on Pinnacle alone — no
// free-tier supplement.
function pickNiches(input: SharpAnchorInput): SharpBookSlug[] {
  const { marketType, pinnacleImplied, pinnacleEdgePp } = input;
  if (marketType !== "ASIAN_HANDICAP") return [];
  const pinnacleAvailable = pinnacleImplied != null && pinnacleImplied > 0;
  if (pinnacleAvailable && pinnacleEdgePp >= 3) {
    return pinnacleEdgePp >= 5 ? ["singbet", "sbobet"] : ["singbet"];
  }
  if (!pinnacleAvailable) return ["singbet"]; // PINNACLE-ABSENT AH
  return [];
}

// ── Singbet AH outcome decoder (E.5) ──────────────────────────────────────
// Singbet's bookmakerOutcomeId for AH outcomes follows the pattern
// "IOR_R{H|C}/<line> / <leg>" — e.g. "IOR_RH/0.5 / 1" or "IOR_RC/0.5 / 1".
// "RH" = home runner; "RC" = away runner. The line is the absolute
// handicap value; its sign is implied by the side convention (favourite
// gets -line, dog gets +line). Singbet returns one outcome per side per
// line, so a matched (side, abs(line)) is canonical for that market spec.
//
// To distinguish "Home -0.5" from "Home +0.5" when both could exist as
// separate Singbet markets, we use price-sign: the favourite handicap
// (negative) has price < 2.0; the dog handicap (positive) has price >
// 2.0. PK (line=0) and razor-thin lines may sit either side of 2.0;
// we accept the first match in that case.
//
// Note: marketKey filtering is intentionally skipped — Singbet's market
// keys are bookmaker-internal codes (10492, 1066, etc.), not OddspaPI's
// normalised marketId. The /odds endpoint already filtered server-side
// by marketId=104; we trust that and identify AH outcomes by the
// "IOR_R[HC]/" prefix in bookmakerOutcomeId.
function decodeSingbetAH(
  selections: RawOddsSelection[],
  selectionName: string,
): number | null {
  const parts = selectionName.split(/\s+/);
  if (parts.length < 2) return null;
  const wantedSide = parts[0]?.toLowerCase();
  const wantedHandicap = parseFloat(parts[1] ?? "0");
  if (!Number.isFinite(wantedHandicap)) return null;
  if (wantedSide !== "home" && wantedSide !== "away") return null;
  const wantedAbs = Math.abs(wantedHandicap);

  const SINGBET_AH_RE = /^IOR_R([HC])\/(-?\d+(?:\.\d+)?)\s*\/\s*\d+$/;
  for (const sel of selections) {
    const ocId = String((sel as any).bookmakerOutcomeId ?? sel.label ?? "");
    const m = SINGBET_AH_RE.exec(ocId);
    if (!m) continue;
    const side = m[1] === "H" ? "home" : "away";
    const lineAbs = Math.abs(parseFloat(m[2]!));
    if (side !== wantedSide) continue;
    if (Math.abs(lineAbs - wantedAbs) > 0.01) continue;
    const odds = (sel.odds ?? (sel as any).value ?? sel.price) as number | undefined;
    if (odds == null || odds <= 1) continue;
    // Price-sign check: a favourite handicap (wantedHandicap<0) should
    // price <2.0; a dog handicap (>0) should price >2.0. Skip if the
    // direction is clearly wrong, accept otherwise (PK / razor-thin).
    if (wantedHandicap < -0.01 && odds > 2.10) continue;
    if (wantedHandicap > 0.01 && odds < 1.90) continue;
    return odds;
  }
  return null;
}

// ── SBOBet AH outcome decoder (E.5 — price-proximity matcher) ─────────────
// SBOBet's AH bookmakerOutcomeId is just "h" (home) or "a" (away). The
// line is encoded only in bookmakerMarketId's first segment (e.g.
// "655312093/9849447/1/0") which is an opaque SBOBet-internal catalog ID
// with no decodable arithmetic — different IDs across lines, but no
// public mapping. Across a single fixture, SBOBet typically returns
// 4-8 AH markets covering main + alternate lines.
//
// Strategy: pick the SBOBet AH market whose price on the bet's side is
// closest to the bet's Betfair odds. Sharps quote the same line within
// ~5-10%; markets on different lines diverge by 30%+. A 25% deviation
// band keeps us safely on the right line while tolerating sharp/soft
// price drift.
//
// Fallback: if no SBOBet market is within tolerance, return null — caller
// continues on Singbet alone (or Pinnacle alone if Singbet also failed).
function decodeSBOBetAH(
  selections: RawOddsSelection[],
  selectionName: string,
  backOdds: number,
): number | null {
  if (!Number.isFinite(backOdds) || backOdds <= 1) return null;
  const parts = selectionName.split(/\s+/);
  if (parts.length < 1) return null;
  const wantedSide = parts[0]?.toLowerCase();
  if (wantedSide !== "home" && wantedSide !== "away") return null;
  const sideCode = wantedSide === "home" ? "h" : "a";

  // Group selections by their parent market (via the existing marketKey
  // field preserved by extractSelections). For each market that has BOTH
  // an h and an a outcome (i.e. is binary, = AH), pull the price on our
  // side. Then pick the market whose side-price is closest to backOdds.
  const byMarket = new Map<string, { h?: number; a?: number }>();
  for (const sel of selections) {
    const mk = String((sel as any).marketKey ?? "");
    if (!mk) continue;
    const ocId = String((sel as any).bookmakerOutcomeId ?? sel.label ?? "").toLowerCase();
    if (ocId !== "h" && ocId !== "a") continue;
    const odds = (sel.odds ?? (sel as any).value ?? sel.price) as number | undefined;
    if (odds == null || odds <= 1) continue;
    const entry = byMarket.get(mk) ?? {};
    entry[ocId as "h" | "a"] = odds;
    byMarket.set(mk, entry);
  }

  let bestOdds: number | null = null;
  let bestDelta = Infinity;
  for (const { h, a } of byMarket.values()) {
    if (h == null || a == null) continue; // not a binary AH market
    const sidePrice = sideCode === "h" ? h : a;
    const delta = Math.abs(sidePrice - backOdds) / backOdds;
    if (delta < bestDelta) {
      bestDelta = delta;
      bestOdds = sidePrice;
    }
  }
  // 25% deviation cap — beyond that, we're almost certainly looking at a
  // different line, not the same one priced sharper.
  if (bestOdds != null && bestDelta <= 0.25) return bestOdds;
  return null;
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
    // budget exhausted OR network failure). Pinnacle is the always-on
    // anchor via the paid prefetch — if it's available for this bet, the
    // bet still has a sharp reference and the free-tier loss is acceptable.
    // Only mark a "true" degradation when Pinnacle is also absent.
    if (hasPinnacleAnchor(input)) {
      return { outcome: "pinnacle_fallback", niches, prices: cached, budgetSpent: 0 };
    }
    const outcome: SharpAnchorOutcome = process.env.ODDSPAPI_FREE_KEY
      ? "budget_exhausted"
      : "free_tier_disabled";
    return { outcome, niches, prices: cached, budgetSpent: 0 };
  }

  // ── Parse the multi-book response with a book-aware dispatcher. ─────────
  // Each sharp uses its own outcome-ID schema:
  //   Singbet: IOR_R{H|C}/<line> mnemonic — direct line match.
  //   SBOBet:  "h"/"a" with line in opaque bookmakerMarketId — price-proximity.
  // Pinnacle is never fetched here (paid prefetch is the authoritative path).
  const now = new Date();
  const books = extractBookmakers(raw);
  const fresh: SharpAnchorPrice[] = [];
  for (const bm of books) {
    const slug = getBookmakerSlug(bm) as SharpBookSlug;
    if (!niches.includes(slug)) continue;
    const selections = extractSelections(bm);
    let odds: number | null = null;
    if (input.marketType === "ASIAN_HANDICAP") {
      if (slug === "singbet") {
        odds = decodeSingbetAH(selections, input.selectionName);
      } else if (slug === "sbobet") {
        odds = decodeSBOBetAH(selections, input.selectionName, input.backOdds);
      }
    }
    if (!odds || odds <= 1) continue;
    fresh.push({
      bookmakerSlug: slug,
      odds,
      rawImplied: 1 / odds,
      capturedAt: now,
    });
  }

  if (fresh.length === 0) {
    // Response was OK but no per-book decoder matched the bet's selection.
    // E.5 onwards the decoders are book-specific (Singbet regex / SBOBet
    // price-proximity), so the diagnostic dumps a sample of every outcome
    // each requested book returned — that's all we need to diagnose either
    // (a) the bet's line not being priced by that book, or (b) the book's
    // outcome-ID schema drifting from what the decoder expects.
    const diagnostic = books
      .filter((bm) => niches.includes(getBookmakerSlug(bm) as SharpBookSlug))
      .map((bm) => {
        const slug = getBookmakerSlug(bm);
        const sels = extractSelections(bm);
        return {
          slug,
          totalSelections: sels.length,
          sampleOutcomeIds: sels
            .slice(0, 12)
            .map((s) => ({
              ocId: String((s as any).bookmakerOutcomeId ?? s.label ?? ""),
              marketKey: s.marketKey ?? null,
              price: s.price ?? s.odds ?? null,
            })),
          distinctMarketKeys: [...new Set(sels.map((s) => s.marketKey).filter(Boolean))].slice(0, 12),
        };
      });
    logger.warn(
      {
        matchId: input.matchId,
        marketType: input.marketType,
        selectionName: input.selectionName,
        backOdds: input.backOdds,
        niches,
        booksInResponse: books.map(getBookmakerSlug),
        diagnostic,
        pinnacleAnchor: hasPinnacleAnchor(input),
      },
      "sharpAnchorFetch: no per-book decoder matched bet's selection",
    );
    // Budget was spent on the fetch, but no per-book sharp price extracted.
    // Pinnacle still anchors the bet via the paid prefetch path when present.
    if (hasPinnacleAnchor(input)) {
      return { outcome: "pinnacle_fallback", niches, prices: cached, budgetSpent: 1 };
    }
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
