/**
 * Task 11 — synthetic CLV writer (Phase 3d.3).
 *
 * Backfills paper_bets.synthetic_clv_pct + consensus_quality +
 * clv_consensus_sources for recently-settled bets where consensus
 * snapshots exist near the bet's kickoff_time. Shadow column — does
 * NOT touch the existing clv_pct / clv_source.
 *
 * Formula matches the existing clv_pct convention (see betfairLive.ts:1008,
 * paperTrading.ts:3288):
 *
 *   synthetic_closing_odds = 1 / consensus_probability_at_kickoff
 *   synthetic_clv_pct = ((placement_odds - synthetic_closing_odds)
 *                        / synthetic_closing_odds) * 100
 *
 * Positive value = we got better odds than the consensus close
 * (we beat the sharp).
 * Negative value = market moved against us by close.
 *
 * Cron: every 15 min. Scans paper_bets where settled_at < NOW (won/lost)
 * AND synthetic_clv_pct IS NULL AND placed_at >= analysis_start_date
 * (default 2026-05-03). Caps to 500 bets per run to bound DB load.
 */

import { db, paperBetsTable, matchesTable, agentConfigTable } from "@workspace/db";
import { and, eq, isNull, sql, gte, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import { computeConsensusForSnapshot } from "./sharpConsensus";

const DEFAULT_ANALYSIS_START_DATE = "2026-05-03";
const BACKFILL_BATCH_SIZE = 500;
const KICKOFF_WINDOW_MS = 5 * 60 * 1000; // ±5 min around kickoff

async function getAnalysisStartDate(): Promise<string> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, "analysis_start_date"));
  return rows[0]?.value ?? DEFAULT_ANALYSIS_START_DATE;
}

export interface SyntheticClvResult {
  scanned: number;
  consensus_found: number;
  rows_written: number;
  duration_ms: number;
}

export async function runSyntheticClvBackfill(): Promise<SyntheticClvResult> {
  const startedAt = Date.now();
  const analysisStart = await getAnalysisStartDate();

  // 1. Find recently-settled bets with no synthetic_clv_pct yet.
  const candidates = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      selectionCanonical: paperBetsTable.selectionCanonical,
      placementOdds: paperBetsTable.oddsAtPlacement,
    })
    .from(paperBetsTable)
    .where(
      and(
        isNull(paperBetsTable.syntheticClvPct),
        gte(paperBetsTable.placedAt, sql`${analysisStart}::date`),
        sql`${paperBetsTable.status} IN ('won','lost')`,
        sql`${paperBetsTable.deletedAt} IS NULL`,
      ),
    )
    .limit(BACKFILL_BATCH_SIZE);

  if (candidates.length === 0) {
    return {
      scanned: 0,
      consensus_found: 0,
      rows_written: 0,
      duration_ms: Date.now() - startedAt,
    };
  }

  // 2. Look up the kickoff times for the relevant matches in one shot.
  const matchIds = [...new Set(candidates.map((c) => c.matchId))];
  const matchRows = await db
    .select({ id: matchesTable.id, kickoffTime: matchesTable.kickoffTime })
    .from(matchesTable)
    .where(inArray(matchesTable.id, matchIds));
  const kickoffById = new Map<number, Date>(
    matchRows
      .filter((r) => r.kickoffTime != null)
      .map((r) => [r.id, new Date(r.kickoffTime!)]),
  );

  // 3. Per-bet consensus lookup, then write back synthetic_clv_pct.
  let consensusFound = 0;
  let rowsWritten = 0;
  for (const bet of candidates) {
    const kickoff = kickoffById.get(bet.matchId);
    if (!kickoff) continue;
    const placementOdds = Number(bet.placementOdds);
    if (!Number.isFinite(placementOdds) || placementOdds <= 1) continue;

    const consensus = await computeConsensusForSnapshot({
      matchId: bet.matchId,
      marketType: bet.marketType,
      selectionName: bet.selectionCanonical ?? bet.selectionName,
      snapshotAt: kickoff,
      windowMs: KICKOFF_WINDOW_MS,
    });
    if (!consensus) continue;
    consensusFound++;

    const closingOdds = consensus.consensusFairOdds;
    if (!Number.isFinite(closingOdds) || closingOdds <= 1) continue;
    const clvPctRaw = ((placementOdds - closingOdds) / closingOdds) * 100;
    const syntheticClvPct = Math.round(clvPctRaw * 1000) / 1000;

    await db
      .update(paperBetsTable)
      .set({
        syntheticClvPct: String(syntheticClvPct),
        consensusQuality: consensus.consensusQuality,
        clvConsensusSources: consensus.contributingSources as never,
      })
      .where(eq(paperBetsTable.id, bet.id));
    rowsWritten++;
  }

  const duration_ms = Date.now() - startedAt;
  const result: SyntheticClvResult = {
    scanned: candidates.length,
    consensus_found: consensusFound,
    rows_written: rowsWritten,
    duration_ms,
  };
  logger.info(result, "Synthetic CLV backfill complete");
  return result;
}
