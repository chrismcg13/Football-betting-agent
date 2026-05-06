# Phase 2 Sub-phase 10 — Ongoing audit cron (PLAN)

**Authored:** 2026-05-06.
**Strategic source:** `docs/PHASE 2 FULL PUSH — strategic inten.txt` sub-phase 10.

> Weekly cron: settlement-bias SQL and feature-coverage SQL. Auto-demotes leagues whose bias drifts above threshold for two consecutive runs.

## Goal

Add a weekly self-audit cron that:
1. Computes per-league settlement-bias z-score from settled bets.
2. Writes observations to `model_decision_audit_log` (always — informational).
3. **Auto-demotes** any league with `|bias_z| > 1.5` in two consecutive weekly observations (gated by env flag, default off).
4. Logs feature-coverage summary stats.

## Bias formula (calibration z-score)

For each league, last 30 days of settled bets where `model_probability IS NOT NULL`:

```
expected_wins = SUM(model_probability)
actual_wins   = SUM(CASE WHEN status='won' THEN 1 ELSE 0 END)
variance      = SUM(model_probability × (1 - model_probability))
bias_z        = (actual_wins - expected_wins) / SQRT(variance)
```

Standard binomial calibration test. `bias_z > 1.5` = model systematically too pessimistic for that league (winning more than predicted); `bias_z < -1.5` = systematically too optimistic. **Either direction breaching for two weeks = demote**, since both indicate model-mismatch (not "good for us / bad for us" — we want calibrated probabilities, not biased ones).

Min sample size: **n ≥ 30 bets** in the lookback window. Below that → skip the league for this run.

## Demotion cascade (LOCKED — gated by env flag)

For each league with two consecutive breaching observations:

| Current tier | Demoted to | Effect |
|---|---|---|
| A | B | drops from production (real money) to experiment (£0) |
| B | D | removes from betting entirely (rejected by dispatcher) |
| C | D | removes from betting entirely |
| D, E, unmapped | (no change) | already at bottom |

**Env flag:** `ONGOING_AUDIT_AUTO_DEMOTE_ENABLED` (default `false`). When `false`, observations still write to audit log + competition_config.settlement_bias_index but no `universe_tier` change happens. Mirrors the 6.5 flag-on pattern.

**Demotion direction:** model is autonomous on demotion (per autonomy envelope). Demotion reduces money-at-risk by definition; never raises it. Auto-promotion is NOT in scope — stays at user-approval-gated graduation gate.

## Audit-log schema (existing `model_decision_audit_log`)

Two new `decision_type` values:

```
settlement_bias_observation:
  subject = "league:<league_name>"
  prior_state = { universe_tier, settlement_bias_index_prev }
  new_state = { universe_tier, settlement_bias_index_new }
  reasoning = "Settlement-bias z=<bias_z> over <n> bets in last 30d"
  supporting_metrics = { n_bets, actual_wins, expected_wins, bias_z, breaching }
  expected_impact = bias_z (positive or negative)
  review_status = 'automatic'

league_auto_demoted:
  subject = "league:<league_name>"
  prior_state = { universe_tier: <prev> }
  new_state = { universe_tier: <new>, demotion_reason: 'consecutive_bias_breach' }
  reasoning = "Two consecutive weekly observations with |bias_z| > 1.5 — auto-demoted <prev> → <new>"
  supporting_metrics = { current_bias_z, prior_bias_z, prior_observation_at }
  review_status = 'automatic'
```

## Code surface

### NEW `artifacts/api-server/src/services/auditCron.ts` (~250 LOC)

- `computeLeagueSettlementBias(lookbackDays)` — pulls settled bets per league, computes bias_z. Returns `Array<{league, n, biasZ, expectedWins, actualWins}>`.
- `findPriorBreach(league, withinDays)` — scans `model_decision_audit_log` for prior `settlement_bias_observation` row for this league with `breaching=true` in last 14 days, excluding the current run.
- `computeFeatureCoverage()` — summary stats: per-league count of upcoming matches × avg feature count.
- `runOngoingAudit()` — orchestrator. Writes observations, checks consecutive breaches, conditionally demotes (env flag), logs summary.

### EDIT `artifacts/api-server/src/services/scheduler.ts` (~+15 LOC)

Cron registration at `0 9 * * 0` UTC (Sunday 09:00, after threshold proposal generator at 08:00).

### EDIT `artifacts/api-server/src/routes/api.ts` (~+15 LOC)

`POST /admin/run-ongoing-audit` — manual-trigger endpoint, body `{ dryRun?: boolean }`. Always returns the bias observations + demotion plan; only persists when `dryRun !== true`.

### Plan-mode doc

This document.

## Verification (post-deploy)

```bash
# Confirm cron registered
grep -i "Ongoing audit scheduler active" ~/.pm2/logs/api-server-out.log | tail -2

# Manual dryRun trigger to see what it would do
curl -s -X POST 'http://localhost:8080/api/admin/run-ongoing-audit' \
  -H 'Content-Type: application/json' -d '{"dryRun":true}' | jq
```

```sql
-- After first cron firing or manual trigger
SELECT decision_at, subject, supporting_metrics->>'bias_z' AS bias_z,
       supporting_metrics->>'n_bets' AS n_bets,
       supporting_metrics->>'breaching' AS breaching
FROM model_decision_audit_log
WHERE decision_type = 'settlement_bias_observation'
ORDER BY decision_at DESC LIMIT 30;

-- After flag-on, watch for auto-demotions
SELECT decision_at, subject, prior_state->>'universe_tier' AS from_tier,
       new_state->>'universe_tier' AS to_tier, reasoning
FROM model_decision_audit_log
WHERE decision_type = 'league_auto_demoted'
ORDER BY decision_at DESC LIMIT 20;
```

## Risk

| # | Risk | Mitigation |
|---|---|---|
| 1 | Mass auto-demote on first run if many leagues breach | Env flag default `false` — first run is observe-only. User reviews observations, then flips flag. Same pattern as 6.5. |
| 2 | A small-N league trips `\|bias_z\| > 1.5` from noise | Min sample size n=30 enforced. Below that, league skipped. |
| 3 | Cascading demotes (A→B this week, B→D next week) | One demote per league per cron run — tier transitions stagger by week. Two-consecutive-breach gate applies independently at each tier. Acceptable. |
| 4 | model_probability IS NULL on some bets | WHERE filter excludes them. n filter enforces calibration only on valid bets. |
| 5 | Demotion cascades affect leagues with active pending bets | Existing pending bets settle naturally. Only NEW bet placement is gated by universe_tier check in dispatcher. |

## Wall-clock

- ~2h implementation + verification.
- Observation window: ≥1-2 weeks of dryRun cron output before flipping `ONGOING_AUDIT_AUTO_DEMOTE_ENABLED=true`.

## What this sub-phase does NOT do

- No schema changes (uses existing `competition_config.settlement_bias_index` and `model_decision_audit_log`).
- No auto-promotion (only auto-demotion).
- No effect on `experiment_registry.data_tier` (per-tag tier — separate axis).
- No interference with sub-phase 6's autonomous threshold tuning (separate decision space).

## Quick-revert

Soft: `ONGOING_AUDIT_AUTO_DEMOTE_ENABLED=false` + restart blocks new auto-demotes. Past auto-demotes remain (UPDATE on competition_config); revert by direct SQL: `UPDATE competition_config SET universe_tier=<original> WHERE name=<league>`.

Hard: `git revert` removes the audit cron + manual endpoint + auditCron.ts entirely. Past observations remain harmlessly in audit log.
