/**
 * Task 15 (Phase 4a.2) — ClubElo team-name resolution & lookup.
 *
 * api-football team names are verbose ("Manchester City",
 * "Bayern München", "Real Madrid"). ClubElo canonical names are
 * compressed and inconsistent ("ManCity", "Bayern", "RealMadrid").
 * This module resolves the former to the latter via a cascade:
 *
 *   1. Exact case-insensitive match
 *   2. Normalised match (strip diacritics, FC/CF/SC prefixes,
 *      strip spaces, lowercase)
 *   3. Substring containment (both directions)
 *   4. Levenshtein distance ≤ 2 (catches small typos / accents)
 *
 * Each resolution is cached in-process per (team_name, date).
 * Returns null if no candidate clears all four passes.
 *
 * Used by featureEngine.ts to add home_clubelo / away_clubelo /
 * elo_diff as shadow features (stored in `features` table; NOT
 * yet wired into FEATURE_NAMES / the model). The shadow accumulates
 * until we verify the resolution hit rate is acceptable; a future
 * PR flips them into model input.
 */

import { db, clubEloSnapshotsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface CacheEntry {
  elo: number | null;
  matchedName: string | null;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function normalise(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/\b(fc|cf|sc|afc|ac|sv|vfb|vfl|tsv|ssc|us|as|asd|asl|aek|sk|sp|csd|club)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Tokenise a name: lowercase, NFD-strip diacritics, drop short prefixes,
 * split on non-alphanumerics, drop empties.
 */
function tokenise(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(fc|cf|sc|afc|ac|sv|vfb|vfl|tsv|ssc|us|as|asd|asl|aek|sk|sp|csd|club|ii|iii)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Token-prefix match — does `short` factor as a concatenation of
 * non-empty prefixes of the tokens of `longName`?
 *
 * Catches "Manchester City" → "ManCity":
 *   tokens=["manchester","city"], short="mancity"
 *   take "man" + "city" = "mancity" ✓
 *
 * Backtracks to find any valid splitting.
 */
function tokenPrefixMatch(longName: string, short: string): boolean {
  const tokens = tokenise(longName);
  const target = short.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (tokens.length === 0 || target.length === 0) return false;

  const dfs = (tokIdx: number, remaining: string): boolean => {
    if (tokIdx === tokens.length) return remaining.length === 0;
    if (remaining.length === 0) return false;
    const tok = tokens[tokIdx]!;
    for (let i = 1; i <= tok.length && i <= remaining.length; i++) {
      if (remaining.slice(0, i) === tok.slice(0, i)) {
        if (dfs(tokIdx + 1, remaining.slice(i))) return true;
      } else {
        break; // prefixes must match contiguously from i=1
      }
    }
    return false;
  };

  return dfs(0, target);
}

/**
 * Single-token match — does `short` equal any single token of `longName`?
 * Catches "Spartak Moscow" → "Spartak" (drop the city qualifier).
 */
function anyTokenEquals(longName: string, short: string): boolean {
  const tokens = tokenise(longName);
  const target = short.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (target.length < 4) return false; // avoid trivial matches like "fc"
  return tokens.some((t) => t === target);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0]![j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1,
        );
      }
    }
  }
  return matrix[b.length]![a.length]!;
}

interface CandidateRow {
  teamName: string;
  elo: string;
  country: string | null;
}

let candidatesCache: { rows: CandidateRow[]; fetchedAt: number; date: string } | null = null;
const CANDIDATES_TTL_MS = 60 * 60 * 1000;

async function loadCurrentCandidates(): Promise<CandidateRow[]> {
  const now = Date.now();
  if (candidatesCache && now - candidatesCache.fetchedAt < CANDIDATES_TTL_MS) {
    return candidatesCache.rows;
  }
  // Use most recent snapshot date — typically yesterday.
  const result = await db
    .select({
      teamName: clubEloSnapshotsTable.teamName,
      elo: clubEloSnapshotsTable.elo,
      country: clubEloSnapshotsTable.country,
      date: clubEloSnapshotsTable.date,
    })
    .from(clubEloSnapshotsTable)
    .where(
      sql`${clubEloSnapshotsTable.date} = (SELECT MAX(date) FROM club_elo_snapshots)`,
    );
  const rows: CandidateRow[] = result.map((r) => ({
    teamName: r.teamName,
    elo: r.elo,
    country: r.country,
  }));
  const date = result[0]?.date ?? "";
  candidatesCache = { rows, fetchedAt: now, date };
  logger.info({ rows: rows.length, date }, "ClubElo candidates loaded");
  return rows;
}

/**
 * Resolve an api-football team name to its ClubElo Elo rating.
 * Returns { elo, matchedName } when a candidate clears the cascade.
 *
 * Country hint is optional: if provided, restricts candidates to the
 * same ISO-3 country code (ClubElo's `Country` column). Slashing
 * the candidate pool by country reduces false-positive Levenshtein
 * matches in cross-league lookups.
 */
export async function getClubEloForTeam(
  teamName: string,
  countryHint?: string,
): Promise<{ elo: number | null; matchedName: string | null }> {
  if (!teamName) return { elo: null, matchedName: null };
  const cacheKey = `${teamName}::${countryHint ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { elo: cached.elo, matchedName: cached.matchedName };
  }

  let candidates = await loadCurrentCandidates();
  if (countryHint) {
    const hint = countryHint.toUpperCase();
    const filtered = candidates.filter((c) => c.country?.toUpperCase() === hint);
    if (filtered.length > 0) candidates = filtered;
    // Fall through to full pool if the country hint produces zero
    // candidates — better to risk a cross-country false-positive than
    // return null for a name that exists but in a different country
    // code than we expected.
  }

  const teamLower = teamName.toLowerCase().trim();
  const teamNorm = normalise(teamName);

  // 1. Exact case-insensitive
  for (const c of candidates) {
    if (c.teamName.toLowerCase() === teamLower) {
      return persist(cacheKey, Number(c.elo), c.teamName);
    }
  }
  // 2. Normalised match
  for (const c of candidates) {
    if (normalise(c.teamName) === teamNorm) {
      return persist(cacheKey, Number(c.elo), c.teamName);
    }
  }
  // 3. Token-prefix match (catches "Manchester City" → "ManCity",
  // "Real Madrid" → "RealMadrid", "Bayern Munich" → "Bayern").
  for (const c of candidates) {
    if (tokenPrefixMatch(teamName, c.teamName)) {
      return persist(cacheKey, Number(c.elo), c.teamName);
    }
  }
  // 4. Single-token match (catches "Spartak Moscow" → "Spartak",
  // "CSKA Moscow" → "CSKA", "Shakhtar Donetsk" → "Shakhtar").
  for (const c of candidates) {
    if (anyTokenEquals(teamName, c.teamName)) {
      return persist(cacheKey, Number(c.elo), c.teamName);
    }
  }
  // 5. Substring containment (either direction). Require >=4 chars
  // on the shorter string to avoid trivial matches.
  for (const c of candidates) {
    const cNorm = normalise(c.teamName);
    if (cNorm.length >= 4 && teamNorm.length >= 4) {
      if (cNorm.includes(teamNorm) || teamNorm.includes(cNorm)) {
        return persist(cacheKey, Number(c.elo), c.teamName);
      }
    }
  }
  // 6. Levenshtein ≤ 2 on normalised names with length ≥ 5.
  // Computed only when prior passes failed — keeps per-call cost low.
  let bestDist = Infinity;
  let bestMatch: CandidateRow | null = null;
  for (const c of candidates) {
    const cNorm = normalise(c.teamName);
    if (cNorm.length < 5 || teamNorm.length < 5) continue;
    const d = levenshtein(cNorm, teamNorm);
    if (d < bestDist) {
      bestDist = d;
      bestMatch = c;
    }
  }
  if (bestMatch && bestDist <= 2) {
    return persist(cacheKey, Number(bestMatch.elo), bestMatch.teamName);
  }

  return persist(cacheKey, null, null);
}

function persist(
  cacheKey: string,
  elo: number | null,
  matchedName: string | null,
): { elo: number | null; matchedName: string | null } {
  cache.set(cacheKey, { elo, matchedName, fetchedAt: Date.now() });
  return { elo, matchedName };
}

/** Drop the in-process caches. */
export function invalidateClubEloCaches(): void {
  cache.clear();
  candidatesCache = null;
}
