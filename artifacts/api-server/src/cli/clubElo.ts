/**
 * Task 15 / F.15 (2026-05-11 — back-to-theory plan):
 * One-shot ClubElo ingestion + feature-backfill CLI.
 *
 * Usage from the VPS, after build:
 *   node ./artifacts/api-server/dist/cli/clubElo.js              # today
 *   node ./artifacts/api-server/dist/cli/clubElo.js 2026-05-11   # specific date (UTC)
 *
 * Fetches the ClubElo daily snapshot (~3,300 rows), upserts to
 * club_elo_snapshots, then chains the feature backfill so upcoming
 * fixtures pick up Elo features immediately. Idempotent on the
 * (date, team_name) primary key.
 *
 * Useful when the daily 02:00 UTC cron has been silently missed
 * (e.g., after a restart that left the scheduler in `no_model_loaded`
 * short-circuit) and the operator wants to manually rehydrate.
 */
import { runClubEloIngestion, runClubEloFeatureBackfill } from "../services/clubElo";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const dateOverride = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : undefined;
  if (arg && !dateOverride) {
    console.error(`Invalid date arg: ${arg}. Expect YYYY-MM-DD.`);
    process.exit(1);
  }

  console.log(`[clubElo CLI] ingesting for ${dateOverride ?? "yesterday-UTC default"} ...`);
  const ingest = await runClubEloIngestion(dateOverride ? { dateOverride } : {});
  console.log(`[clubElo CLI] ingestion done:`, JSON.stringify(ingest, null, 2));

  console.log(`[clubElo CLI] running feature backfill ...`);
  const backfill = await runClubEloFeatureBackfill();
  console.log(`[clubElo CLI] backfill done:`, JSON.stringify(backfill, null, 2));

  console.log(`[clubElo CLI] complete.`);
}

main().catch((err) => {
  console.error(`[clubElo CLI] failed:`, err);
  process.exit(1);
});
