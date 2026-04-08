import axios from "axios";
import { logger } from "../lib/logger";

const BASE_URL = "https://api.football-data.org/v4";

const MAX_RPS = 10;
const REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_RPS);

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

const TRACKED_COMPETITIONS = [
  "PL",
  "BL1",
  "SA",
  "PD",
  "FL1",
  "CL",
  "EL",
  "EC",
  "WC",
  "PPL",
  "BSA",
];

export async function listUpcomingMatches(daysAhead = 7): Promise<FDMatch[]> {
  const client = getClient();
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + daysAhead);

  const dateFrom = from.toISOString().slice(0, 10);
  const dateTo = to.toISOString().slice(0, 10);

  const allMatches: FDMatch[] = [];

  for (const competitionCode of TRACKED_COMPETITIONS) {
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
          {
            competition: competitionCode,
            count: response.data.matches.length,
          },
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
