/**
 * Betfair-first Universe Expansion (sub-phase 2, Commit A)
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily cron at 0 7 * * * UTC. Reverse-maps Betfair's soccer competition list
 * against API-Football's league universe. Populates Tier D rows for Betfair-
 * only competitions; non-destructively updates existing rows with
 * betfair_competition_id + archetype where missing; runs an archetype
 * labelling pass over every row in competition_config.
 *
 * Locked decisions live in:
 *   - docs/phase-2-subphase-2-plan.md (sub-phase 2 plan)
 *   - docs/archetype-labelling-rules.md (archetype cascade)
 *
 * Behaviour: dry-run by default. Reads BETFAIR_REVERSE_MAPPING_DRY_RUN env;
 * defaults to "true" if unset. Flip to "false" via env var on VPS to enable
 * writes. The cron is idempotent — safe to re-run.
 *
 * Scope per the sub-phase 2 plan §3.5 insert-only contract:
 *   - May INSERT new Tier D rows (Betfair-only, api_football_id=NULL).
 *   - May INSERT new rows for AF leagues not yet in competition_config.
 *   - May SET betfair_competition_id when NULL on an existing row.
 *   - May SET archetype when NULL on any existing row.
 *   - MUST NOT change universe_tier on a row that already has a non-unmapped
 *     value. Auto-demotion is sub-phase 10 territory.
 *   - MUST NOT overwrite an existing betfair_competition_id.
 */

import {
  db,
  competitionConfigTable,
  oddspapiLeagueCoverageTable,
  paperBetsTable,
  matchesTable,
} from "@workspace/db";
import { eq, isNull, and, sql, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { listCompetitions, type Competition } from "./betfair";
import { fetchApiFootball } from "./apiFootball";

// ─── AF /leagues response shape (subset we actually read) ────────────────────

interface AfLeagueRaw {
  league?: { id?: number; name?: string; type?: string };
  country?: { name?: string; code?: string | null };
  seasons?: Array<{
    year?: number;
    current?: boolean;
    coverage?: {
      fixtures?: { events?: boolean; statistics_fixtures?: boolean; lineups?: boolean };
      standings?: boolean;
      odds?: boolean;
    };
  }>;
}

// ─── Constants (locked in plan §3.1, §3.2, §3.4) ─────────────────────────────

const FUZZY_MATCH_THRESHOLD = 0.85;
const NO_REGION_FUZZY_THRESHOLD = 0.95;
const ODDS_PAPI_STALENESS_DAYS = 14;
const FUZZY_FAILURE_SAMPLE_SIZE = 30;

// ─── Token-set ratio fuzzy match (plan §3.1, locked) ─────────────────────────

function normaliseLeagueName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")    // strip diacritics
    .replace(/[^a-z0-9 ]/g, " ")        // punctuation → space
    .replace(/\s+/g, " ")               // collapse whitespace
    .trim();
}

function tokenSetRatio(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(normaliseLeagueName(s).split(" ").filter((t) => t.length > 0));
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersect = 0;
  for (const t of A) if (B.has(t)) intersect++;
  return intersect / Math.min(A.size, B.size);
}

// ─── Betfair region → AF country (plan §3.2) ─────────────────────────────────
// Betfair's competitionRegion is empirically a mix: ISO 3166-1 alpha-3 codes
// (the dominant form per first-cycle dry-run histogram), occasional alpha-2
// codes, and full English names. We map all observed forms.
//
// Multi-country values exist where Betfair groups by political union but AF
// separates: GBR → England/Scotland/Wales/Northern Ireland.
//
// Unmapped regions fall through to no-country fuzzy match at threshold 0.95.

const BETFAIR_REGION_TO_AF_COUNTRIES: Record<string, string[]> = {
  // ─── ISO 3166-1 alpha-3 (Betfair's primary form per histogram) ──────────────
  // UK + Ireland
  "GBR": ["England", "Scotland", "Wales", "Northern Ireland"],
  "IRL": ["Ireland"],
  // Western & Central Europe
  "FRA": ["France"],
  "DEU": ["Germany"],
  "ITA": ["Italy"],
  "ESP": ["Spain"],
  "PRT": ["Portugal"],
  "NLD": ["Netherlands"],
  "BEL": ["Belgium"],
  "CHE": ["Switzerland"],
  "AUT": ["Austria"],
  "LUX": ["Luxembourg"],
  // Nordic
  "SWE": ["Sweden"],
  "NOR": ["Norway"],
  "DNK": ["Denmark"],
  "FIN": ["Finland"],
  "ISL": ["Iceland"],
  "FRO": ["Faroe-Islands"],
  // Eastern Europe & former USSR
  "POL": ["Poland"],
  "CZE": ["Czech-Republic"],
  "SVK": ["Slovakia"],
  "HUN": ["Hungary"],
  "ROU": ["Romania"],
  "BGR": ["Bulgaria"],
  "SRB": ["Serbia"],
  "HRV": ["Croatia"],
  "SVN": ["Slovenia"],
  "BIH": ["Bosnia"],
  "MNE": ["Montenegro"],
  "MKD": ["North-Macedonia"],
  "ALB": ["Albania"],
  "GRC": ["Greece"],
  "TUR": ["Turkey"],
  "CYP": ["Cyprus"],
  "MLT": ["Malta"],
  "RUS": ["Russia"],
  "UKR": ["Ukraine"],
  "BLR": ["Belarus"],
  "EST": ["Estonia"],
  "LVA": ["Latvia"],
  "LTU": ["Lithuania"],
  "GEO": ["Georgia"],
  "ARM": ["Armenia"],
  "AZE": ["Azerbaijan"],
  "MDA": ["Moldova"],
  "KAZ": ["Kazakhstan"],
  "UZB": ["Uzbekistan"],
  "SMR": ["San-Marino"],
  // Americas
  "USA": ["USA"],
  "CAN": ["Canada"],
  "MEX": ["Mexico"],
  "BRA": ["Brazil"],
  "ARG": ["Argentina"],
  "CHL": ["Chile"],
  "COL": ["Colombia"],
  "PER": ["Peru"],
  "URY": ["Uruguay"],
  "ECU": ["Ecuador"],
  "PRY": ["Paraguay"],
  "BOL": ["Bolivia"],
  "VEN": ["Venezuela"],
  "CRI": ["Costa-Rica"],
  "PAN": ["Panama"],
  "HND": ["Honduras"],
  "GTM": ["Guatemala"],
  "SLV": ["El-Salvador"],
  "JAM": ["Jamaica"],
  "TTO": ["Trinidad-And-Tobago"],
  // Asia / Oceania
  "JPN": ["Japan"],
  "KOR": ["South-Korea"],
  "CHN": ["China"],
  "AUS": ["Australia"],
  "NZL": ["New-Zealand"],
  "IDN": ["Indonesia"],
  "THA": ["Thailand"],
  "VNM": ["Vietnam"],
  "MYS": ["Malaysia"],
  "PHL": ["Philippines"],
  "IND": ["India"],
  "SAU": ["Saudi-Arabia"],
  "ARE": ["United-Arab-Emirates"],
  "QAT": ["Qatar"],
  "BHR": ["Bahrain"],
  "OMN": ["Oman"],
  "JOR": ["Jordan"],
  "IRN": ["Iran"],
  "IRQ": ["Iraq"],
  "ISR": ["Israel"],
  "LBN": ["Lebanon"],
  "PSE": ["Palestine"],
  // Africa
  "ZAF": ["South-Africa"],
  "EGY": ["Egypt"],
  "MAR": ["Morocco"],
  "TUN": ["Tunisia"],
  "DZA": ["Algeria"],
  "NGA": ["Nigeria"],
  "GHA": ["Ghana"],
  "KEN": ["Kenya"],
  "UGA": ["Uganda"],
  "TZA": ["Tanzania"],
  "ETH": ["Ethiopia"],
  "SEN": ["Senegal"],
  "CIV": ["Ivory-Coast"],
  "CMR": ["Cameroon"],
  "BWA": ["Botswana"],
  "RWA": ["Rwanda"],
  "ZWE": ["Zimbabwe"],
  "MOZ": ["Mozambique"],
  "ZMB": ["Zambia"],

  // ─── Alpha-2 (defensive — Betfair occasionally returns these) ───────────────
  "GB": ["England", "Scotland", "Wales", "Northern Ireland"],
  "IE": ["Ireland"],
  "FR": ["France"], "DE": ["Germany"], "IT": ["Italy"], "ES": ["Spain"],
  "PT": ["Portugal"], "NL": ["Netherlands"], "BE": ["Belgium"],
  "CH": ["Switzerland"], "AT": ["Austria"], "LU": ["Luxembourg"],
  "SE": ["Sweden"], "NO": ["Norway"], "DK": ["Denmark"], "FI": ["Finland"],
  "IS": ["Iceland"], "FO": ["Faroe-Islands"],
  "PL": ["Poland"], "CZ": ["Czech-Republic"], "SK": ["Slovakia"],
  "HU": ["Hungary"], "RO": ["Romania"], "BG": ["Bulgaria"], "RS": ["Serbia"],
  "HR": ["Croatia"], "SI": ["Slovenia"], "BA": ["Bosnia"],
  "ME": ["Montenegro"], "MK": ["North-Macedonia"], "AL": ["Albania"],
  "GR": ["Greece"], "TR": ["Turkey"], "CY": ["Cyprus"], "MT": ["Malta"],
  "RU": ["Russia"], "UA": ["Ukraine"], "BY": ["Belarus"],
  "EE": ["Estonia"], "LV": ["Latvia"], "LT": ["Lithuania"],
  "GE": ["Georgia"], "AM": ["Armenia"], "AZ": ["Azerbaijan"],
  "MD": ["Moldova"], "KZ": ["Kazakhstan"], "UZ": ["Uzbekistan"],
  "US": ["USA"], "CA": ["Canada"], "MX": ["Mexico"],
  "BR": ["Brazil"], "AR": ["Argentina"], "CL": ["Chile"], "CO": ["Colombia"],
  "PE": ["Peru"], "UY": ["Uruguay"], "EC": ["Ecuador"], "PY": ["Paraguay"],
  "BO": ["Bolivia"], "VE": ["Venezuela"],
  "JP": ["Japan"], "KR": ["South-Korea"], "CN": ["China"],
  "AU": ["Australia"], "NZ": ["New-Zealand"], "ID": ["Indonesia"],
  "TH": ["Thailand"], "VN": ["Vietnam"], "MY": ["Malaysia"],
  "PH": ["Philippines"], "IN": ["India"],
  "SA": ["Saudi-Arabia"], "AE": ["United-Arab-Emirates"], "QA": ["Qatar"],
  "BH": ["Bahrain"], "OM": ["Oman"], "JO": ["Jordan"],
  "IR": ["Iran"], "IQ": ["Iraq"], "IL": ["Israel"],
  "ZA": ["South-Africa"], "EG": ["Egypt"], "MA": ["Morocco"], "TN": ["Tunisia"],
  "DZ": ["Algeria"], "NG": ["Nigeria"], "GH": ["Ghana"],
  "KE": ["Kenya"], "UG": ["Uganda"], "TZ": ["Tanzania"],

  // ─── Full English names (defensive) ─────────────────────────────────────────
  "ENGLAND": ["England"], "SCOTLAND": ["Scotland"], "WALES": ["Wales"],
  "NORTHERN IRELAND": ["Northern Ireland"], "IRELAND": ["Ireland"],
  "FRANCE": ["France"], "GERMANY": ["Germany"], "ITALY": ["Italy"],
  "SPAIN": ["Spain"], "PORTUGAL": ["Portugal"], "NETHERLANDS": ["Netherlands"],
  "BELGIUM": ["Belgium"], "SWITZERLAND": ["Switzerland"], "AUSTRIA": ["Austria"],
  "LUXEMBOURG": ["Luxembourg"], "SWEDEN": ["Sweden"], "NORWAY": ["Norway"],
  "DENMARK": ["Denmark"], "FINLAND": ["Finland"], "ICELAND": ["Iceland"],
  "POLAND": ["Poland"], "CZECH REPUBLIC": ["Czech-Republic"],
  "SLOVAKIA": ["Slovakia"], "HUNGARY": ["Hungary"], "ROMANIA": ["Romania"],
  "BULGARIA": ["Bulgaria"], "SERBIA": ["Serbia"], "CROATIA": ["Croatia"],
  "SLOVENIA": ["Slovenia"], "BOSNIA": ["Bosnia"], "MONTENEGRO": ["Montenegro"],
  "ALBANIA": ["Albania"], "GREECE": ["Greece"], "TURKEY": ["Turkey"],
  "CYPRUS": ["Cyprus"], "MALTA": ["Malta"], "RUSSIA": ["Russia"],
  "UKRAINE": ["Ukraine"], "BELARUS": ["Belarus"], "ESTONIA": ["Estonia"],
  "LATVIA": ["Latvia"], "LITHUANIA": ["Lithuania"], "GEORGIA": ["Georgia"],
  "ARMENIA": ["Armenia"], "AZERBAIJAN": ["Azerbaijan"], "MOLDOVA": ["Moldova"],
  "KAZAKHSTAN": ["Kazakhstan"],
  "USA": ["USA"], "CANADA": ["Canada"], "MEXICO": ["Mexico"],
  "BRAZIL": ["Brazil"], "ARGENTINA": ["Argentina"], "CHILE": ["Chile"],
  "COLOMBIA": ["Colombia"], "PERU": ["Peru"], "URUGUAY": ["Uruguay"],
  "ECUADOR": ["Ecuador"], "PARAGUAY": ["Paraguay"], "BOLIVIA": ["Bolivia"],
  "VENEZUELA": ["Venezuela"],
  "JAPAN": ["Japan"], "SOUTH KOREA": ["South-Korea"], "CHINA": ["China"],
  "AUSTRALIA": ["Australia"], "INDONESIA": ["Indonesia"], "THAILAND": ["Thailand"],
  "VIETNAM": ["Vietnam"], "MALAYSIA": ["Malaysia"], "INDIA": ["India"],
  "QATAR": ["Qatar"], "IRAN": ["Iran"], "ISRAEL": ["Israel"],
  "SOUTH AFRICA": ["South-Africa"], "EGYPT": ["Egypt"], "MOROCCO": ["Morocco"],
  "TUNISIA": ["Tunisia"], "ALGERIA": ["Algeria"], "NIGERIA": ["Nigeria"],
  "GHANA": ["Ghana"], "KENYA": ["Kenya"], "UGANDA": ["Uganda"],

  // ─── International / cup tournaments ────────────────────────────────────────
  "INTERNATIONAL": ["World"], "WORLD": ["World"], "EUROPE": ["World"],
  "AFRICA": ["World"], "ASIA": ["World"], "AMERICAS": ["World"],
  "INT": ["World"], "EUR": ["World"], "AFR": ["World"], "ASIA-PACIFIC": ["World"],
};

function mapBetfairRegion(region: string | undefined | null): string[] | null {
  if (!region) return null;
  const key = region.trim().toUpperCase();
  return BETFAIR_REGION_TO_AF_COUNTRIES[key] ?? null;
}

// ─── Archetype labelling (verbatim from archetype-labelling-rules.md §3) ─────

interface ArchetypeInputs {
  name?: string | null;
  country?: string | null;
  gender?: string | null;
  type?: string | null;
  tier?: number | null;
}

function archetypeFor(row: ArchetypeInputs): string {
  const n = (row.name ?? "").toLowerCase();

  // Rule 1: women's leagues — explicit first to avoid being captured by tier rules
  if (
    row.gender === "female" ||
    n.includes("women") ||
    n.includes("féminine") || n.includes("feminine") ||
    n.includes("femenina") ||
    n.includes("nữ") || n.includes(" nu ")
  ) return "women";

  // Rule 2: international tournaments and qualifiers (before cup so "Copa America" hits 'international' not 'cup')
  if (
    n.includes("world cup") ||
    n.includes("nations league") ||
    n.includes("euro ") || n.endsWith(" euro") ||
    n.includes("qualifier") || n.includes("qualifying") ||
    /\bwcq\b/.test(n) ||
    n.includes("copa america") ||
    n.includes("afcon") || n.includes("africa cup of nations") ||
    n.includes("asian cup") ||
    n.includes("concacaf") ||
    n.includes("uefa nations")
  ) return "international";

  // Rule 3: cups (after international rule)
  if (
    n.includes("cup") || n.includes("coupe") || n.includes("copa") ||
    n.includes("pokal") || n.includes("beker") || n.includes("coppa") ||
    n.includes("taça") || n.includes("taca") ||
    row.type === "cup"
  ) return "cup";

  // Rule 4: explicit type=international from AF
  if (row.type === "international") return "international";

  // Rule 5: top-flight men
  if (
    (row.tier === 1 || row.tier == null) &&
    (row.gender === "male" || row.gender == null) &&
    (row.type === "league" || row.type == null || row.type === "League")
  ) return "top_flight_men";

  // Rule 6: lower-division men
  if ((row.tier ?? 0) >= 2 && (row.type === "league" || row.type == null || row.type === "League")) {
    return "lower_division";
  }

  // Rule 7: fallback
  return "other";
}

// ─── Tier assignment (plan §3.4, locked) ─────────────────────────────────────

type Tier = "A" | "B" | "C" | "D";

interface TierInputs {
  matched: boolean;
  hasOdds: boolean;          // oddspapi_league_coverage.has_odds = 1
  oddsPapiAgeDays: number;   // Infinity if no row
  hasHistoricalBets: boolean;
  biasIndex: number | null;  // null when not flagged
}

function assignTier(input: TierInputs): { tier: Tier; reason: string } {
  if (input.biasIndex != null && Math.abs(input.biasIndex) >= 0.10) {
    return { tier: "D", reason: "bias_threshold_violated" };
  }
  if (!input.matched) {
    return { tier: "D", reason: "no_af_match" };
  }
  if (!input.hasHistoricalBets) {
    return { tier: "C", reason: "probationary_no_history" };
  }
  if (input.hasOdds && input.oddsPapiAgeDays <= ODDS_PAPI_STALENESS_DAYS) {
    return { tier: "A", reason: "pinnacle_reliable" };
  }
  if (input.hasOdds && input.oddsPapiAgeDays > ODDS_PAPI_STALENESS_DAYS) {
    return { tier: "C", reason: "pinnacle_stale" };
  }
  return { tier: "B", reason: "no_pinnacle_coverage" };
}

// ─── Result shape ────────────────────────────────────────────────────────────

export interface BetfairReverseMappingResult {
  runId: string;
  dryRun: boolean;
  betfairCompetitionsFetched: number;
  afUniverseSize: number;
  competitionConfigSize: number;
  proposedTierAssignments: Record<string, number>;
  writesProposed: {
    insertNewRows: number;
    updateBetfairCompetitionId: number;
    updateArchetype: number;
    updateUniverseTier: number;        // strictly 0 by insert-only contract
  };
  writesApplied: number;
  skippedUnmappedRegion: number;
  fuzzyMatchFailures: {
    belowThresholdCount: number;
    belowThresholdSample: Array<{
      betfairName: string;
      bestAfMatch: string | null;
      score: number;
    }>;
  };
  unmappedRegionsHistogram: Record<string, number>;
  archetypeLabellingPass: {
    rowsLabelled: number;
    rowsAlreadyLabelled: number;
  };
  durationMs: number;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export async function runBetfairReverseMapping(): Promise<BetfairReverseMappingResult> {
  const startedAt = Date.now();
  const runId = `bfrm-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  const dryRun = (process.env.BETFAIR_REVERSE_MAPPING_DRY_RUN ?? "true").toLowerCase() === "true";

  logger.info({ runId, dryRun }, "betfair_reverse_mapping_starting");

  // ─── Step 1: fetch Betfair competition list ─────────────────────────────────
  let betfairCompetitions: Competition[] = [];
  try {
    betfairCompetitions = await listCompetitions("1");
  } catch (err) {
    logger.error({ err, runId }, "betfair_reverse_mapping: listCompetitions failed; aborting");
    return emptyResult(runId, dryRun, startedAt);
  }

  if (betfairCompetitions.length === 0) {
    logger.warn({ runId }, "betfair_reverse_mapping: 0 competitions returned; aborting");
    return emptyResult(runId, dryRun, startedAt);
  }

  // ─── Step 2: fetch AF league universe ───────────────────────────────────────
  // Use current=true filter; AF returns ~1000-1500 leagues.
  const afResponse = await fetchApiFootball<AfLeagueRaw[]>("/leagues", { current: "true" });
  const afLeagues = (afResponse ?? []).filter(
    (l): l is AfLeagueRaw & { league: { id: number; name: string } } =>
      typeof l.league?.id === "number" && typeof l.league?.name === "string",
  );

  if (afLeagues.length === 0) {
    logger.warn({ runId }, "betfair_reverse_mapping: AF /leagues returned no leagues; aborting");
    return emptyResult(runId, dryRun, startedAt);
  }

  // Index AF leagues by country for fast pre-filter
  const afByCountry = new Map<string, typeof afLeagues>();
  for (const af of afLeagues) {
    const country = (af.country?.name ?? "").trim();
    const list = afByCountry.get(country) ?? [];
    list.push(af);
    afByCountry.set(country, list);
  }

  // ─── Step 3: pre-load competition_config + supporting signals ───────────────
  const ccRows = await db.select().from(competitionConfigTable);
  const ccByApiFootballId = new Map<number, typeof ccRows[number]>();
  for (const r of ccRows) {
    if (r.apiFootballId != null) ccByApiFootballId.set(r.apiFootballId, r);
  }
  const ccByBetfairId = new Map<string, typeof ccRows[number]>();
  for (const r of ccRows) {
    if (r.betfairCompetitionId != null) ccByBetfairId.set(r.betfairCompetitionId, r);
  }

  const opRows = await db.select().from(oddspapiLeagueCoverageTable);
  const opByLeague = new Map<string, typeof opRows[number]>();
  for (const r of opRows) opByLeague.set(r.league.toLowerCase(), r);

  // Set of league names with ≥1 settled bet (for hasHistoricalBets check)
  const leaguesWithBetsRaw = await db
    .selectDistinct({ league: matchesTable.league })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        inArray(paperBetsTable.status, ["won", "lost"]),
        sql`${paperBetsTable.deletedAt} IS NULL`,
        eq(paperBetsTable.legacyRegime, false),
      ),
    );
  const leaguesWithBets = new Set(leaguesWithBetsRaw.map((r) => r.league.toLowerCase()));

  // ─── Step 4: per-Betfair-competition forward map ────────────────────────────
  const proposedTierAssignments: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, unchanged: 0 };
  const writesProposed = {
    insertNewRows: 0,
    updateBetfairCompetitionId: 0,
    updateArchetype: 0,
    updateUniverseTier: 0,
  };
  const fuzzyFailures: Array<{ betfairName: string; bestAfMatch: string | null; score: number }> = [];
  const unmappedRegions = new Map<string, number>();
  let skippedUnmappedRegion = 0;
  let writesApplied = 0;

  for (const bfComp of betfairCompetitions) {
    // Skip if already linked by betfair_competition_id (idempotent re-runs)
    if (ccByBetfairId.has(bfComp.competition.id)) {
      proposedTierAssignments.unchanged = (proposedTierAssignments.unchanged ?? 0) + 1;
      continue;
    }

    const bfName = bfComp.competition.name;
    const mappedCountries = mapBetfairRegion(bfComp.competitionRegion);

    let candidates: typeof afLeagues = [];
    let usedThreshold = FUZZY_MATCH_THRESHOLD;
    if (mappedCountries && mappedCountries.length > 0) {
      candidates = mappedCountries.flatMap((c) => afByCountry.get(c) ?? []);
    } else {
      skippedUnmappedRegion++;
      const rawRegion = (bfComp.competitionRegion ?? "(empty)").trim() || "(empty)";
      unmappedRegions.set(rawRegion, (unmappedRegions.get(rawRegion) ?? 0) + 1);
      candidates = afLeagues;
      usedThreshold = NO_REGION_FUZZY_THRESHOLD;
    }

    let bestScore = 0;
    let bestAf: typeof afLeagues[number] | null = null;
    for (const af of candidates) {
      const score = tokenSetRatio(bfName, af.league.name);
      if (score > bestScore) {
        bestScore = score;
        bestAf = af;
      }
    }

    if (bestScore >= usedThreshold && bestAf != null) {
      // Match found
      const afId = bestAf.league.id;
      const afName = bestAf.league.name;
      const afCountry = bestAf.country?.name ?? mappedCountries?.[0] ?? "Unknown";
      const afType = bestAf.league.type ?? "League";

      const existingCc = ccByApiFootballId.get(afId);

      if (existingCc == null) {
        // New AF league (not in competition_config) — INSERT with tier verdict
        const opRow = opByLeague.get(afName.toLowerCase());
        const hasOdds = opRow ? opRow.hasOdds === 1 : false;
        const oddsPapiAgeDays = opRow?.lastChecked
          ? (Date.now() - new Date(opRow.lastChecked).getTime()) / (24 * 3600 * 1000)
          : Infinity;
        const hasHistoricalBets = leaguesWithBets.has(afName.toLowerCase());

        const tierVerdict = assignTier({
          matched: true,
          hasOdds,
          oddsPapiAgeDays,
          hasHistoricalBets,
          biasIndex: null,
        });
        const archetype = archetypeFor({
          name: afName,
          country: afCountry,
          gender: null,
          type: afType,
          tier: null,
        });

        proposedTierAssignments[tierVerdict.tier] = (proposedTierAssignments[tierVerdict.tier] ?? 0) + 1;
        writesProposed.insertNewRows++;

        if (!dryRun) {
          await db.insert(competitionConfigTable).values({
            apiFootballId: afId,
            name: afName,
            country: afCountry,
            type: typeForDb(afType),
            gender: "male",
            tier: 3,
            isActive: tierVerdict.tier === "A" || tierVerdict.tier === "B" || tierVerdict.tier === "C",
            hasStatistics: false,
            hasLineups: false,
            hasOdds: false,
            hasEvents: false,
            hasPinnacleOdds: tierVerdict.tier === "A",
            pollingFrequency: "low",
            universeTier: tierVerdict.tier,
            archetype,
            betfairCompetitionId: bfComp.competition.id,
            universeTierDecidedAt: new Date(),
          }).onConflictDoNothing();
          writesApplied++;
        }
      } else {
        // Existing AF row — non-destructive update of betfair_competition_id + archetype
        const updates: Record<string, unknown> = {};
        if (existingCc.betfairCompetitionId == null) {
          updates.betfairCompetitionId = bfComp.competition.id;
          writesProposed.updateBetfairCompetitionId++;
        }
        if (existingCc.archetype == null) {
          updates.archetype = archetypeFor({
            name: existingCc.name,
            country: existingCc.country,
            gender: existingCc.gender,
            type: existingCc.type,
            tier: existingCc.tier,
          });
          writesProposed.updateArchetype++;
        }

        // Tier preserved (insert-only contract per plan §3.5)
        const currentTier = existingCc.universeTier ?? "unmapped";
        if (currentTier === "unmapped") {
          // Compute fresh verdict for unmapped row
          const opRow = opByLeague.get(existingCc.name.toLowerCase());
          const hasOdds = opRow ? opRow.hasOdds === 1 : false;
          const oddsPapiAgeDays = opRow?.lastChecked
            ? (Date.now() - new Date(opRow.lastChecked).getTime()) / (24 * 3600 * 1000)
            : Infinity;
          const hasHistoricalBets = leaguesWithBets.has(existingCc.name.toLowerCase());

          const tierVerdict = assignTier({
            matched: true,
            hasOdds,
            oddsPapiAgeDays,
            hasHistoricalBets,
            biasIndex: null,
          });
          updates.universeTier = tierVerdict.tier;
          updates.universeTierDecidedAt = new Date();
          proposedTierAssignments[tierVerdict.tier] = (proposedTierAssignments[tierVerdict.tier] ?? 0) + 1;
          writesProposed.updateUniverseTier++;   // first-time tier assignment for unmapped
        } else {
          proposedTierAssignments.unchanged = (proposedTierAssignments.unchanged ?? 0) + 1;
        }

        if (!dryRun && Object.keys(updates).length > 0) {
          await db
            .update(competitionConfigTable)
            .set(updates)
            .where(eq(competitionConfigTable.id, existingCc.id));
          writesApplied++;
        }
      }
    } else {
      // No match → Tier D (Betfair-only)
      const fallbackCountry = mappedCountries?.[0] ?? null;
      const archetype = archetypeFor({
        name: bfName,
        country: fallbackCountry,
        gender: null,
        type: null,
        tier: null,
      });

      proposedTierAssignments.D = (proposedTierAssignments.D ?? 0) + 1;
      writesProposed.insertNewRows++;

      if (fuzzyFailures.length < FUZZY_FAILURE_SAMPLE_SIZE) {
        fuzzyFailures.push({
          betfairName: bfName,
          bestAfMatch: bestAf?.league.name ?? null,
          score: Math.round(bestScore * 1000) / 1000,
        });
      }

      if (!dryRun) {
        await db.insert(competitionConfigTable).values({
          apiFootballId: null,
          name: bfName,
          country: fallbackCountry ?? "Unknown",
          type: "league",
          gender: "male",
          tier: 3,
          isActive: false,
          hasStatistics: false,
          hasLineups: false,
          hasOdds: false,
          hasEvents: false,
          hasPinnacleOdds: false,
          pollingFrequency: "dormant",
          universeTier: "D",
          archetype,
          betfairCompetitionId: bfComp.competition.id,
          universeTierDecidedAt: new Date(),
        }).onConflictDoNothing();
        writesApplied++;
      }
    }
  }

  // ─── Step 5: archetype labelling pass over rows with NULL archetype ─────────
  const nullArchetypeRows = await db
    .select()
    .from(competitionConfigTable)
    .where(isNull(competitionConfigTable.archetype));

  let archetypeLabelled = 0;
  for (const r of nullArchetypeRows) {
    const archetype = archetypeFor({
      name: r.name,
      country: r.country,
      gender: r.gender,
      type: r.type,
      tier: r.tier,
    });
    writesProposed.updateArchetype++;
    if (!dryRun) {
      await db
        .update(competitionConfigTable)
        .set({ archetype })
        .where(eq(competitionConfigTable.id, r.id));
      writesApplied++;
      archetypeLabelled++;
    } else {
      archetypeLabelled++;
    }
  }
  const archetypeAlreadyLabelled = ccRows.filter((r) => r.archetype != null).length;

  // ─── Result + log ───────────────────────────────────────────────────────────
  const durationMs = Date.now() - startedAt;
  const result: BetfairReverseMappingResult = {
    runId,
    dryRun,
    betfairCompetitionsFetched: betfairCompetitions.length,
    afUniverseSize: afLeagues.length,
    competitionConfigSize: ccRows.length,
    proposedTierAssignments,
    writesProposed,
    writesApplied,
    skippedUnmappedRegion,
    fuzzyMatchFailures: {
      belowThresholdCount: fuzzyFailures.length,
      belowThresholdSample: fuzzyFailures.slice(0, FUZZY_FAILURE_SAMPLE_SIZE),
    },
    unmappedRegionsHistogram: Object.fromEntries(
      [...unmappedRegions.entries()].sort((a, b) => b[1] - a[1]),
    ),
    archetypeLabellingPass: {
      rowsLabelled: archetypeLabelled,
      rowsAlreadyLabelled: archetypeAlreadyLabelled,
    },
    durationMs,
  };

  logger.info(result, "betfair_reverse_mapping_summary");
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyResult(runId: string, dryRun: boolean, startedAt: number): BetfairReverseMappingResult {
  return {
    runId,
    dryRun,
    betfairCompetitionsFetched: 0,
    afUniverseSize: 0,
    competitionConfigSize: 0,
    proposedTierAssignments: { A: 0, B: 0, C: 0, D: 0, unchanged: 0 },
    writesProposed: {
      insertNewRows: 0,
      updateBetfairCompetitionId: 0,
      updateArchetype: 0,
      updateUniverseTier: 0,
    },
    writesApplied: 0,
    skippedUnmappedRegion: 0,
    fuzzyMatchFailures: { belowThresholdCount: 0, belowThresholdSample: [] },
    unmappedRegionsHistogram: {},
    archetypeLabellingPass: { rowsLabelled: 0, rowsAlreadyLabelled: 0 },
    durationMs: Date.now() - startedAt,
  };
}

function typeForDb(afType: string | undefined): string {
  if (!afType) return "league";
  const t = afType.toLowerCase();
  if (t === "cup") return "cup";
  if (t === "league") return "league";
  return "league";
}

// ─── Manual trigger (admin endpoint) ─────────────────────────────────────────

export async function manualTriggerBetfairReverseMapping(): Promise<BetfairReverseMappingResult> {
  logger.info("Manual Betfair reverse-mapping triggered via API");
  return runBetfairReverseMapping();
}
