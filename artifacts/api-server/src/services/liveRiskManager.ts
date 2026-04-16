import { db, paperBetsTable, matchesTable, complianceLogsTable } from "@workspace/db";
import { eq, and, gte, sql, inArray, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getConfigValue, setConfigValue } from "./paperTrading";
import { isLiveMode, getLiveBankroll } from "./betfairLive";
import { getMarketFamily } from "./edgeConcentration";

export interface LiveRiskLevel {
  level: number;
  maxSingleBetPct: number;
  maxOpenExposurePct: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxLeagueExposurePct: number;
  maxMarketTypeExposurePct: number;
  maxFixtureExposurePct: number;
  kellyFraction: number;
}

const RISK_LEVELS: LiveRiskLevel[] = [
  {
    level: 1,
    maxSingleBetPct: 0.02,
    maxOpenExposurePct: 0.95,
    maxDailyLossPct: 0.05,
    maxWeeklyLossPct: 0.10,
    maxLeagueExposurePct: 0.08,
    maxMarketTypeExposurePct: 0.10,
    maxFixtureExposurePct: 0.03,
    kellyFraction: 0.25,
  },
  {
    level: 2,
    maxSingleBetPct: 0.025,
    maxOpenExposurePct: 0.30,
    maxDailyLossPct: 0.06,
    maxWeeklyLossPct: 0.12,
    maxLeagueExposurePct: 0.10,
    maxMarketTypeExposurePct: 0.12,
    maxFixtureExposurePct: 0.035,
    kellyFraction: 0.30,
  },
  {
    level: 3,
    maxSingleBetPct: 0.03,
    maxOpenExposurePct: 0.35,
    maxDailyLossPct: 0.07,
    maxWeeklyLossPct: 0.14,
    maxLeagueExposurePct: 0.12,
    maxMarketTypeExposurePct: 0.14,
    maxFixtureExposurePct: 0.04,
    kellyFraction: 0.30,
  },
  {
    level: 4,
    maxSingleBetPct: 0.035,
    maxOpenExposurePct: 0.40,
    maxDailyLossPct: 0.08,
    maxWeeklyLossPct: 0.16,
    maxLeagueExposurePct: 0.14,
    maxMarketTypeExposurePct: 0.16,
    maxFixtureExposurePct: 0.05,
    kellyFraction: 0.30,
  },
];

export function getRiskLevelConfig(level: number): LiveRiskLevel {
  const idx = Math.max(0, Math.min(level - 1, RISK_LEVELS.length - 1));
  return RISK_LEVELS[idx]!;
}

export async function getCurrentLiveRiskLevel(): Promise<number> {
  const val = await getConfigValue("live_risk_level");
  return val ? Math.max(1, Math.min(4, parseInt(val, 10))) : 1;
}

export async function getStartingDeposit(): Promise<number> {
  const val = await getConfigValue("starting_deposit");
  return val ? Number(val) : 0;
}

export async function getBankrollFloorFromDeposit(): Promise<number> {
  const deposit = await getStartingDeposit();
  if (deposit <= 0) return 60;
  return Math.round(deposit * 0.60 * 100) / 100;
}

export async function getLiveBalance(): Promise<number> {
  if (isLiveMode()) {
    try {
      return await getLiveBankroll();
    } catch {
      logger.warn("Could not fetch live balance — falling back to paper bankroll");
    }
  }
  const val = await getConfigValue("bankroll");
  return val ? Number(val) : 5000;
}

export async function getEffectiveLimits(): Promise<{
  level: number;
  config: LiveRiskLevel;
  liveBalance: number;
  maxSingleBet: number;
  maxOpenExposure: number;
  maxDailyLoss: number;
  maxWeeklyLoss: number;
  maxLeagueExposure: number;
  maxMarketTypeExposure: number;
  maxFixtureExposure: number;
  bankrollFloor: number;
  isLive: boolean;
}> {
  const level = await getCurrentLiveRiskLevel();
  const config = getRiskLevelConfig(level);
  const liveBalance = await getLiveBalance();
  const bankrollFloor = await getBankrollFloorFromDeposit();

  return {
    level,
    config,
    liveBalance,
    maxSingleBet: Math.round(liveBalance * config.maxSingleBetPct * 100) / 100,
    maxOpenExposure: Math.round(liveBalance * config.maxOpenExposurePct * 100) / 100,
    maxDailyLoss: Math.round(liveBalance * config.maxDailyLossPct * 100) / 100,
    maxWeeklyLoss: Math.round(liveBalance * config.maxWeeklyLossPct * 100) / 100,
    maxLeagueExposure: Math.round(liveBalance * config.maxLeagueExposurePct * 100) / 100,
    maxMarketTypeExposure: Math.round(liveBalance * config.maxMarketTypeExposurePct * 100) / 100,
    maxFixtureExposure: Math.round(liveBalance * config.maxFixtureExposurePct * 100) / 100,
    bankrollFloor,
    isLive: isLiveMode(),
  };
}

interface ConcentrationCheck {
  passed: boolean;
  reason: string | null;
}

export async function checkLeagueExposure(
  matchId: number,
  stake: number,
  maxLeagueExposure: number,
): Promise<ConcentrationCheck> {
  const [match] = await db
    .select({ league: matchesTable.league })
    .from(matchesTable)
    .where(eq(matchesTable.id, matchId))
    .limit(1);

  if (!match) return { passed: true, reason: null };

  const result = await db.execute(sql`
    SELECT COALESCE(SUM(pb.stake::numeric), 0) AS total
    FROM paper_bets pb
    JOIN matches m ON pb.match_id = m.id
    WHERE pb.status = 'pending'
    AND pb.deleted_at IS NULL
    AND m.league = ${match.league}
    AND (pb.qualification_path IS NULL OR pb.qualification_path != 'paper')
  `);

  const currentExposure = Number((result.rows[0] as Record<string, unknown>)?.total ?? 0);
  if (currentExposure + stake > maxLeagueExposure) {
    return {
      passed: false,
      reason: `League exposure limit: ${match.league} at £${currentExposure.toFixed(0)} + £${stake.toFixed(0)} > £${maxLeagueExposure.toFixed(0)} (${(maxLeagueExposure > 0 ? ((currentExposure + stake) / maxLeagueExposure * 100) : 0).toFixed(0)}%)`,
    };
  }

  return { passed: true, reason: null };
}

export async function checkMarketTypeExposure(
  marketType: string,
  stake: number,
  maxMarketTypeExposure: number,
): Promise<ConcentrationCheck> {
  const family = getMarketFamily(marketType);

  const marketTypes = family === "OVER_UNDER"
    ? ["OVER_UNDER_25", "OVER_UNDER_35", "OVER_UNDER_45"]
    : family === "CARDS"
      ? ["TOTAL_CARDS_25", "TOTAL_CARDS_35"]
      : family === "CORNERS"
        ? ["TOTAL_CORNERS_75", "TOTAL_CORNERS_85", "TOTAL_CORNERS_95", "TOTAL_CORNERS_105", "TOTAL_CORNERS_115"]
        : [marketType];

  const pgArrayLiteral = `{${marketTypes.join(",")}}`;
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(stake::numeric), 0) AS total
    FROM paper_bets
    WHERE status = 'pending'
    AND deleted_at IS NULL
    AND market_type = ANY(${pgArrayLiteral}::text[])
    AND (qualification_path IS NULL OR qualification_path != 'paper')
  `);

  const currentExposure = Number((result.rows[0] as Record<string, unknown>)?.total ?? 0);
  if (currentExposure + stake > maxMarketTypeExposure) {
    return {
      passed: false,
      reason: `Market type exposure limit: ${family} at £${currentExposure.toFixed(0)} + £${stake.toFixed(0)} > £${maxMarketTypeExposure.toFixed(0)}`,
    };
  }

  return { passed: true, reason: null };
}

export async function checkFixtureExposure(
  matchId: number,
  stake: number,
  maxFixtureExposure: number,
): Promise<ConcentrationCheck> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(stake::numeric), 0) AS total
    FROM paper_bets
    WHERE status = 'pending'
    AND deleted_at IS NULL
    AND match_id = ${matchId}
    AND (qualification_path IS NULL OR qualification_path != 'paper')
  `);

  const currentExposure = Number((result.rows[0] as Record<string, unknown>)?.total ?? 0);
  if (currentExposure + stake > maxFixtureExposure) {
    return {
      passed: false,
      reason: `Fixture exposure limit: match ${matchId} at £${currentExposure.toFixed(0)} + £${stake.toFixed(0)} > £${maxFixtureExposure.toFixed(0)} (3% of balance)`,
    };
  }

  return { passed: true, reason: null };
}

export async function runLiveConcentrationChecks(
  matchId: number,
  marketType: string,
  stake: number,
): Promise<ConcentrationCheck> {
  if (!isLiveMode()) return { passed: true, reason: null };

  const limits = await getEffectiveLimits();

  const leagueCheck = await checkLeagueExposure(matchId, stake, limits.maxLeagueExposure);
  if (!leagueCheck.passed) return leagueCheck;

  const marketCheck = await checkMarketTypeExposure(marketType, stake, limits.maxMarketTypeExposure);
  if (!marketCheck.passed) return marketCheck;

  const fixtureCheck = await checkFixtureExposure(matchId, stake, limits.maxFixtureExposure);
  if (!fixtureCheck.passed) return fixtureCheck;

  return { passed: true, reason: null };
}

export interface LevelCheckResult {
  currentLevel: number;
  qualifiesForNext: boolean;
  nextLevel: number | null;
  shouldDemote: boolean;
  demoteTo: number | null;
  settledLiveBets: number;
  rollingClv: number;
  rollingRoi: number;
  daysSinceLive: number;
  recentCircuitBreakers: number;
  reason: string;
}

export async function evaluateLevelProgression(): Promise<LevelCheckResult> {
  const currentLevel = await getCurrentLiveRiskLevel();

  const liveBetsResult = await db.execute(sql`
    SELECT
      COUNT(*) AS total,
      COALESCE(AVG(clv_pct::numeric), 0) AS avg_clv,
      COALESCE(SUM(settlement_pnl::numeric) / NULLIF(SUM(stake::numeric), 0) * 100, 0) AS roi
    FROM paper_bets
    WHERE status IN ('won', 'lost')
    AND live_tier = 'tier1'
    AND betfair_bet_id IS NOT NULL
  `);

  const row = liveBetsResult.rows[0] as Record<string, unknown>;
  const settledLiveBets = Number(row?.total ?? 0);
  const rollingClv = Number(row?.avg_clv ?? 0);
  const rollingRoi = Number(row?.roi ?? 0);

  const goLiveDateStr = await getConfigValue("go_live_date");
  const daysSinceLive = goLiveDateStr
    ? Math.floor((Date.now() - new Date(goLiveDateStr).getTime()) / (86400000))
    : 0;

  const breakerResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM drawdown_events
    WHERE environment = 'production'
    AND would_have_triggered = 'false'
    AND created_at > NOW() - INTERVAL '30 days'
  `);
  const recentCircuitBreakers = Number((breakerResult.rows[0] as Record<string, unknown>)?.cnt ?? 0);

  const rolling30Result = await db.execute(sql`
    SELECT
      COALESCE(AVG(clv_pct::numeric), 0) AS avg_clv,
      COALESCE(SUM(settlement_pnl::numeric) / NULLIF(SUM(stake::numeric), 0) * 100, 0) AS roi
    FROM paper_bets
    WHERE status IN ('won', 'lost')
    AND live_tier = 'tier1'
    AND betfair_bet_id IS NOT NULL
    AND settled_at > NOW() - INTERVAL '30 days'
  `);
  const rolling30Row = rolling30Result.rows[0] as Record<string, unknown>;
  const rolling30Clv = Number(rolling30Row?.avg_clv ?? 0);
  const rolling30Roi = Number(rolling30Row?.roi ?? 0);

  let shouldDemote = false;
  let demoteTo: number | null = null;
  if (currentLevel > 1 && (rolling30Roi < 0 || rolling30Clv < 0)) {
    shouldDemote = true;
    demoteTo = currentLevel - 1;
  }

  let qualifiesForNext = false;
  let nextLevel: number | null = null;
  let reason = `Level ${currentLevel}: ${settledLiveBets} settled live bets, CLV=${rollingClv.toFixed(1)}%, ROI=${rollingRoi.toFixed(1)}%`;

  if (!shouldDemote && currentLevel < 4) {
    const next = currentLevel + 1;
    if (next === 2 && settledLiveBets >= 50 && rollingClv > 2 && rollingRoi > 3 && recentCircuitBreakers === 0) {
      qualifiesForNext = true;
      nextLevel = 2;
      reason = `Qualifies for Level 2: ${settledLiveBets} bets, CLV ${rollingClv.toFixed(1)}% > 2%, ROI ${rollingRoi.toFixed(1)}% > 3%, no breakers`;
    } else if (next === 3 && settledLiveBets >= 150 && rollingClv > 2.5 && rollingRoi > 4 && recentCircuitBreakers === 0) {
      qualifiesForNext = true;
      nextLevel = 3;
      reason = `Qualifies for Level 3: ${settledLiveBets} bets, CLV ${rollingClv.toFixed(1)}% > 2.5%, ROI ${rollingRoi.toFixed(1)}% > 4%, no breakers 30d`;
    } else if (next === 4 && settledLiveBets >= 300 && rollingClv > 3 && rollingRoi > 5 && daysSinceLive >= 60) {
      qualifiesForNext = true;
      nextLevel = 4;
      reason = `Qualifies for Level 4: ${settledLiveBets} bets, CLV ${rollingClv.toFixed(1)}% > 3%, ROI ${rollingRoi.toFixed(1)}% > 5%, ${daysSinceLive} days live`;
    }
  }

  if (shouldDemote) {
    reason = `DEMOTION: rolling 30-day ROI=${rolling30Roi.toFixed(1)}%, CLV=${rolling30Clv.toFixed(1)}% — dropping from Level ${currentLevel} to ${demoteTo}`;
  }

  return {
    currentLevel,
    qualifiesForNext,
    nextLevel,
    shouldDemote,
    demoteTo,
    settledLiveBets,
    rollingClv: Math.round(rollingClv * 100) / 100,
    rollingRoi: Math.round(rollingRoi * 100) / 100,
    daysSinceLive,
    recentCircuitBreakers,
    reason,
  };
}

export async function applyLevelTransition(): Promise<{
  transitioned: boolean;
  from: number;
  to: number;
  reason: string;
}> {
  const result = await evaluateLevelProgression();

  if (result.shouldDemote && result.demoteTo !== null) {
    await setConfigValue("live_risk_level", String(result.demoteTo));

    await db.insert(complianceLogsTable).values({
      actionType: "live_risk_level_change",
      details: {
        from: result.currentLevel,
        to: result.demoteTo,
        direction: "demotion",
        settledLiveBets: result.settledLiveBets,
        rollingClv: result.rollingClv,
        rollingRoi: result.rollingRoi,
        reason: result.reason,
      },
      timestamp: new Date(),
    });

    logger.warn(
      { from: result.currentLevel, to: result.demoteTo, reason: result.reason },
      "LIVE RISK: Level DEMOTION applied",
    );

    return {
      transitioned: true,
      from: result.currentLevel,
      to: result.demoteTo,
      reason: result.reason,
    };
  }

  if (result.qualifiesForNext && result.nextLevel !== null) {
    await setConfigValue("live_risk_level", String(result.nextLevel));

    await db.insert(complianceLogsTable).values({
      actionType: "live_risk_level_change",
      details: {
        from: result.currentLevel,
        to: result.nextLevel,
        direction: "promotion",
        settledLiveBets: result.settledLiveBets,
        rollingClv: result.rollingClv,
        rollingRoi: result.rollingRoi,
        daysSinceLive: result.daysSinceLive,
        reason: result.reason,
      },
      timestamp: new Date(),
    });

    logger.info(
      { from: result.currentLevel, to: result.nextLevel, reason: result.reason },
      "LIVE RISK: Level PROMOTION applied",
    );

    return {
      transitioned: true,
      from: result.currentLevel,
      to: result.nextLevel,
      reason: result.reason,
    };
  }

  return {
    transitioned: false,
    from: result.currentLevel,
    to: result.currentLevel,
    reason: result.reason,
  };
}

export async function getConsecutiveLiveLosses(): Promise<number> {
  const recent = await db.execute(sql`
    SELECT status FROM paper_bets
    WHERE status IN ('won', 'lost')
    AND live_tier = 'tier1'
    AND betfair_bet_id IS NOT NULL
    ORDER BY settled_at DESC
    LIMIT 20
  `);

  let streak = 0;
  for (const row of recent.rows as Record<string, unknown>[]) {
    if (String(row.status) === "lost") streak++;
    else break;
  }
  return streak;
}

export interface LiveCircuitBreakerResult {
  triggered: boolean;
  action: "none" | "pause_1hr" | "pause_6hr" | "halt" | "daily_halt" | "weekly_halt" | "floor_halt";
  reason: string;
  autoResumeAt: Date | null;
}

export async function checkLiveCircuitBreakers(): Promise<LiveCircuitBreakerResult> {
  if (!isLiveMode()) {
    return { triggered: false, action: "none", reason: "Not in live mode", autoResumeAt: null };
  }

  const pausedUntilStr = await getConfigValue("live_breaker_paused_until");
  if (pausedUntilStr) {
    const pausedUntil = new Date(pausedUntilStr);
    if (Date.now() < pausedUntil.getTime()) {
      return {
        triggered: true,
        action: "pause_1hr",
        reason: `Timed pause active until ${pausedUntil.toISOString()}`,
        autoResumeAt: pausedUntil,
      };
    } else {
      await setConfigValue("live_breaker_paused_until", "");
      logger.info({ pausedUntil: pausedUntilStr }, "Timed circuit breaker pause expired — resuming");
    }
  }

  const consecutiveLosses = await getConsecutiveLiveLosses();

  if (consecutiveLosses >= 8) {
    return {
      triggered: true,
      action: "halt",
      reason: `CRITICAL: ${consecutiveLosses} consecutive live losses — manual restart required`,
      autoResumeAt: null,
    };
  }

  if (consecutiveLosses >= 5) {
    const resumeAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await setConfigValue("live_breaker_paused_until", resumeAt.toISOString());
    logger.warn({ consecutiveLosses, resumeAt: resumeAt.toISOString() }, "Circuit breaker: 6hr pause persisted");
    return {
      triggered: true,
      action: "pause_6hr",
      reason: `${consecutiveLosses} consecutive live losses — pausing until ${resumeAt.toISOString()}`,
      autoResumeAt: resumeAt,
    };
  }

  if (consecutiveLosses >= 3) {
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000);
    await setConfigValue("live_breaker_paused_until", resumeAt.toISOString());
    logger.warn({ consecutiveLosses, resumeAt: resumeAt.toISOString() }, "Circuit breaker: 1hr pause persisted");
    return {
      triggered: true,
      action: "pause_1hr",
      reason: `${consecutiveLosses} consecutive live losses — pausing until ${resumeAt.toISOString()}`,
      autoResumeAt: resumeAt,
    };
  }

  const limits = await getEffectiveLimits();
  const balance = limits.liveBalance;

  const floor = limits.bankrollFloor;
  if (balance < floor) {
    return {
      triggered: true,
      action: "floor_halt",
      reason: `CRITICAL: Balance £${balance.toFixed(2)} below floor £${floor.toFixed(2)} (60% of total deposits). ALL betting halted.`,
      autoResumeAt: null,
    };
  }

  return { triggered: false, action: "none", reason: "All checks passed", autoResumeAt: null };
}

export function getLiveKellyFraction(
  level: number,
  hasPinnacle: boolean,
): number {
  const config = getRiskLevelConfig(level);
  let fraction = config.kellyFraction;
  if (!hasPinnacle) {
    fraction *= 0.5;
  }
  return Math.min(fraction, 0.40);
}

export interface SlippageCheck {
  blocked: boolean;
  slippagePct: number;
  reason: string | null;
}

export function checkSlippage(
  identifiedOdds: number,
  currentOdds: number,
): SlippageCheck {
  if (identifiedOdds <= 1 || currentOdds <= 1) {
    return { blocked: false, slippagePct: 0, reason: null };
  }

  const slippagePct = ((identifiedOdds - currentOdds) / identifiedOdds) * 100;

  if (slippagePct > 5) {
    return {
      blocked: true,
      slippagePct: Math.round(slippagePct * 100) / 100,
      reason: `Slippage ${slippagePct.toFixed(1)}% exceeds 5% threshold (identified: ${identifiedOdds.toFixed(2)}, current: ${currentOdds.toFixed(2)}) — skipping bet`,
    };
  }

  return {
    blocked: false,
    slippagePct: Math.round(slippagePct * 100) / 100,
    reason: null,
  };
}

export async function getLiveRiskStatus(): Promise<{
  level: number;
  limits: ReturnType<typeof getRiskLevelConfig>;
  liveBalance: number;
  startingDeposit: number;
  bankrollFloor: number;
  isLive: boolean;
  consecutiveLosses: number;
  levelProgression: LevelCheckResult;
  effectiveLimits: Awaited<ReturnType<typeof getEffectiveLimits>>;
}> {
  const level = await getCurrentLiveRiskLevel();
  const limits = getRiskLevelConfig(level);
  const liveBalance = await getLiveBalance();
  const startingDeposit = await getStartingDeposit();
  const bankrollFloor = await getBankrollFloorFromDeposit();
  const consecutiveLosses = await getConsecutiveLiveLosses();
  const levelProgression = await evaluateLevelProgression();
  const effectiveLimits = await getEffectiveLimits();

  return {
    level,
    limits,
    liveBalance,
    startingDeposit,
    bankrollFloor,
    isLive: isLiveMode(),
    consecutiveLosses,
    levelProgression,
    effectiveLimits,
  };
}

let apiErrorCount = 0;
let apiErrorWindowStart = Date.now();
let apiPausedUntil = 0;

export function recordBetfairApiError(): { shouldPause: boolean; reason: string | null } {
  const now = Date.now();
  if (now - apiErrorWindowStart > 60 * 60 * 1000) {
    apiErrorCount = 0;
    apiErrorWindowStart = now;
  }

  apiErrorCount++;

  if (apiErrorCount >= 5) {
    apiPausedUntil = now + 30 * 60 * 1000;
    const reason = `${apiErrorCount} Betfair API errors in 1 hour — pausing betting for 30 minutes`;
    logger.warn({ apiErrorCount, pausedUntil: new Date(apiPausedUntil).toISOString() }, reason);
    apiErrorCount = 0;
    apiErrorWindowStart = now;
    return { shouldPause: true, reason };
  }

  return { shouldPause: false, reason: null };
}

export function isBetfairApiPaused(): boolean {
  return Date.now() < apiPausedUntil;
}
