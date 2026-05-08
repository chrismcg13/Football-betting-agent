#!/usr/bin/env node
/**
 * 2026-05-08 (§4.6 of root-cause-analysis): query-budget regression test.
 *
 * For every hot-path query in the trading / settlement / value-detection
 * codepath, this script:
 *   1. Runs the query against the current DB (production data).
 *   2. Captures latency in ms and rows returned.
 *   3. Asserts both are within budget.
 *   4. Asserts EXPLAIN does NOT contain Seq Scan on tables >10k rows.
 *
 * Run locally before merging changes that touch hot-path SQL:
 *   pnpm --filter @workspace/scripts run query-budget-test
 *
 * Currently a SKELETON with 3 sample budgets matching what we audited
 * on 2026-05-08. Add new budget entries when adding new hot-path queries.
 * The harness is exit-1-on-fail so it can be wired into CI later.
 *
 * Required env: DATABASE_URL (point to either prod or a Neon branch
 * snapshotted from prod for test runs).
 */

import pg from "pg";

const { Client } = pg;

interface QueryBudget {
  name: string;
  sqlBuilder: () => Promise<{ sql: string; params: unknown[] }>;
  maxLatencyMs: number;
  maxRowsReturned: number;
  forbidSeqScanOn: string[]; // table names that must not appear in Seq Scan
}

// ── Sample budgets matching today's audited hot paths ──────────────────────
const BUDGETS: QueryBudget[] = [
  {
    name: "valueDetection: bulk odds preload (DISTINCT ON, 2h window)",
    sqlBuilder: async () => {
      // Build using a representative match-id set — top 200 most-recent matches
      // as a stand-in for the ~500 the trading cycle actually targets.
      return {
        sql: `
          SELECT DISTINCT ON (match_id, market_type, selection_name, source)
            id, match_id, market_type, selection_name,
            back_odds, lay_odds, snapshot_time, source
          FROM odds_snapshots
          WHERE match_id IN (
            SELECT id FROM matches
            WHERE kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
            LIMIT 200
          )
          AND snapshot_time >= NOW() - INTERVAL '2 hours'
          ORDER BY match_id, market_type, selection_name, source, snapshot_time DESC
        `,
        params: [],
      };
    },
    maxLatencyMs: 5_000,
    maxRowsReturned: 50_000,
    forbidSeqScanOn: ["odds_snapshots"],
  },
  {
    name: "valueDetection: bulk features preload",
    sqlBuilder: async () => ({
      sql: `
        SELECT id, match_id, feature_name, feature_value, computed_at
        FROM features
        WHERE match_id IN (
          SELECT id FROM matches
          WHERE kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '48 hours'
          LIMIT 200
        )
      `,
      params: [],
    }),
    maxLatencyMs: 2_000,
    maxRowsReturned: 20_000,
    forbidSeqScanOn: ["features"],
  },
  {
    name: "settleBets: candidate scan",
    sqlBuilder: async () => ({
      sql: `
        SELECT pb.id, pb.match_id, pb.market_type, pb.status
        FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
        WHERE pb.status='pending' AND pb.deleted_at IS NULL
          AND m.kickoff_time < NOW()
      `,
      params: [],
    }),
    maxLatencyMs: 500,
    maxRowsReturned: 5_000,
    forbidSeqScanOn: [], // paper_bets is small (3k rows); seq scan acceptable
  },
];

async function explainContainsForbiddenSeqScan(
  client: pg.Client,
  sqlText: string,
  params: unknown[],
  forbidden: string[],
): Promise<{ violated: string | null; plan: string }> {
  if (forbidden.length === 0) return { violated: null, plan: "" };
  const r = await client.query(`EXPLAIN ${sqlText}`, params as unknown[]);
  const plan = (r.rows.map((row) => Object.values(row)[0]).join("\n")) as string;
  for (const tbl of forbidden) {
    // Look for "Seq Scan on <tbl>" pattern in any row of the plan output
    if (new RegExp(`Seq Scan on (?:public\\.)?${tbl}\\b`).test(plan)) {
      return { violated: tbl, plan };
    }
  }
  return { violated: null, plan };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }
  const client = new Client({ connectionString: url });
  await client.connect();

  let failed = 0;
  for (const budget of BUDGETS) {
    const built = await budget.sqlBuilder();
    const t0 = Date.now();
    const result = await client.query(built.sql, built.params as unknown[]).catch((err) => {
      console.error(`✗ ${budget.name}\n  query failed: ${err.message}`);
      failed++;
      return null;
    });
    const latency = Date.now() - t0;
    if (result == null) continue;

    const rowsReturned = result.rowCount ?? result.rows.length;
    const issues: string[] = [];
    if (latency > budget.maxLatencyMs) {
      issues.push(`latency ${latency}ms exceeds budget ${budget.maxLatencyMs}ms`);
    }
    if (rowsReturned > budget.maxRowsReturned) {
      issues.push(`rows ${rowsReturned} exceeds budget ${budget.maxRowsReturned}`);
    }
    const explain = await explainContainsForbiddenSeqScan(
      client, built.sql, built.params, budget.forbidSeqScanOn,
    );
    if (explain.violated) {
      issues.push(`forbidden Seq Scan on ${explain.violated}`);
    }

    if (issues.length === 0) {
      console.log(`✓ ${budget.name} — ${latency}ms / ${rowsReturned} rows`);
    } else {
      console.error(`✗ ${budget.name}`);
      for (const i of issues) console.error(`  ${i}`);
      if (explain.violated) console.error(`  EXPLAIN excerpt:\n${explain.plan.slice(0, 500)}`);
      failed++;
    }
  }

  await client.end();
  if (failed > 0) {
    console.error(`\n${failed} budget(s) breached.`);
    process.exit(1);
  }
  console.log("\nAll budgets within tolerance.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(2);
});
