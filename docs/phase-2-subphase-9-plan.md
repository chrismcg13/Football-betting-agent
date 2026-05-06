# Phase 2 Sub-phase 9 — Probationary Kelly ratchet (PLAN)

**Authored:** 2026-05-07.
**Strategic source:** `docs/PHASE 2 FULL PUSH — strategic inten.txt` sub-phase 9.

> Generalise candidate-tier 0.25× Kelly multiplier to read from experiment_registry.kelly_fraction. Add ratchet logic. Pinnacle-validated leagues bet at full Kelly; experiment-graduated leagues bet at probationary Kelly until 100 real-money bets confirm edge survival.

## Goal

Two coupled changes shipped as one commit:

1. **Plumb `experiment_registry.kelly_fraction` into placement-time stake calc.** Today the column is updated on tier transitions but the stake calculation ignores it — a candidate-tier bet stakes the same as a promoted-tier bet. After this commit, candidate-tier bets stake at `kelly_fraction (=0.25) × score-based fraction × full_kelly × bankroll` and promoted-tier bets stake at `kelly_fraction (eventually =1.0) × ...`.
2. **Probationary ratchet on candidate→promoted graduation.** New promotions start at `kelly_fraction = 0.5` (probationary), not the full `1.0` ceiling. Ratchet to `1.0` only after 100 real-money settled bets confirm rolling-30d ROI > 0.

## Behaviour change preview (real-money impact)

This IS a real-money behaviour change. It DECREASES stakes on candidate-tier and probationary-promoted-tier bets vs current behaviour. Per autonomy envelope ("Stake-size adjustments WITHIN the maximum stake cap" — model autonomous; "model can ratchet down… never up"), this is in scope.

| Bet kind today | Stake today | Stake after 9 |
|---|---|---|
| Tier A (no experiment_registry row, or row with kelly_fraction=1.0) | `score_kf × full_kelly × bankroll` | **same** (no change) |
| Candidate-tier (existing row, kelly_fraction=0.25) | `score_kf × full_kelly × bankroll` | **× 0.25** smaller |
| Promoted-tier (existing row, kelly_fraction=1.0) | `score_kf × full_kelly × bankroll` | **same** (no change) |
| Newly-promoted candidate→promoted | `score_kf × full_kelly × bankroll` (was full Kelly via tier) | **× 0.5** until ratchet |

Tier A behaviour byte-identical (validated by canary diff). Existing promoted-tier tags (already at kelly_fraction=1.0) keep full Kelly.

## Code changes

### EDIT `paperTrading.ts` (~+50 LOC)

- New helper `getTierKellyFractionForTag(experimentTag)`:
  - Looks up `experiment_registry.kelly_fraction` by tag.
  - Returns `1.0` if no row (default — keeps Tier A behaviour byte-identical).
  - Caches per-tag for the request lifetime to avoid double-lookups.
- `calculateDynamicKellyStake` gains a `tierKellyFraction` parameter (defaults to `1.0` if not passed for backward compat). Multiplies into the stake calc:
  ```ts
  stake = bankroll × full_kelly × score_fraction × tier_fraction
  ```
- Caller (the `placeBet` path) computes the experiment_tag and looks up the tier fraction before calling `calculateDynamicKellyStake`. The shadow-stake path also gets tier-aware (currently hardcoded `SHADOW_KELLY_FRACTION = 0.25` — replaced with the registry lookup).

### EDIT `promotionEngine.ts` (~+40 LOC)

- New constant `INITIAL_PROMOTED_KELLY_FRACTION = 0.5`. Used ONLY in the candidate→promoted transition. `TIER_TO_KELLY_FRACTION.promoted = 1.0` is preserved as the ceiling.
- Candidate→promoted transition sets `kelly_fraction = INITIAL_PROMOTED_KELLY_FRACTION` instead of `TIER_TO_KELLY_FRACTION.promoted`. Audit log records the probationary value.
- New helper `checkAndApplyKellyRatchet(experimentTag)`:
  - Loads the tag's row from `experiment_registry`.
  - If `data_tier !== 'promoted'` OR `kelly_fraction >= TIER_TO_KELLY_FRACTION.promoted` → no-op.
  - Counts real-money settled bets for the tag (`status IN ('won','lost') AND stake > 0 AND legacy_regime=false AND deleted_at IS NULL`). If `< 100` → no-op.
  - Computes rolling-30d ROI for the tag. If ROI > 0 → ratchet kelly_fraction to `TIER_TO_KELLY_FRACTION.promoted`, write `model_decision_audit_log` with `decision_type='kelly_ratchet_applied'`.
  - If `n_real_money_bets >= 100 AND ROI <= 0` → log warning (informational; tag stays at probationary). Acceptable: edge hasn't confirmed yet, more bets needed or eventual demote via existing demotion gates.
- `checkAndApplyKellyRatchet` called from `evaluateExperimentTag` on every settlement (the existing event-driven evaluator from sub-phase 5).

### Constants

```ts
const INITIAL_PROMOTED_KELLY_FRACTION = 0.5;
const PROBATIONARY_RATCHET_MIN_BETS = 100;
const PROBATIONARY_RATCHET_MIN_ROI_PCT = 0; // > 0 = positive
```

All three configurable via env vars for future tuning, but defaulting to brief-spec values.

### NO schema changes

`experiment_registry.kelly_fraction` already exists. `model_decision_audit_log` accepts new `decision_type` values without schema changes.

## Audit-log entry on ratchet

```json
{
  "decision_type": "kelly_ratchet_applied",
  "subject": "tag:<experiment_tag>",
  "prior_state": { "kelly_fraction": 0.5, "data_tier": "promoted" },
  "new_state":   { "kelly_fraction": 1.0, "data_tier": "promoted" },
  "reasoning": "Probationary Kelly ratchet: <N> settled real-money bets accumulated (≥100 threshold) with rolling-30d ROI = <X>%. Ratcheting kelly_fraction 0.5 → 1.0.",
  "supporting_metrics": { "n_real_money_settled": <N>, "rolling_roi_30d_pct": <X>, "min_bets_threshold": 100, "min_roi_threshold": 0 },
  "review_status": "automatic"
}
```

## Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | Existing promoted-tier tags with kelly_fraction=1.0 get reset to 0.5 | Only the candidate→promoted TRANSITION uses INITIAL_PROMOTED_KELLY_FRACTION. Existing promoted rows keep their value. |
| 2 | Tier A leagues without experiment_registry rows accidentally lose stake size | Default lookup returns 1.0 when row absent → byte-identical to current. |
| 3 | Race: ratchet check fires concurrently from two settlement events | Single UPDATE with WHERE kelly_fraction < 1.0 idempotent — duplicate ratchets no-op. |
| 4 | n_real_money_bets calculation includes shadow_stake-only rows | Filter `stake > 0` excludes shadow rows. |
| 5 | Stakes drop materially across the bet stream — visible bankroll growth slowdown | Expected outcome on candidate-tier bets — that's the point. Watch first week of bankroll trajectory; if catastrophic, revert via `git revert`. |

## Quick-revert

`git revert` removes the lookup + ratchet logic. The kelly_fraction column on existing rows persists harmlessly — placement reverts to ignoring it (current behaviour).

## Verification (post-deploy)

```bash
# Confirm tier-aware stakes are firing (small candidate-tier bets visible)
psql ...
SELECT m.league, pb.market_type, pb.stake, pb.opportunity_score, er.data_tier, er.kelly_fraction
FROM paper_bets pb
JOIN matches m ON m.id = pb.match_id
LEFT JOIN experiment_registry er ON er.experiment_tag = LOWER(REPLACE(m.league || '-' || pb.market_type, ' ', '-'))
WHERE pb.placed_at >= NOW() - INTERVAL '6 hours'
  AND pb.stake > 0
ORDER BY pb.placed_at DESC LIMIT 30;
```

Expect: `data_tier='candidate'` rows with smaller stakes than equivalent-score `data_tier='promoted'` (or NULL) rows.

```sql
-- Ratchet events as they fire
SELECT decision_at, subject,
       prior_state->>'kelly_fraction' AS from_kf,
       new_state->>'kelly_fraction'   AS to_kf,
       supporting_metrics->>'n_real_money_settled' AS n_settled,
       supporting_metrics->>'rolling_roi_30d_pct'  AS roi
FROM model_decision_audit_log
WHERE decision_type = 'kelly_ratchet_applied'
ORDER BY decision_at DESC;
```

## Wall-clock

~2h implementation + verification.

## What this sub-phase does NOT do

- Does NOT change `TIER_TO_KELLY_FRACTION.promoted = 1.0` ceiling (that's user-owned per autonomy memory).
- Does NOT change candidate-tier value (stays 0.25).
- Does NOT change experiment/abandoned values (stay 0).
- Does NOT touch shadow-stake math beyond using the registry lookup (replaces hardcoded 0.25 with the per-tag value).
- Does NOT add new schema. Reuses `experiment_registry.kelly_fraction` and `model_decision_audit_log`.

## Sign-off

Per strategic brief explicit instruction ("experiment-graduated leagues bet at probationary Kelly until 100 real-money bets confirm edge survival"). User has authorised the ratchet pattern.
