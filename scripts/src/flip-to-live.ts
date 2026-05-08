#!/usr/bin/env node
/**
 * Phase 3 §4.5 / §5 — flip-to-live CLI.
 *
 * Two-step usage:
 *
 *   1. Preview (no flip happens):
 *        npm run flip-to-live
 *      Prints the latest gate_clear_pending_review row, its manifest hash,
 *      and the live snapshot of gate_components / path_s_aggregate_status
 *      / switchover_whitelist. Operator reviews and decides.
 *
 *   2. Confirm and execute:
 *        npm run flip-to-live -- --confirm --manifest-hash=<sha256>
 *      Submits the hash to the server. Server re-verifies the gate is
 *      still passing AND the hash matches the stored pending-review row,
 *      then executes the atomic switchover transaction.
 *
 * Required env: API_URL (default http://localhost:8080).
 *
 * Exit codes:
 *   0 — preview shown OR flip succeeded
 *   1 — preview shown but no pending review (gate not yet cleared)
 *   2 — flip rejected by server (gate state changed, hash mismatch, etc.)
 *   3 — network / unexpected error
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:8080";

interface Args {
  confirm: boolean;
  manifestHash: string | null;
}

function parseArgs(argv: string[]): Args {
  let confirm = false;
  let manifestHash: string | null = null;
  for (const a of argv) {
    if (a === "--confirm") confirm = true;
    else if (a.startsWith("--manifest-hash=")) {
      manifestHash = a.slice("--manifest-hash=".length).trim();
    }
  }
  return { confirm, manifestHash };
}

interface PreviewResponse {
  success: boolean;
  message?: string;
  result?: {
    pending_review_rows: Array<{
      id: number;
      detected_at: string;
      manifest_hash: string;
      manifest: Record<string, unknown>;
      resolved_at: string | null;
      resolution: string | null;
    }>;
    current_gate_components: {
      pool_size: number | string;
      aggregate_net_roi: number | string | null;
      aggregate_net_clv: number | string | null;
      by_market: Record<string, unknown> | null;
    } | null;
    current_path_s_status: {
      pool_size_cleared: number | string;
      distinct_markets_cleared: number | string;
      aggregate_net_roi_cleared: number | string | null;
      path_s_aggregate_pass: boolean;
    } | null;
    current_whitelist: Array<{
      path: string; market_type: string; league: string;
      n: number | string;
      scope_net_roi: number | string | null;
      scope_net_clv: number | string | null;
      share_of_agg_pnl: number | string | null;
    }>;
  };
}

interface FlipResponse {
  success: boolean;
  message?: string;
  result?: {
    trigger: "P" | "S";
    whitelist_inserted: number;
    whitelist_already_active: number;
    caps_applied: { applied: { daily: number; weekly: number; floor: number }; source: string };
    flipped_at: string;
    compliance_log_written: boolean;
    pending_review_resolved: number;
  };
  // Server may include extra diagnostic fields
  [k: string]: unknown;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, init);
  const body = (await r.json()) as T;
  return { status: r.status, body };
}

function fmt(n: number | string | null | undefined): string {
  if (n == null) return "null";
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? v.toString() : String(n);
}

async function preview(): Promise<number> {
  const { status, body } = await fetchJson<PreviewResponse>(`${API_URL}/api/admin/flip-to-live-preview`);
  if (!body.success) {
    console.error(`Preview failed (HTTP ${status}): ${body.message ?? "unknown"}`);
    return 3;
  }
  const r = body.result!;
  const unresolved = r.pending_review_rows.find((p) => p.resolved_at == null);

  console.log("================================================================");
  console.log("                  PHASE 3 FLIP-TO-LIVE PREVIEW");
  console.log("================================================================");
  console.log("");
  console.log("Current Path P (Pinnacle-anchored aggregate):");
  if (r.current_gate_components) {
    const g = r.current_gate_components;
    console.log(`  pool_size            = ${fmt(g.pool_size)} (target ≥ 200)`);
    console.log(`  aggregate_net_roi    = ${fmt(g.aggregate_net_roi)} (target ≥ 0.03)`);
    console.log(`  aggregate_net_clv    = ${fmt(g.aggregate_net_clv)} (target ≥ 2.0)`);
  } else {
    console.log("  (no data)");
  }
  console.log("");
  console.log("Current Path S (shadow-only aggregate of cleared scopes):");
  if (r.current_path_s_status) {
    const s = r.current_path_s_status;
    console.log(`  pool_size_cleared           = ${fmt(s.pool_size_cleared)} (target ≥ 500)`);
    console.log(`  distinct_markets_cleared    = ${fmt(s.distinct_markets_cleared)} (target ≥ 2)`);
    console.log(`  aggregate_net_roi_cleared   = ${fmt(s.aggregate_net_roi_cleared)} (target ≥ 0.04)`);
    console.log(`  path_s_aggregate_pass       = ${s.path_s_aggregate_pass}`);
  } else {
    console.log("  (no data)");
  }
  console.log("");
  console.log(`Current whitelist size: ${r.current_whitelist.length}`);
  for (const w of r.current_whitelist.slice(0, 20)) {
    console.log(
      `  [${w.path}] ${w.market_type} × ${w.league}  n=${fmt(w.n)}  ` +
      `roi=${fmt(w.scope_net_roi)}  clv=${fmt(w.scope_net_clv)}  share=${fmt(w.share_of_agg_pnl)}`,
    );
  }
  if (r.current_whitelist.length > 20) {
    console.log(`  ... and ${r.current_whitelist.length - 20} more`);
  }
  console.log("");

  if (!unresolved) {
    console.log("STATUS: no unresolved gate_clear_pending_review row.");
    console.log("        The gate has not currently fired. No flip available.");
    console.log("");
    return 1;
  }

  console.log("STATUS: gate has fired. Pending review row available.");
  console.log("");
  console.log(`  pending_review.id = ${unresolved.id}`);
  console.log(`  detected_at       = ${unresolved.detected_at}`);
  console.log(`  manifest_hash     = ${unresolved.manifest_hash}`);
  console.log("");
  console.log("To execute the flip, run:");
  console.log("");
  console.log(`  npm run flip-to-live -- --confirm --manifest-hash=${unresolved.manifest_hash}`);
  console.log("");
  console.log("This will:");
  console.log("  1. Re-verify the gate is still passing");
  console.log("  2. Apply bankroll-tier caps to live agent_config");
  console.log("  3. Snapshot the live_whitelist");
  console.log("  4. Flip paper_mode → false, live_mode_active → true");
  console.log("  5. Disable paper bet generation permanently");
  console.log("  6. Log the event to compliance_logs");
  console.log("  7. Mark this pending_review row as resolved=flipped");
  console.log("");
  console.log("After the flip, paper bets currently pending settle to completion;");
  console.log("shadow continues; live placement begins on whitelist scopes only.");
  console.log("================================================================");
  return 0;
}

async function executeFlip(manifestHash: string): Promise<number> {
  console.log(`Submitting flip with manifest_hash=${manifestHash}...`);
  const { status, body } = await fetchJson<FlipResponse>(`${API_URL}/api/admin/flip-to-live`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifestHash, confirm: true }),
  });
  console.log("");
  if (!body.success) {
    console.error(`FLIP REJECTED (HTTP ${status}):`);
    console.error(JSON.stringify(body, null, 2));
    return 2;
  }
  console.log("FLIP SUCCESSFUL.");
  console.log(JSON.stringify(body.result, null, 2));
  console.log("");
  console.log("System is now LIVE. Verify state via:");
  console.log("  SELECT key,value FROM agent_config WHERE key IN ('paper_mode','live_mode_active');");
  console.log("  SELECT * FROM live_whitelist WHERE active=true ORDER BY path, market_type, league;");
  console.log("");
  console.log("First live bets will fire on the whitelisted scopes only,");
  console.log("at half-Kelly per scope (live_whitelist.kelly_fraction_override=0.5)");
  console.log("until the per-scope ramp threshold (50 P / 100 S) clears with");
  console.log("rolling-N positive net ROI. Then the ramp job upgrades to 1.0.");
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.confirm) {
    if (!args.manifestHash || !/^[0-9a-f]{64}$/.test(args.manifestHash)) {
      console.error("--confirm requires --manifest-hash=<sha256> (64 hex chars)");
      process.exit(2);
    }
    const code = await executeFlip(args.manifestHash);
    process.exit(code);
  } else {
    const code = await preview();
    process.exit(code);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(3);
});
