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
 * Behaviour: writes by default (Wave 3, 2026-05-07). Reads
 * BETFAIR_REVERSE_MAPPING_DRY_RUN env; defaults to "false" (write mode) if
 * unset. Set BETFAIR_REVERSE_MAPPING_DRY_RUN=true to suppress writes when
 * iterating locally. The cron is idempotent — safe to re-run. Writes are
 * positively scoped per §3.5 below (insert-only / fill-NULL).
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
  modelDecisionAuditLogTable,
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

// Wave 3 (Phase 2 closeout): threshold for matches scoped to a known
// Betfair region (i.e. country candidates pre-filtered by mapBetfairRegion)
// lowered from 0.85 → 0.78. Empirical context: ~22 Tier D leagues from
// earlier dry-runs failed at 0.85 despite having a clear country match.
// Hard threshold for unmapped regions stays 0.95 to preserve precision when
// the candidate pool is the entire AF universe.
const FUZZY_MATCH_THRESHOLD = 0.78;
const NO_REGION_FUZZY_THRESHOLD = 0.95;

// Wave 3: country-name normalization. AF data is inconsistent — same
// country appears as "Costa-Rica" (4 rows) and "Costa Rica" (1 row),
// "Czech-Republic" (11) vs "Czech Republic" (2), "South-Korea" (6) vs
// "South Korea" (2), etc. Normalising both sides at lookup time
// (lowercase, collapse-whitespace, swap-hyphens) catches every variant
// without needing to enumerate them in BETFAIR_REGION_TO_AF_COUNTRIES.
function normCountry(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "-");
}

// Wave 3: aliases for cases where AF stores the same country under a
// genuinely different name (not just a space-vs-hyphen variant).
// Lookup normalises canonical → list of alternative AF country names.
const COUNTRY_NAME_ALIASES: Record<string, string[]> = {
  "bosnia": ["bosnia-herzegovina", "bosnia-and-herzegovina"],
  "bosnia-herzegovina": ["bosnia"],
  "north-macedonia": ["macedonia"],
  "macedonia": ["north-macedonia"],
  "united-arab-emirates": ["uae"],
  "trinidad-and-tobago": ["trinidad-tobago"],
};
const ODDS_PAPI_STALENESS_DAYS = 14;
const FUZZY_FAILURE_SAMPLE_SIZE = 30;

// ─── Token-set ratio fuzzy match (plan §3.1) + country-adjective strip ──────

// Country-adjective tokens stripped from BOTH sides during tokenisation
// (Commit A.3, 2026-05-05). Empirically catches "Belgian Pro League" →
// AF "Jupiler Pro League" (ratio 1.0 after strip), "Argentinian Primera
// Division" → "Primera División" (ratio 1.0), "French Premiere Ligue" →
// "Ligue 1" (ratio 1.0 after also stripping "premiere"), etc.
//
// Synonym handling (Pro↔Professional, Liga↔League) is NOT in this set —
// that's deferred to a v3 follow-up. ~22 of 30 fuzzy failures from
// Commit A.2 remain as legitimate Tier D after this strip.
const COUNTRY_ADJECTIVES: Set<string> = new Set([
  // Europe
  "english", "scottish", "welsh", "irish", "british", "northern",
  "french", "german", "italian", "spanish", "portuguese", "dutch", "belgian",
  "swiss", "austrian", "luxembourgish",
  "swedish", "norwegian", "danish", "finnish", "icelandic", "faroese",
  "polish", "czech", "slovak", "slovakian", "hungarian", "romanian",
  "bulgarian", "serbian", "croatian", "slovenian", "bosnian", "montenegrin",
  "macedonian", "albanian", "greek", "turkish", "cypriot", "maltese",
  "russian", "ukrainian", "belarusian", "estonian", "latvian", "lithuanian",
  "georgian", "armenian", "azerbaijani", "moldovan", "kazakh", "uzbek",
  // Americas
  "american", "canadian", "mexican",
  "brazilian", "argentinian", "argentine", "chilean", "colombian", "peruvian",
  "uruguayan", "ecuadorian", "paraguayan", "bolivian", "venezuelan",
  "panamanian", "honduran", "jamaican", "guatemalan", "costa", "rican",
  // Asia / Oceania
  "japanese", "korean", "chinese", "australian", "indonesian",
  "thai", "vietnamese", "malaysian", "philippine", "indian",
  "saudi", "qatari", "bahraini", "omani", "emirati", "uae",
  "iranian", "iraqi", "israeli", "jordanian", "lebanese", "kuwaiti", "uzbekistani",
  // Africa
  "egyptian", "moroccan", "tunisian", "algerian",
  "nigerian", "ghanaian", "kenyan", "ugandan", "tanzanian", "ethiopian",
  "senegalese", "ivorian", "cameroonian", "rwandan", "zimbabwean", "botswanan",
  "south", "african",  // for "South African"
  // Generic abbreviations
  "us", "gb", "uk",
  // French equivalents that work like country-adjective noise
  "premiere",  // Betfair "French Premiere Ligue" → strip "premiere" lets "Ligue" match
]);

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
    new Set(
      normaliseLeagueName(s)
        .split(" ")
        .filter((t) => t.length > 0 && !COUNTRY_ADJECTIVES.has(t)),
    );
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersect = 0;
  for (const t of A) if (B.has(t)) intersect++;
  return intersect / Math.min(A.size, B.size);
}

// Y4 (2026-05-07): Levenshtein-ratio for Betfair → AF mismatch resolution
// when token-set ratio fails. Different algorithm catches different failure
// modes — token-set is stop-word-aware and order-insensitive but blind to
// transposed letters / character-level typos; Levenshtein catches those.
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function levenshteinRatio(a: string, b: string): number {
  const A = normaliseLeagueName(a);
  const B = normaliseLeagueName(b);
  if (A.length === 0 || B.length === 0) return 0;
  const dist = levenshteinDistance(A, B);
  const maxLen = Math.max(A.length, B.length);
  return 1 - dist / maxLen;
}

// Y4 fallback threshold — only applies after token-set ratio fails. We
// require a higher Levenshtein ratio (0.75) since this is the second-chance
// algorithm and we want to avoid false positives.
const LEVENSHTEIN_FALLBACK_THRESHOLD = 0.75;

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
  "CANADA": ["Canada"], "MEXICO": ["Mexico"],
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
  category?: CompetitionCategory; // Y2 (2026-05-07): category-aware rules
}

// Y2 (2026-05-07): explicit category detection so the model treats women's,
// youth, international tournaments, and friendlies appropriately. Per Phase 2
// brief: "leave no stone unturned. Map every Betfair-tradeable football
// competition." Category detection runs before tier verdict so tier rules
// can be category-aware (e.g. international tournaments → Tier B regardless
// of historical-bet count, since Pinnacle prices these sharply).
type CompetitionCategory =
  | "international_tournament"  // World Cup, Euro, Copa, AFCON, Asian Cup, Nations
  | "international_friendly"    // senior international friendlies
  | "youth"                     // U17/U18/U19/U20/U21/U22/U23
  | "women"                     // any women's competition
  | "club_friendly"             // pre-season + mid-season club friendlies
  | "reserves"                  // II/B teams + academy
  | "club_domestic";            // standard club league

export function detectCategory(name: string, country: string | null, gender: string | null, type: string | null): CompetitionCategory {
  const n = (name ?? "").toLowerCase();
  const c = (country ?? "").toLowerCase();

  // Women's first — most specific
  if (
    gender === "female" ||
    n.includes("women") || n.includes(" w ") ||
    n.endsWith(" w") ||
    n.includes("féminine") || n.includes("feminine") ||
    n.includes("femenina") || n.includes("damen")
  ) return "women";

  // Youth — explicit U-XX patterns
  if (
    /\bu1[789]\b|\bu2[0-3]\b/.test(n) ||
    /\bu-1[789]\b|\bu-2[0-3]\b/.test(n) ||
    n.includes("youth") ||
    n.includes("under 1") || n.includes("under 2") ||
    n.includes("under-1") || n.includes("under-2") ||
    n.includes("juvenil") || n.includes("primavera") ||
    n.includes("akademi") || n.includes("akatemia") || n.includes("academy")
  ) return "youth";

  // International tournaments
  if (
    n.includes("world cup") ||
    n.includes("nations league") ||
    n.includes("uefa nations") ||
    n.includes("euro ") || n.endsWith(" euro") ||
    n.includes("european championship") ||
    n.includes("copa america") || n.includes("copa libertadores") ||
    n.includes("afcon") || n.includes("africa cup of nations") ||
    n.includes("asian cup") || n.includes("afc cup") ||
    n.includes("concacaf gold cup") || n.includes("gold cup") ||
    n.includes("oceania cup") ||
    n.includes("confederations") ||
    /\bwcq\b/.test(n) || n.includes("qualifier") || n.includes("qualifying") ||
    c === "world" || c === "europe" || c === "south-america" || c === "south america" ||
    c === "africa" || c === "asia" || c === "north-america" || c === "oceania" ||
    type === "international"
  ) return "international_tournament";

  // International friendlies (specifically "Friendlies" without club/match)
  if (
    n.includes("international friendl") ||
    (n.includes("friendl") && type === "international")
  ) return "international_friendly";

  // Club friendlies
  if (
    n.includes("friendl") ||
    n.includes("pre season") || n.includes("pre-season") ||
    n.includes("preseason")
  ) return "club_friendly";

  // Reserves
  if (
    /\bii\b/.test(n) || /\bb\b\s*$/.test(n) ||
    n.includes("reserve") || n.includes("reserves")
  ) return "reserves";

  return "club_domestic";
}

function assignTier(input: TierInputs): { tier: Tier; reason: string } {
  if (input.biasIndex != null && Math.abs(input.biasIndex) >= 0.10) {
    return { tier: "D", reason: "bias_threshold_violated" };
  }
  if (!input.matched) {
    return { tier: "D", reason: "no_af_match" };
  }

  // Y2 (2026-05-07): category-aware tier overrides. Per "leave no stone
  // unturned" principle — international tournaments + women's + youth +
  // friendlies all get an active tier, never default-Tier-E.
  const cat = input.category;
  if (cat === "international_tournament") {
    // World Cup, Euro, Nations League etc. — Pinnacle prices these sharply.
    // Default to B (shadow) for new ones; A only if has Pinnacle coverage.
    if (input.hasOdds && input.oddsPapiAgeDays <= ODDS_PAPI_STALENESS_DAYS) {
      return { tier: "A", reason: "international_tournament_pinnacle_reliable" };
    }
    return { tier: "B", reason: "international_tournament_shadow_default" };
  }
  if (cat === "international_friendly") {
    return { tier: "C", reason: "international_friendly_probationary" };
  }
  if (cat === "youth") {
    return { tier: "C", reason: "youth_probationary" };
  }
  if (cat === "club_friendly") {
    return { tier: "C", reason: "club_friendly_probationary" };
  }
  if (cat === "women") {
    // Women's senior leagues — treat as standard club; Pinnacle prices the
    // big ones (NWSL, FA WSL, UEFA Women's CL) so they may grade Tier A.
    if (input.hasOdds && input.oddsPapiAgeDays <= ODDS_PAPI_STALENESS_DAYS) {
      return { tier: "A", reason: "womens_pinnacle_reliable" };
    }
    if (!input.hasHistoricalBets) {
      return { tier: "C", reason: "womens_probationary_no_history" };
    }
    return { tier: "B", reason: "womens_no_pinnacle_coverage" };
  }
  if (cat === "reserves") {
    return { tier: "C", reason: "reserves_probationary" };
  }

  // Standard club_domestic logic (unchanged)
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

  // Wave 3 (2026-05-07): default flipped from "true" to "false". Phase 2 is
  // out of initial-rollout and the universe-expansion writes are insert-only
  // (new Tier D rows, fill-NULL on existing rows) per §3.5. The dry-run
  // safety net stays available — set BETFAIR_REVERSE_MAPPING_DRY_RUN=true to
  // re-enable diff-only mode for local iteration.
  const dryRun = (process.env.BETFAIR_REVERSE_MAPPING_DRY_RUN ?? "false").toLowerCase() === "true";

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

  // Index AF leagues by country for fast pre-filter.
  // Wave 3: key on normCountry(name) so "Costa Rica" and "Costa-Rica" hash
  // to the same bucket. Affects ~10 countries across the AF dataset.
  const afByCountry = new Map<string, typeof afLeagues>();
  for (const af of afLeagues) {
    const country = normCountry(af.country?.name ?? "");
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
      // Wave 3: each mapped country expands to {normalized form} +
      // {known aliases} — both lookup keys point at the same map.
      const seen = new Set<number>();
      candidates = [];
      for (const rawCountry of mappedCountries) {
        const norm = normCountry(rawCountry);
        const buckets = [norm, ...(COUNTRY_NAME_ALIASES[norm] ?? [])];
        for (const key of buckets) {
          for (const af of afByCountry.get(key) ?? []) {
            const id = af.league?.id;
            if (id != null && !seen.has(id)) {
              seen.add(id);
              candidates.push(af);
            }
          }
        }
      }
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

    // Y4 (2026-05-07): Levenshtein fallback — when token-set ratio fails
    // to clear the threshold, try Levenshtein-ratio with a lower bar.
    // Different algorithm catches transposed letters / character-level
    // typos that token-set is blind to. Only applied to country-narrowed
    // candidate sets (i.e. usedThreshold === FUZZY_MATCH_THRESHOLD) so we
    // don't over-match against the full ~1200-league universe.
    let usedLevenshteinFallback = false;
    if (bestScore < usedThreshold && usedThreshold === FUZZY_MATCH_THRESHOLD) {
      let lvBestScore = 0;
      let lvBestAf: typeof afLeagues[number] | null = null;
      for (const af of candidates) {
        const lvScore = levenshteinRatio(bfName, af.league.name);
        if (lvScore > lvBestScore) {
          lvBestScore = lvScore;
          lvBestAf = af;
        }
      }
      if (lvBestScore >= LEVENSHTEIN_FALLBACK_THRESHOLD && lvBestAf != null) {
        bestScore = lvBestScore;
        bestAf = lvBestAf;
        usedLevenshteinFallback = true;
      }
    }
    void usedLevenshteinFallback; // tracked for telemetry; included in fuzzy failure log

    if (bestScore >= Math.min(usedThreshold, LEVENSHTEIN_FALLBACK_THRESHOLD) && bestAf != null) {
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

        // Y2 (2026-05-07): category-aware tier assignment
        const category = detectCategory(afName, afCountry, null, afType);
        const tierVerdict = assignTier({
          matched: true,
          hasOdds,
          oddsPapiAgeDays,
          hasHistoricalBets,
          biasIndex: null,
          category,
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

          // Y2 (2026-05-07): category-aware tier assignment for unmapped rows
          const category = detectCategory(existingCc.name, existingCc.country, existingCc.gender, existingCc.type);
          const tierVerdict = assignTier({
            matched: true,
            hasOdds,
            oddsPapiAgeDays,
            hasHistoricalBets,
            biasIndex: null,
            category,
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

// ─── Y3 (2026-05-07): Autonomous WC participant coverage audit ──────────────
// Identifies countries that are participating in World Cup competitions
// (qualifiers + final) but have no Tier 1 active club league in
// competition_config. For each gap-country, autonomously promotes that
// country's most-likely Tier 1 league from Tier E (or Tier D) to an
// active tier so the model captures shadow bets from those leagues
// during the WC build-up.
//
// Data-driven from existing matches table — no new AF API calls. Uses
// the matches we've already ingested to identify which national teams
// are competing in WC fixtures, which countries those teams represent,
// and which countries lack club-level coverage.

export interface WcAuditResult {
  runId: string;
  wcParticipantCountries: number;
  countriesWithCoverage: number;
  countriesWithoutCoverage: number;
  promotionsApplied: number;
  durationMs: number;
}

export async function auditWorldCupParticipantCoverage(): Promise<WcAuditResult> {
  const startedAt = Date.now();
  const runId = `wc-audit-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  // Step 1: identify WC-related competitions in our matches table.
  // Matches league names include "World Cup", "WCQ", "Qualifier", "Qualifying"
  // for WC qualification fixtures.
  const wcCountriesRows = await db.execute(sql`
    SELECT DISTINCT m.country, COUNT(*) AS fixture_count
    FROM matches m
    WHERE m.kickoff_time BETWEEN NOW() - INTERVAL '90 days' AND NOW() + INTERVAL '365 days'
      AND (
        LOWER(m.league) LIKE '%world cup%'
        OR LOWER(m.league) LIKE '%wcq%'
        OR LOWER(m.league) LIKE '%qualifier%'
        OR LOWER(m.league) LIKE '%qualifying%'
      )
    GROUP BY m.country
    HAVING COUNT(*) >= 1
  `);

  const wcCountries = ((wcCountriesRows as any).rows ?? []).map((r: any) => r.country).filter(Boolean) as string[];

  if (wcCountries.length === 0) {
    logger.info({ runId }, "WC audit — no WC fixtures detected in 90d-back-to-365d-forward window");
    return {
      runId,
      wcParticipantCountries: 0,
      countriesWithCoverage: 0,
      countriesWithoutCoverage: 0,
      promotionsApplied: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  // For the WC qualifying fixtures, we don't easily get participating
  // countries from `m.country` (which often reads as "World" / "Europe").
  // Instead, look at home_team / away_team strings — these are usually
  // country names for international fixtures. Cross-reference with
  // competition_config countries to identify which countries are playing.
  const wcTeamsRows = await db.execute(sql`
    SELECT DISTINCT team
    FROM (
      SELECT m.home_team AS team FROM matches m
      WHERE m.kickoff_time BETWEEN NOW() - INTERVAL '90 days' AND NOW() + INTERVAL '365 days'
        AND (LOWER(m.league) LIKE '%world cup%' OR LOWER(m.league) LIKE '%wcq%' OR LOWER(m.league) LIKE '%qualifier%' OR LOWER(m.league) LIKE '%qualifying%')
      UNION
      SELECT m.away_team AS team FROM matches m
      WHERE m.kickoff_time BETWEEN NOW() - INTERVAL '90 days' AND NOW() + INTERVAL '365 days'
        AND (LOWER(m.league) LIKE '%world cup%' OR LOWER(m.league) LIKE '%wcq%' OR LOWER(m.league) LIKE '%qualifier%' OR LOWER(m.league) LIKE '%qualifying%')
    ) t
  `);
  const wcTeams = ((wcTeamsRows as any).rows ?? []).map((r: any) => r.team).filter(Boolean) as string[];

  // Many international teams have country-name-as-team (e.g. "England", "Brazil")
  // Match these against competition_config.country (case-insensitive) to identify
  // candidate countries with WC participation.
  const candidateCountries = new Set<string>();
  for (const team of wcTeams) {
    const normalized = team.toLowerCase().replace(/-/g, " ").trim();
    candidateCountries.add(normalized);
  }

  // Step 2: which of those countries have at least one active top_flight_men
  // club league in competition_config?
  const coverageRows = await db.execute(sql`
    SELECT DISTINCT LOWER(REPLACE(country, '-', ' ')) AS country
    FROM competition_config
    WHERE archetype = 'top_flight_men'
      AND universe_tier IN ('A', 'B', 'C')
      AND is_active = true
  `);
  const coveredCountries = new Set<string>(
    ((coverageRows as any).rows ?? []).map((r: any) => r.country),
  );

  // Step 3: for each candidate-without-coverage, find a candidate Tier E
  // top_flight_men league for that country and autonomously promote it.
  const gapCountries: string[] = [];
  for (const c of candidateCountries) {
    if (!coveredCountries.has(c)) gapCountries.push(c);
  }

  let promotionsApplied = 0;
  for (const country of gapCountries) {
    // Find a Tier E top_flight_men row for this country (best candidate
    // for promotion). Limit 1 per gap-country to avoid promoting many.
    const candidateRow = await db.execute(sql`
      SELECT id, name, country
      FROM competition_config
      WHERE LOWER(REPLACE(country, '-', ' ')) = ${country}
        AND archetype = 'top_flight_men'
        AND universe_tier IN ('E', 'D')
      ORDER BY universe_tier_decided_at DESC NULLS LAST
      LIMIT 1
    `);
    const candidate = (candidateRow as any).rows?.[0];
    if (!candidate) continue;

    // Promote to Tier C (probationary — model will graduate via Z4 ladder)
    await db
      .update(competitionConfigTable)
      .set({
        universeTier: "C",
        universeTierDecidedAt: new Date(),
        isActive: true,
      })
      .where(eq(competitionConfigTable.id, candidate.id));

    await db.insert(modelDecisionAuditLogTable).values({
      decisionType: "wc_country_coverage_promotion",
      subject: `competition:${candidate.id}:${candidate.name}/${candidate.country ?? "unknown"}`,
      priorState: { universe_tier: "E_or_D" } as any,
      newState: { universe_tier: "C", reason: "wc_participant_country_no_coverage" } as any,
      reasoning: `Y3 autonomous promotion: country '${country}' has WC qualifying fixtures in last 90d / next 365d but had no top_flight_men league in active tier. Promoted candidate league to Tier C (probationary).`,
      supportingMetrics: {
        country,
        wc_team_count: wcTeams.length,
        wc_country_set_size: candidateCountries.size,
        gap_countries_count: gapCountries.length,
        runId,
      } as any,
      expectedImpact: null,
      reviewStatus: "automatic",
    });

    promotionsApplied++;
  }

  const result: WcAuditResult = {
    runId,
    wcParticipantCountries: candidateCountries.size,
    countriesWithCoverage: candidateCountries.size - gapCountries.length,
    countriesWithoutCoverage: gapCountries.length,
    promotionsApplied,
    durationMs: Date.now() - startedAt,
  };

  logger.info(result, "wc_audit_complete");
  return result;
}

// ─── Y1 (2026-05-07): Tier E re-evaluation pass ──────────────────────────────
// The original betfairFirstUniverse cron is INSERT-ONLY: existing tier rows
// stay at their assigned tier forever. With Y2's category-aware rules in
// place, many Tier E rows (especially women's, youth, internationals,
// friendlies) should now qualify for active tiers. This function re-runs
// assignTier with current category info on Tier E rows and updates any
// where the verdict has shifted.
//
// Per the brief's autonomy envelope: "Promotion of experiment-graduated
// leagues to candidate tier" + "All feature engineering decisions" +
// "Demotion of underperforming leagues from any tier" — all autonomous.
// This function autonomously reactivates Tier E rows where category-aware
// rules now grant them tier B/C status, with full audit logging.

export interface TierEReevalResult {
  runId: string;
  rowsScanned: number;
  rowsReclassified: number;
  byNewTier: Record<string, number>;
  byCategory: Record<string, number>;
  durationMs: number;
}

export async function reevaluateExcludedLeagues(): Promise<TierEReevalResult> {
  const startedAt = Date.now();
  const runId = `tier-e-reeval-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

  // Pull all Tier E rows with active=true OR with recent fixtures (i.e. data
  // suggesting they're real competitions, not historical artefacts).
  const tierERows = await db
    .select({
      id: competitionConfigTable.id,
      apiFootballId: competitionConfigTable.apiFootballId,
      name: competitionConfigTable.name,
      country: competitionConfigTable.country,
      type: competitionConfigTable.type,
      gender: competitionConfigTable.gender,
      tier: competitionConfigTable.tier,
      hasOdds: competitionConfigTable.hasOdds,
      hasPinnacleOdds: competitionConfigTable.hasPinnacleOdds,
      betfairCompetitionId: competitionConfigTable.betfairCompetitionId,
    })
    .from(competitionConfigTable)
    .where(eq(competitionConfigTable.universeTier, "E"));

  if (tierERows.length === 0) {
    logger.info({ runId }, "Tier E re-eval — no rows to scan");
    return {
      runId,
      rowsScanned: 0,
      rowsReclassified: 0,
      byNewTier: {},
      byCategory: {},
      durationMs: Date.now() - startedAt,
    };
  }

  // Bulk-load oddspapi coverage (re-used pattern from main fn)
  const opCoverage = await db.select().from(oddspapiLeagueCoverageTable);
  const opByLeague = new Map<string, { hasOdds: number; lastChecked: Date }>();
  for (const r of opCoverage) {
    opByLeague.set(r.league.toLowerCase(), { hasOdds: r.hasOdds, lastChecked: r.lastChecked });
  }

  // Bulk-load historical-bet leagues
  const histLeagues = await db.execute(sql`
    SELECT DISTINCT LOWER(m.league) AS league
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status IN ('won', 'lost')
      AND pb.deleted_at IS NULL
  `);
  const leaguesWithBets = new Set<string>(
    ((histLeagues as any).rows ?? []).map((r: { league: string }) => r.league),
  );

  let rowsReclassified = 0;
  const byNewTier: Record<string, number> = {};
  const byCategory: Record<string, number> = {};

  for (const row of tierERows) {
    const category = detectCategory(row.name, row.country, row.gender, row.type);
    byCategory[category] = (byCategory[category] ?? 0) + 1;

    const opRow = opByLeague.get(row.name.toLowerCase());
    const hasOdds = opRow ? opRow.hasOdds === 1 : Boolean(row.hasOdds);
    const oddsPapiAgeDays = opRow?.lastChecked
      ? (Date.now() - new Date(opRow.lastChecked).getTime()) / (24 * 3600 * 1000)
      : Infinity;
    const hasHistoricalBets = leaguesWithBets.has(row.name.toLowerCase());

    const verdict = assignTier({
      matched: row.apiFootballId != null, // E-tier rows can be either matched or no_af_match
      hasOdds,
      oddsPapiAgeDays,
      hasHistoricalBets,
      biasIndex: null, // Re-evaluation — bias only applies on demotion path, not promotion
      category,
    });

    // Only reclassify if verdict differs from E. Tier D verdicts are still
    // promotions vs E (rejected → at-least-tracked).
    if (verdict.tier === "E") continue;

    byNewTier[verdict.tier] = (byNewTier[verdict.tier] ?? 0) + 1;

    await db
      .update(competitionConfigTable)
      .set({
        universeTier: verdict.tier,
        universeTierDecidedAt: new Date(),
        isActive: verdict.tier === "A" || verdict.tier === "B" || verdict.tier === "C",
      })
      .where(eq(competitionConfigTable.id, row.id));

    // Audit log autonomous reactivation
    await db.insert(modelDecisionAuditLogTable).values({
      decisionType: "tier_e_reactivation",
      subject: `competition:${row.id}:${row.name}/${row.country ?? "unknown"}`,
      priorState: { universe_tier: "E", category: null } as any,
      newState: { universe_tier: verdict.tier, category, reason: verdict.reason } as any,
      reasoning: `Y1 Tier E re-evaluation: category=${category} → ${verdict.tier} (${verdict.reason}). hasOdds=${hasOdds}, hasHistoricalBets=${hasHistoricalBets}.`,
      supportingMetrics: {
        category,
        hasOdds,
        oddsPapiAgeDays: Number.isFinite(oddsPapiAgeDays) ? oddsPapiAgeDays : null,
        hasHistoricalBets,
        runId,
      } as any,
      expectedImpact: null,
      reviewStatus: "automatic",
    });

    rowsReclassified++;
  }

  const result: TierEReevalResult = {
    runId,
    rowsScanned: tierERows.length,
    rowsReclassified,
    byNewTier,
    byCategory,
    durationMs: Date.now() - startedAt,
  };

  logger.info(result, "tier_e_reevaluation_summary");
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
