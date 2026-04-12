/**
 * Correlation Detector
 * Identifies correlated, conflicting and complementary bets on the same match
 * and applies deduplication, removals, and stake adjustments.
 *
 * Step 0A: Same-category threshold dedup (goals OU / corners / cards)
 * Step 0B: Cross-market correlation dedup (BTTS Yes + Over 2.5, Home + 1X)
 * Step 1:  Conflicting bet removal (Over vs Under same line)
 * Step 2:  Complementary bet stake reduction
 * Step 3:  Per-match overexposure stake reduction
 * Step 4:  Hard cap — max 2 bets per match
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

// Cross-market correlation pairs — if both present on same match, keep higher-scored only
interface CorrelatedPair {
  market1: string; sel1Includes: string;
  market2: string; sel2Includes: string;
  reason: string;
}

const CORRELATED_PAIRS: CorrelatedPair[] = [
  {
    market1: "BTTS", sel1Includes: "Yes",
    market2: "OVER_UNDER_25", sel2Includes: "Over",
    reason: "BTTS Yes and Over 2.5 Goals are strongly correlated — both require 3+ goals",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Home",
    market2: "DOUBLE_CHANCE", sel2Includes: "1X",
    reason: "Home Win is a subset of Double Chance 1X — highly correlated",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Home",
    market2: "DOUBLE_CHANCE", sel2Includes: "Home or Draw",
    reason: "Home Win is a subset of Double Chance Home or Draw — highly correlated",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Away",
    market2: "DOUBLE_CHANCE", sel2Includes: "X2",
    reason: "Away Win is a subset of Double Chance X2 — highly correlated",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Away",
    market2: "DOUBLE_CHANCE", sel2Includes: "Away or Draw",
    reason: "Away Win is a subset of Double Chance Away or Draw — highly correlated",
  },
  {
    market1: "BTTS", sel1Includes: "Yes",
    market2: "OVER_UNDER_15", sel2Includes: "Over",
    reason: "BTTS Yes implies both teams score, making Over 1.5 near-certain — correlated",
  },
];

// ─── Threshold category helper ────────────────────────────────────────────────

// Returns a grouping key if the market is a threshold bet (goals OU, corners, cards).
// Bets in the same category on the same match are correlated and should be deduped.
export function getThresholdCategory(marketType: string): string | null {
  if (/^OVER_UNDER_\d+$/.test(marketType)) return "goals_ou";
  if (/^TOTAL_CORNERS_\d+$/.test(marketType)) return "corners";
  if (/^TOTAL_CARDS_\d+$/.test(marketType)) return "cards";
  return null;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function ruleMatch(
  bet: BetCandidate,
  market: string,
  selIncludes: string,
): boolean {
  return bet.marketType === market && bet.selectionName.includes(selIncludes);
}

function betKey(b: Pick<BetCandidate, "matchId" | "marketType" | "selectionName">): string {
  return `${b.matchId}::${b.marketType}::${b.selectionName}`;
}

function removeBet(
  selected: BetCandidate[],
  removed: BetCandidate[],
  byMatch: Map<number, BetCandidate[]>,
  target: BetCandidate,
): void {
  const idx = selected.findIndex((b) => betKey(b) === betKey(target));
  if (idx >= 0) {
    removed.push(selected[idx]!);
    selected.splice(idx, 1);
  }
  const matchBets = byMatch.get(target.matchId) ?? [];
  const mi = matchBets.findIndex((b) => betKey(b) === betKey(target));
  if (mi >= 0) matchBets.splice(mi, 1);
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

  // ── 0A. Same-category threshold dedup ────────────────────────────────────
  // Goals OU / Corners / Cards — multiple thresholds on the same match are
  // correlated (if Under 3.5 wins, Under 4.5 and 5.5 automatically win too).
  // Keep only the bet with the highest opportunity score per category per match.
  const processedCategoryKeys = new Set<string>();
  for (const [matchId, bets] of byMatch) {
    // Collect all threshold categories present on this match
    const categories = new Set(
      bets.map((b) => getThresholdCategory(b.marketType)).filter(Boolean) as string[],
    );
    for (const cat of categories) {
      const key = `${matchId}:${cat}`;
      if (processedCategoryKeys.has(key)) continue;
      processedCategoryKeys.add(key);

      const catBets = bets.filter((b) => getThresholdCategory(b.marketType) === cat);
      if (catBets.length <= 1) continue;

      catBets.sort((a, b) => b.opportunityScore - a.opportunityScore);
      const [keep, ...discard] = catBets;
      if (!keep) continue;

      const removedNames = discard.map((d) => `${d.selectionName} (${d.marketType}, score: ${d.opportunityScore.toFixed(0)})`).join(", ");
      const msg = `Deduplicated ${discard.length} correlated ${cat} threshold bet(s) on ${keep.homeTeam} vs ${keep.awayTeam}. Kept ${keep.selectionName} (${keep.marketType}, score: ${keep.opportunityScore.toFixed(0)}), removed: ${removedNames}.`;
      narratives.push(msg);
      logger.info({ matchId, category: cat, kept: keep.marketType, removedCount: discard.length }, `0A threshold dedup: ${msg}`);

      for (const d of discard) {
        removeBet(selected, removed, byMatch, d);
      }
    }
  }

  // ── 0B. Cross-market correlation dedup ───────────────────────────────────
  // Pairs like BTTS Yes + Over 2.5, or Home + 1X, are highly correlated.
  // Keep only the higher-scored bet.
  for (const [matchId, bets] of byMatch) {
    for (const rule of CORRELATED_PAIRS) {
      const b1 = bets.find((b) => ruleMatch(b, rule.market1, rule.sel1Includes));
      const b2 = bets.find((b) => ruleMatch(b, rule.market2, rule.sel2Includes));
      if (!b1 || !b2) continue;

      const [keep, cancel] = b1.opportunityScore >= b2.opportunityScore ? [b1, b2] : [b2, b1];
      const msg = `Correlated markets on ${b1.homeTeam} vs ${b1.awayTeam}: ${rule.reason}. Kept ${keep.selectionName} (score: ${keep.opportunityScore.toFixed(0)}), removed ${cancel.selectionName} (score: ${cancel.opportunityScore.toFixed(0)}).`;
      narratives.push(msg);
      logger.info({ matchId, kept: betKey(keep), cancelled: betKey(cancel) }, `0B cross-market dedup: correlated pair removed`);
      removeBet(selected, removed, byMatch, cancel);
    }
  }

  // ── 1. Conflicting bet detection ──────────────────────────────────────────
  for (const [matchId, bets] of byMatch) {
    for (const rule of CONFLICTING_RULES) {
      const b1 = bets.find((b) => ruleMatch(b, rule.market1, rule.sel1Includes));
      const b2 = bets.find((b) => ruleMatch(b, rule.market2, rule.sel2Includes));
      if (!b1 || !b2) continue;

      const [keep, cancel] = b1.opportunityScore >= b2.opportunityScore ? [b1, b2] : [b2, b1];
      const msg = `Conflicting bets on ${b1.homeTeam} vs ${b1.awayTeam}: ${b1.marketType} ${b1.selectionName} vs ${b2.marketType} ${b2.selectionName}. Kept ${keep.selectionName} (score: ${keep.opportunityScore.toFixed(0)}) and cancelled ${cancel.selectionName} (score: ${cancel.opportunityScore.toFixed(0)}).`;
      narratives.push(msg);
      logger.info({ matchId, kept: betKey(keep), cancelled: betKey(cancel) }, "Conflicting bets — lower score cancelled");
      removeBet(selected, removed, byMatch, cancel);
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

  // ── 4. Hard cap: max 2 bets per match ────────────────────────────────────
  // After all dedup, if any match still has >2 bets, keep only the top 2 by
  // opportunity score. This prevents over-concentration on a single fixture.
  for (const [matchId, bets] of byMatch) {
    const activeBets = bets
      .filter((b) => selected.some((s) => betKey(s) === betKey(b)))
      .sort((a, b) => b.opportunityScore - a.opportunityScore);

    if (activeBets.length <= 2) continue;

    const toRemove = activeBets.slice(2);
    const kept = activeBets.slice(0, 2);
    const msg = `Max-2-bets-per-match cap applied on ${activeBets[0]?.homeTeam ?? "match"} vs ${activeBets[0]?.awayTeam ?? ""}. Kept ${kept.map((b) => `${b.selectionName} (${b.opportunityScore.toFixed(0)})`).join(" & ")}. Removed ${toRemove.length} lower-scored bets: ${toRemove.map((b) => b.selectionName).join(", ")}.`;
    narratives.push(msg);
    logger.info({ matchId, keptCount: 2, removedCount: toRemove.length }, "4 max-bets-per-match cap applied");
    for (const b of toRemove) {
      removeBet(selected, removed, byMatch, b);
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
