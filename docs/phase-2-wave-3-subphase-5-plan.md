# Wave 3 Sub-phase 5 — Event-driven graduation evaluator (PLAN)

**Status:** PLAN-MODE. **No code change in this document.** User reviews; implementation begins on explicit approval.

**Authored:** 2026-05-05.
**Predecessors:**
- Wave 1 (firehose ON, Tier B/C placing shadow bets)
- Wave 2 #1 (`model_decision_audit_log` + `pending_threshold_revisions` schema live)
- Wave 2 #4 (banned-market reactivation; 5+ Tier B shadow bets per cycle)
- Wave 2 #4.1 (dispatcher tier-lookup fixed; Tier B reachability ~doubled)

**Source:** strategic brief sub-phase 5 + roadmap doc Wave 3.

---

## 1. Goal

Replace the 24h cron-driven graduation latency with **event-driven evaluation on every settlement.** When a bet settles, the affected `experiment_tag`'s metrics recompute, threshold gates fire, tier transitions execute (if triggered), distribution-shift A(archetype) logs.

The 03:00/04:00 cron stays as a **reconciler** — same evaluator code, called per-experiment, catches anything the event-driven path missed (e.g., experiments with no recent settlements but accumulated stale metrics).

**Strategic intent:** close the 24h learning latency to ~real-time. Current state means a Tier B/C league that has clearly graduated (50+ settled bets, 8% ROI, p<0.05) waits up to 24h before the cron picks it up. Post-Wave-3-#1: graduation fires within seconds of the settlement that crossed the threshold.

---

## 2. Inputs locked from prior waves

| Decision | Source | Value |
|---|---|---|
| `graduation_evaluation_log` table | Phase 2.A schema (`migrate.ts:1014-1024`) | Exists. Columns: `id, experiment_tag, triggered_by ('settlement'|'cron'|'manual'), trigger_bet_id, metrics_snapshot (jsonb), threshold_outcome ('promote'|'demote'|'hold'|'warmup'|'insufficient_data'), evaluated_at` |
| `model_decision_audit_log` table | Wave 2 #1 (commit `8958578`) | Exists, empty. Sub-phase 5 is the first writer for tier-transition decisions. |
| `experiment_registry.kelly_fraction` | Phase 2.A | Defaulted 1.0; not yet wired into placement (sub-phase 9 work). Sub-phase 5 sets it on tier transitions: 0 (experiment), 0.25 (candidate), 1.0 (promoted), 0 (abandoned). |
| THRESHOLDS constant | `promotionEngine.ts:1-50` (existing) | Reused as-is. v2.5 calibration shipped: `PROMO_MIN_SAMPLE_SIZE=25` + R14 winsorization. |
| Existing per-experiment evaluation logic | `promotionEngine.ts:181-295` | Extracted into `evaluateExperimentTag()` — both cron and event-driven path call it. |

---

## 3. Decisions pinned (no deferred-to-scoping)

### 3.1 Integration point (LOCKED)

Hook into `paperTrading._settleBetsInner` after the existing UPDATE on `paper_bets` at ~line 2080.

```ts
// In _settleBetsInner, after the UPDATE that finalises the bet:
await db.update(paperBetsTable).set({...}).where(eq(paperBetsTable.id, bet.id));

// NEW: event-driven graduation evaluation
if (bet.experimentTag) {
  void evaluateExperimentTag(bet.experimentTag, {
    triggeredBy: "settlement",
    triggerBetId: bet.id,
  }).catch((err) => {
    logger.warn({ err, betId: bet.id, tag: bet.experimentTag },
      "Event-driven graduation evaluation failed — reconciler will catch it");
  });
}
```

**Decisions:**
- **`void` + `.catch`**: graduation evaluation runs async but is non-blocking. Settlement completes regardless. If it errors, the daily cron reconciler catches the experiment_tag at 04:00 UTC.
- **Skip if no `experiment_tag`**: legacy bets without tags don't trigger evaluation.
- **Inside settlement loop, not after**: evaluating per-bet (vs per-cycle) keeps the per-tag computation small. A cycle settling 50 bets across 10 tags evaluates 50 times (with idempotency dedupe via §3.3).

### 3.2 evaluateExperimentTag function shape (LOCKED)

```ts
export interface EvaluateExperimentOpts {
  triggeredBy: "settlement" | "cron" | "manual";
  triggerBetId?: number;
}

export interface EvaluateExperimentResult {
  tag: string;
  evaluated: boolean;        // false if deduped
  outcome: "promote" | "demote" | "hold" | "warmup" | "insufficient_data" | "skipped_dedupe";
  newTier?: string;          // populated if outcome ∈ {promote, demote}
  metrics: ExperimentMetrics;
}

export async function evaluateExperimentTag(
  tag: string,
  opts: EvaluateExperimentOpts,
): Promise<EvaluateExperimentResult>;
```

The function:
1. Loads the experiment_registry row for the tag.
2. Runs the same per-experiment logic as the cron's loop body (existing 181-295 code).
3. Writes to `graduation_evaluation_log` with `metrics_snapshot` JSONB + `threshold_outcome`.
4. On tier transition: writes to `model_decision_audit_log` (autonomy audit per Wave 2 #1).
5. On tier transition: updates `experiment_registry.kelly_fraction` per the table in §3.5.

### 3.3 Idempotency / dedupe (LOCKED)

A trading cycle settles many bets at once. Without dedupe, evaluating the same `tag` 50 times in a row creates redundant `graduation_evaluation_log` rows and unnecessary work.

**Dedupe rule:** before running evaluation, check `graduation_evaluation_log` for the most recent row on this tag. If `evaluated_at >= NOW() - INTERVAL '15 seconds'` AND outcome is not `promote`/`demote` (i.e., previous evaluation didn't transition), skip with `outcome: "skipped_dedupe"`.

If the previous evaluation DID transition, we still re-run — the registry row has changed and the new tier needs its own gates checked.

**Why 15 seconds:** trading-cycle settlement bursts complete in <5 seconds typically. 15s is a safe bracket that absorbs the burst without delaying recently-changed-state evaluations.

### 3.4 Threshold-evaluation gates (LOCKED — verbatim from existing promotionEngine)

The thresholds and gates are NOT changed in this sub-phase. Sub-phase 6 (autonomous threshold management) is when threshold tuning becomes autonomous. Sub-phase 5 just makes evaluation event-driven — same gates, faster cadence.

| Current tier | Gate | Outcome | Source |
|---|---|---|---|
| `experiment` | All §1.2 gates met (sample, ROI, p, weeks, edge) | `promote` → `candidate` | promotionEngine.ts:197-216 |
| `experiment` | Sample ≥50 ∧ ROI ≤ −10% ∧ p ≤ 0.10 | `promote` → `abandoned` | promotionEngine.ts:218-231 |
| `candidate` | All §1.2.6 gates met (edge retention, p, no bad week) | `promote` → `promoted` | promotionEngine.ts:234-259 |
| `candidate` | candidate-phase ROI < min OR CLV < min | `demote` → `experiment` | promotionEngine.ts:261-270 |
| `promoted` | rolling-30 ROI < 0 OR ≥3 consecutive negative weeks | `demote` → `candidate` | promotionEngine.ts:273-294 |
| All other | metrics below thresholds | `hold` (no transition) | implicit |

### 3.5 Kelly-fraction side effect on tier transitions (LOCKED — v1 placeholders)

`experiment_registry.kelly_fraction` set per the v2 §3.3 design table:

| New tier | kelly_fraction set to (v1 placeholder) |
|---|---|
| `experiment` | 0 (£0 stake architectural guarantee — sub-phase 9 wires it into placement) |
| `candidate` | 0.25 |
| `promoted` | 1.0 |
| `abandoned` | 0 |

**These are v1 placeholders.** Per user's R-Notes: sub-phase 6's autonomous threshold-management evaluator will propose **per-league dynamic kelly_fraction values** based on Kelly-growth retrospective analysis. The schema column accepts the full range `[0, 1.0]` per Phase 2.A CHECK constraint at `migrate.ts:992-997`. Sub-phase 5's writes use the placeholders but do not lock the column to those three values — sub-phase 6 freely overrides.

**Note:** kelly_fraction is currently UNREAD by `placePaperBet` (per current-state §2.10). Sub-phase 9 wires it. Sub-phase 5 just sets the value so sub-phase 9 finds it correctly when implemented.

### 3.5a Per-league granularity (LOCKED — Refinement 1)

The `experiment_tag` is the per-league-per-market keying entity. Format: `LEAGUE_<canonical_name_lower>__MARKET_<market_type>` or similar (per `valueDetection.ts` placement code; existing tags follow this pattern, e.g., `serie-a-double-chance`, `bundesliga-over-under-25`).

**Per-league granularity is preserved end-to-end:**

- **Metrics:** `computeMetricsForExperiment(tag)` filters `WHERE experiment_tag = tag` — no cross-league aggregation.
- **Tier transitions:** each tag has its own `data_tier` column in `experiment_registry`. No global tier.
- **Audit log:** `model_decision_audit_log.subject = "experiment_tag:<tag>"` — every row identifies the specific league+market entity that transitioned.
- **Distribution-shift:** A(archetype) is per-archetype, but the audit log writes one row per archetype with `subject = "archetype:<name>"`. Cross-archetype aggregation does NOT happen at this stage.
- **Sub-phase 6 inheritance:** the per-league `kelly_fraction` field, the per-tag `current_*` metric fields, and the `model_decision_audit_log.supporting_metrics` JSONB all preserve the per-league dimension. Sub-phase 6's autonomous threshold-management evaluator reads these directly and proposes per-league threshold revisions without any aggregation upstream.

**No collapsing** — the autonomy the strategic brief mandates is per-league/per-archetype, not global. Sub-phase 5 ships scaffolding that respects this.

### 3.6 Distribution-shift detector A(archetype) (LOCKED — Refinement 3)

Per brief: "Per-archetype distribution-shift detector runs on every settlement: A(archetype) computed and logged; persistent |A| > 1.5 raises a flag for model-bug investigation, NOT threshold tightening."

Computation per v2 §1.5:
```
A(archetype) = (ROI(archetype) - ROI(global)) / sqrt(N(archetype))
```

Where:
- `ROI(archetype)` = aggregate ROI across all settled bets in this archetype (last 30 days)
- `ROI(global)` = aggregate ROI across all settled bets globally (last 30 days)
- `N(archetype)` = sample size of settled bets in this archetype (last 30 days)

**Run cadence:** computed on every settlement-triggered evaluator call, per-archetype. Cached for 5 minutes per archetype.

**Findings written as STRUCTURED JSONB to BOTH `model_decision_audit_log` AND `experiment_learning_journal`** so sub-phase 6's autonomous threshold-management evaluator can consume programmatically without parsing free-form text.

`model_decision_audit_log` row:
- `decision_type = "distribution_shift_observation"`
- `subject = "archetype:<name>"`
- `prior_state = null`, `new_state = null` (observational, not a state change)
- `reasoning` = brief human-readable summary
- `supporting_metrics` JSONB pinned shape:

```json
{
  "archetype": "women",
  "n_archetype_30d": 47,
  "roi_archetype_30d": -0.082,
  "n_global_30d": 1247,
  "roi_global_30d": 0.041,
  "a_score": -2.31,
  "consecutive_windows_breaching": 1,
  "kelly_growth_archetype_30d": -0.0034,
  "kelly_growth_global_30d": 0.0019
}
```

`experiment_learning_journal` row (parallel write, same JSONB content):
- `analysisType = "distribution_drift"`
- `findings` = same JSONB shape as supporting_metrics above
- `experimentTag` = null (archetype-level, not tag-level)
- `recommendations`, `actionsTaken` = null in sub-phase 5 (sub-phase 6 populates these)

**Threshold for alert:** `|a_score| > 1.5` AND `consecutive_windows_breaching >= 2` triggers a warning-level log + flags the row for sub-phase 6 review. NO threshold tightening — this is a model-bug detector, not a graduation gate.

**Implementation:** separate function `computeArchetypeDistributionShift()` in `promotionEngine.ts`. Called from the same hook as `evaluateExperimentTag`. 5-min in-memory cache per archetype.

### 3.7 Cron reconciler relationship (LOCKED)

Existing daily 04:00 UTC cron stays. After refactor, the cron's body becomes:

```ts
export async function runPromotionEngine(): Promise<{...}> {
  const experiments = await db.select().from(experimentRegistryTable);
  const results = { promoted: 0, demoted: 0, abandoned: 0, evaluated: 0 };
  for (const exp of experiments) {
    if (exp.dataTier === "abandoned") continue;
    const result = await evaluateExperimentTag(exp.experimentTag, { triggeredBy: "cron" });
    results.evaluated++;
    if (result.outcome === "promote") results.promoted++;
    if (result.outcome === "demote") results.demoted++;
  }
  // existing learning_journal write
  return results;
}
```

**Net behaviour:** event-driven catches transitions within seconds; cron sweeps everything daily as belt-and-braces.

### 3.8 Audit trail to model_decision_audit_log (LOCKED — Refinement 2)

Every tier transition writes a row to `model_decision_audit_log` with **Kelly-growth-rate as a first-class metric in `supporting_metrics`**, alongside ROI:

```json
{
  "decision_at": "<NOW>",
  "decision_type": "tier_transition",
  "subject": "experiment_tag:<tag>",
  "prior_state": { "data_tier": "experiment", "kelly_fraction": 0.0 },
  "new_state": { "data_tier": "candidate", "kelly_fraction": 0.25 },
  "reasoning": "Met all experiment→candidate thresholds: sample=27/25, realised_roi=8.4%/5%, kelly_growth=0.0042/bet, ...",
  "supporting_metrics": {
    "sample_size": 27,
    "realised_roi": 0.084,
    "realised_kelly_growth_rate": 0.0042,
    "kelly_growth_30d_rolling": 0.0061,
    "clv": 2.1,
    "win_rate": 0.556,
    "p_value": 0.038,
    "edge": 3.2,
    "weeks_active": 4
  },
  "expected_impact": null,
  "review_status": "automatic"
}
```

**Kelly-growth-rate computation (LOCKED):**

Per-bet log-return:
```
g_i = ln(max(0.001, (effective_stake_i + pnl_i) / effective_stake_i))
```

Where:
- `effective_stake_i = stake > 0 ? stake : shadow_stake` (handles shadow bets)
- `pnl_i = settlement_pnl > 0 ? settlement_pnl : shadow_pnl ?? 0`
- `max(0.001, ...)` clip prevents `log(0) = -∞` on full losses

Aggregate metrics:
- `realised_kelly_growth_rate = sum(g_i) / N` over all settled bets in the experiment_tag (mean log-return per bet)
- `kelly_growth_30d_rolling = sum(g_i) / N_30d` over last 30 days only

**Why Kelly-growth-rate as first-class:**
- (a) Sub-phase 6 needs historical Kelly-growth in audit logs to operate without retroactive recomputation.
- (b) User's weekly review surfaces variance via Kelly-growth, not just mean ROI. ROI alone hides variance traps.

**Implementation note on `expected_impact` field:**
`NUMERIC(10,6)` accepts the Kelly-growth-rate delta semantics. Sub-phase 5 leaves it `null` (no prediction made — transitions are deterministic against thresholds). **Sub-phase 6 populates it** with the predicted Kelly-growth-rate change from autonomous threshold revisions. The column semantics are pinned now: any non-null value in `expected_impact` is a Kelly-growth-rate delta in absolute terms (e.g., +0.0008 means predicted +0.08% per-bet log-return improvement).

`reasoning` field includes Kelly-growth in human-readable form alongside ROI.

All transitions are `'automatic'`. User reviews retrospectively via the weekly weekly-review query.

---

## 4. Code surface — files modified

### 4.1 `artifacts/api-server/src/services/promotionEngine.ts` — major refactor

**Additions:**
- `evaluateExperimentTag(tag, opts)` — extracted from runPromotionEngine's loop body. ~150 lines.
- `computeArchetypeDistributionShift(archetype, opts)` — new function. ~50 lines.
- Internal: `writeGraduationEvaluationLog(tag, outcome, metrics, opts)` — helper. ~20 lines.
- Internal: `writeAuditLogForTransition(tag, prevTier, newTier, reason, metrics)` — helper. ~25 lines.

**Modifications:**
- `runPromotionEngine()` becomes a thin loop calling `evaluateExperimentTag` per row.
- `manualPromote()` (existing, line 360) refactored to use the same helpers for audit-log consistency.

**Net line change:** ~+200 / −100. Substantive but not enormous.

### 4.2 `artifacts/api-server/src/services/paperTrading.ts` — single hook

**Addition** at end of per-bet UPDATE block in `_settleBetsInner` (~line 2080):

```ts
if (bet.experimentTag) {
  void evaluateExperimentTag(bet.experimentTag, {
    triggeredBy: "settlement",
    triggerBetId: bet.id,
  }).catch((err) => {
    logger.warn({ err, betId: bet.id, tag: bet.experimentTag },
      "Event-driven graduation evaluation failed — reconciler will catch it");
  });
}

// Distribution shift — fire-and-forget, cached internally
if (bet.universeTierAtPlacement && match) {
  void computeArchetypeDistributionShiftForMatch(match.id).catch((err) => {
    logger.warn({ err, matchId: match.id }, "Distribution-shift compute failed");
  });
}
```

**Net line change:** ~+15 lines.

### 4.3 `artifacts/api-server/src/lib/migrate.ts` — NO change

`graduation_evaluation_log` and `model_decision_audit_log` already exist. No new schema.

---

## 5. Failure modes & safety

| Mode | Mitigation |
|---|---|
| Event-driven evaluation throws on a malformed registry row | `void .catch()` swallows; cron reconciler picks up at 04:00 UTC |
| Two settlement bursts in same 15s on same tag | Dedupe (§3.3) keeps log clean; both bursts share one evaluation result |
| Tier transition on Tier A bet (production track) | Tier A bets don't have `experimentTag` for shadow-stake purposes — but production-track bets DO have experiment_tag. The evaluator still evaluates, and if a Tier A experiment_tag's gates fire, transition happens. Production-track tier transitions ARE the design; this works. |
| Settlement-burst storm (e.g., 100 settlements in 1 second) | Each one fires evaluator. Dedupe (§3.3) keeps writes minimal. Performance: each evaluator call ~50-100ms (DB-bound). 100 calls × 50ms = 5s background work; settlement cycle UI not blocked. |
| Distribution-shift cache stale | 5-minute cache acceptable. Sub-phase 6 might tighten. |
| graduation_evaluation_log table grows unbounded | Per-tag, per-evaluation. ~1 row per settlement post-dedupe. At 1000 settlements/day = 365k rows/year. Acceptable. Add retention cron in sub-phase 10. |

---

## 6. Risk register

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Settlement throughput degrades due to evaluator overhead | Medium | Low | `void .catch()` async + cache + dedupe. Settlement UPDATE returns before evaluator completes. |
| R2 | Event-driven evaluator fires spurious tier transitions due to race | Medium | Low | Dedupe (§3.3) + transactional `experiment_registry` UPDATE inside evaluator. |
| R3 | Distribution-shift A(archetype) fires false alerts at low N | Low | Medium | Threshold |A| > 1.5 across **two consecutive 30-day windows** dampens noise. Single-window outliers don't fire. |
| R4 | Refactor breaks existing cron behaviour | Medium | Low | Cron's loop body becomes a thin wrapper around `evaluateExperimentTag`. Same logic, same outputs. Verifiable by diffing pre/post cron runs. |
| R5 | model_decision_audit_log writes fail (e.g., schema-not-ready edge case) | Low | Very low | Wave 2 #1 verified schema live + queryable. |
| R6 | Per-archetype distribution-shift compute fails for unlabelled rows (archetype IS NULL) | Medium | Low | Sub-phase 2 cron labels all rows; current state has 0 NULL archetype rows. Defensive: skip evaluation if archetype is null. |

**Net risk: LOW-MEDIUM.** Tight scope (one new function + one hook), reuses verified evaluation logic, all dependencies (schema) in place.

---

## 7. Wall-clock estimate

- Refactor `runPromotionEngine` to extract `evaluateExperimentTag`: 1.5h
- New `computeArchetypeDistributionShift` function: 1h
- Hook into `_settleBetsInner`: 30 min
- Helpers + audit-log writes: 1h
- Build + commit + push: 15 min
- VPS deploy + restart + initial monitoring: 30 min
- Verification SQL on first event-driven evaluation: 30 min

**Total: 4.5-5h active work.** **24h passive observation** before declaring close.

---

## 8. Quick-revert procedure

The hook is non-blocking (void .catch) so failures don't break settlement. Three escalation levels:

1. **Soft-revert via flag (no code change):** introduce an `agent_config` key `event_driven_graduation_enabled`. Default `'true'`. If issues surface, set `'false'` — hook checks the flag and skips evaluator. Cron reconciler still fires daily.
2. **Code revert (single commit):** `git revert <hash>` + push + redeploy. Reverts to cron-only graduation.
3. **Full database rollback NOT NEEDED:** evaluator only writes additive rows (graduation_evaluation_log, model_decision_audit_log) and updates experiment_registry.data_tier. Tier transitions are reversible via `manualPromote(tag, prevTier)`.

I'll add the flag in §4.2 of the implementation. Cheap insurance.

---

## 9. Verification SQL — post-deploy

```sql
-- T1: graduation_evaluation_log accumulating event-driven entries
SELECT
  triggered_by,
  threshold_outcome,
  COUNT(*) AS rows,
  MIN(evaluated_at) AS first,
  MAX(evaluated_at) AS most_recent
FROM graduation_evaluation_log
WHERE evaluated_at >= '<deploy_timestamp_utc>'
GROUP BY triggered_by, threshold_outcome
ORDER BY triggered_by, threshold_outcome;
-- Expected: triggered_by='settlement' rows accumulating in real-time.
-- threshold_outcome distribution dominated by 'hold' / 'insufficient_data'
-- (most evaluations don't transition).

-- T2: model_decision_audit_log capturing tier transitions
SELECT
  decision_type,
  subject,
  prior_state->>'data_tier' AS prev,
  new_state->>'data_tier' AS new_tier,
  decision_at
FROM model_decision_audit_log
WHERE decision_type = 'tier_transition'
  AND decision_at >= '<deploy_timestamp_utc>'
ORDER BY decision_at DESC LIMIT 20;
-- Expected: zero or a few rows. Tier transitions are rare events.

-- T3: distribution-shift logged
SELECT decision_type, COUNT(*) AS n, MAX(decision_at) AS most_recent
FROM model_decision_audit_log
WHERE decision_type LIKE '%distribution_shift%'
  AND decision_at >= '<deploy_timestamp_utc>'
GROUP BY decision_type;
-- Expected: rows accumulating; should appear within ~5 min of first settlement.

-- T4: cron behaviour unchanged
-- Run after the first 04:00 UTC cron post-deploy.
SELECT triggered_by, COUNT(*) AS rows
FROM graduation_evaluation_log
WHERE evaluated_at >= '<deploy_timestamp_utc>'
GROUP BY triggered_by;
-- Expected: triggered_by='cron' has ~1 row per active experiment_tag (one cycle).
```

---

## 10. What this commit does NOT do

- **Does not change graduation thresholds.** Same THRESHOLDS constant. Sub-phase 6 owns autonomous threshold tuning.
- **Does not wire `kelly_fraction` into placement.** Sub-phase 9 owns Kelly ratchet wiring. Sub-phase 5 just sets the field on transitions.
- **Does not run a backfill** on `graduation_evaluation_log` for past evaluations. Forward-only.
- **Does not change settlement code semantics.** The bet UPDATE is unchanged; the new hook is purely additive.
- **Does not modify the cron schedule.** 04:00 cron stays.
- **Does not auto-re-admit `abandoned` experiments.** Per v2 §3.3, abandoned readmission is gated on (90-day cooldown + retrain trigger + manual review). Sub-phase 5 ships only the 90-day cooldown_eligible_at write; readmission logic is sub-phase 10 (auto-audit).

---

## 11. Sign-off — STOP

Code commits affecting settlement code paths and reusing cron evaluation are user-approval-gated. Approve any/all:

- [ ] §3.1 hook into `_settleBetsInner` after the bet UPDATE OK?
- [ ] §3.2 `evaluateExperimentTag` function shape OK?
- [ ] §3.3 dedupe rule (15s window, skip non-transition recent eval) OK?
- [ ] §3.4 thresholds reused as-is (no tuning) OK?
- [ ] §3.5 kelly_fraction set on transitions, not yet wired into placement OK?
- [ ] §3.6 A(archetype) calculation + cadence (every settlement, 5-min cache) OK?
- [ ] §3.7 cron reconciler refactored to use same evaluator OK?
- [ ] §3.8 audit-log writes on transitions OK?
- [ ] §6 risk register accepted?
- [ ] §8 quick-revert via env flag OK?

If approved: I refactor `promotionEngine.ts`, extract evaluator, write distribution-shift function, add the settlement hook, commit, push, hand you the deploy + verification SQL.

Stopping. Awaiting Wave 3 #1 approval.
