import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  fetchUnderstatLeagueData,
  LEAGUE_MAP,
  type MatchXGData,
} from "../utils/understat";
import { resolveAlias, teamSimilarity } from "./oddsPapi";

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

interface PerLeagueIngestStats {
  league: string;
  scraped: number;
  matched: number;
  unmatched: number;
  inserted: number;
  updated: number;
  sampleUnmatched: string[];
}

const TEAM_SIMILARITY_THRESHOLD = 0.85;
const MAX_SAMPLE_UNMATCHED = 10;

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Determine the active Understat season-year. Football season is e.g. 2024-25;
// Jan-June reads as previous-year-start. Aug-Dec reads as current-year-start.
function activeUnderstatYear(): number {
  const now = new Date();
  return now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0);
}

// Match an Understat record to a row in the matches table.
// Returns matchId on a high-confidence match, null otherwise.
// Conservative: ≥0.85 similarity on BOTH home and away. Bind by league + ±24h window.
async function findMatchingDbRow(
  understatLeague: string,
  understatHome: string,
  understatAway: string,
  understatKickoffMs: number,
): Promise<number | null> {
  const winLow = new Date(understatKickoffMs - 24 * 60 * 60 * 1000);
  const winHigh = new Date(understatKickoffMs + 24 * 60 * 60 * 1000);

  // Pull candidate matches from DB. Bind to league + ±24h window.
  // We compare on the LEAGUE column; Understat's slug ("Serie_A") may differ
  // from our display string ("Serie A"). Try both forms.
  const understatLeagueDisplayMap: Record<string, string[]> = {
    EPL: ["Premier League", "EPL"],
    Bundesliga: ["Bundesliga"],
    La_liga: ["La Liga", "La_liga"],
    Serie_A: ["Serie A", "Serie_A"],
    Ligue_1: ["Ligue 1", "Ligue_1"],
    "La Liga": ["La Liga", "La_liga"],
    "Serie A": ["Serie A", "Serie_A"],
    "Ligue 1": ["Ligue 1", "Ligue_1"],
  };
  const candidateLeagues = understatLeagueDisplayMap[understatLeague] ?? [understatLeague];

  const candidatesResult = await db.execute(sql`
    SELECT id, home_team, away_team, league, kickoff_time
    FROM matches
    WHERE league = ANY(${candidateLeagues})
      AND kickoff_time >= ${winLow}
      AND kickoff_time <= ${winHigh}
  `);
  const candidates = ((candidatesResult as any).rows ?? []) as Array<{
    id: number;
    home_team: string;
    away_team: string;
    league: string;
    kickoff_time: Date;
  }>;

  if (candidates.length === 0) return null;

  // Resolve aliases up-front for the Understat names.
  const understatHomeResolved = resolveAlias(understatHome);
  const understatAwayResolved = resolveAlias(understatAway);

  let best: { id: number; homeSim: number; awaySim: number; dtMs: number } | null = null;
  for (const c of candidates) {
    const dbHomeResolved = resolveAlias(c.home_team);
    const dbAwayResolved = resolveAlias(c.away_team);
    const homeSim = teamSimilarity(understatHomeResolved, dbHomeResolved);
    const awaySim = teamSimilarity(understatAwayResolved, dbAwayResolved);
    if (homeSim < TEAM_SIMILARITY_THRESHOLD || awaySim < TEAM_SIMILARITY_THRESHOLD) continue;
    const dtMs = Math.abs(new Date(c.kickoff_time).getTime() - understatKickoffMs);
    // Pick closest kickoff among tying-quality matches
    if (
      !best ||
      homeSim + awaySim > best.homeSim + best.awaySim ||
      (homeSim + awaySim === best.homeSim + best.awaySim && dtMs < best.dtMs)
    ) {
      best = { id: c.id, homeSim, awaySim, dtMs };
    }
  }

  return best?.id ?? null;
}

async function ingestLeague(
  league: string,
  matches: MatchXGData[],
): Promise<PerLeagueIngestStats> {
  const stats: PerLeagueIngestStats = {
    league,
    scraped: matches.length,
    matched: 0,
    unmatched: 0,
    inserted: 0,
    updated: 0,
    sampleUnmatched: [],
  };

  for (const m of matches) {
    const understatKickoffMs = new Date(m.datetime).getTime();
    if (Number.isNaN(understatKickoffMs)) {
      stats.unmatched++;
      if (stats.sampleUnmatched.length < MAX_SAMPLE_UNMATCHED) {
        stats.sampleUnmatched.push(`${m.home_team} vs ${m.away_team} (bad datetime)`);
      }
      continue;
    }

    const matchId = await findMatchingDbRow(
      league,
      m.home_team,
      m.away_team,
      understatKickoffMs,
    );

    if (matchId === null) {
      stats.unmatched++;
      if (stats.sampleUnmatched.length < MAX_SAMPLE_UNMATCHED) {
        stats.sampleUnmatched.push(`${m.home_team} vs ${m.away_team}`);
      }
      continue;
    }

    stats.matched++;

    // Use the Understat numeric match id as the primary key for xg_match_data.
    // ON CONFLICT (id) DO UPDATE handles re-scrapes idempotently.
    const matchDate = m.datetime.slice(0, 10);
    const homeXg = (m.home_xG as number | null) ?? null;
    const awayXg = (m.away_xG as number | null) ?? null;
    const homeGoals = m.isResult ? (m.home_goals as number | null) ?? null : null;
    const awayGoals = m.isResult ? (m.away_goals as number | null) ?? null : null;
    const isResult =
      m.isResult && m.home_goals != null && m.away_goals != null ? true : false;

    const existingResult = await db.execute(sql`
      SELECT id, is_result FROM xg_match_data WHERE id = ${m.id}
    `);
    const existing = ((existingResult as any).rows ?? []) as Array<{
      id: string;
      is_result: boolean;
    }>;

    if (existing.length === 0) {
      await db.execute(sql`
        INSERT INTO xg_match_data
          (id, home_team, away_team, league, season, match_date,
           home_xg, away_xg, home_goals, away_goals, is_result, source, created_at)
        VALUES
          (${m.id}, ${m.home_team}, ${m.away_team}, ${league},
           ${`${activeUnderstatYear()}-${(activeUnderstatYear() + 1).toString().slice(-2)}`},
           ${matchDate},
           ${homeXg}, ${awayXg}, ${homeGoals}, ${awayGoals},
           ${isResult}, 'understat', NOW())
        ON CONFLICT (id) DO NOTHING
      `);
      stats.inserted++;
    } else if (!existing[0].is_result && isResult) {
      // Result newly arrived
      await db.execute(sql`
        UPDATE xg_match_data SET
          home_goals = ${homeGoals},
          away_goals = ${awayGoals},
          home_xg    = ${homeXg},
          away_xg    = ${awayXg},
          is_result  = true,
          source     = 'understat'
        WHERE id = ${m.id}
      `);
      stats.updated++;
    } else if (!existing[0].is_result) {
      // Pre-match xG refresh
      await db.execute(sql`
        UPDATE xg_match_data SET
          home_xg = ${homeXg},
          away_xg = ${awayXg},
          source  = 'understat'
        WHERE id = ${m.id}
      `);
      stats.updated++;
    }
  }

  return stats;
}

async function logComplianceXgIngestion(
  leagueStats: PerLeagueIngestStats[],
  durationMs: number,
): Promise<void> {
  const totalScraped = leagueStats.reduce((s, l) => s + l.scraped, 0);
  const totalMatched = leagueStats.reduce((s, l) => s + l.matched, 0);
  const matchRate = totalScraped > 0 ? totalMatched / totalScraped : 0;

  // Aggregate top unmatched names across leagues for alias-table grooming.
  const unmatchedFreq = new Map<string, number>();
  for (const ls of leagueStats) {
    for (const name of ls.sampleUnmatched) {
      unmatchedFreq.set(name, (unmatchedFreq.get(name) ?? 0) + 1);
    }
  }
  const topUnmatchedTeams = Array.from(unmatchedFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  try {
    await db.insert(complianceLogsTable).values({
      actionType: "xg_ingestion_real",
      details: {
        leagueStats,
        totalScraped,
        totalMatched,
        matchRate: Math.round(matchRate * 10000) / 10000,
        topUnmatchedTeams,
        durationMs,
      },
      timestamp: new Date(),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to write xg_ingestion_real compliance log");
  }
}

export async function runXGIngestion(): Promise<{ inserted: number; updated: number }> {
  const startedAt = Date.now();
  logger.info("xG ingestion starting (REAL Understat scrape)");

  const year = activeUnderstatYear();
  const leagues = Object.keys(LEAGUE_MAP);

  const leagueStats: PerLeagueIngestStats[] = [];
  let totalInserted = 0;
  let totalUpdated = 0;

  // Dedupe identical Understat slugs so we don't double-fetch (LEAGUE_MAP has
  // both display-name and slug keys mapping to the same slug).
  const seenSlugs = new Set<string>();

  for (const league of leagues) {
    const slug = LEAGUE_MAP[league];
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    let scraped: MatchXGData[] = [];
    try {
      scraped = await fetchUnderstatLeagueData(league, year);
    } catch (err) {
      logger.warn({ err, league, year }, "Understat fetch threw — treating as empty result");
      scraped = [];
    }

    logger.info({ league, year, scrapedCount: scraped.length }, "Understat league fetch complete");

    if (scraped.length === 0) {
      leagueStats.push({
        league,
        scraped: 0,
        matched: 0,
        unmatched: 0,
        inserted: 0,
        updated: 0,
        sampleUnmatched: [],
      });
      continue;
    }

    const stats = await ingestLeague(league, scraped);
    leagueStats.push(stats);
    totalInserted += stats.inserted;
    totalUpdated += stats.updated;
  }

  logger.info(
    { totalInserted, totalUpdated, leagueStats },
    "xG match data upsert complete (Understat) — computing rolling stats",
  );

  await computeTeamXGRolling();

  const durationMs = Date.now() - startedAt;
  await logComplianceXgIngestion(leagueStats, durationMs);

  logger.info({ durationMs }, "xG ingestion complete (REAL Understat)");
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
