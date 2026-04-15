import { db, tournamentConfigTable, competitionConfigTable, matchesTable } from "@workspace/db";
import { eq, sql, and, gte, lte, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

const WORLD_CUP_LEAGUE_ID = 1;
const WCQ_LEAGUE_IDS = [15, 29, 31, 33, 30, 34];
const INTERNATIONAL_LEAGUE_IDS = [1, 5, 6, 7, 8, 9, 10, 11, 15, 22, 29, 30, 31, 33, 34, 480, 523, 530, 666, 848, 880, 960, 1082, 1083, 1084, 1085, 1086];
const FRIENDLY_LEAGUE_IDS = [10, 22, 666];

export type SeasonalPhase = "active" | "off_season" | "pre_season" | "playoff" | "unknown";
export type CompetitionType = "league" | "cup" | "world_cup" | "continental" | "qualifier" | "friendly" | "international";

export interface TournamentStatus {
  activeTournaments: Array<{
    id: number;
    name: string;
    type: string;
    startDate: string | null;
    endDate: string | null;
    daysUntilStart: number | null;
    isLive: boolean;
    pollingMultiplier: number;
    softLineNationCount: number;
  }>;
  worldCup2026: {
    daysUntilStart: number;
    qualifiersActive: boolean;
    dataReadiness: {
      qualificationFixturesIngested: number;
      softLineNationsTracked: number;
      friendliesTracked: number;
      pinnacleQualifierCoverage: boolean;
    };
    phase: "preparation" | "pre_tournament" | "live" | "post_tournament";
  };
  seasonalWarnings: Array<{
    league: string;
    phase: SeasonalPhase;
    message: string;
  }>;
  isAnyTournamentActive: boolean;
}

let tournamentConfigCache: Array<typeof tournamentConfigTable.$inferSelect> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 300_000;

async function loadTournamentConfigs() {
  if (tournamentConfigCache && Date.now() - cacheLoadedAt < CACHE_TTL) {
    return tournamentConfigCache;
  }
  try {
    tournamentConfigCache = await db.select().from(tournamentConfigTable);
    cacheLoadedAt = Date.now();
  } catch {
    if (!tournamentConfigCache) tournamentConfigCache = [];
  }
  return tournamentConfigCache;
}

export function classifyCompetitionType(leagueId: number, leagueName: string, apiType: string): CompetitionType {
  if (leagueId === WORLD_CUP_LEAGUE_ID || leagueId === 8) return "world_cup";
  if (WCQ_LEAGUE_IDS.includes(leagueId) || [32, 35, 36, 37, 38].includes(leagueId)) return "qualifier";
  if (FRIENDLY_LEAGUE_IDS.includes(leagueId)) return "friendly";

  const name = leagueName.toLowerCase();
  if (name.includes("world cup")) return "world_cup";
  if (name.includes("qualifier") || name.includes("qualif")) return "qualifier";
  if (name.includes("friendl")) return "friendly";
  if (name.includes("nations league") || name.includes("euro") || name.includes("copa america") ||
      name.includes("gold cup") || name.includes("africa cup") || name.includes("asian cup") ||
      name.includes("olympic")) return "continental";
  if (INTERNATIONAL_LEAGUE_IDS.includes(leagueId)) return "international";
  if (apiType === "Cup") return "cup";
  return "league";
}

export function detectSeasonalPhase(
  seasonStart: string | null,
  seasonEnd: string | null,
  leagueName: string,
): SeasonalPhase {
  if (!seasonStart || !seasonEnd) return "unknown";

  const now = new Date();
  const currentMonth = now.getUTCMonth() + 1;
  const currentDay = now.getUTCDate();

  const [startMonth, startDay] = parseMonthDay(seasonStart);
  const [endMonth, endDay] = parseMonthDay(seasonEnd);

  if (startMonth === 0 || endMonth === 0) return "unknown";

  const name = leagueName.toLowerCase();
  const isWinterLeague = startMonth >= 7 && endMonth <= 6;
  const isSummerLeague = startMonth >= 1 && startMonth <= 4 && endMonth >= 10;

  const currentDoy = currentMonth * 31 + currentDay;
  const startDoy = startMonth * 31 + startDay;
  const endDoy = endMonth * 31 + endDay;

  if (isWinterLeague) {
    if (currentDoy >= startDoy || currentDoy <= endDoy) {
      if (currentMonth >= endMonth - 1 && currentDay >= 15) {
        if (name.includes("premier") || name.includes("liga") || name.includes("serie") ||
            name.includes("bundesliga") || name.includes("ligue")) {
          return "playoff";
        }
      }
      return "active";
    }
    const preSeasonStart = startMonth - 1;
    if (currentMonth >= preSeasonStart && currentMonth < startMonth) return "pre_season";
    return "off_season";
  }

  if (isSummerLeague) {
    if (currentDoy >= startDoy && currentDoy <= endDoy) return "active";
    const preSeasonStart = startMonth - 1;
    if (currentMonth >= preSeasonStart && currentMonth < startMonth) return "pre_season";
    return "off_season";
  }

  if (currentDoy >= startDoy && currentDoy <= endDoy) return "active";
  return "off_season";
}

function parseMonthDay(dateStr: string): [number, number] {
  const parts = dateStr.split("-");
  if (parts.length >= 3) {
    return [parseInt(parts[1]!, 10), parseInt(parts[2]!, 10)];
  }
  if (parts.length === 2) {
    return [parseInt(parts[0]!, 10), parseInt(parts[1]!, 10)];
  }
  const monthNum = parseInt(dateStr, 10);
  if (!isNaN(monthNum)) return [monthNum, 1];
  return [0, 0];
}

export function isFriendlyMatch(leagueId: number, leagueName: string): boolean {
  if (FRIENDLY_LEAGUE_IDS.includes(leagueId)) return true;
  const name = leagueName.toLowerCase();
  return name.includes("friendl") || name.includes("amical");
}

export function isInternationalMatch(leagueId: number): boolean {
  return INTERNATIONAL_LEAGUE_IDS.includes(leagueId);
}

export function isWorldCupRelated(leagueId: number): boolean {
  return leagueId === WORLD_CUP_LEAGUE_ID || WCQ_LEAGUE_IDS.includes(leagueId);
}

export async function isSoftLineNation(team: string): Promise<boolean> {
  const configs = await loadTournamentConfigs();
  const teamLower = team.toLowerCase();
  for (const config of configs) {
    const nations = (config.softLineNations as string[]) ?? [];
    if (nations.some(n => n.toLowerCase() === teamLower)) return true;
  }
  return false;
}

export async function getSoftLineBonus(
  homeTeam: string,
  awayTeam: string,
  leagueId: number,
  kickoffTime: Date,
): Promise<{ bonus: number; reason: string | null }> {
  if (!isInternationalMatch(leagueId)) return { bonus: 0, reason: null };

  const configs = await loadTournamentConfigs();
  let maxBonus = 0;
  let reason: string | null = null;

  for (const config of configs) {
    const nations = (config.softLineNations as string[]) ?? [];
    if (nations.length === 0) continue;

    const homeSoft = nations.some(n => n.toLowerCase() === homeTeam.toLowerCase());
    const awaySoft = nations.some(n => n.toLowerCase() === awayTeam.toLowerCase());

    if (!homeSoft && !awaySoft) continue;

    let bonus = 0;

    if (homeSoft && awaySoft) {
      bonus = 12;
      reason = `Both teams (${homeTeam}, ${awayTeam}) are soft-line nations in ${config.tournamentName}`;
    } else if (homeSoft || awaySoft) {
      bonus = 8;
      const softTeam = homeSoft ? homeTeam : awayTeam;
      reason = `${softTeam} is a soft-line nation in ${config.tournamentName}`;
    }

    if (config.startDate && config.endDate) {
      const start = new Date(config.startDate);
      const end = new Date(config.endDate);
      const now = new Date();
      const daysUntil = Math.ceil((start.getTime() - now.getTime()) / 86400000);

      if (now >= start && now <= end) {
        bonus = Math.round(bonus * 1.5);
        reason = `[TOURNAMENT LIVE] ${reason}`;
      } else if (daysUntil > 0 && daysUntil <= 30) {
        bonus = Math.round(bonus * 1.2);
        reason = `[PRE-TOURNAMENT] ${reason}`;
      }
    }

    if (isWorldCupRelated(leagueId) && config.tournamentType === "qualifier") {
      const hoursToKick = (kickoffTime.getTime() - Date.now()) / 3600000;
      if (hoursToKick > 0 && hoursToKick <= 72) {
        bonus += 3;
        reason = `${reason} — early market window (<72h)`;
      }
    }

    if (bonus > maxBonus) maxBonus = bonus;
  }

  return { bonus: Math.min(maxBonus, 20), reason };
}

export function getInternationalModelAdjustments(leagueId: number): {
  formWeightMultiplier: number;
  homeAdvantageReduced: boolean;
  uncertaintyFactor: number;
} {
  if (isFriendlyMatch(leagueId, "")) {
    return { formWeightMultiplier: 0.5, homeAdvantageReduced: true, uncertaintyFactor: 1.3 };
  }

  if (leagueId === WORLD_CUP_LEAGUE_ID) {
    return { formWeightMultiplier: 0.7, homeAdvantageReduced: true, uncertaintyFactor: 1.15 };
  }

  if (WCQ_LEAGUE_IDS.includes(leagueId)) {
    return { formWeightMultiplier: 0.8, homeAdvantageReduced: false, uncertaintyFactor: 1.1 };
  }

  if (INTERNATIONAL_LEAGUE_IDS.includes(leagueId)) {
    return { formWeightMultiplier: 0.75, homeAdvantageReduced: true, uncertaintyFactor: 1.12 };
  }

  return { formWeightMultiplier: 1.0, homeAdvantageReduced: false, uncertaintyFactor: 1.0 };
}

export function shouldBlockBet(
  leagueId: number,
  leagueName: string,
  seasonalPhase: SeasonalPhase,
): { blocked: boolean; reason: string | null } {
  if (isFriendlyMatch(leagueId, leagueName)) {
    return { blocked: true, reason: "Friendly match — low confidence, no betting" };
  }

  if (seasonalPhase === "pre_season") {
    return { blocked: true, reason: "Pre-season match — unreliable form data" };
  }

  return { blocked: false, reason: null };
}

export function getSeasonalAdjustment(phase: SeasonalPhase): {
  confidenceMultiplier: number;
  note: string | null;
} {
  switch (phase) {
    case "playoff":
      return { confidenceMultiplier: 0.9, note: "Playoff/relegation phase — increased unpredictability" };
    case "off_season":
      return { confidenceMultiplier: 0.0, note: "Off-season — no fixtures expected" };
    case "pre_season":
      return { confidenceMultiplier: 0.0, note: "Pre-season — blocked" };
    default:
      return { confidenceMultiplier: 1.0, note: null };
  }
}

export function isTransferWindowActive(): boolean {
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  return (month === 7 || month === 8 || (month === 1 && day >= 1 && day <= 31) || (month === 2 && day <= 3));
}

export function getTransferWindowUncertainty(): { multiplier: number; note: string | null } {
  if (!isTransferWindowActive()) return { multiplier: 1.0, note: null };
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  if (month === 7 || month === 8) {
    return { multiplier: 0.85, note: "Summer transfer window — squad changes increase uncertainty" };
  }
  return { multiplier: 0.9, note: "January transfer window — mid-season squad changes" };
}

export async function getTournamentStatus(): Promise<TournamentStatus> {
  const configs = await loadTournamentConfigs();
  const now = new Date();

  const WC_START = new Date("2026-06-11T00:00:00Z");
  const WC_END = new Date("2026-07-19T00:00:00Z");
  const daysUntilWC = Math.ceil((WC_START.getTime() - now.getTime()) / 86400000);

  let wcPhase: "preparation" | "pre_tournament" | "live" | "post_tournament";
  if (now > WC_END) wcPhase = "post_tournament";
  else if (now >= WC_START) wcPhase = "live";
  else if (daysUntilWC <= 30) wcPhase = "pre_tournament";
  else wcPhase = "preparation";

  const activeTournaments = configs
    .filter(c => {
      if (c.isActive) return true;
      if (c.startDate && c.endDate) {
        return now >= new Date(c.startDate) && now <= new Date(c.endDate);
      }
      return false;
    })
    .map(c => {
      const start = c.startDate ? new Date(c.startDate) : null;
      const end = c.endDate ? new Date(c.endDate) : null;
      const daysUntil = start ? Math.ceil((start.getTime() - now.getTime()) / 86400000) : null;
      const isLive = start && end ? (now >= start && now <= end) : false;
      return {
        id: c.tournamentId,
        name: c.tournamentName,
        type: c.tournamentType,
        startDate: c.startDate?.toISOString() ?? null,
        endDate: c.endDate?.toISOString() ?? null,
        daysUntilStart: daysUntil,
        isLive,
        pollingMultiplier: c.pollingMultiplier,
        softLineNationCount: ((c.softLineNations as string[]) ?? []).length,
      };
    });

  let qualFixtures = 0;
  let friendliesTracked = 0;
  let softLineNationsTracked = 0;
  try {
    const [qualRows] = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(matchesTable)
      .where(sql`${matchesTable.league} ILIKE '%World Cup%Qualif%' OR ${matchesTable.league} ILIKE '%WCQ%'`);
    qualFixtures = Number(qualRows?.cnt ?? 0);

    const [friendlyRows] = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(matchesTable)
      .where(sql`${matchesTable.league} ILIKE '%Friendl%'`);
    friendliesTracked = Number(friendlyRows?.cnt ?? 0);

    const wcConfig = configs.find(c => c.tournamentId === WORLD_CUP_LEAGUE_ID);
    softLineNationsTracked = ((wcConfig?.softLineNations as string[]) ?? []).length;
  } catch (err) {
    logger.debug({ err }, "Tournament status data query failed");
  }

  const seasonalWarnings: TournamentStatus["seasonalWarnings"] = [];
  if (isTransferWindowActive()) {
    seasonalWarnings.push({
      league: "ALL",
      phase: "active" as SeasonalPhase,
      message: getTransferWindowUncertainty().note!,
    });
  }

  return {
    activeTournaments,
    worldCup2026: {
      daysUntilStart: Math.max(0, daysUntilWC),
      qualifiersActive: configs.some(c => WCQ_LEAGUE_IDS.includes(c.tournamentId) && c.isActive),
      dataReadiness: {
        qualificationFixturesIngested: qualFixtures,
        softLineNationsTracked,
        friendliesTracked,
        pinnacleQualifierCoverage: false,
      },
      phase: wcPhase,
    },
    seasonalWarnings,
    isAnyTournamentActive: activeTournaments.some(t => t.isLive),
  };
}

export async function getPollingMultiplier(leagueId: number): Promise<number> {
  const configs = await loadTournamentConfigs();
  const match = configs.find(c => c.tournamentId === leagueId);
  if (match) return match.pollingMultiplier;

  if (INTERNATIONAL_LEAGUE_IDS.includes(leagueId)) return 1.5;
  return 1.0;
}
