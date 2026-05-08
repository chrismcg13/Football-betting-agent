/**
 * Phase 3 B9 (2026-05-08): gate-monitoring cron. Daily 04:00 UTC. Reads
 * the gate_components / path_s_aggregate_status views and writes a
 * gate_status row per evaluation. Fires gate_clear_pending_review when
 * either Path P or Path S aggregate trigger clears (and the
 * single-scope-≤80% rule and ≥1-whitelist-row rule both hold). Fires
 * gate_status_review_required after 56 days post-evaluation_start_at if
 * the gate hasn't cleared.
 *
 * Pre-evaluation_start_at: short-circuits with a no-op (writes a single
 * row noting "evaluation not started"). After the blocker checklist
 * passes and Chris sets evaluation_start_at, the cron starts evaluating
 * the gate against accumulating settled bets.
 */

import { db, agentConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { createHash } from "node:crypto";

async function getConfig(key: string): Promise<string | null> {
  const rows = await db.select({ value: agentConfigTable.value }).from(agentConfigTable).where(eq(agentConfigTable.key, key));
  return rows[0]?.value ?? null;
}

export interface GateMonitorResult {
  evaluated_at: string;
  evaluation_started: boolean;
  path_p: {
    pool_size: number;
    aggregate_net_roi: number | null;
    aggregate_net_clv: number | null;
    pool_pass: boolean;
    roi_pass: boolean;
    clv_pass: boolean;
    all_pass: boolean;
  };
  // Phase 3 C1 (2026-05-08): Path P+ multi-anchor secondary trigger.
  // Same shape as Path P. Tier 1+2 admitted; thresholds n≥150, ROI≥3%,
  // CLV≥1%. Does NOT auto-fire switchover — surfaces a manual review row
  // when all_pass; Chris decides whether to flip on it.
  path_p_plus: {
    pool_size: number;
    n_tier_1: number;
    n_tier_2: number;
    aggregate_net_roi: number | null;
    aggregate_net_clv: number | null;
    pool_pass: boolean;
    roi_pass: boolean;
    clv_pass: boolean;
    all_pass: boolean;
  };
  path_s: {
    pool_size_cleared: number;
    distinct_markets_cleared: number;
    aggregate_net_roi_cleared: number | null;
    n_pass: boolean;
    diversity_pass: boolean;
    roi_pass: boolean;
    aggregate_pass: boolean;
  };
  whitelist_size: number;
  whitelist_largest_share: number | null;
  trigger: "P" | "S" | null;
  pending_review_inserted: boolean;
  diagnostic_inserted: boolean;
}

export async function runGateMonitor(): Promise<GateMonitorResult> {
  const evalStartStr = await getConfig("evaluation_start_at");
  const result: GateMonitorResult = {
    evaluated_at: new Date().toISOString(),
    evaluation_started: !!evalStartStr,
    path_p: {
      pool_size: 0,
      aggregate_net_roi: null,
      aggregate_net_clv: null,
      pool_pass: false,
      roi_pass: false,
      clv_pass: false,
      all_pass: false,
    },
    path_p_plus: {
      pool_size: 0,
      n_tier_1: 0,
      n_tier_2: 0,
      aggregate_net_roi: null,
      aggregate_net_clv: null,
      pool_pass: false,
      roi_pass: false,
      clv_pass: false,
      all_pass: false,
    },
    path_s: {
      pool_size_cleared: 0,
      distinct_markets_cleared: 0,
      aggregate_net_roi_cleared: null,
      n_pass: false,
      diversity_pass: false,
      roi_pass: false,
      aggregate_pass: false,
    },
    whitelist_size: 0,
    whitelist_largest_share: null,
    trigger: null,
    pending_review_inserted: false,
    diagnostic_inserted: false,
  };

  if (!evalStartStr) {
    // Evaluation not started — write a no-op status row so we have a heartbeat.
    await db.execute(sql`
      INSERT INTO gate_status (
        evaluated_at, pool_size, aggregate_net_roi, aggregate_net_clv,
        pool_size_pass, roi_pass, clv_pass, all_pass,
        whitelist_size, whitelist_largest_share, manifest
      ) VALUES (
        NOW(), 0, NULL, NULL, false, false, false, false, 0, NULL,
        ${JSON.stringify({ status: "evaluation_not_started" })}::jsonb
      )
    `);
    return result;
  }

  // Path P aggregate
  const pComp = await db.execute(sql`SELECT * FROM gate_components`);
  const pRow = (((pComp as any).rows ?? []) as Array<{
    pool_size: number | string;
    aggregate_net_roi: number | string | null;
    aggregate_net_clv: number | string | null;
    by_market: Record<string, unknown> | null;
  }>)[0];
  if (pRow) {
    result.path_p.pool_size = Number(pRow.pool_size ?? 0);
    result.path_p.aggregate_net_roi = pRow.aggregate_net_roi != null ? Number(pRow.aggregate_net_roi) : null;
    result.path_p.aggregate_net_clv = pRow.aggregate_net_clv != null ? Number(pRow.aggregate_net_clv) : null;
    result.path_p.pool_pass = result.path_p.pool_size >= 200;
    result.path_p.roi_pass = (result.path_p.aggregate_net_roi ?? 0) >= 0.03;
    // Phase 3 Path C relaxation (2026-05-08): CLV is no longer a gate
    // condition. clv_pass stays in the result for diagnostic visibility
    // (manifest still shows whether the model is beating the closing line)
    // but it does NOT participate in all_pass. Per Chris: "we can still
    // validate CLV after the match to learn edge" — CLV is learning data
    // post-Path-C, not a switchover gate.
    result.path_p.clv_pass = (result.path_p.aggregate_net_clv ?? 0) >= 2.0;
    result.path_p.all_pass = result.path_p.pool_pass && result.path_p.roi_pass;
  }

  // Path P+ aggregate (Phase 3 C1, 2026-05-08): Tier-1+2 multi-anchor pool.
  // Surfaces in manifest + writes a review row when all_pass — does NOT
  // auto-fire switchover. Thresholds: n≥150, ROI≥3%, CLV≥1% (looser than
  // Path P's 200/3%/2% — looser CLV because Tier-2 anchors have higher
  // noise than Pinnacle).
  try {
    const pPlusComp = await db.execute(sql`SELECT * FROM gate_components_p_plus`);
    const pPlusRow = (((pPlusComp as any).rows ?? []) as Array<{
      pool_size: number | string;
      aggregate_net_roi: number | string | null;
      aggregate_net_clv: number | string | null;
      n_tier_1: number | string;
      n_tier_2: number | string;
    }>)[0];
    if (pPlusRow) {
      result.path_p_plus.pool_size = Number(pPlusRow.pool_size ?? 0);
      result.path_p_plus.n_tier_1 = Number(pPlusRow.n_tier_1 ?? 0);
      result.path_p_plus.n_tier_2 = Number(pPlusRow.n_tier_2 ?? 0);
      result.path_p_plus.aggregate_net_roi =
        pPlusRow.aggregate_net_roi != null ? Number(pPlusRow.aggregate_net_roi) : null;
      result.path_p_plus.aggregate_net_clv =
        pPlusRow.aggregate_net_clv != null ? Number(pPlusRow.aggregate_net_clv) : null;
      result.path_p_plus.pool_pass = result.path_p_plus.pool_size >= 150;
      result.path_p_plus.roi_pass = (result.path_p_plus.aggregate_net_roi ?? 0) >= 0.03;
      result.path_p_plus.clv_pass = (result.path_p_plus.aggregate_net_clv ?? 0) >= 1.0;
      result.path_p_plus.all_pass =
        result.path_p_plus.pool_pass &&
        result.path_p_plus.roi_pass &&
        result.path_p_plus.clv_pass;
    }
  } catch (err) {
    // Path P+ views may not be migrated yet on first deploy — non-fatal.
    logger.warn({ err }, "gate_monitor: Path P+ evaluation failed (likely pre-migration) — skipping");
  }

  // Path S aggregate
  const sStatus = await db.execute(sql`SELECT * FROM path_s_aggregate_status`);
  const sRow = (((sStatus as any).rows ?? []) as Array<{
    pool_size_cleared: number | string;
    distinct_markets_cleared: number | string;
    aggregate_net_roi_cleared: number | string | null;
    path_s_n_pass: boolean;
    path_s_diversity_pass: boolean;
    path_s_roi_pass: boolean;
    path_s_aggregate_pass: boolean;
  }>)[0];
  if (sRow) {
    result.path_s.pool_size_cleared = Number(sRow.pool_size_cleared ?? 0);
    result.path_s.distinct_markets_cleared = Number(sRow.distinct_markets_cleared ?? 0);
    result.path_s.aggregate_net_roi_cleared = sRow.aggregate_net_roi_cleared != null ? Number(sRow.aggregate_net_roi_cleared) : null;
    result.path_s.n_pass = !!sRow.path_s_n_pass;
    result.path_s.diversity_pass = !!sRow.path_s_diversity_pass;
    result.path_s.roi_pass = !!sRow.path_s_roi_pass;
    result.path_s.aggregate_pass = !!sRow.path_s_aggregate_pass;
  }

  // Whitelist health (single-scope ≤80% rule)
  const wl = await db.execute(sql`
    SELECT path, market_type, league, n, scope_net_roi, scope_net_clv, share_of_agg_pnl
    FROM switchover_whitelist
  `);
  const wlRows = (((wl as any).rows ?? []) as Array<{
    path: string; market_type: string; league: string;
    n: number | string;
    scope_net_roi: number | string | null;
    scope_net_clv: number | string | null;
    share_of_agg_pnl: number | string | null;
  }>);
  result.whitelist_size = wlRows.length;
  result.whitelist_largest_share = wlRows.length === 0
    ? null
    : Math.max(...wlRows.map((r) => Number(r.share_of_agg_pnl ?? 0)));

  // Determine trigger
  const wlOk = result.whitelist_size >= 1 && (result.whitelist_largest_share ?? 0) <= 0.80;
  if (result.path_p.all_pass && wlOk) {
    result.trigger = "P";
  } else if (result.path_s.aggregate_pass && wlOk) {
    result.trigger = "S";
  }

  const manifest = {
    evaluated_at: result.evaluated_at,
    path_p: result.path_p,
    path_p_plus: result.path_p_plus,
    path_s: result.path_s,
    by_market: pRow?.by_market ?? null,
    whitelist: wlRows,
    whitelist_size: result.whitelist_size,
    whitelist_largest_share: result.whitelist_largest_share,
    bankroll: await getConfig("bankroll"),
    evaluation_start_at: evalStartStr,
    blockers_validated_at: await getConfig("blockers_validated_at"),
    trigger: result.trigger,
  };

  // Path P+ review row (Phase 3 C1): surfaces a manual-review signal when
  // Path P+ all_pass but Path P hasn't fired. Idempotent — at most one
  // unresolved row at a time. Does NOT auto-fire switchover.
  if (result.path_p_plus.all_pass && !result.trigger) {
    try {
      await db.execute(sql`
        INSERT INTO gate_status_review_required (reason, diagnostic)
        SELECT 'path_p_plus_clear_pending_review', ${JSON.stringify({
          path_p_plus: result.path_p_plus,
          path_p: result.path_p,
          path_s: result.path_s,
          evaluated_at: result.evaluated_at,
        })}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM gate_status_review_required
          WHERE reason = 'path_p_plus_clear_pending_review'
            AND acknowledged_at IS NULL
        )
      `);
    } catch (err) {
      logger.warn({ err }, "gate_monitor: failed to insert Path P+ review row");
    }
  }

  // Insert gate_status row
  await db.execute(sql`
    INSERT INTO gate_status (
      evaluated_at, pool_size, aggregate_net_roi, aggregate_net_clv,
      pool_size_pass, roi_pass, clv_pass, all_pass,
      whitelist_size, whitelist_largest_share, manifest
    ) VALUES (
      NOW(), ${result.path_p.pool_size},
      ${result.path_p.aggregate_net_roi}, ${result.path_p.aggregate_net_clv},
      ${result.path_p.pool_pass}, ${result.path_p.roi_pass}, ${result.path_p.clv_pass}, ${result.path_p.all_pass},
      ${result.whitelist_size}, ${result.whitelist_largest_share},
      ${JSON.stringify(manifest)}::jsonb
    )
  `);

  // Insert pending-review row if trigger fires and no unresolved row exists
  if (result.trigger) {
    const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const insertResult = await db.execute(sql`
      INSERT INTO gate_clear_pending_review (manifest_hash, manifest)
      SELECT ${hash}, ${JSON.stringify(manifest)}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM gate_clear_pending_review WHERE resolved_at IS NULL
      )
      RETURNING id
    `);
    result.pending_review_inserted = ((insertResult as any).rows ?? []).length > 0;
  }

  // 8-week diagnostic
  const elapsedDays = (Date.now() - new Date(evalStartStr).getTime()) / 86400000;
  if (elapsedDays >= 56 && !result.trigger) {
    const insertResult = await db.execute(sql`
      INSERT INTO gate_status_review_required (reason, diagnostic)
      SELECT 'gate_not_cleared_after_56_days', ${JSON.stringify(manifest)}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM gate_status_review_required
        WHERE reason = 'gate_not_cleared_after_56_days'
          AND detected_at > NOW() - INTERVAL '7 days'
          AND acknowledged_at IS NULL
      )
      RETURNING id
    `);
    result.diagnostic_inserted = ((insertResult as any).rows ?? []).length > 0;
  }

  // ── Post-flip continuous Path P/S graduation (A4.3) ──────────────────────
  // After live_mode_active='true', any new scope that meets Path P (n≥50,
  // ROI>0, CLV>0) or Path S (n≥400, ROI≥5%, time-ordered split-half ≥3%)
  // criteria gets added to live_whitelist as a new active row. Existing
  // active rows for the same (market_type, league) are NOT re-inserted —
  // continuous graduation is additive, not replacement.
  const liveModeActive = (await getConfig("live_mode_active")) === "true";
  if (liveModeActive) {
    const newGraduates = await db.execute(sql`
      WITH candidates AS (
        SELECT 'P' AS path, market_type, league, n, scope_net_roi, scope_net_clv, share_of_agg_pnl
        FROM switchover_whitelist
        UNION ALL
        SELECT 'S' AS path, market_type, league, n, net_roi AS scope_net_roi,
               NULL::numeric AS scope_net_clv, NULL::numeric AS share_of_agg_pnl
        FROM path_s_scope_status
        WHERE path_s_pass = true
      )
      INSERT INTO live_whitelist (path, market_type, league, n, scope_net_roi, scope_net_clv, share_of_agg_pnl, kelly_fraction_override, active)
      SELECT c.path, c.market_type, c.league, c.n, c.scope_net_roi, c.scope_net_clv, c.share_of_agg_pnl, 0.5, true
      FROM candidates c
      WHERE NOT EXISTS (
        SELECT 1 FROM live_whitelist w
        WHERE w.market_type = c.market_type
          AND w.league = c.league
          AND w.path = c.path
          AND w.active = true
      )
      RETURNING id, path, market_type, league
    `);
    const newRows = (((newGraduates as any).rows ?? []) as Array<{
      id: number; path: string; market_type: string; league: string;
    }>);
    if (newRows.length > 0) {
      logger.info(
        { count: newRows.length, scopes: newRows },
        "gate_monitor: post-flip continuous graduation — new scopes added to live_whitelist",
      );
      for (const ng of newRows) {
        await db.execute(sql`
          INSERT INTO stop_condition_actions (action_type, scope_path, market_type, league, reason, metric_name, metric_value, threshold_value)
          VALUES (
            'continuous_graduation', ${ng.path}, ${ng.market_type}, ${ng.league},
            ${`Path ${ng.path} scope newly cleared post-flip — added to live_whitelist at half-Kelly`},
            NULL, NULL, NULL
          )
        `);
      }
    }
  }

  logger.info(result, "gate_monitor evaluated");
  return result;
}
