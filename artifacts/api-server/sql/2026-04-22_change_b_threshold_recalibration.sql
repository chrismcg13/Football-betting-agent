-- ============================================================================
-- Change B — Threshold recalibration for post-Prompt-5 pricing pipeline
-- ============================================================================
-- Date:   2026-04-22
-- Run:    Production database, BEFORE clearing live_breaker_paused_until.
-- Why:    Prompt-5 cutover changed the meaning of `calculatedEdge` from raw
--         bookie-shop edge (Pinnacle vs best back) to CLV-style edge
--         (actionable price vs fair value). The pre-cutover thresholds were
--         calibrated against the bookie-shop signal and now reject every bet
--         the new pipeline produces (zero bets per cycle observed).
-- Pair:   Run AFTER deploy of changes A, C, D and AFTER backfill marks all
--         bets placed before cutover as legacy_regime = true.
-- Idempotent: Yes (UPDATE WHERE).
-- ============================================================================

BEGIN;

-- 1) Edge floor: 0.03 → 0.005
--    Old (bookie-shop): 3% edge over Pinnacle was rare and meaningful.
--    New (CLV-style):   0.5% edge over fair value matches what the actionable
--                       pricing source can realistically deliver pre-kickoff.
UPDATE agent_config
   SET value = '0.005', updated_at = now()
 WHERE key = 'min_edge_threshold'
   AND value <> '0.005';

-- 2a) Paper-mode opportunity-score floor: 58 → 60
--     Read by services/scheduler.ts (line 704) and services/valueDetection.ts
--     (line 746) as `min_opportunity_score`. With more bets passing the
--     lower edge floor, raise the opp_score gate to keep selectivity.
UPDATE agent_config
   SET value = '60', updated_at = now()
 WHERE key = 'min_opportunity_score'
   AND value <> '60';

-- 2b) Live-mode opportunity-score floor: → 60
--     Read by services/liveThresholdReview.ts as `live_opp_score_threshold`
--     (separate key from the paper-mode floor). Keep the two in lockstep
--     so live placement uses the same selectivity as paper.
UPDATE agent_config
   SET value = '60', updated_at = now()
 WHERE key = 'live_opp_score_threshold'
   AND value <> '60';

-- 3) Mark pre-cutover bets as legacy_regime = true.
--    Cutover timestamp = 2026-04-19T20:00Z (matches the unique-pending index
--    in lib/db/src/schema/paperBets.ts).  Any bet placed before this point
--    used the old pricing pipeline and must be hidden from dashboard /
--    metric / experiment queries that read paper_bets_current.
UPDATE paper_bets
   SET legacy_regime = true
 WHERE placed_at < '2026-04-19T20:00:00Z'
   AND legacy_regime = false;

-- ── Sanity checks (read-only) ────────────────────────────────────────────────
SELECT key, value FROM agent_config
 WHERE key IN ('min_edge_threshold','opp_score_threshold')
 ORDER BY key;

SELECT
  count(*)                                          AS total_bets,
  count(*) FILTER (WHERE legacy_regime = true)      AS legacy_bets,
  count(*) FILTER (WHERE legacy_regime = false)     AS current_bets
FROM paper_bets;

SELECT count(*) AS rows_in_view FROM paper_bets_current;

COMMIT;
