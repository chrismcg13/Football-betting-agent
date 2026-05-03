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

import { db, discoveredLeaguesTable, leagueEdgeScoresTable, learningNarrativesTable, complianceLogsTable, oddspapiFixtureMapTable, matchesTable, oddsSnapshotsTable, competitionConfigTable } from "@workspace/db";
import { eq, inArray, sql, and, like } from "drizzle-orm";
import { logger } from "../lib/logger";
import { ALL_LEAGUE_IDS, TIER1_LEAGUE_IDS, TIER2_LEAGUE_IDS, TIER3_LEAGUE_IDS } from "./apiFootball";
import { listCompetitions } from "./betfair";
import { leagueNameSimilarity } from "./oddsPapiDiscovery";

// ─── Pre-known leagues to ALWAYS include (hardcoded IDs from apiFootball.ts) ──
const BASELINE_LEAGUE_IDS = new Set(ALL_LEAGUE_IDS);
const TIER1_SET = new Set(TIER1_LEAGUE_IDS);
const TIER2_SET = new Set(TIER2_LEAGUE_IDS);

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
  106,  // Polish Ekstraklasa
  345,  // Czech First League
  283,  // Romanian Liga I
  286,  // Serbian SuperLiga
  188,  // A-League (Australia)
  98,   // J1 League (Japan)
  292,  // K-League 1 (South Korea)
  244,  // Finnish Veikkausliiga
  72,   // Brazilian Serie B
  235,  // Russian Premier League
  333,  // Ukrainian Premier League
  207,  // Swiss Super League
  218,  // Austrian Bundesliga
  210,  // Croatian HNL
  253,  // Major League Soccer
  4,    // UEFA Conference League
  62,   // Ligue 2
  79,   // 2. Bundesliga
  141,  // Segunda División
  41,   // EFL League One
  42,   // EFL League Two
  307,  // Saudi Pro League
  288,  // South Africa PSL
  // ─── Phase 1.F additions (2026-05-04) — obvious-Pinnacle internationals,
  //     domestic cups, women's leagues, and friendlies. Static fallback floor;
  //     the weekly /v4/tournaments probe in oddsPapiDiscovery.ts is the
  //     authoritative source for the long tail. See plan v3 1.F.
  // International tournaments (men's)
  1,    // FIFA World Cup
  5,    // UEFA Nations League
  6,    // Africa Cup of Nations
  7,    // AFC Asian Cup
  9,    // Copa America
  10,   // International Friendlies (men's)
  11,   // Gold Cup (CONCACAF)
  848,  // UEFA Nations League (alt ID)
  // International tournaments (women's)
  8,    // FIFA Women's World Cup
  22,   // Women's International Friendlies
  666,  // Women's International Friendlies (alt)
  960,  // UEFA Women's Euro
  // Domestic cups (Europe top-5 + Scotland + Netherlands)
  45,   // FA Cup (England)
  46,   // EFL Cup / Carabao
  66,   // Coupe de France
  81,   // DFB-Pokal (Germany)
  137,  // Coppa Italia
  143,  // Copa del Rey (Spain)
  156,  // KNVB Beker (Netherlands)
  180,  // Scottish Cup
  // Women's domestic leagues
  254,  // NWSL (USA)
  524,  // Serie A Femminile (Italy)
  770,  // Frauen-Bundesliga (Germany)
  771,  // WSL (England)
  773,  // Division 1 Féminine (France)
  775,  // Liga F (Spain)
]);

// ─── Tier classification ──────────────────────────────────────────────────────

function classifyLeague(leagueId: number, leagueName: string, countryName: string): {
  tier: string;
  seedEdgeScore: number;
  numericTier: number;
} {
  if (TIER1_SET.has(leagueId)) return { tier: "tier1", seedEdgeScore: 75, numericTier: 1 };
  if (TIER2_SET.has(leagueId)) return { tier: "tier2", seedEdgeScore: 78, numericTier: 2 };

  const name = leagueName.toLowerCase();
  const country = countryName.toLowerCase();

  const top5Ids = new Set([39, 140, 135, 78, 61, 2, 3]);
  if (top5Ids.has(leagueId)) return { tier: "tier1", seedEdgeScore: 75, numericTier: 1 };

  const tier2Names = ["championship", "ligue 2", "2. bundesliga", "serie b", "segunda", "segunda división"];
  if (tier2Names.some((n) => name.includes(n))) return { tier: "tier2", seedEdgeScore: 82, numericTier: 2 };

  const scandCountries = ["sweden", "norway", "denmark", "finland", "iceland"];
  if (scandCountries.includes(country)) return { tier: "tier2", seedEdgeScore: 78, numericTier: 2 };

  const eeCountries = ["poland", "czech republic", "romania", "croatia", "ukraine", "serbia", "slovakia", "hungary"];
  if (eeCountries.includes(country)) return { tier: "tier2", seedEdgeScore: 78, numericTier: 2 };

  const saCountries = ["brazil", "argentina", "colombia", "chile", "peru", "uruguay", "ecuador", "paraguay", "bolivia", "venezuela"];
  if (saCountries.includes(country)) return { tier: "tier2", seedEdgeScore: 78, numericTier: 2 };

  const apCountries = ["japan", "south korea", "australia", "china", "thailand", "indonesia", "malaysia", "india", "saudi arabia", "qatar", "uae"];
  if (apCountries.includes(country)) return { tier: "tier2", seedEdgeScore: 78, numericTier: 2 };

  const lowerNames = ["liga 3", "third", "national", "3. liga", "serie c", "division 3", "league two", "league one"];
  if (lowerNames.some((n) => name.includes(n))) return { tier: "tier3", seedEdgeScore: 75, numericTier: 3 };

  return { tier: "tier3", seedEdgeScore: 77, numericTier: 3 };
}

function classifyCompetitionType(leagueName: string, leagueType: string): { type: string; gender: string } {
  const name = leagueName.toLowerCase();

  const gender = (name.includes("women") || name.includes("féminine") || name.includes("frauen") ||
    name.includes("femminile") || name.includes("femenina") || name.includes("nwsl") ||
    name.includes("wsl") || name.includes("liga f") || name.includes("she believes")) ? "female" : "male";

  let type: string;
  if (leagueType === "Cup") {
    type = "cup";
  } else if (name.includes("world cup") || name.includes("euro") || name.includes("nations league") ||
    name.includes("copa america") || name.includes("gold cup") || name.includes("africa cup") ||
    name.includes("asian cup") || name.includes("olympic") || name.includes("friendlies") ||
    name.includes("qualifiers")) {
    type = "international";
  } else {
    type = "league";
  }

  return { type, gender };
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

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const prevYear = currentYear - 1;

  const leaguesCurrent = await apiFetch<any[]>("/leagues", { current: "true", season: currentYear });
  const leaguesPrev = currentMonth <= 6
    ? await apiFetch<any[]>("/leagues", { current: "true", season: prevYear })
    : null;

  const seenIds = new Set<number>();
  const allLeagues: any[] = [];
  for (const l of leaguesCurrent ?? []) {
    if (l.league?.id) { seenIds.add(l.league.id); allLeagues.push(l); }
  }
  for (const l of leaguesPrev ?? []) {
    if (l.league?.id && !seenIds.has(l.league.id)) { seenIds.add(l.league.id); allLeagues.push(l); }
  }

  if (allLeagues.length === 0) {
    logger.warn("League discovery: no leagues returned from API-Football");
    return {
      totalLeaguesFound: 0, inSeasonCount: 0, newLeagues: 0,
      activatedLeagues: [], monitoringLeagues: [], withApiFootballOdds: 0,
      withPinnacleOdds: 0, totalActiveLeagues: 0, totalFixtureCount: 0, report: [],
    };
  }

  logger.info({ total: allLeagues.length, currentSeason: leaguesCurrent?.length ?? 0, prevSeason: leaguesPrev?.length ?? 0 }, "League discovery: raw leagues fetched (current + prev season)");

  const inSeason = allLeagues.filter((l: any) => {
    const seasons = l.seasons as any[];
    return seasons?.some((s: any) => s.current === true);
  });

  logger.info({ inSeason: inSeason.length }, "League discovery: in-season leagues found");

  // 3. Load existing discovered leagues from DB
  const existing = await db.select().from(discoveredLeaguesTable);
  const existingMap = new Map(existing.map((r) => [r.leagueId, r]));

  const result: LeagueDiscoveryResult = {
    totalLeaguesFound: allLeagues.length,
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

  // 4. Process ALL in-season leagues (no cap — we have 75k/day budget)
  for (const leagueData of inSeason) {
    const leagueId: number = leagueData.league?.id;
    const leagueName: string = leagueData.league?.name ?? "Unknown";
    const countryName: string = leagueData.country?.name ?? "Unknown";

    if (!leagueId) continue;

    const { tier, seedEdgeScore, numericTier } = classifyLeague(leagueId, leagueName, countryName);
    const leagueType = leagueData.league?.type ?? "League";
    const { type: compType, gender } = classifyCompetitionType(leagueName, leagueType);
    const hasPinnacleOdds = KNOWN_PINNACLE_LEAGUE_IDS.has(leagueId);
    const isExisting = existingMap.has(leagueId);

    const currentSeasonData = (leagueData.seasons as any[])?.find((s: any) => s.current === true);
    const coverage = currentSeasonData?.coverage;
    const hasEvents = !!coverage?.fixtures?.events;
    const hasStatistics = !!coverage?.fixtures?.statistics_fixtures || !!coverage?.fixtures?.statistics;
    const hasLineups = !!coverage?.fixtures?.lineups;
    const fixtureCount: number = hasEvents ? 100 : 0;
    const currentSeason = currentSeasonData?.year as number | undefined;

    const pollingFrequency = numericTier === 1 ? "high" : numericTier === 2 ? "medium" : "low";

    await db.insert(competitionConfigTable).values({
      apiFootballId: leagueId,
      name: leagueName,
      country: countryName,
      type: compType,
      gender,
      tier: numericTier,
      isActive: true,
      hasStatistics,
      hasLineups,
      hasOdds: false,
      hasEvents,
      hasPinnacleOdds,
      currentSeason,
      pollingFrequency,
      coverageCheckedAt: new Date(),
    }).onConflictDoUpdate({
      target: competitionConfigTable.apiFootballId,
      set: {
        isActive: true,
        hasStatistics,
        hasLineups,
        hasEvents,
        // Ratchet upward only: never demote a Pinnacle flag that was promoted
        // dynamically (e.g. via updatePinnacleOddsFromActualMappings or manual
        // operator action). The static KNOWN_PINNACLE_LEAGUE_IDS list is a
        // floor, not a ceiling.
        hasPinnacleOdds: sql`${competitionConfigTable.hasPinnacleOdds} OR ${hasPinnacleOdds}`,
        currentSeason,
        pollingFrequency,
        coverageCheckedAt: new Date(),
      },
    });

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
      // Update existing entry. Ratchet hasPinnacleOdds upward only so that
      // dynamic promotion (from updatePinnacleOddsFromActualMappings or manual
      // operator action) is not wiped by the static KNOWN_PINNACLE_LEAGUE_IDS
      // floor.
      await db.update(discoveredLeaguesTable)
        .set({
          lastChecked: new Date(),
          fixtureCount,
          hasPinnacleOdds: sql`${discoveredLeaguesTable.hasPinnacleOdds} OR ${hasPinnacleOdds}`,
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
  const { LEAGUE_IDS, ALL_LEAGUE_IDS } = await import("./apiFootball");

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

  const nameById = new Map(leagueEntries.map(([n, id]) => [id, n]));

  for (const id of ALL_LEAGUE_IDS) {
    if (nameById.has(id)) continue;
    const meta = LEAGUE_ID_NAMES[id];
    const name = meta?.name ?? `League ${id}`;
    const country = meta?.country ?? "";
    const { tier, seedEdgeScore } = classifyLeague(id, name, country);
    const hasPinnacle = KNOWN_PINNACLE_LEAGUE_IDS.has(id);

    await db.insert(discoveredLeaguesTable).values({
      leagueId: id,
      name,
      country,
      tier,
      fixtureCount: 0,
      hasApiFootballOdds: true,
      hasPinnacleOdds: hasPinnacle,
      seedEdgeScore,
      status: "active",
      activatedAt: new Date(),
      discoveryNotes: `Baseline league — seeded at startup via ALL_LEAGUE_IDS. ${meta ? `(${meta.type}, ${meta.gender})` : ""}`,
    }).onConflictDoNothing();

    // Also update name if entry already exists with generic name
    if (meta) {
      await db.update(discoveredLeaguesTable)
        .set({ name, country })
        .where(and(
          eq(discoveredLeaguesTable.leagueId, id),
          like(discoveredLeaguesTable.name, "League %"),
        ));
    }
  }

  logger.info({ count: leagueEntries.length + ALL_LEAGUE_IDS.length }, "Baseline leagues seeded into discovered_leagues");
}

// ─── Seed competition config from hardcoded tier lists ──────────────────────

const LEAGUE_ID_NAMES: Record<number, { name: string; country: string; type: string; gender: string }> = {
  1: { name: "FIFA World Cup", country: "World", type: "international", gender: "male" },
  2: { name: "UEFA Champions League", country: "World", type: "cup", gender: "male" },
  3: { name: "UEFA Europa League", country: "World", type: "cup", gender: "male" },
  4: { name: "UEFA Conference League", country: "World", type: "cup", gender: "male" },
  5: { name: "UEFA Nations League", country: "Europe", type: "international", gender: "male" },
  6: { name: "Africa Cup of Nations", country: "Africa", type: "international", gender: "male" },
  7: { name: "AFC Asian Cup", country: "Asia", type: "international", gender: "male" },
  8: { name: "FIFA Women's World Cup", country: "World", type: "international", gender: "female" },
  9: { name: "Copa America", country: "South America", type: "international", gender: "male" },
  10: { name: "International Friendlies", country: "World", type: "international", gender: "male" },
  11: { name: "CONCACAF Gold Cup", country: "North America", type: "international", gender: "male" },
  12: { name: "CAF Champions League", country: "Africa", type: "cup", gender: "male" },
  13: { name: "CONMEBOL Libertadores", country: "South America", type: "cup", gender: "male" },
  14: { name: "CONMEBOL Sudamericana", country: "South America", type: "cup", gender: "male" },
  15: { name: "FIFA WC Qualifiers - UEFA", country: "Europe", type: "international", gender: "male" },
  16: { name: "CONCACAF Champions Cup", country: "North America", type: "cup", gender: "male" },
  17: { name: "AFC Champions League", country: "Asia", type: "cup", gender: "male" },
  20: { name: "CAF Confederation Cup", country: "Africa", type: "cup", gender: "male" },
  22: { name: "International Friendlies Women", country: "World", type: "international", gender: "female" },
  29: { name: "FIFA WC Qualifiers - CONMEBOL", country: "South America", type: "international", gender: "male" },
  30: { name: "FIFA WC Qualifiers - AFC", country: "Asia", type: "international", gender: "male" },
  31: { name: "FIFA WC Qualifiers - CONCACAF", country: "North America", type: "international", gender: "male" },
  33: { name: "FIFA WC Qualifiers - CAF", country: "Africa", type: "international", gender: "male" },
  34: { name: "FIFA WC Qualifiers - OFC", country: "Oceania", type: "international", gender: "male" },
  39: { name: "Premier League", country: "England", type: "league", gender: "male" },
  40: { name: "Championship", country: "England", type: "league", gender: "male" },
  41: { name: "EFL League One", country: "England", type: "league", gender: "male" },
  42: { name: "EFL League Two", country: "England", type: "league", gender: "male" },
  43: { name: "National League", country: "England", type: "league", gender: "male" },
  45: { name: "FA Cup", country: "England", type: "cup", gender: "male" },
  50: { name: "National League North", country: "England", type: "league", gender: "male" },
  51: { name: "National League South", country: "England", type: "league", gender: "male" },
  46: { name: "League Cup", country: "England", type: "cup", gender: "male" },
  61: { name: "Ligue 1", country: "France", type: "league", gender: "male" },
  62: { name: "Ligue 2", country: "France", type: "league", gender: "male" },
  63: { name: "National 1", country: "France", type: "league", gender: "male" },
  66: { name: "Coupe de France", country: "France", type: "cup", gender: "male" },
  71: { name: "Brasileirão Série A", country: "Brazil", type: "league", gender: "male" },
  78: { name: "Bundesliga", country: "Germany", type: "league", gender: "male" },
  79: { name: "2. Bundesliga", country: "Germany", type: "league", gender: "male" },
  80: { name: "3. Liga", country: "Germany", type: "league", gender: "male" },
  81: { name: "DFB-Pokal", country: "Germany", type: "cup", gender: "male" },
  88: { name: "Eredivisie", country: "Netherlands", type: "league", gender: "male" },
  94: { name: "Primeira Liga", country: "Portugal", type: "league", gender: "male" },
  95: { name: "Segunda Liga", country: "Portugal", type: "league", gender: "male" },
  98: { name: "J1 League", country: "Japan", type: "league", gender: "male" },
  103: { name: "Eliteserien", country: "Norway", type: "league", gender: "male" },
  104: { name: "OBOS-ligaen", country: "Norway", type: "league", gender: "male" },
  106: { name: "Ekstraklasa", country: "Poland", type: "league", gender: "male" },
  113: { name: "Allsvenskan", country: "Sweden", type: "league", gender: "male" },
  114: { name: "Superettan", country: "Sweden", type: "league", gender: "male" },
  119: { name: "Superliga", country: "Denmark", type: "league", gender: "male" },
  120: { name: "1st Division", country: "Denmark", type: "league", gender: "male" },
  128: { name: "Liga Profesional", country: "Argentina", type: "league", gender: "male" },
  135: { name: "Serie A", country: "Italy", type: "league", gender: "male" },
  136: { name: "Serie B", country: "Italy", type: "league", gender: "male" },
  137: { name: "Coppa Italia", country: "Italy", type: "cup", gender: "male" },
  138: { name: "Serie C", country: "Italy", type: "league", gender: "male" },
  140: { name: "La Liga", country: "Spain", type: "league", gender: "male" },
  141: { name: "Segunda División", country: "Spain", type: "league", gender: "male" },
  143: { name: "Copa del Rey", country: "Spain", type: "cup", gender: "male" },
  144: { name: "Jupiler Pro League", country: "Belgium", type: "league", gender: "male" },
  145: { name: "First Division B", country: "Belgium", type: "league", gender: "male" },
  156: { name: "KNVB Beker", country: "Netherlands", type: "cup", gender: "male" },
  157: { name: "Copa do Brasil", country: "Brazil", type: "cup", gender: "male" },
  169: { name: "Chinese Super League", country: "China", type: "league", gender: "male" },
  179: { name: "Scottish Premiership", country: "Scotland", type: "league", gender: "male" },
  180: { name: "Scottish Championship", country: "Scotland", type: "league", gender: "male" },
  181: { name: "Scottish FA Cup", country: "Scotland", type: "cup", gender: "male" },
  183: { name: "Scottish League One", country: "Scotland", type: "league", gender: "male" },
  184: { name: "Scottish League Two", country: "Scotland", type: "league", gender: "male" },
  188: { name: "A-League Men", country: "Australia", type: "league", gender: "male" },
  196: { name: "A-League Women", country: "Australia", type: "league", gender: "female" },
  197: { name: "Super League", country: "Greece", type: "league", gender: "male" },
  200: { name: "Botola Pro", country: "Morocco", type: "league", gender: "male" },
  201: { name: "Ligue 1", country: "Algeria", type: "league", gender: "male" },
  202: { name: "Ligue 1", country: "Tunisia", type: "league", gender: "male" },
  203: { name: "Süper Lig", country: "Turkey", type: "league", gender: "male" },
  204: { name: "1. Lig", country: "Turkey", type: "league", gender: "male" },
  207: { name: "Super League", country: "Switzerland", type: "league", gender: "male" },
  210: { name: "HNL", country: "Croatia", type: "league", gender: "male" },
  218: { name: "Bundesliga", country: "Austria", type: "league", gender: "male" },
  230: { name: "Liga MX", country: "Mexico", type: "league", gender: "male" },
  231: { name: "Liga Expansión MX", country: "Mexico", type: "league", gender: "male" },
  233: { name: "Egyptian Premier League", country: "Egypt", type: "league", gender: "male" },
  235: { name: "Premier Liga", country: "Russia", type: "league", gender: "male" },
  239: { name: "Primera División", country: "Costa Rica", type: "league", gender: "male" },
  242: { name: "Serie A", country: "Ecuador", type: "league", gender: "male" },
  253: { name: "Major League Soccer", country: "USA", type: "league", gender: "male" },
  254: { name: "NWSL", country: "USA", type: "league", gender: "female" },
  262: { name: "Liga BetPlay", country: "Colombia", type: "league", gender: "male" },
  265: { name: "Primera División", country: "Chile", type: "league", gender: "male" },
  268: { name: "Primera División", country: "Uruguay", type: "league", gender: "male" },
  270: { name: "Primera División", country: "Paraguay", type: "league", gender: "male" },
  271: { name: "Primera División", country: "Bolivia", type: "league", gender: "male" },
  281: { name: "Liga 1", country: "Peru", type: "league", gender: "male" },
  283: { name: "Liga I", country: "Romania", type: "league", gender: "male" },
  288: { name: "Premier Division", country: "South Africa", type: "league", gender: "male" },
  292: { name: "K League 1", country: "South Korea", type: "league", gender: "male" },
  296: { name: "Thai League 1", country: "Thailand", type: "league", gender: "male" },
  299: { name: "Primera División", country: "Venezuela", type: "league", gender: "male" },
  301: { name: "Stars League", country: "Qatar", type: "league", gender: "male" },
  305: { name: "Pro League", country: "UAE", type: "league", gender: "male" },
  307: { name: "Saudi Pro League", country: "Saudi Arabia", type: "league", gender: "male" },
  318: { name: "Premier League", country: "Ghana", type: "league", gender: "male" },
  320: { name: "Premier League", country: "Kenya", type: "league", gender: "male" },
  399: { name: "NPFL", country: "Nigeria", type: "league", gender: "male" },
  323: { name: "Indian Super League", country: "India", type: "league", gender: "male" },
  332: { name: "Liga Nacional", country: "Honduras", type: "league", gender: "male" },
  333: { name: "Premier League", country: "Ukraine", type: "league", gender: "male" },
  345: { name: "Czech First League", country: "Czech Republic", type: "league", gender: "male" },
  480: { name: "Olympic Football Men", country: "World", type: "international", gender: "male" },
  523: { name: "Olympic Football Women", country: "World", type: "international", gender: "female" },
  524: { name: "Serie A Femminile", country: "Italy", type: "league", gender: "female" },
  770: { name: "Frauen-Bundesliga", country: "Germany", type: "league", gender: "female" },
  771: { name: "WSL", country: "England", type: "league", gender: "female" },
  773: { name: "Division 1 Féminine", country: "France", type: "league", gender: "female" },
  775: { name: "Liga F", country: "Spain", type: "league", gender: "female" },
  790: { name: "Brasileiro Feminino", country: "Brazil", type: "league", gender: "female" },
  848: { name: "UEFA Nations League", country: "Europe", type: "international", gender: "male" },
  880: { name: "Women's WC Qualifiers - Europe", country: "Europe", type: "international", gender: "female" },
  960: { name: "UEFA Women's Euro", country: "Europe", type: "international", gender: "female" },
  1040: { name: "UEFA Nations League Women", country: "Europe", type: "international", gender: "female" },
  1083: { name: "UEFA Women's Championship Qualifiers", country: "Europe", type: "international", gender: "female" },
  666: { name: "Women's International Friendlies", country: "World", type: "international", gender: "female" },
  18: { name: "AFC Cup", country: "Asia", type: "cup", gender: "male" },
  19: { name: "CAF Super Cup", country: "Africa", type: "cup", gender: "male" },
  32: { name: "AFCON Qualifiers", country: "Africa", type: "international", gender: "male" },
  35: { name: "WCQ CONMEBOL", country: "South America", type: "international", gender: "male" },
  36: { name: "WCQ AFC", country: "Asia", type: "international", gender: "male" },
  37: { name: "WCQ CAF", country: "Africa", type: "international", gender: "male" },
  38: { name: "WCQ OFC", country: "Oceania", type: "international", gender: "male" },
  44: { name: "FA Community Shield", country: "England", type: "cup", gender: "male" },
  64: { name: "National 2", country: "France", type: "league", gender: "male" },
  72: { name: "Brasileirão Série B", country: "Brazil", type: "league", gender: "male" },
  73: { name: "Brasileirão Série C", country: "Brazil", type: "league", gender: "male" },
  75: { name: "Copa do Nordeste", country: "Brazil", type: "cup", gender: "male" },
  89: { name: "Eerste Divisie", country: "Netherlands", type: "league", gender: "male" },
  99: { name: "J2 League", country: "Japan", type: "league", gender: "male" },
  100: { name: "J3 League", country: "Japan", type: "league", gender: "male" },
  107: { name: "I Liga", country: "Poland", type: "league", gender: "male" },
  129: { name: "Copa de la Liga", country: "Argentina", type: "cup", gender: "male" },
  142: { name: "Segunda División RFEF", country: "Spain", type: "league", gender: "male" },
  170: { name: "Chinese League One", country: "China", type: "league", gender: "male" },
  182: { name: "Scottish League Cup", country: "Scotland", type: "cup", gender: "male" },
  198: { name: "Super League 2", country: "Greece", type: "league", gender: "male" },
  208: { name: "Swiss Challenge League", country: "Switzerland", type: "league", gender: "male" },
  211: { name: "Druga HNL", country: "Croatia", type: "league", gender: "male" },
  219: { name: "2. Liga", country: "Austria", type: "league", gender: "male" },
  234: { name: "Liga Panameña", country: "Panama", type: "league", gender: "male" },
  240: { name: "Primera División", country: "El Salvador", type: "league", gender: "male" },
  241: { name: "Liga Nacional", country: "Guatemala", type: "league", gender: "male" },
  243: { name: "Jamaica Premier League", country: "Jamaica", type: "league", gender: "male" },
  255: { name: "USL Championship", country: "USA", type: "league", gender: "male" },
  256: { name: "USL League One", country: "USA", type: "league", gender: "male" },
  258: { name: "Canadian Premier League", country: "Canada", type: "league", gender: "male" },
  269: { name: "Primera B", country: "Venezuela", type: "league", gender: "male" },
  279: { name: "Liga Dominicana", country: "Dominican Republic", type: "league", gender: "male" },
  284: { name: "Liga II", country: "Romania", type: "league", gender: "male" },
  286: { name: "First Professional League", country: "Bulgaria", type: "league", gender: "male" },
  289: { name: "National First Division", country: "South Africa", type: "league", gender: "male" },
  293: { name: "K League 2", country: "South Korea", type: "league", gender: "male" },
  297: { name: "Thai League 2", country: "Thailand", type: "league", gender: "male" },
  298: { name: "V-League", country: "Vietnam", type: "league", gender: "male" },
  302: { name: "Qatar Second Division", country: "Qatar", type: "league", gender: "male" },
  308: { name: "Saudi First Division", country: "Saudi Arabia", type: "league", gender: "male" },
  319: { name: "Ethiopian Premier League", country: "Ethiopia", type: "league", gender: "male" },
  321: { name: "Uganda Premier League", country: "Uganda", type: "league", gender: "male" },
  322: { name: "Tanzanian Premier League", country: "Tanzania", type: "league", gender: "male" },
  324: { name: "I-League", country: "India", type: "league", gender: "male" },
  325: { name: "Malaysian Super League", country: "Malaysia", type: "league", gender: "male" },
  326: { name: "Malaysian Premier League", country: "Malaysia", type: "league", gender: "male" },
  334: { name: "Zambian Super League", country: "Zambia", type: "league", gender: "male" },
  335: { name: "Zimbabwe PSL", country: "Zimbabwe", type: "league", gender: "male" },
  336: { name: "PrvaLiga", country: "Slovenia", type: "league", gender: "male" },
  338: { name: "Kazakhstan Premier League", country: "Kazakhstan", type: "league", gender: "male" },
  340: { name: "Uzbekistan Super League", country: "Uzbekistan", type: "league", gender: "male" },
  346: { name: "FNL", country: "Czech Republic", type: "league", gender: "male" },
  347: { name: "Persha Liga", country: "Ukraine", type: "league", gender: "male" },
  348: { name: "Vysshaya Liga", country: "Belarus", type: "league", gender: "male" },
  354: { name: "Ligat HaAl", country: "Israel", type: "league", gender: "male" },
  355: { name: "Super Liga", country: "Serbia", type: "league", gender: "male" },
  357: { name: "League of Ireland Premier", country: "Ireland", type: "league", gender: "male" },
  372: { name: "Superliga", country: "Albania", type: "league", gender: "male" },
  373: { name: "Premijer Liga", country: "Bosnia-Herzegovina", type: "league", gender: "male" },
  374: { name: "Veikkausliiga", country: "Finland", type: "league", gender: "male" },
  375: { name: "Virsliga", country: "Latvia", type: "league", gender: "male" },
  376: { name: "A Lyga", country: "Lithuania", type: "league", gender: "male" },
  377: { name: "Úrvalsdeild", country: "Iceland", type: "league", gender: "male" },
  378: { name: "First Division", country: "Cyprus", type: "league", gender: "male" },
  382: { name: "Meistriliiga", country: "Estonia", type: "league", gender: "male" },
  383: { name: "Erovnuli Liga", country: "Georgia", type: "league", gender: "male" },
  384: { name: "Prva Liga", country: "North Macedonia", type: "league", gender: "male" },
  385: { name: "Betrideildin", country: "Faroe Islands", type: "league", gender: "male" },
  387: { name: "Meridianbet 1. CFL", country: "Montenegro", type: "league", gender: "male" },
  388: { name: "National Division", country: "Luxembourg", type: "league", gender: "male" },
  390: { name: "Divizia Nationala", country: "Moldova", type: "league", gender: "male" },
  396: { name: "NIFL Premiership", country: "Northern Ireland", type: "league", gender: "male" },
  528: { name: "EFL Trophy", country: "England", type: "cup", gender: "male" },
  527: { name: "Premier League 2", country: "England", type: "league", gender: "male" },
  530: { name: "CONCACAF Nations League", country: "North America", type: "international", gender: "male" },
  772: { name: "Championship Women", country: "England", type: "league", gender: "female" },
  793: { name: "Damallsvenskan", country: "Sweden", type: "league", gender: "female" },
  794: { name: "Toppserien", country: "Norway", type: "league", gender: "female" },
  795: { name: "Kvindeligaen", country: "Denmark", type: "league", gender: "female" },
  868: { name: "UEFA Youth League", country: "Europe", type: "cup", gender: "male" },
  891: { name: "W-League", country: "Australia", type: "league", gender: "female" },
  1082: { name: "WCQ Women CONMEBOL", country: "South America", type: "international", gender: "female" },
  1084: { name: "WCQ Women AFC", country: "Asia", type: "international", gender: "female" },
  1085: { name: "WCQ Women CAF", country: "Africa", type: "international", gender: "female" },
  1086: { name: "WCQ Women CONCACAF", country: "North America", type: "international", gender: "female" },
};

export async function seedCompetitionConfig(): Promise<{ seeded: number }> {
  let seeded = 0;
  for (const leagueId of ALL_LEAGUE_IDS) {
    const meta = LEAGUE_ID_NAMES[leagueId];
    if (!meta) continue;

    const { numericTier } = classifyLeague(leagueId, meta.name, meta.country);
    const pollingFrequency = numericTier === 1 ? "high" : numericTier === 2 ? "medium" : "low";

    try {
      const result = await db.insert(competitionConfigTable).values({
        apiFootballId: leagueId,
        name: meta.name,
        country: meta.country,
        type: meta.type,
        gender: meta.gender,
        tier: numericTier,
        isActive: true,
        hasStatistics: false,
        hasLineups: false,
        hasOdds: false,
        hasEvents: false,
        hasPinnacleOdds: KNOWN_PINNACLE_LEAGUE_IDS.has(leagueId),
        pollingFrequency,
      }).onConflictDoNothing();
      if ((result.rowCount ?? 0) > 0) seeded++;
    } catch (err) {
      logger.warn({ err, leagueId }, "Failed to seed competition config entry");
    }
  }
  logger.info({ seeded, total: ALL_LEAGUE_IDS.length }, "Competition config seeding complete");
  return { seeded };
}

export async function getCompetitionCoverageStats(): Promise<{
  totalCompetitions: number;
  activeCompetitions: number;
  byTier: Record<string, number>;
  byType: Record<string, number>;
  byGender: Record<string, number>;
  withPinnacle: number;
  withStatistics: number;
  pollingBreakdown: Record<string, number>;
}> {
  const all = await db.select().from(competitionConfigTable);
  const active = all.filter((c) => c.isActive);

  const byTier: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
  const byType: Record<string, number> = { league: 0, cup: 0, international: 0 };
  const byGender: Record<string, number> = { male: 0, female: 0 };
  const pollingBreakdown: Record<string, number> = { high: 0, medium: 0, low: 0, dormant: 0 };
  let withPinnacle = 0;
  let withStatistics = 0;

  for (const c of all) {
    byTier[String(c.tier)] = (byTier[String(c.tier)] ?? 0) + 1;
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    byGender[c.gender] = (byGender[c.gender] ?? 0) + 1;
    pollingBreakdown[c.pollingFrequency] = (pollingBreakdown[c.pollingFrequency] ?? 0) + 1;
    if (c.hasPinnacleOdds) withPinnacle++;
    if (c.hasStatistics) withStatistics++;
  }

  return {
    totalCompetitions: all.length,
    activeCompetitions: active.length,
    byTier,
    byType,
    byGender,
    withPinnacle,
    withStatistics,
    pollingBreakdown,
  };
}

// ─── Dynamic Pinnacle coverage update ─────────────────────────────────────────
// After OddsPapi fixture mapping runs, check which leagues actually have mapped
// fixtures and update hasPinnacleOdds accordingly. This is more accurate than
// the static KNOWN_PINNACLE_LEAGUE_IDS list.

export async function updatePinnacleOddsFromActualMappings(): Promise<{
  updated: number;
  leaguesWithPinnacle: string[];
}> {
  // Strategy 1: leagues that have actual Pinnacle bookmaker data via API-Football
  // source = "api_football_real:Pinnacle" is the most reliable signal
  const leaguesWithAfPinnacle = await db
    .selectDistinct({ league: matchesTable.league })
    .from(oddsSnapshotsTable)
    .innerJoin(matchesTable, eq(oddsSnapshotsTable.matchId, matchesTable.id))
    .where(eq(oddsSnapshotsTable.source, "api_football_real:Pinnacle"));

  // Strategy 2: leagues with OddsPapi fixture mappings (secondary signal)
  const leaguesWithOddsPapiMapping = await db
    .selectDistinct({ league: matchesTable.league })
    .from(oddspapiFixtureMapTable)
    .innerJoin(matchesTable, eq(oddspapiFixtureMapTable.matchId, matchesTable.id));

  // Merge both sources
  const leagueSet = new Set<string>();
  for (const r of leaguesWithAfPinnacle) leagueSet.add(r.league);
  for (const r of leaguesWithOddsPapiMapping) leagueSet.add(r.league);
  const leagueNames = [...leagueSet];

  if (leagueNames.length === 0) {
    logger.info("No Pinnacle coverage found from any source — hasPinnacleOdds unchanged");
    return { updated: 0, leaguesWithPinnacle: [] };
  }

  // Update discovered_leagues for these leagues
  let updated = 0;
  let ccUpdated = 0;
  for (const name of leagueNames) {
    const result = await db
      .update(discoveredLeaguesTable)
      .set({ hasPinnacleOdds: true, lastChecked: new Date() })
      .where(and(eq(discoveredLeaguesTable.name, name), eq(discoveredLeaguesTable.hasPinnacleOdds, false)));

    if ((result.rowCount ?? 0) > 0) {
      updated++;
      logger.info({ league: name }, "Updated hasPinnacleOdds=true from Pinnacle data (API-Football or OddsPapi)");
    }

    // Phase 1.E (2026-05-04): also propagate to competition_config so the
    // trading-cycle gate at scheduler.ts:937-948 (which reads competition_config,
    // not discovered_leagues) sees the promotion. Case-insensitive name match
    // because the gate lowercases on read.
    const ccResult = await db.execute(sql`
      UPDATE competition_config
      SET has_pinnacle_odds = true
      WHERE LOWER(name) = LOWER(${name})
        AND has_pinnacle_odds = false
    `);
    const ccRowCount = (ccResult as { rowCount?: number }).rowCount ?? 0;
    if (ccRowCount > 0) {
      ccUpdated++;
      logger.info({ league: name }, "Promoted competition_config.has_pinnacle_odds=true (bidirectional sync)");
    }
  }

  logger.info(
    {
      afPinnacle: leaguesWithAfPinnacle.length,
      oddsPapiMapped: leaguesWithOddsPapiMapping.length,
      discoveredLeaguesUpdated: updated,
      competitionConfigUpdated: ccUpdated,
    },
    "Pinnacle coverage sync complete",
  );
  return { updated, leaguesWithPinnacle: leagueNames };
}

// ─── Betfair Exchange coverage sync (Phase 1.C + 1.D.1 aggressive matcher) ───
// Calls Betfair listCompetitions("1") (eventTypeId=1 = football) and matches
// each Betfair competition to a competition_config row using a 4-pass matcher:
//
//   Pass 1: strict token-set ratio ≥ 0.85 with country tie-breaker
//           (combined = 0.7×nameSim + 0.3×countrySim)
//   Pass 2: relaxed token-set ratio ≥ 0.70, country tolerance
//   Pass 3: slug-strict equality (alphanum-only normalised)
//   Pass 4: substring containment (≥ 8 char overlap), country tolerance
//
// Each pass tries all unmatched Betfair competitions. Each Betfair competition
// matches at most once (first pass to land it wins). The match-method is
// logged so we can audit aggressiveness and false-positive rate.
//
// Ratchets has_betfair_exchange=true on match (one-way). Logs unmatched with
// nearest-neighbour for manual curation. Runs weekly Sunday 02:30 UTC; can
// also be triggered manually via POST /api/admin/sync-betfair-coverage.

const BETFAIR_SIM_THRESHOLD_STRICT = 0.85;
const BETFAIR_SIM_THRESHOLD_LOOSE = 0.70;
const BETFAIR_COUNTRY_TOLERANCE = 0.5;
const BETFAIR_SUBSTRING_MIN_CHARS = 6;
const BETFAIR_PASS1_COMBINED_FLOOR = 0.85;

// Betfair returns competitionRegion as ISO 3-letter codes (BRA, GBR, USA, KOR,
// etc.) but our competition_config.country uses full English names. Without
// translation, country fuzzy-match always near-zero. This map normalises ISO
// codes → country names before comparison. GBR is ambiguous (England /
// Scotland / Wales / NI separately in cc) — handled in normaliseRegion below.
const ISO_TO_COUNTRY: Record<string, string> = {
  ARG: "Argentina", AUS: "Australia", AUT: "Austria", BEL: "Belgium",
  BHR: "Bahrain", BLR: "Belarus", BIH: "Bosnia and Herzegovina",
  BRA: "Brazil", BGR: "Bulgaria", CAN: "Canada", CHE: "Switzerland",
  CHL: "Chile", CHN: "China", COL: "Colombia", CRO: "Croatia", HRV: "Croatia",
  CZE: "Czech Republic", DEU: "Germany", DNK: "Denmark", ECU: "Ecuador",
  EGY: "Egypt", ENG: "England", ESP: "Spain", FIN: "Finland", FRA: "France",
  GRC: "Greece", HKG: "Hong Kong", HUN: "Hungary", IDN: "Indonesia",
  IND: "India", IRL: "Ireland", IRN: "Iran", ISL: "Iceland", ISR: "Israel",
  ITA: "Italy", JPN: "Japan", KOR: "South Korea", LUX: "Luxembourg",
  MEX: "Mexico", MKD: "North Macedonia", NGA: "Nigeria", NLD: "Netherlands",
  NOR: "Norway", NZL: "New Zealand", PAK: "Pakistan", PER: "Peru",
  PHL: "Philippines", POL: "Poland", PRT: "Portugal", PRY: "Paraguay",
  QAT: "Qatar", ROU: "Romania", RUS: "Russia", SAU: "Saudi Arabia",
  SCO: "Scotland", SRB: "Serbia", SVK: "Slovakia", SVN: "Slovenia",
  SWE: "Sweden", THA: "Thailand", TUR: "Turkey", UKR: "Ukraine",
  URY: "Uruguay", USA: "USA", VEN: "Venezuela", VNM: "Vietnam",
  ZAF: "South Africa", WAL: "Wales",
};

function normaliseRegion(region: string, bcName: string): string {
  const upper = region.toUpperCase();
  if (upper === "GBR") {
    // GBR is ambiguous — try to disambiguate from name hints
    const lower = bcName.toLowerCase();
    if (lower.includes("scottish") || lower.includes("scotland")) return "Scotland";
    if (lower.includes("welsh") || lower.includes("wales")) return "Wales";
    if (lower.includes("northern irish") || lower.includes("northern ireland")) return "Northern Ireland";
    return "England"; // default — most common GBR football market
  }
  if (upper === "INTERNATIONAL") return "World";
  return ISO_TO_COUNTRY[upper] ?? region;
}

function slugifyAlnum(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function normaliseForSubstring(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface CcRow {
  id: number;
  name: string;
  country: string;
  hasBetfairExchange: boolean;
}

interface MatchResult {
  cc: CcRow;
  method: "strict" | "loose" | "slug" | "substring";
  nameSim: number;
  countrySim: number;
  combined: number;
}

function findBestMatch(
  bcName: string,
  bcRegion: string,
  ccRows: CcRow[],
  excludedIds: Set<number>,
): MatchResult | null {
  // Normalise ISO country code → country name for fuzzy comparison
  const bcRegionNormalised = normaliseRegion(bcRegion, bcName);

  // Pass 1: strict token-set ≥ 0.85. Combined floor only enforced when BOTH
  // country fields are meaningful (non-blank, non-"World", non-"International").
  // Pre-2026-05-04 commit ca28646 bug: only nameSim thresholded → allowed
  // "Brazilian Serie C" (BRA) to match Italian Serie C cross-country.
  // Commit 7fa1519 over-corrected: combined-floor enforcement when country
  // fields blank rejected 56 legitimate matches (CL/EL/internationals where
  // categoryName=="International" or cc.country=="" gives countrySim=0).
  // This commit: combined floor only kicks in when both countries are
  // present and disagree — i.e., catches actual cross-country bleed without
  // rejecting "country signal unavailable" cases.
  let best: MatchResult | null = null;
  const bcCountryMeaningful =
    bcRegionNormalised.trim() !== "" && bcRegionNormalised.toLowerCase() !== "world";
  for (const cc of ccRows) {
    if (excludedIds.has(cc.id)) continue;
    const nameSim = leagueNameSimilarity(bcName, cc.name);
    if (nameSim < BETFAIR_SIM_THRESHOLD_STRICT) continue;
    const countrySim = leagueNameSimilarity(bcRegionNormalised, cc.country ?? "");
    const combined = nameSim * 0.7 + countrySim * 0.3;
    const ccCountryMeaningful =
      (cc.country ?? "").trim() !== "" && (cc.country ?? "").toLowerCase() !== "world";
    if (ccCountryMeaningful && bcCountryMeaningful && combined < BETFAIR_PASS1_COMBINED_FLOOR) {
      continue;
    }
    if (!best || combined > best.combined) {
      best = { cc, method: "strict", nameSim, countrySim, combined };
    }
  }
  if (best) return best;

  // Pass 2: loose token-set ≥ 0.70 with country tolerance — require country
  // signal when cc.country is populated (avoids cross-country same-name false
  // positives for "Premier League", "Primera División", etc.)
  for (const cc of ccRows) {
    if (excludedIds.has(cc.id)) continue;
    const nameSim = leagueNameSimilarity(bcName, cc.name);
    if (nameSim < BETFAIR_SIM_THRESHOLD_LOOSE) continue;
    const countrySim = leagueNameSimilarity(bcRegionNormalised, cc.country ?? "");
    if ((cc.country ?? "") !== "" && countrySim < BETFAIR_COUNTRY_TOLERANCE) continue;
    const combined = nameSim * 0.7 + countrySim * 0.3;
    if (!best || combined > best.combined) {
      best = { cc, method: "loose", nameSim, countrySim, combined };
    }
  }
  if (best) return best;

  // Pass 3: slug-strict equality (alphanum-only)
  const bSlug = slugifyAlnum(bcName);
  if (bSlug.length >= 4) {
    for (const cc of ccRows) {
      if (excludedIds.has(cc.id)) continue;
      const ccSlug = slugifyAlnum(cc.name);
      if (ccSlug === bSlug && ccSlug.length >= 4) {
        return { cc, method: "slug", nameSim: 1.0, countrySim: 0, combined: 1.0 };
      }
    }
  }

  // Pass 4: substring containment with country tolerance — Betfair name fully
  // contains a competition_config row's name (or vice versa), at least 6
  // matching characters (down from 8 to catch "Serie A" 7 chars and "FA Cup"
  // 6 chars). Country tolerance still required when cc.country populated.
  const bNorm = normaliseForSubstring(bcName);
  for (const cc of ccRows) {
    if (excludedIds.has(cc.id)) continue;
    const ccNorm = normaliseForSubstring(cc.name);
    if (!ccNorm || !bNorm) continue;
    const longer = bNorm.length >= ccNorm.length ? bNorm : ccNorm;
    const shorter = bNorm.length >= ccNorm.length ? ccNorm : bNorm;
    if (shorter.length < BETFAIR_SUBSTRING_MIN_CHARS) continue;
    if (!longer.includes(shorter)) continue;
    const countrySim = leagueNameSimilarity(bcRegionNormalised, cc.country ?? "");
    if ((cc.country ?? "") !== "" && countrySim < BETFAIR_COUNTRY_TOLERANCE) continue;
    return { cc, method: "substring", nameSim: 0.75, countrySim, combined: 0.75 };
  }

  return null;
}

export async function syncBetfairCompetitionCoverage(): Promise<{
  betfairCompetitions: number;
  matched: number;
  promoted: number;
  unmatched: number;
  matchMethodBreakdown: Record<string, number>;
}> {
  const startedAt = new Date();
  logger.info("Starting Betfair Exchange coverage sync (4-pass matcher)");

  let betfairCompetitions: Array<{ competition: { id: string; name: string }; competitionRegion: string }>;
  try {
    betfairCompetitions = await listCompetitions("1");
  } catch (err) {
    logger.warn({ err }, "Betfair listCompetitions failed — skipping coverage sync");
    return { betfairCompetitions: 0, matched: 0, promoted: 0, unmatched: 0, matchMethodBreakdown: {} };
  }

  if (!Array.isArray(betfairCompetitions) || betfairCompetitions.length === 0) {
    logger.warn("Betfair listCompetitions returned empty — skipping coverage sync");
    return { betfairCompetitions: 0, matched: 0, promoted: 0, unmatched: 0, matchMethodBreakdown: {} };
  }

  const ccRows = await db
    .select({
      id: competitionConfigTable.id,
      name: competitionConfigTable.name,
      country: competitionConfigTable.country,
      hasBetfairExchange: competitionConfigTable.hasBetfairExchange,
    })
    .from(competitionConfigTable);

  let matched = 0;
  let promoted = 0;
  const matchMethodBreakdown: Record<string, number> = {
    strict: 0,
    loose: 0,
    slug: 0,
    substring: 0,
  };
  const unmatched: Array<{
    name: string;
    region: string;
    bestSim: number;
    bestCandidate: string;
    bestCandidateCountry: string;
  }> = [];
  const excludedIds = new Set<number>();

  for (const bc of betfairCompetitions) {
    const bcName = bc.competition?.name ?? "";
    const bcRegion = bc.competitionRegion ?? "";
    if (!bcName) continue;

    const result = findBestMatch(bcName, bcRegion, ccRows, excludedIds);

    if (!result) {
      // Log unmatched with nearest-neighbour for manual review
      let nearMiss = { name: "", country: "", sim: 0 };
      for (const cc of ccRows) {
        const s = leagueNameSimilarity(bcName, cc.name);
        if (s > nearMiss.sim) nearMiss = { name: cc.name, country: cc.country ?? "", sim: s };
      }
      unmatched.push({
        name: bcName,
        region: bcRegion,
        bestSim: nearMiss.sim,
        bestCandidate: nearMiss.name,
        bestCandidateCountry: nearMiss.country,
      });
      continue;
    }

    matched++;
    matchMethodBreakdown[result.method]++;
    excludedIds.add(result.cc.id);

    if (!result.cc.hasBetfairExchange) {
      await db
        .update(competitionConfigTable)
        .set({ hasBetfairExchange: true })
        .where(eq(competitionConfigTable.id, result.cc.id));
      promoted++;
      logger.info(
        {
          betfairName: bcName,
          betfairRegion: bcRegion,
          matchedTo: result.cc.name,
          matchedCountry: result.cc.country,
          method: result.method,
          nameSim: result.nameSim.toFixed(3),
          countrySim: result.countrySim.toFixed(3),
          combined: result.combined.toFixed(3),
        },
        "Promoted competition_config.has_betfair_exchange=true via Betfair sync",
      );
    }
  }

  await db.insert(complianceLogsTable).values({
    actionType: "decision",
    details: {
      action: "betfair_competition_coverage_sync",
      betfairCompetitions: betfairCompetitions.length,
      matched,
      promoted,
      matchMethodBreakdown,
      unmatchedCount: unmatched.length,
      unmatchedSample: unmatched.slice(0, 50),
      durationMs: Date.now() - startedAt.getTime(),
    },
    timestamp: new Date(),
  });

  logger.info(
    {
      betfairCompetitions: betfairCompetitions.length,
      matched,
      promoted,
      matchMethodBreakdown,
      unmatched: unmatched.length,
      durationMs: Date.now() - startedAt.getTime(),
    },
    "Betfair Exchange coverage sync complete",
  );

  return {
    betfairCompetitions: betfairCompetitions.length,
    matched,
    promoted,
    unmatched: unmatched.length,
    matchMethodBreakdown,
  };
}
