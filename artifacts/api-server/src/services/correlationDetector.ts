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
 * Step 4:  Hard cap — max 4 bets per match
 */

import { db, learningNarrativesTable, complianceLogsTable, paperBetsTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { ValueBet } from "./valueDetection";
import { getConfigValue } from "./paperTrading";

// Read a haircut multiplier from config; clamp to (0, 1] to prevent
// pathological values (e.g. negative or >1 multipliers that would amplify
// rather than reduce risk). Returns the default if the key is unset or
// unparseable.
async function readHaircut(key: string, defaultValue: number): Promise<number> {
  try {
    const raw = await getConfigValue(key);
    if (!raw) return defaultValue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 1) return defaultValue;
    return n;
  } catch {
    return defaultValue;
  }
}

export interface BetCandidate extends ValueBet {
  stakeMultiplier: number;
  estimatedStake: number;
  enhanced?: boolean;
  // Phase 2.B.2: set by the gate dispatcher when classifying candidates;
  // 'A' = production track (full Kelly stake), 'B'|'C' = experiment track
  // (shadow-stake at 0.25× full Kelly with actual stake = 0). Undefined
  // means the gate hasn't classified the candidate yet.
  universeTier?: "A" | "B" | "C";
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
  // FIRST_HALF_RESULT + MATCH_ODDS same-side: positively correlated (same
  // team-strength thesis), but resolve independently — keep both, haircut
  // stakes 20% to right-size exposure. Historical: 35/36 paired bets were
  // same-side; aligned pairs delivered +39% ROI on £1.7k combined stake.
  // Different-side pairings are NOT flagged (genuinely independent edges).
  {
    market1: "FIRST_HALF_RESULT", sel1Includes: "Home",
    market2: "MATCH_ODDS", sel2Includes: "Home",
    thesis: "home dominance across both halves",
  },
  {
    market1: "FIRST_HALF_RESULT", sel1Includes: "Away",
    market2: "MATCH_ODDS", sel2Includes: "Away",
    thesis: "away dominance across both halves",
  },
  {
    market1: "FIRST_HALF_RESULT", sel1Includes: "Draw",
    market2: "MATCH_ODDS", sel2Includes: "Draw",
    thesis: "low-scoring stalemate across both halves",
  },
  // ─── Same-side BTTS+OU (goals direction) ────────────────────────────────
  // 60d data: 2-bet matches with BTTS+OU pairs returned -57% ROI on £652
  // stake (-£373). 3 of 8 had BOTH bets lose (correlated wrong). The
  // BTTS:Yes+OU:Over case is already dominated/dropped via CORRELATED_PAIRS,
  // but the bearish-side pairs (BTTS:No + OU:Under) and stronger-bullish
  // (BTTS:Yes + OU3.5:Over) are not. Tunable via complementary_haircut_btts_ou
  // (default 0.7 = 30% reduction).
  {
    market1: "BTTS", sel1Includes: "No",
    market2: "OVER_UNDER_25", sel2Includes: "Under",
    thesis: "low-tempo defensive game (BTTS No + Under 2.5)",
  },
  {
    market1: "BTTS", sel1Includes: "No",
    market2: "OVER_UNDER_35", sel2Includes: "Under",
    thesis: "low-tempo defensive game (BTTS No + Under 3.5)",
  },
  {
    market1: "BTTS", sel1Includes: "Yes",
    market2: "OVER_UNDER_35", sel2Includes: "Over",
    thesis: "high-tempo open game (BTTS Yes + Over 3.5)",
  },
  // ─── Same-side MO+OU (result + goals direction) ─────────────────────────
  // Mirror of existing MO:Away+OU:Over rule: home dominance can also express
  // as MO:Home + OU:Over (home wins by scoring multiple goals). Tunable via
  // complementary_haircut_mo_ou (default 0.8 = 20% reduction).
  {
    market1: "MATCH_ODDS", sel1Includes: "Home",
    market2: "OVER_UNDER_25", sel2Includes: "Over",
    thesis: "home dominance expressed via attacking output",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Home",
    market2: "OVER_UNDER_35", sel2Includes: "Over",
    thesis: "home dominance expressed via heavy attacking output",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Away",
    market2: "OVER_UNDER_35", sel2Includes: "Over",
    thesis: "away dominance expressed via heavy attacking output",
  },
  // ─── F2.A.18: cross-tempo correlation ──────────────────────────────────
  // Goals + corners + cards on the same direction share the underlying
  // "match-tempo" thesis. High-tempo open games produce more of all three;
  // low-tempo grinds produce fewer. Backing same-direction on multiple
  // tempo proxies at full Kelly over-leverages the same proposition.
  // Haircut keeps both bets (genuine independent edges measured on each)
  // but right-sizes the combined exposure. Config-tunable via
  // complementary_haircut_tempo (default 0.85 = 15% reduction).
  //
  // Per-pair list rather than a generic loop so settlement timing of each
  // pair stays explicit and tunable. Mirrors for Under direction.
  {
    market1: "OVER_UNDER_25", sel1Includes: "Over",
    market2: "TOTAL_CORNERS_95", sel2Includes: "Over",
    thesis: "high-tempo attacking match (goals + corners same direction)",
  },
  {
    market1: "OVER_UNDER_25", sel1Includes: "Over",
    market2: "TOTAL_CORNERS_105", sel2Includes: "Over",
    thesis: "high-tempo attacking match (goals + corners same direction)",
  },
  {
    market1: "OVER_UNDER_35", sel1Includes: "Over",
    market2: "TOTAL_CORNERS_105", sel2Includes: "Over",
    thesis: "high-tempo attacking match (goals + corners same direction)",
  },
  {
    market1: "OVER_UNDER_25", sel1Includes: "Over",
    market2: "TOTAL_CARDS_45", sel2Includes: "Over",
    thesis: "high-tempo open game (goals + cards same direction)",
  },
  {
    market1: "OVER_UNDER_35", sel1Includes: "Over",
    market2: "TOTAL_CARDS_55", sel2Includes: "Over",
    thesis: "high-tempo open game (goals + cards same direction)",
  },
  {
    market1: "TOTAL_CORNERS_95", sel1Includes: "Over",
    market2: "TOTAL_CARDS_45", sel2Includes: "Over",
    thesis: "high-tempo physical game (corners + cards same direction)",
  },
  // Mirror Under direction (low-tempo defensive thesis)
  {
    market1: "OVER_UNDER_25", sel1Includes: "Under",
    market2: "TOTAL_CORNERS_85", sel2Includes: "Under",
    thesis: "low-tempo defensive match (goals + corners same direction)",
  },
  {
    market1: "OVER_UNDER_15", sel1Includes: "Under",
    market2: "TOTAL_CORNERS_85", sel2Includes: "Under",
    thesis: "low-tempo defensive match (goals + corners same direction)",
  },
  {
    market1: "OVER_UNDER_25", sel1Includes: "Under",
    market2: "TOTAL_CARDS_35", sel2Includes: "Under",
    thesis: "low-tempo cautious game (goals + cards same direction)",
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
  // ─── BTTS:Yes + DOUBLE_CHANCE pairs (60d data: BTTS:Yes+DC:X2 leaked
  // -£147 over 9 occurrences with 5/9 BOTH-lost). BTTS:Yes is dominated by
  // any DC selection that includes the side BTTS Yes implies high-tempo for —
  // adding both pays vig twice for one underlying view.
  {
    market1: "BTTS", sel1Includes: "Yes",
    market2: "DOUBLE_CHANCE", sel2Includes: "X2",
    reason: "BTTS Yes + DC X2 share thesis 'away/draw side scoring' — correlated",
  },
  {
    market1: "BTTS", sel1Includes: "Yes",
    market2: "DOUBLE_CHANCE", sel2Includes: "1X",
    reason: "BTTS Yes + DC 1X share thesis 'home/draw side scoring' — correlated",
  },
  {
    market1: "BTTS", sel1Includes: "Yes",
    market2: "DOUBLE_CHANCE", sel2Includes: "Away or Draw",
    reason: "BTTS Yes + DC Away or Draw share thesis 'away/draw side scoring' — correlated",
  },
  {
    market1: "BTTS", sel1Includes: "Yes",
    market2: "DOUBLE_CHANCE", sel2Includes: "Home or Draw",
    reason: "BTTS Yes + DC Home or Draw share thesis 'home/draw side scoring' — correlated",
  },
  // ─── MO:Draw + DOUBLE_CHANCE subset domination ─────────────────────────
  // Draw is a strict subset of every DC selection containing "Draw".
  // Placing both is mathematically dominated.
  {
    market1: "MATCH_ODDS", sel1Includes: "Draw",
    market2: "DOUBLE_CHANCE", sel2Includes: "1X",
    reason: "Draw is a strict subset of DC 1X — dominated",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Draw",
    market2: "DOUBLE_CHANCE", sel2Includes: "X2",
    reason: "Draw is a strict subset of DC X2 — dominated",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Draw",
    market2: "DOUBLE_CHANCE", sel2Includes: "Home or Draw",
    reason: "Draw is a strict subset of DC Home or Draw — dominated",
  },
  {
    market1: "MATCH_ODDS", sel1Includes: "Draw",
    market2: "DOUBLE_CHANCE", sel2Includes: "Away or Draw",
    reason: "Draw is a strict subset of DC Away or Draw — dominated",
  },
  // ─── F2.A.18: Cards ↔ Booking Points proxy domination ──────────────────
  // BOOKING_POINTS = 10×yellows + 25×reds, so it's a weighted re-encoding
  // of the same card-count proposition. Backing both is paying vig twice
  // on one underlying. Keep higher-scored bet only.
  {
    market1: "TOTAL_CARDS_25", sel1Includes: "Over",
    market2: "TOTAL_BOOKING_POINTS_25", sel2Includes: "Over",
    reason: "Cards and Booking Points proxy the same underlying card-count proposition",
  },
  {
    market1: "TOTAL_CARDS_35", sel1Includes: "Over",
    market2: "TOTAL_BOOKING_POINTS_35", sel2Includes: "Over",
    reason: "Cards and Booking Points proxy the same underlying card-count proposition",
  },
  {
    market1: "TOTAL_CARDS_45", sel1Includes: "Over",
    market2: "TOTAL_BOOKING_POINTS_45", sel2Includes: "Over",
    reason: "Cards and Booking Points proxy the same underlying card-count proposition",
  },
  {
    market1: "TOTAL_CARDS_55", sel1Includes: "Over",
    market2: "TOTAL_BOOKING_POINTS_55", sel2Includes: "Over",
    reason: "Cards and Booking Points proxy the same underlying card-count proposition",
  },
  // (mirror for Under selections)
  {
    market1: "TOTAL_CARDS_25", sel1Includes: "Under",
    market2: "TOTAL_BOOKING_POINTS_25", sel2Includes: "Under",
    reason: "Cards and Booking Points proxy the same underlying card-count proposition",
  },
  {
    market1: "TOTAL_CARDS_35", sel1Includes: "Under",
    market2: "TOTAL_BOOKING_POINTS_35", sel2Includes: "Under",
    reason: "Cards and Booking Points proxy the same underlying card-count proposition",
  },
  {
    market1: "TOTAL_CARDS_45", sel1Includes: "Under",
    market2: "TOTAL_BOOKING_POINTS_45", sel2Includes: "Under",
    reason: "Cards and Booking Points proxy the same underlying card-count proposition",
  },
  // ─── F2.A.18: CORRECT_SCORE 0-0 ↔ Under 0.5 deterministic subset ──────
  // CS "0-0" wins iff Under 0.5 wins (same event). CS "0-0" is a strict
  // subset of Under 1.5 too. Keep higher-scored only.
  {
    market1: "CORRECT_SCORE", sel1Includes: "0 - 0",
    market2: "OVER_UNDER_05", sel2Includes: "Under",
    reason: "CS 0-0 is the same event as Under 0.5 — perfect subset",
  },
  // ─── F2.A.18: EUROPEAN_HANDICAP ↔ MATCH_ODDS same-side subset ─────────
  // EH "Home -1" wins iff "Home wins by 2+". This is a strict subset of
  // MO "Home" (which wins on any home win). Keep higher-scored only.
  {
    market1: "EUROPEAN_HANDICAP", sel1Includes: "Home -",
    market2: "MATCH_ODDS", sel2Includes: "Home",
    reason: "EH Home -N is a strict subset of MO Home — dominated",
  },
  {
    market1: "EUROPEAN_HANDICAP", sel1Includes: "Away -",
    market2: "MATCH_ODDS", sel2Includes: "Away",
    reason: "EH Away -N is a strict subset of MO Away — dominated",
  },
];

// ─── Threshold category helper ────────────────────────────────────────────────

// Returns a grouping key if the market is a threshold bet (goals OU, corners, cards).
// Bets in the same category on the same match are correlated and should be deduped.
//
// F2.A.18 (2026-05-19): booking_points added (Bundle O markets); first_half
// variants of goals + corners grouped separately (different propositions
// from full-match but same proposition across lines). HALF_TIME_SCORE and
// CORRECT_SCORE kept distinct from goals_ou — they're discrete outcomes,
// not threshold rolls, but cross-market implications are caught in
// CORRELATED_PAIRS below (CS 0-0 → Under 0.5, etc.).
export function getThresholdCategory(marketType: string): string | null {
  if (/^OVER_UNDER_\d+$/.test(marketType)) return "goals_ou";
  if (/^FIRST_HALF_OU_\d+$/.test(marketType)) return "first_half_goals_ou";
  if (marketType === "BTTS") return "btts";
  if (/^TOTAL_CORNERS_\d+$/.test(marketType)) return "corners";
  if (marketType === "FIRST_HALF_CORNERS_MULTI") return "first_half_corners";
  if (/^TOTAL_CARDS_\d+$/.test(marketType)) return "cards";
  if (/^TOTAL_BOOKING_POINTS_\d+$/.test(marketType) || marketType === "TOTAL_BOOKING_POINTS") return "booking_points";
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

  // ── 0C. Cross-cycle correlation check ─────────────────────────────────────
  // 60d data analysis: most 2-bet matches that lost both bets had the two
  // bets placed in DIFFERENT cycles (avg gap 16+ hours). The within-cycle
  // correlation rules can't catch these because by the time bet #2 is being
  // evaluated, bet #1 is already in the pending state — not in the candidate
  // pool. Fix: fetch pending bets per match upfront and drop any new candidate
  // that would form a CORRELATED_PAIRS subset-domination pair with one.
  // Estimated impact: -£250 to -£400 per 60d in eliminated cross-cycle leakage.
  const matchIds = [...byMatch.keys()];
  if (matchIds.length > 0) {
    const pendingBets = await db
      .select({
        matchId: paperBetsTable.matchId,
        marketType: paperBetsTable.marketType,
        selectionName: paperBetsTable.selectionName,
      })
      .from(paperBetsTable)
      .where(
        and(
          inArray(paperBetsTable.matchId, matchIds),
          inArray(paperBetsTable.status, ["pending", "pending_placement"]),
          sql`${paperBetsTable.deletedAt} IS NULL`,
        ),
      );

    const pendingByMatch = new Map<number, Array<{ marketType: string; selectionName: string }>>();
    for (const pb of pendingBets) {
      const arr = pendingByMatch.get(pb.matchId) ?? [];
      arr.push({ marketType: pb.marketType, selectionName: pb.selectionName });
      pendingByMatch.set(pb.matchId, arr);
    }

    let crossCycleDrops = 0;
    let crossCycleConflictDrops = 0;
    for (const [matchId, bets] of byMatch) {
      const pending = pendingByMatch.get(matchId);
      if (!pending || pending.length === 0) continue;

      // For each candidate on this match, check if it would form a correlated
      // OR conflicting pair with any pending bet. If yes, drop the candidate
      // (cannot drop the pending bet — it's already placed).
      //
      // Two rule sets are checked:
      //   - CORRELATED_PAIRS: subset-domination (BTTS Yes vs Over 2.5, etc.)
      //     drop the candidate to avoid paying vig twice on one underlying view.
      //   - CONFLICTING_RULES: mutually-exclusive selections (MO Home vs Draw,
      //     OU Over vs Under, BTTS Yes vs No). Backing both can never win
      //     together; second-cycle candidate is dead money. Within-cycle this
      //     is handled in step 1 by score comparison; across cycles the older
      //     pending bet wins by default — drop the candidate.
      for (const cand of [...bets]) {
        let dropped = false;
        for (const pb of pending) {
          let matched: CorrelatedPair | null = null;
          for (const rule of CORRELATED_PAIRS) {
            const candIs1 = ruleMatch(cand, rule.market1, rule.sel1Includes);
            const candIs2 = ruleMatch(cand, rule.market2, rule.sel2Includes);
            const pendIs1 = pb.marketType === rule.market1 && pb.selectionName.includes(rule.sel1Includes);
            const pendIs2 = pb.marketType === rule.market2 && pb.selectionName.includes(rule.sel2Includes);
            if ((candIs1 && pendIs2) || (candIs2 && pendIs1)) {
              matched = rule;
              break;
            }
          }
          if (matched) {
            const msg = `Cross-cycle correlation on ${cand.homeTeam} vs ${cand.awayTeam}: candidate ${cand.marketType}:${cand.selectionName} correlates with pending ${pb.marketType}:${pb.selectionName}. ${matched.reason}. Candidate dropped.`;
            narratives.push(msg);
            logger.info(
              {
                matchId,
                candidate: betKey(cand),
                pending: `${matchId}::${pb.marketType}::${pb.selectionName}`,
                rule: matched.reason,
              },
              "0C cross-cycle correlation: candidate dropped",
            );
            removeBet(selected, removed, byMatch, cand);
            crossCycleDrops++;
            dropped = true;
            break;
          }
        }
        if (dropped) continue;

        for (const pb of pending) {
          let matchedConflict: ConflictingRule | null = null;
          for (const rule of CONFLICTING_RULES) {
            const candIs1 = ruleMatch(cand, rule.market1, rule.sel1Includes);
            const candIs2 = ruleMatch(cand, rule.market2, rule.sel2Includes);
            const pendIs1 = pb.marketType === rule.market1 && pb.selectionName.includes(rule.sel1Includes);
            const pendIs2 = pb.marketType === rule.market2 && pb.selectionName.includes(rule.sel2Includes);
            if ((candIs1 && pendIs2) || (candIs2 && pendIs1)) {
              matchedConflict = rule;
              break;
            }
          }
          if (matchedConflict) {
            const msg = `Cross-cycle conflict on ${cand.homeTeam} vs ${cand.awayTeam}: candidate ${cand.marketType}:${cand.selectionName} cannot co-win with pending ${pb.marketType}:${pb.selectionName} — candidate dropped.`;
            narratives.push(msg);
            logger.info(
              {
                matchId,
                candidate: betKey(cand),
                pending: `${matchId}::${pb.marketType}::${pb.selectionName}`,
              },
              "0C cross-cycle conflict: candidate dropped",
            );
            removeBet(selected, removed, byMatch, cand);
            crossCycleConflictDrops++;
            break;
          }
        }
      }
    }
    if (crossCycleDrops > 0 || crossCycleConflictDrops > 0) {
      logger.info(
        { crossCycleDrops, crossCycleConflictDrops, totalCandidates: candidates.length },
        "0C cross-cycle correlation summary",
      );
    }
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
  // Per-rule haircut multiplier with config-tunable keys per rule family.
  // - FHR+MO: 0.8 default (35/36 paired bets historically same-side, +39% ROI)
  // - BTTS+OU same-side (No+Under, Yes+Over3.5): 0.7 default (60d data shows
  //   -57% ROI on £652 of these bets, stronger correlation → bigger haircut)
  // - MO+OU same-side: 0.8 default (mirrors existing MO:Away+OU:Over rule)
  const fhrMoHaircut = await readHaircut("complementary_haircut_fhr_mo", 0.8);
  const bttsOuHaircut = await readHaircut("complementary_haircut_btts_ou", 0.7);
  const moOuHaircut = await readHaircut("complementary_haircut_mo_ou", 0.8);
  // F2.A.18: cross-tempo haircut for goals/corners/cards same-direction pairs.
  // Default 0.85 (15% reduction) — mild positive correlation, lighter than
  // BTTS+OU (0.7) which is a stronger same-direction tie.
  const tempoHaircut = await readHaircut("complementary_haircut_tempo", 0.85);
  for (const [matchId, bets] of byMatch) {
    for (const rule of COMPLEMENTARY_RULES) {
      const b1 = bets.find((b) => ruleMatch(b, rule.market1, rule.sel1Includes));
      const b2 = bets.find((b) => ruleMatch(b, rule.market2, rule.sel2Includes));
      if (!b1 || !b2) continue;

      const isFhrMo =
        (rule.market1 === "FIRST_HALF_RESULT" && rule.market2 === "MATCH_ODDS") ||
        (rule.market1 === "MATCH_ODDS" && rule.market2 === "FIRST_HALF_RESULT");
      const isBttsOu =
        (rule.market1 === "BTTS" && rule.market2.startsWith("OVER_UNDER_")) ||
        (rule.market1.startsWith("OVER_UNDER_") && rule.market2 === "BTTS");
      const isMoOu =
        (rule.market1 === "MATCH_ODDS" && rule.market2.startsWith("OVER_UNDER_")) ||
        (rule.market1.startsWith("OVER_UNDER_") && rule.market2 === "MATCH_ODDS");
      // F2.A.18: detect cross-tempo pairs (goals/corners/cards in any
      // combination of two distinct families). Membership check on the
      // family prefixes rather than enumerating every line pair.
      const isTempo = ((): boolean => {
        const familyOf = (m: string): string | null => {
          if (m.startsWith("OVER_UNDER_") && !m.startsWith("OVER_UNDER_CORNERS")) return "goals";
          if (m.startsWith("TOTAL_CORNERS_")) return "corners";
          if (m.startsWith("TOTAL_CARDS_")) return "cards";
          return null;
        };
        const f1 = familyOf(rule.market1);
        const f2 = familyOf(rule.market2);
        return f1 != null && f2 != null && f1 !== f2;
      })();
      let haircut = 0.8;
      if (isFhrMo) haircut = fhrMoHaircut;
      else if (isBttsOu) haircut = bttsOuHaircut;
      else if (isMoOu) haircut = moOuHaircut;
      else if (isTempo) haircut = tempoHaircut;
      const reductionPct = Math.round((1 - haircut) * 100);

      const msg = `Complementary bets on ${b1.homeTeam} vs ${b1.awayTeam}: ${b1.selectionName} + ${b2.selectionName} share the thesis '${rule.thesis}'. Stakes reduced ${reductionPct}% to manage correlated risk.`;
      narratives.push(msg);
      logger.info({ matchId, thesis: rule.thesis, haircut, isFhrMo }, `Complementary bets detected — stakes reduced ${reductionPct}%`);

      for (const b of [b1, b2]) {
        const idx = selected.findIndex((s) => betKey(s) === betKey(b));
        if (idx >= 0) selected[idx]!.stakeMultiplier *= haircut;
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

  // ── 4. Production-rail cap: top-4 stay production, overflow → shadow ─────
  // 2026-05-09 (no-bet-dropped): previously the top 4 by score were kept and
  // the rest *removed*. That deleted independent-edge picks (correlation
  // dedup in steps 0A/0B/1 already removed correlated ones, so picks 5+ are
  // genuinely independent edges that just lost the priority race). They now
  // demote to placementTrack='shadow' so the model still gets the learning
  // signal at £0 capital risk. The shadow rail's per-match cap (12 in
  // placePaperBet) still protects against firehose volume.
  const MAX_BETS_PER_MATCH = 4;
  for (const [matchId, bets] of byMatch) {
    const activeBets = bets
      .filter((b) => selected.some((s) => betKey(s) === betKey(b)))
      .sort((a, b) => b.opportunityScore - a.opportunityScore);

    if (activeBets.length <= MAX_BETS_PER_MATCH) continue;

    const overflow = activeBets.slice(MAX_BETS_PER_MATCH);
    const kept = activeBets.slice(0, MAX_BETS_PER_MATCH);
    const productionOverflow = overflow.filter((b) => b.placementTrack !== "shadow");
    const alreadyShadow = overflow.length - productionOverflow.length;
    for (const b of productionOverflow) {
      const idx = selected.findIndex((s) => betKey(s) === betKey(b));
      if (idx >= 0) selected[idx]!.placementTrack = "shadow";
    }
    const msg = `Max-${MAX_BETS_PER_MATCH}-bets-per-match cap applied on ${activeBets[0]?.homeTeam ?? "match"} vs ${activeBets[0]?.awayTeam ?? ""}. Kept ${kept.map((b) => `${b.selectionName} (${b.opportunityScore.toFixed(0)})`).join(" & ")} on production. Demoted ${productionOverflow.length} lower-scored bets to shadow: ${productionOverflow.map((b) => b.selectionName).join(", ")}${alreadyShadow > 0 ? ` (plus ${alreadyShadow} already shadow)` : ""}.`;
    narratives.push(msg);
    logger.info(
      { matchId, keptCount: kept.length, demotedToShadow: productionOverflow.length, alreadyShadow },
      `max-${MAX_BETS_PER_MATCH}-bets-per-match cap — overflow demoted to shadow`,
    );
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
