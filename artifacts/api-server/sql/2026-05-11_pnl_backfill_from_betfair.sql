-- ============================================================================
-- 2026-05-11 evening — net_pnl + status backfill from Betfair authoritative
-- ============================================================================
-- Date:    2026-05-11
-- Run:     Production database, AFTER the liveReconciliation.ts code change
--          (auto-correct net_pnl/status when wallet disagrees) deploys.
-- Why:     Chris's report showed +£47.28 on live bets since cutover, but
--          summing betfair_pnl (Betfair's authoritative wallet value) gives
--          only +£13.42. The £34 overstatement is concentrated in two
--          misclassified bets:
--            id=6044 — marked 'won', betfair_pnl = −£10.36 (full stake loss)
--            id=6089 — marked 'lost', betfair_pnl = £0.00 (Betfair voided)
--          Plus a long tail of ~£0.10/bet rounding differences that aggregate
--          to ~£8 across 87 cleanly-won bets (commission rounding, partial
--          fills at off-tick prices).
--
--          Per memory `feedback_settlement_audit_after_logic_changes`:
--          Betfair is authoritative; when local disagrees, overwrite local.
-- Scope:   All live-rail rows where betfair_pnl IS NOT NULL and disagrees
--          with net_pnl by > £0.50 (matches the going-forward tolerance
--          used by liveReconciliation.ts) OR where the implied status from
--          wallet impact disagrees with the stored status.
-- Idempotent: Yes — predicate narrows to current disagreement set; re-runs
--          produce 0 row updates after the first.
-- ============================================================================

BEGIN;

-- Pre-check: list every row that this backfill will touch, with the
-- previous vs new values. Eyeball before COMMIT.
WITH disagreements AS (
  SELECT
    id,
    status                                        AS prev_status,
    betfair_status                                AS bf_status,
    ROUND(stake::numeric, 2)                      AS stake,
    ROUND(gross_pnl::numeric, 2)                  AS prev_gross,
    ROUND(net_pnl::numeric, 2)                    AS prev_net_pnl,
    ROUND(betfair_pnl::numeric, 2)                AS bf_pnl,
    CASE
      WHEN betfair_pnl > 0.50  THEN 'won'
      WHEN betfair_pnl < -0.50 THEN 'lost'
      ELSE 'void'
    END                                           AS new_status,
    ROUND((betfair_pnl - net_pnl)::numeric, 2)    AS pnl_correction
  FROM paper_bets
  WHERE bet_track = 'live'
    AND deleted_at IS NULL
    AND betfair_pnl IS NOT NULL
    AND status IN ('won','lost','void')
    AND (
      ABS(net_pnl - betfair_pnl) > 0.50
      OR status <> CASE
                     WHEN betfair_pnl > 0.50  THEN 'won'
                     WHEN betfair_pnl < -0.50 THEN 'lost'
                     ELSE 'void'
                   END
    )
)
SELECT
  COUNT(*)                                              AS rows_to_update,
  COUNT(*) FILTER (WHERE prev_status <> new_status)     AS status_flips,
  ROUND(SUM(pnl_correction)::numeric, 2)                AS total_pnl_correction
FROM disagreements;

-- The actual backfill. Sets net_pnl = betfair_pnl and re-derives status
-- from the sign of betfair_pnl. Skips rows already in agreement.
WITH updates AS (
  SELECT
    id,
    betfair_pnl,
    CASE
      WHEN betfair_pnl > 0.50  THEN 'won'
      WHEN betfair_pnl < -0.50 THEN 'lost'
      ELSE 'void'
    END AS new_status
  FROM paper_bets
  WHERE bet_track = 'live'
    AND deleted_at IS NULL
    AND betfair_pnl IS NOT NULL
    AND status IN ('won','lost','void')
    AND (
      ABS(net_pnl - betfair_pnl) > 0.50
      OR status <> CASE
                     WHEN betfair_pnl > 0.50  THEN 'won'
                     WHEN betfair_pnl < -0.50 THEN 'lost'
                     ELSE 'void'
                   END
    )
)
UPDATE paper_bets pb
SET net_pnl    = u.betfair_pnl,
    status     = u.new_status
FROM updates u
WHERE pb.id = u.id;

-- Audit row in compliance_logs so the operator can trace this backfill
-- after the fact.
INSERT INTO compliance_logs (action_type, details, timestamp)
VALUES (
  'pnl_backfill_from_betfair',
  jsonb_build_object(
    'reason', 'one-shot backfill aligning net_pnl + status with betfair_pnl after liveReconciliation auto-correct shipped',
    'scope', 'paper_bets WHERE bet_track=live AND betfair_pnl IS NOT NULL AND deleted_at IS NULL AND disagreement > £0.50',
    'note', 'Going-forward correction lives in liveReconciliation.reconcileLiveAccountStatement (daily 05:00 UTC)'
  ),
  NOW()
);

-- Post-check: live P&L since cutover, after the backfill.
SELECT
  COUNT(*) AS decided,
  COUNT(*) FILTER (WHERE status = 'won')                            AS wins,
  COUNT(*) FILTER (WHERE status = 'lost')                           AS losses,
  COUNT(*) FILTER (WHERE status = 'void')                           AS voids,
  ROUND(SUM(stake)::numeric, 2)                                     AS stake_total,
  ROUND(SUM(net_pnl)::numeric, 2)                                   AS net_pnl,
  ROUND(SUM(betfair_pnl)::numeric, 2)                               AS bf_pnl_check,
  ROUND((SUM(net_pnl) - SUM(betfair_pnl))::numeric, 2)              AS residual_drift
FROM paper_bets
WHERE bet_track = 'live'
  AND deleted_at IS NULL
  AND placed_at >= (SELECT value::timestamptz FROM agent_config WHERE key = 'cutover_completed_at')
  AND status IN ('won','lost','void');

-- And the wider window since the theory-plan baseline.
SELECT
  COUNT(*) AS decided,
  COUNT(*) FILTER (WHERE status = 'won')                            AS wins,
  COUNT(*) FILTER (WHERE status = 'lost')                           AS losses,
  COUNT(*) FILTER (WHERE status = 'void')                           AS voids,
  ROUND(SUM(stake)::numeric, 2)                                     AS stake_total,
  ROUND(SUM(net_pnl)::numeric, 2)                                   AS net_pnl,
  ROUND(SUM(betfair_pnl)::numeric, 2)                               AS bf_pnl_check,
  ROUND((SUM(net_pnl) - SUM(betfair_pnl))::numeric, 2)              AS residual_drift
FROM paper_bets
WHERE bet_track = 'live'
  AND deleted_at IS NULL
  AND placed_at >= '2026-05-03'
  AND status IN ('won','lost','void');

-- Operator: inspect the pre-check + post-check counts. If they look right,
-- COMMIT. Otherwise, ROLLBACK and ping Claude with the output.
-- COMMIT;
-- ROLLBACK;
