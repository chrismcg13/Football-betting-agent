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

// ─── Betfair region → AF country (plan §3.2, locked) ─────────────────────────
// Generated from observed competitionRegion values + best-effort coverage.
// Unmapped regions fall through to no-country fuzzy match at threshold 0.95.

const BETFAIR_REGION_TO_AF_COUNTRY: Record<string, string> = {
  // UK
  "GB": "England",
  "ENGLAND": "England",
  "SCOTLAND": "Scotland",
  "WALES": "Wales",
  "NORTHERN IRELAND": "Northern Ireland",
  "IRELAND": "Ireland",
  "IE": "Ireland",
  // Western Europe
  "ES": "Spain",
  "SPAIN": "Spain",
  "FR": "France",
  "FRANCE": "France",
  "DE": "Germany",
  "GERMANY": "Germany",
  "IT": "Italy",
  "ITALY": "Italy",
  "NL": "Netherlands",
  "NETHERLANDS": "Netherlands",
  "PT": "Portugal",
  "PORTUGAL": "Portugal",
  "BE": "Belgium",
  "BELGIUM": "Belgium",
  "CH": "Switzerland",
  "SWITZERLAND": "Switzerland",
  "AT": "Austria",
  "AUSTRIA": "Austria",
  "LU": "Luxembourg",
  "LUXEMBOURG": "Luxembourg",
  // Nordic
  "SE": "Sweden",
  "SWEDEN": "Sweden",
  "NO": "Norway",
  "NORWAY": "Norway",
  "DK": "Denmark",
  "DENMARK": "Denmark",
  "FI": "Finland",
  "FINLAND": "Finland",
  "IS": "Iceland",
  "ICELAND": "Iceland",
  "FO": "Faroe-Islands",
  // Eastern Europe
  "PL": "Poland",
  "POLAND": "Poland",
  "CZ": "Czech-Republic",
  "CZECH REPUBLIC": "Czech-Republic",
  "SK": "Slovakia",
  "SLOVAKIA": "Slovakia",
  "HU": "Hungary",
  "HUNGARY": "Hungary",
  "RO": "Romania",
  "ROMANIA": "Romania",
  "BG": "Bulgaria",
  "BULGARIA": "Bulgaria",
  "RS": "Serbia",
  "SERBIA": "Serbia",
  "HR": "Croatia",
  "CROATIA": "Croatia",
  "SI": "Slovenia",
  "SLOVENIA": "Slovenia",
  "BA": "Bosnia",
  "BOSNIA": "Bosnia",
  "ME": "Montenegro",
  "MONTENEGRO": "Montenegro",
  "MK": "North-Macedonia",
  "AL": "Albania",
  "ALBANIA": "Albania",
  "GR": "Greece",
  "GREECE": "Greece",
  "TR": "Turkey",
  "TURKEY": "Turkey",
  "CY": "Cyprus",
  "CYPRUS": "Cyprus",
  "MT": "Malta",
  "MALTA": "Malta",
  "RU": "Russia",
  "RUSSIA": "Russia",
  "UA": "Ukraine",
  "UKRAINE": "Ukraine",
  "BY": "Belarus",
  "BELARUS": "Belarus",
  "EE": "Estonia",
  "ESTONIA": "Estonia",
  "LV": "Latvia",
  "LATVIA": "Latvia",
  "LT": "Lithuania",
  "LITHUANIA": "Lithuania",
  "GE": "Georgia",
  "GEORGIA": "Georgia",
  "AM": "Armenia",
  "ARMENIA": "Armenia",
  "AZ": "Azerbaijan",
  "AZERBAIJAN": "Azerbaijan",
  "MD": "Moldova",
  "MOLDOVA": "Moldova",
  "KZ": "Kazakhstan",
  "KAZAKHSTAN": "Kazakhstan",
  // Americas
  "US": "USA",
  "USA": "USA",
  "CA": "Canada",
  "CANADA": "Canada",
  "MX": "Mexico",
  "MEXICO": "Mexico",
  "BR": "Brazil",
  "BRAZIL": "Brazil",
  "AR": "Argentina",
  "ARGENTINA": "Argentina",
  "CL": "Chile",
  "CHILE": "Chile",
  "CO": "Colombia",
  "COLOMBIA": "Colombia",
  "PE": "Peru",
  "PERU": "Peru",
  "UY": "Uruguay",
  "URUGUAY": "Uruguay",
  "EC": "Ecuador",
  "ECUADOR": "Ecuador",
  "PY": "Paraguay",
  "PARAGUAY": "Paraguay",
  "BO": "Bolivia",
  "BOLIVIA": "Bolivia",
  "VE": "Venezuela",
  "VENEZUELA": "Venezuela",
  "CR": "Costa-Rica",
  "PA": "Panama",
  "HN": "Honduras",
  "GT": "Guatemala",
  "SV": "El-Salvador",
  "JM": "Jamaica",
  "TT": "Trinidad-And-Tobago",
  // Asia / Oceania
  "JP": "Japan",
  "JAPAN": "Japan",
  "KR": "South-Korea",
  "SOUTH KOREA": "South-Korea",
  "CN": "China",
  "CHINA": "China",
  "AU": "Australia",
  "AUSTRALIA": "Australia",
  "NZ": "New-Zealand",
  "ID": "Indonesia",
  "INDONESIA": "Indonesia",
  "TH": "Thailand",
  "THAILAND": "Thailand",
  "VN": "Vietnam",
  "VIETNAM": "Vietnam",
  "MY": "Malaysia",
  "MALAYSIA": "Malaysia",
  "PH": "Philippines",
  "IN": "India",
  "INDIA": "India",
  "SA": "Saudi-Arabia",
  "AE": "United-Arab-Emirates",
  "QA": "Qatar",
  "QATAR": "Qatar",
  "BH": "Bahrain",
  "OM": "Oman",
  "JO": "Jordan",
  "IR": "Iran",
  "IRAN": "Iran",
  "IQ": "Iraq",
  "IL": "Israel",
  "ISRAEL": "Israel",
  "UZ": "Uzbekistan",
  // Africa
  "ZA": "South-Africa",
  "SOUTH AFRICA": "South-Africa",
  "EG": "Egypt",
  "EGYPT": "Egypt",
  "MA": "Morocco",
  "MOROCCO": "Morocco",
  "TN": "Tunisia",
  "TUNISIA": "Tunisia",
  "DZ": "Algeria",
  "ALGERIA": "Algeria",
  "NG": "Nigeria",
  "NIGERIA": "Nigeria",
  "GH": "Ghana",
  "GHANA": "Ghana",
  "KE": "Kenya",
  "KENYA": "Kenya",
  "UG": "Uganda",
  "UGANDA": "Uganda",
  "TZ": "Tanzania",
  "ET": "Ethiopia",
  "SN": "Senegal",
  "CI": "Ivory-Coast",
  "CM": "Cameroon",
  "CONGO": "DR-Congo",
  // International / cup tournaments
  "INTERNATIONAL": "World",
  "WORLD": "World",
  "EUROPE": "World",
  "AFRICA": "World",
  "ASIA": "World",
  "AMERICAS": "World",
};

function mapBetfairRegion(region: string | undefined | null): string | null {
  if (!region) return null;
  const key = region.trim().toUpperCase();
  return BETFAIR_REGION_TO_AF_COUNTRY[key] ?? null;
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
    const mappedCountry = mapBetfairRegion(bfComp.competitionRegion);

    let candidates: typeof afLeagues = [];
    let usedThreshold = FUZZY_MATCH_THRESHOLD;
    if (mappedCountry) {
      candidates = afByCountry.get(mappedCountry) ?? [];
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
      const afCountry = bestAf.country?.name ?? mappedCountry ?? "Unknown";
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
      const archetype = archetypeFor({
        name: bfName,
        country: mappedCountry,
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
          country: mappedCountry ?? "Unknown",
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
