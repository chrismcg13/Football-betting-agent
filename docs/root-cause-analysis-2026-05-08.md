# Root-cause analysis: 2026-05-08 cascade failure
**Author:** Claude (Opus 4.7) · **Date:** 2026-05-08 · **Status:** Diagnostic, not yet remediated

You're right to call this out. I've made ~10 hot-patches today, all targeting symptoms. Stepping back.

---

## 1. Symptom inventory (what I actually did today)

| # | Symptom | Hot-patch I applied | Real fix? |
|---|---|---|---|
| 1 | trading_near hanging on `features` table seq-scan | Added composite index `features(match_id, feature_name)` | Yes for *that* query, no for the class |
| 2 | Event loop saturation from lineMovement logs | Demoted log level info → debug | Symptom mask, not fix |
| 3 | `tradingCycleRunning` lock held forever after vps-relay HTTP hang | Added 5-min stale-lock auto-release | Workaround, not root fix |
| 4 | Startup `runTradingCycle` warmup hung deterministically | Disabled the warmup entirely | Removed the symptom, didn't fix the underlying hang |
| 5 | `odds_snapshots` query loading 700k–2M rows per cycle | Added 24h time filter (still 700k rows) | Insufficient |
| 6 | Same query still slow at 24h | Tightened to 2h + DISTINCT ON | Better, but introduced #7 |
| 7 | DISTINCT ON query failed because drizzle binds JS arrays as `($1,$2,..)` not arrays | Replaced with `sql.raw` integer interpolation | Same bug class as Track A revert; happens any time `inArray`/`ANY` meets a runtime variable array |
| 8 | TEAM_TOTAL_* bets stuck pending forever | Added missing cases to `determineBetWon` switch | Yes for those types, no for the class |
| 9 | compliance_logs at 271 MB | Deleted 218 MB of stale rows | One-time cleanup |
| 10 | `api_usage` 100% sequential scan | Added composite index | Yes for that table |

**Pattern:** every fix was reactive to an observed symptom. None addressed the *failure mode that produced the symptom*.

---

## 2. The patterns underneath

### Pattern A — No production-data-scale validation before merge
**Evidence:**
- `features.match_id` was unindexed despite the table being queried with `inArray(matchIds)` from the very start of the trading cycle. With 159k rows and many match_ids per query, this was a sequential-scan bomb waiting for traffic to detonate it.
- `odds_snapshots` query had no time filter despite the table now being 20M rows / 3.4 GB. Whoever wrote the trading cycle did not test against representative production volume.
- Both bugs lurked for weeks until volume crossed the timeout threshold today.

**Diagnosis:** the codebase was built feature-first against small-volume dev data. As the prod tables grew (odds_snapshots especially), what worked in dev silently broke in prod. There is no test or pre-merge gate that runs hot-path queries against representative data and asserts a latency / row-count budget.

### Pattern B — No Postgres-side defense
**Evidence (gathered today):**
```sql
SHOW statement_timeout;     -- "0"  (unlimited)
SHOW lock_timeout;          -- "0"  (unlimited)
```
A single bad query can hang for 10+ minutes (we observed 583s and 866s durations). On Neon this is **directly billed compute time**, and the long-running query holds connections that other crons need. This amplifies every other bug.

**Diagnosis:** the role/DB has no statement-level guards. A pathological query has no upper bound on its blast radius.

### Pattern C — No coverage assertion between code components
**Evidence:**
- `valueDetection.ts` generates bets in market types `MATCH_ODDS`, `BTTS`, `OVER_UNDER_*`, `ASIAN_HANDICAP`, **`TEAM_TOTAL_HOME_*`**, **`TEAM_TOTAL_AWAY_*`**, `FIRST_HALF_RESULT`.
- `paperTrading.ts:determineBetWon` switch handled all of those EXCEPT `TEAM_TOTAL_HOME_*` and `TEAM_TOTAL_AWAY_*`.
- The two files are in the same project, edited by the same hands. There is no compile-time or runtime assertion that they agree on the set of supported market types.
- This bug existed in production for the entire window TEAM_TOTAL_* was being generated. 285 pending bets accumulated. They would have voided after 72h timeout regardless of actual outcome.

**Diagnosis:** market types are defined as string literals in two places independently. Drift between them is invisible until the bet hits the `default: return null` branch and silently retries forever.

### Pattern D — drizzle ORM array-bind footgun, used in multiple call sites
**Evidence:**
- Today: `where(inArray(featuresTable.matchId, ids))` — works correctly.
- Today: `WHERE match_id = ANY(${matchIds}::int[])` (raw sql with JS array) — produces `ANY(($1, $2, ...)::int[])` which Postgres rejects as a row-to-array cast.
- Hit twice today: Track A revert endpoint (caught at deploy time), valueDetection DISTINCT ON (caught only after 12 cron failures).
- `inArray` works because drizzle has a special-cased helper for it. `sql\`${arr}\`` does NOT — drizzle expands JS arrays to multiple parameters in the raw-SQL path.

**Diagnosis:** this is a documented drizzle behavior, but there is no project-level safety: any future engineer writing `sql\`...ANY(${arr})\`` will reproduce the bug. There's no lint rule, no helper, no pattern that prevents this.

### Pattern E — Single Node event loop carrying 30+ concurrent crons
**Evidence:**
- All 30+ scheduled jobs run inside the same `api-server` process.
- When lineMovement was logging at info level, it saturated the event loop and node-cron printed "missed execution" warnings — meaning ticks were dropped or delayed.
- When `runTradingCycle` calls vps-relay over HTTP and the relay is slow, the Node process's I/O pool fills up, blocking other concurrent operations.
- A single hung cron (today: trading cycle hung in vps-relay) holds a module-level lock that blocks all subsequent ticks of the same cron, until manual intervention.

**Diagnosis:** the system has no isolation between crons. One bad cron can starve the others. There's no per-cron budget, no separate worker process for ingestion vs trading vs analytics.

### Pattern F — Silent failures because of swallowed errors
**Evidence:**
- `cron_executions` only writes a row at the END of `runTradingCycle`, both on success and error. Early-return paths (lock held, risk triggered, agent not running) write **nothing**.
- For 13+ hours today, the only signal that trading_near was failing was the absence of fresh placements. The cron continued firing, the lock kept being held, no alerts fired.
- Some catch blocks `catch (_) {}` swallow errors entirely (e.g., the cron_executions write fallback at scheduler.ts:702).

**Diagnosis:** the system is designed to fail silently. Without manual SQL inspection, problems only surface when observable downstream effects (no bets, no settlements) accumulate enough for a human to notice.

---

## 3. The actual root cause

**The codebase was built feature-first without any system-level discipline for production scale, partial-failure recovery, or component-coverage drift.**

That single sentence explains every symptom today. Each individual feature works in isolation against small data. Composed together at production scale they break each other in non-obvious ways. There are no guard rails — no statement timeouts, no lock liveness, no cron health invariants, no market-coverage assertions, no array-bind safety, no per-cron isolation, no production-data-scale tests.

Every "urgent" deploy I shipped today was a patch on a symptom. The next bug of the same class will hit tomorrow, possibly with the same severity, possibly worse.

---

## 4. Long-term permanent fixes — proposal

These are ordered by impact-per-effort. Each section is a discrete unit of work; together they form a defense-in-depth.

### 4.1 Postgres-side guards (≤2 hours, prevents 80% of future hangs)

```sql
-- Set on the api-server's DB role
ALTER ROLE neondb_owner SET statement_timeout = '60s';
ALTER ROLE neondb_owner SET lock_timeout = '5s';
ALTER ROLE neondb_owner SET idle_in_transaction_session_timeout = '120s';
```

**What this does:**
- No query can run longer than 60 seconds. A bad query fails fast with a clear error instead of hanging the cron lock.
- No lock acquisition can wait longer than 5s. Prevents indefinite blocking on table locks.
- No connection can sit idle in a transaction longer than 2 minutes. Prevents leaked connections.

**Why it matters:** today's 30-second migration index build, 583s features query, 866s exchange-book-sweep query — all would have surfaced as immediate errors months ago instead of slowly degrading until they timed out the cron itself. Errors at 60s are recoverable; hangs at 600s aren't.

**Cost:** ~free. All hot-path queries already complete in <60s when properly indexed; the few that don't were bugs we were unaware of.

### 4.2 Cron health invariants (~1 day)

Build a `cron_health_monitor` cron that runs every 5 min:
- For every cron job tracked in `cron_executions`, compute time-since-last-success and expected-cadence (from a registry).
- If a cron hasn't succeeded in 3× its expected cadence, insert a `cron_stale_alert` row with full context.
- Alerts surface via SQL (no UI required): `SELECT * FROM cron_stale_alert WHERE acknowledged_at IS NULL`.

Combined with: every cron writes a `cron_executions` row at *START* (not just end) so we can distinguish "haven't fired" from "fired but didn't complete".

**Why it matters:** today's 13-hour invisible failure of trading_near would have alerted within 15 min. The lineMovement event-loop saturation would have alerted on the first missed cron tick.

**Cost:** ~150 lines of code, one new table.

### 4.3 Market-type coverage assertion (~half day)

Centralise market types in a single registry:
```ts
// lib/market-types/registry.ts
export interface MarketType {
  id: string;                    // e.g. "TEAM_TOTAL_HOME_25"
  generator: "value_detection";
  selectionFormat: "OVER_UNDER" | "HOME_AWAY_DRAW" | "ASIAN" | "BTTS_YES_NO";
  resolveFromFinalScore: (home: number, away: number, selection: string) => boolean | null;
  resolveFromHalftime?: ...;
  resolveFromStats?: ...;
}
export const MARKET_TYPES: Record<string, MarketType> = { ... };
```

`valueDetection.ts` only generates bets where `MARKET_TYPES[type]` exists. `determineBetWon` is replaced by `MARKET_TYPES[type].resolveFromFinalScore(...)` with type-checked dispatch. Adding a new market type forces both ends to be wired or the type registry won't compile.

A startup invariant asserts: for every market type ever appearing in a settled bet, the registry has an entry. Drift detected at boot.

**Why it matters:** TEAM_TOTAL_* shipped without settlement support. The registry pattern makes that a compile error, not a silent runtime void.

**Cost:** ~half day to refactor the existing switch. New market types add 5 lines instead of editing 3 separate files.

### 4.4 Drizzle array-bind safety (~2 hours)

Two-part fix:
1. **Helper:** `sqlIntList(ids: number[])` returns a `sql.raw` interpolation of the validated integer list. Used wherever raw SQL needs `IN (...)` or `ANY(...)` on a runtime array.
2. **Lint rule** (or grep test in CI): forbid `sql\`...${variable}::int[]...\`` patterns. Direct user to `sqlIntList`.

```ts
// services/db-helpers.ts
export function sqlIntList(ids: number[]): SQL {
  if (ids.length === 0) throw new Error("sqlIntList called with empty array");
  for (const id of ids) {
    if (!Number.isInteger(id)) throw new Error(`sqlIntList expects integers, got ${id}`);
  }
  return sql.raw(ids.join(","));
}

// usage:
sql`... WHERE match_id IN (${sqlIntList(matchIds)}) ...`
```

**Why it matters:** the same drizzle bug bit me twice today, in two separate files, with two separate root causes. It will keep biting until prevented at the API surface.

**Cost:** ~2 hours including the lint rule.

### 4.5 In-process lock liveness (~half day)

Generalise the `tradingCycleRunning` stale-lock pattern I shipped today into a reusable wrapper:

```ts
// services/lock.ts
export async function withLock<T>(
  name: string,
  maxAgeMs: number,
  fn: () => Promise<T>,
): Promise<T | { skipped: true; reason: string }> {
  // 1. If lock held and held < maxAgeMs → return { skipped, reason: "in_progress" }
  // 2. If lock held and held >= maxAgeMs → log, force-release, proceed
  // 3. Acquire, run fn, release in finally
}
```

Apply to: `runTradingCycle` (already done), `settleBets` (has its own ad-hoc), `runSettlementPipeline`, anything else with a module-level mutex.

**Why it matters:** any await in the wrapped function that hangs (vps-relay, file I/O, timer that never fires) is recoverable within `maxAgeMs`. Today's deterministic startup hang would have unstuck itself in 5 minutes instead of requiring restart.

**Cost:** ~half day, applied to ~5 locks.

### 4.6 Production-scale query budget tests (~1 day, plus per-feature ongoing)

A new test harness `scripts/src/query-budget-test.ts` that:
- Connects to a Neon branch with a snapshot of production data
- Runs each registered hot-path query
- Asserts: latency < N ms, rows fetched < N, plan does not contain `Seq Scan` on tables >10k rows
- Fails CI if any budget breached

Apply to:
- `valueDetection.ts` odds preload
- `valueDetection.ts` features preload  
- `predictionEngine.ts` training-set preload
- `oddsPapi.ts` recent-snapshot scans
- `paperTrading.ts:settleBets` candidate scan

**Why it matters:** the index-missing bugs (features, odds_snapshots, api_usage) were all detectable by running the query against real-volume data and looking at `EXPLAIN ANALYZE`. None of them were caught because no such test exists.

**Cost:** ~1 day to build the harness. Ongoing: every new hot-path query adds a budget test entry (5 lines).

### 4.7 Process isolation for crons (longer-term, ~3 days)

Split crons into worker processes by domain:
- `worker-ingestion` — odds capture, betfair sweep, line movement detection
- `worker-trading` — trading cycle, settlement, value detection
- `worker-analytics` — feature engineering, gate monitor, predictive power, audits

PM2 manages each as a separate process. A bad cron in ingestion can't starve trading. The DB connection pool is per-worker so connections aren't fought over.

**Why it matters:** today the lineMovement chatter (in apiFootball.ts, an ingestion path) starved the trading cycle (in scheduler.ts, the trading path) just because they share an event loop. With separation, the trading cycle keeps ticking even if ingestion is degraded.

**Cost:** ~3 days. Bigger refactor; defer until 4.1–4.6 land.

---

## 5. Recommended sequencing

| Order | Item | Effort | Impact |
|---|---|---|---|
| 1 | §4.1 Postgres-side timeouts | 30 min | Stops the worst-case hangs cold |
| 2 | §4.4 Drizzle array-bind helper + lint | 2 hrs | Prevents recurrence of today's two bugs |
| 3 | §4.5 In-process lock liveness wrapper | half day | Generalises today's stale-lock fix |
| 4 | §4.2 Cron health monitor | 1 day | No more 13-hour invisible failures |
| 5 | §4.3 Market-type registry | half day | Compile-time settlement coverage |
| 6 | §4.6 Query budget tests | 1 day | Pre-merge gate against scale bugs |
| 7 | §4.7 Process isolation | 3 days | Last-mile resilience |

**Total: ~6 days of focused work.** The first three (1.5 days) eliminate the worst classes of today's failures. The full set turns the system from "feature-rich but fragile" into "boring and reliable."

---

## 6. The one thing I want to push back on

I keep promising "won't happen again" after each hot-patch and you keep — rightly — calling out the pattern. The ONLY way to actually mean it is to ship §4.1–§4.6 before continuing on the Phase 3 work. Otherwise the gate evaluation window itself becomes the next "one weird query at scale" failure, and we lose another week.

Recommendation: **pause Phase 3 forward work for ~1.5 days**, ship §4.1–§4.4, then resume. The evaluation window is months long; 1.5 days lost up front is cheap. The alternative is dealing with another cascade in a week.

If you agree, I'll start on §4.1 now (30 min including verifying it doesn't break any legitimate slow query) and stop hot-patching everything else until that and §4.4 are in.
