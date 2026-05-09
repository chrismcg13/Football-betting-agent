/**
 * Bundle 9 (2026-05-09) — Venue ingestion + Wikipedia classification + Nominatim geocoding.
 *
 * Two-phase per venue:
 *   Phase A: capture from AF /fixtures (ID + name + city + country) — runs as
 *            part of upcoming-fixtures cron, populates matches.venue_api_id
 *            and seeds the venues row with NULLs in lat/lon/classified_at.
 *   Phase B: enrich (lat/lon via Nominatim + classification via Wikipedia) —
 *            runs as a separate daily cron via runVenueEnrichmentCron.
 *
 * Phase B is idempotent: WHERE classified_at IS NULL OR geocoded_at IS NULL.
 * Re-running on already-enriched venues is a no-op.
 *
 * Manual override: operator can set is_indoor / lat / lon directly via SQL
 * UPDATE; classification_source='manual_override' / geocoding_source='manual_override'
 * tells the auto-classifier to skip on subsequent runs.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { classifyVenueByWikipedia } from "./venueClassifierService";
import { geocodeStadium } from "./venueGeocoder";

interface AfFixtureVenue {
  id?: number | null;
  name?: string | null;
  city?: string | null;
}

/**
 * Phase A: extract venue info from an AF /fixtures response and persist.
 * Called from existing fixture ingestion paths in apiFootball.ts.
 */
export async function captureVenueFromFixture(
  matchId: number,
  fixtureVenue: AfFixtureVenue | null | undefined,
  country: string | null,
): Promise<void> {
  if (!fixtureVenue?.id) return;

  const apiVenueId = Number(fixtureVenue.id);
  if (!Number.isFinite(apiVenueId)) return;

  // Upsert venue row (insert minimal info, don't overwrite enrichment).
  try {
    await db.execute(sql`
      INSERT INTO venues (api_venue_id, venue_name, city, country)
      VALUES (${apiVenueId}, ${fixtureVenue.name ?? null}, ${fixtureVenue.city ?? null}, ${country})
      ON CONFLICT (api_venue_id) DO UPDATE SET
        venue_name = COALESCE(venues.venue_name, EXCLUDED.venue_name),
        city = COALESCE(venues.city, EXCLUDED.city),
        country = COALESCE(venues.country, EXCLUDED.country)
    `);

    // Set venue_api_id back-reference on matches (idempotent).
    await db.execute(sql`
      UPDATE matches SET venue_api_id = ${apiVenueId}
      WHERE id = ${matchId} AND (venue_api_id IS NULL OR venue_api_id != ${apiVenueId})
    `);
  } catch (err) {
    logger.warn({ err, matchId, apiVenueId }, "Venue capture failed (non-fatal)");
  }
}

interface VenueEnrichmentRow {
  api_venue_id: number;
  venue_name: string | null;
  city: string | null;
  country: string | null;
  needs_geocode: boolean;
  needs_classify: boolean;
}

/**
 * Phase B: daily cron. Find venues missing lat/lon or classification, enrich.
 * Rate-limited per Wikipedia + Nominatim usage policies (~1 req/sec each).
 *
 * Budget: at start, ~300 venues to enrich (~5 minutes). Steady-state: a few
 * new venues per day as new leagues / teams ingest.
 */
export async function runVenueEnrichmentCron(): Promise<{
  geocoded: number;
  classified: number;
  unknown: number;
  errors: number;
}> {
  const result = await db.execute(sql`
    SELECT api_venue_id::int, venue_name, city, country,
      (lat IS NULL AND geocoding_source IS DISTINCT FROM 'manual_override') AS needs_geocode,
      (classified_at IS NULL AND classification_source IS DISTINCT FROM 'manual_override') AS needs_classify
    FROM venues
    WHERE (lat IS NULL AND geocoding_source IS DISTINCT FROM 'manual_override')
       OR (classified_at IS NULL AND classification_source IS DISTINCT FROM 'manual_override')
    ORDER BY api_venue_id
    LIMIT 500
  `);
  const rows = ((result as { rows?: VenueEnrichmentRow[] }).rows ?? []) as VenueEnrichmentRow[];
  let geocoded = 0;
  let classified = 0;
  let unknown = 0;
  let errors = 0;

  for (const v of rows) {
    if (!v.venue_name) {
      // Mark classified as unknown so we don't keep retrying empty venues.
      try {
        await db.execute(sql`
          UPDATE venues SET classified_at = NOW(), classification_source = 'unknown'
          WHERE api_venue_id = ${v.api_venue_id}
        `);
      } catch (err) {
        errors++;
      }
      continue;
    }

    // Geocoding
    if (v.needs_geocode) {
      try {
        const g = await geocodeStadium(v.venue_name, v.city, v.country);
        if (g) {
          await db.execute(sql`
            UPDATE venues SET lat = ${g.lat}, lon = ${g.lon}, geocoded_at = NOW(), geocoding_source = ${g.source}
            WHERE api_venue_id = ${v.api_venue_id}
          `);
          geocoded++;
        } else {
          // Mark geocode-attempted with NULL lat/lon to avoid re-attempting today.
          await db.execute(sql`
            UPDATE venues SET geocoded_at = NOW(), geocoding_source = 'nominatim_failed'
            WHERE api_venue_id = ${v.api_venue_id}
          `);
        }
      } catch (err) {
        logger.warn({ err, venue: v.venue_name }, "Geocode error");
        errors++;
      }
    }

    // Classification
    if (v.needs_classify) {
      try {
        const c = await classifyVenueByWikipedia(v.venue_name, v.country);
        await db.execute(sql`
          UPDATE venues SET
            is_indoor = ${c.is_indoor},
            is_retractable = ${c.is_retractable},
            classification_text = ${c.classification_text},
            wikipedia_url = ${c.wikipedia_url},
            classified_at = NOW(),
            classification_source = ${c.classification_source}
          WHERE api_venue_id = ${v.api_venue_id}
        `);
        if (c.classification_source === "wikipedia_auto") classified++;
        else unknown++;
      } catch (err) {
        logger.warn({ err, venue: v.venue_name }, "Classification error");
        errors++;
      }
    }
  }

  logger.info({ geocoded, classified, unknown, errors, evaluated: rows.length }, "Venue enrichment cron complete");
  return { geocoded, classified, unknown, errors };
}
