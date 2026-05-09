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
 * Resolver signature: given the match state and selection name, returns
 * true (won), false (lost), or null (cannot resolve — typically because
 * a stat field is missing). Null routes through the 72h timeout retry
 * in settlement; persistent null is a bug, not a recoverable state.
 */
export type Resolver = (selection: string, ctx: ResolveContext) => boolean | null;

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
    return null;
  }

  // Whole or half handicaps: single-leg evaluation. Half-goal lines
  // (e.g. ±0.5) can't push (no integer score equals a half value).
  // Whole-goal lines (e.g. ±1) push when adjusted == opposing — for
  // shadow bets we treat that as void (return null).
  const outcome = evalLeg(handicap);
  if (outcome === "win") return true;
  if (outcome === "loss") return false;
  return null;
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

  DOUBLE_CHANCE: {
    id: "DOUBLE_CHANCE",
    resolveFrom: "final_score",
    resolve: (selection, ctx) => {
      if (selection === "Home or Draw" || selection === "1X") return ctx.homeScore >= ctx.awayScore;
      if (selection === "Away or Draw" || selection === "X2") return ctx.awayScore >= ctx.homeScore;
      if (selection === "Home or Away" || selection === "12") return ctx.homeScore !== ctx.awayScore;
      return null;
    },
  },

  ASIAN_HANDICAP: {
    id: "ASIAN_HANDICAP",
    resolveFrom: "final_score",
    resolve: resolveAsianHandicap,
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
): boolean | null {
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
