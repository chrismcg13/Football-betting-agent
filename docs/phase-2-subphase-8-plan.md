# Phase 2 Sub-phase 8 — OddsPapi kickoff-proximity (PLAN)

**Authored:** 2026-05-07.
**Strategic source:** `docs/PHASE 2 FULL PUSH — strategic inten.txt` sub-phase 8.

> Investigate Pinnacle's pricing-sharpness curve as function of time-to-kickoff. Restructure OddsPapi polling: high-frequency in kickoff-minus-3h window, lower frequency further out. Same monthly call count, redistributed.
>
> Verify with empirical: Pinnacle CLV on bets placed 24h+ pre-kickoff vs within 3h. Ship the redistribution if the latter shows materially higher CLV.

## Goal

Two sub-commits. Same "validate-then-ship" pattern as 7.0:

- **8.a (this commit)** — retrospective analysis. Stratify settled bets by time-to-kickoff at placement, report mean / median / ROI / win-rate per bucket. Read-only SQL + admin endpoint.
- **8.b (CONDITIONAL on 8.a verdict)** — if 8.a shows materially higher CLV in close-to-kickoff buckets, restructure the bulk-prefetch cron to weight the 3h-pre-kickoff window heavier. Same monthly call count, redistributed.

## Existing OddsPapi infrastructure (for context)

Polling is more layered than the brief implies:

| Cron | Cadence | Window | Function |
|---|---|---|---|
| Bulk prefetch | every 2h | next 7 days | `runDedicatedBulkPrefetch(7, 1000)` |
| Snapshot B (1hr-pre) | every 15min at :07/:22/:37/:52 | 45-75min pre-kickoff | `fetchPreKickoffSnapshots` |
| Closing-line (snapshot C) | every 15min | next 90min pre-kickoff | `fetchAndStoreClosingLineForPendingBets` |
| Daily budget summary | 00:01 UTC | n/a | `logDailyBudgetSummary` |

Already 3-snapshot system stores per-bet `pinnacle_open` (placement-time) + `pinnacle_60min` (snapshot B) + `closing_pinnacle_odds` (snapshot C) on `paper_bets`. The brief's redistribution suggestion targets the 2h-bulk cron, which IS the "further out" coverage. 8.a tests whether closer-to-kickoff bets actually capture a CLV edge — if not, the existing distribution is fine.

## Sub-commit 8.a — retrospective (THIS COMMIT)

### Time buckets (LOCKED)

Stratify settled bets by minutes-to-kickoff at `placed_at`:

| Bucket | Range |
|---|---|
| `0-1h` | < 60 min |
| `1-3h` | 60-180 min |
| `3-12h` | 180-720 min |
| `12-24h` | 720-1440 min |
| `24h+` | ≥ 1440 min |

### Metrics per bucket (LOCKED)

- `n_bets` — sample size
- `mean_clv_pct`, `median_clv_pct`, `stddev_clv_pct`
- `roi_pct` = `SUM(settlement_pnl) / SUM(stake) × 100` (real-money only)
- `win_rate_pct` = `% of bets where status='won'`
- `mean_clv_95ci_lower`, `mean_clv_95ci_upper` — bootstrap or normal-approximation CI on the mean

Lookback: 90 days, hard-floored at `2026-05-03` (matches sub-phase 6.3.5's pre-Replit-era exclusion).

Filters: `legacy_regime=false`, `deleted_at IS NULL`, `clv_pct IS NOT NULL`, `status IN ('won','lost')`.

Two report variants: paper bets only (`stake > 0`) AND combined (paper + shadow, weighting shadow by shadow_stake) — the second is the "what would the model have learned" signal.

### Ship-criterion for 8.b (LOCKED)

8.b ships if:
- `mean_clv_pct` in `0-3h` aggregate exceeds `mean_clv_pct` in `24h+` aggregate by **≥ 1 percentage point**
- 95% CIs of the two means **do not overlap**

If signal absent → 8.a closes sub-phase 8 with no live redistribution. Document and move on.

### Code surface

- **NEW** `services/oddsPapiRetrospective.ts` — `runClvTimeBucketRetrospective(opts)` returns a `ClvTimeBucketResult`. ~200 LOC.
- **EDIT** `routes/api.ts` — `POST /admin/run-clv-time-bucket-retrospective` admin endpoint.
- **NO** schema changes, no scheduler changes, no new crons.

## Sub-commit 8.b — conditional polling redistribution

If 8.a shows signal, candidate change shape:

- **Option 1**: keep bulk prefetch every 2h on 7-day window, BUT add a **focused 3h-window prefetch** every 30 min that targets only fixtures kicking off in the next 3 hours. Existing budget caps absorb the extra calls because the 3h-window has many fewer fixtures than the 7-day window.
- **Option 2**: change bulk prefetch from every 2h to every 4h on the 7-day window, AND add the focused 3h prefetch every 15 min. Net call count unchanged; coverage shifted.
- **Option 3**: extend `fetchAndStoreClosingLineForPendingBets` (currently 90min pre-kickoff) to fire at 180min pre-kickoff with reduced cadence.

The right option depends on the bucket-by-bucket detail 8.a returns. Decision deferred to post-8.a.

## Risk

| # | Risk | Mitigation |
|---|---|---|
| 1 | Time-bucket sample sizes too small | Min 30 bets per bucket reported; below that, bucket marked as "insufficient" and excluded from ship-criterion. |
| 2 | CLV-by-time correlation confounded by league mix (some leagues only bettable in close window) | 8.a output includes per-bucket league mix; 8.b's redistribution decision can include per-archetype stratification if needed. |
| 3 | Real-money vs shadow bets behave differently | Two report variants per above. |
| 4 | Bias from settled-only window (recently-placed near-kickoff bets may not have settled yet) | Lookback 90d ensures even slow-settling Sundays-only bets have settled. |

## Verification (post-deploy)

```bash
curl -s -X POST 'http://localhost:8080/api/admin/run-clv-time-bucket-retrospective' \
  -H 'Content-Type: application/json' -d '{}' \
  | jq '.result | {paperBuckets: .paperBets.buckets, combinedBuckets: .combined.buckets, verdict: .verdict}'
```

Expect: 5 bucket rows per variant with mean_clv_pct, n_bets, CI bounds, and a verdict object indicating whether ship-criterion is met.

## Wall-clock

- 8.a: ~1.5h (this commit).
- 8.b (if shipped): ~1.5-2h depending on redistribution shape chosen.

## Quick-revert

8.a: `git revert` removes the read-only function + endpoint. No state change.

8.b: cron schedule revert. No data side-effects.

## What this sub-phase does NOT do

- No changes to OddsPapi placement/CLV pipeline in 8.a (analysis-only).
- No changes to pinnacle_odds_snapshots schema.
- No autonomous decision-making — sub-phase 6 / 10 own that. This is a one-shot reconfiguration if the data supports it.
