/**
 * Task 15 — ClubElo daily ingestion (Phase 4a).
 *
 * api.clubelo.com is a free, no-auth CSV API maintained by the
 * "Football Club Elo Ratings" project. Two endpoints:
 *   - http://api.clubelo.com/{YYYY-MM-DD}  — all clubs on that date
 *   - http://api.clubelo.com/{TEAM}        — full history for one team
 *
 * We fetch the all-clubs CSV once a day (cron 02:00 UTC) and upsert
 * into club_elo_snapshots. ~3,300 rows per fetch. Feature-engine
 * integration is Phase 4a.2.
 *
 * CSV shape (all-clubs endpoint, one row per club):
 *   Rank,Club,Country,Level,Elo,From,To
 *   1,RealMadrid,ESP,1,2125.79,2026-05-09,2026-05-12
 *   2,ManCity,ENG,1,2089.41,2026-05-08,2026-05-13
 *   …
 *
 * `Rank` can be blank for retired or non-active teams. Level=1 is the
 * top tier in the team's country.
 */

import { db, clubEloSnapshotsTable, matchesTable, featuresTable } from "@workspace/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { resilientFetch } from "./resilientFetch";
import { getClubEloForTeam } from "./clubEloLookup";

const BASE_URL = "http://api.clubelo.com";

export interface ClubEloFetchResult {
  date: string;
  rowsFetched: number;
  rowsInserted: number;
  rowsSkipped: number;
  durationMs: number;
}

interface ParsedRow {
  rank: number | null;
  teamName: string;
  country: string | null;
  level: number | null;
  elo: number;
  fromDate: string | null;
  toDate: string | null;
}

/** Coerce a CSV cell to an integer, returning null if blank, "NaN", or non-finite. */
function intOrNull(cell: string | undefined): number | null {
  if (!cell) return null;
  const trimmed = cell.trim();
  if (!trimmed || trimmed === "NaN" || trimmed === "None") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseCsvRow(line: string): ParsedRow | null {
  // CSV from ClubElo is comma-separated, no embedded commas, no quoting.
  const parts = line.split(",");
  if (parts.length < 7) return null;
  const [rank, club, country, level, elo, fromDate, toDate] = parts;
  if (!club || !elo) return null;
  const eloNum = Number(elo);
  if (!Number.isFinite(eloNum)) return null;
  return {
    // ClubElo returns "NaN" for retired/inactive clubs and some
    // transitional rows. Drop those to null rather than pass through
    // a JS NaN — Postgres rejects NaN on the integer column.
    rank: intOrNull(rank),
    teamName: club.trim(),
    country: country?.trim() || null,
    level: intOrNull(level),
    elo: eloNum,
    fromDate: fromDate?.trim() || null,
    toDate: toDate?.trim() || null,
  };
}

/**
 * Fetch one day's full ClubElo snapshot as a CSV string and parse rows.
 * Returns an empty array on any fetch failure (the resilientFetch layer
 * logs the error already).
 */
export async function fetchClubEloForDate(dateIso: string): Promise<ParsedRow[]> {
  // resilientFetch parses JSON by default — for plain CSV we have to
  // bypass and call fetch directly with the same retry semantics.
  // For simplicity, use a single attempt + 30s timeout; ClubElo is
  // reliable enough.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${BASE_URL}/${dateIso}`, {
      signal: controller.signal,
      headers: {
        "User-Agent": "BetAgentOS/1.0 (research; chris.mcg@hotmail.co.uk)",
        Accept: "text/csv",
      },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, dateIso }, "ClubElo fetch non-OK");
      return [];
    }
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    if (lines.length === 0) return [];
    // First line is the header — skip if present.
    const startIdx = lines[0]?.toLowerCase().startsWith("rank,") ? 1 : 0;
    const rows: ParsedRow[] = [];
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      const parsed = parseCsvRow(line);
      if (parsed) rows.push(parsed);
    }
    return rows;
  } catch (err) {
    logger.warn({ err, dateIso }, "ClubElo fetch failed");
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Daily ingestion entry point. Fetches yesterday's snapshot (so the rows
 * are stable — today's Elo can change late as match results roll in).
 *
 * Idempotent — composite PK (date, team_name) means re-running just
 * upserts.
 */
export async function runClubEloIngestion(opts: {
  dateOverride?: string; // YYYY-MM-DD; default = yesterday UTC
} = {}): Promise<ClubEloFetchResult> {
  const startedAt = Date.now();
  const targetDate =
    opts.dateOverride ??
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = await fetchClubEloForDate(targetDate);
  const result: ClubEloFetchResult = {
    date: targetDate,
    rowsFetched: rows.length,
    rowsInserted: 0,
    rowsSkipped: 0,
    durationMs: 0,
  };
  if (rows.length === 0) {
    result.durationMs = Date.now() - startedAt;
    logger.warn(result, "ClubElo ingestion: no rows returned");
    return result;
  }

  // Batch upsert. ON CONFLICT silently overwrites — Elo can revise
  // retroactively when ClubElo recomputes.
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    try {
      await db
        .insert(clubEloSnapshotsTable)
        .values(
          batch.map((r) => ({
            date: targetDate,
            teamName: r.teamName,
            country: r.country,
            level: r.level,
            elo: String(r.elo),
            rank: r.rank,
            fromDate: r.fromDate,
            toDate: r.toDate,
          })),
        )
        .onConflictDoUpdate({
          target: [clubEloSnapshotsTable.date, clubEloSnapshotsTable.teamName],
          set: {
            country: clubEloSnapshotsTable.country,
            level: clubEloSnapshotsTable.level,
            elo: clubEloSnapshotsTable.elo,
            rank: clubEloSnapshotsTable.rank,
            fromDate: clubEloSnapshotsTable.fromDate,
            toDate: clubEloSnapshotsTable.toDate,
          },
        });
      result.rowsInserted += batch.length;
    } catch (err) {
      logger.warn({ err, batchStart: i, batchSize: batch.length }, "ClubElo upsert batch failed");
      result.rowsSkipped += batch.length;
    }
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(result, "ClubElo ingestion complete");
  return result;
}

/**
 * Phase 4a.2 — Elo-only feature backfill for upcoming matches.
 *
 * The main featureEngine.runFeatureEngineForUpcomingMatches applies a
 * 2-hour freshness filter keyed on `home_form_last5`. Matches whose
 * form features are fresh get the entire feature computation skipped,
 * including the new Elo block. To populate Elo on those matches without
 * re-running the full pipeline, this lightweight job:
 *
 *   1. SELECTs upcoming matches (kickoff in next 7 days, status='scheduled')
 *      where `home_clubelo` is not present in features table
 *   2. For each, calls getClubEloForTeam(home) and (away)
 *   3. Upserts home_clubelo / away_clubelo / elo_diff into features
 *
 * Cost: one batched SELECT + N small upserts. Cached resolver makes
 * repeat calls free. Caps to 1000 matches per run to bound DB load.
 */
export interface EloFeatureBackfillResult {
  upcoming_matches: number;
  needing_elo: number;
  home_resolved: number;
  away_resolved: number;
  full_pairs: number;
  durationMs: number;
}

export async function runClubEloFeatureBackfill(): Promise<EloFeatureBackfillResult> {
  const startedAt = Date.now();
  const result: EloFeatureBackfillResult = {
    upcoming_matches: 0,
    needing_elo: 0,
    home_resolved: 0,
    away_resolved: 0,
    full_pairs: 0,
    durationMs: 0,
  };

  // Upcoming matches in the next 7 days.
  const now = new Date();
  const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const upcoming = await db
    .select({
      id: matchesTable.id,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
    })
    .from(matchesTable)
    .where(
      and(
        gte(matchesTable.kickoffTime, now),
        lte(matchesTable.kickoffTime, until),
        eq(matchesTable.status, "scheduled"),
      ),
    )
    .limit(1000);

  result.upcoming_matches = upcoming.length;
  if (upcoming.length === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // One bulk SELECT to find which matches already have home_clubelo.
  const matchIds = upcoming.map((m) => m.id);
  const haveHome = await db.execute(sql`
    SELECT DISTINCT match_id
    FROM features
    WHERE feature_name = 'home_clubelo'
      AND match_id IN (${sql.raw(matchIds.join(","))})
  `);
  const haveHomeSet = new Set<number>(
    (((haveHome as unknown) as { rows?: Array<{ match_id: number }> }).rows ?? []).map((r) => Number(r.match_id)),
  );

  const needing = upcoming.filter((m) => !haveHomeSet.has(m.id));
  result.needing_elo = needing.length;
  if (needing.length === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  for (const match of needing) {
    const homeRes = await getClubEloForTeam(match.homeTeam);
    const awayRes = await getClubEloForTeam(match.awayTeam);
    if (homeRes.elo != null) {
      await upsertFeature(match.id, "home_clubelo", homeRes.elo);
      result.home_resolved++;
    }
    if (awayRes.elo != null) {
      await upsertFeature(match.id, "away_clubelo", awayRes.elo);
      result.away_resolved++;
    }
    if (homeRes.elo != null && awayRes.elo != null) {
      await upsertFeature(match.id, "elo_diff", homeRes.elo - awayRes.elo);
      result.full_pairs++;
    }
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(result, "ClubElo feature backfill complete");
  return result;
}

// Mini-copy of the upsertFeature helper from featureEngine.ts. Inlined
// here to avoid an import cycle (clubEloLookup -> featureEngine would
// pull the whole feature pipeline into this module).
async function upsertFeature(matchId: number, name: string, value: number): Promise<void> {
  const rounded = String(Math.round(value * 1_000_000) / 1_000_000);
  const existing = await db
    .select({ id: featuresTable.id })
    .from(featuresTable)
    .where(and(eq(featuresTable.matchId, matchId), eq(featuresTable.featureName, name)))
    .limit(1);
  if (existing.length > 0 && existing[0]) {
    await db
      .update(featuresTable)
      .set({ featureValue: rounded, computedAt: new Date() })
      .where(eq(featuresTable.id, existing[0].id));
  } else {
    await db.insert(featuresTable).values({
      matchId,
      featureName: name,
      featureValue: rounded,
      computedAt: new Date(),
    });
  }
}
