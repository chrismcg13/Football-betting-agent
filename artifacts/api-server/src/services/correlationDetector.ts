/**
 * Correlation Detector
 * Identifies complementary and conflicting bets on the same match
 * and applies stake adjustments or removals accordingly.
 */

import { db, learningNarrativesTable, complianceLogsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import type { ValueBet } from "./valueDetection";

export interface BetCandidate extends ValueBet {
  stakeMultiplier: number;
  estimatedStake: number;
  enhanced?: boolean;
}

export interface CorrelationResult {
  selectedBets: BetCandidate[];
  removedBets: BetCandidate[];
  narratives: string[];
}

// ─── Thesis definitions ───────────────────────────────────────────────────────

interface ComplementaryRule {
  market1: string; sel1Includes: string;
  market2: string; sel2Includes: string;
  thesis: string;
}

const COMPLEMENTARY_RULES: ComplementaryRule[] = [
  {
    market1: "MATCH_ODDS", sel1Includes: "Home",
    market2: "OVER_UNDER_25", sel2Includes: "Under",
    thesis: "dominant low-scoring home win",
  },
  {
    market1: "BTTS", sel1Includes: "Yes",
    market2: "OVER_UNDER_25", sel2Includes: "Over",
    thesis: "open, high-scoring game",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Away",
    market2: "OVER_UNDER_25", sel2Includes: "Over",
    thesis: "away team attacking dominance",
  },
];

interface ConflictingRule {
  market1: string; sel1Includes: string;
  market2: string; sel2Includes: string;
}

const CONFLICTING_RULES: ConflictingRule[] = [
  { market1: "MATCH_ODDS", sel1Includes: "Home", market2: "MATCH_ODDS", sel2Includes: "Draw" },
  { market1: "MATCH_ODDS", sel1Includes: "Draw", market2: "MATCH_ODDS", sel2Includes: "Away" },
  { market1: "OVER_UNDER_25", sel1Includes: "Over", market2: "OVER_UNDER_25", sel2Includes: "Under" },
  { market1: "OVER_UNDER_15", sel1Includes: "Over", market2: "OVER_UNDER_15", sel2Includes: "Under" },
  { market1: "OVER_UNDER_35", sel1Includes: "Over", market2: "OVER_UNDER_35", sel2Includes: "Under" },
  { market1: "BTTS", sel1Includes: "Yes", market2: "OVER_UNDER_15", sel2Includes: "Under" },
  { market1: "BTTS", sel1Includes: "Yes", market2: "BTTS", sel2Includes: "No" },
];

// ─── Helper ───────────────────────────────────────────────────────────────────

function ruleMatch(
  bet: BetCandidate,
  market: string,
  selIncludes: string,
): boolean {
  return bet.marketType === market && bet.selectionName.includes(selIncludes);
}

function betKey(b: BetCandidate): string {
  return `${b.matchId}::${b.marketType}::${b.selectionName}`;
}

// ─── Main detection function ──────────────────────────────────────────────────

export async function applyCorrelationDetection(
  candidates: BetCandidate[],
  bankroll: number,
): Promise<CorrelationResult> {
  const selected = [...candidates];
  const removed: BetCandidate[] = [];
  const narratives: string[] = [];

  // Group bets by matchId for fast lookup
  const byMatch = new Map<number, BetCandidate[]>();
  for (const bet of selected) {
    const arr = byMatch.get(bet.matchId) ?? [];
    arr.push(bet);
    byMatch.set(bet.matchId, arr);
  }

  // ── 1. Conflicting bet detection ──────────────────────────────────────────
  for (const [matchId, bets] of byMatch) {
    for (const rule of CONFLICTING_RULES) {
      const b1 = bets.find((b) => ruleMatch(b, rule.market1, rule.sel1Includes));
      const b2 = bets.find((b) => ruleMatch(b, rule.market2, rule.sel2Includes));
      if (!b1 || !b2) continue;

      // Keep the higher-scoring bet, remove the other
      const [keep, cancel] = b1.opportunityScore >= b2.opportunityScore ? [b1, b2] : [b2, b1];
      const msg = `Conflicting bets on ${b1.homeTeam} vs ${b1.awayTeam}: ${b1.marketType} ${b1.selectionName} vs ${b2.marketType} ${b2.selectionName}. Kept ${keep.selectionName} (score: ${keep.opportunityScore.toFixed(0)}) and cancelled ${cancel.selectionName} (score: ${cancel.opportunityScore.toFixed(0)}).`;
      narratives.push(msg);
      logger.info({ matchId, kept: betKey(keep), cancelled: betKey(cancel) }, "Conflicting bets — lower score cancelled");

      const cancelIdx = selected.findIndex((b) => betKey(b) === betKey(cancel));
      if (cancelIdx >= 0) {
        removed.push(selected[cancelIdx]!);
        selected.splice(cancelIdx, 1);
        // Also remove from byMatch
        const matchBets = byMatch.get(matchId) ?? [];
        const mi = matchBets.findIndex((b) => betKey(b) === betKey(cancel));
        if (mi >= 0) matchBets.splice(mi, 1);
      }
    }
  }

  // ── 2. Complementary bet detection ───────────────────────────────────────
  for (const [matchId, bets] of byMatch) {
    for (const rule of COMPLEMENTARY_RULES) {
      const b1 = bets.find((b) => ruleMatch(b, rule.market1, rule.sel1Includes));
      const b2 = bets.find((b) => ruleMatch(b, rule.market2, rule.sel2Includes));
      if (!b1 || !b2) continue;

      const msg = `Complementary bets on ${b1.homeTeam} vs ${b1.awayTeam}: ${b1.selectionName} + ${b2.selectionName} share the thesis '${rule.thesis}'. Stakes reduced 20% to manage correlated risk.`;
      narratives.push(msg);
      logger.info({ matchId, thesis: rule.thesis }, "Complementary bets detected — stakes reduced 20%");

      // Apply 0.8x multiplier to both bets
      for (const b of [b1, b2]) {
        const idx = selected.findIndex((s) => betKey(s) === betKey(b));
        if (idx >= 0) selected[idx]!.stakeMultiplier *= 0.8;
      }
    }
  }

  // ── 3. Overexposure check (total stake on single match > 4% bankroll) ────
  const maxMatchExposure = bankroll * 0.04;
  for (const [matchId, bets] of byMatch) {
    const activeBets = bets.filter((b) => selected.some((s) => betKey(s) === betKey(b)));
    const totalEstimated = activeBets.reduce((sum, b) => sum + b.estimatedStake * b.stakeMultiplier, 0);
    if (totalEstimated > maxMatchExposure) {
      const ratio = maxMatchExposure / totalEstimated;
      const msg = `Exposure cap hit on ${activeBets[0]?.homeTeam ?? "match"} vs ${activeBets[0]?.awayTeam ?? ""}. Total exposure reduced from £${totalEstimated.toFixed(2)} to £${maxMatchExposure.toFixed(2)}.`;
      narratives.push(msg);
      logger.info({ matchId, ratio }, "Overexposure — proportional stake reduction");
      for (const b of activeBets) {
        const idx = selected.findIndex((s) => betKey(s) === betKey(b));
        if (idx >= 0) selected[idx]!.stakeMultiplier *= ratio;
      }
    }
  }

  // Log narratives to DB
  for (const narrative of narratives) {
    await db.insert(learningNarrativesTable).values({
      narrativeType: "correlation_detection",
      narrativeText: narrative,
      relatedData: {},
      createdAt: new Date(),
    });
    await db.insert(complianceLogsTable).values({
      actionType: "correlation_detection",
      details: { narrative },
      timestamp: new Date(),
    });
  }

  return { selectedBets: selected, removedBets: removed, narratives };
}
