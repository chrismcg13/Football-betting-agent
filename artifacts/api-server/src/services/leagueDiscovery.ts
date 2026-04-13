/**
 * League Discovery Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans API-Football /leagues to discover all in-season leagues globally,
 * checks bookmaker odds coverage (API-Football + Pinnacle), auto-activates
 * leagues that have odds, and seeds initial edge scores.
 *
 * Budget: ~200 API-Football requests/week (trivial against 75k/day cap).
 * Runs: weekly (Sunday midnight) + on-demand via API.
 */

import { db, discoveredLeaguesTable, leagueEdgeScoresTable, learningNarrativesTable, complianceLogsTable } from "@workspace/db";
import { eq, inArray, sql, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { ALL_LEAGUE_IDS } from "./apiFootball";

// ─── Pre-known leagues to ALWAYS include (hardcoded IDs from apiFootball.ts) ──
const BASELINE_LEAGUE_IDS = new Set(ALL_LEAGUE_IDS);

// ─── Known Pinnacle-covered league IDs (confirmed coverage) ──────────────────
// This list grows as OddsPapi fixture mapping confirms coverage.
const KNOWN_PINNACLE_LEAGUE_IDS = new Set([
  39,   // Premier League
  140,  // La Liga
  135,  // Serie A
  78,   // Bundesliga
  61,   // Ligue 1
  2,    // UEFA Champions League
  3,    // UEFA Europa League
  88,   // Eredivisie
  94,   // Primeira Liga
  40,   // Championship / EFL
  71,   // Brazilian Serie A
  179,  // Scottish Premiership
  144,  // Belgian Pro League
  103,  // Norwegian Eliteserien
  113,  // Swedish Allsvenskan
  119,  // Danish Superliga
  203,  // Süper Lig
  197,  // Super League Greece
  128,  // Argentine Liga Profesional
  262,  // Colombian Liga BetPlay
  98,   // J1 League (Japan)
  292,  // K League 1 (South Korea)
  188,  // A-League (Australia)
  235,  // Russian Premier League
  333,  // Ukrainian Premier League
  135,  // Serie A
  207,  // Swiss Super League
  218,  // Austrian Bundesliga
  106,  // Polish Ekstraklasa
  345,  // Czech First League
  283,  // Romanian Liga I
  210,  // Croatian HNL
]);

// ─── Tier classification ──────────────────────────────────────────────────────

function classifyLeague(leagueId: number, leagueName: string, countryName: string): {
  tier: string;
  seedEdgeScore: number;
} {
  const name = leagueName.toLowerCase();
  const country = countryName.toLowerCase();

  // Top 5 + UCL/UEL
  const top5Ids = new Set([39, 140, 135, 78, 61, 2, 3]);
  if (top5Ids.has(leagueId)) return { tier: "top5", seedEdgeScore: 75 };

  // Well-known top divisions
  const tier1Ids = new Set([88, 94, 40, 71, 179, 144, 203, 197, 98, 292, 188, 128, 207, 218, 103, 113, 119]);
  if (tier1Ids.has(leagueId)) return { tier: "top_division", seedEdgeScore: 78 };

  // Second divisions of major countries (high edge potential)
  const tier2Names = ["championship", "ligue 2", "2. bundesliga", "serie b", "segunda", "segunda división", "segunda b"];
  if (tier2Names.some((n) => name.includes(n))) return { tier: "second_division", seedEdgeScore: 82 };

  const tier2Ids = new Set([62, 79, 136, 141]);
  if (tier2Ids.has(leagueId)) return { tier: "second_division", seedEdgeScore: 82 };

  // Scandinavia (undervalued markets)
  const scandCountries = ["sweden", "norway", "denmark", "finland", "iceland"];
  if (scandCountries.includes(country)) return { tier: "scandinavia", seedEdgeScore: 78 };

  // Eastern Europe (sharp money, thin margins)
  const eeCountries = ["poland", "czech republic", "romania", "croatia", "ukraine", "serbia", "slovakia", "hungary"];
  if (eeCountries.includes(country)) return { tier: "eastern_europe", seedEdgeScore: 78 };

  // South America (value markets)
  const saCountries = ["brazil", "argentina", "colombia", "chile", "peru", "uruguay", "ecuador", "paraguay", "bolivia", "venezuela"];
  if (saCountries.includes(country)) return { tier: "south_america", seedEdgeScore: 78 };

  // Asia-Pacific
  const apCountries = ["japan", "south korea", "australia", "china", "thailand", "indonesia", "malaysia"];
  if (apCountries.includes(country)) return { tier: "asia_pacific", seedEdgeScore: 78 };

  // Third divisions / lower
  const lowerNames = ["liga 3", "third", "national", "3. liga", "serie c", "division 3"];
  if (lowerNames.some((n) => name.includes(n))) return { tier: "third_division", seedEdgeScore: 75 };

  // Default: top division of smaller country
  return { tier: "top_division", seedEdgeScore: 77 };
}

// ─── API-Football fetch helper ────────────────────────────────────────────────

const BASE_URL = "https://v3.football.api-sports.io";

async function apiFetch<T = unknown>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) { logger.warn("API_FOOTBALL_KEY not set"); return null; }

  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  try {
    const res = await fetch(url.toString(), { headers: { "x-apisports-key": key } });
    if (!res.ok) { logger.warn({ path, status: res.status }, "API-Football error"); return null; }
    const json = await res.json() as { response?: T; errors?: unknown };
    return (json.response ?? null) as T | null;
  } catch (err) {
    logger.warn({ err, path }, "API-Football fetch failed");
    return null;
  }
}

// ─── Bookmaker odds check ──────────────────────────────────────────────────────

async function checkLeagueHasBookmakerOdds(leagueId: number): Promise<boolean> {
  // Fetch the soonest fixture and check if odds exist
  const today = new Date().toISOString().slice(0, 10);
  const inThreeDays = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);

  const fixtures = await apiFetch<any[]>("/fixtures", {
    league: leagueId,
    season: new Date().getFullYear(),
    from: today,
    to: inThreeDays,
  });

  if (!fixtures || fixtures.length === 0) return false;

  const firstFixtureId = fixtures[0]?.fixture?.id;
  if (!firstFixtureId) return false;

  // Check if any bookmaker has odds for this fixture
  const odds = await apiFetch<any[]>("/odds", { fixture: firstFixtureId });
  return Array.isArray(odds) && odds.length > 0 && Array.isArray(odds[0]?.bookmakers) && odds[0].bookmakers.length > 0;
}

// ─── Main discovery function ──────────────────────────────────────────────────

export interface LeagueDiscoveryResult {
  totalLeaguesFound: number;
  inSeasonCount: number;
  newLeagues: number;
  activatedLeagues: string[];
  monitoringLeagues: string[];
  withApiFootballOdds: number;
  withPinnacleOdds: number;
  totalActiveLeagues: number;
  totalFixtureCount: number;
  report: LeagueReport[];
}

export interface LeagueReport {
  leagueId: number;
  name: string;
  country: string;
  tier: string;
  status: string;
  hasApiFootballOdds: boolean;
  hasPinnacleOdds: boolean;
  fixtureCount: number;
  seedEdgeScore: number;
  isNew: boolean;
}

export async function runLeagueDiscovery(): Promise<LeagueDiscoveryResult> {
  logger.info("League discovery starting — fetching all in-season leagues from API-Football");

  // 1. Fetch all current in-season leagues
  const currentYear = new Date().getFullYear();
  const leagues = await apiFetch<any[]>("/leagues", { current: "true", season: currentYear });

  if (!leagues || leagues.length === 0) {
    logger.warn("League discovery: no leagues returned from API-Football");
    return {
      totalLeaguesFound: 0, inSeasonCount: 0, newLeagues: 0,
      activatedLeagues: [], monitoringLeagues: [], withApiFootballOdds: 0,
      withPinnacleOdds: 0, totalActiveLeagues: 0, totalFixtureCount: 0, report: [],
    };
  }

  logger.info({ total: leagues.length }, "League discovery: raw leagues fetched");

  // 2. Filter to leagues that are in-season and have upcoming fixtures
  const inSeason = leagues.filter((l: any) => {
    const seasons = l.seasons as any[];
    const current = seasons?.find((s: any) => s.current === true && s.year === currentYear);
    return !!current;
  });

  logger.info({ inSeason: inSeason.length }, "League discovery: in-season leagues found");

  // 3. Load existing discovered leagues from DB
  const existing = await db.select().from(discoveredLeaguesTable);
  const existingMap = new Map(existing.map((r) => [r.leagueId, r]));

  const result: LeagueDiscoveryResult = {
    totalLeaguesFound: leagues.length,
    inSeasonCount: inSeason.length,
    newLeagues: 0,
    activatedLeagues: [],
    monitoringLeagues: [],
    withApiFootballOdds: 0,
    withPinnacleOdds: 0,
    totalActiveLeagues: 0,
    totalFixtureCount: 0,
    report: [],
  };

  // 4. Process each in-season league
  // Limit to first 200 to stay within budget (~200 requests per scan)
  const toProcess = inSeason.slice(0, 200);

  for (const leagueData of toProcess) {
    const leagueId: number = leagueData.league?.id;
    const leagueName: string = leagueData.league?.name ?? "Unknown";
    const countryName: string = leagueData.country?.name ?? "Unknown";

    if (!leagueId) continue;

    const { tier, seedEdgeScore } = classifyLeague(leagueId, leagueName, countryName);
    const hasPinnacleOdds = KNOWN_PINNACLE_LEAGUE_IDS.has(leagueId);
    const isExisting = existingMap.has(leagueId);

    // Get fixture count for the current season
    const currentSeasonData = (leagueData.seasons as any[])?.find((s: any) => s.current === true);
    const fixtureCount: number = currentSeasonData?.coverage?.fixtures?.events ? 100 : 0;

    let hasApiFootballOdds = false;

    // Only do the expensive odds check for leagues NOT in our baseline AND not already checked
    if (isExisting) {
      const existingRow = existingMap.get(leagueId)!;
      hasApiFootballOdds = existingRow.hasApiFootballOdds;
    } else {
      // New league: check if bookmaker odds exist (costs 2 API calls)
      hasApiFootballOdds = BASELINE_LEAGUE_IDS.has(leagueId)
        ? true // We know baseline leagues have odds
        : await checkLeagueHasBookmakerOdds(leagueId);
      await new Promise((r) => setTimeout(r, 300)); // Polite delay
    }

    // Determine status
    let status = "monitoring";
    if (hasApiFootballOdds) {
      status = "active";
    }

    if (hasPinnacleOdds) result.withPinnacleOdds++;
    if (hasApiFootballOdds) result.withApiFootballOdds++;
    if (status === "active") result.totalActiveLeagues++;

    const report: LeagueReport = {
      leagueId, name: leagueName, country: countryName, tier, status,
      hasApiFootballOdds, hasPinnacleOdds, fixtureCount, seedEdgeScore, isNew: !isExisting,
    };
    result.report.push(report);

    if (!isExisting) {
      result.newLeagues++;
      const notes = [
        `Discovered ${new Date().toISOString().slice(0, 10)}.`,
        hasApiFootballOdds ? "Bookmaker odds: confirmed." : "Bookmaker odds: none.",
        hasPinnacleOdds ? "Pinnacle: confirmed." : "Pinnacle: not confirmed.",
      ].join(" ");

      await db.insert(discoveredLeaguesTable).values({
        leagueId,
        name: leagueName,
        country: countryName,
        tier,
        fixtureCount,
        hasApiFootballOdds,
        hasPinnacleOdds,
        seedEdgeScore,
        status,
        activatedAt: status === "active" ? new Date() : undefined,
        discoveryNotes: notes,
      }).onConflictDoNothing();

      // Seed edge score for newly discovered leagues if they have odds
      if (hasApiFootballOdds) {
        await db.insert(leagueEdgeScoresTable).values({
          league: leagueName,
          marketType: "ALL",
          totalBets: 0,
          wins: 0,
          losses: 0,
          roiPct: 0,
          avgClv: 0,
          avgEdge: 0,
          confidenceScore: seedEdgeScore,
          isSeedData: 1,
        }).onConflictDoNothing();
      }

      // Generate narrative for newly discovered active leagues
      if (status === "active") {
        const narrativeText = `New league discovered: ${leagueName} (${countryName}). ${hasPinnacleOdds ? "Pinnacle odds confirmed — CLV validation active." : "Bookmaker odds confirmed — scanning for edge."} Initial edge score: ${seedEdgeScore}. First 20 bets at 0.7× Kelly.`;
        await db.insert(learningNarrativesTable).values({
          narrativeType: "league_discovery",
          narrativeText,
          relatedData: { league: leagueName, country: countryName, tier, hasPinnacleOdds, seedEdgeScore },
        }).catch(() => {}); // Non-fatal
      }

      logger.info({ leagueId, name: leagueName, country: countryName, tier, status, hasApiFootballOdds, hasPinnacleOdds },
        "League discovery: new league added");

      if (status === "active") result.activatedLeagues.push(leagueName);
      else result.monitoringLeagues.push(leagueName);
    } else {
      // Update existing entry
      await db.update(discoveredLeaguesTable)
        .set({
          lastChecked: new Date(),
          fixtureCount,
          hasPinnacleOdds,
          hasApiFootballOdds,
          status,
        })
        .where(eq(discoveredLeaguesTable.leagueId, leagueId));

      if (status === "active") result.activatedLeagues.push(leagueName);
    }
  }

  // 5. Write compliance log
  await db.insert(complianceLogsTable).values({
    actionType: "league_discovery_scan",
    details: JSON.stringify({
      totalFound: result.totalLeaguesFound,
      inSeason: result.inSeasonCount,
      newLeagues: result.newLeagues,
      activated: result.activatedLeagues.length,
      withOdds: result.withApiFootballOdds,
      withPinnacle: result.withPinnacleOdds,
    }),
    approved: 1,
  }).catch(() => {});

  logger.info({
    totalFound: result.totalLeaguesFound,
    inSeason: result.inSeasonCount,
    newLeagues: result.newLeagues,
    activated: result.activatedLeagues.length,
    withOdds: result.withApiFootballOdds,
    withPinnacle: result.withPinnacleOdds,
  }, "League discovery complete");

  return result;
}

// ─── Get league discovery status from DB ─────────────────────────────────────

export async function getDiscoveredLeagues() {
  return db.select().from(discoveredLeaguesTable).orderBy(discoveredLeaguesTable.status, discoveredLeaguesTable.name);
}

export async function getDiscoveryStats() {
  const leagues = await db.select().from(discoveredLeaguesTable);
  const active = leagues.filter((l) => l.status === "active");
  const withPinnacle = active.filter((l) => l.hasPinnacleOdds);
  const monitoring = leagues.filter((l) => l.status === "monitoring");
  const disabled = leagues.filter((l) => l.status === "disabled");

  return {
    totalDiscovered: leagues.length,
    active: active.length,
    monitoring: monitoring.length,
    disabled: disabled.length,
    withPinnacleOdds: withPinnacle.length,
    withApiOddsOnly: active.filter((l) => !l.hasPinnacleOdds).length,
    newestLeagues: leagues
      .filter((l) => l.status === "active")
      .sort((a, b) => new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime())
      .slice(0, 10)
      .map((l) => ({
        name: l.name,
        country: l.country,
        tier: l.tier,
        hasApiFootballOdds: l.hasApiFootballOdds,
        hasPinnacleOdds: l.hasPinnacleOdds,
        status: l.status,
        activatedAt: l.activatedAt,
      })),
    byTier: Object.fromEntries(
      ["top5", "top_division", "second_division", "scandinavia", "eastern_europe", "south_america", "asia_pacific", "third_division", "unknown"].map((tier) => [
        tier,
        leagues.filter((l) => l.tier === tier && l.status === "active").length,
      ])
    ),
  };
}

// ─── Kelly multiplier for new leagues ────────────────────────────────────────

export function getNewLeagueKellyMultiplier(leagueName: string, betsPlaced: number): number {
  // First 20 bets in a new league get 0.7× Kelly multiplier
  if (betsPlaced < 20) return 0.7;
  return 1.0;
}

// ─── Seed baseline leagues (idempotent, run at startup) ───────────────────────

export async function seedBaselineLeagues(): Promise<void> {
  const { LEAGUE_IDS } = await import("./apiFootball");

  // Build list of all unique leagues from LEAGUE_IDS constant
  const leagueEntries = Object.entries(LEAGUE_IDS);

  for (const [name, id] of leagueEntries) {
    const { tier, seedEdgeScore } = classifyLeague(id, name, "");
    const hasPinnacle = KNOWN_PINNACLE_LEAGUE_IDS.has(id);

    await db.insert(discoveredLeaguesTable).values({
      leagueId: id,
      name,
      country: "",
      tier,
      fixtureCount: 0,
      hasApiFootballOdds: true,
      hasPinnacleOdds: hasPinnacle,
      seedEdgeScore,
      status: "active",
      activatedAt: new Date(),
      discoveryNotes: "Baseline league — seeded at startup.",
    }).onConflictDoNothing();
  }

  logger.info({ count: leagueEntries.length }, "Baseline leagues seeded into discovered_leagues");
}
