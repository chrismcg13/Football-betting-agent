/**
 * API-Football v3 Integration
 * Base: https://v3.football.api-sports.io/
 * Free tier: 100 requests/day. Hard cap: 90 (leave 10 for emergencies).
 * Priority: odds → fixture stats → team stats → players → lineups
 */

import {
  db,
  matchesTable,
  oddsSnapshotsTable,
  featuresTable,
  complianceLogsTable,
  apiUsageTable,
} from "@workspace/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const BASE_URL = "https://v3.football.api-sports.io";
const DAILY_CAP = 90;

// ─── League ID mapping ────────────────────────────────────────────────────────
const LEAGUE_IDS: Record<string, number> = {
  "Premier League": 39,
  "Bundesliga": 78,
  "Primera Division": 140,
  "Serie A": 135,
  "Ligue 1": 61,
  "Eredivisie": 88,
  "Primeira Liga": 94,
  "Campeonato Brasileiro Série A": 71,
  "Championship": 40,
  "Brasileirão": 71,
  "UEFA Champions League": 2,
  "Champions League": 2,
};

// Bookmaker IDs: 8=Bet365, 6=Bwin, 11=1xBet
const BOOKMAKER_IDS = [8, 6, 11];

// API-Football market name → our marketType
const MARKET_MAP: Record<string, string> = {
  "Match Winner": "MATCH_ODDS",
  "Goals Over/Under": "OVER_UNDER",
  "Both Teams Score": "BTTS",
  "Asian Handicap": "ASIAN_HANDICAP",
  "Cards Over/Under": "TOTAL_CARDS",
  "Corners Over/Under": "TOTAL_CORNERS",
  "Total - Cards": "TOTAL_CARDS",
  "Corners - Match": "TOTAL_CORNERS",
};

// Goals OU line → our marketType suffix
const GOALS_OU_LINES: Record<string, string> = {
  "1.5": "OVER_UNDER_15",
  "2.5": "OVER_UNDER_25",
  "3.5": "OVER_UNDER_35",
};

// ─── Budget tracking ───────────────────────────────────────────────────────────

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

// ─── Core fetch function ──────────────────────────────────────────────────────

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
    await db.insert(complianceLogsTable).values({
      actionType: "api_budget",
      details: { message: "API-Football daily budget exhausted", path },
      timestamp: new Date(),
    });
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

// ─── Fixture discovery and matching ──────────────────────────────────────────

interface ApiFixture {
  fixture: { id: number; date: string; status: { short: string } };
  league: { id: number; name: string; country: string };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
}

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bfc\b|\bsc\b|\bac\b|\baf\b|\bcf\b|\bfk\b|\bsk\b|\bsv\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function teamNameMatch(dbName: string, apiName: string): boolean {
  const db = normalizeTeamName(dbName);
  const api = normalizeTeamName(apiName);
  if (db === api) return true;
  if (db.includes(api) || api.includes(db)) return true;
  // Check if first word matches (e.g. "Arsenal" in "Arsenal FC")
  const dbFirst = db.split(" ")[0] ?? "";
  const apiFirst = api.split(" ")[0] ?? "";
  return dbFirst.length > 3 && dbFirst === apiFirst;
}

async function getFixturesForDate(date: string): Promise<ApiFixture[]> {
  const result = await fetchApiFootball<ApiFixture[]>("/fixtures", { date });
  return result ?? [];
}

interface FixtureMatch {
  matchId: number;
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
}

export async function discoverFixtureMappings(): Promise<FixtureMatch[]> {
  // Get upcoming + very-soon matches from our DB (broader window: 3 days ago → 7 days ahead)
  // so recently-started matches can still be settled and upcoming ones can be pre-mapped.
  const now = new Date();
  const upcoming = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, new Date(now.getTime() - 3 * 60 * 60 * 1000)), // 3 hours ago (in-play buffer)
        lte(matchesTable.kickoffTime, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
      ),
    );

  if (upcoming.length === 0) {
    logger.info("No upcoming scheduled matches in DB — skipping fixture discovery");
    return [];
  }

  // Fetch ALL fixtures across the trading window (1h-96h = today through today+4 days)
  // to ensure weekend EPL/La Liga/Bundesliga fixtures are covered.
  const allApiFixtures: ApiFixture[] = [];
  const offsets = [-1, 0, 1, 2, 3, 4]; // yesterday through today+4 days

  for (const offset of offsets) {
    if (!(await canMakeRequest())) break;
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + offset);
    const dateStr = d.toISOString().slice(0, 10);
    const fixtures = await getFixturesForDate(dateStr);
    if (fixtures.length > 0) {
      logger.info({ date: dateStr, count: fixtures.length }, "API-Football fixtures fetched");
      allApiFixtures.push(...fixtures);
    }
  }

  logger.info({ totalApiFixtures: allApiFixtures.length, dbMatches: upcoming.length }, "Starting fixture matching");

  const mappings: FixtureMatch[] = [];

  for (const match of upcoming) {
    // Return cached fixture ID if already stored
    const cached = await db
      .select({ featureValue: featuresTable.featureValue })
      .from(featuresTable)
      .where(and(eq(featuresTable.matchId, match.id), eq(featuresTable.featureName, "_af_fixture_id")))
      .limit(1);

    if (cached[0]?.featureValue) {
      const fid = parseInt(cached[0].featureValue, 10);
      if (!isNaN(fid)) {
        mappings.push({ matchId: match.id, fixtureId: fid, homeTeam: match.homeTeam, awayTeam: match.awayTeam });
        continue;
      }
    }

    // Try to match against the combined API fixture pool
    const matched = allApiFixtures.find((f) =>
      teamNameMatch(match.homeTeam, f.teams.home.name) &&
      teamNameMatch(match.awayTeam, f.teams.away.name),
    );

    if (!matched) continue;

    // Persist the mapping as a hidden feature so we don't need to re-discover later
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
    });

    logger.info(
      { matchId: match.id, fixtureId: matched.fixture.id, home: match.homeTeam, away: match.awayTeam },
      "API-Football fixture mapped",
    );
  }

  return mappings;
}

// ─── Odds fetching ────────────────────────────────────────────────────────────

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

function mapOddsToMarket(
  betName: string,
  value: string,
  odd: string,
): { marketType: string; selectionName: string; backOdds: number } | null {
  const o = parseFloat(odd);
  if (isNaN(o) || o <= 1.0) return null;

  const norm = betName.toLowerCase();

  // Match Winner / 1X2
  if (norm.includes("match winner") || norm === "result") {
    if (value === "Home") return { marketType: "MATCH_ODDS", selectionName: "Home", backOdds: o };
    if (value === "Draw") return { marketType: "MATCH_ODDS", selectionName: "Draw", backOdds: o };
    if (value === "Away") return { marketType: "MATCH_ODDS", selectionName: "Away", backOdds: o };
  }

  // BTTS
  if (norm.includes("both teams score")) {
    if (value === "Yes") return { marketType: "BTTS", selectionName: "Yes", backOdds: o };
    if (value === "No") return { marketType: "BTTS", selectionName: "No", backOdds: o };
  }

  // Goals Over/Under
  if (norm.includes("goals over/under")) {
    const line = value.replace("Over", "").replace("Under", "").trim();
    const marketSuffix = GOALS_OU_LINES[line];
    if (marketSuffix) {
      const sel = value.startsWith("Over") ? `Over ${line} Goals` : `Under ${line} Goals`;
      return { marketType: marketSuffix, selectionName: sel, backOdds: o };
    }
  }

  // Cards Over/Under
  if (norm.includes("card") && norm.includes("over")) {
    const line = value.replace("Over", "").replace("Under", "").trim();
    const sel = value.startsWith("Over") ? `Over ${line} Cards` : `Under ${line} Cards`;
    if (line === "3.5") return { marketType: "TOTAL_CARDS_35", selectionName: sel, backOdds: o };
    if (line === "4.5") return { marketType: "TOTAL_CARDS_45", selectionName: sel, backOdds: o };
  }

  // Corners Over/Under
  if (norm.includes("corner") && (norm.includes("over") || norm.includes("under"))) {
    const line = value.replace("Over", "").replace("Under", "").trim();
    const sel = value.startsWith("Over") ? `Over ${line} Corners` : `Under ${line} Corners`;
    if (line === "9.5") return { marketType: "TOTAL_CORNERS_95", selectionName: sel, backOdds: o };
    if (line === "10.5") return { marketType: "TOTAL_CORNERS_105", selectionName: sel, backOdds: o };
    if (line === "8.5") return { marketType: "TOTAL_CORNERS_85", selectionName: sel, backOdds: o };
  }

  return null;
}

export async function fetchAndStoreOddsForFixture(
  matchId: number,
  fixtureId: number,
): Promise<number> {
  // Check if we already have fresh odds (< 6 hours old)
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const existingReal = await db
    .select({ id: oddsSnapshotsTable.id })
    .from(oddsSnapshotsTable)
    .where(
      and(
        eq(oddsSnapshotsTable.matchId, matchId),
        eq(oddsSnapshotsTable.source, "api_football_real"),
        gte(oddsSnapshotsTable.snapshotTime, sixHoursAgo),
      ),
    )
    .limit(1);

  if (existingReal.length > 0) {
    logger.debug({ matchId, fixtureId }, "Real odds already fresh — skipping fetch");
    return 0;
  }

  let storedCount = 0;

  for (const bookmakerId of BOOKMAKER_IDS) {
    if (!(await canMakeRequest())) break;

    const result = await fetchApiFootball<ApiOddsFixture[]>("/odds", {
      fixture: fixtureId,
      bookmaker: bookmakerId,
    });

    if (!result || result.length === 0) continue;

    const fixture = result[0];
    if (!fixture?.bookmakers?.length) continue;

    const bookmakerName = bookmakerId === 8 ? "Bet365" : bookmakerId === 6 ? "Bwin" : "1xBet";
    const source = `api_football_${bookmakerName.toLowerCase().replace("365", "365")}`;

    for (const bm of fixture.bookmakers) {
      for (const bet of bm.bets) {
        for (const val of bet.values) {
          const mapped = mapOddsToMarket(bet.name, val.value, val.odd);
          if (!mapped) continue;

          await db.insert(oddsSnapshotsTable).values({
            matchId,
            marketType: mapped.marketType,
            selectionName: mapped.selectionName,
            backOdds: String(mapped.backOdds),
            source: `api_football_real:${bookmakerName}`,
            snapshotTime: new Date(),
          });
          storedCount++;
        }
      }
    }

    logger.info({ matchId, fixtureId, bookmakerName, storedCount }, "Odds stored from API-Football");
  }

  return storedCount;
}

export async function fetchAndStoreOddsForAllUpcoming(): Promise<{
  fixturesProcessed: number;
  oddsStored: number;
  mappings: number;
}> {
  logger.info("Starting API-Football odds ingestion for upcoming fixtures");

  const mappings = await discoverFixtureMappings();
  logger.info({ count: mappings.length }, "Fixture mappings discovered");

  let oddsStored = 0;
  for (const m of mappings) {
    if (!(await canMakeRequest(2))) {
      logger.warn("Budget too low for more odds fetching — stopping");
      break;
    }
    oddsStored += await fetchAndStoreOddsForFixture(m.matchId, m.fixtureId);
  }

  await db.insert(complianceLogsTable).values({
    actionType: "api_football_ingestion",
    details: {
      action: "odds_ingestion",
      fixturesProcessed: mappings.length,
      oddsStored,
      budgetUsed: await getApiUsageToday(),
    },
    timestamp: new Date(),
  });

  return { fixturesProcessed: mappings.length, oddsStored, mappings: mappings.length };
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

  // Goals
  const goalsForAvg = parseFloat(result.goals.for.average[venue]) || 1.4;
  const goalsAgainstAvg = parseFloat(result.goals.against.average[venue]) || 1.1;
  await upsertFeature(matchId, `${prefix}_af_goals_scored_avg`, goalsForAvg);
  await upsertFeature(matchId, `${prefix}_af_goals_conceded_avg`, goalsAgainstAvg);

  // Form
  const formRatio = extractFormRatio(result.form ?? "", 10);
  await upsertFeature(matchId, `${prefix}_af_form_last10`, formRatio);

  // Yellow cards per game
  const gamesPlayed = result.fixtures.played[venue] || 1;
  let totalYellows = 0;
  for (const v of Object.values(result.cards.yellow)) {
    totalYellows += v.total ?? 0;
  }
  const yellowCardsAvg = totalYellows / gamesPlayed;
  await upsertFeature(matchId, `${prefix}_yellow_cards_avg`, yellowCardsAvg);

  logger.debug({ matchId, teamId, venue, goalsForAvg, yellowCardsAvg }, "Team stats stored from API-Football");
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

    // Get stored AF team IDs if available
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

// ─── Fixture Statistics (after match for training data) ──────────────────────

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

  const homeShotsOnTarget = getStat(homeStats.statistics, "Shots on Goal");
  const awayShotsOnTarget = getStat(awayStats.statistics, "Shots on Goal");
  const homeTotalShots = getStat(homeStats.statistics, "Total Shots") || 1;
  const awayTotalShots = getStat(awayStats.statistics, "Total Shots") || 1;
  const homeCorners = getStat(homeStats.statistics, "Corner Kicks");
  const awayCorners = getStat(awayStats.statistics, "Corner Kicks");
  const homeYellows = getStat(homeStats.statistics, "Yellow Cards");
  const awayYellows = getStat(awayStats.statistics, "Yellow Cards");
  const homeFouls = getStat(homeStats.statistics, "Fouls");
  const awayFouls = getStat(awayStats.statistics, "Fouls");

  const features: Array<[string, number]> = [
    ["home_shots_on_target", homeShotsOnTarget],
    ["away_shots_on_target", awayShotsOnTarget],
    ["home_total_shots", homeTotalShots],
    ["away_total_shots", awayTotalShots],
    ["home_corners", homeCorners],
    ["away_corners", awayCorners],
    ["home_yellow_cards", homeYellows],
    ["away_yellow_cards", awayYellows],
    ["home_fouls", homeFouls],
    ["away_fouls", awayFouls],
    ["total_corners", homeCorners + awayCorners],
    ["total_yellow_cards", homeYellows + awayYellows],
  ];

  for (const [name, value] of features) {
    await upsertFeature(matchId, name, value);
  }

  return true;
}

// ─── Lineup monitoring ────────────────────────────────────────────────────────

interface ApiLineup {
  team: { id: number; name: string };
  startXI: Array<{ player: { id: number; name: string; number: number; pos: string } }>;
}

export async function checkLineupAndFlag(
  matchId: number,
  fixtureId: number,
): Promise<{ available: boolean; flagged: boolean; narrative: string }> {
  if (!(await canMakeRequest())) {
    return { available: false, flagged: false, narrative: "Budget exhausted" };
  }

  const result = await fetchApiFootball<ApiLineup[]>("/fixtures/lineups", {
    fixture: fixtureId,
  });

  if (!result || result.length < 2) {
    return { available: false, flagged: false, narrative: "Lineup not yet published" };
  }

  const [home, away] = result;
  const homeStarters = home?.startXI?.length ?? 0;
  const awayStarters = away?.startXI?.length ?? 0;

  const narrative = `Lineups confirmed: ${home?.team?.name} (${homeStarters} starters) vs ${away?.team?.name} (${awayStarters} starters)`;

  return { available: true, flagged: false, narrative };
}
