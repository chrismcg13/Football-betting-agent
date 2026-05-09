#!/usr/bin/env node
/**
 * Pre-flip blocker #7 — locked_reserve CLI.
 *
 *   npm run reserve -- status
 *   npm run reserve -- lock --amount=5000 --note="post-Phase-2 milestone"
 *   npm run reserve -- unlock --amount=2000 --note="changed mind"
 *   npm run reserve -- withdrawal --amount=10000 --betfair-tx-id=ABC123 --note="bank xfer"
 *   npm run reserve -- reconcile      (no-op stub until daily reconcile cron lands)
 *
 * Required env: API_URL (default http://localhost:8080).
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:8080";

type Action = "status" | "lock" | "unlock" | "withdrawal" | "reconcile";

interface Args {
  action: Action | null;
  amount: number | null;
  note: string | null;
  betfairTxId: string | null;
}

function parseArgs(argv: string[]): Args {
  let action: Action | null = null;
  let amount: number | null = null;
  let note: string | null = null;
  let betfairTxId: string | null = null;

  for (const a of argv) {
    if (a === "status" || a === "lock" || a === "unlock" || a === "withdrawal" || a === "reconcile") {
      action = a;
    } else if (a.startsWith("--amount=")) {
      amount = Number(a.slice("--amount=".length));
    } else if (a.startsWith("--note=")) {
      note = a.slice("--note=".length);
    } else if (a.startsWith("--betfair-tx-id=")) {
      betfairTxId = a.slice("--betfair-tx-id=".length);
    }
  }
  return { action, amount, note, betfairTxId };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await r.json()) as T;
  return { status: r.status, body };
}

interface StatusResponse {
  success: boolean;
  message?: string;
  result?: {
    current_locked: number;
    betfair_available_cached: number | null;
    active_bankroll_estimate: number | null;
    recent_events: Array<{
      id: number; event_type: string; amount: number;
      prior_locked: number; new_locked: number;
      notes: string | null; created_at: string; created_by: string;
    }>;
  };
}

interface EventResponse {
  success: boolean;
  message?: string;
  result?: { priorLocked: number; newLocked: number; amount: number; eventId: number };
}

async function status(): Promise<number> {
  const { status, body } = await fetchJson<StatusResponse>("/api/admin/reserve/status");
  if (!body.success || !body.result) {
    console.error(`status failed (HTTP ${status}): ${body.message ?? "unknown"}`);
    return 1;
  }
  const r = body.result;
  console.log("================================================================");
  console.log("                       LOCKED RESERVE STATUS");
  console.log("================================================================");
  console.log(`current_locked:               £${r.current_locked.toFixed(2)}`);
  console.log(`betfair_available (cached):   ${r.betfair_available_cached == null ? "null" : "£" + r.betfair_available_cached.toFixed(2)}`);
  console.log(`active_bankroll_estimate:     ${r.active_bankroll_estimate == null ? "null" : "£" + r.active_bankroll_estimate.toFixed(2)}`);
  console.log("");
  console.log(`recent events (last ${r.recent_events.length}):`);
  for (const e of r.recent_events) {
    console.log(`  [${e.created_at}] ${e.event_type.padEnd(20)} £${Number(e.amount).toFixed(2).padStart(10)}  ${e.prior_locked.toFixed(2)} → ${e.new_locked.toFixed(2)}  ${e.notes ?? ""}`);
  }
  return 0;
}

async function event(eventType: "lock" | "unlock" | "withdrawal_recorded", args: Args): Promise<number> {
  if (args.amount == null || !Number.isFinite(args.amount) || args.amount <= 0) {
    console.error(`--amount=<positive number> is required`);
    return 2;
  }
  const notes = args.note ?? (args.betfairTxId ? `betfair_tx_id=${args.betfairTxId}` : null);
  const { status, body } = await fetchJson<EventResponse>("/api/admin/reserve/event", {
    method: "POST",
    body: JSON.stringify({ event_type: eventType, amount: args.amount, notes }),
  });
  if (!body.success || !body.result) {
    console.error(`${eventType} failed (HTTP ${status}): ${body.message ?? "unknown"}`);
    return 2;
  }
  const r = body.result;
  console.log(`${eventType} OK — £${args.amount.toFixed(2)}  locked: ${r.priorLocked.toFixed(2)} → ${r.newLocked.toFixed(2)}  (event_id=${r.eventId})`);
  return 0;
}

async function reconcile(): Promise<number> {
  console.log("reconcile: deferred — will be wired to listAccountStatement daily cron post-cutover");
  return 0;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.action) {
    console.error("Usage: npm run reserve -- <status|lock|unlock|withdrawal|reconcile> [--amount=...] [--note=...] [--betfair-tx-id=...]");
    process.exit(2);
  }
  let code = 0;
  switch (args.action) {
    case "status":      code = await status(); break;
    case "lock":        code = await event("lock", args); break;
    case "unlock":      code = await event("unlock", args); break;
    case "withdrawal":  code = await event("withdrawal_recorded", args); break;
    case "reconcile":   code = await reconcile(); break;
  }
  process.exit(code);
})().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(3);
});
