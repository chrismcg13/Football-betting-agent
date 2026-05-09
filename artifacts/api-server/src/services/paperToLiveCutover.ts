/**
 * Pre-flip blocker #11: paper-to-live cutover orchestrator.
 *
 * Single orchestrated pass. Converts every paper-pending bet with kickoff
 * > NOW() + 1h into a live placement attempt. Each conversion:
 *   - Per-bet feasibility gates (1: market open, 2: drift, 3: residual edge,
 *     4: liquidity).
 *   - Recompute Kelly stake against live B = getLiveBankroll().
 *   - placeLiveBetOnBetfair() on pass; UPDATE paper_bets to bet_track='live'
 *     per Amendment 4 field-refresh policy on success.
 *   - On any failure: UPDATE original row to status='cancelled', INSERT a
 *     shadow row with stake=0, write compliance_logs entry with reason.
 *
 * Drift tolerance (Option (i) per plan §B): max(3 ticks, 1.5% × paper_price).
 * Residual edge floor: existing valueDetection minEdge (no new threshold).
 * Liquidity floor: availableToBack >= roundedStake.
 *
 * Per-bet atomicity. Re-running is safe — converted bets are no longer
 * bet_track='paper' so they drop out of the SELECT.
 */

import { db, paperBetsTable, complianceLogsTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getLiveBankroll,
  refreshBalanceIfStale,
  findMarketForBet,
  findSelectionId,
  placeLiveBetOnBetfair,
} from "./betfairLive";
import { listMarketBook } from "./betfair";
import { isLivePlacementEnabled } from "./livePlacementGate";

const KICKOFF_BUFFER_INTERVAL = "1 hour";

// Betfair tick sizes by price band (from Betfair price ladder spec).
function tickSize(price: number): number {
  if (price < 2.0) return 0.01;
  if (price < 3.0) return 0.02;
  if (price < 4.0) return 0.05;
  if (price < 6.0) return 0.10;
  if (price < 10.0) return 0.20;
  if (price < 20.0) return 0.50;
  if (price < 30.0) return 1.0;
  if (price < 50.0) return 2.0;
  if (price < 100.0) return 5.0;
  return 10.0;
}

function driftTolerance(paperPrice: number): number {
  const threeTicks = 3 * tickSize(paperPrice);
  const onePointFivePct = 0.015 * paperPrice;
  return Math.max(threeTicks, onePointFivePct);
}

interface EligibleBet {
  id: number;
  match_id: number;
  market_type: string;
  selection_name: string;
  odds_at_placement: number;
  stake: number;
  experiment_tag: string | null;
  universe_tier_at_placement: string | null;
  data_tier: string | null;
  opportunity_score: number | null;
  model_probability: number | null;
  pinnacle_implied: number | null;
  home_team: string;
  away_team: string;
  league: string;
  kickoff_time: string;
  betfair_event_id: string | null;
}

export type ConversionFailureReason =
  | "kill_switch_off"
  | "no_betfair_event"
  | "market_not_found"
  | "selection_not_found"
  | "market_suspended"
  | "drift_exceeded"
  | "edge_collapsed"
  | "liquidity_short"
  | "stake_below_minimum"
  | "api_error"
  | "unknown";

interface PerBetOutcome {
  betId: number;
  marketType: string;
  league: string;
  paperOdds: number;
  paperStake: number;
  currentBackOdds: number | null;
  recomputedEdge: number | null;
  recomputedStake: number | null;
  outcome: "converted" | "shadow" | "skipped";
  reason: ConversionFailureReason | null;
  betfairBetId: string | null;
}

export interface CutoverReport {
  dryRun: boolean;
  evaluatedAt: string;
  liveBankroll: number;
  killSwitchOn: boolean;
  totalEligible: number;
  converted: number;
  shadowed: number;
  skipped: number;
  byReason: Record<string, number>;
  totalLiveExposure: number;
  perBet: PerBetOutcome[];
  // Amendment 3 surface item: historical Tier1 silent-rejection rate.
  historicalTier1Rate: Array<{ day: string; paper_emitted: number; live_attempted: number; silently_rejected: number; pct_rejected: number | null }> | null;
}

const MIN_EDGE_FALLBACK = 0.03;
async function readMinEdge(): Promise<number> {
  const r = await db.execute(sql`SELECT value FROM agent_config WHERE key='min_edge_threshold' LIMIT 1`);
  const v = (((r as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
  const n = Number(v ?? "");
  return Number.isFinite(n) && n > 0 ? n : MIN_EDGE_FALLBACK;
}

async function readMaxStakePct(): Promise<number> {
  const r = await db.execute(sql`SELECT value FROM agent_config WHERE key='max_stake_pct' LIMIT 1`);
  const v = (((r as any).rows ?? []) as Array<{ value: string }>)[0]?.value;
  const n = Number(v ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0.02;
}

async function readBoundedKellyFraction(opportunityScore: number | null): Promise<number> {
  // Match the existing kellyFractionForScore behaviour from lazyPromoteShadowToPaper.ts:46-51.
  const s = opportunityScore ?? 0;
  if (s >= 80) return 0.50;
  if (s >= 72) return 0.375;
  if (s >= 65) return 0.25;
  return 0.125;
}

function recomputeKellyStake(
  bankroll: number,
  edgeFraction: number,
  backOdds: number,
  kellyFraction: number,
  maxStakePct: number,
): number {
  if (edgeFraction <= 0 || backOdds <= 1) return 0;
  const fullKelly = edgeFraction / (backOdds - 1);
  let stake = bankroll * fullKelly * kellyFraction;
  stake = Math.min(stake, bankroll * maxStakePct);
  return Math.round(stake * 100) / 100;
}

async function selectEligibleBets(): Promise<EligibleBet[]> {
  const r = await db.execute(sql`
    SELECT pb.id, pb.match_id, pb.market_type, pb.selection_name,
           pb.odds_at_placement::float8 AS odds_at_placement,
           pb.stake::float8              AS stake,
           pb.experiment_tag, pb.universe_tier_at_placement,
           pb.data_tier, pb.opportunity_score::float8 AS opportunity_score,
           pb.model_probability::float8  AS model_probability,
           pb.pinnacle_implied::float8   AS pinnacle_implied,
           m.home_team, m.away_team, m.league,
           m.kickoff_time::text          AS kickoff_time,
           m.betfair_event_id
    FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
    WHERE pb.bet_track = 'paper'
      AND pb.status = 'pending'
      AND pb.deleted_at IS NULL
      AND pb.legacy_regime = false
      AND m.kickoff_time > NOW() + INTERVAL '1 hour'
    ORDER BY m.kickoff_time
  `);
  return ((r as any).rows ?? []) as EligibleBet[];
}

async function fetchHistoricalTier1Rate(): Promise<CutoverReport["historicalTier1Rate"]> {
  const r = await db.execute(sql`
    SELECT DATE_TRUNC('day', placed_at)::text AS day,
           COUNT(*)::int AS paper_emitted,
           COUNT(*) FILTER (WHERE live_tier='tier1')::int AS live_attempted,
           COUNT(*) FILTER (WHERE live_tier='tier2')::int AS silently_rejected
    FROM paper_bets
    WHERE bet_track='paper' AND legacy_regime=false
      AND live_tier IS NOT NULL
    GROUP BY 1 ORDER BY 1 DESC LIMIT 30
  `);
  const rows = ((r as any).rows ?? []) as Array<{ day: string; paper_emitted: number; live_attempted: number; silently_rejected: number }>;
  if (rows.length === 0) return [];
  return rows.map((x) => ({
    day: x.day,
    paper_emitted: Number(x.paper_emitted),
    live_attempted: Number(x.live_attempted),
    silently_rejected: Number(x.silently_rejected),
    pct_rejected: x.paper_emitted > 0
      ? Math.round((100 * Number(x.silently_rejected) / Number(x.paper_emitted)) * 10) / 10
      : null,
  }));
}

interface GateResult {
  pass: boolean;
  reason: ConversionFailureReason | null;
  currentBackOdds: number | null;
  availableLay: number | null;
  marketStatus: string | null;
  marketId: string | null;
  selectionId: number | null;
}

async function applyFeasibilityGates(bet: EligibleBet, recomputedStake: number): Promise<GateResult> {
  if (!bet.betfair_event_id) {
    return { pass: false, reason: "no_betfair_event", currentBackOdds: null, availableLay: null, marketStatus: null, marketId: null, selectionId: null };
  }
  const market = await findMarketForBet(bet.betfair_event_id, bet.market_type, bet.home_team, bet.away_team);
  if (!market || !market.runners) {
    return { pass: false, reason: "market_not_found", currentBackOdds: null, availableLay: null, marketStatus: null, marketId: null, selectionId: null };
  }
  const selectionId = findSelectionId(market.runners as any, bet.selection_name, bet.home_team, bet.away_team);
  if (!selectionId) {
    return { pass: false, reason: "selection_not_found", currentBackOdds: null, availableLay: null, marketStatus: null, marketId: market.marketId, selectionId: null };
  }

  const books = await listMarketBook([market.marketId]);
  const book = books[0];
  if (!book) {
    return { pass: false, reason: "market_not_found", currentBackOdds: null, availableLay: null, marketStatus: null, marketId: market.marketId, selectionId };
  }

  // Gate 1: market open + not suspended.
  if (book.status !== "OPEN") {
    return { pass: false, reason: "market_suspended", currentBackOdds: null, availableLay: null, marketStatus: book.status, marketId: market.marketId, selectionId };
  }

  const runner = book.runners.find((rr) => rr.selectionId === selectionId);
  const backTop = runner?.ex?.availableToBack?.[0];
  if (!runner || !backTop) {
    return { pass: false, reason: "liquidity_short", currentBackOdds: null, availableLay: null, marketStatus: book.status, marketId: market.marketId, selectionId };
  }
  const currentBack = backTop.price;
  const availableSize = backTop.size ?? 0;

  // Gate 2: drift tolerance — option (i) max(3 ticks, 1.5% × paper_price).
  const tol = driftTolerance(bet.odds_at_placement);
  if (Math.abs(currentBack - bet.odds_at_placement) > tol) {
    return {
      pass: false, reason: "drift_exceeded",
      currentBackOdds: currentBack, availableLay: availableSize,
      marketStatus: book.status, marketId: market.marketId, selectionId,
    };
  }

  // Gate 4: liquidity (size at top of back-side queue >= our stake).
  // Lay-side size on the back queue is what we'd take if we placed at currentBack.
  if (availableSize < recomputedStake) {
    return {
      pass: false, reason: "liquidity_short",
      currentBackOdds: currentBack, availableLay: availableSize,
      marketStatus: book.status, marketId: market.marketId, selectionId,
    };
  }

  return {
    pass: true, reason: null,
    currentBackOdds: currentBack, availableLay: availableSize,
    marketStatus: book.status, marketId: market.marketId, selectionId,
  };
}

async function logSuccessToCompliance(
  bet: EligibleBet,
  betfairBetId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(complianceLogsTable).values({
    actionType: "paper_to_live_conversion_success",
    details: { bet_id: bet.id, betfair_bet_id: betfairBetId, ...detail },
    timestamp: new Date(),
  });
}

async function applyConversionSuccess(bet: EligibleBet, params: {
  recomputedStake: number;
  conversionAt: Date;
}): Promise<void> {
  // Amendment 4 field-refresh policy. placeLiveBetOnBetfair already sets
  // betfair_* fields and betfair_placed_at; here we only set the cutover-
  // specific deltas.
  const newPotentialProfit = Math.round(params.recomputedStake * (bet.odds_at_placement - 1) * 100) / 100;
  await db.update(paperBetsTable).set({
    betTrack: "live",
    status: "pending",
    stake: String(params.recomputedStake),
    potentialProfit: String(newPotentialProfit),
    qualificationPath: "cutover_converted",
    placedAt: params.conversionAt,
  }).where(eq(paperBetsTable.id, bet.id));
}

async function applyConversionFailure(bet: EligibleBet, reason: ConversionFailureReason, detail: Record<string, unknown>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(paperBetsTable).set({
      status: "cancelled",
      betfairStatus: `CUTOVER_FAILED_TO_SHADOW: ${reason}`,
    }).where(eq(paperBetsTable.id, bet.id));

    await tx.insert(paperBetsTable).values({
      matchId: bet.match_id,
      marketType: bet.market_type,
      selectionName: bet.selection_name,
      oddsAtPlacement: String(bet.odds_at_placement),
      stake: "0",
      potentialProfit: "0",
      betTrack: "shadow",
      status: "pending",
      experimentTag: bet.experiment_tag,
      universeTierAtPlacement: bet.universe_tier_at_placement,
      dataTier: bet.data_tier ?? "experiment",
      opportunityScore: bet.opportunity_score != null ? String(bet.opportunity_score) : null,
      modelProbability: bet.model_probability != null ? String(bet.model_probability) : null,
      pinnacleImplied: bet.pinnacle_implied != null ? String(bet.pinnacle_implied) : null,
      qualificationPath: "cutover_demoted_to_shadow",
      placedAt: new Date(),
    } as any);

    await tx.insert(complianceLogsTable).values({
      actionType: "paper_to_live_conversion_failed_to_shadow",
      details: { bet_id: bet.id, reason, ...detail },
      timestamp: new Date(),
    });
  });
}

export async function runCutoverConversion(opts: { dryRun: boolean }): Promise<CutoverReport> {
  const evaluatedAt = new Date().toISOString();
  const killSwitchOn = await isLivePlacementEnabled();

  const report: CutoverReport = {
    dryRun: opts.dryRun,
    evaluatedAt,
    liveBankroll: 0,
    killSwitchOn,
    totalEligible: 0,
    converted: 0,
    shadowed: 0,
    skipped: 0,
    byReason: {},
    totalLiveExposure: 0,
    perBet: [],
    historicalTier1Rate: null,
  };

  if (!killSwitchOn) {
    logger.warn("runCutoverConversion: live_placement_enabled=false — refusing to run");
    return report;
  }

  // Surface item: historical Tier1 silent-rejection rate (Amendment 3 caveat
  // query — full lookback, not 7-day-only). Always include in report so dry-run
  // surfaces day-one volume-uplift expectation.
  report.historicalTier1Rate = await fetchHistoricalTier1Rate();

  await refreshBalanceIfStale();
  report.liveBankroll = await getLiveBankroll();

  const minEdge = await readMinEdge();
  const maxStakePct = await readMaxStakePct();

  const bets = await selectEligibleBets();
  report.totalEligible = bets.length;

  // Sort by paper-side score: edge × stake (proxy for the documented
  // ordering function; remaining-budget term is implicit via per-bet
  // recomputation against B_live).
  const scored = bets.map((b) => {
    const paperEdge = b.pinnacle_implied != null && b.odds_at_placement > 0
      ? (1 / b.odds_at_placement - b.pinnacle_implied) / b.pinnacle_implied  // pseudo edge for ordering
      : 0;
    return { b, score: Math.abs(paperEdge) * b.stake };
  }).sort((a, c) => c.score - a.score);

  for (const { b: bet } of scored) {
    const kellyFraction = await readBoundedKellyFraction(bet.opportunity_score);

    // Provisional Kelly stake (will be revised after we see current price).
    const provisionalStake = recomputeKellyStake(
      report.liveBankroll,
      // Use paper-recorded edge as approximation; refined post-gate-2.
      Math.max(0, (1 / bet.odds_at_placement) - (bet.pinnacle_implied ?? (1 / bet.odds_at_placement))),
      bet.odds_at_placement,
      kellyFraction,
      maxStakePct,
    );

    if (provisionalStake < 2) {
      report.skipped += 1;
      report.byReason["stake_below_minimum"] = (report.byReason["stake_below_minimum"] ?? 0) + 1;
      report.perBet.push({
        betId: bet.id, marketType: bet.market_type, league: bet.league,
        paperOdds: bet.odds_at_placement, paperStake: bet.stake,
        currentBackOdds: null, recomputedEdge: null, recomputedStake: provisionalStake,
        outcome: "skipped", reason: "stake_below_minimum", betfairBetId: null,
      });
      continue;
    }

    const gates = await applyFeasibilityGates(bet, provisionalStake);
    if (!gates.pass) {
      report.byReason[gates.reason ?? "unknown"] = (report.byReason[gates.reason ?? "unknown"] ?? 0) + 1;
      report.perBet.push({
        betId: bet.id, marketType: bet.market_type, league: bet.league,
        paperOdds: bet.odds_at_placement, paperStake: bet.stake,
        currentBackOdds: gates.currentBackOdds, recomputedEdge: null, recomputedStake: provisionalStake,
        outcome: "shadow", reason: gates.reason, betfairBetId: null,
      });
      if (!opts.dryRun) {
        await applyConversionFailure(bet, gates.reason ?? "unknown", {
          paper_odds: bet.odds_at_placement,
          current_back_odds: gates.currentBackOdds,
          market_status: gates.marketStatus,
          available_size: gates.availableLay,
          provisional_stake: provisionalStake,
        });
      }
      report.shadowed += 1;
      continue;
    }

    // Gate 3: residual edge against current price.
    const currentBack = gates.currentBackOdds!;
    const pinImplied = bet.pinnacle_implied;
    const recomputedEdge = pinImplied != null ? (1 / currentBack) - pinImplied : null;
    if (recomputedEdge != null && recomputedEdge < minEdge) {
      report.byReason["edge_collapsed"] = (report.byReason["edge_collapsed"] ?? 0) + 1;
      report.perBet.push({
        betId: bet.id, marketType: bet.market_type, league: bet.league,
        paperOdds: bet.odds_at_placement, paperStake: bet.stake,
        currentBackOdds: currentBack, recomputedEdge, recomputedStake: provisionalStake,
        outcome: "shadow", reason: "edge_collapsed", betfairBetId: null,
      });
      if (!opts.dryRun) {
        await applyConversionFailure(bet, "edge_collapsed", {
          paper_odds: bet.odds_at_placement,
          current_back_odds: currentBack,
          recomputed_edge: recomputedEdge,
          min_edge_threshold: minEdge,
        });
      }
      report.shadowed += 1;
      continue;
    }

    // Recompute stake against the current price and refreshed B.
    const finalEdgeFraction = recomputedEdge != null && recomputedEdge > 0
      ? recomputedEdge
      : Math.max(0, (1 / bet.odds_at_placement) - (pinImplied ?? (1 / bet.odds_at_placement)));
    const refreshedStake = recomputeKellyStake(
      report.liveBankroll, finalEdgeFraction, currentBack, kellyFraction, maxStakePct,
    );
    if (refreshedStake < 2) {
      report.byReason["stake_below_minimum"] = (report.byReason["stake_below_minimum"] ?? 0) + 1;
      report.perBet.push({
        betId: bet.id, marketType: bet.market_type, league: bet.league,
        paperOdds: bet.odds_at_placement, paperStake: bet.stake,
        currentBackOdds: currentBack, recomputedEdge, recomputedStake: refreshedStake,
        outcome: "shadow", reason: "stake_below_minimum", betfairBetId: null,
      });
      if (!opts.dryRun) {
        await applyConversionFailure(bet, "stake_below_minimum", {
          recomputed_stake: refreshedStake, current_back_odds: currentBack,
        });
      }
      report.shadowed += 1;
      continue;
    }

    if (opts.dryRun) {
      report.converted += 1;
      report.totalLiveExposure += refreshedStake;
      report.perBet.push({
        betId: bet.id, marketType: bet.market_type, league: bet.league,
        paperOdds: bet.odds_at_placement, paperStake: bet.stake,
        currentBackOdds: currentBack, recomputedEdge, recomputedStake: refreshedStake,
        outcome: "converted", reason: null, betfairBetId: null,
      });
      continue;
    }

    // Live placement.
    const result = await placeLiveBetOnBetfair({
      internalBetId: bet.id,
      betfairEventId: bet.betfair_event_id!,
      marketType: bet.market_type,
      selectionName: bet.selection_name,
      odds: currentBack,
      stake: refreshedStake,
      homeTeam: bet.home_team,
      awayTeam: bet.away_team,
    });

    if (!result.success || !result.betfairBetId) {
      const reason: ConversionFailureReason = (() => {
        const e = (result.error ?? "").toLowerCase();
        if (e.includes("suspended") || e.includes("not_open")) return "market_suspended";
        if (e.includes("nsufficient") || e.includes("balance")) return "liquidity_short";
        if (e.includes("below betfair minimum") || e.includes("below £2")) return "stake_below_minimum";
        return "api_error";
      })();
      report.byReason[reason] = (report.byReason[reason] ?? 0) + 1;
      report.perBet.push({
        betId: bet.id, marketType: bet.market_type, league: bet.league,
        paperOdds: bet.odds_at_placement, paperStake: bet.stake,
        currentBackOdds: currentBack, recomputedEdge, recomputedStake: refreshedStake,
        outcome: "shadow", reason, betfairBetId: null,
      });
      await applyConversionFailure(bet, reason, {
        error: result.error, current_back_odds: currentBack, recomputed_stake: refreshedStake,
      });
      report.shadowed += 1;
      continue;
    }

    // Success — UPDATE per Amendment 4 field-refresh policy.
    await applyConversionSuccess(bet, {
      recomputedStake: refreshedStake,
      conversionAt: new Date(),
    });
    await logSuccessToCompliance(bet, result.betfairBetId, {
      paper_odds: bet.odds_at_placement,
      current_back_odds: currentBack,
      paper_stake: bet.stake,
      live_stake: refreshedStake,
      kelly_fraction: kellyFraction,
    });
    report.converted += 1;
    report.totalLiveExposure += refreshedStake;
    report.perBet.push({
      betId: bet.id, marketType: bet.market_type, league: bet.league,
      paperOdds: bet.odds_at_placement, paperStake: bet.stake,
      currentBackOdds: currentBack, recomputedEdge, recomputedStake: refreshedStake,
      outcome: "converted", reason: null, betfairBetId: result.betfairBetId,
    });
  }

  return report;
}
