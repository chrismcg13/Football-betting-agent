/**
 * Bundle 7.A — Dual-track candidate classifier (2026-05-17)
 *
 * Every candidate at placement time is classified into one of two tracks:
 *
 *   sharp_anchored — Pinnacle implied is non-null AND/OR a non-Pinnacle
 *                    sharp (singbet, sbobet, ps3838) has a fresh row in
 *                    pinnacle_odds_snapshots for the exact (matchId,
 *                    marketType, selectionName). Gated by the inversion
 *                    gate (Bundle 5): 3pp net edge, multi-sharp Kelly
 *                    tiering, exposure caps. Bundle 7.C bypasses the 8
 *                    upstream gates for this track.
 *
 *   model_only     — No sharp anchor available. Gated by the legacy model
 *                    + opportunity_score path. RETAINS all 8 upstream
 *                    gates as the learning rail — shadow-only until the
 *                    scope proves edge via Wilson 95% LCB on win-rate +
 *                    CLV t-stat, then graduates to live via the existing
 *                    v_live_eligibility two-path view.
 *
 * The classification is computed at placement time (cheap query — one
 * indexed lookup into pinnacle_odds_snapshots) and stored on the bet
 * row in paper_bets.candidate_track for downstream per-track aggregation.
 *
 * Pinnacle/Singbet/SBOBet coverage is now maximised (post Bundle 1
 * E.1-E.5) so the vast majority of candidates will be sharp_anchored.
 * The model_only rail exists for the long tail.
 */

import { db, pinnacleOddsSnapshotsTable } from "@workspace/db";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

export type CandidateTrack = "sharp_anchored" | "model_only";

/** Sharps recognized as anchors. Mirror of SHARP_BOOK_SLUGS in inversionPipeline. */
const SHARP_BOOK_SLUGS = ["pinnacle", "singbet", "sbobet", "ps3838"];

/** Freshness window for a sharp snapshot to count as "available" at placement. */
const SHARP_FRESHNESS_MS = 10 * 60 * 1000; // 10 minutes

export interface TrackClassification {
  track: CandidateTrack;
  /** Slugs of sharps found within the freshness window. Empty if model_only. */
  sharpsPresent: string[];
  /** True if pinnacleImpliedFromBet was non-null at the call site (caller-supplied). */
  pinnacleAtCallSite: boolean;
}

/**
 * Classify a candidate's track. Cheap — one indexed query against
 * pinnacle_odds_snapshots. The caller passes pinnacleImpliedFromBet
 * because the value is typically already in scope at placement time
 * (no need to re-derive from DB).
 *
 * Logic:
 *   1. If pinnacleImpliedFromBet is non-null and positive → sharp_anchored
 *      (Pinnacle is the always-on paid anchor; presence is sufficient).
 *   2. Else, query pinnacle_odds_snapshots for any sharp slug
 *      (pinnacle / singbet / sbobet / ps3838) with captured_at within
 *      SHARP_FRESHNESS_MS for the exact (matchId, marketType,
 *      selectionName). If any row → sharp_anchored.
 *   3. Else → model_only.
 */
export async function classifyCandidateTrack(args: {
  matchId: number;
  marketType: string;
  selectionName: string;
  pinnacleImpliedFromBet: number | null;
}): Promise<TrackClassification> {
  const { matchId, marketType, selectionName, pinnacleImpliedFromBet } = args;

  // Fast path — Pinnacle is the always-on paid anchor. Non-null pinnacle
  // implied from the bet's own write-time data means Pinnacle priced
  // this selection; no need to round-trip the DB.
  if (pinnacleImpliedFromBet != null && pinnacleImpliedFromBet > 0) {
    return {
      track: "sharp_anchored",
      sharpsPresent: ["pinnacle"],
      pinnacleAtCallSite: true,
    };
  }

  // Slow path — Pinnacle absent from the bet row; check if any sharp
  // slug has a fresh snapshot. Uses the index added in Bundle 1 E.2
  // (idx_sharp_snapshots_book_lookup).
  const cutoff = new Date(Date.now() - SHARP_FRESHNESS_MS);
  const rows = await db
    .select({
      bookmakerSlug: pinnacleOddsSnapshotsTable.bookmakerSlug,
    })
    .from(pinnacleOddsSnapshotsTable)
    .where(
      and(
        eq(pinnacleOddsSnapshotsTable.matchId, matchId),
        eq(pinnacleOddsSnapshotsTable.marketType, marketType),
        eq(pinnacleOddsSnapshotsTable.selectionName, selectionName),
        inArray(pinnacleOddsSnapshotsTable.bookmakerSlug, SHARP_BOOK_SLUGS),
        gte(pinnacleOddsSnapshotsTable.capturedAt, cutoff),
      ),
    )
    .orderBy(desc(pinnacleOddsSnapshotsTable.capturedAt))
    .limit(SHARP_BOOK_SLUGS.length);

  const sharpsPresent = [...new Set(rows.map((r) => r.bookmakerSlug))];

  return {
    track: sharpsPresent.length > 0 ? "sharp_anchored" : "model_only",
    sharpsPresent,
    pinnacleAtCallSite: false,
  };
}
