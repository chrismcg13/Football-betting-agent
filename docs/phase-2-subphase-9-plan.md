# Phase 2 Sub-phase 9 — Data-driven Kelly-optimiser (PLAN v2)

**Authored:** 2026-05-07. **Replaces v1's heuristic ratchet** (`checkAndApplyKellyRatchet`).
**Strategic source:** `docs/PHASE 2 FULL PUSH — strategic inten.txt` sub-phase 9 + Chris's correction (2026-05-07): "I want the model to be data-driven and autonomously decide what is best to do to improve Kelly-growth ROI."

> Generalise candidate-tier 0.25× Kelly multiplier to read from experiment_registry.kelly_fraction. Add ratchet logic. [Strategic-brief framing.]
>
> The model should re-assess the problem and its solution with full autonomy and decide what is best for its main goal of increasing Kelly-growth ROI. The model should review this regularly and have an automated mechanism to change it dynamically as it learns. [User correction.]

## Goal

Two coupled changes:

1. **Plumb `experiment_registry.kelly_fraction` into placement-time stake calc.** (Already shipped in v1 — stays.)
2. **Replace the heuristic ratchet (100 bets + ROI > 0) with a data-driven Kelly-optimiser** that:
   - Maximises empirical `E[ln(1 + f × r)]` over a grid of candidate kelly_fractions (the actual mathematical Kelly-growth optimisation, not a proxy).
   - Uses statistical-significance gating (95% CIs of optimal vs current must not overlap) so sample-size threshold is data-driven, not a fixed count.
   - Runs continuously — on every settlement event AND a weekly cron pass for dormant tags.
   - Is bidirectional — ratchets UP when data confirms edge, DOWN when data signals decay.
   - Includes shadow bets in the per-bet return computation (per-unit return r_i is outcome-driven, not stake-source-driven).
   - Applies to BOTH candidate-tier AND promoted-tier tags within their respective tier ceilings.

## What's wrong with v1 (now being replaced)

| v1 (heuristic) | v2 (data-driven) |
|---|---|
| Fixed 100-bet threshold | CI-overlap gating (sample need is data-derived) |
| Gate on `ROI > 0` (not Kelly-growth) | Direct `E[ln(1 + f × r)]` maximisation |
| Filter `stake > 0` (real-money only) | Effective-stake/effective-pnl (shadow bets contribute too — same convention as 6.3.5) |
| Fires once, stuck at 1.0 forever | Re-runs continuously; bidirectional |
| Promoted-tier only | Both candidate AND promoted |
| No re-assessment of decisions | Periodic re-evaluation built in |

## Algorithm

For each tag in `data_tier ∈ ('candidate', 'promoted')`, on every settlement event AND in the weekly cron:

```
1. Pull settled bets in lookback window (90d, hard-floored at 2026-05-03).
2. For each bet, compute r_i = effective_pnl / effective_stake using
   COALESCE(NULLIF(stake, 0), shadow_stake) and
   COALESCE(NULLIF(settlement_pnl, 0), shadow_pnl) — same NULLIF
   source-selection as 6.3.5 counterfactual replay.
3. If n < 10 (numerical-stability floor) → skip.
4. tier_ceiling = TIER_TO_KELLY_FRACTION[tag.data_tier]
   (candidate=0.25, promoted=1.0). User-owned guardrail.
5. For each candidate f in [0, 0.05, 0.10, ..., tier_ceiling]:
     mean_growth[f] = mean_i ln(max(0.001, 1 + f × r_i))
     ci_95[f] = mean ± 1.96 × stddev / sqrt(n)
6. optimal_f = argmax(mean_growth)
7. Compute mean_growth + CI at the CURRENT kelly_fraction (may not
   be on the grid).
8. Apply IF:
     optimal_f != current_f (within grid resolution) AND
     ci_lower[optimal_f] > ci_upper[current_f]  (non-overlapping CIs)
9. UPDATE experiment_registry.kelly_fraction = optimal_f.
10. Audit log decision_type='kelly_optimizer_applied' with full
    grid_results, CIs, prior+posterior values.
```

## Why this matches the prime directive

- **Optimisation target:** maximises `E[ln(1 + f × r)]` directly = Kelly-growth-rate. Not ROI, not win-rate.
- **Sample size data-driven:** CI width naturally tightens as N grows. Low-N tags don't ratchet (CIs overlap). High-N tags ratchet decisively.
- **Continuous re-assessment:** every settlement event → per-tag run; weekly cron → all tags.
- **Bidirectional:** the optimum can be lower than current. Optimizer ratchets DOWN when data flags decay. Symmetric — no upward bias.
- **Bounded:** tier ceiling is user-owned. Optimizer has full data-driven autonomy WITHIN [0, ceiling]. If optimum hits 0, the tag effectively halts staking — a valid data-driven autonomous safety mechanism complementing the existing demotion gates.

## Constants (env-configurable)

```
KELLY_OPTIMIZER_LOOKBACK_DAYS=90
KELLY_OPTIMIZER_GRID_STEP=0.05         (21 candidates per tier)
KELLY_OPTIMIZER_MIN_SAMPLE=10          (numerical floor; real gate is CI overlap)
KELLY_OPTIMIZER_CI_Z=1.96              (95% normal-approximation CI)
INITIAL_PROMOTED_KELLY_FRACTION=0.5    (seed on candidate→promoted; optimizer refines)
```

`INITIAL_PROMOTED_KELLY_FRACTION` is the **seed value** when a tag freshly transitions from candidate→promoted — the optimizer hasn't run yet on the new tier's data. Conservative starting point; optimizer adjusts as data accumulates.

## Code surface

### EDIT `paperTrading.ts` (NO CHANGE from v1)

`getTierKellyFractionForTag` + the placement-time multiplier stay as shipped in `d519b83`. The plumbing is correct.

### EDIT `promotionEngine.ts` (~+250 LOC, replacing v1's ratchet)

- DELETE old constants `PROBATIONARY_RATCHET_MIN_BETS`, `PROBATIONARY_RATCHET_MIN_ROI_PCT`.
- DELETE old function `checkAndApplyKellyRatchet`.
- ADD new constants `KELLY_OPTIMIZER_*`.
- ADD new function `runKellyOptimizerForTag(tag)` — the algorithm above.
- ADD new function `runKellyOptimizerForAllTags()` — iterates over candidate+promoted registry rows.
- KEEP `INITIAL_PROMOTED_KELLY_FRACTION` (still the seed on candidate→promoted transition).
- UPDATE the hook in `evaluateExperimentTag` to call `runKellyOptimizerForTag` instead of `checkAndApplyKellyRatchet`.

### EDIT `scheduler.ts` (~+15 LOC)

Add weekly cron at `30 9 * * 0` UTC (Sunday 09:30, after ongoing audit at 09:00 which may have demoted some tags). Calls `runKellyOptimizerForAllTags`.

### EDIT `routes/api.ts` (~+20 LOC)

`POST /admin/run-kelly-optimizer` with optional body `{ tag?: string }`:
- If `tag` provided → runs for that tag only.
- Otherwise → runs for all candidate+promoted tags.

Returns the per-tag result objects (with grid scan, CIs, decision rationale).

## Audit-log entry

```json
{
  "decision_type": "kelly_optimizer_applied",
  "subject": "tag:<experiment_tag>",
  "prior_state": { "kelly_fraction": 0.5, "data_tier": "promoted" },
  "new_state":   { "kelly_fraction": 0.85, "data_tier": "promoted" },
  "reasoning": "Kelly-optimiser: argmax over [0, 1.0] grid (step 0.05) gave optimal_f=0.85 vs current=0.50. Realised log-growth: optimal=+0.0024/bet [CI 0.0008, 0.0040], current=+0.0011/bet [CI -0.0005, 0.0027]. CIs non-overlapping; applying.",
  "supporting_metrics": {
    "n_bets": 142,
    "lookback_days": 90,
    "tier_ceiling": 1.0,
    "growth_at_current": 0.0011,
    "growth_at_optimal": 0.0024,
    "ci_at_current": [-0.0005, 0.0027],
    "ci_at_optimal": [0.0008, 0.0040],
    "grid_results": [/* full grid scan for transparency */],
    "prior_kelly_fraction": 0.5
  },
  "expected_impact": 0.0013,
  "review_status": "automatic"
}
```

## Risk

| # | Risk | Mitigation |
|---|---|---|
| 1 | Optimizer thrashes between values across cycles | CI-overlap gate prevents low-significance moves. Cycle-to-cycle changes need genuine new evidence. |
| 2 | Race: two settlements call optimizer concurrently | UPDATE has `WHERE kelly_fraction = current_kf` guard — second call sees mismatch, no-ops. |
| 3 | Tag with extreme outliers skews mean log-growth | CI widens with variance, naturally gating ratchets on noisy tags. |
| 4 | Optimizer drops a profitable tag's kelly_fraction to 0 prematurely | CI-overlap gate. Plus existing demotion gates (sub-phase 5) operate independently — would catch persistently-bad tags via tier change. |

## Quick-revert

`git revert` returns to v1 heuristic ratchet (or with two reverts, returns to pre-9 fixed-multiplier behaviour). Past `kelly_optimizer_applied` audit-log rows persist harmlessly. Manual restore of any kelly_fraction values via direct UPDATE if needed.

## Verification

```bash
# Run optimizer manually across all candidate+promoted tags
curl -s -X POST 'http://localhost:8080/api/admin/run-kelly-optimizer' \
  -H 'Content-Type: application/json' -d '{}' \
  | jq '.result | {checked, ratcheted, sampleResults: (.results | map({tag, ratcheted, reason, currentKellyFraction, optimalKellyFraction, nBets}) | .[0:10])}'

# Run for a specific tag with full grid output
curl -s -X POST 'http://localhost:8080/api/admin/run-kelly-optimizer' \
  -H 'Content-Type: application/json' -d '{"tag":"<experiment_tag>"}' \
  | jq '.result'
```

```sql
-- Watch optimizer events
SELECT decision_at, subject,
       prior_state->>'kelly_fraction' AS from_kf,
       new_state->>'kelly_fraction'   AS to_kf,
       supporting_metrics->>'n_bets'  AS n,
       supporting_metrics->>'growth_at_current'  AS growth_curr,
       supporting_metrics->>'growth_at_optimal'  AS growth_opt
FROM model_decision_audit_log
WHERE decision_type = 'kelly_optimizer_applied'
ORDER BY decision_at DESC LIMIT 30;
```

## What this sub-phase does NOT do

- Does NOT change tier ceilings (`TIER_TO_KELLY_FRACTION` constants stay — user-owned).
- Does NOT change tier graduation gates (sub-phase 5 owns those).
- Does NOT add new schema (`experiment_registry.kelly_fraction` already exists).
- Does NOT touch demotion logic — orthogonal axis. Tier change vs in-tier kelly_fraction tuning are independent.
