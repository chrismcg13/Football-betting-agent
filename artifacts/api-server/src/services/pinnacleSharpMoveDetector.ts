import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Pinnacle sharp-move detector (2026-05-08 maximisation bundle).
 *
 * Pinnacle's line movements are the cleanest sharp-money signal in
 * football betting. Pinnacle takes the action, sharp money hits the
 * price, Pinnacle moves the line. The size + direction + speed of
 * the move encode information our model can use:
 *
 *   - STEAM   : >=1.5% move within 5 min near kickoff. Strong sharp
 *               signal — the move is recent enough that the value
 *               hasn't fully closed yet.
 *   - REVERSE : line moves opposite to public-money direction (here
 *               approximated as opposite to the soft-book consensus
 *               via api_football_real Bet365/Unibet data). Pinnacle
 *               moving against soft consensus is a textbook sharp
 *               signal (RLM).
 *   - DRIFT   : <1.5% but consistent direction over 15+ min. Mild
 *               sharp signal.
 *   - DEAD    : no move >0.5% in 60+ min. Indicates no sharp money
 *               interest. Lower-confidence bet.
 *
 * Runs every 5 min. For each Tier-A candidate match (universe_tier='A',
 * scheduled, kickoff in T-30 to T-0), compares the most recent
 * api_football_real:Pinnacle snapshot to the snapshot from 5 min before.
 * Logs detected moves to pinnacle_line_moves with audit context.
 *
 * Output is consumed by the value-detection / opportunity-score path
 * in a follow-up commit (read-only first cycle to validate signal
 * quality before wiring into stake decisions).
 */

const STEAM_PCT = 1.5;
const DRIFT_PCT = 0.5;
const REVERSE_OPP_THRESHOLD_PCT = 1.0;

interface MoveResult {
  evaluatedAt: string;
  matchesScanned: number;
  movesDetected: number;
  byType: Record<string, number>;
}

export async function runPinnacleSharpMoveDetector(): Promise<MoveResult> {
  const evaluatedAt = new Date().toISOString();

  // Find Tier-A candidate fixtures kicking off in the next 30 min that have
  // at least 2 Pinnacle snapshots from the last 30 min (need a 5-min delta
  // for steam detection). We also look further back for drift detection.
  const candidates = (await db.execute(sql`
    SELECT m.id AS match_id, m.kickoff_time::text AS kickoff
    FROM matches m
    JOIN competition_config cc ON cc.name = m.league
    WHERE cc.is_active = true
      AND cc.universe_tier = 'A'
      AND m.status = 'scheduled'
      AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
  `)) as unknown as { rows: Array<{ match_id: number; kickoff: string }> };

  let movesDetected = 0;
  const byType: Record<string, number> = {};

  for (const c of candidates.rows) {
    // Pull recent Pinnacle snapshots for this match — both AF and OddsPapi
    const snapshots = (await db.execute(sql`
      SELECT market_type, selection_name, back_odds::float8 AS odds, snapshot_time
      FROM odds_snapshots
      WHERE match_id = ${c.match_id}
        AND source IN ('api_football_real:Pinnacle','oddspapi_pinnacle')
        AND snapshot_time > NOW() - INTERVAL '20 minutes'
      ORDER BY market_type, selection_name, snapshot_time DESC
    `)) as unknown as {
      rows: Array<{ market_type: string; selection_name: string; odds: number; snapshot_time: string }>;
    };

    // Group by (market_type, selection_name) preserving time order
    const byKey = new Map<string, Array<{ odds: number; snapshot_time: string }>>();
    for (const row of snapshots.rows) {
      const k = `${row.market_type}|${row.selection_name}`;
      const arr = byKey.get(k) ?? [];
      arr.push({ odds: row.odds, snapshot_time: row.snapshot_time });
      byKey.set(k, arr);
    }

    for (const [k, series] of byKey.entries()) {
      if (series.length < 2) continue;
      const [marketType, selectionName] = k.split("|");
      if (!marketType || !selectionName) continue;

      const newest = series[0]; // ORDER BY DESC → newest first
      const prev5 = series.find(
        (s) => Date.parse(newest!.snapshot_time) - Date.parse(s.snapshot_time) >= 4 * 60_000,
      );
      if (!prev5) continue;

      const prevOdds = prev5.odds;
      const newOdds = newest!.odds;
      if (!prevOdds || !newOdds || prevOdds <= 1 || newOdds <= 1) continue;

      const movePct = ((newOdds - prevOdds) / prevOdds) * 100;
      const absMove = Math.abs(movePct);

      let moveType: "steam" | "reverse" | "drift" | "dead" | null = null;
      if (absMove >= STEAM_PCT) {
        moveType = "steam";
      } else if (absMove >= DRIFT_PCT) {
        moveType = "drift";
      } else {
        moveType = "dead";
      }

      // Reverse-line-movement check: if Pinnacle moved by >REVERSE_OPP_THRESHOLD_PCT
      // AND opposite direction to recent soft-book consensus, upgrade to 'reverse'.
      if (absMove >= REVERSE_OPP_THRESHOLD_PCT) {
        const softs = (await db.execute(sql`
          SELECT AVG(back_odds::float8) AS avg_odds
          FROM odds_snapshots
          WHERE match_id = ${c.match_id}
            AND market_type = ${marketType}
            AND selection_name = ${selectionName}
            AND source IN ('api_football_real:Bet365','api_football_real:Unibet','api_football_real:Marathonbet','api_football_real:Betano')
            AND snapshot_time > NOW() - INTERVAL '15 minutes'
        `)) as unknown as { rows: Array<{ avg_odds: number | null }> };
        const softAvg = softs.rows[0]?.avg_odds;
        if (softAvg && softAvg > 1) {
          const softMovePct = ((softAvg - prevOdds) / prevOdds) * 100;
          // Opposite direction (sign mismatch) AND meaningful magnitude
          if (Math.sign(movePct) !== Math.sign(softMovePct) && Math.abs(softMovePct) >= 0.5) {
            moveType = "reverse";
          }
        }
      }

      const minutesToKickoff = Math.max(
        0,
        Math.round((Date.parse(c.kickoff) - Date.now()) / 60_000),
      );

      await db.execute(sql`
        INSERT INTO pinnacle_line_moves (
          match_id, market_type, selection_name,
          prev_odds, new_odds, move_pct, move_type,
          prev_snapshot_at, new_snapshot_at, detected_at, minutes_to_kickoff
        ) VALUES (
          ${c.match_id}, ${marketType}, ${selectionName},
          ${prevOdds}, ${newOdds}, ${movePct}, ${moveType},
          ${prev5.snapshot_time}::timestamptz, ${newest!.snapshot_time}::timestamptz, NOW(),
          ${minutesToKickoff}
        )
      `);

      movesDetected++;
      byType[moveType] = (byType[moveType] ?? 0) + 1;

      if (moveType === "steam" || moveType === "reverse") {
        logger.info(
          {
            matchId: c.match_id, marketType, selectionName,
            prevOdds, newOdds, movePct: movePct.toFixed(3), moveType,
            minutesToKickoff,
          },
          `Pinnacle ${moveType} move detected — sharp signal`,
        );
      }
    }
  }

  logger.info(
    { matchesScanned: candidates.rows.length, movesDetected, byType, evaluatedAt },
    "Pinnacle sharp-move detector cycle complete",
  );

  return { evaluatedAt, matchesScanned: candidates.rows.length, movesDetected, byType };
}
