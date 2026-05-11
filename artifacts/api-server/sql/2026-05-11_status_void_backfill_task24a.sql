-- ============================================================================
-- Task 24 Part A — Fix status='void' mis-classification on CANCELLED orders
-- ============================================================================
-- Date:    2026-05-11
-- Run:     Production database, AFTER deploying orderManager.ts code change
--          (status: "void" → "cancelled" at lines 234 and 280).
-- Why:     orderManager.ts was writing status='void' when an unmatched order
--          was cancelled because of low fill or near-kickoff drift. Void is
--          reserved for actual Betfair market voids (match abandoned). The
--          mis-classification contaminates dashboards, the cold-market
--          trigger, and the Bundle B segment-stats analytics.
-- Scope:   Only bets where betfair_status indicates a cancellation event.
--          Real voids (betfair_status='void' or NULL with status='void') are
--          left untouched.
-- Idempotent: Yes (UPDATE WHERE condition narrows to exact mis-classified set).
-- ============================================================================

BEGIN;

-- Pre-check: count of rows we expect to touch
SELECT
  betfair_status,
  COUNT(*) AS n,
  SUM(stake)::numeric(12,2) AS stake_reserved
FROM paper_bets
WHERE betfair_status IN ('CANCELLED_LOW_FILL', 'CANCELLED_NEAR_KICKOFF')
  AND status = 'void'
  AND deleted_at IS NULL
GROUP BY betfair_status
ORDER BY betfair_status;

-- Backfill: reclassify CANCELLED_* orders from status='void' to 'cancelled'
UPDATE paper_bets
   SET status = 'cancelled'
 WHERE betfair_status IN ('CANCELLED_LOW_FILL', 'CANCELLED_NEAR_KICKOFF')
   AND status = 'void'
   AND deleted_at IS NULL;

-- Post-check: verify no rows remain with the mis-classification
SELECT
  betfair_status,
  COUNT(*) AS remaining_void,
  COUNT(*) FILTER (WHERE status = 'cancelled') AS now_cancelled
FROM paper_bets
WHERE betfair_status IN ('CANCELLED_LOW_FILL', 'CANCELLED_NEAR_KICKOFF')
  AND deleted_at IS NULL
GROUP BY betfair_status
ORDER BY betfair_status;

COMMIT;
