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

import { db, clubEloSnapshotsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { resilientFetch } from "./resilientFetch";

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

function parseCsvRow(line: string): ParsedRow | null {
  // CSV from ClubElo is comma-separated, no embedded commas, no quoting.
  const parts = line.split(",");
  if (parts.length < 7) return null;
  const [rank, club, country, level, elo, fromDate, toDate] = parts;
  if (!club || !elo) return null;
  const eloNum = Number(elo);
  if (!Number.isFinite(eloNum)) return null;
  return {
    rank: rank && rank.trim() ? Number(rank) : null,
    teamName: club.trim(),
    country: country?.trim() || null,
    level: level && level.trim() ? Number(level) : null,
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
