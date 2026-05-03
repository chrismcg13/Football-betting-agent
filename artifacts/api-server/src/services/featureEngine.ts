import { db, matchesTable, featuresTable } from "@workspace/db";
import { eq, and, gte, lte, asc, desc, ne, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getStandings,
  getTeamMatches,
  getHeadToHead,
  type FDMatch,
  type FDStandingEntry,
} from "./footballData";
import {
  LEAGUE_IDS,
  fetchStandingsFromApiFootball,
  fetchH2HFromApiFootball,
  getCurrentSeasonForLeague,
  getTeamPositionFromStandings,
} from "./apiFootball";

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

// ─── New: Clean sheet rate ────────────────────────────────────────────────────

function computeCleanSheetRate(
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

  if (filtered.length === 0) return 0;

  const cleanSheets = filtered.filter((m) => {
    const ft = m.score.fullTime;
    if (ft.home === null || ft.away === null) return false;
    const isHome = m.homeTeam?.id === teamId;
    const conceded = isHome ? ft.away : ft.home;
    return conceded === 0;
  }).length;

  return cleanSheets / filtered.length;
}

// ─── New: Points trajectory (slope over last 10 games) ───────────────────────

function computePointsTrajectory(
  matches: FDMatch[],
  teamId: number,
  last = 10,
): number {
  const allMatches = matches
    .filter((m) => m.homeTeam?.id === teamId || m.awayTeam?.id === teamId)
    .slice(0, last);

  if (allMatches.length < 3) return 0;

  // Calculate points per match and fit linear trend
  const points: number[] = allMatches.reverse().map((m) => {
    const isHome = m.homeTeam?.id === teamId;
    const winner = m.score.winner;
    if (winner === "DRAW") return 1;
    if ((isHome && winner === "HOME_TEAM") || (!isHome && winner === "AWAY_TEAM")) return 3;
    return 0;
  });

  // Simple linear regression slope
  const n = points.length;
  const xMean = (n - 1) / 2;
  const yMean = points.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * ((points[i] ?? 0) - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// ─── New: Days since last match (fatigue proxy) ───────────────────────────────

function computeDaysSinceLastMatch(
  matches: FDMatch[],
  teamId: number,
): number {
  const played = matches
    .filter(
      (m) =>
        (m.homeTeam?.id === teamId || m.awayTeam?.id === teamId) &&
        m.score.winner !== null,
    )
    .slice(0, 1);

  if (played.length === 0) return 7; // default neutral

  const lastDate = new Date(played[0]!.utcDate);
  const now = new Date();
  const diffMs = now.getTime() - lastDate.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

// ─── New: xG proxy from goal conversion rates ─────────────────────────────────

function computeXgProxy(
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

  if (filtered.length === 0) return 1.2; // league average fallback

  let totalGoals = 0;
  let validGames = 0;
  for (const m of filtered) {
    const ft = m.score.fullTime;
    if (ft.home === null || ft.away === null) continue;
    const isHome = m.homeTeam?.id === teamId;
    totalGoals += isHome ? ft.home : ft.away;
    validGames++;
  }
  if (validGames === 0) return 1.2;
  // Smooth toward league average (1.4 goals)
  const rawAvg = totalGoals / validGames;
  return 0.7 * rawAvg + 0.3 * 1.4;
}

// ─── Upsert feature ───────────────────────────────────────────────────────────

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

async function getStoredAfTeamId(
  matchId: number,
  featureName: "_af_home_team_id" | "_af_away_team_id",
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

  // ─── Classic features ─────────────────────────────────
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

  // ─── New features ─────────────────────────────────────
  const homeCleanSheets = computeCleanSheetRate(homeMatches, homeTeamId, "home", 5);
  const awayCleanSheets = computeCleanSheetRate(awayMatches, awayTeamId, "away", 5);

  const homePointsTraj = computePointsTrajectory(homeMatches, homeTeamId, 10);
  const awayPointsTraj = computePointsTrajectory(awayMatches, awayTeamId, 10);

  const homeDaysSince = computeDaysSinceLastMatch(homeMatches, homeTeamId);
  const awayDaysSince = computeDaysSinceLastMatch(awayMatches, awayTeamId);

  const homeXg = computeXgProxy(homeMatches, homeTeamId, "home", 10);
  const awayXg = computeXgProxy(awayMatches, awayTeamId, "away", 10);
  const xgDiff = homeXg - awayXg;

  // ─── Read any API-Football enriched features already stored ─────────────────
  const storedFeatures = await db
    .select({ featureName: featuresTable.featureName, featureValue: featuresTable.featureValue })
    .from(featuresTable)
    .where(eq(featuresTable.matchId, matchId));

  const stored: Record<string, number> = {};
  for (const f of storedFeatures) {
    stored[f.featureName] = Number(f.featureValue);
  }

  // ─── Derived features using AF team stats if available ───────────────────────
  const homeYellowCards = stored["home_yellow_cards_avg"] ?? 1.8;
  const awayYellowCards = stored["away_yellow_cards_avg"] ?? 1.6;
  const combinedCardsPrediction = homeYellowCards + awayYellowCards;

  // Shots proxy: ~5 shots per goal (league average conversion ≈ 20%)
  const homeShotsOnTargetAvg = stored["home_shots_on_target_avg"] ?? (homeXg * 5);
  const awayShotsOnTargetAvg = stored["away_shots_on_target_avg"] ?? (awayXg * 5);
  const homeConversionRate = homeShotsOnTargetAvg > 0 ? homeGoals.scored / homeShotsOnTargetAvg : 0.2;
  const awayConversionRate = awayShotsOnTargetAvg > 0 ? awayGoals.scored / awayShotsOnTargetAvg : 0.2;

  // Corners proxy: ~3.5 corners per xG unit (attacking volume → corners)
  const homeCornersAvg = stored["home_corners_avg"] ?? Math.round(homeXg * 3.5 * 10) / 10;
  const awayCornersAvg = stored["away_corners_avg"] ?? Math.round(awayXg * 3.0 * 10) / 10;
  const combinedCornersPrediction = homeCornersAvg + awayCornersAvg;

  // Goal momentum (last3 vs last10 ratio) — use form+trajectory as proxy
  const homeGoalMomentum = 0.5 + homePointsTraj * 2; // rising trajectory → > 0.5
  const awayGoalMomentum = 0.5 + awayPointsTraj * 2;

  const features: Array<[string, number]> = [
    // Classic
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
    // Extended
    ["home_clean_sheet_rate", homeCleanSheets],
    ["away_clean_sheet_rate", awayCleanSheets],
    ["home_points_trajectory", homePointsTraj],
    ["away_points_trajectory", awayPointsTraj],
    ["home_days_since_last_match", homeDaysSince],
    ["away_days_since_last_match", awayDaysSince],
    ["home_xg_proxy", homeXg],
    ["away_xg_proxy", awayXg],
    ["xg_diff", xgDiff],
    // API-Football enriched (or proxied defaults)
    ["home_yellow_cards_avg", homeYellowCards],
    ["away_yellow_cards_avg", awayYellowCards],
    ["combined_cards_prediction", combinedCardsPrediction],
    ["home_shots_on_target_avg", homeShotsOnTargetAvg],
    ["away_shots_on_target_avg", awayShotsOnTargetAvg],
    ["home_shot_conversion_rate", Math.min(homeConversionRate, 1)],
    ["away_shot_conversion_rate", Math.min(awayConversionRate, 1)],
    ["home_corners_avg", homeCornersAvg],
    ["away_corners_avg", awayCornersAvg],
    ["combined_corners_prediction", combinedCornersPrediction],
    ["home_goals_last3_vs_last10", Math.max(0, homeGoalMomentum)],
    ["away_goals_last3_vs_last10", Math.max(0, awayGoalMomentum)],
  ];

  for (const [name, value] of features) {
    await upsertFeature(matchId, name, value);
  }

  logger.info({ matchId, featureCount: features.length }, "Features saved");
}

async function getDbTeamMatches(teamName: string, limit: number): Promise<FDMatch[]> {
  const rows = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "finished"),
        or(
          eq(matchesTable.homeTeam, teamName),
          eq(matchesTable.awayTeam, teamName),
        ),
      ),
    )
    .orderBy(desc(matchesTable.kickoffTime))
    .limit(limit);

  return rows.map((r) => ({
    utcDate: r.kickoffTime.toISOString(),
    homeTeam: { id: r.homeTeam === teamName ? 1 : 2, name: r.homeTeam },
    awayTeam: { id: r.awayTeam === teamName ? 2 : 1, name: r.awayTeam },
    score: {
      winner:
        r.homeScore === null || r.awayScore === null
          ? null
          : r.homeScore > r.awayScore
            ? "HOME_TEAM"
            : r.homeScore < r.awayScore
              ? "AWAY_TEAM"
              : "DRAW",
      fullTime: { home: r.homeScore, away: r.awayScore },
    },
  })) as FDMatch[];
}

async function computeFeaturesFromDb(
  matchId: number,
  homeTeam: string,
  awayTeam: string,
  league: string,
): Promise<void> {
  logger.info({ matchId, homeTeam, awayTeam }, "Computing features from DB history + AF stats");

  const homeTeamId = 1;
  const awayTeamId = 2;

  const homeMatches = await getDbTeamMatches(homeTeam, 20);
  const awayMatches = await getDbTeamMatches(awayTeam, 20);

  const storedFeatures = await db
    .select({ featureName: featuresTable.featureName, featureValue: featuresTable.featureValue })
    .from(featuresTable)
    .where(eq(featuresTable.matchId, matchId));

  const stored: Record<string, number> = {};
  for (const f of storedFeatures) {
    stored[f.featureName] = Number(f.featureValue);
  }

  const homeHistCount = homeMatches.filter(m => m.homeTeam?.id === homeTeamId).length;
  const awayHistCount = awayMatches.filter(m => m.awayTeam?.id === awayTeamId).length;
  const hasDbHistory = homeHistCount >= 3 && awayHistCount >= 3;

  const homeFormDb = computeForm(homeMatches, homeTeamId, "home", 5);
  const awayFormDb = computeForm(awayMatches, awayTeamId, "away", 5);
  const homeGoalsDb = computeGoalAverages(homeMatches, homeTeamId, "home", 10);
  const awayGoalsDb = computeGoalAverages(awayMatches, awayTeamId, "away", 10);

  const homeAfGoalsFor = stored["home_af_goals_scored_avg"];
  const homeAfGoalsAgainst = stored["home_af_goals_conceded_avg"];
  const awayAfGoalsFor = stored["away_af_goals_scored_avg"];
  const awayAfGoalsAgainst = stored["away_af_goals_conceded_avg"];
  const homeAfForm = stored["home_af_form_last10"];
  const awayAfForm = stored["away_af_form_last10"];

  const homeForm5 = hasDbHistory ? homeFormDb : (homeAfForm ?? 0.5);
  const awayForm5 = hasDbHistory ? awayFormDb : (awayAfForm ?? 0.5);
  const homeGoalsScored = hasDbHistory ? homeGoalsDb.scored : (homeAfGoalsFor ?? 1.3);
  const homeGoalsConceded = hasDbHistory ? homeGoalsDb.conceded : (homeAfGoalsAgainst ?? 1.1);
  const awayGoalsScored = hasDbHistory ? awayGoalsDb.scored : (awayAfGoalsFor ?? 1.0);
  const awayGoalsConceded = hasDbHistory ? awayGoalsDb.conceded : (awayAfGoalsAgainst ?? 1.3);

  const totalGoalsAvg = homeGoalsScored + awayGoalsScored;

  const homeBttsDb = computeBttsRate(homeMatches, homeTeamId, "home", 10);
  const awayBttsDb = computeBttsRate(awayMatches, awayTeamId, "away", 10);
  const homeBtts = hasDbHistory ? homeBttsDb :
    (homeGoalsScored > 0 && homeGoalsConceded > 0 ? Math.min(0.85, (homeGoalsScored * homeGoalsConceded) / 2.5) : 0.5);
  const awayBtts = hasDbHistory ? awayBttsDb :
    (awayGoalsScored > 0 && awayGoalsConceded > 0 ? Math.min(0.85, (awayGoalsScored * awayGoalsConceded) / 2.5) : 0.5);

  const homeOver25Db = computeOver25Rate(homeMatches, homeTeamId, "home", 10);
  const awayOver25Db = computeOver25Rate(awayMatches, awayTeamId, "away", 10);
  const homeOver25 = hasDbHistory ? homeOver25Db :
    Math.min(0.9, Math.max(0.1, (totalGoalsAvg - 2.0) * 0.35 + 0.5));
  const awayOver25 = hasDbHistory ? awayOver25Db :
    Math.min(0.9, Math.max(0.1, (totalGoalsAvg - 2.0) * 0.35 + 0.5));

  // ─── h2h_home_win_rate via API-Football /fixtures/headtohead ─────────────────
  // Fallback 0.4 (slight home advantage prior) if either team's API-Football ID
  // isn't stored, the league isn't in our LEAGUE_IDS map, or the call returns null.
  const homeAfId = await getStoredAfTeamId(matchId, "_af_home_team_id");
  const awayAfId = await getStoredAfTeamId(matchId, "_af_away_team_id");
  let h2hHomeWinRate = 0.4;
  if (homeAfId && awayAfId) {
    try {
      const h2h = await fetchH2HFromApiFootball(homeAfId, awayAfId, 20);
      if (h2h && h2h.numberOfMatches > 0) {
        h2hHomeWinRate = h2h.homeWins / h2h.numberOfMatches;
      }
    } catch (err) {
      logger.warn({ err, matchId, homeAfId, awayAfId }, "H2H lookup failed — using neutral fallback");
    }
  }

  const homeCleanSheets = hasDbHistory ? computeCleanSheetRate(homeMatches, homeTeamId, "home", 5) :
    Math.max(0.05, 1 - (awayGoalsScored / 1.5));
  const awayCleanSheets = hasDbHistory ? computeCleanSheetRate(awayMatches, awayTeamId, "away", 5) :
    Math.max(0.05, 1 - (homeGoalsScored / 1.5));

  const homePointsTraj = computePointsTrajectory(homeMatches, homeTeamId, 10);
  const awayPointsTraj = computePointsTrajectory(awayMatches, awayTeamId, 10);

  const homeDaysSince = computeDaysSinceLastMatch(homeMatches, homeTeamId);
  const awayDaysSince = computeDaysSinceLastMatch(awayMatches, awayTeamId);

  const homeXgDb = computeXgProxy(homeMatches, homeTeamId, "home", 10);
  const awayXgDb = computeXgProxy(awayMatches, awayTeamId, "away", 10);
  const homeXg = hasDbHistory ? homeXgDb : homeGoalsScored;
  const awayXg = hasDbHistory ? awayXgDb : awayGoalsScored;
  const xgDiff = homeXg - awayXg;

  const homeYellowCards = stored["home_yellow_cards_avg"] ?? 1.8;
  const awayYellowCards = stored["away_yellow_cards_avg"] ?? 1.6;
  const combinedCardsPrediction = homeYellowCards + awayYellowCards;
  const homeShotsOnTargetAvg = stored["home_shots_on_target_avg"] ?? (homeXg * 5);
  const awayShotsOnTargetAvg = stored["away_shots_on_target_avg"] ?? (awayXg * 5);
  const homeConversionRate = homeShotsOnTargetAvg > 0 ? homeGoalsScored / homeShotsOnTargetAvg : 0.2;
  const awayConversionRate = awayShotsOnTargetAvg > 0 ? awayGoalsScored / awayShotsOnTargetAvg : 0.2;
  const homeCornersAvg = stored["home_corners_avg"] ?? Math.round(homeXg * 3.5 * 10) / 10;
  const awayCornersAvg = stored["away_corners_avg"] ?? Math.round(awayXg * 3.0 * 10) / 10;
  const combinedCornersPrediction = homeCornersAvg + awayCornersAvg;
  const homeGoalMomentum = 0.5 + homePointsTraj * 2;
  const awayGoalMomentum = 0.5 + awayPointsTraj * 2;

  // ─── league_position_diff via API-Football /standings ────────────────────────
  // Fallback 0 (treat as equal-position) if league isn't in LEAGUE_IDS map,
  // either team's API-Football ID isn't stored, or standings call returns empty.
  let leaguePositionDiff = 0;
  const apiLeagueId = LEAGUE_IDS[league];
  if (apiLeagueId && homeAfId && awayAfId) {
    try {
      const season = getCurrentSeasonForLeague(apiLeagueId);
      const standings = await fetchStandingsFromApiFootball(apiLeagueId, season);
      if (standings.length > 0) {
        const homePos = getTeamPositionFromStandings(standings, homeAfId);
        const awayPos = getTeamPositionFromStandings(standings, awayAfId);
        if (homePos !== null && awayPos !== null) {
          leaguePositionDiff = (awayPos - homePos) / standings.length;
        }
      }
    } catch (err) {
      logger.warn({ err, matchId, apiLeagueId }, "Standings lookup failed — using neutral fallback");
    }
  }

  const features: Array<[string, number]> = [
    ["home_form_last5", homeForm5],
    ["away_form_last5", awayForm5],
    ["home_goals_scored_avg", homeGoalsScored],
    ["home_goals_conceded_avg", homeGoalsConceded],
    ["away_goals_scored_avg", awayGoalsScored],
    ["away_goals_conceded_avg", awayGoalsConceded],
    ["h2h_home_win_rate", h2hHomeWinRate],
    ["league_position_diff", leaguePositionDiff],
    ["home_btts_rate", homeBtts],
    ["away_btts_rate", awayBtts],
    ["home_over25_rate", homeOver25],
    ["away_over25_rate", awayOver25],
    ["home_clean_sheet_rate", homeCleanSheets],
    ["away_clean_sheet_rate", awayCleanSheets],
    ["home_points_trajectory", homePointsTraj],
    ["away_points_trajectory", awayPointsTraj],
    ["home_days_since_last_match", homeDaysSince],
    ["away_days_since_last_match", awayDaysSince],
    ["home_xg_proxy", homeXg],
    ["away_xg_proxy", awayXg],
    ["xg_diff", xgDiff],
    ["home_yellow_cards_avg", homeYellowCards],
    ["away_yellow_cards_avg", awayYellowCards],
    ["combined_cards_prediction", combinedCardsPrediction],
    ["home_shots_on_target_avg", homeShotsOnTargetAvg],
    ["away_shots_on_target_avg", awayShotsOnTargetAvg],
    ["home_shot_conversion_rate", Math.min(homeConversionRate, 1)],
    ["away_shot_conversion_rate", Math.min(awayConversionRate, 1)],
    ["home_corners_avg", homeCornersAvg],
    ["away_corners_avg", awayCornersAvg],
    ["combined_corners_prediction", combinedCornersPrediction],
    ["home_goals_last3_vs_last10", Math.max(0, homeGoalMomentum)],
    ["away_goals_last3_vs_last10", Math.max(0, awayGoalMomentum)],
  ];

  for (const [name, value] of features) {
    await upsertFeature(matchId, name, value);
  }

  logger.info(
    { matchId, featureCount: features.length, hasDbHistory, homeHistCount, awayHistCount,
      usedAfStats: !hasDbHistory && (homeAfGoalsFor !== undefined || awayAfGoalsFor !== undefined) },
    "Features saved (DB-backed + AF enriched)",
  );
}

// Tunables for feature computation throughput.
// Goal: complete a feature run in <10 min so trading cycles can fire.
const FEATURE_RUN_BUDGET_MS = 20 * 60 * 1000;          // Fix D: hard wall-clock cap
const FEATURE_MAX_HOURS_AHEAD = 72;                    // Fix B: skip far-future matches
const FEATURE_FRESHNESS_MS = 2 * 60 * 60 * 1000;       // Fix B: 2h staleness window
const FEATURE_CONCURRENCY = 8;                         // Fix C-light: bounded parallelism

async function processOneMatch(
  match: typeof matchesTable.$inferSelect,
  standingsCache: StandingsCache,
): Promise<"processed" | "skipped" | "failed"> {
  if (match.betfairEventId?.startsWith("af_")) {
    try {
      await computeFeaturesFromDb(match.id, match.homeTeam, match.awayTeam, match.league);
      return "processed";
    } catch (err) {
      logger.error({ err, matchId: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam },
        "Feature computation (DB-backed) failed for match");
      return "failed";
    }
  }
  if (match.betfairEventId?.startsWith("fd_")) {
    const fdMatchId = parseInt(match.betfairEventId.replace("fd_", ""), 10);
    if (isNaN(fdMatchId)) return "skipped";

    const homeTeamId = await getStoredTeamId(match.id, "_home_team_id");
    const awayTeamId = await getStoredTeamId(match.id, "_away_team_id");

    if (!homeTeamId || !awayTeamId) {
      try {
        await computeFeaturesFromDb(match.id, match.homeTeam, match.awayTeam, match.league);
        return "processed";
      } catch (err) {
        logger.error({ err, matchId: match.id }, "Feature computation (DB fallback for fd_) failed");
        return "failed";
      }
    }
    try {
      await computeFeaturesForMatch(match.id, homeTeamId, awayTeamId, match.league, fdMatchId, standingsCache);
      return "processed";
    } catch (err) {
      logger.error({ err, matchId: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam },
        "Feature computation failed for match");
      return "failed";
    }
  }
  try {
    await computeFeaturesFromDb(match.id, match.homeTeam, match.awayTeam, match.league);
    return "processed";
  } catch {
    return "skipped";
  }
}

export async function runFeatureEngineForUpcomingMatches(force = false): Promise<{
  processed: number;
  skipped: number;
  failed: number;
  timedOut?: boolean;
  remaining?: number;
  durationMs: number;
}> {
  const startedAt = Date.now();
  logger.info({ force, budgetMs: FEATURE_RUN_BUDGET_MS, maxHoursAhead: FEATURE_MAX_HOURS_AHEAD,
    freshnessMs: FEATURE_FRESHNESS_MS, concurrency: FEATURE_CONCURRENCY },
    "Starting feature computation run for upcoming matches");

  const now = new Date();
  const horizon = new Date(now.getTime() + FEATURE_MAX_HOURS_AHEAD * 60 * 60 * 1000);

  // Fix B: only matches kicking off in [now, now+72h], ordered by kickoff (most imminent first)
  const upcomingMatches = await db
    .select()
    .from(matchesTable)
    .where(and(
      eq(matchesTable.status, "scheduled"),
      gte(matchesTable.kickoffTime, now),
      lte(matchesTable.kickoffTime, horizon),
    ))
    .orderBy(asc(matchesTable.kickoffTime));

  logger.info({ count: upcomingMatches.length, windowHours: FEATURE_MAX_HOURS_AHEAD },
    "Upcoming matches to process (filtered by kickoff window)");

  // Fix B: bulk freshness check — one query instead of N
  let toProcess = upcomingMatches;
  let preSkipped = 0;
  if (!force && upcomingMatches.length > 0) {
    const freshCutoff = new Date(Date.now() - FEATURE_FRESHNESS_MS);
    const freshRows = await db
      .select({ matchId: featuresTable.matchId })
      .from(featuresTable)
      .where(and(
        eq(featuresTable.featureName, "home_form_last5"),
        gte(featuresTable.computedAt, freshCutoff),
      ));
    const freshSet = new Set(freshRows.map((r) => r.matchId));
    toProcess = upcomingMatches.filter((m) => !freshSet.has(m.id));
    preSkipped = upcomingMatches.length - toProcess.length;
    logger.info({ totalCandidates: upcomingMatches.length, alreadyFresh: preSkipped, toProcess: toProcess.length },
      "Freshness filter applied");
  }

  const standingsCache: StandingsCache = new Map();
  let processed = 0;
  let skipped = preSkipped;
  let failed = 0;
  let cursor = 0;
  let timedOut = false;

  // Fix C-light + Fix D: bounded concurrency with wall-clock budget
  async function worker() {
    while (true) {
      if (Date.now() - startedAt > FEATURE_RUN_BUDGET_MS) { timedOut = true; return; }
      const idx = cursor++;
      if (idx >= toProcess.length) return;
      const match = toProcess[idx]!;
      const outcome = await processOneMatch(match, standingsCache);
      if (outcome === "processed") processed++;
      else if (outcome === "skipped") skipped++;
      else failed++;
    }
  }
  await Promise.all(Array.from({ length: FEATURE_CONCURRENCY }, () => worker()));

  const durationMs = Date.now() - startedAt;
  const remaining = Math.max(0, toProcess.length - cursor);
  logger.info(
    { processed, skipped, failed, timedOut, remaining, durationMs,
      ratePerMin: durationMs > 0 ? Math.round((processed / durationMs) * 60_000) : 0 },
    "Feature computation run complete",
  );
  return { processed, skipped, failed, timedOut, remaining, durationMs };
}
