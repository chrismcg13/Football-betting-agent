-- ============================================================================
-- 2026-05-11 v2 — gross_pnl + commission_amount backfill
-- ============================================================================
-- Why:     The first backfill (2026-05-11_pnl_backfill_from_betfair.sql)
--          only updated net_pnl + status. It left gross_pnl and
--          commission_amount stale, so any aggregation that uses those
--          columns (e.g. "gross − commission") gives a different answer
--          than net_pnl. Example after v1:
--              gross_pnl sum     = +£77.43   (stale, pre-backfill calc)
--              commission sum    = +£30.15   (stale, pre-backfill calc)
--              net_pnl sum       = +£16.65   (correct, betfair_pnl)
--              gross − comm      = +£47.28   ← does not equal net_pnl
--
--          This v2 reconciles gross_pnl + commission_amount so that
--          gross − commission == net_pnl == betfair_pnl for every row.
--
-- Rule:    For each settled live bet with betfair_pnl set,
--            net_pnl    = betfair_pnl                        (already done)
--            status     = sign(betfair_pnl)                  (already done)
--          AND
--            gross_pnl    = betfair_pnl / 0.95   (won)       0 (void)   betfair_pnl (lost)
--            commission   = gross_pnl - net_pnl  (won)       0 (else)
--
--          The 0.95 factor assumes Betfair's standard 5% commission. This
--          is exact for won rows (gross = net / (1 − rate)). Lost rows
--          carry no commission, so gross = net. Void rows zero out.
--
-- Idempotent: yes — predicate narrows to rows still inconsistent.
-- ============================================================================

BEGIN;

-- Pre-check
SELECT
  COUNT(*) AS rows_inconsistent,
  ROUND(SUM(gross_pnl - commission_amount - net_pnl)::numeric, 2) AS aggregate_gap
FROM paper_bets
WHERE bet_track='live'
  AND deleted_at IS NULL
  AND betfair_pnl IS NOT NULL
  AND status IN ('won','lost','void')
  AND ABS(gross_pnl - commission_amount - net_pnl) > 0.01;

-- Backfill gross_pnl, commission_amount, settlement_pnl to be consistent
-- with net_pnl. Critical: settlement_pnl is what the risk manager reads
-- for daily/weekly loss circuit breakers (see riskManager.ts:139,154,166,
-- 181). Leaving it stale would have the breakers operating on pre-
-- correction P&L values — a money-guardrail bug.
UPDATE paper_bets
SET
  gross_pnl = CASE
                WHEN status = 'won'  THEN ROUND((net_pnl / 0.95)::numeric, 2)
                WHEN status = 'lost' THEN net_pnl
                WHEN status = 'void' THEN 0
                ELSE gross_pnl
              END,
  commission_amount = CASE
                        WHEN status = 'won' THEN ROUND((net_pnl / 0.95 - net_pnl)::numeric, 2)
                        ELSE 0
                      END,
  settlement_pnl = net_pnl
WHERE bet_track='live'
  AND deleted_at IS NULL
  AND betfair_pnl IS NOT NULL
  AND status IN ('won','lost','void')
  AND (
    ABS(gross_pnl - commission_amount - net_pnl) > 0.01
    OR ABS(settlement_pnl - net_pnl) > 0.01
  );

-- Audit row
INSERT INTO compliance_logs (action_type, details, timestamp)
VALUES (
  'pnl_backfill_v2_gross_commission',
  jsonb_build_object(
    'reason', 'reconcile gross_pnl + commission_amount with net_pnl after v1 backfill that only touched net_pnl + status',
    'rule', 'gross_pnl = net_pnl/0.95 for won; net_pnl for lost; 0 for void. commission_amount = gross - net for won; 0 else.'
  ),
  NOW()
);

-- Post-check: every settled live bet should now satisfy gross - comm = net
SELECT
  COUNT(*) AS still_inconsistent,
  ROUND(SUM(stake)::numeric, 2)           AS stake_total,
  ROUND(SUM(gross_pnl)::numeric, 2)       AS gross_total,
  ROUND(SUM(commission_amount)::numeric,2) AS commission_total,
  ROUND(SUM(net_pnl)::numeric, 2)         AS net_total,
  ROUND((SUM(gross_pnl) - SUM(commission_amount) - SUM(net_pnl))::numeric, 2) AS aggregate_gap
FROM paper_bets
WHERE bet_track='live'
  AND deleted_at IS NULL
  AND betfair_pnl IS NOT NULL
  AND status IN ('won','lost','void')
  AND ABS(gross_pnl - commission_amount - net_pnl) > 0.01;

-- Operator's headline numbers — should now match live_bets_current sums
SELECT
  COUNT(*) FILTER (WHERE status IN ('won','lost'))                    AS decided,
  COUNT(*) FILTER (WHERE status='won')                                AS wins,
  COUNT(*) FILTER (WHERE status='lost')                               AS losses,
  COUNT(*) FILTER (WHERE status='void')                               AS voids,
  ROUND(SUM(stake)::numeric, 2)                                       AS stake_total_gbp,
  ROUND(SUM(gross_pnl)::numeric, 2)                                   AS gross_pnl_gbp,
  ROUND(SUM(commission_amount)::numeric, 2)                           AS commission_paid_gbp,
  ROUND(SUM(net_pnl)::numeric, 2)                                     AS net_pnl_gbp,
  ROUND((SUM(gross_pnl) - SUM(commission_amount))::numeric, 2)        AS gross_minus_comm_check,
  ROUND((SUM(gross_pnl) - SUM(commission_amount) - SUM(net_pnl))::numeric, 2) AS gap_should_be_zero
FROM live_bets_current
WHERE status IN ('won','lost','void');

-- COMMIT;
-- ROLLBACK;
