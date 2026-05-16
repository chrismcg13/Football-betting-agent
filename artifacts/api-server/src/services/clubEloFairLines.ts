import { db, paperBetsTable, matchesTable } from "@workspace/db";
import { sql, eq, and, isNull, inArray, desc } from "drizzle-orm";
import { logger } from "../lib/logger";

// Bundle 1B.2 (2026-05-16): Club Elo fair-line CLV benchmark.
//
// Independent third CLV anchor for European club fixtures where both teams
// appear in club_elo_snapshots. Closes the 40-50% Pinnacle-only coverage
// gap on mid-tier European leagues. Sits ALONGSIDE Pinnacle (tier 1) and
// Smarkets (tier 2, Bundle 1B.1 next) — never replaces them.
//
// Coverage discipline: club_elo_snapshots covers ~630 European clubs
// (top 1-2 divisions per country). Norwegian / Georgian / non-European
// fixtures are EXPECTED to fail coverage and stay flagged for special
// review (per feedback_subtract_before_restore). Do not extend Elo to
// other regions — that's a data-source decision requiring its own CBA.
//
// Derivation (Hvattum-Arntzen 2010, simplified):
//   ratingDiff   = elo_home + HOME_ADVANTAGE_ELO − elo_away
//   p_home_minus = 1 / (1 + 10^(−ratingDiff/400))         head-to-head P(home outscores away)
//   drawRate     = DRAW_MAX × exp(−(ratingDiff / DRAW_SCALE)²)   peaks at parity, decays to 0 at large margins
//   P(home_win)  = (1 − drawRate) × p_home_minus
//   P(away_win)  = (1 − drawRate) × (1 − p_home_minus)
//   P(draw)      = drawRate
//   fair odds    = 1 / probability
//
// HOME_ADVANTAGE_ELO is the operator-set default. Future enhancement could
// fit per-league via competition_config column (not in this bundle).

const HOME_ADVANTAGE_ELO = 60;
const DRAW_MAX = 0.30;        // historical draw rate cap
const DRAW_SCALE = 250;       // ratingDiff at which draw rate decays to ~37% of max

const STALE_ELO_DAYS = 14;    // Elo older than this is suspect — flag, don't compute

// Internal-market-type set this estimator can fair-line. We only score
// MATCH_ODDS, BTTS (derived from scoreline matrix elsewhere uses Elo too),
// and the three side-resolved markets (DRAW_NO_BET, ASIAN_HANDICAP) that
// reduce to home_vs_away under our Poisson-via-Elo derivation. Other
// markets get elo_data_quality='unsupported_market' and skip the compute.
const ELO_FAIR_LINE_MARKETS: ReadonlySet<string> = new Set([
  "MATCH_ODDS",
]);

// Map our market_type + selection_name to which fair-line outcome to use.
function selectionToOutcome(
  marketType: string,
  selectionName: string,
): "home" | "draw" | "away" | null {
  if (marketType !== "MATCH_ODDS") return null;
  const s = selectionName.trim();
  if (s === "Home") return "home";
  if (s === "Draw") return "draw";
  if (s === "Away") return "away";
  return null;
}

export interface FairLine {
  pHome: number;
  pDraw: number;
  pAway: number;
  oddsHome: number;
  oddsDraw: number;
  oddsAway: number;
  ratingDiff: number;
  drawRate: number;
}

export function computeEloFairLine(
  eloHome: number,
  eloAway: number,
  opts?: { homeAdvantage?: number },
): FairLine {
  const ratingDiff = eloHome + (opts?.homeAdvantage ?? HOME_ADVANTAGE_ELO) - eloAway;
  const pHomeMinus = 1 / (1 + Math.pow(10, -ratingDiff / 400));
  const drawRate = DRAW_MAX * Math.exp(-Math.pow(ratingDiff / DRAW_SCALE, 2));
  const pHome = (1 - drawRate) * pHomeMinus;
  const pAway = (1 - drawRate) * (1 - pHomeMinus);
  return {
    pHome,
    pDraw: drawRate,
    pAway,
    oddsHome: 1 / Math.max(pHome, 1e-6),
    oddsDraw: 1 / Math.max(drawRate, 1e-6),
    oddsAway: 1 / Math.max(pAway, 1e-6),
    ratingDiff,
    drawRate,
  };
}

interface EloLookup {
  elo: number;
  date: Date;
}

// Fetch latest Elo per team in one batched query. Returns Map<team_name, EloLookup>.
async function lookupLatestElos(teamNames: string[]): Promise<Map<string, EloLookup>> {
  const map = new Map<string, EloLookup>();
  if (teamNames.length === 0) return map;
  // SELECT DISTINCT ON (team_name) team_name, elo, date FROM club_elo_snapshots
  // WHERE team_name = ANY($1) ORDER BY team_name, date DESC;
  const rows = await db.execute<{
    team_name: string;
    elo: string;
    date: string;
  }>(sql`
    SELECT DISTINCT ON (team_name) team_name, elo::text AS elo, date::text AS date
    FROM club_elo_snapshots
    WHERE team_name = ANY(${teamNames}::text[])
    ORDER BY team_name, date DESC
  `);
  for (const r of rows.rows) {
    const elo = Number(r.elo);
    if (!Number.isFinite(elo)) continue;
    map.set(r.team_name, { elo, date: new Date(r.date) });
  }
  return map;
}

export interface EloBackfillResult {
  scanned: number;
  computed: number;
  perQuality: Record<string, number>;
  durationMs: number;
}

/**
 * Backfill closing_elo_fair_odds + clv_elo_pct on pending or recently-settled
 * paper_bets where the column is NULL. Designed to run on a 15-min cron;
 * idempotent (NULL filter), bounded per-pass.
 *
 * Read pattern: one indexed JOIN paper_bets ↔ matches, one batched Elo
 * lookup, one UPDATE per bet. No per-bet round trips beyond the UPDATE.
 */
export async function backfillEloFairLines(opts?: {
  maxBets?: number;
}): Promise<EloBackfillResult> {
  const start = Date.now();
  const maxBets = opts?.maxBets ?? 1000;
  const perQuality: Record<string, number> = {};
  const bump = (q: string) => {
    perQuality[q] = (perQuality[q] ?? 0) + 1;
  };

  // Pull pending bets + bets settled in last 7 days where elo line not yet
  // computed. The 7-day backfill window lets us populate historical bets
  // for backtest analysis the first time the cron runs after deploy; in
  // steady state, almost all bets are pending and the join is cheap.
  const pending = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      oddsAtPlacement: paperBetsTable.oddsAtPlacement,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        isNull(paperBetsTable.eloDataQuality),
        sql`${paperBetsTable.placedAt} >= NOW() - INTERVAL '7 days'`,
      ),
    )
    .limit(maxBets);

  if (pending.length === 0) {
    return { scanned: 0, computed: 0, perQuality, durationMs: Date.now() - start };
  }

  // Distinct team-name set across the batch — one indexed lookup, not N.
  const teamSet = new Set<string>();
  for (const bet of pending) {
    teamSet.add(bet.homeTeam);
    teamSet.add(bet.awayTeam);
  }
  const eloMap = await lookupLatestElos([...teamSet]);

  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_ELO_DAYS * 24 * 60 * 60 * 1000);

  let computed = 0;
  for (const bet of pending) {
    const outcome = selectionToOutcome(bet.marketType, bet.selectionName);
    if (outcome == null) {
      await db
        .update(paperBetsTable)
        .set({ eloDataQuality: "unsupported_market" })
        .where(eq(paperBetsTable.id, bet.id));
      bump("unsupported_market");
      continue;
    }

    const homeElo = eloMap.get(bet.homeTeam);
    const awayElo = eloMap.get(bet.awayTeam);

    if (!homeElo && !awayElo) {
      await db
        .update(paperBetsTable)
        .set({ eloDataQuality: "no_coverage" })
        .where(eq(paperBetsTable.id, bet.id));
      bump("no_coverage");
      continue;
    }
    if (!homeElo) {
      await db
        .update(paperBetsTable)
        .set({ eloDataQuality: "home_missing" })
        .where(eq(paperBetsTable.id, bet.id));
      bump("home_missing");
      continue;
    }
    if (!awayElo) {
      await db
        .update(paperBetsTable)
        .set({ eloDataQuality: "away_missing" })
        .where(eq(paperBetsTable.id, bet.id));
      bump("away_missing");
      continue;
    }
    if (homeElo.date < staleCutoff || awayElo.date < staleCutoff) {
      await db
        .update(paperBetsTable)
        .set({ eloDataQuality: "stale_elo" })
        .where(eq(paperBetsTable.id, bet.id));
      bump("stale_elo");
      continue;
    }

    const line = computeEloFairLine(homeElo.elo, awayElo.elo);
    const closingOdds = outcome === "home" ? line.oddsHome
                      : outcome === "draw" ? line.oddsDraw
                      : line.oddsAway;

    const placementOdds = Number(bet.oddsAtPlacement);
    // Same CLV convention as the existing Pinnacle path (oddsPapi.ts:3488):
    //   clv_pct = ((placement - closing) / closing) × 100
    const clvEloPct = closingOdds > 1 && Number.isFinite(placementOdds)
      ? Math.round(((placementOdds - closingOdds) / closingOdds) * 100 * 1000) / 1000
      : null;

    await db
      .update(paperBetsTable)
      .set({
        closingEloFairOdds: String(Math.round(closingOdds * 10000) / 10000),
        ...(clvEloPct != null ? { clvEloPct: String(clvEloPct) } : {}),
        eloDataQuality: "both_teams_covered",
      })
      .where(eq(paperBetsTable.id, bet.id));
    computed++;
    bump("both_teams_covered");
  }

  const durationMs = Date.now() - start;
  logger.info(
    { scanned: pending.length, computed, perQuality, durationMs },
    "Bundle 1B.2 Club Elo fair-line backfill complete",
  );
  return { scanned: pending.length, computed, perQuality, durationMs };
}
