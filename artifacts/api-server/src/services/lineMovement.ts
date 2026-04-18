/**
 * Line Movement Service
 * Tracks odds movements over time, detects significant shifts,
 * and provides momentum signals for the prediction models.
 */

import { db, oddsHistoryTable, matchesTable, oddsSnapshotsTable } from "@workspace/db";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface LineMovementSummary {
  matchId: number;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selectionName: string;
  oddsAtFirstSeen: number;
  oddsAtLatest: number;
  oddsChangePct: number;
  direction: string;
  snapshotCount: number;
  hoursToKickoff: number;
  isSignificant: boolean;
}

export interface OddsMomentum {
  momentum: number; // positive = shortening (more likely), negative = drifting
  direction: "shortening" | "drifting" | "stable";
  changePct: number;
  isSignificant: boolean;
}

/** Get the odds momentum for a specific selection (for ML feature enrichment) */
export async function getOddsMomentum(
  matchId: number,
  marketType: string,
  selectionName: string,
): Promise<OddsMomentum> {
  const neutral: OddsMomentum = { momentum: 0, direction: "stable", changePct: 0, isSignificant: false };

  const history = await db
    .select({ odds: oddsHistoryTable.odds, snapshotTime: oddsHistoryTable.snapshotTime })
    .from(oddsHistoryTable)
    .where(
      and(
        eq(oddsHistoryTable.matchId, matchId),
        eq(oddsHistoryTable.marketType, marketType),
        eq(oddsHistoryTable.selectionName, selectionName),
      ),
    )
    .orderBy(desc(oddsHistoryTable.snapshotTime))
    .limit(5);

  if (history.length < 2) return neutral;

  const latest = Number(history[0]!.odds);
  const earliest = Number(history[history.length - 1]!.odds);

  if (earliest <= 0) return neutral;

  const changePct = ((latest - earliest) / earliest) * 100;
  const isSignificant = Math.abs(changePct) >= 5;

  let direction: "shortening" | "drifting" | "stable";
  let momentum: number;

  if (Math.abs(changePct) < 1) {
    direction = "stable";
    momentum = 0;
  } else if (latest < earliest) {
    direction = "shortening"; // odds getting shorter = market thinks more likely
    momentum = Math.min(Math.abs(changePct) / 10, 1); // positive momentum
  } else {
    direction = "drifting"; // odds getting longer = market thinks less likely
    momentum = -Math.min(Math.abs(changePct) / 10, 1); // negative momentum
  }

  return { momentum, direction, changePct, isSignificant };
}

/** Get all significant line movements for today's dashboard.
 *  Reads from odds_history (the canonical store of every snapshot, which
 *  already has oddsChangePct + direction + previousOdds + hoursToKickoff).
 *  Joins matches for home/away team labels.
 */
export async function getTodayLineMovements(): Promise<LineMovementSummary[]> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({
      matchId: oddsHistoryTable.matchId,
      marketType: oddsHistoryTable.marketType,
      selectionName: oddsHistoryTable.selectionName,
      previousOdds: oddsHistoryTable.previousOdds,
      odds: oddsHistoryTable.odds,
      oddsChangePct: oddsHistoryTable.oddsChangePct,
      direction: oddsHistoryTable.direction,
      hoursToKickoff: oddsHistoryTable.hoursToKickoff,
      snapshotTime: oddsHistoryTable.snapshotTime,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
    })
    .from(oddsHistoryTable)
    .leftJoin(matchesTable, eq(oddsHistoryTable.matchId, matchesTable.id))
    .where(
      and(
        gte(oddsHistoryTable.snapshotTime, todayStart),
        sql`abs(${oddsHistoryTable.oddsChangePct}) >= 5`,
      ),
    )
    .orderBy(desc(oddsHistoryTable.snapshotTime))
    .limit(50);

  return rows.map((r) => ({
    matchId: r.matchId ?? 0,
    homeTeam: r.homeTeam ?? "",
    awayTeam: r.awayTeam ?? "",
    marketType: r.marketType ?? "",
    selectionName: r.selectionName ?? "",
    oddsAtFirstSeen: r.previousOdds != null ? Number(r.previousOdds) : 0,
    oddsAtLatest: Number(r.odds),
    oddsChangePct: r.oddsChangePct != null ? Number(r.oddsChangePct) : 0,
    direction: r.direction ?? "stable",
    snapshotCount: 2,
    hoursToKickoff: r.hoursToKickoff != null ? Number(r.hoursToKickoff) : 0,
    isSignificant: true,
  }));
}

/** Get odds history sparkline for a specific match+market+selection */
export async function getOddsSparkline(
  matchId: number,
  marketType: string,
  selectionName: string,
): Promise<Array<{ time: string; odds: number; direction?: string }>> {
  const history = await db
    .select({
      odds: oddsHistoryTable.odds,
      snapshotTime: oddsHistoryTable.snapshotTime,
      direction: oddsHistoryTable.direction,
    })
    .from(oddsHistoryTable)
    .where(
      and(
        eq(oddsHistoryTable.matchId, matchId),
        eq(oddsHistoryTable.marketType, marketType),
        eq(oddsHistoryTable.selectionName, selectionName),
      ),
    )
    .orderBy(oddsHistoryTable.snapshotTime)
    .limit(20);

  return history.map((h) => ({
    time: h.snapshotTime.toISOString(),
    odds: Number(h.odds),
    direction: h.direction ?? undefined,
  }));
}

/** Get count of significant line movements today.
 *  Reads from odds_history (>= 5% absolute change matches the writer threshold).
 */
export async function getLineMovementsCountToday(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(oddsHistoryTable)
    .where(
      and(
        gte(oddsHistoryTable.snapshotTime, todayStart),
        sql`abs(${oddsHistoryTable.oddsChangePct}) >= 5`,
      ),
    );

  return rows[0]?.count ?? 0;
}

/** Compute best-available odds snapshot across all bookmakers for a selection */
export async function getBestAvailableOdds(
  matchId: number,
  marketType: string,
  selectionName: string,
): Promise<{ odds: number; bookmaker: string } | null> {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

  const rows = await db
    .select({
      backOdds: oddsSnapshotsTable.backOdds,
      source: oddsSnapshotsTable.source,
    })
    .from(oddsSnapshotsTable)
    .where(
      and(
        eq(oddsSnapshotsTable.matchId, matchId),
        eq(oddsSnapshotsTable.marketType, marketType),
        eq(oddsSnapshotsTable.selectionName, selectionName),
        gte(oddsSnapshotsTable.snapshotTime, twoHoursAgo),
      ),
    )
    .orderBy(desc(oddsSnapshotsTable.backOdds))
    .limit(1);

  if (!rows[0]?.backOdds) return null;

  return {
    odds: Number(rows[0].backOdds),
    bookmaker: rows[0].source?.replace("api_football_real:", "") ?? "unknown",
  };
}

logger.debug("Line movement service initialized");
