import express from "express";
import axios, { type AxiosInstance } from "axios";

const app = express();
app.use(express.json());

const PORT = Number(process.env["RELAY_PORT"] ?? 3001);
const RELAY_SECRET = process.env["VPS_RELAY_SECRET"] ?? "";
const BETFAIR_APP_KEY = process.env["LIVE_BETFAIR_KEY"] ?? "";
const BETFAIR_USERNAME = process.env["BETFAIR_USERNAME"] ?? "";
const BETFAIR_PASSWORD = process.env["BETFAIR_PASSWORD"] ?? "";

const IDENTITY_BASE = "https://identitysso.betfair.com";
const BETTING_BASE = "https://api.betfair.com/exchange/betting/rest/v1.0";
const ACCOUNT_BASE = "https://api.betfair.com/exchange/account/rest/v1.0";

const MAX_RPS = 5;
const REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_RPS);
const SESSION_REFRESH_MS = 12 * 60 * 60 * 1000;

interface Session {
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

interface MarketCache {
  marketId: string;
  marketName: string;
  runners: Array<{ selectionId: number; runnerName: string; sortPriority: number }>;
  fetchedAt: number;
}

const session: Session = { token: null, obtainedAt: 0, expiresAt: 0 };
let cachedBalance: CachedBalance | null = null;
let lastRequestAt = 0;
const marketCache = new Map<string, MarketCache[]>();
let betfairHealthy = true;
let lastBetfairCheck = 0;

function log(level: string, msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const extra = data ? " " + JSON.stringify(data) : "";
  console.log(`[${ts}] ${level}: ${msg}${extra}`);
}

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!RELAY_SECRET) {
    return next();
  }
  const token = req.headers["x-relay-secret"] || req.query["secret"];
  if (token !== RELAY_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.use(authMiddleware);

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

async function authenticate(): Promise<string> {
  if (!BETFAIR_APP_KEY || !BETFAIR_USERNAME || !BETFAIR_PASSWORD) {
    throw new Error("Missing LIVE_BETFAIR_KEY, BETFAIR_USERNAME, or BETFAIR_PASSWORD");
  }

  const params = new URLSearchParams();
  params.set("username", BETFAIR_USERNAME);
  params.set("password", BETFAIR_PASSWORD);

  const response = await axios.post(`${IDENTITY_BASE}/api/login`, params.toString(), {
    headers: {
      "X-Application": BETFAIR_APP_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    timeout: 15000,
  });

  const data = response.data as { status: string; token?: string; error?: string };
  if (data.status !== "SUCCESS" || !data.token) {
    throw new Error(`Betfair login failed: ${data.error ?? data.status}`);
  }

  session.token = data.token;
  session.obtainedAt = Date.now();
  session.expiresAt = Date.now() + 20 * 60 * 60 * 1000;
  log("INFO", "Betfair authentication successful");
  return data.token;
}

async function getToken(): Promise<string> {
  const needsRefresh =
    !session.token ||
    Date.now() >= session.expiresAt ||
    Date.now() - session.obtainedAt >= SESSION_REFRESH_MS;

  if (needsRefresh) return authenticate();
  return session.token!;
}

function createClient(baseURL: string, token: string): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      "X-Application": BETFAIR_APP_KEY,
      "X-Authentication": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 30000,
  });
}

const NON_RETRYABLE = new Set([
  "INSUFFICIENT_FUNDS", "MARKET_NOT_OPEN_FOR_BETTING", "MARKET_SUSPENDED",
  "MARKET_CLOSED", "PERMISSION_DENIED", "DUPLICATE_TRANSACTION",
  "INVALID_ACCOUNT_STATE", "ACCOUNT_FUNDS_ERROR",
]);

async function betfairRequest<T>(
  base: "betting" | "account",
  endpoint: string,
  payload: Record<string, unknown>,
  retries = 3,
): Promise<T> {
  const baseURL = base === "betting" ? BETTING_BASE : ACCOUNT_BASE;

  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttle();
    let token = await getToken();
    let client = createClient(baseURL, token);

    try {
      const response = await client.post<T>(endpoint, payload);
      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const errorCode = (err.response?.data as any)?.detail?.APINGException?.errorCode;

        if (status === 401 || status === 403 || errorCode === "INVALID_SESSION_INFORMATION") {
          session.token = null;
          token = await authenticate();
          client = createClient(baseURL, token);
          await throttle();
          try {
            return (await client.post<T>(endpoint, payload)).data;
          } catch (retryErr) {
            if (attempt === retries) throw retryErr;
            continue;
          }
        }

        if (errorCode && NON_RETRYABLE.has(errorCode)) {
          throw err;
        }
      }

      if (attempt < retries) {
        const backoff = Math.pow(2, attempt) * 1000;
        log("WARN", `Betfair API error, retrying`, { attempt, endpoint, backoffMs: backoff });
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        throw err;
      }
    }
  }
  throw new Error("Exhausted retries");
}

const BETFAIR_MARKET_TYPE_MAP: Record<string, string> = {
  MATCH_ODDS: "MATCH_ODDS",
  DOUBLE_CHANCE: "DOUBLE_CHANCE",
  BOTH_TEAMS_TO_SCORE: "BOTH_TEAMS_TO_SCORE",
  OVER_UNDER_05: "OVER_UNDER_05",
  OVER_UNDER_15: "OVER_UNDER_15",
  OVER_UNDER_25: "OVER_UNDER_25",
  OVER_UNDER_35: "OVER_UNDER_35",
  OVER_UNDER_45: "OVER_UNDER_45",
  TOTAL_CORNERS_75: "TOTAL_CORNERS",
  TOTAL_CORNERS_85: "TOTAL_CORNERS",
  TOTAL_CORNERS_95: "TOTAL_CORNERS",
  TOTAL_CORNERS_105: "TOTAL_CORNERS",
  TOTAL_CORNERS_115: "TOTAL_CORNERS",
  TOTAL_CARDS_25: "TOTAL_CARDS",
  TOTAL_CARDS_35: "TOTAL_CARDS",
  TOTAL_CARDS_45: "TOTAL_CARDS",
  TOTAL_CARDS_55: "TOTAL_CARDS",
  TOTAL_CARDS_65: "TOTAL_CARDS",
  ASIAN_HANDICAP: "ASIAN_HANDICAP",
};

interface Runner {
  selectionId: number;
  runnerName: string;
  sortPriority: number;
}

interface MarketCatalogue {
  marketId: string;
  marketName: string;
  runners: Runner[];
  totalMatched?: number;
  description?: {
    marketTime?: string;
    marketType?: string;
  };
}

async function listMarketsForEvent(eventId: string): Promise<MarketCatalogue[]> {
  const cached = marketCache.get(eventId);
  if (cached && Date.now() - cached[0]?.fetchedAt < 10 * 60 * 1000) {
    return cached as unknown as MarketCatalogue[];
  }

  const markets = await betfairRequest<MarketCatalogue[]>("betting", "/listMarketCatalogue/", {
    filter: { eventIds: [eventId] },
    maxResults: "50",
    marketProjection: ["RUNNER_DESCRIPTION", "MARKET_DESCRIPTION"],
  });

  const cacheEntries: MarketCache[] = markets.map((m) => ({
    marketId: m.marketId,
    marketName: m.marketName,
    runners: m.runners.map((r) => ({
      selectionId: r.selectionId,
      runnerName: r.runnerName,
      sortPriority: r.sortPriority,
    })),
    fetchedAt: Date.now(),
  }));
  marketCache.set(eventId, cacheEntries);

  return markets;
}

interface MarketBook {
  marketId: string;
  status: string;
  runners: Array<{
    selectionId: number;
    status: string;
    ex: {
      availableToBack: Array<{ price: number; size: number }>;
      availableToLay: Array<{ price: number; size: number }>;
    };
    totalMatched?: number;
  }>;
  totalMatched?: number;
  totalAvailable?: number;
}

app.get("/health", async (_req, res) => {
  const uptime = process.uptime();
  const sessionValid = !!session.token && Date.now() < session.expiresAt;

  let betfairOk = false;
  try {
    if (sessionValid || (BETFAIR_APP_KEY && BETFAIR_USERNAME)) {
      await getToken();
      betfairOk = true;
    }
  } catch {
    betfairOk = false;
  }
  betfairHealthy = betfairOk;
  lastBetfairCheck = Date.now();

  res.json({
    status: betfairOk ? "healthy" : "degraded",
    uptime: Math.round(uptime),
    betfairConnected: betfairOk,
    sessionValid,
    cachedBalanceAge: cachedBalance ? Date.now() - cachedBalance.fetchedAt : null,
    cachedMarkets: marketCache.size,
    lastBetfairCheck: new Date(lastBetfairCheck).toISOString(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/balance", async (_req, res) => {
  try {
    if (cachedBalance && Date.now() - cachedBalance.fetchedAt < 5 * 60 * 1000) {
      return res.json({ ...cachedBalance, fromCache: true });
    }

    const funds = await betfairRequest<{
      availableToBetBalance: number;
      exposure: number;
    }>("account", "/getAccountFunds/", { wallet: "UK" });

    cachedBalance = {
      available: funds.availableToBetBalance,
      exposure: Math.abs(funds.exposure),
      total: funds.availableToBetBalance + Math.abs(funds.exposure),
      fetchedAt: Date.now(),
    };

    res.json({ ...cachedBalance, fromCache: false });
  } catch (err) {
    log("ERROR", "Balance fetch failed", { error: String(err) });
    if (cachedBalance) {
      return res.json({ ...cachedBalance, fromCache: true, stale: true });
    }
    res.status(500).json({ error: String(err) });
  }
});

app.get("/market/:eventId", async (req, res) => {
  try {
    const markets = await listMarketsForEvent(req.params.eventId!);
    res.json({
      eventId: req.params.eventId,
      markets: markets.map((m) => ({
        marketId: m.marketId,
        marketName: m.marketName,
        marketType: m.description?.marketType,
        runners: m.runners.map((r) => ({
          selectionId: r.selectionId,
          name: r.runnerName,
        })),
      })),
    });
  } catch (err) {
    log("ERROR", "Market listing failed", { eventId: req.params.eventId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.get("/market/:marketId/liquidity", async (req, res) => {
  try {
    const book = await betfairRequest<MarketBook[]>("betting", "/listMarketBook/", {
      marketIds: [req.params.marketId],
      priceProjection: {
        priceData: ["EX_BEST_OFFERS"],
        exBestOffersOverrides: { bestPricesDepth: 5 },
      },
    });

    if (!book || book.length === 0) {
      return res.status(404).json({ error: "Market not found" });
    }

    const market = book[0]!;
    res.json({
      marketId: market.marketId,
      status: market.status,
      totalMatched: market.totalMatched,
      totalAvailable: market.totalAvailable,
      runners: market.runners.map((r) => ({
        selectionId: r.selectionId,
        status: r.status,
        backPrices: r.ex.availableToBack,
        layPrices: r.ex.availableToLay,
        totalMatched: r.totalMatched,
      })),
    });
  } catch (err) {
    log("ERROR", "Liquidity fetch failed", { marketId: req.params.marketId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.post("/bet/place", async (req, res) => {
  const startMs = Date.now();
  try {
    const { marketId, selectionId, odds, stake, side = "BACK", persistenceType = "LAPSE" } = req.body;

    if (!marketId || !selectionId || !odds || !stake) {
      return res.status(400).json({ error: "Missing required fields: marketId, selectionId, odds, stake" });
    }

    const roundedOdds = Math.round(odds * 100) / 100;
    const roundedStake = Math.round(stake * 100) / 100;

    log("INFO", "Placing bet", { marketId, selectionId, odds: roundedOdds, stake: roundedStake, side });

    const result = await betfairRequest<{
      status: string;
      marketId: string;
      instructionReports: Array<{
        status: string;
        instruction: { limitOrder: { size: number; price: number }; selectionId: number };
        betId?: string;
        sizeMatched?: number;
        averagePriceMatched?: number;
        orderStatus?: string;
        errorCode?: string;
      }>;
      errorCode?: string;
    }>("betting", "/placeOrders/", {
      marketId,
      instructions: [
        {
          orderType: "LIMIT",
          selectionId: Number(selectionId),
          side,
          limitOrder: {
            size: roundedStake,
            price: roundedOdds,
            persistenceType,
          },
        },
      ],
    });

    const execMs = Date.now() - startMs;
    const report = result.instructionReports?.[0];

    if (result.status === "SUCCESS" && report?.status === "SUCCESS") {
      log("INFO", "Bet placed successfully", {
        betId: report.betId,
        sizeMatched: report.sizeMatched,
        avgPrice: report.averagePriceMatched,
        execMs,
      });

      if (cachedBalance) {
        cachedBalance.available -= roundedStake;
        cachedBalance.exposure += roundedStake;
      }

      res.json({
        success: true,
        betfairBetId: report.betId,
        marketId,
        status: report.orderStatus ?? "EXECUTABLE",
        sizeMatched: report.sizeMatched ?? 0,
        avgPriceMatched: report.averagePriceMatched ?? 0,
        executionMs: execMs,
      });
    } else {
      const errorCode = report?.errorCode ?? result.errorCode ?? "UNKNOWN";
      log("WARN", "Bet placement failed", { errorCode, execMs });
      res.json({
        success: false,
        error: errorCode,
        executionMs: execMs,
      });
    }
  } catch (err) {
    const execMs = Date.now() - startMs;
    log("ERROR", "Bet placement error", { error: String(err), execMs });
    res.status(500).json({ success: false, error: String(err), executionMs: execMs });
  }
});

app.get("/bet/status/:betId", async (req, res) => {
  try {
    const orders = await betfairRequest<{
      currentOrders: Array<{
        betId: string;
        marketId: string;
        selectionId: number;
        side: string;
        orderType: string;
        status: string;
        priceSize: { price: number; size: number };
        sizeMatched: number;
        sizeRemaining: number;
        sizeLapsed: number;
        sizeCancelled: number;
        sizeVoided: number;
        averagePriceMatched: number;
        placedDate: string;
      }>;
    }>("betting", "/listCurrentOrders/", {
      betIds: [req.params.betId],
    });

    const order = orders.currentOrders?.[0];
    if (!order) {
      return res.status(404).json({ error: "Bet not found in current orders" });
    }

    const totalSize = order.sizeMatched + order.sizeRemaining + order.sizeLapsed + order.sizeCancelled + order.sizeVoided;
    const fillPct = totalSize > 0 ? Math.round((order.sizeMatched / (order.sizeMatched + order.sizeRemaining)) * 100) : 0;

    res.json({
      betId: order.betId,
      marketId: order.marketId,
      selectionId: order.selectionId,
      side: order.side,
      status: order.status,
      requestedPrice: order.priceSize.price,
      requestedSize: order.priceSize.size,
      sizeMatched: order.sizeMatched,
      sizeRemaining: order.sizeRemaining,
      sizeLapsed: order.sizeLapsed,
      sizeCancelled: order.sizeCancelled,
      averagePriceMatched: order.averagePriceMatched,
      fillPct,
      placedDate: order.placedDate,
    });
  } catch (err) {
    log("ERROR", "Bet status check failed", { betId: req.params.betId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/bet/:betId", async (req, res) => {
  try {
    const statusResp = await betfairRequest<{
      currentOrders: Array<{ betId: string; marketId: string; sizeRemaining: number; status: string }>;
    }>("betting", "/listCurrentOrders/", { betIds: [req.params.betId] });

    const order = statusResp.currentOrders?.[0];
    if (!order) {
      return res.status(404).json({ error: "Bet not found" });
    }

    if (order.status !== "EXECUTABLE" || order.sizeRemaining <= 0) {
      return res.json({ cancelled: false, reason: "Order fully matched or already complete", status: order.status });
    }

    const cancelResult = await betfairRequest<{
      status: string;
      instructionReports: Array<{
        status: string;
        sizeCancelled: number;
        cancelledDate?: string;
        errorCode?: string;
      }>;
    }>("betting", "/cancelOrders/", {
      marketId: order.marketId,
      instructions: [{ betId: req.params.betId }],
    });

    const report = cancelResult.instructionReports?.[0];
    res.json({
      cancelled: report?.status === "SUCCESS",
      sizeCancelled: report?.sizeCancelled ?? 0,
      error: report?.errorCode,
    });
  } catch (err) {
    log("ERROR", "Bet cancel failed", { betId: req.params.betId, error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.get("/settlements", async (req, res) => {
  try {
    const hours = Number(req.query["hours"] ?? 48);
    const from = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const settled = await betfairRequest<{
      clearedOrders: Array<{
        betId: string;
        marketId: string;
        selectionId: number;
        side: string;
        profit: number;
        betOutcome: string;
        priceMatched: number;
        sizeSettled: number;
        settledDate: string;
      }>;
      moreAvailable: boolean;
    }>("betting", "/listClearedOrders/", {
      betStatus: "SETTLED",
      settledDateRange: { from },
      recordCount: 200,
    });

    res.json({
      orders: settled.clearedOrders ?? [],
      moreAvailable: settled.moreAvailable ?? false,
      queryHours: hours,
    });
  } catch (err) {
    log("ERROR", "Settlement fetch failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

app.post("/auth/refresh", async (_req, res) => {
  try {
    await authenticate();
    res.json({ success: true, expiresAt: new Date(session.expiresAt).toISOString() });
  } catch (err) {
    log("ERROR", "Auth refresh failed", { error: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

setInterval(async () => {
  try {
    await getToken();
    betfairHealthy = true;
  } catch {
    betfairHealthy = false;
    log("ERROR", "Betfair health check FAILED — connectivity issue");
  }
  lastBetfairCheck = Date.now();
}, 5 * 60 * 1000);

setInterval(async () => {
  try {
    const funds = await betfairRequest<{
      availableToBetBalance: number;
      exposure: number;
    }>("account", "/getAccountFunds/", { wallet: "UK" });

    cachedBalance = {
      available: funds.availableToBetBalance,
      exposure: Math.abs(funds.exposure),
      total: funds.availableToBetBalance + Math.abs(funds.exposure),
      fetchedAt: Date.now(),
    };
    log("INFO", "Balance refreshed", { available: cachedBalance.available, total: cachedBalance.total });
  } catch (err) {
    log("WARN", "Balance refresh failed", { error: String(err) });
  }
}, 5 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [eventId, markets] of marketCache) {
    if (markets[0] && now - markets[0].fetchedAt > 30 * 60 * 1000) {
      marketCache.delete(eventId);
    }
  }
}, 10 * 60 * 1000);

setInterval(async () => {
  const needsRefresh =
    session.token &&
    Date.now() - session.obtainedAt >= SESSION_REFRESH_MS;
  if (needsRefresh) {
    try {
      await authenticate();
      log("INFO", "Proactive session refresh successful");
    } catch (err) {
      log("ERROR", "Proactive session refresh failed", { error: String(err) });
    }
  }
}, SESSION_REFRESH_MS);

app.listen(PORT, "0.0.0.0", () => {
  log("INFO", `VPS Relay started on port ${PORT}`);
  log("INFO", `Betfair credentials ${BETFAIR_APP_KEY ? "configured" : "MISSING"}`);
  log("INFO", `Relay secret ${RELAY_SECRET ? "configured" : "NOT SET — open access"}`);

  if (BETFAIR_APP_KEY && BETFAIR_USERNAME) {
    void authenticate()
      .then(() => log("INFO", "Initial Betfair authentication successful"))
      .catch((err) => log("WARN", "Initial authentication failed — will retry on first request", { error: String(err) }));
  }
});
