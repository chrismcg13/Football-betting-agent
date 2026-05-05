# Real-Money Go-Live Checklist

**Purpose:** define the irreversible safety-boundary state that must be in force at the moment any real-money bet is placed. These boundaries are intentionally relaxed during paper-mode operation for unconstrained data gathering. This document lists what must be tightened (and to what values) before `paper_mode` flips from `true` to `false`, before `experiment_track_enabled` produces real-money stakes (post-graduation), or before any code path bypasses `paper_mode` to place a non-zero-stake real bet.

**Status:** active — boundaries currently relaxed. **Do not flip `paper_mode = false` without first executing this checklist in full.**

**Authored:** 2026-05-05, sub-phase 1 of the strategic Phase 2 push.

---

## 1. Why this exists

The strategic Phase 2 brief (2026-05-05) defined the following parameters as **user-approval-gated** — the model can tighten them autonomously but cannot loosen them. The diagnostic in `docs/phase-2-diagnostic-findings.md` §-1 surfaced that these are currently set to **effectively-disabled** values:

| Parameter | Brief-stated default | Current paper-mode value | Status |
|---|---|---|---|
| `bankroll_floor` | £200 | **£0** | Disabled |
| `daily_loss_limit_pct` | 5% (`0.05`) | **99% (`0.99`)** | Disabled |
| `weekly_loss_limit_pct` | 10% (`0.10`) | **99% (`0.99`)** | Disabled |
| `max_stake_pct` | 2% (`0.02`) | **2% (`0.02`)** post-2026-05-05 fix | Restored to brief default |

The user has made an explicit decision to keep these at relaxed values for the duration of paper-mode, on the grounds that:
- Both production track (Tier A, paper_mode=true) and experiment track (Tier B/C, stake=0 by design) currently bet **£0 actual capital**.
- Drawdown circuit breakers, bankroll floors, and stake-size caps protect real-money capital that is not currently flowing.
- Aggressive paper-mode data gathering needs the full distribution to be observed without circuit-breaker trips on natural variance.

**The "model can tighten but not loosen" principle from the brief applies from the moment real money flows, not before.**

This document is the contract that says: at the moment of transition from paper to real, the boundaries snap back to defensible values.

---

## 2. The check itself — what must be true before real-money can flow

The system must enforce this checklist **automatically** at the experiment_track → production_track promotion gate (sub-phase 5) and at any code path that flips `paper_mode = false`.

### 2.1 Boundary parameters that must be set to valid values

| Parameter | Constraint at go-live | Rationale |
|---|---|---|
| `bankroll_floor` | **TBD at go-live based on actual bankroll, not less than 5% of opening capital.** Concrete value to be set before flip; must be ≥ 5% × current bankroll. | A bankroll floor below 5% means the agent can liquidate to near-zero before stopping. 5% gives a defensible re-evaluation point if drawdown approaches. |
| `daily_loss_limit_pct` | **TBD at go-live, suggested range 0.05 to 0.10.** Concrete value to be set before flip; must be ≤ 0.10. | 5% daily is the brief's stated default; 10% is the upper bound for high-conviction operational phases. Above 10% the daily cap stops protecting against a single bad day. |
| `weekly_loss_limit_pct` | **TBD at go-live, suggested range 0.10 to 0.20.** Concrete value to be set before flip; must be ≤ 0.20. | 10% weekly is the brief's stated default; 20% is the upper bound. Above 20% the weekly cap stops protecting against a sustained losing streak. |
| `max_stake_pct` | **0.02 (restored 2026-05-05).** Already at brief default — no change needed at go-live. | Brief default. Already restored as part of sub-phase 1's safety-boundary deferral resolution (see §3 below for the rationale of the 2026-05-05 restoration timing). |

### 2.2 Other invariants that must hold at the flip

These are not config-parameter values; they are system-state invariants. The flip code path must verify all of these are true before allowing `paper_mode = false`.

| Invariant | Why |
|---|---|
| `agent_status = 'running'` | A paused agent cannot place bets; flipping while paused leaves real money exposed to whatever cron runs first. |
| `experiment_track_enabled = 'false'` initially when flipping `paper_mode` | Real money should reach the experiment track only via a deliberate second decision after observing real-money production-track behaviour for at least one settlement cycle. |
| Drawdown circuit breakers tested | Run a simulated 5%/10% breach and confirm the breaker fires. Tested at flip time; logged to `compliance_logs`. |
| Bankroll floor enforced | Confirm a synthetic bet that would breach the floor is rejected at placement (use `agent_config.value` introspection in a test rather than a real bet). |
| `model_decision_audit_log` table exists and is being written | Sub-phase 6 deliverable. The audit log is the brief's autonomy-with-traceability mechanism. Real money cannot flow without it. |
| `graduation_evaluation_log` table exists and is being written | Sub-phase 5 deliverable. Same logic — automatic graduation gates need audit trails before real money flows through them. |

### 2.3 Pre-flight verification queries

Run all of these immediately before flipping `paper_mode = false`. Every one must return the expected result. If any fails, **abort the flip**.

```sql
-- Q-flip-1: Boundary parameters at acceptable values
SELECT key, value::numeric AS v,
  CASE
    WHEN key = 'bankroll_floor'         AND value::numeric >= (SELECT value::numeric * 0.05 FROM agent_config WHERE key = 'bankroll')
      THEN 'ok'
    WHEN key = 'daily_loss_limit_pct'   AND value::numeric > 0 AND value::numeric <= 0.10 THEN 'ok'
    WHEN key = 'weekly_loss_limit_pct'  AND value::numeric > 0 AND value::numeric <= 0.20 THEN 'ok'
    WHEN key = 'max_stake_pct'          AND value::numeric > 0 AND value::numeric <= 0.02 THEN 'ok'
    ELSE 'ABORT'
  END AS verdict
FROM agent_config
WHERE key IN ('bankroll_floor','daily_loss_limit_pct','weekly_loss_limit_pct','max_stake_pct')
ORDER BY key;

-- Q-flip-2: Other system-state invariants
SELECT
  (SELECT value FROM agent_config WHERE key = 'agent_status')                          AS agent_status_should_be_running,
  (SELECT value FROM agent_config WHERE key = 'experiment_track_enabled')              AS experiment_track_should_be_false,
  (SELECT 1 FROM information_schema.tables WHERE table_name = 'model_decision_audit_log') AS decision_audit_log_table_should_exist,
  (SELECT 1 FROM information_schema.tables WHERE table_name = 'graduation_evaluation_log') AS grad_eval_log_table_should_exist;
```

**Pass criterion:** Q-flip-1 returns 4 rows all with verdict='ok'. Q-flip-2 returns single row with `agent_status='running'`, `experiment_track='false'` (or NULL — defaults to false), both `_should_exist` columns = 1.

---

## 3. The 2026-05-05 max_stake_pct decision

`max_stake_pct` was raised from the brief default of `0.02` to `0.03` at some point on 2026-04-16 (per `agent_config.updated_at`). This was outside the brief's "tighten only" discipline because the brief did not exist at that time.

The user posed two options for resolution:
- **(a)** Set `max_stake_pct = 0.02` now, accepting that paper-mode shadow stakes reflect eventual real-money sizing.
- **(b)** Keep `max_stake_pct = 0.03` during paper-mode, normalise via `shadow_stake_kelly_fraction` at graduation-gate time.

**Decision: (a) — set to 0.02 now, applied 2026-05-05.**

**Rationale (Kelly-growth-rate framing per the brief's optimisation objective):**

1. **Cleaner downstream computation.** Kelly-optimal long-term growth rate is `E[log(1 + f·X)]` where `f` is fraction-of-bankroll bet. If `f` changes between the data-gathering phase (paper-mode at 0.03) and the deployment phase (real-money at 0.02), the Kelly-growth-rate estimate computed from paper-mode data systematically over-estimates the rate that real-money will actually achieve. Sub-phase 6's autonomous threshold-management logic — which the brief specifies must explicitly compute log-bankroll-growth — then makes decisions on a stale projection.
2. **Aligns with brief discipline.** The brief explicitly states `max_stake_pct` defaults to 0.02 and the model can tighten autonomously (model authority confirmed). Setting 0.02 now exercises that authority without crossing into loosening territory.
3. **Practical impact in paper-mode is minimal.** For experiment-track shadow bets, `stake = 0` regardless of the cap. For Tier A bets in paper-mode, `paper_mode = true` means the trade doesn't execute at any non-zero capital impact. The only effect is that recorded `shadow_stake` values for Kelly-binding bets are computed against the 2% cap — which is more accurate of what real-money will deploy.
4. **Forward continuity.** When real-money flips on, the data we gathered already reflects the same cap. No normalisation jump.
5. **Option (b) requires schema work.** Capturing per-bet `max_stake_pct_at_placement` would need a new column. Option (a) is a single SQL UPDATE. Lower-risk, simpler surface.

**Net:** the decision is a tightening within the brief's authority envelope. No edge-survival graduation comparison is invalidated, because ROI is scale-invariant under stake cap changes (pnl scales linearly with stake; the ratio is constant).

**The decision is logged here as the durable record. Future autonomous-decision sessions must consult this document before adjusting `max_stake_pct`.**

---

## 4. Reference contract — sub-phase 5 promotion-gate logic must check this

The brief's sub-phase 5 (event-driven graduation) implements the experiment_track → production_track promotion gate. Per the strategic-push discipline, the promotion gate must:

```
function canPromote(experimentTag): boolean {
  // ... edge-survival, ROI, p-value, sample-size checks ...

  // Real-money safety check — applies only when promotion target is the
  // production track (real-money) and paper_mode is about to flip.
  if (targetTier === 'promoted' && agentConfig.paper_mode === 'false') {
    if (!verifyGoLiveChecklist()) {
      logger.error("PROMOTION BLOCKED — go-live checklist failed");
      return false;
    }
  }

  return true;
}

function verifyGoLiveChecklist(): boolean {
  // Run Q-flip-1 and Q-flip-2 from §2.3.
  // Return true iff every row passes.
}
```

**This is non-optional.** The contract is: real money cannot flow through automated graduation without the checklist passing. If the agent attempts to promote during a state where the checklist fails, the promotion is blocked with a critical-severity alert raised.

This document is the canonical reference for `verifyGoLiveChecklist` semantics. If the values in §2.1 are revised, this document is updated and the promotion-gate code is updated to match.

---

## 5. Restoration DML at go-live

When real-money is about to flip on, run the following sequence (with explicit user approval at every step, per the brief's safety-boundary discipline):

```sql
-- Step 1: tighten boundaries to go-live values. Specific numbers TBD by user
-- at the moment of flip; the values below are the brief's recommended floor.
UPDATE agent_config SET value = '<TBD ≥ 5% × bankroll>', updated_at = NOW()
  WHERE key = 'bankroll_floor';
UPDATE agent_config SET value = '<TBD ≤ 0.10>',          updated_at = NOW()
  WHERE key = 'daily_loss_limit_pct';
UPDATE agent_config SET value = '<TBD ≤ 0.20>',          updated_at = NOW()
  WHERE key = 'weekly_loss_limit_pct';
-- max_stake_pct already 0.02 from 2026-05-05; no change needed.

-- Step 2: log the decision in compliance trail
INSERT INTO compliance_logs (action_type, details, timestamp)
VALUES (
  'go_live_boundaries_set',
  jsonb_build_object(
    'bankroll_floor', (SELECT value FROM agent_config WHERE key = 'bankroll_floor'),
    'daily_loss_limit_pct', (SELECT value FROM agent_config WHERE key = 'daily_loss_limit_pct'),
    'weekly_loss_limit_pct', (SELECT value FROM agent_config WHERE key = 'weekly_loss_limit_pct'),
    'max_stake_pct', (SELECT value FROM agent_config WHERE key = 'max_stake_pct'),
    'set_at', NOW(),
    'set_by', 'real_money_go_live_checklist'
  ),
  NOW()
);

-- Step 3: run pre-flight verification (Q-flip-1 + Q-flip-2 from §2.3).
-- All must pass.

-- Step 4: ONLY if all of the above pass, flip paper_mode.
UPDATE agent_config SET value = 'false', updated_at = NOW() WHERE key = 'paper_mode';
INSERT INTO compliance_logs (action_type, details, timestamp)
VALUES ('paper_mode_flipped_to_false', jsonb_build_object('flipped_at', NOW()), NOW());
```

**Step 2 (compliance log) is the durable audit trail.** Step 4 happens only if every pre-flight returns 'ok'.

---

## 6. agent_config marker row

A row in `agent_config` with key `real_money_go_live_checklist` carries a JSON payload referencing this document. It serves as the always-loadable reminder that boundaries are deferred. The DML is in `docs/phase-2-diagnostic-findings.md` §10 (the sub-phase 1 deliverable DML block).

```json
{
  "status": "deferred_until_real_money",
  "reason": "Both tracks bet £0 in paper-mode; circuit breakers protect real-money capital not currently flowing.",
  "doc": "docs/real-money-go-live-checklist.md",
  "boundaries_at_go_live": {
    "bankroll_floor":         { "value": "TBD", "constraint": ">= 5% * bankroll" },
    "daily_loss_limit_pct":   { "value": "TBD", "constraint": "0 < value <= 0.10" },
    "weekly_loss_limit_pct":  { "value": "TBD", "constraint": "0 < value <= 0.20" },
    "max_stake_pct":          { "value": "0.02", "constraint": "0 < value <= 0.02", "note": "restored 2026-05-05" }
  },
  "max_stake_pct_decision": {
    "applied": "2026-05-05",
    "rationale": "Option (a) per docs/real-money-go-live-checklist.md §3"
  },
  "deferred_at": "2026-05-05",
  "deferred_by": "user_explicit_resolution"
}
```

---

## 7. Sign-off

- [x] §2 boundary values agreed (TBD-at-go-live form).
- [x] §3 max_stake_pct decision recorded — option (a), set to 0.02 on 2026-05-05.
- [ ] §4 sub-phase 5 promotion-gate code references this document. (Sub-phase 5 deliverable.)
- [ ] §6 agent_config marker row inserted. (Sub-phase 1 DML, awaiting user run.)

**Authoritative version:** this file. If it conflicts with anything else (other docs, code comments), this file wins.
