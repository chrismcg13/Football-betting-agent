/**
 * Cancel unmatched portions of pre-parser-fix (pre-2026-05-14 18:00 UTC)
 * live AH bets that are holding (market_id, selection_id) slots the
 * correctly-routed parser now wants.
 *
 * EXECUTABLE-only by construction: 0% matched, fully cancellable, slot
 * fully released. PARTIALLY_MATCHED is intentionally excluded — its
 * matched stake is committed on Betfair regardless, and the post-cancel
 * status (PARTIAL_ACCEPTED) stays in the universal collapse-guard
 * liveStatuses set so the slot remains blocked. Those settle naturally
 * on kickoff.
 *
 * Usage (from repo root, after sourcing .env):
 *   pnpm dlx tsx artifacts/api-server/src/cli/cancel-stranded-prefix-live-bets.ts             # dry-run
 *   pnpm dlx tsx artifacts/api-server/src/cli/cancel-stranded-prefix-live-bets.ts --execute   # do it
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const CUTOFF_ISO = "2026-05-14T18:00:00Z";
const API_HOST = process.env["API_HOST"] ?? "http://localhost:8080";
const SLEEP_MS = Number(process.env["SLEEP_BETWEEN_MS"] ?? "400");

interface Candidate {
  id: number;
  betfair_bet_id: string;
  selection_name: string;
  betfair_status: string;
  matched: string;
  match_id: number;
  league: string;
  kickoff: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");

  const candidates = await db.execute(sql`
    SELECT pb.id,
           pb.betfair_bet_id,
           pb.selection_name,
           pb.betfair_status,
           COALESCE(pb.betfair_size_matched, 0)::text AS matched,
           pb.match_id,
           m.league,
           to_char(m.kickoff_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS kickoff
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.bet_track = 'live'
      AND pb.market_type = 'ASIAN_HANDICAP'
      AND pb.placed_at < ${CUTOFF_ISO}::timestamptz
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

  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}`);
  console.log(`Cutoff: ${CUTOFF_ISO}`);
  console.log(`API host: ${API_HOST}`);
  console.log(`Candidates: ${rows.length}`);
  console.log();

  if (rows.length === 0) {
    console.log("No EXECUTABLE pre-parser-fix stranded bets. Backlog clear.");
    process.exit(0);
  }

  const preview = rows.slice(0, 20);
  for (const r of preview) {
    const id = String(r.id).padStart(6);
    const bf = (r.betfair_bet_id ?? "-").padEnd(12);
    const sel = (r.selection_name ?? "-").padEnd(12);
    const league = (r.league ?? "-").slice(0, 28).padEnd(28);
    console.log(`bet=${id} bf=${bf} sel='${sel}' match=${r.match_id} league='${league}' kickoff=${r.kickoff}`);
  }
  if (rows.length > 20) console.log(`...(showing first 20 of ${rows.length})`);

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
        console.log(`${idx} OK   bet=${r.id} sel='${r.selection_name}' league='${r.league}'`);
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
