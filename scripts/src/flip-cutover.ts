#!/usr/bin/env node
/**
 * Pre-flip blocker #14 — flip atomic transaction CLI.
 *
 * Two-step usage:
 *
 *   1. Preview (no-op):
 *        npm run flip-cutover -- \
 *          --real-balance=1234.56 \
 *          --max-stake-pct=0.02 \
 *          --bankroll-floor-pct=0.50 \
 *          --daily-loss-limit-pct=0.04 \
 *          --weekly-loss-limit-pct=0.10
 *      Prints what would happen, then refuses without --confirm.
 *
 *   2. Confirm and execute:
 *        npm run flip-cutover -- --confirm \
 *          --real-balance=1234.56 \
 *          --max-stake-pct=0.02 \
 *          --bankroll-floor-pct=0.50 \
 *          --daily-loss-limit-pct=0.04 \
 *          --weekly-loss-limit-pct=0.10
 *      Sends to POST /api/admin/cutover/flip. The endpoint runs the
 *      Amendment 2 atomic transaction — view, kill-switch flip,
 *      cutover_completed_at, four guardrail percentages, derived
 *      absolute bankroll_floor, paper baseline snapshot, compliance log.
 *
 * Required env: API_URL (default http://localhost:8080).
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:8080";

interface Args {
  confirm: boolean;
  realBalance: number | null;
  maxStakePct: number | null;
  bankrollFloorPct: number | null;
  dailyLossLimitPct: number | null;
  weeklyLossLimitPct: number | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    confirm: false,
    realBalance: null,
    maxStakePct: null,
    bankrollFloorPct: null,
    dailyLossLimitPct: null,
    weeklyLossLimitPct: null,
  };
  for (const x of argv) {
    if (x === "--confirm") a.confirm = true;
    else if (x.startsWith("--real-balance="))           a.realBalance        = Number(x.slice("--real-balance=".length));
    else if (x.startsWith("--max-stake-pct="))          a.maxStakePct        = Number(x.slice("--max-stake-pct=".length));
    else if (x.startsWith("--bankroll-floor-pct="))     a.bankrollFloorPct   = Number(x.slice("--bankroll-floor-pct=".length));
    else if (x.startsWith("--daily-loss-limit-pct="))   a.dailyLossLimitPct  = Number(x.slice("--daily-loss-limit-pct=".length));
    else if (x.startsWith("--weekly-loss-limit-pct="))  a.weeklyLossLimitPct = Number(x.slice("--weekly-loss-limit-pct=".length));
  }
  return a;
}

interface FlipResponse {
  success: boolean;
  message?: string;
  result?: {
    snapshot_id: number | null;
    paper_baseline_bankroll: number | null;
    absolute_bankroll_floor: number;
    compliance_log_id: number | null;
  };
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  const missing: string[] = [];
  if (a.realBalance        == null || !Number.isFinite(a.realBalance))        missing.push("--real-balance");
  if (a.maxStakePct        == null || !Number.isFinite(a.maxStakePct))        missing.push("--max-stake-pct");
  if (a.bankrollFloorPct   == null || !Number.isFinite(a.bankrollFloorPct))   missing.push("--bankroll-floor-pct");
  if (a.dailyLossLimitPct  == null || !Number.isFinite(a.dailyLossLimitPct))  missing.push("--daily-loss-limit-pct");
  if (a.weeklyLossLimitPct == null || !Number.isFinite(a.weeklyLossLimitPct)) missing.push("--weekly-loss-limit-pct");
  if (missing.length > 0) {
    console.error(`Missing required: ${missing.join(", ")}`);
    process.exit(2);
  }

  const absoluteFloor = Math.round((a.bankrollFloorPct! * a.realBalance!) * 100) / 100;

  console.log("================================================================");
  console.log("                      FLIP-CUTOVER PREVIEW");
  console.log("================================================================");
  console.log(`real Betfair availableToBetBalance:  £${a.realBalance!.toFixed(2)}`);
  console.log(`max_stake_pct:                       ${(a.maxStakePct! * 100).toFixed(2)}%`);
  console.log(`bankroll_floor_pct:                  ${(a.bankrollFloorPct! * 100).toFixed(2)}%`);
  console.log(`  → absolute bankroll_floor:         £${absoluteFloor.toFixed(2)}`);
  console.log(`daily_loss_limit_pct:                ${(a.dailyLossLimitPct! * 100).toFixed(2)}%`);
  console.log(`  → daily loss cap absolute:         £${(a.realBalance! * a.dailyLossLimitPct!).toFixed(2)}`);
  console.log(`weekly_loss_limit_pct:               ${(a.weeklyLossLimitPct! * 100).toFixed(2)}%`);
  console.log(`  → weekly loss cap absolute:        £${(a.realBalance! * a.weeklyLossLimitPct!).toFixed(2)}`);
  console.log("");
  console.log("Atomic transaction will:");
  console.log("  1. CREATE OR REPLACE VIEW live_bets_current");
  console.log("  2. SET live_placement_enabled='true'");
  console.log("  3. SET cutover_completed_at=NOW()");
  console.log("  4. UPSERT four guardrail percentages + absolute bankroll_floor");
  console.log("  5. INSERT bankroll_snapshots row (label='paper_baseline_pre_flip')");
  console.log("  6. INSERT compliance_logs entry tagged 'cutover_completed'");
  console.log("");

  if (!a.confirm) {
    console.log("--- preview only. Re-run with --confirm to execute. ---");
    process.exit(0);
  }

  console.log("Sending flip to API...");
  const r = await fetch(`${API_URL}/api/admin/cutover/flip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirm: true,
      real_betfair_balance: a.realBalance,
      max_stake_pct: a.maxStakePct,
      bankroll_floor_pct: a.bankrollFloorPct,
      daily_loss_limit_pct: a.dailyLossLimitPct,
      weekly_loss_limit_pct: a.weeklyLossLimitPct,
    }),
  });
  const body = (await r.json()) as FlipResponse;
  if (!body.success) {
    console.error(`flip failed (HTTP ${r.status}): ${body.message ?? "unknown"}`);
    process.exit(2);
  }
  console.log("================================================================");
  console.log("                       FLIP COMPLETE");
  console.log("================================================================");
  console.log(`paper_baseline_snapshot_id:     ${body.result?.snapshot_id ?? "—"}`);
  console.log(`paper_baseline_bankroll:        ${body.result?.paper_baseline_bankroll != null ? "£" + body.result.paper_baseline_bankroll.toFixed(2) : "—"}`);
  console.log(`absolute_bankroll_floor:        £${body.result?.absolute_bankroll_floor.toFixed(2)}`);
  console.log(`compliance_log_id:              ${body.result?.compliance_log_id ?? "—"}`);
  console.log("");
  console.log("Next: review with `npm run live-health`, then `npm run cutover -- --dry-run`.");
})().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(3);
});
