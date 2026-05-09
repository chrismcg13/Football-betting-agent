/**
 * Pre-flip blocker #11 (revised): paper-to-live cutover orchestrator.
 *
 * Single orchestrated pass. Converts every paper-pending bet with kickoff
 * > NOW() + 1h into a live placement attempt. Each bet has exactly one of
 * three outcomes — there is no "skipped" state, every non-converted bet
 * cancels the original paper row and inserts a shadow row with reason:
 *
 *   1. Converted: gates pass + stake>=£2 + Betfair placement succeeds
 *      → original row UPDATEd to bet_track='live'.
 *
 *   2. Shadow-demoted: any of the per-bet feasibility gates fail OR the
 *      Kelly helper returns 0 (edge<=0 at current price) OR Betfair
 *      placement fails → original row UPDATEd to status='cancelled',
 *      a new bet_track='shadow' row inserted with stake=0 and
 *      qualification_path='cutover_demoted_to_shadow', compliance_logs
 *      entry tagged 'paper_to_live_conversion_failed_to_shadow' with reason
 *      ∈ {market_suspended, drift_exceeded, edge_collapsed, liquidity_short,
 *         market_not_found, selection_not_found, no_betfair_event,
 *         api_error, stake_below_minimum}.
 *
 * Stake sizing IS the same as new live emissions: the cutover calls
 * calculateDynamicKellyStake() exported from paperTrading.ts. That helper
 * encodes the £2 floor rule (paperTrading.ts:718): edge<=0 returns 0
 * (we shadow-demote 'edge_collapsed'); edge>0 floors stake to £2 minimum.
 * No conversion-specific staking rules are introduced.
 *
 * Drift tolerance (Option (i) per plan §B): max(3 ticks, 1.5% × paper_price).
 * Edge floor: agent_config.min_edge_threshold (default 0.03), recomputed
 * against current market-book price using the bet's stored model_probability.
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
import { calculateDynamicKellyStake } from "./paperTrading";

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
  return Math.max(3 * tickSize(paperPrice), 0.015 * paperPrice);
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
  | "no_model_probability"
  | "api_error"
  | "unknown";

interface PerBetOutcome {
  betId: number;
  marketType: string;
  league: string;
  paperOdds: number;
  paperStake: number;
  currentBackOdds: number | null;
  modelProbability: number | null;
  edgeAtCurrentPrice: number | null;
  computedStake: number | null;
  outcome: "converted" | "shadow_demoted";
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
  shadowDemoted: number;
  cancelledOriginalCount: number;  // every non-converted bet cancels the original
  byReason: Record<string, number>;
  totalLiveExposure: number;
  perBet: PerBetOutcome[];
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

interface MarketContext {
  pass: boolean;
  reason: ConversionFailureReason | null;
  currentBackOdds: number | null;
  availableSize: number | null;
  marketStatus: string | null;
  marketId: string | null;
  selectionId: number | null;
}

async function fetchMarketContext(bet: EligibleBet): Promise<MarketContext> {
  if (!bet.betfair_event_id) {
    return { pass: false, reason: "no_betfair_event", currentBackOdds: null, availableSize: null, marketStatus: null, marketId: null, selectionId: null };
  }
  const market = await findMarketForBet(bet.betfair_event_id, bet.market_type, bet.home_team, bet.away_team);
  if (!market || !market.runners) {
    return { pass: false, reason: "market_not_found", currentBackOdds: null, availableSize: null, marketStatus: null, marketId: null, selectionId: null };
  }
  const selectionId = findSelectionId(market.runners as any, bet.selection_name, bet.home_team, bet.away_team);
  if (!selectionId) {
    return { pass: false, reason: "selection_not_found", currentBackOdds: null, availableSize: null, marketStatus: null, marketId: market.marketId, selectionId: null };
  }

  const books = await listMarketBook([market.marketId]);
  const book = books[0];
  if (!book) {
    return { pass: false, reason: "market_not_found", currentBackOdds: null, availableSize: null, marketStatus: null, marketId: market.marketId, selectionId };
  }
  if (book.status !== "OPEN") {
    return { pass: false, reason: "market_suspended", currentBackOdds: null, availableSize: null, marketStatus: book.status, marketId: market.marketId, selectionId };
  }

  const runner = book.runners.find((rr) => rr.selectionId === selectionId);
  const backTop = runner?.ex?.availableToBack?.[0];
  if (!runner || !backTop) {
    return { pass: false, reason: "liquidity_short", currentBackOdds: null, availableSize: 0, marketStatus: book.status, marketId: market.marketId, selectionId };
  }

  return {
    pass: true, reason: null,
    currentBackOdds: backTop.price,
    availableSize: backTop.size ?? 0,
    marketStatus: book.status,
    marketId: market.marketId,
    selectionId,
  };
}

async function shadowDemote(
  bet: EligibleBet,
  reason: ConversionFailureReason,
  detail: Record<string, unknown>,
): Promise<void> {
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

async function applyConversionSuccess(bet: EligibleBet, params: {
  recomputedStake: number;
  conversionAt: Date;
}): Promise<void> {
  // Amendment 4 field-refresh policy. placeLiveBetOnBetfair already sets
  // betfair_* fields and betfair_placed_at; here we set the cutover-specific
  // deltas only.
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
    shadowDemoted: 0,
    cancelledOriginalCount: 0,
    byReason: {},
    totalLiveExposure: 0,
    perBet: [],
    historicalTier1Rate: null,
  };

  if (!killSwitchOn) {
    logger.warn("runCutoverConversion: live_placement_enabled=false — refusing to run");
    return report;
  }

  report.historicalTier1Rate = await fetchHistoricalTier1Rate();

  await refreshBalanceIfStale();
  report.liveBankroll = await getLiveBankroll();

  const minEdge = await readMinEdge();
  const maxStakePct = await readMaxStakePct();

  const bets = await selectEligibleBets();
  report.totalEligible = bets.length;

  // Best-first ordering. Use paper-recorded edge as a proxy for sort order;
  // recomputation against current price happens per-bet during processing.
  const scored = bets.map((b) => {
    const proxyEdge = b.model_probability != null && b.odds_at_placement > 0
      ? (b.model_probability * b.odds_at_placement) - 1
      : 0;
    return { b, score: Math.max(0, proxyEdge) * b.stake };
  }).sort((a, c) => c.score - a.score);

  const recordOutcome = (
    bet: EligibleBet,
    ctx: { currentBackOdds: number | null; edgeAtCurrentPrice: number | null; computedStake: number | null },
    outcome: "converted" | "shadow_demoted",
    reason: ConversionFailureReason | null,
    betfairBetId: string | null,
  ) => {
    report.perBet.push({
      betId: bet.id,
      marketType: bet.market_type,
      league: bet.league,
      paperOdds: bet.odds_at_placement,
      paperStake: bet.stake,
      currentBackOdds: ctx.currentBackOdds,
      modelProbability: bet.model_probability,
      edgeAtCurrentPrice: ctx.edgeAtCurrentPrice,
      computedStake: ctx.computedStake,
      outcome,
      reason,
      betfairBetId,
    });
    if (outcome === "converted") {
      report.converted += 1;
      if (ctx.computedStake != null) report.totalLiveExposure += ctx.computedStake;
    } else {
      report.shadowDemoted += 1;
      report.cancelledOriginalCount += 1;
      const k = reason ?? "unknown";
      report.byReason[k] = (report.byReason[k] ?? 0) + 1;
    }
  };

  for (const { b: bet } of scored) {
    // Pre-flight: model_probability must exist for any meaningful edge calc.
    if (bet.model_probability == null || !Number.isFinite(bet.model_probability) || bet.model_probability <= 0) {
      recordOutcome(bet, { currentBackOdds: null, edgeAtCurrentPrice: null, computedStake: null },
        "shadow_demoted", "no_model_probability", null);
      if (!opts.dryRun) await shadowDemote(bet, "no_model_probability", { paper_odds: bet.odds_at_placement });
      continue;
    }

    // Gate 1: market open (also resolves marketId, selectionId, current odds, available size).
    const ctx = await fetchMarketContext(bet);
    if (!ctx.pass) {
      recordOutcome(bet, { currentBackOdds: ctx.currentBackOdds, edgeAtCurrentPrice: null, computedStake: null },
        "shadow_demoted", ctx.reason, null);
      if (!opts.dryRun) await shadowDemote(bet, ctx.reason ?? "unknown", {
        paper_odds: bet.odds_at_placement,
        market_status: ctx.marketStatus,
      });
      continue;
    }

    const currentBack = ctx.currentBackOdds!;
    const edgeAtCurrentPrice = (bet.model_probability * currentBack) - 1;

    // Gate 2: drift tolerance (Option (i): max(3 ticks, 1.5% × paper_price)).
    const tol = driftTolerance(bet.odds_at_placement);
    if (Math.abs(currentBack - bet.odds_at_placement) > tol) {
      recordOutcome(bet, { currentBackOdds: currentBack, edgeAtCurrentPrice, computedStake: null },
        "shadow_demoted", "drift_exceeded", null);
      if (!opts.dryRun) await shadowDemote(bet, "drift_exceeded", {
        paper_odds: bet.odds_at_placement, current_back_odds: currentBack, tolerance: tol,
      });
      continue;
    }

    // Stake sizing — same helper as new live emissions. The helper returns 0
    // if edge<=0 (we'll shadow-demote 'edge_collapsed'); otherwise floors to £2.
    const opportunityScore = bet.opportunity_score ?? 0;
    const stake = calculateDynamicKellyStake(
      report.liveBankroll,
      edgeAtCurrentPrice,
      currentBack,
      maxStakePct,
      opportunityScore,
      bet.market_type,
    );

    // Gate 3: residual edge must clear the same threshold paper emission uses.
    // If edgeAtCurrentPrice<=0 the helper already returned 0 and we'd shadow-demote
    // below — but we also shadow-demote when edge is positive but below minEdge,
    // matching valueDetection's emission-time floor.
    if (stake === 0) {
      recordOutcome(bet, { currentBackOdds: currentBack, edgeAtCurrentPrice, computedStake: 0 },
        "shadow_demoted", "edge_collapsed", null);
      if (!opts.dryRun) await shadowDemote(bet, "edge_collapsed", {
        paper_odds: bet.odds_at_placement, current_back_odds: currentBack,
        edge_at_current_price: edgeAtCurrentPrice,
      });
      continue;
    }
    if (edgeAtCurrentPrice < minEdge) {
      recordOutcome(bet, { currentBackOdds: currentBack, edgeAtCurrentPrice, computedStake: stake },
        "shadow_demoted", "edge_collapsed", null);
      if (!opts.dryRun) await shadowDemote(bet, "edge_collapsed", {
        paper_odds: bet.odds_at_placement, current_back_odds: currentBack,
        edge_at_current_price: edgeAtCurrentPrice, min_edge_threshold: minEdge,
      });
      continue;
    }

    // Gate 4: liquidity at top of back queue.
    if ((ctx.availableSize ?? 0) < stake) {
      recordOutcome(bet, { currentBackOdds: currentBack, edgeAtCurrentPrice, computedStake: stake },
        "shadow_demoted", "liquidity_short", null);
      if (!opts.dryRun) await shadowDemote(bet, "liquidity_short", {
        current_back_odds: currentBack, available_size: ctx.availableSize, requested_stake: stake,
      });
      continue;
    }

    if (opts.dryRun) {
      recordOutcome(bet, { currentBackOdds: currentBack, edgeAtCurrentPrice, computedStake: stake },
        "converted", null, null);
      continue;
    }

    // Live placement.
    const result = await placeLiveBetOnBetfair({
      internalBetId: bet.id,
      betfairEventId: bet.betfair_event_id!,
      marketType: bet.market_type,
      selectionName: bet.selection_name,
      odds: currentBack,
      stake,
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
      recordOutcome(bet, { currentBackOdds: currentBack, edgeAtCurrentPrice, computedStake: stake },
        "shadow_demoted", reason, null);
      await shadowDemote(bet, reason, {
        error: result.error, current_back_odds: currentBack, requested_stake: stake,
      });
      continue;
    }

    await applyConversionSuccess(bet, { recomputedStake: stake, conversionAt: new Date() });
    await logSuccessToCompliance(bet, result.betfairBetId, {
      paper_odds: bet.odds_at_placement,
      current_back_odds: currentBack,
      paper_stake: bet.stake,
      live_stake: stake,
      edge_at_current_price: edgeAtCurrentPrice,
    });
    recordOutcome(bet, { currentBackOdds: currentBack, edgeAtCurrentPrice, computedStake: stake },
      "converted", null, result.betfairBetId);
  }

  return report;
}
