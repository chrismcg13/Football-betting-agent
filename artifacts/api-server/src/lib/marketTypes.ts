/**
 * 2026-05-08 (§4.3 of root-cause-analysis): central registry of market
 * types. The single source of truth for:
 *
 *   - Which market types are valid candidates from value-detection.
 *   - How each market type resolves to win/loss given final score / stats.
 *   - Whether each market needs match stats (corners, cards) or halftime
 *     scores beyond the final score.
 *
 * Why this exists: prior to today, market types were string literals scattered
 * across valueDetection.ts (generation) and paperTrading.ts:determineBetWon
 * (settlement). On 2026-05-08 we discovered TEAM_TOTAL_HOME_* / TEAM_TOTAL_AWAY_*
 * had been generated for weeks but never settled because determineBetWon's
 * switch was missing those cases. 285 bets accumulated stuck pending.
 *
 * Adding a new market type now requires:
 *   1. A registry entry here, with a resolver.
 *   2. Generator code in valueDetection.ts must reference MARKET_TYPES[id].
 *
 * Both ends are typed against the registry; drift becomes a compile-time
 * error rather than a silent runtime null-return.
 *
 * The startup invariant in services/startupChecks.ts asserts every
 * market_type that's ever appeared in paper_bets has a registry entry.
 */

export interface ResolveContext {
  homeScore: number;
  awayScore: number;
  totalCorners: number | null;
  totalCards: number | null;
  homeScoreHt: number | null;
  awayScoreHt: number | null;
}

/**
 * Resolver signature:
 *   true   — bet won
 *   false  — bet lost
 *   "void" — definitive push / refund (e.g. ASIAN_HANDICAP whole-line where
 *            adjusted score equals opposing). Data IS available; the
 *            outcome is "neither side wins". Settlement should void
 *            immediately and refund stake. Distinct from null.
 *   null   — cannot resolve (typically because a stat/HT field is missing).
 *            Routes through the 72h timeout retry in settlement; persistent
 *            null is a bug, not a recoverable state.
 *
 * 2026-05-10 (settlement bucket A fix): "void" added to differentiate
 * "definitive push" from "data missing". Pre-fix, AH whole-line PUSH
 * cases returned null and after 72h were force-settled as losses, which
 * was wrong. Now PUSH returns "void" and settles immediately.
 */
export type Resolver = (selection: string, ctx: ResolveContext) => boolean | "void" | null;

export interface MarketType {
  id: string;
  /**
   * 'final_score'      — needs only home/away final.
   * 'final_with_stats' — needs corners or cards in addition.
   * 'halftime'         — needs HT scores (and final score for match flow).
   */
  resolveFrom: "final_score" | "final_with_stats" | "halftime";
  resolve: Resolver;
}

// ── Helpers used by multiple resolvers ──────────────────────────────────────
function suffixThreshold(marketId: string): number {
  // Parse "..._05" → 0.5, "..._15" → 1.5, "..._25" → 2.5, "..._115" → 11.5
  const tail = marketId.split("_").pop()!;
  return parseInt(tail, 10) / 10;
}

function overUnder(threshold: number): Resolver {
  return (selection, ctx) => {
    const total = ctx.homeScore + ctx.awayScore;
    if (selection.startsWith("Over")) return total > threshold;
    if (selection.startsWith("Under")) return total < threshold;
    return null;
  };
}

function teamTotal(side: "HOME" | "AWAY", threshold: number): Resolver {
  return (selection, ctx) => {
    const teamScore = side === "HOME" ? ctx.homeScore : ctx.awayScore;
    if (selection.startsWith("Over")) return teamScore > threshold;
    if (selection.startsWith("Under")) return teamScore < threshold;
    return null;
  };
}

function totalCorners(threshold: number): Resolver {
  return (selection, ctx) => {
    if (ctx.totalCorners == null) return null;
    if (selection.startsWith("Over")) return ctx.totalCorners > threshold;
    if (selection.startsWith("Under")) return ctx.totalCorners < threshold;
    return null;
  };
}

function totalCards(threshold: number): Resolver {
  return (selection, ctx) => {
    if (ctx.totalCards == null) return null;
    if (selection.startsWith("Over")) return ctx.totalCards > threshold;
    if (selection.startsWith("Under")) return ctx.totalCards < threshold;
    return null;
  };
}

// ── ASIAN_TOTAL_GOALS ───────────────────────────────────────────────────────
// 2026-05-09 (Bundle 2): mirrors resolveAsianHandicap but operates on the
// goal TOTAL (homeScore + awayScore) instead of side-handicap. Same leg-by-
// leg WIN/PUSH/LOSS algorithm for quarter-line bets:
//   "Over 2.25": split into Over 2.0 (push if total=2) and Over 2.5
//                (no push). Combine: WIN+WIN -> true, LOSS+LOSS -> false,
//                WIN+PUSH -> half-win (binary collapse to true), LOSS+PUSH
//                -> half-loss (binary collapse to false).
// Selection format: "Over 2.25", "Under 2.75", "Over 3", etc. Single
// MARKET_TYPES["ASIAN_TOTAL_GOALS"] entry with line in selection (mirrors AH).
const resolveAsianTotalGoals: Resolver = (selection, ctx) => {
  const m = selection.match(/^(Over|Under)\s+([\d.]+)$/);
  if (!m) return null;
  const side = m[1] as "Over" | "Under";
  const threshold = parseFloat(m[2]!);
  if (!Number.isFinite(threshold)) return null;

  const total = ctx.homeScore + ctx.awayScore;
  const evalLeg = (line: number): "win" | "push" | "loss" => {
    if (side === "Over") {
      if (total > line) return "win";
      if (total < line) return "loss";
      return "push";
    }
    if (total < line) return "win";
    if (total > line) return "loss";
    return "push";
  };

  if (Math.abs(threshold % 1) === 0.25) {
    const lowerLeg = evalLeg(threshold - 0.25);
    const upperLeg = evalLeg(threshold + 0.25);
    if (lowerLeg === "win" && upperLeg === "win") return true;
    if (lowerLeg === "loss" && upperLeg === "loss") return false;
    if (lowerLeg === "push") return upperLeg === "win";
    if (upperLeg === "push") return lowerLeg === "win";
    return "void";
  }

  // Whole-line totals (e.g. "Over 2") push when total exactly equals the line.
  // 2026-05-10: was returning null; settlement loop's null→retry→72h-loss
  // path was settling pushes as losses.
  const outcome = evalLeg(threshold);
  if (outcome === "win") return true;
  if (outcome === "loss") return false;
  return "void";
};

// ── ASIAN_HANDICAP ──────────────────────────────────────────────────────────
// 2026-05-09: rewritten leg-by-leg evaluation. The original code's winLow/
// winHigh tests were mathematically incorrect — they checked whether the
// ORIGINAL handicap bet wins at a shifted line ("does Away +0.25 win at
// line 0?") rather than whether each leg's actual line wins ("does Away +0
// win?"). This meant Away +0.25 with 0-0 (a real-world half-WIN: Away +0
// pushes, Away +0.5 wins) was reported as winLow=TRUE/winHigh=FALSE and
// then either voided or — after my prior fix — incorrectly marked LOST.
//
// Correct algorithm: split a quarter-line bet into two adjacent half-goal
// lines (handicap−0.25 and handicap+0.25). Evaluate each leg as WIN/PUSH/
// LOSS. Combine:
//   WIN + WIN   → full win (true)
//   LOSS + LOSS → full loss (false)
//   WIN + PUSH  → half-win → binary collapse to true (won)
//   LOSS + PUSH → half-loss → binary collapse to false (lost)
//   WIN + LOSS  → impossible for adjacent half-goal lines with integer
//                 scores; return null defensively
//
// Live real-money bets defer to Betfair's listClearedOrders before reaching
// this function, so the partial-credit math is handled by Betfair natively.
// Only the paper/shadow learning path uses this resolver, where the binary
// collapse is the right semantics for the won/lost label feeding the model.
const resolveAsianHandicap: Resolver = (selection, ctx) => {
  const parts = selection.split(" ");
  const side = parts[0];
  const handicap = parseFloat(parts[1] ?? "0");

  // Evaluate one leg of an Asian handicap bet at a given handicap value.
  // Returns "win" (strict beat), "push" (exact tie at the line), or "loss".
  const evalLeg = (h: number): "win" | "push" | "loss" => {
    const adjustedSide = (side === "Home" ? ctx.homeScore : ctx.awayScore) + h;
    const opposing = side === "Home" ? ctx.awayScore : ctx.homeScore;
    if (adjustedSide > opposing) return "win";
    if (adjustedSide < opposing) return "loss";
    return "push";
  };

  if (Math.abs(handicap % 1) === 0.25) {
    const lowerLeg = evalLeg(handicap - 0.25);
    const upperLeg = evalLeg(handicap + 0.25);
    if (lowerLeg === "win" && upperLeg === "win") return true;
    if (lowerLeg === "loss" && upperLeg === "loss") return false;
    // Half-win/half-loss case: one leg pushes, the other decides.
    if (lowerLeg === "push") return upperLeg === "win";
    if (upperLeg === "push") return lowerLeg === "win";
    // win + loss across adjacent half-goal lines should not occur with
    // integer scores; be defensive and void rather than mis-settle.
    return "void";
  }

  // Whole or half handicaps: single-leg evaluation. Half-goal lines
  // (e.g. ±0.5) can't push (no integer score equals a half value).
  // Whole-goal lines (e.g. ±1) push when adjusted == opposing — settle
  // immediately as void (refund stake). 2026-05-10 fix: was returning
  // null which conflated push with data-missing; the 72h-retry path
  // then force-settled these as losses.
  const outcome = evalLeg(handicap);
  if (outcome === "win") return true;
  if (outcome === "loss") return false;
  return "void";
};

// ── The registry ─────────────────────────────────────────────────────────────
export const MARKET_TYPES: Record<string, MarketType> = {
  MATCH_ODDS: {
    id: "MATCH_ODDS",
    resolveFrom: "final_score",
    resolve: (selection, ctx) => {
      if (selection === "Home") return ctx.homeScore > ctx.awayScore;
      if (selection === "Draw") return ctx.homeScore === ctx.awayScore;
      if (selection === "Away") return ctx.awayScore > ctx.homeScore;
      return null;
    },
  },

  BTTS: {
    id: "BTTS",
    resolveFrom: "final_score",
    resolve: (selection, ctx) => {
      const both = ctx.homeScore > 0 && ctx.awayScore > 0;
      if (selection === "Yes") return both;
      if (selection === "No") return !both;
      return null;
    },
  },

  // DOUBLE_CHANCE removed 2026-05-09 (Bundle 1 / plan v3 §3B). Banned 2026-04-20,
  // no Pinnacle data in either oddspapi or api_football (0/0 rows verified),
  // mathematically dominated by MATCH_ODDS (DC alpha = MO alpha − vig). Still
  // listed in BANNED_MARKETS as defence in depth. Verified 0 pending DC bets
  // before removal; settlement only processes pending/pending_placement rows.

  ASIAN_HANDICAP: {
    id: "ASIAN_HANDICAP",
    resolveFrom: "final_score",
    resolve: resolveAsianHandicap,
  },

  ASIAN_TOTAL_GOALS: {
    id: "ASIAN_TOTAL_GOALS",
    resolveFrom: "final_score",
    resolve: resolveAsianTotalGoals,
  },

  // Match-total over/under
  OVER_UNDER_05: { id: "OVER_UNDER_05", resolveFrom: "final_score", resolve: overUnder(0.5) },
  OVER_UNDER_15: { id: "OVER_UNDER_15", resolveFrom: "final_score", resolve: overUnder(1.5) },
  OVER_UNDER_25: { id: "OVER_UNDER_25", resolveFrom: "final_score", resolve: overUnder(2.5) },
  OVER_UNDER_35: { id: "OVER_UNDER_35", resolveFrom: "final_score", resolve: overUnder(3.5) },
  OVER_UNDER_45: { id: "OVER_UNDER_45", resolveFrom: "final_score", resolve: overUnder(4.5) },

  // Team-total — added 2026-05-08 to fix the 285-pending-bet settlement gap
  TEAM_TOTAL_HOME_05: { id: "TEAM_TOTAL_HOME_05", resolveFrom: "final_score", resolve: teamTotal("HOME", 0.5) },
  TEAM_TOTAL_HOME_15: { id: "TEAM_TOTAL_HOME_15", resolveFrom: "final_score", resolve: teamTotal("HOME", 1.5) },
  TEAM_TOTAL_HOME_25: { id: "TEAM_TOTAL_HOME_25", resolveFrom: "final_score", resolve: teamTotal("HOME", 2.5) },
  TEAM_TOTAL_HOME_35: { id: "TEAM_TOTAL_HOME_35", resolveFrom: "final_score", resolve: teamTotal("HOME", 3.5) },
  TEAM_TOTAL_AWAY_05: { id: "TEAM_TOTAL_AWAY_05", resolveFrom: "final_score", resolve: teamTotal("AWAY", 0.5) },
  TEAM_TOTAL_AWAY_15: { id: "TEAM_TOTAL_AWAY_15", resolveFrom: "final_score", resolve: teamTotal("AWAY", 1.5) },
  TEAM_TOTAL_AWAY_25: { id: "TEAM_TOTAL_AWAY_25", resolveFrom: "final_score", resolve: teamTotal("AWAY", 2.5) },
  TEAM_TOTAL_AWAY_35: { id: "TEAM_TOTAL_AWAY_35", resolveFrom: "final_score", resolve: teamTotal("AWAY", 3.5) },

  // Stats-based
  TOTAL_CORNERS_75: { id: "TOTAL_CORNERS_75", resolveFrom: "final_with_stats", resolve: totalCorners(7.5) },
  TOTAL_CORNERS_85: { id: "TOTAL_CORNERS_85", resolveFrom: "final_with_stats", resolve: totalCorners(8.5) },
  TOTAL_CORNERS_95: { id: "TOTAL_CORNERS_95", resolveFrom: "final_with_stats", resolve: totalCorners(9.5) },
  TOTAL_CORNERS_105: { id: "TOTAL_CORNERS_105", resolveFrom: "final_with_stats", resolve: totalCorners(10.5) },
  TOTAL_CORNERS_115: { id: "TOTAL_CORNERS_115", resolveFrom: "final_with_stats", resolve: totalCorners(11.5) },

  TOTAL_CARDS_25: { id: "TOTAL_CARDS_25", resolveFrom: "final_with_stats", resolve: totalCards(2.5) },
  TOTAL_CARDS_35: { id: "TOTAL_CARDS_35", resolveFrom: "final_with_stats", resolve: totalCards(3.5) },
  TOTAL_CARDS_45: { id: "TOTAL_CARDS_45", resolveFrom: "final_with_stats", resolve: totalCards(4.5) },
  TOTAL_CARDS_55: { id: "TOTAL_CARDS_55", resolveFrom: "final_with_stats", resolve: totalCards(5.5) },

  // Halftime
  FIRST_HALF_RESULT: {
    id: "FIRST_HALF_RESULT",
    resolveFrom: "halftime",
    resolve: (selection, ctx) => {
      if (ctx.homeScoreHt == null || ctx.awayScoreHt == null) return null;
      if (selection === "Home") return ctx.homeScoreHt > ctx.awayScoreHt;
      if (selection === "Draw") return ctx.homeScoreHt === ctx.awayScoreHt;
      if (selection === "Away") return ctx.awayScoreHt > ctx.homeScoreHt;
      return null;
    },
  },
  FIRST_HALF_OU_05: {
    id: "FIRST_HALF_OU_05",
    resolveFrom: "halftime",
    resolve: (selection, ctx) => {
      if (ctx.homeScoreHt == null || ctx.awayScoreHt == null) return null;
      const total = ctx.homeScoreHt + ctx.awayScoreHt;
      if (selection.startsWith("Over")) return total > 0.5;
      if (selection.startsWith("Under")) return total < 0.5;
      return null;
    },
  },
  FIRST_HALF_OU_15: {
    id: "FIRST_HALF_OU_15",
    resolveFrom: "halftime",
    resolve: (selection, ctx) => {
      if (ctx.homeScoreHt == null || ctx.awayScoreHt == null) return null;
      const total = ctx.homeScoreHt + ctx.awayScoreHt;
      if (selection.startsWith("Over")) return total > 1.5;
      if (selection.startsWith("Under")) return total < 1.5;
      return null;
    },
  },

  // Bundle F2.B.G (2026-05-19): EUROPEAN_HANDICAP 3-way settlement.
  // Integer handicap applied to home team; 3 outcomes (Home / Draw /
  // Away) under the handicapped score. Selection format matches the
  // predictor in valueDetection: "<Home|Draw|Away> <handicap>"
  // (e.g. "Home -1", "Draw +2", "Away -2"). No push — every match
  // resolves to exactly one of the three sides.
  EUROPEAN_HANDICAP: {
    id: "EUROPEAN_HANDICAP",
    resolveFrom: "final_score",
    resolve: (selection, ctx) => {
      const parts = selection.split(" ");
      const side = parts[0];
      const handicap = parseFloat(parts[1] ?? "0");
      if (!Number.isFinite(handicap)) return null;
      // Only integer handicaps are valid EH lines (½ / ¼ go to AH).
      // Reject fractional handicaps defensively rather than silently
      // mis-settling — caller bug.
      if (handicap !== Math.trunc(handicap)) return null;
      const adjustedHome = ctx.homeScore + handicap;
      if (side === "Home") return adjustedHome > ctx.awayScore;
      if (side === "Draw") return adjustedHome === ctx.awayScore;
      if (side === "Away") return adjustedHome < ctx.awayScore;
      return null;
    },
  },

  // Bundle F2.B.F (2026-05-19): SECOND_HALF_RESULT settles from second-half
  // goals only (FT - HT). FIRST_HALF_RESULT already exists above and serves
  // the HALF_TIME_MATCH_ODDS market on the placement side. Selection format
  // matches MATCH_ODDS / FIRST_HALF_RESULT for consistency.
  SECOND_HALF_RESULT: {
    id: "SECOND_HALF_RESULT",
    resolveFrom: "halftime",
    resolve: (selection, ctx) => {
      if (ctx.homeScoreHt == null || ctx.awayScoreHt == null) return null;
      const home2H = ctx.homeScore - ctx.homeScoreHt;
      const away2H = ctx.awayScore - ctx.awayScoreHt;
      if (selection === "Home") return home2H > away2H;
      if (selection === "Draw") return home2H === away2H;
      if (selection === "Away") return away2H > home2H;
      return null;
    },
  },

  // Bundle F2.B.C (2026-05-19): register resolvers for the F2.A.10 Poisson
  // predictors (CORRECT_SCORE / HTFT / CLEAN_SHEET) so emitted bets can
  // actually settle. Without entries here, determineBetWon falls through
  // to null and bets accumulate pending. WIN_TO_NIL omitted: predictor
  // returns null at emission (runner-naming unresolved), so no bets land
  // in paper_bets — nothing to settle yet.
  CORRECT_SCORE: {
    id: "CORRECT_SCORE",
    resolveFrom: "final_score",
    resolve: (selection, ctx) => {
      const exact = selection.match(/^(\d+)\s*-\s*(\d+)$/);
      if (exact) {
        const h = parseInt(exact[1]!, 10);
        const a = parseInt(exact[2]!, 10);
        if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
        return ctx.homeScore === h && ctx.awayScore === a;
      }
      // Any Other Home/Away/Draw — Betfair aggregates scores ≥ 4 goals.
      // Matches predictCorrectScoreAnyOther cutoff=4 in valueDetection.ts.
      const lower = selection.toLowerCase().trim();
      if (!lower.includes("any other")) return null;
      const maxGoal = Math.max(ctx.homeScore, ctx.awayScore);
      if (maxGoal < 4) return false;
      if (lower.includes("home")) return ctx.homeScore > ctx.awayScore;
      if (lower.includes("away")) return ctx.awayScore > ctx.homeScore;
      if (lower.includes("draw")) return ctx.homeScore === ctx.awayScore;
      return null;
    },
  },

  HTFT: {
    id: "HTFT",
    resolveFrom: "halftime",
    resolve: (selection, ctx) => {
      if (ctx.homeScoreHt == null || ctx.awayScoreHt == null) return null;
      const m = selection.match(/^(Home|Draw|Away)\s*\/\s*(Home|Draw|Away)$/);
      if (!m) return null;
      const htClass = (h: number, a: number): "Home" | "Draw" | "Away" =>
        h > a ? "Home" : h < a ? "Away" : "Draw";
      return (
        htClass(ctx.homeScoreHt, ctx.awayScoreHt) === m[1] &&
        htClass(ctx.homeScore, ctx.awayScore) === m[2]
      );
    },
  },

  // Alias so bets written under either canonical name settle identically.
  // valueDetection.ts treats marketType === "HTFT" || === "HALF_TIME_FULL_TIME"
  // as the same Poisson predictor; same on settlement.
  HALF_TIME_FULL_TIME: {
    id: "HALF_TIME_FULL_TIME",
    resolveFrom: "halftime",
    resolve: (selection, ctx) => {
      if (ctx.homeScoreHt == null || ctx.awayScoreHt == null) return null;
      const m = selection.match(/^(Home|Draw|Away)\s*\/\s*(Home|Draw|Away)$/);
      if (!m) return null;
      const htClass = (h: number, a: number): "Home" | "Draw" | "Away" =>
        h > a ? "Home" : h < a ? "Away" : "Draw";
      return (
        htClass(ctx.homeScoreHt, ctx.awayScoreHt) === m[1] &&
        htClass(ctx.homeScore, ctx.awayScore) === m[2]
      );
    },
  },

  // CLEAN_SHEET_HOME — Home keeps a clean sheet iff awayScore == 0.
  // Mirrors predictCleanSheet(side='home') which returns P(away_score = 0).
  CLEAN_SHEET_HOME: {
    id: "CLEAN_SHEET_HOME",
    resolveFrom: "final_score",
    resolve: (selection, ctx) => {
      const yes = ctx.awayScore === 0;
      if (selection === "Yes") return yes;
      if (selection === "No") return !yes;
      return null;
    },
  },

  // CLEAN_SHEET_AWAY — Away keeps a clean sheet iff homeScore == 0.
  CLEAN_SHEET_AWAY: {
    id: "CLEAN_SHEET_AWAY",
    resolveFrom: "final_score",
    resolve: (selection, ctx) => {
      const yes = ctx.homeScore === 0;
      if (selection === "Yes") return yes;
      if (selection === "No") return !yes;
      return null;
    },
  },
};

/**
 * Resolve a bet outcome. Returns true (won), false (lost), or null
 * (cannot resolve — caller decides void/retry).
 *
 * If the marketId isn't in the registry, returns null AND logs a
 * warning — that's the assertion that catches future drift.
 */
export function resolveOutcome(
  marketId: string,
  selection: string,
  ctx: ResolveContext,
): boolean | "void" | null {
  const def = MARKET_TYPES[marketId];
  if (!def) {
    // We deliberately do NOT throw — settlement of a single unknown bet
    // shouldn't crash the whole cycle. But it logs loudly so the gap
    // is visible in monitoring.
    // eslint-disable-next-line no-console
    console.warn(`[marketTypes] resolveOutcome: unknown marketId "${marketId}" — returning null (will retry/void)`);
    return null;
  }
  return def.resolve(selection, ctx);
}

export function isMarketTypeRegistered(marketId: string): boolean {
  return marketId in MARKET_TYPES;
}

export function listRegisteredMarketTypes(): string[] {
  return Object.keys(MARKET_TYPES).sort();
}
