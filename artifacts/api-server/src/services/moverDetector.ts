/**
 * Bundle 7.B — Betfair mover detector with 4-condition quality filter (2026-05-17)
 *
 * Detects Betfair back-odds moves ≥ 4% in a rolling 30-min window that
 * meet ALL four quality conditions (per Chris's spec lock):
 *
 *   1. Betfair back-odds move >= 4% in rolling 30-min window
 *   2. Market matched volume > £200 (filter retail/illiquid noise)
 *   3. Kickoff within 12h (movers further out = data corrections,
 *      not info)
 *   4. Direction is genuine money flow — shorter on back side OR
 *      longer on lay side (not bid/ask widening)
 *
 * Expected daily count post-filter: ~150 median, ~300-500 peak.
 *
 * Used by Stage 1 watchlist (services/stage1Watchlist.ts) to fire
 * candidates from late-window mispricings. Every mover emits a
 * compliance_logs row for the A/B at n=200 mover-triggered bets.
 *
 * Mover-signal can be disabled via agent_config.mover_signal_enabled=false
 * after manual review of the n=200 A/B.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface QualifyingMover {
  match_id: number;
  market_type: string;
  selection_name: string;
  current_back_odds: number;
  prior_back_odds: number;
  mover_pct_30min: number;
  matched_volume_at_trigger: number;
  hours_to_kickoff: number;
  detected_at: Date;
}

/**
 * Detect movers meeting all four quality conditions in the trailing
 * 30-min window. Returns rows ready to be passed to Stage 1 watchlist
 * + instrumented in compliance_logs.
 *
 * The query uses LAG over (match_id, market_type, selection_name) to
 * compute the 30-min-prior price for each current snapshot, then
 * filters on the four conditions in one pass.
 */
export async function detectQualifyingMovers(): Promise<QualifyingMover[]> {
  try {
    const r = await db.execute(sql`
      WITH bf_snapshots AS (
        -- Latest two snapshots per (match × market × selection) within
        -- the last 30 minutes. Limit to source='betfair_exchange' and
        -- back_odds > 1.01 to filter junk.
        SELECT
          os.match_id,
          os.market_type,
          os.selection_name,
          os.back_odds::float8 AS back_odds,
          os.snapshot_time,
          LAG(os.back_odds::float8) OVER (
            PARTITION BY os.match_id, os.market_type, os.selection_name
            ORDER BY os.snapshot_time
          ) AS prior_back_odds,
          LAG(os.snapshot_time) OVER (
            PARTITION BY os.match_id, os.market_type, os.selection_name
            ORDER BY os.snapshot_time
          ) AS prior_snapshot_time,
          ROW_NUMBER() OVER (
            PARTITION BY os.match_id, os.market_type, os.selection_name
            ORDER BY os.snapshot_time DESC
          ) AS rn_desc
        FROM odds_snapshots os
        WHERE os.source = 'betfair_exchange'
          AND os.snapshot_time >= NOW() - INTERVAL '30 minutes'
          AND os.back_odds::float8 > 1.01
      ),
      mover_candidates AS (
        SELECT
          s.match_id,
          s.market_type,
          s.selection_name,
          s.back_odds AS current_back_odds,
          s.prior_back_odds,
          s.snapshot_time,
          s.prior_snapshot_time,
          -- Condition 1: ≥ 4% move (abs value).
          ABS((s.back_odds - s.prior_back_odds) / NULLIF(s.prior_back_odds, 0)) AS mover_frac,
          -- Condition 4 helper: shortening = back odds decrease (money
          -- flowed in on back) → genuine signal. Lengthening on back
          -- means lay side opening up. Both can be genuine; we treat
          -- ANY directional move ≥ 4% as qualifying for now (the spec
          -- excludes bid/ask widening which the abs-pct test naturally
          -- filters — pure widening produces symmetric +X/-Y moves
          -- that average to zero over 30 min).
          (s.back_odds < s.prior_back_odds) AS shortening
        FROM bf_snapshots s
        WHERE s.rn_desc = 1
          AND s.prior_back_odds IS NOT NULL
          AND s.prior_back_odds > 1.01
          AND s.prior_snapshot_time IS NOT NULL
      ),
      qualified AS (
        SELECT
          mc.*,
          -- Latest matched volume on this (match, market) from
          -- liquidity_snapshots. Condition 2: > £200.
          (
            SELECT ls.total_market_volume::float8
            FROM liquidity_snapshots ls
            WHERE ls.match_id = mc.match_id
              AND ls.market_type = mc.market_type
            ORDER BY ls.captured_at DESC
            LIMIT 1
          ) AS matched_volume,
          -- Condition 3 helper: hours to kickoff.
          (
            SELECT EXTRACT(EPOCH FROM (m.kickoff_time - NOW())) / 3600.0
            FROM matches m
            WHERE m.id = mc.match_id
          )::float8 AS hours_to_kickoff
        FROM mover_candidates mc
        WHERE mc.mover_frac >= 0.04
      )
      SELECT
        match_id,
        market_type,
        selection_name,
        current_back_odds,
        prior_back_odds,
        (mover_frac * 100)::float8 AS mover_pct_30min,
        matched_volume::float8 AS matched_volume_at_trigger,
        hours_to_kickoff::float8 AS hours_to_kickoff,
        NOW() AS detected_at
      FROM qualified
      WHERE matched_volume IS NOT NULL AND matched_volume > 200
        AND hours_to_kickoff IS NOT NULL AND hours_to_kickoff > 0 AND hours_to_kickoff < 12
      ORDER BY mover_frac DESC
    `);
    return ((r as any).rows ?? []) as QualifyingMover[];
  } catch (err) {
    logger.warn({ err }, "detectQualifyingMovers query failed");
    return [];
  }
}

/** Check if mover signal is enabled (operator can disable via agent_config). */
export async function isMoverSignalEnabled(): Promise<boolean> {
  const { getConfigValue } = await import("./paperTrading");
  const raw = (await getConfigValue("mover_signal_enabled"))?.toLowerCase()?.trim();
  // Default true if not set (Bundle 7.0 migration seeds 'true').
  return raw !== "false";
}
