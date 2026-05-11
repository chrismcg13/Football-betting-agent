/**
 * Phase 4b.2 (2026-05-11) — venue_api_id backfill for matches that
 * already have their API-Football fixture ID cached but never had
 * venue captured (the upstream lineup-arrival path only fires close
 * to kickoff for some headline leagues, leaving ~99.8% of historical
 * matches with venue_api_id NULL).
 *
 * Strategy:
 *   1. SELECT matches with _af_fixture_id present AND venue_api_id NULL
 *   2. Batch fixture IDs (20 per call — the AF /fixtures?ids=a-b-c limit)
 *   3. For each batch, fetch via fetchFixturesByIds (priority: false so we
 *      don't crowd live-trading windows)
 *   4. Extract fixture.venue and call captureVenueFromFixture
 *
 * Cost: ~4,750 matches × 1 fixture per call / 20 batch = ~240 API calls
 * for a full backfill. Capped per run at MAX_MATCHES_PER_RUN so a single
 * cron tick stays comfortably under the per-hour budget.
 *
 * Unlocks the dormant travel-distance / stadium-altitude features
 * (Task 19) which previously had near-zero input.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { fetchFixturesByIds } from "./apiFootball";
import { captureVenueFromFixture } from "./venueIngestionService";

const MAX_MATCHES_PER_RUN = 400;
const BATCH = 20;

export interface VenueIdBackfillResult {
  candidates: number;
  fixturesFetched: number;
  venuesCaptured: number;
  errors: number;
  durationMs: number;
}

export async function runVenueIdBackfill(): Promise<VenueIdBackfillResult> {
  const startedAt = Date.now();
  const result: VenueIdBackfillResult = {
    candidates: 0,
    fixturesFetched: 0,
    venuesCaptured: 0,
    errors: 0,
    durationMs: 0,
  };

  // Find candidates: matches lacking venue_api_id but with a cached AF
  // fixture ID. Order by kickoff_time DESC to prioritise recent matches
  // (their venue is most relevant for upcoming-bet feature engineering).
  const rows = await db.execute(sql`
    SELECT m.id::int AS match_id,
           f.feature_value AS fixture_id_str
    FROM matches m
    JOIN features f
      ON f.match_id = m.id AND f.feature_name = '_af_fixture_id'
    WHERE m.venue_api_id IS NULL
      AND f.feature_value ~ '^[0-9]+$'
    ORDER BY m.kickoff_time DESC NULLS LAST
    LIMIT ${MAX_MATCHES_PER_RUN}
  `);
  const candidates = (((rows as unknown) as { rows?: Array<{
    match_id: number;
    fixture_id_str: string;
  }> }).rows ?? []);
  result.candidates = candidates.length;
  if (candidates.length === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // Build the (fixtureId → matchId[]) reverse map so we know which
  // match(es) to update from each fetched fixture. A given fixtureId
  // should map to one match, but accept the array shape defensively.
  const fixtureToMatches = new Map<number, number[]>();
  const fixtureIds: number[] = [];
  for (const c of candidates) {
    const fid = Number.parseInt(c.fixture_id_str, 10);
    if (!Number.isFinite(fid)) continue;
    fixtureIds.push(fid);
    const arr = fixtureToMatches.get(fid) ?? [];
    arr.push(c.match_id);
    fixtureToMatches.set(fid, arr);
  }

  // Fetch fixtures in 20-at-a-time batches (fetchFixturesByIds handles
  // the batching internally — pass the full array).
  let fetched: Awaited<ReturnType<typeof fetchFixturesByIds>> = [];
  try {
    fetched = await fetchFixturesByIds(fixtureIds, { priority: false });
  } catch (err) {
    logger.warn({ err, requested: fixtureIds.length },
      "venueIdBackfill: fetchFixturesByIds threw");
    result.errors += 1;
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  result.fixturesFetched = fetched.length;

  for (const fx of fetched) {
    const venue = fx.fixture?.venue;
    if (!venue?.id) continue;
    const matchIds = fixtureToMatches.get(fx.fixture.id) ?? [];
    for (const matchId of matchIds) {
      try {
        await captureVenueFromFixture(matchId, venue, fx.league?.country ?? null);
        result.venuesCaptured += 1;
      } catch (err) {
        logger.warn({ err, matchId, fixtureId: fx.fixture.id },
          "venueIdBackfill: captureVenueFromFixture failed");
        result.errors += 1;
      }
    }
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(result, "venue_api_id backfill complete");
  return result;
}

