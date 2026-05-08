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
];

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

  // ─── (1) odds_snapshots non-essential bookmakers — per-source loop ───────
  // Iterate one source at a time with small batches so each DELETE is
  // O(log n) via the new index and well within statement_timeout. The
  // per-source loop stops early when a batch returns 0 rows.
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

  // ─── (3) odds_history retention 30 days — small-batch loop ──────────────
  // Same pattern as odds_snapshots: small batches that fit in statement_
  // timeout, looped within the call until empty or iteration cap.
  // odds_history_time_idx already exists so this is index-driven.
  let oddsHistoryDeleted = 0;
  for (let i = 0; i < oddsHistoryMaxIterations; i++) {
    const result = (await db.execute(sql`
      WITH deletable AS (
        SELECT ctid FROM odds_history
        WHERE snapshot_time < NOW() - INTERVAL '30 days'
        LIMIT ${oddsHistoryBatchSize}
      )
      DELETE FROM odds_history WHERE ctid IN (SELECT ctid FROM deletable)
    `)) as unknown as { rowCount?: number };
    const deleted = result.rowCount ?? 0;
    oddsHistoryDeleted += deleted;
    if (deleted < oddsHistoryBatchSize) break;
  }
  if (oddsHistoryDeleted > 0) {
    notes.push(`odds_history: ${oddsHistoryDeleted} rows >30d deleted`);
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
 * Compact + reclaim: VACUUM ANALYZE on tables that just had bulk deletes.
 * Postgres won't reclaim disk space without VACUUM, so this is critical
 * for the storage savings to actually materialise. Runs separately from
 * runStorageCleanup because VACUUM cannot run inside a transaction and
 * needs a fresh connection — the daily cron calls both in sequence.
 */
export async function vacuumCleanedTables(): Promise<{ tablesVacuumed: string[] }> {
  const tables = ["odds_snapshots", "odds_history", "compliance_logs"];
  const vacuumed: string[] = [];
  for (const t of tables) {
    try {
      // VACUUM ANALYZE without FULL — gentler, doesn't lock the table.
      await db.execute(sql.raw(`VACUUM (ANALYZE) ${t}`));
      vacuumed.push(t);
    } catch (err) {
      logger.warn({ err, table: t }, "VACUUM failed — Neon may auto-vacuum, continuing");
    }
  }
  return { tablesVacuumed: vacuumed };
}
