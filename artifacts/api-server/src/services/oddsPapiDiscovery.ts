import { db, competitionConfigTable, complianceLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { fetchOddsPapi, canMakeOddspapiRequest } from "./oddsPapi";

interface OddsPapiTournament {
  tournamentId: number;
  tournamentSlug: string;
  tournamentName: string;
  categorySlug: string;
  categoryName: string;
  futureFixtures: number;
  upcomingFixtures: number;
  liveFixtures: number;
}

interface OddsPapiFixtureProbe {
  fixtureId?: string;
  id?: string | number;
}

interface OddsPapiBookmaker {
  bookmakerSlug?: string;
  bookmakerName?: string;
  slug?: string;
  name?: string;
}

interface OddsPapiOddsResponse {
  bookmakerOdds?: Record<string, OddsPapiBookmaker> | OddsPapiBookmaker[];
  bookmakers?: OddsPapiBookmaker[];
  odds?: OddsPapiBookmaker[];
}

// Token-set ratio with diacritic stripping. Returns 1.0 when smaller token
// set is fully contained in the larger; partial scores reflect fractional
// inclusion. Chosen over Levenshtein/Jaro-Winkler because league names
// commonly differ by word reordering and extra qualifiers ("Premier League"
// vs "England Premier League"); set-based matching is robust to those.
export function leagueNameSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const aN = norm(a);
  const bN = norm(b);
  if (aN === bN) return 1.0;
  const aTokens = new Set(aN.split(" ").filter((t) => t.length >= 2));
  const bTokens = new Set(bN.split(" ").filter((t) => t.length >= 2));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const t of aTokens) if (bTokens.has(t)) intersection++;
  return intersection / Math.min(aTokens.size, bTokens.size);
}

function extractBookmakerSlugs(raw: OddsPapiOddsResponse): string[] {
  const slugs: string[] = [];
  let arr: OddsPapiBookmaker[] = [];
  if (raw.bookmakerOdds) {
    if (Array.isArray(raw.bookmakerOdds)) {
      arr = raw.bookmakerOdds;
    } else {
      slugs.push(...Object.keys(raw.bookmakerOdds));
      arr = Object.values(raw.bookmakerOdds);
    }
  } else if (raw.bookmakers) {
    arr = raw.bookmakers;
  } else if (raw.odds) {
    arr = raw.odds;
  }
  for (const bm of arr) {
    const slug = (bm.bookmakerSlug ?? bm.slug ?? bm.bookmakerName ?? bm.name ?? "")
      .toLowerCase();
    if (slug) slugs.push(slug);
  }
  return slugs;
}

function hasPinnacle(slugs: string[]): boolean {
  return slugs.some((s) => s.includes("pinnacle"));
}

const SIM_THRESHOLD = 0.85;

// Authoritative discovery of Pinnacle-priced leagues. Replaces reliance on
// the static KNOWN_PINNACLE_LEAGUE_IDS list (which is now a fallback floor
// only). Runs weekly Sunday 02:00 UTC.
//
// Flow:
//   1. GET /v4/tournaments?sportId=10 — list all OddsPapi football tournaments.
//   2. For each tournament with futureFixtures > 0:
//      a. GET /v4/fixtures?tournamentId=X&hasOdds=true&limit=1 — pick one fixture.
//      b. GET /v4/odds?fixtureId=Y&marketId=101 — probe its odds.
//      c. If Pinnacle bookmaker present, fuzzy-match tournament name + category
//         to competition_config (token-set ratio, threshold 0.85, country
//         tie-breaker via combined score 0.7×name + 0.3×country).
//      d. On match: ratchet competition_config.has_pinnacle_odds=true.
//      e. On no-match: log to compliance for review (Phase 2 backlog —
//         Pinnacle covers but we don't ingest from API-Football).
export async function discoverPinnacleLeagues(): Promise<{
  tournamentsScanned: number;
  pinnaclePriced: number;
  matched: number;
  promoted: number;
  unmatched: number;
}> {
  const startedAt = new Date();
  logger.info("Starting OddsPapi tournament discovery (weekly)");

  if (!(await canMakeOddspapiRequest(3000, "P4"))) {
    logger.warn("OddsPapi budget too low for tournament discovery — skipping");
    return { tournamentsScanned: 0, pinnaclePriced: 0, matched: 0, promoted: 0, unmatched: 0 };
  }

  const tournaments = await fetchOddsPapi<OddsPapiTournament[]>(
    "/tournaments",
    { sportId: 10 },
    "tournaments_discovery",
    "P4",
  );

  if (!tournaments || !Array.isArray(tournaments)) {
    logger.warn("OddsPapi tournament discovery: empty or invalid response");
    return { tournamentsScanned: 0, pinnaclePriced: 0, matched: 0, promoted: 0, unmatched: 0 };
  }

  const active = tournaments.filter((t) => (t.futureFixtures ?? 0) > 0);
  logger.info(
    { totalTournaments: tournaments.length, activeTournaments: active.length },
    "OddsPapi tournaments fetched",
  );

  const ccRows = await db
    .select({
      id: competitionConfigTable.id,
      name: competitionConfigTable.name,
      country: competitionConfigTable.country,
      hasPinnacleOdds: competitionConfigTable.hasPinnacleOdds,
    })
    .from(competitionConfigTable);

  let pinnaclePriced = 0;
  let matched = 0;
  let promoted = 0;
  const unmatched: Array<{ tournamentName: string; categoryName: string }> = [];

  for (const tour of active) {
    const fixtures = await fetchOddsPapi<OddsPapiFixtureProbe[]>(
      "/fixtures",
      { tournamentId: tour.tournamentId, hasOdds: "true", limit: 1 },
      "discovery_fixture_probe",
      "P4",
    );
    if (!fixtures || fixtures.length === 0) continue;
    const fixId = fixtures[0]?.fixtureId ?? (fixtures[0]?.id != null ? String(fixtures[0].id) : null);
    if (!fixId) continue;

    const oddsData = await fetchOddsPapi<OddsPapiOddsResponse>(
      "/odds",
      { fixtureId: fixId, marketId: 101 },
      "discovery_odds_probe",
      "P4",
    );
    if (!oddsData) continue;

    const slugs = extractBookmakerSlugs(oddsData);
    if (!hasPinnacle(slugs)) continue;

    pinnaclePriced++;

    let bestMatch: typeof ccRows[number] | null = null;
    let bestCombined = 0;
    let bestNameSim = 0;
    let bestCountrySim = 0;
    for (const cc of ccRows) {
      const nameSim = leagueNameSimilarity(tour.tournamentName, cc.name);
      if (nameSim < SIM_THRESHOLD) continue;
      const countrySim = leagueNameSimilarity(tour.categoryName, cc.country ?? "");
      const combined = nameSim * 0.7 + countrySim * 0.3;
      if (!bestMatch || combined > bestCombined) {
        bestMatch = cc;
        bestCombined = combined;
        bestNameSim = nameSim;
        bestCountrySim = countrySim;
      }
    }

    if (!bestMatch) {
      unmatched.push({ tournamentName: tour.tournamentName, categoryName: tour.categoryName });
      continue;
    }
    matched++;

    if (!bestMatch.hasPinnacleOdds) {
      await db
        .update(competitionConfigTable)
        .set({ hasPinnacleOdds: true })
        .where(eq(competitionConfigTable.id, bestMatch.id));
      promoted++;
      logger.info(
        {
          tournamentName: tour.tournamentName,
          categoryName: tour.categoryName,
          matchedTo: bestMatch.name,
          matchedCountry: bestMatch.country,
          nameSim: bestNameSim.toFixed(3),
          countrySim: bestCountrySim.toFixed(3),
          combined: bestCombined.toFixed(3),
        },
        "Promoted competition_config to has_pinnacle_odds=true via OddsPapi tournament probe",
      );
    }
  }

  await db.insert(complianceLogsTable).values({
    actionType: "decision",
    details: {
      action: "oddspapi_tournament_discovery",
      tournamentsScanned: active.length,
      pinnaclePriced,
      matched,
      promoted,
      unmatchedCount: unmatched.length,
      unmatchedSample: unmatched.slice(0, 20),
      durationMs: Date.now() - startedAt.getTime(),
    },
    timestamp: new Date(),
  });

  logger.info(
    {
      tournamentsScanned: active.length,
      pinnaclePriced,
      matched,
      promoted,
      unmatched: unmatched.length,
      durationMs: Date.now() - startedAt.getTime(),
    },
    "OddsPapi tournament discovery complete",
  );

  return {
    tournamentsScanned: active.length,
    pinnaclePriced,
    matched,
    promoted,
    unmatched: unmatched.length,
  };
}
