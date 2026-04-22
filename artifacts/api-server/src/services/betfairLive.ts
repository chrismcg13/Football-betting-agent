import axios, { type AxiosInstance } from "axios";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { paperBetsTable, complianceLogsTable, oddsSnapshotsTable } from "@workspace/db";
import { eq, and, isNotNull, isNull, sql, desc } from "drizzle-orm";
import { BETFAIR_TICKS } from "./orderManager";

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
  if (cachedBalance && !isBalanceStale() && isBalanceFresh()) {
    return cachedBalance.available;
  }

  try {
    const funds = await getAccountFunds();
    return funds.availableToBetBalance;
  } catch (err) {
    if (cachedBalance && !isBalanceStale()) {
      logger.warn(
        { lastFetchedAt: new Date(cachedBalance.fetchedAt).toISOString() },
        "Balance fetch failed — using cached value",
      );
      return cachedBalance.available;
    }
    logger.error(
      "CRITICAL: Balance fetch failed and cached balance is stale (>1hr) — halting bet placement",
    );
    throw new Error("Balance unavailable and stale — cannot place bets");
  }
}

export interface PlaceInstruction {
  orderType: "LIMIT";
  selectionId: number;
  handicap?: number;
  side: "BACK" | "LAY";
  limitOrder: {
    size: number;
    price: number;
    persistenceType: "LAPSE";
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
  try {
    for (const status of ["SETTLED", "VOIDED", "LAPSED", "CANCELLED"] as const) {
      const cleared = await listClearedOrders(dateRange, betfairIds, status);
      for (const order of cleared) {
        const existing = orderByBetId.get(order.betId);
        if (!existing || statusPriority[status] < statusPriority[existing.betfairStatus]) {
          orderByBetId.set(order.betId, { betfairStatus: status, order });
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to fetch cleared orders for reconciliation");
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
    const profit = Number(cleared.profit ?? 0);
    const commission = Number(cleared.commission ?? 0);
    const betfairPnl = Number.isFinite(profit) && Number.isFinite(commission)
      ? profit - commission
      : 0;
    if (!Number.isFinite(profit) || !Number.isFinite(commission)) {
      logger.warn(
        { betId: bet.id, betfairBetId: bet.betfairBetId, rawProfit: cleared.profit, rawCommission: cleared.commission },
        "reconcileSettlements: non-finite profit/commission from Betfair — treating as 0",
      );
    }
    const internalPnl = Number(bet.settlementPnl ?? 0);
    const pnlDiff = Math.abs(betfairPnl - internalPnl);

    // ── CLV: compare placement odds vs latest market snapshot (proxy) ──
    // Ported from paperTrading.settleBets which used to compute this for all
    // bets. Now that settleBets defers all matched real-money bets to this
    // function, we must compute CLV here or every future real-money bet
    // would have null CLV/closingOddsProxy. Best-effort — failure does not
    // block settlement.
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
          const placementOdds = Number(bet.oddsAtPlacement ?? 0);
          if (placementOdds > 1) {
            clvPct = ((placementOdds - closingOddsProxy) / closingOddsProxy) * 100;
            clvPct = Math.round(clvPct * 1000) / 1000;
          }
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
    const commissionAmount = Number.isFinite(commission) ? commission : 0;
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
  DOUBLE_CHANCE: "DOUBLE_CHANCE",
  CORRECT_SCORE: "CORRECT_SCORE",
  FIRST_HALF_OU_05: "FIRST_HALF_GOALS_05",
  FIRST_HALF_OU_15: "FIRST_HALF_GOALS_15",
  // Cards markets — Betfair Exchange uses OVER_UNDER_<line>_CARDS naming
  TOTAL_CARDS_25: "OVER_UNDER_25_CARDS",
  TOTAL_CARDS_35: "OVER_UNDER_35_CARDS",
  TOTAL_CARDS_45: "OVER_UNDER_45_CARDS",
  TOTAL_CARDS_55: "OVER_UNDER_55_CARDS",
  // Half-time result — Betfair calls it HALF_TIME (1/X/2 outcomes for H1)
  FIRST_HALF_RESULT: "HALF_TIME",
};

const NON_EXCHANGE_MARKETS = new Set([
  // Corners markets are still missing Exchange equivalents (sportsbook only)
  "TOTAL_CORNERS_85",
  "TOTAL_CORNERS_95",
  "TOTAL_CORNERS_105",
  "TOTAL_CORNERS_115",
]);

interface MarketCatalogueItem {
  marketId: string;
  marketName: string;
  marketStartTime?: string;
  event: { id: string; name: string };
  runners?: Array<{
    selectionId: number;
    runnerName: string;
    sortPriority: number;
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
    const awayTokens = awayTeam.toLowerCase()
      .replace(/\b(FC|SC|CF|AC|AS|US|SS|SSC|Borussia|TSG)\b/gi, "")
      .trim().split(/\s+/);
    const awayFirst = awayTokens[0];
    const match = markets.find(m => (m.event?.name ?? "").toLowerCase().includes(awayFirst));
    if (match) {
      logger.info({ eventId: match.event.id, eventName: match.event.name, shortHome }, "Resolved Betfair event ID via MATCH_ODDS search");
      return match.event.id;
    }
    if (markets.length === 1) {
      logger.info({ eventId: markets[0].event.id, eventName: markets[0].event.name }, "Resolved Betfair event ID (single result)");
      return markets[0].event.id;
    }
    logger.warn({ shortHome, awayFirst, resultCount: markets.length, eventNames: markets.map(m => m.event?.name) }, "Could not match Betfair event from results");
    return null;
  } catch (err) {
    logger.error({ err, homeTeam, awayTeam }, "Failed to resolve Betfair event ID");
    return null;
  }
}

async function findMarketForBet(
  betfairEventId: string,
  internalMarketType: string,
  homeTeam?: string,
  awayTeam?: string,
): Promise<MarketCatalogueItem | null> {
  const bfMarketType = MARKET_TYPE_MAP[internalMarketType];
  if (!bfMarketType) return null;

  let resolvedEventId = betfairEventId.startsWith("af_") ? null : betfairEventId;

  if (!resolvedEventId && homeTeam && awayTeam) {
    resolvedEventId = await findEventIdByTeamNames(homeTeam, awayTeam);
  }

  try {
    if (resolvedEventId) {
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
          maxResults: 10,
        },
        3,
      );
      if (markets.length > 0) {
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
  runners: Array<{ selectionId: number; runnerName: string; sortPriority: number }>,
  selectionName: string,
  homeTeam: string,
  awayTeam: string,
): number | null {
  const sel = selectionName.toLowerCase().trim();

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

  if (sel.includes("over")) {
    const over = runners.find(
      (r) =>
        r.runnerName.toLowerCase().includes("over") || r.sortPriority === 1,
    );
    if (over) return over.selectionId;
  }
  if (sel.includes("under")) {
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

  const market = await findMarketForBet(betfairEventId, marketType, homeTeam, awayTeam);
  if (!market) {
    const bfType = MARKET_TYPE_MAP[marketType] ?? marketType;
    const msg = `${bfType} market unavailable on Betfair Exchange for this event`;
    logger.warn({ internalBetId, betfairEventId, marketType, bfType, homeTeam, awayTeam }, msg);
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

  const roundedOdds = roundDownToTick(odds);
  const roundedStake = Math.round(stake * 100) / 100;

  if (roundedOdds !== Math.round(odds * 100) / 100) {
    logger.info(
      { internalBetId, requestedOdds: odds, tickOdds: roundedOdds },
      "Odds rounded down to valid Betfair tick",
    );
  }

  if (roundedStake < 2) {
    const msg = `Stake £${roundedStake} below Betfair minimum £2`;
    logger.warn({ internalBetId, stake: roundedStake }, msg);
    return { success: false, error: msg };
  }

  const customerRef = `BAO-${internalBetId}-${Date.now()}`;

  try {
    const result = await placeOrders(
      market.marketId,
      [
        {
          orderType: "LIMIT",
          selectionId,
          side: "BACK",
          limitOrder: {
            size: roundedStake,
            price: roundedOdds,
            persistenceType: "LAPSE",
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
