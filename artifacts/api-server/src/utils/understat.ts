import { logger } from "../lib/logger";

export interface MatchXGData {
  id: string;
  home_team: string;
  away_team: string;
  home_xG: number;
  away_xG: number;
  home_goals: number;
  away_goals: number;
  datetime: string;
  isResult: boolean;
}

export const LEAGUE_MAP: Record<string, string> = {
  EPL: "EPL",
  Bundesliga: "Bundesliga",
  "La Liga": "La_liga",
  "Serie A": "Serie_A",
  "Ligue 1": "Ligue_1",
  La_liga: "La_liga",
  Serie_A: "Serie_A",
  Ligue_1: "Ligue_1",
};

function decodeUnderstatJson(raw: string): string {
  return raw
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

export async function fetchUnderstatLeagueData(
  league: string,
  year: number,
): Promise<MatchXGData[]> {
  const slug = LEAGUE_MAP[league] ?? league;
  const url = `https://understat.com/league/${slug}/${year}`;

  try {
    logger.info({ league, year, url }, "Fetching Understat league data");

    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; BettingAgent/1.0; research purposes)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      logger.warn(
        { league, year, status: resp.status },
        "Understat returned non-200 status",
      );
      return [];
    }

    const html = await resp.text();

    const match = html.match(/var datesData\s*=\s*JSON\.parse\('(.+?)'\)/);
    if (!match) {
      logger.warn({ league, year }, "Could not find datesData variable in Understat HTML");
      return [];
    }

    const decoded = decodeUnderstatJson(match[1]);
    type UnderstatRawMatch = {
      id?: unknown;
      h?: { title?: unknown };
      a?: { title?: unknown };
      home_team?: unknown;
      away_team?: unknown;
      xG?: { h?: unknown; a?: unknown };
      home_xG?: unknown;
      away_xG?: unknown;
      goals?: { h?: unknown; a?: unknown };
      home_goals?: unknown;
      away_goals?: unknown;
      datetime?: unknown;
      isResult?: unknown;
    };
    const parsed = JSON.parse(decoded) as UnderstatRawMatch[];

    return parsed.map((m) => ({
      id: String(m.id ?? ""),
      home_team: String(m.h?.title ?? m.home_team ?? ""),
      away_team: String(m.a?.title ?? m.away_team ?? ""),
      home_xG: parseFloat(String(m.xG?.h ?? m.home_xG ?? 0)),
      away_xG: parseFloat(String(m.xG?.a ?? m.away_xG ?? 0)),
      home_goals: parseInt(String(m.goals?.h ?? m.home_goals ?? 0), 10),
      away_goals: parseInt(String(m.goals?.a ?? m.away_goals ?? 0), 10),
      datetime: String(m.datetime ?? ""),
      isResult: Boolean(m.isResult),
    }));
  } catch (err) {
    logger.warn({ err, league, year }, "Understat fetch failed — skipping");
    return [];
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
