/**
 * Phase 3 §1.7 + §11.7 (2026-05-08): per-scope half-Kelly → full-Kelly ramp.
 *
 * Runs every 15 min when live_mode_active='true'. Pre-flip is a no-op.
 *
 * Per scope in live_whitelist (active=true), reads the count of settled-live
 * bets for that scope. When the counter crosses the path-specific ramp
 * threshold (Path P: 50, Path S: 100):
 *   - If rolling-N net ROI > 0% → write live_whitelist.kelly_fraction_override=1.0
 *     (graduate to full Kelly).
 *   - If rolling-N net ROI ≤ 0% → leave at 0.5; insert one
 *     live_ramp_review_required row per scope so Chris can decide whether to
 *     extend the half-Kelly window or halt the scope. Idempotent — only one
 *     unresolved review row per scope at a time.
 *
 * Path P uses 50 (Pinnacle-anchored evidence is independently confirmed by
 * CLV); Path S uses 100 (no anchor → longer ramp to accumulate live evidence
 * before full sizing).
 *
 * Idempotent: scopes already at kelly_fraction_override=1.0 are skipped.
 */

import { db, agentConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

async function getConfig(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, key));
  return rows[0]?.value ?? null;
}

const PATH_P_RAMP_THRESHOLD = 50;
const PATH_S_RAMP_THRESHOLD = 100;

export interface HalfKellyRampResult {
  evaluated_at: string;
  live_mode_active: boolean;
  scopes_evaluated: number;
  scopes_graduated: Array<{ path: string; market_type: string; league: string; n: number; rolling_roi: number }>;
  scopes_pending_review: Array<{ path: string; market_type: string; league: string; n: number; rolling_roi: number }>;
  scopes_below_threshold: number;
}

export async function runHalfKellyRamp(): Promise<HalfKellyRampResult> {
  const result: HalfKellyRampResult = {
    evaluated_at: new Date().toISOString(),
    live_mode_active: false,
    scopes_evaluated: 0,
    scopes_graduated: [],
    scopes_pending_review: [],
    scopes_below_threshold: 0,
  };

  const liveModeActive = (await getConfig("live_mode_active")) === "true";
  result.live_mode_active = liveModeActive;
  if (!liveModeActive) {
    logger.debug("half_kelly_ramp: pre-flip — no-op");
    return result;
  }

  // Only consider active scopes still on half-Kelly (override < 1.0).
  const scopes = await db.execute(sql`
    SELECT id, path, market_type, league, kelly_fraction_override
    FROM live_whitelist
    WHERE active = true AND kelly_fraction_override < 1.0
  `);
  const scopeRows = (((scopes as any).rows ?? []) as Array<{
    id: number; path: string; market_type: string; league: string;
    kelly_fraction_override: string | number | null;
  }>);
  result.scopes_evaluated = scopeRows.length;

  for (const scope of scopeRows) {
    const threshold = scope.path === "P" ? PATH_P_RAMP_THRESHOLD : PATH_S_RAMP_THRESHOLD;

    // Rolling-N counter + ROI for this scope (most recent N settled live bets).
    const rolling = await db.execute(sql`
      WITH recent AS (
        SELECT pb.stake::numeric AS stake, pb.net_pnl::numeric AS net_pnl
        FROM paper_bets pb
        JOIN matches m ON m.id = pb.match_id
        WHERE pb.bet_track = 'live'
          AND pb.legacy_regime = false
          AND pb.deleted_at IS NULL
          AND pb.status IN ('won','lost')
          AND pb.market_type = ${scope.market_type}
          AND m.league = ${scope.league}
          AND pb.stake::numeric > 0
        ORDER BY pb.settled_at DESC NULLS LAST
        LIMIT ${threshold}
      )
      SELECT COUNT(*)::int AS n,
             SUM(stake) AS sum_stake,
             SUM(net_pnl) AS sum_net_pnl
      FROM recent
    `);
    const r = (((rolling as any).rows ?? []) as Array<{
      n: number; sum_stake: string | null; sum_net_pnl: string | null;
    }>)[0];
    const n = Number(r?.n ?? 0);
    if (n < threshold) {
      result.scopes_below_threshold++;
      continue;
    }
    const stake = Number(r?.sum_stake ?? 0);
    const pnl = Number(r?.sum_net_pnl ?? 0);
    const roi = stake > 0 ? pnl / stake : 0;

    if (roi > 0) {
      await db.execute(sql`
        UPDATE live_whitelist
        SET kelly_fraction_override = 1.0
        WHERE id = ${scope.id} AND kelly_fraction_override < 1.0
      `);
      await db.execute(sql`
        INSERT INTO stop_condition_actions (action_type, scope_path, market_type, league, reason, metric_name, metric_value, threshold_value)
        VALUES (
          'kelly_ramp_to_full', ${scope.path}, ${scope.market_type}, ${scope.league},
          ${`Path ${scope.path} scope at n=${n} live bets, rolling ROI ${(roi * 100).toFixed(2)}% > 0 — graduating to full Kelly`},
          'rolling_n_net_roi', ${roi}, 0
        )
      `);
      result.scopes_graduated.push({
        path: scope.path, market_type: scope.market_type, league: scope.league, n, rolling_roi: roi,
      });
      logger.info(
        { scope, n, roi },
        "half_kelly_ramp: scope graduated to full Kelly",
      );
    } else {
      // ROI ≤ 0% at threshold — surface review row (idempotent: one unresolved per scope)
      await db.execute(sql`
        INSERT INTO live_ramp_review_required (scope_path, market_type, league, n, rolling_net_roi, threshold)
        SELECT ${scope.path}, ${scope.market_type}, ${scope.league}, ${n}, ${roi}, ${threshold}
        WHERE NOT EXISTS (
          SELECT 1 FROM live_ramp_review_required
          WHERE market_type = ${scope.market_type}
            AND league = ${scope.league}
            AND resolved_at IS NULL
        )
      `);
      result.scopes_pending_review.push({
        path: scope.path, market_type: scope.market_type, league: scope.league, n, rolling_roi: roi,
      });
      logger.warn(
        { scope, n, roi },
        "half_kelly_ramp: scope at threshold but ROI ≤ 0 — review required",
      );
    }
  }

  logger.info(result, "half_kelly_ramp evaluated");
  return result;
}
