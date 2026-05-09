#!/usr/bin/env node
/**
 * Pre-flip blocker #11 — paper-to-live cutover CLI.
 *
 *   npm run cutover -- --dry-run   (default; nothing committed)
 *   npm run cutover -- --confirm   (executes; converts paper bets to live)
 *
 * Required env: API_URL (default http://localhost:8080).
 *
 * Calls POST /admin/cutover/run with { dryRun: !confirm }. Prints the
 * structured CutoverReport including:
 *   - eligible / converted / shadowed / skipped counts
 *   - by-reason breakdown for failures
 *   - total live exposure
 *   - per-bet outcomes
 *   - historical Tier1 silent-rejection rate (Amendment 3 surface item)
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:8080";

interface PerBet {
  betId: number; marketType: string; league: string;
  paperOdds: number; paperStake: number;
  currentBackOdds: number | null;
  recomputedEdge: number | null;
  recomputedStake: number | null;
  outcome: string; reason: string | null;
  betfairBetId: string | null;
}

interface Report {
  dryRun: boolean;
  evaluatedAt: string;
  liveBankroll: number;
  killSwitchOn: boolean;
  totalEligible: number;
  converted: number;
  shadowed: number;
  skipped: number;
  byReason: Record<string, number>;
  totalLiveExposure: number;
  perBet: PerBet[];
  historicalTier1Rate: Array<{ day: string; paper_emitted: number; live_attempted: number; silently_rejected: number; pct_rejected: number | null }> | null;
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `£${Number(v).toFixed(2)}`;
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = true;
  for (const a of argv) {
    if (a === "--confirm") dryRun = false;
    else if (a === "--dry-run") dryRun = true;
  }
  return { dryRun };
}

(async () => {
  const { dryRun } = parseArgs(process.argv.slice(2));
  console.log(`Running cutover: dryRun=${dryRun}`);
  const r = await fetch(`${API_URL}/api/admin/cutover/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
  const body = (await r.json()) as { success: boolean; message?: string; result?: Report };
  if (!body.success || !body.result) {
    console.error(`cutover failed (HTTP ${r.status}): ${body.message ?? "unknown"}`);
    process.exit(2);
  }
  const x = body.result;

  console.log("================================================================");
  console.log(`           CUTOVER REPORT (${x.dryRun ? "DRY RUN" : "EXECUTED"})`);
  console.log("================================================================");
  console.log(`evaluated_at:    ${x.evaluatedAt}`);
  console.log(`kill_switch:     ${x.killSwitchOn ? "ON" : "OFF (will refuse to run)"}`);
  console.log(`live_bankroll:   ${fmtMoney(x.liveBankroll)}`);
  console.log("");
  console.log(`eligible:        ${x.totalEligible}`);
  console.log(`converted:       ${x.converted}`);
  console.log(`shadowed:        ${x.shadowed}`);
  console.log(`skipped:         ${x.skipped}`);
  console.log(`live exposure:   ${fmtMoney(x.totalLiveExposure)}`);
  console.log("");
  if (Object.keys(x.byReason).length > 0) {
    console.log("By reason:");
    for (const [k, v] of Object.entries(x.byReason)) {
      console.log(`  ${k.padEnd(28)} ${v}`);
    }
    console.log("");
  }
  if (x.historicalTier1Rate && x.historicalTier1Rate.length > 0) {
    console.log("Historical qualifiesForTier1 silent-rejection rate (last 30 evaluated days):");
    for (const t of x.historicalTier1Rate) {
      const day = t.day.slice(0, 10);
      const pct = t.pct_rejected != null ? `${t.pct_rejected.toFixed(1)}%` : "—";
      console.log(`  ${day}  paper=${String(t.paper_emitted).padStart(4)}  live=${String(t.live_attempted).padStart(4)}  rejected=${String(t.silently_rejected).padStart(4)}  pct=${pct}`);
    }
    console.log("");
  } else {
    console.log("Historical Tier1 rate: no data (live rail never evaluated paper bets in this regime)");
    console.log("");
  }
  console.log(`Per-bet (${x.perBet.length}):`);
  const head = "  betId   market_type/league                                outcome      paper→curr odds   stake → recomp   reason";
  console.log(head);
  for (const p of x.perBet.slice(0, 200)) {
    const scope = `${p.marketType}/${p.league}`.slice(0, 50).padEnd(50);
    const outcome = p.outcome.padEnd(12);
    const odds = `${p.paperOdds.toFixed(2)} → ${p.currentBackOdds != null ? p.currentBackOdds.toFixed(2) : "—"}`.padStart(15);
    const stake = `${p.paperStake.toFixed(2)} → ${p.recomputedStake != null ? p.recomputedStake.toFixed(2) : "—"}`.padStart(15);
    const reason = p.reason ?? "";
    console.log(`  ${String(p.betId).padStart(6)} ${scope} ${outcome} ${odds}  ${stake}   ${reason}`);
  }
  if (x.perBet.length > 200) {
    console.log(`  ... and ${x.perBet.length - 200} more`);
  }
  if (x.dryRun) {
    console.log("");
    console.log("Re-run with --confirm to execute.");
  }
})().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(3);
});
