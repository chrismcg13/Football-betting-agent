/**
 * API-Football v3 Integration
 * Base: https://v3.football.api-sports.io/
 * Upgraded plan: 75,000 requests/day — no rationing needed.
 * Priority: odds (all bookmakers) → fixture stats → team stats
 */

import {
  db,
  matchesTable,
  oddsSnapshotsTable,
  featuresTable,
  complianceLogsTable,
  apiUsageTable,
  oddsHistoryTable,
} from "@workspace/db";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const BASE_URL = "https://v3.football.api-sports.io";
const DAILY_CAP = 75_000;

// ─── Comprehensive league ID mapping ─────────────────────────────────────────
// Tier 1 — Top flights
// Tier 2 — Second divisions (edge_score 82 — less scrutinised)
// Tier 3 — Smaller top flights (edge_score 70)
export const LEAGUE_IDS: Record<string, number> = {
  // Tier 1 — Already active
  "Premier League": 39,
  "Bundesliga": 78,
  "Primera Division": 140,
  "La Liga": 140,
  "Serie A": 135,
  "Ligue 1": 61,
  "Eredivisie": 88,
  "Primeira Liga": 94,
  "Campeonato Brasileiro Série A": 71,
  "Brasileirão": 71,
  "Championship": 40,
  "UEFA Champions League": 2,
  "Champions League": 2,
  "Europa League": 3,
  "UEFA Europa League": 3,

  // Tier 2 — Second divisions (high edge)
  "Ligue 2": 62,
  "2. Bundesliga": 79,
  "Serie B": 136,
  "Segunda División": 141,
  "La Liga 2": 141,
  "Segunda Division": 141,
  "EFL Championship": 40,

  // Tier 3 — Smaller top flights
  "Scottish Premiership": 179,
  "Belgian Pro League": 144,
  "Swiss Super League": 207,
  "Austrian Football Bundesliga": 218,
  "Danish Superliga": 119,
  "Norwegian Eliteserien": 103,
  "Swedish Allsvenskan": 113,
  "Süper Lig": 203,
  "Super League Greece": 197,
  "Super League 1": 197,
};

// All league IDs we scan (used for fixture discovery by league)
export const ALL_LEAGUE_IDS: number[] = [
  // Tier 1
  39, 78, 140, 135, 61, 88, 94, 71, 40, 2, 3,
  // Tier 2 (second divisions)
  62, 79, 136, 141,
  // Tier 3 (smaller top flights)
  179, 144, 207, 218, 119, 103, 113, 203, 197,
];

// Second-division leagues — higher edge, no OddsPapi (not covered)
export const SECOND_DIVISION_LEAGUES = new Set<string>([
  "Ligue 2", "2. Bundesliga", "Serie B", "Segunda División", "La Liga 2", "Segunda Division",
]);

// ─── Market parsing ───────────────────────────────────────────────────────────

const GOALS_OU_LINES: Record<string, string> = {
  "0.5": "OVER_UNDER_05",
  "1.5": "OVER_UNDER_15",
  "2.5": "OVER_UNDER_25",
  "3.5": "OVER_UNDER_35",
  "4.5": "OVER_UNDER_45",
};

const CORNERS_LINES: Record<string, string> = {
  "7.5": "TOTAL_CORNERS_75",
  "8.5": "TOTAL_CORNERS_85",
  "9.5": "TOTAL_CORNERS_95",
  "10.5": "TOTAL_CORNERS_105",
  "11.5": "TOTAL_CORNERS_115",
};

const CARDS_LINES: Record<string, string> = {
  "2.5": "TOTAL_CARDS_25",
  "3.5": "TOTAL_CARDS_35",
  "4.5": "TOTAL_CARDS_45",
  "5.5": "TOTAL_CARDS_55",
};

function mapOddsToMarket(
  betName: string,
  value: unknown,
  odd: unknown,
): { marketType: string; selectionName: string; backOdds: number } | null {
  const o = parseFloat(String(odd));
  if (isNaN(o) || o <= 1.0) return null;

  const v = String(value ?? "");
  const norm = betName.toLowerCase();

  if (norm.includes("match winner") || norm === "result" || norm === "1x2") {
    if (v === "Home") return { marketType: "MATCH_ODDS", selectionName: "Home", backOdds: o };
    if (v === "Draw") return { marketType: "MATCH_ODDS", selectionName: "Draw", backOdds: o };
    if (v === "Away") return { marketType: "MATCH_ODDS", selectionName: "Away", backOdds: o };
  }

  if (norm.includes("both teams score") || norm === "btts" || norm === "both teams to score") {
    if (v === "Yes") return { marketType: "BTTS", selectionName: "Yes", backOdds: o };
    if (v === "No") return { marketType: "BTTS", selectionName: "No", backOdds: o };
  }

  if (norm.includes("goals over/under") || norm.includes("total goals") || norm === "goals") {
    const line = v.replace("Over", "").replace("Under", "").trim();
    const marketSuffix = GOALS_OU_LINES[line];
    if (marketSuffix) {
      const sel = v.startsWith("Over") ? `Over ${line} Goals` : `Under ${line} Goals`;
      return { marketType: marketSuffix, selectionName: sel, backOdds: o };
    }
  }

  if (norm.includes("double chance")) {
    if (v === "Home/Draw" || v === "1X") return { marketType: "DOUBLE_CHANCE", selectionName: "1X", backOdds: o };
    if (v === "Draw/Away" || v === "X2") return { marketType: "DOUBLE_CHANCE", selectionName: "X2", backOdds: o };
    if (v === "Home/Away" || v === "12") return { marketType: "DOUBLE_CHANCE", selectionName: "12", backOdds: o };
  }

  if (norm.includes("first half winner") || norm === "half time result" || norm.includes("halftime result")) {
    if (v === "Home") return { marketType: "FIRST_HALF_RESULT", selectionName: "Home", backOdds: o };
    if (v === "Draw") return { marketType: "FIRST_HALF_RESULT", selectionName: "Draw", backOdds: o };
    if (v === "Away") return { marketType: "FIRST_HALF_RESULT", selectionName: "Away", backOdds: o };
  }

  if (norm.includes("first half") && norm.includes("goal")) {
    const line = v.replace("Over", "").replace("Under", "").trim();
    if (line === "0.5") {
      const sel = v.startsWith("Over") ? "Over 0.5 First Half Goals" : "Under 0.5 First Half Goals";
      return { marketType: "FIRST_HALF_OU_05", selectionName: sel, backOdds: o };
    }
    if (line === "1.5") {
      const sel = v.startsWith("Over") ? "Over 1.5 First Half Goals" : "Under 1.5 First Half Goals";
      return { marketType: "FIRST_HALF_OU_15", selectionName: sel, backOdds: o };
    }
  }

  if ((norm.includes("card") || norm.includes("yellow")) && (norm.includes("over") || norm.includes("under") || norm.includes("total"))) {
    const line = v.replace("Over", "").replace("Under", "").trim();
    const marketSuffix = CARDS_LINES[line];
    if (marketSuffix) {
      const sel = v.startsWith("Over") ? `Over ${line} Cards` : `Under ${line} Cards`;
      return { marketType: marketSuffix, selectionName: sel, backOdds: o };
    }
  }

  if (norm.includes("corner") && (norm.includes("over") || norm.includes("under") || norm.includes("total"))) {
    const line = v.replace("Over", "").replace("Under", "").trim();
    const marketSuffix = CORNERS_LINES[line];
    if (marketSuffix) {
      const sel = v.startsWith("Over") ? `Over ${line} Corners` : `Under ${line} Corners`;
      return { marketType: marketSuffix, selectionName: sel, backOdds: o };
    }
  }

  if (norm.includes("asian handicap")) {
    const line = v.replace("Home", "").replace("Away", "").trim();
    if (v.startsWith("Home")) return { marketType: "ASIAN_HANDICAP", selectionName: `Home ${line}`, backOdds: o };
    if (v.startsWith("Away")) return { marketType: "ASIAN_HANDICAP", selectionName: `Away ${line}`, backOdds: o };
  }

  return null;
}

// ─── Budget tracking ──────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getApiUsageToday(): Promise<number> {
  const today = todayStr();
  const rows = await db
    .select({ total: sql<number>`sum(${apiUsageTable.requestCount})::int` })
    .from(apiUsageTable)
    .where(
      and(
        eq(apiUsageTable.date, today),
        sql`${apiUsageTable.endpoint} NOT LIKE 'oddspapi_%'`,
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

async function trackApiCall(endpoint: string, count = 1): Promise<void> {
  await db.insert(apiUsageTable).values({
    date: todayStr(),
    endpoint,
    requestCount: count,
  });
}

async function canMakeRequest(needed = 1): Promise<boolean> {
  const used = await getApiUsageToday();
  return used + needed <= DAILY_CAP;
}

export async function getApiBudgetStatus(): Promise<{
  used: number;
  cap: number;
  remaining: number;
  date: string;
}> {
  const used = await getApiUsageToday();
  return { used, cap: DAILY_CAP, remaining: Math.max(0, DAILY_CAP - used), date: todayStr() };
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchApiFootball<T = unknown>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T | null> {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    logger.warn("API_FOOTBALL_KEY not set — skipping API-Football call");
    return null;
  }

  if (!(await canMakeRequest())) {
    logger.warn({ path, used: await getApiUsageToday() }, "API-Football daily budget exhausted");
    return null;
  }

  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { "x-apisports-key": key },
    });

    await trackApiCall(path);

    if (!res.ok) {
      logger.warn({ status: res.status, path }, "API-Football HTTP error");
      return null;
    }

    const json = (await res.json()) as { response: T; errors?: unknown };
    return json.response ?? null;
  } catch (err) {
    logger.error({ err, path }, "API-Football fetch failed");
    return null;
  }
}

// ─── Fixture discovery ────────────────────────────────────────────────────────

interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string; long: string } };
  league: { id: number; name: string; country: string };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
  goals: { home: number | null; away: number | null };
  score: {
    halftime: { home: number | null; away: number | null };
    fulltime: { home: number | null; away: number | null };
  };
}

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    // Transliterate accented chars → ASCII BEFORE stripping (prevents "atlético" → "atl tico")
    .replace(/[áàâäã]/g, "a")
    .replace(/[éèêë]/g, "e")
    .replace(/[íìîï]/g, "i")
    .replace(/[óòôöõ]/g, "o")
    .replace(/[úùûü]/g, "u")
    .replace(/[ñ]/g, "n")
    .replace(/[ç]/g, "c")
    .replace(/[ý]/g, "y")
    .replace(/[ß]/g, "ss")
    .replace(/[ø]/g, "o")
    .replace(/[æ]/g, "ae")
    // Strip common club abbreviations (standalone words)
    .replace(/\b(fc|sc|ac|af|cf|fk|sk|sv|bc|ec|cd|rc|ca|cr|rj|sp|fbpa|1901|1909|1910|1912)\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function teamNameMatch(dbName: string, apiName: string): boolean {
  const d = normalizeTeamName(dbName);
  const a = normalizeTeamName(apiName);
  if (d === a) return true;
  if (d.includes(a) || a.includes(d)) return true;
  const dFirst = d.split(" ")[0] ?? "";
  const aFirst = a.split(" ")[0] ?? "";
  if (dFirst.length > 3 && dFirst === aFirst) return true;
  // Word-overlap: if all meaningful words in the shorter name appear in the longer
  const dWords = d.split(" ").filter((w) => w.length > 3);
  const aWords = a.split(" ").filter((w) => w.length > 3);
  if (dWords.length > 0 && aWords.length > 0) {
    const shorter = dWords.length <= aWords.length ? dWords : aWords;
    const longer = dWords.length <= aWords.length ? aWords : dWords;
    const overlap = shorter.filter((w) => longer.includes(w)).length;
    if (overlap > 0 && overlap >= shorter.length) return true;
  }
  return false;
}

async function getFixturesForDate(date: string): Promise<ApiFixture[]> {
  const result = await fetchApiFootball<ApiFixture[]>("/fixtures", { date });
  return result ?? [];
}

// ─── Fetch recent finished fixtures for result syncing ─────────────────────

export async function fetchRecentFixtureResults(daysBack = 7): Promise<ApiFixture[]> {
  const dates: string[] = [];
  for (let i = daysBack; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const all: ApiFixture[] = [];
  for (const date of dates) {
    try {
      const fixtures = await getFixturesForDate(date);
      const finished = fixtures.filter(
        (f) => f.fixture.status.short === "FT" || f.fixture.status.short === "AET" || f.fixture.status.short === "PEN",
      );
      all.push(...finished);
    } catch (err) {
      logger.warn({ err, date }, "fetchRecentFixtureResults: error fetching date");
    }
  }
  logger.info({ count: all.length }, "fetchRecentFixtureResults: finished fixtures fetched via API-Football");
  return all;
}

export { teamNameMatch };

interface FixtureMatch {
  matchId: number;
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoffTime: Date;
}

export async function discoverFixtureMappings(): Promise<FixtureMatch[]> {
  const now = new Date();
  const upcoming = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, new Date(now.getTime() - 3 * 60 * 60 * 1000)),
        lte(matchesTable.kickoffTime, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
      ),
    );

  if (upcoming.length === 0) {
    logger.info("No upcoming scheduled matches in DB — skipping fixture discovery");
    return [];
  }

  // Fetch fixtures for the full 7-day window (yesterday through today+7)
  const allApiFixtures: ApiFixture[] = [];
  const offsets = [-1, 0, 1, 2, 3, 4, 5, 6, 7];

  for (const offset of offsets) {
    if (!(await canMakeRequest())) break;
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + offset);
    const dateStr = d.toISOString().slice(0, 10);
    const fixtures = await getFixturesForDate(dateStr);
    if (fixtures.length > 0) {
      logger.debug({ date: dateStr, count: fixtures.length }, "API-Football fixtures fetched");
      allApiFixtures.push(...fixtures);
    }
  }

  logger.info({ totalApiFixtures: allApiFixtures.length, dbMatches: upcoming.length }, "Starting fixture matching");

  const mappings: FixtureMatch[] = [];

  for (const match of upcoming) {
    const cached = await db
      .select({ featureValue: featuresTable.featureValue })
      .from(featuresTable)
      .where(and(eq(featuresTable.matchId, match.id), eq(featuresTable.featureName, "_af_fixture_id")))
      .limit(1);

    if (cached[0]?.featureValue) {
      const fid = parseInt(cached[0].featureValue, 10);
      if (!isNaN(fid)) {
        mappings.push({ matchId: match.id, fixtureId: fid, homeTeam: match.homeTeam, awayTeam: match.awayTeam, league: match.league, kickoffTime: match.kickoffTime });
        continue;
      }
    }

    const matched = allApiFixtures.find((f) =>
      teamNameMatch(match.homeTeam, f.teams.home.name) &&
      teamNameMatch(match.awayTeam, f.teams.away.name),
    );

    if (!matched) continue;

    const existing2 = await db
      .select({ id: featuresTable.id })
      .from(featuresTable)
      .where(and(eq(featuresTable.matchId, match.id), eq(featuresTable.featureName, "_af_fixture_id")))
      .limit(1);

    if (existing2.length > 0 && existing2[0]) {
      await db
        .update(featuresTable)
        .set({ featureValue: String(matched.fixture.id), computedAt: new Date() })
        .where(eq(featuresTable.id, existing2[0].id));
    } else {
      await db.insert(featuresTable).values({
        matchId: match.id,
        featureName: "_af_fixture_id",
        featureValue: String(matched.fixture.id),
        computedAt: new Date(),
      });
    }

    mappings.push({
      matchId: match.id,
      fixtureId: matched.fixture.id,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      league: match.league,
      kickoffTime: match.kickoffTime,
    });

    logger.debug(
      { matchId: match.id, fixtureId: matched.fixture.id, home: match.homeTeam, away: match.awayTeam },
      "API-Football fixture mapped",
    );
  }

  return mappings;
}

// ─── Odds fetching — ALL bookmakers in one call ───────────────────────────────

interface ApiOddsBookmaker {
  id: number;
  name: string;
  bets: Array<{
    id: number;
    name: string;
    values: Array<{ value: string; odd: string }>;
  }>;
}

interface ApiOddsFixture {
  fixture: { id: number };
  bookmakers: ApiOddsBookmaker[];
}

interface MarketConsensus {
  marketType: string;
  selectionName: string;
  bestOdds: number;
  worstOdds: number;
  avgOdds: number;
  bookmakerCount: number;
  marketSpread: number;
  consensusImpliedProb: number;
}

async function upsertFeature(matchId: number, name: string, value: number): Promise<void> {
  const rounded = String(Math.round(value * 1_000_000) / 1_000_000);
  const existing = await db
    .select({ id: featuresTable.id })
    .from(featuresTable)
    .where(and(eq(featuresTable.matchId, matchId), eq(featuresTable.featureName, name)))
    .limit(1);

  if (existing.length > 0 && existing[0]) {
    await db
      .update(featuresTable)
      .set({ featureValue: rounded, computedAt: new Date() })
      .where(eq(featuresTable.id, existing[0].id));
  } else {
    await db.insert(featuresTable).values({
      matchId,
      featureName: name,
      featureValue: rounded,
      computedAt: new Date(),
    });
  }
}

// Detect line movements — compare to previous snapshot and log if > 5%
async function detectAndLogLineMovement(
  matchId: number,
  marketType: string,
  selectionName: string,
  bookmaker: string,
  currentOdds: number,
  kickoffTime: Date,
): Promise<void> {
  try {
    // Get most recent history entry for this selection
    const prev = await db
      .select({ odds: oddsHistoryTable.odds, snapshotTime: oddsHistoryTable.snapshotTime })
      .from(oddsHistoryTable)
      .where(
        and(
          eq(oddsHistoryTable.matchId, matchId),
          eq(oddsHistoryTable.marketType, marketType),
          eq(oddsHistoryTable.selectionName, selectionName),
          eq(oddsHistoryTable.bookmaker, bookmaker),
        ),
      )
      .orderBy(desc(oddsHistoryTable.snapshotTime))
      .limit(1);

    const prevOdds = prev[0] ? Number(prev[0].odds) : null;
    const now = new Date();
    const hoursToKickoff = (kickoffTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    let oddsChangePct: number | null = null;
    let direction: string | null = null;

    if (prevOdds && prevOdds > 0) {
      oddsChangePct = ((currentOdds - prevOdds) / prevOdds) * 100;
      if (Math.abs(oddsChangePct) < 0.5) {
        direction = "stable";
      } else if (currentOdds < prevOdds) {
        direction = "shortening"; // odds getting shorter = selection more likely
      } else {
        direction = "drifting"; // odds getting longer = selection less likely
      }

      // Log significant line movements (> 5%)
      if (Math.abs(oddsChangePct) >= 5) {
        logger.info(
          {
            matchId, marketType, selectionName, bookmaker,
            prevOdds, currentOdds, oddsChangePct: oddsChangePct.toFixed(1), direction, hoursToKickoff: hoursToKickoff.toFixed(1),
          },
          "Significant line movement detected",
        );
        await db.insert(complianceLogsTable).values({
          actionType: "line_movement",
          details: {
            matchId, marketType, selectionName, bookmaker,
            prevOdds, currentOdds, oddsChangePct, direction, hoursToKickoff,
          },
          timestamp: now,
        });
      }
    }

    await db.insert(oddsHistoryTable).values({
      matchId,
      marketType,
      selectionName,
      bookmaker,
      odds: String(currentOdds),
      snapshotTime: now,
      previousOdds: prevOdds ? String(prevOdds) : null,
      oddsChangePct: oddsChangePct !== null ? String(Math.round(oddsChangePct * 100) / 100) : null,
      direction,
      hoursToKickoff: String(Math.round(hoursToKickoff * 100) / 100),
    });
  } catch (err) {
    logger.debug({ err, matchId, marketType }, "Line movement tracking error — non-fatal");
  }
}

export async function fetchAndStoreOddsForFixture(
  matchId: number,
  fixtureId: number,
  kickoffTime?: Date,
): Promise<number> {
  // Check if we already have fresh odds (< 2 hours old)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const existingReal = await db
    .select({ id: oddsSnapshotsTable.id })
    .from(oddsSnapshotsTable)
    .where(
      and(
        eq(oddsSnapshotsTable.matchId, matchId),
        eq(oddsSnapshotsTable.source, "api_football_real"),
        gte(oddsSnapshotsTable.snapshotTime, twoHoursAgo),
      ),
    )
    .limit(1);

  if (existingReal.length > 0) {
    logger.debug({ matchId, fixtureId }, "Real odds already fresh (< 2h) — skipping");
    return 0;
  }

  if (!(await canMakeRequest())) {
    logger.warn({ matchId }, "API-Football budget exhausted — skipping odds fetch");
    return 0;
  }

  // Fetch ALL bookmakers in a single call (no bookmaker filter = all returned)
  const result = await fetchApiFootball<ApiOddsFixture[]>("/odds", {
    fixture: fixtureId,
  });

  if (!result || result.length === 0) return 0;

  const fixture = result[0];
  if (!fixture?.bookmakers?.length) return 0;

  let storedCount = 0;
  const snapshotTime = new Date();

  // Track odds per market+selection across all bookmakers for consensus calc
  const marketOddsMap = new Map<string, number[]>();

  for (const bm of fixture.bookmakers) {
    const bookmakerName = bm.name ?? `bm_${bm.id}`;

    for (const bet of bm.bets) {
      for (const val of bet.values) {
        const mapped = mapOddsToMarket(bet.name, val.value, val.odd);
        if (!mapped) continue;

        const key = `${mapped.marketType}:${mapped.selectionName}`;
        const existing = marketOddsMap.get(key) ?? [];
        existing.push(mapped.backOdds);
        marketOddsMap.set(key, existing);

        await db.insert(oddsSnapshotsTable).values({
          matchId,
          marketType: mapped.marketType,
          selectionName: mapped.selectionName,
          backOdds: String(mapped.backOdds),
          source: `api_football_real:${bookmakerName}`,
          snapshotTime,
        });
        storedCount++;

        // Track line movement for best-available bookmaker (Bet365 or first found)
        if (kickoffTime && (bookmakerName === "Bet365" || bookmakerName === "Pinnacle" || bookmakerName === "1xBet")) {
          void detectAndLogLineMovement(matchId, mapped.marketType, mapped.selectionName, bookmakerName, mapped.backOdds, kickoffTime);
        }
      }
    }
  }

  // Compute market consensus + spread and store as match features
  const consensusData: MarketConsensus[] = [];
  for (const [key, oddsArr] of marketOddsMap.entries()) {
    if (oddsArr.length < 2) continue;
    const [marketType, selectionName] = key.split(":") as [string, string];
    const bestOdds = Math.max(...oddsArr);
    const worstOdds = Math.min(...oddsArr);
    const avgOdds = oddsArr.reduce((a, b) => a + b, 0) / oddsArr.length;
    const marketSpread = worstOdds > 0 ? (bestOdds - worstOdds) / worstOdds : 0;
    const consensusImpliedProb = 1 / avgOdds;
    consensusData.push({ marketType, selectionName, bestOdds, worstOdds, avgOdds, bookmakerCount: oddsArr.length, marketSpread, consensusImpliedProb });
  }

  if (kickoffTime) {
    const matchOddsData = consensusData.filter((c) => c.marketType === "MATCH_ODDS");
    if (matchOddsData.length > 0) {
      const homeData = matchOddsData.find((c) => c.selectionName === "Home");
      const awayData = matchOddsData.find((c) => c.selectionName === "Away");
      if (homeData) {
        await upsertFeature(matchId, "market_consensus_home", homeData.consensusImpliedProb);
        await upsertFeature(matchId, "market_spread_home", homeData.marketSpread);
        await upsertFeature(matchId, "bookmaker_count_home", homeData.bookmakerCount);
      }
      if (awayData) {
        await upsertFeature(matchId, "market_consensus_away", awayData.consensusImpliedProb);
        await upsertFeature(matchId, "market_spread_away", awayData.marketSpread);
      }
      const avgSpread = matchOddsData.reduce((a, c) => a + c.marketSpread, 0) / matchOddsData.length;
      await upsertFeature(matchId, "avg_market_spread", avgSpread);
    }
  }

  logger.info({ matchId, fixtureId, bookmakerCount: fixture.bookmakers.length, storedCount, marketTypes: marketOddsMap.size }, "Odds stored from API-Football (all bookmakers)");

  return storedCount;
}

export async function fetchAndStoreOddsForAllUpcoming(): Promise<{
  fixturesProcessed: number;
  oddsStored: number;
  mappings: number;
  leaguesScanned: Set<string>;
}> {
  logger.info("Starting API-Football odds ingestion for upcoming fixtures");

  const mappings = await discoverFixtureMappings();
  logger.info({ count: mappings.length }, "Fixture mappings discovered");

  let oddsStored = 0;
  const leaguesScanned = new Set<string>();

  for (const m of mappings) {
    if (!(await canMakeRequest())) {
      logger.warn("Budget exhausted — stopping odds ingestion");
      break;
    }
    const count = await fetchAndStoreOddsForFixture(m.matchId, m.fixtureId, m.kickoffTime);
    oddsStored += count;
    leaguesScanned.add(m.league);
  }

  logger.info({
    fixturesProcessed: mappings.length,
    oddsStored,
    leaguesScanned: leaguesScanned.size,
    leagues: [...leaguesScanned],
    budgetUsed: await getApiUsageToday(),
  }, "API-Football odds ingestion complete");

  await db.insert(complianceLogsTable).values({
    actionType: "api_football_ingestion",
    details: {
      action: "odds_ingestion",
      fixturesProcessed: mappings.length,
      oddsStored,
      leaguesScanned: [...leaguesScanned],
      budgetUsed: await getApiUsageToday(),
    },
    timestamp: new Date(),
  });

  return { fixturesProcessed: mappings.length, oddsStored, mappings: mappings.length, leaguesScanned };
}

// ─── Team Statistics ──────────────────────────────────────────────────────────

interface ApiTeamStats {
  team: { id: number; name: string };
  league: { id: number };
  form: string;
  goals: {
    for: { average: { home: string; away: string; total: string } };
    against: { average: { home: string; away: string; total: string } };
  };
  cards: {
    yellow: Record<string, { total: number | null }>;
    red: Record<string, { total: number | null }>;
  };
  fixtures: {
    played: { home: number; away: number; total: number };
  };
}

function extractFormRatio(form: string, last = 10): number {
  const recent = form.slice(-last);
  if (!recent.length) return 0.4;
  let pts = 0;
  for (const c of recent) {
    if (c === "W") pts += 3;
    else if (c === "D") pts += 1;
  }
  return pts / (recent.length * 3);
}

async function getStoredFeature(matchId: number, featureName: string): Promise<number | null> {
  const rows = await db
    .select({ featureValue: featuresTable.featureValue })
    .from(featuresTable)
    .where(and(eq(featuresTable.matchId, matchId), eq(featuresTable.featureName, featureName)))
    .limit(1);
  if (!rows[0]?.featureValue) return null;
  const v = parseInt(rows[0].featureValue, 10);
  return isNaN(v) ? null : v;
}

export async function fetchAndStoreTeamStats(
  matchId: number,
  teamId: number,
  leagueId: number,
  venue: "home" | "away",
  season = new Date().getFullYear(),
): Promise<boolean> {
  if (!(await canMakeRequest())) return false;

  const result = await fetchApiFootball<ApiTeamStats>("/teams/statistics", {
    team: teamId,
    league: leagueId,
    season,
  });

  if (!result) return false;

  const prefix = venue === "home" ? "home" : "away";

  const goalsForAvg = parseFloat(result.goals.for.average[venue]) || 1.4;
  const goalsAgainstAvg = parseFloat(result.goals.against.average[venue]) || 1.1;
  await upsertFeature(matchId, `${prefix}_af_goals_scored_avg`, goalsForAvg);
  await upsertFeature(matchId, `${prefix}_af_goals_conceded_avg`, goalsAgainstAvg);

  const formRatio = extractFormRatio(result.form ?? "", 10);
  await upsertFeature(matchId, `${prefix}_af_form_last10`, formRatio);

  const gamesPlayed = result.fixtures.played[venue] || 1;
  let totalYellows = 0;
  for (const v of Object.values(result.cards.yellow)) {
    totalYellows += v.total ?? 0;
  }
  await upsertFeature(matchId, `${prefix}_yellow_cards_avg`, totalYellows / gamesPlayed);

  logger.debug({ matchId, teamId, venue, goalsForAvg }, "Team stats stored from API-Football");
  return true;
}

export async function fetchTeamStatsForUpcomingMatches(): Promise<{
  matchesProcessed: number;
  teamsUpdated: number;
}> {
  logger.info("Starting API-Football team stats ingestion");

  const now = new Date();
  const upcoming = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, now),
        lte(matchesTable.kickoffTime, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
      ),
    );

  let matchesProcessed = 0;
  let teamsUpdated = 0;

  for (const match of upcoming) {
    if (!(await canMakeRequest(2))) break;

    const leagueId = LEAGUE_IDS[match.league];
    if (!leagueId) continue;

    const homeAfId = await getStoredFeature(match.id, "_af_home_team_id");
    const awayAfId = await getStoredFeature(match.id, "_af_away_team_id");

    if (homeAfId && awayAfId) {
      const homeOk = await fetchAndStoreTeamStats(match.id, homeAfId, leagueId, "home");
      if (homeOk) teamsUpdated++;
      const awayOk = await fetchAndStoreTeamStats(match.id, awayAfId, leagueId, "away");
      if (awayOk) teamsUpdated++;
      matchesProcessed++;
    }
  }

  return { matchesProcessed, teamsUpdated };
}

// ─── Fixture statistics (post-match for training data) ───────────────────────

interface ApiFixtureStats {
  team: { id: number };
  statistics: Array<{ type: string; value: number | string | null }>;
}

function getStat(stats: ApiFixtureStats["statistics"], type: string): number {
  const s = stats.find((s) => s.type === type);
  return Number(s?.value ?? 0) || 0;
}

export async function fetchAndStoreFixtureStats(
  matchId: number,
  fixtureId: number,
): Promise<boolean> {
  if (!(await canMakeRequest())) return false;

  const result = await fetchApiFootball<ApiFixtureStats[]>("/fixtures/statistics", {
    fixture: fixtureId,
  });

  if (!result || result.length < 2) return false;

  const [homeStats, awayStats] = result;
  if (!homeStats || !awayStats) return false;

  const features: Array<[string, number]> = [
    ["home_shots_on_target", getStat(homeStats.statistics, "Shots on Goal")],
    ["away_shots_on_target", getStat(awayStats.statistics, "Shots on Goal")],
    ["home_total_shots", getStat(homeStats.statistics, "Total Shots") || 1],
    ["away_total_shots", getStat(awayStats.statistics, "Total Shots") || 1],
    ["home_corners", getStat(homeStats.statistics, "Corner Kicks")],
    ["away_corners", getStat(awayStats.statistics, "Corner Kicks")],
    ["home_yellow_cards", getStat(homeStats.statistics, "Yellow Cards")],
    ["away_yellow_cards", getStat(awayStats.statistics, "Yellow Cards")],
    ["home_fouls", getStat(homeStats.statistics, "Fouls")],
    ["away_fouls", getStat(awayStats.statistics, "Fouls")],
    ["total_corners", getStat(homeStats.statistics, "Corner Kicks") + getStat(awayStats.statistics, "Corner Kicks")],
    ["total_yellow_cards", getStat(homeStats.statistics, "Yellow Cards") + getStat(awayStats.statistics, "Yellow Cards")],
  ];

  for (const [name, value] of features) {
    await upsertFeature(matchId, name, value);
  }

  return true;
}

// ─── Line movement stats for dashboard ───────────────────────────────────────

export async function getLineMovementsToday(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(complianceLogsTable)
    .where(
      and(
        eq(complianceLogsTable.actionType, "line_movement"),
        gte(complianceLogsTable.timestamp, todayStart),
      ),
    );

  return rows[0]?.count ?? 0;
}

// ─── Scan statistics for dashboard ───────────────────────────────────────────

export async function getScanStats(): Promise<{
  leaguesActive: number;
  fixturesUpcoming: number;
  marketsPerFixture: number;
  lineMovementsToday: number;
  budgetUsedToday: number;
  budgetCap: number;
}> {
  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [fixtureRows, oddsRows, budgetStatus, lineMovements] = await Promise.all([
    db
      .select({ count: sql<number>`count(distinct ${matchesTable.id})::int`, leagueCount: sql<number>`count(distinct ${matchesTable.league})::int` })
      .from(matchesTable)
      .where(and(eq(matchesTable.status, "scheduled"), gte(matchesTable.kickoffTime, now), lte(matchesTable.kickoffTime, weekOut))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(oddsSnapshotsTable)
      .where(gte(oddsSnapshotsTable.snapshotTime, new Date(now.getTime() - 2 * 60 * 60 * 1000))),
    getApiBudgetStatus(),
    getLineMovementsToday(),
  ]);

  const fixtureCount = fixtureRows[0]?.count ?? 0;
  const leagueCount = fixtureRows[0]?.leagueCount ?? 0;
  const recentOdds = oddsRows[0]?.count ?? 0;
  const marketsPerFixture = fixtureCount > 0 ? Math.round(recentOdds / fixtureCount) : 0;

  return {
    leaguesActive: leagueCount,
    fixturesUpcoming: fixtureCount,
    marketsPerFixture,
    lineMovementsToday: lineMovements,
    budgetUsedToday: budgetStatus.used,
    budgetCap: budgetStatus.cap,
  };
}
