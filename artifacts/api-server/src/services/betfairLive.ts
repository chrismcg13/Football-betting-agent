import axios, { type AxiosInstance } from "axios";
import { logger } from "../lib/logger";
import { db, agentConfigTable } from "@workspace/db";
import { paperBetsTable, complianceLogsTable, oddsSnapshotsTable } from "@workspace/db";
import { eq, and, isNotNull, isNull, sql, desc, inArray } from "drizzle-orm";
import { BETFAIR_TICKS } from "./orderManager";
import { relayGetLiquidity } from "./vpsRelay";
import { teamNameMatch } from "./apiFootball";

/**
 * Task 24 Part D — persistence-type resolver. Reads two config keys
 * with a 60s cache so cron-rate placements don't hammer the DB:
 *   ah_persist_enabled      ('true' | 'false', default 'false')
 *   ah_persist_min_edge     (number,         default 0.15)
 *
 * Returns 'PERSIST' only for ASIAN_HANDICAP bets with edge above the
 * threshold when the flag is on. Everything else gets 'LAPSE'.
 */
const PERSIST_CFG_TTL_MS = 60 * 1000;
let cachedPersistCfg: { enabled: boolean; minEdge: number; fetchedAt: number } | null = null;

async function loadPersistCfg(): Promise<{ enabled: boolean; minEdge: number }> {
  const now = Date.now();
  if (cachedPersistCfg && now - cachedPersistCfg.fetchedAt < PERSIST_CFG_TTL_MS) {
    return { enabled: cachedPersistCfg.enabled, minEdge: cachedPersistCfg.minEdge };
  }
  const rows = await db
    .select({ key: agentConfigTable.key, value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(inArray(agentConfigTable.key, ["ah_persist_enabled", "ah_persist_min_edge"]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const enabled = byKey.get("ah_persist_enabled") === "true";
  const minEdgeRaw = byKey.get("ah_persist_min_edge");
  const minEdgeNum = minEdgeRaw != null ? Number(minEdgeRaw) : 0.15;
  const minEdge = Number.isFinite(minEdgeNum) && minEdgeNum > 0 ? minEdgeNum : 0.15;
  cachedPersistCfg = { enabled, minEdge, fetchedAt: now };
  return { enabled, minEdge };
}

async function resolvePersistenceType(args: {
  marketType: string;
  edge?: number;
}): Promise<BetfairPersistenceType> {
  if (args.marketType !== "ASIAN_HANDICAP") return "LAPSE";
  if (args.edge == null || !Number.isFinite(args.edge)) return "LAPSE";
  const { enabled, minEdge } = await loadPersistCfg();
  if (!enabled) return "LAPSE";
  if (args.edge < minEdge) return "LAPSE";
  return "PERSIST";
}

export type PlacementMode = "TARGET" | "TAKE_BEST_BACK";

function roundDownToTick(price: number): number {
  let best = BETFAIR_TICKS[0];
  for (const tick of BETFAIR_TICKS) {
    if (tick <= price + 0.0001) {
      best = tick;
    } else {
      break;
    }
  }
  return best;
}

const PROXY_BASE =
  process.env["BETFAIR_PROXY_URL"] ?? "https://api.betfair.com";
const IDENTITY_PROXY_BASE =
  process.env["BETFAIR_IDENTITY_PROXY_URL"] ??
  "https://identitysso.betfair.com";
const IDENTITY_URL = `${IDENTITY_PROXY_BASE}/api/login`;
const BETTING_BASE = `${PROXY_BASE}/exchange/betting/rest/v1.0`;
const ACCOUNT_BASE = `${PROXY_BASE}/exchange/account/rest/v1.0`;

const MAX_RPS = 5;
const REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_RPS);

const SESSION_REFRESH_MS = 12 * 60 * 60 * 1000;
const BALANCE_REFRESH_MS = 15 * 60 * 1000;
const BALANCE_STALE_MS = 60 * 60 * 1000;

interface LiveSession {
  token: string | null;
  obtainedAt: number;
  expiresAt: number;
}

interface CachedBalance {
  available: number;
  exposure: number;
  total: number;
  fetchedAt: number;
}

const liveSession: LiveSession = {
  token: null,
  obtainedAt: 0,
  expiresAt: 0,
};

let cachedBalance: CachedBalance | null = null;
let lastRequestAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function isLiveMode(): boolean {
  return process.env["TRADING_MODE"] === "LIVE";
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

async function authenticate(): Promise<string> {
  const appKey = process.env["LIVE_BETFAIR_KEY"];
  const username = process.env["BETFAIR_USERNAME"];
  const password = process.env["BETFAIR_PASSWORD"];

  if (!appKey || !username || !password) {
    throw new Error(
      "CRITICAL: LIVE_BETFAIR_KEY, BETFAIR_USERNAME, and BETFAIR_PASSWORD must all be set for live trading",
    );
  }

  logger.info("Authenticating with Betfair (LIVE)...");

  const params = new URLSearchParams();
  params.set("username", username);
  params.set("password", password);

  try {
    const response = await axios.post(IDENTITY_URL, params.toString(), {
      headers: {
        "X-Application": appKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 15000,
    });

    const data = response.data as {
      status: string;
      token?: string;
      error?: string;
    };

    if (data.status !== "SUCCESS" || !data.token) {
      const errMsg = `Betfair LIVE login failed: ${data.error ?? data.status}`;
      logger.error({ error: data.error, status: data.status }, errMsg);
      throw new Error(errMsg);
    }

    liveSession.token = data.token;
    liveSession.obtainedAt = Date.now();
    liveSession.expiresAt = Date.now() + 20 * 60 * 60 * 1000;

    logger.info(
      { obtainedAt: new Date().toISOString() },
      "Betfair LIVE authentication successful",
    );

    return data.token;
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      logger.error(
        { status: err.response?.status, data: err.response?.data },
        "CRITICAL: Betfair LIVE authentication HTTP error",
      );
    }
    throw err;
  }
}

async function getSessionToken(): Promise<string> {
  const needsRefresh =
    !liveSession.token ||
    Date.now() >= liveSession.expiresAt ||
    Date.now() - liveSession.obtainedAt >= SESSION_REFRESH_MS;

  if (needsRefresh) {
    return authenticate();
  }
  return liveSession.token!;
}

function startSessionRefreshTimer(): void {
  if (refreshTimer) return;

  refreshTimer = setInterval(
    async () => {
      try {
        logger.info("Proactive Betfair LIVE session refresh...");
        await authenticate();
      } catch (err) {
        logger.error(
          { err },
          "CRITICAL: Proactive session refresh failed — will retry on next API call",
        );
      }
    },
    SESSION_REFRESH_MS,
  );
}

function createClient(
  baseURL: string,
  appKey: string,
  token: string,
): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      "X-Application": appKey,
      "X-Authentication": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 30000,
  });
}

type NonRetryableError =
  | "INSUFFICIENT_FUNDS"
  | "MARKET_NOT_OPEN_FOR_BETTING"
  | "MARKET_SUSPENDED"
  | "MARKET_CLOSED"
  | "PERMISSION_DENIED"
  | "DUPLICATE_TRANSACTION"
  | "INVALID_ACCOUNT_STATE"
  | "ACCOUNT_FUNDS_ERROR";

const NON_RETRYABLE_ERRORS: Set<string> = new Set([
  "INSUFFICIENT_FUNDS",
  "MARKET_NOT_OPEN_FOR_BETTING",
  "MARKET_SUSPENDED",
  "MARKET_CLOSED",
  "PERMISSION_DENIED",
  "DUPLICATE_TRANSACTION",
  "INVALID_ACCOUNT_STATE",
  "ACCOUNT_FUNDS_ERROR",
]);

async function apiRequest<T>(
  base: "betting" | "account",
  endpoint: string,
  payload: Record<string, unknown>,
  retries = 3,
): Promise<T> {
  const appKey = process.env["LIVE_BETFAIR_KEY"]!;
  const baseURL = base === "betting" ? BETTING_BASE : ACCOUNT_BASE;

  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttle();
    let token = await getSessionToken();
    let client = createClient(baseURL, appKey, token);

    try {
      const response = await client.post<T>(endpoint, payload);
      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const errorCode = (err.response?.data as any)?.detail?.APINGException
          ?.errorCode;

        if (
          status === 401 ||
          status === 403 ||
          errorCode === "INVALID_SESSION_INFORMATION"
        ) {
          logger.warn(
            { attempt, endpoint },
            "Betfair LIVE session invalid — re-authenticating",
          );
          liveSession.token = null;
          token = await authenticate();
          client = createClient(baseURL, appKey, token);
          await throttle();
          try {
            const response = await client.post<T>(endpoint, payload);
            return response.data;
          } catch (retryErr) {
            if (attempt === retries) throw retryErr;
            continue;
          }
        }

        if (errorCode && NON_RETRYABLE_ERRORS.has(errorCode)) {
          logger.error(
            { errorCode, endpoint, attempt },
            `Betfair non-retryable error: ${errorCode}`,
          );
          throw err;
        }
      }

      if (attempt < retries) {
        const backoff = Math.pow(2, attempt) * 1000;
        logger.warn(
          { attempt, endpoint, backoffMs: backoff },
          "Betfair API call failed — retrying with backoff",
        );
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        throw err;
      }
    }
  }

  throw new Error("Unreachable: exhausted retries");
}

export interface AccountFunds {
  availableToBetBalance: number;
  exposure: number;
  retainedCommission: number;
  exposureLimit: number;
  discountRate: number;
  pointsBalance: number;
  wallet: string;
}

export async function getAccountFunds(): Promise<AccountFunds> {
  const funds = await apiRequest<AccountFunds>(
    "account",
    "/getAccountFunds/",
    { wallet: "UK" },
    3,
  );

  cachedBalance = {
    available: funds.availableToBetBalance,
    exposure: Math.abs(funds.exposure),
    total: funds.availableToBetBalance + Math.abs(funds.exposure),
    fetchedAt: Date.now(),
  };

  logger.info(
    {
      available: funds.availableToBetBalance,
      exposure: funds.exposure,
      total: cachedBalance.total,
    },
    "Betfair LIVE balance fetched",
  );

  return funds;
}

export function getCachedBalance(): CachedBalance | null {
  return cachedBalance;
}

// ── Market suppression cache ─────────────────────────────────────────────────
// Suppresses (matchId, marketType) pairs that have proven un-placeable so the
// scheduler can drop their candidates before placement, freeing per-cycle
// slots for the next-best candidates.
//
// Two suppression triggers:
//   - HARD: market unavailable on Betfair (catalogue lookup returned no
//     results) → suppressed for 4h.
//   - CIRCUIT BREAKER: 3+ consecutive cycle-level placement failures of any
//     kind on the same (match, market) → suppressed for 4h.
//
// Successful placement clears the failure counter for that pair.

type SuppressionEntry = {
  reason: "market_unavailable" | "circuit_breaker";
  failureCount: number;
  lastFailureAt: number;
  expiresAt: number;
};

// Hard suppression (confirmed market unavailable on Betfair): 4h TTL.
// Circuit-breaker suppression (consecutive failures of mixed cause): 30min TTL,
// since these can include transient API issues that may resolve quickly.
const MARKET_UNAVAILABLE_TTL_MS = 4 * 60 * 60 * 1000;
const CIRCUIT_BREAKER_TTL_MS = 30 * 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const marketSuppression = new Map<string, SuppressionEntry>();

function suppressionKey(matchId: number, marketType: string): string {
  return `${matchId}::${marketType}`;
}

export function isMarketSuppressed(
  matchId: number,
  marketType: string,
): { suppressed: boolean; reason?: string; expiresAt?: number } {
  const key = suppressionKey(matchId, marketType);
  const entry = marketSuppression.get(key);
  if (!entry) return { suppressed: false };
  if (Date.now() >= entry.expiresAt) {
    marketSuppression.delete(key);
    return { suppressed: false };
  }
  if (entry.failureCount >= CIRCUIT_BREAKER_THRESHOLD || entry.reason === "market_unavailable") {
    return { suppressed: true, reason: entry.reason, expiresAt: entry.expiresAt };
  }
  return { suppressed: false };
}

export function markMarketUnavailable(matchId: number, marketType: string): void {
  const key = suppressionKey(matchId, marketType);
  marketSuppression.set(key, {
    reason: "market_unavailable",
    failureCount: CIRCUIT_BREAKER_THRESHOLD,
    lastFailureAt: Date.now(),
    expiresAt: Date.now() + MARKET_UNAVAILABLE_TTL_MS,
  });
  logger.info(
    { matchId, marketType, ttlMs: MARKET_UNAVAILABLE_TTL_MS },
    "Market suppressed (unavailable on Betfair)",
  );
}

export function recordPlacementFailure(matchId: number, marketType: string): void {
  const key = suppressionKey(matchId, marketType);
  const existing = marketSuppression.get(key);
  const now = Date.now();
  const newCount = (existing?.failureCount ?? 0) + 1;
  const reason: "market_unavailable" | "circuit_breaker" =
    existing?.reason === "market_unavailable" ? "market_unavailable" : "circuit_breaker";
  // Keep the longer TTL if this slot is already a hard "market_unavailable" suppression.
  const ttl = reason === "market_unavailable" ? MARKET_UNAVAILABLE_TTL_MS : CIRCUIT_BREAKER_TTL_MS;
  marketSuppression.set(key, {
    reason,
    failureCount: newCount,
    lastFailureAt: now,
    expiresAt: now + ttl,
  });
  if (newCount >= CIRCUIT_BREAKER_THRESHOLD) {
    logger.warn(
      { matchId, marketType, failureCount: newCount, ttlMs: ttl },
      "Circuit breaker tripped — market suppressed after consecutive failures",
    );
  }
}

export function clearPlacementFailures(matchId: number, marketType: string): void {
  marketSuppression.delete(suppressionKey(matchId, marketType));
}

export function getSuppressionStats(): { total: number; unavailable: number; circuitBreaker: number } {
  let unavailable = 0;
  let circuitBreaker = 0;
  const now = Date.now();
  for (const [key, entry] of marketSuppression) {
    if (now >= entry.expiresAt) {
      marketSuppression.delete(key);
      continue;
    }
    if (entry.reason === "market_unavailable") unavailable++;
    else if (entry.failureCount >= CIRCUIT_BREAKER_THRESHOLD) circuitBreaker++;
  }
  return { total: marketSuppression.size, unavailable, circuitBreaker };
}

// Refresh balance if cached value is older than the given window. Used as a
// pre-flight check before each live placement to prevent INSUFFICIENT_FUNDS
// cascades during placement bursts.
const BALANCE_PREFLIGHT_MAX_AGE_MS = 30_000;
export async function refreshBalanceIfStale(maxAgeMs: number = BALANCE_PREFLIGHT_MAX_AGE_MS): Promise<void> {
  if (cachedBalance && Date.now() - cachedBalance.fetchedAt <= maxAgeMs) return;
  try {
    await getAccountFunds();
  } catch (err) {
    logger.warn({ err }, "refreshBalanceIfStale: balance refresh failed — using existing cached value");
  }
}

export function isBalanceStale(): boolean {
  if (!cachedBalance) return true;
  return Date.now() - cachedBalance.fetchedAt > BALANCE_STALE_MS;
}

export function isBalanceFresh(): boolean {
  if (!cachedBalance) return false;
  return Date.now() - cachedBalance.fetchedAt <= BALANCE_REFRESH_MS;
}

export async function getLiveBankroll(): Promise<number> {
  // Active bankroll = Betfair available − locked_reserve (pre-flip blocker #7).
  const { getLockedReserve } = await import("./lockedReserve");
  const locked = await getLockedReserve();

  if (cachedBalance && !isBalanceStale() && isBalanceFresh()) {
    return Math.max(0, cachedBalance.available - locked);
  }

  try {
    const funds = await getAccountFunds();
    return Math.max(0, funds.availableToBetBalance - locked);
  } catch (err) {
    if (cachedBalance && !isBalanceStale()) {
      logger.warn(
        { lastFetchedAt: new Date(cachedBalance.fetchedAt).toISOString() },
        "Balance fetch failed — using cached value",
      );
      return Math.max(0, cachedBalance.available - locked);
    }
    logger.error(
      "CRITICAL: Balance fetch failed and cached balance is stale (>1hr) — halting bet placement",
    );
    throw new Error("Balance unavailable and stale — cannot place bets");
  }
}

export type BetfairPersistenceType = "LAPSE" | "PERSIST" | "MARKET_ON_CLOSE";

export interface PlaceInstruction {
  orderType: "LIMIT";
  selectionId: number;
  handicap?: number;
  side: "BACK" | "LAY";
  limitOrder: {
    size: number;
    price: number;
    persistenceType: BetfairPersistenceType;
  };
}

export interface PlaceOrderResult {
  status: "SUCCESS" | "FAILURE";
  marketId: string;
  instructionReports?: Array<{
    status: "SUCCESS" | "FAILURE";
    errorCode?: string;
    instruction: PlaceInstruction;
    betId?: string;
    placedDate?: string;
    averagePriceMatched?: number;
    sizeMatched?: number;
    orderStatus?: "EXECUTABLE" | "EXECUTION_COMPLETE";
  }>;
  errorCode?: string;
}

export interface CurrentOrder {
  betId: string;
  marketId: string;
  selectionId: number;
  handicap: number;
  priceSize: { price: number; size: number };
  bspLiability: number;
  side: "BACK" | "LAY";
  status: "EXECUTION_COMPLETE" | "EXECUTABLE";
  persistenceType: string;
  orderType: string;
  placedDate: string;
  matchedDate?: string;
  averagePriceMatched?: number;
  sizeMatched?: number;
  sizeRemaining?: number;
  sizeLapsed?: number;
  sizeCancelled?: number;
  sizeVoided?: number;
  customerOrderRef?: string;
  customerStrategyRef?: string;
}

interface CurrentOrdersResponse {
  currentOrders: CurrentOrder[];
  moreAvailable: boolean;
}

/**
 * Fetch current (unsettled) orders from Betfair. When `betIds` is provided,
 * only those specific orders are returned — useful for ground-truth checks
 * before reconciliation or cancellation.
 *
 * Read-only. Safe to call without confirmation.
 */
export async function listCurrentOrders(
  betIds?: string[],
): Promise<CurrentOrder[]> {
  if (!isLiveMode()) return [];
  const all: CurrentOrder[] = [];
  let moreAvailable = true;
  let fromRecord = 0;
  while (moreAvailable) {
    const params: Record<string, unknown> = {
      orderProjection: "ALL",
      fromRecord,
      recordCount: 1000,
    };
    if (betIds && betIds.length > 0) {
      params["betIds"] = betIds;
    }
    const result = await apiRequest<CurrentOrdersResponse>(
      "betting",
      "/listCurrentOrders/",
      params,
      2,
    );
    all.push(...(result.currentOrders ?? []));
    moreAvailable = Boolean(result.moreAvailable);
    fromRecord += result.currentOrders?.length ?? 0;
    if ((result.currentOrders?.length ?? 0) === 0) break;
  }
  return all;
}

export async function cancelOrders(
  marketId: string,
  instructions: { betId: string; sizeReduction?: number }[],
): Promise<unknown> {
  logger.warn({ marketId, instructions }, "LIVE: Cancelling order(s) on Betfair");
  const result = await apiRequest<unknown>(
    "betting",
    "/cancelOrders/",
    { marketId, instructions },
    2,
  );
  logger.warn({ marketId, result }, "LIVE: Betfair cancelOrders response");
  return result;
}

export async function placeOrders(
  marketId: string,
  instructions: PlaceInstruction[],
  customerRef?: string,
): Promise<PlaceOrderResult> {
  logger.info(
    {
      marketId,
      instructions: instructions.map((i) => ({
        selectionId: i.selectionId,
        side: i.side,
        size: i.limitOrder.size,
        price: i.limitOrder.price,
      })),
      customerRef,
    },
    "LIVE: Placing order on Betfair",
  );

  const result = await apiRequest<PlaceOrderResult>(
    "betting",
    "/placeOrders/",
    {
      marketId,
      instructions,
      customerRef,
    },
    3,
  );

  logger.info(
    {
      marketId,
      status: result.status,
      errorCode: result.errorCode,
      reports: result.instructionReports?.map((r) => ({
        status: r.status,
        betId: r.betId,
        sizeMatched: r.sizeMatched,
        avgPrice: r.averagePriceMatched,
        orderStatus: r.orderStatus,
        errorCode: r.errorCode,
      })),
    },
    "LIVE: Betfair placeOrders response",
  );

  return result;
}

export interface ClearedOrder {
  eventId: string;
  eventTypeId: string;
  marketId: string;
  selectionId: number;
  handicap: number;
  betId: string;
  placedDate: string;
  settledDate: string;
  betOutcome: "WON" | "LOST" | "NOT_SETTLED";
  priceMatched: number;
  priceRequested: number;
  sizeSettled: number;
  sizeCancelled: number;
  profit: number;
  commission: number;
  orderType: string;
  side: string;
  persistenceType: string;
  betCount: number;
}

export interface ClearedOrdersResponse {
  clearedOrders: ClearedOrder[];
  moreAvailable: boolean;
}

export async function listClearedOrders(
  settledDateRange?: { from: string; to: string },
  betIds?: string[],
  betStatus: "SETTLED" | "VOIDED" | "LAPSED" | "CANCELLED" = "SETTLED",
): Promise<ClearedOrder[]> {
  const filter: Record<string, unknown> = {
    betStatus,
  };

  if (settledDateRange) {
    filter.settledDateRange = settledDateRange;
  }

  if (betIds && betIds.length > 0) {
    filter.betIds = betIds;
  }

  const allOrders: ClearedOrder[] = [];
  let moreAvailable = true;
  let fromRecord = 0;

  while (moreAvailable) {
    const result = await apiRequest<ClearedOrdersResponse>(
      "betting",
      "/listClearedOrders/",
      {
        ...filter,
        fromRecord,
        recordCount: 1000,
      },
      3,
    );

    allOrders.push(...result.clearedOrders);
    moreAvailable = result.moreAvailable;
    fromRecord += result.clearedOrders.length;
  }

  return allOrders;
}

// ── Account statement (per-line balance ledger from Betfair) ──────────────
// Returns every credit/debit on the wallet — stake debits, winnings credits,
// commission deductions, deposits/withdrawals — for a date range. Each bet
// generates multiple entries (debit at placement, credit at settlement).
// Used by liveReconciliation to detect orphans (Betfair has, we don't),
// missing entries (we have settled, Betfair has no record), and per-bet P&L
// mismatches against our local net_pnl ledger.
export interface AccountStatementItem {
  refId: string;
  itemDate: string;
  amount: number;
  balance: number;
  itemClass: string;
  itemClassData?: { unknownStatementItem?: string } | null;
  legacyData?: {
    avgPrice?: number;
    betSize?: number;
    betType?: string;
    betCategoryType?: string;
    commissionRate?: string;
    eventId?: number;
    eventTypeId?: number;
    fullMarketName?: string;
    grossBetAmount?: number;
    marketName?: string;
    marketType?: string;
    placedDate?: string;
    selectionId?: number;
    selectionName?: string;
    startDate?: string;
    transactionType?: string;
    transactionId?: number;
    winLose?: string;
    betId?: string;
  } | null;
}

interface AccountStatementResponse {
  accountStatement: AccountStatementItem[];
  moreAvailable: boolean;
}

export async function listAccountStatement(
  itemDateRange?: { from: string; to: string },
  includeItem: "ALL" | "EXCHANGE" | "POKER_ROOM" | "DEPOSITS_WITHDRAWALS" = "EXCHANGE",
): Promise<AccountStatementItem[]> {
  const filter: Record<string, unknown> = {
    locale: "en",
    includeItem,
    wallet: "UK",
  };
  if (itemDateRange) filter.itemDateRange = itemDateRange;

  const all: AccountStatementItem[] = [];
  let moreAvailable = true;
  let fromRecord = 0;

  while (moreAvailable) {
    const result = await apiRequest<AccountStatementResponse>(
      "account",
      "/getAccountStatement/",
      { ...filter, fromRecord, recordCount: 100 },
      3,
    );
    all.push(...result.accountStatement);
    moreAvailable = result.moreAvailable;
    fromRecord += result.accountStatement.length;
    if (result.accountStatement.length === 0) break;
  }

  return all;
}

export async function reconcileSettlements(): Promise<{
  matched: number;
  discrepancies: number;
  unmatched: number;
  voided: number;
}> {
  if (!isLiveMode()) return { matched: 0, discrepancies: 0, unmatched: 0, voided: 0 };

  const now = new Date();
  const lookback = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  const betsWithBetfairId = await db
    .select({
      id: paperBetsTable.id,
      betfairBetId: paperBetsTable.betfairBetId,
      settlementPnl: paperBetsTable.settlementPnl,
      status: paperBetsTable.status,
      stake: paperBetsTable.stake,
      // R6.1 (2026-05-05): added so the CLV block below can compute clv_pct
      // correctly. The prior R6 patch referenced these fields without adding
      // them to the projection — the queries silently filtered on undefined
      // and never returned rows. No production impact (this writer is
      // isLiveMode()-gated and live mode is currently off), but a latent
      // bug for the live-mode flip.
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      oddsAtPlacement: paperBetsTable.oddsAtPlacement,
      closingPinnacleOdds: paperBetsTable.closingPinnacleOdds,
    })
    .from(paperBetsTable)
    .where(
      and(
        isNotNull(paperBetsTable.betfairBetId),
        isNull(paperBetsTable.betfairSettledAt),
      ),
    );

  if (betsWithBetfairId.length === 0) {
    return { matched: 0, discrepancies: 0, unmatched: 0, voided: 0 };
  }

  const betfairIds = betsWithBetfairId
    .map((b) => b.betfairBetId)
    .filter(Boolean) as string[];

  // Query all 4 cleared-order statuses. SETTLED takes precedence if a bet
  // appears in both SETTLED and one of {LAPSED, CANCELLED, VOIDED} (e.g. a
  // partially-matched bet whose unmatched remainder lapsed at suspension —
  // the SETTLED record carries the real PnL). For bets that only appear in
  // LAPSED/CANCELLED/VOIDED, treat as a £0-PnL void: no bankroll impact
  // (settlement-only model — pending bets were never debited).
  const dateRange = { from: lookback.toISOString(), to: now.toISOString() };
  const orderByBetId = new Map<
    string,
    { betfairStatus: "SETTLED" | "VOIDED" | "LAPSED" | "CANCELLED"; order: ClearedOrder }
  >();
  const statusPriority: Record<string, number> = {
    SETTLED: 0,
    VOIDED: 1,
    CANCELLED: 2,
    LAPSED: 3,
  };
  // 2026-05-12: Betfair caps listClearedOrders.betIds at 250 items per call.
  // Pre-fix we passed the full pending-bet list in one request — any time we
  // had >250 pending bets the API returned 400 Bad Request, the catch below
  // returned {0,0,0,0}, and NO bets were reconciled. Result: matched bets
  // sat on `status='pending'` indefinitely even though Betfair had settled
  // them. Chunk the betIds and fetch each chunk independently; merge results.
  const BETFAIR_CLEARED_ORDERS_BETIDS_CAP = 200; // conservative; docs say 250
  const chunk = <T,>(arr: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };
  const idChunks = chunk(betfairIds, BETFAIR_CLEARED_ORDERS_BETIDS_CAP);
  try {
    for (const status of ["SETTLED", "VOIDED", "LAPSED", "CANCELLED"] as const) {
      for (const idChunk of idChunks) {
        const cleared = await listClearedOrders(dateRange, idChunk, status);
        for (const order of cleared) {
          const existing = orderByBetId.get(order.betId);
          if (!existing || statusPriority[status] < statusPriority[existing.betfairStatus]) {
            orderByBetId.set(order.betId, { betfairStatus: status, order });
          }
        }
      }
    }
    logger.info(
      {
        totalBets: betfairIds.length,
        chunks: idChunks.length,
        chunkSize: BETFAIR_CLEARED_ORDERS_BETIDS_CAP,
        ordersResolved: orderByBetId.size,
      },
      "reconcileSettlements: chunked listClearedOrders complete",
    );
  } catch (err) {
    logger.error(
      { err, totalBets: betfairIds.length, chunks: idChunks.length },
      "Failed to fetch cleared orders for reconciliation",
    );
    return { matched: 0, discrepancies: 0, unmatched: 0, voided: 0 };
  }

  let matched = 0;
  let discrepancies = 0;
  let unmatched = 0;
  let voided = 0;

  for (const bet of betsWithBetfairId) {
    const hit = orderByBetId.get(bet.betfairBetId!);
    if (!hit) {
      unmatched++;
      continue;
    }

    const { betfairStatus, order: cleared } = hit;

    if (betfairStatus !== "SETTLED") {
      // CANCELLED / LAPSED / VOIDED — never matched (or matched portion is in
      // the SETTLED record above). Real-money impact is £0 — no position taken.
      // Betfair is the authoritative source: ALWAYS overwrite internal fields
      // to reflect this, even if settleBets() previously stamped a (wrong)
      // won/lost/void status from match-score logic. The pre-fix behavior of
      // "only update if status=pending" left ~150 dashboard rows showing
      // phantom wins/losses on bets that never actually executed on Betfair.
      const newStatus = betfairStatus === "VOIDED" ? "void" : "cancelled";
      const internalStatusChanged = bet.status !== newStatus && bet.status !== "pending";
      await db
        .update(paperBetsTable)
        .set({
          betfairSettledAt: cleared.settledDate ? new Date(cleared.settledDate) : new Date(),
          betfairPnl: "0.00",
          betfairStatus: newStatus,
          status: newStatus,
          settlementPnl: "0.00",
          netPnl: "0.00",
          grossPnl: "0.00",
          commissionAmount: "0.00",
          settledAt: new Date(),
        })
        .where(eq(paperBetsTable.id, bet.id));

      voided++;
      if (internalStatusChanged) {
        logger.warn(
          {
            betId: bet.id,
            betfairBetId: bet.betfairBetId,
            previousStatus: bet.status,
            newStatus,
            betfairStatus,
            sizeCancelled: cleared.sizeCancelled,
          },
          "reconcileSettlements: CORRECTING previously mis-settled bet — Betfair reports non-matched",
        );
      } else {
        logger.info(
          { betId: bet.id, betfairBetId: bet.betfairBetId, betfairStatus, sizeCancelled: cleared.sizeCancelled },
          "reconcileSettlements: voided bet from Betfair non-SETTLED cleared status",
        );
      }
      continue;
    }

    // SETTLED — existing real-money reconciliation path.
    // Defensive numeric coercion — Betfair occasionally returns undefined for
    // profit/commission on settled-but-zero-matched orders (cancelled-pre-match
    // edge case). Without this, `undefined - undefined = NaN` was being written
    // into betfair_pnl as the literal numeric NaN, breaking pnlDiff comparison
    // (Math.abs(NaN - x) = NaN, which silently fails the `> 0.02` check).
    //
    // 2026-05-10: Betfair's listClearedOrders returns commission=0 at the
    // per-bet level — commission is settled per-MARKET in their API and
    // is not attributed back to individual bet rows when fetched by betId.
    // When profit > 0 but the API reports commission = 0, fall back to the
    // standard 5% rate locally so net_pnl reflects the actual cost of
    // trading. The authoritative per-market commission still flows in via
    // reconcileLiveAccountStatement (drift detector); a future fix could
    // backfill from the account ledger but the 5% fallback is correct for
    // standard accounts (no discount tier reached, no premium charge).
    const STANDARD_BETFAIR_COMMISSION_RATE = 0.05;
    const profit = Number(cleared.profit ?? 0);
    const reportedCommission = Number(cleared.commission ?? 0);
    const haveReportedCommission = Number.isFinite(reportedCommission) && reportedCommission > 0;
    const effectiveCommission = haveReportedCommission
      ? reportedCommission
      : (Number.isFinite(profit) && profit > 0
        ? Math.round(profit * STANDARD_BETFAIR_COMMISSION_RATE * 100) / 100
        : 0);
    const betfairPnl = Number.isFinite(profit) ? profit - effectiveCommission : 0;
    if (!Number.isFinite(profit) || !Number.isFinite(reportedCommission)) {
      logger.warn(
        { betId: bet.id, betfairBetId: bet.betfairBetId, rawProfit: cleared.profit, rawCommission: cleared.commission },
        "reconcileSettlements: non-finite profit/commission from Betfair — treating as 0",
      );
    }
    const internalPnl = Number(bet.settlementPnl ?? 0);
    const pnlDiff = Math.abs(betfairPnl - internalPnl);

    // ── CLV: Pinnacle-source-only at reconciliation (R6 hotfix, 2026-05-04) ──
    // Mirror of the post-R6 paperTrading.settleBets logic:
    //   (1) closing_odds_proxy — latest snapshot of ANY source. Diagnostic only.
    //   (2) clv_pct — latest snapshot of Pinnacle sources ONLY. Promotion-
    //       engine threshold (1.5%) is Pinnacle-shaped; do not write market-
    //       proxy values into this column. If no Pinnacle snapshot exists,
    //       leave clv_pct alone via conditional spread (already in place
    //       below). Pre-R6, this writer was non-destructive but source-
    //       agnostic, which still contaminated clv_pct for Tier B/C bets.
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
      // See docs/r6-1-in-play-clv-fix-plan.md §0 for rationale. Mirror of the
      // logic in paperTrading._settleBetsInner.
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
        const placementOdds = Number(bet.oddsAtPlacement ?? 0);
        if (placementOdds > 1) {
          clvPct = ((placementOdds - pinnacleClose) / pinnacleClose) * 100;
          clvPct = Math.round(clvPct * 1000) / 1000;
          logger.info(
            { betId: bet.id, placementOdds, pinnacleClose, pinnacleSource, clvPct },
            "CLV calculated from Pinnacle source (live-mode reconciliation)",
          );
        }
      }
    } catch {
      // best-effort; never block settlement on CLV failure
    }

    // Determine internal status flip semantics. Cleared.betOutcome is the
    // authoritative result. We rewrite the full P&L breakdown so dashboard
    // and reports stay consistent.
    const internalStatus = cleared.betOutcome === "WON" ? "won"
      : cleared.betOutcome === "LOST" ? "lost"
      : "void";
    const grossPnl = Number.isFinite(profit) ? profit : 0;
    const commissionAmount = effectiveCommission;
    const commissionRate = grossPnl > 0
      ? Math.round((commissionAmount / grossPnl) * 10000) / 10000
      : 0;
    const wasPending = bet.status === "pending";

    // Betfair is the authoritative source of truth for SETTLED bets. ALWAYS
    // sync internal fields to the cleared-order values, regardless of whether
    // the bet was previously settled by paperTrading.settleBets() (e.g. with
    // wrong status from match-score logic, or marked 'void' due to missing
    // HT data on FIRST_HALF_RESULT). The pre-fix policy of "only update if
    // pending" left the dashboard with phantom wins/losses worth ~£700/30d.
    const previousStatusForLog = bet.status;
    const internalStatusChanged = previousStatusForLog !== internalStatus && previousStatusForLog !== "pending";
    await db
      .update(paperBetsTable)
      .set({
        betfairSettledAt: new Date(cleared.settledDate),
        betfairPnl: String(betfairPnl.toFixed(2)),
        betfairStatus: cleared.betOutcome === "WON" ? "won" : cleared.betOutcome === "LOST" ? "lost" : "void",
        status: internalStatus,
        settlementPnl: String(betfairPnl.toFixed(2)),
        grossPnl: String(grossPnl.toFixed(2)),
        commissionAmount: String(commissionAmount.toFixed(2)),
        commissionRate: String(commissionRate),
        netPnl: String(betfairPnl.toFixed(2)),
        settledAt: new Date(),
        ...(closingOddsProxy != null ? { closingOddsProxy: String(closingOddsProxy) } : {}),
        ...(clvPct != null ? { clvPct: String(clvPct) } : {}),
      })
      .where(eq(paperBetsTable.id, bet.id));

    if (internalStatusChanged) {
      logger.warn(
        {
          betId: bet.id,
          betfairBetId: bet.betfairBetId,
          previousStatus: previousStatusForLog,
          newStatus: internalStatus,
          previousPnl: internalPnl,
          newPnl: betfairPnl,
        },
        "reconcileSettlements: CORRECTING previously mis-settled bet — Betfair is authoritative",
      );
    }

    if (pnlDiff > 0.02) {
      discrepancies++;
      logger.error(
        {
          betId: bet.id,
          betfairBetId: bet.betfairBetId,
          internalPnl,
          betfairPnl,
          diff: pnlDiff,
          betfairOutcome: cleared.betOutcome,
          internalStatus: bet.status,
        },
        "SETTLEMENT DISCREPANCY: Betfair vs internal P&L mismatch",
      );

      await db.insert(complianceLogsTable).values({
        actionType: "settlement_discrepancy",
        details: {
          betId: bet.id,
          betfairBetId: bet.betfairBetId,
          internalPnl,
          betfairPnl,
          diff: pnlDiff,
          betfairOutcome: cleared.betOutcome,
          internalStatus: bet.status,
        },
        timestamp: new Date(),
      });
    } else {
      matched++;
    }
  }

  logger.info(
    { matched, discrepancies, unmatched, voided },
    "Betfair settlement reconciliation complete",
  );

  return { matched, discrepancies, unmatched, voided };
}

export async function runStartupHealthCheck(): Promise<{
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}> {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const tradingMode = process.env["TRADING_MODE"];

  checks.push({
    name: "TRADING_MODE set",
    passed: !!tradingMode,
    detail: tradingMode ? `TRADING_MODE=${tradingMode}` : "NOT SET",
  });

  if (tradingMode === "LIVE") {
    const liveKey = !!process.env["LIVE_BETFAIR_KEY"];
    const username = !!process.env["BETFAIR_USERNAME"];
    const password = !!process.env["BETFAIR_PASSWORD"];
    checks.push({
      name: "Betfair credentials present",
      passed: liveKey && username && password,
      detail: `LIVE_KEY=${liveKey}, USERNAME=${username}, PASSWORD=${password}`,
    });

    try {
      const funds = await getAccountFunds();
      checks.push({
        name: "Betfair API connection",
        passed: true,
        detail: `Balance: £${funds.availableToBetBalance.toFixed(2)}, Exposure: £${Math.abs(funds.exposure).toFixed(2)}`,
      });
    } catch (err) {
      checks.push({
        name: "Betfair API connection",
        passed: false,
        detail: `FAILED: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const { verifyDbHostForEnvironment, verifyTradingModeForEnvironment } = await import("../lib/startupChecks");
    // ALLOW_DEV_ON_PROD is intentionally NOT threaded through here. This
    // health check only runs when TRADING_MODE=LIVE, and LIVE-mode pre-flight
    // must always engage all rails — the override is meaningless (and unsafe)
    // once real money is on the line.
    const dbCheck = verifyDbHostForEnvironment(
      process.env["ENVIRONMENT"] ?? "development",
      process.env["DATABASE_URL"] ?? "",
    );
    checks.push({
      name: "Database is production (not dev)",
      passed: !dbCheck.fatal,
      detail: dbCheck.message,
    });

    const tmCheck = verifyTradingModeForEnvironment(
      process.env["ENVIRONMENT"] ?? "development",
      process.env["TRADING_MODE"],
    );
    checks.push({
      name: "Trading mode matches environment",
      passed: !tmCheck.fatal,
      detail: tmCheck.message,
    });

    startSessionRefreshTimer();
  }

  const allPassed = checks.every((c) => c.passed);

  for (const check of checks) {
    const level = check.passed ? "info" : "error";
    logger[level](
      { check: check.name, result: check.passed ? "PASS" : "FAIL", detail: check.detail },
      `Startup health check: ${check.name} — ${check.passed ? "PASS" : "FAIL"}`,
    );
  }

  if (!allPassed && tradingMode === "LIVE") {
    logger.error(
      "CRITICAL: One or more startup health checks FAILED — trading engine will NOT start",
    );
  }

  return { passed: allPassed, checks };
}

export const MARKET_TYPE_MAP: Record<string, string> = {
  MATCH_ODDS: "MATCH_ODDS",
  BTTS: "BOTH_TEAMS_TO_SCORE",
  OVER_UNDER_15: "OVER_UNDER_15",
  OVER_UNDER_25: "OVER_UNDER_25",
  OVER_UNDER_35: "OVER_UNDER_35",
  OVER_UNDER_45: "OVER_UNDER_45",
  ASIAN_HANDICAP: "ASIAN_HANDICAP",
  CORRECT_SCORE: "CORRECT_SCORE",
  FIRST_HALF_OU_05: "FIRST_HALF_GOALS_05",
  FIRST_HALF_OU_15: "FIRST_HALF_GOALS_15",
  // 2026-05-16 subtract bundle: DOUBLE_CHANCE, TOTAL_CARDS_*,
  // FIRST_HALF_RESULT removed. See feedback_subtract_before_restore.
  // Sub-phase 4.B (2026-05-08): VERIFIED by discovery cron observing
  // listMarketCatalogue across 50 upcoming Tier A/B/C events. All codes
  // below confirmed present in real Betfair Exchange responses.
  OVER_UNDER_05: "OVER_UNDER_05",
  OVER_UNDER_55: "OVER_UNDER_55",
  OVER_UNDER_65: "OVER_UNDER_65",
  OVER_UNDER_75: "OVER_UNDER_75",
  OVER_UNDER_85: "OVER_UNDER_85",
  FIRST_HALF_OU_25: "FIRST_HALF_GOALS_25",
  DRAW_NO_BET: "DRAW_NO_BET",
  HALF_TIME_SCORE: "HALF_TIME_SCORE",
  // 2026-05-16 subtract bundle: HALF_TIME_FULL_TIME, GOALS_ODD_EVEN,
  // WIN_TO_NIL_HOME, WIN_TO_NIL_AWAY removed.
  // Team total goals — Betfair encodes the line as suffix N (= goals N+).
  // TEAM_A_1 = "Home to score 1 or more" = OVER 0.5 line.
  // TEAM_A_2 = "Home to score 2 or more" = OVER 1.5 line.
  // TEAM_A_3 = "Home to score 3 or more" = OVER 2.5 line.
  TEAM_TOTAL_HOME_05: "TEAM_A_1",
  TEAM_TOTAL_HOME_15: "TEAM_A_2",
  TEAM_TOTAL_HOME_25: "TEAM_A_3",
  TEAM_TOTAL_AWAY_05: "TEAM_B_1",
  TEAM_TOTAL_AWAY_15: "TEAM_B_2",
  TEAM_TOTAL_AWAY_25: "TEAM_B_3",
  // Combined markets — observed but not yet supported by our model
  // (would need joint MO+OU / MO+BTTS predictions). Mapped here so the
  // discovery cron stops flagging them as unmapped; valueDetection
  // skips because getModelProbability returns null for these.
  MATCH_ODDS_AND_OU_25: "MATCH_ODDS_AND_OU_25",
  MATCH_ODDS_AND_BTTS: "MATCH_ODDS_AND_BTTS",
  // ALT_TOTAL_GOALS = single market with multiple OU lines as runners.
  // Captured for completeness; settlement model uses standard OU.
  ALT_TOTAL_GOALS: "ALT_TOTAL_GOALS",
  // 2026-05-09 (Bundle 2): ASIAN_TOTAL_GOALS internal name -> ALT_TOTAL_GOALS
  // Betfair code. Pinnacle prices ATG at quarter lines; Betfair Exchange's
  // ALT_TOTAL_GOALS market carries the corresponding runners. The runner-
  // matching for line-aware capture is deferred — verified via [verify]
  // catalogue inspection. Settlement and prediction work without exchange
  // capture (paper_mode shadow bets settle from final score directly).
  ASIAN_TOTAL_GOALS: "ALT_TOTAL_GOALS",
  // Bundle F2.B.C (2026-05-19): Betfair codes for F2.A.10 predictor outputs.
  // CORRECT_SCORE already mapped above; add the half/clean-sheet group so
  // capture + reconcile can join Betfair settlement rows to internal bets.
  HTFT: "HALF_TIME_FULL_TIME",
  HALF_TIME_FULL_TIME: "HALF_TIME_FULL_TIME",
  CLEAN_SHEET_HOME: "CLEAN_SHEET_TEAM_A",
  CLEAN_SHEET_AWAY: "CLEAN_SHEET_TEAM_B",
  // Bundle F2.B.F (2026-05-19): half-specific 1X2. Betfair exposes
  // either HALF_TIME (older code) or HALF_TIME_MATCH_ODDS / SECOND_HALF
  // _MATCH_ODDS as live market types. exchangeBookSweep already requests
  // both in its catalogue filter; this map is the reverse direction
  // (internal → Betfair) for live placement once a market graduates.
  FIRST_HALF_RESULT: "HALF_TIME_MATCH_ODDS",
  SECOND_HALF_RESULT: "SECOND_HALF_MATCH_ODDS",
};

// Sub-phase 4.B (2026-05-08): set of internal market types whose Betfair code
// has been VERIFIED by observation in production catalogue responses. Used by
// valueDetection's shadow-only fallthrough to gate shadow capture on
// markets that have a real graduation path (vs writing dead-end shadow rows
// for markets we can't ever place on Betfair Exchange).
//
// Initial set: the long-standing core that the existing exchange book sweep
// captures. The discovery cron extends this set as new market codes are
// observed in real Betfair catalogue responses (writes to compliance_logs +
// proposes additions via model_decision_audit_log).
// 2026-05-16 subtract bundle: removed DOUBLE_CHANCE, FIRST_HALF_RESULT,
// TOTAL_CARDS_25, TOTAL_CARDS_35 (no liquidity probes, zero non-paper bets).
export const VERIFIED_BETFAIR_PLACEABLE = new Set<string>([
  "MATCH_ODDS",
  "BTTS",
  "OVER_UNDER_15",
  "OVER_UNDER_25",
  "OVER_UNDER_35",
  "OVER_UNDER_45",
  "ASIAN_HANDICAP",
  "FIRST_HALF_OU_15",
  // Bundle F2.B.D (2026-05-19): TOTAL_CORNERS restored. Betfair
  // exchangeBookSweep already requests TOTAL_CORNERS / OVER_UNDER_CORNERS
  // catalogue per F2.A.9.2 — Pinnacle direct quotes verified in
  // odds_snapshots last 7d (76-622 matches/line). Settlement resolvers
  // live in marketTypes.ts (pre-existing from earlier corner experiment).
  "TOTAL_CORNERS_75",
  "TOTAL_CORNERS_85",
  "TOTAL_CORNERS_95",
  "TOTAL_CORNERS_105",
  "TOTAL_CORNERS_115",
  // Bundle F2.B.E (2026-05-19): TOTAL_CARDS restored. Pinnacle direct
  // quotes verified in odds_snapshots last 7d (48-110 matches/line).
  // Betfair Exchange represents cards as TOTAL_BOOKING_POINTS (yellow=10,
  // red=25) — settlement bridge follow-up. Until then, TOTAL_CARDS bets
  // accumulate as shadow learning data; graduation pathway is via the
  // forthcoming TOTAL_BOOKING_POINTS predictor + MARKET_TYPE_MAP entry.
  "TOTAL_CARDS_25",
  "TOTAL_CARDS_35",
  "TOTAL_CARDS_45",
  "TOTAL_CARDS_55",
  // Bundle F2.B.F (2026-05-19): half-specific 1X2. Betfair has both
  // as native markets (catalogue filter requests them per F2.A.9.2).
  // Settlement uses HT scores only (FIRST_HALF_RESULT) and FT-HT
  // scores (SECOND_HALF_RESULT) — both available in matches table.
  "FIRST_HALF_RESULT",
  "SECOND_HALF_RESULT",
]);

// 2026-05-16 subtract bundle: TOTAL_CORNERS_* entirely subtracted; this
// set is now empty but retained for future re-use if another market_type
// needs the same NON_EXCHANGE_MARKETS guard.
const NON_EXCHANGE_MARKETS = new Set<string>([]);

export interface MarketCatalogueItem {
  marketId: string;
  marketName: string;
  marketStartTime?: string;
  event: { id: string; name: string };
  runners?: Array<{
    selectionId: number;
    runnerName: string;
    sortPriority: number;
    // Sub-phase 4.A (2026-05-08): for ASIAN_HANDICAP markets, Betfair
    // returns the handicap line on each runner. Required for
    // exchangeBookSweep.deriveSelectionName to format the internal
    // selection name as "Home -1.5" / "Away +0.5" etc.
    handicap?: number;
  }>;
  description?: { marketType: string };
}

export async function listMarketsByEventId(
  eventId: string,
): Promise<MarketCatalogueItem[]> {
  try {
    return await apiRequest<MarketCatalogueItem[]>(
      "betting",
      "/listMarketCatalogue/",
      {
        filter: { eventIds: [eventId] },
        marketProjection: ["RUNNER_DESCRIPTION", "MARKET_DESCRIPTION", "MARKET_START_TIME", "EVENT"],
        maxResults: 200,
      },
      3,
    );
  } catch (err) {
    logger.error({ err, eventId }, "Failed to list markets by eventId");
    return [];
  }
}

export async function listAllMarketsForEvent(
  homeTeam: string,
  awayTeam: string,
): Promise<MarketCatalogueItem[]> {
  const shortHome = homeTeam.replace(/\b(FC|SC|CF|AC|AS|US|SS|SSC|1907|Calcio)\b/gi, "").trim().split(/\s+/).slice(0, 2).join(" ");
  try {
    const markets = await apiRequest<MarketCatalogueItem[]>(
      "betting",
      "/listMarketCatalogue/",
      {
        filter: {
          eventTypeIds: ["1"],
          textQuery: shortHome,
          marketStartTime: {
            from: new Date().toISOString(),
            to: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
        marketProjection: ["RUNNER_DESCRIPTION", "MARKET_DESCRIPTION", "MARKET_START_TIME", "EVENT"],
        maxResults: 100,
      },
      3,
    );
    if (awayTeam === "__SKIP_FILTER__") return markets;
    const awayFirst = awayTeam.toLowerCase().split(/\s+/)[0];
    return markets.filter(m => {
      const name = (m.event?.name ?? "").toLowerCase();
      return name.includes(awayFirst);
    });
  } catch (err) {
    logger.error({ err, homeTeam, awayTeam }, "Failed to list all markets for event");
    return [];
  }
}

export async function findEventIdByTeamNames(
  homeTeam: string,
  awayTeam: string,
): Promise<string | null> {
  const shortHome = homeTeam
    .replace(/\b(FC|SC|CF|AC|AS|US|SS|SSC|TSG|SV|VfL|VfB|1\. FC|1907|1899|1860|Calcio|W)\b/gi, "")
    .replace(/\b(II|III|IV|B|C|U\d+)\b$/i, "")
    .trim().split(/\s+/).slice(0, 2).join(" ");
  try {
    const markets = await apiRequest<MarketCatalogueItem[]>(
      "betting",
      "/listMarketCatalogue/",
      {
        filter: {
          eventTypeIds: ["1"],
          textQuery: shortHome,
          marketTypeCodes: ["MATCH_ODDS"],
          marketStartTime: {
            from: new Date().toISOString(),
            to: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
        marketProjection: ["MARKET_DESCRIPTION", "EVENT"],
        maxResults: 20,
      },
      3,
    );
    const homeFirst = shortHome.toLowerCase().split(/\s+/)[0] ?? "";
    const awayTokens = awayTeam.toLowerCase()
      .replace(/\b(FC|SC|CF|AC|AS|US|SS|SSC|Borussia|TSG)\b/gi, "")
      .trim().split(/\s+/);
    const awayFirst = awayTokens[0] ?? "";

    // 2026-05-11 BUG FIX: cross-validate BOTH team names against the
    // resolved event name. Pre-fix, the away-team filter found matches
    // by awayFirst alone — and the single-result fallback below skipped
    // the away check entirely. Consequence: ambiguous home-team text
    // queries (e.g. "Real" matching both Real Madrid and Real Salt Lake)
    // could resolve to the wrong fixture. The PSG-vs-Arsenal / Liverpool-
    // vs-Arsenal class of error is the root cause we believe drove the
    // id=6044 won-marked-but-Betfair-lost row.
    const eventNameContains = (eventName: string | undefined, token: string): boolean => {
      if (!token) return false;
      return (eventName ?? "").toLowerCase().includes(token);
    };

    // Strict pass: event name contains BOTH home AND away tokens.
    if (homeFirst && awayFirst) {
      const strictMatch = markets.find((m) =>
        eventNameContains(m.event?.name, homeFirst) &&
        eventNameContains(m.event?.name, awayFirst),
      );
      if (strictMatch) {
        logger.info(
          {
            eventId: strictMatch.event.id,
            eventName: strictMatch.event.name,
            shortHome,
            awayFirst,
          },
          "Resolved Betfair event ID via strict home+away cross-validation",
        );
        return strictMatch.event.id;
      }
    }

    // Permissive fallback: at least the away token must appear (the
    // original behaviour). Logged at WARN so operator can audit if this
    // path produces drift.
    const awayOnlyMatch = markets.find((m) =>
      eventNameContains(m.event?.name, awayFirst),
    );
    if (awayOnlyMatch) {
      logger.warn(
        {
          eventId: awayOnlyMatch.event.id,
          eventName: awayOnlyMatch.event.name,
          shortHome,
          awayFirst,
          note: "home token did not match event name — using away-only fallback",
        },
        "Resolved Betfair event ID via permissive away-only fallback",
      );
      return awayOnlyMatch.event.id;
    }

    // Single-result fallback DELETED 2026-05-11. The prior code returned
    // the sole result without cross-checking either team — this was the
    // wrong-fixture vector. If neither strict nor permissive matches, we
    // refuse to resolve rather than gamble on the wrong fixture.
    logger.warn(
      {
        shortHome,
        homeFirst,
        awayFirst,
        resultCount: markets.length,
        eventNames: markets.map((m) => m.event?.name),
      },
      "Could not match Betfair event — refusing single-result fallback (would risk wrong fixture)",
    );
    return null;
  } catch (err) {
    logger.error({ err, homeTeam, awayTeam }, "Failed to resolve Betfair event ID");
    return null;
  }
}

// 2026-05-12: AH line-aware market selection. For ASIAN_HANDICAP, Betfair
// returns ONE market per LINE per event — each with 2 runners (Home/Away)
// carrying a `handicap` value. Picking markets[0] silently collapsed every
// "Home +0.25" / "Home +0.5" / "Home +1" etc. onto whichever AH market
// happened to come back first, so 7 distinct lines stacked on the SAME
// Betfair selection at the SAME matched price. Mirrors the logic in
// paperTrading.ts findAhMarketByLine (which was patched for capture in 4.A
// but never wired into the LIVE placement path).
// 2026-05-14 — Betfair returns ASIAN_HANDICAP as a single market per event with
// N×2 runners (one per (team, handicap-line) pair). Pre-fix this function did
// `runners.find(side-match)` and only checked the first matching runner's
// handicap — collapsing all internal AH lines onto whichever runner Betfair
// happened to return first. Confirmed via probe-betfair-ah.ts 2026-05-14: every
// AH event has exactly 1 market with 32+ runners spanning multiple lines.
//
// Correct logic: among ALL runners in the market, find the ONE whose runner
// name matches the requested side AND whose handicap matches the requested
// line. Refuses to fall back to sortPriority — collapse would be silent.
function pickAhMarketForLine(
  markets: MarketCatalogueItem[],
  selectionName: string | undefined,
  homeTeam: string | undefined,
  awayTeam: string | undefined,
): MarketCatalogueItem | null {
  if (!selectionName) return null;
  const m = selectionName.trim().match(/^(Home|Away)\s*([+-]?\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const side = m[1]!.toLowerCase() === "home" ? "home" : "away";
  const line = parseFloat(m[2]!);
  if (!Number.isFinite(line)) return null;

  const teamForSide = side === "home" ? (homeTeam ?? "") : (awayTeam ?? "");

  for (const market of markets) {
    const runners = market.runners ?? [];
    if (runners.length < 2) continue;
    const matchingRunner = runners.find((r) => {
      // 2026-05-14 second iteration: exact-string team match was too strict —
      // failed on "Bodo/Glimt" vs "Bodø/Glimt", "IF Elfsborg" vs "Elfsborg",
      // "OH Leuven" vs "Oud-Heverlee Leuven", and dozens of similar variants
      // across Eliteserien / Allsvenskan / Jupiler Pro / etc. Use the
      // accent-strip + prefix-aware fuzzy matcher from apiFootball; pair it
      // with the strict handicap predicate so the collapse fix is preserved.
      if (!teamNameMatch(r.runnerName, teamForSide)) return false;
      if (r.handicap == null) return false;
      return Math.abs(r.handicap - line) < 1e-6;
    });
    if (matchingRunner) return market;
  }
  return null;
}

export async function findMarketForBet(
  betfairEventId: string,
  internalMarketType: string,
  homeTeam?: string,
  awayTeam?: string,
  selectionName?: string,
): Promise<MarketCatalogueItem | null> {
  const bfMarketType = MARKET_TYPE_MAP[internalMarketType];
  if (!bfMarketType) return null;

  let resolvedEventId = betfairEventId.startsWith("af_") ? null : betfairEventId;

  if (!resolvedEventId && homeTeam && awayTeam) {
    resolvedEventId = await findEventIdByTeamNames(homeTeam, awayTeam);
  }

  try {
    if (resolvedEventId) {
      // For AH, request enough markets to cover every line on the event.
      const ahWidenedCap = bfMarketType === "ASIAN_HANDICAP" ? 50 : 10;
      const markets = await apiRequest<MarketCatalogueItem[]>(
        "betting",
        "/listMarketCatalogue/",
        {
          filter: {
            eventIds: [resolvedEventId],
            marketTypeCodes: [bfMarketType],
          },
          marketProjection: [
            "RUNNER_DESCRIPTION",
            "MARKET_DESCRIPTION",
            "MARKET_START_TIME",
          ],
          maxResults: ahWidenedCap,
        },
        3,
      );
      if (markets.length > 0) {
        if (bfMarketType === "ASIAN_HANDICAP") {
          const lineMatch = pickAhMarketForLine(markets, selectionName, homeTeam, awayTeam);
          if (lineMatch) {
            logger.info(
              { marketId: lineMatch.marketId, eventId: resolvedEventId, marketType: bfMarketType, selectionName },
              "Found Betfair AH market via line-aware lookup",
            );
            return lineMatch;
          }
          // Refuse to place when the line cannot be matched — better to skip
          // than to fire onto the wrong Betfair selection.
          logger.warn(
            {
              eventId: resolvedEventId,
              selectionName,
              ahCandidateCount: markets.length,
              availableLines: markets.map((m) => ({
                marketId: m.marketId,
                runners: (m.runners ?? []).map((r) => ({ side: r.sortPriority, handicap: r.handicap })),
              })),
            },
            "AH line-aware match failed — refusing fallback to first market (would place onto wrong line)",
          );
          return null;
        }
        logger.info({ marketId: markets[0].marketId, eventId: resolvedEventId, marketType: bfMarketType }, "Found Betfair market via eventId lookup");
        return markets[0];
      }

      const allMarkets = await apiRequest<MarketCatalogueItem[]>(
        "betting",
        "/listMarketCatalogue/",
        {
          filter: { eventIds: [resolvedEventId] },
          marketProjection: ["MARKET_DESCRIPTION"],
          maxResults: 50,
        },
        3,
      );
      const marketTypes = allMarkets.map(m => m.description?.marketType ?? m.marketName);
      logger.warn(
        { eventId: resolvedEventId, requestedType: bfMarketType, availableTypes: [...new Set(marketTypes)] },
        "Requested market type not available — listing all available types for event",
      );
    }

    return null;
  } catch (err) {
    logger.error(
      { err, betfairEventId, internalMarketType },
      "Failed to find Betfair market for bet",
    );
    return null;
  }
}

export function findSelectionId(
  runners: Array<{ selectionId: number; runnerName: string; sortPriority: number; handicap?: number | null }>,
  selectionName: string,
  homeTeam: string,
  awayTeam: string,
): number | null {
  const sel = selectionName.toLowerCase().trim();

  // 2026-05-14 — Betfair ASIAN_HANDICAP_DOUBLE_LINE markets carry N×2 runners
  // (one per (team, handicap) pair). The original code at this branch did
  // `runners.find(r => r.sortPriority === 1)` for any "home X" selectionName,
  // returning the FIRST home-side selectionId regardless of line — silently
  // collapsing all internal AH lines onto whichever Betfair runner sorted
  // first. The collapse-bug-guard (betfairLive.ts:2060+) caught duplicate
  // second-placements but the first placement still landed on the wrong line.
  // Cumulative effect: 4 days of post-cutover AH PnL was attributed to lines
  // the model emitted, not the lines actually backed.
  //
  // Correct: parse the line from the selectionName, find the runner whose
  // team-name matches AND whose handicap equals the requested line. Refuse
  // to fall through to sortPriority — without an exact handicap match the
  // placement would route to the wrong Betfair selection.
  const ahMatch = sel.match(/^(home|away)\s*([+-]?\d+(?:\.\d+)?)$/);
  if (ahMatch) {
    const wantedSide = ahMatch[1]!;
    const wantedLine = parseFloat(ahMatch[2]!);
    if (!Number.isFinite(wantedLine)) return null;
    const teamForSide = wantedSide === "home" ? homeTeam : awayTeam;
    const runner = runners.find((r) => {
      // Fuzzy team-name match keeps tolerance for naming variants
      // (accents, club prefixes, abbreviations) while strict handicap match
      // preserves the collapse fix.
      if (!teamNameMatch(r.runnerName, teamForSide)) return false;
      if (r.handicap == null) return false;
      return Math.abs(r.handicap - wantedLine) < 1e-6;
    });
    return runner ? runner.selectionId : null;
  }

  if (sel === "home" || sel === homeTeam.toLowerCase()) {
    const home = runners.find((r) => r.sortPriority === 1);
    if (home) return home.selectionId;
  }

  if (sel === "away" || sel === awayTeam.toLowerCase()) {
    const away = runners.find(
      (r) => r.sortPriority === 2 || r.sortPriority === 3,
    );
    if (away) return away.selectionId;
  }

  if (sel === "draw" || sel === "the draw") {
    const draw = runners.find(
      (r) =>
        r.runnerName.toLowerCase() === "the draw" ||
        r.runnerName.toLowerCase() === "draw",
    );
    if (draw) return draw.selectionId;
  }

  if (sel === "yes") {
    const yes = runners.find(
      (r) => r.runnerName.toLowerCase() === "yes" || r.sortPriority === 1,
    );
    if (yes) return yes.selectionId;
  }
  if (sel === "no") {
    const no = runners.find(
      (r) => r.runnerName.toLowerCase() === "no" || r.sortPriority === 2,
    );
    if (no) return no.selectionId;
  }

  // OU lines: in 2-runner markets (OVER_UNDER_25 etc.) the line is encoded in
  // the marketType, so a single Over/Under runner per market is fine. In
  // multi-line markets (ALT_TOTAL_GOALS, Betfair returns Over/Under runners
  // at every line in ONE market), falling back to "first Over runner" would
  // collapse every internal "Over X.5" bet onto the same Betfair selection —
  // the exact bug class that crippled AH placement. If the selectionName
  // carries a line digit (e.g. "Over 2.5"), require it to appear in the
  // runner name; refuse to fall through to sortPriority.
  const ouLineMatch = sel.match(/^(over|under)\s*([0-9]+(?:\.[0-9]+)?)/);
  if (ouLineMatch) {
    const dir = ouLineMatch[1];
    const line = ouLineMatch[2];
    const exact = runners.find((r) => {
      const rn = r.runnerName.toLowerCase();
      return rn.includes(dir) && rn.includes(line);
    });
    if (exact) return exact.selectionId;
    // Fallback to direction-only ONLY when the market has exactly 2 runners
    // (i.e. line is implicit in marketType, not encoded per-runner).
    if (runners.length === 2) {
      const dirOnly = runners.find((r) => r.runnerName.toLowerCase().includes(dir));
      if (dirOnly) return dirOnly.selectionId;
    }
    return null;
  }
  if (sel.includes("over")) {
    if (runners.length !== 2) return null; // refuse first-runner fallback in multi-line markets
    const over = runners.find(
      (r) =>
        r.runnerName.toLowerCase().includes("over") || r.sortPriority === 1,
    );
    if (over) return over.selectionId;
  }
  if (sel.includes("under")) {
    if (runners.length !== 2) return null;
    const under = runners.find(
      (r) =>
        r.runnerName.toLowerCase().includes("under") || r.sortPriority === 2,
    );
    if (under) return under.selectionId;
  }

  if (sel === "1x") {
    const r = runners.find(
      (r) =>
        r.runnerName.toLowerCase().includes("home or draw") ||
        r.sortPriority === 1,
    );
    if (r) return r.selectionId;
  }
  if (sel === "12") {
    const r = runners.find(
      (r) =>
        r.runnerName.toLowerCase().includes("home or away") ||
        r.sortPriority === 2,
    );
    if (r) return r.selectionId;
  }
  if (sel === "x2") {
    const r = runners.find(
      (r) =>
        r.runnerName.toLowerCase().includes("draw or away") ||
        r.sortPriority === 3,
    );
    if (r) return r.selectionId;
  }

  const fuzzy = runners.find(
    (r) =>
      r.runnerName.toLowerCase().includes(sel) ||
      sel.includes(r.runnerName.toLowerCase()),
  );
  if (fuzzy) return fuzzy.selectionId;

  return null;
}

export async function placeLiveBetOnBetfair(params: {
  internalBetId: number;
  betfairEventId: string;
  marketType: string;
  selectionName: string;
  odds: number;
  stake: number;
  homeTeam: string;
  awayTeam: string;
  // Task 24 Part C — when 'TAKE_BEST_BACK', resolve the current best back
  // price for the runner and use it as the placement price (rounded down to
  // a valid Betfair tick). Honoured only if the best back is within
  // `slippageTolerance` of `odds`. Default 'TARGET' preserves legacy
  // limit-at-target behaviour for low-edge / lazy-promoted bets.
  placementMode?: PlacementMode;
  slippageTolerance?: number;
  // Task 24 Part D (2026-05-11) — bet's calculated edge. Only used to decide
  // persistenceType: when edge ≥ ah_persist_min_edge (default 0.15) AND
  // market is ASIAN_HANDICAP AND agent_config.ah_persist_enabled='true',
  // unmatched portion goes to Starting Price at in-play instead of lapsing.
  // Default undefined → legacy LAPSE behaviour for all markets.
  edge?: number;
}): Promise<{
  success: boolean;
  betfairBetId?: string;
  betfairMarketId?: string;
  betfairStatus?: string;
  sizeMatched?: number;
  avgPriceMatched?: number;
  error?: string;
}> {
  const {
    internalBetId,
    betfairEventId,
    marketType,
    selectionName,
    odds,
    stake,
    homeTeam,
    awayTeam,
    placementMode = "TARGET",
    slippageTolerance = 0.05,
    edge,
  } = params;

  if (NON_EXCHANGE_MARKETS.has(marketType)) {
    const msg = `Market type ${marketType} not available on Betfair Exchange — paper-only`;
    logger.warn({ internalBetId, marketType }, msg);
    return { success: false, error: msg };
  }

  if (!betfairEventId) {
    const msg = "No betfairEventId for match — cannot place live bet";
    logger.warn({ internalBetId }, msg);
    return { success: false, error: msg };
  }

  // Pre-flight: refresh balance if the cached value is older than 30s. Stops
  // INSUFFICIENT_FUNDS cascades during placement bursts where multiple bets
  // in the same cycle drain the bankroll faster than the periodic refresh.
  await refreshBalanceIfStale();

  const balance = getCachedBalance();
  if (balance && stake > balance.available) {
    const msg = `Insufficient funds: stake £${stake} > available £${balance.available}`;
    logger.error({ internalBetId, stake, available: balance.available }, msg);
    return { success: false, error: msg };
  }

  // 2026-05-12 (afternoon): AH side-dedup guard removed. Different AH lines
  // on the same side (Home -0.25 / Home -0.5 / Home -1) are correlated but
  // NOT identical — each has its own break-even point, edge, odds, and
  // realised PnL. The empirical record shows multi-line-per-side wins
  // settling to distinct PnL (e.g. Celta v Levante 2026-05-10/11/12 four
  // Away-side AH lines, all matched, all won at different stakes).
  //
  // Kelly already prices correlation correctly when bets are placed
  // sequentially against a shrinking bankroll: the Nth line sees the
  // post-prior-bet balance and is sized down accordingly. The Wilson + CLV
  // t-stat gate in v_live_eligibility_candidates is calibrated against
  // historical multi-line placements, so the gate's assumption matches the
  // production behaviour.
  //
  // The actual mapping bug (multiple internal bets collapsed onto one
  // Betfair (market_id, selection_id)) is caught by line-aware market
  // selection above + the universal collapse guard at L2098+ below.

  const market = await findMarketForBet(betfairEventId, marketType, homeTeam, awayTeam, selectionName);
  if (!market) {
    const bfType = MARKET_TYPE_MAP[marketType] ?? marketType;
    const msg = `${bfType} market unavailable on Betfair Exchange for this event`;
    logger.warn({ internalBetId, betfairEventId, marketType, bfType, homeTeam, awayTeam, selectionName }, msg);
    return { success: false, error: msg, unavailableOnExchange: true };
  }

  if (!market.runners || market.runners.length === 0) {
    const msg = `Market ${market.marketId} has no runners`;
    logger.warn({ internalBetId, marketId: market.marketId }, msg);
    return { success: false, error: msg };
  }

  const selectionId = findSelectionId(
    market.runners,
    selectionName,
    homeTeam,
    awayTeam,
  );
  if (!selectionId) {
    const msg = `Cannot map selection "${selectionName}" to Betfair runner`;
    logger.warn(
      {
        internalBetId,
        selectionName,
        runners: market.runners.map((r) => r.runnerName),
      },
      msg,
    );
    return { success: false, error: msg };
  }

  // Task 24 Part C — resolve placement price. In TAKE_BEST_BACK mode, snap to
  // the current top-of-book back price (within slippage tolerance) so the
  // order matches immediately. The target price `odds` is the model's
  // theoretical fair entry; for high-edge bets the model has already proven
  // the bet is +EV, so a small slippage haircut beats letting the order
  // expire unmatched (see Task 24 finding: ~£999 of foregone AH EV from
  // unmatched LIMIT orders since 2026-05-03).
  let placementPrice = odds;
  // True only when we are consuming a real top-of-book back price. The two
  // LIMIT-fallback branches below keep this false so the slippage guard at
  // ~L1864 doesn't run on LIMIT-at-target orders (we're providing liquidity,
  // not consuming it).
  let consumingLiquidity = false;
  if (placementMode === "TAKE_BEST_BACK") {
    try {
      const liquidity = await relayGetLiquidity(market.marketId);
      const runner = liquidity?.runners?.find((r) => r.selectionId === selectionId);
      const bestBack = runner?.backPrices?.[0]?.price;
      if (!bestBack || bestBack <= 1) {
        // 2026-05-11: was return-fail. Niche AH sub-lines (Away+0.75 etc.)
        // often have no current back-side liquidity. Falling back to LIMIT-at-
        // target lets the order sit on the book until it matches OR persists
        // to SP at kickoff (if ah_persist_enabled). Either outcome is strictly
        // better than abandoning the bet. Theory: a positive-EV bet that sits
        // unmatched preserves option value; demoting to shadow throws away the
        // entire EV.
        logger.info(
          { internalBetId, marketId: market.marketId, selectionId, target: odds },
          "TAKE_BEST_BACK: no back-side liquidity — falling back to LIMIT at target",
        );
        // placementPrice stays at `odds` (initial value); LIMIT order at target
        // is the fallback behaviour.
      } else {
        const minAcceptable = odds * (1 - slippageTolerance);
        if (bestBack < minAcceptable) {
          // 2026-05-11: same fallback rationale as above. Betfair's current
          // price has drifted away from our target by more than tolerance —
          // taking the drifted price would crystallise slippage, so instead
          // we LIMIT at target and let the order ride.
          logger.info(
            { internalBetId, target: odds, bestBack, minAcceptable, slippageTolerance },
            "TAKE_BEST_BACK: best back below tolerance — falling back to LIMIT at target",
          );
          // placementPrice stays at `odds` (target).
        } else {
          placementPrice = bestBack;
          consumingLiquidity = true;
        }
      }
      logger.info(
        { internalBetId, target: odds, placementPrice, marketId: market.marketId },
        "TAKE_BEST_BACK placement — using current best back price",
      );
    } catch (err) {
      logger.warn({ err, internalBetId, marketId: market.marketId }, "TAKE_BEST_BACK liquidity fetch failed — falling back to TARGET");
      // Fall through to TARGET behaviour rather than fail outright.
    }
  }

  const roundedOdds = roundDownToTick(placementPrice);
  const roundedStake = Math.round(stake * 100) / 100;

  if (roundedOdds !== Math.round(placementPrice * 100) / 100) {
    logger.info(
      { internalBetId, requestedOdds: placementPrice, tickOdds: roundedOdds, placementMode },
      "Odds rounded down to valid Betfair tick",
    );
  }

  if (roundedStake < 2) {
    const msg = `Stake £${roundedStake} below Betfair minimum £2`;
    logger.warn({ internalBetId, stake: roundedStake }, msg);
    return { success: false, error: msg };
  }

  // Task 23 — order-book depth + slippage guard. Only meaningful when we
  // are CONSUMING liquidity (TAKE_BEST_BACK): there, depth-at-or-better
  // is the actual slippage risk between fetch and place. For TARGET mode
  // we are PROVIDING liquidity at our edge price — the order sits on the
  // book until matched or persists to SP at kickoff. There is no slippage
  // to guard against; the "no depth at our price or better" condition is
  // the normal state for a LIMIT order on a thin AH sub-line, not a
  // failure. Running the guard there demoted ~63 Tier A LIMIT orders/12h
  // on 2026-05-12 with SLIPPAGE_NO_LIQUIDITY.
  let finalStake = roundedStake;
  if (consumingLiquidity) {
    try {
      const { checkOrderBookDepth } = await import("./slippageGuard");
      const slip = await checkOrderBookDepth({
        marketId: market.marketId,
        selectionId,
        intendedStake: roundedStake,
        intendedPrice: roundedOdds,
      });
      if (slip.adjustedStake === 0) {
        logger.info({ internalBetId, marketId: market.marketId, reason: slip.reason },
          "Slippage guard blocked placement");
        return { success: false, error: `SLIPPAGE_${slip.reason.toUpperCase()}` };
      }
      if (slip.wasReduced && slip.adjustedStake < finalStake) {
        logger.info(
          { internalBetId, originalStake: finalStake, adjustedStake: slip.adjustedStake,
            depthAtPrice: slip.depthAtPrice },
          "Slippage guard reduced stake to fit available depth",
        );
        finalStake = slip.adjustedStake;
      }
    } catch (err) {
      logger.warn({ err, internalBetId, marketId: market.marketId },
        "Slippage guard threw — proceeding at intended stake");
    }
  }

  // Task 24 Part D — persistence type. The unmatched portion of a LIMIT
  // order normally LAPSEs at in-play (refunded, never settles). For
  // high-edge ASIAN_HANDICAP bets the model has already identified the
  // mispricing; on average the price tightens by kick-off and the
  // matched portion is profitable, but the unmatched residual is dead
  // EV under LAPSE. Switching to PERSIST sends the residual to Starting
  // Price at in-play — Betfair's SP auction at kick-off — which closes
  // the EV gap on the residual.
  //
  // Gated behind agent_config.ah_persist_enabled (default 'false') as a
  // money-guardrail change — operator must explicitly opt in. Threshold
  // controlled by ah_persist_min_edge (default 0.15).
  const persistenceType = await resolvePersistenceType({
    marketType,
    edge,
  });

  // 2026-05-12 universal collapse-bug guard. THIS IS A LAST-LINE SAFETY NET.
  // The original AH bug fired because `findMarketForBet` collapsed multiple
  // internal lines onto a single Betfair (marketId, selectionId) pair.
  // Regardless of WHERE the upstream collapse comes from (wrong market
  // lookup, wrong runner resolution, fuzzy-match misfire, future market type
  // we haven't audited), the symptom is always: two internal bets resolve
  // to the same Betfair (marketId, selectionId). Check that triple here, in
  // one place, for every placement. If any other internal bet for this
  // match already has a live Betfair position on (marketId, selectionId),
  // refuse — full stop. This catches the entire bug class once and for all.
  try {
    const selfRow = await db
      .select({ matchId: paperBetsTable.matchId })
      .from(paperBetsTable)
      .where(eq(paperBetsTable.id, internalBetId))
      .limit(1);
    const selfMatchId = selfRow[0]?.matchId ?? null;
    if (selfMatchId != null) {
      const collisions = await db
        .select({
          id: paperBetsTable.id,
          betfairBetId: paperBetsTable.betfairBetId,
          betfairStatus: paperBetsTable.betfairStatus,
          selectionName: paperBetsTable.selectionName,
        })
        .from(paperBetsTable)
        .where(
          and(
            eq(paperBetsTable.matchId, selfMatchId),
            eq(paperBetsTable.betfairMarketId, market.marketId),
            eq(paperBetsTable.betfairSelectionId, String(selectionId)),
            isNotNull(paperBetsTable.betfairBetId),
          ),
        );
      const liveStatuses = new Set([
        "EXECUTABLE",
        "EXECUTION_COMPLETE",
        "PARTIAL_ACCEPTED",
        "MATCHED",
        "STATUS_UNKNOWN",
      ]);
      const collision = collisions.find(
        (c) =>
          c.id !== internalBetId &&
          c.betfairStatus != null &&
          liveStatuses.has(c.betfairStatus),
      );
      if (collision) {
        const msg = `COLLAPSE_GUARD: Betfair (market ${market.marketId}, selection ${selectionId}) already open on internal bet #${collision.id} (selection "${collision.selectionName}") for match ${selfMatchId} — refusing placement`;
        logger.error(
          {
            internalBetId,
            matchId: selfMatchId,
            marketId: market.marketId,
            selectionId,
            collidingBetId: collision.id,
            collidingBetfairBetId: collision.betfairBetId,
            collidingSelectionName: collision.selectionName,
            ourSelectionName: selectionName,
          },
          msg,
        );
        await db.insert(complianceLogsTable).values({
          actionType: "live_bet_placement_collapse_guard",
          details: {
            internalBetId,
            matchId: selfMatchId,
            marketType,
            ourSelectionName: selectionName,
            betfairMarketId: market.marketId,
            betfairSelectionId: selectionId,
            collidingInternalBetId: collision.id,
            collidingSelectionName: collision.selectionName,
            collidingBetfairBetId: collision.betfairBetId,
          },
          timestamp: new Date(),
        });
        return { success: false, error: msg };
      }
    }
  } catch (err) {
    // Guard query failure is non-fatal — log and proceed. We prefer to place
    // the bet than to block on a transient DB hiccup; the AH-specific guard
    // upstream still gates the most-likely collapse case.
    logger.warn({ err, internalBetId }, "COLLAPSE_GUARD: pre-flight check threw — proceeding");
  }

  // Idempotent on retry — Betfair rejects DUPLICATE_TRANSACTION; do NOT add a timestamp.
  const customerRef = `BAO-${internalBetId}`;

  try {
    const result = await placeOrders(
      market.marketId,
      [
        {
          orderType: "LIMIT",
          selectionId,
          side: "BACK",
          limitOrder: {
            size: finalStake,
            price: roundedOdds,
            persistenceType,
          },
        },
      ],
      customerRef,
    );

    if (result.status !== "SUCCESS" || !result.instructionReports?.[0]) {
      const msg = `Betfair placeOrders failed: ${result.errorCode ?? "unknown"}`;
      logger.error(
        { internalBetId, result },
        msg,
      );

      await db.insert(complianceLogsTable).values({
        actionType: "live_bet_placement_failed",
        details: {
          internalBetId,
          marketId: market.marketId,
          selectionId,
          odds: roundedOdds,
          stake: roundedStake,
          errorCode: result.errorCode,
          customerRef,
        },
        timestamp: new Date(),
      });

      return { success: false, error: msg };
    }

    const report = result.instructionReports[0];

    if (report.status !== "SUCCESS") {
      const msg = `Bet instruction failed: ${report.errorCode ?? "unknown"}`;
      logger.error({ internalBetId, report }, msg);

      await db.insert(complianceLogsTable).values({
        actionType: "live_bet_placement_failed",
        details: {
          internalBetId,
          marketId: market.marketId,
          selectionId,
          errorCode: report.errorCode,
          customerRef,
        },
        timestamp: new Date(),
      });

      return { success: false, error: msg };
    }

    await db
      .update(paperBetsTable)
      .set({
        betfairBetId: report.betId ?? null,
        betfairMarketId: market.marketId,
        betfairSelectionId: String(selectionId),
        betfairStatus: report.orderStatus ?? "EXECUTABLE",
        betfairSizeMatched: report.sizeMatched != null ? String(report.sizeMatched) : "0",
        betfairAvgPriceMatched:
          report.averagePriceMatched != null
            ? String(report.averagePriceMatched)
            : null,
        betfairPlacedAt: report.placedDate
          ? new Date(report.placedDate)
          : new Date(),
      })
      .where(eq(paperBetsTable.id, internalBetId));

    await db.insert(complianceLogsTable).values({
      actionType: "live_bet_placed",
      details: {
        internalBetId,
        betfairBetId: report.betId,
        marketId: market.marketId,
        selectionId,
        selectionName,
        odds: roundedOdds,
        stake: roundedStake,
        sizeMatched: report.sizeMatched,
        avgPriceMatched: report.averagePriceMatched,
        orderStatus: report.orderStatus,
        customerRef,
      },
      timestamp: new Date(),
    });

    logger.info(
      {
        internalBetId,
        betfairBetId: report.betId,
        marketId: market.marketId,
        sizeMatched: report.sizeMatched,
        avgPriceMatched: report.averagePriceMatched,
        orderStatus: report.orderStatus,
      },
      "LIVE BET PLACED on Betfair Exchange",
    );

    return {
      success: true,
      betfairBetId: report.betId,
      betfairMarketId: market.marketId,
      betfairStatus: report.orderStatus,
      sizeMatched: report.sizeMatched,
      avgPriceMatched: report.averagePriceMatched,
    };
  } catch (err) {
    const msg = `Live bet placement exception: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err, internalBetId }, msg);

    try {
      const { recordBetfairApiError } = await import("./liveRiskManager");
      recordBetfairApiError();
    } catch { /* avoid circular import issues */ }

    await db.insert(complianceLogsTable).values({
      actionType: "live_bet_placement_failed",
      details: {
        internalBetId,
        marketId: market.marketId,
        selectionId,
        error: msg,
        customerRef,
      },
      timestamp: new Date(),
    });

    return { success: false, error: msg };
  }
}

export {
  isLiveMode,
  startSessionRefreshTimer,
  authenticate,
  getSessionToken as getLiveSessionToken,
};
