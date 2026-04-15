import { db, paperBetsTable, matchesTable, complianceLogsTable, pinnacleOddsSnapshotsTable } from "@workspace/db";
import { eq, and, gte, lte, sql, desc, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isLiveMode, getAccountFunds, getCachedBalance, getLiveBankroll, placeLiveBetOnBetfair } from "./betfairLive";
import { getEffectiveLimits, getCurrentLiveRiskLevel, runLiveConcentrationChecks, checkLiveCircuitBreakers, getLiveKellyFraction } from "./liveRiskManager";
import { getApiBudgetStatus } from "./apiFootball";
import { isLeagueMarketTier1Eligible } from "./dataRichness";
import { getLiveOppScoreThreshold } from "./liveThresholdReview";
import { commissionAdjustedEV, getCommissionRate } from "./commissionService";
import { createAlert } from "./alerting";
import { getConfigValue, getBankroll } from "./paperTrading";

const LAUNCH_LOCK_KEY = "launch_activation_running";

export interface LaunchReport {
  timestamp: string;
  mode: "LIVE" | "DRY_RUN";
  preFlightChecks: PreFlightResult;
  scan: ScanResult;
  placements: PlacementResult[];
  summary: LaunchSummary;
}

interface PreFlightResult {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

interface ScanResult {
  totalPaperBets: number;
  qualified: number;
  skippedReasons: Record<string, number>;
}

interface PlacementResult {
  betId: number;
  fixture: string;
  market: string;
  selection: string;
  stake: number;
  odds: number;
  opportunityScore: number;
  pinnacleEdgePct: number;
  commissionAdjustedEV: number;
  dataRichness: boolean;
  path: "promoted" | "data_richness";
  status: "placed" | "skipped" | "failed";
  skipReason?: string;
  error?: string;
  betfairBetId?: string;
  executionTimeMs?: number;
}

interface LaunchSummary {
  totalScanned: number;
  qualifiedForLive: number;
  passedPinnacle: number;
  passedOddsVerification: number;
  successfullyPlaced: number;
  skippedPinnacleEdge: number;
  skippedOddsMoved: number;
  skippedInsufficientData: number;
  skippedInsufficientLiquidity: number;
  skippedExposureLimit: number;
  failedToPlace: number;
  totalStakeDeployed: number;
  stakeAsPctOfBalance: number;
  currentExposurePct: number;
  avgExecutionTimeMs: number;
}

export async function runLaunchActivation(): Promise<LaunchReport> {
  const isLive = isLiveMode();
  const mode = isLive ? "LIVE" : "DRY_RUN";
  logger.info({ mode }, "=== LAUNCH ACTIVATION STARTING ===");

  const report: LaunchReport = {
    timestamp: new Date().toISOString(),
    mode,
    preFlightChecks: { passed: false, checks: [] },
    scan: { totalPaperBets: 0, qualified: 0, skippedReasons: {} },
    placements: [],
    summary: {
      totalScanned: 0,
      qualifiedForLive: 0,
      passedPinnacle: 0,
      passedOddsVerification: 0,
      successfullyPlaced: 0,
      skippedPinnacleEdge: 0,
      skippedOddsMoved: 0,
      skippedInsufficientData: 0,
      skippedInsufficientLiquidity: 0,
      skippedExposureLimit: 0,
      failedToPlace: 0,
      totalStakeDeployed: 0,
      stakeAsPctOfBalance: 0,
      currentExposurePct: 0,
      avgExecutionTimeMs: 0,
    },
  };

  const preFlightResult = await runPreFlightChecks(isLive);
  report.preFlightChecks = preFlightResult;

  if (!preFlightResult.passed) {
    logger.error({ checks: preFlightResult.checks.filter(c => !c.passed) }, "LAUNCH ACTIVATION ABORTED — pre-flight checks failed");
    return report;
  }

  logger.info("Pre-flight checks PASSED — scanning paper bets for live promotion");

  const limits = await getEffectiveLimits();
  const oppThreshold = await getLiveOppScoreThreshold();
  const commissionRate = await getCommissionRate();

  const candidates = await scanPaperBets(oppThreshold);
  report.scan.totalPaperBets = candidates.totalScanned;
  report.scan.qualified = candidates.qualified.length;
  report.scan.skippedReasons = candidates.skippedReasons;
  report.summary.totalScanned = candidates.totalScanned;

  logger.info(
    { totalScanned: candidates.totalScanned, qualified: candidates.qualified.length, skippedReasons: candidates.skippedReasons },
    "Paper bet scan complete",
  );

  const sortedCandidates = candidates.qualified.sort(
    (a, b) => Number(b.opportunityScore) - Number(a.opportunityScore),
  );

  let failCount = 0;
  let totalExecTime = 0;
  let placedCount = 0;

  for (const bet of sortedCandidates) {
    if (failCount >= 3) {
      logger.error("LAUNCH ACTIVATION HALTED — 3+ placement failures, possible API issue");
      await createAlert({
        severity: "critical",
        category: "trading",
        code: "LAUNCH_BATCH_HALTED",
        title: "Launch batch halted — 3+ placement failures",
        message: `Stopped after ${failCount} consecutive failures. ${placedCount} bets placed before halt.`,
        metadata: { failCount, placedCount },
      });
      break;
    }

    const result = await processCandidate(bet, limits, commissionRate, isLive);
    report.placements.push(result);

    if (result.status === "placed") {
      report.summary.successfullyPlaced++;
      report.summary.totalStakeDeployed += result.stake;
      totalExecTime += result.executionTimeMs ?? 0;
      placedCount++;
      failCount = 0;
    } else if (result.status === "failed") {
      report.summary.failedToPlace++;
      failCount++;
    } else {
      failCount = 0;
      if (result.skipReason?.includes("Pinnacle")) report.summary.skippedPinnacleEdge++;
      else if (result.skipReason?.includes("odds")) report.summary.skippedOddsMoved++;
      else if (result.skipReason?.includes("data")) report.summary.skippedInsufficientData++;
      else if (result.skipReason?.includes("liquidity")) report.summary.skippedInsufficientLiquidity++;
      else if (result.skipReason?.includes("exposure") || result.skipReason?.includes("limit")) report.summary.skippedExposureLimit++;
    }
  }

  report.summary.qualifiedForLive = sortedCandidates.length;
  report.summary.passedPinnacle = report.placements.filter(p => p.pinnacleEdgePct >= 2).length;
  report.summary.passedOddsVerification = report.placements.filter(p => p.commissionAdjustedEV > 0).length;

  const balance = isLive ? (getCachedBalance()?.total ?? 0) : await getBankroll();
  report.summary.stakeAsPctOfBalance = balance > 0 ? Math.round((report.summary.totalStakeDeployed / balance) * 10000) / 100 : 0;
  report.summary.currentExposurePct = balance > 0 ? Math.round(((getCachedBalance()?.exposure ?? 0) / balance) * 10000) / 100 : 0;
  report.summary.avgExecutionTimeMs = placedCount > 0 ? Math.round(totalExecTime / placedCount) : 0;

  await db.insert(complianceLogsTable).values({
    actionType: "launch_activation_complete",
    details: {
      mode,
      summary: report.summary,
      placedBets: report.placements.filter(p => p.status === "placed").map(p => ({
        betId: p.betId,
        fixture: p.fixture,
        market: p.market,
        selection: p.selection,
        stake: p.stake,
        odds: p.odds,
        oppScore: p.opportunityScore,
        pinnacleEdge: p.pinnacleEdgePct,
        caEV: p.commissionAdjustedEV,
      })),
    },
    timestamp: new Date(),
  });

  await createAlert({
    severity: "info",
    category: "trading",
    code: "LAUNCH_ACTIVATION_COMPLETE",
    title: `Live trading active — ${report.summary.successfullyPlaced} bets placed (${mode})`,
    message: `Launch batch: ${report.summary.totalScanned} scanned, ${report.summary.qualifiedForLive} qualified, ${report.summary.successfullyPlaced} placed. Total stake: £${report.summary.totalStakeDeployed.toFixed(2)} (${report.summary.stakeAsPctOfBalance}% of balance).`,
    metadata: { mode, ...report.summary },
  });

  logger.info({ mode, summary: report.summary }, "=== LAUNCH ACTIVATION COMPLETE ===");
  return report;
}

async function runPreFlightChecks(isLive: boolean): Promise<PreFlightResult> {
  const checks: { name: string; passed: boolean; detail: string }[] = [];

  checks.push({
    name: "TRADING_MODE",
    passed: true,
    detail: isLive ? "LIVE" : "PAPER (dry-run mode — no real bets will be placed)",
  });

  if (isLive) {
    try {
      const funds = await getAccountFunds();
      checks.push({
        name: "Betfair API / Balance",
        passed: funds.availableToBetBalance > 0,
        detail: `Balance: £${funds.availableToBetBalance.toFixed(2)}, Exposure: £${Math.abs(funds.exposure).toFixed(2)}`,
      });
    } catch (err) {
      checks.push({ name: "Betfair API / Balance", passed: false, detail: `Failed: ${String(err)}` });
    }

    const vpsUrl = process.env["VPS_RELAY_URL"];
    checks.push({
      name: "VPS Relay",
      passed: !!vpsUrl,
      detail: vpsUrl ? `Configured: ${vpsUrl}` : "VPS_RELAY_URL not set — live placement will fail",
    });
  } else {
    const bankroll = await getBankroll();
    checks.push({
      name: "Paper Bankroll",
      passed: bankroll > 0,
      detail: `Paper bankroll: £${bankroll.toFixed(2)}`,
    });
  }

  const dbUrl = process.env["DATABASE_URL"] ?? "";
  const isNeon = dbUrl.includes("neon") || dbUrl.includes("neon.tech");
  checks.push({
    name: "Database",
    passed: true,
    detail: isNeon ? "Production Neon DB" : "Development DB (acceptable for dry-run)",
  });

  try {
    await db.execute(sql`SELECT 1`);
    checks.push({ name: "DB Connection", passed: true, detail: "OK" });
  } catch (err) {
    checks.push({ name: "DB Connection", passed: false, detail: `Failed: ${String(err)}` });
  }

  const commRate = await getCommissionRate();
  checks.push({
    name: "Commission Tracking",
    passed: commRate > 0,
    detail: `Commission rate: ${(commRate * 100).toFixed(1)}%`,
  });

  try {
    const apiBudget = await getApiBudgetStatus();
    checks.push({
      name: "API-Football Budget",
      passed: !apiBudget.throttled,
      detail: `Used: ${apiBudget.used}/${apiBudget.cap} today, Monthly: ${apiBudget.monthlyUsed}/${apiBudget.monthlyCap}`,
    });
  } catch (err) {
    checks.push({ name: "API-Football Budget", passed: true, detail: `Could not check — non-blocking: ${String(err)}` });
  }

  const riskLevel = await getCurrentLiveRiskLevel();
  checks.push({
    name: "Risk Level",
    passed: riskLevel === 1,
    detail: `Level ${riskLevel} (${riskLevel === 1 ? "Level 1 — correct for launch" : "WARNING: not Level 1"})`,
  });

  const oppThreshold = await getLiveOppScoreThreshold();
  checks.push({
    name: "Opp Score Threshold",
    passed: oppThreshold >= 60 && oppThreshold <= 80,
    detail: `Current threshold: ${oppThreshold}`,
  });

  const env = process.env["ENVIRONMENT"] ?? "development";
  checks.push({
    name: "Environment",
    passed: true,
    detail: env,
  });

  const allPassed = !isLive || checks.every(c => c.passed);
  return { passed: allPassed, checks };
}

interface ScanCandidate {
  betId: number;
  matchId: number;
  fixture: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  country: string;
  marketType: string;
  selectionName: string;
  oddsAtPlacement: number;
  stake: number;
  opportunityScore: number;
  modelProbability: number;
  dataTier: string;
  pinnacleOdds: number | null;
  pinnacleImplied: number | null;
  betfairEventId: string | null;
  kickoffTime: Date;
}

async function scanPaperBets(oppThreshold: number): Promise<{
  totalScanned: number;
  qualified: ScanCandidate[];
  skippedReasons: Record<string, number>;
}> {
  const now = new Date();
  const minKickoff = new Date(now.getTime() + 30 * 60 * 1000);
  const maxKickoff = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const rows = await db
    .select({
      betId: paperBetsTable.id,
      matchId: paperBetsTable.matchId,
      marketType: paperBetsTable.marketType,
      selectionName: paperBetsTable.selectionName,
      oddsAtPlacement: paperBetsTable.oddsAtPlacement,
      stake: paperBetsTable.stake,
      opportunityScore: paperBetsTable.opportunityScore,
      modelProbability: paperBetsTable.modelProbability,
      dataTier: paperBetsTable.dataTier,
      pinnacleOdds: paperBetsTable.pinnacleOdds,
      pinnacleImplied: paperBetsTable.pinnacleImplied,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      league: matchesTable.league,
      country: matchesTable.country,
      kickoffTime: matchesTable.kickoffTime,
      betfairEventId: matchesTable.betfairEventId,
    })
    .from(paperBetsTable)
    .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        isNull(paperBetsTable.deletedAt),
        gte(matchesTable.kickoffTime, minKickoff),
        lte(matchesTable.kickoffTime, maxKickoff),
      ),
    )
    .orderBy(desc(paperBetsTable.opportunityScore));

  const skippedReasons: Record<string, number> = {};
  const qualified: ScanCandidate[] = [];

  const incSkip = (reason: string) => {
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  };

  for (const row of rows) {
    const oppScore = Number(row.opportunityScore ?? 0);
    if (oppScore < oppThreshold) {
      incSkip("opp_score_below_threshold");
      continue;
    }

    const dataTier = row.dataTier ?? "experiment";
    if (dataTier === "abandoned" || dataTier === "demoted" || dataTier === "opportunity_boosted") {
      incSkip(`blocked_tier_${dataTier}`);
      continue;
    }

    const pinnOdds = row.pinnacleOdds ? Number(row.pinnacleOdds) : null;
    const pinnImpl = row.pinnacleImplied ? Number(row.pinnacleImplied) : null;
    if (pinnOdds == null || pinnImpl == null) {
      incSkip("no_pinnacle_odds");
      continue;
    }

    const modelProb = Number(row.modelProbability ?? 0);
    const edgeVsPinnacle = (modelProb - pinnImpl) * 100;
    if (edgeVsPinnacle < 2) {
      incSkip("pinnacle_edge_insufficient");
      continue;
    }

    const isRichData = await isLeagueMarketTier1Eligible(
      row.league ?? "",
      row.country ?? "",
      row.marketType,
    );
    const isPromoted = dataTier === "promoted";

    if (!isPromoted && !isRichData) {
      incSkip("data_richness_insufficient");
      continue;
    }

    qualified.push({
      betId: row.betId,
      matchId: row.matchId,
      fixture: `${row.homeTeam} vs ${row.awayTeam}`,
      homeTeam: row.homeTeam ?? "",
      awayTeam: row.awayTeam ?? "",
      league: row.league ?? "",
      country: row.country ?? "",
      marketType: row.marketType,
      selectionName: row.selectionName,
      oddsAtPlacement: Number(row.oddsAtPlacement),
      stake: Number(row.stake),
      opportunityScore: oppScore,
      modelProbability: modelProb,
      dataTier,
      pinnacleOdds: pinnOdds,
      pinnacleImplied: pinnImpl,
      betfairEventId: row.betfairEventId,
      kickoffTime: row.kickoffTime!,
    });
  }

  return { totalScanned: rows.length, qualified, skippedReasons };
}

async function processCandidate(
  bet: ScanCandidate,
  limits: Awaited<ReturnType<typeof getEffectiveLimits>>,
  commissionRate: number,
  isLive: boolean,
): Promise<PlacementResult> {
  const pinnacleEdgePct = ((bet.modelProbability - (bet.pinnacleImplied ?? 0)) * 100);
  const path = bet.dataTier === "promoted" ? "promoted" as const : "data_richness" as const;

  const evResult = commissionAdjustedEV(bet.modelProbability, bet.oddsAtPlacement, commissionRate);

  if (evResult.netEV <= 0) {
    return {
      betId: bet.betId,
      fixture: bet.fixture,
      market: bet.marketType,
      selection: bet.selectionName,
      stake: bet.stake,
      odds: bet.oddsAtPlacement,
      opportunityScore: bet.opportunityScore,
      pinnacleEdgePct: Math.round(pinnacleEdgePct * 100) / 100,
      commissionAdjustedEV: evResult.netEV,
      dataRichness: path === "data_richness",
      path,
      status: "skipped",
      skipReason: "Negative commission-adjusted EV",
    };
  }

  if (bet.stake > limits.maxSingleBet) {
    return {
      betId: bet.betId,
      fixture: bet.fixture,
      market: bet.marketType,
      selection: bet.selectionName,
      stake: bet.stake,
      odds: bet.oddsAtPlacement,
      opportunityScore: bet.opportunityScore,
      pinnacleEdgePct: Math.round(pinnacleEdgePct * 100) / 100,
      commissionAdjustedEV: evResult.netEV,
      dataRichness: path === "data_richness",
      path,
      status: "skipped",
      skipReason: `Stake £${bet.stake.toFixed(2)} exceeds single bet limit £${limits.maxSingleBet.toFixed(2)}`,
    };
  }

  if (isLive) {
    const concentrationCheck = await runLiveConcentrationChecks(bet.matchId, bet.marketType, bet.stake);
    if (!concentrationCheck.passed) {
      return {
        betId: bet.betId,
        fixture: bet.fixture,
        market: bet.marketType,
        selection: bet.selectionName,
        stake: bet.stake,
        odds: bet.oddsAtPlacement,
        opportunityScore: bet.opportunityScore,
        pinnacleEdgePct: Math.round(pinnacleEdgePct * 100) / 100,
        commissionAdjustedEV: evResult.netEV,
        dataRichness: path === "data_richness",
        path,
        status: "skipped",
        skipReason: `exposure/concentration limit: ${concentrationCheck.reason}`,
      };
    }

    if (!bet.betfairEventId) {
      return {
        betId: bet.betId,
        fixture: bet.fixture,
        market: bet.marketType,
        selection: bet.selectionName,
        stake: bet.stake,
        odds: bet.oddsAtPlacement,
        opportunityScore: bet.opportunityScore,
        pinnacleEdgePct: Math.round(pinnacleEdgePct * 100) / 100,
        commissionAdjustedEV: evResult.netEV,
        dataRichness: path === "data_richness",
        path,
        status: "skipped",
        skipReason: "No Betfair event ID — cannot place",
      };
    }

    await db
      .update(paperBetsTable)
      .set({ liveTier: "tier1", betfairStatus: "PENDING_PLACEMENT" })
      .where(eq(paperBetsTable.id, bet.betId));

    const start = Date.now();
    const placementResult = await placeLiveBetOnBetfair({
      internalBetId: bet.betId,
      betfairEventId: bet.betfairEventId,
      marketType: bet.marketType,
      selectionName: bet.selectionName,
      odds: bet.oddsAtPlacement,
      stake: bet.stake,
      homeTeam: bet.homeTeam,
      awayTeam: bet.awayTeam,
    });
    const execMs = Date.now() - start;

    if (!placementResult.success) {
      return {
        betId: bet.betId,
        fixture: bet.fixture,
        market: bet.marketType,
        selection: bet.selectionName,
        stake: bet.stake,
        odds: bet.oddsAtPlacement,
        opportunityScore: bet.opportunityScore,
        pinnacleEdgePct: Math.round(pinnacleEdgePct * 100) / 100,
        commissionAdjustedEV: evResult.netEV,
        dataRichness: path === "data_richness",
        path,
        status: "failed",
        error: placementResult.error,
        executionTimeMs: execMs,
      };
    }

    return {
      betId: bet.betId,
      fixture: bet.fixture,
      market: bet.marketType,
      selection: bet.selectionName,
      stake: bet.stake,
      odds: bet.oddsAtPlacement,
      opportunityScore: bet.opportunityScore,
      pinnacleEdgePct: Math.round(pinnacleEdgePct * 100) / 100,
      commissionAdjustedEV: evResult.netEV,
      dataRichness: path === "data_richness",
      path,
      status: "placed",
      betfairBetId: placementResult.betfairBetId,
      executionTimeMs: execMs,
    };
  }

  return {
    betId: bet.betId,
    fixture: bet.fixture,
    market: bet.marketType,
    selection: bet.selectionName,
    stake: bet.stake,
    odds: bet.oddsAtPlacement,
    opportunityScore: bet.opportunityScore,
    pinnacleEdgePct: Math.round(pinnacleEdgePct * 100) / 100,
    commissionAdjustedEV: evResult.netEV,
    dataRichness: path === "data_richness",
    path,
    status: "placed",
    executionTimeMs: 0,
  };
}
