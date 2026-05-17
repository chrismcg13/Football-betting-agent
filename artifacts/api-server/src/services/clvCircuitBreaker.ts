/**
 * CLV circuit breaker — Bundle 5.L (2026-05-17)
 *
 * Leading-indicator complement to the existing drawdown breakers. Every
 * 15 minutes (when the cron tick fires), reads v_clv_health_rolling and
 * checks per-market_type stake-weighted CLV against the configured
 * threshold (agent_config.clv_circuit_breaker_threshold, default 0.0pp).
 *
 * If a market_type's rolling-100-bet stake-weighted CLV falls BELOW the
 * threshold, the breaker sets agent_config.clv_paused_<market_type> =
 * 'true'. The inversion gate (inversionPipeline.evaluateInversionGate)
 * reads this flag in Stage 1 and demotes shadow on the affected
 * market_type only — other market_types continue placement unchanged.
 *
 * Auto-pause, MANUAL unpause: per the locked spec, even if CLV recovers
 * the flag stays set until the operator clears it via
 * /api/admin/set-config. This forces a human review of edge-decay
 * incidents rather than allowing silent re-engagement.
 *
 * Telemetry only pre-activation: the breaker writes pause flags
 * regardless of inversion_pipeline_enabled. Pre-activation those flags
 * have no behavioural effect (the gate is shadow-only). Post-activation
 * they gate real placement. This lets us observe the breaker's
 * behaviour for days before it controls real money.
 */

import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getConfigValue, setConfigValue } from "./paperTrading";

export interface ClvHealthRow {
  market_type: string;
  n: number;
  mean_clv_pct: number;
  stake_weighted_clv_pct: number;
  p25_clv_pct: number;
  p75_clv_pct: number;
}

export interface ClvBreakerResult {
  evaluated_at: string;
  threshold_pp: number;
  markets_evaluated: number;
  markets_paused_now: string[];
  markets_already_paused: string[];
  markets_healthy: number;
  /** Markets with n < min_sample_for_breaker — too thin to trip the breaker either way. */
  markets_insufficient_sample: string[];
}

/** Min sample size for the breaker to trip. Sparse market types stay un-paused. */
const MIN_SAMPLE_FOR_BREAKER = 30;

/**
 * Construct the agent_config key for a market_type's pause flag. Market
 * types are upper-cased (matching their canonical form in paper_bets);
 * the lookup at the gate side does the same upper-case normalisation.
 */
export function clvPausedConfigKey(marketType: string): string {
  return `clv_paused_${marketType.toUpperCase()}`;
}

export async function isMarketClvPaused(marketType: string): Promise<boolean> {
  const raw = (await getConfigValue(clvPausedConfigKey(marketType)))?.toLowerCase()?.trim();
  return raw === "true";
}

export async function runClvCircuitBreaker(): Promise<ClvBreakerResult> {
  const result: ClvBreakerResult = {
    evaluated_at: new Date().toISOString(),
    threshold_pp: 0.0,
    markets_evaluated: 0,
    markets_paused_now: [],
    markets_already_paused: [],
    markets_healthy: 0,
    markets_insufficient_sample: [],
  };

  const thresholdRaw = await getConfigValue("clv_circuit_breaker_threshold");
  const threshold = thresholdRaw != null ? Number(thresholdRaw) : 0.0;
  if (!Number.isFinite(threshold)) {
    logger.warn(
      { thresholdRaw },
      "clvCircuitBreaker: invalid threshold in config — using 0.0 default",
    );
  }
  result.threshold_pp = Number.isFinite(threshold) ? threshold : 0.0;

  let rows: ClvHealthRow[] = [];
  try {
    const r = await db.execute(sql`
      SELECT
        market_type,
        n,
        mean_clv_pct::float8 AS mean_clv_pct,
        stake_weighted_clv_pct::float8 AS stake_weighted_clv_pct,
        p25_clv_pct::float8 AS p25_clv_pct,
        p75_clv_pct::float8 AS p75_clv_pct
      FROM v_clv_health_rolling
      ORDER BY n DESC
    `);
    rows = ((r as any).rows ?? []) as ClvHealthRow[];
  } catch (err) {
    // View missing (pre-migration deploy) or query failed. Never auto-pause
    // on telemetry failure — the absence of evidence isn't evidence of
    // absence. Log and exit cleanly.
    logger.warn({ err }, "clvCircuitBreaker: v_clv_health_rolling query failed — skipping");
    return result;
  }

  result.markets_evaluated = rows.length;

  for (const row of rows) {
    if (row.n < MIN_SAMPLE_FOR_BREAKER) {
      result.markets_insufficient_sample.push(row.market_type);
      continue;
    }
    const alreadyPaused = await isMarketClvPaused(row.market_type);
    const swclv = row.stake_weighted_clv_pct;
    if (Number.isFinite(swclv) && swclv < result.threshold_pp) {
      if (alreadyPaused) {
        result.markets_already_paused.push(row.market_type);
        continue;
      }
      // Trip the breaker. setConfigValue is the canonical write path —
      // honours the read-through cache and logs the change.
      try {
        await setConfigValue(clvPausedConfigKey(row.market_type), "true");
        result.markets_paused_now.push(row.market_type);
        // Audit row — operator will see this in compliance_logs when
        // reviewing why a market_type went silent on placement.
        await db.insert(complianceLogsTable).values({
          actionType: "clv_circuit_breaker_tripped",
          details: {
            marketType: row.market_type,
            n: row.n,
            stakeWeightedClvPct: row.stake_weighted_clv_pct,
            meanClvPct: row.mean_clv_pct,
            p25ClvPct: row.p25_clv_pct,
            p75ClvPct: row.p75_clv_pct,
            thresholdPp: result.threshold_pp,
            configKey: clvPausedConfigKey(row.market_type),
            unpauseInstruction:
              "Manual unpause: POST /api/admin/set-config with " +
              `{ key: '${clvPausedConfigKey(row.market_type)}', value: 'false' } ` +
              "AFTER human review of the CLV-decay incident",
          } as Record<string, unknown>,
          timestamp: new Date(),
        });
        logger.error(
          {
            marketType: row.market_type,
            n: row.n,
            stakeWeightedClvPct: row.stake_weighted_clv_pct,
            thresholdPp: result.threshold_pp,
          },
          "CLV circuit breaker TRIPPED — market_type paused until manual review",
        );
      } catch (err) {
        logger.error(
          { err, marketType: row.market_type },
          "clvCircuitBreaker: failed to set pause flag — market remains active",
        );
      }
    } else {
      if (alreadyPaused) {
        // CLV has recovered but spec is explicit: auto-pause, manual
        // unpause. We do NOT auto-clear the flag. Log so the operator
        // sees the recovery in compliance_logs and can make the call.
        result.markets_already_paused.push(row.market_type);
        logger.info(
          {
            marketType: row.market_type,
            stakeWeightedClvPct: row.stake_weighted_clv_pct,
            thresholdPp: result.threshold_pp,
          },
          "CLV recovered above threshold but market remains paused — awaiting manual unpause",
        );
      } else {
        result.markets_healthy++;
      }
    }
  }

  return result;
}
