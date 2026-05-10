# Reliability Architecture

VPS-first observability with selective Neon mirroring. **Signal goes to Neon, noise stays on the VPS.** This document is the cost-discipline forcing function: every Neon write must justify itself here.

## Storage strategy at a glance

| Layer | Purpose | Volume guarantee |
|---|---|---|
| **Neon Postgres** | Audit, state-of-truth, last-N-cycles + 5-min rollups for phone-debug | ~100 MB amber / 200 MB red across observability tables |
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
- **Volume:** bounded by the bets table row count (live bets only post-cutover; paper-bet emission is permanently disabled). UPSERT pattern keeps it bounded.

#### `system_health`
- **Write trigger:** UPSERT (`ON CONFLICT (component) DO UPDATE`) only when `status` changes OR `last_check_at` would lag >5 min.
- **Why Neon:** /diagnostics needs to read this from anywhere. Component count is fixed (~10).
- **Volume:** ~10 rows total, never grows. **Critical:** writers must never INSERT, always UPSERT keyed by component.

### Daily rollup (volume = 1 row/day)

#### `reliability_daily_summary`
- **Write trigger:** End-of-UTC-day cron rolls up VPS SQLite into one row.
- **Why Neon:** source of truth for the daily ops digest. Survives VPS rebuild (you need historical performance even after disk loss).
- **Volume:** 365/year. ~5 MB/year max.

### 5-minute time-series rollups (phone-debug trend visibility)

These two tables exist because the phone-only triage requirement firmed up: I need to be able to answer "what component is failing, since when, and at what rate" without SSHing the VPS. Point-in-time `system_health` answers "now"; these answer "trend".

#### `health_5m_rollup` — per-component status time-series
- **Write trigger:** every component status update UPSERTs the (component, bucket_start) row. Bucket is `date_bin('5 minutes', NOW(), TIMESTAMP '2000-01-01')`. ON CONFLICT picks the worst-seen status in the bucket via CASE — atomic single-statement.
- **Why Neon:** "was trading flapping overnight?" answered with one SELECT on the phone.
- **Volume:** ~10 components × 288 buckets/day = 2,880 rows/day. At 14-day retention ≈ 40k rows ≈ 5 MB. UPSERT-keyed — bounded.
- **Retention:** 14 days. Cleanup nightly.

#### `cycle_counters_5m` — system-wide cycle/bet counters time-series
- **Write trigger:** end-of-cycle hook UPSERTs the bucket with atomic counter increments via `INSERT ... ON CONFLICT (bucket_start) DO UPDATE SET cycles_run = cycle_counters_5m.cycles_run + EXCLUDED.cycles_run, ...`. PG row-locks serialise concurrent inserts — no read-modify-write race.
- **Why Neon:** directly answers the silent-failure mode. "Are we placing bets right now?" — `SELECT bets_placed FROM cycle_counters_5m WHERE bucket_start > NOW() - INTERVAL '6 hours' ORDER BY bucket_start`. Zeros despite selections existing = silent failure happening **now**.
- **Volume:** 288 rows/day max. At 14-day retention ≈ 4k rows ≈ 2 MB.
- **Retention:** 14 days. Cleanup nightly.

### Selective-mirror patterns

#### `recent_cycles_buffer` — fixed ring buffer of the last 500 cycles
- **Write trigger:** end-of-cycle hook INSERTs one summary row, then runs:
  ```sql
  DELETE FROM recent_cycles_buffer
  WHERE cycle_id NOT IN (SELECT cycle_id FROM recent_cycles_buffer ORDER BY started_at DESC LIMIT 500)
  ```
- **Why Neon:** ~42 hours of cycle-level visibility from anywhere even if the VPS is unavailable. Phone-debuggable. Lets you catch "this started Wednesday" patterns.
- **Volume:** exactly ~500 rows ≈ 12 MB total. **The DELETE-by-rank is the bound — without it, this would grow without limit.**

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
| Green | < 100 MB | normal |
| **Amber** | 100–200 MB | escalation: investigate which table is growing |
| **Red** | > 200 MB | escalation + automatic disable of high-volume writers (placement_reconciliation upserts excepted) |

Predicted steady-state footprint:
- `recent_cycles_buffer` ≈ 12 MB (capped at 500)
- `health_5m_rollup` ≈ 5 MB (14-day window)
- `cycle_counters_5m` ≈ 2 MB (14-day window)
- `failed_cycle_breadcrumbs` ≈ 1 MB (30-day window, failure-rate dependent)
- `mismatch_pass_history` ≈ near-zero in healthy weeks
- `self_healing_actions` + `escalations` + `system_health` + `reliability_daily_summary` ≈ <2 MB
- `placement_reconciliation` ≈ scales with bet count
- **Total observability budget ≈ 25 MB plus reconciliation table.**

If amber fires (4× predicted), something unexpected is being written. Investigate immediately.

### Per-table row-count guards (specifically for ring-buffered tables)

`recent_cycles_buffer` is bounded by application-level discipline (post-INSERT DELETE-by-rank in the writer), not by DDL. A writer bug — or any future code path that INSERTs without the prune — could leak unbounded rows. The weekly storage check therefore runs an explicit row-count guard outside the writer's code path so the policy bound is observable from outside:

```sql
-- Run weekly as part of the storage size check.
SELECT COUNT(*) as row_count FROM recent_cycles_buffer;
```

| Threshold | Row count | Action |
|---|---|---|
| Green | ≤ 500 | normal — DELETE-by-rank is doing its job |
| **Amber** | 501–550 | escalation: writer is leaking; investigate within 24h |
| **Red** | > 1000 | escalation + emergency DELETE-by-rank to restore the cap |

The 50-row amber margin (500→550) absorbs transient overshoot during a writer cycle (INSERT happens, DELETE follows; a checker that races between them sees up to N+1 rows briefly). 1000 means the cap discipline has fully broken.

The other rollup tables (`health_5m_rollup`, `cycle_counters_5m`) are bounded by time-based cleanup, not application discipline, so they don't need a row-count guard at this level. Their hard-bounded UPSERT key (component+bucket / bucket alone) plus 14-day retention naturally caps growth.

## Egress budget

Estimated daily egress in steady state:

| Source | Estimate |
|---|---|
| `/diagnostics` from phone (~10 hits/day, 30s memory cache) | ~300 KB |
| `health_5m_rollup` reads (last 288 rows for 1 component per hit) | ~50 KB/hit × ~10 hits = ~500 KB |
| `cycle_counters_5m` reads (last 288 rows per hit) | ~30 KB/hit × ~10 hits = ~300 KB |
| Watchdog reads from Neon | ~zero (it primarily writes) |
| Reconciliation reads from `placement_reconciliation` | ~50 KB/day |
| Other crons | negligible |
| **Total** | **< 5 MB/day at heavy phone-refresh** |

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
| _(Phase 3, planned)_ — `selfHealing.recordAction()` | `self_healing_actions` | every recovery action | audit trail of auto-actions, must survive VPS rebuild |
| _(Phase 3, planned)_ — `escalation.dispatch()` | `escalations` | severity≥warning + delivery to channel | operator-of-record state across raise→ack→resolve. **Indexed on (severity, raised_at)** for phone-debug "criticals only" filter. |
| _(Phase 3, planned)_ — reconciliation cron | `placement_reconciliation` | every reconciliation pass per bet | canonical state-of-truth, in-place UPSERT |
| _(Phase 3, planned)_ — `health.update(component, status)` | `system_health` | status change OR last_check_at lag >5m | `/diagnostics` reads this for "now" view; UPSERT keyed by component (bounded ~10 rows). **Writer MUST cap `detail` size**: truncate string values >1KB, never store stack traces. |
| _(Phase 3, planned)_ — `health.update(...)` (same call) | `health_5m_rollup` | every status update | per-component 14-day trend for phone-debug; UPSERT (component, bucket_start) with worst-status CASE. **Writer MUST compute `bucket_start` inside the SQL via `date_bin('5 minutes', NOW(), TIMESTAMPTZ '2000-01-01 00:00:00+00')`** — never accept a timestamp from the caller (prevents resurrected-bucket bugs). |
| _(Phase 3, planned)_ — end-of-cycle hook | `cycle_counters_5m` | every cycle terminus | system-wide silent-failure detector; UPSERT (bucket_start) with atomic counter increment. Same `date_bin(NOW(), ...)` discipline as `health_5m_rollup`. |
| _(Phase 3, planned)_ — end-of-cycle hook | `recent_cycles_buffer` | every cycle terminus | 500-row ring buffer; INSERT + DELETE-by-rank in same statement |
| _(Phase 3, planned)_ — end-of-cycle hook (failed cycles only) | `failed_cycle_breadcrumbs` | terminal_outcome ∈ {failed, stalled} | full forensic context, copied from VPS SQLite, 30-day retention. **Writer MUST use `INSERT ... ON CONFLICT (cycle_id, step_seq) DO NOTHING`** — VPS→Neon copy is retry-prone; uniqueness constraint prevents duplicates from network-blip retries. |
| _(Phase 3, planned)_ — reconciliation cron (mismatched bets only) | `mismatch_pass_history` | bet has mismatch_class != NULL | per-pass history bounded by open-mismatch count |
| _(Phase 4, planned)_ — daily rollup cron | `reliability_daily_summary` | 1 row per UTC day | daily ops digest source; survives VPS rebuild |

If a row above doesn't make sense at code-review time, the writer comes out. Phase 3 PRs will replace `(planned)` with the actual file:line of the writer.

## Operational runbook (phone-first triage)

When `/diagnostics` shows red, the phone-resolvable queries (in escalating depth):

```sql
-- 1. Are we placing bets right now? (silent-failure detector)
SELECT bucket_start, cycles_run, cycles_zero_bets, bets_placed, bets_failed
FROM cycle_counters_5m
WHERE bucket_start > NOW() - INTERVAL '6 hours'
ORDER BY bucket_start DESC;

-- 2. Was anything flapping overnight? (component health trend)
SELECT bucket_start, dominant_status, error_count, last_error_class
FROM health_5m_rollup
WHERE component = 'trading_near'    -- swap as needed
  AND bucket_start > NOW() - INTERVAL '24 hours'
ORDER BY bucket_start DESC;

-- 3. What's currently broken?
SELECT component, status, last_status_change_at, consecutive_failures, detail
FROM system_health
WHERE status != 'ok';

-- 4. Has the system tried to recover?
SELECT occurred_at, action_type, component, success, detail
FROM self_healing_actions
ORDER BY occurred_at DESC LIMIT 10;

-- 5. Open escalations
SELECT raised_at, severity, code, title, message
FROM escalations
WHERE resolved = false
ORDER BY raised_at DESC;

-- 6. Recent cycle terminal outcomes
SELECT cycle_id, started_at, terminal_outcome, terminal_error_class, bets_placed
FROM recent_cycles_buffer
ORDER BY started_at DESC LIMIT 50;

-- 7. Forensic deep-dive on a failed cycle
SELECT step_seq, step_name, success, error_message, detail
FROM failed_cycle_breadcrumbs
WHERE cycle_id = 'YYYY-MM-DDTHH:MM:SSZ-near'
ORDER BY step_seq;

-- 8. A specific bet's reconciliation history
SELECT pass_at, db_status, betfair_status, mismatch_class, resolved
FROM mismatch_pass_history
WHERE internal_bet_id = 12345
ORDER BY pass_at DESC;
```

`/diagnostics` runs queries 1–6 itself and returns the result. 7–8 are escalations into the deep tables.

## Non-goals

- **Real-time metrics dashboard.** This isn't Grafana — it's a forensic+reliability layer. For real-time, query the live tables directly via Neon SQL.
- **Per-call Betfair tracing in Neon.** That stays VPS-local in `betfair_api_calls`. Volume too high.
- **Replacing alerts table.** `alerts` stays as-is (intra-process). `escalations` is what dispatches alerts to humans.
- **Replacing compliance_logs.** `compliance_logs` stays as the application audit log. Reliability tables are operational.
