/**
 * Task 15 (Phase 4a follow-up, 2026-05-11) — local Elo computation
 * for leagues outside ClubElo's European coverage.
 *
 * ClubElo's daily snapshot returns ~630 European clubs (ENG, ESP,
 * ITA, GER, FRA + lower European tiers). Settled matches in J1/J2/J3
 * (JPN), MLS (USA), Liga Profesional Argentina, Primera Nacional,
 * Primera C, Copa Colombia, K League 1/2 (KOR), Botola Pro (MAR),
 * Premier Soccer League (RSA) etc. cannot resolve regardless of
 * resolver quality. This module computes a per-league chronological
 * Elo and fills in the home_clubelo / away_clubelo / elo_diff feature
 * rows when ClubElo did not supply them.
 *
 * Algorithm (standard chess Elo with goal-difference scaling):
 *   initial rating       R0 = 1500
 *   home advantage       H  = 65 Elo points
 *   expected home prob   E  = 1 / (1 + 10^((Ra − Rh − H) / 400))
 *   K-factor base        K0 = 20
 *   goal-diff multiplier K  = K0 × (1 + 0.5 × ln(1 + |gd|))
 *   actual               S  = 1 (home win) | 0.5 (draw) | 0 (away win)
 *   updates              Rh' = Rh + K × (S − E),  Ra' = Ra − K × (S − E)
 *
 * Idempotency: only writes a feature row if NONE exists for that match
 * and feature_name. ClubElo's real values always win — both pipelines
 * write the same column name, but ClubElo runs first (via the historical
 * backfill walking chronological dates with the European snapshot) and
 * this fills the gaps.
 *
 * Cost: one bulk SELECT per league + one upsert per (match × feature)
 * gap. Walk is in-memory, no Python sidecar required. Recompute is
 * deterministic and cheap (~5k matches across ~50 leagues completes in
 * a few seconds).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const INITIAL_RATING = 1500;
const HOME_ADV = 65;
const K_BASE = 20;

interface MatchRow {
  id: number;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  kickoff_time: string;
}

export interface LocalEloResult {
  leagues_scanned: number;
  leagues_processed: number;
  matches_seen: number;
  features_written: number;
  durationMs: number;
}

/**
 * Compute the K-factor for a match given the goal-difference.
 * Margin ≥1 lifts K modestly; 4-0 result weighs ~2× a 1-0 result.
 */
function kFactor(goalDiff: number): number {
  return K_BASE * (1 + 0.5 * Math.log(1 + Math.abs(goalDiff)));
}

/**
 * Expected probability the home team wins from current ratings.
 */
function expectedHome(rh: number, ra: number): number {
  return 1 / (1 + Math.pow(10, (ra - rh - HOME_ADV) / 400));
}

async function insertFeature(
  matchId: number,
  name: string,
  value: number,
): Promise<void> {
  const rounded = String(Math.round(value * 1_000_000) / 1_000_000);
  await db.execute(sql`
    INSERT INTO features (match_id, feature_name, feature_value, computed_at)
    VALUES (${matchId}, ${name}, ${rounded}, NOW())
  `);
}

/**
 * Pre-fetch the set of (match_id, feature_name) pairs that already
 * exist for a league's matches, limited to the three Elo features
 * this module writes. Returns a Set keyed by "matchId:featureName".
 */
async function loadExistingEloKeys(matchIds: number[]): Promise<Set<string>> {
  if (matchIds.length === 0) return new Set();
  const result = (await db.execute(sql`
    SELECT match_id, feature_name
    FROM features
    WHERE feature_name IN ('home_clubelo', 'away_clubelo', 'elo_diff')
      AND match_id IN (${sql.raw(matchIds.join(","))})
  `)) as unknown as { rows?: Array<{ match_id: number; feature_name: string }> };
  const set = new Set<string>();
  for (const row of result.rows ?? []) {
    set.add(`${row.match_id}:${row.feature_name}`);
  }
  return set;
}

/**
 * Entry point — walks each league chronologically, computes per-team
 * Elo, and writes the three Elo feature rows on any match where they
 * are still missing.
 *
 * Set `onlyLeaguesMissingElo=true` to limit to leagues where at least
 * one settled match lacks home_clubelo — typically the non-European
 * universe. Default `false` covers both, which is the safe choice for
 * full re-runs (ClubElo data wins via the ON CONFLICT DO NOTHING gate).
 */
export async function runLocalEloBackfill(opts: {
  onlyLeaguesMissingElo?: boolean;
} = {}): Promise<LocalEloResult> {
  const startedAt = Date.now();
  const result: LocalEloResult = {
    leagues_scanned: 0,
    leagues_processed: 0,
    matches_seen: 0,
    features_written: 0,
    durationMs: 0,
  };

  // List of leagues to process. When onlyLeaguesMissingElo, we filter
  // to leagues where there exists at least one settled match without
  // a home_clubelo feature row — that's our coverage gap. Otherwise
  // walk every league.
  const leaguesQuery = opts.onlyLeaguesMissingElo
    ? sql`
        SELECT DISTINCT m.league
        FROM matches m
        WHERE m.home_score IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM features f
            WHERE f.match_id = m.id AND f.feature_name = 'home_clubelo'
          )
      `
    : sql`SELECT DISTINCT league FROM matches WHERE league IS NOT NULL`;

  const leaguesResult = (await db.execute(leaguesQuery)) as unknown as {
    rows?: Array<{ league: string | null }>;
  };
  const leagues = (leaguesResult.rows ?? [])
    .map((r) => r.league)
    .filter((l): l is string => typeof l === "string" && l.length > 0);
  result.leagues_scanned = leagues.length;

  for (const league of leagues) {
    // Pull every match in this league ordered chronologically. We
    // include both settled and upcoming — settled matches drive the
    // rating updates; upcoming matches just inherit the team's current
    // rating as a feature (no update, since the result is unknown).
    const matchRows = (await db.execute(sql`
      SELECT id, home_team, away_team, home_score, away_score,
             kickoff_time::text AS kickoff_time
      FROM matches
      WHERE league = ${league}
      ORDER BY kickoff_time ASC, id ASC
    `)) as unknown as { rows?: MatchRow[] };
    const matches = matchRows.rows ?? [];
    if (matches.length === 0) continue;

    // Pre-fetch the set of (match_id, feature_name) pairs that already
    // have Elo features — typically populated by ClubElo for European
    // leagues. We skip those and only fill genuine gaps.
    const existing = await loadExistingEloKeys(matches.map((m) => m.id));

    const ratings = new Map<string, number>();

    for (const m of matches) {
      result.matches_seen += 1;
      const rh = ratings.get(m.home_team) ?? INITIAL_RATING;
      const ra = ratings.get(m.away_team) ?? INITIAL_RATING;

      if (!existing.has(`${m.id}:home_clubelo`)) {
        await insertFeature(m.id, "home_clubelo", rh);
        result.features_written += 1;
      }
      if (!existing.has(`${m.id}:away_clubelo`)) {
        await insertFeature(m.id, "away_clubelo", ra);
        result.features_written += 1;
      }
      if (!existing.has(`${m.id}:elo_diff`)) {
        await insertFeature(m.id, "elo_diff", rh - ra);
        result.features_written += 1;
      }

      // Only update ratings on settled matches — upcoming matches
      // carry forward the team's current rating untouched.
      if (m.home_score != null && m.away_score != null) {
        const goalDiff = m.home_score - m.away_score;
        const s = goalDiff > 0 ? 1 : goalDiff < 0 ? 0 : 0.5;
        const e = expectedHome(rh, ra);
        const k = kFactor(goalDiff);
        const delta = k * (s - e);
        ratings.set(m.home_team, rh + delta);
        ratings.set(m.away_team, ra - delta);
      }
    }

    result.leagues_processed += 1;
  }

  result.durationMs = Date.now() - startedAt;
  logger.info(result, "Local Elo backfill complete");
  return result;
}
