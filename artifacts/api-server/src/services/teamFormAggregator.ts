/**
 * Phase 2c (2026-05-15) — SQL-only team_form_scrape aggregator.
 *
 * Replaces the broken FBref scraper path. Computes season-aggregate
 * per-(source × league × season × team) rows from xg_match_data,
 * which is fed by working ingest paths (Understat men's, StatsBomb
 * women's tournaments). When a new xg_match_data source lands later
 * (e.g. if FotMob's API ever returns or someone wires Sofascore via
 * a paid proxy service), the same aggregator picks it up
 * automatically — no per-source scraper code to maintain.
 *
 * Idempotent. UPSERT on the (source, league, season, team_name,
 * snapshot_date) unique index. Runs in seconds even at full xg_match_
 * data scale (8k+ rows aggregated to a few hundred summaries).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface TeamFormAggregateResult {
  rowsWritten: number;
  durationMs: number;
  bySource: Record<string, number>;
}

/**
 * Aggregate xg_match_data → team_form_scrape, one row per (source,
 * league, season, team_name, current_date). Both `home_team` and
 * `away_team` perspectives are unioned per team — each match
 * contributes one xg_for and one xg_against entry to that team.
 */
export async function runTeamFormAggregation(): Promise<TeamFormAggregateResult> {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // Build a one-row-per-team aggregate from BOTH sides of each match.
  // home perspective: xg_for = home_xg, xg_against = away_xg.
  // away perspective: xg_for = away_xg, xg_against = home_xg.
  // gender derives from team-name suffix " W" (matches the Phase 2d
  // normalisation convention from StatsBomb / forthcoming FotMob).
  const upserted = (await db.execute(sql`
    WITH per_team AS (
      SELECT source, league, season,
             home_team AS team_name,
             home_xg   AS xg_for,
             away_xg   AS xg_against,
             home_goals AS goals_for,
             away_goals AS goals_against,
             is_result
      FROM xg_match_data
      WHERE home_team IS NOT NULL AND home_team <> ''
        AND home_xg IS NOT NULL AND away_xg IS NOT NULL
      UNION ALL
      SELECT source, league, season,
             away_team AS team_name,
             away_xg   AS xg_for,
             home_xg   AS xg_against,
             away_goals AS goals_for,
             home_goals AS goals_against,
             is_result
      FROM xg_match_data
      WHERE away_team IS NOT NULL AND away_team <> ''
        AND home_xg IS NOT NULL AND away_xg IS NOT NULL
    ),
    agg AS (
      SELECT source, league, season, team_name,
             count(*)                                            AS matches_played,
             round(sum(xg_for)::numeric, 3)                       AS xg_for,
             round(sum(xg_against)::numeric, 3)                   AS xg_against,
             sum(CASE WHEN is_result THEN goals_for ELSE NULL END)::int     AS goals_for,
             sum(CASE WHEN is_result THEN goals_against ELSE NULL END)::int AS goals_against
      FROM per_team
      GROUP BY source, league, season, team_name
    )
    INSERT INTO team_form_scrape
      (source, league_name, gender, season, team_name, snapshot_date,
       matches_played, xg_for, xg_against, goals_for, goals_against)
    SELECT
      agg.source,
      agg.league,
      CASE WHEN team_name LIKE '% W' THEN 'female' ELSE 'male' END AS gender,
      agg.season,
      agg.team_name,
      ${today}::date,
      agg.matches_played,
      agg.xg_for,
      agg.xg_against,
      agg.goals_for,
      agg.goals_against
    FROM agg
    ON CONFLICT (source, league_name, season, team_name, snapshot_date)
    DO UPDATE SET
      matches_played = EXCLUDED.matches_played,
      xg_for         = EXCLUDED.xg_for,
      xg_against     = EXCLUDED.xg_against,
      goals_for      = EXCLUDED.goals_for,
      goals_against  = EXCLUDED.goals_against
  `)) as unknown as { rowCount?: number };

  // Per-source breakdown for the operator response.
  const bySrcRows = (await db.execute(sql`
    SELECT source, count(*)::int AS n
    FROM team_form_scrape
    WHERE snapshot_date = ${today}::date
    GROUP BY source ORDER BY n DESC
  `)) as unknown as { rows: Array<{ source: string; n: number }> };

  const bySource: Record<string, number> = {};
  for (const r of bySrcRows.rows ?? []) {
    bySource[r.source] = r.n;
  }

  const durationMs = Date.now() - startedAt;
  const rowsWritten = upserted.rowCount ?? 0;

  logger.info(
    { rowsWritten, durationMs, bySource, snapshotDate: today },
    "Team-form aggregation complete",
  );

  return { rowsWritten, durationMs, bySource };
}
