/**
 * NOTE (2026-05-11 — terminology): the filename and function name preserve
 * the historical "ToPaper" suffix even though post-cutover (2026-05-09)
 * this service only ever promotes to LIVE. A full rename to
 * `lazyPromoteShadowToLive` + `runLazyPromoteShadowToLive` is scoped as a
 * separate low-risk PR — touching 4 files but mechanical — deferred so the
 * back-to-theory rebake push stays cohesive. Operators reading this file
 * should mentally substitute "Live" wherever "Paper" appears.
 *
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
import { computeAdaptiveKellyFactor } from "./paperTrading";
import { sweepEventOnDemand } from "./exchangeBookSweep";

// 2026-05-14 Fix 2 — 6-hour cache of unavailable (event_id, market_type) pairs.
// On unavailableOnExchange from placeLiveBetOnBetfair we trigger a targeted
// listMarketCatalogue + listMarketBook for the event. If Betfair has no
// relevant markets for the event, we record that fact and short-circuit any
// further lazy-promote attempts on the same (event, market_type) for 6h.
//
// Why 6h: Betfair lists markets closer to kickoff. A market that wasn't there
// at T is unlikely to appear in the next 5-min cycle, but may appear within 6h
// as the fixture approaches. 6h balances retry cost against catch-up latency.
//
// Self-clearing: the cache TTL ensures every event eventually retries; success
// (markets found, snapshots written) clears the entry immediately so the next
// cycle re-attempts placement against the fresh snapshot.

interface UnavailabilityCacheEntry {
  triedAt: number;
  foundMarkets: boolean;
}
const onDemandUnavailabilityCache = new Map<string, UnavailabilityCacheEntry>();
const ONDEMAND_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function unavailabilityCacheKey(betfairEventId: string, marketType: string): string {
  return `${betfairEventId}|${marketType}`;
}

function isCachedAsUnavailable(betfairEventId: string, marketType: string): boolean {
  const entry = onDemandUnavailabilityCache.get(unavailabilityCacheKey(betfairEventId, marketType));
  if (!entry) return false;
  if (Date.now() - entry.triedAt >= ONDEMAND_CACHE_TTL_MS) return false;
  return !entry.foundMarkets;
}

async function triggerOnDemandFetch(
  matchId: number,
  betfairEventId: string,
  marketType: string,
  homeTeam: string,
  awayTeam: string,
): Promise<void> {
  // Fire-and-forget from the caller; this helper updates the cache so the
  // *next* lazy-promote cycle can either re-attempt against a fresh
  // snapshot or skip via the cache. Never throws to the caller — errors are
  // logged and the cache is set to a permissive default.
  const cacheKey = unavailabilityCacheKey(betfairEventId, marketType);
  try {
    const result = await sweepEventOnDemand(matchId, betfairEventId, homeTeam, awayTeam);
    onDemandUnavailabilityCache.set(cacheKey, {
      triedAt: Date.now(),
      foundMarkets: result.foundMarkets,
    });
    logger.info(
      {
        matchId, betfairEventId, marketType,
        resolvedEventId: result.resolvedEventId,
        marketsDiscovered: result.marketsDiscovered,
        snapshotsWritten: result.snapshotsWritten,
        reason: result.reason,
      },
      "onDemandFetch: targeted exchange refresh complete",
    );
    void db.insert(complianceLogsTable).values({
      actionType: "ondemand_exchange_fetch",
      details: {
        matchId,
        betfairEventId,
        resolvedEventId: result.resolvedEventId,
        marketType,
        marketsDiscovered: result.marketsDiscovered,
        snapshotsWritten: result.snapshotsWritten,
        foundMarkets: result.foundMarkets,
        reason: result.reason,
      } as Record<string, unknown>,
      timestamp: new Date(),
    } as any);
  } catch (err) {
    // On error, write a short-TTL cache entry so the same event isn't
    // re-fetched immediately while we log and recover.
    onDemandUnavailabilityCache.set(cacheKey, {
      triedAt: Date.now(),
      foundMarkets: false,
    });
    logger.warn(
      { err, matchId, betfairEventId, marketType },
      "onDemandFetch: sweepEventOnDemand threw — cached as unavailable for 6h",
    );
  }
}

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

// 2026-05-14 Block C — classify placeResult.error into a structured
// (reason, errorClass) pair so SQL audits over lazy_promote_placement_failed
// can histogram failure modes without scraping pm2 logs. Buckets the error
// strings emitted by placeLiveBetOnBetfair (betfairLive.ts) and the relayed
// Betfair API errors. Unknown strings fall through to ("betfair_other",
// "other") so the row is still queryable and we can iterate.
function classifyPlacementFailure(
  error: string | null | undefined,
  unavailableOnExchange?: boolean,
): { reason: string; errorClass: string } {
  if (unavailableOnExchange) return { reason: "market_unavailable_on_exchange", errorClass: "exchange_availability" };
  const e = String(error ?? "").trim();
  if (!e) return { reason: "no_error_string", errorClass: "unknown" };
  const upper = e.toUpperCase();

  if (upper.includes("INSUFFICIENT_FUNDS") || upper.includes("INSUFFICIENT FUNDS"))
    return { reason: "insufficient_funds", errorClass: "wallet" };
  if (e.startsWith("SLIPPAGE_") || upper.startsWith("SLIPPAGE_"))
    return { reason: "slippage_guard_blocked", errorClass: "slippage" };
  if (e.includes("below Betfair minimum") || upper.includes("BELOW BETFAIR MINIMUM"))
    return { reason: "stake_below_minimum", errorClass: "sizing" };
  if (e.includes("Cannot map selection"))
    return { reason: "selection_unmappable", errorClass: "mapping" };
  if (e.includes("no runners") || upper.includes("NO RUNNERS"))
    return { reason: "market_empty", errorClass: "exchange_availability" };
  if (upper.includes("MARKET UNAVAILABLE") || upper.includes("UNAVAILABLE ON BETFAIR"))
    return { reason: "market_unavailable_on_exchange", errorClass: "exchange_availability" };
  if (upper.includes("INVALID_BET") || upper.includes("ERROR_IN_ORDER") || upper.includes("INVALID_ODDS") || upper.includes("INVALID_BACK_LAY_COMBINATION"))
    return { reason: "betfair_invalid_order", errorClass: "betfair_api" };
  if (upper.includes("BET_TAKEN_OR_LAPSED") || upper.includes("MARKET_NOT_OPEN_FOR_BETTING") || upper.includes("EVENT_INACTIVE"))
    return { reason: "market_lifecycle_closed", errorClass: "exchange_availability" };
  if (upper.includes("TIMEOUT") || upper.includes("ECONNREFUSED") || upper.includes("ETIMEDOUT"))
    return { reason: "relay_network_error", errorClass: "infra" };
  if (upper.includes("COLLAPSE") || upper.includes("DUP_GUARD") || upper.includes("DUPLICATE"))
    return { reason: "collapse_guard_blocked", errorClass: "safety" };
  return { reason: "betfair_other", errorClass: "other" };
}

// 2026-05-10: extended from 6h to 168h to match trading_far emission window.
// Pre-fix, only bets within 6h of kickoff were lazy-promote eligible.
// Today's analysis found 216 quality AH shadow bets (Tier A + score 70+ +
// Pinnacle + mapped Betfair event + Exchange AH snapshot) sitting beyond 6h
// with no promotion mechanism. They were emitted as shadow when the fixture
// was af_*-unmapped; mapping has since resolved them but the existing shadow
// rows have no path to live without re-emission. Wider lazy-promote window
// catches them. Cost: more candidate scans per cron cycle (5min cadence).
// Each candidate still gates on fresh Exchange snapshot (30 min) + Kelly
// stake ≥ £2 fallback + scope checks — so widening the window doesn't lower
// the placement quality bar, just expands the eligible pool.
const KICKOFF_LOOKAHEAD_HOURS = 168;
const BETFAIR_MIN_STAKE = 2.00;

export interface LazyPromoteResult {
  evaluated_at: string;
  pending_shadow_count: number;
  promoted: number;
  skipped_no_exchange: number;
  skipped_kelly_below_min: number;
  // 2026-05-14 Fix 2: when a recent on-demand catalogue fetch confirmed the
  // event has no relevant markets (cached for 6h), short-circuit subsequent
  // placement attempts on the same (event, market_type) without burning relay
  // API budget.
  skipped_event_unavailable_cached: number;
  skipped_paper_already_exists: number;
  skipped_kickoff_too_far: number;
  // 2026-05-14: adaptive Kelly haircut applied at lazy-promote time. Distinct
  // demotion counters surface Wilson-LCB shadow routes from this rail.
  skipped_adaptive_negative_kelly: number;     // f̂ ≤ 0
  skipped_adaptive_wilson_lcb_negative: number; // f̂ > 0 but f_lo ≤ 0
  // 2026-05-14: agent_status (paused_streak / paused_daily / paused_weekly)
  // halts lazy-promote alongside the kill switch. Mirrors the trading-cycle
  // forceShadowOnly behaviour so both rails respect circuit breakers
  // consistently.
  skipped_agent_paused: number;
  // 2026-05-14: distinct counter for downstream Betfair placement failures
  // (INSUFFICIENT_FUNDS, market unavailable, slippage, etc.). Previously
  // these were bucketed into `errors`; splitting them out lets the operator
  // distinguish "Betfair said no" from "code threw".
  betfair_rejected: number;
  // 2026-05-17 (Bundle 5.G) — leak guards before promotion. Stale shadow odds
  // can drift far from current Pinnacle/Betfair pricing by the time the
  // promoter picks them up; promoting blindly against the stored odds_at_
  // placement would route capital based on an edge that no longer exists.
  // skipped_edge_evaporated: latest Pinnacle implied says edge_pp dropped
  //   below lazy_promote_min_pinnacle_edge_pp (default 1pp) on the stored
  //   odds.
  // skipped_betfair_drift_too_large: latest Betfair best-back differs from
  //   stored odds_at_placement by more than lazy_promote_max_betfair_drift_pct
  //   (default 5%) — placeLiveBetOnBetfair would fill at a price our edge
  //   calc never assumed.
  skipped_edge_evaporated: number;
  skipped_betfair_drift_too_large: number;
  errors: number;
}

export async function runLazyPromoteShadowToPaper(): Promise<LazyPromoteResult> {
  const result: LazyPromoteResult = {
    evaluated_at: new Date().toISOString(),
    pending_shadow_count: 0,
    promoted: 0,
    skipped_no_exchange: 0,
    skipped_kelly_below_min: 0,
    skipped_event_unavailable_cached: 0,
    skipped_paper_already_exists: 0,
    skipped_kickoff_too_far: 0,
    skipped_adaptive_negative_kelly: 0,
    skipped_adaptive_wilson_lcb_negative: 0,
    skipped_agent_paused: 0,
    betfair_rejected: 0,
    skipped_edge_evaporated: 0,
    skipped_betfair_drift_too_large: 0,
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

  // Task 2 (2026-05-11): the small-bankroll £2 min-stake fallback was removed
  // from this path along with the direct-emission path in paperTrading.ts.
  // Kelly-below-£2 stakes stay shadow until the market moves enough to push
  // Kelly above £2 on a later lazy-promote pass. min_edge_threshold remains
  // a separate emission-time floor in valueDetection; it no longer gates the
  // min-stake decision here.

  // Cutover state: post-cutover, promote shadow→live (real Betfair placement).
  // Pre-cutover: legacy shadow→paper. The §3 trigger forbids paper INSERTs
  // post-cutover; we honour that here by gating UPDATEs to bet_track='paper'
  // on the same condition.
  const cutoverCompletedAtRaw = await getConfig("cutover_completed_at");
  const cutoverActive = !!cutoverCompletedAtRaw && cutoverCompletedAtRaw.trim() !== "";

  // 2026-05-12: tier hardcode replaced with eligibility-view gate. Previously
  // `universe_tier_at_placement = 'A'` rejected Tier B/C bets regardless of
  // scope. The eligibility view (v_live_eligibility_candidates) is the
  // empirical proof gate — n>=30 settled bets with Wilson lo95 winrate > 50%
  // AND/OR CLV t-stat > 1.96. Tier is an emission-time a priori signal;
  // when empirical data proves a scope is +EV, the a priori conservatism
  // should not override the empirical proof.
  //
  // Bundle B groups by (league, market_type, bet_track) — the Wilson + CLV
  // numbers it produces already average across the tier mix in that scope.
  // Promoting any tier in an eligible scope is consistent with the proof.
  //
  // Per project_shadow_bets_principle: previously Tier B/C £0 bets bypassed
  // every capital-risk gate. That made sense when there was no empirical
  // signal to override the tier ladder. With Bundle B + the eligibility
  // view, the data-driven gate exists and supersedes.
  // 2026-05-13 Lever A+G — selector now reads BOTH eligibility paths:
  //   (a) per-scope qualification via v_live_eligibility_candidates, OR
  //   (b) market_type aggregate qualification via v_live_eligibility_market_types
  //       with three-signal disproof carve-out (n>=30 AND roi<0 AND clv_t_stat<0
  //       at the per-(league × market) scope). Identical disjunction as the
  //       placement gate in paperTrading.ts so shadow inventory can flow live
  //       through the same statistical reasoning that authorises fresh
  //       placements.
  const candidates = await db.execute(sql`
    WITH latest_signal AS (
      SELECT league, market_type, n, roi, clv_t_stat
      FROM analysis_signal_strength
      WHERE computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength)
        AND league <> '__market_type_aggregate__'
    ),
    disproven AS (
      SELECT league, market_type FROM latest_signal
      WHERE n >= 30 AND roi < 0 AND clv_t_stat < 0
    )
    SELECT pb.id, pb.match_id, pb.market_type, pb.selection_name,
           pb.selection_canonical, pb.opportunity_score::numeric AS score,
           pb.calculated_edge::numeric AS edge,
           pb.odds_at_placement::numeric AS odds,
           pb.universe_tier_at_placement AS universe_tier,
           m.league AS league
    FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
    WHERE pb.bet_track = 'shadow'
      AND pb.status = 'pending'
      AND pb.legacy_regime = false
      AND pb.deleted_at IS NULL
      AND pb.placed_at >= ${new Date(evalStartStr)}
      AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '${sql.raw(String(KICKOFF_LOOKAHEAD_HOURS))} hours'
      AND (
        (m.league, pb.market_type) IN (
          SELECT league, market_type FROM v_live_eligibility_candidates
        )
        OR (
          pb.market_type IN (
            SELECT market_type FROM v_live_eligibility_market_types
          )
          AND (m.league, pb.market_type) NOT IN (
            SELECT league, market_type FROM disproven
          )
        )
      )
    ORDER BY pb.calculated_edge DESC NULLS LAST
  `);
  const rows = (((candidates as any).rows ?? []) as Array<{
    id: number; match_id: number; market_type: string; selection_name: string;
    selection_canonical: string | null;
    score: string | number; edge: string | number; odds: string | number;
    universe_tier: string;
    league: string | null;
  }>);
  result.pending_shadow_count = rows.length;
  if (rows.length === 0) return result;

  for (const r of rows) {
    try {
      // 2026-05-12: drop the strict/relaxed conditional. The strict variant
      // (30-min exact-selection-name snapshot) structurally cannot lazy-
      // promote any non-default AH sub-line because exchange_book_sweep only
      // captures the ±4 default line per event (Bundle 6.5 finding). Most
      // Tier A flow lives on Home +2 / Away +1.5 / etc. Use the relaxed
      // 24h-any-selection-on-market check: Betfair will either match or
      // reject with market_unavailable, and the demote handler in
      // paperTrading handles rejections cleanly.
      //
      // Bug history: a `strictAhOnly` config flag governed this conditional
      // until the AH-only mode was removed (commit 7d55f74, 2026-05-11). The
      // variable definition was deleted but its reference at this line was
      // not — every lazy-promote candidate threw ReferenceError silently for
      // 24h before this fix. Lazy promotion was therefore 0/day from
      // 2026-05-11 onward despite Tier A shadow bets accruing.
      //
      // 2026-05-14: snapshot-freshness gate REMOVED. The 24h-snapshot test
      // was a stale heuristic proxy for tradeability — not a probabilistic
      // statement. The actual test of tradeability is the exchange API call
      // at placement time inside placeLiveBetOnBetfair, which:
      //   - calls relayGetLiquidity / listMarketCatalogue to discover markets,
      //   - falls back to findEventIdByTeamNames for af_* placeholder IDs
      //     (betfairLive.ts:1591 — so af_* bets CAN place natively),
      //   - returns unavailableOnExchange=true cleanly when no market exists.
      //
      // Removing the proxy unblocks ~1,466 eligible-scope shadow bets per
      // day (929 numeric-id matches kicking off in 24–168h that the sweep
      // has not yet covered + 537 af_* matches that the placement-time
      // resolver handles natively). The downstream lazy_promote_placement_failed
      // path (Block C) classifies any actual rejection into reason +
      // errorClass so unmappable / unavailable events stay shadow and the
      // operator can audit the rejection rate from SQL.
      //
      // Theory: scope eligibility (Wilson lo95 > 0.50 OR CLV t > 1.96 at
      // n>=30, OR market_type aggregate three-gate pass) is the probabilistic
      // proof that a bet should deploy capital. Symmetric to Block ZERO —
      // an eligible scope is a placement candidate unless the actual exchange
      // says otherwise. The skipped_no_exchange counter is retained in the
      // result interface for backward compatibility with operator dashboards
      // but is no longer incremented.

      // Check no live (or legacy paper) bet already exists on the same
      // canonical selection for this match. Post-cutover this branch promotes
      // shadow→live, so the dup-check must include live; the unique partial
      // index would error on conflict anyway but checking up-front is cleaner.
      if (r.selection_canonical) {
        const dup = await db.execute(sql`
          SELECT 1 FROM paper_bets
          WHERE match_id = ${r.match_id}
            AND market_type = ${r.market_type}
            AND selection_canonical = ${r.selection_canonical}
            AND bet_track IN ('paper', 'live')
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

      // 2026-05-14: apply adaptive Kelly factor (Wilson-LCB / Kelly-LCB ratio)
      // BEFORE max_stake_pct cap, mirroring paperTrading.ts. The placement
      // gate in paperTrading already routes new bets through this; the
      // lazy-promote rail (which doesn't go through placePaperBet) was
      // bypassing the factor entirely until this fix. ~79% of today's
      // deployed capital flows through lazy-promote, so this is where the
      // adaptive sizing matters most.
      let adaptiveMultiplier = 1.0;
      let adaptiveAudit: { pHat: number; pLo: number; fHat: number; fLo: number; rawFactor: number; cappedFactor: number; path: "per_scope" | "aggregate_only" } | null = null;
      if (r.league) {
        const adaptive = await computeAdaptiveKellyFactor(r.league, r.market_type, odds);
        if ("reason" in adaptive) {
          if (adaptive.reason === "negative_kelly") {
            result.skipped_adaptive_negative_kelly++;
            await db.insert(complianceLogsTable).values({
              actionType: "shadow_gate_exemption",
              details: {
                reason: "scope_eligible_but_negative_kelly",
                betId: r.id, matchId: r.match_id, marketType: r.market_type,
                league: r.league, backOdds: odds,
                pHat: adaptive.pHat, pLo: adaptive.pLo,
                fHat: adaptive.fHat, fLo: adaptive.fLo,
                source: "lazy_promote",
              },
              timestamp: new Date(),
            });
            continue;
          }
          if (adaptive.reason === "wilson_lcb_negative") {
            result.skipped_adaptive_wilson_lcb_negative++;
            await db.insert(complianceLogsTable).values({
              actionType: "shadow_gate_exemption",
              details: {
                reason: "scope_eligible_but_wilson_lcb_negative",
                betId: r.id, matchId: r.match_id, marketType: r.market_type,
                league: r.league, backOdds: odds,
                pHat: adaptive.pHat, pLo: adaptive.pLo,
                fHat: adaptive.fHat, fLo: adaptive.fLo,
                source: "lazy_promote",
              },
              timestamp: new Date(),
            });
            continue;
          }
          // reason === "no_evidence": keep multiplier=1.0 (eligibility gate
          // already accepted; trust the existing score-keyed fraction).
        } else {
          adaptiveMultiplier = adaptive.factor;
          adaptiveAudit = {
            pHat: adaptive.pHat, pLo: adaptive.pLo,
            fHat: adaptive.fHat, fLo: adaptive.fLo,
            rawFactor: adaptive.rawFactor, cappedFactor: adaptive.factor,
            path: adaptive.path,
          };
        }
      }

      // Kelly stake = bankroll × kellyFraction × edge / (odds - 1) × adaptiveMultiplier
      let stake = bankroll * kellyFraction * edge / (odds - 1) * adaptiveMultiplier;
      stake = Math.min(stake, maxStake);
      stake = Math.round(stake * 100) / 100;
      // Task 2 (2026-05-11): no min-stake floor. If lazy-recomputed Kelly is
      // below the Betfair minimum, leave the row as shadow — the next pass
      // will retry as the market moves. Flooring to £2 contradicted Kelly
      // theory and broke long-term log-growth; see paperTrading.ts:1700
      // for the matching change on the direct-emission path.
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

        // 2026-05-15 — per-market-type kill switch. Mirrors the check in
        // paperTrading.placePaperBet so lazy-promote doesn't bypass the
        // gate on the ~79% of capital that flows through this path.
        const disabledCsv = (await getConfig("live_placement_disabled_market_types")) ?? "";
        const disabledSet = new Set(
          disabledCsv
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        );
        if (disabledSet.has(r.market_type.toUpperCase())) {
          result.skipped_kelly_below_min++;  // reuse counter
          continue;
        }

        // 2026-05-14: also honour agent_status circuit breakers. paused_streak
        // (consecutive-loss halt), paused_daily and paused_weekly all gate
        // production-track placement in the trading cycle via forceShadowOnly.
        // The lazy-promote rail must respect the same signal — the same loss
        // distribution that fired the breaker covers candidates here too. Keep
        // lazy-promote logically equivalent to a "fresh emission via
        // placePaperBet"; not honouring agent_status lets thousands of pending
        // shadow bets quietly route live while the trading cycle has stopped.
        const agentStatus = await getConfig("agent_status");
        if (agentStatus !== null && agentStatus !== "running") {
          result.skipped_agent_paused++;
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

        // 2026-05-14 Fix 2 — short-circuit if a recent on-demand catalogue
        // fetch confirmed this (event, market_type) has no relevant markets
        // on Betfair. The 6h cache prevents the same dead event from being
        // retried every 5 minutes (~71 wasted relay calls per event before
        // this gate). Cache entry is cleared on next sweep cycle when TTL
        // expires.
        if (isCachedAsUnavailable(m.betfair_event_id, r.market_type)) {
          result.skipped_event_unavailable_cached++;
          continue;
        }

        // ── Bundle 5.G + Bundle 10 (2026-05-17): stale-odds + 3-7pp band ─
        // Lazy promoter MUST enforce the same gate as direct emission
        // (Chris 2026-05-17: "any pathway to eligible live bet has to
        // have a 3-7pp sharp edge found"). Reads min_net_edge_pp (3.0)
        // and inversion_live_max_edge_pp (7.0) — the same band the
        // inversion gate uses. Computes post-slip edge against the
        // CURRENT Betfair best-back (not stored odds) + CURRENT
        // pinnacle_implied (≤15 min freshness). Outside the band →
        // stays shadow with a structured compliance_logs row.
        //
        // PINNACLE-ABSENT scopes (routed via v_live_eligibility market
        // aggregate) still need a Pinnacle anchor to clear the band —
        // they can't promote under Bundle 10's discipline. Sharp-anchor
        // is the gate.
        //
        // Slippage default: 0.015 (1.5pp) — matches the inversion gate's
        // defaultP75Slippage fallback. When real per-(market×ttk)
        // slippage data accumulates, the gate uses that; lazy promote
        // can be upgraded to call v_slippage_p75_rolling too (deferred).
        try {
          // Fetch fresh Pinnacle anchor + fresh Betfair best-back in
          // parallel so we always evaluate against current prices.
          const [pinnRow, bfRow] = await Promise.all([
            db.execute(sql`
              SELECT pinnacle_implied::float8 AS pinn_implied
              FROM pinnacle_odds_snapshots
              WHERE match_id = ${r.match_id}
                AND market_type = ${r.market_type}
                AND selection_name = ${r.selection_name}
                AND bookmaker_slug = 'pinnacle'
                AND captured_at >= NOW() - INTERVAL '15 minutes'
              ORDER BY captured_at DESC
              LIMIT 1
            `) as unknown as Promise<{ rows?: Array<{ pinn_implied: number | null }> }>,
            db.execute(sql`
              SELECT back_odds::float8 AS back_odds
              FROM odds_snapshots
              WHERE match_id = ${r.match_id}
                AND market_type = ${r.market_type}
                AND selection_name = ${r.selection_name}
                AND source = 'betfair_exchange'
                AND snapshot_time >= NOW() - INTERVAL '10 minutes'
              ORDER BY snapshot_time DESC
              LIMIT 1
            `) as unknown as Promise<{ rows?: Array<{ back_odds: number | null }> }>,
          ]);
          const pinnImplied = pinnRow.rows?.[0]?.pinn_implied;
          const currentBack = bfRow.rows?.[0]?.back_odds ?? odds;
          if (pinnImplied != null && Number.isFinite(pinnImplied) && pinnImplied > 0) {
            const minEdgeRaw = await getConfig("min_net_edge_pp");
            const maxEdgeRaw = await getConfig("inversion_live_max_edge_pp");
            const minEdgePp = minEdgeRaw != null ? Number(minEdgeRaw) : 3.0;
            const maxEdgePp = maxEdgeRaw != null ? Number(maxEdgeRaw) : 7.0;
            const slippage = 0.015;
            const postSlipEdgePp = (currentBack * (1 - slippage) * pinnImplied - 1) * 100;
            const belowFloor = postSlipEdgePp < minEdgePp;
            const aboveCeiling = postSlipEdgePp > maxEdgePp;
            if (belowFloor || aboveCeiling) {
              result.skipped_edge_evaporated++;
              await db.insert(complianceLogsTable).values({
                actionType: "lazy_promote_edge_outside_band",
                details: {
                  betId: r.id,
                  matchId: r.match_id,
                  marketType: r.market_type,
                  selectionName: r.selection_name,
                  storedOdds: odds,
                  currentBack,
                  currentPinnImplied: pinnImplied,
                  postSlipEdgePp,
                  minEdgePp,
                  maxEdgePp,
                  reason: belowFloor ? "below_3pp_floor" : "above_7pp_ceiling",
                  source: "lazy_promote",
                },
                timestamp: new Date(),
              } as any);
              continue;
            }
          } else {
            // No Pinnacle anchor → no sharp edge → no live placement
            // under Bundle 10's discipline. Sharp-anchor IS the gate.
            result.skipped_edge_evaporated++;
            await db.insert(complianceLogsTable).values({
              actionType: "lazy_promote_edge_outside_band",
              details: {
                betId: r.id,
                matchId: r.match_id,
                marketType: r.market_type,
                selectionName: r.selection_name,
                storedOdds: odds,
                currentBack,
                currentPinnImplied: null,
                reason: "no_pinnacle_anchor",
                source: "lazy_promote",
              },
              timestamp: new Date(),
            } as any);
            continue;
          }
        } catch (err) {
          // Edge re-check failed (DB hiccup). FAIL SAFE — do NOT promote
          // when we can't verify edge. Earlier Bundle 5.G used a "log and
          // proceed" pattern; Bundle 10 tightens to a hard skip because
          // the band is the activation discipline.
          logger.warn(
            { err, betId: r.id, matchId: r.match_id },
            "lazyPromote: edge re-check failed — skipping promotion (fail safe)",
          );
          result.skipped_edge_evaporated++;
          continue;
        }

        // (2) Betfair drift check
        try {
          const bfRow = (await db.execute(sql`
            SELECT back_odds::float8 AS back_odds
            FROM odds_snapshots
            WHERE match_id = ${r.match_id}
              AND market_type = ${r.market_type}
              AND selection_name = ${r.selection_name}
              AND source = 'betfair_exchange'
              AND snapshot_time >= NOW() - INTERVAL '10 minutes'
            ORDER BY snapshot_time DESC
            LIMIT 1
          `)) as unknown as { rows?: Array<{ back_odds: number | null }> };
          const bestBack = bfRow.rows?.[0]?.back_odds;
          if (bestBack != null && Number.isFinite(bestBack) && bestBack > 1) {
            const driftPct = Math.abs((bestBack - odds) / odds);
            const maxDriftRaw = await getConfig("lazy_promote_max_betfair_drift_pct");
            const maxDrift = maxDriftRaw != null ? Number(maxDriftRaw) : 0.05;
            if (Number.isFinite(maxDrift) && driftPct > maxDrift) {
              result.skipped_betfair_drift_too_large++;
              await db.insert(complianceLogsTable).values({
                actionType: "lazy_promote_betfair_drift",
                details: {
                  betId: r.id,
                  matchId: r.match_id,
                  marketType: r.market_type,
                  selectionName: r.selection_name,
                  storedOdds: odds,
                  currentBestBack: bestBack,
                  driftPct,
                  maxDrift,
                  source: "lazy_promote",
                },
                timestamp: new Date(),
              } as any);
              continue;
            }
          }
        } catch (err) {
          logger.warn(
            { err, betId: r.id, matchId: r.match_id },
            "lazyPromote: Betfair drift re-check failed (non-blocking)",
          );
        }

        const { placeLiveBetOnBetfair } = await import("./betfairLive");
        const promoteEdge = Number(r.edge);
        const placeResult = await placeLiveBetOnBetfair({
          internalBetId: r.id,
          betfairEventId: m.betfair_event_id,
          marketType: r.market_type,
          selectionName: r.selection_name,
          odds,
          stake,
          homeTeam: m.home_team,
          awayTeam: m.away_team,
          // Task 24 Part D — pass edge so the persistence-type resolver
          // can opt into PERSIST for high-edge AH (flag-gated).
          edge: Number.isFinite(promoteEdge) ? promoteEdge : undefined,
        });

        if (!placeResult.success || !placeResult.betfairBetId) {
          // Stays shadow. placeLiveBetOnBetfair may have written its own
          // compliance event for some failure modes, but not all paths log
          // (e.g. INSUFFICIENT_FUNDS, market unavailable). Write a dedicated
          // lazy_promote_placement_failed row so the operator can audit
          // Betfair-side rejection rates from SQL alone, without scraping
          // pm2 logs.
          //
          // 2026-05-14 Block C — classify the raw error into (reason, errorClass)
          // so audits can histogram failure modes. Before this, all 72k+
          // daily rows had details.reason = null, making SQL diagnosis
          // impossible.
          const { reason, errorClass } = classifyPlacementFailure(
            placeResult.error,
            (placeResult as { unavailableOnExchange?: boolean }).unavailableOnExchange,
          );
          logger.info(
            { betId: r.id, matchId: r.match_id, error: placeResult.error, reason, errorClass },
            "lazyPromote: live placement failed — bet stays shadow for retry",
          );
          await db.insert(complianceLogsTable).values({
            actionType: "lazy_promote_placement_failed",
            details: {
              betId: r.id,
              matchId: r.match_id,
              marketType: r.market_type,
              selectionName: r.selection_name,
              odds, stake, score, edge, bankroll,
              betfairEventId: m.betfair_event_id,
              error: placeResult.error ?? null,
              reason,
              errorClass,
              unavailableOnExchange: (placeResult as { unavailableOnExchange?: boolean }).unavailableOnExchange ?? false,
              adaptiveKelly: adaptiveAudit,
            } as Record<string, unknown>,
            timestamp: new Date(),
          } as any);
          result.betfair_rejected++;

          // 2026-05-14 Fix 2 — on unavailableOnExchange, trigger a targeted
          // catalogue refresh for the event. Fire-and-forget: this populates
          // odds_snapshots if Betfair has markets we missed, and sets the
          // 6h cache so the next 71 cycles don't retry this dead event.
          // Other failure modes (slippage, insufficient_funds, invalid_order)
          // are NOT events we want to re-sweep — they're placement-time
          // issues, not catalogue-coverage issues.
          const unavailable = (placeResult as { unavailableOnExchange?: boolean }).unavailableOnExchange === true
            || reason === "market_unavailable_on_exchange";
          if (unavailable) {
            void triggerOnDemandFetch(
              r.match_id,
              m.betfair_event_id,
              r.market_type,
              m.home_team,
              m.away_team,
            );
          }

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
            // 2026-05-14: adaptive Kelly audit at lazy-promote time. null when
            // no scope evidence row exists (factor=1.0 applied by default).
            adaptiveKelly: adaptiveAudit,
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
