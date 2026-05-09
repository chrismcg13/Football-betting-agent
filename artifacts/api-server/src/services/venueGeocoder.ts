/**
 * Bundle 9 (2026-05-09) — Nominatim geocoder for stadium lat/lon.
 *
 * AF /venues returns city/country but NOT lat/lon. Nominatim (OpenStreetMap's
 * geocoder) is free with no API key, fair-use rate-limited at 1 req/sec.
 * One-shot per venue, cached forever in venues.lat/lon.
 *
 * Per Nominatim usage policy: requires a meaningful User-Agent. Failure
 * tolerated — venue with NULL lat/lon results in weatherService skipping
 * fetch (feature absent rather than zero).
 */

import { logger } from "../lib/logger";

const NOMINATIM_USER_AGENT = "FootballBettingAgent/1.0 (research; non-distributed; contact: chris.mcg@hotmail.co.uk)";

export interface GeocodeResult {
  lat: number;
  lon: number;
  source: "nominatim";
}

let lastNominatimCallMs = 0;
async function rateLimit(minIntervalMs = 1100): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastNominatimCallMs;
  if (elapsed < minIntervalMs) await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
  lastNominatimCallMs = Date.now();
}

export async function geocodeStadium(
  venueName: string,
  city: string | null,
  country: string | null,
): Promise<GeocodeResult | null> {
  // Try queries in order of specificity: venue+city+country, venue+country,
  // city+country (last resort — country-level only).
  const queries: string[] = [];
  if (city && country) queries.push(`${venueName}, ${city}, ${country}`);
  if (country) queries.push(`${venueName}, ${country}`);
  if (city && country) queries.push(`${city}, ${country}`);
  queries.push(venueName);

  for (const q of queries) {
    await rateLimit();
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": NOMINATIM_USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        logger.warn({ status: resp.status, query: q }, "Nominatim non-200");
        continue;
      }
      const json = (await resp.json()) as Array<{ lat?: string; lon?: string }>;
      const hit = json[0];
      if (!hit?.lat || !hit?.lon) continue;
      const lat = parseFloat(hit.lat);
      const lon = parseFloat(hit.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      return { lat: Math.round(lat * 100000) / 100000, lon: Math.round(lon * 100000) / 100000, source: "nominatim" };
    } catch (err) {
      logger.warn({ err, query: q }, "Nominatim fetch failed");
    }
  }

  return null;
}
