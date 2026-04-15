import { db, paperBetsTable, matchesTable, learningNarrativesTable } from "@workspace/db";
import { sql, and, gte, lte, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

export type RegimeType =
  | "mid_season"
  | "end_of_season"
  | "international_break"
  | "transfer_window"
  | "major_tournament"
  | "pre_season"
  | "normal";

export interface MarketRegime {
  current: RegimeType;
  confidenceMultiplier: number;
  stakeMultiplier: number;
  description: string;
  detectedAt: string;
  factors: string[];
}

interface SeasonalPattern {
  month: number;
  dayRange?: [number, number];
  regime: RegimeType;
  confidenceMultiplier: number;
  stakeMultiplier: number;
  description: string;
}

const SEASONAL_PATTERNS: SeasonalPattern[] = [
  { month: 6, regime: "major_tournament", confidenceMultiplier: 0.7, stakeMultiplier: 0.8, description: "Major tournament period (World Cup 2026 / Euros) — different dynamics, reduced domestic data" },
  { month: 7, regime: "major_tournament", confidenceMultiplier: 0.7, stakeMultiplier: 0.8, description: "Major tournament / transfer window — market uncertainty" },
  { month: 7, dayRange: [15, 31], regime: "pre_season", confidenceMultiplier: 0.6, stakeMultiplier: 0.7, description: "Pre-season friendlies — limited predictive value, squad changes" },
  { month: 8, dayRange: [1, 15], regime: "pre_season", confidenceMultiplier: 0.7, stakeMultiplier: 0.8, description: "Season start — limited current-season data, new signings integrating" },
  { month: 1, dayRange: [1, 31], regime: "transfer_window", confidenceMultiplier: 0.85, stakeMultiplier: 0.9, description: "January transfer window — squad changes affecting team quality" },
  { month: 5, dayRange: [10, 31], regime: "end_of_season", confidenceMultiplier: 0.8, stakeMultiplier: 0.85, description: "End of season — motivation varies (relegation battles vs dead rubbers)" },
];

const INTERNATIONAL_BREAK_WINDOWS_2026 = [
  { start: "2026-03-23", end: "2026-03-31", label: "March international break" },
  { start: "2026-06-01", end: "2026-07-20", label: "World Cup 2026" },
  { start: "2026-09-07", end: "2026-09-15", label: "September international break" },
  { start: "2026-10-12", end: "2026-10-14", label: "October international break" },
  { start: "2026-11-16", end: "2026-11-18", label: "November international break" },
];

function detectInternationalBreak(date: Date): { active: boolean; label: string | null } {
  const dateStr = date.toISOString().slice(0, 10);
  for (const window of INTERNATIONAL_BREAK_WINDOWS_2026) {
    if (dateStr >= window.start && dateStr <= window.end) {
      return { active: true, label: window.label };
    }
  }
  return { active: false, label: null };
}

function detectSeasonalPattern(date: Date): SeasonalPattern | null {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  for (const pattern of SEASONAL_PATTERNS) {
    if (pattern.month === month) {
      if (pattern.dayRange) {
        if (day >= pattern.dayRange[0] && day <= pattern.dayRange[1]) {
          return pattern;
        }
      } else {
        return pattern;
      }
    }
  }
  return null;
}

async function detectFixtureVolumeAnomaly(): Promise<{ anomaly: boolean; reason: string | null; multiplier: number }> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000);

  const [thisWeek] = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM matches
    WHERE kickoff_time >= ${weekAgo} AND kickoff_time < ${now}
  `).then(r => r.rows as Record<string, unknown>[]);

  const [lastWeek] = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM matches
    WHERE kickoff_time >= ${twoWeeksAgo} AND kickoff_time < ${weekAgo}
  `).then(r => r.rows as Record<string, unknown>[]);

  const thisCount = Number(thisWeek?.cnt ?? 0);
  const lastCount = Number(lastWeek?.cnt ?? 0);

  if (lastCount > 0 && thisCount < lastCount * 0.4) {
    return {
      anomaly: true,
      reason: `Fixture volume dropped ${Math.round((1 - thisCount / lastCount) * 100)}% (${thisCount} vs ${lastCount} last week) — possible international break`,
      multiplier: 0.85,
    };
  }

  return { anomaly: false, reason: null, multiplier: 1.0 };
}

export async function detectCurrentRegime(): Promise<MarketRegime> {
  const now = new Date();
  const factors: string[] = [];

  const intBreak = detectInternationalBreak(now);
  if (intBreak.active) {
    factors.push(`International break: ${intBreak.label}`);
    return {
      current: "international_break",
      confidenceMultiplier: 0.75,
      stakeMultiplier: 0.8,
      description: `${intBreak.label} — reduced domestic fixture volume, different team compositions`,
      detectedAt: now.toISOString(),
      factors,
    };
  }

  const seasonal = detectSeasonalPattern(now);
  if (seasonal) {
    factors.push(`Seasonal: ${seasonal.description}`);
  }

  const volumeCheck = await detectFixtureVolumeAnomaly();
  if (volumeCheck.anomaly) {
    factors.push(`Volume: ${volumeCheck.reason}`);
  }

  if (seasonal) {
    const combinedConfidence = seasonal.confidenceMultiplier * (volumeCheck.anomaly ? volumeCheck.multiplier : 1.0);
    const combinedStake = seasonal.stakeMultiplier * (volumeCheck.anomaly ? volumeCheck.multiplier : 1.0);

    return {
      current: seasonal.regime,
      confidenceMultiplier: Math.round(Math.max(0.5, combinedConfidence) * 100) / 100,
      stakeMultiplier: Math.round(Math.max(0.5, combinedStake) * 100) / 100,
      description: seasonal.description,
      detectedAt: now.toISOString(),
      factors,
    };
  }

  if (volumeCheck.anomaly) {
    return {
      current: "international_break",
      confidenceMultiplier: volumeCheck.multiplier,
      stakeMultiplier: volumeCheck.multiplier,
      description: volumeCheck.reason!,
      detectedAt: now.toISOString(),
      factors,
    };
  }

  factors.push("No special regime conditions detected");
  return {
    current: "normal",
    confidenceMultiplier: 1.0,
    stakeMultiplier: 1.0,
    description: "Standard mid-season conditions — full confidence",
    detectedAt: now.toISOString(),
    factors,
  };
}

export async function logRegimeChange(regime: MarketRegime): Promise<void> {
  if (regime.current === "normal") return;

  await db.insert(learningNarrativesTable).values({
    narrativeType: "market_regime",
    narrativeText: `Market regime: ${regime.current} — ${regime.description}. Confidence ×${regime.confidenceMultiplier}, Stake ×${regime.stakeMultiplier}.`,
    relatedData: regime,
    createdAt: new Date(),
  });

  logger.info(
    { regime: regime.current, confidence: regime.confidenceMultiplier, stake: regime.stakeMultiplier },
    `Market regime detected: ${regime.current}`,
  );
}
