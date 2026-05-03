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

// Generic football-league tokens that, when shared as the ONLY common token,
// don't constitute a meaningful match. Used by the degenerate-set guard
// below: if the singleton intersection token is generic, fall back to
// Jaccard scoring (which penalises size disparity); if specific, trust the
// subset match.
//
// Without this distinction, "V-League" {league} matched "South Korean K1
// League" {south,korean,k1,league} at 1.0 (false), but ALSO "Norwegian
// Eliteserien" failed to match "Eliteserien" because both were treated
// the same way.
const GENERIC_LEAGUE_TOKENS = new Set([
  "league", "cup", "liga", "serie", "primera", "segunda", "premier",
  "championship", "division", "conference", "professional", "pro",
  "national", "ligue", "copa", "federation", "federacion", "supercup",
  "playoff", "playoffs", "qualifying", "qualifier", "qualifiers",
  "first", "second", "third", "tier", "men", "women", "men_s", "women_s",
]);

// Token-set similarity with diacritic stripping + selective degenerate-set
// guard. When min(|A|,|B|) == 1 and the singleton intersection token is
// GENERIC (e.g., "league", "cup"), fall back to Jaccard. When the singleton
// is SPECIFIC (e.g., "eliteserien", "allsvenskan"), trust the subset match.
//
// Test cases:
//   "Premier League" vs "Premier League England": min=2, score=2/2=1.0 ✓
//   "V-League" vs "South Korean K1 League": min=1, singleton=league GENERIC,
//     Jaccard=1/4=0.25 ✓ rejects
//   "Norwegian Eliteserien" vs "Eliteserien": min=1, singleton=eliteserien
//     SPECIFIC, score=1/1=1.0 ✓ matches (was rejected pre-fix)
//   "Brazilian Serie A" vs "Serie A": min=1, singleton=serie GENERIC,
//     Jaccard=1/2=0.5 ✓ rejects (cross-country bleed prevented)
//   "Brazil Serie A" vs "Brasileirão Série A": min=2, score=1/2=0.5 ✓ rejects
//     (still needs alias dictionary, not fuzzy match)
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
  const sharedTokens: string[] = [];
  for (const t of aTokens) if (bTokens.has(t)) sharedTokens.push(t);
  const intersection = sharedTokens.length;
  if (intersection === 0) return 0;
  const minSize = Math.min(aTokens.size, bTokens.size);
  if (minSize === 1) {
    // Singleton — generic tokens trigger Jaccard fallback to avoid generic-
    // suffix bleed; specific tokens trust the subset match.
    const allSharedGeneric = sharedTokens.every((t) => GENERIC_LEAGUE_TOKENS.has(t));
    if (allSharedGeneric) {
      return intersection / (aTokens.size + bTokens.size - intersection);
    }
    return intersection / minSize;
  }
  return intersection / minSize;
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

  // Pre-2026-05-04: required upfront 3000-call budget reservation, which
  // P4 priority (10% of 100k/month = 10k/month allocation) almost always
  // failed because we were near monthly cap. Result: function returned
  // all-zeros immediately. New approach: drop the upfront reservation,
  // check budget per-tournament inside the loop. Greedy consumption,
  // partial results > zero results.
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

  let budgetExhaustedAt: number | null = null;
  for (let i = 0; i < active.length; i++) {
    const tour = active[i];
    if (!tour) continue;
    // Per-tournament budget check (need 2 calls: fixture + odds probe)
    if (!(await canMakeOddspapiRequest(2, "P4"))) {
      budgetExhaustedAt = i;
      logger.warn(
        { tournamentsScanned: i, remainingTournaments: active.length - i },
        "OddsPapi budget exhausted mid-discovery — partial results",
      );
      break;
    }

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

    // 2026-05-04 fix: tie-breaker by name-length proximity. When multiple cc
    // rows score the same combined (common when countrySim=0 because both
    // use international/world), prefer the cc.name with length closest to the
    // tournamentName. This fixes "World Cup" matching "FIFA Women's World Cup"
    // (length 21) instead of "FIFA World Cup" (length 14): both score
    // nameSim=1.0 via subset matching, but FIFA World Cup is the closer-
    // length match to "World Cup" (length 9), so |14-9|=5 < |21-9|=12.
    const bcLen = tour.tournamentName.length;
    let bestMatch: typeof ccRows[number] | null = null;
    let bestCombined = 0;
    let bestNameSim = 0;
    let bestCountrySim = 0;
    let bestLenDelta = Number.POSITIVE_INFINITY;
    for (const cc of ccRows) {
      const nameSim = leagueNameSimilarity(tour.tournamentName, cc.name);
      if (nameSim < SIM_THRESHOLD) continue;
      const countrySim = leagueNameSimilarity(tour.categoryName, cc.country ?? "");
      const combined = nameSim * 0.7 + countrySim * 0.3;
      const lenDelta = Math.abs(cc.name.length - bcLen);
      // Prefer higher combined; on combined-tie, prefer smaller name-length delta
      const isBetter = !bestMatch
        || combined > bestCombined
        || (combined === bestCombined && lenDelta < bestLenDelta);
      if (isBetter) {
        bestMatch = cc;
        bestCombined = combined;
        bestNameSim = nameSim;
        bestCountrySim = countrySim;
        bestLenDelta = lenDelta;
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

  const tournamentsScanned = budgetExhaustedAt ?? active.length;

  await db.insert(complianceLogsTable).values({
    actionType: "decision",
    details: {
      action: "oddspapi_tournament_discovery",
      tournamentsScanned,
      tournamentsTotal: active.length,
      pinnaclePriced,
      matched,
      promoted,
      unmatchedCount: unmatched.length,
      unmatchedSample: unmatched.slice(0, 20),
      budgetExhausted: budgetExhaustedAt !== null,
      durationMs: Date.now() - startedAt.getTime(),
    },
    timestamp: new Date(),
  });

  logger.info(
    {
      tournamentsScanned,
      tournamentsTotal: active.length,
      pinnaclePriced,
      matched,
      promoted,
      unmatched: unmatched.length,
      budgetExhausted: budgetExhaustedAt !== null,
      durationMs: Date.now() - startedAt.getTime(),
    },
    "OddsPapi tournament discovery complete",
  );

  return {
    tournamentsScanned,
    pinnaclePriced,
    matched,
    promoted,
    unmatched: unmatched.length,
  };
}
