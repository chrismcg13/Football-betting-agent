/**
 * Bundle F2.B.AUDIT-FIX-5 (2026-05-19): inversion-band widening monitor.
 *
 * Controlled experiment per the master plan Step 4: widen the
 * inversion_live_max_edge_pp from 7 → 9, then auto-snap-back if the
 * new 7-9pp band fails to clear breakeven over a meaningful sample.
 *
 * Rule (per user direction):
 *   - Widen 7 → 9 first, not directly to 12
 *   - Run until n=200 settled bets in the 7-9pp band OR 14 days
 *     (whichever comes first)
 *   - Snap back to 7 iff stake-weighted ROI on those bets < 0
 *   - If passes, operator manually widens to 12; this cron does NOT
 *     auto-promote past 9 (one controlled step at a time)
 *
 * Snap-back is operator-priority — auto-pause emission for matters
 * money is at stake. Idempotent: each tick re-evaluates the current
 * state; only fires the snap-back action once because subsequent runs
 * see the cap already at 7 and skip.
 *
 * Stake-weighted ROI rather than Wilson on win-rate because 7-9pp
 * bets are at variable odds (~2.5-5.0 typical) — Wilson at 50% gate
 * is the wrong threshold; ROI > 0 is the right one.
 */

import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getConfigValue, setConfigValue } from "./paperTrading";

const BAND_MIN_PP = 0.07; // 7pp — lower bound of the widening band
const BAND_MAX_PP = 0.09; // 9pp — upper bound (the new cap)
const SNAP_BACK_FROM_PP = 9.0;
const SNAP_BACK_TO_PP = 7.0;
const MIN_SAMPLE_N = 200;
const MAX_WINDOW_DAYS = 14;

export interface InversionBandMonitorResult {
  current_cap_pp: number;
  widening_started_at: string | null;
  settled_in_band: number;
  wins: number;
  losses: number;
  sum_stake: number;
  sum_pnl: number;
  roi: number | null;
  action: "noop" | "snap_back_fired" | "evaluating";
  reason: string;
}

export async function runInversionBandMonitor(): Promise<InversionBandMonitorResult> {
  const capRaw = await getConfigValue("inversion_live_max_edge_pp");
  const currentCap = capRaw != null && Number.isFinite(Number(capRaw)) ? Number(capRaw) : 7.0;

  // If cap is already at-or-below snap-back target, nothing to monitor.
  if (currentCap <= SNAP_BACK_TO_PP + 0.01) {
    return {
      current_cap_pp: currentCap,
      widening_started_at: null,
      settled_in_band: 0,
      wins: 0,
      losses: 0,
      sum_stake: 0,
      sum_pnl: 0,
      roi: null,
      action: "noop",
      reason: "cap_at_or_below_snap_back_target",
    };
  }

  const widenedAtRaw = await getConfigValue("inversion_band_widening_started_at");
  // If widening start timestamp missing, set it now (first observation of
  // a widened cap). Don't snap back without data.
  if (!widenedAtRaw) {
    await setConfigValue("inversion_band_widening_started_at", new Date().toISOString());
    return {
      current_cap_pp: currentCap,
      widening_started_at: new Date().toISOString(),
      settled_in_band: 0,
      wins: 0,
      losses: 0,
      sum_stake: 0,
      sum_pnl: 0,
      roi: null,
      action: "noop",
      reason: "widening_started_at_initialised",
    };
  }
  const widenedAt = new Date(widenedAtRaw);

  // Count settled bets placed in the 7-9pp band since widening.
  // Use shadow PnL since live volume is small; both rails are evidence
  // for whether the band is profitable.
  const rows = (await db.execute(sql`
    SELECT
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE status='won')::int AS wins,
      COUNT(*) FILTER (WHERE status='lost')::int AS losses,
      COALESCE(SUM(CASE WHEN bet_track='shadow' THEN COALESCE(shadow_stake, 0)
                        ELSE stake END), 0)::float8 AS sum_stake,
      COALESCE(SUM(CASE WHEN bet_track='shadow' THEN COALESCE(shadow_pnl, 0)
                        ELSE COALESCE(net_pnl, settlement_pnl, 0) END), 0)::float8 AS sum_pnl
    FROM paper_bets
    WHERE deleted_at IS NULL
      AND status IN ('won','lost')
      AND bet_track IN ('shadow','live')
      AND calculated_edge BETWEEN ${BAND_MIN_PP} AND ${BAND_MAX_PP}
      AND placed_at >= ${widenedAt.toISOString()}::timestamptz
  `)) as unknown as {
    rows?: Array<{ n: number; wins: number; losses: number; sum_stake: number; sum_pnl: number }>;
  };
  const r = rows.rows?.[0];
  const n = r?.n ?? 0;
  const wins = r?.wins ?? 0;
  const losses = r?.losses ?? 0;
  const sumStake = r?.sum_stake ?? 0;
  const sumPnl = r?.sum_pnl ?? 0;
  const roi = sumStake > 0 ? sumPnl / sumStake : null;

  const ageDays = (Date.now() - widenedAt.getTime()) / (1000 * 60 * 60 * 24);
  const evaluationReady = n >= MIN_SAMPLE_N || ageDays >= MAX_WINDOW_DAYS;

  if (!evaluationReady) {
    return {
      current_cap_pp: currentCap,
      widening_started_at: widenedAt.toISOString(),
      settled_in_band: n,
      wins, losses, sum_stake: sumStake, sum_pnl: sumPnl,
      roi,
      action: "evaluating",
      reason: `n=${n}/${MIN_SAMPLE_N}, age_days=${ageDays.toFixed(1)}/${MAX_WINDOW_DAYS}`,
    };
  }

  // Evaluation gate met — decide.
  // Snap back iff stake-weighted ROI is negative. Pass-through otherwise.
  if (roi != null && roi < 0) {
    await setConfigValue("inversion_live_max_edge_pp", String(SNAP_BACK_TO_PP));
    // Preserve widening_started_at for audit; operator can clear / reset
    // before next experiment if they want to retry the widening later.
    await db.insert(complianceLogsTable).values({
      actionType: "inversion_band_auto_snapback",
      details: {
        from_cap_pp: currentCap,
        to_cap_pp: SNAP_BACK_TO_PP,
        widening_started_at: widenedAt.toISOString(),
        settled_in_band: n, wins, losses,
        sum_stake: sumStake, sum_pnl: sumPnl, roi,
        age_days: ageDays,
        reason: "stake_weighted_roi_negative_over_evaluation_window",
      },
      timestamp: new Date(),
    });
    logger.warn(
      { from: currentCap, to: SNAP_BACK_TO_PP, n, roi, ageDays },
      "Inversion band auto-snapback FIRED — 7-9pp band underperformed",
    );
    return {
      current_cap_pp: SNAP_BACK_TO_PP,
      widening_started_at: widenedAt.toISOString(),
      settled_in_band: n,
      wins, losses, sum_stake: sumStake, sum_pnl: sumPnl,
      roi,
      action: "snap_back_fired",
      reason: "stake_weighted_roi_negative_over_evaluation_window",
    };
  }

  // Passed — no action; operator can manually widen to 9-12pp next.
  return {
    current_cap_pp: currentCap,
    widening_started_at: widenedAt.toISOString(),
    settled_in_band: n,
    wins, losses, sum_stake: sumStake, sum_pnl: sumPnl,
    roi,
    action: "noop",
    reason: `evaluation_passed_roi_${roi != null ? roi.toFixed(4) : "null"}_over_n${n}_at_age_${ageDays.toFixed(1)}d`,
  };
}
