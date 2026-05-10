# Reliability Architecture

VPS-first observability with selective Neon mirroring. **Signal goes to Neon, noise stays on the VPS.** This document is the cost-discipline forcing function: every Neon write must justify itself here.

## Storage strategy at a glance

| Layer | Purpose | Volume guarantee |
|---|---|---|
| **Neon Postgres** | Audit, state-of-truth, last-N-cycles for cross-VPS visibility | ~75 MB amber / 200 MB red across observability tables |
| **VPS SQLite** (`/var/lib/agent/observability.db`) | Per-step breadcrumbs for every cycle, per-call traces | 7-day retention, free local I/O |
| **VPS filesystem** | Structured JSON logs (pino) | logrotate daily, gzip, 14-day retention |

The failure mode this design avoids in BOTH directions:
- **Don't write every cron tick to Neon** (volume scales with cron frequency → blows budget).
- **Don't keep all debug context VPS-local only** (lose everything if disk dies mid-incident).

The selective-mirror patterns get the best of both.

## Tables and write rationale

### Append-on-real-event (volume = real events / day)

#### `self_healing_actions`
- **Write trigger:** A real self-healing action fires (stuck-lock release, watchdog process exit, ledger reconcile, scheduled cleanup execution).
- **Why Neon, not VPS-only:** Audit trail of "what the system did about it" must survive a VPS rebuild — that's exactly when you want to know what auto-actions happened.
- **Volume:** scales with failure count, not cron frequency. ~10–100 rows/day in steady state.
- **Retention:** indefinite (small enough).

#### `escalations`
- **Write trigger:** Severity ≥ warning event raised AND dispatched to a notification channel (Telegram/Slack/email).
- **Why Neon:** lifecycle (raised → delivered → acknowledged → resolved) is operator-of-record state. Distinct from `alerts` table — alerts are intra-process, escalations have crossed the human boundary.
- **Volume:** real problems / day. <50/year in healthy steady state.
- **Retention:** indefinite.

### State-of-truth (one canonical row per entity)

#### `placement_reconciliation`
- **Write trigger:** Every reconciliation pass UPSERTs the row for that bet.
- **Why Neon:** the state-of-the-world for "is this bet's recorded status consistent with Betfair's." Per-pass history goes to VPS SQLite (and to `mismatch_pass_history` only when mismatched).
- **Volume:** bounded by paper_bets row count. UPSERT pattern keeps it bounded.

#### `system_health`
- **Write trigger:** UPSERT (`ON CONFLICT (component) DO UPDATE`) only when `status` changes OR `last_check_at` would lag >5 min.
- **Why Neon:** /diagnostics needs to read this from anywhere. Component count is fixed (~10).
- **Volume:** ~10 rows total, never grows. **Critical:** writers must never INSERT, always UPSERT keyed by component.

### Daily rollup (volume = 1 row/day)

#### `reliability_daily_summary`
- **Write trigger:** End-of-UTC-day cron rolls up VPS SQLite into one row.
- **Why Neon:** source of truth for the daily ops digest. Survives VPS rebuild (you need historical performance even after disk loss).
- **Volume:** 365/year. ~5 MB/year max.

### Selective-mirror patterns (the new bit)

#### `recent_cycles_buffer` — fixed ring buffer of the last 200 cycles
- **Write trigger:** end-of-cycle hook INSERTs one summary row, then runs:
  ```sql
  DELETE FROM recent_cycles_buffer
  WHERE cycle_id NOT IN (SELECT cycle_id FROM recent_cycles_buffer ORDER BY started_at DESC LIMIT 200)
  ```
- **Why Neon:** ~50 hours of cycle-level visibility from anywhere even if the VPS is unavailable. Phone-debuggable.
- **Volume:** exactly ~200 rows ≈ 5 MB total. **The DELETE-by-rank is the bound — without it, this would grow without limit.**

#### `failed_cycle_breadcrumbs` — full breadcrumbs only on failure
- **Write trigger:** end-of-cycle hook detects `terminal_outcome='failed' OR 'stalled'`, copies that cycle's `pipeline_step_outcomes` rows from VPS SQLite to Neon.
- **Why Neon:** when something failed is exactly when you need full breadcrumbs from anywhere. Successful cycles' breadcrumbs stay VPS-local.
- **Volume:** at 5% failure rate × 7 steps/cycle × 100 cycles/day = ~35 rows/day. At 30-day retention ≈ 1k rows steady state. Trivial.
- **Retention:** 30 days, unless cycle_id is referenced by an open escalation (then keep until resolved + 30 days).

#### `mismatch_pass_history` — passes only for currently-problematic bets
- **Write trigger:** reconciliation pass on a bet where `mismatch_class IS NOT NULL`.
- **Why Neon:** the cost only appears when something is actually broken — exactly when you want it.
- **Volume:** bounded by open-mismatch count, not bet count. Healthy = near zero. Bad week with 20 ghosts × 5 passes ≈ 100 rows.
- **Retention:** 30 days after the mismatch resolves.

## Cost ceiling

Weekly cron queries `pg_database_size()` and per-table sizes. Writes to `system_health.detail` keyed by `component='neon_storage'`. Thresholds:

| Threshold | Combined size of observability tables | Action |
|---|---|---|
| Green | < 75 MB | normal |
| **Amber** | 75–200 MB | escalation: investigate which table is growing |
| **Red** | > 200 MB | escalation + automatic disable of high-volume writers (placement_reconciliation upserts excepted) |

If amber fires, something unexpected is being written to Neon — investigate immediately. The whole design is "<10 MB steady-state for everything except `placement_reconciliation`."

## Egress budget

Estimated daily egress in steady state:

| Source | Estimate |
|---|---|
| `/diagnostics` from phone (~10 hits/day) | ~300 KB |
| Watchdog reads from Neon | ~zero (it primarily writes) |
| Reconciliation reads from `placement_reconciliation` | ~50 KB/day |
| Other crons | negligible |
| **Total** | **< 1 MB/day** |

Free tier handles this. Paid tier line item should be unnoticeable. If egress climbs, we're either reading too eagerly or there's a runaway loop.

## Cleanup policy

**Neon (nightly cron at 03:30 UTC):**
1. `failed_cycle_breadcrumbs`: delete rows older than 30 days where `cycle_id` is not referenced by an open escalation.
2. `mismatch_pass_history`: delete rows older than 30 days where the mismatch is resolved.
3. Manual `VACUUM` on both tables.
4. Write one summary row to `self_healing_actions`: `{action_type: "neon_cleanup", detail: {rows_deleted, mb_reclaimed, tables}}`.

**VPS SQLite (nightly):**
- `pipeline_step_outcomes`: delete rows older than 7 days, then `VACUUM`.
- `reconciliation_passes`: delete rows older than 7 days, then `VACUUM`.
- `betfair_api_calls`: delete rows older than 3 days, then `VACUUM`.

If the Neon cleanup hasn't run successfully in 36 hours → escalate.

## Working order (Phase plan)

1. **Phase 1 — audit (DONE).** E2E review of monitoring & self-healing gaps. Output: prioritised gap list.
2. **Phase 2 — DDL on dev (THIS COMMIT).** Schema for the 8 Neon tables defined in `lib/db/src/schema/reliability.ts`. Drizzle generates migration. Apply on dev DB first, soak 24h, then prod.
3. **Phase 3 — watchdog + observers in DETECT-ONLY mode.** Code writes to `system_health` + `recent_cycles_buffer` + (on failure) `failed_cycle_breadcrumbs`. No auto-actions yet. Soak 24h while we verify writes are bounded as predicted.
4. **Phase 4 — enable auto-actions.** Self-healing for: stale cron → process restart, stuck reconciliation lock → release, drift threshold breach → kill switch (existing). Escalation channel wired (Telegram/Slack/email).

Phase 3 must run a full 24 hours before Phase 4. Non-negotiable.

## Why each Neon write exists (the audit list)

This section is the cost-discipline contract: every place in the codebase that writes to Neon must be listed here with the justification. **Adding a Neon writer without updating this section is a code-review blocker.**

| Write site | Table | Trigger | Justification |
|---|---|---|---|
| _(Phase 3 will add entries)_ | | | |

When Phase 3 lands, this table will list every `db.insert(...)` and `db.execute(sql\`INSERT/UPDATE...\`)` against the eight observability tables, with one-line justification each. If a row in this table doesn't make sense, the writer comes out.

## Operational runbook (skeleton)

When `/diagnostics` shows red:

1. Check `system_health` for failing components.
2. Check `escalations` WHERE resolved=false ORDER BY raised_at DESC.
3. Check last 10 `self_healing_actions` — has the system already tried to recover?
4. Check `recent_cycles_buffer` for terminal_outcome trends.
5. If a specific cycle is suspect, check `failed_cycle_breadcrumbs` WHERE cycle_id=X.
6. If a specific bet is mismatched, check `mismatch_pass_history` WHERE internal_bet_id=X.

## Non-goals

- **Real-time metrics dashboard.** This isn't Grafana — it's a forensic+reliability layer. For real-time, query the live tables directly via Neon SQL.
- **Per-call Betfair tracing in Neon.** That stays VPS-local in `betfair_api_calls`. Volume too high.
- **Replacing alerts table.** `alerts` stays as-is (intra-process). `escalations` is what dispatches alerts to humans.
- **Replacing compliance_logs.** `compliance_logs` stays as the application audit log. Reliability tables are operational.
