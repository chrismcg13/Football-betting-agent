import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// 2026-05-08 (§4.1 of root-cause-analysis): every connection enforces
// per-query timeouts at the Postgres session level. Without these, a
// pathological query holds a connection indefinitely on Neon, billing
// continuous compute and starving other crons. Defaults:
//   statement_timeout              60_000 ms (60s) — any single query
//   lock_timeout                    5_000 ms ( 5s) — table/row lock waits
//   idle_in_transaction_session_timeout  120_000 ms (2 min) — leaked txns
//
// Override per-cron via the wrapper below for genuinely long jobs
// (migrations, exchange_book_sweep, ingestion). Keep the floor low
// for the trading-near hot path so a bad query fails fast.
const STATEMENT_TIMEOUT_MS = 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_IN_TX_TIMEOUT_MS = 120_000;

function withConnectionInit(p: pg.Pool): pg.Pool {
  p.on("connect", (client) => {
    // Each new pool connection runs these SETs once. They persist for the
    // life of the connection (which may be re-acquired many times across
    // queries by different async callers). Failures here log but do not
    // crash — a connection without timeouts is degraded, not fatal.
    client.query(
      `SET statement_timeout = ${STATEMENT_TIMEOUT_MS}; ` +
      `SET lock_timeout = ${LOCK_TIMEOUT_MS}; ` +
      `SET idle_in_transaction_session_timeout = ${IDLE_IN_TX_TIMEOUT_MS};`,
    ).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[db] failed to set per-connection timeouts:", err);
    });
  });
  return p;
}

export const pool = withConnectionInit(
  new Pool({ connectionString: process.env.DATABASE_URL }),
);
export const db = drizzle(pool, { schema });

export function createPool(url: string) {
  return withConnectionInit(new Pool({ connectionString: url }));
}

/**
 * Run an async block with an extended statement_timeout for THIS connection.
 * Used by genuinely long-running operations (migrations, exchange book sweep,
 * full ingestion) where the default 60s is too tight. The session timeout
 * is restored to default at the end of the block.
 *
 * Usage:
 *   await withExtendedTimeout(db, 600_000, async () => {
 *     await db.execute(sql`...long migration query...`);
 *   });
 */
export async function withExtendedTimeout<T>(
  database: typeof db,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    return await fn();
  } finally {
    try {
      await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    } catch (_) { /* swallow — connection may already be returning to pool */ }
    client.release();
  }
}

export * from "./schema";
