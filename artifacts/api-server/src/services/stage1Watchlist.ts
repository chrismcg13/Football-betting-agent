/**
 * Bundle 7.B — Stage 1 model-blind watchlist (2026-05-17)
 *
 * Emits candidates from Betfair signals only. R1-preserving: the model
 * is NOT consulted for inclusion. Three primary signals UNION:
 *
 *   - Liquidity > £500 (memo §H BALANCED)
 *   - Pinnacle coverage AND kickoff < 24h (release-window proxy)
 *   - 4%/30min Betfair mover with quality filter (Bundle 7.B
 *     services/moverDetector.ts)
 *
 * Candidates from this builder are tagged candidate_track='sharp_anchored'
 * automatically — Stage 1 only fires on fixtures where Pinnacle priced
 * the market or a non-Pinnacle sharp has a fresh snapshot.
 *
 * valueDetection.ts continues to emit MODEL-DRIVEN candidates for
 * model_only scopes (no sharp anchor). Bundle 7.C will gate-bypass
 * the 8 upstream filters for sharp_anchored candidates only.
 *
 * The cron fires every 5 min (registered in scheduler.ts). Stage 0
 * (watchPriority) sets the polling cadence per tier; Stage 1 acts on
 * Tier 1/2/3 — Tier 4 only enters via mover signal.
 */

import { db, complianceLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { detectQualifyingMovers, isMoverSignalEnabled, type QualifyingMover } from "./moverDetector";

export interface Stage1Candidate {
  match_id: number;
  market_type: string;
  selection_name: string;
  back_odds: number;
  pinnacle_implied: number | null;
  source: "liquidity" | "kickoff_window" | "mover";
  mover_meta?: {
    mover_pct_30min: number;
    matched_volume_at_trigger: number;
    hours_to_kickoff: number;
  };
}

export interface Stage1RunResult {
  evaluated_at: string;
  candidates_emitted: number;
  by_source: { liquidity: number; kickoff_window: number; mover: number };
  movers_logged: number;
  errors: number;
}

export async function runStage1Watchlist(): Promise<Stage1RunResult> {
  const result: Stage1RunResult = {
    evaluated_at: new Date().toISOString(),
    candidates_emitted: 0,
    by_source: { liquidity: 0, kickoff_window: 0, mover: 0 },
    movers_logged: 0,
    errors: 0,
  };

  // Source 1 + 2 — liquidity > £500 OR kickoff window
  let liqRows: Stage1Candidate[] = [];
  let kwRows: Stage1Candidate[] = [];
  try {
    const r = await db.execute(sql`
      WITH liquid AS (
        SELECT DISTINCT ON (ls.match_id, ls.market_type)
          ls.match_id, ls.market_type, ls.total_market_volume::float8 AS vol
        FROM liquidity_snapshots ls
        WHERE ls.captured_at >= NOW() - INTERVAL '15 minutes'
          AND ls.total_market_volume::float8 > 500
        ORDER BY ls.match_id, ls.market_type, ls.captured_at DESC
      ),
      kickoff_window AS (
        SELECT DISTINCT ON (s.match_id, s.market_type)
          s.match_id, s.market_type, s.selection_name, s.pinnacle_implied::float8 AS pi
        FROM pinnacle_odds_snapshots s
        JOIN matches m ON m.id = s.match_id
        WHERE m.kickoff_time IS NOT NULL
          AND m.kickoff_time > NOW()
          AND m.kickoff_time <= NOW() + INTERVAL '24 hours'
          AND s.bookmaker_slug = 'pinnacle'
          AND s.captured_at >= NOW() - INTERVAL '15 minutes'
          AND s.pinnacle_implied IS NOT NULL
        ORDER BY s.match_id, s.market_type, s.captured_at DESC
      )
      -- Source 1: liquidity-driven, joined to fresh exchange back_odds.
      SELECT
        'liquidity'::text AS source,
        l.match_id AS match_id,
        l.market_type AS market_type,
        os.selection_name AS selection_name,
        os.back_odds::float8 AS back_odds,
        pi.pinnacle_implied::float8 AS pinnacle_implied
      FROM liquid l
      JOIN LATERAL (
        SELECT DISTINCT ON (selection_name) selection_name, back_odds, snapshot_time
        FROM odds_snapshots
        WHERE match_id = l.match_id AND market_type = l.market_type
          AND source = 'betfair_exchange' AND back_odds::float8 > 1.01
          AND snapshot_time >= NOW() - INTERVAL '15 minutes'
        ORDER BY selection_name, snapshot_time DESC
      ) os ON true
      LEFT JOIN LATERAL (
        SELECT pinnacle_implied
        FROM pinnacle_odds_snapshots
        WHERE match_id = l.match_id AND market_type = l.market_type
          AND selection_name = os.selection_name
          AND bookmaker_slug = 'pinnacle'
          AND captured_at >= NOW() - INTERVAL '15 minutes'
        ORDER BY captured_at DESC LIMIT 1
      ) pi ON true
      UNION ALL
      -- Source 2: kickoff window — Pinnacle present, kickoff < 24h. Reuses
      -- pinnacle_implied from kickoff_window CTE, joins back to exchange
      -- price for back_odds.
      SELECT
        'kickoff_window'::text AS source,
        kw.match_id AS match_id,
        kw.market_type AS market_type,
        kw.selection_name AS selection_name,
        os.back_odds::float8 AS back_odds,
        kw.pi::float8 AS pinnacle_implied
      FROM kickoff_window kw
      JOIN LATERAL (
        SELECT back_odds
        FROM odds_snapshots
        WHERE match_id = kw.match_id AND market_type = kw.market_type
          AND selection_name = kw.selection_name
          AND source = 'betfair_exchange' AND back_odds::float8 > 1.01
          AND snapshot_time >= NOW() - INTERVAL '15 minutes'
        ORDER BY snapshot_time DESC LIMIT 1
      ) os ON true
    `);
    const rows = ((r as any).rows ?? []) as Array<{
      source: "liquidity" | "kickoff_window";
      match_id: number;
      market_type: string;
      selection_name: string;
      back_odds: number;
      pinnacle_implied: number | null;
    }>;
    for (const row of rows) {
      const candidate: Stage1Candidate = {
        match_id: row.match_id,
        market_type: row.market_type,
        selection_name: row.selection_name,
        back_odds: row.back_odds,
        pinnacle_implied: row.pinnacle_implied,
        source: row.source,
      };
      if (row.source === "liquidity") liqRows.push(candidate);
      else kwRows.push(candidate);
    }
  } catch (err) {
    logger.warn({ err }, "stage1Watchlist: liquidity/kickoff query failed");
    result.errors++;
  }

  // Source 3 — qualifying movers (4%/30min + 4-condition quality filter)
  let moverCandidates: Stage1Candidate[] = [];
  const moverEnabled = await isMoverSignalEnabled();
  if (moverEnabled) {
    const movers = await detectQualifyingMovers();
    for (const m of movers) {
      // Log every mover for the n=200 A/B analysis (structured fields
      // per the locked spec). Bet outcome backfilled by settlement.
      try {
        await db.insert(complianceLogsTable).values({
          actionType: "mover_signal_detected",
          details: {
            matchId: m.match_id,
            marketType: m.market_type,
            selectionName: m.selection_name,
            mover_signal_present: true,
            mover_pct_30min: Number(m.mover_pct_30min.toFixed(2)),
            matched_volume_at_trigger: m.matched_volume_at_trigger,
            hours_to_kickoff: Number(m.hours_to_kickoff.toFixed(2)),
            current_back_odds: m.current_back_odds,
            prior_back_odds: m.prior_back_odds,
            bet_subsequently_placed: false, // backfilled by placement path
            bet_settled_outcome: null,       // backfilled by settlement path
          } as Record<string, unknown>,
          timestamp: new Date(),
        });
        result.movers_logged++;
      } catch (err) {
        logger.warn({ err, matchId: m.match_id }, "mover_signal_detected log write failed");
      }

      // Build candidate. Mover candidates may not have pinnacle_implied
      // yet (Tier 4 fixtures, Pinnacle not yet polled). Stage 2 inversion
      // gate will demote if no Pinnacle anchor — that's the right
      // behaviour: the mover surfaces the fixture, the sharp anchor
      // decides if it's actionable.
      const pinnRow = await fetchPinnacleImplied(m.match_id, m.market_type, m.selection_name);
      moverCandidates.push({
        match_id: m.match_id,
        market_type: m.market_type,
        selection_name: m.selection_name,
        back_odds: m.current_back_odds,
        pinnacle_implied: pinnRow,
        source: "mover",
        mover_meta: {
          mover_pct_30min: m.mover_pct_30min,
          matched_volume_at_trigger: m.matched_volume_at_trigger,
          hours_to_kickoff: m.hours_to_kickoff,
        },
      });
    }
  }

  // Dedup across sources — same (match × market × selection) may
  // surface in multiple. First-wins; source tag retained.
  const seen = new Set<string>();
  const unique: Stage1Candidate[] = [];
  for (const c of [...liqRows, ...kwRows, ...moverCandidates]) {
    const k = `${c.match_id}|${c.market_type}|${c.selection_name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(c);
    result.by_source[c.source]++;
  }
  result.candidates_emitted = unique.length;

  // NOTE: this builder emits candidates as a structured list. Actual
  // wiring to placePaperBet happens in Bundle 7.D (candidate prioritiser)
  // — Stage 1 is the source; 7.D is the allocator. For D3 we ship the
  // emission service + scheduler cron that COMPUTES the list every 5
  // min for observability + log it; 7.D will swap in the call to
  // placePaperBet via the prioritiser.
  if (unique.length > 0) {
    logger.info(
      {
        evaluatedAt: result.evaluated_at,
        emitted: result.candidates_emitted,
        bySource: result.by_source,
        moversLogged: result.movers_logged,
      },
      "Stage 1 watchlist computed (D3: observation only; D4 wires to placement)",
    );
  }

  return result;
}

async function fetchPinnacleImplied(
  matchId: number,
  marketType: string,
  selectionName: string,
): Promise<number | null> {
  try {
    const r = await db.execute(sql`
      SELECT pinnacle_implied::float8 AS pi
      FROM pinnacle_odds_snapshots
      WHERE match_id = ${matchId}
        AND market_type = ${marketType}
        AND selection_name = ${selectionName}
        AND bookmaker_slug = 'pinnacle'
        AND captured_at >= NOW() - INTERVAL '15 minutes'
      ORDER BY captured_at DESC
      LIMIT 1
    `);
    const row = ((r as any).rows ?? [])[0] as { pi: number | null } | undefined;
    return row?.pi ?? null;
  } catch {
    return null;
  }
}
