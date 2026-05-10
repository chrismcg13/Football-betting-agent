/**
 * Phase 3 Path C+ (2026-05-08): lazy shadow → paper / live promotion.
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
 *   - the bet's selection_canonical isn't already a pending paper/live bet
 *
 * Promotion target depends on cutover state:
 *   PRE-cutover  → in-place UPDATE bet_track='paper', stake=fresh Kelly.
 *                  Settles deterministically as paper P&L. Legacy behaviour.
 *   POST-cutover → call placeLiveBetOnBetfair(). On success in-place UPDATE
 *                  bet_track='live', betfair_* fields populated, real money
 *                  on the exchange. On any failure (kill switch off, market
 *                  unavailable, INSUFFICIENT_FUNDS, drift, etc.) the row
 *                  stays bet_track='shadow' — the next lazy-promoter pass
 *                  will retry. Never UPDATE to bet_track='paper' post-
 *                  cutover (the §3 trigger forbids fresh paper inserts but
 *                  doesn't catch UPDATEs; we enforce it here).
 *
 * Uses the bet's stored opportunity_score + edge to compute Kelly fraction
 * (no re-prediction; the original valueDetection decision stands). If the
 * fresh Kelly stake < £2 (Betfair minimum), the bet stays shadow — no
 * regression to a sub-minimum paper stake. Idempotent — already-paper /
 * already-live rows are skipped.
 */

import { db, paperBetsTable, agentConfigTable, complianceLogsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isLiveMode, getLiveBankroll, getAccountFunds } from "./betfairLive";

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
  // 2026-05-10: in live mode the relevant bankroll is the actual Betfair
  // available cash (minus locked_reserve), NOT agent_config.bankroll which
  // is the virtual paper-trading P&L ledger that has grown to ~£31k while
  // real cash is ~£50. Sizing against the virtual figure produced Kelly
  // stakes of £15-£632 that all failed INSUFFICIENT_FUNDS at Betfair.
  // Pre-cutover (paper-only mode) keeps the legacy agent_config read.
  let bankroll: number;
  if (isLiveMode()) {
    try {
      bankroll = await getLiveBankroll();
    } catch (err) {
      logger.warn({ err }, "lazyPromoteShadowToPaper: getLiveBankroll failed — no-op");
      return result;
    }
  } else {
    const bankrollStr = await getConfig("bankroll");
    bankroll = bankrollStr != null ? Number(bankrollStr) : 0;
  }
  if (!(bankroll > 0)) {
    logger.warn({ bankroll }, "lazyPromoteShadowToPaper: invalid bankroll — no-op");
    return result;
  }
  const maxStakePctStr = await getConfig("max_stake_pct");
  const maxStakePct = maxStakePctStr != null ? Number(maxStakePctStr) : 0.02;
  let maxStake = Math.round(bankroll * maxStakePct * 100) / 100;

  // Cutover state: post-cutover, promote shadow→live (real Betfair placement).
  // Pre-cutover: legacy shadow→paper. The §3 trigger forbids paper INSERTs
  // post-cutover; we honour that here by gating UPDATEs to bet_track='paper'
  // on the same condition.
  const cutoverCompletedAtRaw = await getConfig("cutover_completed_at");
  const cutoverActive = !!cutoverCompletedAtRaw && cutoverCompletedAtRaw.trim() !== "";

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

      // Post-cutover: try live placement. On any failure leave the row as
      // shadow so the next pass can retry. The §3 trigger forbids paper
      // INSERTs once cutover_completed_at is set — and it would correctly
      // flag this UPDATE-to-paper path as semantically illegal too — so we
      // gate ourselves explicitly here rather than relying on a downstream
      // catch.
      if (cutoverActive) {
        const { isLivePlacementEnabled } = await import("./livePlacementGate");
        const killSwitchOn = isLiveMode() && (await isLivePlacementEnabled());
        if (!killSwitchOn) {
          // Degraded mode: kill switch off. Don't promote — leave as shadow.
          // The shadow row keeps its £0 stake / shadow_stake notional and the
          // next lazy-promoter run can retry once the operator re-enables.
          result.skipped_kelly_below_min++;  // reuse counter for "not eligible for live"
          continue;
        }

        // Look up match identity for placeLiveBetOnBetfair.
        const matchRow = await db.execute(sql`
          SELECT home_team, away_team, betfair_event_id
          FROM matches WHERE id = ${r.match_id} LIMIT 1
        `);
        const m = (((matchRow as any).rows ?? []) as Array<{
          home_team: string; away_team: string; betfair_event_id: string | null;
        }>)[0];
        if (!m || !m.betfair_event_id) {
          result.errors++;
          continue;
        }

        const { placeLiveBetOnBetfair } = await import("./betfairLive");
        const placeResult = await placeLiveBetOnBetfair({
          internalBetId: r.id,
          betfairEventId: m.betfair_event_id,
          marketType: r.market_type,
          selectionName: r.selection_name,
          odds,
          stake,
          homeTeam: m.home_team,
          awayTeam: m.away_team,
        });

        if (!placeResult.success || !placeResult.betfairBetId) {
          // Stays shadow. Compliance event already written by placeLiveBetOnBetfair.
          logger.info(
            { betId: r.id, matchId: r.match_id, error: placeResult.error },
            "lazyPromote: live placement failed — bet stays shadow for retry",
          );
          result.errors++;
          continue;
        }

        // Live placement succeeded — promote bet_track to 'live'.
        // placeLiveBetOnBetfair already set the betfair_* fields and
        // betfair_placed_at; here we set the cutover-equivalent deltas
        // (bet_track, stake, potential_profit, qualification_path).
        await db
          .update(paperBetsTable)
          .set({
            stake: String(stake),
            potentialProfit: String(potentialProfit),
            betTrack: "live",
            shadowStake: null,
            shadowStakeKellyFraction: null,
            qualificationPath: "lazy_promoted_to_live",
          } as any)
          .where(eq(paperBetsTable.id, r.id));

        await db.insert(complianceLogsTable).values({
          actionType: "lazy_promoted_shadow_to_live",
          details: {
            betId: r.id,
            matchId: r.match_id,
            marketType: r.market_type,
            selectionName: r.selection_name,
            betfairBetId: placeResult.betfairBetId,
            score, edge, odds, newStake: stake, kellyFraction, bankroll,
          } as Record<string, unknown>,
          timestamp: new Date(),
        } as any);

        result.promoted++;
        logger.info(
          { betId: r.id, matchId: r.match_id, marketType: r.market_type, selection: r.selection_name, stake, betfairBetId: placeResult.betfairBetId },
          "lazyPromote: shadow bet promoted to LIVE on Betfair",
        );

        // 2026-05-10: refresh available balance so the next candidate's Kelly
        // sizes against post-placement bankroll. Without this, bet N+1 in the
        // same pass uses the same balance bet 1 saw — which Betfair has now
        // partially spent — and we re-emit oversized stakes that fail
        // INSUFFICIENT_FUNDS. Mirrors paperToLiveCutover.ts:516-530.
        try {
          await getAccountFunds();
          bankroll = await getLiveBankroll();
          maxStake = Math.round(bankroll * maxStakePct * 100) / 100;
        } catch (refreshErr) {
          logger.warn(
            { err: refreshErr, betId: r.id },
            "lazyPromote: post-placement balance refresh failed — continuing with stale bankroll",
          );
        }
        continue;
      }

      // Pre-cutover: legacy in-place shadow→paper promotion.
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
          score, edge, odds,
          newStake: stake,
          newPotentialProfit: potentialProfit,
          kellyFraction, bankroll,
        } as Record<string, unknown>,
        timestamp: new Date(),
      } as any);

      result.promoted++;
      logger.info(
        { betId: r.id, matchId: r.match_id, marketType: r.market_type, selection: r.selection_name, stake, score, edge, odds },
        "lazyPromoteShadowToPaper: promoted shadow bet to paper (pre-cutover legacy path)",
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
