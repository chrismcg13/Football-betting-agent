import {
  db,
  agentConfigTable,
  paperBetsTable,
  matchesTable,
  complianceLogsTable,
  oddsSnapshotsTable,
  competitionConfigTable,
  modelDecisionAuditLogTable,
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
import { evaluateExperimentTag, computeArchetypeDistributionShift } from "./promotionEngine";
import { shouldBlockBet, getSegmentKellyMultiplier, getMarketFamily } from "./edgeConcentration";
import { checkAutonomousPauses } from "./modelSelfAudit";
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
import { checkLivePlacementGates } from "./livePlacementGate";

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
  // Phase 3 B1 (2026-05-08): include marketId in the capture return value
  // so placement code can persist it. The Betfair Exchange placeOrders API
  // requires a marketId — without this the only path to live placement
  // is unavailable. Pre-Phase-3 builds discarded the marketId after using
  // it for listMarketBook, leaving paper_bets.betfair_market_id null on
  // every row.
  marketId: string | null;
  fetchedAt: Date;
}

// Allowlist: only numeric Betfair event IDs. Rejects "af_*", "fd_*", and any
// other foreign-source prefixes that may have leaked into matches.betfair_event_id.
const BETFAIR_EVENT_ID_RE = /^\d+$/;

/**
 * Phase 3 Track D / AH line-aware (2026-05-08): pick the correct ASIAN_HANDICAP
 * market for a bet whose selectionName encodes the line ("Home +0.5",
 * "Away -1.5"). Each Betfair event has multiple AH markets (one per line).
 * Each AH market has 2 runners (Home and Away) with handicap values.
 *
 * Selection-name convention from exchangeBookSweep.deriveSelectionName:
 *   side = "Home" or "Away"
 *   line = handicap given to that side (e.g. "Home +0.5" → Home gets +0.5)
 *
 * Match: AH market where the matching-side runner has runner.handicap == line.
 * Falls back to NULL (caller treats as no_market — counter increments).
 *
 * Tolerance: handicap values are stored as numbers (Betfair) and our line
 * encoding is decimal. We compare with epsilon 1e-6 for safety on floating-
 * point representations of quarter-line values like 0.25 / 0.75.
 */
function findAhMarketByLine(
  catalogue: MarketCatalogueItem[],
  selectionName: string,
  homeTeam: string,
  awayTeam: string,
): MarketCatalogueItem | undefined {
  // Parse "Home +0.5" / "Away -1.25" / "Home +0" — capture side + signed line.
  const m = selectionName.trim().match(/^(Home|Away)\s*([+-]?\d+(?:\.\d+)?)$/i);
  if (!m) return undefined;
  const side = m[1]!.toLowerCase() === "home" ? "home" : "away";
  const line = parseFloat(m[2]!);
  if (!Number.isFinite(line)) return undefined;

  const ahMarkets = catalogue.filter((c) => c.description?.marketType === "ASIAN_HANDICAP");
  for (const market of ahMarkets) {
    const runners = market.runners ?? [];
    if (runners.length < 2) continue;
    // Pick the runner that matches our side. Prefer name-equality, fall back
    // to sortPriority (1=Home, 2=Away — same convention as findSelectionId).
    const sideRunner = runners.find((r) => {
      const rn = r.runnerName.toLowerCase();
      if (side === "home") return rn === homeTeam.toLowerCase() || r.sortPriority === 1;
      return rn === awayTeam.toLowerCase() || r.sortPriority === 2;
    });
    if (!sideRunner) continue;
    const handicap = sideRunner.handicap;
    if (handicap == null) continue;
    if (Math.abs(handicap - line) < 1e-6) return market;
  }
  return undefined;
}

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

  // Phase 3 Track D / B-bundle (2026-05-08): map our internal marketType
  // (e.g. BTTS, TEAM_TOTAL_HOME_15, FIRST_HALF_RESULT) to Betfair's
  // canonical marketType (BOTH_TEAMS_TO_SCORE, TEAM_A_2, HALF_TIME)
  // before searching the catalogue. Pre-fix, exact-string matching
  // silently failed for any market whose Betfair name differs from our
  // internal name — observed 0% capture rate on BTTS (126 bets/7d),
  // TEAM_TOTAL_* (303 bets/7d across 5 sub-types), FIRST_HALF_RESULT,
  // and any future internal code that doesn't 1:1 match Betfair.
  const { MARKET_TYPE_MAP } = await import("./betfairLive");
  const bfMarketType = MARKET_TYPE_MAP[marketType] ?? marketType;

  // Phase 3 Track D / AH line-aware (2026-05-08): for ASIAN_HANDICAP, Betfair
  // returns ONE market per line per event (each with 2 runners — Home and
  // Away — and a runner.handicap value). catalogue.find by marketType alone
  // returns the FIRST AH market, which is rarely the line our bet was on.
  // Pre-fix observed AH capture at 44% — most captures landed on the wrong
  // line, so the captured market_id was useless for live placement.
  // Fix: parse line from selectionName ("Home +0.5" / "Away -1.5"), then
  // search AH markets for the one whose matching-side runner has that
  // handicap. For non-AH markets, exact marketType match is correct.
  let market: MarketCatalogueItem | undefined;
  if (bfMarketType === "ASIAN_HANDICAP") {
    market = findAhMarketByLine(catalogue, selectionName, homeTeam, awayTeam);
  } else {
    market = catalogue.find((m) => m.description?.marketType === bfMarketType);
  }
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
    marketId: market.marketId,
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

// ─── Bankroll writer helpers (B1) ────────────────────────────────────────────
// Writers MUST read the persisted bankroll from agent_config (NOT the live
// Betfair balance via getBankroll()) before applying a delta and writing back.
// Reading the live Betfair value and writing it to agent_config is the bug
// these helpers exist to prevent — it overwrites the persisted ledger with a
// transient exchange-balance snapshot.

/** Read raw persisted bankroll from agent_config. Never falls through to live Betfair. */
export async function getConfigBankroll(): Promise<number> {
  const v = await getConfigValue("bankroll");
  return Number(v ?? "500");
}

/**
 * Atomic bankroll mutation: read persisted value, add delta, write back, log.
 * Returns { before, after, delta } so callers can embed in their own audit logs.
 */
export async function applyBatchPnl(
  delta: number,
  reason: string,
  extraDetails?: Record<string, unknown>,
): Promise<{ before: number; after: number; delta: number }> {
  const before = await getConfigBankroll();
  const after = Math.round((before + delta) * 100) / 100;
  await setConfigValue("bankroll", String(after));
  await db.insert(complianceLogsTable).values({
    actionType: "bankroll_updated",
    details: {
      bankrollBefore: before,
      bankrollAfter: after,
      delta,
      reason,
      ...(extraDetails ?? {}),
    },
    timestamp: new Date(),
  });
  // F1 (2026-05-07): bankroll snapshot AFTER batch PnL applied. Together
  // with pre-bet snapshots, lets us compute true LN(after/before) per bet
  // for proper Kelly-growth-rate measurement (vs current proxy LN(1+pnl/stake)).
  void db.execute(sql`
    INSERT INTO bankroll_snapshots (paper_bankroll, source, notes, taken_at)
    VALUES (${after}, ${reason}, ${JSON.stringify(extraDetails ?? {})}, NOW())
  `).catch((err) => logger.warn({ err }, "F1 bankroll snapshot write failed (non-fatal)"));
  logger.info(
    { previous: before, delta, updated: after, reason },
    "Bankroll updated via applyBatchPnl",
  );
  return { before, after, delta };
}

/**
 * F1 (2026-05-07): pre-placement bankroll snapshot. Called from
 * placePaperBet just before INSERT so settleBets can compute true
 * LN(bankroll_after / bankroll_before) per bet.
 */
async function writePrePlacementSnapshot(betId: number | null, reason: string): Promise<void> {
  try {
    const bankroll = await getConfigBankroll();
    await db.execute(sql`
      INSERT INTO bankroll_snapshots (paper_bankroll, source, bet_id, notes, taken_at)
      VALUES (${bankroll}, ${reason}, ${betId}, NULL, NOW())
    `);
  } catch (err) {
    logger.warn({ err, betId, reason }, "F1 pre-placement snapshot failed (non-fatal)");
  }
}
export { writePrePlacementSnapshot };

/**
 * Set bankroll to an absolute value (used for explicit resets, e.g. £100 baseline).
 * Logs compliance with previous value for audit.
 */
export async function setBankrollAbsolute(
  value: number,
  reason: string,
): Promise<{ before: number; after: number }> {
  const before = await getConfigBankroll();
  const after = Math.round(value * 100) / 100;
  await setConfigValue("bankroll", String(after));
  await db.insert(complianceLogsTable).values({
    actionType: "bankroll_updated",
    details: { bankrollBefore: before, bankrollAfter: after, delta: after - before, reason, source: "setBankrollAbsolute" },
    timestamp: new Date(),
  });
  logger.warn({ previous: before, updated: after, reason }, "Bankroll set to absolute value");
  return { before, after };
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
  // Task 8 (2026-05-11): TOTAL_CORNERS_* unbanned. Phantom-signal root-cause
  // patched in predictCorners (strict feature gate, no defaulting). Corners
  // now flow through the normal eligibility ladder — shadow-only until they
  // accrue n>=30 with Wilson lower-95 > breakeven; auto-promotes via
  // v_live_eligibility_candidates. Wilson cold-market gate demotes any
  // scope that fails to hold an edge.
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

// Sub-phase 9: tier kelly_fraction lookup. Replaces the env-flag-driven
// CANDIDATE_STAKE_MULTIPLIER with a per-tag value sourced from
// experiment_registry.kelly_fraction. Returns 1.0 (no multiplier) when:
//   - tag is null/empty (Tier A legacy bet without a registry row)
//   - registry row missing for the tag
//   - registry row's kelly_fraction is null
// Otherwise returns the row's value, clamped to [0, 1.0] defensively.
async function getTierKellyFractionForTag(experimentTag: string | null | undefined): Promise<number> {
  if (!experimentTag) return 1.0;
  try {
    const rows = await db.execute(sql`
      SELECT kelly_fraction FROM experiment_registry
      WHERE experiment_tag = ${experimentTag}
      LIMIT 1
    `);
    const r = (rows as any).rows?.[0];
    if (!r || r.kelly_fraction == null) return 1.0;
    const v = parseFloat(r.kelly_fraction);
    if (!Number.isFinite(v)) return 1.0;
    return Math.max(0, Math.min(1.0, v));
  } catch (err) {
    logger.warn({ err, experimentTag }, "getTierKellyFractionForTag lookup failed — defaulting to 1.0");
    return 1.0;
  }
}

// 2026-05-09 (no-bet-dropped): operator kill-switch for the production→
// shadow fallthrough behavior added in this commit. Default true.
// When false, every demote site reverts to its previous reject behavior.
// Cached for 30s to keep the placement hot path lookup-free in steady state.
let cachedFallthroughFlag: { value: boolean; fetchedAt: number } | null = null;
const FALLTHROUGH_FLAG_TTL_MS = 30_000;
async function isLiveToShadowFallthroughEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedFallthroughFlag && now - cachedFallthroughFlag.fetchedAt < FALLTHROUGH_FLAG_TTL_MS) {
    return cachedFallthroughFlag.value;
  }
  const raw = (await getConfigValue("live_to_shadow_fallthrough_enabled"))?.toLowerCase()?.trim() ?? "true";
  const value = raw !== "false" && raw !== "0";
  cachedFallthroughFlag = { value, fetchedAt: now };
  return value;
}

// Wave 1 (Phase 2 closeout): shadow-bet gate exemption audit log.
// Each Tier B/C bet that bypasses a production-track risk gate writes a row
// to model_decision_audit_log. Bucket-batched at one row per
// (gate, experimentTag, hour) to keep volume manageable: subsequent fires
// within the bucket increment supportingMetrics.exemptionsInBucket.
//
// Failures are swallowed (warn-log only) so audit-log unavailability never
// blocks a bet from placing. The compliance_logs trail is unaffected.
async function logShadowGateExemption(
  gateName: string,
  experimentTag: string | null,
  reason: string,
  shadowStake: number | null,
  universeTier: string | null,
): Promise<void> {
  const tag = experimentTag ?? "untagged";
  const hourBucket = new Date()
    .toISOString()
    .slice(0, 13)
    .replace("T", "_")
    .replace(/-/g, ""); // e.g. "20260507_11"
  const subject = `gate:${gateName}:tag:${tag}:hour:${hourBucket}`;
  try {
    const existing = await db
      .select({
        id: modelDecisionAuditLogTable.id,
        supportingMetrics: modelDecisionAuditLogTable.supportingMetrics,
      })
      .from(modelDecisionAuditLogTable)
      .where(
        and(
          eq(modelDecisionAuditLogTable.subject, subject),
          eq(modelDecisionAuditLogTable.decisionType, "shadow_bet_gate_exempted"),
        ),
      )
      .limit(1);

    if (existing[0]) {
      const oldMetrics = (existing[0].supportingMetrics as Record<string, unknown> | null) ?? {};
      const oldCount = Number(oldMetrics["exemptionsInBucket"] ?? 1);
      await db
        .update(modelDecisionAuditLogTable)
        .set({
          supportingMetrics: {
            ...oldMetrics,
            exemptionsInBucket: oldCount + 1,
          } as any,
        })
        .where(eq(modelDecisionAuditLogTable.id, existing[0].id));
      return;
    }

    await db.insert(modelDecisionAuditLogTable).values({
      decisionType: "shadow_bet_gate_exempted",
      subject,
      priorState: { gate_would_have_blocked: true, reason } as any,
      newState: { admitted: true, stake: 0, shadow_stake: shadowStake } as any,
      reasoning:
        "Tier B/C bet exempted from production-track risk control per architectural guarantee — £0 stake cannot affect bankroll",
      supportingMetrics: {
        universeTier,
        kellyGrowthImpactExpected: 0,
        exemptionsInBucket: 1,
      } as any,
      reviewStatus: "automatic",
    });
  } catch (err) {
    logger.warn(
      { err, gateName, experimentTag: tag },
      "Failed to write shadow_bet_gate_exempted audit row",
    );
  }
}

// 2026-05-11 — single source of truth for the Kelly fraction used when
// recording shadow_stake. Mirrors the candidate-tier flow at
// paperTrading.ts:1683 so shadow_pnl is computed against the SAME Kelly
// fraction a real candidate-tier bet would have used (drawdown-targeted
// dynamic Kelly from kelly_fraction_lookup, computed by the daily
// Monte-Carlo cron in dynamicKelly.ts). Falls back to 0.25 with a
// compliance log if the lookup hasn't populated yet — same fallback as
// the live candidate-tier path.
export async function getShadowKellyFraction(
  matchId: number,
  marketType: string,
): Promise<number> {
  try {
    const { getDynamicKellyFraction } = await import("./dynamicKelly");
    const dynamicF = await getDynamicKellyFraction();
    if (dynamicF != null && Number.isFinite(dynamicF) && dynamicF > 0 && dynamicF <= 1) {
      return dynamicF;
    }
  } catch (err) {
    logger.warn(
      { err, matchId, marketType },
      "Shadow Kelly fraction: getDynamicKellyFraction failed — using fallback",
    );
  }
  const fallback = 0.25;
  try {
    await db.insert(complianceLogsTable).values({
      actionType: "shadow_dynamic_kelly_fallback",
      details: { matchId, marketType, fallback, reason: "kelly_fraction_lookup empty or invalid" },
      timestamp: new Date(),
    });
  } catch {
    // Non-fatal — fallback still returned
  }
  return fallback;
}

export function calculateDynamicKellyStake(
  bankroll: number,
  pFair: number,
  backOdds: number,
  maxStakePct: number,
  opportunityScore: number,
  marketType?: string,
  commissionRate: number = 0.05,
): number {
  // Task 1 (2026-05-11): commission-aware Kelly. Replaces the legacy
  // `edge / (backOdds - 1)` formula (which sized against gross edge and
  // ignored Betfair's 5% commission entirely) with the canonical Kelly
  // criterion applied to the COMMISSION-ADJUSTED decimal odds:
  //
  //   b_net   = (backOdds - 1) * (1 - commissionRate)  // net win multiplier
  //   f* full = (p_fair × b_net − (1 − p_fair)) / b_net
  //
  // p_fair is the true-win-probability estimate. Caller is expected to pass:
  //   - 1 / fairValueOdds when a non-degenerate Pinnacle (or CLV-equivalent)
  //     source is available (the strongest unbiased prior we have); OR
  //   - the calibrated model probability when no sharp reference exists
  //     (post-Phase-3b: this is the isotonic-calibrated sigmoid, not raw).
  //
  // Returns raw Kelly stake (no £2 floor — Task 2 removed it). Caller is
  // responsible for routing sub-£2 results to the shadow rail; see the
  // demote block in placePaperBet.
  //
  // Worked example (AH at odds 2.00, p_fair 0.55, commission 5%, score 70):
  //   b_net   = 1.00 * 0.95 = 0.95
  //   f* full = (0.55 * 0.95 − 0.45) / 0.95
  //           = (0.5225 − 0.45) / 0.95
  //           = 0.0763  (≈ 7.6% of bankroll if score-multiplier were 1.0)
  //   Compared to legacy gross-edge sizing the bet is ~5% smaller on the
  //   win term, which is exactly the size of the commission haircut on
  //   realised P&L. Stakes that previously sat just above the maxStakePct
  //   cap shrink modestly; sub-marginal edges (close to commission
  //   break-even) shrink to zero, correctly demoting them to shadow.
  if (!Number.isFinite(pFair) || pFair <= 0 || pFair >= 1) return 0;
  if (!Number.isFinite(backOdds) || backOdds <= 1) return 0;

  const bNet = (backOdds - 1) * (1 - commissionRate);
  if (bNet <= 0) return 0;

  const q = 1 - pFair;
  const kellyFull = (pFair * bNet - q) / bNet;
  if (kellyFull <= 0) return 0;

  const fraction = kellyFractionForScore(opportunityScore, marketType);
  let stake = bankroll * kellyFull * fraction;

  stake = Math.min(stake, bankroll * maxStakePct);

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
  // Phase 2.B.2: when set to 'B' or 'C', placement enters shadow-stake
  // mode — actual stake is set to 0 and shadow_stake records what
  // 0.25× full Kelly would have been. Min-stake / exposure / live-
  // concentration gates are bypassed for shadow bets. 'A' (or null/
  // undefined) leaves the existing production-stake flow untouched.
  universeTier?: "A" | "B" | "C" | null;
  // B1+B2 (2026-05-07): authoritative placement-track signal from
  // valueDetection. When set to 'shadow', placement enters £0 shadow-stake
  // mode regardless of universeTier — captures Tier A near-misses (bets
  // below production threshold but above shadow floor) as learning data.
  // When undefined, falls back to the universeTier-based check.
  placementTrack?: "production" | "shadow" | null;
  // Task 12 (2026-05-11): pre-calibration sigmoid output (raw_model_probability)
  // and a backreference to the calibration_buckets row applied. Both NULL on
  // legacy emissions; populated post-deploy. modelProbability (positional arg
  // to placePaperBet) carries the post-calibration value.
  rawModelProbability?: number | null;
  calibrationBucketId?: number | null;
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
    universeTier = null,
    placementTrack = null,
    rawModelProbability = null,
    calibrationBucketId = null,
  } = options;
  // Phase 2.B.2 + B1/B2 (2026-05-07): shadow-bet flag. Tier B/C are always
  // shadow (no Pinnacle anchor by definition). Additionally, valueDetection
  // can set placementTrack='shadow' for Tier A near-misses (positive-EV
  // candidates below production threshold) — those are captured as £0
  // learning bets too. When either trigger fires, placement bypasses
  // min-stake / exposure / live-concentration gates and writes stake=0 +
  // shadow_stake.
  let isShadowBet = placementTrack === "shadow" || universeTier === "B" || universeTier === "C";

  // 2026-05-11 (Task 7 — back-to-theory plan): AH-only live exception removed.
  // Live eligibility is now governed entirely by v_live_eligibility_candidates
  // (Wilson lower-95 on win-rate AND/OR t-stat on CLV at n>=30). Any market
  // whose (league, market_type) qualifies there may route to live.

  // Mutable: boosted bets that qualify for Tier 1B get a 0.5x stake multiplier.
  let stakeMultiplier = options.stakeMultiplier ?? 1.0;

  // Post-cutover (2026-05-09): the §3 trigger blocks any INSERT with
  // bet_track='paper' once agent_config.cutover_completed_at is set. Production-
  // track candidates (isShadowBet=false) must therefore route to bet_track='live'
  // when the kill switch is on, or to bet_track='shadow' when it's off (degraded
  // mode — record the signal without committing real money). Without this branch,
  // every Tier A production candidate that passed upstream gates would trip the
  // trigger and the cycle would lose the signal silently.
  const cutoverCompletedAtRaw = await getConfigValue("cutover_completed_at");
  const postCutover = !!cutoverCompletedAtRaw && cutoverCompletedAtRaw.trim() !== "";
  if (postCutover && !isShadowBet) {
    const { isLivePlacementEnabled } = await import("./livePlacementGate");
    const killSwitchOn = isLiveMode() && (await isLivePlacementEnabled());
    if (!killSwitchOn) {
      await logShadowGateExemption(
        "post_cutover_kill_switch_off",
        experimentTag ?? null,
        `Post-cutover degraded mode: kill switch off (live_placement_enabled=false or TRADING_MODE!=LIVE) — demoting production-track signal to shadow`,
        null,
        universeTier,
      );
      isShadowBet = true;
    }
  }
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
  // Wave 2 #4 (2026-05-05): production track keeps bans; experiment track
  // (Tier B/C, £0 stake architectural guarantee) bypasses them. Strategic
  // intent: let the model re-prove edge or non-edge with current
  // post-Replit-migration infrastructure. £0 stake means zero capital at
  // risk; correlation + duplicate-bet rejection still apply.
  if (BANNED_MARKETS.has(marketType) && !isShadowBet) {
    logger.warn({ matchId, marketType, selectionName }, "HARDSTOP: Banned market — bet blocked at placement");
    return logReject(`Banned market: ${marketType}`);
  }
  if (BANNED_MARKETS.has(marketType) && isShadowBet) {
    logger.info(
      { matchId, marketType, selectionName, universeTier },
      "Wave 2 #4: experiment-track shadow bet on previously-banned market — admitted for relearning",
    );
  }

  // ── Autonomous-pause registry (model self-audit) ─────────────────────────
  // Daily runModelSelfAudit() pauses scopes (market / league_market / league
  // / archetype) where Kelly-growth-rate / ROI / data-coverage tripped a
  // threshold. Tier B/C shadow bets bypass via checkAutonomousPauses (the
  // architectural principle that £0 capture continues even on distressed
  // markets — that's where the most valuable learning happens).
  let stakeMultiplierFromPauseTrial = 1.0;
  let pauseScopeContext: { league: string | null; archetype: string | null } = {
    league: null,
    archetype: null,
  };
  try {
    const [matchInfo] = await db
      .select({
        league: matchesTable.league,
      })
      .from(matchesTable)
      .where(eq(matchesTable.id, matchId))
      .limit(1);
    pauseScopeContext.league = matchInfo?.league ?? null;
    if (pauseScopeContext.league) {
      const [ccInfo] = await db
        .select({ archetype: competitionConfigTable.archetype })
        .from(competitionConfigTable)
        .where(eq(competitionConfigTable.name, pauseScopeContext.league))
        .limit(1);
      pauseScopeContext.archetype = ccInfo?.archetype ?? null;
    }

    const pauseCheck = await checkAutonomousPauses({
      marketType,
      league: pauseScopeContext.league,
      archetype: pauseScopeContext.archetype,
      isShadowBet,
    });
    if (pauseCheck.paused) {
      logger.warn(
        {
          matchId,
          marketType,
          scope: pauseCheck.pauseRow,
        },
        "Bet blocked by autonomous pause (self-audit)",
      );
      return logReject(
        `Autonomous pause active on ${pauseCheck.pauseRow?.scopeType} ${pauseCheck.pauseRow?.scopeValue} (reason: ${pauseCheck.pauseRow?.reason}, until ${pauseCheck.pauseRow?.pausedUntil})`,
      );
    }
    if (
      pauseCheck.kellyFractionOverride !== null &&
      pauseCheck.kellyFractionOverride !== 1.0 &&
      pauseCheck.kellyFractionOverride > 0
    ) {
      // Tier override active. Values < 1.0 are demotion-side trials (TRIAL
      // = 0.25, STANDARD_REDUCED = 0.5). Values > 1.0 are promotion-side
      // boosts (BOOSTED = 1.5). Multiply into existing stakeMultiplier so
      // it composes with sub-phase 9 v2 per-tag kelly_fraction and other
      // multipliers; the hard maxStakePct cap downstream still applies so
      // boost can't run away.
      stakeMultiplierFromPauseTrial = pauseCheck.kellyFractionOverride;
      stakeMultiplier *= stakeMultiplierFromPauseTrial;
      logger.info(
        {
          matchId,
          marketType,
          scope: pauseCheck.pauseRow,
          kellyFractionOverride: pauseCheck.kellyFractionOverride,
          combinedStakeMultiplier: stakeMultiplier,
          direction: pauseCheck.kellyFractionOverride < 1.0 ? "demoted" : "boosted",
        },
        "Bet admitted with autonomous tier override",
      );
    }
  } catch (pauseErr) {
    // Pause-check failures must not block bet placement — fail-open.
    logger.warn({ err: pauseErr, matchId }, "Autonomous pause check failed — proceeding");
  }

  // ── Edge concentration gates ─────────────────────────────────────────────
  // Wave 1 (Phase 2 closeout): production track keeps the gate; experiment
  // track (Tier B/C, £0 stake) is exempted because the gate exists to bound
  // capital concentration risk and shadow bets carry no capital.
  {
    const blockCheck = shouldBlockBet(marketType, backOdds, options.liveTier ?? null);
    if (blockCheck.blocked) {
      if (isShadowBet) {
        logger.info(
          { matchId, marketType, selectionName, backOdds, reason: blockCheck.reason, universeTier },
          "Edge-concentration gate exempted for shadow bet",
        );
        await logShadowGateExemption(
          "edge_concentration",
          experimentTag ?? null,
          blockCheck.reason ?? "edge concentration block",
          null,
          universeTier,
        );
      } else {
        logger.warn(
          { matchId, marketType, selectionName, backOdds, reason: blockCheck.reason },
          "EDGE CONCENTRATION: bet blocked",
        );
        return logReject(blockCheck.reason!);
      }
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
      // Firehose leak fix (2026-05-07): shadow bets (£0 stake, learning data)
      // bypass stats-coverage requirements per "shadow bypasses every capital-
      // risk gate" durable rule. Production-track real-stake still rejected.
      if (!isShadowBet) {
        return logReject(`No ${isCornersMarket ? "corners" : "cards"} stats coverage for league: ${match.league} (${match.country})`);
      }
      await logShadowGateExemption(
        "stats_coverage_required",
        experimentTag ?? null,
        `No ${isCornersMarket ? "corners" : "cards"} stats coverage for league: ${match.league}`,
        0, // shadow_stake not yet computed at this point
      );
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
  // 2026-05-09 (no-bet-dropped): both quarantine paths now demote to shadow
  // when live_to_shadow_fallthrough_enabled=true rather than dropping the
  // bet entirely. Capital is still protected (shadow stakes £0); the model
  // gets the learning signal on quarantined-tier or non-Tier-1B-boosted
  // bets so re-graduation evidence accumulates.
  const currentEnv = process.env["ENVIRONMENT"] ?? "development";
  if (currentEnv === "production") {
    if (dataTier === "abandoned" || dataTier === "demoted") {
      if (!isShadowBet && (await isLiveToShadowFallthroughEnabled())) {
        logger.info(
          { matchId, marketType, selectionName, dataTier },
          "Production quarantine: demoting to shadow rail",
        );
        await logShadowGateExemption(
          "production_quarantine",
          experimentTag ?? null,
          `Production quarantine: ${dataTier}-tier — demoted to shadow`,
          null,
          universeTier,
        );
        isShadowBet = true;
      } else {
        return logReject(`Production quarantine: ${dataTier}-tier bets blocked in prod`);
      }
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
        if (!isShadowBet && (await isLiveToShadowFallthroughEnabled())) {
          logger.info(
            { matchId, marketType, score, edge, reason: preCheck.reason },
            "Boosted-bet quarantine: demoting to shadow rail",
          );
          await logShadowGateExemption(
            "production_quarantine_boosted",
            experimentTag ?? null,
            `Production quarantine: opportunity-boosted not Tier 1B-qualified (${preCheck.reason}) — demoted to shadow`,
            null,
            universeTier,
          );
          isShadowBet = true;
        } else {
          return logReject(
            `Production quarantine: opportunity-boosted bet not Tier 1B-qualified (${preCheck.reason})`,
          );
        }
      } else {
        // Approved: apply 0.5x stake and tag for later.
        stakeMultiplier *= 0.5;
        boostedTier1BApproved = true;
        logger.info(
          { matchId, marketType, score, edge, stakeMultiplier },
          "Boosted bet exempted from quarantine — pre-qualifies Tier 1B at 0.5x stake",
        );
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Wave 1.5 (Phase 2 closeout): the next three gates are global circuit-
  // breakers that protect real-money operations (admin pause, Betfair API
  // rate limiter, consecutive-loss / floor-breach kill switch). Shadow bets
  // carry stake=0 and capture learning data — they bypass all three but
  // STILL fire any state-mutating side effects (e.g. circuit breaker still
  // sets agent_status='paused' when it triggers; we just don't reject the
  // shadow bet that observed the trigger).
  const status = await getAgentStatus();
  if (status !== "running") {
    if (isShadowBet) {
      await logShadowGateExemption(
        "agent_status_paused",
        experimentTag ?? null,
        `Agent is not running (status: ${status})`,
        null,
        universeTier,
      );
    } else {
      return logReject(`Agent is not running (status: ${status})`);
    }
  }

  if (isLiveMode() && isBetfairApiPaused()) {
    if (isShadowBet) {
      // Shadow bets don't transmit to the Betfair Exchange (stake=0 is a
      // local paper_bets row), so a Betfair API pause is irrelevant.
      await logShadowGateExemption(
        "betfair_api_paused",
        experimentTag ?? null,
        "Betfair API error rate pause active",
        null,
        universeTier,
      );
    } else {
      return logReject("Betfair API error rate pause active — skipping bet placement");
    }
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
    if (isShadowBet) {
      // Consecutive losses / floor breach are pure capital-protection
      // signals. Shadow bets are £0 — explicitly architecturally allowed
      // to fire during these states (and especially valuable for learning
      // when the model is in a distressed regime).
      await logShadowGateExemption(
        "live_circuit_breaker",
        experimentTag ?? null,
        liveCircuitBreaker.reason ?? "live circuit breaker triggered",
        null,
        universeTier,
      );
    } else {
      return logReject(`Live circuit breaker: ${liveCircuitBreaker.reason}`);
    }
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
        const reason = `Bankroll £${effectiveBankroll.toFixed(2)} at or below paper floor £${bankrollFloor}`;
        if (isShadowBet) {
          // Wave 1: shadow bets carry stake=0 and cannot affect bankroll, so
          // the paper floor doesn't apply. Audit-log the exemption.
          await logShadowGateExemption(
            "paper_bankroll_floor",
            experimentTag ?? null,
            reason,
            null,
            universeTier,
          );
        } else {
          return logReject(reason);
        }
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
      const reason = `Daily loss limit hit: £${dailyLoss.toFixed(2)} >= £${dailyLossLimit.toFixed(2)} (${(dailyLossLimitPct * 100).toFixed(0)}% of ${liveLimits ? "live" : "paper"} balance)`;
      if (isShadowBet) {
        // Wave 1: shadow bets cannot move the loss counter (stake=0), so the
        // daily-loss circuit-breaker is exempted. Audit-log the exemption.
        await logShadowGateExemption(
          "daily_loss_limit",
          experimentTag ?? null,
          reason,
          null,
          universeTier,
        );
      } else {
        return logReject(reason);
      }
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
      const reason = `Weekly loss limit hit: £${weeklyLoss.toFixed(2)} >= £${weeklyLossLimit.toFixed(2)} (${(weeklyLossLimitPct * 100).toFixed(0)}% of ${liveLimits ? "live" : "paper"} balance)`;
      if (isShadowBet) {
        // Wave 1: same architectural rationale as daily_loss_limit.
        await logShadowGateExemption(
          "weekly_loss_limit",
          experimentTag ?? null,
          reason,
          null,
          universeTier,
        );
      } else {
        return logReject(reason);
      }
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
        betTrack: paperBetsTable.betTrack,
      })
      .from(paperBetsTable)
      .where(
        and(
          eq(paperBetsTable.matchId, matchId),
          sql`deleted_at IS NULL`,
          sql`(${paperBetsTable.status} IN ('pending','pending_placement') OR (${paperBetsTable.status} IN ('void','cancelled') AND ${paperBetsTable.settledAt} >= ${recentVoidCutoff}))`,
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

    // 3. Hard cap — bet-track-aware (Phase 3 A3, 2026-05-08; demote 2026-05-09;
    //    shadow cap raised 12→24 on 2026-05-09 per plan v3 Bundle 1 / §Item 7).
    // Paper rail: cap=4 (capital-discipline analogue, prevents per-fixture
    //   correlation/exposure). Threshold-category dedup above prevents
    //   correlated picks; the 4-cap then limits independent-edge stacking.
    // Shadow rail: cap=24. Shadow is £0 learning data with no capital risk.
    //   AH/ATG-rich fixtures saturated the prior cap of 12 (13,210 rejects/24h
    //   from 698 distinct (match × selection) pairs). Doubling captures the
    //   marginal candidates that were lost; further raises hit diminishing
    //   returns because valueDetection re-emits the same opportunities every
    //   5-min cycle (structural retry — separate follow-up ticket).
    // 2026-05-09 (no-bet-dropped): paper cap saturation no longer drops the
    //   bet — it demotes to shadow if shadow has room. Only when BOTH rails
    //   are saturated does the bet drop.
    const incomingTrack: "paper" | "shadow" = isShadowBet ? "shadow" : "paper";
    const cap = incomingTrack === "shadow" ? 24 : 4;
    const sameTrackPending = existingPending.filter(
      (b) => (b.betTrack ?? "paper") === incomingTrack,
    );
    if (sameTrackPending.length >= cap) {
      if (incomingTrack === "paper" && (await isLiveToShadowFallthroughEnabled())) {
        const shadowPending = existingPending.filter(
          (b) => (b.betTrack ?? "paper") === "shadow",
        );
        if (shadowPending.length < 24) {
          logger.info(
            {
              matchId,
              marketType,
              selectionName,
              paperPending: sameTrackPending.length,
              shadowPending: shadowPending.length,
            },
            "Paper per-match cap reached — demoting to shadow rail",
          );
          await logShadowGateExemption(
            "paper_per_match_cap",
            experimentTag ?? null,
            `Paper per-match cap of 4 reached on match ${matchId}; shadow has ${24 - shadowPending.length} slots free — demoted`,
            null,
            universeTier,
          );
          isShadowBet = true;
        } else {
          return logReject(
            `Match ${matchId} saturated on both rails (paper ${sameTrackPending.length}/4, shadow ${shadowPending.length}/24) — dropping ${marketType}:${selectionName}`,
          );
        }
      } else {
        return logReject(
          `Match ${matchId} already has ${sameTrackPending.length} pending ${incomingTrack} bets (max ${cap}) — skipping ${marketType}:${selectionName}`,
        );
      }
    }
  }

  const maxStakePct = liveLimits
    ? liveLimits.config.maxSingleBetPct
    : Number((await getConfigValue("max_stake_pct")) ?? "0.02");
  const stakingBankroll = liveLimits ? liveLimits.liveBalance : bankroll;
  // Task 1 (2026-05-11): p_fair source priority. Prefer the Pinnacle-derived
  // sharp probability (1/fairValueOdds) when a non-degenerate fair value
  // source is available; fall back to the calibrated model probability
  // otherwise. The fairValueSource === actionableSource case is the
  // degenerate fallback used for non-Pinnacle leagues (see valueDetection.ts
  // — that branch synthesises fair_value from the exchange row itself, so
  // 1/fairValueOdds collapses to the book's implied prob and is useless for
  // sizing). modelProbability is post-Phase-3b calibrated.
  const fvAvailable =
    fairValueOdds != null &&
    Number(fairValueOdds) > 1 &&
    fairValueSource != null &&
    fairValueSource !== actionableSource;
  const pFair = fvAvailable ? 1 / Number(fairValueOdds) : modelProbability;
  const { getCommissionRate: __getCommissionRate } = await import("./commissionService");
  const commissionRate = await __getCommissionRate("betfair");
  let stake = calculateDynamicKellyStake(
    stakingBankroll,
    pFair,
    backOdds,
    maxStakePct,
    score,
    marketType,
    commissionRate,
  );

  if (liveLimits) {
    const liveKelly = getLiveKellyFraction(
      liveLimits.level,
      !!(pinnacleOdds && pinnacleOdds > 0),
    );
    // 2026-05-11 BUG FIX: the prior multiplier `(liveKelly / 0.25)` assumed
    // calculateDynamicKellyStake's base fraction was always 0.25, which was
    // true when kellyFractionForScore returned a constant 0.25 across the
    // board. After kellyFractionForScore was changed to score-variable
    // (0.125 / 0.25 / 0.375 / 0.50 in paperTrading.ts:576-585) the multiplier
    // stopped converting "intended live fraction" into "scale factor on
    // applied base fraction" — it just amplified or shrank by liveKelly/0.25
    // regardless of what kellyFractionForScore actually returned. Effective
    // applied fraction was kellyFractionForScore(score) * (liveKelly / 0.25),
    // not liveKelly. Concrete impact: score=80 (base 0.50), live level=DEFAULT
    // (Kelly 0.25) → applied 0.50 * 1.0 = 0.50 of full Kelly, double the
    // intended cap. Fix: divide by the actual base fraction so the net
    // effective fraction equals liveKelly.
    const appliedBaseFraction = kellyFractionForScore(score, marketType);
    if (appliedBaseFraction > 0) {
      stake = Math.round(stake * (liveKelly / appliedBaseFraction) * 100) / 100;
    }
    logger.info(
      { matchId, marketType, liveLevel: liveLimits.level, liveKelly, appliedBaseFraction, hasPinnacle: !!(pinnacleOdds && pinnacleOdds > 0) },
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

  // Sub-phase 9: tier kelly_fraction multiplier. Per-tag value from
  // experiment_registry.kelly_fraction, applied after all conviction-based
  // sizing and before the hard cap. Catches BOTH candidate-tier (0.25) and
  // probationary-promoted (0.5 → ratchets to 1.0 after 100 real-money bets).
  // Falls back to env-flag CANDIDATE_STAKE_MULTIPLIER for candidate-tier
  // bets that don't have a registry row yet (defensive — should be rare
  // post sub-phase 5).
  let tierKellyFraction = 1.0;
  if (experimentTag) {
    tierKellyFraction = await getTierKellyFractionForTag(experimentTag);
  } else if (dataTier === "candidate") {
    // Phase 5b.2 (Task 17 wire-in, 2026-05-11): replace the fixed 0.25
    // candidate-tier multiplier with the drawdown-targeted dynamic
    // fraction from kelly_fraction_lookup. Falls back to env / 0.25
    // when no row exists yet (cron hasn't run) and logs a compliance
    // entry so we can audit the fallback frequency.
    try {
      const { getDynamicKellyFraction } = await import("./dynamicKelly");
      const dynamicF = await getDynamicKellyFraction();
      if (dynamicF != null && Number.isFinite(dynamicF) && dynamicF > 0 && dynamicF <= 1) {
        tierKellyFraction = dynamicF;
      } else {
        tierKellyFraction = parseFloat(process.env["CANDIDATE_STAKE_MULTIPLIER"] ?? "0.25");
        await db.insert(complianceLogsTable).values({
          actionType: "dynamic_kelly_fallback",
          details: { matchId, marketType, dataTier, fallback: tierKellyFraction },
          timestamp: new Date(),
        });
      }
    } catch (err) {
      logger.warn({ err, matchId }, "Dynamic Kelly fraction lookup failed — using fallback");
      tierKellyFraction = parseFloat(process.env["CANDIDATE_STAKE_MULTIPLIER"] ?? "0.25");
    }
  }
  if (tierKellyFraction < 1.0) {
    const originalStake = stake;
    stake = Math.round(stake * tierKellyFraction * 100) / 100;
    logger.info(
      { matchId, marketType, experimentTag, dataTier, originalStake, reducedStake: stake, tierKellyFraction },
      "Tier kelly_fraction multiplier applied (sub-phase 9)",
    );
  }

  // Phase 5d.2 (Task 13 wire-in, 2026-05-11): portfolio correlation
  // shrinkage. Treats this new candidate plus any already-pending bets
  // on the same fixture as a basket and shrinks each leg's fraction by
  // its correlated load. Default fixtureCap = 5% of bankroll across
  // the basket (operator-tunable via agent_config.portfolio_fixture_cap).
  // Order matters: applied AFTER the tier multiplier (so we're shrinking
  // the already-tier-discounted candidate stake) but BEFORE the
  // liveLimits hard cap (so the cap is the final upper bound).
  try {
    const portfolioBankroll = stakingBankroll;
    if (portfolioBankroll > 0 && stake > 0) {
      const pendingOnFixture = await db
        .select({
          marketType: paperBetsTable.marketType,
          selectionName: paperBetsTable.selectionName,
          stake: paperBetsTable.stake,
          shadowStake: paperBetsTable.shadowStake,
        })
        .from(paperBetsTable)
        .where(
          and(
            eq(paperBetsTable.matchId, matchId),
            sql`${paperBetsTable.status} IN ('pending','pending_placement')`,
            sql`${paperBetsTable.deletedAt} IS NULL`,
          ),
        );
      // Build basket: existing pending + this new candidate (last).
      const matchRowForLeague = await db
        .select({ league: matchesTable.league })
        .from(matchesTable)
        .where(eq(matchesTable.id, matchId))
        .limit(1);
      const leagueForCorr = matchRowForLeague[0]?.league ?? "";
      const fixtureCapStr = await getConfigValue("portfolio_fixture_cap");
      const fixtureCap = fixtureCapStr != null ? Number(fixtureCapStr) : 0.05;
      const basket = pendingOnFixture
        .map((b) => {
          const s = Number(b.stake);
          const ss = Number(b.shadowStake);
          const effectiveStake = s > 0 ? s : ss > 0 ? ss : 0;
          return effectiveStake > 0
            ? {
                marketType: b.marketType,
                selectionName: b.selectionName,
                rawFraction: effectiveStake / portfolioBankroll,
              }
            : null;
        })
        .filter((b): b is { marketType: string; selectionName: string; rawFraction: number } => b !== null);
      basket.push({
        marketType,
        selectionName,
        rawFraction: stake / portfolioBankroll,
      });
      const { applyPortfolioCorrelationShrinkage } = await import("./portfolioKelly");
      const portfolio = await applyPortfolioCorrelationShrinkage({
        league: leagueForCorr,
        bets: basket,
        fixtureCap,
      });
      // The new candidate is the last item in the basket.
      const newBetOutput = portfolio.bets[portfolio.bets.length - 1];
      if (newBetOutput && Number.isFinite(newBetOutput.shrunkFraction)) {
        const shrunkStake = Math.round(newBetOutput.shrunkFraction * portfolioBankroll * 100) / 100;
        if (shrunkStake < stake) {
          logger.info(
            {
              matchId, marketType, selectionName, leagueForCorr,
              originalStake: stake,
              shrunkStake,
              correlatedLoad: newBetOutput.correlatedLoad,
              shrinkageFactor: newBetOutput.shrinkageFactor,
              basketSize: basket.length,
              capApplied: portfolio.capApplied,
            },
            "Portfolio correlation shrinkage applied",
          );
          stake = shrunkStake;
        }
      }
    }
  } catch (err) {
    logger.warn({ err, matchId, marketType }, "Portfolio Kelly shrinkage failed — proceeding at pre-shrinkage stake");
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

  // ── Phase 2.B.2: shadow-stake branch ──────────────────────────────────
  // For Tier B/C candidates we capture "what a candidate-tier real-money
  // bet would have staked" — the experiment-phase analogue of
  // settlement_pnl, feeding the edge-survival graduation gate.
  //
  // 2026-05-11 BUG FIX: previously this used a hardcoded 0.25 (the old
  // candidate-tier multiplier). After Task 17 wired drawdown-targeted
  // dynamic Kelly into the candidate-tier flow (paperTrading.ts:1683),
  // the candidate-tier fraction is no longer fixed — it's a Monte-Carlo
  // lookup from kelly_fraction_lookup targeting a 15% 1st-percentile
  // drawdown over a 450-bet horizon. Hardcoding 0.25 here makes shadow
  // sizing diverge from the candidate-tier sizing it's meant to mirror.
  // Read the same dynamic fraction; fall back to 0.25 with a compliance
  // log if the lookup is missing.
  let shadowStake: number | null = null;
  let shadowStakeKellyFraction: number | null = null;
  if (isShadowBet) {
    const shadowFraction = await getShadowKellyFraction(matchId, marketType);
    const fullKellyStake = stake;
    shadowStakeKellyFraction = shadowFraction;
    shadowStake = Math.round(fullKellyStake * shadowFraction * 100) / 100;
    stake = 0;
    logger.info(
      { matchId, marketType, universeTier, fullKellyStake, shadowStake, shadowStakeKellyFraction },
      "Phase 2.B.2 shadow bet — actual stake = 0; shadow_stake recorded (theory-driven Kelly fraction)",
    );
  }

  // Option A canonical floor (2026-05-10): all upstream multipliers (live
  // Kelly fraction, low-odds, segment, regime, tier) have now applied. If
  // the final stake is sub-£2 but the bet has real edge and bankroll covers
  // the £2 minimum, force-floor to £2 — same policy as
  // lazyPromoteShadowToPaper.ts:226. Eliminates the lazyPromote round-trip
  // for direct-production candidates that previously got demoted by the
  // multiplier-after-floor compounding bug. Otherwise demote to shadow
  // capture (preserves learning data when bet is unviable for real money).
  //
  // Pre-fix (commit 7f30304, 2026-05-07): unconditional demote on stake<£2.
  // Combined with the post-cutover liveLimits multiplier activating on small
  // live bankroll, every direct-production live bet got demoted; lazyPromote
  // then rescued at exactly £2 — making every live bet appear as
  // qualification_path = 'lazy_promoted_to_live' since cutover.
  // Task 2 (2026-05-11): Kelly < £2 → demote to shadow unconditionally.
  // The previous "eligibleForFloor" branch floored sub-£2 Kelly stakes to
  // exactly £2 when edge >= min_edge_threshold AND bankroll >= £2. That
  // contradicted Kelly theory by over-betting every bet whose mathematical
  // optimum was below the Betfair minimum. The 163 live bets in the
  // £1.50–£2.50 floor band over 2026-05-03→2026-05-11 carried just
  // -£3.09 PnL on £327 stake — break-even on volume with zero growth
  // contribution. The signal lives in shadow now; the lazyPromote service
  // rescues bets back to live if Kelly recovers above £2 before kickoff.
  if (!isShadowBet && stake < 2) {
    const fullKellyStake = stake;
    // 2026-05-11: same theory-driven Kelly fraction as the primary shadow
    // branch — drawdown-targeted dynamic Kelly, not the legacy 0.25.
    const SHADOW_KELLY_FRACTION = await getShadowKellyFraction(matchId, marketType);
    shadowStakeKellyFraction = SHADOW_KELLY_FRACTION;
    shadowStake = Math.round(fullKellyStake * SHADOW_KELLY_FRACTION * 100) / 100;
    stake = 0;
    isShadowBet = true;
    await logShadowGateExemption(
      "kelly_below_min_stake",
      experimentTag ?? null,
      `Production-track Kelly-stake £${fullKellyStake} below £2 Betfair minimum — demoted to shadow per Task 2 (floor removed 2026-05-11)`,
      shadowStake,
    );
    logger.info(
      {
        matchId, marketType, universeTier,
        fullKellyStake, shadowStake, shadowStakeKellyFraction, edge,
      },
      "Kelly below £2 — demoted to shadow (Task 2: £2 floor removed)",
    );
  }

  if (isLiveMode()) {
    const slippageResult = checkSlippage(backOdds, backOdds);
    if (slippageResult.blocked) {
      if (isShadowBet) {
        // Slippage protects real fills against bad price moves between
        // detection and placement. Shadow bets don't fill anywhere, so
        // there's no fill price to protect.
        await logShadowGateExemption(
          "slippage_guard",
          experimentTag ?? null,
          slippageResult.reason ?? "slippage guard blocked",
          null,
          universeTier,
        );
      } else {
        return logReject(`Slippage guard: ${slippageResult.reason}`);
      }
    }
  }

  // ── Exposure-based risk gate ─────────────────────────────────────────────
  // In LIVE mode: uses progressive level limits (Level 1 starts at 25%, earns up to 40% at Level 4)
  // In PAPER mode: uses legacy 40% default from agent_config
  // Phase 2.B.2: shadow bets (stake=0) bypass — they contribute nothing to
  // exposure by construction; running the check would be a no-op anyway,
  // but we explicitly skip to avoid coupling shadow-stake telemetry to the
  // exposure metric.
  let exposureAtPlacement: { current: number; max: number; pct: number } = { current: 0, max: 0, pct: 0 };
  if (!isShadowBet) {
    const maxExposurePct = liveLimits
      ? liveLimits.config.maxOpenExposurePct
      : Number((await getConfigValue("max_unsettled_exposure_pct")) ?? "0.40");
    const currentExposure = await getTotalPendingExposure();
    const effectiveBankroll = liveLimits ? liveLimits.liveBalance : bankroll;
    const maxExposure = effectiveBankroll * maxExposurePct;
    if (currentExposure + stake > maxExposure) {
      // 2026-05-09 (no-bet-dropped): exposure cap is a capital-risk gate;
      // demote to shadow (£0 contributes nothing to exposure) when enabled.
      if (await isLiveToShadowFallthroughEnabled()) {
        const fullKellyStake = stake;
        shadowStakeKellyFraction = 0.25;
        shadowStake = Math.round(fullKellyStake * 0.25 * 100) / 100;
        stake = 0;
        isShadowBet = true;
        await logShadowGateExemption(
          "paper_exposure_limit",
          experimentTag ?? null,
          `Exposure limit hit £${(currentExposure + fullKellyStake).toFixed(0)}/£${maxExposure.toFixed(0)} — demoted to shadow`,
          shadowStake,
          universeTier,
        );
        logger.info(
          { matchId, marketType, currentExposure, maxExposure, fullKellyStake, shadowStake },
          "Exposure limit hit — production bet demoted to shadow rail",
        );
      } else {
        return logReject(
          `Exposure limit reached (£${(currentExposure + stake).toFixed(0)}/£${maxExposure.toFixed(0)} = ${(maxExposurePct * 100).toFixed(0)}% of ${liveLimits ? `live balance, Level ${liveLimits.level}` : "paper bankroll"}). Skipping bet on match ${matchId}.`,
        );
      }
    } else {
      exposureAtPlacement = { current: currentExposure, max: maxExposure, pct: Math.round((currentExposure / maxExposure) * 1000) / 10 };
    }
  }

  // ── Live concentration limits (per-league, per-market-type, per-fixture) ──
  // Phase 2.B.2: shadow bets bypass — they don't go to Betfair and have no
  // real-money concentration implications.
  // 2026-05-09 (no-bet-dropped): demote production bets that hit a live
  // concentration cap rather than dropping them.
  if (isLiveMode() && !isShadowBet) {
    const concentrationCheck = await runLiveConcentrationChecks(matchId, marketType, stake);
    if (!concentrationCheck.passed) {
      if (await isLiveToShadowFallthroughEnabled()) {
        const fullKellyStake = stake;
        shadowStakeKellyFraction = 0.25;
        shadowStake = Math.round(fullKellyStake * 0.25 * 100) / 100;
        stake = 0;
        isShadowBet = true;
        await logShadowGateExemption(
          "paper_live_concentration",
          experimentTag ?? null,
          `Live concentration limit (${concentrationCheck.reason}) — demoted to shadow`,
          shadowStake,
          universeTier,
        );
        logger.info(
          { matchId, marketType, fullKellyStake, shadowStake, reason: concentrationCheck.reason },
          "Live concentration limit hit — production bet demoted to shadow rail",
        );
      } else {
        return logReject(`Live concentration limit: ${concentrationCheck.reason}`);
      }
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

    // Task 2 follow-up (2026-05-11): skip ghost emissions where both stake
    // and shadow_stake are zero — they carry no financial signal AND no
    // £0 shadow-track signal. Happens when commission-aware Kelly returns 0
    // for sub-marginal edges (Kelly = 0 → full_kelly = 0 → shadow_stake =
    // 0 × 0.25 = 0). Without this guard, the bet lands on bet_track='live'
    // (because the bet_track decision tree checks shadowStake > 0, not
    // isShadowBet) and pollutes reporting with phantom rows. Rolls back the
    // BEGIN we just opened so the connection returns to the pool clean.
    if (stake === 0 && (shadowStake == null || shadowStake === 0)) {
      await pgClient.query("ROLLBACK");
      logger.info(
        { matchId, marketType, selectionName, edge },
        "Ghost emission skipped — both stake and shadow_stake are 0 (sub-marginal Kelly)",
      );
      return { placed: false, reason: "ghost_zero_stake" };
    }
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
        rawModelProbability:
          rawModelProbability != null ? String(rawModelProbability) : null,
        calibrationBucketId: calibrationBucketId ?? null,
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
        // Phase 3 B1 (2026-05-08): persist marketId for live-placement readiness.
        betfairMarketId: exchangeSnapshot?.marketId ?? null,
        // Prompt 5 pricing-pipeline columns
        actionablePrice: actionablePrice != null ? String(actionablePrice) : null,
        actionableSource: actionableSource ?? null,
        fairValueOdds: fairValueOdds != null ? String(fairValueOdds) : null,
        fairValueSource: fairValueSource ?? null,
        validatorBestOdds: validatorBestOdds != null ? String(validatorBestOdds) : null,
        // Phase 2.B.2 shadow-stake columns + universe-tier capture.
        // For Tier A bets: shadow_stake/fraction stay null, universe_tier_at_placement='A'.
        // For Tier B/C shadow bets: shadow_stake = full_Kelly × 0.25, stake = 0,
        //   universe_tier_at_placement='B'|'C', clv_source initially null
        //   (settlement will tag it 'pinnacle' / 'market_proxy' / 'none').
        shadowStake: shadowStake != null ? String(shadowStake) : null,
        shadowStakeKellyFraction: shadowStakeKellyFraction,
        universeTierAtPlacement: universeTier ?? null,
        clvSource: null,
        // Phase 3 B6 (2026-05-08): denormalised bet-track at placement.
        // 'paper' = real-stake paper-mode bet (stake>0, no betfair_bet_id).
        // 'shadow' = £0 stake with shadow_stake notional Kelly.
        // 'live' = real-stake bet emitted post-cutover (§3 trigger forbids
        // 'paper' inserts once cutover_completed_at is set).
        betTrack:
          shadowStake != null && shadowStake > 0
            ? "shadow"
            : (postCutover ? "live" : "paper"),
      })
      .returning();

    bet = betResult[0];

    // F1 (2026-05-07): pre-placement bankroll snapshot. Tied to bet_id so
    // settleBets can compute true LN(bankroll_after / bankroll_before)
    // per bet. Fire-and-forget; placement never waits or fails on snapshot.
    if (bet?.id) {
      void writePrePlacementSnapshot(bet.id, "pre_placement");
    }

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

  // 2026-05-10: gate live placement on !isShadowBet. Pre-fix, shadow bets
  // (stake=0) reached placeLiveBetOnBetfair, failed with "Stake £0 below
  // Betfair minimum £2", and triggered the demote-to-shadow handler that
  // pointlessly overwrote shadow_stake to 0. The placement attempt also
  // generated noisy compliance logs and Betfair API calls for bets that
  // can never fill. Shadow bets keep their compliance metadata from the
  // upstream shadow-stake branch.
  if (isLiveMode() && bet?.id && !isShadowBet) {
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

    // Post-cutover (2026-05-09): paper-eligibility = live-eligibility. The
    // scope whitelist and qualifiesForTier1 post-filter are removed; only
    // the live_placement_enabled kill switch remains. If a bet is good
    // enough to be a paper bet, it's good enough to be a live bet.
    const liveGates = await checkLivePlacementGates({
      marketType,
      league: match?.league ?? "",
      betId: bet.id,
    });

    // Fail-loud guard (Amendment 1). live_whitelist is deprecated; the
    // override field MUST be null. If a future change re-activates whitelist
    // writes, this assertion fires before any unexpected stake scaling
    // reaches Betfair.
    if (liveGates.kellyFractionOverride !== null) {
      throw new Error(
        "kelly_fraction_override unexpectedly non-null after cutover. " +
        "live_whitelist should be deprecated; investigate and remove the " +
        "write path before re-enabling live placement."
      );
    }

    const liveTier = liveGates.allowed ? "tier1" : "tier2";
    const qualificationPath: string = liveGates.allowed
      ? (boostedTier1BApproved ? "1B_boosted" : "live_eligible")
      : "paper";
    await db.update(paperBetsTable).set({ liveTier, qualificationPath }).where(eq(paperBetsTable.id, bet.id));

    if (liveGates.allowed) {
      logger.info(
        { betId: bet.id, reason: liveGates.reason },
        "Live placement: gate passed (kill switch on) — proceeding",
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
        } else if (stake < 2) {
          // 2026-05-10 defensive guard: stake fell below £2 between the
          // line-1670 floor and this block. Should not happen — line 1670
          // either force-floors to £2 (when edge meets threshold) or
          // demotes to shadow. If we see this fire, something downstream
          // of line 1670 is zeroing stake without flipping isShadowBet.
          // Skip the Betfair API call (would return "Stake £0 below
          // Betfair minimum £2" anyway), demote to shadow, log loudly so
          // forensics can find the path.
          logger.warn(
            { betId: bet.id, stake, universeTier, marketType, selectionName, edge, score },
            "LIVE: stake < £2 at placement entry — upstream gate bypass detected, demoting to shadow",
          );
          await db.update(paperBetsTable)
            .set({
              betTrack: "shadow",
              stake: "0",
              shadowStake: String(Math.round(stake * 0.25 * 100) / 100),
              shadowStakeKellyFraction: 0.25,
              status: "pending",
              betfairStatus: `SKIPPED_PRE_PLACEMENT: stake £${stake} below £2 minimum`,
              qualificationPath: "live_skipped_stake_below_min",
            })
            .where(eq(paperBetsTable.id, bet.id));
        } else if (match?.betfairEventId && /^\d+$/.test(match.betfairEventId)) {
          // 2026-05-10: regex check rejects non-numeric betfairEventId
          // (e.g., 'af_*' provisional API-Football IDs). Those events have
          // no Betfair markets at all; attempting placement burns an API
          // call to get "market unavailable" back. Matches exchange_book_sweep's
          // BETFAIR_EVENT_ID_RE filter for symmetry. Bets on such matches
          // fall through to the else branch below and demote to shadow.
          // Post-cutover (2026-05-09): live_whitelist deprecated; no override
          // scaling. The assertion at the top of the live-placement block
          // guarantees liveGates.kellyFractionOverride is null. Stake comes
          // straight from the upstream Kelly calc.
          const liveStake = stake;
          // Task 24 Part C — pick placement mode based on edge. High-edge bets
          // (>= take_best_back_min_edge, default 10%) ride the current best
          // back to guarantee a match; below the threshold, LIMIT at target
          // (legacy behaviour).
          const tbbMinEdgeRaw = await getConfigValue("take_best_back_min_edge");
          const tbbMinEdge = tbbMinEdgeRaw != null ? Number(tbbMinEdgeRaw) : 0.10;
          const tbbSlippageRaw = await getConfigValue("take_best_back_slippage_tolerance");
          const tbbSlippage = tbbSlippageRaw != null ? Number(tbbSlippageRaw) : 0.05;
          const placementMode: "TARGET" | "TAKE_BEST_BACK" =
            Number.isFinite(edge) && edge >= tbbMinEdge ? "TAKE_BEST_BACK" : "TARGET";
          const liveResult = await placeLiveBetOnBetfair({
            internalBetId: bet.id,
            betfairEventId: match.betfairEventId,
            marketType,
            selectionName,
            odds: backOdds,
            stake: liveStake,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            placementMode,
            slippageTolerance: tbbSlippage,
            // Task 24 Part D — flag-gated PERSIST for high-edge AH.
            // The resolver reads agent_config.ah_persist_enabled and the
            // ah_persist_min_edge threshold; when off, this is a no-op.
            edge,
          });

          if (!liveResult.success) {
            const errLower = (liveResult.error ?? "").toLowerCase();
            const isMarketUnavailable = !!liveResult.unavailableOnExchange;
            const isInsufficientFunds = errLower.includes("nsufficient") || errLower.includes("balance") || errLower.includes("bankroll");
            const isStakeBelowMin = errLower.includes("below betfair minimum") || errLower.includes("below £2");
            const isAccount = errLower.includes("account") || errLower.includes("no betfaireventid");

            // 2026-05-10 policy update: ANY live placement failure demotes
            // to the shadow rail (prev behavior: terminal failures demote,
            // transient stay placement_failed for liveReconciliation to retry).
            // No retry mechanism actually exists — placement_failed bets just
            // sit forever, contributing nothing. Demoting to shadow ensures
            // every value-identified bet still settles and feeds learning.
            // The fallthrough flag is retained as a kill-switch.
            const isBestBackOutOfRange = errLower.includes("best_back_below_tolerance") || errLower.includes("best_back_unavailable");
            const isSlippage = errLower.startsWith("slippage_");
            const errCategory = isMarketUnavailable ? "market_unavailable"
              : isInsufficientFunds ? "insufficient_funds"
              : isStakeBelowMin ? "stake_below_min"
              : isAccount ? "account_issue"
              : isBestBackOutOfRange ? "best_back_drift"
              : isSlippage ? "slippage_blocked"
              : "transient_or_unknown";
            if (await isLiveToShadowFallthroughEnabled()) {
              const intendedKellyStake = liveStake;
              const shadowStakeOnDemote = Math.round(intendedKellyStake * 0.25 * 100) / 100;
              await db.update(paperBetsTable)
                .set({
                  status: "pending",
                  betTrack: "shadow",
                  stake: "0",
                  potentialProfit: "0",
                  shadowStake: String(shadowStakeOnDemote),
                  shadowStakeKellyFraction: 0.25,
                  betfairStatus: `LIVE_FAILED_DEMOTED_TO_SHADOW: ${liveResult.error ?? "unknown"}`,
                  qualificationPath: `live_demoted_${errCategory}`,
                })
                .where(eq(paperBetsTable.id, bet.id));
              await logShadowGateExemption(
                "live_placement_failed",
                experimentTag ?? null,
                `Live placement failed (${errCategory}: ${liveResult.error ?? ""}) — demoted to shadow`,
                shadowStakeOnDemote,
                universeTier,
              );
              logger.info(
                { betId: bet.id, errCategory, liveError: liveResult.error, intendedKellyStake, shadowStakeOnDemote },
                "Live placement failed — demoted to shadow rail; will settle as shadow",
              );
            } else {
              logger.warn(
                { betId: bet.id, error: liveResult.error },
                "LIVE: Betfair placement failed (fallthrough disabled) — marked placement_failed",
              );
              await db.update(paperBetsTable)
                .set({ status: "placement_failed", betfairStatus: `FAILED: ${liveResult.error ?? "unknown"}` })
                .where(eq(paperBetsTable.id, bet.id));
            }

            // Suppression bookkeeping (regardless of demote): protect future
            // cycles from re-attempting a broken market. Skip the breaker
            // for global/account errors that aren't market-specific.
            if (isMarketUnavailable) {
              markMarketUnavailable(matchId, marketType);
            } else if (!isInsufficientFunds && !isAccount) {
              recordPlacementFailure(matchId, marketType);
            }
          } else {
            clearPlacementFailures(matchId, marketType);
          }
        } else {
          // 2026-05-10: falls through here when betfairEventId is missing
          // OR non-numeric (af_* provisional IDs). Betfair has no markets
          // either way — demote to shadow so the bet doesn't sit as a
          // pending 'live' row forever. Today this catches 144+ bets/day
          // from leagues like 3. Liga / Segunda División where the event
          // mapping never resolved to a real Betfair eventId.
          const reason = !match?.betfairEventId
            ? "no betfairEventId"
            : `non-numeric betfairEventId (${match.betfairEventId}) — provisional ID, Betfair has no markets`;
          logger.info(
            { betId: bet.id, matchId, reason },
            "LIVE: skipping placement — Betfair event not mapped; demoting to shadow",
          );
          await db.update(paperBetsTable)
            .set({
              betTrack: "shadow",
              stake: "0",
              shadowStake: String(Math.round(stake * 0.25 * 100) / 100),
              shadowStakeKellyFraction: 0.25,
              status: "pending",
              betfairStatus: `SKIPPED: ${reason}`,
              qualificationPath: "live_skipped_no_betfair_event",
            })
            .where(eq(paperBetsTable.id, bet.id));
        }
      } catch (err) {
        logger.error(
          { err, betId: bet.id },
          "LIVE: Unexpected error during Betfair placement — demoting to shadow if enabled",
        );
        // 2026-05-09 (no-bet-dropped): unexpected exception is treated as
        // terminal — demote to shadow if fallthrough enabled. Worst case
        // is we mis-classify a transient error and the bet settles as
        // shadow rather than placement_failed; that still feeds learning.
        if (await isLiveToShadowFallthroughEnabled()) {
          const intendedKellyStake = stake;
          const shadowStakeOnDemote = Math.round(intendedKellyStake * 0.25 * 100) / 100;
          await db.update(paperBetsTable)
            .set({
              status: "pending",
              betTrack: "shadow",
              stake: "0",
              potentialProfit: "0",
              shadowStake: String(shadowStakeOnDemote),
              shadowStakeKellyFraction: 0.25,
              betfairStatus: `LIVE_FAILED_DEMOTED_TO_SHADOW (exception): ${err instanceof Error ? err.message : String(err)}`,
              qualificationPath: "live_demoted_exception",
            })
            .where(eq(paperBetsTable.id, bet.id));
          await logShadowGateExemption(
            "live_placement_failed",
            experimentTag ?? null,
            `Live placement exception — demoted to shadow`,
            shadowStakeOnDemote,
            universeTier,
          );
        } else {
          await db.update(paperBetsTable)
            .set({ status: "placement_failed", betfairStatus: `EXCEPTION: ${err instanceof Error ? err.message : String(err)}` })
            .where(eq(paperBetsTable.id, bet.id));
        }
      }
    } else {
      // 2026-05-10: tier1Check was removed in the post-cutover refactor
      // (qualifiesForTier1 / scope-whitelist deprecated, kill switch is the
      // only live gate). The log line still referenced the removed variable
      // — caused ReferenceError on every cycle when kill switch was off,
      // crashing trading_near with "tier1Check is not defined".
      logger.info(
        { betId: bet.id, liveTier, reason: liveGates.reason },
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

        // 2026-05-10 policy update: stale pending_placement (>10 min, no Betfair
        // order found via clearedOrders) demotes to shadow instead of marking
        // placement_failed. The clearedOrders lookup above already confirmed
        // Betfair has no record of the bet, so no real-money exposure exists.
        // Demoting to shadow lets the bet still contribute settlement signal.
        const intendedKellyStake = Number(bet.stake ?? 0);
        const shadowStakeOnDemote = intendedKellyStake > 0
          ? Math.round(intendedKellyStake * 0.25 * 100) / 100
          : 0;
        await db.update(paperBetsTable)
          .set({
            status: "pending",
            betTrack: "shadow",
            stake: "0",
            potentialProfit: "0",
            shadowStake: String(shadowStakeOnDemote),
            shadowStakeKellyFraction: 0.25,
            betfairStatus: "STALE_PENDING_DEMOTED_TO_SHADOW: not found on Betfair",
            qualificationPath: "live_demoted_stale_pending",
          })
          .where(eq(paperBetsTable.id, bet.id));
        flagged++;

        await db.insert(complianceLogsTable).values({
          actionType: "stale_placement_demoted_to_shadow",
          details: {
            betId: bet.id,
            matchId: bet.matchId,
            marketType: bet.marketType,
            selectionName: bet.selectionName,
            placedAt: bet.placedAt?.toISOString(),
            ageMinutes: Math.round((Date.now() - (bet.placedAt?.getTime() ?? 0)) / 60000),
            intendedKellyStake,
            shadowStakeOnDemote,
          },
          timestamp: new Date(),
        });

        const { createAlert } = await import("./alerting");
        await createAlert({
          severity: "warning",
          category: "execution",
          code: "STALE_PENDING_PLACEMENT",
          title: "Stale pending placement demoted to shadow",
          message: `Bet #${bet.id} (${bet.marketType} on match ${bet.matchId}) was in PENDING_PLACEMENT for ${Math.round((Date.now() - (bet.placedAt?.getTime() ?? 0)) / 60000)} minutes without resolution and not found on Betfair. Demoted to shadow track.`,
          metadata: { betId: bet.id, matchId: bet.matchId, marketType: bet.marketType, shadowStakeOnDemote },
        });

        logger.warn({ betId: bet.id, shadowStakeOnDemote }, "Stale bet demoted to shadow — no Betfair match found");
      }
    } catch (err) {
      logger.error({ err, betId: bet.id }, "Error reconciling stale placement");
    }
  }

  logger.info({ reconciled, flagged, total: staleBets.length }, "Stale placement reconciliation complete");
  return { reconciled, flagged };
}

// ===================== Reconcile stale POST-KICKOFF pending bets =====================
//
// 2026-05-06: bets that sit `pending` past match completion are usually data-feed
// gaps — the matches table never received a final score, so settleBets() never
// fires. Without this escalator they stay pending indefinitely. Two thresholds:
//
//   - WARN at kickoff + 4h. Raises STALE_PENDING_POSTKICKOFF (warning, code
//     scoped per bet so each bet alerts independently). No state change. Most
//     football fixtures finish well within 3h; 4h is past extra-time + penalties.
//
//   - AUTO-VOID at kickoff + 24h. Branching by bet type:
//       paper / shadow (no betfair_bet_id): unconditional void with
//         betfair_status='VOID_DATA_TIMEOUT'. Stake was synthetic so refund is
//         a no-op for paper, and shadow bets had stake=0 anyway.
//       real-money (has betfair_bet_id): try listClearedOrders(betIds=[id])
//         across SETTLED/VOIDED/LAPSED/CANCELLED. If Betfair reports an outcome,
//         reconcile to that outcome. If Betfair has no record after 24h that's
//         unexpected for a placed bet — escalate as STALE_PENDING_BETFAIR_UNRESOLVED
//         (critical) but DO NOT auto-void; refusing to silently zero out a
//         real-money position the system can't confirm.
const STALE_PENDING_WARN_HOURS = 4;
const STALE_PENDING_VOID_HOURS = 24;

export interface StalePendingResult {
  warned: number;
  paperVoided: number;
  betfairReconciled: number;
  betfairFlagged: number;
}

export async function reconcileStalePending(): Promise<StalePendingResult> {
  const now = Date.now();
  const warnCutoff = new Date(now - STALE_PENDING_WARN_HOURS * 3_600_000);
  const voidCutoff = new Date(now - STALE_PENDING_VOID_HOURS * 3_600_000);

  const stalePending = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      betfairBetId: paperBetsTable.betfairBetId,
      stake: paperBetsTable.stake,
      placedAt: paperBetsTable.placedAt,
      kickoffTime: matchesTable.kickoffTime,
      matchStatus: matchesTable.status,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        sql`${paperBetsTable.deletedAt} IS NULL`,
        lte(matchesTable.kickoffTime, warnCutoff),
      ),
    );

  if (stalePending.length === 0) {
    return { warned: 0, paperVoided: 0, betfairReconciled: 0, betfairFlagged: 0 };
  }

  let warned = 0;
  let paperVoided = 0;
  let betfairReconciled = 0;
  let betfairFlagged = 0;

  for (const bet of stalePending) {
    if (!bet.kickoffTime) continue;
    const hoursPastKickoff = (now - bet.kickoffTime.getTime()) / 3_600_000;
    const pastVoidCutoff = bet.kickoffTime.getTime() <= voidCutoff.getTime();

    try {
      if (!pastVoidCutoff) {
        // Between WARN_HOURS and VOID_HOURS: alert only.
        const { createAlert } = await import("./alerting");
        const created = await createAlert({
          severity: "warning",
          category: "execution",
          code: `STALE_PENDING_POSTKICKOFF_${bet.id}`,
          title: "Bet pending past kickoff",
          message: `Bet #${bet.id} (${bet.marketType}:${bet.selectionName} on match ${bet.matchId}) is ${hoursPastKickoff.toFixed(1)}h past kickoff and still pending. Will auto-void at ${STALE_PENDING_VOID_HOURS}h if unresolved.`,
          metadata: {
            betId: bet.id,
            matchId: bet.matchId,
            hoursPastKickoff: Math.round(hoursPastKickoff * 10) / 10,
            matchStatus: bet.matchStatus,
            hasBetfairBetId: !!bet.betfairBetId,
          },
        });
        if (created != null) warned++;
        continue;
      }

      // Past void cutoff — branch by bet type.
      if (bet.betfairBetId) {
        let resolved = false;
        if (isLiveMode()) {
          try {
            const { listClearedOrders } = await import("./betfairLive");
            for (const status of ["SETTLED", "VOIDED", "LAPSED", "CANCELLED"] as const) {
              const cleared = await listClearedOrders(undefined, [bet.betfairBetId], status);
              const order = cleared.find((o) => o.betId === bet.betfairBetId);
              if (!order) continue;

              const outcome = String(order.betOutcome ?? "").toUpperCase();
              const profit = Number(order.profit ?? 0);
              const newStatus = outcome === "WON" ? "won" : outcome === "LOST" ? "lost" : "void";
              // 2026-05-11: Betfair's `profit` field is the post-commission
              // wallet impact. Write it to ALL P&L columns consistently so
              // gross − commission = net (the prior writer just stored
              // profit in gross+settlement and left commission/net stale,
              // breaking aggregations and the risk manager's daily-loss
              // query that reads settlement_pnl).
              const COMMISSION_RATE = 0.05;
              let recGross: number;
              let recCommission: number;
              if (newStatus === "won") {
                recGross = Math.round((profit / (1 - COMMISSION_RATE)) * 100) / 100;
                recCommission = Math.round((recGross - profit) * 100) / 100;
              } else if (newStatus === "lost") {
                recGross = profit;
                recCommission = 0;
              } else {
                recGross = 0;
                recCommission = 0;
              }
              await db.update(paperBetsTable).set({
                status: newStatus,
                settlementPnl: String(newStatus === "void" ? 0 : profit),
                grossPnl: String(recGross),
                commissionAmount: String(recCommission),
                netPnl: String(newStatus === "void" ? 0 : profit),
                betfairStatus: `RECONCILED_VIA_TIMEOUT:${status}`,
                settledAt: new Date(),
              }).where(eq(paperBetsTable.id, bet.id));
              betfairReconciled++;
              logger.info(
                { betId: bet.id, betfairBetId: bet.betfairBetId, betfairStatus: status, outcome, profit },
                "Stale Betfair bet reconciled via timeout path",
              );
              resolved = true;
              break;
            }
          } catch (bfErr) {
            logger.warn(
              { betId: bet.id, err: bfErr },
              "Could not query Betfair for stale-pending reconciliation",
            );
          }
        }

        if (!resolved) {
          // Real-money bet we can't confirm — flag, do not auto-void.
          const { createAlert } = await import("./alerting");
          await createAlert({
            severity: "critical",
            category: "execution",
            code: `STALE_PENDING_BETFAIR_UNRESOLVED_${bet.id}`,
            title: "Real-money bet pending past void cutoff — manual reconciliation needed",
            message: `Bet #${bet.id} (Betfair ${bet.betfairBetId}, ${bet.marketType}:${bet.selectionName} on match ${bet.matchId}) is ${hoursPastKickoff.toFixed(1)}h past kickoff and not in listClearedOrders. Refusing to auto-void real-money position; manual reconciliation required.`,
            metadata: {
              betId: bet.id,
              matchId: bet.matchId,
              betfairBetId: bet.betfairBetId,
              hoursPastKickoff: Math.round(hoursPastKickoff * 10) / 10,
            },
          });
          betfairFlagged++;
          logger.warn(
            { betId: bet.id, betfairBetId: bet.betfairBetId, hoursPastKickoff },
            "Real-money bet stuck post-kickoff — flagged, not auto-voided",
          );
        }
        continue;
      }

      // Paper / shadow: unconditional void.
      await db.update(paperBetsTable).set({
        status: "void",
        settlementPnl: "0",
        grossPnl: "0",
        commissionAmount: "0",
        netPnl: "0",
        betfairStatus: "VOID_DATA_TIMEOUT",
        settledAt: new Date(),
      }).where(eq(paperBetsTable.id, bet.id));
      paperVoided++;
      logger.info(
        { betId: bet.id, matchId: bet.matchId, hoursPastKickoff, matchStatus: bet.matchStatus },
        "Paper/shadow bet auto-voided — pending past 24h cutoff",
      );
    } catch (err) {
      logger.error({ err, betId: bet.id }, "Error reconciling stale-pending bet");
    }
  }

  if (paperVoided + betfairReconciled + betfairFlagged > 0) {
    await db.insert(complianceLogsTable).values({
      actionType: "stale_pending_reconciliation",
      details: { warned, paperVoided, betfairReconciled, betfairFlagged, total: stalePending.length },
      timestamp: new Date(),
    });
  }

  logger.info(
    { warned, paperVoided, betfairReconciled, betfairFlagged, total: stalePending.length },
    "Stale-pending reconciliation complete",
  );
  return { warned, paperVoided, betfairReconciled, betfairFlagged };
}

// ===================== Determine bet outcome from match result =====================

// Returns true (won), false (lost), or null (void — data unavailable, stake refunded)
// 2026-05-08 (§4.3 of root-cause-analysis): determineBetWon now dispatches
// to lib/marketTypes.ts which holds the single source of truth for every
// supported market type. The switch below is preserved as a fallback for
// any market type the registry hasn't yet adopted, but new market types
// MUST be added to the registry rather than this switch.
//
// Long-term: this switch can be deleted entirely once we verify every
// historical market_type appears in MARKET_TYPES. The startup invariant
// in services/startupChecks.ts will refuse to boot if a paper_bets row
// references a market type that's not in the registry.
import { resolveOutcome as resolveViaRegistry, isMarketTypeRegistered } from "../lib/marketTypes";

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
): boolean | "void" | null {
  // Return semantics:
  //   true   — bet won
  //   false  — bet lost
  //   "void" — definitive push (e.g. AH whole-line where adjusted == opposing).
  //            Settle immediately as void, refund stake, no PnL impact.
  //   null   — cannot resolve from data given. Routes through 72h retry; if
  //            still null after 72h, force-settled as loss (bet got dropped
  //            by the data feed).
  // Registry path — preferred for any market type it knows about.
  if (isMarketTypeRegistered(marketType)) {
    return resolveViaRegistry(marketType, selectionName, {
      homeScore,
      awayScore,
      totalCorners: matchStats?.totalCorners ?? null,
      totalCards: matchStats?.totalCards ?? null,
      homeScoreHt: matchStats?.homeScoreHt ?? null,
      awayScoreHt: matchStats?.awayScoreHt ?? null,
    });
  }

  // Legacy switch — only reached if the registry is missing a type.
  // Logs a warning so the gap is visible.
  // eslint-disable-next-line no-console
  console.warn(`[determineBetWon] market type "${marketType}" not in registry — falling through to legacy switch`);

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
      // 2026-05-09: leg-by-leg WIN/PUSH/LOSS evaluation. See
      // marketTypes.ts:resolveAsianHandicap for the canonical implementation
      // and rationale. This legacy switch is kept only as a fallback for
      // unregistered market types — registry path is preferred.
      const parts = selectionName.split(" ");
      const side = parts[0]; // "Home" or "Away"
      const handicap = parseFloat(parts[1] ?? "0");

      const evalLeg = (h: number): "win" | "push" | "loss" => {
        const adjustedSide = (side === "Home" ? homeScore : awayScore) + h;
        const opposing = side === "Home" ? awayScore : homeScore;
        if (adjustedSide > opposing) return "win";
        if (adjustedSide < opposing) return "loss";
        return "push";
      };

      if (Math.abs(handicap % 1) === 0.25) {
        const lowerLeg = evalLeg(handicap - 0.25);
        const upperLeg = evalLeg(handicap + 0.25);
        if (lowerLeg === "win" && upperLeg === "win") return true;
        if (lowerLeg === "loss" && upperLeg === "loss") return false;
        if (lowerLeg === "push") return upperLeg === "win";
        if (upperLeg === "push") return lowerLeg === "win";
        return "void";
      }

      const outcome = evalLeg(handicap);
      if (outcome === "win") return true;
      if (outcome === "loss") return false;
      // Whole-line push — definitive void. Pre-fix returned null which got
      // force-settled as loss after 72h. (Same fix as marketTypes.ts:201.)
      return "void";
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

    // ─── Team-total markets (added 2026-05-08) ────────────────────────────
    // Resolve from final scores. Naming convention:
    //   TEAM_TOTAL_HOME_05 → home goals threshold 0.5
    //   TEAM_TOTAL_HOME_15 → 1.5,  TEAM_TOTAL_HOME_25 → 2.5
    //   TEAM_TOTAL_AWAY_05 → away goals threshold 0.5
    //   TEAM_TOTAL_AWAY_15 → 1.5
    // Selection format: "Over 0.5" / "Under 0.5".
    //
    // Critical: without these cases, determineBetWon returned null on
    // 285+ pending team-total bets. Settlement retried for 13+ hours
    // before the 72h timeout would have voided/lost them. Now resolved
    // immediately on first settlement attempt post-finish.
    case "TEAM_TOTAL_HOME_05":
    case "TEAM_TOTAL_HOME_15":
    case "TEAM_TOTAL_HOME_25":
    case "TEAM_TOTAL_HOME_35":
    case "TEAM_TOTAL_AWAY_05":
    case "TEAM_TOTAL_AWAY_15":
    case "TEAM_TOTAL_AWAY_25":
    case "TEAM_TOTAL_AWAY_35": {
      const isHome = marketType.startsWith("TEAM_TOTAL_HOME_");
      const teamScore = isHome ? homeScore : awayScore;
      const suffix = marketType.split("_").pop()!;
      const threshold = parseInt(suffix, 10) / 10;
      if (selectionName.startsWith("Over")) return teamScore > threshold;
      if (selectionName.startsWith("Under")) return teamScore < threshold;
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
    .where(and(
      eq(paperBetsTable.status, "pending"),
      sql`deleted_at IS NULL`,
      eq(paperBetsTable.legacyRegime, false),
    ));

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
    //
    // 2026-05-06: post-kickoff guard. The data feed occasionally flips a
    // kicked-off match to a cancelled-style status mid-game (or in error).
    // If kickoff has already passed, refuse to void here — let
    // reconcileStalePending() handle it after the 24h grace, which gives
    // Betfair / data feeds time to settle authoritatively. Genuine in-play
    // abandonment will still be caught, just on the timeout path.
    if (ABANDONMENT_STATUSES.has(match.status) && !bet.betfairBetId) {
      const kickoffPassed = match.kickoffTime && match.kickoffTime.getTime() <= Date.now();
      if (kickoffPassed) {
        logger.warn(
          { betId: bet.id, matchId: match.id, fixtureStatus: match.status, kickoffTime: match.kickoffTime },
          "Skipping abandonment-void — kickoff already passed; deferring to stale-pending escalator",
        );
        continue;
      }

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
    //     2026-05-10: outcome === "void" is a definitive push (e.g. AH whole-line
    //     adjusted == opposing). Settle immediately as void; do NOT enter the
    //     null/retry branch — pre-fix bug routed pushes through the 72h timeout
    //     and force-settled them as losses.
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

    // "void" = definitive push (refund stake, no PnL impact).
    // null    = forced loss after 72h timeout fell through above, OR a real-
    //           money unmatched-bet guard hit at line ~2914 (also voids).
    const isVoid = outcome === "void" || outcome === null;
    const betWon = outcome === true;

    const { calculateSettlementWithCommission, getCommissionRate, getBetfairExchangeId } = await import("./commissionService");
    const commissionRate = await getCommissionRate("betfair");
    const exchangeId = await getBetfairExchangeId();

    const commResult = isVoid
      ? { grossPnl: 0, commissionRate: 0, commissionAmount: 0, netPnl: 0 }
      : calculateSettlementWithCommission(stake, odds, betWon, commissionRate);

    const settlementPnl = commResult.netPnl;

    // ── Phase 2.B.2: shadow_pnl computation ────────────────────────────────
    // For shadow bets (Tier B/C with stake=0), compute the P&L as if the
    // bet had been placed at shadow_stake. This is the experiment-phase
    // analogue of settlementPnl and feeds the edge-survival graduation
    // gate (experiment-phase shadow ROI vs candidate-phase real ROI).
    // Real bets (stake > 0) leave shadow_pnl = null.
    let shadowPnl: number | null = null;
    const recordedShadowStake = bet.shadowStake != null ? Number(bet.shadowStake) : 0;
    if (recordedShadowStake > 0) {
      const shadowComm = isVoid
        ? { netPnl: 0 }
        : calculateSettlementWithCommission(recordedShadowStake, odds, betWon, commissionRate);
      shadowPnl = shadowComm.netPnl;
    }

    const newStatus = isVoid ? "void" : betWon ? "won" : "lost";
    const now = new Date();

    // ── CLV: Pinnacle-source-only at settlement (R6 hotfix, 2026-05-04) ──
    // Two separate snapshot lookups:
    //   (1) closing_odds_proxy — latest snapshot of ANY source. Diagnostic
    //       column; preserves the historical "did any closing data exist?"
    //       semantics. Not used by the promotion-engine threshold gate.
    //   (2) clv_pct — latest snapshot of Pinnacle sources ONLY. The promotion
    //       engine's minClv ≥ 1.5 gate is Pinnacle-shaped; market-proxy values
    //       must not flow into this column at settlement. If no Pinnacle
    //       snapshot exists, leave clv_pct alone via conditional spread on
    //       the UPDATE (do not null-clobber a prior Writer-A pre-kickoff
    //       Pinnacle write).
    let closingOddsProxy: number | null = null;
    let clvPct: number | null = null;
    try {
      const latestAnySource = await db
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
      if (latestAnySource[0]?.backOdds) {
        closingOddsProxy = Number(latestAnySource[0].backOdds);
      }

      // R6.1 (2026-05-05): prefer paper_bets.closing_pinnacle_odds when non-null.
      // The column is frozen pre-kickoff by Writer A (fetchAndStoreClosingLineForPendingBets,
      // oddsPapi.ts:2596-2731). The fallback odds_snapshots Pinnacle filter takes
      // the LATEST Pinnacle snapshot, which can be POST-kickoff in-play for
      // matches already started — using it as "closing line" produces strongly-
      // negative CLV on bets that subsequently won (in-play prices compress
      // toward 1.0). closing_pinnacle_odds is unambiguous strict-pre-kickoff.
      // See docs/r6-1-in-play-clv-fix-plan.md.
      let pinnacleClose: number | null = null;
      let pinnacleSource: "closing_column" | "snapshot" | null = null;
      if (bet.closingPinnacleOdds != null) {
        const fromColumn = Number(bet.closingPinnacleOdds);
        if (fromColumn > 1) {
          pinnacleClose = fromColumn;
          pinnacleSource = "closing_column";
        }
      }
      if (pinnacleClose == null) {
        const latestPinnacle = await db
          .select({ backOdds: oddsSnapshotsTable.backOdds })
          .from(oddsSnapshotsTable)
          .where(
            and(
              eq(oddsSnapshotsTable.matchId, bet.matchId),
              eq(oddsSnapshotsTable.marketType, bet.marketType),
              eq(oddsSnapshotsTable.selectionName, bet.selectionName),
              inArray(oddsSnapshotsTable.source, ["oddspapi_pinnacle", "api_football_real:Pinnacle"]),
            ),
          )
          .orderBy(desc(oddsSnapshotsTable.snapshotTime))
          .limit(1);
        if (latestPinnacle[0]?.backOdds) {
          const fromSnapshot = Number(latestPinnacle[0].backOdds);
          if (fromSnapshot > 1) {
            pinnacleClose = fromSnapshot;
            pinnacleSource = "snapshot";
          }
        }
      }
      if (pinnacleClose != null) {
        clvPct = ((odds - pinnacleClose) / pinnacleClose) * 100;
        clvPct = Math.round(clvPct * 1000) / 1000;
        logger.info(
          { betId: bet.id, placementOdds: odds, pinnacleClose, pinnacleSource, clvPct },
          "CLV calculated from Pinnacle source",
        );
      }
    } catch (_err) {
      // CLV is best-effort; don't block settlement
    }

    // Phase 3 B5 (2026-05-08): tag clv_source for ALL settled bets, not just
    // shadow. The previous logic only tagged shadow rows, leaving paper bets
    // untagged (16.7% of Tier-A paper bets had clv_source='pinnacle' even
    // when closing_pinnacle_odds was captured 60% of the time). Path P
    // evaluation requires the tag — without it, evaluation_pool is starved.
    // clvPct is non-null iff a Pinnacle snapshot was found in the lookup
    // above, so it is the authoritative "did Pinnacle anchor exist?" signal.
    const clvSourceTag: "pinnacle" | "none" =
      clvPct != null ? "pinnacle" : "none";

    await db
      .update(paperBetsTable)
      .set({
        status: newStatus,
        settlementPnl: String(settlementPnl),
        settledAt: now,
        closingOddsProxy: closingOddsProxy != null ? String(closingOddsProxy) : null,
        ...(clvPct != null ? { clvPct: String(clvPct) } : {}),
        ...(shadowPnl != null ? { shadowPnl: String(shadowPnl) } : {}),
        clvSource: clvSourceTag,
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

    // ─── Sub-phase 5: event-driven graduation evaluator hook ──────────────
    // Per docs/phase-2-wave-3-subphase-5-plan.md §3.1.
    // Non-blocking: void + .catch. Settlement never fails on evaluator error.
    // Soft-revert via agent_config.event_driven_graduation_enabled='false'.
    // The 04:00 UTC cron continues to run as a reconciler regardless.
    if (bet.experimentTag) {
      const flagRaw = (await getConfigValue("event_driven_graduation_enabled")) ?? "true";
      const flagEnabled = flagRaw.toLowerCase() === "true";
      if (flagEnabled) {
        void evaluateExperimentTag(bet.experimentTag, {
          triggeredBy: "settlement",
          triggerBetId: bet.id,
        }).catch((err) => {
          logger.warn(
            { err, betId: bet.id, tag: bet.experimentTag },
            "Sub-phase 5 event-driven evaluator failed — 04:00 cron reconciler will catch it",
          );
        });
        // Distribution-shift A(archetype) — fire-and-forget, internally cached 5min.
        void computeArchetypeDistributionShift().catch((err) => {
          logger.warn({ err }, "Sub-phase 5 distribution-shift compute failed — non-fatal");
        });
      }
    }

    // ─── Z3 event-driven (2026-05-07): per-settlement scoped threshold
    // revision. Per Chris's directive — weekly is too slow; review on
    // every settlement. In-memory 5-min dedupe per scope keeps Neon
    // load trivial. Fire-and-forget; settlement never waits or fails.
    if (bet.matchId && bet.marketType) {
      void (async () => {
        try {
          const matchRow = await db
            .select({ league: matchesTable.league })
            .from(matchesTable)
            .where(eq(matchesTable.id, bet.matchId))
            .limit(1);
          const league = matchRow[0]?.league ?? null;
          if (!league) return;
          const { triggerScopedThresholdRevision } = await import("./autonomousThresholdRevision");
          await triggerScopedThresholdRevision(league, bet.marketType);
        } catch (err) {
          logger.debug({ err, betId: bet.id }, "Event-driven threshold revision failed — non-fatal");
        }
      })();
    }
  }

  if (settled > 0) {
    await applyBatchPnl(totalPnl, "settlement", {
      betsSettled: settled,
      won,
      lost,
    });

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
    .where(and(
      eq(paperBetsTable.status, "void"),
      eq(paperBetsTable.legacyRegime, false),
    ));

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

    // null = can't resolve, skip. "void" = definitive push, leave the bet
    // voided (re-settling as won/lost would be wrong). Only resolved
    // boolean outcomes (true/false) trigger re-settlement here.
    if (outcome === null || outcome === "void") continue;

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
    await applyBatchPnl(pnlDelta, "backfill_corners_cards_resettle", {
      betsResettled,
    });
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
  // 1. Fetch all pending bets with their match info and scores. Phase 3 A3
  // (2026-05-08): include bet_track so Step C cap below can be bet-track-
  // aware (paper=4, shadow=12). Pre-fix this function hardcoded 4 across
  // both rails, retroactively voiding shadow bets that emission had
  // legitimately allowed at the higher 12-cap. Observed 1,855 bets voided
  // in a single 21:12 cycle on 2026-05-08 — most were shadow rail.
  const rows = await db
    .select({
      id: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      stake: paperBetsTable.stake,
      opportunityScore: paperBetsTable.opportunityScore,
      betTrack: paperBetsTable.betTrack,
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

    // ── Step C: Per-match cap, bet-track-aware (Phase 3 A3, 2026-05-08; shadow
    // cap raised 12→24 on 2026-05-09 per Bundle 1 / plan v3 §Item 7).
    // Paper rail: cap=4 (capital-discipline). Shadow rail: cap=24 (£0
    // learning data, no capital risk; matches the emission-time check above).
    // The two caps MUST stay in sync — emission allowing 24 while dedup
    // voids back to 12 would re-create the original problem we were fixing.
    const remainingBets = activeBetsForMatch(matchId);
    for (const track of ["paper", "shadow"] as const) {
      const cap = track === "shadow" ? 24 : 4;
      const trackBets = remainingBets.filter((b) => (b.betTrack ?? "paper") === track);
      if (trackBets.length > cap) {
        const sorted = [...trackBets].sort((a, b) => (b.opportunityScore ?? 0) - (a.opportunityScore ?? 0));
        const excess = sorted.slice(cap);
        logger.info(
          { matchId, track, cap, removedCount: excess.length },
          `deduplicatePendingBets [max-per-track cap]: removing ${excess.length} excess ${track} bets (cap=${cap})`,
        );
        for (const e of excess) {
          toVoid.add(e.id);
          removedByReason.max_per_match++;
        }
      }
    }
  }

  // 3. Void all marked bets in one batch.
  // 2026-05-11 BUG FIX: prior writer set only status + settlementPnl, leaving
  // gross_pnl/commission_amount/net_pnl with whatever they were pre-void
  // (NULL on pending bets — harmless; but inconsistent shape risks future
  // aggregation bugs). Zero all P&L columns for void.
  if (toVoid.size > 0) {
    const idsToVoid = [...toVoid];
    await db
      .update(paperBetsTable)
      .set({
        status: "void",
        settlementPnl: "0",
        grossPnl: "0",
        commissionAmount: "0",
        netPnl: "0",
        settledAt: new Date(),
      })
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
        eq(paperBetsTable.legacyRegime, false),
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

    // 2026-05-11 BUG FIX: zero ALL P&L columns on void, not just settlement_pnl.
    await db
      .update(paperBetsTable)
      .set({
        status: "void",
        settlementPnl: "0",
        grossPnl: "0",
        commissionAmount: "0",
        netPnl: "0",
        settledAt: new Date(),
      })
      .where(eq(paperBetsTable.id, bet.id));
  }

  // Refund total stake to bankroll (writes via applyBatchPnl, then a separate
  // void_banned_market_bets audit entry that references the before/after values).
  const { before: bankrollBefore, after: bankrollAfter } = await applyBatchPnl(
    totalStakeRefunded,
    "void_banned_market_bets_refund",
    { voided: pendingBanned.length, byMarket, bannedMarkets: BANNED_MARKETS },
  );

  await db.insert(complianceLogsTable).values({
    actionType: "void_banned_market_bets",
    details: {
      voided: pendingBanned.length,
      totalStakeRefunded: totalStakeRefunded.toFixed(2),
      byMarket,
      bannedMarkets: BANNED_MARKETS,
      bankrollBefore,
      bankrollAfter,
    },
    timestamp: new Date(),
  });

  logger.info(
    { voided: pendingBanned.length, totalStakeRefunded: totalStakeRefunded.toFixed(2), byMarket },
    "voidBetsOnBannedMarkets: complete — stake refunded to bankroll",
  );

  return { voided: pendingBanned.length, totalStakeRefunded, byMarket };
}
