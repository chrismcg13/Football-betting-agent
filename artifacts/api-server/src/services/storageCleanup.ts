import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Storage cleanup service (2026-05-08 Neon cost audit).
 *
 * Pre-cleanup state of the DB:
 *   odds_snapshots   3.6 GB  21.9M rows (80% of those rows are bookmakers
 *                                        no analysis path reads)
 *   odds_history     1.5 GB  7.8M rows  (used by line-movement detection
 *                                        — needs retention policy, not drop)
 *   compliance_logs  273 MB  321K rows  (line_movement legacy data + 24h+
 *                                        old bet_rejected rows are dead)
 *
 * Three cleanup tracks. All idempotent, safe to re-run, and bounded so
 * no single run can wipe live data:
 *
 *   1. odds_snapshots non-essential bookmakers older than 14 days.
 *      Going forward apiFootball.ts:fetchOdds skips writing these. This
 *      backfill removes the historical bloat.
 *
 *   2. compliance_logs:
 *      - Drop ALL `line_movement` rows (no current writer; legacy data).
 *      - Drop `bet_rejected` rows >24h old (only the last 24h is read by
 *        the rejection-reason dashboard; everything else is dead weight).
 *      - Drop `correlation_detection` rows >7d old (high-volume diagnostic).
 *
 *   3. odds_history retention: drop snapshot rows >30 days old.
 *      Line-movement detection only looks at the last few hours; older
 *      data has no analytical value.
 *
 * Returns headline counts so the operator can confirm the impact.
 */

const NON_ESSENTIAL_AF_BOOKMAKERS = [
  "api_football_real:1xBet",
  "api_football_real:10Bet",
  "api_football_real:BetVictor",
  "api_football_real:William Hill",
  "api_football_real:888Sport",
  "api_football_real:SBO",
  "api_football_real:Dafabet",
  "api_football_real:188Bet",
  // 2026-05-08 follow-up: api_football_real:Betfair is fully redundant
  // with the betfair_exchange source captured via the dedicated exchange
  // book sweep. No analysis path reads the AF Betfair version. Aggressive
  // cleanup (no retention buffer) — drop everything.
  "api_football_real:Betfair",
];

// Per-essential-bookmaker retention. Set tight because each is consumed
// from a NARROW window:
//   Pinnacle    — multi-source CLV resolver looks at last 6h (Strategy B);
//                 cross-check looks at last 30 min. 7 days is generous.
//   Bet365/Unibet/Marathonbet/Betano — sharp-move RLM detector queries
//                 last 15 minutes. 3 days is generous.
const ESSENTIAL_AF_BOOKMAKER_RETENTION: Record<string, string> = {
  "api_football_real:Pinnacle": "7 days",
  "api_football_real:Bet365": "3 days",
  "api_football_real:Unibet": "3 days",
  "api_football_real:Marathonbet": "3 days",
  "api_football_real:Betano": "3 days",
};

interface CleanupResult {
  evaluatedAt: string;
  oddsSnapshotsDeleted: number;
  oddsHistoryDeleted: number;
  complianceLogsDeleted: {
    line_movement: number;
    bet_rejected: number;
    correlation_detection: number;
  };
  totalRowsDeleted: number;
  notes: string[];
}

export async function runStorageCleanup(opts: {
  // Per-source batch size (small enough to fit in 60s statement_timeout
  // even before the partial index is built / before autovacuum updates
  // statistics). Default 10K rows per DELETE, up to 50 iterations per
  // source per call.
  oddsSnapshotsBatchSize?: number;
  oddsSnapshotsMaxIterations?: number;
  oddsHistoryBatchSize?: number;
  oddsHistoryMaxIterations?: number;
} = {}): Promise<CleanupResult> {
  const evaluatedAt = new Date().toISOString();
  const notes: string[] = [];
  const oddsSnapshotsBatchSize = opts.oddsSnapshotsBatchSize ?? 10_000;
  const oddsSnapshotsMaxIterations = opts.oddsSnapshotsMaxIterations ?? 50;
  const oddsHistoryBatchSize = opts.oddsHistoryBatchSize ?? 10_000;
  const oddsHistoryMaxIterations = opts.oddsHistoryMaxIterations ?? 50;

  // ─── (0) Idempotent index build for the cleanup hot path ─────────────────
  // Without this, the source-filtered DELETE is a sequential scan over
  // 21M+ rows and breaches the 60s statement_timeout. The partial index
  // is small (covers only non-essential rows) and serves only the cleanup
  // path. CREATE INDEX IF NOT EXISTS is idempotent so safe to retry.
  // CONCURRENTLY skipped — it can't run inside a transaction and the
  // table is busy enough that a brief AccessExclusive lock during build
  // is acceptable for a one-shot.
  try {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS odds_snapshots_cleanup_idx
        ON odds_snapshots (source, snapshot_time)
    `);
    notes.push("odds_snapshots_cleanup_idx ensured (idempotent)");
  } catch (err) {
    notes.push(`Index build skipped: ${String(err)}`);
  }

  // ─── (1a) odds_snapshots non-essential bookmakers — aggressive cleanup ──
  // Non-essentials we no longer write at all (apiFootball.ts filter) AND
  // never read. 14-day retention is just safety buffer for unexpected
  // backfill. Per-source loop with small batches.
  let oddsSnapshotsDeleted = 0;
  for (const source of NON_ESSENTIAL_AF_BOOKMAKERS) {
    let perSource = 0;
    for (let i = 0; i < oddsSnapshotsMaxIterations; i++) {
      const result = (await db.execute(sql`
        WITH deletable AS (
          SELECT ctid
          FROM odds_snapshots
          WHERE source = ${source}
            AND snapshot_time < NOW() - INTERVAL '14 days'
          LIMIT ${oddsSnapshotsBatchSize}
        )
        DELETE FROM odds_snapshots WHERE ctid IN (SELECT ctid FROM deletable)
      `)) as unknown as { rowCount?: number };
      const deleted = result.rowCount ?? 0;
      perSource += deleted;
      if (deleted < oddsSnapshotsBatchSize) break;
    }
    if (perSource > 0) {
      notes.push(`odds_snapshots[${source}]: ${perSource} rows deleted`);
    }
    oddsSnapshotsDeleted += perSource;
  }

  // ─── (1b) odds_snapshots ESSENTIAL bookmakers — tight retention ──────────
  // Pinnacle/Bet365/Unibet/Marathonbet/Betano are kept for live use but
  // each has a NARROW read window (Pinnacle 6h via CLV resolver, others
  // 15 min via sharp-move detector). Old data adds nothing analytically
  // and is the bulk of the remaining bloat.
  for (const [source, retention] of Object.entries(ESSENTIAL_AF_BOOKMAKER_RETENTION)) {
    let perSource = 0;
    for (let i = 0; i < oddsSnapshotsMaxIterations; i++) {
      const result = (await db.execute(sql`
        WITH deletable AS (
          SELECT ctid FROM odds_snapshots
          WHERE source = ${source}
            AND snapshot_time < NOW() - ${sql.raw(`INTERVAL '${retention}'`)}
          LIMIT ${oddsSnapshotsBatchSize}
        )
        DELETE FROM odds_snapshots WHERE ctid IN (SELECT ctid FROM deletable)
      `)) as unknown as { rowCount?: number };
      const deleted = result.rowCount ?? 0;
      perSource += deleted;
      if (deleted < oddsSnapshotsBatchSize) break;
    }
    if (perSource > 0) {
      notes.push(`odds_snapshots[${source}] (>${retention}): ${perSource} rows deleted`);
    }
    oddsSnapshotsDeleted += perSource;
  }

  // ─── (2) compliance_logs — batched with index ───────────────────────────
  try {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS compliance_logs_cleanup_idx
        ON compliance_logs (action_type, timestamp)
    `);
    notes.push("compliance_logs_cleanup_idx ensured");
  } catch (err) {
    notes.push(`compliance_logs index build skipped: ${String(err)}`);
  }

  async function deleteComplianceBatched(
    actionType: string,
    minAge: string | null,
  ): Promise<number> {
    let total = 0;
    const batchSize = 5000;
    for (let i = 0; i < 50; i++) {
      const result = minAge
        ? (await db.execute(sql`
            WITH deletable AS (
              SELECT ctid FROM compliance_logs
              WHERE action_type = ${actionType}
                AND timestamp < NOW() - ${sql.raw(`INTERVAL '${minAge}'`)}
              LIMIT ${batchSize}
            )
            DELETE FROM compliance_logs WHERE ctid IN (SELECT ctid FROM deletable)
          `)) as unknown as { rowCount?: number }
        : (await db.execute(sql`
            WITH deletable AS (
              SELECT ctid FROM compliance_logs
              WHERE action_type = ${actionType}
              LIMIT ${batchSize}
            )
            DELETE FROM compliance_logs WHERE ctid IN (SELECT ctid FROM deletable)
          `)) as unknown as { rowCount?: number };
      const deleted = result.rowCount ?? 0;
      total += deleted;
      if (deleted < batchSize) break;
    }
    return total;
  }

  const complianceLogsDeleted = {
    line_movement: await deleteComplianceBatched("line_movement", null),
    bet_rejected: await deleteComplianceBatched("bet_rejected", "24 hours"),
    correlation_detection: await deleteComplianceBatched("correlation_detection", "7 days"),
  };
  const complianceTotal =
    complianceLogsDeleted.line_movement +
    complianceLogsDeleted.bet_rejected +
    complianceLogsDeleted.correlation_detection;
  if (complianceTotal > 0) {
    notes.push(`compliance_logs: deleted ${complianceTotal} rows (${JSON.stringify(complianceLogsDeleted)})`);
  }

  // ─── (3) odds_history retention 7 days — small-batch loop ──────────────
  // Tightened from 30d to 7d (2026-05-08 follow-up). Line-movement
  // detection only reads the last few hours; 7 days gives generous
  // forensic backfill room. Drops 1.5GB → ~350MB once the cycle catches up.
  let oddsHistoryDeleted = 0;
  for (let i = 0; i < oddsHistoryMaxIterations; i++) {
    const result = (await db.execute(sql`
      WITH deletable AS (
        SELECT ctid FROM odds_history
        WHERE snapshot_time < NOW() - INTERVAL '7 days'
        LIMIT ${oddsHistoryBatchSize}
      )
      DELETE FROM odds_history WHERE ctid IN (SELECT ctid FROM deletable)
    `)) as unknown as { rowCount?: number };
    const deleted = result.rowCount ?? 0;
    oddsHistoryDeleted += deleted;
    if (deleted < oddsHistoryBatchSize) break;
  }
  if (oddsHistoryDeleted > 0) {
    notes.push(`odds_history: ${oddsHistoryDeleted} rows >7d deleted`);
  }

  const totalRowsDeleted = oddsSnapshotsDeleted + oddsHistoryDeleted + complianceTotal;

  if (totalRowsDeleted === 0) {
    notes.push("Storage cleanup: nothing to delete (steady state)");
  }

  logger.info(
    {
      evaluatedAt,
      oddsSnapshotsDeleted,
      oddsHistoryDeleted,
      complianceLogsDeleted,
      totalRowsDeleted,
    },
    "Storage cleanup complete",
  );

  return {
    evaluatedAt,
    oddsSnapshotsDeleted,
    oddsHistoryDeleted,
    complianceLogsDeleted,
    totalRowsDeleted,
    notes,
  };
}

/**
 * Phase 6 housekeeping (2026-05-11) — retention for the analytics &
 * observability tables landed during the theory-plan rebake. Each table
 * here is a low-volume cron output, append-only, that grows linearly
 * over time. Without trimming, the smallest of them (kelly_fraction_lookup,
 * 1 row/day) is trivial; the largest (sharp_consensus_snapshots, fed by
 * Smarkets every 15 min × hundreds of fixtures × markets) would balloon
 * fast. Conservative retention windows below — each well above any read
 * surface that currently exists, so it's safe to extend later if needed.
 *
 * All tables are append-only with a timestamp column — DELETE by simple
 * predicate is enough. No batching needed at these sizes; each DELETE
 * comfortably fits in the 60s statement_timeout.
 *
 * Tables and their reasons:
 *   sharp_consensus_snapshots   60d  — multi-source CLV joins to bets;
 *                                       closing windows we may revisit.
 *   club_elo_snapshots         180d  — historical Elo backfill walks
 *                                       distinct match dates; keep
 *                                       enough to cover the longest
 *                                       settled-bet window.
 *   analysis_segment_stats      30d  — nightly recompute, idempotent.
 *   analysis_signal_strength    30d  — nightly recompute, idempotent.
 *   kelly_fraction_lookup      365d  — 1 row/day; trivial growth.
 *   shap_drift_runs            365d  — 1 row/day × markets; trivial.
 *   feature_attribution         24mo — monthly; long history is valuable.
 *   market_correlation_matrix   12mo — monthly snapshots; matrices are
 *                                       small but readable history helps.
 *   calibration_buckets         90d  on inactive only — active rows
 *                                       always retained (drives live
 *                                       inference).
 *
 * Returns per-table delete counts so the operator can see the impact.
 */
export interface AnalyticsCleanupResult {
  evaluatedAt: string;
  deleted: Record<string, number>;
  totalRowsDeleted: number;
  errors: Array<{ table: string; error: string }>;
}

export async function runAnalyticsTablesCleanup(): Promise<AnalyticsCleanupResult> {
  const evaluatedAt = new Date().toISOString();
  const deleted: Record<string, number> = {};
  const errors: Array<{ table: string; error: string }> = [];

  async function trim(table: string, predicate: string): Promise<void> {
    try {
      const res = (await db.execute(
        sql.raw(`DELETE FROM ${table} WHERE ${predicate}`),
      )) as unknown as { rowCount?: number };
      const n = res.rowCount ?? 0;
      if (n > 0) deleted[table] = n;
    } catch (err) {
      errors.push({ table, error: String(err) });
      logger.warn({ err, table }, "Analytics cleanup: DELETE failed");
    }
  }

  await trim(
    "sharp_consensus_snapshots",
    "snapshot_at < NOW() - INTERVAL '60 days'",
  );
  await trim(
    "club_elo_snapshots",
    "date < (NOW() - INTERVAL '180 days')::date",
  );
  await trim(
    "analysis_segment_stats",
    "computed_at < NOW() - INTERVAL '30 days'",
  );
  await trim(
    "analysis_signal_strength",
    "computed_at < NOW() - INTERVAL '30 days'",
  );
  await trim(
    "kelly_fraction_lookup",
    "computed_at < NOW() - INTERVAL '365 days'",
  );
  await trim(
    "shap_drift_runs",
    "run_at < NOW() - INTERVAL '365 days'",
  );
  await trim(
    "feature_attribution",
    "computed_at < NOW() - INTERVAL '24 months'",
  );
  await trim(
    "market_correlation_matrix",
    "computed_at < NOW() - INTERVAL '12 months'",
  );
  await trim(
    "calibration_buckets",
    "active = false AND fitted_at < NOW() - INTERVAL '90 days'",
  );

  const totalRowsDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
  logger.info(
    { evaluatedAt, deleted, totalRowsDeleted, errors },
    "Analytics tables cleanup complete",
  );
  return { evaluatedAt, deleted, totalRowsDeleted, errors };
}

/**
 * Compact + reclaim: VACUUM ANALYZE on tables that just had bulk deletes.
 * Postgres marks dead rows as reusable space but does NOT return disk
 * to the OS / object store. For Neon this means the logical-storage
 * billing metric stays at the high-water mark until either (a) the
 * dead space is reused by new inserts, or (b) VACUUM FULL rewrites
 * the table.
 *
 * Daily cron uses VACUUM ANALYZE (gentle, no lock). VACUUM FULL is
 * available via runVacuumFull() — operator-triggered only because it
 * takes an AccessExclusive lock for 1-3 minutes per table.
 */
export async function vacuumCleanedTables(): Promise<{ tablesVacuumed: string[] }> {
  const tables = ["odds_snapshots", "odds_history", "compliance_logs"];
  const vacuumed: string[] = [];
  for (const t of tables) {
    try {
      await db.execute(sql.raw(`VACUUM (ANALYZE) ${t}`));
      vacuumed.push(t);
    } catch (err) {
      logger.warn({ err, table: t }, "VACUUM failed — Neon may auto-vacuum, continuing");
    }
  }
  return { tablesVacuumed: vacuumed };
}

/**
 * VACUUM FULL — rewrites the table to reclaim disk space. Takes an
 * AccessExclusive lock for the duration (1-3 min for a 3GB table) so
 * callers/inserters block. Operator-only via the admin endpoint.
 *
 * Runs each table sequentially. Reports per-table size before/after so
 * the operator can see actual GB freed. Defaults to all 3 cleanup-target
 * tables; pass `{ tables: [...] }` to limit scope.
 *
 * Use after a fresh runStorageCleanup pass, ideally during a low-traffic
 * window. Each VACUUM FULL connection is its own transaction so partial
 * progress is preserved if the call times out.
 */
export async function runVacuumFull(opts: {
  tables?: string[];
} = {}): Promise<{
  results: Array<{
    table: string;
    sizeBefore: string;
    sizeAfter: string;
    bytesBefore: number;
    bytesAfter: number;
    bytesFreed: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }>;
  totalBytesFreed: number;
}> {
  const targetTables = opts.tables ?? ["odds_snapshots", "odds_history", "compliance_logs"];
  const results: Array<{
    table: string; sizeBefore: string; sizeAfter: string;
    bytesBefore: number; bytesAfter: number; bytesFreed: number;
    durationMs: number; success: boolean; error?: string;
  }> = [];
  let totalBytesFreed = 0;

  for (const table of targetTables) {
    const beforeRow = (await db.execute(sql`
      SELECT pg_total_relation_size(${table}::regclass)::bigint AS bytes,
             pg_size_pretty(pg_total_relation_size(${table}::regclass)) AS pretty
    `)) as unknown as { rows: Array<{ bytes: number; pretty: string }> };
    const bytesBefore = Number(beforeRow.rows[0]?.bytes ?? 0);
    const sizeBefore = beforeRow.rows[0]?.pretty ?? "?";

    const t0 = Date.now();
    let success = true;
    let error: string | undefined;
    try {
      // Bypass statement_timeout for this single VACUUM FULL call.
      // Use a dedicated client + session-level SET so the timeout
      // applies to the VACUUM FULL itself.
      const { pool } = await import("@workspace/db");
      const client = await pool.connect();
      try {
        await client.query("SET statement_timeout = 0");
        await client.query(`VACUUM (FULL, ANALYZE) ${table}`);
      } finally {
        client.release();
      }
    } catch (err) {
      success = false;
      error = String(err);
      logger.error({ err, table }, "VACUUM FULL failed");
    }
    const durationMs = Date.now() - t0;

    const afterRow = (await db.execute(sql`
      SELECT pg_total_relation_size(${table}::regclass)::bigint AS bytes,
             pg_size_pretty(pg_total_relation_size(${table}::regclass)) AS pretty
    `)) as unknown as { rows: Array<{ bytes: number; pretty: string }> };
    const bytesAfter = Number(afterRow.rows[0]?.bytes ?? 0);
    const sizeAfter = afterRow.rows[0]?.pretty ?? "?";
    const bytesFreed = Math.max(0, bytesBefore - bytesAfter);
    totalBytesFreed += bytesFreed;

    results.push({
      table, sizeBefore, sizeAfter, bytesBefore, bytesAfter,
      bytesFreed, durationMs, success, ...(error ? { error } : {}),
    });

    logger.info(
      { table, sizeBefore, sizeAfter, bytesFreed, durationMs, success },
      "VACUUM FULL complete for table",
    );
  }

  return { results, totalBytesFreed };
}
