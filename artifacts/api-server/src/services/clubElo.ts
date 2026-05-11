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
import {
  getClubEloForTeam,
  getClubEloForTeamAtDate,
  invalidateClubEloCaches,
} from "./clubEloLookup";

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

/**
 * Phase 4a.3 — historical Elo backfill for settled matches that lack
 * the new home_clubelo / away_clubelo / elo_diff features. Drives the
 * retraining surface: until settled matches have real Elo, training
 * uses ELO_BASELINE (1500) imputation and Elo coefficients converge to
 * zero. This job walks distinct kickoff dates, fetches the ClubElo
 * daily snapshot for each (idempotent — composite PK), then resolves
 * each match's home + away team against the date-specific snapshot.
 *
 * Rate-limited at ~1 fetch/s on ClubElo to stay within hobbyist usage.
 * Caps to MAX_DATES_PER_RUN to bound a single cron invocation; the cron
 * runs every 6h so coverage builds up over a day or two.
 *
 * Lookup order:
 *  1. Find distinct kickoff dates (UTC) that have settled matches with
 *     no home_clubelo feature row.
 *  2. For each date, ensure club_elo_snapshots has rows for that date
 *     (fetch + upsert if not).
 *  3. For each match on that date, resolve home/away against the
 *     date-specific snapshot and upsert the three feature rows.
 */
export interface HistoricalBackfillResult {
  dates_scanned: number;
  dates_fetched: number;
  matches_resolved: number;
  features_written: number;
  durationMs: number;
}

const MAX_DATES_PER_RUN = 10;
const FETCH_DELAY_MS = 1000;

export async function runClubEloHistoricalBackfill(): Promise<HistoricalBackfillResult> {
  const startedAt = Date.now();
  const result: HistoricalBackfillResult = {
    dates_scanned: 0,
    dates_fetched: 0,
    matches_resolved: 0,
    features_written: 0,
    durationMs: 0,
  };

  // Find settled matches that have a final score but no home_clubelo.
  // ORDER BY date ASC so historical-ingest progresses chronologically.
  const datesResult = await db.execute(sql`
    SELECT DISTINCT (kickoff_time AT TIME ZONE 'UTC')::date AS d
    FROM matches m
    WHERE home_score IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM features f
        WHERE f.match_id = m.id AND f.feature_name = 'home_clubelo'
      )
    ORDER BY d ASC
    LIMIT ${MAX_DATES_PER_RUN}
  `);
  const dates = (((datesResult as unknown) as { rows?: Array<{ d: string }> }).rows ?? [])
    .map((r) => (typeof r.d === "string" ? r.d.slice(0, 10) : new Date(r.d).toISOString().slice(0, 10)));

  result.dates_scanned = dates.length;
  if (dates.length === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  for (const dateIso of dates) {
    // Ensure we have a snapshot for this date. Idempotent — if the
    // row already exists (e.g. from a prior daily ingestion) the
    // upsert is a no-op.
    const probe = await db.execute(sql`
      SELECT 1 AS present FROM club_elo_snapshots WHERE date = ${dateIso}::date LIMIT 1
    `);
    const present = ((probe as unknown) as { rows?: unknown[] }).rows?.length ?? 0;
    if (!present) {
      // Sleep briefly between fetches to be a polite ClubElo client.
      if (result.dates_fetched > 0) {
        await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
      }
      try {
        await runClubEloIngestion({ dateOverride: dateIso });
        result.dates_fetched += 1;
      } catch (err) {
        logger.warn({ err, dateIso }, "Historical ClubElo ingestion failed — skipping date");
        continue;
      }
    }

    // Refresh the date-specific candidate cache (in case the ingestion
    // just populated it). Cheap.
    invalidateClubEloCaches();

    // Pull all settled matches on this date that still need Elo.
    const matchRows = await db.execute(sql`
      SELECT m.id, m.home_team AS home_team, m.away_team AS away_team
      FROM matches m
      WHERE (kickoff_time AT TIME ZONE 'UTC')::date = ${dateIso}::date
        AND home_score IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM features f
          WHERE f.match_id = m.id AND f.feature_name = 'home_clubelo'
        )
    `);
    const matches = (((matchRows as unknown) as { rows?: Array<{
      id: number;
      home_team: string;
      away_team: string;
    }> }).rows ?? []);

    for (const m of matches) {
      const homeRes = await getClubEloForTeamAtDate(m.home_team, dateIso);
      const awayRes = await getClubEloForTeamAtDate(m.away_team, dateIso);
      if (homeRes.elo != null) {
        await upsertFeature(m.id, "home_clubelo", homeRes.elo);
        result.features_written += 1;
      }
      if (awayRes.elo != null) {
        await upsertFeature(m.id, "away_clubelo", awayRes.elo);
        result.features_written += 1;
      }
      if (homeRes.elo != null && awayRes.elo != null) {
        await upsertFeature(m.id, "elo_diff", homeRes.elo - awayRes.elo);
        result.features_written += 1;
        result.matches_resolved += 1;
      }
    }
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(result, "ClubElo historical backfill complete");
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
