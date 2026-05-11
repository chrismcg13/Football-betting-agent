/**
 * Bundle B analytics — Tasks 3, 5, 6, 7, 9 from the theory-plan rebake
 * (docs/back to theory plan 11.5.26.md).
 *
 * Nightly job. Recomputes per-segment stats and signal-strength verdicts
 * for every (league, market_type, bet_track) that has at least 1 settled
 * bet since the analysis-window start. Read-only against `paper_bets`;
 * writes to `analysis_segment_stats` and `analysis_signal_strength`.
 *
 * One snapshot per run, identified by `computed_at`. Composite PK keeps
 * history. Operator reads via `v_live_eligibility_candidates`.
 *
 * Live-eligibility verdict:
 *   - n >= 30 floor
 *   - qualifies on ROI       if wilson_lo95_winrate > 50
 *   - qualifies on CLV       if clv_t_stat > 1.96 AND avg_clv > 0
 *   - qualification_basis    is 'roi' | 'clv' | 'both' | 'insufficient'
 *
 * Shrinkage prior (Bayesian per Task 9):
 *   - league × market scope shrinks toward the market-type-global mean ROI
 *     with n_prior = 30 effective samples.
 */

import { db, agentConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const DEFAULT_ANALYSIS_START_DATE = "2026-05-03";
const N_FLOOR = 30;
const SHRINKAGE_N_PRIOR = 30;
const CLV_T_THRESHOLD = 1.96;
const WILSON_WINRATE_THRESHOLD = 0.50;

async function getAnalysisStartDate(): Promise<string> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, "analysis_start_date"));
  return rows[0]?.value ?? DEFAULT_ANALYSIS_START_DATE;
}

export interface BundleBResult {
  computed_at: string;
  segment_rows: number;
  signal_rows: number;
  qualifies_live: number;
  duration_ms: number;
}

export async function runBundleBAnalytics(): Promise<BundleBResult> {
  const startedAt = Date.now();
  const computedAt = new Date();
  const analysisStart = await getAnalysisStartDate();

  logger.info({ analysisStart, computedAt }, "Bundle B analytics starting");

  // Step 1: segment-level stats. One row per (league, market_type, bet_track)
  // with n >= 1 settled bet. PnL/stake column resolved per-rail at compute
  // time so shadow uses shadow_*, live/paper uses net/settlement.
  const segmentInsert = await db.execute(sql`
    INSERT INTO analysis_segment_stats
      (computed_at, league, market_type, bet_track, n, w, stake, pnl, avg_clv, sd_clv, clv_n)
    SELECT
      ${computedAt}::timestamptz                                   AS computed_at,
      COALESCE(m.league, '__unknown__')                            AS league,
      pb.market_type,
      pb.bet_track,
      COUNT(*)::int                                                AS n,
      COUNT(*) FILTER (WHERE pb.status = 'won')::int               AS w,
      SUM(CASE WHEN pb.bet_track = 'shadow'
               THEN COALESCE(pb.shadow_stake, 0)
               ELSE pb.stake END)::numeric                          AS stake,
      SUM(CASE WHEN pb.bet_track = 'shadow'
               THEN COALESCE(pb.shadow_pnl, 0)
               ELSE COALESCE(pb.net_pnl, pb.settlement_pnl, 0) END)::numeric AS pnl,
      AVG(pb.clv_pct)::numeric                                     AS avg_clv,
      STDDEV(pb.clv_pct)::numeric                                  AS sd_clv,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL)::int          AS clv_n
    FROM paper_bets pb
    LEFT JOIN matches m ON pb.match_id = m.id
    WHERE pb.placed_at >= ${analysisStart}::date
      AND pb.deleted_at IS NULL
      AND pb.status IN ('won', 'lost')
    GROUP BY m.league, pb.market_type, pb.bet_track
  `);
  const segmentRows = (segmentInsert as { rowCount: number }).rowCount ?? 0;

  // Step 2: signal-strength verdicts. Computes per-market prior inline via
  // a CTE (avoids cross-connection temp-table issues with pooled execute).
  const signalInsert = await db.execute(sql`
    WITH priors AS (
      SELECT
        market_type,
        SUM(pnl) / NULLIF(SUM(stake), 0) AS mean_roi
      FROM analysis_segment_stats
      WHERE computed_at = ${computedAt}::timestamptz
      GROUP BY market_type
    )
    INSERT INTO analysis_signal_strength
      (computed_at, league, market_type, bet_track, n,
       win_rate, wilson_lo95_winrate, roi, shrunk_roi,
       avg_clv, clv_t_stat, qualifies_live, qualification_basis)
    SELECT
      s.computed_at,
      s.league,
      s.market_type,
      s.bet_track,
      s.n,
      (s.w::numeric / NULLIF(s.n, 0))                                          AS win_rate,
      -- Wilson 95% lower bound on win rate
      ((s.w + 1.92) / (s.n + 3.84)
        - 1.96 * SQRT((s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                      / (s.n + 3.84)) / (s.n + 3.84))                          AS wilson_lo95_winrate,
      (s.pnl / NULLIF(s.stake, 0))                                             AS roi,
      -- Bayesian shrunk ROI: weight observed ROI vs market-global prior
      CASE
        WHEN s.stake IS NULL OR s.stake = 0 THEN p.mean_roi
        ELSE
          (s.n::numeric / (s.n + ${SHRINKAGE_N_PRIOR})) * (s.pnl / NULLIF(s.stake, 0))
          + (${SHRINKAGE_N_PRIOR}::numeric / (s.n + ${SHRINKAGE_N_PRIOR})) * COALESCE(p.mean_roi, 0)
      END                                                                     AS shrunk_roi,
      s.avg_clv,
      -- One-sample t-stat for avg_clv vs zero
      CASE
        WHEN s.sd_clv IS NULL OR s.sd_clv = 0 OR s.clv_n < 2 THEN NULL
        ELSE (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv
      END                                                                     AS clv_t_stat,
      -- Qualifies live?
      (
        s.n >= ${N_FLOOR}
        AND s.pnl > 0
        AND (
          ((s.w + 1.92) / (s.n + 3.84)
            - 1.96 * SQRT((s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                          / (s.n + 3.84)) / (s.n + 3.84)) > ${WILSON_WINRATE_THRESHOLD}
          OR (
            s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
            AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > ${CLV_T_THRESHOLD}
            AND s.avg_clv > 0
          )
        )
      )                                                                       AS qualifies_live,
      -- Basis label
      CASE
        WHEN s.n < ${N_FLOOR} THEN 'insufficient'
        WHEN s.pnl <= 0 THEN 'insufficient'
        ELSE
          CASE
            WHEN
              ((s.w + 1.92) / (s.n + 3.84)
                - 1.96 * SQRT((s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                              / (s.n + 3.84)) / (s.n + 3.84)) > ${WILSON_WINRATE_THRESHOLD}
              AND s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
              AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > ${CLV_T_THRESHOLD}
              AND s.avg_clv > 0
            THEN 'both'
            WHEN
              ((s.w + 1.92) / (s.n + 3.84)
                - 1.96 * SQRT((s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                              / (s.n + 3.84)) / (s.n + 3.84)) > ${WILSON_WINRATE_THRESHOLD}
            THEN 'roi'
            WHEN
              s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
              AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > ${CLV_T_THRESHOLD}
              AND s.avg_clv > 0
            THEN 'clv'
            ELSE 'insufficient'
          END
      END                                                                     AS qualification_basis
    FROM analysis_segment_stats s
    LEFT JOIN priors p ON p.market_type = s.market_type
    WHERE s.computed_at = ${computedAt}::timestamptz
  `);
  const signalRows = (signalInsert as { rowCount: number }).rowCount ?? 0;

  // Step 3: count qualifying segments for the log line.
  const qRes = await db.execute(sql`
    SELECT COUNT(*)::int AS q
    FROM analysis_signal_strength
    WHERE computed_at = ${computedAt}::timestamptz
      AND qualifies_live = TRUE
  `);
  const qualifiesLive =
    ((((qRes as unknown) as { rows?: Array<{ q: number }> }).rows ?? [])[0]?.q) ?? 0;

  const durationMs = Date.now() - startedAt;
  const result: BundleBResult = {
    computed_at: computedAt.toISOString(),
    segment_rows: segmentRows,
    signal_rows: signalRows,
    qualifies_live: qualifiesLive,
    duration_ms: durationMs,
  };

  logger.info(result, "Bundle B analytics complete");
  return result;
}
