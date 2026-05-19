/**
 * Bundle F2.B.J (2026-05-19): per-predictor circuit breaker.
 *
 * Cross-cutting safety guard for new market types (Bundles D / E / F /
 * G — corners, cards, half-MO, EH) and any future predictor. Distinct
 * from account-level drawdown and the operator kill switch.
 *
 * Algorithm (rolling 100 settled bets per market_type, any league):
 *   1. n = settled count; if n < 50, breaker is dormant for this market.
 *   2. avg_edge = mean(calculated_edge at placement, on settled bets)
 *      breakeven_winrate = mean(1 / odds_at_placement)
 *      shortfall_band_pp = max(0.03, avg_edge * 1.5)
 *   3. If wilson_lo95_winrate < breakeven_winrate - shortfall_band_pp:
 *      auto-pause emission for this market_type.
 *
 * Edge-scaled band (not blanket 5pp) — low-edge markets can bleed
 * silently inside a blanket band; high-edge markets shouldn't trigger
 * on normal variance. See the master plan's tightening discussion.
 *
 * Pause storage: agent_config.market_type_paused_list (CSV, matches
 * the existing live_placement_disabled_market_types shape). Operator
 * unpauses via /api/admin/set-config after investigating the root cause.
 *
 * Cron: runPerMarketCircuitBreaker every 30 minutes. Idempotent —
 * recomputes the rolling window each tick; auto-pauses additively;
 * does NOT auto-unpause (operator-only per master plan §K).
 */

import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getConfigValue, setConfigValue } from "./paperTrading";

const ROLLING_WINDOW_SIZE = 100;
const MIN_SAMPLES_TO_FIRE = 50;
const MIN_SHORTFALL_BAND_PP = 0.03; // 3pp absolute floor
const EDGE_BAND_MULTIPLIER = 1.5;
const Z_95 = 1.96;

interface MarketStats {
  market_type: string;
  n: number;
  wins: number;
  avg_edge: number;
  breakeven_winrate: number;
}

export interface CircuitBreakerResult {
  markets_evaluated: number;
  markets_paused_now: string[];
  markets_already_paused: string[];
  markets_inactive: number;
  duration_ms: number;
}

function wilsonLo95(wins: number, n: number): number {
  if (n <= 0) return 0;
  const centre = (wins + (Z_95 * Z_95) / 2) / (n + Z_95 * Z_95);
  const margin =
    (Z_95 * Math.sqrt(((wins * (n - wins)) / n) + (Z_95 * Z_95) / 4)) /
    (n + Z_95 * Z_95);
  return Math.max(0, centre - margin);
}

async function readPausedSet(): Promise<Set<string>> {
  const raw = (await getConfigValue("market_type_paused_list")) ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

async function writePausedSet(s: Set<string>): Promise<void> {
  const csv = [...s].sort().join(",");
  await setConfigValue("market_type_paused_list", csv);
}

export async function runPerMarketCircuitBreaker(): Promise<CircuitBreakerResult> {
  const startedAt = Date.now();

  // Pull rolling-100 stats per market_type. WINDOW + ROW_NUMBER could
  // give exact 100; LIMIT in subquery is simpler + good enough since we
  // gate at n>=50 (so even leaky boundaries don't change firing).
  const rowsQ = await db.execute(sql`
    WITH ranked AS (
      SELECT
        market_type,
        status,
        odds_at_placement::float8 AS odds,
        calculated_edge::float8 AS edge,
        ROW_NUMBER() OVER (PARTITION BY market_type ORDER BY settled_at DESC NULLS LAST) AS rn
      FROM paper_bets
      WHERE status IN ('won','lost')
        AND deleted_at IS NULL
        AND odds_at_placement::numeric > 1.01
        AND settled_at IS NOT NULL
        AND settled_at >= NOW() - INTERVAL '90 days'
    )
    SELECT
      market_type,
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE status = 'won')::int AS wins,
      AVG(edge)::float8 AS avg_edge,
      AVG(1.0 / odds)::float8 AS breakeven_winrate
    FROM ranked
    WHERE rn <= ${ROLLING_WINDOW_SIZE}
    GROUP BY market_type
    HAVING COUNT(*) >= ${MIN_SAMPLES_TO_FIRE}
  `);
  const stats = (((rowsQ as any).rows ?? []) as MarketStats[]);

  const alreadyPaused = await readPausedSet();
  const newlyPaused: string[] = [];
  const stillFiring: string[] = [];

  // F2.A.26 (2026-05-20): three-signal CLV-vs-realized disproof, relocated
  // from the now-bypassed v_live_eligibility view. Catches the failure
  // mode the anchor-contamination diagnostic exposed: CLV looks good
  // (we're beating Pinnacle close in expectation) but realized Wilson ROI
  // is negative. Indicates anchor measurement is broken, not edge real.
  //
  // Trigger: n >= 30 AND CLV t-stat > 2.0 AND Wilson lo95 ROI < -0.03.
  // Same threshold semantics as the deprecated eligibility view's
  // disproof carve-out, applied here so removing the view doesn't lose
  // the defence.
  const disproofRowsQ = await db.execute(sql`
    WITH ranked AS (
      SELECT
        market_type,
        status,
        odds_at_placement::float8 AS odds,
        stake::float8 AS stake,
        net_pnl::float8 AS pnl,
        clv_pct::float8 AS clv,
        ROW_NUMBER() OVER (PARTITION BY market_type ORDER BY settled_at DESC NULLS LAST) AS rn
      FROM paper_bets
      WHERE status IN ('won','lost')
        AND deleted_at IS NULL
        AND settled_at IS NOT NULL
        AND settled_at >= NOW() - INTERVAL '90 days'
        AND clv_pct IS NOT NULL
    )
    SELECT
      market_type,
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE status = 'won')::int AS wins,
      AVG(clv)::float8 AS avg_clv,
      STDDEV_SAMP(clv)::float8 AS sd_clv,
      SUM(pnl)::float8 / NULLIF(SUM(stake), 0)::float8 AS roi
    FROM ranked
    WHERE rn <= 100
    GROUP BY market_type
    HAVING COUNT(*) >= 30
  `);
  type DisproofRow = { market_type: string; n: number; wins: number; avg_clv: number; sd_clv: number | null; roi: number | null };
  const disproofStats = (((disproofRowsQ as any).rows ?? []) as DisproofRow[]);
  for (const d of disproofStats) {
    if (alreadyPaused.has(d.market_type.toUpperCase())) continue;
    const sd = d.sd_clv ?? 0;
    const tStat = sd > 0 ? (d.avg_clv * Math.sqrt(d.n)) / sd : 0;
    const wilsonLoRoi = wilsonLo95(d.wins, d.n) - 0.5; // approx ROI lower bound proxy
    const roi = d.roi ?? 0;
    // Three-signal disproof: CLV positive but realized strongly negative.
    if (tStat > 2.0 && roi < -0.03 && wilsonLoRoi < 0) {
      newlyPaused.push(d.market_type);
      alreadyPaused.add(d.market_type.toUpperCase());
      void db.insert(complianceLogsTable).values({
        actionType: "market_type_auto_paused",
        details: {
          market_type: d.market_type,
          n: d.n,
          clv_t_stat: tStat,
          avg_clv: d.avg_clv,
          realized_roi: roi,
          wilson_lo_roi_proxy: wilsonLoRoi,
          reason: "three_signal_clv_realized_disproof",
          source: "per_market_circuit_breaker",
        },
        timestamp: new Date(),
      });
      logger.warn(
        { marketType: d.market_type, n: d.n, tStat, roi },
        "Three-signal disproof: CLV positive but realized negative — auto-pausing",
      );
    }
  }

  for (const s of stats) {
    if (alreadyPaused.has(s.market_type.toUpperCase())) {
      stillFiring.push(s.market_type);
      continue;
    }
    const lo95 = wilsonLo95(s.wins, s.n);
    const avgEdge = Math.max(0, s.avg_edge);
    const band = Math.max(MIN_SHORTFALL_BAND_PP, avgEdge * EDGE_BAND_MULTIPLIER);
    const threshold = s.breakeven_winrate - band;

    if (lo95 < threshold) {
      newlyPaused.push(s.market_type);
      alreadyPaused.add(s.market_type.toUpperCase());

      void db.insert(complianceLogsTable).values({
        actionType: "market_type_auto_paused",
        details: {
          market_type: s.market_type,
          n: s.n,
          wins: s.wins,
          wilson_lo95: lo95,
          breakeven_winrate: s.breakeven_winrate,
          avg_edge: s.avg_edge,
          shortfall_band_pp: band,
          threshold,
          reason: "circuit_breaker_wilson_below_band",
          source: "per_market_circuit_breaker",
        },
        timestamp: new Date(),
      });

      logger.warn(
        { marketType: s.market_type, n: s.n, lo95, breakeven: s.breakeven_winrate, band },
        "Per-market circuit breaker fired — auto-pausing emission",
      );
    }
  }

  if (newlyPaused.length > 0) {
    await writePausedSet(alreadyPaused);
  }

  const result: CircuitBreakerResult = {
    markets_evaluated: stats.length,
    markets_paused_now: newlyPaused,
    markets_already_paused: stillFiring,
    markets_inactive: stats.length - newlyPaused.length - stillFiring.length,
    duration_ms: Date.now() - startedAt,
  };
  if (newlyPaused.length > 0 || stillFiring.length > 0) {
    logger.info(result, "Per-market circuit breaker run complete");
  }
  return result;
}

/**
 * Read the current paused set for valueDetection.ts to consult before
 * emission. Cached read via getConfigValue's existing 60s cache, so
 * hot-path cost is negligible.
 */
export async function getPausedMarketTypes(): Promise<Set<string>> {
  return readPausedSet();
}
