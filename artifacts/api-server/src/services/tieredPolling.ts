/**
 * Bundle F2.A (2026-05-18) — tier-aware polling helper.
 *
 * Reads watch_priority_history to determine which fixtures to poll at
 * each tier's cadence. The watch_priority_score is a POLLING-CADENCE
 * optimizer, NOT a placement gate. Every Pinnacle-covered fixture
 * across all 800+ mapped leagues stays in the polling universe; only
 * the cadence varies by tier.
 *
 * Tier cadences (operator-tunable via agent_config.f2a_tier*_cadence_minutes):
 *   Tier 1 HOT  (score >= 20):  every 5 min
 *   Tier 2 WARM (15 <= score < 20): every 30 min
 *   Tier 3 COOL (6 <= score < 15):  every 60 min — ALL fixtures, no rotation
 *   Tier 4 COLD (score < 6):  every 6 hours
 *   Bootstrap (competition_config.bootstrap_priority=true): every 30 min
 *
 * Budget: ~38k API-Football /odds calls/day on 75k daily cap. The
 * point of casting Tier 3 wide is discovery — niche leagues where the
 * model hasn't yet found edge but Pinnacle might.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export type WatchTier = 1 | 2 | 3 | 4;

/**
 * Return the latest watch_priority row per fixture (any market_type)
 * filtered to a specific tier. We collapse market_types because the
 * polling unit is the FIXTURE (one /odds call returns all markets).
 *
 * If a fixture has rows across multiple market_types in different tiers,
 * we take the MAX tier (i.e., HOT > WARM > COOL > COLD priority).
 */
export async function getFixturesByTier(tier: WatchTier): Promise<number[]> {
  try {
    const rows = await db.execute(sql`
      WITH latest AS (
        SELECT DISTINCT ON (fixture_id, market_type)
          fixture_id, market_type, tier, watch_priority_score, computed_at
        FROM watch_priority_history
        WHERE computed_at >= NOW() - INTERVAL '15 minutes'
        ORDER BY fixture_id, market_type, computed_at DESC
      ),
      best AS (
        SELECT
          fixture_id,
          MIN(tier) AS best_tier  -- lower tier number = higher priority
        FROM latest
        GROUP BY fixture_id
      )
      SELECT fixture_id
      FROM best
      WHERE best_tier = ${tier}
      ORDER BY fixture_id
    `) as unknown as { rows?: Array<{ fixture_id: number }> };
    return (rows.rows ?? []).map((r) => r.fixture_id).filter((n) => Number.isFinite(n));
  } catch (err) {
    logger.warn({ err, tier }, "getFixturesByTier query failed — returning empty");
    return [];
  }
}

/**
 * Returns fixture_ids for competitions flagged with bootstrap_priority=true.
 * Operator-controlled override for accelerated discovery on new initiatives
 * (WC, women's expansion, new cup competitions).
 */
export async function getBootstrapFixtures(): Promise<number[]> {
  try {
    const rows = await db.execute(sql`
      SELECT m.api_fixture_id AS fixture_id
      FROM matches m
      JOIN competition_config c ON c.name = m.league
      WHERE c.bootstrap_priority = true
        AND m.status = 'scheduled'
        AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '7 days'
        AND m.api_fixture_id IS NOT NULL
      ORDER BY m.kickoff_time
    `) as unknown as { rows?: Array<{ fixture_id: number }> };
    return (rows.rows ?? []).map((r) => r.fixture_id).filter((n) => Number.isFinite(n));
  } catch (err) {
    logger.warn({ err }, "getBootstrapFixtures query failed — returning empty");
    return [];
  }
}

/**
 * Bundle F2.A tripwire check: read the model calibration view and
 * return the global stake-weighted CLV over recent settled live bets.
 * If below threshold on n >= min_n, log an alert. Audit-only — no
 * auto-pause (money guardrail boundary; operator must intervene).
 */
export async function checkCalibrationTripwire(
  thresholdPct: number,
  minN: number,
): Promise<{ tripped: boolean; n: number; stakeWeightedClvPct: number | null }> {
  try {
    const rows = await db.execute(sql`
      WITH recent AS (
        SELECT pb.stake::float8 AS stake, pb.clv_pct::float8 AS clv_pct
        FROM paper_bets pb
        WHERE pb.bet_track = 'live'
          AND pb.legacy_regime = false
          AND pb.placed_at >= NOW() - INTERVAL '14 days'
          AND pb.status IN ('won','lost','void')
          AND pb.clv_pct IS NOT NULL
          AND pb.stake > 0
        ORDER BY pb.placed_at DESC
        LIMIT 200
      )
      SELECT
        COUNT(*)::int AS n,
        CASE
          WHEN SUM(stake) > 0
          THEN (SUM(stake * clv_pct) / SUM(stake))::float8
          ELSE NULL
        END AS sw_clv
      FROM recent
    `) as unknown as { rows?: Array<{ n: number; sw_clv: number | null }> };
    const row = rows.rows?.[0];
    const n = row?.n ?? 0;
    const swClv = row?.sw_clv ?? null;
    const tripped = n >= minN && swClv != null && swClv < thresholdPct;
    return { tripped, n, stakeWeightedClvPct: swClv };
  } catch (err) {
    logger.warn({ err }, "checkCalibrationTripwire query failed");
    return { tripped: false, n: 0, stakeWeightedClvPct: null };
  }
}
