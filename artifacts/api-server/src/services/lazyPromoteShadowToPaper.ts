/**
 * Phase 3 Path C+ (2026-05-08): lazy shadow→paper promotion.
 *
 * Pre-fix: when valueDetection emits a bet but no recent betfair_exchange
 * snapshot exists for the (match, market, selection) tuple, the bet routes
 * to shadow track (£0 stake). Once routed, even if exchange data appears
 * later (closer to kickoff), the bet stays shadow forever — the dedup
 * partial unique index blocks any later paper bet on the same selection.
 *
 * Result observed: ~87% of Tier A bets routed shadow due to missing-
 * exchange-data, with avg edge 22.81%. The model finds strong edges that
 * never get capital deployment.
 *
 * Fix: every 5 min, scan pending Tier A shadow bets where:
 *   - kickoff in next 6h
 *   - betfair_exchange has a fresh snapshot (≤30 min) for the specific
 *     (match_id, market_type, selection_name)
 *   - the bet's selection_canonical isn't already a pending paper bet
 * Re-route by promoting in place: bet_track='paper', stake=fresh Kelly,
 * potential_profit=stake×(odds-1), shadow_stake/shadow_stake_kelly_fraction=NULL.
 *
 * Uses the bet's stored opportunity_score + edge to compute Kelly fraction
 * (no re-prediction; the original valueDetection decision stands). If the
 * fresh Kelly stake < £2 (Betfair minimum), the bet stays shadow — no
 * regression to a sub-minimum paper stake. Idempotent — already-paper rows
 * are skipped.
 *
 * Pre-flip: stake is computed but the bet stays a paper-mode bet (no
 * Betfair placement). Post-flip: same bet enters the live placement
 * pipeline via paperTrading.ts handlers when isLiveMode().
 */

import { db, paperBetsTable, agentConfigTable, complianceLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

async function getConfig(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, key));
  return rows[0]?.value ?? null;
}

// Mirrors paperTrading.ts:kellyFractionForScore. Kept local to avoid
// circular import; if these drift in future, update both.
function kellyFractionForScore(opportunityScore: number): number {
  if (opportunityScore >= 80) return 0.50;
  if (opportunityScore >= 72) return 0.375;
  if (opportunityScore >= 65) return 0.25;
  return 0.125;
}

const FRESH_EXCHANGE_WINDOW_MIN = 30;
const KICKOFF_LOOKAHEAD_HOURS = 6;
const BETFAIR_MIN_STAKE = 2.00;

export interface LazyPromoteResult {
  evaluated_at: string;
  pending_shadow_count: number;
  promoted: number;
  skipped_no_exchange: number;
  skipped_kelly_below_min: number;
  skipped_paper_already_exists: number;
  skipped_kickoff_too_far: number;
  errors: number;
}

export async function runLazyPromoteShadowToPaper(): Promise<LazyPromoteResult> {
  const result: LazyPromoteResult = {
    evaluated_at: new Date().toISOString(),
    pending_shadow_count: 0,
    promoted: 0,
    skipped_no_exchange: 0,
    skipped_kelly_below_min: 0,
    skipped_paper_already_exists: 0,
    skipped_kickoff_too_far: 0,
    errors: 0,
  };

  const evalStartStr = await getConfig("evaluation_start_at");
  if (!evalStartStr) {
    logger.debug("lazyPromoteShadowToPaper: no evaluation_start_at — no-op");
    return result;
  }
  const bankrollStr = await getConfig("bankroll");
  const bankroll = bankrollStr != null ? Number(bankrollStr) : 0;
  if (!(bankroll > 0)) {
    logger.warn({ bankroll }, "lazyPromoteShadowToPaper: invalid bankroll — no-op");
    return result;
  }
  const maxStakePctStr = await getConfig("max_stake_pct");
  const maxStakePct = maxStakePctStr != null ? Number(maxStakePctStr) : 0.02;
  const maxStake = Math.round(bankroll * maxStakePct * 100) / 100;

  // Find candidates: pending Tier A shadow bets, kickoff within 6h.
  const candidates = await db.execute(sql`
    SELECT pb.id, pb.match_id, pb.market_type, pb.selection_name,
           pb.selection_canonical, pb.opportunity_score::numeric AS score,
           pb.calculated_edge::numeric AS edge,
           pb.odds_at_placement::numeric AS odds,
           pb.universe_tier_at_placement AS universe_tier
    FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
    WHERE pb.bet_track = 'shadow'
      AND pb.status = 'pending'
      AND pb.legacy_regime = false
      AND pb.deleted_at IS NULL
      AND pb.universe_tier_at_placement = 'A'
      AND pb.placed_at >= ${new Date(evalStartStr)}
      AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '${sql.raw(String(KICKOFF_LOOKAHEAD_HOURS))} hours'
  `);
  const rows = (((candidates as any).rows ?? []) as Array<{
    id: number; match_id: number; market_type: string; selection_name: string;
    selection_canonical: string | null;
    score: string | number; edge: string | number; odds: string | number;
    universe_tier: string;
  }>);
  result.pending_shadow_count = rows.length;
  if (rows.length === 0) return result;

  for (const r of rows) {
    try {
      // Check fresh exchange data for this specific selection. AH lines are
      // captured by exact selectionName match in odds_snapshots (set by
      // exchangeBookSweep.deriveSelectionName as "Home -1.5" / "Away +0.5").
      const fresh = await db.execute(sql`
        SELECT 1 FROM odds_snapshots
        WHERE match_id = ${r.match_id}
          AND market_type = ${r.market_type}
          AND selection_name = ${r.selection_name}
          AND source = 'betfair_exchange'
          AND snapshot_time > NOW() - INTERVAL '${sql.raw(String(FRESH_EXCHANGE_WINDOW_MIN))} minutes'
        LIMIT 1
      `);
      const hasFreshExchange = (((fresh as any).rows ?? []) as unknown[]).length > 0;
      if (!hasFreshExchange) {
        result.skipped_no_exchange++;
        continue;
      }

      // Check no paper bet already exists on the same canonical selection
      // for this match — the unique partial index would error on conflict
      // anyway, but checking up-front is cleaner than catching the error.
      if (r.selection_canonical) {
        const dup = await db.execute(sql`
          SELECT 1 FROM paper_bets
          WHERE match_id = ${r.match_id}
            AND market_type = ${r.market_type}
            AND selection_canonical = ${r.selection_canonical}
            AND bet_track = 'paper'
            AND status IN ('pending','pending_placement')
            AND deleted_at IS NULL
          LIMIT 1
        `);
        if ((((dup as any).rows ?? []) as unknown[]).length > 0) {
          result.skipped_paper_already_exists++;
          continue;
        }
      }

      // Compute fresh Kelly stake from opportunity_score + edge + current
      // bankroll. Apply maxStakePct cap. If below £2 minimum, leave shadow.
      const score = Number(r.score ?? 0);
      const edge = Number(r.edge ?? 0);
      const odds = Number(r.odds ?? 0);
      if (!(odds > 1.01) || !(edge > 0)) {
        result.errors++;
        continue;
      }
      const kellyFraction = kellyFractionForScore(score);
      // Kelly stake = bankroll × kellyFraction × edge / (odds - 1).
      // Approximation matches paperTrading.ts dynamic Kelly path.
      let stake = bankroll * kellyFraction * edge / (odds - 1);
      stake = Math.min(stake, maxStake);
      stake = Math.round(stake * 100) / 100;
      if (stake < BETFAIR_MIN_STAKE) {
        result.skipped_kelly_below_min++;
        continue;
      }
      const potentialProfit = Math.round(stake * (odds - 1) * 100) / 100;

      // Promote in place: stake>0, bet_track='paper', clear shadow_stake.
      await db
        .update(paperBetsTable)
        .set({
          stake: String(stake),
          potentialProfit: String(potentialProfit),
          betTrack: "paper",
          shadowStake: null,
          shadowStakeKellyFraction: null,
        } as any)
        .where(eq(paperBetsTable.id, r.id));

      await db.insert(complianceLogsTable).values({
        actionType: "lazy_promoted_shadow_to_paper",
        details: {
          betId: r.id,
          matchId: r.match_id,
          marketType: r.market_type,
          selectionName: r.selection_name,
          score,
          edge,
          odds,
          newStake: stake,
          newPotentialProfit: potentialProfit,
          kellyFraction,
          bankroll,
        } as Record<string, unknown>,
        timestamp: new Date(),
      } as any);

      result.promoted++;
      logger.info(
        { betId: r.id, matchId: r.match_id, marketType: r.market_type, selection: r.selection_name, stake, score, edge, odds },
        "lazyPromoteShadowToPaper: promoted shadow bet to paper",
      );
    } catch (err) {
      logger.warn({ err, betId: r.id }, "lazyPromoteShadowToPaper: failed to promote bet — skipping");
      result.errors++;
    }
  }

  // Skipped_kickoff_too_far is computed differently — bets already filtered
  // by the SQL, so this counter stays 0 in this implementation. Reserved for
  // future expansion if we accept matches further out.
  logger.info(result, "lazyPromoteShadowToPaper evaluated");
  return result;
}
