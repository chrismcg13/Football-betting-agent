/**
 * F2.A.27 (2026-05-20) — auto-gate for F2.A.25 inversion-direct bypass.
 *
 * The inversion-direct bypass at paperTrading.ts:1444 is contingent on
 * F2.A.23 emission-stage Pinnacle freshness gate actually working — i.e.,
 * placements should overwhelmingly have a real Pinnacle anchor for their
 * exact selection within the TTK freshness window. If the freshness gate
 * is broken or stale-allowed, F2.A.25 makes things worse by placing live
 * faster against bad anchors.
 *
 * This cron-based check runs every 15min:
 *   - Sample last 2h of placements (any track)
 *   - Count how many have NO Pinnacle snapshot ±15min for exact selection
 *   - If sample < MIN_SAMPLE_SIZE → leave config unchanged (insufficient evidence)
 *   - If no_anchor_rate > MAX_ALLOWED_RATE → set bypass_enabled = false
 *   - Else → set bypass_enabled = true
 *
 * Safe default: config starts unset/false. paperTrading.ts treats absent
 * or false as "fall back to v_live_eligibility gate" (pre-F2.A.25 behaviour).
 * The bypass only activates when this check explicitly flips it on.
 */

import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { setConfigValue, getConfigValue } from "./paperTrading";

const SAMPLE_WINDOW_HOURS = 2;
const ANCHOR_WINDOW_SECONDS = 900; // matches F2.A.23 BASE column max (24h+ TTK)
const MIN_SAMPLE_SIZE = 30;
const MAX_ALLOWED_NO_ANCHOR_RATE = 0.10; // 10% leak tolerance

export interface HealthGateResult {
  sample_size: number;
  no_anchor_count: number;
  no_anchor_rate: number;
  threshold: number;
  bypass_enabled_before: boolean;
  bypass_enabled_after: boolean;
  decision_reason: string;
  duration_ms: number;
}

export async function runF2A25HealthGate(): Promise<HealthGateResult> {
  const startedAt = Date.now();

  const beforeRaw = await getConfigValue("f2a25_inversion_bypass_enabled");
  const bypassEnabledBefore = beforeRaw === "true";

  const rowsQ = await db.execute(sql`
    WITH recent AS (
      SELECT pb.id, pb.match_id, pb.market_type, pb.selection_name, pb.placed_at
      FROM paper_bets pb
      WHERE pb.placed_at >= NOW() - INTERVAL '${sql.raw(String(SAMPLE_WINDOW_HOURS))} hours'
        AND pb.placed_at < NOW() - INTERVAL '5 minutes' -- exclude bets so recent the anchor may still be inserting
        AND pb.deleted_at IS NULL
    )
    SELECT
      COUNT(*)::int AS sample,
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM odds_snapshots os
        WHERE os.match_id = r.match_id
          AND os.market_type = r.market_type
          AND os.selection_name = r.selection_name
          AND os.source ILIKE '%pinnacle%'
          AND ABS(EXTRACT(EPOCH FROM (r.placed_at - os.snapshot_time))) < ${ANCHOR_WINDOW_SECONDS}
      ))::int AS no_anchor
    FROM recent r
  `);
  const row = (((rowsQ as { rows?: Array<{ sample: number; no_anchor: number }> }).rows ?? [])[0]) ?? { sample: 0, no_anchor: 0 };

  const sampleSize = row.sample;
  const noAnchorCount = row.no_anchor;
  const rate = sampleSize > 0 ? noAnchorCount / sampleSize : 0;

  let bypassEnabledAfter = bypassEnabledBefore;
  let decisionReason = "no_change";

  if (sampleSize < MIN_SAMPLE_SIZE) {
    decisionReason = `insufficient_sample_${sampleSize}_lt_${MIN_SAMPLE_SIZE}`;
  } else if (rate > MAX_ALLOWED_NO_ANCHOR_RATE) {
    if (bypassEnabledBefore) {
      bypassEnabledAfter = false;
      decisionReason = `disabled_rate_${rate.toFixed(3)}_gt_${MAX_ALLOWED_NO_ANCHOR_RATE}`;
      await setConfigValue("f2a25_inversion_bypass_enabled", "false");
    } else {
      decisionReason = `staying_disabled_rate_${rate.toFixed(3)}`;
    }
  } else {
    if (!bypassEnabledBefore) {
      bypassEnabledAfter = true;
      decisionReason = `enabled_rate_${rate.toFixed(3)}_le_${MAX_ALLOWED_NO_ANCHOR_RATE}`;
      await setConfigValue("f2a25_inversion_bypass_enabled", "true");
    } else {
      decisionReason = `staying_enabled_rate_${rate.toFixed(3)}`;
    }
  }

  const result: HealthGateResult = {
    sample_size: sampleSize,
    no_anchor_count: noAnchorCount,
    no_anchor_rate: rate,
    threshold: MAX_ALLOWED_NO_ANCHOR_RATE,
    bypass_enabled_before: bypassEnabledBefore,
    bypass_enabled_after: bypassEnabledAfter,
    decision_reason: decisionReason,
    duration_ms: Date.now() - startedAt,
  };

  logger.info(result, "F2.A.27 health-gate check complete");

  if (bypassEnabledBefore !== bypassEnabledAfter) {
    void db.insert(complianceLogsTable).values({
      actionType: "f2a25_bypass_state_change",
      details: result as unknown as Record<string, unknown>,
      timestamp: new Date(),
    });
    logger.warn(
      { from: bypassEnabledBefore, to: bypassEnabledAfter, rate, sampleSize },
      "F2.A.25 inversion-direct bypass state changed by F2.A.27 health gate",
    );
  }

  return result;
}
