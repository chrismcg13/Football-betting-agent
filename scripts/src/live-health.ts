#!/usr/bin/env node
/**
 * Pre-flip blocker #12 — live-health snapshot CLI.
 *
 *   npm run live-health
 *
 * Required env: API_URL (default http://localhost:8080).
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:8080";

interface HealthResponse {
  success: boolean;
  message?: string;
  result?: {
    kill_switch: {
      live_placement_enabled: boolean;
      last_updated: string | null;
      auto_disable_reason: string | null;
      last_auto_disable_at: string | null;
    };
    cutover_completed_at: string | null;
    bankroll: {
      betfair_available_cached: number | null;
      locked_reserve: number;
      active_estimate: number | null;
    };
    guardrails: {
      max_stake_pct: number;
      bankroll_floor: number;
      daily_loss_limit_pct: number;
      weekly_loss_limit_pct: number;
    };
    recent_24h_errors: Array<{ action_type: string; n: number; last: string }>;
    paper_emission_7d_trend: Array<{ day: string; paper_emitted: number; live_attempted: number }>;
    today_volume: {
      stake_total: number;
      realised_pnl: number;
      daily_loss_cap_abs: number | null;
      distance_to_cap: number | null;
    };
    live_perf_since_cutover: { settled: number; net_pnl: number; stake: number } | null;
  };
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const sign = Number(v) < 0 ? "-" : "";
  return `${sign}£${Math.abs(Number(v)).toFixed(2)}`;
}

(async () => {
  const r = await fetch(`${API_URL}/api/admin/live-health`);
  const body = (await r.json()) as HealthResponse;
  if (!body.success || !body.result) {
    console.error(`live-health failed (HTTP ${r.status}): ${body.message ?? "unknown"}`);
    process.exit(1);
  }
  const x = body.result;

  console.log("================================================================");
  console.log("                          LIVE HEALTH");
  console.log("================================================================");
  console.log(`kill_switch:                ${x.kill_switch.live_placement_enabled ? "ON" : "OFF"}  (last_updated ${x.kill_switch.last_updated ?? "—"})`);
  if (x.kill_switch.auto_disable_reason) {
    console.log(`auto_disable_reason:        ${x.kill_switch.auto_disable_reason}`);
    console.log(`last_auto_disable_at:       ${x.kill_switch.last_auto_disable_at ?? "—"}`);
  }
  console.log(`cutover_completed_at:       ${x.cutover_completed_at ?? "(not flipped)"}`);
  console.log("");
  console.log("Bankroll:");
  console.log(`  betfair_available (cached): ${fmtMoney(x.bankroll.betfair_available_cached)}`);
  console.log(`  locked_reserve:             ${fmtMoney(x.bankroll.locked_reserve)}`);
  console.log(`  active estimate:            ${fmtMoney(x.bankroll.active_estimate)}`);
  console.log("");
  console.log("Guardrails:");
  console.log(`  max_stake_pct:         ${(x.guardrails.max_stake_pct * 100).toFixed(2)}%`);
  console.log(`  bankroll_floor:        ${fmtMoney(x.guardrails.bankroll_floor)}`);
  console.log(`  daily_loss_limit_pct:  ${(x.guardrails.daily_loss_limit_pct * 100).toFixed(2)}%`);
  console.log(`  weekly_loss_limit_pct: ${(x.guardrails.weekly_loss_limit_pct * 100).toFixed(2)}%`);
  console.log("");
  console.log("Today's volume:");
  console.log(`  stake_total:           ${fmtMoney(x.today_volume.stake_total)}`);
  console.log(`  realised_pnl:          ${fmtMoney(x.today_volume.realised_pnl)}`);
  console.log(`  daily_loss_cap_abs:    ${fmtMoney(x.today_volume.daily_loss_cap_abs)}`);
  console.log(`  distance_to_cap:       ${fmtMoney(x.today_volume.distance_to_cap)}`);
  console.log("");
  console.log("Paper-emission 7-day trend (volume-shock awareness):");
  for (const t of x.paper_emission_7d_trend) {
    const dayShort = t.day.slice(0, 10);
    console.log(`  ${dayShort}  paper=${String(t.paper_emitted).padStart(4)}  live=${String(t.live_attempted).padStart(4)}`);
  }
  console.log("");
  console.log("Recent 24h compliance errors:");
  if (x.recent_24h_errors.length === 0) {
    console.log("  (none)");
  } else {
    for (const e of x.recent_24h_errors) {
      console.log(`  ${e.action_type.padEnd(45)} n=${String(e.n).padStart(4)}  last=${e.last}`);
    }
  }
  console.log("");
  if (x.live_perf_since_cutover) {
    const lp = x.live_perf_since_cutover;
    const roi = lp.stake > 0 ? (100 * lp.net_pnl / lp.stake).toFixed(2) : "—";
    console.log(`Live since cutover: settled=${lp.settled}  stake=${fmtMoney(lp.stake)}  net_pnl=${fmtMoney(lp.net_pnl)}  ROI=${roi}%`);
  } else {
    console.log("Live since cutover: (not flipped yet)");
  }
})().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(3);
});
