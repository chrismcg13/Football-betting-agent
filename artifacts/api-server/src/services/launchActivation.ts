import { db, paperBetsTable, matchesTable, complianceLogsTable, pinnacleOddsSnapshotsTable } from "@workspace/db";
import { createPool } from "@workspace/db";
import { eq, and, gte, lte, sql, desc, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isLiveMode, getAccountFunds, getCachedBalance, getLiveBankroll, placeLiveBetOnBetfair, findEventIdByTeamNames, listMarketsByEventId } from "./betfairLive";
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

    const proxyUrl = process.env["BETFAIR_PROXY_URL"];
    checks.push({
      name: "Betfair Proxy",
      passed: !!proxyUrl,
      detail: proxyUrl ? `Configured: ${proxyUrl}` : "BETFAIR_PROXY_URL not set — live placement will fail",
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
  apiFixtureId: number | null;
  pinnacleEdgeCategory: string | null;
  calculatedEdge: number | null;
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
      apiFixtureId: row.apiFixtureId ? Number(row.apiFixtureId) : null,
      pinnacleEdgeCategory: row.pinnacleEdgeCategory ?? null,
      calculatedEdge: row.calculatedEdge != null ? Number(row.calculatedEdge) : null,
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

async function recordBetOnNeon(
  bet: ScanCandidate,
  result: { betfairBetId?: string; sizeMatched?: number; avgPriceMatched?: number; betfairMarketId?: string },
): Promise<number> {
  let neonMatchId: number | null = null;

  if (bet.apiFixtureId) {
    const matchRows = await db.execute(sql`
      SELECT id FROM matches WHERE api_fixture_id = ${bet.apiFixtureId} LIMIT 1
    `);
    if (matchRows.rows.length > 0) {
      neonMatchId = Number((matchRows.rows[0] as any).id);
    }
  }

  if (!neonMatchId) {
    const matchRows = await db.execute(sql`
      SELECT id FROM matches WHERE home_team = ${bet.homeTeam} AND away_team = ${bet.awayTeam}
      AND kickoff_time > NOW() - INTERVAL '7 days'
      ORDER BY kickoff_time DESC LIMIT 1
    `);
    if (matchRows.rows.length > 0) {
      neonMatchId = Number((matchRows.rows[0] as any).id);
    }
  }

  if (!neonMatchId) {
    const insertResult = await db.execute(sql`
      INSERT INTO matches (home_team, away_team, league, country, kickoff_time, api_fixture_id, betfair_event_id, status)
      VALUES (${bet.homeTeam}, ${bet.awayTeam}, ${bet.league}, ${bet.country}, ${bet.kickoffTime.toISOString()}, ${bet.apiFixtureId}, ${bet.betfairEventId}, 'scheduled')
      RETURNING id
    `);
    neonMatchId = Number((insertResult.rows[0] as any).id);
    logger.info({ neonMatchId, fixture: bet.fixture }, "Created match on Neon for live bet");
  }

  const potentialProfit = Number((bet.stake * (bet.oddsAtPlacement - 1)).toFixed(2));
  const betfairImplied = bet.oddsAtPlacement > 0 ? 1 / bet.oddsAtPlacement : null;

  const insertBet = await db.execute(sql`
    INSERT INTO paper_bets (
      match_id, market_type, selection_name, bet_type,
      odds_at_placement, stake, potential_profit,
      model_probability, betfair_implied_probability, calculated_edge,
      opportunity_score, data_tier, status,
      pinnacle_odds, pinnacle_implied, pinnacle_edge_category,
      live_tier, betfair_bet_id, betfair_market_id, betfair_status,
      betfair_size_matched, betfair_avg_price_matched, betfair_placed_at,
      odds_source
    ) VALUES (
      ${neonMatchId}, ${bet.marketType}, ${bet.selectionName}, 'back',
      ${bet.oddsAtPlacement.toFixed(4)}, ${bet.stake.toFixed(2)}, ${potentialProfit.toFixed(2)},
      ${bet.modelProbability.toFixed(6)}, ${betfairImplied?.toFixed(6) ?? null}, ${bet.calculatedEdge?.toFixed(6) ?? null},
      ${bet.opportunityScore.toFixed(2)}, ${bet.dataTier}, 'pending',
      ${bet.pinnacleOdds?.toFixed(4) ?? null}, ${bet.pinnacleImplied?.toFixed(6) ?? null}, ${bet.pinnacleEdgeCategory},
      'tier1', ${result.betfairBetId ?? null}, ${result.betfairMarketId ?? null},
      ${(result.sizeMatched ?? 0) > 0 ? 'matched' : 'unmatched'},
      ${(result.sizeMatched ?? 0).toFixed(2)}, ${(result.avgPriceMatched ?? 0).toFixed(4)}, NOW(),
      'betfair_exchange'
    ) RETURNING id
  `);

  const neonBetId = Number((insertBet.rows[0] as any).id);
  logger.info({ neonBetId, betfairBetId: result.betfairBetId, fixture: bet.fixture, market: bet.marketType }, "Bet recorded on Neon DB");
  return neonBetId;
}

export async function backfillExistingBetsToNeon(): Promise<{
  backfilled: number;
  skipped: number;
  errors: string[];
  details: any[];
}> {
  const devDbUrl = process.env.DEV_DATABASE_URL;
  if (!devDbUrl) throw new Error("DEV_DATABASE_URL not set");

  const devPool = createPool(devDbUrl);
  const errors: string[] = [];
  const details: any[] = [];
  let backfilled = 0, skipped = 0;

  try {
    const { rows: existingNeon } = await db.execute(sql`
      SELECT betfair_bet_id FROM paper_bets WHERE betfair_bet_id IS NOT NULL AND deleted_at IS NULL
    `) as any;
    const existingBfIds = new Set((existingNeon as any[]).map((r: any) => r.betfair_bet_id));

    const { rows } = await devPool.query(`
      SELECT pb.id, pb.market_type, pb.selection_name,
        pb.odds_at_placement::float, pb.stake::float, pb.opportunity_score::float,
        pb.model_probability::float, pb.data_tier, pb.pinnacle_odds::float,
        pb.pinnacle_implied::float, pb.pinnacle_edge_category, pb.calculated_edge::float,
        m.home_team, m.away_team, m.league, m.country, m.kickoff_time,
        m.betfair_event_id, m.api_fixture_id
      FROM paper_bets pb
      JOIN matches m ON pb.match_id = m.id
      WHERE pb.betfair_bet_id IS NOT NULL
        AND pb.deleted_at IS NULL
    `);

    logger.info({ total: rows.length }, "Backfill: found bets with betfair_bet_id on dev DB");

    for (const row of rows) {
      const devBetfairId = await devPool.query(
        `SELECT betfair_bet_id FROM paper_bets WHERE id = $1`, [row.id]
      );
      const bfBetId = devBetfairId.rows[0]?.betfair_bet_id;
      if (!bfBetId) { skipped++; continue; }
      if (existingBfIds.has(bfBetId)) {
        details.push({ fixture: `${row.home_team} vs ${row.away_team}`, status: "already_exists", betfairBetId: bfBetId });
        skipped++;
        continue;
      }

      try {
        const bet: ScanCandidate = {
          betId: row.id,
          matchId: 0,
          fixture: `${row.home_team} vs ${row.away_team}`,
          homeTeam: row.home_team ?? "",
          awayTeam: row.away_team ?? "",
          league: row.league ?? "",
          country: row.country ?? "",
          marketType: row.market_type,
          selectionName: row.selection_name,
          oddsAtPlacement: Number(row.odds_at_placement),
          stake: Number(row.stake),
          opportunityScore: Number(row.opportunity_score),
          modelProbability: Number(row.model_probability),
          dataTier: row.data_tier ?? "experiment",
          pinnacleOdds: row.pinnacle_odds ? Number(row.pinnacle_odds) : null,
          pinnacleImplied: row.pinnacle_implied ? Number(row.pinnacle_implied) : null,
          betfairEventId: row.betfair_event_id,
          kickoffTime: new Date(row.kickoff_time),
          apiFixtureId: row.api_fixture_id ? Number(row.api_fixture_id) : null,
          pinnacleEdgeCategory: row.pinnacle_edge_category ?? null,
          calculatedEdge: row.calculated_edge != null ? Number(row.calculated_edge) : null,
        };

        const devBetExtra = await devPool.query(
          `SELECT betfair_bet_id, betfair_market_id, betfair_status, betfair_size_matched::float, betfair_avg_price_matched::float FROM paper_bets WHERE id = $1`, [row.id]
        );
        const extra = devBetExtra.rows[0] ?? {};

        const neonBetId = await recordBetOnNeon(bet, {
          betfairBetId: extra.betfair_bet_id,
          betfairMarketId: extra.betfair_market_id,
          sizeMatched: extra.betfair_size_matched ?? 0,
          avgPriceMatched: extra.betfair_avg_price_matched ?? 0,
        });

        details.push({ fixture: bet.fixture, market: bet.marketType, selection: bet.selectionName, betfairBetId: bfBetId, neonBetId, status: "backfilled" });
        backfilled++;
      } catch (err) {
        errors.push(`${row.home_team} vs ${row.away_team}: ${String(err)}`);
      }
    }

    logger.info({ backfilled, skipped, errors: errors.length }, "Backfill to Neon complete");
    return { backfilled, skipped, errors, details };
  } finally {
    await devPool.end();
  }
}

export async function runCrossDbLaunchActivation(opts?: {
  dryRun?: boolean;
  maxBets?: number;
  maxStakePerBet?: number;
  excludeBetIds?: number[];
  minOpportunityScore?: number;
}): Promise<{
  mode: string;
  dryRun: boolean;
  totalScanned: number;
  qualified: number;
  skipped: { reason: string; count: number }[];
  placements: any[];
  summary: { placed: number; failed: number; skipped: number; totalStake: number };
}> {
  const dryRun = opts?.dryRun ?? true;
  const maxBets = opts?.maxBets ?? 20;
  const maxStakePerBet = opts?.maxStakePerBet ?? 10;
  const excludeBetIds = new Set(opts?.excludeBetIds ?? []);
  const minOppScore = opts?.minOpportunityScore ?? 60;

  const devDbUrl = process.env.DEV_DATABASE_URL;
  if (!devDbUrl) {
    throw new Error("DEV_DATABASE_URL not set — cannot read dev bets");
  }

  const isLive = isLiveMode();
  logger.info({ dryRun, isLive, maxBets, maxStakePerBet }, "Cross-DB launch activation starting");

  const devPool = createPool(devDbUrl);

  try {
    const now = new Date();
    const minKickoff = new Date(now.getTime() + 30 * 60 * 1000);
    const maxKickoff = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    const { rows } = await devPool.query(`
      SELECT pb.id AS bet_id, pb.match_id, pb.market_type, pb.selection_name,
        pb.odds_at_placement::float, pb.stake::float, pb.opportunity_score::float,
        pb.model_probability::float, pb.data_tier, pb.pinnacle_odds::float,
        pb.pinnacle_implied::float, pb.pinnacle_edge_category, pb.calculated_edge::float,
        m.home_team, m.away_team, m.league, m.country, m.kickoff_time,
        m.betfair_event_id, m.api_fixture_id
      FROM paper_bets pb
      JOIN matches m ON pb.match_id = m.id
      WHERE pb.status = 'pending'
        AND pb.deleted_at IS NULL
        AND m.kickoff_time > $1
        AND m.kickoff_time < $2
        AND pb.opportunity_score >= $3
        AND pb.pinnacle_odds IS NOT NULL
        AND pb.calculated_edge >= 0.02
        AND pb.pinnacle_edge_category IS NOT NULL
        AND pb.pinnacle_edge_category != ''
      ORDER BY pb.opportunity_score DESC
    `, [minKickoff.toISOString(), maxKickoff.toISOString(), minOppScore]);

    logger.info({ totalRows: rows.length }, "Cross-DB: raw candidates from dev DB");

    const skippedReasons: Record<string, number> = {};
    const incSkip = (r: string) => { skippedReasons[r] = (skippedReasons[r] ?? 0) + 1; };
    const qualified: ScanCandidate[] = [];
    const seenMatchMarket = new Set<string>();

    for (const row of rows) {
      if (excludeBetIds.has(Number(row.bet_id))) {
        incSkip("excluded_already_placed");
        continue;
      }

      const dedupKey = `${row.home_team}|${row.away_team}|${row.market_type}|${row.selection_name}`;
      if (seenMatchMarket.has(dedupKey)) {
        incSkip("duplicate_match_market");
        continue;
      }
      seenMatchMarket.add(dedupKey);

      const dataTier = row.data_tier ?? "experiment";
      if (dataTier === "abandoned" || dataTier === "demoted") {
        incSkip(`blocked_tier_${dataTier}`);
        continue;
      }

      const modelProb = Number(row.model_probability ?? 0);
      const pinnImpl = Number(row.pinnacle_implied ?? 0);
      const edgePct = (modelProb - pinnImpl) * 100;
      if (edgePct < 2) {
        incSkip("pinnacle_edge_insufficient");
        continue;
      }

      const isPromoted = dataTier === "promoted";
      if (!isPromoted) {
        const drResult = await devPool.query(
          `SELECT tier1_eligible FROM data_richness_cache
           WHERE LOWER(league) = LOWER($1) AND LOWER(country) = LOWER($2)
             AND market_type = $3 LIMIT 1`,
          [row.league ?? "", row.country ?? "", row.market_type],
        );
        const isRichData = drResult.rows[0]?.tier1_eligible === true;
        if (!isRichData) {
          incSkip("data_richness_insufficient");
          continue;
        }
      }

      if (!row.betfair_event_id) {
        incSkip("no_betfair_event_id");
        continue;
      }

      qualified.push({
        betId: row.bet_id,
        matchId: row.match_id,
        fixture: `${row.home_team} vs ${row.away_team}`,
        homeTeam: row.home_team ?? "",
        awayTeam: row.away_team ?? "",
        league: row.league ?? "",
        country: row.country ?? "",
        marketType: row.market_type,
        selectionName: row.selection_name,
        oddsAtPlacement: Number(row.odds_at_placement),
        stake: Math.min(Number(row.stake), maxStakePerBet),
        opportunityScore: Number(row.opportunity_score),
        modelProbability: modelProb,
        dataTier,
        pinnacleOdds: Number(row.pinnacle_odds),
        pinnacleImplied: pinnImpl,
        betfairEventId: row.betfair_event_id,
        kickoffTime: new Date(row.kickoff_time),
        apiFixtureId: row.api_fixture_id ? Number(row.api_fixture_id) : null,
        pinnacleEdgeCategory: row.pinnacle_edge_category ?? null,
        calculatedEdge: row.calculated_edge != null ? Number(row.calculated_edge) : null,
      });
    }

    let alreadyPlacedKeys = new Set<string>();
    try {
      const countResult = await db.execute(sql`SELECT COUNT(*) AS cnt FROM paper_bets`);
      const totalBets = Number((countResult.rows[0] as any)?.cnt ?? 0);
      if (totalBets > 0) {
        const alreadyPlacedRows = await db.execute(sql`
          SELECT DISTINCT home_team || '|' || away_team || '|' || market_type || '|' || selection_name AS dedup_key
          FROM paper_bets
          WHERE deleted_at IS NULL
        `);
        alreadyPlacedKeys = new Set(
          (alreadyPlacedRows.rows as any[]).map(r => r.dedup_key)
        );
      }
    } catch (err) {
      logger.warn({ err }, "Cross-DB: could not check already-placed bets on Neon — proceeding without dedup");
    }
    logger.info({ alreadyPlacedCount: alreadyPlacedKeys.size }, "Cross-DB: bets already on Neon");

    for (const bet of [...qualified]) {
      const dedupKey = `${bet.homeTeam}|${bet.awayTeam}|${bet.marketType}|${bet.selectionName}`;
      if (alreadyPlacedKeys.has(dedupKey)) {
        incSkip("already_placed_on_betfair");
        qualified.splice(qualified.indexOf(bet), 1);
      }
    }

    const skippedList = Object.entries(skippedReasons).map(([reason, count]) => ({ reason, count }));
    logger.info({ qualified: qualified.length, skipped: skippedList }, "Cross-DB: filtered candidates");

    const toPlace = qualified.slice(0, maxBets);
    const placements: any[] = [];
    let placed = 0, failed = 0, skipped = 0, totalStake = 0;

    for (const bet of toPlace) {
      const pinnEdgePct = ((bet.modelProbability - (bet.pinnacleImplied ?? 0)) * 100);
      const path = bet.dataTier === "promoted" ? "promoted" : "data_richness";

      if (bet.stake < 2) {
        placements.push({
          betId: bet.betId, fixture: bet.fixture, market: bet.marketType,
          selection: bet.selectionName, stake: bet.stake, odds: bet.oddsAtPlacement,
          opp: bet.opportunityScore, pinnEdge: Math.round(pinnEdgePct * 100) / 100,
          path, status: "skipped", reason: "Stake below £2 minimum",
        });
        skipped++;
        continue;
      }

      const internalToBetfairType: Record<string, string> = {
        "DOUBLE_CHANCE": "DOUBLE_CHANCE",
        "OVER_UNDER_05": "OVER_UNDER_05",
        "OVER_UNDER_15": "OVER_UNDER_15",
        "OVER_UNDER_25": "OVER_UNDER_25",
        "OVER_UNDER_35": "OVER_UNDER_35",
        "OVER_UNDER_45": "OVER_UNDER_45",
        "BTTS": "BOTH_TEAMS_TO_SCORE",
        "BOTH_TEAMS_TO_SCORE": "BOTH_TEAMS_TO_SCORE",
      };
      const needsPreCheck = bet.marketType !== "MATCH_ODDS" && bet.homeTeam && bet.awayTeam;
      if (needsPreCheck) {
        const expectedBfType = internalToBetfairType[bet.marketType] ?? bet.marketType;
        try {
          const rawEventId = bet.betfairEventId && !bet.betfairEventId.startsWith("af_") ? bet.betfairEventId : null;
          const eventId = rawEventId ?? await findEventIdByTeamNames(bet.homeTeam, bet.awayTeam);
          if (eventId) {
            const eventMarkets = await listMarketsByEventId(eventId);
            const hasMarket = eventMarkets.some(m => m.description?.marketType === expectedBfType);
            if (!hasMarket) {
              const availableTypes = [...new Set(eventMarkets.map(m => m.description?.marketType).filter(Boolean))];
              logger.info({ fixture: bet.fixture, eventId, marketType: bet.marketType, expectedBfType, availableTypes }, "Market not available on exchange — skipping pre-flight");
              placements.push({
                betId: bet.betId, fixture: bet.fixture, market: bet.marketType,
                selection: bet.selectionName, stake: bet.stake, odds: bet.oddsAtPlacement,
                opp: bet.opportunityScore, pinnEdge: Math.round(pinnEdgePct * 100) / 100,
                path, status: "skipped", reason: `${bet.marketType} unavailable on exchange (pre-check)`,
              });
              skipped++;
              continue;
            }
            logger.info({ fixture: bet.fixture, eventId, marketType: bet.marketType }, "Market confirmed available — proceeding");
          } else {
            logger.warn({ fixture: bet.fixture }, "Could not resolve Betfair event — skipping");
            placements.push({
              betId: bet.betId, fixture: bet.fixture, market: bet.marketType,
              selection: bet.selectionName, stake: bet.stake, odds: bet.oddsAtPlacement,
              opp: bet.opportunityScore, pinnEdge: Math.round(pinnEdgePct * 100) / 100,
              path, status: "skipped", reason: "Event not found on Betfair",
            });
            skipped++;
            continue;
          }
        } catch (err) {
          logger.warn({ err, fixture: bet.fixture }, "Market pre-check failed — skipping");
          placements.push({
            betId: bet.betId, fixture: bet.fixture, market: bet.marketType,
            selection: bet.selectionName, stake: bet.stake, odds: bet.oddsAtPlacement,
            opp: bet.opportunityScore, pinnEdge: Math.round(pinnEdgePct * 100) / 100,
            path, status: "skipped", reason: "Market pre-check error",
          });
          skipped++;
          continue;
        }
      }

      if (dryRun) {
        placements.push({
          betId: bet.betId, fixture: bet.fixture, market: bet.marketType,
          selection: bet.selectionName, stake: bet.stake, odds: bet.oddsAtPlacement,
          opp: bet.opportunityScore, pinnEdge: Math.round(pinnEdgePct * 100) / 100,
          path, status: "dry_run",
          betfairEventId: bet.betfairEventId,
        });
        placed++;
        totalStake += bet.stake;
        continue;
      }

      try {
        const result = await placeLiveBetOnBetfair({
          internalBetId: bet.betId,
          betfairEventId: bet.betfairEventId!,
          marketType: bet.marketType,
          selectionName: bet.selectionName,
          odds: bet.oddsAtPlacement,
          stake: bet.stake,
          homeTeam: bet.homeTeam,
          awayTeam: bet.awayTeam,
        });

        if (result.success) {
          placed++;
          totalStake += bet.stake;

          let neonBetId: number | null = null;
          try {
            neonBetId = await recordBetOnNeon(bet, result);
          } catch (recordErr) {
            logger.error({ err: recordErr, betId: bet.betId, fixture: bet.fixture }, "Failed to record bet on Neon — bet is LIVE on Betfair but not in dashboard DB");
          }

          placements.push({
            betId: bet.betId, fixture: bet.fixture, market: bet.marketType,
            selection: bet.selectionName, stake: bet.stake, odds: bet.oddsAtPlacement,
            opp: bet.opportunityScore, pinnEdge: Math.round(pinnEdgePct * 100) / 100,
            path, status: "placed",
            betfairBetId: result.betfairBetId,
            sizeMatched: result.sizeMatched,
            avgPrice: result.avgPriceMatched,
            neonBetId,
          });
        } else {
          failed++;
          placements.push({
            betId: bet.betId, fixture: bet.fixture, market: bet.marketType,
            selection: bet.selectionName, stake: bet.stake, odds: bet.oddsAtPlacement,
            opp: bet.opportunityScore, pinnEdge: Math.round(pinnEdgePct * 100) / 100,
            path, status: "failed", error: result.error,
          });
        }
      } catch (err) {
        failed++;
        placements.push({
          betId: bet.betId, fixture: bet.fixture, market: bet.marketType,
          selection: bet.selectionName, stake: bet.stake, odds: bet.oddsAtPlacement,
          opp: bet.opportunityScore, pinnEdge: Math.round(pinnEdgePct * 100) / 100,
          path, status: "error", error: String(err),
        });
      }
    }

    const report = {
      mode: isLive ? "LIVE" : "PAPER",
      dryRun,
      totalScanned: rows.length,
      qualified: qualified.length,
      skipped: skippedList,
      placements,
      summary: { placed, failed, skipped, totalStake: Math.round(totalStake * 100) / 100 },
    };

    logger.info({ summary: report.summary }, "Cross-DB launch activation complete");
    return report;
  } finally {
    await devPool.end();
  }
}
