/**
 * Cron-health observability (2026-05-11) — wraps a cron body with
 * structured success/failure logging that lands in compliance_logs.
 * Lets the operator query Neon for "which crons ran, when, with what
 * result, did they error" without needing VPS log access.
 *
 * Pattern:
 *
 *   cron.schedule("*\/15 * * * *", () => {
 *     void runCronWithHealthLog("smarkets_ingestion", async () => {
 *       const { runSmarketsIngestion } = await import("./...");
 *       return runSmarketsIngestion();
 *     });
 *   });
 *
 * One row per run with action_type='cron_health' and a details JSON of:
 *   { cron: <name>, status: 'success' | 'error',
 *     duration_ms: <n>, result: <stringified result> | null,
 *     error: <error message> | null }
 *
 * The companion view `v_cron_health_24h` (created in migrate.ts)
 * surfaces the last success/failure per cron + counts over 24h.
 */

import { db, complianceLogsTable } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Trim a JSON-serialised result so the compliance_logs row stays
 * small. Anything beyond 2 KB is sliced — large analytics outputs
 * still leave their headline counts on the row.
 */
function summariseResult(result: unknown): unknown {
  if (result == null) return null;
  if (typeof result === "object") {
    try {
      const s = JSON.stringify(result);
      if (s.length > 2048) {
        return { _truncated: true, _preview: s.slice(0, 1900) };
      }
      return result;
    } catch {
      return { _unserialisable: true };
    }
  }
  return result;
}

export async function runCronWithHealthLog<T>(
  cronName: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    try {
      await db.insert(complianceLogsTable).values({
        actionType: "cron_health",
        details: {
          cron: cronName,
          status: "success",
          duration_ms: durationMs,
          result: summariseResult(result),
        },
      });
    } catch (logErr) {
      logger.warn({ logErr, cronName }, "cron_health: success log write failed (non-fatal)");
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack?.slice(0, 1024) : undefined;
    logger.error({ err, cronName, durationMs }, `Cron ${cronName} failed`);
    try {
      await db.insert(complianceLogsTable).values({
        actionType: "cron_health",
        details: {
          cron: cronName,
          status: "error",
          duration_ms: durationMs,
          error: errMsg,
          stack: errStack,
        },
      });
    } catch (logErr) {
      logger.warn({ logErr, cronName }, "cron_health: error log write failed (non-fatal)");
    }
    return null;
  }
}
