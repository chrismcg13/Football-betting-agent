import {
  db,
  agentConfigTable,
  paperBetsTable,
  matchesTable,
  complianceLogsTable,
  oddsSnapshotsTable,
  competitionConfigTable,
} from "@workspace/db";
import { eq, and, gte, lt, lte, inArray, desc, sql, isNull, or } from "drizzle-orm";
import { logger } from "../lib/logger";
import { retrainIfNeeded } from "./predictionEngine";
import { fetchMatchStatsForSettlement, getFixturesForDate, teamNameMatch, isApiFootballCircuitOpen } from "./apiFootball";
import { getThresholdCategory } from "./correlationDetector";
import {
  isLiveMode,
  placeLiveBetOnBetfair,
  isBalanceStale,
  getLiveBankroll,
  markMarketUnavailable,
  recordPlacementFailure,
  clearPlacementFailures,
} from "./betfairLive";
import {
  listMarketCatalogue,
  listMarketBook,
  type MarketCatalogueItem,
  type MarketBook,
} from "./betfair";
import { isLeagueMarketTier1Eligible } from "./dataRichness";
import { getLiveOppScoreThreshold } from "./liveThresholdReview";
import { storePinnacleSnapshot } from "./oddsPapi";
import { shouldBlockBet, getSegmentKellyMultiplier, getMarketFamily } from "./edgeConcentration";
import {
  getEffectiveLimits,
  runLiveConcentrationChecks,
  getLiveKellyFraction,
  getCurrentLiveRiskLevel,
  checkSlippage,
  checkLiveCircuitBreakers,
  isBetfairApiPaused,
} from "./liveRiskManager";
import { detectCurrentRegime } from "./marketRegime";

// ===================== C1: Exchange-book capture (delayed app key) ========
// Captured at placement time via listMarketCatalogue + listMarketBook on the
// delayed app key (BETFAIR_APP_KEY, NOT LIVE_BETFAIR_KEY). Capture is purely
// analytical — it never blocks, throws, or talks to placeOrders. All failure
// paths increment a counter and return null so the bet still goes in.

const CATALOGUE_TTL_MS = 5 * 60 * 1000;
const catalogueCache = new Map<string, { fetchedAt: number; items: MarketCatalogueItem[] }>();

export async function getCatalogueForEvent(eventId: string): Promise<MarketCatalogueItem[]> {
  const cached = catalogueCache.get(eventId);
  if (cached && Date.now() - cached.fetchedAt < CATALOGUE_TTL_MS) {
    return cached.items;
  }
  const items = await listMarketCatalogue([eventId]);
  catalogueCache.set(eventId, { fetchedAt: Date.now(), items });
  return items;
}

interface ExchangeCaptureCounters {
  attempted: number;
  captured: number;
  failed_no_event: number;
  failed_no_market: number;
  failed_no_selection: number;
  failed_api: number;
  cross_spread_samples: number[];
  queue_position_samples: number[];
}

let exchangeCaptureCounters: ExchangeCaptureCounters = {
  attempted: 0,
  captured: 0,
  failed_no_event: 0,
  failed_no_market: 0,
  failed_no_selection: 0,
  failed_api: 0,
  cross_spread_samples: [],
  queue_position_samples: [],
};

export function resetExchangeCaptureCounters(): void {
  exchangeCaptureCounters = {
    attempted: 0,
    captured: 0,
    failed_no_event: 0,
    failed_no_market: 0,
    failed_no_selection: 0,
    failed_api: 0,
    cross_spread_samples: [],
    queue_position_samples: [],
  };
}

export function getExchangeCaptureCounters(): {
  attempted: number;
  captured: number;
  failed_no_event: number;
  failed_no_market: number;
  failed_no_selection: number;
  failed_api: number;
  capture_rate_pct: number;
  avg_cross_spread_vs_lay: number | null;
  avg_queue_position_vs_back: number | null;
  fills_immediately_count: number;
  fills_immediately_pct: number;
  sample_count: number;
} {
  const c = exchangeCaptureCounters;
  const sample_count = c.cross_spread_samples.length;
  const avg_cross_spread_vs_lay =
    sample_count > 0
      ? c.cross_spread_samples.reduce((a, b) => a + b, 0) / sample_count
      : null;
  const avg_queue_position_vs_back =
    c.queue_position_samples.length > 0
      ? c.queue_position_samples.reduce((a, b) => a + b, 0) / c.queue_position_samples.length
      : null;
  // "Fills immediately" = our backed price is at or above the prevailing best
  // back (queue position sample <= 0 means we're at-or-better than the front
  // of the queue, i.e. would match instantly on a real exchange order).
  const fills_immediately_count = c.queue_position_samples.filter((q) => q <= 0).length;
  const fills_immediately_pct =
    c.queue_position_samples.length > 0
      ? (fills_immediately_count / c.queue_position_samples.length) * 100
      : 0;
  const capture_rate_pct = c.attempted > 0 ? (c.captured / c.attempted) * 100 : 0;
  return {
    attempted: c.attempted,
    captured: c.captured,
    failed_no_event: c.failed_no_event,
    failed_no_market: c.failed_no_market,
    failed_no_selection: c.failed_no_selection,
    failed_api: c.failed_api,
    capture_rate_pct: Math.round(capture_rate_pct * 100) / 100,
    avg_cross_spread_vs_lay:
      avg_cross_spread_vs_lay != null
        ? Math.round(avg_cross_spread_vs_lay * 10000) / 10000
        : null,
    avg_queue_position_vs_back:
      avg_queue_position_vs_back != null
        ? Math.round(avg_queue_position_vs_back * 10000) / 10000
        : null,
    fills_immediately_count,
    fills_immediately_pct: Math.round(fills_immediately_pct * 100) / 100,
    sample_count,
  };
}

interface ExchangeSnapshot {
  bestBack: number | null;
  bestBackSize: number | null;
  bestLay: number | null;
  bestLaySize: number | null;
  selectionId: number | null;
  fetchedAt: Date;
}

// Allowlist: only numeric Betfair event IDs. Rejects "af_*", "fd_*", and any
// other foreign-source prefixes that may have leaked into matches.betfair_event_id.
const BETFAIR_EVENT_ID_RE = /^\d+$/;

async function captureExchangeSnapshot(args: {
  betfairEventId: string | null;
  marketType: string;
  selectionName: string;
  homeTeam: string;
  awayTeam: string;
  matchId: number;
}): Promise<ExchangeSnapshot | null> {
  exchangeCaptureCounters.attempted += 1;
  const { betfairEventId, marketType, selectionName, homeTeam, awayTeam, matchId } = args;

  if (!betfairEventId || !BETFAIR_EVENT_ID_RE.test(betfairEventId)) {
    exchangeCaptureCounters.failed_no_event += 1;
    return null;
  }

  let catalogue: MarketCatalogueItem[];
  try {
    catalogue = await getCatalogueForEvent(betfairEventId);
  } catch (err) {
    exchangeCaptureCounters.failed_api += 1;
    logger.warn(
      { err, matchId, betfairEventId, marketType },
      "C1 capture: listMarketCatalogue failed",
    );
    return null;
  }

  const market = catalogue.find(
    (m) => m.description?.marketType === marketType,
  );
  if (!market) {
    exchangeCaptureCounters.failed_no_market += 1;
    return null;
  }

  const runners = market.runners ?? [];
  let selectionId: number | null;
  try {
    const { findSelectionId } = await import("./betfairLive");
    selectionId = findSelectionId(runners, selectionName, homeTeam, awayTeam);
  } catch (err) {
    exchangeCaptureCounters.failed_no_selection += 1;
    logger.warn(
      { err, matchId, betfairEventId, marketType, selectionName },
      "C1 capture: findSelectionId import/call failed",
    );
    return null;
  }
  if (selectionId == null) {
    exchangeCaptureCounters.failed_no_selection += 1;
    return null;
  }

  let books: MarketBook[];
  try {
    books = await listMarketBook([market.marketId]);
  } catch (err) {
    exchangeCaptureCounters.failed_api += 1;
    logger.warn(
      { err, matchId, betfairEventId, marketId: market.marketId },
      "C1 capture: listMarketBook failed",
    );
    return null;
  }

  const book = books[0];
  if (!book) {
    exchangeCaptureCounters.failed_api += 1;
    return null;
  }

  const runner = book.runners.find((r) => r.selectionId === selectionId);
  if (!runner) {
    exchangeCaptureCounters.failed_no_selection += 1;
    return null;
  }

  const back = runner.ex?.availableToBack?.[0];
  const lay = runner.ex?.availableToLay?.[0];

  return {
    bestBack: back?.price ?? null,
    bestBackSize: back?.size ?? null,
    bestLay: lay?.price ?? null,
    bestLaySize: lay?.size ?? null,
    selectionId,
    fetchedAt: new Date(),
  };
}

// ===================== Selection-name canonicalization =====================
// 2026-04-19: Bookmakers serve OU selections as both "Over 2.5" and
// "Over 2.5 Goals" — the dedup logic compared raw strings and missed the
// variant, allowing duplicate placements on the same selection. Canonical form
// strips trailing " Goals", lowercases, and trims. Used by both the dedup
// pre-check and persisted to selection_canonical for the partial unique index
// that race-protects parallel cycles.
export function canonicalSelectionName(_marketType: string, name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+goals?$/i, "")
    .replace(/\s+/g, " ");
}

// ===================== Config helpers =====================

export async function getConfigValue(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, key));
  return rows[0]?.value ?? null;
}

export async function setConfigValue(
  key: string,
  value: string,
): Promise<void> {
  await db
    .insert(agentConfigTable)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: agentConfigTable.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function getBankroll(): Promise<number> {
  if (isLiveMode()) {
    try {
      const liveBankroll = await getLiveBankroll();
      if (liveBankroll > 0) {
        return liveBankroll;
      }
    } catch {
    }
  }
  const v = await getConfigValue("bankroll");
  return Number(v ?? "500");
}

// ===================== Bet placement pre-checks =====================

// Read a stake-multiplier from config; clamp to (0, 1] to prevent
// pathological values that would amplify rather than reduce stake.
// Returns the default if the key is unset or unparseable.
async function readMultiplierConfig(key: string, defaultValue: number): Promise<number> {
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

async function getTotalPendingExposure(): Promise<number> {
  // Only count bets placed on or after exposure_rule_since — pre-rule bets are grandfathered.
  // Paper bets (qualification_path='paper') are excluded — they are NOT real money.
  const sinceStr = await getConfigValue("exposure_rule_since");
  const since = sinceStr ? new Date(sinceStr) : null;
  const realMoneyFilter = sql`(${paperBetsTable.qualificationPath} IS NULL OR ${paperBetsTable.qualificationPath} != 'paper')`;
  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${paperBetsTable.stake}::numeric), 0)` })
    .from(paperBetsTable)
    .where(
      since
        ? and(eq(paperBetsTable.status, "pending"), sql`deleted_at IS NULL`, gte(paperBetsTable.placedAt, since), realMoneyFilter)
        : and(eq(paperBetsTable.status, "pending"), sql`deleted_at IS NULL`, realMoneyFilter),
    );
  return Number(result[0]?.total ?? 0);
}

async function getTodaysLoss(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${paperBetsTable.settlementPnl}::numeric) FILTER (WHERE ${paperBetsTable.settlementPnl}::numeric < 0), 0)`,
    })
    .from(paperBetsTable)
    .where(gte(paperBetsTable.settledAt, todayStart));
  return Math.abs(result[0]?.total ?? 0);
}

async function getWeeklyLoss(): Promise<number> {
  const weekStart = new Date();
  const day = weekStart.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  weekStart.setUTCDate(weekStart.getUTCDate() - daysToMonday);
  weekStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${paperBetsTable.settlementPnl}::numeric) FILTER (WHERE ${paperBetsTable.settlementPnl}::numeric < 0), 0)`,
    })
    .from(paperBetsTable)
    .where(gte(paperBetsTable.settledAt, weekStart));
  return Math.abs(result[0]?.total ?? 0);
}

export async function getAgentStatus(): Promise<string> {
  return (await getConfigValue("agent_status")) ?? "running";
}

// ===================== Dynamic stake sizing =====================

const NEW_MARKET_TYPES = new Set(["TOTAL_CARDS_35", "TOTAL_CARDS_45", "TOTAL_CORNERS_95", "TOTAL_CORNERS_105"]);

// ── Banned-market hardstop (single source of truth) ───────────────────────────
// These markets are permanently banned due to unreliable edge signals or
// poor settlement data. Block placement and exclude from value detection.
export const BANNED_MARKETS: ReadonlySet<string> = new Set([
  "OVER_UNDER_05",     // ~92% win rate — no edge signal
  "OVER_UNDER_15",     // ~75% win rate — no edge signal
  "TOTAL_CARDS_55",    // ~85% win rate — no edge signal
  "TOTAL_CARDS_45",    // Near-certainty; unreliable settlement data
  "TOTAL_CORNERS_75",  // Edge concentration: ALL corners suspended — 90 bets, -42.5% ROI
  "TOTAL_CORNERS_85",  // Edge concentration: ALL corners suspended
  "TOTAL_CORNERS_95",  // Edge concentration: ALL corners suspended
  "TOTAL_CORNERS_105", // Edge concentration: ALL corners suspended
  "TOTAL_CORNERS_115", // Edge concentration: ALL corners suspended
  "FIRST_HALF_OU_05",  // Too easy; FIRST_HALF_OU_15 retained instead
  // Quarantined 2026-04-20 pending pricing-pipeline fix — see CLV diagnostic
  "OVER_UNDER_25",
  // Quarantined 2026-04-20 pending pricing-pipeline fix — see CLV diagnostic
  "OVER_UNDER_35",
  // Quarantined 2026-04-20 pending pricing-pipeline fix — see CLV diagnostic
  "FIRST_HALF_RESULT",
  // Quarantined 2026-04-20 pending pricing-pipeline fix — see CLV diagnostic
  "DOUBLE_CHANCE",
]);

function kellyFractionForScore(opportunityScore: number, marketType?: string): number {
  let fraction: number;
  if (opportunityScore >= 80) fraction = 0.50;       // high confidence
  else if (opportunityScore >= 72) fraction = 0.375; // confident
  else if (opportunityScore >= 65) fraction = 0.25;  // standard
  else fraction = 0.125;                             // conservative (58-65)
  // 0.7x multiplier for new unproven market types
  if (marketType && NEW_MARKET_TYPES.has(marketType)) fraction *= 0.7;
  return fraction;
}

function calculateDynamicKellyStake(
  bankroll: number,
  edge: number,
  backOdds: number,
  maxStakePct: number,
  opportunityScore: number,
  marketType?: string,
): number {
  if (edge <= 0 || backOdds <= 1) return 0;

  const fraction = kellyFractionForScore(opportunityScore, marketType);
  const kellyFull = edge / (backOdds - 1);
  let stake = bankroll * kellyFull * fraction;

  stake = Math.min(stake, bankroll * maxStakePct);
  stake = Math.max(stake, 2);

  return Math.round(stake * 100) / 100;
}

// ===================== Tier 1 live qualification =====================

const MIN_PINNACLE_EDGE_PCT = 1;

interface Tier1CheckResult {
  qualifies: boolean;
  reason: string;
  path?: "1A" | "1B" | "promoted";
}

const MIN_TIER1_ODDS = 1.80;

async function qualifiesForTier1(opts: {
  opportunityScore: number;
  dataTier: string;
  marketType: string;
  league: string;
  country: string;
  pinnacleOdds: number | null;
  pinnacleImplied: number | null;
  modelProbability: number;
  backOdds: number;
}): Promise<Tier1CheckResult> {
  if (opts.dataTier === "abandoned" || opts.dataTier === "demoted") {
    return { qualifies: false, reason: `${opts.dataTier}-tier bets never qualify for Tier 1` };
  }

  const threshold = await getLiveOppScoreThreshold();

  if (opts.opportunityScore < threshold) {
    return { qualifies: false, reason: `Opportunity score ${opts.opportunityScore} < threshold ${threshold}` };
  }

  if (opts.pinnacleOdds == null || opts.pinnacleImplied == null) {
    return { qualifies: false, reason: "No Pinnacle odds available — cannot validate edge" };
  }

  if (opts.backOdds < MIN_TIER1_ODDS) {
    return { qualifies: false, reason: `Odds ${opts.backOdds} < minimum ${MIN_TIER1_ODDS} for Tier 1` };
  }

  const pinnacleImpliedProb = opts.pinnacleImplied;
  const ourImpliedProb = opts.modelProbability;
  const edgeVsPinnacle = (ourImpliedProb - pinnacleImpliedProb) * 100;

  if (edgeVsPinnacle < MIN_PINNACLE_EDGE_PCT) {
    return { qualifies: false, reason: `Pinnacle edge ${edgeVsPinnacle.toFixed(2)}% < minimum ${MIN_PINNACLE_EDGE_PCT}%` };
  }

  if (opts.dataTier === "promoted") {
    return {
      qualifies: true,
      reason: `Promoted strategy: score=${opts.opportunityScore} >= ${threshold}, Pinnacle edge=${edgeVsPinnacle.toFixed(2)}%`,
      path: "promoted",
    };
  }

  const isRichData = await isLeagueMarketTier1Eligible(opts.league, opts.country, opts.marketType);
  if (isRichData) {
    return {
      qualifies: true,
      reason: `Tier 1A: score=${opts.opportunityScore} >= ${threshold}, Pinnacle edge=${edgeVsPinnacle.toFixed(2)}%, data richness >= 70% [${opts.dataTier}]`,
      path: "1A",
    };
  }

  return {
    qualifies: true,
    reason: `Tier 1B: score=${opts.opportunityScore} >= ${threshold}, Pinnacle edge=${edgeVsPinnacle.toFixed(2)}%, odds=${opts.backOdds} [${opts.dataTier}]`,
    path: "1B",
  };
}

// ===================== Place paper bet =====================

export interface BetPlacementResult {
  placed: boolean;
  betId?: number;
  stake?: number;
  reason?: string;
}

export interface PaperBetOptions {
  modelVersion?: string | null;
  opportunityScore?: number;
  oddsSource?: string;
  enhancedOpportunityScore?: number | null;
  pinnacleOdds?: number | null;
  pinnacleImplied?: number | null;
  bestOdds?: number | null;
  bestBookmaker?: string | null;
  betThesis?: string | null;
  isContrarian?: boolean;
  stakeMultiplier?: number;
  experimentTag?: string;
  dataTier?: string;
  opportunityBoosted?: boolean;
  originalOpportunityScore?: number;
  boostedOpportunityScore?: number;
  syncEligible?: boolean;
  pinnacleEdgeCategory?: "high_confidence" | "standard" | "filtered" | null;
  lineDirection?: "toward" | "away" | "stable" | "unknown" | null;
  liveTier?: string | null;
  // Pricing-pipeline (Prompt 5): wired through from value detection so the
  // bet row records BOTH the actionable (placed) price and the fair-value
  // reference, plus the validator best-price diagnostic.
  actionablePrice?: number | null;
  actionableSource?: string | null;
  fairValueOdds?: number | null;
  fairValueSource?: string | null;
  validatorBestOdds?: number | null;
}

export async function placePaperBet(
  matchId: number,
  marketType: string,
  selectionName: string,
  backOdds: number,
  modelProbability: number,
  edge: number,
  options: PaperBetOptions = {},
): Promise<BetPlacementResult> {
  const {
    modelVersion,
    opportunityScore,
    oddsSource,
    enhancedOpportunityScore,
    bestOdds,
    bestBookmaker,
    betThesis,
    isContrarian = false,
    experimentTag,
    dataTier = "experiment",
    opportunityBoosted = false,
    originalOpportunityScore,
    boostedOpportunityScore,
    syncEligible = false,
    pinnacleEdgeCategory = null,
    lineDirection = null,
    actionablePrice = null,
    actionableSource = null,
    fairValueOdds = null,
    fairValueSource = null,
    validatorBestOdds = null,
  } = options;
  // Mutable: boosted bets that qualify for Tier 1B get a 0.5x stake multiplier.
  let stakeMultiplier = options.stakeMultiplier ?? 1.0;
  // Mutable: boosted bets that pre-qualify for Tier 1B get tagged "1B_boosted"
  // and bypass the production quarantine.
  let boostedTier1BApproved = false;
  // Make these mutable so we can fall back to DB-stored Pinnacle snapshots
  // when the trading-cycle cache misses (allows Tier 1B qualification).
  let pinnacleOdds: number | null = options.pinnacleOdds ?? null;
  let pinnacleImplied: number | null = options.pinnacleImplied ?? null;
  const score = opportunityScore ?? 65;

  const logReject = async (reason: string) => {
    logger.info({ matchId, marketType, selectionName, reason }, "Bet rejected");
    await db.insert(complianceLogsTable).values({
      actionType: "bet_rejected",
      details: {
        matchId,
        marketType,
        selectionName,
        backOdds,
        modelProbability,
        edge,
        opportunityScore: score,
        reason,
      },
      timestamp: new Date(),
    });
    return { placed: false, reason };
  };

  // ── Banned-market hardstop (uses module-level BANNED_MARKETS) ─────────────
  if (BANNED_MARKETS.has(marketType)) {
    logger.warn({ matchId, marketType, selectionName }, "HARDSTOP: Banned market — bet blocked at placement");
    return logReject(`Banned market: ${marketType}`);
  }

  // ── Edge concentration gates ─────────────────────────────────────────────
  {
    const blockCheck = shouldBlockBet(marketType, backOdds, options.liveTier ?? null);
    if (blockCheck.blocked) {
      logger.warn(
        { matchId, marketType, selectionName, backOdds, reason: blockCheck.reason },
        "EDGE CONCENTRATION: bet blocked",
      );
      return logReject(blockCheck.reason!);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  if (CORNERS_CARDS_MARKETS.has(marketType)) {
    const [match] = await db
      .select({ league: matchesTable.league, country: matchesTable.country })
      .from(matchesTable)
      .where(eq(matchesTable.id, matchId))
      .limit(1);
    if (!match) {
      return logReject(`Cannot verify stats coverage — match ${matchId} not found`);
    }
    const [config] = await db
      .select({ hasStatistics: competitionConfigTable.hasStatistics })
      .from(competitionConfigTable)
      .where(
        and(
          eq(competitionConfigTable.name, match.league),
          eq(competitionConfigTable.country, match.country ?? ""),
        ),
      )
      .limit(1);
    if (!config || !config.hasStatistics) {
      const isCornersMarket = marketType.startsWith("TOTAL_CORNERS");
      return logReject(`No ${isCornersMarket ? "corners" : "cards"} stats coverage for league: ${match.league} (${match.country})`);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Graceful degradation: tighten threshold when API-Football is down ──
  const API_FOOTBALL_DEGRADATION_BOOST = 5;
  if (isApiFootballCircuitOpen()) {
    const tightenedMin = score - API_FOOTBALL_DEGRADATION_BOOST;
    if (score < 70 + API_FOOTBALL_DEGRADATION_BOOST) {
      return logReject(
        `API-Football circuit open — opportunity score ${score} < tightened threshold ${70 + API_FOOTBALL_DEGRADATION_BOOST} (normal 70 + ${API_FOOTBALL_DEGRADATION_BOOST} degradation penalty)`,
      );
    }
    logger.info({ matchId, score, tightenedMin }, "API-Football degraded — applying +5 score penalty (bet passes)");
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Production quarantine ──────────────────────────────────────────────
  // In production, block abandoned/demoted tiers. Opportunity-boosted bets
  // are allowed through ONLY if they pre-qualify for Tier 1B (Pinnacle odds
  // present, Pinnacle edge ≥ 1%, score ≥ threshold, odds ≥ 1.80). Approved
  // boosted bets get a 0.5x stake multiplier and qualification_path = '1B_boosted'.
  const currentEnv = process.env["ENVIRONMENT"] ?? "development";
  if (currentEnv === "production") {
    if (dataTier === "abandoned" || dataTier === "demoted") {
      return logReject(`Production quarantine: ${dataTier}-tier bets blocked in prod`);
    }
    if (opportunityBoosted) {
      // Lookup match league/country for Tier 1B pre-check.
      const [matchRow] = await db
        .select({ league: matchesTable.league, country: matchesTable.country })
        .from(matchesTable)
        .where(eq(matchesTable.id, matchId))
        .limit(1);

      // Run a Pinnacle DB fallback inline so the pre-check sees DB-stored Pinnacle odds.
      let preCheckPinOdds = pinnacleOdds;
      let preCheckPinImplied = pinnacleImplied;
      if (preCheckPinOdds == null) {
        try {
          const variants = Array.from(new Set([
            selectionName,
            selectionName.endsWith(" Goals") ? selectionName.replace(/ Goals$/, "") : `${selectionName} Goals`,
          ]));
          const latestPin = await db
            .select({ backOdds: oddsSnapshotsTable.backOdds })
            .from(oddsSnapshotsTable)
            .where(and(
              eq(oddsSnapshotsTable.matchId, matchId),
              eq(oddsSnapshotsTable.marketType, marketType),
              inArray(oddsSnapshotsTable.selectionName, variants),
              or(
                eq(oddsSnapshotsTable.source, "api_football_real:Pinnacle"),
                eq(oddsSnapshotsTable.source, "oddspapi"),
                eq(oddsSnapshotsTable.source, "derived_from_match_odds"),
              ),
            ))
            .orderBy(desc(oddsSnapshotsTable.snapshotTime))
            .limit(1);
          const fb = latestPin[0]?.backOdds ? parseFloat(latestPin[0].backOdds) : null;
          if (fb && fb > 1.01) {
            preCheckPinOdds = fb;
            preCheckPinImplied = 1 / fb;
            // Promote to outer scope so the main flow uses these too.
            pinnacleOdds = fb;
            pinnacleImplied = preCheckPinImplied;
          }
        } catch (err) {
          logger.warn({ err, matchId }, "Boosted-bet Pinnacle pre-check fallback failed");
        }
      }

      const preCheck = await qualifiesForTier1({
        opportunityScore: score,
        dataTier,
        marketType,
        league: matchRow?.league ?? "",
        country: matchRow?.country ?? "",
        pinnacleOdds: preCheckPinOdds,
        pinnacleImplied: preCheckPinImplied,
        modelProbability,
        backOdds,
      });
      if (!preCheck.qualifies || preCheck.path !== "1B") {
        return logReject(
          `Production quarantine: opportunity-boosted bet not Tier 1B-qualified (${preCheck.reason})`,
        );
      }
      // Approved: apply 0.5x stake and tag for later.
      stakeMultiplier *= 0.5;
      boostedTier1BApproved = true;
      logger.info(
        { matchId, marketType, score, edge, stakeMultiplier },
        "Boosted bet exempted from quarantine — pre-qualifies Tier 1B at 0.5x stake",
      );
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  const status = await getAgentStatus();
  if (status !== "running") {
    return logReject(`Agent is not running (status: ${status})`);
  }

  if (isLiveMode() && isBetfairApiPaused()) {
    return logReject("Betfair API error rate pause active — skipping bet placement");
  }

  const liveCircuitBreaker = await checkLiveCircuitBreakers();
  if (liveCircuitBreaker.triggered) {
    const action = liveCircuitBreaker.action;
    if (action === "halt" || action === "floor_halt") {
      await setConfigValue("agent_status", "paused");
      // Tag the pause so the auto-resume watchdog (scheduler.ts) knows
      // whether this is recoverable. Only `floor_halt` (cash dipped below
      // the £50 absolute floor) auto-resumes once cash recovers; `halt`
      // (consecutive-loss kill-switch) requires manual restart.
      await setConfigValue("pause_reason", action);
      await setConfigValue("paused_at", new Date().toISOString());
    }
    return logReject(`Live circuit breaker: ${liveCircuitBreaker.reason}`);
  }

  const bankroll = await getBankroll();
  const isDev = process.env.NODE_ENV !== "production";
  const liveLimits = isLiveMode() ? await getEffectiveLimits() : null;

  if (!isDev) {
    const effectiveBankroll = liveLimits ? liveLimits.liveBalance : bankroll;
    // Apr 17 2026: percentage-based bankroll floor decommissioned for live mode.
    // The sole emergency stop is the absolute £50 floor on AVAILABLE cash, enforced
    // by checkLiveCircuitBreakers() above (already evaluated this cycle). Paper mode
    // retains the legacy configurable floor.
    if (!liveLimits) {
      const bankrollFloor = Number((await getConfigValue("bankroll_floor")) ?? "200");
      if (effectiveBankroll <= bankrollFloor) {
        return logReject(
          `Bankroll £${effectiveBankroll.toFixed(2)} at or below paper floor £${bankrollFloor}`,
        );
      }
    }

    // Strategy override (today-only, self-expiring at strategy_overrides_expire_at)
    // lets us raise the hardcoded RISK_LEVELS daily cap without editing the table.
    const stratExpiresStr = await getConfigValue("strategy_overrides_expire_at");
    const stratActive = stratExpiresStr ? new Date(stratExpiresStr).getTime() > Date.now() : false;
    const dailyOverrideStr = stratActive ? await getConfigValue("strategy_max_daily_loss_pct") : null;
    const dailyLossLimitPct = dailyOverrideStr
      ? Number(dailyOverrideStr)
      : liveLimits
        ? liveLimits.config.maxDailyLossPct
        : Number((await getConfigValue("daily_loss_limit_pct")) ?? "0.05");
    const dailyLoss = await getTodaysLoss();
    const dailyLossLimit = effectiveBankroll * dailyLossLimitPct;
    if (dailyLoss >= dailyLossLimit) {
      return logReject(
        `Daily loss limit hit: £${dailyLoss.toFixed(2)} >= £${dailyLossLimit.toFixed(2)} (${(dailyLossLimitPct * 100).toFixed(0)}% of ${liveLimits ? "live" : "paper"} balance)`,
      );
    }

    const weeklyOverrideStr = stratActive ? await getConfigValue("strategy_max_weekly_loss_pct") : null;
    const weeklyLossLimitPct = weeklyOverrideStr
      ? Number(weeklyOverrideStr)
      : liveLimits
        ? liveLimits.config.maxWeeklyLossPct
        : Number((await getConfigValue("weekly_loss_limit_pct")) ?? "0.10");
    const weeklyLoss = await getWeeklyLoss();
    const weeklyLossLimit = effectiveBankroll * weeklyLossLimitPct;
    if (weeklyLoss >= weeklyLossLimit) {
      return logReject(
        `Weekly loss limit hit: £${weeklyLoss.toFixed(2)} >= £${weeklyLossLimit.toFixed(2)} (${(weeklyLossLimitPct * 100).toFixed(0)}% of ${liveLimits ? "live" : "paper"} balance)`,
      );
    }
  }

  // ── Duplicate / per-match cap guard ─────────────────────────────────────────
  // Enforced at placement time so duplicates never reach the DB. Two layers:
  //   1. App-level pre-check (this block) — friendly, fast-path rejection.
  //   2. DB-level partial unique index (paper_bets_unique_pending_canonical_idx)
  //      — race-proof guarantee against parallel cycles. Index uses canonical
  //      selection name to collapse "Over 2.5" / "Over 2.5 Goals" variants.
  const selectionCanonical = canonicalSelectionName(marketType, selectionName);
  {
    const recentVoidCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const existingBets = await db
      .select({
        id: paperBetsTable.id,
        marketType: paperBetsTable.marketType,
        selectionName: paperBetsTable.selectionName,
        selectionCanonical: paperBetsTable.selectionCanonical,
        status: paperBetsTable.status,
      })
      .from(paperBetsTable)
      .where(
        and(
          eq(paperBetsTable.matchId, matchId),
          sql`deleted_at IS NULL`,
          sql`(${paperBetsTable.status} IN ('pending','pending_placement') OR (${paperBetsTable.status} = 'void' AND ${paperBetsTable.settledAt} >= ${recentVoidCutoff}))`,
        ),
      );

    const existingPending = existingBets.filter(
      (b) => b.status === "pending" || b.status === "pending_placement",
    );
    const allRelevant = existingBets;

    // 1. Exact duplicate — same market + canonical-selection already pending or recently voided.
    // Compares against persisted selection_canonical when present, falls back to recomputing
    // canonical from raw selection_name for legacy rows that pre-date the column.
    const exactDup = allRelevant.find(
      (b) =>
        b.marketType === marketType &&
        (b.selectionCanonical ?? canonicalSelectionName(b.marketType, b.selectionName)) ===
          selectionCanonical,
    );
    if (exactDup) {
      return logReject(
        `Duplicate: ${exactDup.status} bet already exists for ${marketType}:${selectionName} (canonical "${selectionCanonical}") on match ${matchId}`,
      );
    }

    // 2. Threshold-category duplicate — e.g. already have a Goals OU or BTTS bet → skip another
    const thisCat = getThresholdCategory(marketType);
    if (thisCat) {
      const catDup = allRelevant.find(
        (b) => getThresholdCategory(b.marketType) === thisCat,
      );
      if (catDup) {
        return logReject(
          `Threshold category "${thisCat}" already covered by ${catDup.status} ${catDup.marketType}:${catDup.selectionName} on match ${matchId}`,
        );
      }
    }

    // 3. Hard cap — max 4 bets per match (pending only)
    // Raised from 2 → 4 to allow independent edges across MATCH_ODDS /
    // OVER_UNDER / BTTS / cards / corners on the same fixture. Threshold-
    // category dedup above (rule #2) still prevents correlated picks.
    if (existingPending.length >= 4) {
      return logReject(
        `Match ${matchId} already has ${existingPending.length} pending bets (max 4) — skipping ${marketType}:${selectionName}`,
      );
    }
  }

  const maxStakePct = liveLimits
    ? liveLimits.config.maxSingleBetPct
    : Number((await getConfigValue("max_stake_pct")) ?? "0.02");
  const stakingBankroll = liveLimits ? liveLimits.liveBalance : bankroll;
  let stake = calculateDynamicKellyStake(
    stakingBankroll,
    edge,
    backOdds,
    maxStakePct,
    score,
    marketType,
  );

  if (liveLimits) {
    const liveKelly = getLiveKellyFraction(
      liveLimits.level,
      !!(pinnacleOdds && pinnacleOdds > 0),
    );
    stake = Math.round(stake * (liveKelly / 0.25) * 100) / 100;
    logger.info(
      { matchId, marketType, liveLevel: liveLimits.level, liveKelly, hasPinnacle: !!(pinnacleOdds && pinnacleOdds > 0) },
      "Live Kelly fraction applied",
    );
  }

  const segmentMultiplier = getSegmentKellyMultiplier(marketType, backOdds, score);
  if (segmentMultiplier < 1.0) {
    const preSegStake = stake;
    stake = Math.round(stake * segmentMultiplier * 100) / 100;
    logger.info(
      { matchId, marketType, backOdds, segmentMultiplier, preSegStake, postSegStake: stake, marketFamily: getMarketFamily(marketType) },
      "Edge concentration: segment Kelly modifier applied",
    );
  }

  const regime = await detectCurrentRegime();
  if (regime.stakeMultiplier < 1.0) {
    const preRegimeStake = stake;
    stake = Math.round(stake * regime.stakeMultiplier * 100) / 100;
    logger.info(
      { matchId, marketType, regime: regime.current, stakeMultiplier: regime.stakeMultiplier, preRegimeStake, postRegimeStake: stake },
      "Market regime stake adjustment applied",
    );
  }

  // Contrarian stake reduction removed — dev data shows +18.4% ROI on contrarian bets
  if (stakeMultiplier !== 1.0) stake = Math.round(stake * stakeMultiplier * 100) / 100;

  // ─── Low-odds stake multiplier ──────────────────────────────────────────
  // 90d analysis: bets at odds <3.0 with stake ≥£35 returned -23.6% ROI on
  // £5,507 of stake (-£1,302). Bets at odds ≥3.0 returned +80% to +166% ROI
  // across stake sizes. The model's edge estimates are systematically
  // over-confident on short-priced selections — Kelly stakes them too
  // aggressively for the slim true margin. Apply a tiered haircut on
  // low-odds stakes (after all conviction-based sizing, before candidate-
  // tier and hard-cap). All three tiers tunable via config; set any to
  // 1.0 for instant rollback.
  if (backOdds < 3.0) {
    let lowOddsMult = 1.0;
    let lowOddsBand = "";
    if (backOdds < 2.0) {
      lowOddsMult = await readMultiplierConfig("low_odds_stake_mult_under_2_0", 0.4);
      lowOddsBand = "<2.0";
    } else if (backOdds < 2.5) {
      lowOddsMult = await readMultiplierConfig("low_odds_stake_mult_2_0_to_2_5", 0.6);
      lowOddsBand = "2.0-2.5";
    } else {
      lowOddsMult = await readMultiplierConfig("low_odds_stake_mult_2_5_to_3_0", 0.8);
      lowOddsBand = "2.5-3.0";
    }
    if (lowOddsMult < 1.0) {
      const preLowOddsStake = stake;
      stake = Math.round(stake * lowOddsMult * 100) / 100;
      logger.info(
        { matchId, marketType, backOdds, lowOddsBand, lowOddsMult, preLowOddsStake, postLowOddsStake: stake },
        "Low-odds stake multiplier applied",
      );
    }
  }

  if (dataTier === "candidate") {
    const CANDIDATE_STAKE_MULT = parseFloat(process.env["CANDIDATE_STAKE_MULTIPLIER"] ?? "0.25");
    const originalStake = stake;
    stake = Math.round(stake * CANDIDATE_STAKE_MULT * 100) / 100;
    logger.info({ matchId, marketType, dataTier, originalStake, reducedStake: stake, multiplier: CANDIDATE_STAKE_MULT }, "Candidate-tier stake reduction applied");
  }

  if (liveLimits) {
    const hardCap = Math.round(liveLimits.liveBalance * liveLimits.config.maxSingleBetPct * 100) / 100;
    if (stake > hardCap) {
      logger.info(
        { matchId, marketType, preCapStake: stake, hardCap, level: liveLimits.level },
        "Live stake hard-capped to maxSingleBetPct after all multipliers",
      );
      stake = hardCap;
    }
  }

  if (stake < 2) {
    return logReject(`Calculated stake £${stake} is below minimum £2`);
  }

  if (isLiveMode()) {
    const slippageResult = checkSlippage(backOdds, backOdds);
    if (slippageResult.blocked) {
      return logReject(`Slippage guard: ${slippageResult.reason}`);
    }
  }

  // ── Exposure-based risk gate ─────────────────────────────────────────────
  // In LIVE mode: uses progressive level limits (Level 1 starts at 25%, earns up to 40% at Level 4)
  // In PAPER mode: uses legacy 40% default from agent_config
  let exposureAtPlacement: { current: number; max: number; pct: number } = { current: 0, max: 0, pct: 0 };
  {
    const maxExposurePct = liveLimits
      ? liveLimits.config.maxOpenExposurePct
      : Number((await getConfigValue("max_unsettled_exposure_pct")) ?? "0.40");
    const currentExposure = await getTotalPendingExposure();
    const effectiveBankroll = liveLimits ? liveLimits.liveBalance : bankroll;
    const maxExposure = effectiveBankroll * maxExposurePct;
    if (currentExposure + stake > maxExposure) {
      return logReject(
        `Exposure limit reached (£${(currentExposure + stake).toFixed(0)}/£${maxExposure.toFixed(0)} = ${(maxExposurePct * 100).toFixed(0)}% of ${liveLimits ? `live balance, Level ${liveLimits.level}` : "paper bankroll"}). Skipping bet on match ${matchId}.`,
      );
    }

    exposureAtPlacement = { current: currentExposure, max: maxExposure, pct: Math.round((currentExposure / maxExposure) * 1000) / 10 };
  }

  // ── Live concentration limits (per-league, per-market-type, per-fixture) ──
  if (isLiveMode()) {
    const concentrationCheck = await runLiveConcentrationChecks(matchId, marketType, stake);
    if (!concentrationCheck.passed) {
      return logReject(`Live concentration limit: ${concentrationCheck.reason}`);
    }
  }

  // ── Pinnacle DB fallback ─────────────────────────────────────────────────
  // If the trading-cycle cache didn't supply Pinnacle odds, look them up from
  // the most recent snapshot in odds_snapshots. This unblocks Tier 1B for
  // matches whose Pinnacle data exists in DB but missed the in-memory cache.
  if (pinnacleOdds == null) {
    try {
      const variants = Array.from(new Set([
        selectionName,
        selectionName.endsWith(" Goals") ? selectionName.replace(/ Goals$/, "") : `${selectionName} Goals`,
      ]));
      const latestPin = await db
        .select({ backOdds: oddsSnapshotsTable.backOdds, source: oddsSnapshotsTable.source })
        .from(oddsSnapshotsTable)
        .where(and(
          eq(oddsSnapshotsTable.matchId, matchId),
          eq(oddsSnapshotsTable.marketType, marketType),
          inArray(oddsSnapshotsTable.selectionName, variants),
          or(
            eq(oddsSnapshotsTable.source, "api_football_real:Pinnacle"),
            eq(oddsSnapshotsTable.source, "oddspapi"),
            eq(oddsSnapshotsTable.source, "derived_from_match_odds"),
          ),
        ))
        .orderBy(desc(oddsSnapshotsTable.snapshotTime))
        .limit(1);
      const fallbackOdds = latestPin[0]?.backOdds ? parseFloat(latestPin[0].backOdds) : null;
      if (fallbackOdds && fallbackOdds > 1.01) {
        pinnacleOdds = fallbackOdds;
        pinnacleImplied = 1 / fallbackOdds;
        logger.info(
          { matchId, marketType, selectionName, pinnacleOdds, source: latestPin[0]?.source },
          "Pinnacle odds loaded from DB snapshot fallback",
        );
      }
    } catch (err) {
      logger.warn({ err, matchId, marketType, selectionName }, "Pinnacle DB fallback lookup failed");
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  const { getCommissionRate } = await import("./commissionService");
  const commRate = await getCommissionRate("betfair");
  const potentialProfit =
    Math.round(stake * (backOdds - 1) * (1 - commRate) * 100) / 100;
  const impliedProbability = 1 / backOdds;

  const kellyFraction = kellyFractionForScore(score);

  // ── C1: capture Betfair exchange snapshot before insert ───────────────────
  // Fetch home/away/event id from matches table, then capture best back+lay
  // and selection id via the delayed app key. Failure → null columns + WARN,
  // never blocks the bet.
  let exchangeSnapshot: ExchangeSnapshot | null = null;
  try {
    const matchRow = await db
      .select({
        homeTeam: matchesTable.homeTeam,
        awayTeam: matchesTable.awayTeam,
        betfairEventId: matchesTable.betfairEventId,
      })
      .from(matchesTable)
      .where(eq(matchesTable.id, matchId))
      .limit(1);
    const m = matchRow[0];
    if (m) {
      exchangeSnapshot = await captureExchangeSnapshot({
        betfairEventId: m.betfairEventId ?? null,
        marketType,
        selectionName,
        homeTeam: m.homeTeam ?? "",
        awayTeam: m.awayTeam ?? "",
        matchId,
      });
    }
  } catch (err) {
    logger.warn(
      { err, matchId, marketType, selectionName },
      "C1 capture: pre-insert match lookup failed — inserting with null exchange columns",
    );
    exchangeSnapshot = null;
  }
  if (exchangeSnapshot && exchangeSnapshot.bestBack != null) {
    exchangeCaptureCounters.captured += 1;
    // Cross-spread vs lay: how far our backed price is from the prevailing
    // best lay. Positive = we're inside the spread relative to lay (good).
    if (exchangeSnapshot.bestLay != null) {
      exchangeCaptureCounters.cross_spread_samples.push(
        backOdds - exchangeSnapshot.bestLay,
      );
    }
    // Queue position vs back: how far our backed price is from the front of
    // the back queue. <=0 means we'd fill immediately on a real exchange.
    exchangeCaptureCounters.queue_position_samples.push(
      exchangeSnapshot.bestBack - backOdds,
    );
  }

  const { pool } = await import("@workspace/db");
  const pgClient = await pool.connect();
  let bet: any;
  try {
    await pgClient.query("BEGIN");

    const betResult = await db
      .insert(paperBetsTable)
      .values({
        matchId,
        marketType,
        selectionName,
        selectionCanonical,
        betType: "back",
        oddsAtPlacement: String(actionablePrice ?? backOdds),
        stake: String(stake),
        potentialProfit: String(potentialProfit),
        modelProbability: String(modelProbability),
        betfairImpliedProbability: String(impliedProbability),
        calculatedEdge: String(edge),
        opportunityScore: String(score),
        modelVersion: modelVersion ?? null,
        oddsSource: actionableSource ?? oddsSource ?? "synthetic",
        enhancedOpportunityScore: enhancedOpportunityScore != null ? String(enhancedOpportunityScore) : null,
        pinnacleOdds: pinnacleOdds != null ? String(pinnacleOdds) : null,
        pinnacleImplied: pinnacleImplied != null ? String(pinnacleImplied) : null,
        bestOdds: bestOdds != null ? String(bestOdds) : null,
        bestBookmaker: bestBookmaker ?? null,
        betThesis: betThesis ?? null,
        isContrarian: String(isContrarian),
        status: "pending",
        dataTier,
        experimentTag: experimentTag ?? null,
        opportunityBoosted,
        originalOpportunityScore: originalOpportunityScore ?? null,
        boostedOpportunityScore: boostedOpportunityScore ?? null,
        syncEligible,
        pinnacleEdgeCategory: pinnacleEdgeCategory ?? null,
        lineDirection: lineDirection ?? null,
        pinnacleSnapshotCount: pinnacleOdds ? 1 : 0,
        clvDataQuality: pinnacleOdds ? "incomplete" : "incomplete",
        betfairBestBack: exchangeSnapshot?.bestBack != null ? String(exchangeSnapshot.bestBack) : null,
        betfairBestBackSize: exchangeSnapshot?.bestBackSize != null ? String(exchangeSnapshot.bestBackSize) : null,
        betfairBestLay: exchangeSnapshot?.bestLay != null ? String(exchangeSnapshot.bestLay) : null,
        betfairBestLaySize: exchangeSnapshot?.bestLaySize != null ? String(exchangeSnapshot.bestLaySize) : null,
        exchangeFetchAt: exchangeSnapshot?.fetchedAt ?? null,
        betfairSelectionId: exchangeSnapshot?.selectionId != null ? String(exchangeSnapshot.selectionId) : null,
        // Prompt 5 pricing-pipeline columns
        actionablePrice: actionablePrice != null ? String(actionablePrice) : null,
        actionableSource: actionableSource ?? null,
        fairValueOdds: fairValueOdds != null ? String(fairValueOdds) : null,
        fairValueSource: fairValueSource ?? null,
        validatorBestOdds: validatorBestOdds != null ? String(validatorBestOdds) : null,
      })
      .returning();

    bet = betResult[0];

    await db.insert(complianceLogsTable).values({
      actionType: "bet_placed",
      details: {
        betId: bet?.id,
        matchId,
        marketType,
        selectionName,
        backOdds,
        stake,
        potentialProfit,
        modelProbability,
        impliedProbability,
        edge,
        opportunityScore: score,
        bankrollBefore: bankroll,
        kellyFraction,
        dynamicKellyFraction: kellyFraction,
        modelVersion,
        exposureAtPlacement: {
          currentExposure: Math.round(exposureAtPlacement.current * 100) / 100,
          maxExposure: Math.round(exposureAtPlacement.max * 100) / 100,
          exposurePct: exposureAtPlacement.pct,
        },
      },
      timestamp: new Date(),
    });

    await pgClient.query("COMMIT");
  } catch (txErr) {
    await pgClient.query("ROLLBACK");
    // Postgres unique-violation (23505) → race-blocked duplicate from a parallel
    // trading cycle. The dedup pre-check above passed (no row visible at SELECT
    // time) but the partial unique index caught it at INSERT time. Convert to a
    // friendly logReject so the cycle continues placing other candidates.
    const code = (txErr as { code?: string })?.code;
    const constraint = (txErr as { constraint?: string })?.constraint;
    if (code === "23505" && constraint === "paper_bets_unique_pending_canonical_idx") {
      logger.warn(
        { matchId, marketType, selectionName, selectionCanonical, constraint },
        "Duplicate-bet race blocked by partial unique index — parallel cycle won the insert",
      );
      // Fall through to finally — single release path. The `return` triggers finally.
      return logReject(
        `Duplicate (race-blocked at DB): ${marketType}:${selectionName} on match ${matchId}`,
      );
    }
    logger.error({ err: txErr, matchId, marketType }, "Transaction failed for bet placement");
    throw txErr;
  } finally {
    pgClient.release();
  }

  if (bet?.id && pinnacleOdds) {
    storePinnacleSnapshot({
      betId: bet.id,
      matchId,
      marketType,
      selectionName,
      snapshotType: "identification",
      pinnacleOdds,
    }).catch((err) => logger.warn({ err, betId: bet.id }, "Failed to store snapshot A"));
  }

  logger.info(
    {
      betId: bet?.id,
      matchId,
      marketType,
      selectionName,
      backOdds,
      stake,
      edge: edge.toFixed(4),
      opportunityScore: score,
      kellyFraction,
    },
    "Paper bet placed",
  );

  if (isLiveMode() && bet?.id) {
    const matchData = await db
      .select({
        homeTeam: matchesTable.homeTeam,
        awayTeam: matchesTable.awayTeam,
        betfairEventId: matchesTable.betfairEventId,
        league: matchesTable.league,
        country: matchesTable.country,
      })
      .from(matchesTable)
      .where(eq(matchesTable.id, matchId))
      .limit(1);

    const match = matchData[0];

    const tier1Check = await qualifiesForTier1({
      opportunityScore: score,
      dataTier,
      marketType,
      league: match?.league ?? "",
      country: match?.country ?? "",
      pinnacleOdds: pinnacleOdds ?? null,
      pinnacleImplied: pinnacleImplied ?? null,
      modelProbability,
      backOdds,
    });

    const liveTier = tier1Check.qualifies ? "tier1" : "tier2";
    let qualificationPath: string = tier1Check.qualifies ? (tier1Check.path ?? "1B") : "paper";
    // If this is an opportunity-boosted bet that passed the Tier 1B pre-check
    // in the production quarantine, tag it as 1B_boosted (overrides "1B").
    if (boostedTier1BApproved && tier1Check.qualifies) {
      qualificationPath = "1B_boosted";
    }
    await db.update(paperBetsTable).set({ liveTier, qualificationPath }).where(eq(paperBetsTable.id, bet.id));

    if (tier1Check.qualifies) {
      logger.info(
        { betId: bet.id, liveTier, path: tier1Check.path, reason: tier1Check.reason },
        "TIER 1: Bet qualifies for live placement",
      );

      await db.update(paperBetsTable)
        .set({ status: "pending_placement" })
        .where(eq(paperBetsTable.id, bet.id));

      try {
        if (isBalanceStale()) {
          logger.warn(
            { betId: bet.id },
            "LIVE: Skipping Betfair placement — balance is stale (>1hr)",
          );
          await db.update(paperBetsTable)
            .set({ status: "pending" })
            .where(eq(paperBetsTable.id, bet.id));
        } else if (match?.betfairEventId) {
          const liveResult = await placeLiveBetOnBetfair({
            internalBetId: bet.id,
            betfairEventId: match.betfairEventId,
            marketType,
            selectionName,
            odds: backOdds,
            stake,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
          });

          if (!liveResult.success) {
            logger.warn(
              { betId: bet.id, error: liveResult.error },
              "LIVE: Betfair placement failed — paper bet recorded but no live bet",
            );
            await db.update(paperBetsTable)
              .set({ status: "placement_failed", betfairStatus: `FAILED: ${liveResult.error ?? "unknown"}` })
              .where(eq(paperBetsTable.id, bet.id));

            // Suppression bookkeeping: hard-suppress on "market unavailable",
            // otherwise increment circuit-breaker counter for this (match, market).
            // Skip the breaker for global/account-level errors (insufficient
            // funds, balance issues) — those aren't a market-specific problem
            // and would unfairly ban the market when bankroll is the cause.
            if (liveResult.unavailableOnExchange) {
              markMarketUnavailable(matchId, marketType);
            } else {
              const errLower = (liveResult.error ?? "").toLowerCase();
              const isGlobalError =
                errLower.includes("nsufficient") ||      // Insufficient/INSUFFICIENT
                errLower.includes("account") ||
                errLower.includes("balance") ||
                errLower.includes("bankroll") ||
                errLower.includes("no betfaireventid");
              if (!isGlobalError) {
                recordPlacementFailure(matchId, marketType);
              }
            }
          } else {
            clearPlacementFailures(matchId, marketType);
          }
        } else {
          logger.warn(
            { betId: bet.id, matchId },
            "LIVE: No betfairEventId for match — paper bet only",
          );
          await db.update(paperBetsTable)
            .set({ status: "pending" })
            .where(eq(paperBetsTable.id, bet.id));
        }
      } catch (err) {
        logger.error(
          { err, betId: bet.id },
          "LIVE: Unexpected error during Betfair placement — paper bet preserved",
        );
        await db.update(paperBetsTable)
          .set({ status: "placement_failed", betfairStatus: `EXCEPTION: ${err instanceof Error ? err.message : String(err)}` })
          .where(eq(paperBetsTable.id, bet.id));
      }
    } else {
      logger.info(
        { betId: bet.id, liveTier, reason: tier1Check.reason },
        "TIER 2: Bet does not qualify for live placement — paper only",
      );
    }
  }

  return { placed: true, betId: bet?.id, stake };
}

// ===================== Reconcile stale PENDING_PLACEMENT bets =====================

const STALE_PLACEMENT_THRESHOLD_MS = 10 * 60 * 1000;

export async function reconcileStalePlacements(): Promise<{ reconciled: number; flagged: number }> {
  const cutoff = new Date(Date.now() - STALE_PLACEMENT_THRESHOLD_MS);

  const staleBets = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      stake: paperBetsTable.stake,
      placedAt: paperBetsTable.placedAt,
      betfairBetId: paperBetsTable.betfairBetId,
    })
    .from(paperBetsTable)
    .where(
      and(
        eq(paperBetsTable.status, "pending_placement"),
        lte(paperBetsTable.placedAt, cutoff),
      ),
    );

  if (staleBets.length === 0) return { reconciled: 0, flagged: 0 };

  logger.warn({ count: staleBets.length }, "Found stale PENDING_PLACEMENT bets — reconciling");

  let reconciled = 0;
  let flagged = 0;

  for (const bet of staleBets) {
    try {
      if (bet.betfairBetId) {
        await db.update(paperBetsTable)
          .set({ status: "pending" })
          .where(eq(paperBetsTable.id, bet.id));
        reconciled++;
        logger.info({ betId: bet.id, betfairBetId: bet.betfairBetId }, "Stale bet had Betfair ID — restored to pending");
      } else {
        if (isLiveMode()) {
          try {
            const { listClearedOrders } = await import("./betfairLive");
            const cleared = await listClearedOrders("LATEST", 50);
            const matchingOrder = cleared?.clearedOrders?.find((o: any) =>
              Math.abs(Number(o.sizeSettled ?? o.sizeMatched ?? 0) - Number(bet.stake)) < 0.5,
            );

            if (matchingOrder) {
              await db.update(paperBetsTable)
                .set({
                  status: "pending",
                  betfairBetId: matchingOrder.betId,
                  betfairStatus: "RECONCILED",
                })
                .where(eq(paperBetsTable.id, bet.id));
              reconciled++;
              logger.info(
                { betId: bet.id, betfairBetId: matchingOrder.betId },
                "Stale bet matched to Betfair order — reconciled",
              );
              continue;
            }
          } catch (bfErr) {
            logger.warn({ betId: bet.id, err: bfErr }, "Could not query Betfair for stale bet reconciliation");
          }
        }

        await db.update(paperBetsTable)
          .set({ status: "placement_failed", betfairStatus: "STALE_PENDING: not found on Betfair" })
          .where(eq(paperBetsTable.id, bet.id));
        flagged++;

        await db.insert(complianceLogsTable).values({
          actionType: "stale_placement_flagged",
          details: {
            betId: bet.id,
            matchId: bet.matchId,
            marketType: bet.marketType,
            selectionName: bet.selectionName,
            placedAt: bet.placedAt?.toISOString(),
            ageMinutes: Math.round((Date.now() - (bet.placedAt?.getTime() ?? 0)) / 60000),
          },
          timestamp: new Date(),
        });

        const { createAlert } = await import("./alerting");
        await createAlert({
          severity: "warning",
          category: "execution",
          code: "STALE_PENDING_PLACEMENT",
          title: "Stale pending placement detected",
          message: `Bet #${bet.id} (${bet.marketType} on match ${bet.matchId}) was in PENDING_PLACEMENT for ${Math.round((Date.now() - (bet.placedAt?.getTime() ?? 0)) / 60000)} minutes without resolution. Marked as placement_failed.`,
          metadata: { betId: bet.id, matchId: bet.matchId, marketType: bet.marketType },
        });

        logger.warn({ betId: bet.id }, "Stale bet flagged as placement_failed — no Betfair match found");
      }
    } catch (err) {
      logger.error({ err, betId: bet.id }, "Error reconciling stale placement");
    }
  }

  logger.info({ reconciled, flagged, total: staleBets.length }, "Stale placement reconciliation complete");
  return { reconciled, flagged };
}

// ===================== Determine bet outcome from match result =====================

// Returns true (won), false (lost), or null (void — data unavailable, stake refunded)
function determineBetWon(
  marketType: string,
  selectionName: string,
  homeScore: number,
  awayScore: number,
  matchStats?: {
    totalCorners: number | null;
    totalCards: number | null;
    homeScoreHt?: number | null;
    awayScoreHt?: number | null;
  } | null,
): boolean | null {
  const totalGoals = homeScore + awayScore;

  switch (marketType) {
    case "MATCH_ODDS":
      if (selectionName === "Home") return homeScore > awayScore;
      if (selectionName === "Draw") return homeScore === awayScore;
      if (selectionName === "Away") return awayScore > homeScore;
      return null;

    case "BTTS":
      if (selectionName === "Yes") return homeScore > 0 && awayScore > 0;
      if (selectionName === "No") return !(homeScore > 0 && awayScore > 0);
      return null;

    case "DOUBLE_CHANCE":
      if (selectionName === "Home or Draw" || selectionName === "1X") return homeScore >= awayScore;
      if (selectionName === "Away or Draw" || selectionName === "X2") return awayScore >= homeScore;
      if (selectionName === "Home or Away" || selectionName === "12") return homeScore !== awayScore;
      return null;

    case "OVER_UNDER_05":
      if (selectionName.startsWith("Over")) return totalGoals > 0;
      if (selectionName.startsWith("Under")) return totalGoals === 0;
      return null;

    case "OVER_UNDER_15":
      if (selectionName.startsWith("Over")) return totalGoals > 1;
      if (selectionName.startsWith("Under")) return totalGoals <= 1;
      return null;

    case "OVER_UNDER_25":
      if (selectionName.startsWith("Over")) return totalGoals > 2;
      if (selectionName.startsWith("Under")) return totalGoals <= 2;
      return null;

    case "OVER_UNDER_35":
      if (selectionName.startsWith("Over")) return totalGoals > 3;
      if (selectionName.startsWith("Under")) return totalGoals <= 3;
      return null;

    case "OVER_UNDER_45":
      if (selectionName.startsWith("Over")) return totalGoals > 4;
      if (selectionName.startsWith("Under")) return totalGoals <= 4;
      return null;

    case "ASIAN_HANDICAP": {
      // selectionName examples: "Home -0.5", "Away +1.5", "Home -1", "Away 0"
      const parts = selectionName.split(" ");
      const side = parts[0]; // "Home" or "Away"
      const handicap = parseFloat(parts[1] ?? "0");
      const adjustedHome = homeScore + (side === "Home" ? handicap : -handicap);
      const adjustedAway = awayScore + (side === "Away" ? handicap : -handicap);
      if (Math.abs(handicap % 1) === 0.25) {
        // Split bet: half each on nearest 0.5 lines
        const lower = handicap - 0.25;
        const upper = handicap + 0.25;
        const adjHomeLow = homeScore + (side === "Home" ? lower : -lower);
        const adjHomeHigh = homeScore + (side === "Home" ? upper : -upper);
        const winLow = side === "Home" ? adjHomeLow > awayScore : adjustedAway > homeScore + lower;
        const winHigh = side === "Home" ? adjHomeHigh > awayScore : adjustedAway > homeScore + upper;
        if (winLow && winHigh) return true;
        if (!winLow && !winHigh) return false;
        return null; // half-win/half-loss treated as void for simplicity
      }
      if (side === "Home") return adjustedHome > awayScore;
      if (side === "Away") return adjustedAway > homeScore;
      return null;
    }

    // ─── Corners markets — use stored stats ───────────────────────────────────
    case "TOTAL_CORNERS_75":
    case "TOTAL_CORNERS_85":
    case "TOTAL_CORNERS_95":
    case "TOTAL_CORNERS_105":
    case "TOTAL_CORNERS_115": {
      if (!matchStats || matchStats.totalCorners === null) return null;
      // Parse threshold from market type: "TOTAL_CORNERS_95" → 9.5
      const suffix = marketType.split("_").pop()!;
      const threshold = parseInt(suffix, 10) / 10;
      if (selectionName.startsWith("Over")) return matchStats.totalCorners > threshold;
      if (selectionName.startsWith("Under")) return matchStats.totalCorners < threshold;
      return null;
    }

    // ─── Cards markets — use stored stats ────────────────────────────────────
    case "TOTAL_CARDS_25":
    case "TOTAL_CARDS_35":
    case "TOTAL_CARDS_45":
    case "TOTAL_CARDS_55": {
      if (!matchStats || matchStats.totalCards === null) return null;
      const suffix = marketType.split("_").pop()!;
      const threshold = parseInt(suffix, 10) / 10;
      if (selectionName.startsWith("Over")) return matchStats.totalCards > threshold;
      if (selectionName.startsWith("Under")) return matchStats.totalCards < threshold;
      return null;
    }

    case "FIRST_HALF_RESULT": {
      // Resolved from halftime scores captured during syncMatchResults
      // (matches.home_score_ht / away_score_ht). When HT scores are not
      // available (older fixtures, feeds without halftime data), return
      // null so the bet voids — but for any matched real-money bet,
      // _settleBetsInner has already deferred to reconcileSettlements
      // (Betfair listClearedOrders) before reaching this function.
      const htHome = matchStats?.homeScoreHt;
      const htAway = matchStats?.awayScoreHt;
      if (htHome === null || htHome === undefined || htAway === null || htAway === undefined) return null;
      if (selectionName === "Home") return htHome > htAway;
      if (selectionName === "Draw") return htHome === htAway;
      if (selectionName === "Away") return htAway > htHome;
      return null;
    }

    case "FIRST_HALF_OU_05":
    case "FIRST_HALF_OU_15": {
      const htHome = matchStats?.homeScoreHt;
      const htAway = matchStats?.awayScoreHt;
      if (htHome === null || htHome === undefined || htAway === null || htAway === undefined) return null;
      const htTotal = htHome + htAway;
      const threshold = marketType === "FIRST_HALF_OU_05" ? 0.5 : 1.5;
      if (selectionName.startsWith("Over")) return htTotal > threshold;
      if (selectionName.startsWith("Under")) return htTotal < threshold;
      return null;
    }

    default:
      return null; // void unknown markets rather than forcing a loss
  }
}

// ===================== Settle bets =====================

export interface SettlementResult {
  settled: number;
  won: number;
  lost: number;
  totalPnl: number;
  paperPendingRetry: number;
  paperTimeoutLoss: number;
  paperAbandonmentVoid: number;
}

const SETTLEMENT_MATCH_STATUSES = ["finished", "abandoned", "postponed", "cancelled", "suspended"] as const;
const ABANDONMENT_STATUSES = new Set<string>(["abandoned", "postponed", "cancelled", "suspended"]);

let settlingInProgress = false;

export async function settleBets(): Promise<SettlementResult> {
  if (settlingInProgress) {
    logger.debug("settleBets already in progress — skipping concurrent call");
    return {
      settled: 0,
      won: 0,
      lost: 0,
      totalPnl: 0,
      paperPendingRetry: 0,
      paperTimeoutLoss: 0,
      paperAbandonmentVoid: 0,
    };
  }
  settlingInProgress = true;
  try {
    return await _settleBetsInner();
  } finally {
    settlingInProgress = false;
  }
}

async function _settleBetsInner(): Promise<SettlementResult> {
  const pendingBets = await db
    .select()
    .from(paperBetsTable)
    .where(and(eq(paperBetsTable.status, "pending"), sql`deleted_at IS NULL`));

  if (pendingBets.length === 0) {
    return {
      settled: 0,
      won: 0,
      lost: 0,
      totalPnl: 0,
      paperPendingRetry: 0,
      paperTimeoutLoss: 0,
      paperAbandonmentVoid: 0,
    };
  }

  const uniqueMatchIds = [...new Set(pendingBets.map((b) => b.matchId))];
  const finishedMatches = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        inArray(matchesTable.id, uniqueMatchIds),
        inArray(matchesTable.status, SETTLEMENT_MATCH_STATUSES as unknown as string[]),
      ),
    );

  const matchMap = new Map(finishedMatches.map((m) => [m.id, m]));

  let settled = 0;
  let won = 0;
  let lost = 0;
  let totalPnl = 0;
  let paperPendingRetry = 0;
  let paperTimeoutLoss = 0;
  let paperAbandonmentVoid = 0;

  for (const bet of pendingBets) {
    const match = matchMap.get(bet.matchId);
    if (!match) continue;

    // ─── Abandonment-void branch (Apr 22 2026) ─────────────────────────
    // Fixture won't complete; void any unmatched paper-bet side. Real-money
    // matched bets are settled by reconcileSettlements (Betfair listClearedOrders),
    // so we only act on bets without a betfair_bet_id.
    if (ABANDONMENT_STATUSES.has(match.status) && !bet.betfairBetId) {
      await db.update(paperBetsTable).set({
        status: "void",
        settlementPnl: "0",
        grossPnl: "0",
        commissionAmount: "0",
        netPnl: "0",
        settledAt: new Date(),
      }).where(eq(paperBetsTable.id, bet.id));

      logger.info(
        { betId: bet.id, matchId: match.id, fixtureStatus: match.status },
        `Paper bet voided — fixture status=${match.status}`,
      );
      paperAbandonmentVoid++;
      settled++;
      continue;
    }

    if (match.homeScore === null || match.awayScore === null) continue;

    // ─── Real-money matched-bet deferral (Apr 19 2026) ─────────────────
    // For any Betfair real-money bet that has matched size > 0, Betfair
    // is the authoritative source of truth for the outcome. Defer to
    // reconcileSettlements (which queries listClearedOrders across
    // SETTLED/LAPSED/CANCELLED/VOIDED) instead of computing the outcome
    // from the match score. Fixes two prior bugs:
    //   (a) FIRST_HALF_RESULT and other markets that always returned null
    //       in determineBetWon (no HT data) being incorrectly voided —
    //       silently swallowing real Betfair winnings.
    //   (b) Stale `betfair_size_matched` reads racing settleBets and
    //       triggering the unmatched-bet guard below for fully-matched
    //       bets, voiding real wins/losses.
    const matchedSize = Number(bet.betfairSizeMatched ?? 0);
    if (bet.betfairBetId && matchedSize > 0) {
      logger.debug(
        { betId: bet.id, betfairBetId: bet.betfairBetId, matchedSize },
        "settleBets: real-money matched bet — deferring to reconcileSettlements",
      );
      continue;
    }

    const stake = Number(bet.stake);
    const odds = Number(bet.oddsAtPlacement);
    let outcome = determineBetWon(
      bet.marketType,
      bet.selectionName,
      match.homeScore,
      match.awayScore,
      {
        totalCorners: match.totalCorners ?? null,
        totalCards: match.totalCards ?? null,
        homeScoreHt: match.homeScoreHt ?? null,
        awayScoreHt: match.awayScoreHt ?? null,
      },
    );

    // ─── Real-money unmatched-bet guard (Apr 18 2026) ──────────────────
    // If this is a Betfair real-money bet (betfairBetId present) and the
    // matched size is zero (offer placed but never filled, then cancelled
    // at kickoff), no actual position was ever taken — real-money P/L is
    // £0. Force the outcome to void regardless of the match result so we
    // don't credit a phantom win/loss based on placement stake.
    if (bet.betfairBetId && matchedSize <= 0) {
      logger.warn(
        {
          betId: bet.id,
          betfairBetId: bet.betfairBetId,
          marketType: bet.marketType,
          selectionName: bet.selectionName,
          matchedSize,
          stake: Number(bet.stake),
          determinedOutcome: outcome,
        },
        "Real-money bet has zero matched size — voiding settlement (no actual Betfair position taken)",
      );
      outcome = null;
    }
    // ───────────────────────────────────────────────────────────────────

    // ─── 72h retry/timeout for paper bets where determineBetWon returned null ───
    //     Only applies to bets without a betfair_bet_id (real-money matched bets
    //     are handled above). For paper bets, give the data feed a window to catch
    //     up; after 72h post-kickoff, accept the loss rather than leaving pending forever.
    if (outcome === null && !bet.betfairBetId) {
      const hoursSinceKickoff =
        (Date.now() - new Date(match.kickoffTime).getTime()) / 3_600_000;
      if (hoursSinceKickoff < 72) {
        await db.update(paperBetsTable).set({
          settlementAttempts: (bet.settlementAttempts ?? 0) + 1,
          lastSettlementAttemptAt: new Date(),
        }).where(eq(paperBetsTable.id, bet.id));
        paperPendingRetry++;
        logger.debug(
          {
            betId: bet.id,
            matchId: match.id,
            marketType: bet.marketType,
            hoursSinceKickoff: Math.round(hoursSinceKickoff * 10) / 10,
          },
          "Paper bet pending — outcome unresolved, will retry",
        );
        continue;
      }
      outcome = false;
      paperTimeoutLoss++;
      logger.warn(
        {
          betId: bet.id,
          matchId: match.id,
          marketType: bet.marketType,
          hoursSinceKickoff: Math.round(hoursSinceKickoff * 10) / 10,
        },
        "Paper bet settled as lost after 72h timeout — determineBetWon could not resolve",
      );
    }

    // null = void (data unavailable or unmatched) — refund stake, no PnL impact
    const isVoid = outcome === null;
    const betWon = outcome === true;

    const { calculateSettlementWithCommission, getCommissionRate, getBetfairExchangeId } = await import("./commissionService");
    const commissionRate = await getCommissionRate("betfair");
    const exchangeId = await getBetfairExchangeId();

    const commResult = isVoid
      ? { grossPnl: 0, commissionRate: 0, commissionAmount: 0, netPnl: 0 }
      : calculateSettlementWithCommission(stake, odds, betWon, commissionRate);

    const settlementPnl = commResult.netPnl;
    const newStatus = isVoid ? "void" : betWon ? "won" : "lost";
    const now = new Date();

    // ── CLV: compare placement odds vs closing odds proxy ──────────────
    // NOTE: True CLV should use Pinnacle closing odds. The odds_snapshots table
    // does not have a separate Pinnacle source — it stores API-Football real odds
    // (1xBet / Bet365). We use the latest snapshot as the best available proxy.
    // Pinnacle odds at placement time are stored in bet.pinnacleOdds but those
    // are opening prices, not closing prices. Until a Pinnacle closing-odds fetch
    // is added to the settlement flow, this remains a market-proxy CLV.
    let closingOddsProxy: number | null = null;
    let clvPct: number | null = null;
    try {
      const latestSnapshot = await db
        .select({ backOdds: oddsSnapshotsTable.backOdds })
        .from(oddsSnapshotsTable)
        .where(
          and(
            eq(oddsSnapshotsTable.matchId, bet.matchId),
            eq(oddsSnapshotsTable.marketType, bet.marketType),
            eq(oddsSnapshotsTable.selectionName, bet.selectionName),
          ),
        )
        .orderBy(desc(oddsSnapshotsTable.snapshotTime))
        .limit(1);
      if (latestSnapshot[0]?.backOdds) {
        closingOddsProxy = Number(latestSnapshot[0].backOdds);
        if (closingOddsProxy > 1) {
          clvPct = ((odds - closingOddsProxy) / closingOddsProxy) * 100;
          clvPct = Math.round(clvPct * 1000) / 1000;
          logger.info(
            { betId: bet.id, placementOdds: odds, closingOddsProxy, clvPct },
            "CLV calculated (proxy: latest API-Football snapshot — not Pinnacle closing odds)",
          );
        }
      }
    } catch (_err) {
      // CLV is best-effort; don't block settlement
    }

    await db
      .update(paperBetsTable)
      .set({
        status: newStatus,
        settlementPnl: String(settlementPnl),
        settledAt: now,
        closingOddsProxy: closingOddsProxy != null ? String(closingOddsProxy) : null,
        clvPct: clvPct != null ? String(clvPct) : null,
        exchangeId,
        grossPnl: String(commResult.grossPnl),
        commissionRate: String(commResult.commissionRate),
        commissionAmount: String(commResult.commissionAmount),
        netPnl: String(commResult.netPnl),
      })
      .where(eq(paperBetsTable.id, bet.id));

    await db.insert(complianceLogsTable).values({
      actionType: "bet_settled",
      details: {
        betId: bet.id,
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        marketType: bet.marketType,
        selectionName: bet.selectionName,
        odds,
        stake,
        outcome: newStatus,
        grossPnl: commResult.grossPnl,
        commissionRate: commResult.commissionRate,
        commissionAmount: commResult.commissionAmount,
        netPnl: commResult.netPnl,
        settlementPnl,
        opportunityScore: Number(bet.opportunityScore ?? 0),
      },
      timestamp: now,
    });

    if (!isVoid && betWon) won++;
    else if (!isVoid) lost++;
    totalPnl += settlementPnl;
    settled++;

    logger.info(
      {
        betId: bet.id,
        matchId: match.id,
        outcome: newStatus,
        settlementPnl,
        opportunityScore: bet.opportunityScore,
      },
      "Bet settled",
    );
  }

  if (settled > 0) {
    const currentBankroll = await getBankroll();
    const newBankroll =
      Math.round((currentBankroll + totalPnl) * 100) / 100;
    await setConfigValue("bankroll", String(newBankroll));

    await db.insert(complianceLogsTable).values({
      actionType: "bankroll_updated",
      details: {
        bankrollBefore: currentBankroll,
        bankrollAfter: newBankroll,
        delta: totalPnl,
        betsSettled: settled,
        won,
        lost,
        reason: "settlement",
      },
      timestamp: new Date(),
    });

    logger.info(
      { previous: currentBankroll, delta: totalPnl, updated: newBankroll },
      "Bankroll updated after settlement",
    );

    const totalSettledResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(paperBetsTable)
      .where(inArray(paperBetsTable.status, ["won", "lost"]));
    const totalSettled = totalSettledResult[0]?.count ?? 0;

    if (totalSettled > 0 && totalSettled % 20 === 0) {
      logger.info(
        { totalSettled },
        "Triggering model retraining after settlement milestone",
      );
      void retrainIfNeeded().catch((err) =>
        logger.error({ err }, "Retraining after settlement failed"),
      );
    }
  }

  return { settled, won, lost, totalPnl, paperPendingRetry, paperTimeoutLoss, paperAbandonmentVoid };
}

// ===================== Backfill stats for voided corners/cards bets =====================

const CORNERS_CARDS_MARKETS = new Set([
  "TOTAL_CORNERS_75", "TOTAL_CORNERS_85", "TOTAL_CORNERS_95", "TOTAL_CORNERS_105", "TOTAL_CORNERS_115",
  "TOTAL_CARDS_25", "TOTAL_CARDS_35", "TOTAL_CARDS_45", "TOTAL_CARDS_55",
]);

export async function backfillCornersCardsStats(): Promise<{ matchesUpdated: number; betsResettled: number }> {
  const allVoidedBets = await db
    .select()
    .from(paperBetsTable)
    .where(eq(paperBetsTable.status, "void"));

  if (allVoidedBets.length === 0) {
    return { matchesUpdated: 0, betsResettled: 0 };
  }

  const cornersCardsMatchIds = [
    ...new Set(
      allVoidedBets
        .filter((b) => CORNERS_CARDS_MARKETS.has(b.marketType))
        .map((b) => b.matchId),
    ),
  ];

  let matchesUpdated = 0;

  if (cornersCardsMatchIds.length > 0) {
    const matchesNeedingStats = await db
      .select()
      .from(matchesTable)
      .where(
        and(
          inArray(matchesTable.id, cornersCardsMatchIds),
          eq(matchesTable.status, "finished"),
          or(isNull(matchesTable.totalCorners), isNull(matchesTable.totalCards)),
        ),
      );

    if (matchesNeedingStats.length > 0) {
      const dateGroups = new Map<string, typeof matchesNeedingStats>();
      for (const m of matchesNeedingStats) {
        const dateStr = m.kickoffTime.toISOString().slice(0, 10);
        if (!dateGroups.has(dateStr)) dateGroups.set(dateStr, []);
        dateGroups.get(dateStr)!.push(m);
      }

      for (const [date, dateMatches] of dateGroups) {
        const fixtures = await getFixturesForDate(date);
        const finished = fixtures.filter(
          (f) => f.fixture.status.short === "FT" || f.fixture.status.short === "AET" || f.fixture.status.short === "PEN",
        );
        for (const dbMatch of dateMatches) {
          let fixtureId = dbMatch.apiFixtureId;
          if (!fixtureId) {
            const fixture = finished.find(
              (f) =>
                teamNameMatch(dbMatch.homeTeam, f.teams.home.name) &&
                teamNameMatch(dbMatch.awayTeam, f.teams.away.name),
            );
            if (!fixture) continue;
            fixtureId = fixture.fixture.id;
          }

          const stats = await fetchMatchStatsForSettlement(fixtureId);
          if (!stats) continue;

          await db
            .update(matchesTable)
            .set({
              apiFixtureId: fixtureId,
              totalCorners: stats.totalCorners,
              totalCards: stats.totalCards,
            })
            .where(eq(matchesTable.id, dbMatch.id));

          matchesUpdated++;
        }
      }
    }
  }

  const allVoidMatchIds = [...new Set(allVoidedBets.map((b) => b.matchId))];
  const finishedMatches = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        inArray(matchesTable.id, allVoidMatchIds),
        eq(matchesTable.status, "finished"),
      ),
    );
  const matchMap = new Map(finishedMatches.map((m) => [m.id, m]));

  let betsResettled = 0;
  let pnlDelta = 0;

  for (const bet of allVoidedBets) {
    const match = matchMap.get(bet.matchId);
    if (!match || match.homeScore === null || match.awayScore === null) continue;

    if (bet.settledAt && bet.placedAt) {
      const voidedMs = new Date(bet.settledAt).getTime() - new Date(bet.placedAt).getTime();
      if (voidedMs < 3600_000) continue;
    }

    const outcome = determineBetWon(
      bet.marketType,
      bet.selectionName,
      match.homeScore,
      match.awayScore,
      {
        totalCorners: match.totalCorners ?? null,
        totalCards: match.totalCards ?? null,
        homeScoreHt: match.homeScoreHt ?? null,
        awayScoreHt: match.awayScoreHt ?? null,
      },
    );

    if (outcome === null) continue;

    const stake = Number(bet.stake);
    const odds = Number(bet.oddsAtPlacement);
    const betWon = outcome === true;

    const { calculateSettlementWithCommission, getCommissionRate, getBetfairExchangeId } = await import("./commissionService");
    const commRate = await getCommissionRate("betfair");
    const exId = await getBetfairExchangeId();
    const commResult = calculateSettlementWithCommission(stake, odds, betWon, commRate);
    const settlementPnl = commResult.netPnl;
    const newStatus = betWon ? "won" : "lost";

    await db
      .update(paperBetsTable)
      .set({
        status: newStatus,
        settlementPnl: String(settlementPnl),
        settledAt: new Date(),
        exchangeId: exId,
        grossPnl: String(commResult.grossPnl),
        commissionRate: String(commResult.commissionRate),
        commissionAmount: String(commResult.commissionAmount),
        netPnl: String(commResult.netPnl),
      })
      .where(eq(paperBetsTable.id, bet.id));

    pnlDelta += settlementPnl;
    betsResettled++;

    logger.info(
      { betId: bet.id, market: bet.marketType, selection: bet.selectionName, newStatus, settlementPnl },
      "backfill: voided bet re-settled",
    );
  }

  if (betsResettled > 0) {
    const bankrollStr = await getConfigValue("bankroll");
    const bankroll = parseFloat(bankrollStr ?? "500");
    const newBankroll = Math.round((bankroll + pnlDelta) * 100) / 100;
    await setConfigValue("bankroll", String(newBankroll));
    logger.info(
      { betsResettled, pnlDelta, bankroll, newBankroll },
      "backfill: bankroll updated after re-settlement",
    );
  }

  return { matchesUpdated, betsResettled };
}

// ===================== Pending bet deduplication =====================

// Cross-market correlated pairs: if both present on same match, remove the lower-scored one
const CORRELATED_CROSS_MARKET: Array<{
  market1: string; sel1Includes: string;
  market2: string; sel2Includes: string;
}> = [
  { market1: "BTTS", sel1Includes: "Yes", market2: "OVER_UNDER_25", sel2Includes: "Over" },
  { market1: "BTTS", sel1Includes: "Yes", market2: "OVER_UNDER_15", sel2Includes: "Over" },
  { market1: "MATCH_ODDS", sel1Includes: "Home", market2: "DOUBLE_CHANCE", sel2Includes: "1X" },
  { market1: "MATCH_ODDS", sel1Includes: "Home", market2: "DOUBLE_CHANCE", sel2Includes: "Home or Draw" },
  { market1: "MATCH_ODDS", sel1Includes: "Away", market2: "DOUBLE_CHANCE", sel2Includes: "X2" },
  { market1: "MATCH_ODDS", sel1Includes: "Away", market2: "DOUBLE_CHANCE", sel2Includes: "Away or Draw" },
];

export async function deduplicatePendingBets(): Promise<{
  totalBefore: number;
  totalRemoved: number;
  totalAfter: number;
  removedByReason: Record<string, number>;
}> {
  // 1. Fetch all pending bets with their match info and scores
  const rows = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      stake: paperBetsTable.stake,
      opportunityScore: paperBetsTable.opportunityScore,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(and(eq(paperBetsTable.status, "pending"), sql`${paperBetsTable.deletedAt} IS NULL`));

  const totalBefore = rows.length;
  const toVoid = new Set<number>(); // bet IDs to void
  const removedByReason: Record<string, number> = {
    threshold_dedup: 0,
    cross_market_dedup: 0,
    max_per_match: 0,
  };

  // Helper to get active bets for a match (not already queued for void)
  const activeBetsForMatch = (matchId: number) =>
    rows.filter((b) => b.matchId === matchId && !toVoid.has(b.id));

  // 2. Group by matchId
  const matchIds = [...new Set(rows.map((r) => r.matchId))];

  for (const matchId of matchIds) {
    const matchBets = activeBetsForMatch(matchId);

    // ── Step A: Threshold dedup ───────────────────────────────────────
    const categories = [...new Set(
      matchBets.map((b) => getThresholdCategory(b.marketType)).filter(Boolean) as string[],
    )];
    for (const cat of categories) {
      const catBets = matchBets.filter((b) => getThresholdCategory(b.marketType) === cat && !toVoid.has(b.id));
      if (catBets.length <= 1) continue;
      catBets.sort((a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0));
      const [keep, ...discard] = catBets;
      const removedNames = discard.map((d) => `${d.selectionName} (${d.marketType})`).join(", ");
      logger.info(
        { matchId, kept: `${keep!.marketType}:${keep!.selectionName}`, removedCount: discard.length },
        `deduplicatePendingBets [0A ${cat}]: removed ${removedNames}`,
      );
      for (const d of discard) {
        toVoid.add(d.id);
        removedByReason.threshold_dedup++;
      }
    }

    // ── Step B: Cross-market correlation dedup ────────────────────────
    const activeBets = activeBetsForMatch(matchId);
    for (const rule of CORRELATED_CROSS_MARKET) {
      const b1 = activeBets.find(
        (b) => b.marketType === rule.market1 && b.selectionName.includes(rule.sel1Includes) && !toVoid.has(b.id),
      );
      const b2 = activeBets.find(
        (b) => b.marketType === rule.market2 && b.selectionName.includes(rule.sel2Includes) && !toVoid.has(b.id),
      );
      if (!b1 || !b2) continue;
      const [, cancel] = (b1.opportunityScore ?? 0) >= (b2.opportunityScore ?? 0) ? [b1, b2] : [b2, b1];
      logger.info(
        { matchId, cancelled: `${cancel.marketType}:${cancel.selectionName}` },
        `deduplicatePendingBets [0B cross-market]: correlated pair removed`,
      );
      toVoid.add(cancel.id);
      removedByReason.cross_market_dedup++;
    }

    // ── Step C: Max 4 bets per match ─────────────────────────────────
    const remainingBets = activeBetsForMatch(matchId);
    if (remainingBets.length > 4) {
      const sorted = [...remainingBets].sort((a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0));
      const excess = sorted.slice(4);
      logger.info(
        { matchId, removedCount: excess.length },
        `deduplicatePendingBets [max-4 cap]: removing ${excess.length} excess bets`,
      );
      for (const e of excess) {
        toVoid.add(e.id);
        removedByReason.max_per_match++;
      }
    }
  }

  // 3. Void all marked bets in one batch
  if (toVoid.size > 0) {
    const idsToVoid = [...toVoid];
    await db
      .update(paperBetsTable)
      .set({ status: "void", settlementPnl: "0", settledAt: new Date() })
      .where(inArray(paperBetsTable.id, idsToVoid));

    logger.info({ count: toVoid.size, removedByReason }, "deduplicatePendingBets: voided correlated duplicate pending bets");
  }

  // 4. Compliance log
  await db.insert(complianceLogsTable).values({
    actionType: "correlation_dedup_applied",
    details: {
      totalBefore,
      totalRemoved: toVoid.size,
      totalAfter: totalBefore - toVoid.size,
      removedByReason,
      note: "Correlation fix applied. Historical stats before this point may be inflated by correlated threshold bets.",
    },
    timestamp: new Date(),
  });

  return {
    totalBefore,
    totalRemoved: toVoid.size,
    totalAfter: totalBefore - toVoid.size,
    removedByReason,
  };
}

// ─── Void bets on banned markets ──────────────────────────────────────────────
// Used by the admin endpoint to void any existing pending bets on markets that
// are now permanently banned. Refunds the stake to bankroll.

export async function voidBetsOnBannedMarkets(): Promise<{
  voided: number;
  totalStakeRefunded: number;
  byMarket: Record<string, number>;
}> {
  const bannedList = [...BANNED_MARKETS];

  const pendingBanned = await db
    .select({
      id: paperBetsTable.id,
      marketType: paperBetsTable.marketType,
      stake: paperBetsTable.stake,
    })
    .from(paperBetsTable)
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        sql`deleted_at IS NULL`,
        inArray(paperBetsTable.marketType, bannedList),
      ),
    );

  if (pendingBanned.length === 0) {
    logger.info("voidBetsOnBannedMarkets: no pending bets on banned markets");
    return { voided: 0, totalStakeRefunded: 0, byMarket: {} };
  }

  const byMarket: Record<string, number> = {};
  let totalStakeRefunded = 0;

  for (const bet of pendingBanned) {
    const stake = parseFloat(bet.stake ?? "0");
    byMarket[bet.marketType] = (byMarket[bet.marketType] ?? 0) + 1;
    totalStakeRefunded += stake;

    await db
      .update(paperBetsTable)
      .set({ status: "void", settlementPnl: "0", settledAt: new Date() })
      .where(eq(paperBetsTable.id, bet.id));
  }

  // Refund total stake to bankroll
  const currentBankroll = await getBankroll();
  const newBankroll = currentBankroll + totalStakeRefunded;
  await setConfigValue("bankroll", String(newBankroll.toFixed(2)));

  await db.insert(complianceLogsTable).values({
    actionType: "void_banned_market_bets",
    details: {
      voided: pendingBanned.length,
      totalStakeRefunded: totalStakeRefunded.toFixed(2),
      byMarket,
      bannedMarkets: BANNED_MARKETS,
      bankrollBefore: currentBankroll,
      bankrollAfter: newBankroll,
    },
    timestamp: new Date(),
  });

  logger.info(
    { voided: pendingBanned.length, totalStakeRefunded: totalStakeRefunded.toFixed(2), byMarket },
    "voidBetsOnBannedMarkets: complete — stake refunded to bankroll",
  );

  return { voided: pendingBanned.length, totalStakeRefunded, byMarket };
}
