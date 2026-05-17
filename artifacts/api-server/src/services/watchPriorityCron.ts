/**
 * Bundle 7.0 — Stage 0 watch-priority cron (2026-05-17)
 *
 * Every 5 minutes (registered in startScheduler), iterates every active
 * (fixture × market_type) pair in the universe and writes a row to
 * watch_priority_history with the computed score + tier. Components are
 * fetched in bulk to keep query count flat — 5 lookup queries total,
 * not 5 per fixture.
 *
 * "Active" = match.kickoff_time within [NOW - 1h, NOW + 7 days]. The
 * 1h grace catches in-flight matches (rare for our markets but
 * defensive). The 7-day horizon matches API-Football discovery window.
 *
 * Market-type universe per fixture comes from league_market_catalogue
 * (derived from historical pinnacle_odds_snapshots). Fixtures in leagues
 * with no catalogue rows get only MATCH_ODDS as a default candidate
 * (every Pinnacle-covered league prices MO).
 *
 * History retention: a companion daily cron drops rows older than
 * agent_config.watch_priority_history_retention_days (default 7).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  readWatchConfig,
  computeWatchPriorityScore,
  assignTier,
  clvYieldScore,
  edgeDensityScore,
  liquidityScoreFromVolume,
  releaseProximityScore,
  ttkScoreFromHours,
  type WatchScoreComponents,
} from "./watchPriority";

interface ActiveFixtureRow {
  fixture_id: number;
  league: string | null;
  market_type: string;
  hours_to_kickoff: number;
}

interface LiquiditySnapshotRow {
  match_id: number;
  market_type: string;
  total_market_volume: number | null;
}

interface ScopeClvRow {
  league: string;
  market_type: string;
  ttk_bucket: string;
  stake_weighted_clv_pct: number | null;
}

interface ScopeEdgeDensityRow {
  league: string;
  market_type: string;
  ttk_bucket: string;
  density_score: number | null;
}

interface ScopeReleaseTimingRow {
  league: string;
  market_type: string;
  median_hours_to_kickoff: number | null;
}

interface ModelOppRow {
  match_id: number;
  market_type: string;
  opportunity_score: number;
}

function ttkBucket(hoursToKickoff: number): "0_1h" | "1_6h" | "6_24h" | "24h_plus" {
  if (hoursToKickoff < 1) return "0_1h";
  if (hoursToKickoff < 6) return "1_6h";
  if (hoursToKickoff < 24) return "6_24h";
  return "24h_plus";
}

function sharpCountTierFromContext(): number {
  // Stage 0 doesn't know sharp count without firing the multi-book reader
  // for every fixture (expensive). We tag sharp_count_tier=null and let
  // the post-bet aggregator infer it from compliance_logs when the bet
  // actually fires. Stored as null in history rows.
  return 0;
}

export interface WatchPriorityCronResult {
  evaluated_at: string;
  fixtures_evaluated: number;
  rows_written: number;
  tier_counts: { tier1: number; tier2: number; tier3: number; tier4: number };
  errors: number;
}

export async function runWatchPriorityCron(): Promise<WatchPriorityCronResult> {
  const result: WatchPriorityCronResult = {
    evaluated_at: new Date().toISOString(),
    fixtures_evaluated: 0,
    rows_written: 0,
    tier_counts: { tier1: 0, tier2: 0, tier3: 0, tier4: 0 },
    errors: 0,
  };

  const { weights, thresholds } = await readWatchConfig();

  // Pull every (fixture × likely_market_type) in the active window.
  // Cross-join with league_market_catalogue gives us the catalogue;
  // matches without a league_id catalogue row fall back to MATCH_ODDS.
  let activeRows: ActiveFixtureRow[] = [];
  try {
    const r = await db.execute(sql`
      WITH active AS (
        SELECT
          m.id AS fixture_id,
          m.league,
          m.league_id,
          EXTRACT(EPOCH FROM (m.kickoff_time - NOW())) / 3600.0 AS hours_to_kickoff
        FROM matches m
        WHERE m.kickoff_time IS NOT NULL
          AND m.kickoff_time >= NOW() - INTERVAL '1 hour'
          AND m.kickoff_time <= NOW() + INTERVAL '7 days'
          AND m.deleted_at IS NULL
      )
      SELECT
        a.fixture_id,
        a.league,
        COALESCE(c.market_type, 'MATCH_ODDS') AS market_type,
        a.hours_to_kickoff::float8 AS hours_to_kickoff
      FROM active a
      LEFT JOIN league_market_catalogue c
        ON c.league_id = a.league_id AND c.sample_count >= 5
    `);
    activeRows = ((r as any).rows ?? []) as ActiveFixtureRow[];
  } catch (err) {
    // Migration race or schema drift — log and exit cleanly. The cron
    // retries in 5 min.
    logger.warn({ err }, "watchPriorityCron: active-fixtures query failed");
    result.errors++;
    return result;
  }

  if (activeRows.length === 0) return result;
  result.fixtures_evaluated = activeRows.length;

  // Bulk-fetch component inputs. Each is a small lookup table keyed by
  // (league, market_type, ttk_bucket) or (match_id, market_type).
  const [edgeDensity, clvRolling, releaseTiming, liquidity, modelOpp] =
    await Promise.all([
      fetchEdgeDensity(),
      fetchClvRolling(),
      fetchReleaseTiming(),
      fetchLatestLiquidity(),
      fetchLatestModelOpp(),
    ]);

  // Iterate + write. Batch into bulk INSERT to keep round-trips low.
  const rowsToInsert: Array<{
    fixture_id: number;
    market_type: string;
    score: number;
    base: number;
    boost: number;
    tier: 1 | 2 | 3 | 4;
    components: WatchScoreComponents;
    ttk_bucket: string;
  }> = [];

  for (const row of activeRows) {
    const ttk = ttkBucket(row.hours_to_kickoff);
    const league = row.league ?? "";
    const scopeKey = `${league}|${row.market_type}|${ttk}`;
    const scopeKeyNoTtk = `${league}|${row.market_type}`;

    const components: WatchScoreComponents = {
      edge_density_score: edgeDensityScore(edgeDensity.get(scopeKey) ?? null),
      release_proximity_score: releaseProximityScore(
        row.hours_to_kickoff,
        releaseTiming.get(scopeKeyNoTtk) ?? 48, // 48h fallback when no historical data
      ),
      liquidity_score: liquidityScoreFromVolume(
        liquidity.get(`${row.fixture_id}|${row.market_type}`) ?? 0,
      ),
      ttk_score: ttkScoreFromHours(row.hours_to_kickoff),
      clv_yield_score: clvYieldScore(clvRolling.get(scopeKey) ?? null),
      model_opportunity_score:
        modelOpp.get(`${row.fixture_id}|${row.market_type}`) ?? 0,
    };
    const { score, basePriority, modelBoost } = computeWatchPriorityScore(
      components,
      weights,
    );
    const tier = assignTier(score, thresholds);
    rowsToInsert.push({
      fixture_id: row.fixture_id,
      market_type: row.market_type,
      score,
      base: basePriority,
      boost: modelBoost,
      tier,
      components,
      ttk_bucket: ttk,
    });
    result.tier_counts[`tier${tier}` as "tier1" | "tier2" | "tier3" | "tier4"]++;
  }

  // Bulk insert in chunks of 500.
  for (let i = 0; i < rowsToInsert.length; i += 500) {
    const chunk = rowsToInsert.slice(i, i + 500);
    try {
      // Build the VALUES list with parameterised values. Each row binds
      // 12 params; chunk of 500 → 6,000 params, within pg's 65,535 limit.
      const valuesSql = sql.join(
        chunk.map(
          (r) => sql`(
            ${r.fixture_id}, ${r.market_type}, NOW(),
            ${r.score.toFixed(3)}::numeric,
            ${r.base.toFixed(3)}::numeric,
            ${r.boost.toFixed(3)}::numeric,
            ${r.tier}, ${r.components.edge_density_score.toFixed(3)}::numeric,
            ${r.components.release_proximity_score.toFixed(3)}::numeric,
            ${r.components.liquidity_score.toFixed(3)}::numeric,
            ${r.components.ttk_score.toFixed(3)}::numeric,
            ${r.components.clv_yield_score.toFixed(3)}::numeric,
            ${r.components.model_opportunity_score.toFixed(3)}::numeric,
            ${r.ttk_bucket}, ${sharpCountTierFromContext()}::smallint
          )`,
        ),
        sql`, `,
      );
      await db.execute(sql`
        INSERT INTO watch_priority_history (
          fixture_id, market_type, computed_at,
          watch_priority_score, base_priority, model_boost,
          tier, edge_density_score, release_proximity_score,
          liquidity_score, ttk_score, clv_yield_score, model_opportunity_score,
          ttk_bucket, sharp_count_tier
        )
        VALUES ${valuesSql}
      `);
      result.rows_written += chunk.length;
    } catch (err) {
      logger.warn({ err, chunkSize: chunk.length }, "watchPriorityCron: chunk insert failed");
      result.errors++;
    }
  }

  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Bulk lookups (each returns a Map keyed for fast iteration)
// ──────────────────────────────────────────────────────────────────────────

async function fetchEdgeDensity(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const r = await db.execute(sql`
      SELECT league, market_type, ttk_bucket, density_score::float8 AS density_score
      FROM scope_edge_density_v
    `);
    for (const row of ((r as any).rows ?? []) as ScopeEdgeDensityRow[]) {
      if (row.density_score == null) continue;
      out.set(`${row.league}|${row.market_type}|${row.ttk_bucket}`, row.density_score);
    }
  } catch (err) {
    logger.debug({ err }, "fetchEdgeDensity: view unavailable, defaulting to empty");
  }
  return out;
}

async function fetchClvRolling(): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  try {
    const r = await db.execute(sql`
      SELECT league, market_type, ttk_bucket, stake_weighted_clv_pct::float8 AS stake_weighted_clv_pct
      FROM scope_clv_rolling_v
    `);
    for (const row of ((r as any).rows ?? []) as ScopeClvRow[]) {
      out.set(`${row.league}|${row.market_type}|${row.ttk_bucket}`, row.stake_weighted_clv_pct);
    }
  } catch (err) {
    logger.debug({ err }, "fetchClvRolling: view unavailable, defaulting to empty");
  }
  return out;
}

async function fetchReleaseTiming(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const r = await db.execute(sql`
      SELECT league, market_type, median_hours_to_kickoff::float8 AS median_hours_to_kickoff
      FROM scope_pinnacle_release_timing_v
    `);
    for (const row of ((r as any).rows ?? []) as ScopeReleaseTimingRow[]) {
      if (row.median_hours_to_kickoff == null) continue;
      out.set(`${row.league}|${row.market_type}`, row.median_hours_to_kickoff);
    }
  } catch (err) {
    logger.debug({ err }, "fetchReleaseTiming: view unavailable, defaulting to empty");
  }
  return out;
}

async function fetchLatestLiquidity(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const r = await db.execute(sql`
      SELECT DISTINCT ON (match_id, market_type)
        match_id, market_type, total_market_volume::float8 AS total_market_volume
      FROM liquidity_snapshots
      WHERE captured_at >= NOW() - INTERVAL '6 hours'
      ORDER BY match_id, market_type, captured_at DESC
    `);
    for (const row of ((r as any).rows ?? []) as LiquiditySnapshotRow[]) {
      out.set(`${row.match_id}|${row.market_type}`, row.total_market_volume ?? 0);
    }
  } catch (err) {
    logger.debug({ err }, "fetchLatestLiquidity: query failed, defaulting to empty");
  }
  return out;
}

async function fetchLatestModelOpp(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    // Latest opportunity_score per (match, market_type) from pending
    // emitted candidates. We use paper_bets pending rows as the proxy
    // for "model has expressed an opinion on this fixture × market"
    // — the cleanest source available without re-running the model.
    const r = await db.execute(sql`
      SELECT DISTINCT ON (match_id, market_type)
        match_id, market_type, opportunity_score::float8 AS opportunity_score
      FROM paper_bets
      WHERE placed_at >= NOW() - INTERVAL '6 hours'
        AND opportunity_score IS NOT NULL
        AND deleted_at IS NULL
      ORDER BY match_id, market_type, placed_at DESC
    `);
    for (const row of ((r as any).rows ?? []) as ModelOppRow[]) {
      out.set(`${row.match_id}|${row.market_type}`, row.opportunity_score);
    }
  } catch (err) {
    logger.debug({ err }, "fetchLatestModelOpp: query failed, defaulting to empty");
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Retention pruner — daily cron
// ──────────────────────────────────────────────────────────────────────────

export async function runWatchPriorityRetention(): Promise<{ deleted: number }> {
  const { getConfigValue } = await import("./paperTrading");
  const ttlRaw = await getConfigValue("watch_priority_history_retention_days");
  const ttlDays = ttlRaw != null ? Number(ttlRaw) : 7;
  const days = Number.isFinite(ttlDays) && ttlDays >= 1 ? ttlDays : 7;
  const r = (await db.execute(sql`
    DELETE FROM watch_priority_history
    WHERE computed_at < NOW() - ${sql.raw(`INTERVAL '${days} days'`)}
  `)) as unknown as { rowCount?: number };
  return { deleted: r.rowCount ?? 0 };
}
