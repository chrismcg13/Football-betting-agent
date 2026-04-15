import axios, { type AxiosInstance } from "axios";
import { logger } from "../lib/logger";

const VPS_RELAY_URL = process.env["VPS_RELAY_URL"] ?? "";
const VPS_RELAY_SECRET = process.env["VPS_RELAY_SECRET"] ?? "";

let relayHealthy = true;
let lastHealthCheck = 0;
let lastLatencyMs = 0;

function getClient(): AxiosInstance {
  return axios.create({
    baseURL: VPS_RELAY_URL,
    headers: {
      "X-Relay-Secret": VPS_RELAY_SECRET,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });
}

export function isRelayConfigured(): boolean {
  return !!VPS_RELAY_URL;
}

export function getRelayStatus(): {
  configured: boolean;
  healthy: boolean;
  lastHealthCheck: string | null;
  lastLatencyMs: number;
  url: string;
} {
  return {
    configured: isRelayConfigured(),
    healthy: relayHealthy,
    lastHealthCheck: lastHealthCheck ? new Date(lastHealthCheck).toISOString() : null,
    lastLatencyMs,
    url: VPS_RELAY_URL ? VPS_RELAY_URL.replace(/\/\/.*?@/, "//***@") : "",
  };
}

export async function checkRelayHealth(): Promise<{
  healthy: boolean;
  betfairConnected: boolean;
  latencyMs: number;
  uptime?: number;
  cachedMarkets?: number;
}> {
  if (!VPS_RELAY_URL) {
    return { healthy: false, betfairConnected: false, latencyMs: 0 };
  }

  const startMs = Date.now();
  try {
    const resp = await getClient().get("/health", { timeout: 10000 });
    const latencyMs = Date.now() - startMs;
    lastLatencyMs = latencyMs;
    lastHealthCheck = Date.now();

    const data = resp.data as {
      status: string;
      betfairConnected: boolean;
      uptime: number;
      cachedMarkets: number;
    };

    relayHealthy = data.status === "healthy";

    if (!relayHealthy) {
      logger.warn(
        { latencyMs, status: data.status, betfairConnected: data.betfairConnected },
        "VPS relay health check DEGRADED",
      );
    }

    return {
      healthy: relayHealthy,
      betfairConnected: data.betfairConnected,
      latencyMs,
      uptime: data.uptime,
      cachedMarkets: data.cachedMarkets,
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    lastLatencyMs = latencyMs;
    lastHealthCheck = Date.now();
    relayHealthy = false;

    logger.error(
      { err, latencyMs },
      "VPS relay health check FAILED — relay unreachable",
    );

    return { healthy: false, betfairConnected: false, latencyMs };
  }
}

export async function relayGetBalance(): Promise<{
  available: number;
  exposure: number;
  total: number;
  fromCache: boolean;
  latencyMs: number;
}> {
  const startMs = Date.now();
  const resp = await getClient().get("/balance");
  const latencyMs = Date.now() - startMs;

  const data = resp.data as {
    available: number;
    exposure: number;
    total: number;
    fromCache: boolean;
  };

  logger.debug({ latencyMs, fromCache: data.fromCache }, "VPS relay: balance fetched");
  return { ...data, latencyMs };
}

export async function relayGetMarket(eventId: string): Promise<{
  eventId: string;
  markets: Array<{
    marketId: string;
    marketName: string;
    marketType?: string;
    runners: Array<{ selectionId: number; name: string }>;
  }>;
  latencyMs: number;
}> {
  const startMs = Date.now();
  const resp = await getClient().get(`/market/${eventId}`);
  const latencyMs = Date.now() - startMs;

  logger.debug({ eventId, latencyMs }, "VPS relay: market fetched");
  return { ...resp.data, latencyMs };
}

export async function relayGetLiquidity(marketId: string): Promise<{
  marketId: string;
  status: string;
  totalMatched: number;
  totalAvailable: number;
  runners: Array<{
    selectionId: number;
    status: string;
    backPrices: Array<{ price: number; size: number }>;
    layPrices: Array<{ price: number; size: number }>;
    totalMatched: number;
  }>;
  latencyMs: number;
}> {
  const startMs = Date.now();
  const resp = await getClient().get(`/market/${marketId}/liquidity`);
  const latencyMs = Date.now() - startMs;

  logger.debug({ marketId, latencyMs }, "VPS relay: liquidity fetched");
  return { ...resp.data, latencyMs };
}

export async function relayPlaceBet(params: {
  marketId: string;
  selectionId: number;
  odds: number;
  stake: number;
  side?: "BACK" | "LAY";
  persistenceType?: "LAPSE" | "PERSIST" | "MARKET_ON_CLOSE";
}): Promise<{
  success: boolean;
  betfairBetId?: string;
  marketId?: string;
  status?: string;
  sizeMatched?: number;
  avgPriceMatched?: number;
  executionMs?: number;
  error?: string;
  relayLatencyMs: number;
}> {
  const startMs = Date.now();
  try {
    const resp = await getClient().post("/bet/place", params);
    const relayLatencyMs = Date.now() - startMs;

    const data = resp.data as {
      success: boolean;
      betfairBetId?: string;
      marketId?: string;
      status?: string;
      sizeMatched?: number;
      avgPriceMatched?: number;
      executionMs?: number;
      error?: string;
    };

    logger.info(
      {
        success: data.success,
        betfairBetId: data.betfairBetId,
        sizeMatched: data.sizeMatched,
        relayLatencyMs,
        betfairExecMs: data.executionMs,
      },
      "VPS relay: bet placement result",
    );

    return { ...data, relayLatencyMs };
  } catch (err) {
    const relayLatencyMs = Date.now() - startMs;
    logger.error({ err, relayLatencyMs }, "VPS relay: bet placement failed");
    return { success: false, error: String(err), relayLatencyMs };
  }
}

export async function relayGetBetStatus(betId: string): Promise<{
  betId: string;
  status: string;
  sizeMatched: number;
  sizeRemaining: number;
  fillPct: number;
  averagePriceMatched: number;
  latencyMs: number;
} | null> {
  const startMs = Date.now();
  try {
    const resp = await getClient().get(`/bet/status/${betId}`);
    const latencyMs = Date.now() - startMs;
    return { ...resp.data, latencyMs };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function relayCancelBet(betId: string): Promise<{
  cancelled: boolean;
  sizeCancelled?: number;
  reason?: string;
  error?: string;
}> {
  const resp = await getClient().delete(`/bet/${betId}`);
  return resp.data;
}

export async function relayGetSettlements(hours = 48): Promise<{
  orders: Array<{
    betId: string;
    marketId: string;
    profit: number;
    betOutcome: string;
    sizeSettled: number;
    settledDate: string;
  }>;
  moreAvailable: boolean;
}> {
  const resp = await getClient().get(`/settlements?hours=${hours}`);
  return resp.data;
}

export async function relayRefreshAuth(): Promise<{ success: boolean; expiresAt?: string }> {
  const resp = await getClient().post("/auth/refresh");
  return resp.data;
}
