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
import { eq, and, gte, lte, sql, like, inArray } from "drizzle-orm";
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

  const rawFixtures = await fetchOddsPapi<RawFixture[]>("/fixtures", {
    sportId: 10,
    from: todayDate,
    to: plusFour,
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

interface RawBookmakerOdds {
  bookmakerSlug?: string;
  bookmaker?: string;
  slug?: string;
  name?: string;
  bookmakerName?: string;
  odds?: RawOddsSelection[];
  selections?: RawOddsSelection[];
  markets?: Array<{ selections?: RawOddsSelection[] }>;
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
  bookmakerOdds?: RawBookmakerOdds[];
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

  for (const sel of selections) {
    const label = (sel.selection ?? sel.label ?? sel.name ?? sel.outcome ?? "").toLowerCase();
    const odds = sel.odds ?? sel.value ?? sel.price;
    if (!odds || odds <= 1) continue;
    const line = String(sel.line ?? sel.handicap ?? "");

    // Match Winner (market 101)
    if (marketType === "MATCH_ODDS") {
      if (selectionName === "Home" && (label === "1" || label === "home" || label === "1x" && false)) return odds;
      if (selectionName === "Draw" && (label === "x" || label === "draw")) return odds;
      if (selectionName === "Away" && (label === "2" || label === "away")) return odds;
    }

    // Over/Under markets
    if (ouLine && (label.includes("over") || label.includes("under"))) {
      if (!line || line === ouLine || line === `${ouLine}`) {
        if (selectionName.toLowerCase().includes("over") && label.includes("over")) return odds;
        if (selectionName.toLowerCase().includes("under") && label.includes("under")) return odds;
      }
    }

    // BTTS
    if (marketType === "BTTS") {
      if (selectionName === "Yes" && (label === "yes" || label === "gg")) return odds;
      if (selectionName === "No" && (label === "no" || label === "ng")) return odds;
    }

    // Cards/Corners (generic over/under)
    if ((marketType.startsWith("TOTAL_CARDS") || marketType.startsWith("TOTAL_CORNERS")) && ouLine) {
      if (!line || line === ouLine || line === `${ouLine}`) {
        if (selectionName.toLowerCase().includes("over") && label.includes("over")) return odds;
        if (selectionName.toLowerCase().includes("under") && label.includes("under")) return odds;
      }
    }
  }
  return null;
}

function extractSelections(bm: RawBookmakerOdds): RawOddsSelection[] {
  if (Array.isArray(bm.odds)) return bm.odds;
  if (Array.isArray(bm.selections)) return bm.selections;
  if (Array.isArray(bm.markets)) {
    return bm.markets.flatMap((m) => m.selections ?? []);
  }
  return [];
}

function getBookmakerSlug(bm: RawBookmakerOdds): string {
  return (bm.bookmakerSlug ?? bm.slug ?? bm.bookmaker ?? bm.bookmakerName ?? bm.name ?? "").toLowerCase();
}

function getBookmakerName(bm: RawBookmakerOdds): string {
  return bm.bookmakerName ?? bm.name ?? bm.bookmakerSlug ?? bm.slug ?? "Unknown";
}

function extractBookmakers(raw: RawOddsResponse): RawBookmakerOdds[] {
  if (Array.isArray(raw.bookmakerOdds)) return raw.bookmakerOdds;
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

  const marketId = MARKET_IDS[marketType];
  if (!marketId) return noData;

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

export type OddsPapiValidationCache = Map<
  number,
  { Home: OddspapiValidation; Draw: OddspapiValidation; Away: OddspapiValidation }
>;

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

    const marketId = MARKET_IDS["MATCH_ODDS"];
    if (!marketId || !(await canMakeOddspapiRequest(1))) break;

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

    // Build per-selection best-odds map
    const selectionOdds: Record<string, { best: number; bookmaker: string; pinnacle: number | null; sharp: number[]; soft: number[] }> = {
      Home:  { best: 0, bookmaker: "", pinnacle: null, sharp: [], soft: [] },
      Draw:  { best: 0, bookmaker: "", pinnacle: null, sharp: [], soft: [] },
      Away:  { best: 0, bookmaker: "", pinnacle: null, sharp: [], soft: [] },
    };

    for (const bm of bookmakers) {
      const slug = getBookmakerSlug(bm);
      const name = getBookmakerName(bm);
      const selections = extractSelections(bm);

      for (const selName of ["Home", "Draw", "Away"] as const) {
        const odds = getSelectionOdds(selections, "MATCH_ODDS", selName);
        if (!odds) continue;

        const so = selectionOdds[selName];
        if (!so) continue;
        const implied = 1 / odds;

        if (slug.includes("pinnacle")) so.pinnacle = odds;
        if (odds > so.best) { so.best = odds; so.bookmaker = name; }
        if (SHARP_SLUGS.has(slug)) so.sharp.push(implied);
        if (SOFT_SLUGS.has(slug)) so.soft.push(implied);
      }
    }

    // Store in odds_snapshots and build cache
    const now = new Date();
    const matchCache: { Home: OddspapiValidation; Draw: OddspapiValidation; Away: OddspapiValidation } = {} as any;

    for (const [selName, so] of Object.entries(selectionOdds)) {
      if (so.best <= 1.01) continue;

      const pinnacleImplied = so.pinnacle ? 1 / so.pinnacle : null;
      const sharpAvg = so.sharp.length ? so.sharp.reduce((a, b) => a + b, 0) / so.sharp.length : null;
      const softAvg = so.soft.length ? so.soft.reduce((a, b) => a + b, 0) / so.soft.length : null;

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

      (matchCache as Record<string, OddspapiValidation>)[selName] = validation;

      // Upsert into odds_snapshots (delete old oddspapi snapshot first)
      await db
        .delete(oddsSnapshotsTable)
        .where(
          and(
            eq(oddsSnapshotsTable.matchId, matchId),
            eq(oddsSnapshotsTable.marketType, "MATCH_ODDS"),
            eq(oddsSnapshotsTable.selectionName, selName),
            eq(oddsSnapshotsTable.source, "oddspapi"),
          ),
        );

      await db.insert(oddsSnapshotsTable).values({
        matchId,
        marketType: "MATCH_ODDS",
        selectionName: selName,
        backOdds: String(so.best),
        layOdds: null,
        snapshotTime: now,
        source: "oddspapi",
      });
    }

    if (Object.keys(matchCache).length > 0) {
      cache.set(matchId, matchCache as { Home: OddspapiValidation; Draw: OddspapiValidation; Away: OddspapiValidation });
      logger.info(
        { matchId, home: homeTeam, away: awayTeam, selections: Object.keys(matchCache) },
        "OddsPapi MATCH_ODDS pre-fetched and stored",
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

    const marketId = MARKET_IDS[matchOddsMarket];
    if (!marketId) { skipped += bets.length; continue; }

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
