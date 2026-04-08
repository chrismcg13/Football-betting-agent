import { db, matchesTable, featuresTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getStandings,
  getTeamMatches,
  getHeadToHead,
  type FDMatch,
  type FDStandingEntry,
} from "./footballData";

type StandingsCache = Map<string, FDStandingEntry[]>;

const LEAGUE_CODE_MAP: Record<string, string> = {
  "Premier League": "PL",
  "Bundesliga": "BL1",
  "Primera Division": "PD",
  "Serie A": "SA",
  "Ligue 1": "FL1",
  "Championship": "ELC",
  "Eredivisie": "DED",
  "Primeira Liga": "PPL",
};

function getTeamPosition(
  standings: FDStandingEntry[],
  teamId: number,
): number | null {
  return standings.find((s) => s.team.id === teamId)?.position ?? null;
}

function computeForm(
  matches: FDMatch[],
  teamId: number,
  venue: "home" | "away",
  last = 5,
): number {
  const filtered = matches
    .filter((m) =>
      venue === "home"
        ? m.homeTeam?.id === teamId
        : m.awayTeam?.id === teamId,
    )
    .slice(0, last);

  if (filtered.length === 0) return 0.5;

  const maxPoints = filtered.length * 3;
  let points = 0;

  for (const m of filtered) {
    const isHome = m.homeTeam?.id === teamId;
    const winner = m.score.winner;
    if (winner === "DRAW") points += 1;
    else if (
      (isHome && winner === "HOME_TEAM") ||
      (!isHome && winner === "AWAY_TEAM")
    ) {
      points += 3;
    }
  }
  return points / maxPoints;
}

function computeGoalAverages(
  matches: FDMatch[],
  teamId: number,
  venue: "home" | "away",
  last = 10,
): { scored: number; conceded: number } {
  const filtered = matches
    .filter((m) =>
      venue === "home"
        ? m.homeTeam?.id === teamId
        : m.awayTeam?.id === teamId,
    )
    .slice(0, last);

  if (filtered.length === 0) return { scored: 0, conceded: 0 };

  let scored = 0;
  let conceded = 0;
  let validGames = 0;

  for (const m of filtered) {
    const ft = m.score.fullTime;
    if (ft.home === null || ft.away === null) continue;
    const isHome = m.homeTeam?.id === teamId;
    scored += isHome ? ft.home : ft.away;
    conceded += isHome ? ft.away : ft.home;
    validGames++;
  }

  if (validGames === 0) return { scored: 0, conceded: 0 };
  return { scored: scored / validGames, conceded: conceded / validGames };
}

function computeBttsRate(
  matches: FDMatch[],
  teamId: number,
  venue: "home" | "away",
  last = 10,
): number {
  const filtered = matches
    .filter((m) =>
      venue === "home"
        ? m.homeTeam?.id === teamId
        : m.awayTeam?.id === teamId,
    )
    .slice(0, last);

  if (filtered.length === 0) return 0.5;

  const btts = filtered.filter((m) => {
    const ft = m.score.fullTime;
    return ft.home !== null && ft.away !== null && ft.home > 0 && ft.away > 0;
  }).length;

  return btts / filtered.length;
}

function computeOver25Rate(
  matches: FDMatch[],
  teamId: number,
  venue: "home" | "away",
  last = 10,
): number {
  const filtered = matches
    .filter((m) =>
      venue === "home"
        ? m.homeTeam?.id === teamId
        : m.awayTeam?.id === teamId,
    )
    .slice(0, last);

  if (filtered.length === 0) return 0.5;

  const over = filtered.filter((m) => {
    const ft = m.score.fullTime;
    return ft.home !== null && ft.away !== null && ft.home + ft.away > 2;
  }).length;

  return over / filtered.length;
}

async function upsertFeature(
  matchId: number,
  name: string,
  value: number,
): Promise<void> {
  const rounded = String(Math.round(value * 1_000_000) / 1_000_000);

  const existing = await db
    .select({ id: featuresTable.id })
    .from(featuresTable)
    .where(
      and(
        eq(featuresTable.matchId, matchId),
        eq(featuresTable.featureName, name),
      ),
    )
    .limit(1);

  if (existing.length > 0 && existing[0]) {
    await db
      .update(featuresTable)
      .set({ featureValue: rounded, computedAt: new Date() })
      .where(eq(featuresTable.id, existing[0].id));
  } else {
    await db.insert(featuresTable).values({
      matchId,
      featureName: name,
      featureValue: rounded,
      computedAt: new Date(),
    });
  }
}

async function getStoredTeamId(
  matchId: number,
  featureName: "_home_team_id" | "_away_team_id",
): Promise<number | null> {
  const rows = await db
    .select({ featureValue: featuresTable.featureValue })
    .from(featuresTable)
    .where(
      and(
        eq(featuresTable.matchId, matchId),
        eq(featuresTable.featureName, featureName),
      ),
    )
    .limit(1);

  if (!rows[0]?.featureValue) return null;
  const id = parseInt(rows[0].featureValue, 10);
  return isNaN(id) ? null : id;
}

export async function computeFeaturesForMatch(
  matchId: number,
  homeTeamId: number,
  awayTeamId: number,
  league: string,
  fdMatchId: number,
  standingsCache: StandingsCache,
): Promise<void> {
  logger.info({ matchId, homeTeamId, awayTeamId }, "Computing features");

  const homeMatches = await getTeamMatches(homeTeamId, 20).catch(
    (): FDMatch[] => [],
  );
  const awayMatches = await getTeamMatches(awayTeamId, 20).catch(
    (): FDMatch[] => [],
  );
  const h2h = await getHeadToHead(fdMatchId).catch(() => null);

  const homeForm5 = computeForm(homeMatches, homeTeamId, "home", 5);
  const awayForm5 = computeForm(awayMatches, awayTeamId, "away", 5);

  const homeGoals = computeGoalAverages(homeMatches, homeTeamId, "home", 10);
  const awayGoals = computeGoalAverages(awayMatches, awayTeamId, "away", 10);

  const homeBtts = computeBttsRate(homeMatches, homeTeamId, "home", 10);
  const awayBtts = computeBttsRate(awayMatches, awayTeamId, "away", 10);

  const homeOver25 = computeOver25Rate(homeMatches, homeTeamId, "home", 10);
  const awayOver25 = computeOver25Rate(awayMatches, awayTeamId, "away", 10);

  let h2hHomeWinRate = 0.4;
  if (h2h && h2h.numberOfMatches > 0) {
    h2hHomeWinRate = h2h.homeTeam.wins / h2h.numberOfMatches;
  }

  let leaguePositionDiff = 0;
  const competitionCode = LEAGUE_CODE_MAP[league] ?? null;
  if (competitionCode) {
    if (!standingsCache.has(competitionCode)) {
      const standings = await getStandings(competitionCode);
      standingsCache.set(competitionCode, standings);
    }
    const standings = standingsCache.get(competitionCode)!;
    if (standings.length > 0) {
      const homePos = getTeamPosition(standings, homeTeamId);
      const awayPos = getTeamPosition(standings, awayTeamId);
      if (homePos !== null && awayPos !== null) {
        leaguePositionDiff = (awayPos - homePos) / standings.length;
      }
    }
  }

  const features: Array<[string, number]> = [
    ["home_form_last5", homeForm5],
    ["away_form_last5", awayForm5],
    ["home_goals_scored_avg", homeGoals.scored],
    ["home_goals_conceded_avg", homeGoals.conceded],
    ["away_goals_scored_avg", awayGoals.scored],
    ["away_goals_conceded_avg", awayGoals.conceded],
    ["h2h_home_win_rate", h2hHomeWinRate],
    ["league_position_diff", leaguePositionDiff],
    ["home_btts_rate", homeBtts],
    ["away_btts_rate", awayBtts],
    ["home_over25_rate", homeOver25],
    ["away_over25_rate", awayOver25],
  ];

  for (const [name, value] of features) {
    await upsertFeature(matchId, name, value);
  }

  logger.info({ matchId, featureCount: features.length }, "Features saved");
}

export async function runFeatureEngineForUpcomingMatches(): Promise<{
  processed: number;
  skipped: number;
  failed: number;
}> {
  logger.info("Starting feature computation run for upcoming matches");

  const upcomingMatches = await db
    .select()
    .from(matchesTable)
    .where(eq(matchesTable.status, "scheduled"));

  logger.info(
    { count: upcomingMatches.length },
    "Upcoming matches to process",
  );

  const standingsCache: StandingsCache = new Map();
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const match of upcomingMatches) {
    if (!match.betfairEventId?.startsWith("fd_")) {
      skipped++;
      continue;
    }

    const fdMatchId = parseInt(
      match.betfairEventId.replace("fd_", ""),
      10,
    );
    if (isNaN(fdMatchId)) {
      skipped++;
      continue;
    }

    const homeTeamId = await getStoredTeamId(match.id, "_home_team_id");
    const awayTeamId = await getStoredTeamId(match.id, "_away_team_id");

    if (!homeTeamId || !awayTeamId) {
      logger.debug(
        { matchId: match.id },
        "Team IDs not yet stored — run ingestion first",
      );
      skipped++;
      continue;
    }

    try {
      await computeFeaturesForMatch(
        match.id,
        homeTeamId,
        awayTeamId,
        match.league,
        fdMatchId,
        standingsCache,
      );
      processed++;
    } catch (err) {
      logger.error(
        { err, matchId: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam },
        "Feature computation failed for match",
      );
      failed++;
    }
  }

  logger.info({ processed, skipped, failed }, "Feature computation run complete");
  return { processed, skipped, failed };
}
