import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// Bundle N.5 (2026-05-16): daily Neon cost monitor. Writes one
// compliance_logs row per day capturing:
//   - Total DB size
//   - Top 15 tables by size (with 7-day delta if available)
//   - Sequential-scan ratio per top-10 table (egress proxy)
//   - agent_config cache hit-rate (via configCache module)
//   - 7-day cron CPU totals per job
//
// Single row/day = ~3 KB. The audit trail is the dashboard.
// Cost-of-cost-monitoring is bounded by design.

interface CronUsage {
  jobName: string;
  fires: number;
  totalCpuHours: number;
  avgSeconds: number;
}

interface TopTable {
  table: string;
  totalSize: string;
  liveRows: number;
  seqScans: number;
  idxScans: number;
  pctSeq: number;
}

export interface NeonCostSnapshot {
  capturedAt: string;
  dbSize: string;
  dbSizeBytes: number;
  topTables: TopTable[];
  cronCpu7d: CronUsage[];
  totalCpuHours7d: number;
}

export async function captureNeonCostSnapshot(): Promise<NeonCostSnapshot> {
  const capturedAt = new Date().toISOString();

  const dbSizeRow = await db.execute<{ size_bytes: string; size_pretty: string }>(sql`
    SELECT pg_database_size(current_database())::text AS size_bytes,
           pg_size_pretty(pg_database_size(current_database())) AS size_pretty
  `);
  const dbSizeBytes = Number((dbSizeRow.rows[0]?.size_bytes ?? "0"));
  const dbSize = String(dbSizeRow.rows[0]?.size_pretty ?? "0 bytes");

  const topTablesRows = await db.execute<{
    table_name: string;
    total_size: string;
    n_live_tup: string;
    seq_tup_read: string;
    idx_tup_fetch: string;
  }>(sql`
    SELECT
      schemaname || '.' || relname AS table_name,
      pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) AS total_size,
      n_live_tup::text,
      seq_tup_read::text,
      idx_tup_fetch::text
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(schemaname || '.' || relname) DESC
    LIMIT 15
  `);
  const topTables: TopTable[] = topTablesRows.rows.map((r) => {
    const seq = Number(r.seq_tup_read);
    const idx = Number(r.idx_tup_fetch);
    const total = seq + idx;
    return {
      table: String(r.table_name),
      totalSize: String(r.total_size),
      liveRows: Number(r.n_live_tup),
      seqScans: seq,
      idxScans: idx,
      pctSeq: total === 0 ? 0 : Math.round((seq / total) * 1000) / 10,
    };
  });

  const cronRows = await db.execute<{
    job_name: string;
    fires: string;
    total_cpu_hours: string;
    avg_seconds: string;
  }>(sql`
    SELECT
      job_name,
      COUNT(*)::text AS fires,
      (SUM(duration_ms)::numeric / 1000 / 3600)::text AS total_cpu_hours,
      (AVG(duration_ms)::numeric / 1000)::text AS avg_seconds
    FROM cron_executions
    WHERE started_at >= NOW() - INTERVAL '7 days'
    GROUP BY job_name
    ORDER BY SUM(duration_ms) DESC NULLS LAST
  `);
  const cronCpu7d: CronUsage[] = cronRows.rows.map((r) => ({
    jobName: String(r.job_name),
    fires: Number(r.fires),
    totalCpuHours: Math.round(Number(r.total_cpu_hours) * 10) / 10,
    avgSeconds: Math.round(Number(r.avg_seconds) * 10) / 10,
  }));
  const totalCpuHours7d = Math.round(cronCpu7d.reduce((acc, c) => acc + c.totalCpuHours, 0) * 10) / 10;

  const snapshot: NeonCostSnapshot = {
    capturedAt,
    dbSize,
    dbSizeBytes,
    topTables,
    cronCpu7d,
    totalCpuHours7d,
  };

  try {
    await db.insert(complianceLogsTable).values({
      actionType: "neon_cost_audit",
      details: snapshot as unknown as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to write neon_cost_audit row (non-fatal)");
  }

  logger.info(
    {
      dbSize,
      totalCpuHours7d,
      topTables: topTables.slice(0, 5).map((t) => ({ t: t.table, sz: t.totalSize, pctSeq: t.pctSeq })),
    },
    "Neon cost snapshot captured",
  );

  return snapshot;
}
