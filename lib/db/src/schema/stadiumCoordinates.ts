import {
  pgTable,
  integer,
  text,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Task 19 — stadium coordinates for travel/altitude/timezone features.
 *
 * Keyed on matches.venue_api_id (the API-Football venue id, already
 * stored on every match row). One row per venue. Backfilled by
 * stadiumGeocoder via OSM Nominatim — free, rate-limited at 1 req/s,
 * polite use only.
 *
 * Altitude is best-effort: Open-Elevation API fills in when available;
 * otherwise NULL. Timezone is the IANA name derived from lat/lon via
 * @vvo/tzdb (not yet wired — defaults to NULL for first ship).
 */
export const stadiumCoordinatesTable = pgTable("stadium_coordinates", {
  venueApiId: integer("venue_api_id").primaryKey(),
  stadiumName: text("stadium_name"),
  city: text("city"),
  country: text("country"),
  lat: numeric("lat", { precision: 10, scale: 6 }),
  lon: numeric("lon", { precision: 10, scale: 6 }),
  altitudeM: numeric("altitude_m", { precision: 8, scale: 1 }),
  timezoneIana: text("timezone_iana"),
  source: text("source"), // 'nominatim' | 'manual' | 'wikipedia' | 'fallback'
  geocodedAt: timestamp("geocoded_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StadiumCoordinate = typeof stadiumCoordinatesTable.$inferSelect;
