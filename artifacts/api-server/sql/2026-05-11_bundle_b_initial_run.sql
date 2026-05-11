-- ============================================================================
-- Bundle B analytics — one-shot initial population
-- ============================================================================
-- Date:    2026-05-11
-- Run:     AFTER deploy of analysisJobs.ts + migrate.ts table-creation, so
--          analysis_segment_stats / analysis_signal_strength already exist.
-- Why:     Lets the operator validate Bundle B output immediately rather
--          than waiting for the 02:30 UTC nightly cron. Subsequent cron
--          runs will keep history (composite PK on computed_at).
-- Idempotent: Yes — INSERT keyed by computed_at = now()-rounded-to-second.
--             Re-running within the same second will fail PK conflict
--             cleanly; bump now() by a second if needed.
-- ============================================================================

BEGIN;

-- Capture one timestamp for this snapshot (truncate to second).
DO $$
DECLARE
  ts TIMESTAMPTZ := date_trunc('second', now());
BEGIN
  -- 1) segment-level stats
  INSERT INTO analysis_segment_stats
    (computed_at, league, market_type, bet_track, n, w, stake, pnl, avg_clv, sd_clv, clv_n)
  SELECT
    ts,
    COALESCE(m.league, '__unknown__'),
    pb.market_type,
    pb.bet_track,
    COUNT(*)::int,
    COUNT(*) FILTER (WHERE pb.status = 'won')::int,
    SUM(CASE WHEN pb.bet_track = 'shadow' THEN COALESCE(pb.shadow_stake, 0) ELSE pb.stake END)::numeric,
    SUM(CASE WHEN pb.bet_track = 'shadow' THEN COALESCE(pb.shadow_pnl, 0)
             ELSE COALESCE(pb.net_pnl, pb.settlement_pnl, 0) END)::numeric,
    AVG(pb.clv_pct)::numeric,
    STDDEV(pb.clv_pct)::numeric,
    COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL)::int
  FROM paper_bets pb
  LEFT JOIN matches m ON pb.match_id = m.id
  WHERE pb.placed_at >= '2026-05-03'::date
    AND pb.deleted_at IS NULL
    AND pb.status IN ('won', 'lost')
  GROUP BY m.league, pb.market_type, pb.bet_track;

  -- 2) signal-strength verdicts (per-market prior computed inline via CTE)
  INSERT INTO analysis_signal_strength
    (computed_at, league, market_type, bet_track, n,
     win_rate, wilson_lo95_winrate, roi, shrunk_roi,
     avg_clv, clv_t_stat, qualifies_live, qualification_basis)
  WITH priors AS (
    SELECT market_type, SUM(pnl) / NULLIF(SUM(stake), 0) AS mean_roi
    FROM analysis_segment_stats
    WHERE computed_at = ts
    GROUP BY market_type
  )
  SELECT
    s.computed_at,
    s.league,
    s.market_type,
    s.bet_track,
    s.n,
    (s.w::numeric / NULLIF(s.n, 0)),
    ((s.w + 1.92) / (s.n + 3.84)
      - 1.96 * SQRT((s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                    / (s.n + 3.84)) / (s.n + 3.84)),
    (s.pnl / NULLIF(s.stake, 0)),
    CASE
      WHEN s.stake IS NULL OR s.stake = 0 THEN p.mean_roi
      ELSE
        (s.n::numeric / (s.n + 30)) * (s.pnl / NULLIF(s.stake, 0))
        + (30::numeric / (s.n + 30)) * COALESCE(p.mean_roi, 0)
    END,
    s.avg_clv,
    CASE
      WHEN s.sd_clv IS NULL OR s.sd_clv = 0 OR s.clv_n < 2 THEN NULL
      ELSE (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv
    END,
    (
      s.n >= 30
      AND s.pnl > 0
      AND (
        ((s.w + 1.92) / (s.n + 3.84)
          - 1.96 * SQRT((s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                        / (s.n + 3.84)) / (s.n + 3.84)) > 0.50
        OR (
          s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
          AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > 1.96
          AND s.avg_clv > 0
        )
      )
    ),
    CASE
      WHEN s.n < 30 THEN 'insufficient'
      WHEN s.pnl <= 0 THEN 'insufficient'
      ELSE
        CASE
          WHEN ((s.w + 1.92) / (s.n + 3.84)
                - 1.96 * SQRT((s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                              / (s.n + 3.84)) / (s.n + 3.84)) > 0.50
               AND s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
               AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > 1.96
               AND s.avg_clv > 0
            THEN 'both'
          WHEN ((s.w + 1.92) / (s.n + 3.84)
                - 1.96 * SQRT((s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                              / (s.n + 3.84)) / (s.n + 3.84)) > 0.50
            THEN 'roi'
          WHEN s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
               AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > 1.96
               AND s.avg_clv > 0
            THEN 'clv'
          ELSE 'insufficient'
        END
    END
  FROM analysis_segment_stats s
  LEFT JOIN priors p ON p.market_type = s.market_type
  WHERE s.computed_at = ts;

  RAISE NOTICE 'Bundle B initial run complete at %', ts;
END $$;

COMMIT;

-- ── Verification queries ─────────────────────────────────────────────────────

-- Row counts written this snapshot
SELECT 'segment_stats' AS table_name, COUNT(*) AS rows
FROM analysis_segment_stats
WHERE computed_at = (SELECT MAX(computed_at) FROM analysis_segment_stats)
UNION ALL
SELECT 'signal_strength', COUNT(*)
FROM analysis_signal_strength
WHERE computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength);

-- Top 30 live-eligible candidates by signal strength
SELECT * FROM v_live_eligibility_candidates LIMIT 30;
