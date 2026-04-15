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
  lineMovementsTable,
  filteredBetsTable,
} from "@workspace/db";
import { eq, and, gte, lte, sql, like, inArray, ne, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { resilientFetch, isCircuitOpen } from "./resilientFetch";

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
  "hodd": "hodd",
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
  "barracas central": "barracas",
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
  "sirius": "ik sirius",
  "ik sirius": "ik sirius",
  "vasteras sk fk": "vasteras",
  "vasteras sk": "vasteras",
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
  "ljungskile sk": "ljungskile",
  "norrby if": "norrby",
  "falkenbergs ff": "falkenbergs",
  "oddevold": "oddevold",
  "osters if": "osters",
  "ik brage": "brage",
  "sandviken": "sandviken",
  "sandvikens if": "sandviken",
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
  "panetolikos": "panetolikos",
  "panetolikos gfs": "panetolikos",
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
  "cfr 1907 cluj": "cfr cluj",
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
};

function normalizeTeam(name: string): string {
  let n = transliterate(name)
    .toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/\b(fc|sc|ac|cf|fk|sk|sv|utd|united|club|sporting|real|athletic|atletico|atlético|olympique|olympico|inter|internazionale)\b/g, "")
    .replace(/\b(1910|1899|1893|1904|1907|1908|1909|1903|1896|1898|1894|1895|1897|1900|1901|1902|1905|1906|1911|1912|1913|1914|1915|1916|1917|1918|1919|1920)\b/g, "")
    .replace(/\bii\b/g, "")
    .replace(/\b\d{2}\s*ff\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (TEAM_ALIASES[n]) return TEAM_ALIASES[n]!;
  return n;
}

function resolveAlias(name: string): string {
  const raw = transliterate(name).toLowerCase()
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

    // Pass 6: best-pair scoring — find the fixture with highest combined similarity
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
        if (combined > bestScore && combined >= 0.65 && homeSim >= 0.55 && awaySim >= 0.55) {
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
  // Goals O/U — OVER_UNDER_05 and OVER_UNDER_15 are banned, excluded
  { marketType: "OVER_UNDER_25",    selectionName: "Over 2.5" },
  { marketType: "OVER_UNDER_25",    selectionName: "Under 2.5" },
  { marketType: "OVER_UNDER_35",    selectionName: "Over 3.5" },
  { marketType: "OVER_UNDER_35",    selectionName: "Under 3.5" },
  { marketType: "OVER_UNDER_45",    selectionName: "Over 4.5" },
  { marketType: "OVER_UNDER_45",    selectionName: "Under 4.5" },
  // Corners O/U — only 9.5 and 10.5 are active; 8.5 and 11.5 are banned
  { marketType: "TOTAL_CORNERS_95",  selectionName: "Over 9.5 Corners" },
  { marketType: "TOTAL_CORNERS_95",  selectionName: "Under 9.5 Corners" },
  { marketType: "TOTAL_CORNERS_105", selectionName: "Over 10.5 Corners" },
  { marketType: "TOTAL_CORNERS_105", selectionName: "Under 10.5 Corners" },
  // BTTS
  { marketType: "BTTS",              selectionName: "Yes" },
  { marketType: "BTTS",              selectionName: "No" },
  // Double Chance
  { marketType: "DOUBLE_CHANCE",     selectionName: "1X" },
  { marketType: "DOUBLE_CHANCE",     selectionName: "X2" },
  { marketType: "DOUBLE_CHANCE",     selectionName: "12" },
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
    if (!(await canMakeOddspapiRequest(1, "P1"))) break;

    if (i > 0) await new Promise((r) => setTimeout(r, 1200));

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
    })
    .from(oddsSnapshotsTable)
    .innerJoin(matchesTable, eq(oddsSnapshotsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(oddsSnapshotsTable.source, "oddspapi"),
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, earliestKickoff),
        lte(matchesTable.kickoffTime, latestKickoff),
      ),
    );

  if (rows.length === 0) return cache;

  // Group by matchId → build validation records
  // We only have best-odds (no per-bookmaker breakdown) from the snapshot store.
  // For alignment scoring, pinnacleOdds must come from buildPinnacleValidationFromApiFootball.
  // This cache provides bestOdds + hasPinnacleData=false (overridden by merge in scheduler).
  const matchMap = new Map<number, Record<string, { backOdds: number; marketType: string }>>();
  for (const row of rows) {
    const odds = parseFloat(row.backOdds ?? "0");
    if (!odds || odds <= 1.01) continue;
    if (!matchMap.has(row.matchId)) matchMap.set(row.matchId, {});
    const m = matchMap.get(row.matchId)!;
    if (!m[row.selectionName] || odds > m[row.selectionName]!.backOdds) {
      m[row.selectionName] = { backOdds: odds, marketType: row.marketType };
    }
  }

  for (const [matchId, selMap] of matchMap.entries()) {
    const matchCache: Record<string, OddspapiValidation> = {};
    for (const [selName, data] of Object.entries(selMap)) {
      const entry: OddspapiValidation = {
        pinnacleOdds: null,
        pinnacleImplied: null,
        bestOdds: data.backOdds,
        bestBookmaker: "OddsPapi",
        oddsUpliftPct: null,
        sharpSoftSpread: null,
        consensusPct: null,
        isContrarian: false,
        pinnacleAligned: false,
        hasPinnacleData: false,
      };
      for (const variant of selectionNameVariants(selName)) {
        matchCache[variant] = entry;
      }
    }
    if (Object.keys(matchCache).length > 0) cache.set(matchId, matchCache);
  }

  logger.info({ matchCount: cache.size, totalSelections: rows.length }, "OddsPapi snapshot cache loaded from DB");
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

    if (!(await canMakeOddspapiRequest(1, "P3"))) {
      logger.warn("Pre-kickoff CLV cron: P3 budget exhausted — stopping");
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
      "P3",
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
      for (const selName of getGenericSelectionKeys(matchOddsMarket)) {
        const odds = getSelectionOdds(selections, matchOddsMarket, selName);
        if (odds) pinnacleBySelection[selName] = odds;
      }
    }

    // Store closing odds for each matching bet and compute CLV
    for (const bet of bets) {
      try {
        const genericKey = normaliseSelectionToGenericKey(bet.selectionName, matchOddsMarket);
        const closingOdds = pinnacleBySelection[genericKey] ?? null;
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

        await storePinnacleSnapshot({
          betId: bet.id,
          matchId,
          marketType: bet.marketType,
          selectionName: bet.selectionName,
          snapshotType: "closing",
          pinnacleOdds: closingOdds,
        });

        logger.info(
          { betId: bet.id, matchId, selection: bet.selectionName, placementOdds, closingOdds, clvPct },
          "Pre-kickoff CLV stored (Pinnacle closing line) + snapshot C",
        );
        updated++;
      } catch (err) {
        logger.error({ err, betId: bet.id, matchId }, "Closing line snapshot error — skipping bet");
        skipped++;
      }
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

    const implHome = 1 / mo.home;
    const implDraw = 1 / mo.draw;
    const implAway = 1 / mo.away;
    const totalImplied = implHome + implDraw + implAway;
    const fairHome = implHome / totalImplied;
    const fairDraw = implDraw / totalImplied;
    const fairAway = implAway / totalImplied;

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
  snapshotType: "identification" | "pre_kickoff" | "closing";
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

    await new Promise((r) => setTimeout(r, 1200));

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

    await new Promise((r) => setTimeout(r, 1200));

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
}): Promise<PinnacleFilterResult> {
  const lineDir = await getLineDirection(params.matchId, params.selectionName);

  let pinnacleOdds = params.pinnacleOdds ?? null;
  let pinnacleImplied = params.pinnacleImplied ?? null;

  if (!pinnacleOdds || !pinnacleImplied) {
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

  const edgePct = (params.modelProbability - pinnacleImplied) * 100;

  let minEdge = 2;
  if (lineDir === "away") {
    minEdge = 3;
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
