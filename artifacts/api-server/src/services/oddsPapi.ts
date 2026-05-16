/**
 * OddsPapi Integration — Sharp-line validation & best-odds layer
 * Base URL: https://api.oddspapi.io/v4
 * Auth: query param apiKey={ODDSPAPI_KEY}
 * Budget: 100,000 requests/month
 * Priority allocation:
 *   P1 (40%) — Pre-bet validation for all fixtures evaluated
 *   P2 (30%) — Line movement tracking for Tier 1 qualifying fixtures
 *   P3 (20%) — Closing line capture for CLV measurement
 *   P4 (10%) — Exploratory coverage of new leagues
 * Throttle order: cut P4 first, then P2 frequency. Never cut P1 or P3.
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
  pinnacleOddsSnapshotsTable,
  competitionConfigTable,
  lineMovementsTable,
  filteredBetsTable,
} from "@workspace/db";
import { eq, and, gte, lte, sql, like, inArray, ne, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { resilientFetch, isCircuitOpen } from "./resilientFetch";
import { devig, type DevigMethod } from "./devig";

const BASE_URL = "https://api.oddspapi.io/v4";
const ODDSPAPI_SERVICE = "oddspapi";
const MONTHLY_CAP = 100_000;
const DEFAULT_DAILY_CAP = 5_000;

const GOALS_OU_ALIASES: Record<string, string> = {
  "Over 0.5": "Over 0.5 Goals",
  "Under 0.5": "Under 0.5 Goals",
  "Over 1.5": "Over 1.5 Goals",
  "Under 1.5": "Under 1.5 Goals",
  "Over 2.5": "Over 2.5 Goals",
  "Under 2.5": "Under 2.5 Goals",
  "Over 3.5": "Over 3.5 Goals",
  "Under 3.5": "Under 3.5 Goals",
  "Over 4.5": "Over 4.5 Goals",
  "Under 4.5": "Under 4.5 Goals",
  "Over 5.5": "Over 5.5 Goals",
  "Under 5.5": "Under 5.5 Goals",
};
const REVERSE_GOALS_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(GOALS_OU_ALIASES).map(([k, v]) => [v, k]),
);

export function selectionNameVariants(name: string): string[] {
  const set = new Set<string>([name]);
  if (GOALS_OU_ALIASES[name]) set.add(GOALS_OU_ALIASES[name]);
  if (REVERSE_GOALS_ALIASES[name]) set.add(REVERSE_GOALS_ALIASES[name]);

  const BTTS_YES = ["Yes", "BTTS Yes", "Both Teams Score - Yes", "GG"];
  const BTTS_NO = ["No", "BTTS No", "Both Teams Score - No", "NG"];
  const MO_HOME = ["Home", "1"];
  const MO_DRAW = ["Draw", "X"];
  const MO_AWAY = ["Away", "2"];
  const DC_1X = ["1X", "Home or Draw"];
  const DC_X2 = ["X2", "Draw or Away"];
  const DC_12 = ["12", "Home or Away"];

  const groups = [BTTS_YES, BTTS_NO, MO_HOME, MO_DRAW, MO_AWAY, DC_1X, DC_X2, DC_12];
  for (const group of groups) {
    if (group.some((v) => v.toLowerCase() === name.toLowerCase())) {
      for (const v of group) set.add(v);
    }
  }

  return [...set];
}

export function canonicalSelectionName(name: string): string {
  return GOALS_OU_ALIASES[name] ?? name;
}

const PRIORITY_MONTHLY_BUDGETS: Record<string, number> = {
  P1: 40_000,
  P2: 30_000,
  P3: 20_000,
  P4: 10_000,
};

async function getFlexibleDailyCap(): Promise<number> {
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
  } catch { /* fall through */ }

  const monthUsage = await getOddspapiUsageThisMonth();
  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const daysRemaining = daysInMonth - dayOfMonth + 1;
  const budgetRemaining = MONTHLY_CAP - monthUsage;

  if (daysRemaining <= 0) return DEFAULT_DAILY_CAP;

  const avgNeeded = Math.floor(budgetRemaining / daysRemaining);
  const flexCap = Math.max(4_000, Math.min(6_500, avgNeeded));

  return flexCap;
}

async function getEffectiveDailyCap(): Promise<number> {
  return getFlexibleDailyCap();
}

// ─── Market ID mapping ─────────────────────────────────────────────────────────

// 2026-05-08: All MARKET_IDS the /odds endpoint understands. Note: per
// oddsPapi.ts:2051 comment, the /odds endpoint returns ALL markets in
// one response regardless of marketId — adding entries here is purely
// for explicit per-market fallback fetches (e.g., when validation
// queries one market specifically). The single P1 prefetch call that
// drives PREFETCH_TARGETS persistence costs the same regardless of
// market count.
//
// Reverse-engineered from oddspapi public docs:
//   101 = 1x2 / Match Winner
//   102 = Goals Over/Under (all lines)
//   103 = Both Teams To Score
//   104 = Asian Handicap (all lines)
//   105 = Double Chance
//   106 = Team Totals (all teams, all lines)
//   107 = First Half Result
//   108 = First Half Over/Under (all lines)
//   112 = Cards Over/Under
//   113 = Corners Over/Under
const MARKET_IDS: Record<string, number> = {
  MATCH_ODDS: 101,
  OVER_UNDER_05: 102,
  OVER_UNDER_15: 102,
  OVER_UNDER_25: 102,
  OVER_UNDER_35: 102,
  OVER_UNDER_45: 102,
  BTTS: 103,
  ASIAN_HANDICAP: 104,
  // 2026-05-16 subtract bundle: DOUBLE_CHANCE, FIRST_HALF_RESULT,
  // TOTAL_CARDS_*, TOTAL_CORNERS_* ingestion IDs removed.
  TEAM_TOTAL_HOME_05: 106,
  TEAM_TOTAL_HOME_15: 106,
  TEAM_TOTAL_HOME_25: 106,
  TEAM_TOTAL_AWAY_05: 106,
  TEAM_TOTAL_AWAY_15: 106,
  TEAM_TOTAL_AWAY_25: 106,
  FIRST_HALF_OU_05: 108,
  FIRST_HALF_OU_15: 108,
};

// OU line to target for each market type. 2026-05-08: added OVER_UNDER_05,
// OVER_UNDER_45, TOTAL_CARDS_55. Without these, the slash-format selection
// matcher (1920-1937) silently rejected these markets — a 3-week silent
// parser failure that contributed to BTTS/DC/OU_45 producing 0 oddspapi_pinnacle
// rows. Phase A1 of the coverage-expansion bundle.
const OU_LINES: Record<string, string> = {
  OVER_UNDER_05: "0.5",
  OVER_UNDER_15: "1.5",
  OVER_UNDER_25: "2.5",
  OVER_UNDER_35: "3.5",
  OVER_UNDER_45: "4.5",
  // 2026-05-16 subtract bundle: TOTAL_CARDS_* + TOTAL_CORNERS_* removed.
};

// 2026-05-08 Phase B: team-total OU lines. Selection names are
// "Over X.X" / "Under X.X" plus the team encoded in the market_type
// (TEAM_TOTAL_HOME_05 → home goals threshold 0.5).
const TEAM_TOTAL_LINES: Record<string, { side: "home" | "away"; line: string }> = {
  TEAM_TOTAL_HOME_05: { side: "home", line: "0.5" },
  TEAM_TOTAL_HOME_15: { side: "home", line: "1.5" },
  TEAM_TOTAL_HOME_25: { side: "home", line: "2.5" },
  TEAM_TOTAL_AWAY_05: { side: "away", line: "0.5" },
  TEAM_TOTAL_AWAY_15: { side: "away", line: "1.5" },
  TEAM_TOTAL_AWAY_25: { side: "away", line: "2.5" },
};

// 2026-05-08 Phase B: first-half OU lines.
const FIRST_HALF_OU_LINES: Record<string, string> = {
  FIRST_HALF_OU_05: "0.5",
  FIRST_HALF_OU_15: "1.5",
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

async function trackOddspapiCall(endpoint: string, count = 1, priority = "P1"): Promise<void> {
  await db.insert(apiUsageTable).values({
    date: todayStr(),
    endpoint: `oddspapi_${priority}_${endpoint}`,
    requestCount: count,
  });
}

async function getOddspapiUsageByPriority(priority: string): Promise<number> {
  const month = monthStr();
  const rows = await db
    .select({ total: sql<number>`sum(${apiUsageTable.requestCount})::int` })
    .from(apiUsageTable)
    .where(and(like(apiUsageTable.date, `${month}%`), like(apiUsageTable.endpoint, `oddspapi_${priority}_%`)));
  return Number(rows[0]?.total ?? 0);
}

async function canMakeOddspapiRequest(needed = 1, priority = "P1"): Promise<boolean> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return false;
  const [daily, monthly, effectiveCap] = await Promise.all([
    getOddspapiUsageToday(),
    getOddspapiUsageThisMonth(),
    getEffectiveDailyCap(),
  ]);
  if (daily + needed > effectiveCap) {
    logger.warn({ daily, cap: effectiveCap, priority }, "OddsPapi daily budget exhausted");
    return false;
  }
  if (monthly + needed > MONTHLY_CAP) {
    logger.warn({ monthly, cap: MONTHLY_CAP, priority }, "OddsPapi monthly budget exhausted");
    return false;
  }

  const priorityBudget = PRIORITY_MONTHLY_BUDGETS[priority];
  if (priorityBudget) {
    const priorityUsage = await getOddspapiUsageByPriority(priority);
    if (priorityUsage + needed > priorityBudget) {
      if (priority === "P4") {
        logger.warn({ priority, used: priorityUsage, budget: priorityBudget }, "OddsPapi priority budget exhausted — throttling P4");
        return false;
      }
      if (priority === "P2") {
        logger.warn({ priority, used: priorityUsage, budget: priorityBudget }, "OddsPapi P2 budget soft-limit reached — reducing frequency");
      }
    }
  }
  return true;
}

export async function getOddspapiStatus(): Promise<{
  todayCount: number;
  monthCount: number;
  dailyCap: number;
  monthlyCap: number;
  enabled: boolean;
  byPriority?: Record<string, number>;
  projectedMonthlyUsage: number;
  projectedPct: number;
  throttled: boolean;
}> {
  const key = process.env.ODDSPAPI_KEY;
  const [todayCount, monthCount, effectiveDailyCap, p1, p2, p3, p4] = await Promise.all([
    getOddspapiUsageToday(),
    getOddspapiUsageThisMonth(),
    getEffectiveDailyCap(),
    getOddspapiUsageByPriority("P1"),
    getOddspapiUsageByPriority("P2"),
    getOddspapiUsageByPriority("P3"),
    getOddspapiUsageByPriority("P4"),
  ]);

  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const avgDailyUsage = dayOfMonth > 0 ? monthCount / dayOfMonth : 0;
  const projectedMonthlyUsage = Math.round(avgDailyUsage * daysInMonth);
  const projectedPct = MONTHLY_CAP > 0 ? Math.round((projectedMonthlyUsage / MONTHLY_CAP) * 100) : 0;
  const throttled = projectedPct >= 90;

  return {
    todayCount, monthCount,
    dailyCap: throttled ? Math.round(effectiveDailyCap * 0.5) : effectiveDailyCap,
    monthlyCap: MONTHLY_CAP, enabled: !!key,
    byPriority: { P1: p1, P2: p2, P3: p3, P4: p4 },
    projectedMonthlyUsage,
    projectedPct,
    throttled,
  };
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

export function isOddsPapiCircuitOpen(): boolean {
  return isCircuitOpen(ODDSPAPI_SERVICE);
}

async function fetchOddsPapi<T = unknown>(
  path: string,
  params: Record<string, string | number> = {},
  trackAs = "request",
  priority = "P1",
): Promise<T | null> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) {
    logger.debug("ODDSPAPI_KEY not set — skipping OddsPapi call");
    return null;
  }

  if (!(await canMakeOddspapiRequest(1, priority))) return null;

  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("apiKey", key);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const json = await resilientFetch<Record<string, unknown>>(url.toString(), {
    service: ODDSPAPI_SERVICE,
    timeoutMs: 30_000,
    maxRetries: 3,
    backoffBaseMs: 1000,
  });

  if (json) {
    await trackOddspapiCall(trackAs, 1, priority);
    if ((json as any).data !== undefined) return (json as any).data as T;
    if (Array.isArray(json)) return json as unknown as T;
    return json as unknown as T;
  }

  return null;
}

// ─── Team name normalisation (comprehensive, shared with apiFootball.ts) ─────

function transliterate(s: string): string {
  return s
    .replace(/[àáâãäåæ]/gi, "a")
    .replace(/[èéêë]/gi, "e")
    .replace(/[ìíîï]/gi, "i")
    .replace(/[òóôõöø]/gi, "o")
    .replace(/[ùúûü]/gi, "u")
    .replace(/[ñ]/gi, "n")
    .replace(/[çćč]/gi, "c")
    .replace(/[ýÿ]/gi, "y")
    .replace(/[žźż]/gi, "z")
    .replace(/[šśş]/gi, "s")
    .replace(/[łľ]/gi, "l")
    .replace(/[ß]/gi, "ss")
    .replace(/[đ]/gi, "d")
    .replace(/[ğ]/gi, "g")
    .replace(/[ř]/gi, "r")
    .replace(/[ţť]/gi, "t")
    .replace(/[İı]/g, "i");
}

const TEAM_ALIASES: Record<string, string> = {
  "bodo glimt": "bodoglimt",
  "fk bodoe glimt": "bodoglimt",
  "fk bodo glimt": "bodoglimt",
  "bodoe glimt": "bodoglimt",
  "valerenga": "valerenga",
  "vaalerengen": "valerenga",
  "vaalerenga": "valerenga",
  "tromso": "tromso",
  "tromsoe": "tromso",
  "lillestrom": "lillestrom",
  "lillestrøm": "lillestrom",
  "sarpsborg 08": "sarpsborg",
  "sarpsborg 08 ff": "sarpsborg",
  "stromsgodset": "stromsgodset",
  "stroemsgodset": "stromsgodset",
  "molde": "molde",
  "molde fk": "molde",
  "aalesund": "aalesund",
  "aalesunds": "aalesund",
  "start": "ik start",
  "hoeDD": "hodd",
  "odd ballklubb": "odd",
  "odds bk": "odd",
  "asane": "asane",
  "aasane": "asane",
  "strommen": "strommen",
  "stroemmen": "strommen",
  "stabaek": "stabaek",
  "stabek": "stabaek",
  "bryne": "bryne",
  "bryne fk": "bryne",
  "sogndal": "sogndal",
  "sogndal fotball": "sogndal",
  "haugesund": "haugesund",
  "fk haugesund": "haugesund",
  "egersund": "egersund",
  "sandnes ulf": "sandnes ulf",
  "lyn": "lyn oslo",
  "lyn oslo": "lyn oslo",
  "fc st pauli 1910": "st pauli",
  "st pauli": "st pauli",
  "fc st pauli": "st pauli",
  "1 fc koln": "koln",
  "1 fc koeln": "koln",
  "fc koln": "koln",
  "koln": "koln",
  "cologne": "koln",
  "fc cologne": "koln",
  "fc seoul": "seoul",
  "seoul e land": "seoul",
  "ulsan hyundai": "ulsan",
  "ulsan hyundai fc": "ulsan",
  "ulsan hd": "ulsan",
  "gwangju": "gwangju",
  "gwangju fc": "gwangju",
  "daejeon citizen": "daejeon",
  "daejeon citizen fc": "daejeon",
  "gimnasia lp": "gimnasia la plata",
  "gimnasia l p": "gimnasia la plata",
  "gimnasia la plata": "gimnasia la plata",
  "gimnasia y esgrima lp": "gimnasia la plata",
  "gimnasia m": "gimnasia mendoza",
  "gimnasia y esgrima mendoza": "gimnasia mendoza",
  "independ rivadavia": "independiente rivadavia",
  "independiente rivadavia": "independiente rivadavia",
  "talleres cordoba": "talleres",
  "talleres": "talleres",
  "rosario central": "rosario central",
  "belgrano cordoba": "belgrano",
  "belgrano": "belgrano",
  "sarmiento junin": "sarmiento",
  "sarmiento": "sarmiento",
  "defensa y justicia": "defensa justicia",
  "deportivo riestra": "riestra",
  "estudiantes de rio cuarto": "est rio cuarto",
  "america de cali": "america cali",
  "america": "america cali",
  "millonarios": "millonarios",
  "millonarios fc": "millonarios",
  "liverpool montevideo": "liverpool",
  "liverpool fc montevideo": "liverpool",
  "club nacional": "nacional",
  "nacional montevideo": "nacional",
  "ca nacional": "nacional",
  "fluminense": "fluminense",
  "fluminense fc": "fluminense",
  "colo colo": "colo colo",
  "huachipato": "huachipato",
  "palestino": "palestino",
  "a italiano": "audax italiano",
  "audax italiano": "audax italiano",
  "d la serena": "deportes la serena",
  "deportes la serena": "deportes la serena",
  "concepcion": "concepcion",
  "san marcos de arica": "san marcos arica",
  "cobreloa": "cobreloa",
  "antofagasta": "antofagasta",
  "deportes copiapo": "copiapo",
  "san luis": "san luis",
  "deportes iquique": "iquique",
  "union espanola": "union espanola",
  "curico unido": "curico unido",
  "magallanes": "magallanes",
  "santiago wanderers": "santiago wanderers",
  "rangers de talca": "rangers",
  "recoleta": "recoleta",
  "deportes santa cruz": "santa cruz",
  "union san felipe": "san felipe",
  "ifk varnamo": "varnamo",
  "gif sundsvall": "sundsvall",
  "varbergs bois fc": "varbergs",
  "varbergs bois": "varbergs",
  "landskrona bois": "landskrona",
  "ik brage": "brage",
  "united nordic": "united nordic",
  "riigas fs": "riga fc",
  "rigas fs": "riga fc",
  "riga": "riga fc",
  "riga fc": "riga fc",
  "super nova": "super nova",
  "fk liepaja": "liepaja",
  "liepaja": "liepaja",
  "auda": "auda",
  "fk auda": "auda",
  "bfc daugavpils": "daugavpils",
  "daugavpils": "daugavpils",
  "fs jelgava": "jelgava",
  "jelgava": "jelgava",
  "tukums": "tukums",
  "ogre united": "ogre",
  "grobina": "grobina",
  "alianza lima": "alianza lima",
  "sporting cristal": "sporting cristal",
  "universitario": "universitario",
  "fbc melgar": "melgar",
  "melgar": "melgar",
  "sport huancayo": "sport huancayo",
  "cienciano": "cienciano",
  "ucv moquegua": "ucv moquegua",
  "utc cajamarca": "utc cajamarca",
  "alianza atletico": "alianza atletico",
  "sport boys": "sport boys",
  "adt": "adt",
  "fc cajamarca": "cajamarca",
  "deportivo garcilaso": "garcilaso",
  "comerciantes unidos": "comerciantes",
  "cusco": "cusco fc",
  "cusco fc": "cusco fc",
  "qpr": "queens park rangers",
  "queens park rangers": "queens park rangers",
  "blackburn": "blackburn rovers",
  "blackburn rovers": "blackburn rovers",
  "millwall": "millwall",
  "millwall fc": "millwall",
  "coventry": "coventry city",
  "coventry city": "coventry city",
  "portsmouth": "portsmouth",
  "portsmouth fc": "portsmouth",
  "leicester": "leicester city",
  "leicester city": "leicester city",
  "swansea": "swansea city",
  "swansea city": "swansea city",
  "southampton": "southampton",
  "southampton fc": "southampton",
  "ipswich": "ipswich town",
  "ipswich town": "ipswich town",
  "middlesbrough": "middlesbrough",
  "middlesbrough fc": "middlesbrough",
  "leeds": "leeds",
  "leeds utd": "leeds",
  "wolves": "wolverhampton",
  "wolverhampton": "wolverhampton",
  "wolverhampton wanderers": "wolverhampton",
  "crystal palace": "crystal palace",
  "crystal palace fc": "crystal palace",
  "west ham": "west ham",
  "west ham utd": "west ham",
  "west ham united": "west ham",
  "strasbourg": "strasbourg",
  "rc strasbourg alsace": "strasbourg",
  "rennes": "rennes",
  "stade rennais": "rennes",
  "lecce": "lecce",
  "us lecce": "lecce",
  "fiorentina": "fiorentina",
  "acf fiorentina": "fiorentina",
  "gaziantep fk": "gaziantep",
  "gaziantep": "gaziantep",
  "kayserispor": "kayserispor",
  "fc midtjylland": "midtjylland",
  "midtjylland": "midtjylland",
  "aarhus": "aarhus",
  "agf aarhus": "aarhus",
  "agf": "aarhus",
  "wsg wattens": "wsg tirol",
  "wsg tirol": "wsg tirol",
  "scr altach": "altach",
  "altach": "altach",
  "rapid vienna": "rapid wien",
  "rapid wien": "rapid wien",
  "sk rapid": "rapid wien",
  "sk rapid wien": "rapid wien",
  "panetolikos": "panetolikos",
  "panetolikos gfs": "panetolikos",
  "panaitolikos": "panetolikos",
  "panaitolikos agrinio": "panetolikos",
  "panserraikos": "panserraikos",
  "panserraikos fc": "panserraikos",
  "boston river": "boston river",
  "cerro largo": "cerro largo",
  "cerro largo fc": "cerro largo",
  "otelul galati": "otelul",
  "otelul": "otelul",
  "uta arad": "uta arad",
  "uta": "uta arad",
  "arges pitesti": "arges pitesti",
  "fc arges": "arges pitesti",
  "arges": "arges pitesti",
  "cfr cluj": "cfr cluj",
  "csikszereda": "csikszereda",
  "fk csikszereda": "csikszereda",
  "unirea slobozia": "unirea slobozia",
  "dinamo bucuresti": "dinamo bucuresti",
  "dinamo bucharest": "dinamo bucuresti",
  "universitatea cluj": "universitatea cluj",
  "u cluj": "universitatea cluj",
  "petrolul ploiesti": "petrolul ploiesti",
  "petrolul": "petrolul ploiesti",
  "afc hermannstadt": "hermannstadt",
  "hermannstadt": "hermannstadt",
  "fc hermannstadt": "hermannstadt",
  "universitatea craiova": "u craiova",
  "u craiova": "u craiova",
  "u craiova 1948": "u craiova",
  "rapid": "rapid bucuresti",
  "rapid bucuresti": "rapid bucuresti",
  "rapid bucharest": "rapid bucuresti",
  "fc botosani": "botosani",
  "botosani": "botosani",
  "metaloglobus": "metaloglobus",
  "metaloglobus bucuresti": "metaloglobus",
  "farul constanta": "farul constanta",
  "farul": "farul constanta",
  "fcsb": "fcsb",
  "steaua bucuresti": "fcsb",
  "steaua bucharest": "fcsb",
  "la galaxy": "la galaxy",
  "los angeles galaxy": "la galaxy",
  "toluca": "toluca",
  "deportivo toluca": "toluca",
  "seattle sounders": "seattle sounders",
  "seattle sounders fc": "seattle sounders",
  "tigres uanl": "tigres",
  "club tigres": "tigres",
  "barracas central": "barracas",
  "barracas": "barracas",
  "belgrano de cordoba": "belgrano",
  "independiente": "independiente",
  "ca independiente": "independiente",
  "brage": "brage",
  "norrkoping": "norrkoping",
  "ifk norrkoping": "norrkoping",
  "varberg": "varbergs",
  "sandvikens if": "sandviken",
  "sandviken": "sandviken",
  "ljungskile": "ljungskile",
  "ljungskile sk": "ljungskile",
  "norrby": "norrby",
  "norrby if": "norrby",
  "falkenbergs": "falkenbergs",
  "falkenbergs ff": "falkenbergs",
  "oddevold": "oddevold",
  "ifk goteborg": "goteborg",
  "goteborg": "goteborg",
  "osters if": "osters",
  "osters": "osters",
  "ik sirius": "sirius",
  "sirius": "sirius",
  "vasteras": "vasteras",
  "vasteras sk": "vasteras",
  "vasteras sk fk": "vasteras",
  "orsomarso": "orsomarso",
  "orsomarso sc": "orsomarso",
  "leones fc": "leones",
  "leones": "leones",
  "envigado": "envigado",
  "envigado fc": "envigado",
  "patriotas": "patriotas",
  "patriotas fc": "patriotas",
  "tigres fc": "tigres fc col",
  "quindio": "quindio",
  "deportes quindio": "quindio",
  "real cartagena": "cartagena",
  "barranquilla": "barranquilla",
  "bogota fc": "bogota",
  "depor fc": "depor",
  "union magdalena": "union magdalena",
  "popayan": "popayan",
  "ind yumbo": "yumbo",
  "real soacha": "soacha",
  "st patricks athl": "saint patricks athletic",
  "st patricks athletic": "saint patricks athletic",
  "saint patricks athletic": "saint patricks athletic",
  "saint patricks athletic fc": "saint patricks athletic",
  "st pats": "saint patricks athletic",
  "bohemian fc": "bohemians",
  "bohemians": "bohemians",
  "bohemians fc": "bohemians",
  "shelbourne fc": "shelbourne",
  "shelbourne": "shelbourne",
  "drogheda": "drogheda united",
  "drogheda united": "drogheda united",
  "drogheda united fc": "drogheda united",
  "dundalk": "dundalk",
  "dundalk fc": "dundalk",
  "derry city": "derry city",
  "derry city fc": "derry city",
  "galway united": "galway united",
  "galway united fc": "galway united",
  "shamrock rovers": "shamrock rovers",
  "shamrock rovers fc": "shamrock rovers",
  "obolon brovar kyiv": "obolon brovar",
  "poltava": "poltava",
  "fc poltava": "poltava",
  "h&h export": "hyh sebaco",
  "hyh sebaco": "hyh sebaco",
  "hyh sebaco fc": "hyh sebaco",
  "real esteli": "real esteli",
  "real esteli fc": "real esteli",
  "sokol hostoun": "sokol hostoun",
  "slavia iii": "slavia prague c",
  "slavia prague c": "slavia prague c",
  "sk slavia prague c": "slavia prague c",
  "pribram ii": "pribram b",
  "fk pribram b": "pribram b",
  "pribram b": "pribram b",
  "loko vltavin": "loko prague",
  "fk loko prague": "loko prague",
  "loko prague": "loko prague",
  "nove sady": "nove sady",
  "fk nove sady": "nove sady",
  "kromeriz ii": "hs kromeriz b",
  "sk hs kromeriz b": "hs kromeriz b",
  "ind juniors": "independiente juniors",
  "cd independiente juniors": "independiente juniors",
  "independiente juniors": "independiente juniors",
  "dsd santo domingo": "santo domingo",
  "santo domingo": "santo domingo",
  "qingdao jonoon": "qingdao",
  "qingdao youth island": "qingdao youth island",
  "shandong luneng": "shandong taishan",
  "shandong taishan": "shandong taishan",
  "shandong taishan fc": "shandong taishan",
  "shanghai sipg": "shanghai port",
  "shanghai port": "shanghai port",
  "shanghai port fc": "shanghai port",
  "yunnan yukun": "yunnan yukun",
  "tianjin teda": "tianjin jinmen tiger",
  "tianjin jinmen tiger": "tianjin jinmen tiger",
  "hangzhou greentown": "zhejiang",
  "zhejiang fc": "zhejiang",
  "zhejiang professional": "zhejiang",
  "wuhan three towns": "wuhan three towns",
  "wuhan three towns fc": "wuhan three towns",
  "chengdu better city": "chengdu rongcheng",
  "chengdu rongcheng": "chengdu rongcheng",
  "dalian zhixing": "dalian professional",
  "dalian professional": "dalian professional",
  "dalian professional fc": "dalian professional",
  "henan jianye": "henan songshan longmen",
  "henan songshan longmen": "henan songshan longmen",
  "shenyang urban fc": "shenyang urban",
  "fc arges pitesti": "arges pitesti",
  "cfr 1907 cluj": "cfr cluj",
  "cfr cluj napoca": "cfr cluj",
  "yokohama f marinos": "yokohama f marinos",
  "yokohama f. marinos": "yokohama f marinos",
  "kawasaki frontale": "kawasaki frontale",
  "sanfrecce hiroshima": "sanfrecce hiroshima",
  "v-varen nagasaki": "v varen nagasaki",
  "v varen nagasaki": "v varen nagasaki",
  "kashima": "kashima antlers",
  "kashima antlers": "kashima antlers",
  "urawa": "urawa reds",
  "urawa reds": "urawa reds",
  "urawa red diamonds": "urawa reds",
  "tokyo verdy": "tokyo verdy",
  "jef united chiba": "jef united chiba",
  "jef united": "jef united chiba",
  "cerezo osaka": "cerezo osaka",
  "kyoto sanga": "kyoto sanga",
  "kyoto sanga fc": "kyoto sanga",
  "gangwon fc": "gangwon",
  "gangwon": "gangwon",
  "jeonbuk motors": "jeonbuk hyundai motors",
  "jeonbuk hyundai motors": "jeonbuk hyundai motors",
  "jeonbuk hyundai": "jeonbuk hyundai motors",
  "jeju united": "jeju united",
  "jeju united fc": "jeju united",
  "gimcheon sangmu": "gimcheon sangmu",
  "gimcheon sangmu fc": "gimcheon sangmu",
  "bucheon fc 1995": "bucheon",
  "bucheon fc": "bucheon",
  "bucheon": "bucheon",
  "incheon united": "incheon united",
  "incheon united fc": "incheon united",
  "vancouver whitecaps": "vancouver whitecaps",
  "vancouver whitecaps fc": "vancouver whitecaps",
  "sporting kansas city": "sporting kc",
  "sporting kc": "sporting kc",
  "gks katowice": "gks katowice",
  "motor lublin": "motor lublin",
  "legia warszawa": "legia warsaw",
  "legia warsaw": "legia warsaw",
  "zaglebie lubin": "zaglebie lubin",
  "radomiak radom": "radomiak radom",
  "widzew lodz": "widzew lodz",
  "halmstad": "halmstad bk",
  "halmstad bk": "halmstad bk",
  "if brommapojkarna": "brommapojkarna",
  "brommapojkarna": "brommapojkarna",
  "mjallby aif": "mjallby",
  "mjallby": "mjallby",
  "degerfors if": "degerfors",
  "degerfors": "degerfors",
  "orgryte is": "orgryte",
  "orgryte": "orgryte",
  "hammarby ff": "hammarby",
  "hammarby": "hammarby",
  "djurgardens if": "djurgarden",
  "djurgarden": "djurgarden",
  "djurgardens": "djurgarden",
  "malmo ff": "malmo",
  "malmo": "malmo",
  "sv elversberg": "elversberg",
  "elversberg": "elversberg",
  "karlsruher sc": "karlsruher",
  "karlsruher": "karlsruher",
  "holstein kiel": "holstein kiel",
  "1 fc kaiserslautern": "kaiserslautern",
  "kaiserslautern": "kaiserslautern",
  "arminia bielefeld": "bielefeld",
  "bielefeld": "bielefeld",
  "1 fc nurnberg": "nurnberg",
  "nurnberg": "nurnberg",
  "dynamo dresden": "dynamo dresden",
  "vfl bochum": "bochum",
  "bochum": "bochum",
  "1 fc magdeburg": "magdeburg",
  "magdeburg": "magdeburg",
  "fortuna dusseldorf": "fortuna dusseldorf",
  "grazer ak": "grazer ak",
  "ried": "ried",
  "sv ried": "ried",
  "fenerbahce": "fenerbahce",
  "fenerbahce sk": "fenerbahce",
  "rizespor": "rizespor",
  "caykur rizespor": "rizespor",
  "antalyaspor": "antalyaspor",
  "konyaspor": "konyaspor",
  "fatih karagumruk": "karagumruk",
  "karagumruk": "karagumruk",
  "eyupspor": "eyupspor",
  "brondby": "brondby",
  "brondby if": "brondby",
  "sonderjyske": "sonderjyske",
  "nk osijek": "osijek",
  "osijek": "osijek",
  "nk varazdin": "varazdin",
  "varazdin": "varazdin",
  "hnk gorica": "gorica",
  "gorica": "gorica",
  "nk lokomotiva zagreb": "lokomotiva zagreb",
  "lokomotiva zagreb": "lokomotiva zagreb",
  "nk slaven belupo": "slaven belupo",
  "slaven belupo": "slaven belupo",
  "hnk hajduk split": "hajduk split",
  "hajduk split": "hajduk split",
  "peterborough": "peterborough united",
  "peterborough united": "peterborough united",
  "port vale": "port vale",
  "port vale fc": "port vale",
  "nizhny novgorod": "pari nizhny novgorod",
  "pari nizhny novgorod": "pari nizhny novgorod",
  "fc pari nizhny novgorod": "pari nizhny novgorod",
  "dynamo": "dinamo moscow",
  "dynamo moscow": "dinamo moscow",
  "fk dinamo moscow": "dinamo moscow",
  "rubin": "rubin kazan",
  "rubin kazan": "rubin kazan",
  "fk rubin kazan": "rubin kazan",
  "krylia sovetov": "krylya sovetov",
  "krylya sovetov": "krylya sovetov",
  "krylya sovetov samara": "krylya sovetov",
  "cska moscow": "cska moscow",
  "pfc cska moscow": "cska moscow",
  "spartak moscow": "spartak moscow",
  "fk spartak moscow": "spartak moscow",
  "zenit": "zenit st petersburg",
  "zenit st petersburg": "zenit st petersburg",
  "fc zenit saint petersburg": "zenit st petersburg",
  "lokomotiv moscow": "lokomotiv moscow",
  "fk lokomotiv moscow": "lokomotiv moscow",
  "akhmat grozny": "akhmat grozny",
  "fk akhmat grozny": "akhmat grozny",
  "rostov": "rostov",
  "fk rostov": "rostov",
  "krasnodar": "krasnodar",
  "fk krasnodar": "krasnodar",
  // ── Aliases added from near-miss diagnostics (Apr 17 2026 morning batch) ──
  // Ukrainian Premier League / Druha Liga
  "fc polissya zhytomyr": "polissya",
  "polissya zhytomyr": "polissya",
  "polissya ii": "polissya",
  "fc shakhtar donetsk": "shakhtar",
  "shakhtar donetsk": "shakhtar",
  "fc obolon kyiv": "obolon brovar",
  "obolon brovar": "obolon brovar",
  "obolon kyiv": "obolon brovar",
  "obolon-brovar": "obolon brovar",
  "sc poltava": "sk poltava",
  "sk poltava": "sk poltava",
  "fc epitsentr kamianets-podilskyi": "epitsentr dunayivtsi",
  "epitsentr kamianets-podilskyi": "epitsentr dunayivtsi",
  "epitsentr dunayivtsi": "epitsentr dunayivtsi",
  "karpaty lviv": "karpaty",
  "fc karpaty lviv": "karpaty",
  // Egypt Premier League
  "al mokawloon al arab": "el mokawloon",
  "mokawloon al arab": "el mokawloon",
  "al mokawloon": "el mokawloon",
  "el mokawloon": "el mokawloon",
  "talaea el gaish": "el geish",
  "tala'ea el geish": "el geish",
  "el geish": "el geish",
  // Costa Rica Liga Pro / Ecuador Liga Pro
  "puntarenas fc": "puntarenas",
  "sporting fc": "sporting sj",
  "sporting san jose": "sporting sj",
  "leones futbol club": "leones del norte",
  "leones del norte": "leones del norte",
  "sd aucas": "aucas",
  "manta fc": "manta",
  "deportivo cuenca": "deportivo cuenca",
  // China Super League
  "liaoning tieren fc": "liaoning tieren",
  "shenzhen peng city": "shenzhen peng city",
  "shenzhen peng city srl": "shenzhen peng city",
  "beijing guoan": "beijing guoan",
  "beijing guoan fc": "beijing guoan",
  "chongqing tonglianglong fc srl": "chongqing tongliang long",
  "chongqing tongliang long": "chongqing tongliang long",
  "sichuan jiuniu": "sichuan jiuniu",
  "shenyang urban": "shenyang urban",
  // Brazilian regional (Brasileirão CE / regional Atletico)
  "cf atletas do tirol ce": "atletas do tirol",
  "atletas do tirol": "atletas do tirol",
  "fc atletico ce": "atletico ce",
  "atletico ce": "atletico ce",
  "guarany sc ce": "guarany ce",
  "guarany ce": "guarany ce",
  // Denmark 2nd Division
  "b93 copenhagen": "b 93",
  "b 93": "b 93",
  "hb koege": "hb koge",
  "hb koge": "hb koge",
  "hb køge": "hb koge",
  // Spain Segunda
  "cultural leonesa": "cultural leonesa",
  "cultural y deportiva leonesa": "cultural leonesa",
  // Generic Real Madrid / PSG / national-team friendlies
  "real madrid cf": "real madrid",
  "paris saint-germain fc": "paris saint germain",
  "paris saint-germain": "paris saint germain",
  "psg": "paris saint germain",

  // Apr 17 2026 — additional aliases extracted from UNMATCHED near-miss diagnostics
  // (Pinnacle coverage push, top high-confidence pairs only)
  "fc epitsentr kamianets podilskyi": "epitsentr",
  "karpaty": "karpaty lviv",
  "hodd": "hodd",
  "hoedd il": "hodd",
  "hoedd": "hodd",
  "acs champions fc arges": "arges",
  "asan mugunghwa": "asan",
  "chungnam asan": "asan",
  "chungnam asan fc": "asan",
  "guangzhou e-power": "guangzhou e power",
  "guangzhou e power": "guangzhou e power",
  "guandong gz-power": "guangzhou e power",
  "guandong gz-power fc": "guangzhou e power",
  "guandong gz power fc": "guangzhou e power",
  "meizhou kejia": "meizhou hakka",
  "meizhou hakka": "meizhou hakka",
  "ha noi": "hanoi",
  "ha noi fc": "hanoi",
  "hanoi": "hanoi",
  "hanoi fc": "hanoi",
  "hong linh ha tinh": "ha tinh",
  "ha tinh": "ha tinh",
  "ha tinh fc": "ha tinh",
  "hai phong": "haiphong",
  "haiphong": "haiphong",
  "haiphong fc": "haiphong",
  "javor": "javor ivanjica",
  "fk javor": "javor ivanjica",
  "fk javor ivanjica": "javor ivanjica",
  "javor ivanjica": "javor ivanjica",
  "fk spartak zdrepceva krv": "spartak subotica",
  "fk spartak subotica": "spartak subotica",
  "spartak subotica": "spartak subotica",
  "tsc backa topola": "tsc",
  "fk tsc backa topola": "tsc",
  "tsc": "tsc",
  "sporting cp b": "sporting lisbon b",
  "sporting lisbon b": "sporting lisbon b",
  "felgueiras 1932": "felgueiras",
  "fc felgueiras 1932": "felgueiras",
  "felgueiras": "felgueiras",
  "fortaleza ec": "fortaleza",
  "fortaleza ec ce": "fortaleza",
  "fortaleza": "fortaleza",
  "crb": "crb",
  "cr brasil": "crb",
  "cr brasil al": "crb",
  "chongqing tonglianglong": "chongqing tonglianglong",
  "chongqing tonglianglong fc": "chongqing tonglianglong",
  "shanghai shenhua": "shanghai shenhua",
  "shanghai shenhua fc": "shanghai shenhua",
  "villefranche": "villefranche",
  "fc villefranche beaujolais": "villefranche",
  "villefranche beaujolais": "villefranche",
};

function normalizeTeam(name: string): string {
  let n = transliterate(name)
    .toLowerCase()
    .replace(/[''´`]/g, "'")
    .replace(/\bathl\.\s*/g, "athletic ")
    .replace(/\butd\.\s*/g, "united ")
    .replace(/\bctd\.\s*/g, "city ")
    .replace(/\bf\.\s*/g, " ")
    .replace(/^\d+\.\s*/, "")
    .replace(/\b(fc|sc|ac|cf|fk|sk|sv|utd|united|club|sporting|real|athletic|atletico|atlético|olympique|olympico|inter|internazionale|as|us|ss|afc|bsc|bk|if|ff|ssc|rc|cd|ca|ec|se|ce|cr|rj|sp)\b/g, "")
    .replace(/\b(19\d{2}|20\d{2}|1893|1895)\b/g, "")
    .replace(/\bii\b/g, "")
    .replace(/\biii\b/g, "")
    .replace(/\b\d{2}\s*ff\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (TEAM_ALIASES[n]) return TEAM_ALIASES[n]!;
  return n;
}

function resolveAlias(name: string): string {
  const raw = transliterate(name).toLowerCase()
    .replace(/\bathl\.\s*/g, "athletic ")
    .replace(/\butd\.\s*/g, "united ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ").trim();
  if (TEAM_ALIASES[raw]) return TEAM_ALIASES[raw]!;
  return normalizeTeam(name);
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.split(" ").filter((w) => w.length > 2));
  const wb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) { if (wb.has(w)) overlap++; }
  return overlap / Math.min(wa.size, wb.size);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0]![j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }
  return matrix[b.length]![a.length]!;
}

function teamSimilarity(a: string, b: string): number {
  const na = resolveAlias(a);
  const nb = resolveAlias(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.95;
  const wOvl = wordOverlap(na, nb);
  if (wOvl >= 0.6) return 0.85 + wOvl * 0.1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0;
  const lev = levenshtein(na, nb);
  const levSim = 1 - lev / maxLen;
  return Math.max(levSim, wOvl);
}

function teamMatch(a: string, b: string): boolean {
  return teamSimilarity(a, b) >= 0.70;
}

function teamMatchStrict(a: string, b: string): boolean {
  return teamSimilarity(a, b) >= 0.80;
}

export { transliterate, normalizeTeam, resolveAlias, teamSimilarity };

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

// ─── 1. Daily fixture mapping ─────────────────────────────────────────────────
// Fetches 7 days of fixtures from OddsPapi (hasOdds=true), matches against our
// DB using fuzzy team-name matching, and upserts oddspapi_fixture_map entries.
// Includes detailed per-league diagnostics and unmatched fixture reporting.

export async function runOddspapiFixtureMapping(): Promise<{
  total: number;
  mapped: number;
  newMappings: number;
  unmatchedDb: number;
  unmatchedOp: number;
  perLeague: Record<string, { dbCount: number; mappedCount: number }>;
}> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) {
    logger.info("ODDSPAPI_KEY not set — skipping fixture mapping");
    return { total: 0, mapped: 0, newMappings: 0, unmatchedDb: 0, unmatchedOp: 0, perLeague: {} };
  }

  if (!(await canMakeOddspapiRequest(1))) {
    logger.warn("OddsPapi budget exhausted — skipping fixture mapping");
    return { total: 0, mapped: 0, newMappings: 0, unmatchedDb: 0, unmatchedOp: 0, perLeague: {} };
  }

  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const plusSeven = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  logger.info({ from: todayDate, to: plusSeven }, "Running OddsPapi fixture mapping (7-day window, multi-pass)");

  // Primary fetch: hasOdds=true — high-quality matches with bookmaker data
  const rawFixtures = await fetchOddsPapi<RawFixture[]>("/fixtures", {
    sportId: 10,
    from: todayDate,
    to: plusSeven,
    hasOdds: "true",
  }, "fixtures", "P4");

  if (!rawFixtures || !Array.isArray(rawFixtures)) {
    logger.warn("OddsPapi fixture response was empty or unexpected format");
    return { total: 0, mapped: 0, newMappings: 0, unmatchedDb: 0, unmatchedOp: 0, perLeague: {} };
  }

  let discoveryFixtures: RawFixture[] = [];
  if (await canMakeOddspapiRequest(1, "P4")) {
    const disc = await fetchOddsPapi<RawFixture[]>("/fixtures", {
      sportId: 10,
      from: todayDate,
      to: plusSeven,
    }, "fixtures_discovery", "P4");
    if (disc && Array.isArray(disc)) {
      const existingIds = new Set(rawFixtures.map((f) => extractFixtureStringId(f)).filter(Boolean));
      discoveryFixtures = disc.filter((f) => {
        const id = extractFixtureStringId(f);
        return id && !existingIds.has(id);
      });
      logger.info(
        { hasOddsCount: rawFixtures.length, discoveryOnlyCount: discoveryFixtures.length, totalDiscovery: disc.length },
        "OddsPapi dual-fetch complete: hasOdds + discovery",
      );
    }
  }

  const allFixtures = [...rawFixtures, ...discoveryFixtures];
  logger.info({ count: allFixtures.length, hasOdds: rawFixtures.length, discoveryOnly: discoveryFixtures.length }, "Total OddsPapi fixtures for matching");

  // Get upcoming matches from our DB (next 7 days + 1h back for in-progress)
  const upcoming = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, new Date(now.getTime() - 1 * 60 * 60 * 1000)),
        lte(matchesTable.kickoffTime, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
      ),
    );

  // Track which OddsPapi fixtures were used (for unmatched-OP reporting)
  const usedOpFixtureIds = new Set<string>();
  const perLeague: Record<string, { dbCount: number; mappedCount: number }> = {};

  let mapped = 0;
  let newMappings = 0;
  const unmatchedDbMatches: Array<{ home: string; away: string; date: string; league: string }> = [];

  for (const match of upcoming) {
    const league = match.league ?? "Unknown";
    if (!perLeague[league]) perLeague[league] = { dbCount: 0, mappedCount: 0 };
    perLeague[league].dbCount++;

    // Check if already cached
    const existing = await db
      .select({ id: oddspapiFixtureMapTable.id, oddspapiFixtureId: oddspapiFixtureMapTable.oddspapiFixtureId })
      .from(oddspapiFixtureMapTable)
      .where(eq(oddspapiFixtureMapTable.matchId, match.id))
      .limit(1);

    if (existing[0]) {
      mapped++;
      perLeague[league].mappedCount++;
      await db
        .update(oddspapiFixtureMapTable)
        .set({ cachedAt: new Date() })
        .where(eq(oddspapiFixtureMapTable.id, existing[0].id));
      if (existing[0].oddspapiFixtureId) usedOpFixtureIds.add(existing[0].oddspapiFixtureId);
      continue;
    }

    const matchDate = match.kickoffTime.toISOString().slice(0, 10);

    const dayBefore = new Date(match.kickoffTime.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dayAfter  = new Date(match.kickoffTime.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Pass 1: exact date + strict team match (highest confidence)
    let found = allFixtures.find((f) => {
      const teams = extractTeamNames(f);
      if (!teams) return false;
      return extractFixtureDate(f) === matchDate
        && teamMatchStrict(match.homeTeam, teams.home)
        && teamMatchStrict(match.awayTeam, teams.away);
    });

    // Pass 2: ±1 day tolerance + strict match
    if (!found) {
      found = allFixtures.find((f) => {
        const teams = extractTeamNames(f);
        if (!teams) return false;
        const fd = extractFixtureDate(f);
        return (fd === dayBefore || fd === dayAfter)
          && teamMatchStrict(match.homeTeam, teams.home)
          && teamMatchStrict(match.awayTeam, teams.away);
      });
    }

    // Pass 3: exact date + relaxed match (similarity >= 0.70)
    if (!found) {
      found = allFixtures.find((f) => {
        const teams = extractTeamNames(f);
        if (!teams) return false;
        return extractFixtureDate(f) === matchDate
          && teamMatch(match.homeTeam, teams.home)
          && teamMatch(match.awayTeam, teams.away);
      });
    }

    // Pass 4: ±1 day + relaxed match
    if (!found) {
      found = allFixtures.find((f) => {
        const teams = extractTeamNames(f);
        if (!teams) return false;
        const fd = extractFixtureDate(f);
        return (fd === dayBefore || fd === dayAfter)
          && teamMatch(match.homeTeam, teams.home)
          && teamMatch(match.awayTeam, teams.away);
      });
    }

    // Pass 5: home-only strong match + away similarity >= 0.55 (handles abbreviated away teams)
    if (!found) {
      found = allFixtures.find((f) => {
        const teams = extractTeamNames(f);
        if (!teams) return false;
        const fd = extractFixtureDate(f);
        if (fd !== matchDate && fd !== dayBefore && fd !== dayAfter) return false;
        const homeSim = teamSimilarity(match.homeTeam, teams.home);
        const awaySim = teamSimilarity(match.awayTeam, teams.away);
        return homeSim >= 0.80 && awaySim >= 0.55;
      });
    }

    // Pass 6: best-pair scoring — find the fixture with highest combined similarity.
    // 2026-05-07: lowered combined threshold 0.65 → 0.60 (individual ≥0.55 floors
    // still safety-net against e.g. "Manchester United" / "Manchester City").
    if (!found) {
      let bestScore = 0;
      let bestCandidate: RawFixture | null = null;
      for (const f of allFixtures) {
        const teams = extractTeamNames(f);
        if (!teams) continue;
        const fd = extractFixtureDate(f);
        if (fd !== matchDate && fd !== dayBefore && fd !== dayAfter) continue;
        const homeSim = teamSimilarity(match.homeTeam, teams.home);
        const awaySim = teamSimilarity(match.awayTeam, teams.away);
        const combined = (homeSim + awaySim) / 2;
        if (combined > bestScore && combined >= 0.60 && homeSim >= 0.55 && awaySim >= 0.55) {
          bestScore = combined;
          bestCandidate = f;
        }
      }
      if (bestCandidate) {
        found = bestCandidate;
        const teams = extractTeamNames(bestCandidate)!;
        logger.info(
          { matchId: match.id, home: match.homeTeam, away: match.awayTeam,
            opHome: teams.home, opAway: teams.away, score: bestScore.toFixed(3) },
          "Matched via best-pair scoring (Pass 6)",
        );
      }
    }

    // Pass 7 (2026-05-07): asymmetric strong-match — handles abbreviated-team-
    // name cases where one side matches strongly (e.g. "PK-35" vs "PK-35 Helsinki"
    // = 0.95) but the other side is abbreviated/aliased differently (e.g. "KuPS"
    // vs "Kuopion Palloseura" = 0.22). If max similarity ≥ 0.92 AND opposite
    // side ≥ 0.30 AND only one fixture in the date-window meets these, accept.
    // The "only one" guard prevents accidentally matching when multiple
    // candidates have one strong side but different opposites.
    if (!found) {
      const candidates: Array<{ f: RawFixture; max: number; min: number; combined: number }> = [];
      for (const f of allFixtures) {
        const teams = extractTeamNames(f);
        if (!teams) continue;
        const fd = extractFixtureDate(f);
        if (fd !== matchDate && fd !== dayBefore && fd !== dayAfter) continue;
        const homeSim = teamSimilarity(match.homeTeam, teams.home);
        const awaySim = teamSimilarity(match.awayTeam, teams.away);
        const max = Math.max(homeSim, awaySim);
        const min = Math.min(homeSim, awaySim);
        if (max >= 0.92 && min >= 0.30) {
          candidates.push({ f, max, min, combined: (homeSim + awaySim) / 2 });
        }
      }
      if (candidates.length === 1) {
        found = candidates[0].f;
        const teams = extractTeamNames(found)!;
        logger.info(
          { matchId: match.id, home: match.homeTeam, away: match.awayTeam,
            opHome: teams.home, opAway: teams.away,
            max: candidates[0].max.toFixed(3), min: candidates[0].min.toFixed(3) },
          "Matched via asymmetric strong-match (Pass 7) — single date-window candidate",
        );
      }
    }

    if (found) {
      const fixId = extractFixtureStringId(found);
      if (!fixId) continue;

      await db.insert(oddspapiFixtureMapTable).values({
        matchId: match.id,
        oddspapiFixtureId: fixId,
        cachedAt: new Date(),
      }).onConflictDoUpdate({
        target: oddspapiFixtureMapTable.matchId,
        set: { oddspapiFixtureId: fixId, cachedAt: new Date() },
      });

      logger.info(
        { matchId: match.id, oddspapiFixtureId: fixId, home: match.homeTeam, away: match.awayTeam, league },
        "OddsPapi fixture mapped",
      );

      usedOpFixtureIds.add(fixId);
      mapped++;
      newMappings++;
      perLeague[league].mappedCount++;
    } else {
      // Find the best near-miss for diagnostic logging
      let bestNearMiss = { opHome: "", opAway: "", homeSim: 0, awaySim: 0, combined: 0 };
      for (const f of allFixtures) {
        const teams = extractTeamNames(f);
        if (!teams) continue;
        const fd = extractFixtureDate(f);
        if (fd !== matchDate && fd !== dayBefore && fd !== dayAfter) continue;
        const homeSim = teamSimilarity(match.homeTeam, teams.home);
        const awaySim = teamSimilarity(match.awayTeam, teams.away);
        const combined = (homeSim + awaySim) / 2;
        if (combined > bestNearMiss.combined) {
          bestNearMiss = { opHome: teams.home, opAway: teams.away, homeSim, awaySim, combined };
        }
      }
      if (bestNearMiss.combined > 0.3) {
        logger.info(
          { home: match.homeTeam, away: match.awayTeam, league, matchDate,
            nearMiss: bestNearMiss.opHome + " vs " + bestNearMiss.opAway,
            homeSim: bestNearMiss.homeSim.toFixed(2), awaySim: bestNearMiss.awaySim.toFixed(2),
            combined: bestNearMiss.combined.toFixed(2) },
          "UNMATCHED near-miss diagnostic",
        );
      }
      unmatchedDbMatches.push({ home: match.homeTeam, away: match.awayTeam, date: matchDate, league });
    }
  }

  // Log per-league coverage
  const leagueSummary = Object.entries(perLeague)
    .map(([lg, v]) => ({ league: lg, dbCount: v.dbCount, mappedCount: v.mappedCount, coveragePct: Math.round(v.mappedCount / v.dbCount * 100) }))
    .sort((a, b) => b.dbCount - a.dbCount);

  logger.info({ leagueSummary }, "OddsPapi fixture mapping — per-league coverage");

  // Log unmatched DB matches (first 20) for diagnosis
  if (unmatchedDbMatches.length > 0) {
    logger.info(
      { count: unmatchedDbMatches.length, sample: unmatchedDbMatches.slice(0, 20) },
      "OddsPapi fixture mapping — unmatched DB matches (no OddsPapi equivalent found)",
    );
  }

  // Log OddsPapi fixtures that weren't matched to any DB entry
  const unmatchedOp = rawFixtures.filter((f) => {
    const id = extractFixtureStringId(f);
    return id && !usedOpFixtureIds.has(id);
  });
  const unmatchedOpCount = unmatchedOp.length;
  if (unmatchedOpCount > 0) {
    const sampleUnmatched = unmatchedOp.slice(0, 10).map((f) => {
      const t = extractTeamNames(f);
      return { home: t?.home, away: t?.away, date: extractFixtureDate(f) };
    });
    logger.info(
      { count: unmatchedOpCount, sample: sampleUnmatched },
      "OddsPapi fixture mapping — OddsPapi fixtures not in our DB (first 10)",
    );
  }

  await db.insert(complianceLogsTable).values({
    actionType: "oddspapi_fixture_mapping",
    details: { total: rawFixtures.length, dbMatches: upcoming.length, mapped, newMappings, unmatchedDb: unmatchedDbMatches.length, unmatchedOp: unmatchedOpCount, perLeague: leagueSummary },
    timestamp: new Date(),
  });

  logger.info({ total: allFixtures.length, mapped, newMappings, unmatchedDb: unmatchedDbMatches.length, unmatchedOp: unmatchedOpCount }, "OddsPapi fixture mapping complete");
  return { total: allFixtures.length, mapped, newMappings, unmatchedDb: unmatchedDbMatches.length, unmatchedOp: unmatchedOpCount, perLeague: Object.fromEntries(Object.entries(perLeague)) };
}

// ─── Pinnacle Rescue Mapper ──────────────────────────────────────────────────
// Aggressive second-pass mapper specifically for Pinnacle-league fixtures that
// the standard mapping passes (1-6) rejected. Drops similarity thresholds
// (combined >= 0.50, each side >= 0.40) and widens the date window to ±2 days,
// constrained to fixtures in leagues flagged has_pinnacle_odds=true. Also
// records every proposed pair for human review of potential team aliases.
export async function rescueUnmappedPinnacleFixtures(opts: {
  dryRun?: boolean;
  minCombined?: number;
  minPerSide?: number;
  dateWindowDays?: number;
} = {}): Promise<{
  unmappedBefore: number;
  candidatesEvaluated: number;
  rescued: number;
  proposals: Array<{
    matchId: number; league: string; dbHome: string; dbAway: string; matchDate: string;
    opFixtureId: string; opHome: string; opAway: string; opDate: string;
    homeSim: number; awaySim: number; combined: number; committed: boolean;
  }>;
  rejected: Array<{
    matchId: number; league: string; dbHome: string; dbAway: string;
    bestOpHome: string; bestOpAway: string; bestCombined: number; reason: string;
  }>;
}> {
  const dryRun = opts.dryRun ?? false;
  const minCombined = opts.minCombined ?? 0.50;
  const minPerSide = opts.minPerSide ?? 0.40;
  const windowDays = opts.dateWindowDays ?? 2;

  const key = process.env.ODDSPAPI_KEY;
  if (!key) {
    logger.warn("ODDSPAPI_KEY not set — cannot run Pinnacle rescue");
    return { unmappedBefore: 0, candidatesEvaluated: 0, rescued: 0, proposals: [], rejected: [] };
  }
  if (!(await canMakeOddspapiRequest(2, "P4"))) {
    logger.warn("OddsPapi budget exhausted — skipping rescue mapping");
    return { unmappedBefore: 0, candidatesEvaluated: 0, rescued: 0, proposals: [], rejected: [] };
  }

  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const plusSeven = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Pinnacle-league names
  const pinnLeagues = await db
    .select({ name: competitionConfigTable.name })
    .from(competitionConfigTable)
    .where(eq(competitionConfigTable.hasPinnacleOdds, true));
  const pinnLeagueSet = new Set(pinnLeagues.map((l) => l.name));

  // Unmapped DB fixtures in Pinnacle leagues, next 7 days
  const upcoming = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, new Date(now.getTime() - 1 * 60 * 60 * 1000)),
        lte(matchesTable.kickoffTime, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
      ),
    );
  const unmappedTargets: typeof upcoming = [];
  for (const m of upcoming) {
    if (!m.league || !pinnLeagueSet.has(m.league)) continue;
    const exists = await db
      .select({ id: oddspapiFixtureMapTable.id })
      .from(oddspapiFixtureMapTable)
      .where(eq(oddspapiFixtureMapTable.matchId, m.id))
      .limit(1);
    if (!exists[0]) unmappedTargets.push(m);
  }

  logger.info({ count: unmappedTargets.length, dryRun, minCombined, minPerSide, windowDays }, "Pinnacle rescue: starting");

  if (unmappedTargets.length === 0) {
    return { unmappedBefore: 0, candidatesEvaluated: 0, rescued: 0, proposals: [], rejected: [] };
  }

  // Pull both with-odds and discovery fixtures (same as primary mapper) so we
  // see fixtures that may have been posted without odds yet.
  const withOdds = await fetchOddsPapi<RawFixture[]>("/fixtures", {
    sportId: 10, from: todayDate, to: plusSeven, hasOdds: "true",
  }, "fixtures_rescue", "P4") ?? [];
  let discovery: RawFixture[] = [];
  if (await canMakeOddspapiRequest(1, "P4")) {
    const disc = await fetchOddsPapi<RawFixture[]>("/fixtures", {
      sportId: 10, from: todayDate, to: plusSeven,
    }, "fixtures_rescue_discovery", "P4");
    if (disc && Array.isArray(disc)) {
      const seen = new Set(withOdds.map((f) => extractFixtureStringId(f)).filter(Boolean));
      discovery = disc.filter((f) => {
        const id = extractFixtureStringId(f);
        return id && !seen.has(id);
      });
    }
  }
  const allFixtures = [...withOdds, ...discovery];
  logger.info({ withOdds: withOdds.length, discoveryOnly: discovery.length, total: allFixtures.length }, "Pinnacle rescue: OddsPapi fixtures fetched");

  // Avoid stealing fixtures already bound to other DB matches
  const usedRows = await db
    .select({ id: oddspapiFixtureMapTable.oddspapiFixtureId })
    .from(oddspapiFixtureMapTable);
  const usedOpIds = new Set(usedRows.map((r) => r.id).filter(Boolean));

  let candidatesEvaluated = 0;
  let rescued = 0;
  const proposals: Array<{
    matchId: number; league: string; dbHome: string; dbAway: string; matchDate: string;
    opFixtureId: string; opHome: string; opAway: string; opDate: string;
    homeSim: number; awaySim: number; combined: number; committed: boolean;
  }> = [];
  const rejected: Array<{
    matchId: number; league: string; dbHome: string; dbAway: string;
    bestOpHome: string; bestOpAway: string; bestCombined: number; reason: string;
  }> = [];

  for (const m of unmappedTargets) {
    const matchDateMs = m.kickoffTime.getTime();
    const matchDateStr = m.kickoffTime.toISOString().slice(0, 10);
    const windowMs = windowDays * 24 * 60 * 60 * 1000;

    let best: { f: RawFixture; opHome: string; opAway: string; opDate: string; opId: string;
                homeSim: number; awaySim: number; combined: number } | null = null;
    let bestSwapped: typeof best = null;

    for (const f of allFixtures) {
      const teams = extractTeamNames(f);
      if (!teams) continue;
      const opDate = extractFixtureDate(f);
      if (!opDate) continue;
      const opMs = new Date(opDate + "T12:00:00Z").getTime();
      if (Math.abs(opMs - matchDateMs) > windowMs + 12 * 60 * 60 * 1000) continue;

      const opId = extractFixtureStringId(f);
      if (!opId || usedOpIds.has(opId)) continue;

      candidatesEvaluated++;

      // Try both orientations — OddsPapi sometimes flips home/away
      const homeSim = teamSimilarity(m.homeTeam, teams.home);
      const awaySim = teamSimilarity(m.awayTeam, teams.away);
      const combined = (homeSim + awaySim) / 2;
      if (combined >= minCombined && homeSim >= minPerSide && awaySim >= minPerSide) {
        if (!best || combined > best.combined) {
          best = { f, opHome: teams.home, opAway: teams.away, opDate, opId, homeSim, awaySim, combined };
        }
      }

      const homeSimSw = teamSimilarity(m.homeTeam, teams.away);
      const awaySimSw = teamSimilarity(m.awayTeam, teams.home);
      const combinedSw = (homeSimSw + awaySimSw) / 2;
      if (combinedSw >= minCombined && homeSimSw >= minPerSide && awaySimSw >= minPerSide) {
        if (!bestSwapped || combinedSw > bestSwapped.combined) {
          bestSwapped = { f, opHome: teams.home, opAway: teams.away, opDate, opId, homeSim: homeSimSw, awaySim: awaySimSw, combined: combinedSw };
        }
      }
    }

    // Pick the better of normal vs swapped, with a small bias for normal orientation
    let chosen = best;
    if (bestSwapped && (!best || bestSwapped.combined > best.combined + 0.10)) {
      chosen = bestSwapped;
    }

    if (!chosen) {
      // Diagnostic: find best near-miss regardless of threshold
      let nearMiss = { opHome: "", opAway: "", combined: 0 };
      for (const f of allFixtures) {
        const teams = extractTeamNames(f);
        if (!teams) continue;
        const opDate = extractFixtureDate(f);
        if (!opDate) continue;
        const opMs = new Date(opDate + "T12:00:00Z").getTime();
        if (Math.abs(opMs - matchDateMs) > windowMs + 12 * 60 * 60 * 1000) continue;
        const c = (teamSimilarity(m.homeTeam, teams.home) + teamSimilarity(m.awayTeam, teams.away)) / 2;
        if (c > nearMiss.combined) nearMiss = { opHome: teams.home, opAway: teams.away, combined: c };
      }
      rejected.push({
        matchId: m.id, league: m.league ?? "Unknown", dbHome: m.homeTeam, dbAway: m.awayTeam,
        bestOpHome: nearMiss.opHome, bestOpAway: nearMiss.opAway, bestCombined: nearMiss.combined,
        reason: nearMiss.combined === 0 ? "no candidate within ±2d" : "below loose threshold",
      });
      continue;
    }

    const proposal = {
      matchId: m.id, league: m.league ?? "Unknown",
      dbHome: m.homeTeam, dbAway: m.awayTeam, matchDate: matchDateStr,
      opFixtureId: chosen.opId, opHome: chosen.opHome, opAway: chosen.opAway, opDate: chosen.opDate,
      homeSim: Math.round(chosen.homeSim * 1000) / 1000,
      awaySim: Math.round(chosen.awaySim * 1000) / 1000,
      combined: Math.round(chosen.combined * 1000) / 1000,
      committed: false,
    };

    if (!dryRun) {
      try {
        await db.insert(oddspapiFixtureMapTable).values({
          matchId: m.id,
          oddspapiFixtureId: chosen.opId,
          cachedAt: new Date(),
        }).onConflictDoUpdate({
          target: oddspapiFixtureMapTable.matchId,
          set: { oddspapiFixtureId: chosen.opId, cachedAt: new Date() },
        });
        usedOpIds.add(chosen.opId);
        rescued++;
        proposal.committed = true;
        logger.info(proposal, "Pinnacle rescue: mapped via loose-threshold + swap-aware match");
      } catch (err) {
        logger.warn({ err, matchId: m.id }, "Pinnacle rescue: insert failed");
      }
    } else {
      logger.info(proposal, "Pinnacle rescue (DRY RUN): would map");
    }
    proposals.push(proposal);
  }

  logger.info({
    unmappedBefore: unmappedTargets.length,
    candidatesEvaluated,
    rescued,
    rejectedCount: rejected.length,
    dryRun,
  }, "Pinnacle rescue complete");

  return {
    unmappedBefore: unmappedTargets.length,
    candidatesEvaluated,
    rescued,
    proposals,
    rejected,
  };
}

// ─── Match Diagnostic — exhaustive near-miss analysis for unmapped fixtures ──

export async function runMatchDiagnostic(): Promise<{
  totalUnmapped: number;
  nearMisses: Array<{
    matchId: number; home: string; away: string; league: string; date: string;
    bestMatch: { opHome: string; opAway: string; homeSim: number; awaySim: number; combined: number } | null;
    reason: string;
  }>;
  oddspapiFixtureCount: number;
  leagueSummary: Record<string, { total: number; mapped: number; unmapped: number; coveragePct: number }>;
}> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return { totalUnmapped: 0, nearMisses: [], oddspapiFixtureCount: 0, leagueSummary: {} };

  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const plusSeven = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rawFixtures = await fetchOddsPapi<RawFixture[]>("/fixtures", {
    sportId: 10, from: todayDate, to: plusSeven, hasOdds: "true",
  }, "fixtures_diagnostic", "P4");

  if (!rawFixtures || !Array.isArray(rawFixtures)) {
    return { totalUnmapped: 0, nearMisses: [], oddspapiFixtureCount: 0, leagueSummary: {} };
  }

  const upcoming = await db.select().from(matchesTable).where(
    and(
      eq(matchesTable.status, "scheduled"),
      gte(matchesTable.kickoffTime, new Date(now.getTime() - 1 * 60 * 60 * 1000)),
      lte(matchesTable.kickoffTime, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
    ),
  );

  const mapped = await db.select({ matchId: oddspapiFixtureMapTable.matchId }).from(oddspapiFixtureMapTable);
  const mappedSet = new Set(mapped.map((m) => m.matchId));

  const unmappedMatches = upcoming.filter((m) => !mappedSet.has(m.id));

  const nearMisses = unmappedMatches.map((match) => {
    const matchDate = match.kickoffTime.toISOString().slice(0, 10);
    const dayBefore = new Date(match.kickoffTime.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dayAfter  = new Date(match.kickoffTime.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    let best: { opHome: string; opAway: string; homeSim: number; awaySim: number; combined: number } | null = null;

    for (const f of rawFixtures) {
      const teams = extractTeamNames(f);
      if (!teams) continue;
      const fd = extractFixtureDate(f);
      if (fd !== matchDate && fd !== dayBefore && fd !== dayAfter) continue;
      const homeSim = teamSimilarity(match.homeTeam, teams.home);
      const awaySim = teamSimilarity(match.awayTeam, teams.away);
      const combined = (homeSim + awaySim) / 2;
      if (!best || combined > best.combined) {
        best = { opHome: teams.home, opAway: teams.away, homeSim: +homeSim.toFixed(3), awaySim: +awaySim.toFixed(3), combined: +combined.toFixed(3) };
      }
    }

    let reason = "no_date_match";
    if (best) {
      if (best.combined >= 0.65) reason = "near_miss_fixable";
      else if (best.combined >= 0.4) reason = "partial_name_match";
      else reason = "no_team_match_on_date";
    }

    return {
      matchId: match.id,
      home: match.homeTeam,
      away: match.awayTeam,
      league: match.league ?? "Unknown",
      date: matchDate,
      bestMatch: best,
      reason,
    };
  });

  const leagueSummary: Record<string, { total: number; mapped: number; unmapped: number; coveragePct: number }> = {};
  for (const m of upcoming) {
    const lg = m.league ?? "Unknown";
    if (!leagueSummary[lg]) leagueSummary[lg] = { total: 0, mapped: 0, unmapped: 0, coveragePct: 0 };
    leagueSummary[lg].total++;
    if (mappedSet.has(m.id)) leagueSummary[lg].mapped++;
    else leagueSummary[lg].unmapped++;
  }
  for (const lg of Object.keys(leagueSummary)) {
    leagueSummary[lg]!.coveragePct = Math.round((leagueSummary[lg]!.mapped / leagueSummary[lg]!.total) * 100);
  }

  return { totalUnmapped: unmappedMatches.length, nearMisses, oddspapiFixtureCount: rawFixtures.length, leagueSummary };
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
  // 2026-05-08 maximisation bundle: preserve API structure for markets
  // where bookmakerOutcomeId is numeric (BTTS/DC/FH/TEAM_TOTAL). The
  // marketKey is the parent dict key (matches MARKET_IDS values) and
  // outcomeKey is the inner dict key — typically a readable string
  // like "yes"/"no"/"1x" even when bookmakerOutcomeId is opaque.
  marketKey?: string;
  outcomeKey?: string;
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

function normaliseSelectionToGenericKey(selectionName: string, marketType: string): string {
  const s = selectionName.toLowerCase().trim();
  if (s === "home" || s === "1") return "Home";
  if (s === "draw" || s === "x") return "Draw";
  if (s === "away" || s === "2") return "Away";
  if (s === "yes" || s === "gg") return "Yes";
  if (s === "no" || s === "ng") return "No";
  if (s === "1x") return "1X";
  if (s === "x2") return "X2";
  if (s === "12") return "12";
  if (s.includes("over")) return "Over";
  if (s.includes("under")) return "Under";
  return selectionName;
}

function getGenericSelectionKeys(marketType: string): string[] {
  if (marketType === "MATCH_ODDS") return ["Home", "Draw", "Away"];
  if (marketType === "BTTS") return ["Yes", "No"];
  if (marketType === "DOUBLE_CHANCE") return ["1X", "X2", "12"];
  return ["Home", "Draw", "Away", "Yes", "No", "Over", "Under", "1X", "X2", "12"];
}

function getSelectionOdds(
  selections: RawOddsSelection[],
  marketType: string,
  selectionName: string,
): number | null {
  const ouLine = OU_LINES[marketType];
  const teamTotal = TEAM_TOTAL_LINES[marketType];
  const fhOuLine = FIRST_HALF_OU_LINES[marketType];
  const selLower = selectionName.toLowerCase();

  // 2026-05-08 maximisation bundle: outcomeKey-first matcher for markets
  // where bookmakerOutcomeId is numeric. Tries the parent-dict outcome
  // key (preserved by the updated extractSelections) BEFORE falling
  // through to the legacy bookmakerOutcomeId / label matchers below.
  // This unlocks BTTS/DC/FH/TEAM_TOTAL where the outcome key IS readable
  // even when bookmakerOutcomeId is opaque.
  const wantedMarketId = MARKET_IDS[marketType];
  for (const sel of selections) {
    if (sel.marketKey == null || sel.outcomeKey == null) continue;
    if (wantedMarketId && sel.marketKey !== String(wantedMarketId)) continue;
    const oc = sel.outcomeKey.toLowerCase();
    const odds = sel.odds ?? sel.value ?? sel.price;
    if (!odds || odds <= 1) continue;

    if (marketType === "BTTS") {
      if (selLower.startsWith("yes") && (oc === "yes" || oc === "gg")) return odds;
      if (selLower.startsWith("no") && (oc === "no" || oc === "ng")) return odds;
    } else if (marketType === "DOUBLE_CHANCE") {
      const wanted = selLower === "1x" || selLower.includes("home or draw") ? "1x"
        : selLower === "x2" || selLower.includes("away or draw") ? "x2"
        : selLower === "12" || selLower.includes("home or away") ? "12"
        : null;
      if (wanted && oc === wanted) return odds;
    } else if (marketType === "FIRST_HALF_RESULT") {
      if (selLower === "home" && oc === "home") return odds;
      if (selLower === "draw" && oc === "draw") return odds;
      if (selLower === "away" && oc === "away") return odds;
    } else if (marketType === "MATCH_ODDS") {
      if (selLower === "home" && oc === "home") return odds;
      if (selLower === "draw" && oc === "draw") return odds;
      if (selLower === "away" && oc === "away") return odds;
    }
    // OU/AH/TEAM_TOTAL: outcome key alone isn't sufficient (line is part
    // of the spec) — fall through to the slash-format matcher below.
  }

  for (const sel of selections) {
    const label = (sel.selection ?? sel.label ?? sel.name ?? sel.outcome ?? "").toLowerCase();
    const odds = sel.odds ?? sel.value ?? sel.price;
    if (!odds || odds <= 1) continue;
    const legacyLine = String(sel.line ?? sel.handicap ?? "");

    // ── New OddsPapi format: bookmakerOutcomeId encodes line+direction ──
    // e.g. "home", "draw", "away", "2.5/over", "9.5/under", "10.5/over",
    // "-1.0/home" (AH), "yes"/"no" (BTTS), "1x"/"x2"/"12" (DC).
    // 2026-05-08 Phase A1+A2+B: extended to handle ASIAN_HANDICAP,
    // FIRST_HALF_*, TEAM_TOTAL_*, and broader BTTS/DC label variants
    // (previously only the legacy non-slash branch handled BTTS/DC).
    if (label.includes("/")) {
      const slashIdx = label.lastIndexOf("/");
      const linePart = label.slice(0, slashIdx);
      const dirPart = label.slice(slashIdx + 1);

      // ── ASIAN_HANDICAP (Phase A2): "-1.5/home", "+0.5/away", "0/home" ──
      // Selection name format: "Home -1.5" / "Away +0.5" / "Home 0".
      if ((dirPart === "home" || dirPart === "away") && marketType === "ASIAN_HANDICAP") {
        const handicap = parseFloat(linePart);
        if (Number.isFinite(handicap)) {
          const parts = selectionName.split(/\s+/);
          if (parts.length >= 2) {
            const sideName = parts[0]?.toLowerCase();
            const sideHandicap = parseFloat(parts[1] ?? "0");
            if (sideName === dirPart && Math.abs(handicap - sideHandicap) < 0.01) return odds;
          }
        }
        continue;
      }

      // Match Winner with AH labels — skip for MATCH_ODDS
      if ((dirPart === "home" || dirPart === "away") && marketType === "MATCH_ODDS") {
        continue;
      }

      // ── Over/Under (full match): "2.5/over", "9.5/under", "10.5/over" etc. ──
      if ((dirPart === "over" || dirPart === "under") && ouLine) {
        if (Math.abs(parseFloat(linePart) - parseFloat(ouLine)) < 0.01) {
          if (selLower.includes("over") && dirPart === "over") return odds;
          if (selLower.includes("under") && dirPart === "under") return odds;
        }
      }

      // ── First-half OU (Phase B): "ht_0.5/over", "ht-0.5/under", "1h/0.5/over" ──
      // Allow either prefixed or composite label; line-part may include "ht_" or "1h"
      if (fhOuLine && (dirPart === "over" || dirPart === "under")) {
        const linePartClean = linePart.replace(/^(ht_?|1h_?|fh_?)/, "");
        if (Math.abs(parseFloat(linePartClean) - parseFloat(fhOuLine)) < 0.01
            && (linePart.startsWith("ht") || linePart.startsWith("1h") || linePart.startsWith("fh"))) {
          if (selLower.includes("over") && dirPart === "over") return odds;
          if (selLower.includes("under") && dirPart === "under") return odds;
        }
      }

      // ── Team-total OU (Phase B): "home_0.5/over", "away_1.5/under" ──
      if (teamTotal && (dirPart === "over" || dirPart === "under")) {
        // linePart is e.g. "home_0.5" or "away_1.5" or "home/0.5"
        const ttMatch = /^(home|away)[_/](\d(?:\.\d)?)$/.exec(linePart);
        if (ttMatch && ttMatch[1] === teamTotal.side
            && Math.abs(parseFloat(ttMatch[2]!) - parseFloat(teamTotal.line)) < 0.01) {
          if (selLower.includes("over") && dirPart === "over") return odds;
          if (selLower.includes("under") && dirPart === "under") return odds;
        }
      }

      // ── BTTS (Phase A1): handle slash-format encoding if the API emits one ──
      // Possible formats: "btts/yes", "yes/yes", "yes/no". Be permissive.
      if (marketType === "BTTS") {
        if (selectionName === "Yes" && (dirPart === "yes" || linePart === "yes")) return odds;
        if (selectionName === "No" && (dirPart === "no" || linePart === "no")) return odds;
      }

      // ── DOUBLE_CHANCE (Phase A1): handle slash-format if API emits one ──
      if (marketType === "DOUBLE_CHANCE") {
        if (selectionName === "1X" && (label === "1x" || label === "1/x" || dirPart === "1x")) return odds;
        if (selectionName === "X2" && (label === "x2" || label === "x/2" || dirPart === "x2")) return odds;
        if (selectionName === "12" && (label === "12" || label === "1/2" || dirPart === "12")) return odds;
      }

      // 2026-05-08 diagnostic: log unrecognised labels for the first few
      // unknown patterns of each market_type per process. Helps surface
      // the actual API format if it differs from our assumptions. Limited
      // to avoid log spam.
      logUnknownLabel(marketType, label, selectionName);
      continue; // handled slash-format; don't fall through to legacy logic
    }

    // ── Match Winner (label: "home", "draw", "away" or legacy "1", "x", "2") ──
    if (marketType === "MATCH_ODDS") {
      if (selectionName === "Home" && (label === "home" || label === "1")) return odds;
      if (selectionName === "Draw" && (label === "draw" || label === "x")) return odds;
      if (selectionName === "Away" && (label === "away" || label === "2")) return odds;
    }

    // ── First-half result (Phase B): "ht_home", "1h_home", "ht-draw", "fh_away" ──
    if (marketType === "FIRST_HALF_RESULT") {
      const stripped = label.replace(/^(ht_?|1h_?|fh_?)/, "");
      if (selectionName === "Home" && (stripped === "home" || stripped === "1")) return odds;
      if (selectionName === "Draw" && (stripped === "draw" || stripped === "x")) return odds;
      if (selectionName === "Away" && (stripped === "away" || stripped === "2")) return odds;
    }

    // ── BTTS ──
    if (marketType === "BTTS") {
      if (selectionName === "Yes" && (label === "yes" || label === "gg" || label === "btts_yes")) return odds;
      if (selectionName === "No" && (label === "no" || label === "ng" || label === "btts_no")) return odds;
    }

    // ── Double Chance ──
    if (marketType === "DOUBLE_CHANCE") {
      if (selectionName === "1X" && (label === "1x" || label === "home or draw" || label === "home/draw")) return odds;
      if (selectionName === "X2" && (label === "x2" || label === "draw or away" || label === "draw/away")) return odds;
      if (selectionName === "12" && (label === "12" || label === "home or away" || label === "home/away")) return odds;
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

// 2026-05-08 diagnostic for Phase A1: track first 5 unknown labels per
// market_type per process so the actual API format becomes visible
// without log spam. Reset on process restart.
const unknownLabelsLogged = new Map<string, number>();
function logUnknownLabel(marketType: string, label: string, selectionName: string): void {
  const key = `${marketType}:${label}`;
  const count = unknownLabelsLogged.get(key) ?? 0;
  if (count < 3) {
    logger.debug(
      { marketType, label, selectionName },
      "oddspapi parser: unrecognised slash-format label (first 3 per market_type:label combination)",
    );
    unknownLabelsLogged.set(key, count + 1);
  }
}

function extractSelections(bm: RawBookmakerOdds): RawOddsSelection[] {
  const markets = bm.markets;

  // ── New OddsPapi format: markets is Record<marketId, RawMarket> ──
  // 2026-05-08 maximisation bundle: switched from Object.values to
  // Object.entries so we preserve marketKey + outcomeKey. Previously
  // the parser used only player.bookmakerOutcomeId as the label —
  // works for MATCH_ODDS (where the ID happens to be readable strings
  // like "home"/"draw"/"away") but fails for BTTS/DC/FH/TEAM_TOTAL
  // where the ID is numeric (e.g. "1629824099"). The outcome key in
  // the parent dict is typically the readable form ("yes"/"no"/"1x").
  if (markets && !Array.isArray(markets) && typeof markets === "object") {
    const result: RawOddsSelection[] = [];
    for (const [marketKey, market] of Object.entries(markets as Record<string, RawMarket>)) {
      if (!market?.outcomes) continue;
      for (const [outcomeKey, outcome] of Object.entries(market.outcomes)) {
        for (const player of Object.values(outcome.players ?? {})) {
          if (player.active === false) continue;
          if (!player.price || player.price <= 1) continue;
          result.push({
            label: String(player.bookmakerOutcomeId ?? outcomeKey ?? ""),
            outcomeKey,
            marketKey,
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

  if (!(await canMakeOddspapiRequest(1, "P1"))) return noData;

  const rawData = await fetchOddsPapi<RawOddsResponse>(
    "/odds",
    { fixtureId: oddspapiFixtureId, marketId },
    "odds",
    "P1",
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
// BANNED markets are excluded from prefetch so we never validate or cache them.
// Mirrors the BANNED_MARKETS set in valueDetection.ts.
const PREFETCH_TARGETS: Array<{ marketType: string; selectionName: string }> = [
  // Match Winner (1x2)
  { marketType: "MATCH_ODDS",       selectionName: "Home" },
  { marketType: "MATCH_ODDS",       selectionName: "Draw" },
  { marketType: "MATCH_ODDS",       selectionName: "Away" },
  // Goals O/U — OVER_UNDER_05 and OVER_UNDER_15 added 2026-05-08 (Phase B)
  { marketType: "OVER_UNDER_05",    selectionName: "Over 0.5" },
  { marketType: "OVER_UNDER_05",    selectionName: "Under 0.5" },
  { marketType: "OVER_UNDER_15",    selectionName: "Over 1.5" },
  { marketType: "OVER_UNDER_15",    selectionName: "Under 1.5" },
  { marketType: "OVER_UNDER_25",    selectionName: "Over 2.5" },
  { marketType: "OVER_UNDER_25",    selectionName: "Under 2.5" },
  { marketType: "OVER_UNDER_35",    selectionName: "Over 3.5" },
  { marketType: "OVER_UNDER_35",    selectionName: "Under 3.5" },
  { marketType: "OVER_UNDER_45",    selectionName: "Over 4.5" },
  { marketType: "OVER_UNDER_45",    selectionName: "Under 4.5" },
  // 2026-05-16 subtract bundle: TOTAL_CORNERS_* removed from PREFETCH_TARGETS.
  // Stops writes to odds_snapshots for these markets on every OddsPapi pull.
  // BTTS
  { marketType: "BTTS",              selectionName: "Yes" },
  { marketType: "BTTS",              selectionName: "No" },
  // DOUBLE_CHANCE removed 2026-05-09 (Bundle 1) — banned 2026-04-20, no Pinnacle data
  // (0/0 rows in oddspapi/api_football), mathematically dominated by MATCH_ODDS.
  // Removing from PREFETCH_TARGETS so we stop parsing DC selections on every fixture.
  // ── 2026-05-08 Phase A2 + 2026-05-09 quarter-line expansion: Asian Handicap on the 0.25 grid (-2..+2) ──
  // Quarter-line additions (-1.75 … +1.75) added per Bundle 1 / plan v3 §M1.
  // Resolver `marketTypes.ts:resolveAsianHandicap` already handles WIN/PUSH/LOSS leg-by-leg for 0.25
  // lines. PREFETCH_TARGETS only adds parsing of selection names already returned in the existing
  // /odds payload — zero quota cost.
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home -2" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away -2" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home -1.75" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away -1.75" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home -1.5" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away -1.5" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home -1.25" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away -1.25" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home -1" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away -1" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home -0.75" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away -0.75" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home -0.5" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away -0.5" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home -0.25" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away -0.25" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home 0" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away 0" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home +0.25" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away +0.25" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home +0.5" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away +0.5" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home +0.75" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away +0.75" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home +1" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away +1" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home +1.25" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away +1.25" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home +1.5" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away +1.5" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home +1.75" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away +1.75" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Home +2" },
  { marketType: "ASIAN_HANDICAP",    selectionName: "Away +2" },
  // ── 2026-05-08 Phase B: Team-total Over/Under, common lines ──
  { marketType: "TEAM_TOTAL_HOME_05", selectionName: "Over 0.5" },
  { marketType: "TEAM_TOTAL_HOME_05", selectionName: "Under 0.5" },
  { marketType: "TEAM_TOTAL_HOME_15", selectionName: "Over 1.5" },
  { marketType: "TEAM_TOTAL_HOME_15", selectionName: "Under 1.5" },
  { marketType: "TEAM_TOTAL_HOME_25", selectionName: "Over 2.5" },
  { marketType: "TEAM_TOTAL_HOME_25", selectionName: "Under 2.5" },
  { marketType: "TEAM_TOTAL_AWAY_05", selectionName: "Over 0.5" },
  { marketType: "TEAM_TOTAL_AWAY_05", selectionName: "Under 0.5" },
  { marketType: "TEAM_TOTAL_AWAY_15", selectionName: "Over 1.5" },
  { marketType: "TEAM_TOTAL_AWAY_15", selectionName: "Under 1.5" },
  { marketType: "TEAM_TOTAL_AWAY_25", selectionName: "Over 2.5" },
  { marketType: "TEAM_TOTAL_AWAY_25", selectionName: "Under 2.5" },
  // 2026-05-16 subtract bundle: FIRST_HALF_RESULT + TOTAL_CARDS_55 removed.
  // FIRST_HALF_OU_05/15 KEPT (in plan — bettable first-half goals markets).
  { marketType: "FIRST_HALF_OU_05",   selectionName: "Over 0.5" },
  { marketType: "FIRST_HALF_OU_05",   selectionName: "Under 0.5" },
  { marketType: "FIRST_HALF_OU_15",   selectionName: "Over 1.5" },
  { marketType: "FIRST_HALF_OU_15",   selectionName: "Under 1.5" },
];

export async function prefetchAndStoreOddsPapiOdds(
  earliestKickoff: Date,
  latestKickoff: Date,
  maxFetches = 4,
  matchIdAllowlist?: ReadonlySet<number>,
): Promise<OddsPapiValidationCache> {
  // matchIdAllowlist: when present, restrict the fetch to only those match
  // IDs (skips the league-coverage ranking which biases toward known-good
  // leagues). Used by runDailyDiscoverySweep to actually target anchorless
  // long-tail matches rather than re-pulling fixtures that already have
  // recent oddspapi_pinnacle snapshots.
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

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const pinnacleLeagues = new Set(
    (await db
      .select({ name: competitionConfigTable.name })
      .from(competitionConfigTable)
      .where(eq(competitionConfigTable.hasPinnacleOdds, true))
    ).map((r) => r.name),
  );
  const covGoodSet = new Set(
    coverageRows.filter((r) => r.hasOdds === 1).map((r) => r.league),
  );

  const mappedRows = allRows
    .filter((r) => {
      // Allowlist mode (discovery sweep): only fetch matches the caller
      // explicitly identified. Bypasses league-coverage filtering so genuinely
      // anchorless fixtures in unknown-coverage leagues actually get pulled.
      if (matchIdAllowlist) return matchIdAllowlist.has(r.matchId);
      const cov = coverageMap.get(r.league ?? "");
      if (!cov) return true;
      if (cov.hasOdds === 1) return true;
      return cov.lastChecked < sevenDaysAgo;
    })
    .sort((a, b) => {
      // Allowlist mode: rank by kickoff proximity only — fixtures entering
      // the trading window soonest get pulled first within the budget.
      if (matchIdAllowlist) {
        const ta = a.kickoffTime?.getTime() ?? Infinity;
        const tb = b.kickoffTime?.getTime() ?? Infinity;
        return ta - tb;
      }
      const aKnown = covGoodSet.has(a.league ?? "") || pinnacleLeagues.has(a.league ?? "") ? 1 : 0;
      const bKnown = covGoodSet.has(b.league ?? "") || pinnacleLeagues.has(b.league ?? "") ? 1 : 0;
      if (aKnown !== bKnown) return bKnown - aKnown;
      const aUnknown = coverageMap.has(a.league ?? "") ? 0 : 1;
      const bUnknown = coverageMap.has(b.league ?? "") ? 0 : 1;
      if (aUnknown !== bUnknown) return bUnknown - aUnknown;
      const ta = a.kickoffTime?.getTime() ?? Infinity;
      const tb = b.kickoffTime?.getTime() ?? Infinity;
      if (ta !== tb) return ta - tb;
      const sa = edgeScoreMap.get(a.league ?? "") ?? 50;
      const sb = edgeScoreMap.get(b.league ?? "") ?? 50;
      return sb - sa;
    })
    .slice(0, limit);

  if (mappedRows.length === 0) return cache;

  logger.info({ count: mappedRows.length, limit }, "Pre-fetching OddsPapi Match Odds for value detection");

  for (let i = 0; i < mappedRows.length; i++) {
    const row = mappedRows[i];
    if (!row) break;
    const { matchId, fixtureId, homeTeam, awayTeam } = row;

    // Use MATCH_ODDS market ID — but OddsPapi returns ALL markets regardless.
    // One call per fixture gives us 1x2, goals O/U, corners O/U, BTTS, etc.
    const marketId = MARKET_IDS["MATCH_ODDS"] ?? 101;
    if (!(await canMakeOddspapiRequest(1, "P1"))) break;

    if (i > 0) await new Promise((r) => setTimeout(r, 2400));

    const rawData = await fetchOddsPapi<RawOddsResponse>(
      "/odds",
      { fixtureId, marketId },
      "prefetch_odds",
      "P1",
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

      for (const variant of selectionNameVariants(selName)) {
        matchCache[variant] = validation;
      }

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

      // ALSO persist Pinnacle odds (when present) as a separate snapshot row.
      // Without this, Pinnacle data fetched from OddsPapi lives only in
      // in-memory cache and is lost on restart, leaving Pinnacle validation
      // coverage stuck at ~17% (AF-Pinnacle leagues only). With this, all
      // OddsPapi-mapped fixtures contribute Pinnacle data back to the cycle.
      if (so.pinnacle) {
        await db
          .delete(oddsSnapshotsTable)
          .where(
            and(
              eq(oddsSnapshotsTable.matchId, matchId),
              eq(oddsSnapshotsTable.marketType, marketTypeForSnapshot),
              eq(oddsSnapshotsTable.selectionName, selName),
              eq(oddsSnapshotsTable.source, "oddspapi_pinnacle"),
            ),
          );
        await db.insert(oddsSnapshotsTable).values({
          matchId,
          marketType: marketTypeForSnapshot,
          selectionName: selName,
          backOdds: String(so.pinnacle),
          layOdds: null,
          snapshotTime: now,
          source: "oddspapi_pinnacle",
        });
      }
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

// ─── Load OddsPapi cache from already-stored snapshots (no API calls) ─────────
// Used by the trading cycle to read cached data without spending budget.
// Scheduled bulk prefetch crons populate the DB; this function reads it.

export async function loadOddsPapiCacheFromSnapshots(
  earliestKickoff: Date,
  latestKickoff: Date,
): Promise<OddsPapiValidationCache> {
  const cache: OddsPapiValidationCache = new Map();

  const rows = await db
    .select({
      matchId: oddsSnapshotsTable.matchId,
      marketType: oddsSnapshotsTable.marketType,
      selectionName: oddsSnapshotsTable.selectionName,
      backOdds: oddsSnapshotsTable.backOdds,
      source: oddsSnapshotsTable.source,
    })
    .from(oddsSnapshotsTable)
    .innerJoin(matchesTable, eq(oddsSnapshotsTable.matchId, matchesTable.id))
    .where(
      and(
        inArray(oddsSnapshotsTable.source, ["oddspapi", "oddspapi_pinnacle"]),
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, earliestKickoff),
        lte(matchesTable.kickoffTime, latestKickoff),
      ),
    );

  if (rows.length === 0) return cache;

  // Group by matchId → build validation records.
  // Best-odds come from source="oddspapi"; Pinnacle odds come from
  // source="oddspapi_pinnacle" (persisted by prefetchAndStoreOddsPapiOdds).
  const matchMap = new Map<number, Record<string, { backOdds: number; pinnacleOdds: number | null; marketType: string }>>();
  let pinnacleRowCount = 0;
  for (const row of rows) {
    const odds = parseFloat(row.backOdds ?? "0");
    if (!odds || odds <= 1.01) continue;
    if (!matchMap.has(row.matchId)) matchMap.set(row.matchId, {});
    const m = matchMap.get(row.matchId)!;
    const existing = m[row.selectionName];
    if (row.source === "oddspapi_pinnacle") {
      pinnacleRowCount++;
      if (existing) {
        existing.pinnacleOdds = odds;
      } else {
        m[row.selectionName] = { backOdds: odds, pinnacleOdds: odds, marketType: row.marketType };
      }
    } else {
      if (!existing) {
        m[row.selectionName] = { backOdds: odds, pinnacleOdds: null, marketType: row.marketType };
      } else if (odds > existing.backOdds) {
        existing.backOdds = odds;
        existing.marketType = row.marketType;
      }
    }
  }

  let matchesWithPinnacle = 0;
  for (const [matchId, selMap] of matchMap.entries()) {
    const matchCache: Record<string, OddspapiValidation> = {};
    let hasAnyPinn = false;
    for (const [selName, data] of Object.entries(selMap)) {
      if (data.pinnacleOdds) hasAnyPinn = true;
      const entry: OddspapiValidation = {
        pinnacleOdds: data.pinnacleOdds,
        pinnacleImplied: data.pinnacleOdds ? 1 / data.pinnacleOdds : null,
        bestOdds: data.backOdds,
        bestBookmaker: "OddsPapi",
        oddsUpliftPct: null,
        sharpSoftSpread: null,
        consensusPct: null,
        isContrarian: false,
        pinnacleAligned: false,
        hasPinnacleData: data.pinnacleOdds !== null,
      };
      for (const variant of selectionNameVariants(selName)) {
        matchCache[variant] = entry;
      }
    }
    if (Object.keys(matchCache).length > 0) cache.set(matchId, matchCache);
    if (hasAnyPinn) matchesWithPinnacle++;
  }

  logger.info(
    {
      matchCount: cache.size,
      totalSelections: rows.length,
      pinnacleRows: pinnacleRowCount,
      matchesWithPinnacle,
      pinnaclePct: cache.size ? Math.round((100 * matchesWithPinnacle) / cache.size) : 0,
    },
    "OddsPapi snapshot cache loaded from DB",
  );
  return cache;
}

// ─── Dedicated scheduled bulk prefetch ────────────────────────────────────────
// Called by the morning (6am) and midday (12pm) crons.
// windowDays controls how far ahead we prefetch; maxFetches controls budget use.

export async function runDedicatedBulkPrefetch(
  windowDays: number,
  maxFetches: number,
): Promise<{ fetched: number; totalSelections: number }> {
  const now = new Date();
  const earliest = new Date(now.getTime() + 60 * 60 * 1000); // 1h from now (skip imminent matches)
  const latest   = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  logger.info({ windowDays, maxFetches }, "Dedicated OddsPapi bulk prefetch starting");
  const cache = await prefetchAndStoreOddsPapiOdds(earliest, latest, maxFetches);
  const totalSelections = [...cache.values()].reduce((n, m) => n + Object.keys(m).length, 0);
  logger.info({ fetched: cache.size, totalSelections }, "Dedicated OddsPapi bulk prefetch complete");
  return { fetched: cache.size, totalSelections };
}

// ─── C5 (2026-05-07): kickoff-proximity prefetch ─────────────────────────────
// Replaces uniform every-2hr bulk prefetch. Runs every 15min. Calls the
// existing prefetchAndStoreOddsPapiOdds with TIGHT kickoff-window slices
// per bucket — that helper already filters fixtures by kickoff window,
// orders by priority, and stores via the canonical pipeline. We just
// drive it bucket-by-bucket with allocated budget per bucket.
//
// Buckets:
//   T-0-1h    : drained first, max budget
//   T-1-12h   : second priority
//   T-12-72h  : third
//   T-72h+    : remainder (often 0 calls if earlier buckets consume budget)
//
// Same monthly budget (100k cap, current avg ~2700/day). Reallocates volume
// toward high-information T-0-1h window.

interface KoBucket {
  name: string;
  minHrs: number;
  maxHrs: number;
  budgetShare: number; // fraction of remaining-budget allocated when this bucket runs
}

// 2026-05-08 Option D: rebalanced from prior 50/60/70/100 (effective
// 50/30/14/6) to weight the trading window more heavily. The trading cycle
// fires every 5 min and considers fixtures in T-1h..T-48h, so that's where
// fresh Pinnacle anchors matter most for the pinnaclePreBetFilter to
// pass legitimate edges. T-0-1h still gets adequate coverage (~5x/day per
// match — Pinnacle moves slowly enough at this distance).
//
// New effective shares (assuming fresh budget):
//   T-0-1h     = 0.20 absolute
//   T-1-12h    = 0.50 × 0.80 = 0.40 absolute
//   T-12-72h   = 0.70 × 0.40 = 0.28 absolute
//   T-72h+     = 1.00 × 0.12 = 0.12 absolute
// Trading-window coverage rises from 28% → 68% of budget.
const KO_BUCKETS: KoBucket[] = [
  { name: "T-0-1h",   minHrs: 0,   maxHrs: 1,   budgetShare: 0.20 },
  { name: "T-1-12h",  minHrs: 1,   maxHrs: 12,  budgetShare: 0.50 },
  { name: "T-12-72h", minHrs: 12,  maxHrs: 72,  budgetShare: 0.70 },
  { name: "T-72h+",   minHrs: 72,  maxHrs: 168, budgetShare: 1.00 },
];

export async function runKickoffProximityPrefetch(): Promise<{
  totalFetched: number;
  totalSelections: number;
  bucketsProcessed: Array<{ name: string; fetched: number; budgetAllocated: number }>;
  budgetRemainingAtStart: number;
  budgetRemainingAtEnd: number;
}> {
  if (!process.env.ODDSPAPI_KEY) {
    return { totalFetched: 0, totalSelections: 0, bucketsProcessed: [], budgetRemainingAtStart: 0, budgetRemainingAtEnd: 0 };
  }

  const [daily, effectiveCap] = await Promise.all([getOddspapiUsageToday(), getEffectiveDailyCap()]);
  const reserveForCLV = 50; // CLV/snapshot crons need head-room
  const budgetRemainingAtStart = Math.max(0, effectiveCap - daily - reserveForCLV);

  if (budgetRemainingAtStart <= 0) {
    logger.info({ daily, cap: effectiveCap }, "Kickoff-proximity prefetch — budget exhausted, skipping");
    return { totalFetched: 0, totalSelections: 0, bucketsProcessed: [], budgetRemainingAtStart: 0, budgetRemainingAtEnd: 0 };
  }

  let remaining = budgetRemainingAtStart;
  let totalFetched = 0;
  let totalSelections = 0;
  const bucketsProcessed: Array<{ name: string; fetched: number; budgetAllocated: number }> = [];
  const now = Date.now();

  for (const bucket of KO_BUCKETS) {
    if (remaining <= 0) {
      bucketsProcessed.push({ name: bucket.name, fetched: 0, budgetAllocated: 0 });
      continue;
    }
    const earliest = new Date(now + bucket.minHrs * 3600_000);
    const latest = new Date(now + bucket.maxHrs * 3600_000);
    const allocated = Math.max(1, Math.floor(remaining * bucket.budgetShare));
    const result = await prefetchAndStoreOddsPapiOdds(earliest, latest, allocated);
    const fetched = result.size;
    const selectionsThisBucket = [...result.values()].reduce((n, m) => n + Object.keys(m).length, 0);
    totalFetched += fetched;
    totalSelections += selectionsThisBucket;
    remaining -= fetched;
    bucketsProcessed.push({ name: bucket.name, fetched, budgetAllocated: allocated });
  }

  logger.info(
    {
      totalFetched,
      totalSelections,
      budgetRemainingAtStart,
      budgetRemainingAtEnd: remaining,
      bucketsProcessed,
    },
    "Kickoff-proximity prefetch complete",
  );

  return {
    totalFetched,
    totalSelections,
    bucketsProcessed,
    budgetRemainingAtStart,
    budgetRemainingAtEnd: remaining,
  };
}

// ─── Daily discovery sweep (Option D, 2026-05-08) ──────────────────────────
//
// Counterpart to runKickoffProximityPrefetch. Where the proximity prefetch
// keeps refreshing matches in the trading window (T-1h..T-48h), this sweep
// targets the LONG TAIL: matches in T-12h..T-168h that haven't received a
// Pinnacle anchor in 24h+. Ensures every fixture gets at least one anchor
// before it enters the trading window, even if proximity-prefetch budget
// has rotated past it.
//
// Daily budget cap: 200 calls (~5% of 4,000 daily cap). Cron runs once
// daily at 11:00 UTC (chosen to be after the major European league
// fixture-discovery window and before evening kickoffs).
//
// Returns count of matches anchored. Logged to compliance_logs.
export async function runDailyDiscoverySweep(): Promise<{
  candidatesFound: number;
  pulled: number;
  budgetUsed: number;
  budgetRemaining: number;
}> {
  if (!process.env.ODDSPAPI_KEY) {
    return { candidatesFound: 0, pulled: 0, budgetUsed: 0, budgetRemaining: 0 };
  }

  const SWEEP_DAILY_BUDGET = 200; // ~5% of daily cap; small but meaningful long-tail coverage

  const [daily, effectiveCap] = await Promise.all([
    getOddspapiUsageToday(),
    getEffectiveDailyCap(),
  ]);
  const reserveForCLV = 50;
  const totalRemaining = Math.max(0, effectiveCap - daily - reserveForCLV);
  const budget = Math.min(SWEEP_DAILY_BUDGET, totalRemaining);

  if (budget <= 0) {
    logger.info({ daily, cap: effectiveCap }, "Daily discovery sweep — budget exhausted, skipping");
    return { candidatesFound: 0, pulled: 0, budgetUsed: 0, budgetRemaining: totalRemaining };
  }

  // Find T-12h..T-168h matches WITHOUT a recent oddspapi_pinnacle snapshot.
  // "Recent" = within last 24h. Order by kickoff time so fixtures that will
  // enter the trading window soonest get pulled first.
  const candidatesResult = await db.execute(sql`
    SELECT m.id, m.kickoff_time::text AS kickoff
    FROM matches m
    LEFT JOIN LATERAL (
      SELECT 1 FROM odds_snapshots os
      WHERE os.match_id = m.id
        AND os.source = 'oddspapi_pinnacle'
        AND os.snapshot_time >= NOW() - INTERVAL '24 hours'
      LIMIT 1
    ) recent_pinn ON true
    WHERE m.kickoff_time BETWEEN NOW() + INTERVAL '12 hours' AND NOW() + INTERVAL '168 hours'
      AND m.betfair_event_id IS NOT NULL
      AND recent_pinn IS NULL
    ORDER BY m.kickoff_time
    LIMIT ${budget}
  `);
  const candidateRows = (((candidatesResult as any).rows ?? []) as Array<{
    id: number; kickoff: string;
  }>);

  if (candidateRows.length === 0) {
    logger.info({ budget, daily }, "Daily discovery sweep — no anchorless matches to pull, skipping");
    return { candidatesFound: 0, pulled: 0, budgetUsed: 0, budgetRemaining: totalRemaining };
  }

  // Pass the candidate match IDs through as an allowlist so the prefetch
  // primitive targets exactly the anchorless matches rather than ranking
  // by league-known-good (which biases toward fixtures that already have
  // coverage and undermines the long-tail intent of the sweep).
  const earliest = new Date(candidateRows[0]!.kickoff);
  const latest = new Date(candidateRows[candidateRows.length - 1]!.kickoff);
  const allowlist = new Set(candidateRows.map((r) => r.id));

  const result = await prefetchAndStoreOddsPapiOdds(earliest, latest, candidateRows.length, allowlist);
  const pulled = result.size;

  logger.info(
    {
      candidatesFound: candidateRows.length,
      pulled,
      budgetUsed: pulled,
      budgetRemaining: totalRemaining - pulled,
    },
    "Daily discovery sweep complete",
  );

  await db.insert(complianceLogsTable).values({
    actionType: "oddspapi_daily_discovery_sweep",
    details: {
      candidatesFound: candidateRows.length,
      pulled,
      budgetUsed: pulled,
      windowStart: earliest.toISOString(),
      windowEnd: latest.toISOString(),
    },
    timestamp: new Date(),
  }).catch(() => undefined);

  return {
    candidatesFound: candidateRows.length,
    pulled,
    budgetUsed: pulled,
    budgetRemaining: totalRemaining - pulled,
  };
}

// ─── Log daily budget usage summary ──────────────────────────────────────────

export async function logDailyBudgetSummary(): Promise<void> {
  const [today, month, effectiveCap, p1, p2, p3, p4] = await Promise.all([
    getOddspapiUsageToday(),
    getOddspapiUsageThisMonth(),
    getEffectiveDailyCap(),
    getOddspapiUsageByPriority("P1"),
    getOddspapiUsageByPriority("P2"),
    getOddspapiUsageByPriority("P3"),
    getOddspapiUsageByPriority("P4"),
  ]);

  const byPriority = { P1: p1, P2: p2, P3: p3, P4: p4 };

  await db.insert(complianceLogsTable).values({
    actionType: "oddspapi_daily_budget_summary",
    details: { today, month, dailyCap: effectiveCap, monthlyCap: MONTHLY_CAP, byPriority },
    timestamp: new Date(),
  });

  if (month >= 80_000) {
    await db.insert(learningNarrativesTable).values({
      narrativeType: "budget_alert",
      narrativeText: `OddsPapi monthly usage at ${month}/${MONTHLY_CAP} requests. Approaching limit — sharp-line validation will be throttled to protect remaining budget.`,
      relatedData: { today, month, dailyCap: effectiveCap, monthlyCap: MONTHLY_CAP, byPriority },
      createdAt: new Date(),
    });
  }

  logger.info({ today, month, dailyCap: effectiveCap, monthlyCap: MONTHLY_CAP, byPriority }, "OddsPapi daily budget summary logged");
}

// ─── Closing-line CLV fetch ───────────────────────────────────────────────────
// Called by the pre-kickoff cron every 30 min.
// For each pending bet kicking off in the next 4 hours (was 90 min;
// widened 2026-05-08 Phase D — P3 budget was 5% utilised, expansion has
// huge headroom), fetch the current Pinnacle odds as the TRUE closing
// line and store in closing_pinnacle_odds. This enables professional-
// grade CLV: (placement_odds - closing_odds) / closing_odds × 100.
//
// Why 4h: the 30-min cron means bets in the next 4h get 8 chances to
// have a closing line captured before kickoff (every 30 min), and a
// "near-final" capture at T-30min becomes the de-facto closing line
// for filter / gate-pool inclusion.
//
// 2026-05-08 (Lever 1 fix): grouping was originally by matchId only — the
// code picked ONE market per fixture (preferring MATCH_ODDS), so any
// BTTS/DC/AH/TEAM_TOTAL bet that shared a fixture with a MATCH_ODDS bet
// got silently skipped. Audit showed 0% pinnacle-close coverage on those
// market types vs 75-95% on MATCH_ODDS. Now groups by (matchId, marketType)
// so every market gets its own fetch + Pinnacle extraction.

// 2026-05-08 (CLV multi-source expansion): markets where OddsPapi successfully
// extracts Pinnacle (slash-format labels). The diagnostic confirmed BTTS,
// DOUBLE_CHANCE, FIRST_HALF_*, FIRST_HALF_OU_*, TEAM_TOTAL_* are encoded
// as numeric outcome IDs in OddsPapi (e.g. `1629824099` for BTTS Yes),
// undecodable without per-fixture outcome mapping. For those markets we
// skip OddsPapi entirely and use api_football_real:Pinnacle (189k+ rows
// over 26 markets) which has clean labels. This ALSO saves OddsPapi P3
// budget that would otherwise be wasted on undecodable responses.
const ODDSPAPI_CAPABLE_MARKETS = new Set([
  "MATCH_ODDS", "ASIAN_HANDICAP",
  "OVER_UNDER_05", "OVER_UNDER_15", "OVER_UNDER_25", "OVER_UNDER_35", "OVER_UNDER_45",
  "TOTAL_CORNERS_75", "TOTAL_CORNERS_85", "TOTAL_CORNERS_95", "TOTAL_CORNERS_105", "TOTAL_CORNERS_115",
  "TOTAL_CARDS_25", "TOTAL_CARDS_35", "TOTAL_CARDS_45", "TOTAL_CARDS_55",
]);

interface ResolvedClosing {
  odds: number | null;
  source: "oddspapi_pinnacle" | "api_football_pinnacle" | "derived_from_match_odds" | null;
  dataQuality: "complete" | "partial" | "incomplete";
}

/**
 * Phase 3 C1 (2026-05-08): Tier-2 sharp non-Pinnacle anchor resolver.
 * Only invoked when resolveClosingPinnacle returns null (no Pinnacle
 * available). Queries odds_snapshots for the most-recent pre-kickoff
 * snapshot from a known sharp non-Pinnacle book.
 *
 * Tier-2 list (in priority order):
 *   - oddspapi_smarkets    — Smarkets exchange (sharp money source)
 *   - oddspapi_matchbook   — Matchbook exchange (sharp money source)
 *   - oddspapi_betfair     — Betfair Exchange via OddsPapi feed
 *   - oddspapi_ibcbet / sbobet / sbo — Asian sharp books (Pinnacle peers)
 *   - oddspapi_bet365      — softest of the tier; included because Bet365
 *                            tracks sharp money on big markets, but ranked
 *                            lowest within Tier 2 for soft-book tendency.
 *   - betfair_exchange     — 2026-05-10 addition: raw Betfair Exchange book
 *                            sweep (best back at snapshot). Lowest priority
 *                            within Tier 2; primary purpose is to provide
 *                            a closing anchor for markets Pinnacle does NOT
 *                            price (e.g. BTTS — Pinnacle lacks BTTS via
 *                            api-football and oddspapi for our leagues).
 *                            Without this, BTTS bets always settle with
 *                            clv_pct=NULL, blocking CLV-driven learning.
 *
 * Diversity guard for the gate is at the SCOPE level (Path P+ view requires
 * ≥2 distinct Tier-2 books per scope to admit). This function returns a
 * single snapshot per bet — no diversity checking here.
 */
const TIER_2_SOURCE_PRIORITY = [
  "oddspapi_smarkets",
  "oddspapi_matchbook",
  "oddspapi_betfair",
  "oddspapi_ibcbet",
  "oddspapi_sbobet",
  "oddspapi_sbo",
  "oddspapi_bet365",
  "betfair_exchange",
];

async function resolveTier2Anchor(args: {
  matchId: number;
  marketType: string;
  selectionName: string;
}): Promise<{ odds: number; source: string } | null> {
  // Pull all candidate snapshots from priority list in one query, ordered
  // by (priority, snapshot_time DESC). Take the highest-priority+freshest.
  // 2026-05-09 (Bundle 4): switched array binding from `ANY(${arr}::text[])`
  // — which Drizzle was interpolating as a record tuple causing "cannot cast
  // type record to text[]" runtime errors observed on AH closing-line CLV
  // captures — to explicit IN list via sql.join. Functionally identical;
  // unblocks Tier-2 anchor lookups for AH bets where Pinnacle is unavailable.
  const sourceList = sql.join(
    TIER_2_SOURCE_PRIORITY.map((s) => sql`${s}`),
    sql`, `,
  );
  const rows = await db.execute(sql`
    SELECT source, back_odds::float8 AS odds, snapshot_time
    FROM odds_snapshots
    WHERE match_id = ${args.matchId}
      AND market_type = ${args.marketType}
      AND selection_name = ${args.selectionName}
      AND source IN (${sourceList})
      AND back_odds::numeric > 1.01
      AND snapshot_time > NOW() - INTERVAL '24 hours'
    ORDER BY snapshot_time DESC
    LIMIT 50
  `);
  const list = (((rows as any).rows ?? []) as Array<{
    source: string; odds: number; snapshot_time: string;
  }>);
  if (list.length === 0) return null;

  // Pick best per priority — earliest in TIER_2_SOURCE_PRIORITY wins.
  for (const preferredSource of TIER_2_SOURCE_PRIORITY) {
    const match = list.find((r) => r.source === preferredSource);
    if (match) return { odds: match.odds, source: match.source };
  }
  return null;
}

/**
 * Multi-source closing-line Pinnacle resolver.
 *   1. OddsPapi (only for ODDSPAPI_CAPABLE_MARKETS, only if a pre-fetched
 *      Pinnacle bookmaker is supplied for this fixture+market).
 *   2. api_football_real:Pinnacle most recent within 6h.
 *   3. derived_from_match_odds for DOUBLE_CHANCE only.
 * Returns null odds when nothing usable is available.
 */
async function resolveClosingPinnacle(args: {
  matchId: number;
  marketType: string;
  selectionName: string;
  oddspapiPinnacleBookmaker?: RawBookmakerOdds | null;
}): Promise<ResolvedClosing> {
  // Strategy A — OddsPapi
  if (ODDSPAPI_CAPABLE_MARKETS.has(args.marketType) && args.oddspapiPinnacleBookmaker) {
    const sels = extractSelections(args.oddspapiPinnacleBookmaker);
    const direct = getSelectionOdds(sels, args.marketType, args.selectionName);
    if (direct && direct > 1) {
      return { odds: direct, source: "oddspapi_pinnacle", dataQuality: "complete" };
    }
    const genericKey = normaliseSelectionToGenericKey(args.selectionName, args.marketType);
    const generic = getSelectionOdds(sels, args.marketType, genericKey);
    if (generic && generic > 1) {
      return { odds: generic, source: "oddspapi_pinnacle", dataQuality: "complete" };
    }
  }

  // Strategy B — api_football_real:Pinnacle
  const afResult = (await db.execute(sql`
    SELECT back_odds::float8 AS odds
    FROM odds_snapshots
    WHERE match_id = ${args.matchId}
      AND market_type = ${args.marketType}
      AND selection_name = ${args.selectionName}
      AND source = 'api_football_real:Pinnacle'
      AND snapshot_time > NOW() - INTERVAL '6 hours'
    ORDER BY snapshot_time DESC LIMIT 1
  `)) as unknown as { rows: Array<{ odds: number | null }> };
  const afOdds = afResult.rows[0]?.odds;
  if (afOdds && afOdds > 1) {
    return { odds: afOdds, source: "api_football_pinnacle", dataQuality: "partial" };
  }

  // Strategy C — derived_from_match_odds (DC only)
  if (args.marketType === "DOUBLE_CHANCE") {
    const dResult = (await db.execute(sql`
      SELECT back_odds::float8 AS odds
      FROM odds_snapshots
      WHERE match_id = ${args.matchId}
        AND market_type = 'DOUBLE_CHANCE'
        AND selection_name = ${args.selectionName}
        AND source = 'derived_from_match_odds'
        AND snapshot_time > NOW() - INTERVAL '6 hours'
      ORDER BY snapshot_time DESC LIMIT 1
    `)) as unknown as { rows: Array<{ odds: number | null }> };
    const dOdds = dResult.rows[0]?.odds;
    if (dOdds && dOdds > 1) {
      return { odds: dOdds, source: "derived_from_match_odds", dataQuality: "partial" };
    }
  }

  return { odds: null, source: null, dataQuality: "incomplete" };
}

export async function fetchAndStoreClosingLineForPendingBets(): Promise<{
  checked: number;
  updated: number;
  skipped: number;
  bySource?: Record<string, number>;
}> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return { checked: 0, updated: 0, skipped: 0 };

  // Phase 4 (2026-05-14): tighten the closing-line snap window to
  // kickoff ± 90 seconds. The prior 4-hour window meant most bets got
  // captured at T-1h to T-3:45 — Pinnacle moves significantly in the
  // final hour (and the final 15 min especially), so an early snap
  // systematically biases CLV downward, with the worst hit on
  // women's / lower-tier international books that adjust latest.
  //
  // Paired with the cron-tick increase from */15 to */1 in
  // scheduler.ts so every bet gets ~2 chances to capture in its
  // [T-90s, T+0] window. Once captured (closingPinnacleOdds NOT NULL),
  // subsequent ticks skip — the snap stays at whatever moment in the
  // last 90s the cron actually fired.
  const now = new Date();
  const in90s = new Date(now.getTime() + 90 * 1000);

  // Pre-join with matches to keep kickoffTime on the result rows — we
  // log the per-bet snap_delta_seconds (kickoff - now) on every capture
  // so the operator can audit timing in compliance_logs.
  const pendingBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      oddsAtPlacement: paperBetsTable.oddsAtPlacement,
      closingPinnacleOdds: paperBetsTable.closingPinnacleOdds,
      kickoffTime: matchesTable.kickoffTime,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        sql`${matchesTable.kickoffTime} >= ${now}`,
        sql`${matchesTable.kickoffTime} <= ${in90s}`,
        sql`${paperBetsTable.closingPinnacleOdds} IS NULL`,
      ),
    );

  if (pendingBets.length === 0) {
    logger.debug("Pre-kickoff CLV cron: no pending bets kicking off in next 4h");
    return { checked: 0, updated: 0, skipped: 0 };
  }

  logger.info({ count: pendingBets.length }, "Pre-kickoff CLV cron: fetching Pinnacle closing odds");

  let updated = 0;
  let skipped = 0;

  // Group by (matchId, marketType) so every market gets its own OddsPapi fetch.
  // Cache fixtureId per matchId — one DB lookup per fixture, not per (fixture,market).
  const byMatchMarket = new Map<string, { matchId: number; marketType: string; bets: typeof pendingBets }>();
  for (const bet of pendingBets) {
    const k = `${bet.matchId}|${bet.marketType}`;
    let group = byMatchMarket.get(k);
    if (!group) {
      group = { matchId: bet.matchId, marketType: bet.marketType, bets: [] };
      byMatchMarket.set(k, group);
    }
    group.bets.push(bet);
  }

  // Pre-resolve oddspapi fixture IDs only for capable-market groups
  // (skips DB lookups for matches whose only pending bets are BTTS/DC/etc).
  const fixtureIdCache = new Map<number, number | null>();
  for (const { matchId, marketType } of byMatchMarket.values()) {
    if (!ODDSPAPI_CAPABLE_MARKETS.has(marketType)) continue;
    if (!fixtureIdCache.has(matchId)) {
      fixtureIdCache.set(matchId, await getOddspapiFixtureId(matchId));
    }
  }

  const bySource: Record<string, number> = {};

  for (const { matchId, marketType, bets } of byMatchMarket.values()) {
    let oddspapiPinnacleBookmaker: RawBookmakerOdds | null = null;

    // Pre-fetch OddsPapi only for capable markets. For BTTS/DC/FH/TEAM_TOTAL
    // we bypass OddsPapi entirely (the slash-format parser cannot decode
    // the numeric outcome IDs Pinnacle uses for those markets), going
    // straight to api_football_real:Pinnacle via resolveClosingPinnacle.
    if (ODDSPAPI_CAPABLE_MARKETS.has(marketType)) {
      const oddspapiId = fixtureIdCache.get(matchId);
      const marketId = MARKET_IDS[marketType];
      if (oddspapiId && marketId) {
        if (!(await canMakeOddspapiRequest(1, "P3"))) {
          logger.warn("Pre-kickoff CLV cron: P3 budget exhausted — falling through to AF Pinnacle for remaining markets");
        } else {
          // Rate-limit guard
          await new Promise((r) => setTimeout(r, 2400));
          const rawData = await fetchOddsPapi<RawOddsResponse>(
            "/odds",
            { fixtureId: oddspapiId, marketId },
            "closing_line",
            "P3",
          );
          if (rawData) {
            const bookmakers = extractBookmakers(rawData as RawOddsResponse);
            oddspapiPinnacleBookmaker =
              bookmakers.find((b) => getBookmakerSlug(b).includes("pinnacle")) ?? null;

            // 2026-05-08 maximisation bundle: record every bookmaker we
            // saw in the catalog. Powers future bet-spreading to lower-
            // commission venues (Smarkets/Matchbook) and best-price
            // execution. Fire-and-forget — never blocks closing-line.
            try {
              const { recordBookmakerObservations } = await import("./oddsPapiBookmakerCatalog");
              await recordBookmakerObservations({
                matchId,
                marketType,
                bookmakerSlugs: bookmakers.map((b) => getBookmakerSlug(b)),
              });

              // Also persist non-Pinnacle bookmakers' odds so the
              // bestPriceFinder can compare across venues. We capture
              // the first matching selection per bookmaker for each
              // generic key in this market.
              for (const bm of bookmakers) {
                const slug = getBookmakerSlug(bm);
                if (!slug || slug.includes("pinnacle")) continue;
                const sels = extractSelections(bm);
                for (const bet of bets) {
                  const odds = getSelectionOdds(sels, marketType, bet.selectionName);
                  if (!odds || odds <= 1) continue;
                  await db.execute(sql`
                    INSERT INTO odds_snapshots (
                      match_id, market_type, selection_name, source,
                      back_odds, snapshot_time
                    ) VALUES (
                      ${matchId}, ${marketType}, ${bet.selectionName}, ${`oddspapi_${slug}`},
                      ${odds}, NOW()
                    )
                  `);
                }
              }
            } catch (catErr) {
              logger.debug({ catErr }, "Bookmaker catalog / multi-book capture skipped (non-fatal)");
            }
          }
        }
      }
    }

    for (const bet of bets) {
      try {
        const resolved = await resolveClosingPinnacle({
          matchId,
          marketType,
          selectionName: bet.selectionName,
          oddspapiPinnacleBookmaker,
        });

        // Phase 3 C1 (2026-05-08): if Pinnacle resolved → Tier 1 anchor.
        // If not → fall through to Tier-2 sharp non-Pinnacle anchors via
        // odds_snapshots. We've been recording these (Bet365, Smarkets,
        // Matchbook, IBC, etc.) since the maximisation bundle, so the
        // data is already in the table — just need to query and tag tier=2.
        // Path P pool stays Tier-1-only; Path P+ admits Tier 1+2.
        let clvSourceTag: string | null = null;
        let clvSourceTier: number | null = null;
        let closingOdds: number | null = null;
        let dataQuality: string | null = null;

        if (resolved.odds && resolved.source) {
          closingOdds = resolved.odds;
          clvSourceTag =
            resolved.source === "derived_from_match_odds" ? "pinnacle_derived" : "pinnacle";
          clvSourceTier = 1;
          dataQuality = resolved.dataQuality;
        } else {
          // Tier-2 fallthrough: query odds_snapshots for the most-recent
          // pre-kickoff snapshot from a known sharp non-Pinnacle book.
          const tier2 = await resolveTier2Anchor({
            matchId,
            marketType,
            selectionName: bet.selectionName,
          });
          if (tier2) {
            closingOdds = tier2.odds;
            clvSourceTag = tier2.source;
            clvSourceTier = 2;
            dataQuality = "tier_2_sharp_anchor";
          }
        }

        if (closingOdds == null) {
          // Bundle 1B.4 (2026-05-16): miss-case audit. Previously the snap
          // pipeline wrote pinnacle_close_capture compliance rows ONLY on
          // success — misses were silent skipped++ increments with no
          // per-bet diagnostic. This blocked root-cause analysis of
          // OU/BTTS coverage gaps (audit showed ~30% miss rate on OU_*
          // / BTTS even when other bets on the SAME match snapped fine —
          // a per-(market, selection) Pinnacle quote shape, not a cron
          // timing issue). Fire-and-forget; never blocks the loop.
          const snapDeltaSeconds = Math.round(
            (new Date(bet.kickoffTime).getTime() - Date.now()) / 1000,
          );
          void db.insert(complianceLogsTable).values({
            actionType: "pinnacle_close_capture",
            details: {
              outcome: "miss",
              betId: bet.id,
              matchId,
              marketType,
              selectionName: bet.selectionName,
              snapDeltaSeconds,
              // reason hints — populated to whatever's available; helps
              // distinguish "no Pinnacle quote at all" from "tier-2 fallback
              // also missed". oddspapiPinnacleBookmaker null = OddsPapi
              // returned no Pinnacle for this market_type (likely line
              // mismatch on AH / Pinnacle-doesn't-quote on BTTS).
              oddspapiPinnacleAvailable: oddspapiPinnacleBookmaker !== null,
              tier2FallbackAttempted: true,
            },
            timestamp: new Date(),
          });
          skipped++;
          continue;
        }

        const placementOdds = Number(bet.oddsAtPlacement);
        const clvPct = closingOdds > 1
          ? Math.round(((placementOdds - closingOdds) / closingOdds) * 100 * 1000) / 1000
          : null;

        await db
          .update(paperBetsTable)
          .set({
            closingPinnacleOdds: String(closingOdds),
            ...(clvPct != null ? { clvPct: String(clvPct) } : {}),
            clvSource: clvSourceTag,
            clvDataQuality: dataQuality,
            clvSourceTier: clvSourceTier as any,
          } as any)
          .where(eq(paperBetsTable.id, bet.id));

        // Only snapshot Pinnacle anchors (Tier 1) — pinnacle_odds_snapshots
        // is the Pinnacle line-movement table; Tier-2 has its own snapshot
        // path via odds_snapshots already.
        if (clvSourceTier === 1) {
          await storePinnacleSnapshot({
            betId: bet.id,
            matchId,
            marketType: bet.marketType,
            selectionName: bet.selectionName,
            snapshotType: "closing",
            pinnacleOdds: closingOdds,
          });
        }

        const sourceForCount = clvSourceTag ?? "unknown";
        bySource[sourceForCount] = (bySource[sourceForCount] ?? 0) + 1;

        // Phase 4 (2026-05-14): per-bet capture audit. Records the gap
        // between snap time and kickoff time so the operator can verify
        // we're consistently inside the T-0 ± 90s window (and isn't
        // silently regressing for women's / international scopes where
        // late line moves matter most). Fire-and-forget — never blocks
        // the CLV write.
        const snapDeltaSeconds = Math.round(
          (new Date(bet.kickoffTime).getTime() - Date.now()) / 1000,
        );
        void db.insert(complianceLogsTable).values({
          actionType: "pinnacle_close_capture",
          details: {
            betId: bet.id,
            matchId,
            marketType,
            selectionName: bet.selectionName,
            snapDeltaSeconds,
            clvSource: clvSourceTag,
            clvSourceTier,
            placementOdds,
            closingOdds,
            clvPct,
          },
          timestamp: new Date(),
        });

        logger.info(
          {
            betId: bet.id, matchId, marketType, selection: bet.selectionName,
            placementOdds, closingOdds, clvPct, snapDeltaSeconds,
            source: clvSourceTag, tier: clvSourceTier, dataQuality,
          },
          "Pre-kickoff CLV stored (multi-anchor) + snapshot C",
        );
        updated++;
      } catch (err) {
        logger.error({ err, betId: bet.id, matchId, marketType }, "Closing line resolver error — skipping bet");
        skipped++;
      }
    }
  }

  logger.info(
    { checked: pendingBets.length, updated, skipped, bySource, marketGroups: byMatchMarket.size, oddspapiFixtures: fixtureIdCache.size },
    "Pre-kickoff CLV cron complete (multi-source resolver)",
  );
  return { checked: pendingBets.length, updated, skipped, bySource };
}

/**
 * One-shot backfill: walk every settled paper bet that has no closing line
 * yet and run the multi-source resolver. Recovers CLV for the historical
 * BTTS/DC/FH/TEAM_TOTAL bets that were structurally locked out by the
 * OddsPapi numeric-ID encoding bug. Idempotent — safe to re-run.
 *
 * Backfill cannot reach OddsPapi because kickoff has already passed, so
 * only Strategies B (api_football_real:Pinnacle) and C (derived_from_
 * match_odds) apply. Bumps Path P evaluation_pool size meaningfully.
 */
export async function backfillClosingPinnacleFromMultiSource(opts: {
  limit?: number;
} = {}): Promise<{
  scanned: number; updated: number; skipped: number; bySource: Record<string, number>;
}> {
  const limit = opts.limit ?? 5000;

  const settledBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      oddsAtPlacement: paperBetsTable.oddsAtPlacement,
    })
    .from(paperBetsTable)
    .where(
      and(
        inArray(paperBetsTable.status, ["won", "lost", "void", "push"]),
        sql`${paperBetsTable.closingPinnacleOdds} IS NULL`,
        sql`${paperBetsTable.deletedAt} IS NULL`,
      ),
    )
    .limit(limit);

  let updated = 0;
  let skipped = 0;
  const bySource: Record<string, number> = {};

  for (const bet of settledBets) {
    try {
      const resolved = await resolveClosingPinnacle({
        matchId: bet.matchId,
        marketType: bet.marketType,
        selectionName: bet.selectionName,
        oddspapiPinnacleBookmaker: null,
      });

      if (!resolved.odds || !resolved.source) {
        skipped++;
        continue;
      }

      const placementOdds = Number(bet.oddsAtPlacement);
      const clvPct = resolved.odds > 1
        ? Math.round(((placementOdds - resolved.odds) / resolved.odds) * 100 * 1000) / 1000
        : null;
      const clvSourceTag =
        resolved.source === "derived_from_match_odds" ? "pinnacle_derived" : "pinnacle";

      await db
        .update(paperBetsTable)
        .set({
          closingPinnacleOdds: String(resolved.odds),
          ...(clvPct != null ? { clvPct: String(clvPct) } : {}),
          clvSource: clvSourceTag,
          clvDataQuality: resolved.dataQuality,
        })
        .where(eq(paperBetsTable.id, bet.id));

      bySource[resolved.source] = (bySource[resolved.source] ?? 0) + 1;
      updated++;
    } catch (err) {
      logger.error({ err, betId: bet.id }, "Backfill: error resolving — skipping");
      skipped++;
    }
  }

  logger.info(
    { scanned: settledBets.length, updated, skipped, bySource },
    "Closing-line multi-source backfill complete",
  );
  return { scanned: settledBets.length, updated, skipped, bySource };
}

// ─── DIAGNOSTIC v2: dump the raw market→outcome→player KEY structure for the
// Pinnacle bookmaker. The previous diagnostic flattened via extractSelections
// (lines 2115-2144) which discards both the marketId KEY (101, 102, 103, ...)
// and the outcomeKey ("home"/"yes"/"1x"/etc) before returning. That's why
// we saw numeric outcome IDs for BTTS — the parser used `bookmakerOutcomeId`
// (which IS numeric for BTTS) instead of the outcome KEY (which should be
// "yes"/"no" — readable). This v2 endpoint preserves the full tree so we
// can verify whether the outcome keys for BTTS/DC/FH are decodable.
//
// Truncated to first 8 markets, first 6 outcomes per market, first 2 players
// per outcome — enough structure to draw conclusions without overflowing.

export async function debugOddsPapiRawStructure(args: {
  matchId: number;
  marketType: string;
}): Promise<{
  matchId: number;
  marketType: string;
  oddspapiFixtureId: number | null;
  oddspapiMarketId: number | null;
  pinnacleFound: boolean;
  marketKeys: string[];
  marketsTree: Record<string, {
    bookmakerMarketId?: string;
    outcomes: Record<string, {
      playerSamples: Array<{ playerKey: string; bookmakerOutcomeId?: string; price?: number; active?: boolean }>;
    }>;
  }>;
  notes: string[];
}> {
  const notes: string[] = [];

  const oddspapiFixtureId = await getOddspapiFixtureId(args.matchId);
  if (!oddspapiFixtureId) {
    notes.push("getOddspapiFixtureId returned null");
    return {
      matchId: args.matchId, marketType: args.marketType,
      oddspapiFixtureId: null, oddspapiMarketId: null,
      pinnacleFound: false, marketKeys: [], marketsTree: {}, notes,
    };
  }

  const oddspapiMarketId = MARKET_IDS[args.marketType] ?? null;

  const rawData = await fetchOddsPapi<RawOddsResponse>(
    "/odds",
    oddspapiMarketId
      ? { fixtureId: oddspapiFixtureId, marketId: oddspapiMarketId }
      : { fixtureId: oddspapiFixtureId },
    "diagnostic_v2",
    "P3",
  );
  if (!rawData) {
    notes.push("fetchOddsPapi returned null");
    return {
      matchId: args.matchId, marketType: args.marketType,
      oddspapiFixtureId, oddspapiMarketId,
      pinnacleFound: false, marketKeys: [], marketsTree: {}, notes,
    };
  }

  const bookmakers = extractBookmakers(rawData as RawOddsResponse);
  const pinnacleBm = bookmakers.find((b) => getBookmakerSlug(b).includes("pinnacle"));
  if (!pinnacleBm) {
    notes.push(`Pinnacle bookmaker not in response (${bookmakers.length} bookmakers)`);
    return {
      matchId: args.matchId, marketType: args.marketType,
      oddspapiFixtureId, oddspapiMarketId,
      pinnacleFound: false, marketKeys: [], marketsTree: {}, notes,
    };
  }

  // Walk the raw structure with Object.entries so we preserve KEYS (the
  // current production parser uses Object.values and discards them).
  const rawMarkets = pinnacleBm.markets;
  if (!rawMarkets || Array.isArray(rawMarkets) || typeof rawMarkets !== "object") {
    notes.push("Pinnacle.markets is not the new-format Record — see legacy fallback in extractSelections");
    return {
      matchId: args.matchId, marketType: args.marketType,
      oddspapiFixtureId, oddspapiMarketId,
      pinnacleFound: true, marketKeys: [], marketsTree: {}, notes,
    };
  }

  const marketKeys = Object.keys(rawMarkets as Record<string, RawMarket>);
  const marketsTree: Record<string, {
    bookmakerMarketId?: string;
    outcomes: Record<string, {
      playerSamples: Array<{ playerKey: string; bookmakerOutcomeId?: string; price?: number; active?: boolean }>;
    }>;
  }> = {};

  const marketEntries = Object.entries(rawMarkets as Record<string, RawMarket>).slice(0, 8);
  for (const [marketKey, market] of marketEntries) {
    const outcomes: typeof marketsTree[string]["outcomes"] = {};
    const outcomeEntries = Object.entries(market?.outcomes ?? {}).slice(0, 6);
    for (const [outcomeKey, outcome] of outcomeEntries) {
      const playerEntries = Object.entries(outcome?.players ?? {}).slice(0, 2);
      outcomes[outcomeKey] = {
        playerSamples: playerEntries.map(([pk, p]) => ({
          playerKey: pk,
          bookmakerOutcomeId: (p as any)?.bookmakerOutcomeId,
          price: (p as any)?.price,
          active: (p as any)?.active,
        })),
      };
    }
    marketsTree[marketKey] = {
      bookmakerMarketId: market?.bookmakerMarketId,
      outcomes,
    };
  }

  notes.push(
    `Found ${marketKeys.length} market keys; sampled ${marketEntries.length}. Compare market keys to MARKET_IDS values to confirm market routing.`,
  );
  notes.push(
    "Inspect each market's `outcomes` keys — if they are readable ('yes'/'no'/'1x'/'home'/'over') we can fix the parser. If they are also numeric, the API genuinely doesn't expose decodable labels and AF Pinnacle is the only path.",
  );

  return {
    matchId: args.matchId,
    marketType: args.marketType,
    oddspapiFixtureId,
    oddspapiMarketId,
    pinnacleFound: true,
    marketKeys,
    marketsTree,
    notes,
  };
}

// ─── DIAGNOSTIC: dump raw OddsPapi response for a (match, market) pair ─────
// 2026-05-08 (post-Lever-1): used to drill into BTTS/DC/FH/TEAM_TOTAL parser
// or coverage gaps. After Lever 1 deploy the closing-line cron is correctly
// fetching per-market, but BTTS/DC/FH still showed zero oddspapi_pinnacle
// snapshots over 30 days. This endpoint reveals whether the API genuinely
// has no data for a market, or returns data without Pinnacle, or returns
// Pinnacle in a label format we don't decode.
//
// Usage: POST /admin/debug-oddspapi-fetch with body { matchId, marketType }.
// Returns structured dump: bookmaker count, slug list, Pinnacle outcome,
// raw selection labels (truncated). Does NOT cache or store.

export async function debugOddsPapiFetch(args: {
  matchId: number;
  marketType: string;
}): Promise<{
  matchId: number;
  marketType: string;
  oddspapiFixtureId: number | null;
  oddspapiMarketId: number | null;
  fetchedOk: boolean;
  rawTopLevelKeys: string[];
  bookmakerCount: number;
  bookmakerSlugs: string[];
  pinnacle: {
    found: boolean;
    rawSelectionLabels: string[];
    decodedSelections: Array<{ key: string; odds: number | null }>;
  };
  sampleNonPinnacle: Array<{
    slug: string;
    selectionLabels: string[];
  }>;
  notes: string[];
}> {
  const notes: string[] = [];

  const oddspapiFixtureId = await getOddspapiFixtureId(args.matchId);
  if (!oddspapiFixtureId) {
    notes.push("getOddspapiFixtureId returned null — match has no OddsPapi fixture mapping");
    return {
      matchId: args.matchId,
      marketType: args.marketType,
      oddspapiFixtureId: null,
      oddspapiMarketId: null,
      fetchedOk: false,
      rawTopLevelKeys: [],
      bookmakerCount: 0,
      bookmakerSlugs: [],
      pinnacle: { found: false, rawSelectionLabels: [], decodedSelections: [] },
      sampleNonPinnacle: [],
      notes,
    };
  }

  const oddspapiMarketId = MARKET_IDS[args.marketType];
  if (!oddspapiMarketId) {
    notes.push(`MARKET_IDS["${args.marketType}"] not mapped — closing-line cron skips this market`);
    return {
      matchId: args.matchId,
      marketType: args.marketType,
      oddspapiFixtureId,
      oddspapiMarketId: null,
      fetchedOk: false,
      rawTopLevelKeys: [],
      bookmakerCount: 0,
      bookmakerSlugs: [],
      pinnacle: { found: false, rawSelectionLabels: [], decodedSelections: [] },
      sampleNonPinnacle: [],
      notes,
    };
  }

  const rawData = await fetchOddsPapi<RawOddsResponse>(
    "/odds",
    { fixtureId: oddspapiFixtureId, marketId: oddspapiMarketId },
    "diagnostic",
    "P3",
  );
  if (!rawData) {
    notes.push("fetchOddsPapi returned null — endpoint did not respond or returned non-OK");
    return {
      matchId: args.matchId,
      marketType: args.marketType,
      oddspapiFixtureId,
      oddspapiMarketId,
      fetchedOk: false,
      rawTopLevelKeys: [],
      bookmakerCount: 0,
      bookmakerSlugs: [],
      pinnacle: { found: false, rawSelectionLabels: [], decodedSelections: [] },
      sampleNonPinnacle: [],
      notes,
    };
  }

  const rawTopLevelKeys = Object.keys(rawData as Record<string, unknown>);
  const bookmakers = extractBookmakers(rawData as RawOddsResponse);
  const bookmakerSlugs = bookmakers.map((b) => getBookmakerSlug(b));

  const pinnacleBm = bookmakers.find((b) => getBookmakerSlug(b).includes("pinnacle"));
  let pinnacleResult: {
    found: boolean;
    rawSelectionLabels: string[];
    decodedSelections: Array<{ key: string; odds: number | null }>;
  } = { found: false, rawSelectionLabels: [], decodedSelections: [] };

  if (pinnacleBm) {
    const sels = extractSelections(pinnacleBm);
    const labels = sels.map((s) => String(s.label ?? s.selection ?? s.name ?? s.outcome ?? "")).slice(0, 30);
    const decoded: Array<{ key: string; odds: number | null }> = [];
    for (const key of getGenericSelectionKeys(args.marketType)) {
      decoded.push({ key, odds: getSelectionOdds(sels, args.marketType, key) ?? null });
    }
    pinnacleResult = {
      found: true,
      rawSelectionLabels: labels,
      decodedSelections: decoded,
    };
    if (decoded.every((d) => d.odds == null)) {
      notes.push(
        `Pinnacle bookmaker IS present in response but getSelectionOdds returned null for ALL keys [${decoded.map((d) => d.key).join(", ")}]. Inspect rawSelectionLabels for the actual format and extend the slash-format matcher (oddsPapi.ts:1983-2090).`,
      );
    } else {
      notes.push("Pinnacle decoded successfully — closing-line cron should now be capturing this scope.");
    }
  } else {
    notes.push(
      `Pinnacle slug NOT found among ${bookmakerSlugs.length} bookmakers (${bookmakerSlugs.slice(0, 10).join(", ") || "(empty)"}). API genuinely has no Pinnacle data for ${args.marketType} on this fixture/league.`,
    );
  }

  const sampleNonPinnacle = bookmakers
    .filter((b) => !getBookmakerSlug(b).includes("pinnacle"))
    .slice(0, 5)
    .map((b) => ({
      slug: getBookmakerSlug(b),
      selectionLabels: extractSelections(b)
        .map((s) => String(s.label ?? s.selection ?? s.name ?? s.outcome ?? ""))
        .slice(0, 8),
    }));

  return {
    matchId: args.matchId,
    marketType: args.marketType,
    oddspapiFixtureId,
    oddspapiMarketId,
    fetchedOk: true,
    rawTopLevelKeys,
    bookmakerCount: bookmakers.length,
    bookmakerSlugs,
    pinnacle: pinnacleResult,
    sampleNonPinnacle,
    notes,
  };
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
  // Exclude: ASIAN_HANDICAP (huge volume, not bet), FIRST_HALF_ markets (rarely used),
  // and banned markets: OVER_UNDER_05/15, TOTAL_CORNERS_85/115, TOTAL_CARDS_45/55, FIRST_HALF_OU_05.
  const RELEVANT_MARKETS = [
    "MATCH_ODDS",
    "OVER_UNDER_25", "OVER_UNDER_35", "OVER_UNDER_45",
    "TOTAL_CORNERS_95", "TOTAL_CORNERS_105",
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
        sql`(${oddsSnapshotsTable.source} LIKE 'api_football_real%' OR ${oddsSnapshotsTable.source} = 'derived_from_match_odds')`,
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

    if (row.source === "api_football_real:Pinnacle" || row.source === "derived_from_match_odds") {
      if (sel.pinnacle === null || odds > sel.pinnacle) sel.pinnacle = odds;
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

      const entry: OddspapiValidation = {
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

      for (const variant of selectionNameVariants(selName)) {
        matchCache[variant] = entry;
      }
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

export async function backfillPinnacleOnPendingBets(): Promise<{ updated: number; checked: number }> {
  const pending = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      selectionName: paperBetsTable.selectionName,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        sql`${paperBetsTable.deletedAt} IS NULL`,
        sql`${paperBetsTable.pinnacleOdds} IS NULL`,
        gte(matchesTable.kickoffTime, new Date()),
      ),
    );

  if (pending.length === 0) return { updated: 0, checked: 0 };

  const matchIds = [...new Set(pending.map((b) => b.matchId))];

  const pinnSnaps = await db
    .select({
      matchId: oddsSnapshotsTable.matchId,
      selectionName: oddsSnapshotsTable.selectionName,
      backOdds: oddsSnapshotsTable.backOdds,
    })
    .from(oddsSnapshotsTable)
    .where(
      and(
        eq(oddsSnapshotsTable.source, "api_football_real:Pinnacle"),
        inArray(oddsSnapshotsTable.matchId, matchIds),
      ),
    );

  const pinnMap = new Map<string, number>();
  for (const s of pinnSnaps) {
    const odds = parseFloat(s.backOdds ?? "0");
    if (odds <= 1.01) continue;
    const key = `${s.matchId}:${s.selectionName}`;
    const existing = pinnMap.get(key);
    if (!existing || odds > existing) pinnMap.set(key, odds);
  }

  let updated = 0;
  const updates: Array<{ id: number; odds: number }> = [];

  for (const bet of pending) {
    const variants = selectionNameVariants(bet.selectionName);
    let bestOdds = 0;
    for (const v of variants) {
      const key = `${bet.matchId}:${v}`;
      const o = pinnMap.get(key);
      if (o && o > bestOdds) bestOdds = o;
    }
    if (bestOdds > 1.01) {
      updates.push({ id: bet.id, odds: bestOdds });
    }
  }

  for (const u of updates) {
    await db
      .update(paperBetsTable)
      .set({
        pinnacleOdds: String(u.odds),
        pinnacleImplied: String(1 / u.odds),
      })
      .where(eq(paperBetsTable.id, u.id));
    updated++;
  }

  logger.info({ checked: pending.length, updated }, "Backfilled Pinnacle odds on pending bets");
  return { updated, checked: pending.length };
}

// ─── FIX 1: Derive Pinnacle DC odds from MATCH_ODDS ────────────────────────────

export async function derivePinnacleDCFromMatchOdds(): Promise<{
  matchesProcessed: number;
  dcSelectionsCreated: number;
  betsUpdated: number;
}> {
  const pinnMO = await db
    .select({
      matchId: oddsSnapshotsTable.matchId,
      selectionName: oddsSnapshotsTable.selectionName,
      backOdds: oddsSnapshotsTable.backOdds,
      snapshotTime: oddsSnapshotsTable.snapshotTime,
      league: matchesTable.league,
    })
    .from(oddsSnapshotsTable)
    .innerJoin(matchesTable, eq(oddsSnapshotsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(oddsSnapshotsTable.source, "api_football_real:Pinnacle"),
        eq(oddsSnapshotsTable.marketType, "MATCH_ODDS"),
        eq(matchesTable.status, "scheduled"),
      ),
    )
    .orderBy(desc(oddsSnapshotsTable.snapshotTime));

  // Task 14 (2026-05-11): load per-league de-vig method choice. competition_config
  // is small (~1k rows) so we pull all-in-one and cache as a Map. Falls back to
  // 'power' for any league not in competition_config (no match by name).
  const devigCfgRows = await db
    .select({
      name: competitionConfigTable.name,
      devigMethod: competitionConfigTable.devigMethod,
    })
    .from(competitionConfigTable);
  const devigByLeague = new Map<string, DevigMethod>(
    devigCfgRows.map((r) => [r.name, (r.devigMethod ?? "power") as DevigMethod]),
  );

  const matchLeagueMap = new Map<number, string>();
  const matchMap = new Map<number, { home: number; draw: number; away: number }>();
  const matchSeen = new Map<number, Set<string>>();
  for (const row of pinnMO) {
    const odds = parseFloat(row.backOdds ?? "0");
    if (odds <= 1.01) continue;
    const sel = row.selectionName.toLowerCase();
    let canonical: "home" | "draw" | "away" | null = null;
    if (sel === "home" || sel === "1") canonical = "home";
    else if (sel === "draw" || sel === "x") canonical = "draw";
    else if (sel === "away" || sel === "2") canonical = "away";
    if (!canonical) continue;

    if (!matchSeen.has(row.matchId)) matchSeen.set(row.matchId, new Set());
    const seen = matchSeen.get(row.matchId)!;
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    if (!matchMap.has(row.matchId)) matchMap.set(row.matchId, { home: 0, draw: 0, away: 0 });
    matchMap.get(row.matchId)![canonical] = odds;
    if (row.league) matchLeagueMap.set(row.matchId, row.league);
  }

  let matchesProcessed = 0;
  let dcSelectionsCreated = 0;
  const now = new Date();

  const allMatchIds = [...matchMap.keys()].filter((mid) => {
    const mo = matchMap.get(mid)!;
    return mo.home > 1.01 && mo.draw > 1.01 && mo.away > 1.01;
  });

  type DerivedRow = {
    matchId: number;
    marketType: string;
    selectionName: string;
    backOdds: string;
    layOdds: null;
    snapshotTime: Date;
    source: string;
  };
  const allInserts: DerivedRow[] = [];

  for (const matchId of allMatchIds) {
    const mo = matchMap.get(matchId)!;

    // Task 14 (2026-05-11): replaces the inline proportional de-vig with the
    // per-league configured method (power-Newton or Shin). Defaults to 'power'
    // for any league missing from competition_config. The de-vig service
    // falls back to proportional internally if Newton/bisection fails to
    // converge, so the output vector is always valid.
    const league = matchLeagueMap.get(matchId);
    const method = (league && devigByLeague.get(league)) ?? "power";
    const [fairHome, fairDraw, fairAway] = devig([mo.home, mo.draw, mo.away], method);

    const dcOdds = {
      "1X": 1 / (fairHome + fairDraw),
      "X2": 1 / (fairDraw + fairAway),
      "12": 1 / (fairHome + fairAway),
    };

    for (const [selName, odds] of Object.entries(dcOdds)) {
      if (odds <= 1.01 || !isFinite(odds)) continue;
      allInserts.push({
        matchId,
        marketType: "DOUBLE_CHANCE",
        selectionName: selName,
        backOdds: String(Math.round(odds * 10000) / 10000),
        layOdds: null,
        snapshotTime: now,
        source: "derived_from_match_odds",
      });
      dcSelectionsCreated++;
    }
    matchesProcessed++;
  }

  await db.transaction(async (tx) => {
    if (allMatchIds.length > 0) {
      await tx
        .delete(oddsSnapshotsTable)
        .where(
          and(
            inArray(oddsSnapshotsTable.matchId, allMatchIds),
            eq(oddsSnapshotsTable.marketType, "DOUBLE_CHANCE"),
            eq(oddsSnapshotsTable.source, "derived_from_match_odds"),
          ),
        );
    }
    const BATCH_SIZE = 100;
    for (let i = 0; i < allInserts.length; i += BATCH_SIZE) {
      await tx.insert(oddsSnapshotsTable).values(allInserts.slice(i, i + BATCH_SIZE));
    }
  });

  const betsUpdated = await backfillPinnacleUnified();

  logger.info(
    { matchesProcessed, dcSelectionsCreated, betsUpdated },
    "Derived Pinnacle DC odds from MATCH_ODDS and backfilled bets",
  );
  return { matchesProcessed, dcSelectionsCreated, betsUpdated };
}

// ─── FIX 5: Unified Pinnacle data layer ──────────────────────────────────────

export interface UnifiedPinnacleOdds {
  odds: number;
  implied: number;
  source: "oddspapi" | "api_football_pinnacle" | "derived_from_match_odds";
}

export async function getUnifiedPinnacleOdds(
  matchId: number,
  marketType: string,
  selectionName: string,
): Promise<UnifiedPinnacleOdds | null> {
  const variants = selectionNameVariants(selectionName);

  const sources: Array<{ dbSource: string; tag: UnifiedPinnacleOdds["source"] }> = [
    { dbSource: "oddspapi", tag: "oddspapi" },
    { dbSource: "api_football_real:Pinnacle", tag: "api_football_pinnacle" },
    { dbSource: "derived_from_match_odds", tag: "derived_from_match_odds" },
  ];

  for (const { dbSource, tag } of sources) {
    const rows = await db
      .select({ backOdds: oddsSnapshotsTable.backOdds })
      .from(oddsSnapshotsTable)
      .where(
        and(
          eq(oddsSnapshotsTable.matchId, matchId),
          eq(oddsSnapshotsTable.marketType, marketType),
          inArray(oddsSnapshotsTable.selectionName, variants),
          eq(oddsSnapshotsTable.source, dbSource),
        ),
      )
      .orderBy(desc(oddsSnapshotsTable.snapshotTime))
      .limit(1);

    if (rows.length > 0) {
      const odds = parseFloat(rows[0]!.backOdds ?? "0");
      if (odds > 1.01) {
        return { odds, implied: 1 / odds, source: tag };
      }
    }
  }

  return null;
}

export async function backfillPinnacleUnified(): Promise<number> {
  const pending = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      pinnacleOdds: paperBetsTable.pinnacleOdds,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        sql`${paperBetsTable.deletedAt} IS NULL`,
        gte(matchesTable.kickoffTime, new Date()),
      ),
    );

  if (pending.length === 0) return 0;

  const matchIds = [...new Set(pending.map((b) => b.matchId))];

  const allSnaps = await db
    .select({
      matchId: oddsSnapshotsTable.matchId,
      marketType: oddsSnapshotsTable.marketType,
      selectionName: oddsSnapshotsTable.selectionName,
      source: oddsSnapshotsTable.source,
      backOdds: oddsSnapshotsTable.backOdds,
    })
    .from(oddsSnapshotsTable)
    .where(
      and(
        inArray(oddsSnapshotsTable.matchId, matchIds),
        inArray(oddsSnapshotsTable.source, [
          "oddspapi",
          "api_football_real:Pinnacle",
          "derived_from_match_odds",
        ]),
      ),
    );

  type SnapRecord = { odds: number; priority: number; source: string };
  const snapMap = new Map<string, SnapRecord>();
  const SOURCE_PRIORITY: Record<string, number> = {
    oddspapi: 1,
    "api_football_real:Pinnacle": 2,
    derived_from_match_odds: 3,
  };

  for (const s of allSnaps) {
    const odds = parseFloat(s.backOdds ?? "0");
    if (odds <= 1.01) continue;
    const pri = SOURCE_PRIORITY[s.source] ?? 99;

    for (const variant of selectionNameVariants(s.selectionName)) {
      const key = `${s.matchId}:${s.marketType}:${variant}`;
      const existing = snapMap.get(key);
      if (!existing || pri < existing.priority || (pri === existing.priority && odds > existing.odds)) {
        snapMap.set(key, { odds, priority: pri, source: s.source });
      }
    }
  }

  let updated = 0;
  for (const bet of pending) {
    const variants = selectionNameVariants(bet.selectionName);
    let best: SnapRecord | null = null;
    for (const v of variants) {
      const key = `${bet.matchId}:${bet.marketType}:${v}`;
      const s = snapMap.get(key);
      if (s && (!best || s.priority < best.priority || (s.priority === best.priority && s.odds > best.odds))) {
        best = s;
      }
    }
    if (best && best.odds > 1.01) {
      const existingOdds = parseFloat(String(bet.pinnacleOdds ?? "0"));
      if (Math.abs(existingOdds - best.odds) > 0.001) {
        const sourceTag = best.source === "api_football_real:Pinnacle" ? "api_football_pinnacle" : best.source;
        await db
          .update(paperBetsTable)
          .set({
            pinnacleOdds: String(best.odds),
            pinnacleImplied: String(1 / best.odds),
            pinnacleEdgeCategory: sourceTag,
          })
          .where(eq(paperBetsTable.id, bet.id));
        updated++;
      }
    }
  }

  logger.info({ checked: pending.length, updated }, "Unified Pinnacle backfill complete");
  return updated;
}

// ─── Three-snapshot CLV system ─────────────────────────────────────────────────
// Snapshot A: at bet identification (called from placePaperBet)
// Snapshot B: 1 hour before kickoff (cron)
// Snapshot C: at market close / kickoff (enhanced existing closing line cron)

export async function storePinnacleSnapshot(params: {
  betId: number | null;
  matchId: number;
  marketType: string;
  selectionName: string;
  snapshotType: "identification" | "pre_kickoff" | "closing" | "t60" | "t30" | "t15" | "t5";
  pinnacleOdds: number;
}): Promise<void> {
  const pinnacleImplied = params.pinnacleOdds > 1 ? 1 / params.pinnacleOdds : null;

  await db.insert(pinnacleOddsSnapshotsTable).values({
    betId: params.betId,
    matchId: params.matchId,
    marketType: params.marketType,
    selectionName: params.selectionName,
    snapshotType: params.snapshotType,
    pinnacleOdds: String(params.pinnacleOdds),
    pinnacleImplied: pinnacleImplied ? String(pinnacleImplied) : null,
    capturedAt: new Date(),
  });

  if (params.betId) {
    const existing = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pinnacleOddsSnapshotsTable)
      .where(eq(pinnacleOddsSnapshotsTable.betId, params.betId));
    const count = existing[0]?.count ?? 0;

    const quality = count >= 3 ? "complete" : count >= 2 ? "partial" : "incomplete";
    await db.update(paperBetsTable).set({
      pinnacleSnapshotCount: count,
      clvDataQuality: quality,
    }).where(eq(paperBetsTable.id, params.betId));
  }
}

export async function fetchPreKickoffSnapshots(): Promise<{
  checked: number;
  captured: number;
  skipped: number;
}> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return { checked: 0, captured: 0, skipped: 0 };

  const now = new Date();
  const in45min = new Date(now.getTime() + 45 * 60 * 1000);
  const in75min = new Date(now.getTime() + 75 * 60 * 1000);

  const pendingBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        sql`${matchesTable.kickoffTime} >= ${in45min}`,
        sql`${matchesTable.kickoffTime} <= ${in75min}`,
      ),
    );

  if (pendingBets.length === 0) return { checked: 0, captured: 0, skipped: 0 };

  const existingSnapshots = await db
    .select({ betId: pinnacleOddsSnapshotsTable.betId })
    .from(pinnacleOddsSnapshotsTable)
    .where(
      and(
        inArray(pinnacleOddsSnapshotsTable.betId, pendingBets.map((b) => b.id)),
        eq(pinnacleOddsSnapshotsTable.snapshotType, "pre_kickoff"),
      ),
    );
  const alreadyCaptured = new Set(existingSnapshots.map((s) => s.betId));
  const needCapture = pendingBets.filter((b) => !alreadyCaptured.has(b.id));

  if (needCapture.length === 0) return { checked: pendingBets.length, captured: 0, skipped: 0 };

  logger.info({ count: needCapture.length }, "Pre-kickoff snapshot B: capturing 1hr-before Pinnacle odds");

  let captured = 0;
  let skipped = 0;

  const byMatch = new Map<number, typeof needCapture>();
  for (const bet of needCapture) {
    const group = byMatch.get(bet.matchId) ?? [];
    group.push(bet);
    byMatch.set(bet.matchId, group);
  }

  for (const [matchId, bets] of byMatch) {
    const oddspapiId = await getOddspapiFixtureId(matchId);
    if (!oddspapiId) { skipped += bets.length; continue; }

    if (!(await canMakeOddspapiRequest(1, "P3"))) {
      skipped += bets.length;
      break;
    }

    await new Promise((r) => setTimeout(r, 2400));

    const marketId = MARKET_IDS[bets[0]?.marketType ?? "MATCH_ODDS"] ?? 101;
    const rawData = await fetchOddsPapi<RawOddsResponse>(
      "/odds",
      { fixtureId: oddspapiId, marketId },
      "pre_kickoff_snapshot",
      "P3",
    );

    if (!rawData) { skipped += bets.length; continue; }

    const snapshotMarket = bets[0]?.marketType ?? "MATCH_ODDS";
    const bookmakers = extractBookmakers(rawData as RawOddsResponse);
    const pinnacleBySelection: Record<string, number> = {};
    for (const bm of bookmakers) {
      const slug = getBookmakerSlug(bm);
      if (!slug.includes("pinnacle")) continue;
      const selections = extractSelections(bm);
      for (const selName of getGenericSelectionKeys(snapshotMarket)) {
        const odds = getSelectionOdds(selections, snapshotMarket, selName);
        if (odds) pinnacleBySelection[selName] = odds;
      }
    }

    for (const bet of bets) {
      try {
        const genericKey = normaliseSelectionToGenericKey(bet.selectionName, snapshotMarket);
        const pinnOdds = pinnacleBySelection[genericKey];
        if (!pinnOdds) { skipped++; continue; }

        await storePinnacleSnapshot({
          betId: bet.id,
          matchId,
          marketType: bet.marketType,
          selectionName: bet.selectionName,
          snapshotType: "pre_kickoff",
          pinnacleOdds: pinnOdds,
        });
        captured++;
      } catch (err) {
        logger.error({ err, betId: bet.id, matchId }, "Pre-kickoff snapshot B error — skipping bet");
        skipped++;
      }
    }
  }

  logger.info({ checked: pendingBets.length, captured, skipped }, "Pre-kickoff snapshot B complete");
  return { checked: pendingBets.length, captured, skipped };
}

// ─── Multi-snapshot Pinnacle ingestion ────────────────────────────────────────
// Captures Pinnacle odds for pending bets at granular time-to-kickoff buckets.
// Buckets: t60 (55-65min), t30 (25-35min), t15 (12-18min), t5 (3-7min before KO).
// Each bet gets ONE snapshot per bucket (idempotent on bet_id + snapshot_type).
// This data feeds: (a) "Pinnacle velocity" — did the price move toward us?,
// (b) richer CLV — closing-line proxy when the official closing snapshot fails,
// (c) future placement gate (steam confirmation / reverse-signal abort).

export type SnapshotBucket = "t60" | "t30" | "t15" | "t5";

const BUCKET_WINDOWS: Record<SnapshotBucket, { minMin: number; maxMin: number }> = {
  t60: { minMin: 55, maxMin: 65 },
  t30: { minMin: 25, maxMin: 35 },
  t15: { minMin: 12, maxMin: 18 },
  t5:  { minMin: 3,  maxMin: 7  },
};

export async function captureSnapshotForBucket(bucket: SnapshotBucket): Promise<{
  bucket: SnapshotBucket;
  checked: number;
  captured: number;
  skipped: number;
}> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return { bucket, checked: 0, captured: 0, skipped: 0 };

  const window = BUCKET_WINDOWS[bucket];
  const now = new Date();
  const earliestKO = new Date(now.getTime() + window.minMin * 60 * 1000);
  const latestKO   = new Date(now.getTime() + window.maxMin * 60 * 1000);

  const pendingBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        sql`${matchesTable.kickoffTime} >= ${earliestKO}`,
        sql`${matchesTable.kickoffTime} <= ${latestKO}`,
      ),
    );

  if (pendingBets.length === 0) return { bucket, checked: 0, captured: 0, skipped: 0 };

  // Idempotency: skip bets that already have this bucket captured
  const existing = await db
    .select({ betId: pinnacleOddsSnapshotsTable.betId })
    .from(pinnacleOddsSnapshotsTable)
    .where(
      and(
        inArray(pinnacleOddsSnapshotsTable.betId, pendingBets.map((b) => b.id)),
        eq(pinnacleOddsSnapshotsTable.snapshotType, bucket),
      ),
    );
  const alreadyHave = new Set(existing.map((s) => s.betId));
  const needCapture = pendingBets.filter((b) => !alreadyHave.has(b.id));

  if (needCapture.length === 0) return { bucket, checked: pendingBets.length, captured: 0, skipped: 0 };

  logger.info({ bucket, count: needCapture.length }, `Multi-snapshot ${bucket}: capturing Pinnacle odds`);

  let captured = 0;
  let skipped = 0;

  // Group by matchId to deduplicate fetches (and by market for the request)
  const byMatchMarket = new Map<string, typeof needCapture>();
  for (const bet of needCapture) {
    const k = `${bet.matchId}:${bet.marketType}`;
    const grp = byMatchMarket.get(k) ?? [];
    grp.push(bet);
    byMatchMarket.set(k, grp);
  }

  for (const [k, bets] of byMatchMarket) {
    const matchId = bets[0].matchId;
    const marketType = bets[0].marketType;

    const oddspapiId = await getOddspapiFixtureId(matchId);
    if (!oddspapiId) { skipped += bets.length; continue; }

    if (!(await canMakeOddspapiRequest(1, "P3"))) {
      logger.warn({ bucket }, `Multi-snapshot ${bucket}: P3 budget exhausted — stopping`);
      skipped += bets.length;
      break;
    }

    await new Promise((r) => setTimeout(r, 2400));

    const marketId = MARKET_IDS[marketType] ?? 101;
    const rawData = await fetchOddsPapi<RawOddsResponse>(
      "/odds",
      { fixtureId: oddspapiId, marketId },
      `snapshot_${bucket}`,
      "P3",
    );

    if (!rawData) { skipped += bets.length; continue; }

    const bookmakers = extractBookmakers(rawData as RawOddsResponse);
    const pinnacleBySelection: Record<string, number> = {};
    for (const bm of bookmakers) {
      const slug = getBookmakerSlug(bm);
      if (!slug.includes("pinnacle")) continue;
      const selections = extractSelections(bm);
      for (const selName of getGenericSelectionKeys(marketType)) {
        const odds = getSelectionOdds(selections, marketType, selName);
        if (odds) pinnacleBySelection[selName] = odds;
      }
    }

    for (const bet of bets) {
      try {
        const genericKey = normaliseSelectionToGenericKey(bet.selectionName, marketType);
        const pinnOdds = pinnacleBySelection[genericKey];
        if (!pinnOdds) { skipped++; continue; }

        await storePinnacleSnapshot({
          betId: bet.id,
          matchId,
          marketType: bet.marketType,
          selectionName: bet.selectionName,
          snapshotType: bucket,
          pinnacleOdds: pinnOdds,
        });
        captured++;
      } catch (err) {
        logger.error({ err, betId: bet.id, matchId, bucket }, `Multi-snapshot ${bucket} error — skipping bet`);
        skipped++;
      }
    }
  }

  logger.info({ bucket, checked: pendingBets.length, captured, skipped }, `Multi-snapshot ${bucket} complete`);
  return { bucket, checked: pendingBets.length, captured, skipped };
}

export async function captureAllPendingSnapshots(): Promise<{
  buckets: Array<{ bucket: SnapshotBucket; checked: number; captured: number; skipped: number }>;
}> {
  const results = [];
  for (const bucket of ["t60", "t30", "t15", "t5"] as SnapshotBucket[]) {
    try {
      const r = await captureSnapshotForBucket(bucket);
      results.push(r);
    } catch (err) {
      logger.warn({ err, bucket }, "captureAllPendingSnapshots: bucket failed — continuing");
      results.push({ bucket, checked: 0, captured: 0, skipped: 0 });
    }
  }
  return { buckets: results };
}

// ─── Line Movement Tracking ────────────────────────────────────────────────────

export async function trackLineMovements(): Promise<{
  fixturesChecked: number;
  movementsRecorded: number;
  sharpMovements: number;
}> {
  const key = process.env.ODDSPAPI_KEY;
  if (!key) return { fixturesChecked: 0, movementsRecorded: 0, sharpMovements: 0 };

  const now = new Date();
  const in2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const upcoming = await db
    .select({ id: matchesTable.id })
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, in2h),
        lte(matchesTable.kickoffTime, in7d),
      ),
    );

  if (upcoming.length === 0) return { fixturesChecked: 0, movementsRecorded: 0, sharpMovements: 0 };

  const matchIds = upcoming.map((m) => m.id);

  const hasPendingBets = await db
    .select({ matchId: paperBetsTable.matchId })
    .from(paperBetsTable)
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        inArray(paperBetsTable.matchId, matchIds),
      ),
    );
  const betMatchIds = new Set(hasPendingBets.map((b) => b.matchId));

  const matchesToTrack = upcoming.filter((m) => betMatchIds.has(m.id));
  if (matchesToTrack.length === 0) return { fixturesChecked: 0, movementsRecorded: 0, sharpMovements: 0 };

  logger.info({ count: matchesToTrack.length }, "Line movement tracker: checking Pinnacle lines");

  let movementsRecorded = 0;
  let sharpMovements = 0;
  let fixturesChecked = 0;

  for (const match of matchesToTrack) {
    const oddspapiId = await getOddspapiFixtureId(match.id);
    if (!oddspapiId) continue;

    if (!(await canMakeOddspapiRequest(1, "P2"))) break;

    await new Promise((r) => setTimeout(r, 2400));

    const rawData = await fetchOddsPapi<RawOddsResponse>(
      "/odds",
      { fixtureId: oddspapiId, marketId: 101 },
      "line_movement",
      "P2",
    );

    if (!rawData) continue;
    fixturesChecked++;

    const bookmakers = extractBookmakers(rawData as RawOddsResponse);

    for (const bm of bookmakers) {
      const slug = getBookmakerSlug(bm);
      if (!slug.includes("pinnacle")) continue;

      const selections = extractSelections(bm);
      for (const selName of ["Home", "Draw", "Away"]) {
        const odds = getSelectionOdds(selections, "MATCH_ODDS", selName);
        if (!odds || odds <= 1.01) continue;

        const impliedProb = 1 / odds;

        const prevRows = await db
          .select({ odds: lineMovementsTable.odds, impliedProb: lineMovementsTable.impliedProb })
          .from(lineMovementsTable)
          .where(
            and(
              eq(lineMovementsTable.matchId, match.id),
              eq(lineMovementsTable.selectionName, selName),
              eq(lineMovementsTable.bookmaker, "pinnacle"),
            ),
          )
          .orderBy(desc(lineMovementsTable.capturedAt))
          .limit(1);

        const prevOdds = prevRows.length > 0 ? parseFloat(prevRows[0]!.odds) : null;
        const prevImplied = prevRows.length > 0 && prevRows[0]!.impliedProb ? parseFloat(prevRows[0]!.impliedProb) : null;

        let movementPct: number | null = null;
        let isSharp = false;

        if (prevImplied && prevImplied > 0) {
          movementPct = Math.round(((impliedProb - prevImplied) / prevImplied) * 100 * 100) / 100;
          isSharp = Math.abs((impliedProb - prevImplied) * 100) > 3;
        }

        await db.insert(lineMovementsTable).values({
          matchId: match.id,
          marketType: "MATCH_ODDS",
          selectionName: selName,
          bookmaker: "pinnacle",
          odds: String(odds),
          impliedProb: String(impliedProb),
          previousOdds: prevOdds ? String(prevOdds) : null,
          movementPct: movementPct ? String(movementPct) : null,
          isSharpMovement: isSharp,
          capturedAt: new Date(),
        });

        movementsRecorded++;
        if (isSharp) {
          sharpMovements++;
          logger.info(
            { matchId: match.id, selName, odds, prevOdds, movementPct },
            "Sharp line movement detected (>3% implied shift)",
          );
        }
      }
    }
  }

  logger.info({ fixturesChecked, movementsRecorded, sharpMovements }, "Line movement tracking complete");
  return { fixturesChecked, movementsRecorded, sharpMovements };
}

export async function getLineDirection(matchId: number, selectionName: string): Promise<"toward" | "away" | "stable" | "unknown"> {
  const movements = await db
    .select({ movementPct: lineMovementsTable.movementPct, capturedAt: lineMovementsTable.capturedAt })
    .from(lineMovementsTable)
    .where(
      and(
        eq(lineMovementsTable.matchId, matchId),
        eq(lineMovementsTable.selectionName, selectionName),
        eq(lineMovementsTable.bookmaker, "pinnacle"),
      ),
    )
    .orderBy(desc(lineMovementsTable.capturedAt))
    .limit(5);

  if (movements.length < 2) return "unknown";

  const recentMoves = movements
    .filter((m) => m.movementPct !== null)
    .map((m) => parseFloat(m.movementPct!));

  if (recentMoves.length === 0) return "stable";

  const avgMove = recentMoves.reduce((a, b) => a + b, 0) / recentMoves.length;

  const oldest = movements[movements.length - 1]!.capturedAt;
  const newest = movements[0]!.capturedAt;
  const hoursSinceMove = (newest.getTime() - oldest.getTime()) / (1000 * 60 * 60);

  if (hoursSinceMove >= 24 && Math.abs(avgMove) < 1) return "stable";

  if (avgMove > 0.5) return "toward";
  if (avgMove < -0.5) return "away";

  return "stable";
}

// ─── Pre-bet Pinnacle filtering ────────────────────────────────────────────────

export interface PinnacleFilterResult {
  passed: boolean;
  edgePct: number;
  edgeCategory: "high_confidence" | "standard" | "filtered";
  filterReason: string | null;
  pinnacleOdds: number | null;
  pinnacleImplied: number | null;
  lineDirection: "toward" | "away" | "stable" | "unknown";
  adjustedMinEdge: number;
}

export async function pinnaclePreBetFilter(params: {
  matchId: number;
  marketType: string;
  selectionName: string;
  modelProbability: number;
  marketOdds: number;
  opportunityScore: number;
  league: string;
  pinnacleOdds?: number | null;
  pinnacleImplied?: number | null;
  universeTier?: string | null;
}): Promise<PinnacleFilterResult> {
  const lineDir = await getLineDirection(params.matchId, params.selectionName);

  let pinnacleOdds = params.pinnacleOdds ?? null;
  let pinnacleImplied = params.pinnacleImplied ?? null;

  if (!pinnacleOdds || !pinnacleImplied) {
    // 2026-05-07: data-coverage gate. Previously returned passed=true when
    // Pinnacle data was absent — i.e., bets sailed through without any
    // closing-line validation. Diagnostic showed BTTS bets (36/36 with
    // no Pinnacle reference; -£468 over 31 settled) were the prime victim
    // of this hole: API-Football's Pinnacle feed doesn't include BTTS,
    // and OddsPapi's Pinnacle fetch isn't pulling BTTS either, so the
    // model was sizing aggressively against unanchored "edge".
    //
    // New default: reject when Pinnacle anchor is unavailable. Tier B/C
    // shadow bets are exempted upstream (scheduler.ts:1347 — they don't
    // reach this filter at all by design). Override available via env
    // ALLOW_BETS_WITHOUT_PINNACLE=true for emergency / testing only.
    const allowOverride = process.env["ALLOW_BETS_WITHOUT_PINNACLE"] === "true";
    if (allowOverride) {
      return {
        passed: true,
        edgePct: 0,
        edgeCategory: "standard",
        filterReason: null,
        pinnacleOdds: null,
        pinnacleImplied: null,
        lineDirection: lineDir,
        adjustedMinEdge: 2,
      };
    }

    await db.insert(filteredBetsTable).values({
      matchId: params.matchId,
      marketType: params.marketType,
      selectionName: params.selectionName,
      modelProb: String(params.modelProbability),
      pinnacleImplied: null,
      pinnacleOdds: null,
      edgePct: null,
      filterReason: `No Pinnacle anchor for ${params.marketType} — refusing to bet without closing-line validation`,
      modelOdds: String(1 / params.modelProbability),
      marketOdds: String(params.marketOdds),
      opportunityScore: String(params.opportunityScore),
      league: params.league,
      createdAt: new Date(),
    }).catch(() => {});

    return {
      passed: false,
      edgePct: 0,
      edgeCategory: "filtered",
      filterReason: `No Pinnacle anchor for ${params.marketType} — bet rejected (set ALLOW_BETS_WITHOUT_PINNACLE=true to override)`,
      pinnacleOdds: null,
      pinnacleImplied: null,
      lineDirection: lineDir,
      adjustedMinEdge: 2,
    };
  }

  const edgePct = (params.modelProbability - pinnacleImplied) * 100;

  // 2026-05-08: threshold sourced from adaptive_thresholds (recommender
  // writes weekly Sunday 12:00 UTC, sourced from settled-bet evidence with
  // Bayesian posterior on Kelly log-growth). Falls back through
  // tier_market → market_type → global → agent_config → hardcoded 2%.
  // The hardcoded 2% remains as the final safety floor.
  const { getActivePinnacleEdgeMin } = await import("./adaptiveThresholdRecommender");
  const adaptive = await getActivePinnacleEdgeMin({
    marketType: params.marketType,
    universeTier: params.universeTier ?? null,
  });
  // Convert from fractional (e.g. 0.02) to percentage points (2)
  let minEdge = adaptive.value * 100;
  if (lineDir === "away") {
    // Away-moving lines: require an additional 1 percentage point cushion
    // (preserves the prior 2%/3% asymmetry as a relative bump).
    minEdge += 1;
  }

  if (edgePct < minEdge) {
    await db.insert(filteredBetsTable).values({
      matchId: params.matchId,
      marketType: params.marketType,
      selectionName: params.selectionName,
      modelProb: String(params.modelProbability),
      pinnacleImplied: String(pinnacleImplied),
      pinnacleOdds: String(pinnacleOdds),
      edgePct: String(edgePct),
      filterReason: lineDir === "away"
        ? `Edge ${edgePct.toFixed(2)}% < 3% min (line moving away from position)`
        : `Edge ${edgePct.toFixed(2)}% < 2% min vs Pinnacle implied`,
      modelOdds: String(1 / params.modelProbability),
      marketOdds: String(params.marketOdds),
      opportunityScore: String(params.opportunityScore),
      league: params.league,
      createdAt: new Date(),
    });

    return {
      passed: false,
      edgePct,
      edgeCategory: "filtered",
      filterReason: lineDir === "away"
        ? `Edge ${edgePct.toFixed(2)}% < 3% (line away)`
        : `Edge ${edgePct.toFixed(2)}% < 2% vs Pinnacle`,
      pinnacleOdds,
      pinnacleImplied,
      lineDirection: lineDir,
      adjustedMinEdge: minEdge,
    };
  }

  const edgeCategory = edgePct > 4 ? "high_confidence" : "standard";

  return {
    passed: true,
    edgePct,
    edgeCategory,
    filterReason: null,
    pinnacleOdds,
    pinnacleImplied,
    lineDirection: lineDir,
    adjustedMinEdge: minEdge,
  };
}

// ─── Backfill filtered bet outcomes ───────────────────────────────────────────

export async function backfillFilteredBetOutcomes(): Promise<{ updated: number }> {
  const unresolved = await db
    .select({
      id: filteredBetsTable.id,
      matchId: filteredBetsTable.matchId,
      selectionName: filteredBetsTable.selectionName,
      marketType: filteredBetsTable.marketType,
    })
    .from(filteredBetsTable)
    .innerJoin(matchesTable, eq(filteredBetsTable.matchId, matchesTable.id))
    .where(
      and(
        sql`${filteredBetsTable.actualOutcome} IS NULL`,
        eq(matchesTable.status, "finished"),
      ),
    )
    .limit(200);

  if (unresolved.length === 0) return { updated: 0 };

  let updated = 0;
  for (const fb of unresolved) {
    const match = await db.select().from(matchesTable).where(eq(matchesTable.id, fb.matchId)).limit(1);
    if (!match[0] || match[0].homeScore === null || match[0].awayScore === null) continue;

    const homeScore = match[0].homeScore!;
    const awayScore = match[0].awayScore!;

    let outcome = "unknown";
    const genericKey = normaliseSelectionToGenericKey(fb.selectionName, fb.marketType);

    if (fb.marketType === "MATCH_ODDS") {
      if (genericKey === "Home") outcome = homeScore > awayScore ? "won" : "lost";
      else if (genericKey === "Away") outcome = awayScore > homeScore ? "won" : "lost";
      else if (genericKey === "Draw") outcome = homeScore === awayScore ? "won" : "lost";
    } else if (fb.marketType.startsWith("OVER_UNDER_")) {
      const line = parseFloat(fb.marketType.replace("OVER_UNDER_", "").replace(/(\d)(\d)$/, "$1.$2"));
      const total = homeScore + awayScore;
      if (genericKey === "Over") outcome = total > line ? "won" : "lost";
      else if (genericKey === "Under") outcome = total < line ? "won" : "lost";
    } else if (fb.marketType === "BTTS") {
      const bothScored = homeScore > 0 && awayScore > 0;
      if (genericKey === "Yes") outcome = bothScored ? "won" : "lost";
      else if (genericKey === "No") outcome = !bothScored ? "won" : "lost";
    } else if (fb.marketType === "DOUBLE_CHANCE") {
      const homeWin = homeScore > awayScore;
      const draw = homeScore === awayScore;
      const awayWin = awayScore > homeScore;
      if (genericKey === "1X") outcome = (homeWin || draw) ? "won" : "lost";
      else if (genericKey === "X2") outcome = (draw || awayWin) ? "won" : "lost";
      else if (genericKey === "12") outcome = (homeWin || awayWin) ? "won" : "lost";
    }

    if (outcome !== "unknown") {
      await db.update(filteredBetsTable).set({ actualOutcome: outcome }).where(eq(filteredBetsTable.id, fb.id));
      updated++;
    }
  }

  logger.info({ updated }, "Backfilled filtered bet outcomes");
  return { updated };
}

// ─── Sharp movement analysis ──────────────────────────────────────────────────

export async function analyseSharpMovements(): Promise<{
  totalSharp: number;
  modelAligned: number;
  modelContrarian: number;
  alignmentRate: number;
}> {
  const recentSharp = await db
    .select({
      matchId: lineMovementsTable.matchId,
      selectionName: lineMovementsTable.selectionName,
      movementPct: lineMovementsTable.movementPct,
    })
    .from(lineMovementsTable)
    .where(
      and(
        eq(lineMovementsTable.isSharpMovement, true),
        gte(lineMovementsTable.capturedAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
      ),
    );

  if (recentSharp.length === 0) {
    return { totalSharp: 0, modelAligned: 0, modelContrarian: 0, alignmentRate: 0 };
  }

  let modelAligned = 0;
  let modelContrarian = 0;

  for (const sm of recentSharp) {
    const bets = await db
      .select({ selectionName: paperBetsTable.selectionName })
      .from(paperBetsTable)
      .where(
        and(
          eq(paperBetsTable.matchId, sm.matchId),
          eq(paperBetsTable.status, "pending"),
        ),
      );

    if (bets.length === 0) continue;

    const movePct = parseFloat(sm.movementPct ?? "0");
    const sharpDirection = movePct > 0 ? sm.selectionName : null;

    if (sharpDirection && bets.some((b) => b.selectionName === sharpDirection)) {
      modelAligned++;
    } else if (sharpDirection) {
      modelContrarian++;
    }
  }

  const total = modelAligned + modelContrarian;
  const alignmentRate = total > 0 ? Math.round((modelAligned / total) * 100) : 0;

  logger.info(
    { totalSharp: recentSharp.length, modelAligned, modelContrarian, alignmentRate },
    "Sharp movement analysis complete",
  );

  return { totalSharp: recentSharp.length, modelAligned, modelContrarian, alignmentRate };
}
