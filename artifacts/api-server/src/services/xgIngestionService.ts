import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

interface TeamXGLatest {
  teamName: string;
  league: string;
  xgFor5: number;
  xgAgainst5: number;
  xgDiff5: number;
  goalsVsXgDiff: number;
  xgMomentum: number;
  matchesCounted: number;
  computedAt: Date;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export async function runXGIngestion(): Promise<{ inserted: number; updated: number }> {
  logger.info("xG ingestion starting");

  const featuresResult = await db.execute(sql`
    SELECT
      m.id::text                   AS id,
      m.home_team,
      m.away_team,
      m.league,
      '2024-25'                    AS season,
      m.kickoff_time::date::text   AS match_date,
      MAX(CASE WHEN f.feature_name = 'home_xg_proxy' THEN f.feature_value::real END) AS home_xg,
      MAX(CASE WHEN f.feature_name = 'away_xg_proxy' THEN f.feature_value::real END) AS away_xg,
      m.home_score                 AS home_goals,
      m.away_score                 AS away_goals,
      (m.home_score IS NOT NULL)   AS is_result
    FROM matches m
    JOIN features f ON f.match_id = m.id
    WHERE f.feature_name IN ('home_xg_proxy', 'away_xg_proxy')
    GROUP BY m.id, m.home_team, m.away_team, m.league, m.kickoff_time, m.home_score, m.away_score
    HAVING
      MAX(CASE WHEN f.feature_name = 'home_xg_proxy' THEN f.feature_value END) IS NOT NULL
      AND MAX(CASE WHEN f.feature_name = 'away_xg_proxy' THEN f.feature_value END) IS NOT NULL
    ORDER BY m.kickoff_time
  `);

  const rows = ((featuresResult as any).rows ?? []) as Array<{
    id: string;
    home_team: string;
    away_team: string;
    league: string;
    season: string;
    match_date: string;
    home_xg: number;
    away_xg: number;
    home_goals: number | null;
    away_goals: number | null;
    is_result: boolean;
  }>;

  logger.info({ count: rows.length }, "Fixtures with xG proxy data found");

  let totalInserted = 0;
  let totalUpdated = 0;

  for (const row of rows) {
    const existingResult = await db.execute(sql`
      SELECT id, is_result FROM xg_match_data WHERE id = ${row.id}
    `);
    const existing = ((existingResult as any).rows ?? []) as Array<{ id: string; is_result: boolean }>;

    if (existing.length === 0) {
      await db.execute(sql`
        INSERT INTO xg_match_data
          (id, home_team, away_team, league, season, match_date,
           home_xg, away_xg, home_goals, away_goals, is_result, created_at)
        VALUES
          (${row.id}, ${row.home_team}, ${row.away_team}, ${row.league},
           ${row.season}, ${row.match_date},
           ${row.home_xg}, ${row.away_xg},
           ${row.home_goals ?? null}, ${row.away_goals ?? null},
           ${row.is_result}, NOW())
        ON CONFLICT (id) DO NOTHING
      `);
      totalInserted++;
    } else if (!existing[0].is_result && row.is_result) {
      await db.execute(sql`
        UPDATE xg_match_data SET
          home_goals = ${row.home_goals ?? null},
          away_goals = ${row.away_goals ?? null},
          is_result  = true
        WHERE id = ${row.id}
      `);
      totalUpdated++;
    } else if (!existing[0].is_result) {
      await db.execute(sql`
        UPDATE xg_match_data SET
          home_xg = ${row.home_xg},
          away_xg = ${row.away_xg}
        WHERE id = ${row.id}
      `);
      totalUpdated++;
    }
  }

  logger.info({ totalInserted, totalUpdated }, "xG match data upsert complete — computing rolling stats");

  await computeTeamXGRolling();

  logger.info("xG ingestion complete");
  return { inserted: totalInserted, updated: totalUpdated };
}

export async function computeTeamXGRolling(): Promise<void> {
  const teamsResult = await db.execute(sql`
    SELECT DISTINCT home_team AS team, league FROM xg_match_data
    UNION
    SELECT DISTINCT away_team AS team, league FROM xg_match_data
  `);

  const teams = ((teamsResult as any).rows ?? []) as Array<{ team: string; league: string }>;

  logger.info({ count: teams.length }, "Computing rolling xG for teams");

  for (const { team, league } of teams) {
    const matchesResult = await db.execute(sql`
      SELECT
        match_date,
        CASE WHEN home_team = ${team} THEN home_xg   ELSE away_xg   END AS xg_for,
        CASE WHEN home_team = ${team} THEN away_xg   ELSE home_xg   END AS xg_against,
        CASE WHEN home_team = ${team} THEN home_goals ELSE away_goals END AS goals_for,
        CASE WHEN home_team = ${team} THEN away_goals ELSE home_goals END AS goals_against,
        is_result
      FROM xg_match_data
      WHERE (home_team = ${team} OR away_team = ${team})
      ORDER BY match_date DESC
      LIMIT 12
    `);

    const rows = ((matchesResult as any).rows ?? []) as Array<{
      match_date: string;
      xg_for: number;
      xg_against: number;
      goals_for: number | null;
      goals_against: number | null;
      is_result: boolean;
    }>;

    if (rows.length === 0) continue;

    const last6  = rows.slice(0, 6);
    const prev6  = rows.slice(6, 12);

    const xgFor5     = avg(last6.map((r) => Number(r.xg_for)));
    const xgAgainst5 = avg(last6.map((r) => Number(r.xg_against)));
    const xgDiff5    = xgFor5 - xgAgainst5;

    const settledRows = last6.filter((r) => r.is_result && r.goals_for != null);
    const goalsFor5   = settledRows.length > 0 ? avg(settledRows.map((r) => Number(r.goals_for))) : xgFor5;
    const goalsVsXgDiff = goalsFor5 - xgFor5;

    let xgMomentum = 0;
    if (prev6.length >= 3) {
      const prevXgFor     = avg(prev6.map((r) => Number(r.xg_for)));
      const prevXgAgainst = avg(prev6.map((r) => Number(r.xg_against)));
      const prevDiff      = prevXgFor - prevXgAgainst;
      xgMomentum = xgDiff5 - prevDiff;
    }

    await db.execute(sql`
      INSERT INTO team_xg_rolling
        (team_name, league, computed_at, xg_for_5, xg_against_5, xg_diff_5,
         goals_vs_xg_diff, xg_momentum, matches_counted)
      VALUES
        (${team}, ${league}, NOW(), ${xgFor5}, ${xgAgainst5}, ${xgDiff5},
         ${goalsVsXgDiff}, ${xgMomentum}, ${last6.length})
    `);
  }

  logger.info({ count: teams.length }, "Team xG rolling stats computed");
}

export async function getTeamXGStats(teamName: string): Promise<TeamXGLatest | null> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (team_name)
      team_name, league, xg_for_5, xg_against_5, xg_diff_5,
      goals_vs_xg_diff, xg_momentum, matches_counted, computed_at
    FROM team_xg_rolling
    WHERE LOWER(team_name) LIKE ${`%${teamName.toLowerCase()}%`}
    ORDER BY team_name, computed_at DESC
    LIMIT 1
  `);

  const rows = ((result as any).rows ?? []) as TeamXGLatest[];
  return rows[0] ?? null;
}

export async function getAllTeamXGStats(): Promise<TeamXGLatest[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (team_name)
      team_name, league, xg_for_5, xg_against_5, xg_diff_5,
      goals_vs_xg_diff, xg_momentum, matches_counted, computed_at
    FROM team_xg_rolling
    ORDER BY team_name, computed_at DESC
  `);

  const rows = ((result as any).rows ?? []) as TeamXGLatest[];

  rows.sort(
    (a, b) => Math.abs(Number(b.xgDiff5)) - Math.abs(Number(a.xgDiff5)),
  );

  return rows;
}
