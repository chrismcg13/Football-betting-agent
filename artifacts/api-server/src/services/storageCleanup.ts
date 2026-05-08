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
  // Safety knob: cap each delete batch to prevent a single run from
  // locking the table for too long. Defaults are aggressive enough to
  // clear current backlog in 2-3 runs.
  oddsSnapshotsBatchLimit?: number;
  oddsHistoryBatchLimit?: number;
} = {}): Promise<CleanupResult> {
  const evaluatedAt = new Date().toISOString();
  const notes: string[] = [];
  const oddsSnapshotsBatchLimit = opts.oddsSnapshotsBatchLimit ?? 500_000;
  const oddsHistoryBatchLimit = opts.oddsHistoryBatchLimit ?? 200_000;

  // ─── (1) odds_snapshots non-essential bookmakers ──────────────────────────
  // Use ctid-based batched delete to avoid large transaction. Postgres holds
  // row-level locks for the whole transaction, so a 14M-row single DELETE
  // would lock the table. Batched approach is gentler.
  const snapshotsResult = (await db.execute(sql`
    WITH deletable AS (
      SELECT ctid
      FROM odds_snapshots
      WHERE source = ANY(${NON_ESSENTIAL_AF_BOOKMAKERS}::text[])
        AND snapshot_time < NOW() - INTERVAL '14 days'
      LIMIT ${oddsSnapshotsBatchLimit}
    )
    DELETE FROM odds_snapshots WHERE ctid IN (SELECT ctid FROM deletable)
  `)) as unknown as { rowCount?: number };
  const oddsSnapshotsDeleted = snapshotsResult.rowCount ?? 0;
  if (oddsSnapshotsDeleted > 0) {
    notes.push(`odds_snapshots: deleted ${oddsSnapshotsDeleted} non-essential rows >14d old`);
    if (oddsSnapshotsDeleted >= oddsSnapshotsBatchLimit) {
      notes.push(`odds_snapshots: reached batch limit — re-run to continue draining`);
    }
  }

  // ─── (2) compliance_logs ─────────────────────────────────────────────────
  const lineMovementResult = (await db.execute(sql`
    DELETE FROM compliance_logs WHERE action_type = 'line_movement'
  `)) as unknown as { rowCount?: number };

  const betRejectedResult = (await db.execute(sql`
    DELETE FROM compliance_logs
    WHERE action_type = 'bet_rejected'
      AND timestamp < NOW() - INTERVAL '24 hours'
  `)) as unknown as { rowCount?: number };

  const correlationResult = (await db.execute(sql`
    DELETE FROM compliance_logs
    WHERE action_type = 'correlation_detection'
      AND timestamp < NOW() - INTERVAL '7 days'
  `)) as unknown as { rowCount?: number };

  const complianceLogsDeleted = {
    line_movement: lineMovementResult.rowCount ?? 0,
    bet_rejected: betRejectedResult.rowCount ?? 0,
    correlation_detection: correlationResult.rowCount ?? 0,
  };
  const complianceTotal =
    complianceLogsDeleted.line_movement +
    complianceLogsDeleted.bet_rejected +
    complianceLogsDeleted.correlation_detection;
  if (complianceTotal > 0) {
    notes.push(`compliance_logs: deleted ${complianceTotal} rows (${JSON.stringify(complianceLogsDeleted)})`);
  }

  // ─── (3) odds_history retention 30 days ──────────────────────────────────
  const historyResult = (await db.execute(sql`
    WITH deletable AS (
      SELECT ctid FROM odds_history
      WHERE snapshot_time < NOW() - INTERVAL '30 days'
      LIMIT ${oddsHistoryBatchLimit}
    )
    DELETE FROM odds_history WHERE ctid IN (SELECT ctid FROM deletable)
  `)) as unknown as { rowCount?: number };
  const oddsHistoryDeleted = historyResult.rowCount ?? 0;
  if (oddsHistoryDeleted > 0) {
    notes.push(`odds_history: deleted ${oddsHistoryDeleted} rows >30d old`);
    if (oddsHistoryDeleted >= oddsHistoryBatchLimit) {
      notes.push(`odds_history: reached batch limit — re-run to continue draining`);
    }
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
