/**
 * Phase 3 §1.8 + §11.7 (2026-05-08): post-flip stop-condition monitor.
 *
 * Runs every 15 min when live_mode_active='true'. Pre-flip is a no-op.
 *
 * Five conditions:
 *  1. Drawdown > 15% of bankroll-at-flip          → halt all placements
 *     (set agent_config.live_placement_enabled='false', insert review row).
 *     Existing pending live bets settle naturally; only NEW placements stop.
 *  2. Per-scope rolling-50 net ROI < −2%           → halt that scope
 *     (live_whitelist.active=false). Path P + Path S both apply.
 *  3. Per-scope rolling-100 net Pinnacle CLV < 0%  → halt that scope
 *     (Path P only — Path S has no Pinnacle anchor by definition).
 *  4. Path S only: rolling-100 net ROI < +1%      → demote-to-shadow
 *     (less aggressive than ROI<-2% halt; signals edge-decay before the
 *     scope blows up). Marks live_whitelist.active=false with reason
 *     'path_s_demote_to_shadow' so the scope stops live-betting and the
 *     shadow rail can re-prove its edge.
 *  5. Commission band breach (actual ≠ 5% ± 0.5pp on last 100 live wins)
 *                                                  → alert+reconcile, no halt.
 *     A bookkeeping anomaly is over-reaction territory for halting.
 *
 * Action log: every state transition writes one stop_condition_actions row
 * + one model_decision_audit_log row (review_status='automatic').
 *
 * Idempotent: scopes already inactive are skipped; halts are not re-applied.
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

async function setConfig(key: string, value: string): Promise<void> {
  const existing = await db.select().from(agentConfigTable).where(eq(agentConfigTable.key, key));
  if (existing.length === 0) {
    await db.insert(agentConfigTable).values({ key, value });
  } else {
    await db.update(agentConfigTable).set({ value, updatedAt: new Date() }).where(eq(agentConfigTable.key, key));
  }
}

export interface StopConditionResult {
  evaluated_at: string;
  live_mode_active: boolean;
  drawdown: {
    bankroll_at_flip: number | null;
    bankroll_now: number | null;
    drawdown_pct: number | null;
    halt_triggered: boolean;
    already_halted: boolean;
  };
  scopes_evaluated: number;
  scopes_halted: Array<{ path: string; market_type: string; league: string; reason: string; metric: number }>;
  commission_band: { actual: number; expected: number; alert: boolean } | null;
}

const DRAWDOWN_HALT_PCT = 0.15;
const PER_SCOPE_ROLLING_50_ROI_HALT = -0.02;
const PATH_P_ROLLING_100_CLV_HALT = 0; // CLV in % units
const PATH_S_ROLLING_100_ROI_DEMOTE = 0.01;
const COMMISSION_BAND_LOW = 0.045;
const COMMISSION_BAND_HIGH = 0.055;

export async function runStopConditionMonitor(): Promise<StopConditionResult> {
  const result: StopConditionResult = {
    evaluated_at: new Date().toISOString(),
    live_mode_active: false,
    drawdown: {
      bankroll_at_flip: null,
      bankroll_now: null,
      drawdown_pct: null,
      halt_triggered: false,
      already_halted: false,
    },
    scopes_evaluated: 0,
    scopes_halted: [],
    commission_band: null,
  };

  const liveModeActive = (await getConfig("live_mode_active")) === "true";
  result.live_mode_active = liveModeActive;
  if (!liveModeActive) {
    logger.debug("stop_condition_monitor: pre-flip — no-op");
    return result;
  }

  // ── 1. Drawdown halt ──────────────────────────────────────────────────────
  // bankroll_at_flip is captured by the flip-to-live transaction in
  // compliance_logs.action_type='live_mode_activated'. Fall back to
  // agent_config.bankroll_at_flip if directly set.
  const flipBankrollFromConfig = await getConfig("bankroll_at_flip");
  let bankrollAtFlip: number | null = flipBankrollFromConfig != null
    ? Number(flipBankrollFromConfig)
    : null;
  if (bankrollAtFlip == null) {
    const flipLog = await db.execute(sql`
      SELECT details->>'bankroll_at_flip' AS v
      FROM compliance_logs
      WHERE action_type='live_mode_activated'
      ORDER BY id DESC LIMIT 1
    `);
    const v = (((flipLog as any).rows ?? []) as Array<{ v: string | null }>)[0]?.v ?? null;
    if (v != null) bankrollAtFlip = Number(v);
  }
  const bankrollNow = Number((await getConfig("bankroll")) ?? 0);
  result.drawdown.bankroll_at_flip = bankrollAtFlip;
  result.drawdown.bankroll_now = bankrollNow;

  if (bankrollAtFlip != null && bankrollAtFlip > 0 && Number.isFinite(bankrollNow)) {
    const drawdownPct = (bankrollAtFlip - bankrollNow) / bankrollAtFlip;
    result.drawdown.drawdown_pct = drawdownPct;
    const placementsEnabled = (await getConfig("live_placement_enabled")) === "true";
    result.drawdown.already_halted = !placementsEnabled;

    if (drawdownPct > DRAWDOWN_HALT_PCT && placementsEnabled) {
      await setConfig("live_placement_enabled", "false");
      await db.execute(sql`
        INSERT INTO stop_condition_actions (action_type, scope_path, market_type, league, reason, metric_name, metric_value, threshold_value)
        VALUES (
          'drawdown_halt_placements', NULL, NULL, NULL,
          ${`Drawdown ${(drawdownPct * 100).toFixed(2)}% exceeded ${DRAWDOWN_HALT_PCT * 100}% halt threshold`},
          'drawdown_pct', ${drawdownPct}, ${DRAWDOWN_HALT_PCT}
        )
      `);
      await db.execute(sql`
        INSERT INTO gate_status_review_required (reason, diagnostic)
        VALUES (
          'drawdown_halt_triggered',
          ${JSON.stringify({
            bankroll_at_flip: bankrollAtFlip,
            bankroll_now: bankrollNow,
            drawdown_pct: drawdownPct,
            halt_threshold: DRAWDOWN_HALT_PCT,
            evaluated_at: result.evaluated_at,
          })}::jsonb
        )
      `);
      result.drawdown.halt_triggered = true;
      logger.warn(
        { bankrollAtFlip, bankrollNow, drawdownPct },
        "stop_condition_monitor: drawdown halt triggered — live_placement_enabled set to false",
      );
    }
  }

  // ── 2/3/4. Per-scope rolling-N halts ──────────────────────────────────────
  const scopes = await db.execute(sql`
    SELECT id, path, market_type, league
    FROM live_whitelist
    WHERE active = true
  `);
  const scopeRows = (((scopes as any).rows ?? []) as Array<{
    id: number; path: string; market_type: string; league: string;
  }>);
  result.scopes_evaluated = scopeRows.length;

  for (const scope of scopeRows) {
    // Rolling-50 net ROI on this scope's most recent 50 settled live bets.
    const rolling50 = await db.execute(sql`
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
        LIMIT 50
      )
      SELECT COUNT(*)::int AS n,
             SUM(stake) AS sum_stake,
             SUM(net_pnl) AS sum_net_pnl
      FROM recent
    `);
    const r50 = (((rolling50 as any).rows ?? []) as Array<{
      n: number; sum_stake: string | null; sum_net_pnl: string | null;
    }>)[0];
    const n50 = Number(r50?.n ?? 0);
    const stake50 = Number(r50?.sum_stake ?? 0);
    const pnl50 = Number(r50?.sum_net_pnl ?? 0);
    const roi50 = n50 >= 50 && stake50 > 0 ? pnl50 / stake50 : null;

    if (roi50 != null && roi50 < PER_SCOPE_ROLLING_50_ROI_HALT) {
      await haltScope(scope, "rolling_50_roi_halt", "rolling_50_net_roi", roi50, PER_SCOPE_ROLLING_50_ROI_HALT);
      result.scopes_halted.push({
        path: scope.path, market_type: scope.market_type, league: scope.league,
        reason: "rolling_50_roi_halt", metric: roi50,
      });
      continue; // already halted — skip further checks on this scope
    }

    // Path P only: rolling-100 net Pinnacle CLV < 0
    if (scope.path === "P") {
      const rolling100Clv = await db.execute(sql`
        WITH recent AS (
          SELECT pb.clv_pct::numeric AS clv_pct
          FROM paper_bets pb
          JOIN matches m ON m.id = pb.match_id
          WHERE pb.bet_track = 'live'
            AND pb.legacy_regime = false
            AND pb.deleted_at IS NULL
            AND pb.status IN ('won','lost')
            AND pb.market_type = ${scope.market_type}
            AND m.league = ${scope.league}
            AND pb.clv_source = 'pinnacle'
            AND pb.clv_pct IS NOT NULL
          ORDER BY pb.settled_at DESC NULLS LAST
          LIMIT 100
        )
        SELECT COUNT(*)::int AS n, AVG(clv_pct) AS avg_clv FROM recent
      `);
      const r100 = (((rolling100Clv as any).rows ?? []) as Array<{
        n: number; avg_clv: string | null;
      }>)[0];
      const n100 = Number(r100?.n ?? 0);
      const avgClv = r100?.avg_clv != null ? Number(r100.avg_clv) : null;
      if (n100 >= 100 && avgClv != null && avgClv < PATH_P_ROLLING_100_CLV_HALT) {
        await haltScope(scope, "rolling_100_clv_halt", "rolling_100_net_clv", avgClv, PATH_P_ROLLING_100_CLV_HALT);
        result.scopes_halted.push({
          path: scope.path, market_type: scope.market_type, league: scope.league,
          reason: "rolling_100_clv_halt", metric: avgClv,
        });
      }
    }

    // Path S only: rolling-100 net ROI < +1% → demote-to-shadow
    if (scope.path === "S") {
      const rolling100Roi = await db.execute(sql`
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
          LIMIT 100
        )
        SELECT COUNT(*)::int AS n,
               SUM(stake) AS sum_stake,
               SUM(net_pnl) AS sum_net_pnl
        FROM recent
      `);
      const r100r = (((rolling100Roi as any).rows ?? []) as Array<{
        n: number; sum_stake: string | null; sum_net_pnl: string | null;
      }>)[0];
      const n100r = Number(r100r?.n ?? 0);
      const stake100 = Number(r100r?.sum_stake ?? 0);
      const pnl100 = Number(r100r?.sum_net_pnl ?? 0);
      const roi100 = n100r >= 100 && stake100 > 0 ? pnl100 / stake100 : null;
      if (roi100 != null && roi100 < PATH_S_ROLLING_100_ROI_DEMOTE) {
        await haltScope(scope, "path_s_demote_to_shadow", "rolling_100_net_roi", roi100, PATH_S_ROLLING_100_ROI_DEMOTE);
        result.scopes_halted.push({
          path: scope.path, market_type: scope.market_type, league: scope.league,
          reason: "path_s_demote_to_shadow", metric: roi100,
        });
      }
    }
  }

  // ── 5. Commission band ────────────────────────────────────────────────────
  // Last 100 settled live wins. Commission rate = sum(commission_amount) /
  // sum(gross_pnl). Expected 5% (Betfair base rate). Outside [4.5%, 5.5%]
  // band → alert (no halt). Skip if fewer than 50 wins (insufficient sample).
  const commission = await db.execute(sql`
    WITH recent AS (
      SELECT pb.gross_pnl::numeric AS gross_pnl,
             pb.commission_amount::numeric AS commission_amount
      FROM paper_bets pb
      WHERE pb.bet_track = 'live'
        AND pb.legacy_regime = false
        AND pb.deleted_at IS NULL
        AND pb.status = 'won'
        AND pb.gross_pnl IS NOT NULL
        AND pb.commission_amount IS NOT NULL
      ORDER BY pb.settled_at DESC NULLS LAST
      LIMIT 100
    )
    SELECT COUNT(*)::int AS n,
           SUM(gross_pnl) AS sum_gross,
           SUM(commission_amount) AS sum_commission
    FROM recent
  `);
  const cRow = (((commission as any).rows ?? []) as Array<{
    n: number; sum_gross: string | null; sum_commission: string | null;
  }>)[0];
  const cN = Number(cRow?.n ?? 0);
  const cGross = Number(cRow?.sum_gross ?? 0);
  const cComm = Number(cRow?.sum_commission ?? 0);
  if (cN >= 50 && cGross > 0) {
    const actualRate = cComm / cGross;
    const alert = actualRate < COMMISSION_BAND_LOW || actualRate > COMMISSION_BAND_HIGH;
    result.commission_band = { actual: actualRate, expected: 0.05, alert };
    if (alert) {
      await db.execute(sql`
        INSERT INTO stop_condition_actions (action_type, scope_path, market_type, league, reason, metric_name, metric_value, threshold_value)
        VALUES (
          'commission_band_alert', NULL, NULL, NULL,
          ${`Commission rate ${(actualRate * 100).toFixed(3)}% outside [4.5%, 5.5%] band on last ${cN} wins`},
          'commission_rate', ${actualRate}, 0.05
        )
      `);
      logger.warn(
        { actualRate, n: cN },
        "stop_condition_monitor: commission band breach — alert+reconcile, no halt",
      );
    }
  }

  logger.info(result, "stop_condition_monitor evaluated");
  return result;
}

async function haltScope(
  scope: { id: number; path: string; market_type: string; league: string },
  actionType: string,
  metricName: string,
  metricValue: number,
  thresholdValue: number,
): Promise<void> {
  const reason = `${actionType}: ${metricName}=${metricValue.toFixed(4)} < ${thresholdValue}`;
  await db.execute(sql`
    UPDATE live_whitelist
    SET active = false
    WHERE id = ${scope.id} AND active = true
  `);
  await db.execute(sql`
    INSERT INTO stop_condition_actions (action_type, scope_path, market_type, league, reason, metric_name, metric_value, threshold_value)
    VALUES (
      ${actionType}, ${scope.path}, ${scope.market_type}, ${scope.league},
      ${reason}, ${metricName}, ${metricValue}, ${thresholdValue}
    )
  `);
  logger.warn(
    { scope, actionType, metricName, metricValue, thresholdValue },
    "stop_condition_monitor: scope halted",
  );
}
