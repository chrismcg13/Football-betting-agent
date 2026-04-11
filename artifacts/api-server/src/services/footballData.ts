import axios from "axios";
import { logger } from "../lib/logger";

const BASE_URL = "https://api.football-data.org/v4";

// Reduced throttle — was 6100ms (10/min limit on old plan)
// Keep a small delay to be respectful; football-data.org secondary source
const REQUEST_INTERVAL_MS = 1000;

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

function getClient() {
  const apiKey = process.env["FOOTBALL_DATA_API_KEY"];
  if (!apiKey) {
    throw new Error("FOOTBALL_DATA_API_KEY is not set");
  }
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      "X-Auth-Token": apiKey,
    },
  });
}

export interface FDCompetition {
  id: number;
  name: string;
  code: string;
  area: { name: string; code: string };
}

export interface FDTeam {
  id: number;
  name: string;
  shortName: string;
  tla: string;
}

export interface FDMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  homeTeam: FDTeam;
  awayTeam: FDTeam;
  competition: FDCompetition;
  score: {
    winner: string | null;
    fullTime: { home: number | null; away: number | null };
    halfTime: { home: number | null; away: number | null };
  };
  odds?: {
    homeWin: number | null;
    draw: number | null;
    awayWin: number | null;
  };
}

export interface FDStandingEntry {
  position: number;
  team: FDTeam;
  playedGames: number;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
}

export interface FDStandings {
  competition: FDCompetition;
  standings: Array<{
    stage: string;
    type: string;
    table: FDStandingEntry[];
  }>;
}

export interface FDHeadToHead {
  numberOfMatches: number;
  homeTeam: { wins: number; draws: number; losses: number };
  awayTeam: { wins: number; draws: number; losses: number };
  matches: FDMatch[];
}

// Tier 1 competitions (usually available on most plans)
const TIER1_COMPETITIONS = [
  "PL",   // Premier League
  "BL1",  // Bundesliga
  "SA",   // Serie A
  "PD",   // Primera Division
  "FL1",  // Ligue 1
  "CL",   // Champions League
  "EL",   // Europa League
  "PPL",  // Primeira Liga
  "BSA",  // Brasileirão
];

// Tier 2 competitions (may 403 on free plan — handled gracefully)
const TIER2_COMPETITIONS = [
  "ELC",  // Championship
  "DED",  // Eredivisie
  "FL2",  // Ligue 2
  "BL2",  // 2. Bundesliga
  "SB",   // Serie B
  "SD",   // Segunda División
  "SPL",  // Scottish Premier League
  "PPL2", // Primeira Liga 2
];

export const INGESTION_COMPETITIONS = [...TIER1_COMPETITIONS, ...TIER2_COMPETITIONS];

export const FEATURE_COMPETITIONS = [...TIER1_COMPETITIONS, "ELC", "DED"];

export async function getCompetitions(): Promise<FDCompetition[]> {
  const client = getClient();
  await throttle();
  const response = await client.get<{ competitions: FDCompetition[] }>(
    "/competitions",
  );
  return response.data.competitions ?? [];
}

export async function getStandings(
  competitionCode: string,
): Promise<FDStandingEntry[]> {
  const client = getClient();
  await throttle();
  try {
    const response = await client.get<FDStandings>(
      `/competitions/${competitionCode}/standings`,
    );
    const total = response.data.standings.find((s) => s.type === "TOTAL");
    return total?.table ?? [];
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 403 || err.response?.status === 404)) {
      logger.debug({ competitionCode }, "Standings not available in current plan");
      return [];
    }
    throw err;
  }
}

export async function getTeamMatches(
  teamId: number,
  limit = 20,
): Promise<FDMatch[]> {
  const client = getClient();
  await throttle();
  try {
    const response = await client.get<{ matches: FDMatch[] }>(
      `/teams/${teamId}/matches`,
      {
        params: {
          status: "FINISHED",
          limit,
        },
      },
    );
    return response.data.matches ?? [];
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return [];
    }
    throw err;
  }
}

export async function getHeadToHead(matchId: number): Promise<FDHeadToHead | null> {
  const client = getClient();
  await throttle();
  try {
    const response = await client.get<{ head2head: FDHeadToHead }>(
      `/matches/${matchId}/head2head`,
      { params: { limit: 20 } },
    );
    return response.data.head2head ?? null;
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 403)) {
      return null;
    }
    throw err;
  }
}

export async function listUpcomingMatches(daysAhead = 7): Promise<FDMatch[]> {
  const client = getClient();
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + daysAhead);

  const dateFrom = from.toISOString().slice(0, 10);
  const dateTo = to.toISOString().slice(0, 10);

  const allMatches: FDMatch[] = [];

  for (const competitionCode of INGESTION_COMPETITIONS) {
    try {
      await throttle();
      const response = await client.get<{
        matches: FDMatch[];
        resultSet: { count: number };
      }>(`/competitions/${competitionCode}/matches`, {
        params: {
          dateFrom,
          dateTo,
          status: "SCHEDULED,TIMED",
        },
      });

      if (response.data.matches?.length > 0) {
        allMatches.push(...response.data.matches);
        logger.info(
          { competition: competitionCode, count: response.data.matches.length },
          "Fetched matches from football-data.org",
        );
      }
    } catch (err: unknown) {
      if (
        axios.isAxiosError(err) &&
        (err.response?.status === 403 || err.response?.status === 404)
      ) {
        logger.debug(
          { competition: competitionCode },
          "Competition not available in current plan",
        );
      } else {
        logger.warn(
          { err, competition: competitionCode },
          "Error fetching competition matches",
        );
      }
    }
  }

  return allMatches;
}

export interface FDOdds {
  matchId: number;
  homeWin: number | null;
  draw: number | null;
  awayWin: number | null;
  source: "football_data";
}

export function extractOddsFromMatch(match: FDMatch): FDOdds | null {
  if (!match.odds) return null;
  const { homeWin, draw, awayWin } = match.odds;
  if (!homeWin && !draw && !awayWin) return null;

  return {
    matchId: match.id,
    homeWin: homeWin ?? null,
    draw: draw ?? null,
    awayWin: awayWin ?? null,
    source: "football_data",
  };
}

export async function getHistoricalCompetitionMatches(
  competitionCode: string,
  season: number,
): Promise<FDMatch[]> {
  const client = getClient();
  await throttle();
  try {
    const response = await client.get<{ matches: FDMatch[] }>(
      `/competitions/${competitionCode}/matches`,
      { params: { season, status: "FINISHED" } },
    );
    return response.data.matches ?? [];
  } catch (err) {
    if (
      axios.isAxiosError(err) &&
      (err.response?.status === 403 || err.response?.status === 404)
    ) {
      logger.debug(
        { competitionCode, season },
        "Historical matches not available in current plan",
      );
      return [];
    }
    throw err;
  }
}

export function mapMatchStatus(
  fdStatus: string,
): "scheduled" | "live" | "finished" {
  switch (fdStatus) {
    case "SCHEDULED":
    case "TIMED":
      return "scheduled";
    case "IN_PLAY":
    case "PAUSED":
      return "live";
    case "FINISHED":
    case "AWARDED":
      return "finished";
    default:
      return "scheduled";
  }
}
