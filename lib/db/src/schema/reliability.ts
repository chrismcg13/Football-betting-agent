/**
 * Reliability / observability schema (Phase 2 of the VPS-first architecture
 * with selective Neon backup).
 *
 * Ten tables, grouped here because they form one cohesive observability
 * subsystem. The selection rules:
 *
 *   - Append-only audit of real actions (self_healing_actions, escalations)
 *   - Per-bet state of one canonical record (placement_reconciliation)
 *   - Tiny per-component status (system_health)
 *   - Daily rollup (reliability_daily_summary)
 *   - Two 5-minute time-series rollups for phone-debug trend visibility:
 *       health_5m_rollup    — per-component status, 14-day retention
 *       cycle_counters_5m   — system-wide cycle/bet counters, 14-day retention
 *   - Three selective-mirror patterns:
 *       recent_cycles_buffer    — fixed ring buffer, last 500 cycles
 *       failed_cycle_breadcrumbs — full breadcrumbs only on failure
 *       mismatch_pass_history    — passes only for currently-problematic bets
 *
 * High-volume noise stays VPS-local (SQLite at /var/lib/agent/observability.db).
 * See RELIABILITY.md for the write-rationale matrix.
 */

import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// ── self_healing_actions ────────────────────────────────────────────────────
// Append-only audit of actions the system took to recover itself. One row
// per action: stuck-lock release, watchdog exit, cleanup run, ledger
// reconcile. Volume scales with failure count, not cron frequency, so
// Neon is fine. Used by /diagnostics to show "what the system did about it"
// timeline.
export const selfHealingActionsTable = pgTable(
  "self_healing_actions",
  {
    id: serial("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actionType: text("action_type").notNull(),         // e.g. "stuck_lock_release", "watchdog_process_exit"
    component: text("component").notNull(),            // e.g. "trading_near", "reconciliation_pipeline"
    triggeredBy: text("triggered_by").notNull(),       // e.g. "watchdog", "cronHealthMonitor", "scheduled_cleanup"
    beforeState: jsonb("before_state"),                // snapshot of relevant state pre-action
    afterState: jsonb("after_state"),                  // snapshot post-action
    detail: jsonb("detail"),                           // free-form per-action context
    success: boolean("success").notNull(),
    errorMessage: text("error_message"),
  },
  (t) => [
    index("idx_self_healing_actions_occurred").on(t.occurredAt),
    index("idx_self_healing_actions_component").on(t.component),
  ],
);

// ── escalations ─────────────────────────────────────────────────────────────
// Append-only record of when the system escalated to a human. Distinct from
// the existing `alerts` table: escalations are alerts that have been
// dispatched to a notification channel (Slack/Telegram/email). Tracks
// delivery, acknowledgment, and resolution lifecycle. Volume = real
// problems / day, very low.
export const escalationsTable = pgTable(
  "escalations",
  {
    id: serial("id").primaryKey(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    severity: text("severity").notNull(),              // "warning" | "critical"
    code: text("code").notNull(),                      // e.g. "TRADING_NEAR_STALE_60M"
    title: text("title").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata"),
    channel: text("channel").notNull(),                // "telegram" | "slack" | "email" | "log_only"
    delivered: boolean("delivered").notNull().default(false),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryError: text("delivery_error"),
    acknowledged: boolean("acknowledged").notNull().default(false),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    index("idx_escalations_raised").on(t.raisedAt),
    index("idx_escalations_open").on(t.resolved, t.raisedAt),
    index("idx_escalations_code").on(t.code),
    // Phone-debug "show me only the criticals raised today" — tiny table, trivial cost.
    index("idx_escalations_severity").on(t.severity, t.raisedAt),
  ],
);

// ── placement_reconciliation ────────────────────────────────────────────────
// One row per bet, UPSERT in place. Single canonical record of "is this bet
// in the same state on Betfair as in our DB?". Updated on every reconciliation
// pass (per-pass history goes to VPS SQLite, OR mismatch_pass_history below
// when currently mismatched). Bounded by bet count (paper_bets row count).
export const placementReconciliationTable = pgTable(
  "placement_reconciliation",
  {
    internalBetId: integer("internal_bet_id").primaryKey(),
    betfairBetId: text("betfair_bet_id"),
    dbStatus: text("db_status").notNull(),             // pending/won/lost/void/...
    betfairStatus: text("betfair_status"),             // EXECUTION_COMPLETE / WON / etc
    mismatchClass: text("mismatch_class"),             // NULL = OK; else "ghost_bet" | "status_diverge" | "pnl_drift" | ...
    mismatchFirstSeenAt: timestamp("mismatch_first_seen_at", { withTimezone: true }),
    mismatchResolvedAt: timestamp("mismatch_resolved_at", { withTimezone: true }),
    passCount: integer("pass_count").notNull().default(0),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }).notNull().defaultNow(),
    lastPassDetail: jsonb("last_pass_detail"),
  },
  (t) => [
    index("idx_placement_recon_mismatch").on(t.mismatchClass, t.lastCheckAt),
    index("idx_placement_recon_betfair_id").on(t.betfairBetId),
  ],
);

// ── system_health ───────────────────────────────────────────────────────────
// One row per component, UPSERT keyed by component name. Bounded constant
// (~10 rows total) regardless of runtime — UPSERT-not-append discipline is
// what keeps this cheap. Watchdog updates only on STATUS CHANGE, not every
// tick — that's the cost-discipline guarantee.
export const systemHealthTable = pgTable(
  "system_health",
  {
    component: text("component").primaryKey(),        // "trading_near" | "settlement_pipeline" | "betfair_relay" | ...
    status: text("status").notNull(),                  // "ok" | "degraded" | "down"
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }).notNull().defaultNow(),
    lastStatusChangeAt: timestamp("last_status_change_at", { withTimezone: true }).notNull().defaultNow(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    detail: jsonb("detail"),
  },
);

// ── reliability_daily_summary ───────────────────────────────────────────────
// One row per UTC day, written from VPS-side rollup at end-of-day. Source of
// truth for the daily ops digest. Volume = 1 row/day = 365/year. Bounded.
export const reliabilityDailySummaryTable = pgTable(
  "reliability_daily_summary",
  {
    day: date("day").primaryKey(),
    placementsAttempted: integer("placements_attempted").notNull().default(0),
    placementsSucceeded: integer("placements_succeeded").notNull().default(0),
    placementsFailed: integer("placements_failed").notNull().default(0),
    betsSettled: integer("bets_settled").notNull().default(0),
    avgSettlementLagHours: numeric("avg_settlement_lag_hours", { precision: 6, scale: 2 }),
    p95SettlementLagHours: numeric("p95_settlement_lag_hours", { precision: 6, scale: 2 }),
    absDriftGbp: numeric("abs_drift_gbp", { precision: 10, scale: 2 }),
    relDriftPct: numeric("rel_drift_pct", { precision: 6, scale: 3 }),
    selfHealingCount: integer("self_healing_count").notNull().default(0),
    escalationCount: integer("escalation_count").notNull().default(0),
    mismatchesOpenAtEod: integer("mismatches_open_at_eod").notNull().default(0),
    mismatchesResolved: integer("mismatches_resolved").notNull().default(0),
    netPnlGbp: numeric("net_pnl_gbp", { precision: 10, scale: 2 }),
    detail: jsonb("detail"),                           // open-ended for future fields
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

// ── health_5m_rollup ────────────────────────────────────────────────────────
// Per-component, per-5-minute time-series of dominant status. Lets the
// phone-debug view answer "was trading flapping overnight?" with a single
// SELECT against this table — no SSH required.
//
// Write trigger: every component status update (which UPSERTs system_health)
// ALSO UPSERTs the corresponding (component, bucket_start) row here. Bucket
// is `date_bin('5 minutes', NOW(), TIMESTAMP '2000-01-01')`. ON CONFLICT
// resolves the dominant_status using a CASE that picks the worst seen in
// the bucket (red > amber > green) — atomic, single-statement.
//
// Volume: ~10 components × 288 buckets/day = 2,880 rows/day max.
// At 14-day retention ≈ 40k rows ≈ 5 MB.
// Retention: nightly cleanup deletes rows where bucket_start < NOW() - 14 days.
export const health5mRollupTable = pgTable(
  "health_5m_rollup",
  {
    component: text("component").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    dominantStatus: text("dominant_status").notNull(),  // "green" | "amber" | "red"
    eventCount: integer("event_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    lastErrorClass: text("last_error_class"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.component, t.bucketStart] }),
    // Serves "last 24h of component X" with WHERE component=X ORDER BY bucket_start DESC.
    // PG can scan a btree on (component, bucket_start) in reverse — DESC in the index
    // definition is unnecessary.
    index("idx_health_5m_component_recent").on(t.component, t.bucketStart),
    // Serves cleanup query "WHERE bucket_start < cutoff".
    index("idx_health_5m_bucket").on(t.bucketStart),
  ],
);

// ── cycle_counters_5m ───────────────────────────────────────────────────────
// System-wide (no component dimension) per-5-minute counters. Directly
// answers the silent-failure mode: "are we placing bets at the expected rate
// right now?" — SELECT bets_placed FROM cycle_counters_5m WHERE bucket_start
// > NOW() - INTERVAL '6 hours' ORDER BY bucket_start. Zeros over the last
// hour despite available selections = silent failure happening NOW.
//
// Write trigger: end-of-cycle hook UPSERTs the bucket the cycle ended in,
// incrementing relevant counters via atomic single-statement
// `INSERT ... ON CONFLICT (bucket_start) DO UPDATE SET cycles_run =
//  cycle_counters_5m.cycles_run + EXCLUDED.cycles_run, ...`. PG row-locking
// serialises concurrent inserts on the same bucket — no read-modify-write
// race.
//
// Volume: 288 rows/day max. At 14-day retention ≈ 4k rows ≈ 2 MB.
// Retention: nightly cleanup, same as health_5m_rollup.
export const cycleCounters5mTable = pgTable(
  "cycle_counters_5m",
  {
    bucketStart: timestamp("bucket_start", { withTimezone: true }).primaryKey(),
    cyclesRun: integer("cycles_run").notNull().default(0),
    cyclesFailed: integer("cycles_failed").notNull().default(0),
    cyclesZeroBets: integer("cycles_zero_bets").notNull().default(0),  // qualifying selections existed but no bets placed
    betsAttempted: integer("bets_attempted").notNull().default(0),
    betsPlaced: integer("bets_placed").notNull().default(0),
    betsFailed: integer("bets_failed").notNull().default(0),
    betfairApiErrors: integer("betfair_api_errors").notNull().default(0),
    betfairApiP95Ms: integer("betfair_api_p95_ms"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Serves time-range queries WHERE bucket_start > X ORDER BY bucket_start.
    // (Implicit since bucket_start is the PK; PG btree on PK serves both directions.)
    index("idx_cycle_counters_5m_bucket").on(t.bucketStart),
  ],
);

// ── recent_cycles_buffer ────────────────────────────────────────────────────
// Fixed-size ring buffer, last 500 trading cycles. End-of-cycle hook INSERTs
// then DELETE-by-rank prunes back to 500. Stays at exactly ~500 rows ≈ 12 MB.
// 500 cycles × 5 min near-cadence ≈ 42 hours of detail; far/lazy cycles
// extend the lookback window further. Lets you catch "this started Wednesday"
// patterns from a phone with no VPS access.
export const recentCyclesBufferTable = pgTable(
  "recent_cycles_buffer",
  {
    cycleId: text("cycle_id").primaryKey(),            // e.g. "2026-05-10T14:55:00Z-near"
    cycleType: text("cycle_type").notNull(),           // "near" | "far" | "lazy_promote" | "settlement"
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    stepsAttempted: integer("steps_attempted").notNull().default(0),
    stepsSucceeded: integer("steps_succeeded").notNull().default(0),
    stepsFailed: integer("steps_failed").notNull().default(0),
    betsAttempted: integer("bets_attempted").notNull().default(0),
    betsPlaced: integer("bets_placed").notNull().default(0),
    terminalOutcome: text("terminal_outcome").notNull(), // "ok" | "degraded" | "failed" | "stalled"
    terminalErrorClass: text("terminal_error_class"),    // NULL on ok; else "reference_error" | "betfair_api" | ...
    summaryDetail: jsonb("summary_detail"),
  },
  (t) => [
    index("idx_recent_cycles_started").on(t.startedAt),
  ],
);

// ── failed_cycle_breadcrumbs ────────────────────────────────────────────────
// Per-step breadcrumbs copied from VPS SQLite ONLY when a cycle terminates
// in failure. Successful cycles never touch this table. Cleanup nightly:
// drop rows >30d old unless their cycle is referenced by an open escalation.
// Expected steady-state volume: <2k rows.
export const failedCycleBreadcrumbsTable = pgTable(
  "failed_cycle_breadcrumbs",
  {
    id: serial("id").primaryKey(),
    cycleId: text("cycle_id").notNull(),
    stepSeq: integer("step_seq").notNull(),
    stepName: text("step_name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    success: boolean("success").notNull(),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
    detail: jsonb("detail"),
    copiedAt: timestamp("copied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // UNIQUE: VPS→Neon copy is retry-prone. Writer must use
    // `INSERT ... ON CONFLICT (cycle_id, step_seq) DO NOTHING` — without
    // uniqueness, retries produce duplicate breadcrumbs that mislead reads.
    uniqueIndex("uq_failed_breadcrumbs_cycle_step").on(t.cycleId, t.stepSeq),
    index("idx_failed_breadcrumbs_copied").on(t.copiedAt),
  ],
);

// ── mismatch_pass_history ───────────────────────────────────────────────────
// Reconciliation passes ONLY for bets currently in mismatch_class != NULL.
// Cleanup nightly: drop rows >30d old where the underlying mismatch is
// resolved. Volume bounded by open-mismatch count, not bet count.
export const mismatchPassHistoryTable = pgTable(
  "mismatch_pass_history",
  {
    id: serial("id").primaryKey(),
    internalBetId: integer("internal_bet_id").notNull(),
    betfairBetId: text("betfair_bet_id"),
    passAt: timestamp("pass_at", { withTimezone: true }).notNull().defaultNow(),
    dbStatus: text("db_status").notNull(),
    betfairStatus: text("betfair_status"),
    mismatchClass: text("mismatch_class").notNull(),
    detail: jsonb("detail"),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    // The unique index covers (internal_bet_id, pass_at) for both lookup and
    // uniqueness — no separate non-unique index needed (saves storage, halves
    // write amplification on this table).
    index("idx_mismatch_pass_unresolved").on(t.resolved, t.passAt),
    uniqueIndex("uq_mismatch_pass_bet_at").on(t.internalBetId, t.passAt),
  ],
);
