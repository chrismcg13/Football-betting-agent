/**
 * Task 19 — stadium-coordinate geocoder + travel feature backfill.
 *
 * Geocodes football venues via OSM Nominatim (free public API, rate-
 * limited 1 req/s). Persists to stadium_coordinates keyed on
 * matches.venue_api_id so repeat lookups are free.
 *
 * Then computes per-upcoming-match shadow features:
 *   - away_travel_km — great-circle distance between the away team's
 *     home stadium (its most-recent home match's venue) and the
 *     current match's venue.
 *
 * Altitude + timezone are stubbed for now; Open-Elevation integration
 * + @vvo/tzdb lookup are follow-up PRs. Shadow features only —
 * NOT yet in FEATURE_NAMES.
 *
 * Empirical anchors (from the plan):
 *   - Beckmann 2022: Bundesliga away goals-conceded scales with travel.
 *   - McSharry 2008 BMJ: +1000m altitude diff ≈ +0.5 goal home advantage.
 *   - Verheijen (Bundesliga): <96h rest → ~40% less likely to win.
 */

import { db, matchesTable, stadiumCoordinatesTable, featuresTable } from "@workspace/db";
import { and, eq, gte, lte, isNotNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "BetAgentOS/1.0 (research; chris.mcg@hotmail.co.uk)";
const NOMINATIM_RATE_LIMIT_MS = 1100; // 1 req/s per usage policy + buffer

let lastNominatimCall = 0;

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
  type?: string;
  importance?: number;
}

async function geocodeVenue(stadiumName: string | null, city: string | null, country: string | null): Promise<{
  lat: number | null;
  lon: number | null;
  source: string;
} | null> {
  if (!stadiumName && !city) return null;

  const queryParts = [stadiumName, city, country].filter(Boolean) as string[];
  if (queryParts.length === 0) return null;

  // Rate-limit: pad to 1.1s between calls
  const wait = lastNominatimCall + NOMINATIM_RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();

  const params = new URLSearchParams({
    q: queryParts.join(", "),
    format: "json",
    limit: "1",
    addressdetails: "0",
  });
  const url = `${NOMINATIM_URL}?${params}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, query: queryParts.join(", ") }, "Nominatim non-OK");
      return null;
    }
    const hits = (await res.json()) as NominatimHit[];
    if (!hits || hits.length === 0) return null;
    const lat = Number(hits[0]!.lat);
    const lon = Number(hits[0]!.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, source: "nominatim" };
  } catch (err) {
    logger.debug({ err, query: queryParts.join(", ") }, "Nominatim fetch failed");
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Geocode any new venue_api_ids appearing in matches. Caps batch size
 * to keep within polite Nominatim use; runs every 6h via cron and
 * drains the backlog over multiple ticks.
 */
export async function runStadiumGeocodeBackfill(opts: { maxPerRun?: number } = {}): Promise<{
  candidates: number;
  geocoded: number;
  failed: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const maxPerRun = opts.maxPerRun ?? 50;
  const result = { candidates: 0, geocoded: 0, failed: 0, durationMs: 0 };

  // Find distinct venue_api_ids in matches that DON'T have a stadium_coordinates row.
  const candidates = await db.execute(sql`
    SELECT DISTINCT m.venue_api_id,
                    -- pick any one stadium name + city for the venue (they
                    -- should be consistent across matches with the same id)
                    (array_agg(m.country) FILTER (WHERE m.country IS NOT NULL))[1] AS country
    FROM matches m
    WHERE m.venue_api_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM stadium_coordinates sc WHERE sc.venue_api_id = m.venue_api_id
      )
    GROUP BY m.venue_api_id
    LIMIT ${maxPerRun}
  `);
  const rows = (((candidates as unknown) as { rows?: Array<{ venue_api_id: number; country: string | null }> }).rows ?? []);
  result.candidates = rows.length;

  if (rows.length === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // We don't have venue name on hand from `matches` (only venue_api_id),
  // so geocode using country only + a generic "stadium" hint. This is
  // a crude first pass — a follow-up PR can read api-football's venues
  // endpoint to get the stadium name + city per venue_api_id.
  for (const row of rows) {
    // Skip if no country (impossible to geocode meaningfully).
    if (!row.country) {
      result.failed++;
      continue;
    }
    const hit = await geocodeVenue(null, null, row.country);
    if (!hit) {
      // Persist a placeholder row so we don't retry the same venue
      // every cycle. source='fallback' marks it for later re-geocoding
      // when richer venue data is available.
      await db.insert(stadiumCoordinatesTable).values({
        venueApiId: row.venue_api_id,
        country: row.country,
        source: "fallback",
      }).onConflictDoNothing();
      result.failed++;
      continue;
    }
    await db.insert(stadiumCoordinatesTable).values({
      venueApiId: row.venue_api_id,
      country: row.country,
      lat: String(hit.lat),
      lon: String(hit.lon),
      source: hit.source,
    }).onConflictDoNothing();
    result.geocoded++;
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(result, "Stadium geocode backfill complete");
  return result;
}

/** Great-circle (Haversine) distance in km between two lat/lon pairs. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Backfill away_travel_km for upcoming matches.
 *
 * For each upcoming match:
 *   1. Look up the match's venue coordinates
 *   2. Find the away team's most-recent home match (in matches table)
 *   3. Look up that venue's coordinates
 *   4. Compute Haversine distance, upsert as away_travel_km feature
 *
 * Skips when either venue lacks coordinates. Idempotent.
 */
export async function runTravelFeatureBackfill(): Promise<{
  upcoming: number;
  resolved: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const now = new Date();
  const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Pull upcoming matches that have venue coords.
  const upcoming = await db.execute(sql`
    SELECT m.id, m.away_team, m.kickoff_time,
           sc.lat::float8 AS venue_lat, sc.lon::float8 AS venue_lon
    FROM matches m
    JOIN stadium_coordinates sc ON sc.venue_api_id = m.venue_api_id
    WHERE m.status='scheduled'
      AND m.kickoff_time BETWEEN ${now} AND ${until}
      AND sc.lat IS NOT NULL
      AND sc.lon IS NOT NULL
    LIMIT 1000
  `);

  const rows = (((upcoming as unknown) as {
    rows?: Array<{ id: number; away_team: string; kickoff_time: string;
                   venue_lat: number | null; venue_lon: number | null }>;
  }).rows ?? []);
  const result = { upcoming: rows.length, resolved: 0, durationMs: 0 };

  for (const row of rows) {
    if (row.venue_lat == null || row.venue_lon == null) continue;

    // Find the away team's most recent home venue with coords.
    const homeVenue = await db.execute(sql`
      SELECT sc.lat::float8 AS lat, sc.lon::float8 AS lon
      FROM matches m
      JOIN stadium_coordinates sc ON sc.venue_api_id = m.venue_api_id
      WHERE m.home_team = ${row.away_team}
        AND m.kickoff_time < ${row.kickoff_time}
        AND sc.lat IS NOT NULL
        AND sc.lon IS NOT NULL
      ORDER BY m.kickoff_time DESC
      LIMIT 1
    `);
    const homeRows = (((homeVenue as unknown) as { rows?: Array<{ lat: number; lon: number }> }).rows ?? []);
    if (homeRows.length === 0) continue;
    const home = homeRows[0]!;
    const distance = haversineKm(home.lat, home.lon, row.venue_lat, row.venue_lon);
    const rounded = Math.round(distance * 100) / 100;

    // Upsert the feature.
    const existing = await db
      .select({ id: featuresTable.id })
      .from(featuresTable)
      .where(and(eq(featuresTable.matchId, row.id), eq(featuresTable.featureName, "away_travel_km")))
      .limit(1);
    if (existing.length > 0 && existing[0]) {
      await db.update(featuresTable)
        .set({ featureValue: String(rounded), computedAt: new Date() })
        .where(eq(featuresTable.id, existing[0].id));
    } else {
      await db.insert(featuresTable).values({
        matchId: row.id,
        featureName: "away_travel_km",
        featureValue: String(rounded),
        computedAt: new Date(),
      });
    }
    result.resolved++;
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(result, "Travel feature backfill complete");
  return result;
}
