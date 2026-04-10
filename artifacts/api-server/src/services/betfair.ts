import axios, { type AxiosInstance } from "axios";
import { logger } from "../lib/logger";

const BETFAIR_IDENTITY_BASE = process.env["BETFAIR_IDENTITY_PROXY_URL"] ?? "https://identitysso.betfair.com";
const IDENTITY_URL = `${BETFAIR_IDENTITY_BASE}/api/login`;
const BETFAIR_PROXY_URL = process.env["BETFAIR_PROXY_URL"] ?? "https://api.betfair.com";
const BETTING_BASE = `${BETFAIR_PROXY_URL}/exchange/betting/rest/v1.0`;
const SOCCER_EVENT_TYPE_ID = "1";

const MAX_RPS = 5;
const REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_RPS);

export const MARKET_TYPES = [
  "MATCH_ODDS",
  "OVER_UNDER_25",
  "OVER_UNDER_15",
  "OVER_UNDER_35",
  "BOTH_TEAMS_TO_SCORE",
  "CORRECT_SCORE",
  "ASIAN_HANDICAP",
] as const;

export type MarketType = (typeof MARKET_TYPES)[number];

interface SessionState {
  token: string | null;
  expiresAt: number;
}

const session: SessionState = {
  token: null,
  expiresAt: 0,
};

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

async function login(): Promise<string> {
  const appKey = process.env["BETFAIR_APP_KEY"];
  const username = process.env["BETFAIR_USERNAME"];
  const password = process.env["BETFAIR_PASSWORD"];

  if (!appKey || !username || !password) {
    throw new Error(
      "BETFAIR_APP_KEY, BETFAIR_USERNAME, and BETFAIR_PASSWORD must all be set",
    );
  }

  logger.info("Authenticating with Betfair...");

  const params = new URLSearchParams();
  params.set("username", username);
  params.set("password", password);

  const response = await axios.post(IDENTITY_URL, params.toString(), {
    headers: {
      "X-Application": appKey,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
  });

  const data = response.data as {
    status: string;
    token?: string;
    error?: string;
  };

  if (data.status !== "SUCCESS" || !data.token) {
    throw new Error(
      `Betfair login failed: ${data.error ?? data.status}`,
    );
  }

  logger.info("Betfair authentication successful");

  session.token = data.token;
  session.expiresAt = Date.now() + 7 * 60 * 60 * 1000;

  return data.token;
}

async function getSessionToken(): Promise<string> {
  if (!session.token || Date.now() >= session.expiresAt) {
    return login();
  }
  return session.token;
}

function createBettingClient(appKey: string, token: string): AxiosInstance {
  return axios.create({
    baseURL: BETTING_BASE,
    headers: {
      "X-Application": appKey,
      "X-Authentication": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

async function bettingRequest<T>(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<T> {
  await throttle();

  const appKey = process.env["BETFAIR_APP_KEY"]!;
  let token = await getSessionToken();
  let client = createBettingClient(appKey, token);

  try {
    const response = await client.post<T>(endpoint, payload);
    return response.data;
  } catch (err: unknown) {
    const status =
      axios.isAxiosError(err) ? err.response?.status : undefined;

    if (status === 401 || status === 403) {
      logger.warn("Betfair session expired, re-authenticating...");
      session.token = null;
      token = await login();
      client = createBettingClient(appKey, token);
      await throttle();
      const response = await client.post<T>(endpoint, payload);
      return response.data;
    }

    throw err;
  }
}

export interface EventType {
  eventType: { id: string; name: string };
  marketCount: number;
}

export async function listEventTypes(): Promise<EventType[]> {
  return bettingRequest<EventType[]>("/listEventTypes/", {
    filter: {},
    locale: "en",
  });
}

export interface Competition {
  competition: { id: string; name: string };
  marketCount: number;
  competitionRegion: string;
}

export async function listCompetitions(
  eventTypeId: string = SOCCER_EVENT_TYPE_ID,
): Promise<Competition[]> {
  return bettingRequest<Competition[]>("/listCompetitions/", {
    filter: {
      eventTypeIds: [eventTypeId],
    },
    locale: "en",
  });
}

export interface BetfairEvent {
  event: {
    id: string;
    name: string;
    countryCode?: string;
    timezone?: string;
    venue?: string;
    openDate?: string;
  };
  marketCount: number;
}

export async function listEvents(
  competitionIds: string[],
  from: Date,
  to: Date,
): Promise<BetfairEvent[]> {
  return bettingRequest<BetfairEvent[]>("/listEvents/", {
    filter: {
      eventTypeIds: [SOCCER_EVENT_TYPE_ID],
      competitionIds,
      marketStartTime: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    },
    locale: "en",
  });
}

export interface MarketCatalogueItem {
  marketId: string;
  marketName: string;
  marketStartTime?: string;
  event: { id: string; name: string };
  runners?: Array<{ selectionId: number; runnerName: string; sortPriority: number }>;
  description?: { marketType: string };
}

export async function listMarketCatalogue(
  eventIds: string[],
  marketTypes: string[] = [...MARKET_TYPES],
): Promise<MarketCatalogueItem[]> {
  return bettingRequest<MarketCatalogueItem[]>("/listMarketCatalogue/", {
    filter: {
      eventTypeIds: [SOCCER_EVENT_TYPE_ID],
      eventIds,
      marketTypeCodes: marketTypes,
    },
    marketProjection: ["EVENT", "MARKET_START_TIME", "RUNNER_DESCRIPTION", "MARKET_DESCRIPTION"],
    maxResults: 200,
    locale: "en",
  });
}

export interface RunnerBook {
  selectionId: number;
  status: string;
  lastPriceTraded?: number;
  ex?: {
    availableToBack?: Array<{ price: number; size: number }>;
    availableToLay?: Array<{ price: number; size: number }>;
  };
}

export interface MarketBook {
  marketId: string;
  status: string;
  inplay: boolean;
  totalMatched?: number;
  runners: RunnerBook[];
}

export async function listMarketBook(
  marketIds: string[],
): Promise<MarketBook[]> {
  const CHUNK_SIZE = 40;
  const results: MarketBook[] = [];

  for (let i = 0; i < marketIds.length; i += CHUNK_SIZE) {
    const chunk = marketIds.slice(i, i + CHUNK_SIZE);
    const response = await bettingRequest<MarketBook[]>("/listMarketBook/", {
      marketIds: chunk,
      priceProjection: {
        priceData: ["EX_BEST_OFFERS"],
        exBestOffersOverrides: {
          bestPricesDepth: 1,
          rollupModel: "STAKE",
          rollupLimit: 10,
        },
      },
    });
    results.push(...response);
  }

  return results;
}

export { login, getSessionToken, SOCCER_EVENT_TYPE_ID };
