/**
 * Bundle 9 (2026-05-09) — OpenWeatherMap fetch + match_weather persistence.
 *
 * ToS verified in plan mode (plan v3 §0.2): OpenWeatherMap free tier permits
 * commercial use, 1000 calls/day, 60 calls/min, requires VISIBLE attribution
 * "Weather data © OpenWeather" (handled in dashboard footer per §2.D).
 *
 * Three triggers (per plan v3 §2.B):
 *   - cron_t24h: daily 00:00 UTC sweep, fixtures kicking off in next 24h
 *   - cron_t3h:  every 3h sweep, fixtures kicking off in next 6h
 *   - lineup_event: triggered when capturePreKickoffLineups writes _lineup_data
 *                   for a match (T-90 to T-30 typical). Strategic fetch —
 *                   captures compound lineup × weather signal at peak info
 *                   density.
 *
 * Indoor short-circuit: skips fetch entirely when venues.is_indoor=true.
 * No row written. Features absent for the match (the absence IS the signal).
 *
 * Env vars:
 *   - WEATHER_DISABLED: when 'true', service short-circuits (no HTTP call).
 *     Default during initial deploy; flipped to 'false' once self-verification
 *     probes pass post-deploy.
 *   - OPENWEATHER_API_KEY: required for actual API calls. Service no-ops with
 *     warn log if missing.
 *
 * Quota tracking: writes to api_usage with endpoint='openweather_forecast'
 * for parity with existing AF + oddspapi tracking.
 */

import { db, matchesTable, apiUsageTable } from "@workspace/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export type WeatherTrigger = "cron_t24h" | "cron_t3h" | "lineup_event";

export interface WeatherSnapshot {
  kickoff_temp_c: number;
  kickoff_wind_kph: number;
  kickoff_precipitation_mm: number;
  kickoff_humidity_pct: number;
  kickoff_cloud_pct: number;
}

function isWeatherDisabled(): boolean {
  return (process.env["WEATHER_DISABLED"] ?? "true").toLowerCase() === "true";
}

function getApiKey(): string | null {
  const k = process.env["OPENWEATHER_API_KEY"];
  if (!k || k.length < 10) return null;
  return k;
}

async function recordApiUsage(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await db.execute(sql`
      INSERT INTO api_usage (date, endpoint, request_count)
      VALUES (${today}, 'openweather_forecast', 1)
      ON CONFLICT (date, endpoint) DO UPDATE SET request_count = api_usage.request_count + 1
    `);
  } catch (err) {
    logger.warn({ err }, "openweather api_usage tracking failed (non-fatal)");
  }
}

interface OWMForecastResponse {
  list?: Array<{
    dt: number;
    main: { temp: number; humidity: number };
    weather?: Array<{ main: string; description: string }>;
    clouds?: { all: number };
    wind?: { speed: number; deg?: number };
    rain?: { "3h"?: number };
  }>;
}

async function fetchOpenWeatherMapForecast(
  lat: number,
  lon: number,
  kickoffTime: Date,
): Promise<WeatherSnapshot | null> {
  const key = getApiKey();
  if (!key) {
    logger.warn({ lat, lon }, "OPENWEATHER_API_KEY missing — weather fetch skipped");
    return null;
  }

  const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${key}&units=metric`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    await recordApiUsage();

    if (!resp.ok) {
      logger.warn({ status: resp.status, lat, lon }, "OpenWeatherMap non-200");
      return null;
    }
    const json = (await resp.json()) as OWMForecastResponse;
    const buckets = json.list ?? [];
    if (buckets.length === 0) return null;

    // Pick bucket closest to kickoff_time. OWM 5-day forecast resolution is 3h.
    const kickoffMs = kickoffTime.getTime();
    let best = buckets[0]!;
    let bestDelta = Math.abs(best.dt * 1000 - kickoffMs);
    for (const b of buckets) {
      const delta = Math.abs(b.dt * 1000 - kickoffMs);
      if (delta < bestDelta) {
        best = b;
        bestDelta = delta;
      }
    }

    // OWM wind speed is m/s in metric units. Convert to kph: m/s × 3.6.
    const windMs = best.wind?.speed ?? 0;
    const windKph = Math.round(windMs * 3.6 * 10) / 10;
    const precipMm3h = best.rain?.["3h"] ?? 0;
    const precipMmPerHr = Math.round((precipMm3h / 3) * 100) / 100;

    return {
      kickoff_temp_c: Math.round(best.main.temp * 10) / 10,
      kickoff_wind_kph: windKph,
      kickoff_precipitation_mm: precipMmPerHr,
      kickoff_humidity_pct: Math.round(best.main.humidity),
      kickoff_cloud_pct: Math.round(best.clouds?.all ?? 0),
    };
  } catch (err) {
    logger.warn({ err, lat, lon }, "OpenWeatherMap fetch failed");
    return null;
  }
}

interface MatchForFetch {
  id: number;
  venue_api_id: number | null;
  kickoff_time: Date;
  is_indoor: boolean;
  lat: number | null;
  lon: number | null;
}

async function fetchAndStoreWeatherForMatch(
  match: MatchForFetch,
  trigger: WeatherTrigger,
): Promise<{ stored: boolean; skipped: string | null }> {
  if (isWeatherDisabled()) return { stored: false, skipped: "weather_disabled" };
  if (match.is_indoor) return { stored: false, skipped: "indoor" };
  if (match.lat == null || match.lon == null) return { stored: false, skipped: "no_coordinates" };

  const snap = await fetchOpenWeatherMapForecast(match.lat, match.lon, match.kickoff_time);
  if (!snap) return { stored: false, skipped: "fetch_failed" };

  await db.execute(sql`
    INSERT INTO match_weather (
      match_id, fetched_at, trigger_source,
      kickoff_temp_c, kickoff_wind_kph, kickoff_precipitation_mm,
      kickoff_humidity_pct, kickoff_cloud_pct, weather_source
    ) VALUES (
      ${match.id}, NOW(), ${trigger},
      ${snap.kickoff_temp_c}, ${snap.kickoff_wind_kph}, ${snap.kickoff_precipitation_mm},
      ${snap.kickoff_humidity_pct}, ${snap.kickoff_cloud_pct}, 'openweathermap'
    )
    ON CONFLICT (match_id) DO UPDATE SET
      fetched_at = EXCLUDED.fetched_at,
      trigger_source = EXCLUDED.trigger_source,
      kickoff_temp_c = EXCLUDED.kickoff_temp_c,
      kickoff_wind_kph = EXCLUDED.kickoff_wind_kph,
      kickoff_precipitation_mm = EXCLUDED.kickoff_precipitation_mm,
      kickoff_humidity_pct = EXCLUDED.kickoff_humidity_pct,
      kickoff_cloud_pct = EXCLUDED.kickoff_cloud_pct
  `);
  return { stored: true, skipped: null };
}

/**
 * Fetch matches in the trigger's window and refresh weather. Filtered to
 * fixtures with weather-relevant pending bets AND venue lat/lon resolved
 * AND venues.is_indoor=false.
 */
async function findMatchesForTrigger(trigger: WeatherTrigger): Promise<MatchForFetch[]> {
  const windowHours = trigger === "cron_t24h" ? 24 : trigger === "cron_t3h" ? 6 : 0;
  const minHoursAhead = trigger === "cron_t24h" ? 12 : trigger === "cron_t3h" ? 0 : 0;

  // For cron triggers: pull matches with weather-relevant pending bets in the
  // time window. For lineup_event: caller passes a specific matchId.
  if (trigger === "lineup_event") return []; // caller uses refreshForMatch directly

  const result = await db.execute(sql`
    SELECT DISTINCT m.id, m.venue_api_id, m.kickoff_time,
      v.is_indoor, v.lat::float8 AS lat, v.lon::float8 AS lon
    FROM matches m
    LEFT JOIN venues v ON v.api_venue_id = m.venue_api_id
    JOIN paper_bets pb ON pb.match_id = m.id
    WHERE pb.status = 'pending'
      AND pb.deleted_at IS NULL
      AND pb.market_type IN (
        'BTTS','OVER_UNDER_25','OVER_UNDER_35','ASIAN_TOTAL_GOALS',
        'TEAM_TOTAL_HOME_05','TEAM_TOTAL_HOME_15','TEAM_TOTAL_HOME_25',
        'TEAM_TOTAL_AWAY_05','TEAM_TOTAL_AWAY_15','TEAM_TOTAL_AWAY_25',
        'TOTAL_CARDS_25','TOTAL_CARDS_35'
      )
      AND m.kickoff_time BETWEEN NOW() + INTERVAL '${sql.raw(String(minHoursAhead))} hours'
                             AND NOW() + INTERVAL '${sql.raw(String(windowHours))} hours'
      AND m.venue_api_id IS NOT NULL
      AND v.is_indoor = false
      AND v.lat IS NOT NULL
      AND v.lon IS NOT NULL
  `);
  return ((result as { rows?: MatchForFetch[] }).rows ?? []).map((r) => ({
    id: Number(r.id),
    venue_api_id: r.venue_api_id == null ? null : Number(r.venue_api_id),
    kickoff_time: new Date(r.kickoff_time),
    is_indoor: Boolean(r.is_indoor),
    lat: r.lat == null ? null : Number(r.lat),
    lon: r.lon == null ? null : Number(r.lon),
  }));
}

export async function runWeatherCron(trigger: WeatherTrigger): Promise<{
  evaluated: number;
  stored: number;
  skipped: Record<string, number>;
}> {
  if (isWeatherDisabled()) {
    return { evaluated: 0, stored: 0, skipped: { weather_disabled: 1 } };
  }

  const matches = await findMatchesForTrigger(trigger);
  let stored = 0;
  const skipped: Record<string, number> = {};
  for (const match of matches) {
    // For T-3h trigger: skip if last fetch was within 2h (avoid wasted quota
    // on near-duplicate fetches). T-24h always refreshes.
    if (trigger === "cron_t3h") {
      const recent = await db.execute(sql`
        SELECT 1 FROM match_weather
        WHERE match_id = ${match.id} AND fetched_at > NOW() - INTERVAL '2 hours'
        LIMIT 1
      `);
      if (((recent as { rows?: unknown[] }).rows ?? []).length > 0) {
        skipped["recently_fetched"] = (skipped["recently_fetched"] ?? 0) + 1;
        continue;
      }
    }

    const { stored: ok, skipped: reason } = await fetchAndStoreWeatherForMatch(match, trigger);
    if (ok) stored++;
    else if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
  }
  logger.info({ trigger, evaluated: matches.length, stored, skipped }, "Weather cron complete");
  return { evaluated: matches.length, stored, skipped };
}

/**
 * Lineup-event trigger. Called from capturePreKickoffLineups (apiFootball.ts)
 * when a match's lineup is first captured. Fetches the latest forecast and
 * tags trigger_source='lineup_event' — the strategic peak-info-density fetch.
 */
export async function refreshForMatch(matchId: number): Promise<{ stored: boolean; skipped: string | null }> {
  if (isWeatherDisabled()) return { stored: false, skipped: "weather_disabled" };

  const result = await db.execute(sql`
    SELECT m.id, m.venue_api_id, m.kickoff_time,
      v.is_indoor, v.lat::float8 AS lat, v.lon::float8 AS lon
    FROM matches m
    LEFT JOIN venues v ON v.api_venue_id = m.venue_api_id
    WHERE m.id = ${matchId} AND m.venue_api_id IS NOT NULL
    LIMIT 1
  `);
  const row = ((result as { rows?: MatchForFetch[] }).rows ?? [])[0];
  if (!row) return { stored: false, skipped: "match_or_venue_not_found" };

  return fetchAndStoreWeatherForMatch(
    {
      id: Number(row.id),
      venue_api_id: row.venue_api_id == null ? null : Number(row.venue_api_id),
      kickoff_time: new Date(row.kickoff_time),
      is_indoor: Boolean(row.is_indoor),
      lat: row.lat == null ? null : Number(row.lat),
      lon: row.lon == null ? null : Number(row.lon),
    },
    "lineup_event",
  );
}
