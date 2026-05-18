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

// ─── Sub-phase 7.6: Fixture density (congestion proxy) ──────────────────────
// Counts completed fixtures per team in the last N days. Pairs with
// computeDaysSinceLastMatch (single-fixture gap) to capture the
// "team played 4 in 14d vs team played 2 in 14d" distinction. Both
// signals together describe load — recency AND volume.

function computeFixturesInLastDays(
  matches: FDMatch[],
  teamId: number,
  days: number,
): number {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  return matches.filter(
    (m) =>
      (m.homeTeam?.id === teamId || m.awayTeam?.id === teamId) &&
      m.score.winner !== null &&
      new Date(m.utcDate).getTime() >= cutoffMs,
  ).length;
}

// ─── Sub-phase 7.6: Lineup-publish-timing ────────────────────────────────────
// Reads the _lineup_data feature row's computed_at (written by
// capturePreKickoffLineups in apiFootball.ts when the lineup first appears)
// and returns minutes pre-kickoff. Returns null if the lineup hasn't been
// captured yet for this match — caller should skip the upsert in that case
// (the feature simply won't exist for that match's row set, which the
// retrospective will treat as "absent" rather than zero).

async function computeLineupPublishMinsPreKickoff(matchId: number): Promise<number | null> {
  const lineupRows = await db
    .select({ computedAt: featuresTable.computedAt })
    .from(featuresTable)
    .where(
      and(
        eq(featuresTable.matchId, matchId),
        eq(featuresTable.featureName, "_lineup_data"),
      ),
    )
    .limit(1);
  if (lineupRows.length === 0 || !lineupRows[0]?.computedAt) return null;

  const matchRows = await db
    .select({ kickoffTime: matchesTable.kickoffTime })
    .from(matchesTable)
    .where(eq(matchesTable.id, matchId))
    .limit(1);
  if (matchRows.length === 0 || !matchRows[0]?.kickoffTime) return null;

  const kickoffMs = new Date(matchRows[0].kickoffTime).getTime();
  const publishedMs = new Date(lineupRows[0].computedAt).getTime();
  const minsPreKickoff = (kickoffMs - publishedMs) / 60_000;
  return Math.round(minsPreKickoff * 100) / 100;
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

  // ─── Task 15 (Phase 4a.2) — ClubElo shadow features ──────────────────
  // Looks up home/away team Elo ratings via fuzzy resolver. Stored as
  // shadow features (NOT yet in FEATURE_NAMES / model input). Used by
  // a follow-up PR once we verify the resolver hit rate is acceptable
  // by inspecting home_clubelo / away_clubelo distributions in features.
  let homeClubElo: number | null = null;
  let awayClubElo: number | null = null;
  try {
    const matchRow = await db
      .select({
        homeTeam: matchesTable.homeTeam,
        awayTeam: matchesTable.awayTeam,
        country: matchesTable.country,
      })
      .from(matchesTable)
      .where(eq(matchesTable.id, matchId))
      .limit(1);
    if (matchRow.length > 0 && matchRow[0]) {
      const { getClubEloForTeam } = await import("./clubEloLookup");
      const homeRes = await getClubEloForTeam(matchRow[0].homeTeam);
      const awayRes = await getClubEloForTeam(matchRow[0].awayTeam);
      homeClubElo = homeRes.elo;
      awayClubElo = awayRes.elo;
    }
  } catch (err) {
    logger.debug({ err, matchId }, "ClubElo feature lookup failed (non-fatal)");
  }

  // Sub-phase 7.6: fixture density (last 14 days) + congestion diff.
  const homeFixtures14d = computeFixturesInLastDays(homeMatches, homeTeamId, 14);
  const awayFixtures14d = computeFixturesInLastDays(awayMatches, awayTeamId, 14);
  const fixturesCongestionDiff = homeFixtures14d - awayFixtures14d;

  // Sub-phase 7.6: lineup-publish timing. May be null if lineup not yet
  // captured (capturePreKickoffLineups runs every 15min in 30-90min pre-
  // kickoff window — feature-engine cycles before that won't see it).
  const lineupPublishMins = await computeLineupPublishMinsPreKickoff(matchId);

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
    // Sub-phase 7.6: fixture density (last 14 days)
    ["home_fixtures_in_last_14d", homeFixtures14d],
    ["away_fixtures_in_last_14d", awayFixtures14d],
    ["fixtures_congestion_diff", fixturesCongestionDiff],
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

  // Task 15 shadow features — persist alongside the main set. Skipped
  // when the resolver returns null (team not yet known to ClubElo).
  if (homeClubElo != null) await upsertFeature(matchId, "home_clubelo", homeClubElo);
  if (awayClubElo != null) await upsertFeature(matchId, "away_clubelo", awayClubElo);
  if (homeClubElo != null && awayClubElo != null) {
    await upsertFeature(matchId, "elo_diff", homeClubElo - awayClubElo);
  }

  // ── Bundle 7.F (2026-05-17): §G feature wire-in (HIGH + 5-game form) ────
  // Each feature has a safe neutral default so missing source data
  // doesn't penalise unfamiliar fixtures. Model retrains automatically
  // on next bootstrap via the featureMeans-length-mismatch guard in
  // predictionEngine.loadLatestModel.
  try {
    if (Number.isFinite(homeForm5) && Number.isFinite(awayForm5)) {
      await upsertFeature(matchId, "form_diff_5game", homeForm5 - awayForm5);
    } else {
      await upsertFeature(matchId, "form_diff_5game", 0);
    }
  } catch (err) {
    logger.debug({ err, matchId }, "form_diff_5game upsert failed");
  }
  try {
    const lineupSizes = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM team_expected_xi WHERE team_name = ${homeTeam})::int AS home_size,
        (SELECT COUNT(*) FROM team_expected_xi WHERE team_name = ${awayTeam})::int AS away_size
    `);
    const lr = ((lineupSizes as any).rows ?? [])[0] as { home_size: number; away_size: number } | undefined;
    await upsertFeature(matchId, "home_lineup_xi_size", lr?.home_size ?? 11);
    await upsertFeature(matchId, "away_lineup_xi_size", lr?.away_size ?? 11);
  } catch (err) {
    logger.debug({ err, matchId }, "lineup_xi_size upsert failed — defaulting to 11");
    await upsertFeature(matchId, "home_lineup_xi_size", 11);
    await upsertFeature(matchId, "away_lineup_xi_size", 11);
  }
  try {
    const inj = await db.execute(sql`
      WITH fx AS (
        SELECT api_fixture_id, home_team, away_team
        FROM matches WHERE id = ${matchId}
      )
      SELECT
        COALESCE(SUM(CASE WHEN ir.team_name = (SELECT home_team FROM fx) THEN 1 ELSE 0 END), 0)::int AS home_count,
        COALESCE(SUM(CASE WHEN ir.team_name = (SELECT away_team FROM fx) THEN 1 ELSE 0 END), 0)::int AS away_count
      FROM injury_reports ir
      WHERE ir.api_fixture_id = (SELECT api_fixture_id FROM fx)
    `);
    const ir = ((inj as any).rows ?? [])[0] as { home_count: number; away_count: number } | undefined;
    await upsertFeature(matchId, "home_injuries_count", ir?.home_count ?? 0);
    await upsertFeature(matchId, "away_injuries_count", ir?.away_count ?? 0);
  } catch (err) {
    logger.debug({ err, matchId }, "injuries_count upsert failed — defaulting to 0");
    await upsertFeature(matchId, "home_injuries_count", 0);
    await upsertFeature(matchId, "away_injuries_count", 0);
  }

  // ── Bundle FP1 (2026-05-18): xG features from team_xg_rolling ────────
  // 56k+ rows of rolling 5-match xG-for, xG-against per team. Single
  // highest-value unused predictor. Missing → impute at 1.3 league-avg
  // so featureless fixtures don't get a structural penalty. Model
  // retrains automatically on next bootstrap via featureMeans-length
  // mismatch guard.
  try {
    const xgRows = await db.execute(sql`
      WITH fx AS (
        SELECT home_team, away_team FROM matches WHERE id = ${matchId}
      )
      SELECT
        (SELECT xg_for_5::float8 FROM team_xg_rolling
         WHERE team_name = (SELECT home_team FROM fx)
         ORDER BY computed_at DESC LIMIT 1) AS home_xg_for,
        (SELECT xg_against_5::float8 FROM team_xg_rolling
         WHERE team_name = (SELECT home_team FROM fx)
         ORDER BY computed_at DESC LIMIT 1) AS home_xg_against,
        (SELECT xg_for_5::float8 FROM team_xg_rolling
         WHERE team_name = (SELECT away_team FROM fx)
         ORDER BY computed_at DESC LIMIT 1) AS away_xg_for,
        (SELECT xg_against_5::float8 FROM team_xg_rolling
         WHERE team_name = (SELECT away_team FROM fx)
         ORDER BY computed_at DESC LIMIT 1) AS away_xg_against
    `);
    const xg = ((xgRows as any).rows ?? [])[0] as
      | { home_xg_for: number | null; home_xg_against: number | null; away_xg_for: number | null; away_xg_against: number | null }
      | undefined;
    const homeFor = xg?.home_xg_for != null && Number.isFinite(xg.home_xg_for) ? xg.home_xg_for : 1.3;
    const homeAgainst = xg?.home_xg_against != null && Number.isFinite(xg.home_xg_against) ? xg.home_xg_against : 1.3;
    const awayFor = xg?.away_xg_for != null && Number.isFinite(xg.away_xg_for) ? xg.away_xg_for : 1.3;
    const awayAgainst = xg?.away_xg_against != null && Number.isFinite(xg.away_xg_against) ? xg.away_xg_against : 1.3;
    await upsertFeature(matchId, "home_xg_for_avg", homeFor);
    await upsertFeature(matchId, "home_xg_against_avg", homeAgainst);
    await upsertFeature(matchId, "away_xg_for_avg", awayFor);
    await upsertFeature(matchId, "away_xg_against_avg", awayAgainst);
    await upsertFeature(matchId, "xg_diff", (homeFor - homeAgainst) - (awayFor - awayAgainst));
  } catch (err) {
    logger.debug({ err, matchId }, "Bundle FP1 xG features upsert failed — defaulting");
    await upsertFeature(matchId, "home_xg_for_avg", 1.3);
    await upsertFeature(matchId, "home_xg_against_avg", 1.3);
    await upsertFeature(matchId, "away_xg_for_avg", 1.3);
    await upsertFeature(matchId, "away_xg_against_avg", 1.3);
    await upsertFeature(matchId, "xg_diff", 0);
  }

  // Sub-phase 7.6: conditional lineup-publish-timing (only if captured).
  if (lineupPublishMins !== null) {
    await upsertFeature(matchId, "lineup_publish_mins_pre_kickoff", lineupPublishMins);
  }

  // 2026-05-08: referee tendency features (X2 ingestion → featureEngine).
  // match_referees table populates daily (06:45 UTC) with referee_name per
  // fixture. Compute that referee's historical avg total_cards from past
  // matches.total_cards. Wired here as features for downstream prediction
  // models to use; predictCards extension uses these directly. Cold-start:
  // referee_match_count tracks confidence. Bayesian shrink toward league
  // avg (~4.2) when sample size small.
  try {
    const refereeRow = await db.execute(sql`
      SELECT mr.referee_name,
             COUNT(m2.id) AS n,
             AVG(m2.total_cards::numeric) AS avg_cards
      FROM match_referees mr
      LEFT JOIN match_referees mr2 ON mr2.referee_name = mr.referee_name AND mr2.match_id != mr.match_id
      LEFT JOIN matches m2 ON m2.id = mr2.match_id AND m2.total_cards IS NOT NULL AND m2.status = 'finished'
      WHERE mr.match_id = ${matchId}
      GROUP BY mr.referee_name
    `);
    const refRow = (((refereeRow as any).rows ?? []) as Array<{
      referee_name: string; n: number | string; avg_cards: number | string | null;
    }>)[0];
    if (refRow && refRow.referee_name) {
      const n = Number(refRow.n ?? 0);
      const avgCards = refRow.avg_cards != null ? Number(refRow.avg_cards) : null;
      if (avgCards != null) {
        // Bayesian shrink: blend toward league average 4.2 with prior n0=10.
        // Effective ref n=20 → ~67% ref, 33% league. n=5 → 33% ref, 67% league.
        const shrunk = (avgCards * n + 4.2 * 10) / (n + 10);
        await upsertFeature(matchId, "referee_card_avg", shrunk);
      }
      await upsertFeature(matchId, "referee_match_count", n);
    }
  } catch (refErr) {
    logger.debug({ err: refErr, matchId }, "Referee feature computation skipped (non-fatal)");
  }

  // C3-lineup-features (2026-05-07): key_player_missing_count per side.
  // Compares actual startXI (from _lineup_data) against the team's top-11
  // expected starters in team_expected_xi. Returns null until we have
  // ≥3 captured lineups for a team (cold-start handling). Stored only —
  // not yet in FEATURE_NAMES; future retrain incorporates as predictor.
  try {
    const lineupRow = await db
      .select({ value: featuresTable.featureValue })
      .from(featuresTable)
      .where(
        and(
          eq(featuresTable.matchId, matchId),
          eq(featuresTable.featureName, "_lineup_data"),
        ),
      )
      .limit(1);

    if (lineupRow.length > 0 && lineupRow[0]?.value) {
      const parsed = JSON.parse(lineupRow[0].value);
      const lineups = parsed?.lineups ?? [];
      // Match lineups to home/away by team name (lineup blob has 'team' field).
      const homeLineupRaw = lineups.find((l: any) => l.team === homeTeam);
      const awayLineupRaw = lineups.find((l: any) => l.team === awayTeam);

      for (const [side, teamName, lineup] of [
        ["home", homeTeam, homeLineupRaw],
        ["away", awayTeam, awayLineupRaw],
      ] as Array<["home" | "away", string, { startXI?: string[] } | undefined]>) {
        if (!lineup?.startXI || lineup.startXI.length < 5) continue;
        // Pull team's top-11 expected starters by start_count.
        const expectedRows = await db.execute(sql`
          SELECT player_name, start_count
          FROM team_expected_xi
          WHERE team_name = ${teamName}
          ORDER BY start_count DESC
          LIMIT 11
        `);
        const expected = ((expectedRows as any).rows ?? []) as Array<{
          player_name: string;
          start_count: number;
        }>;
        // Cold-start gate: need ≥3 caps on at least one player to consider
        // the expected-XI baseline meaningful.
        const maxCount = expected.length > 0 ? expected[0].start_count : 0;
        if (maxCount < 3) continue;

        const actualSet = new Set(lineup.startXI.map((p) => p.toLowerCase()));
        let missingCount = 0;
        for (const e of expected) {
          if (!actualSet.has(e.player_name.toLowerCase())) missingCount++;
        }
        await upsertFeature(
          matchId,
          side === "home" ? "home_key_player_missing_count" : "away_key_player_missing_count",
          missingCount,
        );
      }
    }
  } catch (err) {
    logger.debug({ err, matchId }, "Key-player-missing feature computation failed (non-fatal)");
  }

  // C3b (2026-05-07): AF predictions as stored features. Not in FEATURE_NAMES
  // yet (model retrain required to USE them); stored so future retrain can
  // incorporate as a comparator signal (model agreement / disagreement with
  // AF's own prediction). Null-safe: skip writes when no row exists.
  try {
    const afRow = await db.execute(sql`
      SELECT af_pct_home, af_pct_draw, af_pct_away
      FROM af_predictions
      WHERE match_id = ${matchId}
        OR (match_id IS NULL AND api_fixture_id = (
          SELECT api_fixture_id FROM matches WHERE id = ${matchId}
        ))
      LIMIT 1
    `);
    const afPred = (afRow as any).rows?.[0];
    if (afPred) {
      const home = parseFloat(afPred.af_pct_home ?? "");
      const draw = parseFloat(afPred.af_pct_draw ?? "");
      const away = parseFloat(afPred.af_pct_away ?? "");
      if (Number.isFinite(home)) await upsertFeature(matchId, "af_pct_home", home / 100);
      if (Number.isFinite(draw)) await upsertFeature(matchId, "af_pct_draw", draw / 100);
      if (Number.isFinite(away)) await upsertFeature(matchId, "af_pct_away", away / 100);
    }
  } catch (err) {
    logger.debug({ err, matchId }, "AF predictions feature lookup failed (non-fatal)");
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

  const h2hHomeWinRate = 0.4;

  const homeCleanSheets = hasDbHistory ? computeCleanSheetRate(homeMatches, homeTeamId, "home", 5) :
    Math.max(0.05, 1 - (awayGoalsScored / 1.5));
  const awayCleanSheets = hasDbHistory ? computeCleanSheetRate(awayMatches, awayTeamId, "away", 5) :
    Math.max(0.05, 1 - (homeGoalsScored / 1.5));

  const homePointsTraj = computePointsTrajectory(homeMatches, homeTeamId, 10);
  const awayPointsTraj = computePointsTrajectory(awayMatches, awayTeamId, 10);

  const homeDaysSince = computeDaysSinceLastMatch(homeMatches, homeTeamId);
  const awayDaysSince = computeDaysSinceLastMatch(awayMatches, awayTeamId);

  // ─── Task 15 (Phase 4a.2) — ClubElo shadow features ──────────────────
  // Looks up home/away team Elo ratings via fuzzy resolver. Stored as
  // shadow features (NOT yet in FEATURE_NAMES / model input). Used by
  // a follow-up PR once we verify the resolver hit rate is acceptable
  // by inspecting home_clubelo / away_clubelo distributions in features.
  let homeClubElo: number | null = null;
  let awayClubElo: number | null = null;
  try {
    const matchRow = await db
      .select({
        homeTeam: matchesTable.homeTeam,
        awayTeam: matchesTable.awayTeam,
        country: matchesTable.country,
      })
      .from(matchesTable)
      .where(eq(matchesTable.id, matchId))
      .limit(1);
    if (matchRow.length > 0 && matchRow[0]) {
      const { getClubEloForTeam } = await import("./clubEloLookup");
      const homeRes = await getClubEloForTeam(matchRow[0].homeTeam);
      const awayRes = await getClubEloForTeam(matchRow[0].awayTeam);
      homeClubElo = homeRes.elo;
      awayClubElo = awayRes.elo;
    }
  } catch (err) {
    logger.debug({ err, matchId }, "ClubElo feature lookup failed (non-fatal)");
  }

  // Sub-phase 7.6: fixture density (last 14 days) + congestion diff.
  const homeFixtures14d = computeFixturesInLastDays(homeMatches, homeTeamId, 14);
  const awayFixtures14d = computeFixturesInLastDays(awayMatches, awayTeamId, 14);
  const fixturesCongestionDiff = homeFixtures14d - awayFixtures14d;

  // Sub-phase 7.6: lineup-publish timing (null if lineup not yet captured).
  const lineupPublishMins = await computeLineupPublishMinsPreKickoff(matchId);

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

  const leaguePositionDiff = 0;

  // ─── Bundle 7 (2026-05-09): referee + injury features ─────────────────────
  // Sub-phase 7 of PHASE 2 FULL PUSH strategic doc. Pure ingestion-side
  // emission — features land in features table for retrospective predictive-
  // power validation against settled bets in a future Bundle. predictionEngine.ts
  // is NOT changed here: per strategic doc "validate predictive power before
  // predictive use", a feature only graduates into bet decisions after
  // retrospective evidence shows signal.
  //
  // Failure-mode discipline: each query wrapped in try/catch. If the lookup
  // fails or returns no row, the feature simply isn't emitted (vs emitting a
  // zero, which would conflate "no data" with "data showing zero"). featureEngine
  // already treats absent features as null at consumer time.
  let homeRefereeCardRate: number | null = null;
  let refereeCardSampleSize: number | null = null;
  try {
    // referee_card_rates view (Bundle 2, migrate.ts) is grouped by
    // (referee_name, league). Look up the referee assigned to this match.
    const refRows = await db.execute(sql`
      SELECT rcr.avg_cards_per_match::float8 AS rate, rcr.n_matches::int AS n
      FROM match_referees mr
      JOIN referee_card_rates rcr
        ON rcr.referee_name = mr.referee_name
       AND rcr.league = ${league}
      WHERE mr.match_id = ${matchId}
      LIMIT 1
    `);
    const row = ((refRows as { rows?: Array<{ rate: number; n: number }> }).rows ?? [])[0];
    if (row) {
      homeRefereeCardRate = Number(row.rate);
      refereeCardSampleSize = Number(row.n);
    }
  } catch (err) {
    logger.warn({ err, matchId }, "Referee feature lookup failed — feature absent for this match");
  }

  // Injury features from injury_reports (sub-phase 7.0a ingestion at
  // apiFootball.ts:2225). Idempotent ingestion writes per-fixture snapshots
  // keyed by api_fixture_id with a match_id back-reference. Count by
  // injury_type per side. injury_type ∈ {'Missing Fixture','Questionable'}
  // per the CHECK constraint.
  let homeMissingFixtureCount = 0;
  let homeQuestionableCount = 0;
  let awayMissingFixtureCount = 0;
  let awayQuestionableCount = 0;
  try {
    const injCounts = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE ir.team_name = ${homeTeam} AND ir.injury_type = 'Missing Fixture')::int AS home_missing,
        COUNT(*) FILTER (WHERE ir.team_name = ${homeTeam} AND ir.injury_type = 'Questionable')::int AS home_questionable,
        COUNT(*) FILTER (WHERE ir.team_name = ${awayTeam} AND ir.injury_type = 'Missing Fixture')::int AS away_missing,
        COUNT(*) FILTER (WHERE ir.team_name = ${awayTeam} AND ir.injury_type = 'Questionable')::int AS away_questionable
      FROM injury_reports ir
      WHERE ir.match_id = ${matchId}
    `);
    const row = ((injCounts as { rows?: Array<{ home_missing: number; home_questionable: number; away_missing: number; away_questionable: number }> }).rows ?? [])[0];
    if (row) {
      homeMissingFixtureCount = Number(row.home_missing ?? 0);
      homeQuestionableCount = Number(row.home_questionable ?? 0);
      awayMissingFixtureCount = Number(row.away_missing ?? 0);
      awayQuestionableCount = Number(row.away_questionable ?? 0);
    }
  } catch (err) {
    logger.warn({ err, matchId }, "Injury feature lookup failed — counts default to 0");
  }
  const totalMissingFixtureDiff = homeMissingFixtureCount - awayMissingFixtureCount;

  // ─── Bundle 9 (2026-05-09): weather features ──────────────────────────────
  // Raw features (5) + compound features (6) per plan v3 §2.C. Pure ingestion-
  // side emission — no predictionEngine.ts changes here. Indoor short-circuit
  // emits NO weather features at all (the absence is the signal).
  let kickoffTempC: number | null = null;
  let kickoffWindKph: number | null = null;
  let kickoffPrecipMm: number | null = null;
  let kickoffHumidityPct: number | null = null;
  let isExtremeWeather = 0;
  let weatherEmissionAllowed = false;
  try {
    const wRows = await db.execute(sql`
      SELECT mw.kickoff_temp_c::float8 AS temp,
             mw.kickoff_wind_kph::float8 AS wind,
             mw.kickoff_precipitation_mm::float8 AS precip,
             mw.kickoff_humidity_pct::int AS humidity,
             COALESCE(v.is_indoor, false) AS is_indoor
      FROM match_weather mw
      LEFT JOIN matches m ON m.id = mw.match_id
      LEFT JOIN venues v ON v.api_venue_id = m.venue_api_id
      WHERE mw.match_id = ${matchId}
      LIMIT 1
    `);
    const row = ((wRows as { rows?: Array<{ temp: number; wind: number; precip: number; humidity: number; is_indoor: boolean }> }).rows ?? [])[0];
    if (row && !row.is_indoor) {
      kickoffTempC = Number(row.temp);
      kickoffWindKph = Number(row.wind);
      kickoffPrecipMm = Number(row.precip);
      kickoffHumidityPct = Number(row.humidity);
      const extreme =
        kickoffWindKph >= 32 ||
        kickoffPrecipMm >= 5 ||
        kickoffTempC < 5 ||
        kickoffTempC > 28;
      isExtremeWeather = extreme ? 1 : 0;
      weatherEmissionAllowed = true;
    }
    // If row.is_indoor === true OR no row exists: weatherEmissionAllowed stays false.
    // No weather features emitted for this match.
  } catch (err) {
    logger.warn({ err, matchId }, "Bundle 9 weather feature lookup failed — features absent");
  }
  // Compound features (per plan v3 strong-effect cells):
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const windOversDampener = weatherEmissionAllowed ? clamp(((kickoffWindKph ?? 0) - 15) / 17, 0, 1.5) : null;
  const windBttsNoInflator = weatherEmissionAllowed ? clamp(((kickoffWindKph ?? 0) - 15) / 17, 0, 1.5) : null;
  const rainOversDampener = weatherEmissionAllowed ? clamp((kickoffPrecipMm ?? 0) / 5, 0, 2) : null;
  const combinedOversDampener = weatherEmissionAllowed && windOversDampener !== null && rainOversDampener !== null
    ? Math.round(windOversDampener * rainOversDampener * 10000) / 10000 : null;
  const hotCardsInflator = weatherEmissionAllowed ? clamp(((kickoffTempC ?? 0) - 25) / 5, 0, 1.5) : null;
  const coldOversDampener = weatherEmissionAllowed ? clamp((5 - (kickoffTempC ?? 0)) / 5, 0, 1.5) : null;

  // ─── Bundle 8 (2026-05-09): manager-tenure + sidelined-active features ────
  // Team-name -> team_api_id resolution via UNION of injury_reports +
  // team_standings (most reliable sources of the mapping). Falls back to
  // null if the team has never been seen in either source — feature simply
  // doesn't emit for that match.
  let homeManagerTenureDays: number | null = null;
  let awayManagerTenureDays: number | null = null;
  let homeActiveSidelined: number | null = null;
  let awayActiveSidelined: number | null = null;
  try {
    const teamIdRows = await db.execute(sql`
      WITH team_id_map AS (
        SELECT DISTINCT ON (team_name) team_name, team_api_id::int AS team_api_id, src_priority
        FROM (
          SELECT team_name, team_api_id, 1 AS src_priority FROM injury_reports
          UNION ALL
          SELECT team_name, api_team_id AS team_api_id, 2 AS src_priority FROM team_standings
        ) t
        WHERE team_api_id IS NOT NULL
        ORDER BY team_name, src_priority
      )
      SELECT
        (SELECT team_api_id FROM team_id_map WHERE team_name = ${homeTeam}) AS home_id,
        (SELECT team_api_id FROM team_id_map WHERE team_name = ${awayTeam}) AS away_id
    `);
    const idRow = ((teamIdRows as { rows?: Array<{ home_id: number | null; away_id: number | null }> }).rows ?? [])[0];
    const homeApiId = idRow?.home_id ?? null;
    const awayApiId = idRow?.away_id ?? null;

    // Manager-tenure: days since the current coach's start_date.
    // team_coaches uses (team_api_id, is_current=true). Lower tenure = newer
    // manager = potential disruption signal. Null when no current coach
    // captured (e.g. team never reached Sunday cron's metadata refresh).
    if (homeApiId !== null) {
      const r = await db.execute(sql`
        SELECT EXTRACT(EPOCH FROM (NOW() - MAX(start_date::timestamptz))) / 86400.0 AS days
        FROM team_coaches
        WHERE team_api_id = ${homeApiId} AND is_current = true AND start_date IS NOT NULL
      `);
      const v = ((r as { rows?: Array<{ days: number | null }> }).rows ?? [])[0]?.days;
      if (v != null && Number.isFinite(Number(v))) homeManagerTenureDays = Math.round(Number(v) * 10) / 10;
    }
    if (awayApiId !== null) {
      const r = await db.execute(sql`
        SELECT EXTRACT(EPOCH FROM (NOW() - MAX(start_date::timestamptz))) / 86400.0 AS days
        FROM team_coaches
        WHERE team_api_id = ${awayApiId} AND is_current = true AND start_date IS NOT NULL
      `);
      const v = ((r as { rows?: Array<{ days: number | null }> }).rows ?? [])[0]?.days;
      if (v != null && Number.isFinite(Number(v))) awayManagerTenureDays = Math.round(Number(v) * 10) / 10;
    }

    // Active sidelined count: number of players from the team's roster
    // (observed in fixture_player_stats across any prior match) who are
    // currently sidelined (player_sidelined.end_date IS NULL OR > NOW()).
    // Wide-net heuristic: a player who's appeared for the team historically
    // is treated as a roster member. False positives possible (rotation,
    // departed players) — mitigated by sample-size at validation time.
    if (homeApiId !== null) {
      const r = await db.execute(sql`
        SELECT COUNT(DISTINCT ps.player_api_id)::int AS n
        FROM player_sidelined ps
        WHERE ps.player_api_id IN (
          SELECT DISTINCT fps.player_id::int
          FROM fixture_player_stats fps
          WHERE fps.team_id = ${homeApiId} AND fps.player_id IS NOT NULL
        )
        AND (ps.end_date IS NULL OR ps.end_date::date >= CURRENT_DATE)
      `);
      const v = ((r as { rows?: Array<{ n: number | null }> }).rows ?? [])[0]?.n;
      homeActiveSidelined = v == null ? 0 : Number(v);
    }
    if (awayApiId !== null) {
      const r = await db.execute(sql`
        SELECT COUNT(DISTINCT ps.player_api_id)::int AS n
        FROM player_sidelined ps
        WHERE ps.player_api_id IN (
          SELECT DISTINCT fps.player_id::int
          FROM fixture_player_stats fps
          WHERE fps.team_id = ${awayApiId} AND fps.player_id IS NOT NULL
        )
        AND (ps.end_date IS NULL OR ps.end_date::date >= CURRENT_DATE)
      `);
      const v = ((r as { rows?: Array<{ n: number | null }> }).rows ?? [])[0]?.n;
      awayActiveSidelined = v == null ? 0 : Number(v);
    }
  } catch (err) {
    logger.warn({ err, matchId, homeTeam, awayTeam }, "Manager/sidelined feature lookup failed — features absent for this match");
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
    // Sub-phase 7.6: fixture density (last 14 days)
    ["home_fixtures_in_last_14d", homeFixtures14d],
    ["away_fixtures_in_last_14d", awayFixtures14d],
    ["fixtures_congestion_diff", fixturesCongestionDiff],
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
    // Bundle 7 (2026-05-09): injury counts per side. Always emitted; 0 means
    // "no injuries reported" (which IS data — fixture had injury ingestion
    // run and returned zero rows). Absence of the feature row in the table
    // means injury ingestion hasn't fired for this fixture yet.
    ["home_missing_fixture_count", homeMissingFixtureCount],
    ["home_questionable_count", homeQuestionableCount],
    ["away_missing_fixture_count", awayMissingFixtureCount],
    ["away_questionable_count", awayQuestionableCount],
    ["total_missing_fixture_diff", totalMissingFixtureDiff],
  ];

  for (const [name, value] of features) {
    await upsertFeature(matchId, name, value);
  }

  // Task 15 shadow features — persist alongside the main set. Skipped
  // when the resolver returns null (team not yet known to ClubElo).
  if (homeClubElo != null) await upsertFeature(matchId, "home_clubelo", homeClubElo);
  if (awayClubElo != null) await upsertFeature(matchId, "away_clubelo", awayClubElo);
  if (homeClubElo != null && awayClubElo != null) {
    await upsertFeature(matchId, "elo_diff", homeClubElo - awayClubElo);
  }

  // ── Bundle 7.F (2026-05-17): §G feature wire-in (HIGH + 5-game form) ────
  // Each feature has a safe neutral default so missing source data
  // doesn't penalise unfamiliar fixtures. Model retrains automatically
  // on next bootstrap via the featureMeans-length-mismatch guard in
  // predictionEngine.loadLatestModel.
  try {
    if (Number.isFinite(homeForm5) && Number.isFinite(awayForm5)) {
      await upsertFeature(matchId, "form_diff_5game", homeForm5 - awayForm5);
    } else {
      await upsertFeature(matchId, "form_diff_5game", 0);
    }
  } catch (err) {
    logger.debug({ err, matchId }, "form_diff_5game upsert failed");
  }
  try {
    const lineupSizes = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM team_expected_xi WHERE team_name = ${homeTeam})::int AS home_size,
        (SELECT COUNT(*) FROM team_expected_xi WHERE team_name = ${awayTeam})::int AS away_size
    `);
    const lr = ((lineupSizes as any).rows ?? [])[0] as { home_size: number; away_size: number } | undefined;
    await upsertFeature(matchId, "home_lineup_xi_size", lr?.home_size ?? 11);
    await upsertFeature(matchId, "away_lineup_xi_size", lr?.away_size ?? 11);
  } catch (err) {
    logger.debug({ err, matchId }, "lineup_xi_size upsert failed — defaulting to 11");
    await upsertFeature(matchId, "home_lineup_xi_size", 11);
    await upsertFeature(matchId, "away_lineup_xi_size", 11);
  }
  try {
    const inj = await db.execute(sql`
      WITH fx AS (
        SELECT api_fixture_id, home_team, away_team
        FROM matches WHERE id = ${matchId}
      )
      SELECT
        COALESCE(SUM(CASE WHEN ir.team_name = (SELECT home_team FROM fx) THEN 1 ELSE 0 END), 0)::int AS home_count,
        COALESCE(SUM(CASE WHEN ir.team_name = (SELECT away_team FROM fx) THEN 1 ELSE 0 END), 0)::int AS away_count
      FROM injury_reports ir
      WHERE ir.api_fixture_id = (SELECT api_fixture_id FROM fx)
    `);
    const ir = ((inj as any).rows ?? [])[0] as { home_count: number; away_count: number } | undefined;
    await upsertFeature(matchId, "home_injuries_count", ir?.home_count ?? 0);
    await upsertFeature(matchId, "away_injuries_count", ir?.away_count ?? 0);
  } catch (err) {
    logger.debug({ err, matchId }, "injuries_count upsert failed — defaulting to 0");
    await upsertFeature(matchId, "home_injuries_count", 0);
    await upsertFeature(matchId, "away_injuries_count", 0);
  }

  // ── Bundle FP1 (2026-05-18): xG features from team_xg_rolling ────────
  // 56k+ rows of rolling 5-match xG-for, xG-against per team. Single
  // highest-value unused predictor. Missing → impute at 1.3 league-avg
  // so featureless fixtures don't get a structural penalty. Model
  // retrains automatically on next bootstrap via featureMeans-length
  // mismatch guard.
  try {
    const xgRows = await db.execute(sql`
      WITH fx AS (
        SELECT home_team, away_team FROM matches WHERE id = ${matchId}
      )
      SELECT
        (SELECT xg_for_5::float8 FROM team_xg_rolling
         WHERE team_name = (SELECT home_team FROM fx)
         ORDER BY computed_at DESC LIMIT 1) AS home_xg_for,
        (SELECT xg_against_5::float8 FROM team_xg_rolling
         WHERE team_name = (SELECT home_team FROM fx)
         ORDER BY computed_at DESC LIMIT 1) AS home_xg_against,
        (SELECT xg_for_5::float8 FROM team_xg_rolling
         WHERE team_name = (SELECT away_team FROM fx)
         ORDER BY computed_at DESC LIMIT 1) AS away_xg_for,
        (SELECT xg_against_5::float8 FROM team_xg_rolling
         WHERE team_name = (SELECT away_team FROM fx)
         ORDER BY computed_at DESC LIMIT 1) AS away_xg_against
    `);
    const xg = ((xgRows as any).rows ?? [])[0] as
      | { home_xg_for: number | null; home_xg_against: number | null; away_xg_for: number | null; away_xg_against: number | null }
      | undefined;
    const homeFor = xg?.home_xg_for != null && Number.isFinite(xg.home_xg_for) ? xg.home_xg_for : 1.3;
    const homeAgainst = xg?.home_xg_against != null && Number.isFinite(xg.home_xg_against) ? xg.home_xg_against : 1.3;
    const awayFor = xg?.away_xg_for != null && Number.isFinite(xg.away_xg_for) ? xg.away_xg_for : 1.3;
    const awayAgainst = xg?.away_xg_against != null && Number.isFinite(xg.away_xg_against) ? xg.away_xg_against : 1.3;
    await upsertFeature(matchId, "home_xg_for_avg", homeFor);
    await upsertFeature(matchId, "home_xg_against_avg", homeAgainst);
    await upsertFeature(matchId, "away_xg_for_avg", awayFor);
    await upsertFeature(matchId, "away_xg_against_avg", awayAgainst);
    await upsertFeature(matchId, "xg_diff", (homeFor - homeAgainst) - (awayFor - awayAgainst));
  } catch (err) {
    logger.debug({ err, matchId }, "Bundle FP1 xG features upsert failed — defaulting");
    await upsertFeature(matchId, "home_xg_for_avg", 1.3);
    await upsertFeature(matchId, "home_xg_against_avg", 1.3);
    await upsertFeature(matchId, "away_xg_for_avg", 1.3);
    await upsertFeature(matchId, "away_xg_against_avg", 1.3);
    await upsertFeature(matchId, "xg_diff", 0);
  }

  // Sub-phase 7.6: conditional lineup-publish-timing (only if captured).
  if (lineupPublishMins !== null) {
    await upsertFeature(matchId, "lineup_publish_mins_pre_kickoff", lineupPublishMins);
  }

  // Bundle 7 (2026-05-09): referee features. Conditional emission — only
  // ship the feature when a referee was assigned AND has historical card
  // data in the league. n_matches is emitted alongside the rate so a
  // future predictive-use step can apply a sample-size floor (e.g. n>=20)
  // and treat low-n referees as null fallback to league-average.
  if (homeRefereeCardRate !== null && refereeCardSampleSize !== null) {
    await upsertFeature(matchId, "referee_avg_cards_per_match", homeRefereeCardRate);
    await upsertFeature(matchId, "referee_card_sample_size", refereeCardSampleSize);
  }

  // Bundle 8 (2026-05-09): manager-tenure features. Conditional — only emit
  // when team_api_id resolved AND a current coach is captured. Days-since-
  // start is the raw signal; a future predictive-use step can derive
  // "manager_change_recent_days" with decay weighting.
  if (homeManagerTenureDays !== null) {
    await upsertFeature(matchId, "home_manager_tenure_days", homeManagerTenureDays);
  }
  if (awayManagerTenureDays !== null) {
    await upsertFeature(matchId, "away_manager_tenure_days", awayManagerTenureDays);
  }
  // Active-sidelined count features. Always emitted when team_api_id
  // resolved (0 means "no sidelined players observed for this team's known
  // roster" — semantically distinct from "couldn't resolve team_api_id"
  // which results in no row at all).
  if (homeActiveSidelined !== null) {
    await upsertFeature(matchId, "home_active_sidelined_count", homeActiveSidelined);
  }
  if (awayActiveSidelined !== null) {
    await upsertFeature(matchId, "away_active_sidelined_count", awayActiveSidelined);
  }

  // Bundle 9 (2026-05-09): weather features — raw + 6 compounds. Conditional
  // on outdoor venue + match_weather row present. Indoor matches emit NO
  // weather features (absence is the signal — predictionEngine downstream
  // can interpret missing weather as "indoor or unfetched", not as zero).
  if (weatherEmissionAllowed) {
    await upsertFeature(matchId, "kickoff_temp_c", kickoffTempC!);
    await upsertFeature(matchId, "kickoff_wind_kph", kickoffWindKph!);
    await upsertFeature(matchId, "kickoff_precipitation_mm", kickoffPrecipMm!);
    await upsertFeature(matchId, "kickoff_humidity_pct", kickoffHumidityPct!);
    await upsertFeature(matchId, "is_extreme_weather", isExtremeWeather);
    if (windOversDampener !== null) await upsertFeature(matchId, "wind_overs_dampener", windOversDampener);
    if (windBttsNoInflator !== null) await upsertFeature(matchId, "wind_btts_no_inflator", windBttsNoInflator);
    if (rainOversDampener !== null) await upsertFeature(matchId, "rain_overs_dampener", rainOversDampener);
    if (combinedOversDampener !== null) await upsertFeature(matchId, "combined_overs_dampener", combinedOversDampener);
    if (hotCardsInflator !== null) await upsertFeature(matchId, "hot_cards_inflator", hotCardsInflator);
    if (coldOversDampener !== null) await upsertFeature(matchId, "cold_overs_dampener", coldOversDampener);
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

export async function runFeatureEngineForUpcomingMatches(
  force = false,
  opts?: { maxHoursAhead?: number; onlyMatchesWithPendingBets?: boolean },
): Promise<{
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
  // 2026-05-08: opts.maxHoursAhead lets pre-kickoff cron narrow the window
  // (e.g. 1.5h) for targeted refresh. Default = full 72h.
  const hoursAhead = opts?.maxHoursAhead ?? FEATURE_MAX_HOURS_AHEAD;
  const horizon = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  // Fix B: only matches kicking off in [now, now+window], ordered by kickoff (most imminent first)
  let upcomingMatches = await db
    .select()
    .from(matchesTable)
    .where(and(
      eq(matchesTable.status, "scheduled"),
      gte(matchesTable.kickoffTime, now),
      lte(matchesTable.kickoffTime, horizon),
    ))
    .orderBy(asc(matchesTable.kickoffTime));

  // 2026-05-08: optionally restrict to matches with pending bets — used by
  // the pre-kickoff refresh cron to avoid wasting compute on matches we
  // aren't betting on. Filter happens in-memory after the kickoff window
  // narrowing reduces N to a manageable size.
  if (opts?.onlyMatchesWithPendingBets && upcomingMatches.length > 0) {
    const matchIds = upcomingMatches.map((m) => m.id);
    const withPendingRows = await db.execute(sql`
      SELECT DISTINCT match_id FROM paper_bets
      WHERE status='pending' AND deleted_at IS NULL AND legacy_regime=false
        AND match_id IN (${sql.raw(matchIds.join(","))})
    `);
    const withPendingSet = new Set<number>(
      (((withPendingRows as any).rows ?? []) as Array<{ match_id: number }>).map((r) => r.match_id),
    );
    upcomingMatches = upcomingMatches.filter((m) => withPendingSet.has(m.id));
  }

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
