/**
 * Pre-flip blocker #6: live auto-revert kill switch.
 *
 * Runs every 5 min. Three triggers; any trigger fires:
 *   1. UPDATE agent_config SET value='false' WHERE key='live_placement_enabled'
 *   2. UPDATE agent_config SET value=<reason> WHERE key='auto_disable_reason'
 *   3. INSERT INTO compliance_logs (action_type='live_auto_revert', ...)
 *   4. invalidateLivePlacementFlagCache()
 *
 * Re-enable is operator-only via npm run live-resume -- --confirm-reason="...".
 *
 * Triggers:
 *   A) Betfair API failure rate >10% in rolling 15-min window (n>=20).
 *   C) Daily reconciliation drift > £20 abs OR > 0.5% relative.
 *   D) Idempotency anomaly — two live paper_bets rows with the same
 *      BAO-${id} customerRef pointing at distinct betfair_bet_ids.
 *
 * Trigger B (cumulative ROI) intentionally not included — daily/weekly
 * loss limits already cover drawdown.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { invalidateLivePlacementFlagCache } from "./livePlacementGate";

export type AutoRevertTrigger = "A" | "C" | "D";

export interface AutoRevertEvaluation {
  evaluatedAt: string;
  triggers: { A: boolean; C: boolean; D: boolean };
  details: {
    A?: { errors: number; total: number; rate: number | null };
    C?: { localPnl: number; betfairPnl: number; absDrift: number; pctDrift: number | null };
    D?: { duplicates: Array<{ customerRef: string; distinct_orders: number }> };
  };
  fired: boolean;
  reason: string | null;
  alreadyOff: boolean;
}

async function getLivePlacementEnabledRaw(): Promise<boolean> {
  const r = await db.execute(sql`SELECT value FROM agent_config WHERE key='live_placement_enabled' LIMIT 1`);
  const v = (((r as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
  return (v ?? "").toLowerCase().trim() === "true";
}

async function evalTriggerA(): Promise<{ fire: boolean; errors: number; total: number; rate: number | null }> {
  const r = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE action_type='betfair_api_error')   AS errors,
      COUNT(*) FILTER (WHERE action_type LIKE 'betfair_api_%') AS total
    FROM compliance_logs WHERE timestamp > NOW() - INTERVAL '15 minutes'
  `);
  const row = (((r as any).rows ?? []) as Array<{ errors: string | number; total: string | number }>)[0];
  const errors = Number(row?.errors ?? 0);
  const total = Number(row?.total ?? 0);
  const rate = total > 0 ? errors / total : null;
  return { fire: total >= 20 && rate != null && rate > 0.10, errors, total, rate };
}

async function evalTriggerC(): Promise<{ fire: boolean; localPnl: number; betfairPnl: number; absDrift: number; pctDrift: number | null }> {
  const r = await db.execute(sql`
    SELECT
      COALESCE(SUM(net_pnl)::float8, 0)     AS local_pnl,
      COALESCE(SUM(betfair_pnl)::float8, 0) AS betfair_pnl
    FROM paper_bets
    WHERE bet_track='live' AND status IN ('won','lost')
      AND settled_at > NOW() - INTERVAL '24 hours'
  `);
  const row = (((r as any).rows ?? []) as Array<{ local_pnl: number; betfair_pnl: number }>)[0];
  const localPnl = Number(row?.local_pnl ?? 0);
  const betfairPnl = Number(row?.betfair_pnl ?? 0);
  const absDrift = Math.abs(localPnl - betfairPnl);
  const pctDrift = Math.abs(betfairPnl) > 0 ? absDrift / Math.abs(betfairPnl) : null;
  const fire = absDrift > 20 || (pctDrift != null && pctDrift > 0.005);
  return { fire, localPnl, betfairPnl, absDrift, pctDrift };
}

async function evalTriggerD(): Promise<{ fire: boolean; duplicates: Array<{ customerRef: string; distinct_orders: number }> }> {
  const r = await db.execute(sql`
    SELECT (cl.details->>'customerRef') AS customer_ref,
           COUNT(DISTINCT pb.betfair_bet_id) AS distinct_orders
    FROM compliance_logs cl
    JOIN paper_bets pb ON pb.betfair_bet_id IS NOT NULL
      AND (cl.details->>'customerRef') = CONCAT('BAO-', pb.id)
    WHERE cl.action_type IN ('live_bet_placement_success','live_bet_placement_failed')
    GROUP BY 1
    HAVING COUNT(DISTINCT pb.betfair_bet_id) > 1
    LIMIT 20
  `);
  const rows = (((r as any).rows ?? []) as Array<{ customer_ref: string; distinct_orders: string | number }>);
  const duplicates = rows.map((x) => ({ customerRef: x.customer_ref, distinct_orders: Number(x.distinct_orders) }));
  return { fire: duplicates.length > 0, duplicates };
}

async function disableLivePlacement(reason: string, evaluation: AutoRevertEvaluation): Promise<void> {
  await db.execute(sql`
    INSERT INTO agent_config(key, value, updated_at)
    VALUES ('live_placement_enabled', 'false', NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
  `);
  await db.execute(sql`
    INSERT INTO agent_config(key, value, updated_at)
    VALUES ('auto_disable_reason', ${reason}, NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
  `);
  await db.execute(sql`
    INSERT INTO agent_config(key, value, updated_at)
    VALUES ('last_auto_disable_at', ${new Date().toISOString()}, NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
  `);
  await db.execute(sql`
    INSERT INTO compliance_logs (action_type, details, timestamp)
    VALUES ('live_auto_revert',
      ${JSON.stringify({ reason, evaluation })}::jsonb,
      NOW())
  `);
  invalidateLivePlacementFlagCache();
}

export async function runLiveAutoRevert(): Promise<AutoRevertEvaluation> {
  const enabled = await getLivePlacementEnabledRaw();
  const evaluation: AutoRevertEvaluation = {
    evaluatedAt: new Date().toISOString(),
    triggers: { A: false, C: false, D: false },
    details: {},
    fired: false,
    reason: null,
    alreadyOff: !enabled,
  };

  if (!enabled) {
    return evaluation;
  }

  const [a, c, d] = await Promise.all([evalTriggerA(), evalTriggerC(), evalTriggerD()]);
  evaluation.triggers.A = a.fire;
  evaluation.triggers.C = c.fire;
  evaluation.triggers.D = d.fire;
  evaluation.details.A = { errors: a.errors, total: a.total, rate: a.rate };
  evaluation.details.C = { localPnl: c.localPnl, betfairPnl: c.betfairPnl, absDrift: c.absDrift, pctDrift: c.pctDrift };
  evaluation.details.D = { duplicates: d.duplicates };

  const reasons: string[] = [];
  if (a.fire) reasons.push(`A: betfair_api_error rate ${(a.rate! * 100).toFixed(1)}% (${a.errors}/${a.total}) > 10% in 15min window`);
  if (c.fire) reasons.push(`C: reconciliation drift abs=£${c.absDrift.toFixed(2)} pct=${c.pctDrift != null ? (c.pctDrift * 100).toFixed(3) + "%" : "n/a"} > thresholds (£20 abs or 0.5% rel)`);
  if (d.fire) reasons.push(`D: idempotency anomaly — ${d.duplicates.length} customerRef(s) with multiple distinct betfair_bet_id`);

  if (reasons.length > 0) {
    const reason = reasons.join(" | ");
    evaluation.fired = true;
    evaluation.reason = reason;
    logger.error({ reason, evaluation }, "LIVE AUTO-REVERT firing — disabling live placement");
    await disableLivePlacement(reason, evaluation);
  }

  return evaluation;
}
