/**
 * Cancel EXECUTABLE (unmatched) live Betfair bets whose market_type is
 * currently in agent_config.live_placement_disabled_market_types.
 *
 * Companion to the per-market kill switch (livePlacementGate.ts /
 * paperTrading.placePaperBet). The kill switch stops NEW placements;
 * this script unwinds the IN-FLIGHT pending unmatched portion of bets
 * that were placed before the disable.
 *
 * EXECUTABLE-only by construction: 0% matched, fully cancellable,
 * Betfair slot fully released. PARTIALLY_MATCHED is intentionally
 * excluded — the matched stake is committed on Betfair regardless,
 * and post-cancel status (PARTIAL_ACCEPTED) stays in the universal
 * collapse-guard liveStatuses set so the slot remains blocked. Those
 * settle naturally on kickoff.
 *
 * Usage (from repo root, after sourcing .env):
 *   pnpm dlx tsx artifacts/api-server/src/cli/cancel-disabled-market-unmatched.ts             # dry-run
 *   pnpm dlx tsx artifacts/api-server/src/cli/cancel-disabled-market-unmatched.ts --execute   # cancel
 *
 * Optional env:
 *   API_HOST           — default http://localhost:8080
 *   SLEEP_BETWEEN_MS   — default 400 (Betfair-friendly rate limit)
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const API_HOST = process.env["API_HOST"] ?? "http://localhost:8080";
const SLEEP_MS = Number(process.env["SLEEP_BETWEEN_MS"] ?? "400");

interface Candidate {
  id: number;
  betfair_bet_id: string;
  market_type: string;
  selection_name: string;
  betfair_status: string;
  matched: string;
  match_id: number;
  league: string;
  kickoff: string;
}

async function getDisabledMarkets(): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT value FROM agent_config
    WHERE key = 'live_placement_disabled_market_types' LIMIT 1
  `);
  const r = (((rows as unknown) as { rows?: Array<{ value: string }> }).rows ?? [])[0];
  if (!r?.value) return [];
  return r.value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");

  const disabled = await getDisabledMarkets();

  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}`);
  console.log(`API host: ${API_HOST}`);
  console.log(`Disabled markets: ${disabled.length === 0 ? "(none)" : disabled.join(", ")}`);
  console.log();

  if (disabled.length === 0) {
    console.log("No disabled markets in agent_config.live_placement_disabled_market_types. Nothing to cancel.");
    process.exit(0);
  }

  // Build a parameterized IN-list. db.execute with sql template handles arrays via
  // ANY(${array}) — but the cleanest portable form here is uppercase-comparison.
  const disabledSet = disabled;
  const candidates = await db.execute(sql`
    SELECT pb.id,
           pb.betfair_bet_id,
           pb.market_type,
           pb.selection_name,
           pb.betfair_status,
           COALESCE(pb.betfair_size_matched, 0)::text AS matched,
           pb.match_id,
           m.league,
           to_char(m.kickoff_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS kickoff
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.bet_track = 'live'
      AND UPPER(pb.market_type) = ANY(${disabledSet})
      AND pb.betfair_market_id IS NOT NULL
      AND pb.betfair_selection_id IS NOT NULL
      AND pb.status = 'pending'
      AND pb.betfair_status = 'EXECUTABLE'
      AND COALESCE(pb.betfair_size_matched, 0) = 0
      AND m.kickoff_time > NOW()
      AND pb.deleted_at IS NULL
    ORDER BY pb.id
  `);

  const rows = (((candidates as unknown) as { rows?: Candidate[] }).rows ?? []);
  console.log(`EXECUTABLE unmatched candidates on disabled markets: ${rows.length}`);
  console.log();

  if (rows.length === 0) {
    console.log("No EXECUTABLE unmatched bets on disabled markets. Backlog clear.");
    process.exit(0);
  }

  const preview = rows.slice(0, 30);
  for (const r of preview) {
    const id = String(r.id).padStart(6);
    const bf = (r.betfair_bet_id ?? "-").padEnd(12);
    const mt = (r.market_type ?? "-").padEnd(18);
    const sel = (r.selection_name ?? "-").padEnd(14);
    const league = (r.league ?? "-").slice(0, 24).padEnd(24);
    console.log(`bet=${id} bf=${bf} mt=${mt} sel='${sel}' match=${r.match_id} league='${league}' kickoff=${r.kickoff}`);
  }
  if (rows.length > 30) console.log(`...(showing first 30 of ${rows.length})`);

  // Per-market breakdown so operator sees the distribution.
  const byMarket = new Map<string, number>();
  for (const r of rows) byMarket.set(r.market_type, (byMarket.get(r.market_type) ?? 0) + 1);
  console.log();
  console.log("Per-market breakdown:");
  for (const [mt, n] of [...byMarket.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${mt.padEnd(20)} ${n}`);
  }

  if (!execute) {
    console.log();
    console.log("DRY RUN — pass --execute to cancel.");
    process.exit(0);
  }

  console.log();
  console.log(`Executing. Rate limit ${SLEEP_MS}ms between calls.`);
  console.log();

  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const idx = `[${i + 1}/${rows.length}]`;

    // Re-check status right before cancelling — order management + relay
    // run in parallel and may have settled or cancelled this bet between
    // candidate listing and our turn.
    const recheck = await db.execute(sql`
      SELECT betfair_status FROM paper_bets WHERE id = ${r.id}
    `);
    const recheckRows = (((recheck as unknown) as { rows?: Array<{ betfair_status: string | null }> }).rows ?? []);
    const current = recheckRows[0]?.betfair_status ?? "unknown";

    if (current !== "EXECUTABLE") {
      skipped += 1;
      console.log(`${idx} SKIP bet=${r.id} status_now=${current}`);
      continue;
    }

    try {
      const resp = await fetch(`${API_HOST}/api/admin/cancel-bet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ internalBetId: r.id }),
      });
      if (resp.ok) {
        ok += 1;
        console.log(`${idx} OK   bet=${r.id} mt=${r.market_type} sel='${r.selection_name}' league='${r.league}'`);
      } else {
        fail += 1;
        const body = await resp.text().catch(() => "");
        console.log(`${idx} FAIL bet=${r.id} http=${resp.status} body=${body.slice(0, 200)}`);
      }
    } catch (err) {
      fail += 1;
      console.log(`${idx} FAIL bet=${r.id} err=${String(err).slice(0, 200)}`);
    }

    if (SLEEP_MS > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }

  console.log();
  console.log(`Done. cancelled=${ok} failed=${fail} skipped=${skipped} total=${rows.length}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
