/**
 * OddsPapi Integration — Sharp-line validation & best-odds layer
 * Base URL: https://api.oddspapi.io/v4
 * Auth: query param apiKey={ODDSPAPI_KEY}
 * Budget: 5,000 requests/month | Cap: 4,800/month, 150/day
 * Allocation: ~80/day pre-match validation, ~20/day closing-line CLV, ~1/day mapping
 */

import {
  db,
  matchesTable,
  paperBetsTable,
  oddspapiFixtureMapTable,
  apiUsageTable,
  oddsSnapshotsTable,
  complianceLogsTable,
  learningNarrativesTable,
  leagueEdgeScoresTable,
  oddspapiLeagueCoverageTable,
} from "@workspace/db";
import { eq, and, gte, lte, sql, like, inArray, ne } from "drizzle-orm";
import { logger } from "../lib/logger";

const BASE_URL = "https://api.oddspapi.io/v4";
const DAILY_CAP = 150;
const MONTHLY_CAP = 4800;

// DB-driven cap override — reads agent_config key "oddspapi_daily_cap_override"
// Format: {"cap": 15, "expires": "2026-04-09"}  (expires = ISO date, inclusive)
async function getEffectiveDailyCap(): Promise<number> {
  try {
    const { agentConfigTable: act } = await import("@workspace/db");
    const rows = await db.select().from(act).where(eq(act.key, "oddspapi_daily_cap_override")).limit(1);
    if (rows.length > 0 && rows[0]) {
      const data = JSON.parse(rows[0].value) as { cap?: number; expires?: string };
      const today = new Date().toISOString().slice(0, 10);
      if (data.cap && data.expires && data.expires >= today) {
        logger.info({ cap: data.cap, expires: data.expires }, "OddsPapi daily cap override active");
        return data.cap;
      }
    }
  } catch { /* fall through to default */ }
  return DAILY_CAP;
}

// ─── Market ID mapping ─────────────────────────────────────────────────────────

const MARKET_IDS: Record<string, number> = {
  MATCH_ODDS: 101,
  OVER_UNDER_25: 102,
  OVER_UNDER_15: 102,
  OVER_UNDER_35: 102,
  BTTS: 103,
  ASIAN_HANDICAP: 104,
  TOTAL_CARDS_35: 112,
  TOTAL_CARDS_45: 112,
  TOTAL_CORNERS_95: 113,
  TOTAL_CORNERS_105: 113,
};

// OU line to target for each market type
const OU_LINES: Record<string, string> = {
  OVER_UNDER_15: "1.5",
  OVER_UNDER_25: "2.5",
  OVER_UNDER_35: "3.5",
  TOTAL_CARDS_35: "3.5",
  TOTAL_CARDS_45: "4.5",
  TOTAL_CORNERS_95: "9.5",
  TOTAL_CORNERS_105: "10.5",
};

// Sharp bookmakers (consensus-setting)
const SHARP_SLUGS = new Set(["pinnacle", "singbet", "sbobet", "pinnaclesports"]);
// Soft bookmakers (recreational pricing)
const SOFT_SLUGS = new Set(["bet365", "williamhill", "ladbrokes", "bwin", "unibet", "betway", "paddypower"]);

// ─── Budget tracking ──────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStr(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export async function getOddspapiUsageToday(): Promise<number> {
  const today = todayStr();
  const rows = await db
    .select({ total: sql<number>`sum(${apiUsageTable.requestCount})::int` })
    .from(apiUsageTable)
    .where(and(eq(apiUsageTable.date, today), like(apiUsageTable.endpoint, "oddspapi_%")));
  return Number(rows[0]?.total ?? 0);
}

export async function getOddspapiUsageThisMonth(): Promise<number> {
  const month = monthStr();
  const rows = await db
    .select({ total: sql<number>`sum(${apiUsageTable.requestCount})::int` })
    .from(apiUsageTable)
    .where(and(like(apiUsageTable.date, `${month}%`), like(apiUsageTable.endpoint, "oddspapi_%")));
  return Number(rows[0]?.total ?? 0);
}

async function trackOddspapiCall(endpoint: string, count = 1): Promise<void> {
  await db.insert(apiUsageTable).values({
    date: todayStr(),
    endpoint: `oddspapi_${endpoint}`,
    requestCount: count,
  });
}

async function canMakeOddspapiRequest(needed = 1): Promise<boolean> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return false;
  const [daily, monthly, effectiveCap] = await Promise.all([
    getOddspapiUsageToday(),
    getOddspapiUsageThisMonth(),
    getEffectiveDailyCap(),
  ]);
  if (daily + needed > effectiveCap) {
    logger.warn({ daily, cap: effectiveCap }, "OddsPapi daily budget exhausted");
    return false;
  }
  if (monthly + needed > MONTHLY_CAP) {
    logger.warn({ monthly, cap: MONTHLY_CAP }, "OddsPapi monthly budget exhausted");
    return false;
  }
  return true;
}

export async function getOddspapiStatus(): Promise<{
  todayCount: number;
  monthCount: number;
  dailyCap: number;
  monthlyCap: number;
  enabled: boolean;
}> {
  const key = process.env.ODDSPAPI_KEY;
  const [todayCount, monthCount] = await Promise.all([
    getOddspapiUsageToday(),
    getOddspapiUsageThisMonth(),
  ]);
  return { todayCount, monthCount, dailyCap: DAILY_CAP, monthlyCap: MONTHLY_CAP, enabled: !!key };
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchOddsPapi<T = unknown>(
  path: string,
  params: Record<string, string | number> = {},
  trackAs = "request",
): Promise<T | null> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) {
    logger.debug("ODDSPAPI_KEY not set — skipping OddsPapi call");
    return null;
  }

  if (!(await canMakeOddspapiRequest())) return null;

  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("apiKey", key);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  try {
    const res = await fetch(url.toString());
    await trackOddspapiCall(trackAs);

    if (!res.ok) {
      logger.warn({ status: res.status, path }, "OddsPapi HTTP error");
      return null;
    }

    const json = await res.json() as Record<string, unknown>;
    // Handle both { data: ... } and direct array responses
    if (json.data !== undefined) return json.data as T;
    if (Array.isArray(json)) return json as unknown as T;
    return json as unknown as T;
  } catch (err) {
    logger.error({ err, path }, "OddsPapi fetch failed");
    return null;
  }
}

// ─── Team name normalisation (shared with apiFootball.ts logic) ───────────────

function normalizeTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bfc\b|\bsc\b|\bac\b|\bcf\b|\bfk\b|\bsk\b|\bsv\b|\butd\b|\bunited\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function teamMatch(a: string, b: string): boolean {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const fa = na.split(" ")[0] ?? "";
  const fb = nb.split(" ")[0] ?? "";
  return fa.length > 3 && fa === fb;
}

// ─── Fixture response parsing ─────────────────────────────────────────────────

interface RawFixture {
  // OddsPapi v4 actual format
  fixtureId?: string;
  participant1Name?: string;
  participant2Name?: string;
  startTime?: string;
  // Legacy / alternative formats (fallbacks)
  id?: number | string;
  startDate?: string;
  date?: string;
  kickoff?: string;
  homeTeam?: { name?: string; id?: number } | string;
  awayTeam?: { name?: string; id?: number } | string;
  home?: { name?: string } | string;
  away?: { name?: string } | string;
  teams?: { home?: { name?: string }; away?: { name?: string } };
  participants?: Array<{ type?: string; name?: string; id?: number }>;
}

function extractFixtureStringId(f: RawFixture): string | null {
  if (f.fixtureId) return String(f.fixtureId);
  if (f.id != null) return String(f.id);
  return null;
}

function extractTeamNames(f: RawFixture): { home: string; away: string } | null {
  // Format 0 (OddsPapi v4): { participant1Name, participant2Name }
  if (f.participant1Name && f.participant2Name) {
    return { home: f.participant1Name, away: f.participant2Name };
  }
  // Format 1: { homeTeam: { name }, awayTeam: { name } }
  if (f.homeTeam && f.awayTeam) {
    const h = typeof f.homeTeam === "string" ? f.homeTeam : (f.homeTeam.name ?? "");
    const a = typeof f.awayTeam === "string" ? f.awayTeam : (f.awayTeam.name ?? "");
    if (h && a) return { home: h, away: a };
  }
  // Format 2: { home: { name }, away: { name } }
  if (f.home && f.away) {
    const h = typeof f.home === "string" ? f.home : (f.home.name ?? "");
    const a = typeof f.away === "string" ? f.away : (f.away.name ?? "");
    if (h && a) return { home: h, away: a };
  }
  // Format 3: { teams: { home: { name }, away: { name } } }
  if (f.teams?.home?.name && f.teams?.away?.name) {
    return { home: f.teams.home.name, away: f.teams.away.name };
  }
  // Format 4: { participants: [{ type: 'home', name }, { type: 'away', name }] }
  if (Array.isArray(f.participants)) {
    const home = f.participants.find((p) => p.type === "home" || p.type === "1")?.name ?? "";
    const away = f.participants.find((p) => p.type === "away" || p.type === "2")?.name ?? "";
    if (home && away) return { home, away };
  }
  return null;
}

function extractFixtureDate(f: RawFixture): string | null {
  const raw = f.startTime ?? f.startDate ?? f.date ?? f.kickoff ?? null;
  if (!raw) return null;
  return raw.slice(0, 10);
}

// ─── 1. Daily fixture mapping (1 request/day at 6am UTC) ─────────────────────

export async function runOddspapiFixtureMapping(): Promise<{
  total: number;
  mapped: number;
  newMappings: number;
}> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) {
    logger.info("ODDSPAPI_KEY not set — skipping fixture mapping");
    return { total: 0, mapped: 0, newMappings: 0 };
  }

  if (!(await canMakeOddspapiRequest(1))) {
    logger.warn("OddsPapi budget exhausted — skipping fixture mapping");
    return { total: 0, mapped: 0, newMappings: 0 };
  }

  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const plusFour = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  logger.info({ from: todayDate, to: plusFour }, "Running OddsPapi fixture mapping");

  // CRITICAL: filter hasOdds=true so we only match against fixtures that have
  // bookmaker odds. Without this filter we get duplicate fixture stubs for top leagues
  // that match team names but have hasOdds=false — causing us to miss the real fixture.
  const rawFixtures = await fetchOddsPapi<RawFixture[]>("/fixtures", {
    sportId: 10,
    from: todayDate,
    to: plusFour,
    hasOdds: "true",
  }, "fixtures");

  if (!rawFixtures || !Array.isArray(rawFixtures)) {
    logger.warn("OddsPapi fixture response was empty or unexpected format");
    return { total: 0, mapped: 0, newMappings: 0 };
  }

  logger.info({ count: rawFixtures.length }, "OddsPapi fixtures received");

  // Get upcoming matches from our DB (next 7 days)
  const upcoming = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, new Date(now.getTime() - 3 * 60 * 60 * 1000)),
      ),
    );

  let mapped = 0;
  let newMappings = 0;

  for (const match of upcoming) {
    // Check if already cached
    const existing = await db
      .select({ id: oddspapiFixtureMapTable.id, oddspapiFixtureId: oddspapiFixtureMapTable.oddspapiFixtureId })
      .from(oddspapiFixtureMapTable)
      .where(eq(oddspapiFixtureMapTable.matchId, match.id))
      .limit(1);

    if (existing[0]) {
      mapped++;
      // Refresh cachedAt to keep it warm
      await db
        .update(oddspapiFixtureMapTable)
        .set({ cachedAt: new Date() })
        .where(eq(oddspapiFixtureMapTable.id, existing[0].id));
      continue;
    }

    const matchDate = match.kickoffTime.toISOString().slice(0, 10);

    // Try to find a matching fixture in the API response
    const found = rawFixtures.find((f) => {
      const teams = extractTeamNames(f);
      if (!teams) return false;
      const dateMatch = extractFixtureDate(f) === matchDate;
      return dateMatch && teamMatch(match.homeTeam, teams.home) && teamMatch(match.awayTeam, teams.away);
    });

    if (found) {
      const fixId = extractFixtureStringId(found);
      if (!fixId) continue;
      await db.insert(oddspapiFixtureMapTable).values({
        matchId: match.id,
        oddspapiFixtureId: fixId,
        cachedAt: new Date(),
      });

      logger.info(
        { matchId: match.id, oddspapiFixtureId: fixId, home: match.homeTeam, away: match.awayTeam },
        "OddsPapi fixture mapped",
      );

      mapped++;
      newMappings++;
    }
  }

  await db.insert(complianceLogsTable).values({
    actionType: "oddspapi_fixture_mapping",
    details: { total: rawFixtures.length, dbMatches: upcoming.length, mapped, newMappings },
    timestamp: new Date(),
  });

  logger.info({ total: rawFixtures.length, mapped, newMappings }, "OddsPapi fixture mapping complete");
  return { total: rawFixtures.length, mapped, newMappings };
}

// ─── OddsPapi odds response parsing ──────────────────────────────────────────
//
// Actual OddsPapi v4 /odds response (discovered by inspecting live data):
//
//   {
//     fixtureId: "id...",
//     hasOdds: true,
//     bookmakerOdds: {                       ← OBJECT keyed by bookmaker slug
//       "pinnacle": {
//         bookmakerIsActive: true,
//         suspended: false,
//         markets: {                         ← OBJECT keyed by numeric market ID
//           "101": {                         ← 1x2 Match Winner
//             marketActive: true,
//             outcomes: {                    ← OBJECT keyed by outcome ID
//               "101": {
//                 players: {
//                   "0": {
//                     bookmakerOutcomeId: "home",   ← "home"/"draw"/"away" for 1x2
//                     price: 2.41,                  ← decimal odds
//                     active: true,
//                   }
//                 }
//               }
//             }
//           },
//           "1010": { ... }                  ← O/U 2.5 goals; outcomeId = "2.5/over"
//           "1012": { ... }                  ← O/U 3.5; outcomeId = "3.5/over"
//           "10807": { ... }                 ← Corners O/U 10.5; outcomeId = "10.5/over"
//         }
//       }
//     }
//   }
//
// The bookmakerOutcomeId for lines markets encodes BOTH the line and direction:
//   "2.5/over", "9.5/under", "10.5/over", "-1.0/home", etc.

interface RawPlayerOdds {
  active?: boolean;
  bookmakerOutcomeId?: string | number;
  price?: number;
  mainLine?: boolean;
}

interface RawOutcome {
  players?: Record<string, RawPlayerOdds>;
}

interface RawMarket {
  bookmakerMarketId?: string;
  marketActive?: boolean;
  outcomes?: Record<string, RawOutcome>;
}

interface RawBookmakerOdds {
  bookmakerSlug?: string;
  bookmakerName?: string;
  bookmakerIsActive?: boolean;
  suspended?: boolean;
  // New format: Record<marketId, RawMarket>
  markets?: Record<string, RawMarket> | Array<{ selections?: RawOddsSelection[] }>;
  // Legacy fields (old array-format APIs)
  bookmaker?: string;
  slug?: string;
  name?: string;
  odds?: RawOddsSelection[];
  selections?: RawOddsSelection[];
}

interface RawOddsSelection {
  selection?: string;
  label?: string;
  name?: string;
  outcome?: string;
  odds?: number;
  value?: number;
  price?: number;
  line?: string | number;
  handicap?: string | number;
}

interface RawOddsResponse {
  // New format: object keyed by bookmaker slug
  bookmakerOdds?: Record<string, Omit<RawBookmakerOdds, "bookmakerSlug" | "bookmakerName">> | RawBookmakerOdds[];
  // Legacy array formats
  bookmakers?: RawBookmakerOdds[];
  odds?: RawBookmakerOdds[];
}

export interface OddspapiValidation {
  pinnacleOdds: number | null;
  pinnacleImplied: number | null;
  bestOdds: number | null;
  bestBookmaker: string | null;
  oddsUpliftPct: number | null;
  sharpSoftSpread: number | null;
  consensusPct: number | null;
  isContrarian: boolean;
  pinnacleAligned: boolean;
  hasPinnacleData: boolean;
}

function getSelectionOdds(
  selections: RawOddsSelection[],
  marketType: string,
  selectionName: string,
): number | null {
  const ouLine = OU_LINES[marketType];
  const selLower = selectionName.toLowerCase();

  for (const sel of selections) {
    const label = (sel.selection ?? sel.label ?? sel.name ?? sel.outcome ?? "").toLowerCase();
    const odds = sel.odds ?? sel.value ?? sel.price;
    if (!odds || odds <= 1) continue;
    const legacyLine = String(sel.line ?? sel.handicap ?? "");

    // ── New OddsPapi format: bookmakerOutcomeId encodes line+direction ──
    // e.g. "home", "draw", "away", "2.5/over", "9.5/under", "10.5/over"
    if (label.includes("/")) {
      const slashIdx = label.lastIndexOf("/");
      const linePart = label.slice(0, slashIdx);
      const dirPart = label.slice(slashIdx + 1);

      // Match Winner with Asian handicap labels like "-1.0/home" — skip for MATCH_ODDS
      if ((dirPart === "home" || dirPart === "away") && marketType === "MATCH_ODDS") {
        continue;
      }

      // Over/Under: "2.5/over", "9.5/under", "10.5/over" etc.
      if ((dirPart === "over" || dirPart === "under") && ouLine) {
        if (Math.abs(parseFloat(linePart) - parseFloat(ouLine)) < 0.01) {
          if (selLower.includes("over") && dirPart === "over") return odds;
          if (selLower.includes("under") && dirPart === "under") return odds;
        }
      }
      continue; // handled slash-format; don't fall through to legacy logic
    }

    // ── Match Winner (label: "home", "draw", "away" or legacy "1", "x", "2") ──
    if (marketType === "MATCH_ODDS") {
      if (selectionName === "Home" && (label === "home" || label === "1")) return odds;
      if (selectionName === "Draw" && (label === "draw" || label === "x")) return odds;
      if (selectionName === "Away" && (label === "away" || label === "2")) return odds;
    }

    // ── BTTS ──
    if (marketType === "BTTS") {
      if (selectionName === "Yes" && (label === "yes" || label === "gg")) return odds;
      if (selectionName === "No" && (label === "no" || label === "ng")) return odds;
    }

    // ── Legacy array-format Over/Under (label: "over 2.5", "under", etc.) ──
    if (ouLine && (label.includes("over") || label.includes("under"))) {
      if (!legacyLine || legacyLine === ouLine || legacyLine === `${ouLine}`) {
        if (selLower.includes("over") && label.includes("over")) return odds;
        if (selLower.includes("under") && label.includes("under")) return odds;
      }
    }
  }
  return null;
}

function extractSelections(bm: RawBookmakerOdds): RawOddsSelection[] {
  const markets = bm.markets;

  // ── New OddsPapi format: markets is Record<marketId, RawMarket> ──
  if (markets && !Array.isArray(markets) && typeof markets === "object") {
    const result: RawOddsSelection[] = [];
    for (const market of Object.values(markets as Record<string, RawMarket>)) {
      if (!market?.outcomes) continue;
      for (const outcome of Object.values(market.outcomes)) {
        for (const player of Object.values(outcome.players ?? {})) {
          if (player.active === false) continue;
          if (!player.price || player.price <= 1) continue;
          result.push({
            label: String(player.bookmakerOutcomeId ?? ""),
            price: player.price,
          });
        }
      }
    }
    return result;
  }

  // ── Legacy formats ──
  if (Array.isArray(markets)) {
    return (markets as Array<{ selections?: RawOddsSelection[] }>).flatMap((m) => m.selections ?? []);
  }
  if (Array.isArray(bm.odds)) return bm.odds;
  if (Array.isArray(bm.selections)) return bm.selections;
  return [];
}

function getBookmakerSlug(bm: RawBookmakerOdds): string {
  return (bm.bookmakerSlug ?? bm.slug ?? bm.bookmaker ?? bm.bookmakerName ?? bm.name ?? "").toLowerCase();
}

function getBookmakerName(bm: RawBookmakerOdds): string {
  const raw = bm.bookmakerName ?? bm.name ?? bm.bookmakerSlug ?? bm.slug ?? bm.bookmaker ?? "Unknown";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function extractBookmakers(raw: RawOddsResponse): RawBookmakerOdds[] {
  const bOdds = raw.bookmakerOdds;

  // ── New OddsPapi format: bookmakerOdds is object keyed by bookmaker slug ──
  if (bOdds && !Array.isArray(bOdds) && typeof bOdds === "object") {
    return Object.entries(bOdds as Record<string, RawBookmakerOdds>).map(([slug, data]) => ({
      ...data,
      bookmakerSlug: slug,
      bookmakerName: slug.charAt(0).toUpperCase() + slug.slice(1),
    }));
  }

  // ── Legacy array formats ──
  if (Array.isArray(bOdds)) return bOdds;
  if (Array.isArray(raw.bookmakers)) return raw.bookmakers;
  if (Array.isArray(raw.odds)) return raw.odds;
  return [];
}

// ─── 2. Odds validation (up to 5 requests/day per trading cycle) ──────────────

export async function getOddspapiValidation(
  oddspapiFixtureId: string,
  marketType: string,
  selectionName: string,
  apiFootballOdds: number,
): Promise<OddspapiValidation> {
  const noData: OddspapiValidation = {
    pinnacleOdds: null,
    pinnacleImplied: null,
    bestOdds: null,
    bestBookmaker: null,
    oddsUpliftPct: null,
    sharpSoftSpread: null,
    consensusPct: null,
    isContrarian: false,
    pinnacleAligned: false,
    hasPinnacleData: false,
  };

  // The /odds endpoint returns ALL markets regardless of marketId; default to 101 (1x2)
  const marketId = MARKET_IDS[marketType] ?? 101;

  if (!(await canMakeOddspapiRequest(1))) return noData;

  const rawData = await fetchOddsPapi<RawOddsResponse>(
    "/odds",
    { fixtureId: oddspapiFixtureId, marketId },
    "odds",
  );

  if (!rawData) return noData;

  const bookmakers = extractBookmakers(rawData as RawOddsResponse);
  if (!bookmakers.length) {
    logger.debug({ oddspapiFixtureId, marketType }, "No bookmakers in OddsPapi odds response");
    return noData;
  }

  let pinnacleOdds: number | null = null;
  let bestOdds: number | null = null;
  let bestBookmakerName: string | null = null;

  const sharpOddsArr: number[] = [];
  const softOddsArr: number[] = [];
  let bullishCount = 0;
  let totalBookmakers = 0;

  for (const bm of bookmakers) {
    const slug = getBookmakerSlug(bm);
    const name = getBookmakerName(bm);
    const selections = extractSelections(bm);
    const odds = getSelectionOdds(selections, marketType, selectionName);
    if (!odds) continue;

    totalBookmakers++;
    const implied = 1 / odds;

    // Track Pinnacle separately
    if (slug.includes("pinnacle")) {
      pinnacleOdds = odds;
    }

    // Best available odds
    if (!bestOdds || odds > bestOdds) {
      bestOdds = odds;
      bestBookmakerName = name;
    }

    // Sharp vs soft spread
    if (SHARP_SLUGS.has(slug)) sharpOddsArr.push(implied);
    if (SOFT_SLUGS.has(slug)) softOddsArr.push(implied);

    // Consensus: bookmakers that consider our selection likely (implied > 50%)
    if (implied > 0.5) bullishCount++;
  }

  const pinnacleImplied = pinnacleOdds ? 1 / pinnacleOdds : null;
  const oddsUpliftPct =
    bestOdds && apiFootballOdds > 1
      ? ((bestOdds - apiFootballOdds) / apiFootballOdds) * 100
      : null;

  const sharpAvg = sharpOddsArr.length ? sharpOddsArr.reduce((a, b) => a + b, 0) / sharpOddsArr.length : null;
  const softAvg = softOddsArr.length ? softOddsArr.reduce((a, b) => a + b, 0) / softOddsArr.length : null;
  const sharpSoftSpread = sharpAvg !== null && softAvg !== null ? softAvg - sharpAvg : null;
  const consensusPct = totalBookmakers > 0 ? (bullishCount / totalBookmakers) * 100 : null;

  // Pinnacle alignment: compare Pinnacle implied vs our model's direction
  // (Pinnacle implied < 0.5 means Pinnacle favours the AWAY; our selection being HOME means contrarian)
  // This is evaluated relative to the model probability in the enhanced scoring function.
  const hasPinnacleData = pinnacleOdds !== null;

  return {
    pinnacleOdds,
    pinnacleImplied,
    bestOdds,
    bestBookmaker: bestBookmakerName,
    oddsUpliftPct,
    sharpSoftSpread,
    consensusPct,
    isContrarian: false, // computed against modelProbability in enhanced scoring
    pinnacleAligned: false, // computed in enhanced scoring
    hasPinnacleData,
  };
}

// ─── Get cached OddsPapi fixture ID for a match ───────────────────────────────

export async function getOddspapiFixtureId(matchId: number): Promise<string | null> {
  const row = await db
    .select({ oddspapiFixtureId: oddspapiFixtureMapTable.oddspapiFixtureId })
    .from(oddspapiFixtureMapTable)
    .where(eq(oddspapiFixtureMapTable.matchId, matchId))
    .limit(1);
  return row[0]?.oddspapiFixtureId ?? null;
}

// ─── Pre-fetch OddsPapi odds into odds_snapshots for value detection ─────────
// Called once per trading cycle BEFORE detectValueBets(). Stores real market
// odds as source="oddspapi" so value detection treats them as non-synthetic.
// Returns a validation cache keyed by matchId to avoid re-fetching later.

// Cache is keyed by matchId → flat map of selectionName → validation.
// Selection names are unique across all market types we bet on:
//   MATCH_ODDS:        "Home", "Draw", "Away"
//   OVER_UNDER_*:      "Over 2.5", "Under 2.5", "Over 3.5", "Under 3.5", …
//   TOTAL_CORNERS_*:   "Over 9.5 Corners", "Under 10.5 Corners", …
//   BTTS:              "Yes", "No"
//   DOUBLE_CHANCE:     "1X", "X2", "12"
export type OddsPapiValidationCache = Map<number, Record<string, OddspapiValidation>>;

// All bet-relevant targets we extract from every OddsPapi odds response.
// One API call returns all markets, so we pull everything at once.
const PREFETCH_TARGETS: Array<{ marketType: string; selectionName: string }> = [
  // Match Winner (1x2)
  { marketType: "MATCH_ODDS",       selectionName: "Home" },
  { marketType: "MATCH_ODDS",       selectionName: "Draw" },
  { marketType: "MATCH_ODDS",       selectionName: "Away" },
  // Goals O/U
  { marketType: "OVER_UNDER_25",    selectionName: "Over 2.5" },
  { marketType: "OVER_UNDER_25",    selectionName: "Under 2.5" },
  { marketType: "OVER_UNDER_35",    selectionName: "Over 3.5" },
  { marketType: "OVER_UNDER_35",    selectionName: "Under 3.5" },
  { marketType: "OVER_UNDER_45",    selectionName: "Over 4.5" },
  { marketType: "OVER_UNDER_45",    selectionName: "Under 4.5" },
  // Corners O/U
  { marketType: "TOTAL_CORNERS_75",  selectionName: "Over 7.5 Corners" },
  { marketType: "TOTAL_CORNERS_75",  selectionName: "Under 7.5 Corners" },
  { marketType: "TOTAL_CORNERS_85",  selectionName: "Over 8.5 Corners" },
  { marketType: "TOTAL_CORNERS_85",  selectionName: "Under 8.5 Corners" },
  { marketType: "TOTAL_CORNERS_95",  selectionName: "Over 9.5 Corners" },
  { marketType: "TOTAL_CORNERS_95",  selectionName: "Under 9.5 Corners" },
  { marketType: "TOTAL_CORNERS_105", selectionName: "Over 10.5 Corners" },
  { marketType: "TOTAL_CORNERS_105", selectionName: "Under 10.5 Corners" },
  { marketType: "TOTAL_CORNERS_115", selectionName: "Over 11.5 Corners" },
  { marketType: "TOTAL_CORNERS_115", selectionName: "Under 11.5 Corners" },
  // BTTS
  { marketType: "BTTS",              selectionName: "Yes" },
  { marketType: "BTTS",              selectionName: "No" },
];

export async function prefetchAndStoreOddsPapiOdds(
  earliestKickoff: Date,
  latestKickoff: Date,
  maxFetches = 4,
): Promise<OddsPapiValidationCache> {
  const cache: OddsPapiValidationCache = new Map();

  const key = process.env.ODDSPAPI_KEY;
  if (!key) return cache;

  // Check remaining daily budget — reserve 10 requests for closing-line CLV fetches
  const [daily, effectiveCap] = await Promise.all([getOddspapiUsageToday(), getEffectiveDailyCap()]);
  const remaining = effectiveCap - daily;
  if (remaining <= 10) {
    logger.info({ daily, cap: effectiveCap }, "OddsPapi budget nearly exhausted — skipping pre-fetch, reserving for CLV");
    return cache;
  }

  // Use all remaining budget minus CLV reserve, capped by caller limit
  const limit = Math.min(maxFetches, remaining - 10);

  // Dynamic league scoring: load edge scores from DB and coverage cache
  // Higher edge_score = less-scrutinised league = better OddsPapi budget allocation
  const [edgeRows, coverageRows] = await Promise.all([
    db
      .select({ league: leagueEdgeScoresTable.league, confidenceScore: leagueEdgeScoresTable.confidenceScore })
      .from(leagueEdgeScoresTable),
    db
      .select({ league: oddspapiLeagueCoverageTable.league, hasOdds: oddspapiLeagueCoverageTable.hasOdds, lastChecked: oddspapiLeagueCoverageTable.lastChecked })
      .from(oddspapiLeagueCoverageTable),
  ]);

  const edgeScoreMap = new Map(edgeRows.map((r) => [r.league, r.confidenceScore]));
  // If a league is marked hasOdds=0 and was checked in the last 6h, skip it
  const coverageMap = new Map(coverageRows.map((r) => [r.league, r]));

  // Fetch all mapped matches in the window
  const allRows = await db
    .select({
      matchId: oddspapiFixtureMapTable.matchId,
      fixtureId: oddspapiFixtureMapTable.oddspapiFixtureId,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      league: matchesTable.league,
      kickoffTime: matchesTable.kickoffTime,
    })
    .from(oddspapiFixtureMapTable)
    .innerJoin(matchesTable, eq(oddspapiFixtureMapTable.matchId, matchesTable.id))
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, earliestKickoff),
        lte(matchesTable.kickoffTime, latestKickoff),
      ),
    );

  // Leagues with no Pinnacle coverage: retry once per week (7 days) in case coverage changed
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Sort: highest league_edge_score first (dynamic); ties broken by earliest kickoff
  const mappedRows = allRows
    .filter((r) => {
      const cov = coverageMap.get(r.league ?? "");
      if (!cov) return true; // unknown — try it
      if (cov.hasOdds === 1) return true; // known good
      // hasOdds=0: retry once per week to catch new league coverage
      return cov.lastChecked < sevenDaysAgo;
    })
    .sort((a, b) => {
      const sa = edgeScoreMap.get(a.league ?? "") ?? 50;
      const sb = edgeScoreMap.get(b.league ?? "") ?? 50;
      if (sa !== sb) return sb - sa; // higher edge score first
      return (a.kickoffTime?.getTime() ?? 0) - (b.kickoffTime?.getTime() ?? 0);
    })
    .slice(0, limit); // limit = remaining budget minus CLV reserve

  if (mappedRows.length === 0) return cache;

  logger.info({ count: mappedRows.length, limit }, "Pre-fetching OddsPapi Match Odds for value detection");

  for (let i = 0; i < mappedRows.length; i++) {
    const row = mappedRows[i];
    if (!row) break;
    const { matchId, fixtureId, homeTeam, awayTeam } = row;

    // Use MATCH_ODDS market ID — but OddsPapi returns ALL markets regardless.
    // One call per fixture gives us 1x2, goals O/U, corners O/U, BTTS, etc.
    const marketId = MARKET_IDS["MATCH_ODDS"] ?? 101;
    if (!(await canMakeOddspapiRequest(1))) break;

    // Rate-limit guard: OddsPapi enforces ~1 req/s — wait between calls
    if (i > 0) await new Promise((r) => setTimeout(r, 1200));

    const rawData = await fetchOddsPapi<RawOddsResponse>(
      "/odds",
      { fixtureId, marketId },
      "prefetch_odds",
    );

    if (!rawData) continue;

    const bookmakers = extractBookmakers(rawData as RawOddsResponse);
    if (!bookmakers.length) {
      // Record that this league has no OddsPapi coverage so we stop wasting budget on it
      const league = row.league ?? "";
      if (league) {
        await db
          .insert(oddspapiLeagueCoverageTable)
          .values({ league, hasOdds: 0, lastChecked: new Date() })
          .onConflictDoUpdate({
            target: oddspapiLeagueCoverageTable.league,
            set: { hasOdds: 0, lastChecked: new Date() },
          });
        logger.info({ league }, "OddsPapi: no bookmakers for league — marked as no-coverage");
      }
      continue;
    }

    // Mark this league as having OddsPapi coverage
    const leagueForCov = row.league ?? "";
    if (leagueForCov) {
      await db
        .insert(oddspapiLeagueCoverageTable)
        .values({ league: leagueForCov, hasOdds: 1, lastChecked: new Date() })
        .onConflictDoUpdate({
          target: oddspapiLeagueCoverageTable.league,
          set: { hasOdds: 1, lastChecked: new Date() },
        });
    }

    // ── Extract ALL bet-relevant selections from this single API response ──
    // Each bookmaker's selections are pre-flattened from the nested markets structure.
    // PREFETCH_TARGETS covers 1x2, goals O/U, corners O/U, and BTTS.
    type SelectionAgg = { best: number; bookmaker: string; pinnacle: number | null; sharp: number[]; soft: number[] };
    const selectionOdds: Record<string, SelectionAgg> = {};

    for (const target of PREFETCH_TARGETS) {
      selectionOdds[target.selectionName] = { best: 0, bookmaker: "", pinnacle: null, sharp: [], soft: [] };
    }

    for (const bm of bookmakers) {
      const slug = getBookmakerSlug(bm);
      const name = getBookmakerName(bm);
      const bmSelections = extractSelections(bm);

      for (const { marketType, selectionName } of PREFETCH_TARGETS) {
        const odds = getSelectionOdds(bmSelections, marketType, selectionName);
        if (!odds) continue;

        const so = selectionOdds[selectionName];
        if (!so) continue;
        const implied = 1 / odds;

        if (slug.includes("pinnacle")) so.pinnacle = odds;
        if (odds > so.best) { so.best = odds; so.bookmaker = name; }
        if (SHARP_SLUGS.has(slug)) so.sharp.push(implied);
        if (SOFT_SLUGS.has(slug)) so.soft.push(implied);
      }
    }

    // ── Build flat matchCache: selectionName → OddspapiValidation ──
    const now = new Date();
    const matchCache: Record<string, OddspapiValidation> = {};

    // Track which selections we actually got Pinnacle odds for
    let pinnacleSelectionsFound = 0;

    for (const [selName, so] of Object.entries(selectionOdds)) {
      if (so.best <= 1.01) continue;

      const pinnacleImplied = so.pinnacle ? 1 / so.pinnacle : null;
      const sharpAvg = so.sharp.length ? so.sharp.reduce((a, b) => a + b, 0) / so.sharp.length : null;
      const softAvg = so.soft.length ? so.soft.reduce((a, b) => a + b, 0) / so.soft.length : null;

      if (so.pinnacle) pinnacleSelectionsFound++;

      const validation: OddspapiValidation = {
        pinnacleOdds: so.pinnacle,
        pinnacleImplied,
        bestOdds: so.best,
        bestBookmaker: so.bookmaker || null,
        oddsUpliftPct: null,
        sharpSoftSpread: sharpAvg !== null && softAvg !== null ? softAvg - sharpAvg : null,
        consensusPct: null,
        isContrarian: false,
        pinnacleAligned: false,
        hasPinnacleData: so.pinnacle !== null,
      };

      matchCache[selName] = validation;

      // Determine the correct market type for this selection name
      const targetMeta = PREFETCH_TARGETS.find((t) => t.selectionName === selName);
      const marketTypeForSnapshot = targetMeta?.marketType ?? "MATCH_ODDS";

      // Upsert into odds_snapshots (delete old oddspapi snapshot first)
      await db
        .delete(oddsSnapshotsTable)
        .where(
          and(
            eq(oddsSnapshotsTable.matchId, matchId),
            eq(oddsSnapshotsTable.marketType, marketTypeForSnapshot),
            eq(oddsSnapshotsTable.selectionName, selName),
            eq(oddsSnapshotsTable.source, "oddspapi"),
          ),
        );

      await db.insert(oddsSnapshotsTable).values({
        matchId,
        marketType: marketTypeForSnapshot,
        selectionName: selName,
        backOdds: String(so.best),
        layOdds: null,
        snapshotTime: now,
        source: "oddspapi",
      });
    }

    if (Object.keys(matchCache).length > 0) {
      cache.set(matchId, matchCache);
      logger.info(
        {
          matchId,
          home: homeTeam,
          away: awayTeam,
          totalSelections: Object.keys(matchCache).length,
          pinnacleSelections: pinnacleSelectionsFound,
          markets: [...new Set(PREFETCH_TARGETS.filter(t => matchCache[t.selectionName]).map(t => t.marketType))],
        },
        "OddsPapi multi-market pre-fetch complete",
      );
    }
  }

  logger.info({ fetched: cache.size }, "OddsPapi pre-fetch complete");
  return cache;
}

// ─── Log daily budget usage summary ──────────────────────────────────────────

export async function logDailyBudgetSummary(): Promise<void> {
  const [today, month] = await Promise.all([
    getOddspapiUsageToday(),
    getOddspapiUsageThisMonth(),
  ]);

  await db.insert(complianceLogsTable).values({
    actionType: "oddspapi_daily_budget_summary",
    details: { today, month, dailyCap: DAILY_CAP, monthlyCap: MONTHLY_CAP },
    timestamp: new Date(),
  });

  if (month >= 4000) {
    await db.insert(learningNarrativesTable).values({
      narrativeType: "budget_alert",
      narrativeText: `OddsPapi monthly usage at ${month}/${MONTHLY_CAP} requests. Approaching limit — sharp-line validation will be throttled to protect remaining budget.`,
      relatedData: { today, month, dailyCap: DAILY_CAP, monthlyCap: MONTHLY_CAP },
      createdAt: new Date(),
    });
  }

  logger.info({ today, month, dailyCap: DAILY_CAP, monthlyCap: MONTHLY_CAP }, "OddsPapi daily budget summary logged");
}

// ─── Closing-line CLV fetch ───────────────────────────────────────────────────
// Called by the pre-kickoff cron every 30 min.
// For each pending bet kicking off in the next 90 minutes, fetch the current
// Pinnacle odds as the TRUE closing line and store it in closing_pinnacle_odds.
// This enables professional-grade CLV: (placement_odds - closing_odds) / closing_odds × 100.

export async function fetchAndStoreClosingLineForPendingBets(): Promise<{
  checked: number;
  updated: number;
  skipped: number;
}> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return { checked: 0, updated: 0, skipped: 0 };

  const now = new Date();
  const in90min = new Date(now.getTime() + 90 * 60 * 1000);

  // Find pending bets for fixtures kicking off in the next 90 minutes
  // that don't already have a closing line stored
  const pendingBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      oddsAtPlacement: paperBetsTable.oddsAtPlacement,
      closingPinnacleOdds: paperBetsTable.closingPinnacleOdds,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        sql`${matchesTable.kickoffTime} >= ${now}`,
        sql`${matchesTable.kickoffTime} <= ${in90min}`,
        sql`${paperBetsTable.closingPinnacleOdds} IS NULL`,
      ),
    );

  if (pendingBets.length === 0) {
    logger.debug("Pre-kickoff CLV cron: no pending bets kicking off in next 90min");
    return { checked: 0, updated: 0, skipped: 0 };
  }

  logger.info({ count: pendingBets.length }, "Pre-kickoff CLV cron: fetching Pinnacle closing odds");

  let updated = 0;
  let skipped = 0;

  // Group by matchId to deduplicate OddsPapi requests (one request per fixture per market)
  const byMatch = new Map<number, typeof pendingBets>();
  for (const bet of pendingBets) {
    const group = byMatch.get(bet.matchId) ?? [];
    group.push(bet);
    byMatch.set(bet.matchId, group);
  }

  for (const [matchId, bets] of byMatch) {
    const oddspapiId = await getOddspapiFixtureId(matchId);
    if (!oddspapiId) {
      skipped += bets.length;
      continue;
    }

    // Fetch MATCH_ODDS closing line (covers Home/Draw/Away bets)
    const matchOddsMarket = bets.some((b) => b.marketType === "MATCH_ODDS") ? "MATCH_ODDS" : bets[0]?.marketType;
    if (!matchOddsMarket) { skipped += bets.length; continue; }

    if (!(await canMakeOddspapiRequest(1))) {
      logger.warn("Pre-kickoff CLV cron: daily budget exhausted — stopping");
      skipped += bets.length;
      break;
    }

    const marketId = MARKET_IDS[matchOddsMarket] ?? 101;

    // Rate-limit guard
    await new Promise((r) => setTimeout(r, 1200));

    const rawData = await fetchOddsPapi<RawOddsResponse>(
      "/odds",
      { fixtureId: oddspapiId, marketId },
      "closing_line",
    );

    if (!rawData) { skipped += bets.length; continue; }

    const bookmakers = extractBookmakers(rawData as RawOddsResponse);
    if (!bookmakers.length) { skipped += bets.length; continue; }

    // Extract Pinnacle odds for each selection
    const pinnacleBySelection: Record<string, number | null> = {};
    for (const bm of bookmakers) {
      const slug = getBookmakerSlug(bm);
      if (!slug.includes("pinnacle")) continue;
      const selections = extractSelections(bm);
      for (const selName of ["Home", "Draw", "Away", "Yes", "No", "Over", "Under"]) {
        const odds = getSelectionOdds(selections, matchOddsMarket, selName);
        if (odds) pinnacleBySelection[selName] = odds;
      }
    }

    // Store closing odds for each matching bet and compute CLV
    for (const bet of bets) {
      const closingOdds = pinnacleBySelection[bet.selectionName] ?? null;
      if (!closingOdds) { skipped++; continue; }

      const placementOdds = Number(bet.oddsAtPlacement);
      const clvPct = closingOdds > 1
        ? Math.round(((placementOdds - closingOdds) / closingOdds) * 100 * 1000) / 1000
        : null;

      await db
        .update(paperBetsTable)
        .set({
          closingPinnacleOdds: String(closingOdds),
          ...(clvPct != null ? { clvPct: String(clvPct) } : {}),
        })
        .where(eq(paperBetsTable.id, bet.id));

      logger.info(
        { betId: bet.id, matchId, selection: bet.selectionName, placementOdds, closingOdds, clvPct },
        "Pre-kickoff CLV stored (Pinnacle closing line)",
      );
      updated++;
    }
  }

  logger.info({ checked: pendingBets.length, updated, skipped }, "Pre-kickoff CLV cron complete");
  return { checked: pendingBets.length, updated, skipped };
}

// ─── Build Pinnacle validation cache from API-Football Pinnacle odds ──────────
// OddsPapi fixture mapping often has no bookmaker data for our leagues, but
// API-Football already pulls Pinnacle's odds as one of the bookmakers included
// in /odds responses (source = "api_football_real:Pinnacle").
// This function builds the same OddsPapiValidationCache from that data source
// so the trading cycle gets full Pinnacle alignment scoring even when OddsPapi
// itself has no coverage.

export async function buildPinnacleValidationFromApiFootball(
  earliestKickoff: Date,
  latestKickoff: Date,
): Promise<OddsPapiValidationCache> {
  const cache: OddsPapiValidationCache = new Map();

  // Markets we bet on — fetch Pinnacle and all-bookmaker odds for these.
  // Exclude ASIAN_HANDICAP (huge volume, not bet) and FIRST_HALF_ markets (rarely used).
  const RELEVANT_MARKETS = [
    "MATCH_ODDS",
    "OVER_UNDER_25", "OVER_UNDER_35", "OVER_UNDER_45",
    "TOTAL_CORNERS_75", "TOTAL_CORNERS_85", "TOTAL_CORNERS_95",
    "TOTAL_CORNERS_105", "TOTAL_CORNERS_115",
    "DOUBLE_CHANCE", "BTTS",
  ];

  // Fetch all relevant market snapshots for upcoming matches in the window.
  // Pinnacle provides odds for all these markets via API-Football.
  const rows = await db
    .select({
      matchId: oddsSnapshotsTable.matchId,
      marketType: oddsSnapshotsTable.marketType,
      selectionName: oddsSnapshotsTable.selectionName,
      source: oddsSnapshotsTable.source,
      backOdds: oddsSnapshotsTable.backOdds,
    })
    .from(oddsSnapshotsTable)
    .innerJoin(matchesTable, eq(oddsSnapshotsTable.matchId, matchesTable.id))
    .where(
      and(
        like(oddsSnapshotsTable.source, "api_football_real%"),
        inArray(oddsSnapshotsTable.marketType, RELEVANT_MARKETS),
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, earliestKickoff),
        lte(matchesTable.kickoffTime, latestKickoff),
      ),
    );

  if (rows.length === 0) return cache;

  // Group by matchId → selectionName → { pinnacle, best, bestBookmaker }
  type SelData = { pinnacle: number | null; best: number; bestBookmaker: string };
  const matchMap = new Map<number, Map<string, SelData>>();

  for (const row of rows) {
    const odds = parseFloat(row.backOdds ?? "0");
    if (!odds || odds <= 1.01) continue;

    const mid = row.matchId;
    if (!matchMap.has(mid)) matchMap.set(mid, new Map());
    const selMap = matchMap.get(mid)!;

    if (!selMap.has(row.selectionName)) {
      selMap.set(row.selectionName, { pinnacle: null, best: 0, bestBookmaker: "" });
    }
    const sel = selMap.get(row.selectionName)!;

    // Track Pinnacle odds
    if (row.source === "api_football_real:Pinnacle") {
      sel.pinnacle = odds;
    }

    // Track best odds across all bookmakers
    if (odds > sel.best) {
      sel.best = odds;
      sel.bestBookmaker = row.source.replace("api_football_real:", "");
    }
  }

  // Build cache entries for matches that have Pinnacle data for at least one selection
  let matchesWithPinnacle = 0;
  for (const [matchId, selMap] of matchMap.entries()) {
    const hasPinnacle = [...selMap.values()].some((s) => s.pinnacle !== null);
    if (!hasPinnacle) continue;

    const matchCache: Record<string, OddspapiValidation> = {};

    for (const [selName, sd] of selMap.entries()) {
      if (sd.best <= 1.01) continue;
      const pinnacleImplied = sd.pinnacle ? 1 / sd.pinnacle : null;

      matchCache[selName] = {
        pinnacleOdds: sd.pinnacle,
        pinnacleImplied,
        bestOdds: sd.best,
        bestBookmaker: sd.bestBookmaker || null,
        oddsUpliftPct: null,
        sharpSoftSpread: null,
        consensusPct: null,
        isContrarian: false,
        pinnacleAligned: false,
        hasPinnacleData: sd.pinnacle !== null,
      };
    }

    if (Object.keys(matchCache).length > 0) {
      cache.set(matchId, matchCache);
      matchesWithPinnacle++;
    }
  }

  logger.info(
    { matchesWithPinnacle, totalMatches: matchMap.size },
    "Built Pinnacle validation cache from API-Football Pinnacle data",
  );

  return cache;
}
