# Wave 3 Sub-phase 6 — Autonomous threshold management (PLAN)

**Status:** PLAN-MODE. **No code change in this document.** User reviews; implementation breaks into sub-commits per §5.

**Authored:** 2026-05-05.
**Predecessors:**
- Sub-phase 5 shipped (event-driven graduation evaluator + structured distribution-shift findings)
- Wave 2 #1 (`model_decision_audit_log`, `pending_threshold_revisions` schemas live + verified empty)
- Phase 2.A schema (`graduation_evaluation_log` for retrospective analysis input)

**Source:** strategic brief sub-phase 6.

> Implement the in-system meta-evaluator. Weekly retrospective analysis identifies which threshold values would have correctly classified the leagues that turned out to sustain profitability post-promotion. The model autonomously adjusts thresholds in the direction of tighter (more conservative). Looser threshold proposals are written to pending_threshold_revisions and require user approval before activating.
>
> The optimisation target written into this evaluator is Kelly-optimal growth rate, not raw ROI.

---

## 1. Goal

Replace the static `THRESHOLDS` constant in `promotionEngine.ts` with **per-league + per-archetype + global** dynamic thresholds that the model proposes weekly based on Kelly-growth retrospective analysis. The model:

- **Tightens autonomously** (logs to `model_decision_audit_log`, applies immediately).
- **Loosens via user approval** (writes to `pending_threshold_revisions`, status=`pending`, awaits review).

The evaluator runs **weekly**. Each run produces N proposals (one per scope × threshold dimension). Tighter ones apply; looser ones queue. **Kelly-growth is the optimisation target, not raw ROI** — variance-penalising, compounding-aware.

---

## 2. Inputs locked from prior waves

| Decision | Source | Value |
|---|---|---|
| `pending_threshold_revisions` schema | Wave 2 #1 commit `8958578` | Live, empty. Schema supports `direction ∈ {tighter, looser}`, `scope` text (e.g., `'global'`, `'per_archetype:women'`, `'per_league:premier-league-double-chance'`), `current_value` + `proposed_value` JSONB, `status ∈ {pending, approved, rejected, expired}`. |
| `model_decision_audit_log` schema | Wave 2 #1 | Live, accumulating distribution-shift rows (~3 per cron pass). Sub-phase 6 writes `decision_type='threshold_adjust'` rows. |
| `graduation_evaluation_log` | Phase 2.A | 946+ rows post-sub-phase-5 cron run. Provides historical evaluation trace for retrospective analysis. |
| Kelly-growth-rate computation | Sub-phase 5 (Refinement 2) | Per-bet log-return: `g_i = ln(max(0.001, (effective_stake + pnl) / effective_stake))`. Mean per bet over window. |
| Distribution-shift findings | Sub-phase 5 (Refinement 3) | Structured JSONB in `model_decision_audit_log` + `experiment_learning_journal`. Per-archetype A scores, n, kelly_growth. |
| `experiment_registry.kelly_fraction` | Phase 2.A schema | Accepts `[0, 1.0]` per CHECK constraint. Sub-phase 5 sets v1 placeholders (0/0.25/1.0/0). Sub-phase 6 overrides with per-league dynamic values. |

---

## 3. Decisions pinned (no deferred-to-scoping)

### 3.1 Threshold-override storage: REUSE `pending_threshold_revisions` (LOCKED)

No new schema. The single source of truth for active per-scope threshold values is the **most-recently-approved** row in `pending_threshold_revisions` per `(scope, threshold_name)` tuple.

```ts
// Lookup chain in evaluator (called from sub-phase 5's evaluateExperimentTag):
async function resolveThreshold(thresholdName: string, league: string, archetype: string): Promise<number> {
  // 1. per-league override
  const perLeague = await fetchActiveOverride(thresholdName, `per_league:${league}`);
  if (perLeague != null) return perLeague;

  // 2. per-archetype override
  const perArchetype = await fetchActiveOverride(thresholdName, `per_archetype:${archetype}`);
  if (perArchetype != null) return perArchetype;

  // 3. global override
  const global = await fetchActiveOverride(thresholdName, "global");
  if (global != null) return global;

  // 4. compile-time default (current THRESHOLDS constant)
  return DEFAULT_THRESHOLDS[thresholdName];
}

async function fetchActiveOverride(thresholdName: string, scope: string): Promise<number | null> {
  const rows = await db
    .select({ proposedValue: pendingThresholdRevisionsTable.proposedValue })
    .from(pendingThresholdRevisionsTable)
    .where(and(
      eq(pendingThresholdRevisionsTable.thresholdName, thresholdName),
      eq(pendingThresholdRevisionsTable.scope, scope),
      eq(pendingThresholdRevisionsTable.status, "approved"),
    ))
    .orderBy(desc(pendingThresholdRevisionsTable.reviewedAt))
    .limit(1);
  if (rows.length === 0) return null;
  const v = rows[0].proposedValue;
  return typeof v === "number" ? v : (v as any)?.value ?? null;
}
```

**Rationale:**
- One table for proposals + active values means full lineage in one place.
- Tighter changes go directly to `status='approved'` (model-applied).
- Looser proposals go to `status='pending'` (human-reviewed).
- Approved rows accumulate over time → a per-scope, per-threshold history that `expected_impact` and `supporting_metrics` JSONB carry forward.

**Performance:** lookup is one SELECT with index on `(threshold_name, scope, status)` — partial index already exists from Wave 2 #1 schema (`pending_threshold_revisions_status_idx WHERE status = 'pending'`). Add a similar partial index on `WHERE status = 'approved'` — single migration line.

### 3.2 Retrospective analysis methodology (LOCKED)

Per the strategic brief: "weekly retrospective analysis identifies which threshold values would have correctly classified the leagues that turned out to sustain profitability post-promotion."

**Walk-forward backtest, per-scope, per-threshold:**

For each (scope, threshold_name) under evaluation:

1. **Identify candidate alternative values.** Generate ±10%, ±25%, ±50% perturbations from the current value. Plus 2-3 extreme values (e.g., 0.5×, 2×) to bound exploration.
2. **For each alternative value, replay history** from a fixed lookback window (default: 90 days, but user-configurable via env var):
   - For each `graduation_evaluation_log` row in the window with the relevant scope:
     - Re-evaluate the metrics_snapshot against the alternative threshold.
     - Determine: would this row have transitioned (different outcome)?
   - Aggregate the resulting "what-if" tier sequence into a **realised Kelly-growth** for the scope:
     - For each league/tag affected, compute what bets would have placed at what stake (using kelly_fraction implied by the alternative tier path)
     - Compute realised log-bankroll-growth from settled outcomes
3. **Pick the alternative value that maximises Kelly-growth on the lookback window.**
4. **Generate a proposal:** if the winner ≠ current value, create a `pending_threshold_revisions` row.

**Direction classification:**
- `tighter`: alternative makes graduation gates STRICTER (e.g., higher `min_sample_size`, higher `min_roi`, higher `min_clv`, lower `max_p_value`).
- `looser`: alternative makes gates LESS STRICT (lower `min_*`, higher `max_*`).

**For tighter direction:** model writes the row with `status='approved'` directly (auto-applied). Sub-phase 5's evaluator picks it up next call via `resolveThreshold()`.

**For looser direction:** model writes `status='pending'`. Engine does NOT auto-apply.

### 3.3 Kelly-growth-impact computation (LOCKED — Refinement 2 from sub-phase 5 carries forward)

`expected_impact` field (NUMERIC(10,6)) is populated with the predicted Kelly-growth-rate **delta** from applying the proposal:

```
expected_impact = realised_kelly_growth_under_proposed - realised_kelly_growth_under_current
```

Both terms are computed on the SAME lookback window from `graduation_evaluation_log` + `paper_bets` joined data. Positive means the proposal would have improved Kelly-growth historically; negative means worsened.

**Sanity gates on tighter-application:**
- Skip auto-apply if `|expected_impact| < 0.0001` (noise floor — too small a change to act on).
- Skip auto-apply if `lookback_window_n_evaluations < 30` (insufficient data; await more evidence).
- Skip auto-apply if the proposed value crosses an environment-variable safety floor (e.g., `MIN_THRESHOLD_FLOOR_min_sample_size = 10` — never propose sample size below 10).

### 3.4 Per-league + per-archetype + global precedence (LOCKED)

Sub-phase 5's per-league granularity carries forward. Sub-phase 6 generates proposals at all three scopes:

| Scope | Trigger condition | Frequency |
|---|---|---|
| `per_league:<tag>` | League has ≥30 settled bets in lookback window | Weekly |
| `per_archetype:<archetype>` | Archetype has ≥100 settled bets in lookback window | Weekly |
| `global` | ≥500 settled bets across all leagues in lookback window | Weekly |

Per-league trumps per-archetype trumps global. Sub-phase 5's `evaluateExperimentTag` calls `resolveThreshold()` for each gate; the lookup chain handles the precedence.

**Constraint per user's R2 from sub-phase 5:** distribution-shift findings (`a_score > 1.5` persistent) flag a model-bug, NOT a threshold tightening. So when generating proposals, **skip per-archetype proposals if that archetype has an active distribution-shift alert.** Read the most recent `distribution_shift_observation` row for the archetype; if `consecutive_windows_breaching ≥ 2`, skip.

### 3.5 Per-league dynamic kelly_fraction (LOCKED — refines sub-phase 5's v1 placeholders)

Sub-phase 5 set static `kelly_fraction` on tier transitions (0/0.25/1.0/0). Sub-phase 6 owns making this dynamic.

**Trigger:** when the autonomous evaluator processes a `per_league:<tag>` proposal that includes `kelly_fraction` as a threshold dimension, the evaluator can update `experiment_registry.kelly_fraction` for that tag.

**Bounds:** `[0, 1.0]` per Phase 2.A CHECK constraint. Plus an env-var safety ceiling (default `MAX_AUTONOMOUS_KELLY_FRACTION = 0.5` — model can autonomously go up to 0.5; exceeding requires user approval per "looser" path).

**Scope:** evaluator may only adjust kelly_fraction within the tier's valid range:
- `experiment` tier: must stay 0
- `candidate` tier: `[0, 0.5]` autonomous; `[0.5, 1.0]` requires user approval
- `promoted` tier: `[0, 1.0]` autonomous (already at max effectively)
- `abandoned` tier: must stay 0

### 3.6 Cron cadence (LOCKED)

Per the strategic brief: weekly retrospective. New cron at `0 8 * * 0` UTC (Sunday 08:00 UTC) — sits in the empty Sunday morning slot per `phase-2-current-state.md` §3.6.

**Why Sunday 08:00:**
- After the existing Sunday-only crons (02:00 - 06:00 cluster).
- Before any potential weekday market activity (most leagues kick off Saturday afternoon → Sunday morning has most-recent week of settled data).
- Empty slot per existing cron audit.

### 3.7 Cron flow (LOCKED)

```
runAutonomousThresholdManager():
  1. For each scope (in order: per_league, per_archetype, global):
     1.1. For each (scope_value, threshold_name) tuple meeting the trigger condition (§3.4):
       - Skip if archetype has active distribution-shift alert (§3.4).
       - Run retrospective backtest (§3.2): generate alternatives, compute Kelly-growth per alt.
       - Pick best alternative.
       - If best ≠ current, classify direction (tighter/looser).
       - Tighter: insert pending_threshold_revisions row with status='approved', reviewed_by='auto_threshold_manager', reviewed_at=NOW(); write to model_decision_audit_log with decision_type='threshold_adjust'.
       - Looser: insert pending_threshold_revisions row with status='pending', awaits user.
  2. Log summary to experiment_learning_journal with analysisType='threshold_management'.
```

### 3.8 Audit trail (LOCKED)

Every autonomous action writes to `model_decision_audit_log`:

```json
{
  "decision_at": "<NOW>",
  "decision_type": "threshold_adjust",
  "subject": "scope:<scope>:threshold:<threshold_name>",
  "prior_state": { "value": 0.05, "scope": "per_archetype:lower_division" },
  "new_state":   { "value": 0.04, "scope": "per_archetype:lower_division" },
  "reasoning": "Retrospective analysis on 90-day lookback (n=2242 settled bets) suggests min_roi=0.04 maximises Kelly-growth at 0.0023/bet, vs current 0.05 at 0.0019/bet. Direction: tighter (auto-applied).",
  "supporting_metrics": {
    "lookback_days": 90,
    "n_settled_in_lookback": 2242,
    "current_value": 0.05,
    "proposed_value": 0.04,
    "current_kelly_growth": 0.0019,
    "proposed_kelly_growth": 0.0023,
    "alternatives_evaluated": [0.04, 0.045, 0.0475, 0.05, 0.0525, 0.055, 0.06],
    "winner_alternative_kelly_growth": 0.0023,
    "scope_value": "lower_division",
    "threshold_name": "min_roi",
    "direction": "tighter"
  },
  "expected_impact": 0.0004,
  "review_status": "automatic"
}
```

### 3.9 User-facing review surface (LOCKED)

Two new admin endpoints:

- `GET /api/admin/pending-threshold-revisions` — list rows with `status='pending'`. Returns `id, proposed_at, scope, threshold_name, current_value, proposed_value, reasoning, supporting_metrics, expected_impact`.
- `POST /api/admin/threshold-revisions/:id/approve` — flip status to `approved`, set `reviewed_at`, `reviewed_by` from request body.
- `POST /api/admin/threshold-revisions/:id/reject` — flip to `rejected` + `review_note`.

For sub-phase 6 close: these endpoints exist + are queryable. UI can be added later; SQL access is sufficient for now.

---

## 4. Code surface — files modified

### 4.1 NEW: `artifacts/api-server/src/services/autonomousThresholdManager.ts` (~400 lines)

Contains:
- `runAutonomousThresholdManager()` — main cron entry.
- Per-scope iteration logic.
- Retrospective backtest function.
- Proposal generation + classification.
- Helpers: `fetchActiveOverride`, `resolveThreshold`, `computeKellyGrowthForScope`, `replayWithAlternativeThreshold`.

### 4.2 EDIT: `artifacts/api-server/src/services/promotionEngine.ts` (~+50 lines)

- Replace direct `THRESHOLDS.experimentToCandidate.minSampleSize` reads with `await resolveThreshold("min_sample_size", league, archetype)`.
- Same for all 8 threshold dimensions across the 5 transition gates.
- The cron-time evaluator (`evaluateExperimentTag`) now resolves thresholds per-tag dynamically.

### 4.3 EDIT: `artifacts/api-server/src/services/scheduler.ts` (~+8 lines)

- Register `cron.schedule("0 8 * * 0", () => void runAutonomousThresholdManager(), { timezone: "UTC" });`

### 4.4 EDIT: `artifacts/api-server/src/routes/api.ts` (~+30 lines)

- Three new endpoints per §3.9.

### 4.5 EDIT: `artifacts/api-server/src/lib/migrate.ts` (~+5 lines)

- Add partial unique index on `pending_threshold_revisions(threshold_name, scope) WHERE status = 'approved'` so `fetchActiveOverride` is fast.
- (Maybe) deduplicate column for "approved-and-still-current" semantics — see §6.

---

## 5. Sub-commit breakdown (staged ship)

Sub-phase 6 is the LARGEST sub-phase yet. Single megacommit is forbidden per the strategic brief. Five tight commits in sequence:

| # | Sub-commit | Scope | Wall-clock |
|---|---|---|---|
| 6.1 | Schema partial index + `resolveThreshold` lookup chain integrated into `evaluateExperimentTag` | Read-path only. Empty `pending_threshold_revisions` falls through to constants. **Zero behaviour change.** | 1.5h |
| 6.2 | Retrospective analysis function (read-only) | Computes Kelly-growth for current vs alternative thresholds on a sample scope. No writes. Verifiable via direct call. | 2-3h |
| 6.3 | Proposal generator + tighter-application path | Writes `pending_threshold_revisions(status='approved')` + `model_decision_audit_log` for tighter-direction proposals. Looser still writes pending. | 2h |
| 6.4 | Looser-proposal path + admin review endpoints | `GET /pending-threshold-revisions`, `POST .../:id/approve`, `POST .../:id/reject`. | 1h |
| 6.5 | Weekly cron registration + flag-on | env var `autonomous_threshold_manager_enabled` (default 'false' for first 2 weeks of observation; flip to 'true' after manual cron-trigger validation). | 30 min + observation window |

**Total wall-clock: 7-8h active + multi-day observation + user-approval gates between commits.**

Each sub-commit has its own quick-revert (env var flag for 6.5; revert commit for others). Each ships as its own commit message.

---

## 6. Risk register

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Autonomous tighter-application loops into a too-strict regime that halts firehose | High | Medium | Env-var safety floors per threshold (§3.3); minimum lookback n=30; sanity gates on `\|expected_impact\| > 0.0001`. Quick-revert via flag. |
| R2 | Retrospective backtest is computationally expensive at scale (1000s of leagues × 7 alternatives) | Medium | High | Per-scope rate-limiting; only evaluate scopes meeting trigger conditions (§3.4); cache repeated lookups; weekly cadence absorbs the cost. |
| R3 | Approved revisions accumulate and conflict (multiple approved rows per scope) | Medium | Medium | `fetchActiveOverride` orders by `reviewed_at DESC LIMIT 1` — last-approved wins. Old approved rows can be `expired` later. Schema supports this without extra table. |
| R4 | Distribution-shift alert on archetype prevents threshold tuning in that archetype | Low | Medium | This is by design (§3.4) — model-bug investigation comes first. Mitigation: alert clears when |A| drops below 1.5 across two windows. |
| R5 | User overrides an autonomous decision and the model "fights" by re-proposing same change next week | Medium | Medium | Sub-phase 5's `model_decision_audit_log.review_status = 'user_overridden'` field carries override signal. Sub-phase 6 evaluator reads recent overrides (last 30 days) and excludes those (scope, threshold) tuples from auto-apply. Override = sticky for 30 days. |
| R6 | Pre-May-3 Replit-era data pollutes retrospective | High | High | **Default lookback from 2026-05-03 onwards** (env var `THRESHOLD_RETROSPECTIVE_MIN_DATE = '2026-05-03'`). Hard-coded floor in the backtest function. Older data ignored. |
| R7 | Kelly-growth-rate optimisation chooses noise over signal at low N | Medium | Low | Min sample size n=30 per scope before evaluation; bonferroni-style adjustment if needed in v2. |
| R8 | Sub-phase 5 evaluator slowdown from per-tag threshold lookups | Medium | Medium | `resolveThreshold` is a 3-query chain (per-league → per-archetype → global). Cache per-cron-run via in-memory Map. ~10ms overhead per evaluator call; acceptable. |

**Net risk: MEDIUM-HIGH.** The autonomous-decision-making loop is the single biggest behaviour-change in Phase 2. Sub-commit discipline + multiple safety gates + multi-week observation window absorbs the risk.

---

## 7. Wall-clock + sequencing

| Sub-commit | Wall-clock | Observation window |
|---|---|---|
| 6.1 — schema + lookup chain | 1.5h | none (zero behaviour change) |
| 6.2 — retrospective analysis read-only | 2-3h | 1-2 days (verify outputs sensible) |
| 6.3 — tighter-application path | 2h | **2 weeks** before flipping to enabled |
| 6.4 — looser-proposal admin endpoints | 1h | none (just read/write APIs) |
| 6.5 — weekly cron + flag-on | 30 min | **4 weeks** of weekly cron observation |

**Total active: 7-8h.**
**Total observation: 4-6 weeks before sub-phase 6 declared "fully autonomous."**

This is intentionally slow. The autonomous-decision-making is the single biggest leverage point in the system; rushing it risks runaway behaviour.

---

## 8. Quick-revert procedure (per sub-commit)

| Sub-commit | Revert |
|---|---|
| 6.1 | Code revert. Falls back to constants. |
| 6.2 | Code revert. Read-only function, removable. |
| 6.3 | Soft: env var `autonomous_threshold_apply_enabled='false'` blocks new tighter writes. Hard: code revert. |
| 6.4 | Code revert removes endpoints. |
| 6.5 | Soft: `autonomous_threshold_manager_enabled='false'`. Hard: code revert removes cron. |

**Worst-case rollback:** UPDATE all `pending_threshold_revisions` rows with `status='approved'` AND `reviewed_by='auto_threshold_manager'` to `status='rejected'`. Engine falls back to constants on next call. Sub-phase 5's evaluator continues to work with static thresholds.

---

## 9. Verification SQL — per sub-commit

Each sub-commit has its own verification gate.

```sql
-- 6.1 verification: lookup chain works, falls through to constants on empty table
SELECT
  pg_get_indexdef(i.oid)
FROM pg_class i
WHERE i.relname LIKE 'pending_threshold_revisions_status%';
-- Confirm new partial unique index on (threshold_name, scope) WHERE status='approved'.

-- 6.2 verification: retrospective backtest produces sensible output
-- (manually trigger via admin endpoint; inspect logs)

-- 6.3 verification: tighter proposals applied; audit trail
SELECT
  decision_at, subject,
  prior_state->>'value' AS prev,
  new_state->>'value' AS new,
  supporting_metrics->>'direction' AS dir,
  expected_impact
FROM model_decision_audit_log
WHERE decision_type = 'threshold_adjust'
ORDER BY decision_at DESC LIMIT 20;

-- 6.4 verification: pending revisions queryable via API
SELECT id, scope, threshold_name, status, direction
FROM pending_threshold_revisions
ORDER BY proposed_at DESC LIMIT 10;

-- 6.5 verification: weekly cron firing
SELECT * FROM cron_executions
WHERE job_name = 'autonomous_threshold_manager'
ORDER BY started_at DESC LIMIT 5;
```

---

## 10. What this sub-phase does NOT do

- **Does not modify settlement-time behaviour** beyond sub-phase 5's evaluator using dynamic thresholds.
- **Does not change `paper_bets` schema or settlement code paths.**
- **Does not change correlation / duplicate-bet rejection.**
- **Does not modify `BANNED_MARKETS` or banned-market reactivation logic.**
- **Does not touch `experiment_registry.kelly_fraction` outside the autonomous-decision path.**
- **Does not auto-readmit `abandoned` experiments.** That's per v2 §3.3 + sub-phase 10.
- **Does not implement per-bet stake adjustment.** Sub-phase 9 owns Kelly-ratchet wiring.

---

## 11. Cross-wave invariants reinforced

- **Tier A behaviour byte-identical** under autonomous threshold management. Verified via canary diff on first 6.3 deployment.
- **£0 experiment-track stake architectural guarantee.** Sub-phase 6 cannot raise experiment-tier `kelly_fraction` above 0 (hard-coded constraint in §3.5).
- **User-approval invariant on looser thresholds.** Hard-coded; `direction='looser'` writes always go to `status='pending'`.
- **Per-league granularity** preserved end-to-end. No collapsing across leagues.
- **Kelly-growth-rate** is the optimisation target, not raw ROI.

---

## 12. Sign-off — STOP

Code commits affecting threshold semantics + autonomous decision-making are user-approval-gated. Approve any/all:

- [ ] §3.1 threshold storage: REUSE `pending_threshold_revisions` (no new schema) OK?
- [ ] §3.2 retrospective methodology (walk-forward backtest, alternatives ±10/25/50%, Kelly-growth winner) OK?
- [ ] §3.3 Kelly-growth-impact computation as `expected_impact` OK?
- [ ] §3.4 per-league > per-archetype > global precedence + skip-on-distribution-shift-alert OK?
- [ ] §3.5 per-league dynamic kelly_fraction with `MAX_AUTONOMOUS_KELLY_FRACTION=0.5` ceiling OK?
- [ ] §3.6 weekly cron at `0 8 * * 0 UTC` OK?
- [ ] §3.8 audit trail format (with Kelly-growth in supporting_metrics) OK?
- [ ] §3.9 admin review endpoints OK?
- [ ] §5 sub-commit breakdown OK?
- [ ] §6 risk register accepted (esp. R1, R5, R6)?
- [ ] §11 cross-wave invariants OK?

**Particularly important:**
- §3.5 Kelly-fraction ceiling at 0.5 — the model can autonomously increase Kelly stake to 0.5× full Kelly without your approval. This is the single biggest behaviour-change in Phase 2. Confirm comfort.
- §6 R1 + R6 — autonomous tighter-loop runaway risk + Replit-era data pollution.

If approved: I begin sub-commit 6.1 (smallest, lowest-risk — just adds the lookup chain, zero behaviour change since the override table is empty).

Stopping. Awaiting Wave 3 #2 / sub-phase 6 approval.
