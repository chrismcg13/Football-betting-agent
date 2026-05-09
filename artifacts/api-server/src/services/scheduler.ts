import cron from "node-cron";
import { logger } from "../lib/logger";
import { runDataIngestion } from "./dataIngestion";
import { runFeatureEngineForUpcomingMatches } from "./featureEngine";
import { detectValueBets } from "./valueDetection";
import { placePaperBet, settleBets, getAgentStatus, getBankroll, deduplicatePendingBets, backfillCornersCardsStats, getConfigValue, setConfigValue, resetExchangeCaptureCounters, getExchangeCaptureCounters } from "./paperTrading";
import { ABSOLUTE_BANKROLL_FLOOR_GBP, checkLiveCircuitBreakers, getAvailableBalance } from "./liveRiskManager";
import { isLiveMode, listMarketsByEventId, MARKET_TYPE_MAP as BETFAIR_MARKET_TYPE_MAP, isMarketSuppressed, getSuppressionStats } from "./betfairLive";
import { runAllRiskChecks } from "./riskManager";
import { getModelVersion } from "./predictionEngine";
import { runLearningLoop } from "./learningLoop";
import {
  fetchAndStoreOddsForAllUpcoming,
  fetchTeamStatsForUpcomingMatches,
  ingestFixturesForDiscoveredLeagues,
  calculateLeaguePerformanceScores,
  deactivateLowValueLeagues,
  getLeaguesWithPendingBets,
  capturePreKickoffLineups,
  fetchInjuriesForUpcomingMatches,
  fetchTeamMetadataForUpcomingMatches,
  fetchPlayerMetadataForRecentInjuries,
  getApiBudgetStatus,
} from "./apiFootball";
import { runXGIngestion } from "./xgIngestionService";
import {
  runOddspapiFixtureMapping,
  getOddspapiFixtureId,
  getOddspapiValidation,
  prefetchAndStoreOddsPapiOdds,
  loadOddsPapiCacheFromSnapshots,
  runKickoffProximityPrefetch,
  buildPinnacleValidationFromApiFootball,
  fetchAndStoreClosingLineForPendingBets,
  type OddsPapiValidationCache,
  logDailyBudgetSummary,
  pinnaclePreBetFilter,
  fetchPreKickoffSnapshots,
  trackLineMovements,
  backfillFilteredBetOutcomes,
  analyseSharpMovements,
  selectionNameVariants,
  derivePinnacleDCFromMatchOdds,
  backfillPinnacleUnified,
  captureAllPendingSnapshots,
} from "./oddsPapi";
import { applyCorrelationDetection, type BetCandidate } from "./correlationDetector";
import { fetchRecentFixtureResults, teamNameMatch, fetchMatchStatsForSettlement, backfillPinnacleSnapshotsFromAf } from "./apiFootball";
import { runLeagueDiscovery, seedBaselineLeagues, updatePinnacleOddsFromActualMappings, seedCompetitionConfig } from "./leagueDiscovery";
import { runBetfairReverseMapping } from "./betfairFirstUniverse";
import { db, pool, agentConfigTable, leagueEdgeScoresTable, paperBetsTable, matchesTable } from "@workspace/db";
import { eq, and, inArray, sql, gte, lte } from "drizzle-orm";
import { runPromotionEngine, runProposalGenerator } from "./promotionEngine";
import { runWeeklyExperimentAnalysis } from "./experimentAnalysis";
import { syncDevToProd } from "./syncDevToProd";
import { reconcileSettlements, getAccountFunds } from "./betfairLive";
import { recalculateAllDataRichness } from "./dataRichness";
import { reviewLiveThreshold } from "./liveThresholdReview";
import { checkRelayHealth, isRelayConfigured, relayGetLiquidity, relayGetMarket } from "./vpsRelay";
import { runOrderManagement, getTicksWithin } from "./orderManager";
import { liquiditySnapshotsTable } from "@workspace/db";
import { runExchangeBookSweep } from "./exchangeBookSweep";

// ===================== Status tracking =====================

export interface JobStatus {
  lastRunAt: Date | null;
  lastRunResult: "success" | "error" | "skipped" | null;
  isRunning: boolean;
  runCount: number;
}

const jobStatus: Record<string, JobStatus> = {
  ingestion:           { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  features:            { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  trading:             { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  learning:            { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  oddspapi_map:        { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  exchange_book_sweep: { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
};

export function getSchedulerStatus(): Record<string, JobStatus> {
  return { ...jobStatus };
}

function markRun(job: string, result: "success" | "error" | "skipped") {
  const s = jobStatus[job];
  if (s) {
    s.lastRunAt = new Date();
    s.lastRunResult = result;
    s.runCount += 1;
    s.isRunning = false;
  }
}

function markStart(job: string) {
  const s = jobStatus[job];
  if (s) s.isRunning = true;
}

async function trackCronExecution(
  jobName: string,
  fn: () => Promise<number | void>,
): Promise<void> {
  const startedAt = new Date();
  try {
    const { cronExecutionsTable } = await import("@workspace/db");
    const recordsProcessed = (await fn()) ?? 0;
    const durationMs = Date.now() - startedAt.getTime();
    await db.insert(cronExecutionsTable).values({
      jobName,
      startedAt,
      completedAt: new Date(),
      success: true,
      recordsProcessed: typeof recordsProcessed === "number" ? recordsProcessed : 0,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt.getTime();
    try {
      const { cronExecutionsTable } = await import("@workspace/db");
      await db.insert(cronExecutionsTable).values({
        jobName,
        startedAt,
        completedAt: new Date(),
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs,
      });
    } catch (_) {}
    throw err;
  }
}

// ===================== Guard flags =====================
// 2026-05-08 (§4.5 of root-cause-analysis applied to all in-process locks):
// previously every cron had its own module-level boolean lock with NO
// stale-detection. If the underlying function hung (HTTP timeout that
// never resolved, await chain blocked, etc.), the boolean stayed true
// forever and every subsequent tick silently skipped. Today's invisible
// outages traced to this pattern: trading cycle (5 min), ingestion (5+
// hours since 10:30 lost). The lockManager wrapper provides stale auto-
// release at thresholds tuned per-cron.
//
// Stale thresholds set to ~2× expected p99 duration based on cron_executions
// avg_ms readings:
//   ingestion           75 min normal → 150 min stale
//   features             4 min normal →  20 min stale
//   exchange_book_sweep  4 min normal →  20 min stale
//   trading_cycle      2-3 min normal →   5 min stale (hot path; aggressive)
//   settlement         <1 min normal →    5 min stale
import { registerLock } from "../lib/lockManager";
const ingestionLock = registerLock("ingestion_run", { staleAfterMs: 150 * 60 * 1000 });
const featureLock = registerLock("feature_run", { staleAfterMs: 20 * 60 * 1000 });
const exchangeBookSweepLock = registerLock("exchange_book_sweep", { staleAfterMs: 20 * 60 * 1000 });

let tradingCycleRunning = false;
let tradingCycleAcquiredAt: number | null = null;
const TRADING_CYCLE_STALE_MS = 5 * 60 * 1000;

export function resetTradingCycleLock(): { wasHeld: boolean; heldFor: number | null } {
  const wasHeld = tradingCycleRunning;
  const heldFor = tradingCycleAcquiredAt != null ? Date.now() - tradingCycleAcquiredAt : null;
  tradingCycleRunning = false;
  tradingCycleAcquiredAt = null;
  return { wasHeld, heldFor };
}
// ===================== Safe wrappers =====================

async function safeRunIngestion(): Promise<void> {
  const r = await ingestionLock.withLock(async () => {
    markStart("ingestion");
    try {
      await trackCronExecution("ingestion", async () => {
        await runDataIngestion();
      });
      markRun("ingestion", "success");
      void safeRunFeatures();
    } catch (err) {
      logger.error({ err }, "Scheduled data ingestion run failed");
      markRun("ingestion", "error");
      throw err;
    }
  });
  if (r.skipped) {
    logger.warn({ reason: r.reason, heldMs: r.heldMs }, "Data ingestion skipped — lock held");
    markRun("ingestion", "skipped");
  }
}

async function safeRunFeatures(): Promise<void> {
  const r = await featureLock.withLock(async () => {
    markStart("features");
    try {
      await trackCronExecution("features", async () => {
        await runFeatureEngineForUpcomingMatches();
      });
      markRun("features", "success");
    } catch (err) {
      logger.error({ err }, "Scheduled feature computation run failed");
      markRun("features", "error");
      throw err;
    }
  });
  if (r.skipped) {
    logger.warn({ reason: r.reason, heldMs: r.heldMs }, "Feature computation skipped — lock held");
    markRun("features", "skipped");
  }
}

// ===================== Exchange book sweep =====================
// Populates odds_snapshots with source='betfair_exchange' rows so the Prompt 5
// venue-anchored pricing picker has live exchange data to consume. Runs
// unconditionally whenever Betfair credentials are configured — NOT gated on
// agent_config.data_source.

async function safeRunExchangeBookSweep(opts?: { hoursAhead?: number }): Promise<void> {
  const r = await exchangeBookSweepLock.withLock(async () => {
    markStart("exchange_book_sweep");
    try {
      await trackCronExecution("exchange_book_sweep", async () => {
        const result = await runExchangeBookSweep(opts);
        return result.snapshotsWritten;
      });
      markRun("exchange_book_sweep", "success");
    } catch (err) {
      logger.error({ err }, "Scheduled exchange book sweep failed");
      markRun("exchange_book_sweep", "error");
      throw err;
    }
  });
  if (r.skipped) {
    logger.warn({ reason: r.reason, heldMs: r.heldMs }, "Exchange book sweep skipped — lock held");
    markRun("exchange_book_sweep", "skipped");
  }
}

// ===================== OddsPapi fixture mapping =====================

async function safeRunOddspapiMapping(): Promise<void> {
  markStart("oddspapi_map");
  try {
    const result = await runOddspapiFixtureMapping();
    logger.info(result, "OddsPapi fixture mapping complete");
    markRun("oddspapi_map", "success");
  } catch (err) {
    logger.error({ err }, "OddsPapi fixture mapping failed");
    markRun("oddspapi_map", "error");
  }
}

// ===================== Liquidity snapshot helper =====================

async function logLiquiditySnapshot(
  matchId: number,
  marketType: string,
  selectionName: string,
  targetOdds: number,
  desiredStake: number,
): Promise<void> {
  try {
    const match = await db
      .select({ betfairEventId: matchesTable.betfairEventId })
      .from(matchesTable)
      .where(eq(matchesTable.id, matchId))
      .limit(1);

    const eventId = match[0]?.betfairEventId;
    if (!eventId) return;

    const marketData = await relayGetMarket(eventId);
    if (!marketData?.markets?.length) return;

    const relevantMarket = marketData.markets.find((m) =>
      m.marketType === marketType || m.marketName?.toUpperCase().includes(marketType.replace("_", " ")),
    ) ?? marketData.markets[0];

    const liquidity = await relayGetLiquidity(relevantMarket.marketId);
    if (!liquidity?.runners?.length) return;

    const runner = relevantMarket.runners?.find(
      (r) => r.name?.toUpperCase().includes(selectionName.toUpperCase()),
    );
    const runnerData = runner
      ? liquidity.runners.find((r) => r.selectionId === runner.selectionId)
      : liquidity.runners[0];

    if (!runnerData) return;

    const backPrices = runnerData.backPrices ?? [];
    const atPrice = backPrices.find((p) => Math.abs(p.price - targetOdds) < 0.005)?.size ?? 0;
    const tick1Range = getTicksWithin(targetOdds, 1);
    const tick3Range = getTicksWithin(targetOdds, 3);
    const within1 = backPrices
      .filter((p) => p.price >= tick1Range.min && p.price <= tick1Range.max)
      .reduce((s, p) => s + p.size, 0);
    const within3 = backPrices
      .filter((p) => p.price >= tick3Range.min && p.price <= tick3Range.max)
      .reduce((s, p) => s + p.size, 0);
    const shortfall = Math.max(0, desiredStake - within3);

    await db.insert(liquiditySnapshotsTable).values({
      matchId,
      marketType,
      selectionName,
      betfairMarketId: relevantMarket.marketId,
      selectionId: runner?.selectionId ?? null,
      targetOdds: String(targetOdds),
      availableAtPrice: String(atPrice),
      availableWithin1Tick: String(within1),
      availableWithin3Ticks: String(within3),
      totalMarketVolume: String(liquidity.totalMatched ?? 0),
      desiredStake: String(desiredStake),
      liquidityShortfall: String(shortfall),
      depthData: { back: backPrices.slice(0, 5), lay: (runnerData.layPrices ?? []).slice(0, 5) },
    });

    if (shortfall > 0) {
      logger.info(
        { matchId, marketType, selectionName, shortfall: shortfall.toFixed(2), available: within3.toFixed(2), desired: desiredStake },
        "Liquidity shortfall detected for bet",
      );
    }
  } catch (err) {
    logger.debug({ err, matchId }, "Liquidity snapshot logging failed — non-blocking");
  }
}

// ===================== Trading cycle =====================

const TRADING_LOCK_ID = 100001;
const SETTLEMENT_LOCK_ID = 100002;

const lockClients = new Map<number, Awaited<ReturnType<typeof pool.connect>>>();

async function tryAdvisoryLock(lockId: number): Promise<boolean> {
  try {
    const client = await pool.connect();
    const result = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]);
    if (result.rows[0]?.acquired === true) {
      lockClients.set(lockId, client);
      return true;
    }
    client.release();
    return false;
  } catch {
    return false;
  }
}

async function releaseAdvisoryLock(lockId: number): Promise<void> {
  const client = lockClients.get(lockId);
  if (!client) return;
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
  } catch { /* best effort */ } finally {
    client.release();
    lockClients.delete(lockId);
  }
}

export async function runTradingCycle(options?: {
  maxHoursAhead?: number;
  minHoursAhead?: number;
  tier?: "near" | "far";
}): Promise<{
  betsPlaced: number;
  betsSettled: number;
  riskTriggered: boolean;
  tier: string;
  fixtureWindowHours: number;
  signalGeneratedAt?: string;
}> {
  const tier = options?.tier ?? "near";
  const minHours = options?.minHoursAhead ?? 1;
  const maxHours = options?.maxHoursAhead ?? (tier === "near" ? 48 : 168);
  const cycleStartedAt = Date.now();

  if (tradingCycleRunning) {
    const heldMs = tradingCycleAcquiredAt != null ? Date.now() - tradingCycleAcquiredAt : 0;
    if (heldMs > TRADING_CYCLE_STALE_MS) {
      logger.warn(
        { tier, heldMs, staleMs: TRADING_CYCLE_STALE_MS },
        "Trading cycle lock held beyond stale threshold — force-releasing and proceeding",
      );
      tradingCycleRunning = false;
      tradingCycleAcquiredAt = null;
    } else {
      logger.warn({ tier, heldMs }, "Trading cycle already in progress — skipping this run");
      markRun("trading", "skipped");
      return { betsPlaced: 0, betsSettled: 0, riskTriggered: false, tier, fixtureWindowHours: maxHours };
    }
  }

  tradingCycleRunning = true;
  tradingCycleAcquiredAt = Date.now();
  markStart("trading");
  resetExchangeCaptureCounters();

  try {
    logger.info({ tier, minHours, maxHours }, "Starting trading cycle");

    // 1. Settle any finished bets first
    const settlement = await settleBets();
    logger.info(
      {
        settled: settlement.settled,
        won: settlement.won,
        lost: settlement.lost,
        pnl: settlement.totalPnl,
        paper_bets_pending_retry: settlement.paperPendingRetry,
        paper_bets_timeout_lost: settlement.paperTimeoutLoss,
        paper_bets_abandonment_void: settlement.paperAbandonmentVoid,
      },
      "Settlement complete",
    );

    // 2. Run risk checks
    const riskResult = await runAllRiskChecks();
    if (riskResult.anyTriggered) {
      logger.warn({ tier }, "Risk check triggered — skipping bet placement this cycle");
      markRun("trading", "success");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: true, tier, fixtureWindowHours: maxHours };
    }

    // 3. Check agent is running
    const agentStatus = await getAgentStatus();
    if (agentStatus !== "running") {
      logger.info({ agentStatus, tier }, "Agent not running — skipping bet placement");
      markRun("trading", "skipped");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false, tier, fixtureWindowHours: maxHours };
    }

    // 4. Check model is available
    const modelVersion = getModelVersion();
    if (!modelVersion) {
      logger.info({ tier }, "No model loaded — skipping value detection");
      markRun("trading", "skipped");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false, tier, fixtureWindowHours: maxHours };
    }

    // 5. Detect value bets within the specified kickoff window
    const now = new Date();
    const earliest = new Date(now.getTime() + minHours * 60 * 60 * 1000);
    const latest   = new Date(now.getTime() + maxHours * 60 * 60 * 1000);

    // 5a. Load pre-fetched OddsPapi odds from DB snapshots (no API calls here).
    //     The scheduled 6am bulk prefetch and 12pm midday refresh populate the DB.
    //     Only cache misses in step 6 will trigger on-demand API calls (max 20/cycle).
    const [oddsPapiCacheRaw, afPinnacleCache] = await Promise.all([
      loadOddsPapiCacheFromSnapshots(earliest, latest),
      // Build Pinnacle validation cache from API-Football's own Pinnacle bookmaker data.
      // This is our primary source of real Pinnacle odds — API-Football includes Pinnacle
      // as one of its bookmakers, so we already have these odds in odds_snapshots.
      buildPinnacleValidationFromApiFootball(earliest, latest),
    ]);

    // Merge at selection level: OddsPapi takes priority for selections it has;
    // AF-Pinnacle fills in the rest. This avoids OddsPapi overwriting all AF
    // corners/O/U data just because it fetched MATCH_ODDS for that fixture.
    const oddsPapiCache: OddsPapiValidationCache = new Map<number, Record<string, import("./oddsPapi").OddspapiValidation>>();
    const allMatchIds = new Set([...afPinnacleCache.keys(), ...oddsPapiCacheRaw.keys()]);
    for (const matchId of allMatchIds) {
      const afEntry = afPinnacleCache.get(matchId) ?? {};
      const opEntry = oddsPapiCacheRaw.get(matchId) ?? {};
      // OddsPapi wins per-selection; AF-Pinnacle fills gaps
      oddsPapiCache.set(matchId, { ...afEntry, ...opEntry });
    }
    const pinnacleMatchIds = new Set(oddsPapiCache.keys());
    const allUpcoming = await db
      .select({ id: matchesTable.id, league: matchesTable.league })
      .from(matchesTable)
      .where(and(
        eq(matchesTable.status, "scheduled"),
        gte(matchesTable.kickoffTime, earliest),
        lte(matchesTable.kickoffTime, latest),
      ));
    const leagueTotals = new Map<string, { total: number; covered: number }>();
    for (const m of allUpcoming) {
      const entry = leagueTotals.get(m.league) ?? { total: 0, covered: 0 };
      entry.total++;
      if (pinnacleMatchIds.has(m.id)) entry.covered++;
      leagueTotals.set(m.league, entry);
    }
    const pinnacleLeagueBreakdown: Record<string, string> = {};
    for (const [league, { total, covered }] of [...leagueTotals.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 25)) {
      pinnacleLeagueBreakdown[league] = `${covered}/${total}`;
    }
    logger.info(
      {
        oddsPapiMatches: oddsPapiCacheRaw.size,
        afPinnacleMatches: afPinnacleCache.size,
        mergedTotal: oddsPapiCache.size,
        totalSelections: [...oddsPapiCache.values()].reduce((n, m) => n + Object.keys(m).length, 0),
        pinnacleLeagueBreakdown,
        overallCoverage: `${oddsPapiCache.size}/${allUpcoming.length} (${allUpcoming.length > 0 ? Math.round(oddsPapiCache.size / allUpcoming.length * 100) : 0}%)`,
      },
      "Pinnacle validation cache ready (OddsPapi + API-Football Pinnacle merged, selection-level)",
    );

    const valueSummary = await detectValueBets({ earliestKickoff: earliest, latestKickoff: latest });
    const timely = valueSummary.valueBets;

    const funnel: Record<string, number> = {
      "01_matches_evaluated": valueSummary.matchesEvaluated,
      "02_selections_evaluated": valueSummary.selectionsEvaluated,
      "03_value_bets_found": valueSummary.valueBets.length,
      // Pricing-pipeline rejection visibility (Prompt 5)
      "02a_rej_no_betfair_exchange": valueSummary.pricingRejectNoBetfairExchange,
      "02b_rej_no_fair_value_source": valueSummary.pricingRejectNoFairValueSource,
    };

    logger.info(
      {
        totalValueBets: valueSummary.valueBets.length,
        timelyBets: timely.length,
        realOdds: valueSummary.realOddsCount,
        syntheticOdds: valueSummary.syntheticOddsCount,
        byMarketType: valueSummary.byMarketType,
        window: `${minHours}h-${maxHours}h before kickoff`,
      },
      "Value detection complete for trading cycle",
    );

    if (timely.length === 0) {
      markRun("trading", "success");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    // 6. OddsPapi validation — Pinnacle +5 bonus scoring
    // Sort by base opportunity score; try to get Pinnacle data for top candidates
    const sorted = [...timely].sort((a, b) => b.opportunityScore - a.opportunityScore);

    // Load league edge scores for dynamic allocation ranking
    const leagueEdgeRows = await db
      .select({ league: leagueEdgeScoresTable.league, confidenceScore: leagueEdgeScoresTable.confidenceScore })
      .from(leagueEdgeScoresTable);
    const leagueEdgeMap = new Map(leagueEdgeRows.map((r) => [r.league, r.confidenceScore]));

    // Rank by league_edge_score × opportunity_score for OddsPapi budget allocation
    const rankedForOddsPapi = [...sorted].sort((a, b) => {
      const sa = (leagueEdgeMap.get(a.league) ?? 50) * a.opportunityScore;
      const sb = (leagueEdgeMap.get(b.league) ?? 50) * b.opportunityScore;
      return sb - sa;
    });
    // Pinnacle upgrade: validate ALL candidates regardless of league tier or fixture window.
    // Budget is now 3,300/day (100,000/month) — enough to cover every candidate.

    type OddsValidation = Awaited<ReturnType<typeof getOddspapiValidation>>;

    // CACHE-ONLY validation. The trading cycle MUST NOT make external API calls
    // (1.2s sleeps + HTTP latency + 429 retries previously kept cycles running
    // 10+ minutes and blocked live bet placement). The bulk prefetch cron
    // (every 4h) is responsible for populating oddsPapiCache. If a candidate
    // has no cached data, it gets evaluated without the Pinnacle alignment
    // bonus — picked up on the next cycle once the cache is refreshed.
    //
    // To re-enable on-demand calls (NOT recommended), set ENABLE_ONDEMAND_ODDSPAPI=true.
    const ENABLE_ONDEMAND_ODDSPAPI = process.env.ENABLE_ONDEMAND_ODDSPAPI === "true";
    const enhancedCandidates: Array<{ bet: typeof rankedForOddsPapi[number]; validation: OddsValidation | null; effectiveScore: number }> = [];
    const validationStart = Date.now();
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const bet of rankedForOddsPapi) {
      try {
        let validation: OddsValidation | null = null;

        const cachedMatch = oddsPapiCache.get(bet.matchId);
        if (cachedMatch) {
          const variants = selectionNameVariants(bet.selectionName);
          const raw = variants.reduce<import("./oddsPapi").OddspapiValidation | undefined>((found, v) => found ?? cachedMatch[v], undefined);
          if (raw) {
            let pinnacleAligned = false;
            let isContrarian = false;
            if (raw.pinnacleImplied !== null) {
              const diff = bet.modelProbability - raw.pinnacleImplied;
              if (diff < 0) {
                pinnacleAligned = true;
              } else if (Math.abs(diff) <= 0.03) {
                pinnacleAligned = true;
              } else if (diff > 0.08) {
                isContrarian = true;
              }
            }
            validation = { ...raw, pinnacleAligned, isContrarian };
            cacheHits++;
          } else {
            cacheMisses++;
          }
        } else {
          cacheMisses++;
        }

        // OPT-IN escape hatch — disabled by default. See note above.
        if (!validation && ENABLE_ONDEMAND_ODDSPAPI) {
          const oddspapiId = await getOddspapiFixtureId(bet.matchId);
          if (oddspapiId) {
            validation = await getOddspapiValidation(
              oddspapiId,
              bet.marketType,
              bet.selectionName,
              bet.backOdds,
            );
          }
        }

        let effectiveScore = bet.opportunityScore;
        if (validation?.hasPinnacleData) {
          if (validation.pinnacleAligned) effectiveScore += 10;
          else if (validation.isContrarian) effectiveScore -= 10;
        }

        enhancedCandidates.push({ bet, validation: validation ?? null, effectiveScore });
      } catch (err) {
        logger.warn({ err, matchId: bet.matchId }, "OddsPapi validation failed — using base score");
        enhancedCandidates.push({ bet, validation: null, effectiveScore: bet.opportunityScore });
      }
    }

    logger.info(
      {
        candidates: rankedForOddsPapi.length,
        cacheHits,
        cacheMisses,
        durationMs: Date.now() - validationStart,
        ondemandEnabled: ENABLE_ONDEMAND_ODDSPAPI,
      },
      "OddsPapi cache-only validation complete",
    );

    // 7. Build final candidate list with effective scores
    type BetEntry = {
      bet: typeof timely[number];
      effectiveScore: number;
      validation: OddsValidation | null;
    };

    // All candidates are now enhanced (Pinnacle-validated or cache-hit).
    // Sort by effective score so the best opportunities are placed first.
    const allEntriesUnfiltered: BetEntry[] = enhancedCandidates
      .map(({ bet, validation, effectiveScore }) => ({
        bet,
        effectiveScore,
        validation: validation ?? null,
      }))
      .sort((a, b) => b.effectiveScore - a.effectiveScore);

    // ── Fix 2: Pre-check Betfair Exchange market availability (live mode only)
    // Avoid wasting cycle slots on candidates whose market isn't listed on
    // Betfair for the event. Batch one listMarketCatalogue call per unique
    // event, cache results for the cycle, then filter synchronously.
    let allEntries: BetEntry[] = allEntriesUnfiltered;
    let funnelBfMarketUnavailable = 0;
    let funnelBfNoEventId = 0;
    let funnelBfTypeUnsupported = 0;
    let funnelBfSuppressed = 0;
    const ENABLE_BETFAIR_PRECHECK = process.env.ENABLE_BETFAIR_PRECHECK === "true";
    if (ENABLE_BETFAIR_PRECHECK && isLiveMode() && allEntriesUnfiltered.length > 0) {
      const liveCandidates = allEntriesUnfiltered;
      const matchIds = [...new Set(liveCandidates.map(e => e.bet.matchId))];
      const matchRows = await db
        .select({ id: matchesTable.id, betfairEventId: matchesTable.betfairEventId })
        .from(matchesTable)
        .where(inArray(matchesTable.id, matchIds));
      const eventIdByMatch = new Map<number, string | null>();
      for (const m of matchRows) {
        const ev = m.betfairEventId;
        eventIdByMatch.set(m.id, ev && !ev.startsWith("af_") ? ev : null);
      }

      // Limit catalogue lookups to top-N candidates by score to bound API calls.
      const TOP_N_FOR_CATALOGUE = 200;
      const topCandidates = liveCandidates.slice(0, TOP_N_FOR_CATALOGUE);
      const eventsNeeded = new Set<string>();
      for (const e of topCandidates) {
        const ev = eventIdByMatch.get(e.bet.matchId);
        if (ev) eventsNeeded.add(ev);
      }

      // Per-cycle catalogue cache: eventId → Set of available bf market types
      const availableTypesByEvent = new Map<string, Set<string>>();
      const catalogueStartedAt = Date.now();
      for (const eventId of eventsNeeded) {
        try {
          const markets = await listMarketsByEventId(eventId);
          const types = new Set<string>();
          for (const m of markets) {
            const t = m.description?.marketType;
            if (t) types.add(t);
          }
          availableTypesByEvent.set(eventId, types);
        } catch (err) {
          logger.warn({ err, eventId }, "Betfair catalogue lookup failed — treating event as unavailable");
          availableTypesByEvent.set(eventId, new Set());
        }
      }
      const catalogueDurationMs = Date.now() - catalogueStartedAt;

      const filtered: BetEntry[] = [];
      for (const entry of liveCandidates) {
        const ev = eventIdByMatch.get(entry.bet.matchId);
        if (!ev) {
          funnelBfNoEventId++;
          continue;
        }
        const bfType = BETFAIR_MARKET_TYPE_MAP[entry.bet.marketType];
        if (!bfType) {
          funnelBfTypeUnsupported++;
          continue;
        }
        const availableTypes = availableTypesByEvent.get(ev);
        if (!availableTypes) {
          // Outside top-N catalogue lookup window; let it through and let
          // placement-time findMarketForBet decide.
          filtered.push(entry);
          continue;
        }
        if (!availableTypes.has(bfType)) {
          funnelBfMarketUnavailable++;
          continue;
        }
        filtered.push(entry);
      }
      logger.info(
        {
          before: allEntriesUnfiltered.length,
          after: filtered.length,
          eventsLookedUp: eventsNeeded.size,
          catalogueDurationMs,
          rejectedNoEventId: funnelBfNoEventId,
          rejectedTypeUnsupported: funnelBfTypeUnsupported,
          rejectedMarketUnavailable: funnelBfMarketUnavailable,
        },
        "Betfair availability pre-check complete",
      );
      allEntries = filtered;
    }

    // 7b. Load config early so funnel counters can reference thresholds
    const configRows = await db.select().from(agentConfigTable);
    const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));
    const minScore = Number(cfg?.min_opportunity_score ?? "58");

    // Funnel: count bets passing score threshold BEFORE any diversity caps
    const funnelPassScore = allEntries.filter(e => e.effectiveScore >= minScore).length;
    const funnelBoosted = allEntries.filter(e => e.bet.opportunityBoosted && e.effectiveScore >= minScore).length;
    const funnelContrarian = allEntries.filter(e => (e.validation?.isContrarian ?? false) && e.effectiveScore >= minScore).length;
    funnel["04_pass_score_threshold"] = funnelPassScore;
    funnel["04b_of_which_opportunity_boosted"] = funnelBoosted;
    funnel["04c_of_which_contrarian"] = funnelContrarian;

    // Log Pinnacle validation coverage for this cycle
    const pinnacleValidated = enhancedCandidates.filter((e) => e.validation?.hasPinnacleData).length;
    const pinnacleAligned = enhancedCandidates.filter((e) => e.validation?.pinnacleAligned).length;
    const contrarianCount = enhancedCandidates.filter((e) => e.validation?.isContrarian).length;
    logger.info(
      {
        totalCandidates: rankedForOddsPapi.length,
        pinnacleValidated,
        coveragePct: rankedForOddsPapi.length > 0 ? Math.round((pinnacleValidated / rankedForOddsPapi.length) * 100) : 0,
        pinnacleAligned,
        contrarian: contrarianCount,
      },
      "Pinnacle validation summary for trading cycle",
    );

    // 8. Diversity limits (config already loaded above)
    const paperMode = cfg.paper_mode === "true";

    // Fix 3: Daily bet cap — top N by opportunity score, quality over quantity
    const maxDailyBets = paperMode
      ? Number(cfg.max_daily_bets_paper ?? "50")
      : Number(cfg.max_daily_bets_live ?? "15");

    // C1+C2 (2026-05-07): daily cap counts only REAL-STAKE bets. Shadow
    // bets (£0 stake, no capital risk) are unlimited per Chris's directive
    // — if the model thinks there's an opportunity, capture it. This
    // prevents the 5000/day cap from choking the firehose when shadow
    // volume scales 5-10× with new markets.
    const todayBetRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(paperBetsTable)
      .where(sql`date_trunc('day', ${paperBetsTable.placedAt} AT TIME ZONE 'UTC') = current_date AND status != 'void' AND deleted_at IS NULL AND ${paperBetsTable.stake}::numeric > 0`);
    const todayCountRaw = Number(todayBetRows[0]?.count ?? 0);
    // Apr 17 2026: optional same-day offset to "reset" the daily counter after
    // a mid-day bankroll change. Only applied if `daily_bets_used_offset_date`
    // matches the current UTC date — auto-expires at UTC midnight.
    const offsetDate = String(cfg.daily_bets_used_offset_date ?? "");
    const todayUtc = new Date().toISOString().slice(0, 10);
    const offset = offsetDate === todayUtc ? Number(cfg.daily_bets_used_offset ?? "0") : 0;
    const todayCount = Math.max(0, todayCountRaw - offset);
    const dailySlotsLeft = Math.max(0, maxDailyBets - todayCount);

    if (dailySlotsLeft === 0) {
      logger.info({ maxDailyBets, todayCount }, "Daily bet cap reached — skipping placement this cycle");
      markRun("trading", "success");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    logger.info({ maxDailyBets, todayCount, dailySlotsLeft, paperMode }, "Daily bet budget");

    // In paper mode use daily cap as the per-cycle limit (best N by score).
    // In live mode cap both per-cycle and daily.
    const maxPerCycle  = paperMode ? dailySlotsLeft : Math.min(Number(cfg.max_bets_per_cycle ?? "5"), dailySlotsLeft);
    const maxPerLeague = paperMode ? Number.MAX_SAFE_INTEGER : Number(cfg.max_bets_per_league ?? "2");
    const maxPerMarket = paperMode ? Number.MAX_SAFE_INTEGER : Number(cfg.max_bets_per_market ?? "2");
    // Contrarian penalty removed — all bets use minScore threshold (dev data shows +18.4% ROI on contrarian bets)

    if (paperMode) {
      logger.info({ dailySlotsLeft, maxDailyBets }, "Paper mode ACTIVE — daily cap enforced, diversity caps removed");
    }

    // 9. Apply diversity rules
    const leagueCounts: Record<string, number> = {};
    const marketCounts: Record<string, number> = {};
    const preCorrelation: BetCandidate[] = [];
    const bankroll = await getBankroll();

    // Load existing pending bets to prevent duplicates on same match+market+selection
    const existingPending = await db
      .select({ matchId: paperBetsTable.matchId, marketType: paperBetsTable.marketType, selectionName: paperBetsTable.selectionName })
      .from(paperBetsTable)
      .where(and(eq(paperBetsTable.status, "pending"), sql`deleted_at IS NULL`));
    const pendingKeys = new Set(existingPending.map((b) => `${b.matchId}|${b.marketType}|${b.selectionName}`));

    // ── Change A2 (intra-cycle upstream dedup) ───────────────────────────────
    // Belt-and-braces against the picker emitting the same (match, market,
    // selection) more than once in a single cycle. Without this, the pre-loop
    // pendingKeys snapshot is blind to duplicates introduced WITHIN this loop
    // (the original triple-bet bug on Once Caldas vs Inter Bogota, 2026-04-19).
    // Keep the entry with the highest effectiveScore; first-seen wins on ties.
    {
      const beforeCount = allEntries.length;
      const seenByKey = new Map<string, typeof allEntries[number]>();
      for (const e of allEntries) {
        const k = `${e.bet.matchId}|${e.bet.marketType}|${e.bet.selectionName}`;
        const existing = seenByKey.get(k);
        if (!existing || e.effectiveScore > existing.effectiveScore) {
          seenByKey.set(k, e);
        }
      }
      const afterCount = seenByKey.size;
      if (beforeCount > afterCount) {
        logger.info(
          { beforeCount, afterCount, removed: beforeCount - afterCount },
          `Deduplicated ${beforeCount} intra-cycle candidates to ${afterCount} unique (match, market, selection) entries`,
        );
        allEntries = Array.from(seenByKey.values());
      }
    }

    let funnelDupSkip = 0, funnelScoreSkip = 0, funnelLeagueSkip = 0, funnelMarketSkip = 0, funnelCycleCapHit = 0;

    for (const entry of allEntries) {
      const { bet, effectiveScore, validation } = entry;

      // Drop candidates whose (match, market) is currently suppressed —
      // either market is unavailable on Betfair (hard, 4h TTL) or has tripped
      // the circuit breaker (3+ consecutive failures, 30min TTL).
      // Done BEFORE the per-cycle cap so freed slots go to next-best candidates.
      if (isLiveMode()) {
        const sup = isMarketSuppressed(bet.matchId, bet.marketType);
        if (sup.suppressed) {
          funnelBfSuppressed++;
          logger.debug(
            { matchId: bet.matchId, market: bet.marketType, reason: sup.reason, expiresAt: sup.expiresAt },
            "Skipping candidate — market suppressed",
          );
          continue;
        }
      }

      if (preCorrelation.length >= maxPerCycle) { funnelCycleCapHit++; continue; }

      // Skip if we already have a pending bet on this match+market+selection
      const dupKey = `${bet.matchId}|${bet.marketType}|${bet.selectionName}`;
      if (pendingKeys.has(dupKey)) {
        funnelDupSkip++;
        logger.debug({ matchId: bet.matchId, market: bet.marketType, selection: bet.selectionName }, "Skipping duplicate — pending bet already exists");
        continue;
      }

      const isContrarian = validation?.isContrarian ?? false;

      // B1+B2 (2026-05-07): production score gate only applies to bets that
      // valueDetection routed to the production track. Shadow-track candidates
      // (Tier A near-misses + any Tier B/C bet that cleared the shadow floor)
      // bypass this gate so they reach the dispatcher and become £0 learning
      // bets. The gate is preserved for production-track bets to keep the
      // real-stake rail's selectivity unchanged.
      const candidatePlacementTrack = (bet as { placementTrack?: "production" | "shadow" }).placementTrack;
      if (candidatePlacementTrack !== "shadow" && effectiveScore < minScore) {
        funnelScoreSkip++;
        logger.debug(
          { matchId: bet.matchId, score: effectiveScore, threshold: minScore, isContrarian },
          "Skipping bet — below score threshold",
        );
        continue;
      }

      const leagueCount = leagueCounts[bet.league] ?? 0;
      if (leagueCount >= maxPerLeague) { funnelLeagueSkip++; continue; }

      const marketCount = marketCounts[bet.marketType] ?? 0;
      if (marketCount >= maxPerMarket) { funnelMarketSkip++; continue; }

      // Pricing-pipeline (Prompt 5): we ALWAYS place at the actionable
      // (Betfair Exchange) price selected by the picker. The validator's
      // bestOdds is captured for diagnostics only, never for placement.
      const backOdds = bet.actionablePrice;
      const validatorBestOdds = validation?.bestOdds ?? null;
      const pinnacleAligned = validation?.pinnacleAligned ?? false;
      const leagueEdgeScore = leagueEdgeMap.get(bet.league) ?? 50;
      const leagueBonusStr = leagueEdgeScore !== 50 ? ` League edge score: ${leagueEdgeScore.toFixed(0)}.` : "";
      const thesis =
        `Backing ${bet.selectionName} at ${backOdds.toFixed(2)} (${bet.actionableSource}). ` +
        `Model: ${(bet.modelProbability * 100).toFixed(1)}%, ` +
        `fair value ${bet.fairValueOdds.toFixed(2)} (${bet.fairValueSource}, implies ${((1 / bet.fairValueOdds) * 100).toFixed(1)}%). ` +
        `CLV-style edge: ${(bet.edge * 100).toFixed(2)}%.` +
        (validation?.hasPinnacleData
          ? ` Pinnacle implies ${((validation.pinnacleImplied ?? 0) * 100).toFixed(1)}%.` +
            (validation.sharpSoftSpread ? ` Sharp-soft spread: ${(validation.sharpSoftSpread * 100).toFixed(1)}%.` : "") +
            (isContrarian ? " CONTRARIAN — Pinnacle-misaligned." : pinnacleAligned ? " Pinnacle-aligned." : "")
          : "") +
        leagueBonusStr;

      // Estimate Kelly stake for correlation check
      const kellyFraction = Math.min(0.02 * (effectiveScore / 65), 0.05);
      const estimatedStake = Math.round(bankroll * kellyFraction * 100) / 100;

      preCorrelation.push({
        ...bet,
        stakeMultiplier: 1.0,
        estimatedStake,
        enhanced: !!(validation?.hasPinnacleData),
        // Store extra data for placement
        _validation: validation,
        _thesis: thesis,
        _backOdds: backOdds,
        _validatorBestOdds: validatorBestOdds,
        _effectiveScore: effectiveScore,
        _isContrarian: isContrarian,
      } as BetCandidate & Record<string, unknown>);

      // ── Change A1 (intra-cycle TOCTOU close) ────────────────────────────
      // Mark this (match, market, selection) as taken so any further loop
      // iterations queueing the same key are rejected at the dupKey check
      // above. Belt-and-braces alongside A2 upstream dedup.
      pendingKeys.add(dupKey);

      leagueCounts[bet.league] = leagueCount + 1;
      marketCounts[bet.marketType] = marketCount + 1;
    }

    if (preCorrelation.length === 0) {
      markRun("trading", "success");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false, tier, fixtureWindowHours: maxHours };
    }

    funnel["06_pre_correlation_candidates"] = preCorrelation.length;
    funnel["06b_skipped_duplicate_pending"] = funnelDupSkip;
    funnel["06c_skipped_score_threshold"] = funnelScoreSkip;
    funnel["06d_skipped_league_cap"] = funnelLeagueSkip;
    funnel["06e_skipped_market_cap"] = funnelMarketSkip;
    funnel["06f_skipped_cycle_cap"] = funnelCycleCapHit;

    // 10. Correlation detection
    const { selectedBets } = await applyCorrelationDetection(preCorrelation, bankroll);

    funnel["07_post_correlation"] = selectedBets.length;

    // ─── UNIVERSE-TIER SELECTION FILTER (Phase 2.B.1, 2026-05-05) ───
    // Reads competition_config.universe_tier and routes by tier:
    //   Tier A → kept (production track; Pinnacle CLV gate runs downstream)
    //   Tier B/C → rejected (Phase 2.B.2 will route these to shadow-stake
    //                        path; until then, behave like pre-2.B "no Pinnacle")
    //   Tier D/E/unmapped → rejected
    //
    // Replaces the prior `WHERE has_pinnacle_odds = true` check. Net behaviour
    // change: leagues with has_pinnacle_odds=true but missing has_betfair_exchange
    // OR is_active=false are now rejected (correct per v2 design — Tier A
    // requires both flags + active). Empirically this is a small subset (149
    // Tier A vs ~150 has_pinnacle_odds-only after the 2026-05-05 seed).
    //
    // Backwards-compatible toggle: reject_non_pinnacle_leagues="false" still
    // disables the gate entirely (rollback path). The flag's name is
    // historical; functionally it now toggles the universe-tier gate.
    {
      const flagRaw = (await getConfigValue("reject_non_pinnacle_leagues")) ?? "true";
      const flagEnabled = flagRaw.toLowerCase() === "true";
      // Phase 2.B.2 flag: when true, Tier B/C candidates are routed through
      // the £0 shadow-stake placement path. Default false → Tier B/C still
      // rejected (matches 2.B.1 behaviour). Flip via:
      //   UPDATE agent_config SET value = 'true' WHERE key = 'experiment_track_enabled';
      const experimentTrackFlagRaw = (await getConfigValue("experiment_track_enabled")) ?? "false";
      const experimentTrackEnabled = experimentTrackFlagRaw.toLowerCase() === "true";
      if (!flagEnabled) {
        logger.warn(
          { tier, candidates: selectedBets.length },
          "Universe-tier filter DISABLED via reject_non_pinnacle_leagues=false (rollback mode)",
        );
        funnel["07a_universe_tier_filter"] = "disabled" as unknown as number;
      } else if (selectedBets.length > 0) {
        // Wave 2 #4.1 (2026-05-05): normalize hyphens → spaces in both
        // competition_config and matches for tuple lookup. Hyphenation is
        // inconsistent in competition_config (some rows "South-Africa", others
        // "South Africa") but matches.country is space-separated. Without
        // normalization, the strict tuple lookup misses for ~half of Tier
        // A/B leagues, sending their candidates to no_tier_match.
        const ccRows = await db.execute(sql`
          SELECT LOWER(REPLACE(name, '-', ' ')) AS name,
                 LOWER(REPLACE(COALESCE(country, ''), '-', ' ')) AS country,
                 universe_tier
          FROM competition_config
          WHERE universe_tier IN ('A','B','C')
        `);
        const ccData = ((ccRows as unknown as { rows?: Array<{ name: string; country: string; universe_tier: string }> }).rows
          ?? (ccRows as unknown as Array<{ name: string; country: string; universe_tier: string }>));
        // Build (key→tier) and (name→tier) maps. tierByName uses last-wins
        // for duplicate league names (e.g., 32 "cup" rows across countries);
        // this is acceptable when same name maps to same tier (95%+ of cases
        // per D-WV2-7). Mixed-tier names ("fa cup", "2. liga") are bounded
        // and surface as edge-case mis-routing — addressed by the
        // tierByKey-first lookup which catches them when country matches.
        const tierByKey = new Map<string, string>();
        const tierByName = new Map<string, string>();
        for (const r of ccData) {
          tierByName.set(r.name, r.universe_tier);
          tierByKey.set(`${r.name}|${r.country}`, r.universe_tier);
        }

        const matchIds = Array.from(new Set(selectedBets.map((b) => b.matchId)));
        const matchMeta = new Map<number, { league: string; country: string }>();
        if (matchIds.length > 0) {
          const matchRows = await db
            .select({
              id: matchesTable.id,
              league: sql<string>`LOWER(REPLACE(${matchesTable.league}, '-', ' '))`.as("league"),
              country: sql<string>`LOWER(REPLACE(COALESCE(${matchesTable.country}, ''), '-', ' '))`.as("country"),
            })
            .from(matchesTable)
            .where(inArray(matchesTable.id, matchIds));
          for (const r of matchRows) {
            matchMeta.set(Number(r.id), { league: r.league ?? "", country: r.country ?? "" });
          }
        }

        const before = selectedBets.length;
        const rejectionDetails: Array<{ matchId: number; league: string; country: string; market: string; selection: string; reason: string }> = [];
        const kept: BetCandidate[] = [];
        // Telemetry: count candidates per tier classification (incl. no-tier-found)
        const tierCounts: Record<string, number> = { A: 0, B: 0, C: 0, none: 0 };
        for (const c of selectedBets) {
          const meta = matchMeta.get(c.matchId);
          const league = meta?.league ?? "";
          const country = meta?.country ?? "";
          // Wave 2 #4.1 (2026-05-05): tier lookup with name-only fallback
          // when tuple misses. Prior code's `country === ""` guard was
          // unreachable inside the `if (country)` branch, so the fallback
          // never fired when the tuple lookup failed due to country format
          // mismatch. Result: ~half of Tier B candidates routed to
          // no_tier_match. Fixed: tuple-first, name-fallback unconditional
          // on tuple miss.
          let candidateTier: string | null = null;
          if (country) {
            candidateTier = tierByKey.get(`${league}|${country}`) ?? null;
          }
          if (!candidateTier) {
            candidateTier = tierByName.get(league) ?? null;
          }

          if (candidateTier === "A") {
            tierCounts.A++;
            c.universeTier = "A";
            kept.push(c);
          } else if (candidateTier === "B" || candidateTier === "C") {
            tierCounts[candidateTier]++;
            if (experimentTrackEnabled) {
              // Phase 2.B.2: route through shadow-stake placement path.
              // placePaperBet sees universeTier='B'|'C' and writes a £0
              // actual-stake bet with shadow_stake = full_Kelly × 0.25.
              c.universeTier = candidateTier;
              kept.push(c);
            } else {
              // Flag off — reject as in 2.B.1.
              rejectionDetails.push({
                matchId: c.matchId,
                league: league || "(unknown)",
                country: country || "(unknown)",
                market: c.marketType,
                selection: c.selectionName,
                reason: `tier_${candidateTier}_flag_off`,
              });
              continue;
            }
          } else if (candidateTier === "D" || candidateTier === null || candidateTier === "unmapped") {
            // B3 (2026-05-07): Tier D (bias breach or no AF match) and
            // unmapped/no-CC-row candidates fall through as shadow learning
            // data per "every fixture is a learning opportunity". £0 stake
            // means no capital risk — these are exactly the cases the
            // tier-ladder needs evidence for to make A1/A2 decisions.
            // Tier E (explicit exclusion list) stays rejected.
            tierCounts.none++;
            (c as { placementTrack?: "production" | "shadow" }).placementTrack = "shadow";
            // Leave universeTier null/unmapped — paperTrading routes via
            // placementTrack='shadow' regardless of tier label.
            kept.push(c);
          } else {
            // Tier E or other explicit-exclusion → reject. E denotes leagues
            // we've decided don't belong in the universe at all (women's
            // reserves, U-21, etc) so even £0 capture isn't useful.
            tierCounts.none++;
            rejectionDetails.push({
              matchId: c.matchId,
              league: league || "(unknown)",
              country: country || "(unknown)",
              market: c.marketType,
              selection: c.selectionName,
              reason: `tier_${candidateTier}_excluded`,
            });
            continue;
          }
        }
        selectedBets.length = 0;
        selectedBets.push(...kept);
        const rejected = before - selectedBets.length;
        if (rejected > 0) {
          logger.warn(
            {
              tier,
              before,
              after: selectedBets.length,
              rejected,
              tierCounts,
              tierALeaguesLoaded: Array.from(tierByName.values()).filter(t => t === "A").length,
              tierBLeaguesLoaded: Array.from(tierByName.values()).filter(t => t === "B").length,
              tierCLeaguesLoaded: Array.from(tierByName.values()).filter(t => t === "C").length,
              sampleRejections: rejectionDetails.slice(0, 25),
              totalRejections: rejectionDetails.length,
              scope: "phase_2b1_universe_tier_audit",
            },
            "Universe-tier filter rejected non-Tier-A candidates",
          );
        } else {
          logger.info(
            {
              tier,
              kept: selectedBets.length,
              tierCounts,
              tierALeaguesLoaded: Array.from(tierByName.values()).filter(t => t === "A").length,
            },
            "Universe-tier filter: all candidates in Tier A",
          );
        }
        funnel["07a_rejected_non_tier_a_candidates"] = rejected;
        funnel["07a_tier_a_candidates"] = tierCounts.A;
        funnel["07a_tier_b_candidates_rejected"] = tierCounts.B;
        funnel["07a_tier_c_candidates_rejected"] = tierCounts.C;
        funnel["07a_no_tier_match_rejected"] = tierCounts.none;
      }
    }

    // ─── CARDS-MARKET PAUSE FILTER (scope v3 §7 follow-up, 2026-04-19) ───
    // TOTAL_CARDS_25 / TOTAL_CARDS_35 measured at −13% to −17% mean CLV (n=20 captured).
    // Documented negative expectation → pause until root-cause diagnosis. Default OFF.
    // Toggle via enable_total_cards_markets config flag ("true" to re-enable).
    {
      const cardsFlagRaw = (await getConfigValue("enable_total_cards_markets")) ?? "false";
      const cardsEnabled = cardsFlagRaw.toLowerCase() === "true";
      if (cardsEnabled) {
        logger.warn(
          { tier, candidates: selectedBets.length },
          "Cards-market pause DISABLED via enable_total_cards_markets=true (cards will be placed)",
        );
        funnel["07b_cards_pause"] = "disabled" as unknown as number;
      } else if (selectedBets.length > 0) {
        const before = selectedBets.length;
        const cardRejections: Array<{ matchId: number; market: string; selection: string; odds: number }> = [];
        const kept: BetCandidate[] = [];
        for (const c of selectedBets) {
          if (c.marketType.startsWith("TOTAL_CARDS_")) {
            cardRejections.push({
              matchId: c.matchId,
              market: c.marketType,
              selection: c.selectionName,
              odds: c.odds,
            });
            continue;
          }
          kept.push(c);
        }
        selectedBets.length = 0;
        selectedBets.push(...kept);
        const rejected = before - selectedBets.length;
        if (rejected > 0) {
          logger.warn(
            {
              tier,
              before,
              after: selectedBets.length,
              rejected,
              rejections: cardRejections,
              scope: "v3_section7_cards_pause",
              reason: "documented_negative_clv_-13_to_-17pct",
            },
            "Cards-market pause rejected TOTAL_CARDS_* candidates",
          );
        }
        funnel["07b_rejected_cards_markets_paused"] = rejected;
      }
    }

    // ─── PERMANENT MARKET DISABLE FILTER ─────────────────────────────────────
    // DOUBLE_CHANCE: disabled Apr 20 2026 after 30-day P&L review showed it
    // generating −£579 / −31.2% ROI on 43 bets — a structural loss source
    // accounting for ~75% of total monthly profit drag. The synthetic odds
    // derivation from MATCH_ODDS (vig-removed implied probability) appears
    // to systematically over-estimate edge. Re-enable only with a model
    // change or a sharp upstream odds source for this market.
    //
    // FIRST_HALF_RESULT was previously here (no HT data → cannot audit). Now
    // re-enabled because: (a) HT scores are captured into matches.home_score_ht
    // / away_score_ht during syncMatchResults, (b) determineBetWon resolves
    // it deterministically from those columns, and (c) for any matched
    // real-money bet, reconcileSettlements is the authoritative source via
    // Betfair listClearedOrders.
    {
      const PERMANENT_DISABLED_MARKETS = new Set(["DOUBLE_CHANCE"]);
      if (selectedBets.length > 0) {
        const before = selectedBets.length;
        const kept = selectedBets.filter(
          (c) => !PERMANENT_DISABLED_MARKETS.has(c.marketType.toUpperCase()),
        );
        const dropped = before - kept.length;
        if (dropped > 0) {
          selectedBets.length = 0;
          selectedBets.push(...kept);
          logger.warn(
            { tier, before, after: selectedBets.length, dropped, disabled: [...PERMANENT_DISABLED_MARKETS] },
            "Permanent market disable filter applied (DOUBLE_CHANCE — structural −31% ROI, see Apr 20 2026 review)",
          );
          funnel["07a_rejected_permanent_disabled_markets"] = dropped;
        }
      }
    }

    // ─── PER-MARKET EDGE FLOOR FILTER ─────────────────────────────────────────
    // Tighter edge requirement on markets that have shown poor realized ROI
    // despite passing the global min_edge_threshold gate. OVER_UNDER_25
    // generated −£111 / −2.0% ROI on 199 bets in the trailing 30 days
    // (41% of all stake volume) — barely break-even on the highest-volume
    // market. Raising the floor halves exposure while preserving the strongest
    // CLV-positive picks.
    //
    // Tunable via config keys; defaults below if unset.
    {
      if (selectedBets.length > 0) {
        const cfg = await Promise.all([
          getConfigValue("market_edge_floor_over_under_25"),
        ]);
        const floors: Record<string, number> = {
          OVER_UNDER_25: Number(cfg[0] ?? "0.06"),
        };
        const before = selectedBets.length;
        const kept = selectedBets.filter((c) => {
          // B1+B2: shadow bets bypass capital-risk per-market floors. The
          // OVER_UNDER_25 6% floor exists to limit stake exposure on a
          // chronically-poor market, but £0 shadow capture has no capital
          // risk and is exactly how the model relearns whether the market
          // has recovered.
          const ct = (c as { placementTrack?: "production" | "shadow" }).placementTrack;
          if (ct === "shadow") return true;
          const floor = floors[c.marketType.toUpperCase()];
          if (floor === undefined) return true;
          const edge = Number(c.edge ?? 0);
          return edge >= floor;
        });
        const dropped = before - kept.length;
        if (dropped > 0) {
          selectedBets.length = 0;
          selectedBets.push(...kept);
          logger.warn(
            { tier, before, after: selectedBets.length, dropped, floors },
            "Per-market edge floor filter applied (OVER_UNDER_25 — see Apr 20 2026 review)",
          );
          funnel["07c_rejected_per_market_edge_floor"] = dropped;
        }
      }
    }

    // ─── STRATEGY OVERRIDE FILTER (today-only, self-expiring at strategy_overrides_expire_at) ───
    // Reads 3 config keys: strategy_disabled_markets (CSV), strategy_max_odds, strategy_max_hours_to_kickoff.
    // Auto-disables once strategy_overrides_expire_at is past — no manual revert needed.
    {
      const expiresAtStr = await getConfigValue("strategy_overrides_expire_at");
      const expiresAtMs = expiresAtStr ? new Date(expiresAtStr).getTime() : 0;
      if (expiresAtMs > Date.now() && selectedBets.length > 0) {
        const disabledCsv = (await getConfigValue("strategy_disabled_markets")) ?? "";
        const disabled = new Set(
          disabledCsv.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
        );
        const maxOdds = Number((await getConfigValue("strategy_max_odds")) ?? "9999");
        const maxHrsToKo = Number((await getConfigValue("strategy_max_hours_to_kickoff")) ?? "9999");

        const matchIds = Array.from(new Set(selectedBets.map((b) => b.matchId)));
        const koMap = new Map<number, number>();
        if (matchIds.length > 0) {
          const rows = await db
            .select({ id: matchesTable.id, ko: matchesTable.kickoffTime })
            .from(matchesTable)
            .where(inArray(matchesTable.id, matchIds));
          for (const r of rows) {
            if (r.ko) koMap.set(r.id, new Date(r.ko).getTime());
          }
        }

        const before = selectedBets.length;
        const nowMs = Date.now();
        let dropMarket = 0, dropOdds = 0, dropKo = 0;
        const kept: BetCandidate[] = [];
        for (const c of selectedBets) {
          if (disabled.has(c.marketType.toUpperCase())) { dropMarket++; continue; }
          const odds = ((c as BetCandidate & Record<string, unknown>)._backOdds as number | undefined) ?? c.backOdds;
          if (odds > maxOdds) { dropOdds++; continue; }
          const koMs = koMap.get(c.matchId);
          if (koMs != null) {
            const hrs = (koMs - nowMs) / 3600000;
            if (hrs > maxHrsToKo) { dropKo++; continue; }
          }
          kept.push(c);
        }
        selectedBets.length = 0;
        selectedBets.push(...kept);
        logger.warn(
          {
            tier, before, after: selectedBets.length,
            droppedByMarket: dropMarket, droppedByOdds: dropOdds, droppedByKickoff: dropKo,
            disabledMarkets: [...disabled], maxOdds, maxHrsToKo,
            expiresAt: new Date(expiresAtMs).toISOString(),
          },
          "Strategy override filter applied (today-only, self-expiring)",
        );
        funnel["07b_post_strategy_override"] = selectedBets.length;
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: SIGNAL → EXECUTION SPLIT
    // Signal generation is complete. Now build structured bet orders,
    // then execute them as fast as possible with timing tracking.
    // ═══════════════════════════════════════════════════════════════════

    const signalCompleteAt = Date.now();
    const signalDurationMs = signalCompleteAt - cycleStartedAt;
    logger.info(
      { tier, signalDurationMs, candidates: selectedBets.length },
      "Signal generation complete — entering execution phase",
    );

    // 11a. Build bet orders (pre-filter through Pinnacle)
    interface BetOrder {
      matchId: number;
      homeTeam: string;
      awayTeam: string;
      marketType: string;
      selectionName: string;
      backOdds: number;
      modelProbability: number;
      edge: number;
      effectiveScore: number;
      isContrarian: boolean;
      validation: Awaited<ReturnType<typeof getOddspapiValidation>> | null;
      thesis: string | undefined;
      stakeMultiplier: number;
      experimentTag?: string;
      dataTier?: string;
      opportunityBoosted?: boolean;
      originalOpportunityScore?: number;
      boostedOpportunityScore?: number;
      syncEligible?: boolean;
      pinnacleEdgeCategory: string | null;
      lineDirection: string | null;
      oddsSource: string;
      enhanced: boolean;
      signalGeneratedAt: number;
      // Pricing-pipeline (Prompt 5): actionable = price we place on,
      // fair_value = sharp consensus reference for CLV-style edge.
      actionablePrice: number;
      actionableSource: string;
      fairValueOdds: number;
      fairValueSource: string;
      validatorBestOdds: number | null;
      universeTier?: string | null;
      placementTrack: "production" | "shadow";
    }

    const betOrders: BetOrder[] = [];

    for (const candidate of selectedBets) {
      const extra = candidate as BetCandidate & Record<string, unknown>;
      const validation = extra._validation as Awaited<ReturnType<typeof getOddspapiValidation>> | null;
      const isContrarian = (extra._isContrarian as boolean | undefined) ?? false;
      const backOdds = (extra._backOdds as number | undefined) ?? candidate.backOdds;
      const validatorBestOdds = (extra._validatorBestOdds as number | null | undefined) ?? null;
      const effectiveScore = (extra._effectiveScore as number | undefined) ?? candidate.opportunityScore;
      const thesis = (extra._thesis as string | undefined) ?? undefined;

      // Phase 2.B.2 + B1/B2 (2026-05-07): shadow bets bypass the Pinnacle
      // pre-bet filter. Tier B/C lack reliable Pinnacle pricing by definition,
      // and Tier A near-miss shadow bets are exactly the case where Pinnacle
      // disagreement IS the learning signal — we want those captured at £0
      // so the tier-ladder accumulates evidence on whether the model or
      // Pinnacle is correct on borderline calls. Production-track Tier A bets
      // continue through the filter unchanged.
      const candidateTrack = (candidate as { placementTrack?: "production" | "shadow" }).placementTrack;
      const isShadowBet =
        candidateTrack === "shadow" ||
        candidate.universeTier === "B" ||
        candidate.universeTier === "C";

      // B3 (2026-05-07): filterPassed removed — Pinnacle rejection now
      // downgrades to shadow rather than dropping the bet entirely.
      let filterEdgeCategory: string | null = null;
      let filterLineDirection: string | null = null;
      if (!isShadowBet) {
        try {
          const filterResult = await pinnaclePreBetFilter({
            matchId: candidate.matchId,
            marketType: candidate.marketType,
            selectionName: candidate.selectionName,
            modelProbability: candidate.modelProbability,
            marketOdds: backOdds,
            opportunityScore: effectiveScore,
            league: candidate.league,
            pinnacleOdds: validation?.pinnacleOdds ?? null,
            pinnacleImplied: validation?.pinnacleImplied ?? null,
            universeTier: candidate.universeTier ?? null,
          });

          filterEdgeCategory = filterResult.edgeCategory !== "filtered" ? filterResult.edgeCategory : null;
          filterLineDirection = filterResult.lineDirection !== "unknown" ? filterResult.lineDirection : null;

          if (!filterResult.passed) {
            // B3 (2026-05-07): production-track Pinnacle rejection no longer
            // drops the bet — it falls through to shadow capture. The
            // rejection signal itself is learning data: model said edge,
            // Pinnacle said no (or no Pinnacle data at all). Capture the
            // bet at £0 so the tier-ladder learns whether model or Pinnacle
            // was correct when the result settles.
            logger.info(
              {
                matchId: candidate.matchId,
                market: candidate.marketType,
                selection: candidate.selectionName,
                edgePct: filterResult.edgePct.toFixed(2),
                reason: filterResult.filterReason,
                lineDirection: filterResult.lineDirection,
                fallthrough: "shadow",
              },
              "Pinnacle pre-bet filter rejected production bet — falling through to shadow capture",
            );
            (candidate as { placementTrack?: "production" | "shadow" }).placementTrack = "shadow";
          }
        } catch (filterErr) {
          logger.error({ err: filterErr, matchId: candidate.matchId }, "Pinnacle pre-bet filter error — allowing bet through");
        }
      } else {
        logger.info(
          {
            matchId: candidate.matchId,
            universeTier: candidate.universeTier,
            placementTrack: candidateTrack,
            market: candidate.marketType,
          },
          "Shadow bet — bypassing Pinnacle pre-bet filter (Tier B/C lacks Pinnacle, or Tier A near-miss where Pinnacle disagreement is the learning signal)",
        );
      }

      // filterPassed remains true: B3 fall-through means rejected production
      // bets are downgraded to shadow rather than dropped. Only filter errors
      // above leave filterPassed=true (existing 'allow through' behaviour).

      betOrders.push({
        matchId: candidate.matchId,
        homeTeam: candidate.homeTeam,
        awayTeam: candidate.awayTeam,
        marketType: candidate.marketType,
        selectionName: candidate.selectionName,
        backOdds,
        modelProbability: candidate.modelProbability,
        edge: candidate.edge,
        effectiveScore,
        isContrarian,
        validation,
        thesis,
        stakeMultiplier: candidate.stakeMultiplier,
        experimentTag: candidate.experimentTag,
        dataTier: candidate.dataTier,
        opportunityBoosted: candidate.opportunityBoosted,
        originalOpportunityScore: candidate.originalOpportunityScore,
        boostedOpportunityScore: candidate.boostedOpportunityScore,
        syncEligible: candidate.syncEligible,
        pinnacleEdgeCategory: filterEdgeCategory,
        lineDirection: filterLineDirection,
        oddsSource: candidate.oddsSource,
        enhanced: candidate.enhanced ?? false,
        signalGeneratedAt: signalCompleteAt,
        actionablePrice: candidate.actionablePrice,
        actionableSource: candidate.actionableSource,
        fairValueOdds: candidate.fairValueOdds,
        fairValueSource: candidate.fairValueSource,
        validatorBestOdds,
        // Phase 2.B.2: tier carried through to placePaperBet for the
        // shadow-stake branch.
        universeTier: candidate.universeTier ?? null,
        // B1+B2 (2026-05-07): placement-track signal from valueDetection.
        // 'production' → real stake on Tier A; 'shadow' → £0 learning bet
        // (Tier A near-miss OR any Tier B/C bet).
        placementTrack: (candidate as { placementTrack?: "production" | "shadow" }).placementTrack ?? (
          candidate.universeTier === "A" ? "production" : "shadow"
        ),
      });
    }

    funnel["08_post_pinnacle_filter"] = betOrders.length;
    funnel["08b_pinnacle_filtered_out"] = selectedBets.length - betOrders.length;

    // ── Bundle 3 (2026-05-09 / plan v3 §Item 7 follow-up): saturated-fixture
    // pre-filter. valueDetection re-emits the same opportunities every 5-min
    // cycle without per-cycle memory of which fixtures already saturated the
    // shadow cap. Pre-Bundle-1 the pattern was 14k cap-rejects/24h burning
    // placePaperBet compute (DB queries, log writes, gate evaluations) just
    // to reject at the cap. Bundle 1 raised cap 12→24 — same retry shape, new
    // ceiling. This filter drops candidates upstream when the match's shadow
    // rail is already at 24 pending. Both rails saturated (paper 4 + shadow
    // 24) is dropped because paper-cap demote-to-shadow would also hit the
    // saturated shadow rail and reject. Net: zero placement-decision change,
    // material compute saved on saturated fixtures.
    if (betOrders.length > 0) {
      const candidateMatchIds = Array.from(new Set(betOrders.map((o) => o.matchId)));
      const saturatedRows = (await db
        .select({
          matchId: paperBetsTable.matchId,
          shadowCount: sql<number>`COUNT(*) FILTER (WHERE ${paperBetsTable.betTrack} = 'shadow')::int`,
          paperCount: sql<number>`COUNT(*) FILTER (WHERE COALESCE(${paperBetsTable.betTrack}, 'paper') = 'paper')::int`,
        })
        .from(paperBetsTable)
        .where(
          and(
            inArray(paperBetsTable.matchId, candidateMatchIds),
            sql`${paperBetsTable.deletedAt} IS NULL`,
            sql`${paperBetsTable.status} IN ('pending','pending_placement')`,
          ),
        )
        .groupBy(paperBetsTable.matchId));
      // Both rails saturated = no slot for any new candidate (paper full +
      // shadow full means paper-cap demote also rejects). Shadow ≥24 alone
      // means shadow-track candidates reject; production candidates that
      // hit paper cap and try to demote will also reject. Conservative:
      // skip when shadow is full regardless of paper state.
      const saturatedMatchIds = new Set<number>(
        saturatedRows
          .filter((r) => r.shadowCount >= 24)
          .map((r) => r.matchId),
      );
      if (saturatedMatchIds.size > 0) {
        const before = betOrders.length;
        const skipped = betOrders.filter((o) => saturatedMatchIds.has(o.matchId));
        const kept = betOrders.filter((o) => !saturatedMatchIds.has(o.matchId));
        betOrders.length = 0;
        betOrders.push(...kept);
        funnel["08c_saturated_fixture_skip"] = before - kept.length;
        logger.info(
          {
            saturatedMatchCount: saturatedMatchIds.size,
            ordersDropped: skipped.length,
            ordersBefore: before,
            ordersAfter: kept.length,
            sampleMatchIds: Array.from(saturatedMatchIds).slice(0, 5),
          },
          "Bundle 3: dropped orders for shadow-cap-saturated fixtures pre-emission",
        );
      } else {
        funnel["08c_saturated_fixture_skip"] = 0;
      }
    } else {
      funnel["08c_saturated_fixture_skip"] = 0;
    }

    if (betOrders.length > 0) {
      logger.info(
        { orders: betOrders.length, tier },
        "Bet orders built — executing immediately",
      );
    }

    // 11b. EXECUTE bet orders — fast path, no heavy computation
    let betsPlaced = 0;
    let funnelQuarantineReject = 0, funnelExposureReject = 0, funnelOtherReject = 0;
    const executionTimings: Array<{ matchId: number; market: string; executionMs: number }> = [];

    for (const order of betOrders) {
      const execStartMs = Date.now();

      const result = await placePaperBet(
        order.matchId,
        order.marketType,
        order.selectionName,
        order.backOdds,
        order.modelProbability,
        order.edge,
        {
          modelVersion: modelVersion ?? undefined,
          opportunityScore: order.effectiveScore,
          oddsSource: order.oddsSource,
          enhancedOpportunityScore: order.validation?.hasPinnacleData ? order.effectiveScore : null,
          pinnacleOdds: order.validation?.pinnacleOdds ?? null,
          pinnacleImplied: order.validation?.pinnacleImplied ?? null,
          bestOdds: order.validation?.bestOdds ?? order.backOdds,
          bestBookmaker: order.validation?.bestBookmaker ?? null,
          betThesis: order.thesis,
          isContrarian: order.isContrarian,
          stakeMultiplier: order.stakeMultiplier,
          experimentTag: order.experimentTag,
          dataTier: order.dataTier,
          opportunityBoosted: order.opportunityBoosted,
          originalOpportunityScore: order.originalOpportunityScore,
          boostedOpportunityScore: order.boostedOpportunityScore,
          syncEligible: order.syncEligible,
          pinnacleEdgeCategory: order.pinnacleEdgeCategory,
          lineDirection: order.lineDirection,
          actionablePrice: order.actionablePrice,
          actionableSource: order.actionableSource,
          fairValueOdds: order.fairValueOdds,
          fairValueSource: order.fairValueSource,
          validatorBestOdds: order.validatorBestOdds,
          // Phase 2.B.2: tier propagated through so placePaperBet's shadow
          // -stake branch fires for Tier B/C bets (stake=0, shadow_stake=
          // full_Kelly × 0.25).
          universeTier: order.universeTier as "A" | "B" | "C" | null | undefined,
          // B1+B2 (2026-05-07): placement-track is the authoritative shadow
          // signal — covers Tier A near-misses (which would otherwise fall
          // through the universeTier='A' check and become real-stake bets).
          placementTrack: order.placementTrack,
        },
      );

      const execMs = Date.now() - execStartMs;
      const signalToExecMs = Date.now() - order.signalGeneratedAt;

      if (result.placed) {
        betsPlaced++;
        executionTimings.push({ matchId: order.matchId, market: order.marketType, executionMs: execMs });
        logger.info(
          {
            matchId: order.matchId,
            homeTeam: order.homeTeam,
            awayTeam: order.awayTeam,
            marketType: order.marketType,
            selectionName: order.selectionName,
            backOdds: order.backOdds.toFixed(2),
            edge: order.edge.toFixed(4),
            stake: result.stake,
            oddsSource: order.oddsSource,
            opportunityScore: order.effectiveScore,
            enhanced: order.enhanced,
            pinnacleAligned: order.validation?.pinnacleAligned ?? false,
            isContrarian: order.isContrarian,
            stakeMultiplier: order.stakeMultiplier,
            executionMs: execMs,
            signalToExecMs,
          },
          "Automated bet placed",
        );
      } else {
        const reason = (result as { reason?: string }).reason ?? "unknown";
        if (reason.includes("quarantine")) funnelQuarantineReject++;
        else if (reason.includes("xposure") || reason.includes("oncentration")) funnelExposureReject++;
        else funnelOtherReject++;
        logger.info({ matchId: order.matchId, marketType: order.marketType, selectionName: order.selectionName, reason }, "Bet rejected");

        // Fire-and-forget: log liquidity snapshot for this bet (non-blocking)
        if (isRelayConfigured()) {
          void logLiquiditySnapshot(order.matchId, order.marketType, order.selectionName, order.backOdds, result.stake ?? 0)
            .catch((err) => logger.debug({ err, matchId: order.matchId }, "Liquidity snapshot failed — non-fatal"));
        }
      }
    }

    // 11c. Execution timing summary & alerts
    if (executionTimings.length > 0) {
      const avgExecMs = Math.round(executionTimings.reduce((s, t) => s + t.executionMs, 0) / executionTimings.length);
      const maxExecMs = Math.max(...executionTimings.map((t) => t.executionMs));
      const totalSignalToLastExecMs = Date.now() - signalCompleteAt;
      logger.info(
        { avgExecMs, maxExecMs, totalSignalToLastExecMs, betsExecuted: executionTimings.length, tier },
        "Execution timing summary",
      );
      if (avgExecMs > 30000) {
        logger.warn(
          { avgExecMs, threshold: 30000 },
          "EXECUTION SPEED ALERT — average execution time exceeds 30 seconds",
        );
      }
    }

    funnel["09_bets_placed"] = betsPlaced;
    funnel["09b_quarantine_rejected"] = funnelQuarantineReject;
    funnel["09c_exposure_rejected"] = funnelExposureReject;
    funnel["09d_other_rejected"] = funnelOtherReject;
    funnel["daily_budget"] = maxDailyBets;
    funnel["daily_used"] = todayCount;
    funnel["daily_slots_left"] = dailySlotsLeft;
    funnel["per_cycle_cap"] = maxPerCycle;
    funnel["per_league_cap"] = maxPerLeague;
    funnel["per_market_cap"] = maxPerMarket;
    funnel["score_threshold"] = minScore;
    funnel["pinnacle_matches_with_data"] = oddsPapiCache.size;
    funnel["pinnacle_from_oddspapi"] = oddsPapiCacheRaw.size;
    funnel["pinnacle_from_af"] = afPinnacleCache.size;
    funnel["pinnacle_matches_total"] = allUpcoming.length;
    funnel["pinnacle_coverage_pct"] = allUpcoming.length > 0
      ? Math.round((oddsPapiCache.size / allUpcoming.length) * 100)
      : 0;

    // Market suppression visibility — drops from cache + total active suppressions
    funnel["suppressed_dropped_this_cycle"] = funnelBfSuppressed;
    const suppStats = getSuppressionStats();
    funnel["suppressed_active_total"] = suppStats.total;
    funnel["suppressed_active_unavailable"] = suppStats.unavailable;
    funnel["suppressed_active_circuit_breaker"] = suppStats.circuitBreaker;

    logger.info({ funnel }, "=== TRADING CYCLE FUNNEL REPORT ===");

    const cycleDurationMs = Date.now() - cycleStartedAt;
    logger.info(
      { betsPlaced, betsSettled: settlement.settled, tier, maxHours, cycleDurationMs },
      "Trading cycle complete",
    );
    markRun("trading", "success");
    try {
      const { cronExecutionsTable } = await import("@workspace/db");
      await db.insert(cronExecutionsTable).values({
        jobName: `trading_${tier}`,
        startedAt: new Date(cycleStartedAt),
        completedAt: new Date(),
        success: true,
        recordsProcessed: betsPlaced,
        durationMs: cycleDurationMs,
      });
    } catch (_) {}
    return {
      betsPlaced,
      betsSettled: settlement.settled,
      riskTriggered: false,
      tier,
      fixtureWindowHours: maxHours,
      signalGeneratedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error({ err, tier }, "Trading cycle failed");
    markRun("trading", "error");
    try {
      const { cronExecutionsTable } = await import("@workspace/db");
      await db.insert(cronExecutionsTable).values({
        jobName: `trading_${tier}`,
        startedAt: new Date(cycleStartedAt),
        completedAt: new Date(),
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - cycleStartedAt,
      });
    } catch (_) {}
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false, tier, fixtureWindowHours: maxHours };
  } finally {
    tradingCycleRunning = false;
    tradingCycleAcquiredAt = null;
    // C1: emit per-cycle exchange-book capture stats on every exit path
    // (success / risk-triggered early-return / error). Counters were reset at
    // cycle start via resetExchangeCaptureCounters().
    try {
      logger.info(
        { tier, exchange_capture: getExchangeCaptureCounters() },
        "C1: exchange-book capture stats for cycle",
      );
    } catch (_) {}
  }
}

// ===================== Sync match results from football-data.org =====================

export async function syncMatchResults(daysBack = 2): Promise<number> {
  const pendingLeagues = await getLeaguesWithPendingBets();

  const scheduledMatches = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        sql`${matchesTable.kickoffTime} < NOW()`,
        pendingLeagues.size > 0
          ? sql`${matchesTable.league} IN (${sql.join(
              [...pendingLeagues].map((l) => sql`${l}`),
              sql`, `,
            )})`
          : sql`1=0`,
      ),
    );

  if (scheduledMatches.length === 0) {
    logger.info({ pendingLeagues: pendingLeagues.size }, "syncMatchResults: no scheduled past matches in pending-bet leagues");
    return 0;
  }

  logger.info(
    { pendingLeagues: pendingLeagues.size, scheduledPastMatches: scheduledMatches.length },
    "syncMatchResults: scoped to leagues with pending bets",
  );

  let recentFixtures: Awaited<ReturnType<typeof fetchRecentFixtureResults>>;
  try {
    recentFixtures = await fetchRecentFixtureResults(daysBack, { priority: true });
  } catch (err) {
    logger.warn({ err }, "syncMatchResults: failed to fetch recent fixtures");
    return 0;
  }

  if (recentFixtures.length === 0) {
    logger.info("syncMatchResults: API-Football returned 0 finished fixtures");
    return 0;
  }

  let updated = 0;
  const matchedDbIds = new Set<number>();

  const fixtureIdIndex = new Map<number, (typeof scheduledMatches)[0]>();
  for (const m of scheduledMatches) {
    if (m.apiFixtureId) fixtureIdIndex.set(m.apiFixtureId, m);
  }

  for (const fixture of recentFixtures) {
    const homeGoals = fixture.goals?.home ?? fixture.score?.fulltime?.home;
    const awayGoals = fixture.goals?.away ?? fixture.score?.fulltime?.away;
    if (homeGoals === null || homeGoals === undefined || awayGoals === null || awayGoals === undefined) continue;
    // Halftime scores (nullable — older fixtures or feeds may not provide).
    // Captured to enable independent settlement of FIRST_HALF_RESULT bets.
    const htHome = fixture.score?.halftime?.home;
    const htAway = fixture.score?.halftime?.away;

    let dbMatch = fixtureIdIndex.get(fixture.fixture.id);
    if (dbMatch && matchedDbIds.has(dbMatch.id)) dbMatch = undefined;

    if (!dbMatch) {
      dbMatch = scheduledMatches.find(
        (m) =>
          !matchedDbIds.has(m.id) &&
          teamNameMatch(m.homeTeam, fixture.teams.home.name) &&
          teamNameMatch(m.awayTeam, fixture.teams.away.name),
      );
    }
    if (!dbMatch) continue;

    // Fetch corner/card stats while we have the fixture ID
    const matchStats = await fetchMatchStatsForSettlement(fixture.fixture.id);

    await db
      .update(matchesTable)
      .set({
        status: "finished",
        homeScore: homeGoals,
        awayScore: awayGoals,
        ...(htHome !== null && htHome !== undefined && htAway !== null && htAway !== undefined
          ? { homeScoreHt: htHome, awayScoreHt: htAway }
          : {}),
        apiFixtureId: fixture.fixture.id,
        ...(matchStats !== null
          ? { totalCorners: matchStats.totalCorners, totalCards: matchStats.totalCards }
          : {}),
      })
      .where(eq(matchesTable.id, dbMatch.id));

    logger.info(
      {
        matchId: dbMatch.id,
        homeTeam: dbMatch.homeTeam,
        awayTeam: dbMatch.awayTeam,
        score: `${homeGoals}-${awayGoals}`,
        apiFixtureId: fixture.fixture.id,
        totalCorners: matchStats?.totalCorners ?? "N/A",
        totalCards: matchStats?.totalCards ?? "N/A",
      },
      "syncMatchResults: match updated to finished",
    );

    updated++;
    matchedDbIds.add(dbMatch.id);
  }

  if (updated > 0) {
    logger.info({ updated }, "syncMatchResults: matches synced from API-Football");
  }

  // Log any scheduled past matches that still couldn't be matched (diagnostic)
  const unmatched = scheduledMatches.filter((m) => !matchedDbIds.has(m.id));
  if (unmatched.length > 0) {
    for (const m of unmatched) {
      logger.warn(
        { matchId: m.id, homeTeam: m.homeTeam, awayTeam: m.awayTeam, kickoff: m.kickoffTime },
        "syncMatchResults: could not match scheduled past match to any API-Football fixture",
      );
    }
  }

  return updated;
}

// ===================== Settlement cron (always-on) =====================

/**
 * Runs in BOTH development and production.
 * Settlement is a pure DB operation — no expensive API quota consumed.
 * syncMatchResults does call API-Football, but only for matches whose
 * kick-off time has already passed, so it is lightweight and necessary.
 */
let settlementRunning = false;

async function runSettlementPipeline(deep = false): Promise<void> {
  if (settlementRunning) {
    logger.debug("Settlement pipeline already running — skipping");
    return;
  }

  const lockAcquired = await tryAdvisoryLock(SETTLEMENT_LOCK_ID);
  if (!lockAcquired) {
    logger.debug("Settlement pipeline locked by another instance — skipping");
    return;
  }

  settlementRunning = true;
  try {
    const daysBack = deep ? 7 : 2;
    const synced = await syncMatchResults(daysBack);
    if (synced > 0) logger.info({ synced, daysBack }, "Settlement pipeline: match results synced");

    const r = await settleBets();
    if (r.settled > 0)
      logger.info(
        {
          settled: r.settled,
          won: r.won,
          lost: r.lost,
          totalPnl: r.totalPnl,
          paper_bets_pending_retry: r.paperPendingRetry,
          paper_bets_timeout_lost: r.paperTimeoutLoss,
          paper_bets_abandonment_void: r.paperAbandonmentVoid,
        },
        "Settlement pipeline: bets settled",
      );

    const backfill = await backfillCornersCardsStats();
    if (backfill.matchesUpdated > 0 || backfill.betsResettled > 0) {
      logger.info(backfill, "Settlement pipeline: corners/cards backfill complete");
    }
  } catch (err) {
    logger.warn({ err }, "Settlement pipeline failed — non-fatal");
  } finally {
    settlementRunning = false;
    await releaseAdvisoryLock(SETTLEMENT_LOCK_ID);
  }
}

export function startSettlementCron(): void {
  // 2026-05-09 C1: settlement + monitor crons all live on the api-server
  // side. The worker-data process only runs ingestion + exchange sweep
  // (registered in startScheduler under role='data'); settlement / monitors
  // / lazy-promoter all belong with the trading cycle in api-server.
  const role = readWorkerRole();
  if (role === "data") {
    logger.info({ role }, "Worker role 'data' — skipping settlement/monitor crons");
    return;
  }

  cron.schedule("*/2 * * * *", () => {
    void runSettlementPipeline();
  }, { timezone: "UTC" });
  logger.info("Settlement cron active — every 2 minutes (sync 2-day + settle + backfill)");

  cron.schedule("15 * * * *", () => {
    logger.info("Deep settlement sweep triggered (7-day lookback)");
    void runSettlementPipeline(true);
  }, { timezone: "UTC" });
  logger.info("Deep settlement sweep active — hourly at :15 (7-day lookback)");

  setTimeout(() => {
    logger.info("Startup settlement triggered (15s after boot)");
    void runSettlementPipeline(true);
  }, 15_000);

  if (isLiveMode()) {
    // Phase 3 B7 (2026-05-08): tightened from 30 min to 15 min per
    // docs/phase-3-paper-to-live-switchover-plan-v2.md §6.1 +
    // §2.7 validation requirement (≥80 successful runs in 24h, last_run
    // within 30 min of NOW). Earlier capture of cleared orders means
    // earlier reconciliation alerts in the case of partial-match /
    // settlement-divergence anomalies.
    cron.schedule("*/15 * * * *", () => {
      logger.info("Betfair settlement reconciliation triggered");
      void reconcileSettlements().catch((err) =>
        logger.warn({ err }, "Betfair reconciliation failed — non-fatal"),
      );
    }, { timezone: "UTC" });
    logger.info("Betfair settlement reconciliation active — every 15 minutes");

    cron.schedule("*/15 * * * *", () => {
      void getAccountFunds().catch((err) =>
        logger.warn({ err }, "Betfair balance refresh failed — non-fatal"),
      );
    }, { timezone: "UTC" });
    logger.info("Betfair balance refresh active — every 15 minutes");
  }

  // Phase 3 B2 (2026-05-08): bankroll-tier cap recommendation. Daily
  // 03:00 UTC. Writes to pending_caps table; live agent_config caps are
  // ONLY updated at switchover transaction. Pre-flip this is inspection
  // data only.
  cron.schedule("0 3 * * *", () => {
    logger.info("Bankroll-tier caps evaluation triggered (daily 03:00 UTC)");
    void (async () => {
      try {
        const { runBankrollTierCaps } = await import("./bankrollTierCaps");
        const r = await runBankrollTierCaps();
        logger.info(r, "Bankroll-tier caps evaluation complete");
      } catch (err) {
        logger.error({ err }, "Bankroll-tier caps evaluation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Bankroll-tier caps scheduler active — daily 03:00 UTC");

  // Phase 3 B9 (2026-05-08): gate-monitoring cron. Daily 04:00 UTC (slot
  // freed by suspending modelSelfAudit at 03:30 / Z4 at 03:45). Reads
  // gate_components + path_s_aggregate_status views, writes a gate_status
  // row, fires gate_clear_pending_review on aggregate trigger clear, and
  // gate_status_review_required after 56 days without clearance. Pre-
  // evaluation_start_at this short-circuits to a heartbeat-only row.
  cron.schedule("0 4 * * *", () => {
    logger.info("Gate monitor triggered (daily 04:00 UTC)");
    void (async () => {
      try {
        const { runGateMonitor } = await import("./gateMonitor");
        const r = await runGateMonitor();
        logger.info(r, "Gate monitor evaluation complete");
      } catch (err) {
        logger.error({ err }, "Gate monitor evaluation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Gate monitor scheduler active — daily 04:00 UTC");

  // Phase 3 A4 (2026-05-08): post-flip operational jobs. Both run every
  // 15 min. Pre-flip (live_mode_active != 'true') they short-circuit as
  // no-ops, so no harm in scheduling them now — they'll start working
  // automatically when the flip-to-live transaction lands.
  cron.schedule("*/15 * * * *", () => {
    void (async () => {
      try {
        const { runStopConditionMonitor } = await import("./stopConditionMonitor");
        const r = await runStopConditionMonitor();
        if (r.live_mode_active) {
          logger.info(r, "Stop condition monitor evaluation complete");
        }
      } catch (err) {
        logger.error({ err }, "Stop condition monitor evaluation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Stop condition monitor scheduler active — every 15 min UTC (no-op pre-flip)");

  cron.schedule("*/15 * * * *", () => {
    void (async () => {
      try {
        const { runHalfKellyRamp } = await import("./halfKellyRamp");
        const r = await runHalfKellyRamp();
        if (r.live_mode_active) {
          logger.info(r, "Half-Kelly ramp evaluation complete");
        }
      } catch (err) {
        logger.error({ err }, "Half-Kelly ramp evaluation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Half-Kelly ramp scheduler active — every 15 min UTC (no-op pre-flip)");

  // Phase 3 Path C+ (2026-05-08): lazy shadow→paper promotion. Every 5 min,
  // scans pending Tier A shadow bets where kickoff is within 6h and fresh
  // (≤30 min) betfair_exchange data exists for the specific selection.
  // Promotes in place to paper rail with fresh Kelly stake. Pre-fix the
  // valueDetection routing was permanent — once shadow, always shadow.
  // This catches the case where exchange data appears AFTER the bet was
  // emitted, which is the dominant 87% routing-to-shadow cause on Tier A.
  cron.schedule("*/5 * * * *", () => {
    void (async () => {
      try {
        const { runLazyPromoteShadowToPaper } = await import("./lazyPromoteShadowToPaper");
        const r = await runLazyPromoteShadowToPaper();
        if (r.promoted > 0 || r.pending_shadow_count > 0) {
          logger.info(r, "Lazy shadow→paper promotion evaluated");
        }
      } catch (err) {
        logger.error({ err }, "Lazy shadow→paper promotion failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Lazy shadow→paper promoter active — every 5 min UTC");

  // Phase 3 Path C+ (2026-05-08): pre-kickoff feature refresh. Every 15 min,
  // force re-computation of features for matches kicking off within 90 min
  // that have pending bets. Default features cron runs every 6h with 2h
  // freshness — too stale for kickoff-proximity. This narrow refresh
  // pulls in any newly-arrived signals (lineup, injury, referee data) so
  // predictions and value-bet decisions on the next trading_near cycle use
  // the freshest possible picture. Combined with the lazy shadow→paper
  // promoter (5-min cron above), pending shadow bets near kickoff get
  // re-evaluated against fresh predictions and exchange data.
  cron.schedule("*/15 * * * *", () => {
    logger.info("Pre-kickoff feature refresh triggered (every 15 min)");
    void (async () => {
      try {
        const { runFeatureEngineForUpcomingMatches } = await import("./featureEngine");
        const r = await runFeatureEngineForUpcomingMatches(true, {
          maxHoursAhead: 1.5,
          onlyMatchesWithPendingBets: true,
        });
        if (r.processed > 0) {
          logger.info(r, "Pre-kickoff feature refresh complete");
        }
      } catch (err) {
        logger.error({ err }, "Pre-kickoff feature refresh failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Pre-kickoff feature refresh scheduler active — every 15 min UTC (T-90min only)");

  // 2026-05-08 (§4.2 of root-cause-analysis): cron health monitor.
  // Runs every 5 min. Compares each tracked cron's last successful run
  // against expected cadence; inserts gate-style alert rows in
  // cron_stale_alert when a cron is overdue. Operator queries
  // cron_stale_alert WHERE acknowledged_at IS NULL. No UI required.
  cron.schedule("*/5 * * * *", () => {
    void (async () => {
      try {
        const { runCronHealthMonitor } = await import("./cronHealthMonitor");
        await runCronHealthMonitor();
      } catch (err) {
        logger.error({ err }, "Cron health monitor failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Cron health monitor scheduler active — every 5 minutes");

  // 2026-05-08 (post-RCA): generalised data-quality monitor. Daily 02:00
  // UTC. Tracks every external data source's daily volume vs 30-day
  // baseline (excluding last 5 days). Inserts data_quality_alerts row on
  // < 0.5x ratio. Operator queries data_quality_alerts WHERE
  // acknowledged_at IS NULL.
  cron.schedule("0 2 * * *", () => {
    logger.info("Data quality monitor triggered (daily 02:00 UTC)");
    void (async () => {
      try {
        // 2026-05-09 (Bundle 6): unban-gate auto-detector runs alongside the
        // existing low-coverage alerting. Detects when oddspapi_pinnacle
        // distinct_matches/24h ≥ 200 sustained 3 days clears (currently the
        // gate condition for OU_25/OU_35/FIRST_HALF_RESULT unban). Writes a
        // compliance_logs row when the gate clears so operator knows to ship
        // the BANNED_MARKETS one-line edit. Idempotent (one row per 7d window).
        const { runDataQualityMonitor, runUnbanGateMonitor } = await import("./dataQualityMonitor");
        const dq = await runDataQualityMonitor();
        logger.info(dq, "Data quality monitor complete");
        const ug = await runUnbanGateMonitor();
        logger.info(ug, "Unban gate monitor complete");
      } catch (err) {
        logger.error({ err }, "Data quality monitor failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Data quality monitor scheduler active — daily 02:00 UTC");

  // 2026-05-08 (post-RCA): adaptive threshold recommender. Weekly Sunday
  // 12:00 UTC. Beta-Binomial posterior on Kelly log-growth per
  // (scope × edge bucket). Recommends pinnacle_edge_min per scope based
  // on settled-bet evidence. Pre-flight ingestion-health gate skips the
  // cycle if oddspapi_pinnacle 24h volume is < 0.5× baseline.
  cron.schedule("0 12 * * 0", () => {
    logger.info("Adaptive threshold recommender triggered (Sunday 12:00 UTC)");
    void (async () => {
      try {
        const { runAdaptiveThresholdRecommender } = await import("./adaptiveThresholdRecommender");
        const r = await runAdaptiveThresholdRecommender();
        logger.info(r, "Adaptive threshold recommender complete");
      } catch (err) {
        logger.error({ err }, "Adaptive threshold recommender failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Adaptive threshold recommender scheduler active — Sunday 12:00 UTC");

  // 2026-05-08 Option D: daily Pinnacle discovery sweep. Runs once daily
  // at 11:00 UTC. Targets matches in T-12h..T-168h that haven't received
  // a Pinnacle anchor in 24h+. Fixed budget of 200 calls/day (~5% of
  // daily cap). Counterpart to the proximity prefetch (which keeps
  // refreshing trading-window matches).
  cron.schedule("0 11 * * *", () => {
    logger.info("Daily Pinnacle discovery sweep triggered (daily 11:00 UTC)");
    void (async () => {
      try {
        const { runDailyDiscoverySweep } = await import("./oddsPapi");
        const r = await runDailyDiscoverySweep();
        logger.info(r, "Daily Pinnacle discovery sweep complete");
      } catch (err) {
        logger.error({ err }, "Daily Pinnacle discovery sweep failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Daily Pinnacle discovery sweep scheduler active — daily 11:00 UTC");

  // 2026-05-08: Z4-v2 autonomous tier ladder. Daily 03:30 UTC (slot freed
  // by Track A suspension of original modelSelfAudit). Bayesian Kelly-
  // growth posterior with sample floors (n>=200 promotion, n>=100 demotion)
  // and ingestion-health gate. Defaults DISABLED via agent_config.z4_v2_enabled.
  // Operator enables when ready: UPDATE agent_config SET value='true' WHERE
  // key='z4_v2_enabled'.
  cron.schedule("30 3 * * *", () => {
    logger.info("Z4-v2 tier ladder triggered (daily 03:30 UTC)");
    void (async () => {
      try {
        const { runAutonomousTierLadderV2 } = await import("./autonomousTierLadderV2");
        const r = await runAutonomousTierLadderV2();
        logger.info(r, "Z4-v2 tier ladder complete");
      } catch (err) {
        logger.error({ err }, "Z4-v2 tier ladder failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Z4-v2 tier ladder scheduler active — daily 03:30 UTC (gated on z4_v2_enabled)");

  // 2026-05-08 (Lever 2): dead-letter sweep + registry-completeness check.
  // Daily 04:15 UTC — runs after Z4-v2 (03:30) so any DLQ alerts are
  // visible before the gate evaluation cron at 04:30. Two functions:
  // (1) flag market types in paper_bets that the registry doesn't recognise,
  // (2) auto-void bets stuck >7d post-kickoff with >50 settlement attempts.
  cron.schedule("15 4 * * *", () => {
    logger.info("Dead-letter sweep triggered (daily 04:15 UTC)");
    void (async () => {
      try {
        const { runDeadLetterSweep } = await import("./deadLetterSweep");
        const r = await runDeadLetterSweep();
        logger.info(r, "Dead-letter sweep complete");
      } catch (err) {
        logger.error({ err }, "Dead-letter sweep failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Dead-letter sweep scheduler active — daily 04:15 UTC");

  // 2026-05-08 OddsPapi maximisation bundle: three new crons.
  //
  // (1) Pinnacle sharp-move detector — every 5 minutes. Detects steam /
  // reverse-line-movement / drift on Tier-A candidate matches in T-30
  // to T-0 window. Logs to pinnacle_line_moves. Read-only signal layer
  // for now; future commit consumes it in the opportunity-score path.
  cron.schedule("*/5 * * * *", () => {
    void (async () => {
      try {
        const { runPinnacleSharpMoveDetector } = await import("./pinnacleSharpMoveDetector");
        const r = await runPinnacleSharpMoveDetector();
        if (r.movesDetected > 0) {
          logger.info(r, "Pinnacle sharp-move detector complete");
        }
      } catch (err) {
        logger.error({ err }, "Pinnacle sharp-move detector failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Pinnacle sharp-move detector scheduler active — every 5 minutes");

  // (2) AF-vs-OddsPapi Pinnacle cross-check — hourly at :07. Catches
  // disagreements >5% between independent Pinnacle sources. Aberrant
  // disagreements (>15%) raise data_quality_alerts.
  cron.schedule("7 * * * *", () => {
    logger.info("OddsPapi cross-check triggered (hourly :07)");
    void (async () => {
      try {
        const { runOddsPapiCrossCheck } = await import("./oddsPapiCrossCheck");
        const r = await runOddsPapiCrossCheck();
        logger.info(r, "OddsPapi cross-check complete");
      } catch (err) {
        logger.error({ err }, "OddsPapi cross-check failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("OddsPapi cross-check scheduler active — hourly at :07");

  // (3) Bookmaker catalog health log — daily at 04:45 UTC. Summarises
  // which OddsPapi bookmakers have appeared, focuses on api-integratable
  // venues for future bet-spreading.
  cron.schedule("45 4 * * *", () => {
    logger.info("OddsPapi bookmaker catalog health triggered (daily 04:45 UTC)");
    void (async () => {
      try {
        const { logCatalogHealth } = await import("./oddsPapiBookmakerCatalog");
        await logCatalogHealth();
      } catch (err) {
        logger.error({ err }, "Bookmaker catalog health log failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("OddsPapi bookmaker catalog health scheduler active — daily 04:45 UTC");

  // 2026-05-08 Neon cost audit: storage cleanup cron — daily 05:00 UTC.
  // Deletes non-essential bookmaker odds_snapshots >14d old, line_movement
  // legacy compliance logs (entire), bet_rejected >24h, correlation
  // detections >7d, and odds_history >30d. VACUUM ANALYZE runs at the
  // end so Postgres reclaims disk space rather than just marking dead.
  // Pre-cleanup target: free ~3GB across these three tables.
  cron.schedule("0 5 * * *", () => {
    logger.info("Storage cleanup cron triggered (daily 05:00 UTC)");
    void (async () => {
      try {
        const { runStorageCleanup, vacuumCleanedTables } = await import("./storageCleanup");
        const r = await runStorageCleanup();
        logger.info(r, "Storage cleanup complete");
        const v = await vacuumCleanedTables();
        logger.info(v, "Storage VACUUM complete");
      } catch (err) {
        logger.error({ err }, "Storage cleanup failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Storage cleanup scheduler active — daily 05:00 UTC");
}

// ===================== Scheduler =====================

// 2026-05-09 C1: worker role split. The api-server process used to host
// every cron in one Node heap. ingestion (50–74 min/run) and
// exchange_book_sweep (10–18 min/run) regularly OOM'd the 2 GB max-heap
// limit, taking the trading cycle and HTTP server down with them. Splitting
// them into a separate PM2 process (WORKER_ROLE=data) means a heavy cron
// hitting max_memory_restart only kills its own worker; the trading + HTTP
// process keeps placing bets and serving the dashboard.
//
// Role semantics:
//   "all"  — register every cron (default, backward-compatible for tests
//            and any non-PM2 launch).
//   "api"  — register everything EXCEPT the heavy data-pipeline crons.
//            Trading cycle, settlement, HTTP server, monitors, lazy
//            promoter, etc. Lives in the api-server PM2 entry.
//   "data" — register ONLY ingestion + exchange_book_sweep + their
//            startup warmups. Lives in the worker-data PM2 entry.
export type WorkerRole = "all" | "api" | "data";

function readWorkerRole(): WorkerRole {
  const raw = (process.env["WORKER_ROLE"] ?? "all").toLowerCase().trim();
  if (raw === "api" || raw === "data" || raw === "all") return raw;
  logger.warn({ raw }, "Unknown WORKER_ROLE — defaulting to 'all'");
  return "all";
}

export function startScheduler(): void {
  const role = readWorkerRole();
  logger.info({ role }, "Starting schedulers");

  const wantsData = role === "all" || role === "data";
  const wantsApi = role === "all" || role === "api";

  if (wantsData) {
    // Data ingestion: every 30 min, 24/7 (matches scheduled globally at all hours)
    cron.schedule("*/30 * * * *", () => { void safeRunIngestion(); }, { timezone: "UTC" });
    logger.info("Ingestion scheduler active — every 30 min, 24/7");

    // Exchange book sweep: every 10 minutes, populates odds_snapshots with
    // source='betfair_exchange' for the venue-anchored pricing picker. Runs
    // unconditionally, independent of data_source config flag.
    // Wave 1.5 (2026-05-05): extended window from 24h to 48h to match
    // valueDetection's 1-48h evaluation window. Without this, ~half the
    // matches valueDetection looks at have no betfair_exchange snapshot
    // and get rejected at 02a_rej_no_betfair_exchange. Tier B firehose
    // benefits especially since Tier B has fewer matches, so coverage
    // gaps are proportionally more impactful.
    cron.schedule("*/10 * * * *", () => { void safeRunExchangeBookSweep({ hoursAhead: 48 }); }, { timezone: "UTC" });
    logger.info("Exchange book sweep scheduler active — every 10 minutes (48h window — Wave 1.5)");

    // Startup warmup: run one sweep ~30s after boot so the first population
    // doesn't have to wait the full 10-minute cron interval.
    setTimeout(() => {
      logger.info("Exchange book sweep startup warmup triggered (T+30s, 48h window)");
      void safeRunExchangeBookSweep({ hoursAhead: 48 });
    }, 30_000);
  }

  // Worker-data role exits here — every cron below is API/trading/monitoring.
  if (!wantsApi) {
    logger.info({ role }, "Worker role 'data' — skipping API/trading crons");
    return;
  }

  // Feature computation: every 6 hours
  cron.schedule("0 */6 * * *", () => { void safeRunFeatures(); }, { timezone: "UTC" });
  logger.info("Feature scheduler active — every 6 hours UTC");

  // Trading cycle — TIERED:
  // NEAR tier: every 5 minutes for fixtures ≤48h (where speed matters most for edge capture)
  // FAR tier: every 30 minutes for fixtures 48h–168h (discovery — no urgency)
  cron.schedule("*/5 * * * *", () => {
    void runTradingCycle({ tier: "near", minHoursAhead: 1, maxHoursAhead: 48 })
      .then(() => deduplicatePendingBets())
      .catch((err) => {
        logger.warn({ err }, "Post-trading-cycle dedup failed — non-fatal");
      });
  }, { timezone: "UTC" });
  logger.info("Trading cycle (NEAR) scheduler active — every 5 minutes, fixtures ≤48h");

  cron.schedule("2,32 * * * *", () => {
    void runTradingCycle({ tier: "far", minHoursAhead: 48, maxHoursAhead: 168 })
      .then(() => deduplicatePendingBets())
      .catch((err) => {
        logger.warn({ err }, "Post-trading-cycle dedup failed — non-fatal");
      });
  }, { timezone: "UTC" });
  logger.info("Trading cycle (FAR) scheduler active — every 30 minutes, fixtures 48h–168h");

  // Auto-resume watchdog: every 5 minutes, check whether a `floor_halt` pause
  // (available cash dipped below the £50 absolute floor) can now be cleared.
  // Only auto-resumes pauses tagged with reason='floor_halt'; manual pauses
  // and consecutive-loss `halt` pauses are left alone. Requires available
  // cash to have recovered to ≥ 2× the floor (£100) to provide headroom and
  // prevent flapping. Re-runs the full circuit-breaker check to ensure no
  // other condition (e.g. consecutive losses, timed pause) is also active.
  cron.schedule("*/5 * * * *", () => {
    void (async () => {
      try {
        const status = await getAgentStatus();
        if (status === "running") {
          // Already running — clear any stale pause tags.
          const stale = await getConfigValue("pause_reason");
          if (stale) {
            await setConfigValue("pause_reason", "");
            await setConfigValue("paused_at", "");
          }
          return;
        }
        if (status !== "paused") return;

        const reason = await getConfigValue("pause_reason");
        if (reason !== "floor_halt") {
          return; // Only auto-resume bankroll-floor pauses.
        }

        if (!isLiveMode()) return;

        const available = await getAvailableBalance();
        const resumeThreshold = ABSOLUTE_BANKROLL_FLOOR_GBP * 2;
        if (available < resumeThreshold) {
          logger.info(
            { available, resumeThreshold, floor: ABSOLUTE_BANKROLL_FLOOR_GBP },
            "Auto-resume watchdog: cash still below 2× floor — staying paused",
          );
          return;
        }

        // Double-check no other circuit breaker is active.
        const cb = await checkLiveCircuitBreakers();
        if (cb.triggered) {
          logger.warn(
            { available, cbAction: cb.action, cbReason: cb.reason },
            "Auto-resume watchdog: cash recovered but another circuit breaker is active — staying paused",
          );
          return;
        }

        const pausedAtStr = await getConfigValue("paused_at");
        await setConfigValue("agent_status", "running");
        await setConfigValue("pause_reason", "");
        await setConfigValue("paused_at", "");
        logger.info(
          { available, resumeThreshold, pausedAt: pausedAtStr },
          "Auto-resume watchdog: bankroll recovered above 2× floor — agent resumed",
        );

      } catch (err) {
        logger.error({ err }, "Auto-resume watchdog failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Auto-resume watchdog active — every 5 minutes (resumes floor_halt pauses when cash ≥ 2× floor)");

  // API-Football: fetch real odds every 2 hours — fresh odds for every trading cycle
  // With 75,000 req/day budget, each scan uses ~30-50 reqs, plenty of headroom
  cron.schedule("0 */2 * * *", () => {
    logger.info("API-Football odds refresh triggered by scheduler");
    void fetchAndStoreOddsForAllUpcoming()
      .then(async () => {
        const r = await backfillPinnacleSnapshotsFromAf();
        logger.info(r, "Post-AF Pinnacle snapshot backfill complete");
      })
      .catch((err) => {
        logger.error({ err }, "API-Football odds refresh failed");
      });
  }, { timezone: "UTC" });
  logger.info("API-Football odds scheduler active — every 2 hours UTC (with Pinnacle snapshot backfill)");

  // API-Football: fetch team stats every 12 hours (~20 req)
  cron.schedule("0 */12 * * *", () => {
    logger.info("API-Football team stats refresh triggered by scheduler");
    void fetchTeamStatsForUpcomingMatches().catch((err) => {
      logger.error({ err }, "API-Football team stats refresh failed");
    });
  }, { timezone: "UTC" });
  logger.info("API-Football team stats scheduler active — every 12 hours UTC");

  // OddsPapi fixture mapping: every 6 hours (00:05, 06:05, 12:05, 18:05 UTC)
  cron.schedule("5 */6 * * *", () => {
    logger.info("OddsPapi fixture mapping triggered by scheduler");
    void safeRunOddspapiMapping();
  }, { timezone: "UTC" });
  logger.info("OddsPapi fixture mapping scheduler active — every 6 hours UTC");

  // Betfair event mapping: every 6 hours (offset by 15 min to spread API load)
  // Populates matches.betfair_event_id for upcoming fixtures so the precheck
  // can skip genuinely unlisted events instead of failing at placement time.
  // 2026-05-08 (Phase 3 paper-rate fix): cadence raised from 6h → 30min.
  // The original 6h schedule meant a fixture inserted by api-football
  // discovery (with af_-placeholder eventId) might wait up to 6h before the
  // reverse-mapper recovered its real Betfair numeric eventId. During that
  // window, exchange_book_sweep skips the match (regex ^[0-9]+$ filter),
  // valueDetection sees no betfair_exchange snapshot, and the bet routes to
  // shadow rail even when the league IS Betfair-tradeable. 30-min cadence
  // shrinks that window 12× and is cheap (function only updates matches
  // still on af_ prefix; once mapped, subsequent runs are near-noop on those
  // rows). Horizon stays at 72h to align with the firehose's planning window.
  cron.schedule("*/30 * * * *", () => {
    logger.info("Betfair event mapping triggered by scheduler (30-min cadence)");
    void trackCronExecution("betfair_event_map", async () => {
      const { mapBetfairEventsToFixtures } = await import("./betfairEventMapping");
      const stats = await mapBetfairEventsToFixtures(72);
      logger.info(stats, "Betfair event mapping stats");
      return stats.fixturesUpdated;
    }).catch((err) => logger.error({ err }, "Betfair event mapping failed"));
  }, { timezone: "UTC" });
  logger.info("Betfair event mapping scheduler active — every 30 min UTC");

  // Run once on startup (after a short delay so other warmup jobs settle first)
  setTimeout(() => {
    logger.info("Betfair event mapping — startup run");
    void trackCronExecution("betfair_event_map", async () => {
      const { mapBetfairEventsToFixtures } = await import("./betfairEventMapping");
      const stats = await mapBetfairEventsToFixtures(72);
      logger.info(stats, "Betfair event mapping startup stats");
      return stats.fixturesUpdated;
    }).catch((err) => logger.error({ err }, "Betfair event mapping startup failed"));
  }, 45_000);

  // C5 (2026-05-07): kickoff-proximity prefetch — replaces the every-2hr
  // uniform bulk prefetch. Runs every 15min and allocates budget across 4
  // T-to-kickoff buckets (T-0-1h drained first, T-72h+ last). Same monthly
  // budget (100k cap, ~3300/day average), redistributed toward the high-
  // information window where Pinnacle prices sharpen.
  cron.schedule("*/15 * * * *", () => {
    logger.info("OddsPapi kickoff-proximity prefetch triggered (every 15 min)");
    void runKickoffProximityPrefetch()
      .then(async (r) => {
        logger.info(r, "OddsPapi kickoff-proximity prefetch complete");
        const dc = await derivePinnacleDCFromMatchOdds();
        logger.info(dc, "Post-prefetch DC derivation complete");
        const unified = await backfillPinnacleUnified();
        logger.info({ unified }, "Post-prefetch unified Pinnacle backfill complete");
      })
      .catch((err) => logger.error({ err }, "OddsPapi kickoff-proximity prefetch pipeline failed"));
  }, { timezone: "UTC" });
  logger.info("OddsPapi kickoff-proximity prefetch scheduler active — every 15 min UTC (T-0-1h prioritised, daily cap enforced)");

  // OddsPapi budget summary: daily at 00:01 UTC
  cron.schedule("1 0 * * *", () => {
    logger.info("OddsPapi daily budget summary triggered");
    void logDailyBudgetSummary().catch((err) => {
      logger.error({ err }, "OddsPapi budget summary failed");
    });
  }, { timezone: "UTC" });
  logger.info("OddsPapi budget summary scheduler active — daily at 00:01 UTC");

  // Pre-kickoff CLV cron: every 15 minutes (upgraded from 30 with 100k budget)
  // For any pending bet kicking off in the next 90 min, fetch Pinnacle closing odds
  // and store as closing_pinnacle_odds → snapshot C for three-snapshot CLV system
  cron.schedule("*/15 * * * *", () => {
    logger.info("Pre-kickoff CLV cron triggered — fetching Pinnacle closing odds");
    void fetchAndStoreClosingLineForPendingBets()
      .then((r) => {
        if (r.checked > 0) {
          logger.info(r, "Pre-kickoff CLV cron complete");
        }
      })
      .catch((err) => {
        logger.warn({ err }, "Pre-kickoff CLV cron failed — non-fatal");
      });
  }, { timezone: "UTC" });
  logger.info("Pre-kickoff CLV cron active — every 15 minutes (Pinnacle closing line + snapshot C)");

  // Pre-kickoff snapshot B: every 15 minutes
  // Captures Pinnacle odds 45-75 min before kickoff (1hr reference point)
  cron.schedule("7,22,37,52 * * * *", () => {
    void fetchPreKickoffSnapshots()
      .then((r) => {
        if (r.checked > 0) logger.info(r, "Pre-kickoff snapshot B cron complete");
      })
      .catch((err) => logger.warn({ err }, "Pre-kickoff snapshot B failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("Pre-kickoff snapshot B cron active — every 15 minutes (1hr before kickoff)");

  // Multi-snapshot Pinnacle ingestion: every 5 minutes
  // Captures granular T-60 / T-30 / T-15 / T-5 Pinnacle snapshots per pending bet.
  // Each bucket is idempotent (one snapshot per bet per bucket), giving us a
  // velocity series that powers steam detection, reverse-signal aborts, and
  // proper closing-line proxies when the official closing fetch fails.
  cron.schedule("*/5 * * * *", () => {
    void captureAllPendingSnapshots()
      .then((r) => {
        const total = r.buckets.reduce((s, b) => s + b.captured, 0);
        if (total > 0) logger.info({ buckets: r.buckets, totalCaptured: total }, "Multi-snapshot Pinnacle cron complete");
      })
      .catch((err) => logger.warn({ err }, "Multi-snapshot Pinnacle cron failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("Multi-snapshot Pinnacle cron active — every 5 minutes (T-60/T-30/T-15/T-5 buckets)");

  // Line movement tracker: every 4 hours
  // Tracks how Pinnacle odds move for fixtures with pending bets
  cron.schedule("30 */4 * * *", () => {
    logger.info("Line movement tracker triggered");
    void trackLineMovements()
      .then((r) => logger.info(r, "Line movement tracking complete"))
      .catch((err) => logger.warn({ err }, "Line movement tracking failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("Line movement tracker active — every 4 hours");

  // Filtered bet outcome backfill: daily at 02:00 UTC
  // Checks whether bets we filtered out would have won or lost
  cron.schedule("0 2 * * *", () => {
    logger.info("Filtered bet outcome backfill triggered");
    void backfillFilteredBetOutcomes()
      .then((r) => logger.info(r, "Filtered bet outcome backfill complete"))
      .catch((err) => logger.warn({ err }, "Filtered bet outcome backfill failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("Filtered bet outcome backfill active — daily at 02:00 UTC");

  // Sharp movement analysis: weekly Sunday 05:30 UTC
  // Analyses whether model aligns with sharp money movements
  cron.schedule("30 5 * * 0", () => {
    logger.info("Sharp movement analysis triggered");
    void analyseSharpMovements()
      .then((r) => {
        if (r.totalSharp > 0) logger.info(r, "Sharp movement analysis complete");
      })
      .catch((err) => logger.warn({ err }, "Sharp movement analysis failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("Sharp movement analysis active — weekly Sunday 05:30 UTC");

  // Learning loop: daily at 03:00 UTC
  cron.schedule("0 3 * * *", () => {
    logger.info("Daily learning loop triggered by scheduler");
    markStart("learning");
    void runLearningLoop()
      .then(() => markRun("learning", "success"))
      .catch((err) => {
        logger.error({ err }, "Scheduled learning loop failed");
        markRun("learning", "error");
      });
  }, { timezone: "UTC" });
  logger.info("Learning loop scheduler active — daily at 03:00 UTC");

  // xG ingestion: daily at 05:00 UTC (runs before feature cron at 06:00)
  cron.schedule("0 5 * * *", () => {
    logger.info("xG ingestion triggered by scheduler");
    void runXGIngestion()
      .then(({ inserted, updated }) => {
        logger.info({ inserted, updated }, "Scheduled xG ingestion complete");
      })
      .catch((err) => {
        logger.warn({ err }, "Scheduled xG ingestion failed — non-fatal, continuing");
      });
  }, { timezone: "UTC" });
  logger.info("xG ingestion scheduler active — daily at 05:00 UTC");

  // League discovery: DAILY at 00:30 UTC (was weekly — now aggressive, we have budget)
  // Scans all API-Football leagues and populates competition_config + discovered_leagues.
  cron.schedule("30 0 * * *", () => {
    logger.info("Daily league discovery triggered by scheduler");
    void runLeagueDiscovery()
      .then((result) => {
        logger.info({ activated: result.activatedLeagues.length, total: result.totalLeaguesFound }, "Daily league discovery complete");
        return ingestFixturesForDiscoveredLeagues();
      })
      .then((r) => logger.info(r, "Post-discovery fixture ingestion complete"))
      .catch((err) => logger.warn({ err }, "Daily league discovery failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("League discovery scheduler active — daily 00:30 UTC");

  // Discovered league fixture ingestion: TWICE daily (06:30 and 18:30 UTC)
  // With 200+ competitions, this is where most API budget goes.
  cron.schedule("30 6,18 * * *", () => {
    logger.info("Discovered-league fixture ingestion triggered");
    void ingestFixturesForDiscoveredLeagues()
      .then((r) => logger.info(r, "Discovered-league fixture ingestion complete"))
      .catch((err) => logger.warn({ err }, "Discovered-league fixture ingestion failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("Discovered-league fixture ingestion scheduler active — twice daily 06:30 & 18:30 UTC");

  // Betfair-first reverse-mapping: daily at 07:00 UTC (sub-phase 2 plan §3.8).
  // Reverse-maps Betfair's soccer competition list against API-Football,
  // populates Tier D for unmatched, archetype-labels every row.
  // Writes by default (Wave 3) — set BETFAIR_REVERSE_MAPPING_DRY_RUN=true to suppress
  // writes after reviewing 1-3 dry-run reports.
  cron.schedule("0 7 * * *", () => {
    logger.info("Betfair-first reverse-mapping triggered by scheduler");
    void runBetfairReverseMapping()
      .then((r) => logger.info({ runId: r.runId, durationMs: r.durationMs, dryRun: r.dryRun, writesApplied: r.writesApplied }, "Betfair reverse-mapping complete"))
      .catch((err) => logger.warn({ err }, "Betfair reverse-mapping failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("Betfair reverse-mapping scheduler active — daily at 07:00 UTC");

  cron.schedule("0 4 * * *", () => {
    logger.info("Promotion engine triggered (daily 04:00 UTC)");
    void runPromotionEngine().catch((err) => {
      logger.error({ err }, "Promotion engine failed");
    });
  }, { timezone: "UTC" });
  logger.info("Promotion engine scheduler active — daily at 04:00 UTC");

  cron.schedule("15 4 * * *", () => {
    logger.info("Live risk level evaluation triggered (daily 04:15 UTC)");
    void (async () => {
      try {
        const { applyLevelTransition } = await import("./liveRiskManager");
        const result = await applyLevelTransition();
        logger.info({ result }, "Live risk level evaluation complete");
      } catch (err) {
        logger.error({ err }, "Live risk level evaluation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Live risk level evaluation scheduler active — daily at 04:15 UTC");

  cron.schedule("0 4 * * 0", () => {
    logger.info("Weekly experiment self-analysis triggered (Sunday 04:00 UTC)");
    void runWeeklyExperimentAnalysis().catch((err) => {
      logger.error({ err }, "Weekly experiment analysis failed");
    });
  }, { timezone: "UTC" });
  logger.info("Weekly experiment analysis scheduler active — Sunday 04:00 UTC");

  cron.schedule("30 4 * * 0", () => {
    logger.info("Data richness recalculation triggered (Sunday 04:30 UTC)");
    void recalculateAllDataRichness().catch((err) => {
      logger.error({ err }, "Data richness recalculation failed");
    });
  }, { timezone: "UTC" });
  logger.info("Data richness recalculation scheduler active — Sunday 04:30 UTC");

  cron.schedule("0 5 * * 0", () => {
    logger.info("Live threshold review triggered (Sunday 05:00 UTC)");
    void reviewLiveThreshold().catch((err) => {
      logger.error({ err }, "Live threshold review failed");
    });
  }, { timezone: "UTC" });
  logger.info("Live threshold review scheduler active — Sunday 05:00 UTC");

  // Sub-phase 6.5: weekly autonomous threshold proposal generator.
  // Runs every Sunday 08:00 UTC, after the 04:00-05:00 Sunday cron cluster
  // (promotion engine, weekly experiment analysis, data richness, live
  // threshold review) so it reads metrics those runs have refreshed.
  // Writes are env-gated by THRESHOLD_PROPOSAL_GENERATOR_ENABLED inside the
  // function (default false). Cron always runs; only proposes when flag is on.
  // Logs a summary (counts only) — full skip detail is available on demand
  // via POST /api/admin/run-proposal-generator.
  cron.schedule("0 8 * * 0", () => {
    logger.info("Threshold proposal generator triggered (Sunday 08:00 UTC)");
    void runProposalGenerator()
      .then((result) => {
        logger.info({
          proposalsApproved: result.proposalsApproved,
          proposalsPending: result.proposalsPending,
          nProposals: result.proposals.length,
          nSkipped: result.skipped.length,
          scopesProcessed: result.scopesProcessed.length,
          thresholdsConsidered: result.thresholdsConsidered,
          dryRun: result.dryRun,
          flagEnabled: result.proposalGeneratorEnabledFlag,
        }, "Threshold proposal generator complete");
      })
      .catch((err) => {
        logger.error({ err }, "Threshold proposal generator failed");
      });
  }, { timezone: "UTC" });
  logger.info("Threshold proposal generator scheduler active — Sunday 08:00 UTC");

  cron.schedule("0 */6 * * *", () => {
    logger.info("Dev→Prod sync triggered (every 6 hours)");
    void syncDevToProd().catch((err) => {
      logger.error({ err }, "Dev→Prod sync failed");
    });
  }, { timezone: "UTC" });
  logger.info("Dev→Prod sync scheduler active — every 6 hours");

  cron.schedule("*/15 * * * *", () => {
    void capturePreKickoffLineups().catch((err) => {
      logger.error({ err }, "Pre-kickoff lineup capture failed");
    });
  }, { timezone: "UTC" });
  logger.info("Pre-kickoff lineup capture active — every 15 min");

  // Sub-phase 7.0a: daily injury ingestion. Pulls /injuries for fixtures
  // kicking off in the next 24h with placed bets. ~50-100 calls/day, well
  // within the 75k/day budget. No feature wiring yet — sub-commit 7.0b
  // validates predictive power before any feature ships.
  cron.schedule("0 6 * * *", () => {
    logger.info("Injury ingestion triggered (daily 06:00 UTC)");
    void fetchInjuriesForUpcomingMatches().catch((err) => {
      logger.error({ err }, "Injury ingestion failed");
    });
  }, { timezone: "UTC" });
  logger.info("Injury ingestion scheduler active — daily at 06:00 UTC");

  // Sub-phase 7.x: weekly AF metadata bundle (transfers/coaches/sidelined/
  // trophies). Per-team orchestrator runs first then per-player. TTL-gated
  // (6-day refresh window) so steady-state burns ~50 calls/week. Sits in the
  // empty slot between injury ingestion (06:00) and threshold proposal
  // generator (08:00) on Sundays.
  cron.schedule("0 7 * * 0", () => {
    logger.info("AF metadata bundle triggered (Sunday 07:00 UTC)");
    void (async () => {
      try {
        const teamResult = await fetchTeamMetadataForUpcomingMatches();
        logger.info(teamResult, "AF team metadata complete");
        const playerResult = await fetchPlayerMetadataForRecentInjuries();
        logger.info(playerResult, "AF player metadata complete");
      } catch (err) {
        logger.error({ err }, "AF metadata bundle failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("AF metadata bundle scheduler active — Sunday 07:00 UTC");

  // C3a (2026-05-07): AF /predictions ingestion — every 12 hours UTC. Up to
  // 500 fixtures per run; refreshes only fixtures whose prediction is >12h
  // old or missing. Modest API cost (~1k calls/day) within 75k budget.
  cron.schedule("0 8,20 * * *", () => {
    logger.info("AF predictions ingestion triggered (12h cadence)");
    void (async () => {
      try {
        const { captureUpcomingPredictions } = await import("./apiFootball");
        const r = await captureUpcomingPredictions();
        logger.info(r, "AF predictions ingestion complete");
      } catch (err) {
        logger.error({ err }, "AF predictions ingestion failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("AF predictions ingestion scheduler active — 08:00 + 20:00 UTC daily");

  // X2 (2026-05-07): referee assignment ingestion — daily 06:45 UTC.
  cron.schedule("45 6 * * *", () => {
    logger.info("Referee ingestion triggered (daily 06:45 UTC)");
    void (async () => {
      try {
        const { captureRefereesForUpcoming } = await import("./apiFootball");
        const r = await captureRefereesForUpcoming();
        logger.info(r, "Referee ingestion complete");
      } catch (err) {
        logger.error({ err }, "Referee ingestion failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Referee ingestion scheduler active — daily 06:45 UTC");

  // X3 (2026-05-07): H2H ingestion — daily 07:00 UTC.
  cron.schedule("0 7 * * *", () => {
    logger.info("H2H ingestion triggered (daily 07:00 UTC)");
    void (async () => {
      try {
        const { captureH2hForUpcoming } = await import("./apiFootball");
        const r = await captureH2hForUpcoming();
        logger.info(r, "H2H ingestion complete");
      } catch (err) {
        logger.error({ err }, "H2H ingestion failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("H2H ingestion scheduler active — daily 07:00 UTC");

  // X4 (2026-05-07): post-match fixture/events ingestion — daily 02:00 UTC.
  cron.schedule("0 2 * * *", () => {
    logger.info("Fixture-events ingestion triggered (daily 02:00 UTC)");
    void (async () => {
      try {
        const { captureFixtureEventsForRecent } = await import("./apiFootball");
        const r = await captureFixtureEventsForRecent();
        logger.info(r, "Fixture-events ingestion complete");
      } catch (err) {
        logger.error({ err }, "Fixture-events ingestion failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Fixture-events ingestion scheduler active — daily 02:00 UTC");

  // X5 (2026-05-07): post-match fixture/players ingestion — daily 02:30 UTC.
  cron.schedule("30 2 * * *", () => {
    logger.info("Fixture-players ingestion triggered (daily 02:30 UTC)");
    void (async () => {
      try {
        const { captureFixturePlayersForRecent } = await import("./apiFootball");
        const r = await captureFixturePlayersForRecent();
        logger.info(r, "Fixture-players ingestion complete");
      } catch (err) {
        logger.error({ err }, "Fixture-players ingestion failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Fixture-players ingestion scheduler active — daily 02:30 UTC");

  // C3-lineup-features (2026-05-07): expected-XI refresh — daily 04:00 UTC,
  // after settlement so the refresh sees the latest captured lineups.
  // Zero new API calls — aggregates _lineup_data history into team_expected_xi.
  cron.schedule("0 4 * * *", () => {
    logger.info("Expected-XI refresh triggered (daily 04:00 UTC)");
    void (async () => {
      try {
        const { refreshExpectedXi } = await import("./apiFootball");
        const r = await refreshExpectedXi();
        logger.info(r, "Expected-XI refresh complete");
      } catch (err) {
        logger.error({ err }, "Expected-XI refresh failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Expected-XI refresh scheduler active — daily 04:00 UTC");

  // C3a (2026-05-07): AF /standings ingestion — daily 06:30 UTC.
  // ~240 active leagues, one call each, idempotent upsert.
  cron.schedule("30 6 * * *", () => {
    logger.info("AF standings ingestion triggered (daily 06:30 UTC)");
    void (async () => {
      try {
        const { captureAllActiveStandings } = await import("./apiFootball");
        const r = await captureAllActiveStandings();
        logger.info(r, "AF standings ingestion complete");
      } catch (err) {
        logger.error({ err }, "AF standings ingestion failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("AF standings ingestion scheduler active — daily 06:30 UTC");

  // 2026-05-07: model self-audit. Daily 03:30 UTC, before settlement /
  // trading crons. Computes per-market, per-(league × market), per-archetype
  // ROI / Kelly-growth / Pinnacle-coverage; pauses underperforming scopes
  // via the autonomous_pauses registry. Shadow bets bypass pauses (capital-
  // protective only). Auto-resume after pause window with trial-mode 50%
  // Kelly fraction.
  //
  // Phase 3 Track A (2026-05-08): SUSPENDED. Cron disabled at scheduler level
  // (belt-and-braces alongside model_self_audit_enabled='false' kill switch
  // inside runModelSelfAudit). Re-enable only after Kelly-growth proxy is
  // replaced with bankroll_snapshots-based metric. See docs/phase-3-paper-
  // to-live-switchover-plan-v2.md §1.4 + §3 Track A.
  // cron.schedule("30 3 * * *", () => {
  //   logger.info("Model self-audit triggered (daily 03:30 UTC)");
  //   void (async () => {
  //     try {
  //       const { runModelSelfAudit } = await import("./modelSelfAudit");
  //       const result = await runModelSelfAudit();
  //       logger.info(result, "Model self-audit complete");
  //     } catch (err) {
  //       logger.error({ err }, "Model self-audit failed");
  //     }
  //   })();
  // }, { timezone: "UTC" });
  logger.info("Model self-audit SUSPENDED (Phase 3 Track A, 2026-05-08)");

  // Sub-phase 10: weekly ongoing audit (settlement-bias + auto-demote).
  // Sits at Sunday 09:00 UTC, after threshold proposal generator (08:00).
  // Always writes settlement_bias_observation rows; auto-demote action gated
  // by ONGOING_AUDIT_AUTO_DEMOTE_ENABLED env flag (default false).
  cron.schedule("0 9 * * 0", () => {
    logger.info("Ongoing audit triggered (Sunday 09:00 UTC)");
    void (async () => {
      try {
        const { runOngoingAudit } = await import("./auditCron");
        const result = await runOngoingAudit();
        logger.info(
          {
            observationsWritten: result.observationsWritten,
            breachingLeagues: result.breachingLeagues,
            demotionsPlanned: result.demotionsPlanned,
            demotionsApplied: result.demotionsApplied,
            autoDemoteFlagEnabled: result.autoDemoteFlagEnabled,
          },
          "Ongoing audit complete",
        );
      } catch (err) {
        logger.error({ err }, "Ongoing audit failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Ongoing audit scheduler active — Sunday 09:00 UTC");

  // Sub-phase 9 v2: weekly Kelly-optimiser pass over all candidate+promoted
  // tags. Sits at Sunday 09:30 UTC, after ongoing audit (09:00) which may
  // have demoted some tags. Per-settlement event-driven optimiser handles
  // the steady state; this cron catches dormant tags + global re-pass.
  cron.schedule("30 9 * * 0", () => {
    logger.info("Kelly optimiser weekly cron triggered (Sunday 09:30 UTC)");
    void (async () => {
      try {
        const { runKellyOptimizerForAllTags } = await import("./promotionEngine");
        const result = await runKellyOptimizerForAllTags();
        logger.info(
          { checked: result.checked, ratcheted: result.ratcheted, skipped: result.skipped },
          "Kelly optimiser weekly pass complete",
        );
      } catch (err) {
        logger.error({ err }, "Kelly optimiser weekly pass failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Kelly optimiser weekly cron active — Sunday 09:30 UTC");

  cron.schedule("0 3 1 * *", () => {
    logger.info("Monthly league performance scoring + deactivation triggered");
    void (async () => {
      try {
        const scores = await calculateLeaguePerformanceScores();
        logger.info({ topScores: scores.slice(0, 10).map((s) => `${s.league}: ${s.compositeScore} (n=${s.totalBets}, w=${s.sampleSizeWeight.toFixed(2)})`).join(", ") }, "League scores calculated");
        const result = await deactivateLowValueLeagues();
        logger.info(result, "League deactivation complete");
      } catch (err) {
        logger.error({ err }, "Monthly league scoring/deactivation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Monthly league scoring active — 1st of month 03:00 UTC");

  // VPS relay health check: every 5 minutes (if relay is configured)
  if (isRelayConfigured()) {
    cron.schedule("*/5 * * * *", () => {
      void checkRelayHealth()
        .then((result) => {
          if (result.healthy) {
            logger.debug({ latencyMs: result.latencyMs, uptime: result.uptime }, "VPS relay healthy");
          }
        })
        .catch((err) => logger.error({ err }, "VPS relay health check error"));
    }, { timezone: "UTC" });
    logger.info("VPS relay health check active — every 5 minutes");
  } else {
    logger.info("VPS relay not configured (VPS_RELAY_URL not set) — health check skipped");
  }

  // Order management: every 2 minutes when relay is configured (live mode)
  // Checks partial fills, handles cancellation timeouts, near-kickoff reassessment
  if (isRelayConfigured()) {
    cron.schedule("*/2 * * * *", () => {
      void runOrderManagement()
        .then((r) => {
          if (r.checked > 0) {
            logger.info(r, "Order management cycle complete");
          }
        })
        .catch((err) => logger.warn({ err }, "Order management cycle failed — non-fatal"));
    }, { timezone: "UTC" });
    logger.info("Order management cron active — every 2 minutes (partial fills, cancellations, reassessment)");
  }

  // Stale placement reconciliation: every hour — check for PENDING_PLACEMENT > 10 min
  cron.schedule("0 * * * *", () => {
    void (async () => {
      try {
        const { reconcileStalePlacements } = await import("./paperTrading");
        const result = await reconcileStalePlacements();
        if (result.reconciled > 0 || result.flagged > 0) {
          logger.info(result, "Stale placement reconciliation complete");
        }
      } catch (err) {
        logger.error({ err }, "Stale placement reconciliation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Stale placement reconciliation active — hourly");

  // Stale-pending escalation: every hour, offset 30 min from placement check.
  // Warns at kickoff+4h, auto-voids at kickoff+24h. See reconcileStalePending().
  cron.schedule("30 * * * *", () => {
    void (async () => {
      try {
        const { reconcileStalePending } = await import("./paperTrading");
        const result = await reconcileStalePending();
        if (result.warned + result.paperVoided + result.betfairReconciled + result.betfairFlagged > 0) {
          logger.info(result, "Stale-pending reconciliation complete");
        }
      } catch (err) {
        logger.error({ err }, "Stale-pending reconciliation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Stale-pending escalation active — hourly (warn at +4h, auto-void at +24h)");

  // Live balance + statement reconciliation: daily at 05:00 UTC. Two checks
  // running back-to-back so a balance drift can be diagnosed against the
  // statement walk in the same window. No-ops outside live mode.
  cron.schedule("0 5 * * *", () => {
    void (async () => {
      try {
        const { reconcileLiveBalance, reconcileLiveAccountStatement } = await import("./liveReconciliation");
        const balance = await reconcileLiveBalance();
        if (balance) {
          logger.info(balance, "Daily live balance reconciliation");
        }
        const statement = await reconcileLiveAccountStatement();
        if (statement) {
          logger.info(statement, "Daily live statement reconciliation");
        }
      } catch (err) {
        logger.error({ err }, "Live balance/statement reconciliation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Live balance + statement reconciliation active — daily 05:00 UTC");

  // Alert detection: every 5 minutes — check for critical/warning conditions
  cron.schedule("*/5 * * * *", () => {
    void (async () => {
      try {
        const { runAlertDetection, checkMilestones } = await import("./alertDetection");
        await runAlertDetection();
        await checkMilestones();
      } catch (err) {
        logger.error({ err }, "Alert detection cron failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Alert detection active — every 5 minutes");

  // Anomaly detection: daily at 04:30 UTC
  cron.schedule("30 4 * * *", () => {
    void (async () => {
      try {
        const { runAnomalyDetection } = await import("./alertDetection");
        await runAnomalyDetection();
      } catch (err) {
        logger.error({ err }, "Anomaly detection cron failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Anomaly detection active — daily 04:30 UTC");

  // Z4 (2026-05-07): autonomous bidirectional universe_tier ladder — daily
  // 03:45 UTC, after model self-audit at 03:30. For each (league × archetype)
  // scope with n≥10 settled bets in last 30d, computes log-bankroll-growth
  // per bet. Promotes E→C / D→C / C→B and demotes A→B / B→C / C→D / D→E
  // when growth crosses thresholds. All transitions audit-logged.
  //
  // Phase 3 Track A (2026-05-08): SUSPENDED. Same broken Kelly-growth proxy
  // as modelSelfAudit. Disabled at scheduler level (belt-and-braces alongside
  // z4_enabled='false' kill switch inside runAutonomousTierLadder).
  // cron.schedule("45 3 * * *", () => {
  //   logger.info("Autonomous tier-ladder triggered (daily 03:45 UTC)");
  //   void (async () => {
  //     try {
  //       const { runAutonomousTierLadder } = await import("./autonomousTierLadder");
  //       const r = await runAutonomousTierLadder();
  //       logger.info(r, "Autonomous tier-ladder complete");
  //     } catch (err) {
  //       logger.error({ err }, "Autonomous tier-ladder failed");
  //     }
  //   })();
  // }, { timezone: "UTC" });
  logger.info("Autonomous tier-ladder SUSPENDED (Phase 3 Track A, 2026-05-08)");

  // Z3 (2026-05-07): autonomous threshold revision — weekly Sunday 10:00
  // UTC, after Sun 09:30 Kelly optimiser. Per (league, market) scope with
  // n≥30 settled bets in last 30d, simulates Kelly-growth at delta-grid
  // alternative thresholds, auto-applies the best (subject to ≥30%
  // sample-retention safety floor). Per Chris's no-manual directive +
  // brief autonomy clause "Internal confidence thresholds for value
  // detection" — both tighter and looser auto-apply, audit-logged.
  //
  // Phase 3 Track A (2026-05-08): SUSPENDED. Threshold loosening on the same
  // broken Kelly-growth proxy creates a feedback loop. Disabled at scheduler
  // level (belt-and-braces alongside z3_enabled='false' kill switch inside
  // runThresholdRevisionProposer).
  // cron.schedule("0 10 * * 0", () => {
  //   logger.info("Autonomous threshold revision triggered (weekly Sunday 10:00 UTC)");
  //   void (async () => {
  //     try {
  //       const { runThresholdRevisionProposer } = await import("./autonomousThresholdRevision");
  //       const r = await runThresholdRevisionProposer();
  //       logger.info(r, "Autonomous threshold revision complete");
  //     } catch (err) {
  //       logger.error({ err }, "Autonomous threshold revision failed");
  //     }
  //   })();
  // }, { timezone: "UTC" });
  logger.info("Autonomous threshold revision SUSPENDED (Phase 3 Track A, 2026-05-08)");

  // Z6 (2026-05-07): feature predictive-power scoring — weekly Sunday 11:00
  // UTC. Computes per-feature point-biserial correlation + p-value vs
  // settled-bet outcomes. Identifies which stored-but-not-active features
  // have measurable predictive signal. Logs scores to audit log; future
  // commit auto-extends FEATURE_NAMES + triggers retrain when threshold
  // criteria sustain over 4 weeks.
  cron.schedule("0 11 * * 0", () => {
    logger.info("Feature predictive-power scoring triggered (weekly Sunday 11:00 UTC)");
    void (async () => {
      try {
        const { runFeaturePredictivePowerScoring } = await import("./featurePredictivePower");
        const r = await runFeaturePredictivePowerScoring();
        logger.info(r, "Feature predictive-power scoring complete");
      } catch (err) {
        logger.error({ err }, "Feature predictive-power scoring failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Feature predictive-power scoring scheduler active — Sunday 11:00 UTC");

  // Sub-phase 4.B (2026-05-08): Betfair market-type discovery — daily
  // 03:50 UTC. Samples ~50 upcoming Tier A/B/C events, queries
  // listMarketCatalogue with no marketTypeCodes filter, logs all
  // observed marketType values. New unmapped codes auto-proposed via
  // model_decision_audit_log for future MARKET_TYPE_MAP additions.
  cron.schedule("50 3 * * *", () => {
    logger.info("Betfair market discovery triggered (daily 03:50 UTC)");
    void (async () => {
      try {
        const { runBetfairMarketDiscovery } = await import("./betfairMarketDiscovery");
        const r = await runBetfairMarketDiscovery();
        logger.info(r, "Betfair market discovery complete");
      } catch (err) {
        logger.error({ err }, "Betfair market discovery failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Betfair market discovery scheduler active — daily 03:50 UTC");

  // Y3 (2026-05-07): weekly autonomous WC participant coverage audit —
  // Sunday 05:30 UTC. Identifies countries playing in WC qualifying
  // fixtures that lack a Tier 1 active club league + auto-promotes a
  // candidate league from Tier E/D to C. Runs before Y1 Tier E re-eval.
  cron.schedule("30 5 * * 0", () => {
    logger.info("WC participant audit triggered (weekly Sunday 05:30 UTC)");
    void (async () => {
      try {
        const { auditWorldCupParticipantCoverage } = await import("./betfairFirstUniverse");
        const r = await auditWorldCupParticipantCoverage();
        logger.info(r, "WC participant audit complete");
      } catch (err) {
        logger.error({ err }, "WC participant audit failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("WC participant audit scheduler active — Sunday 05:30 UTC");

  // Y1 (2026-05-07): weekly Tier E re-evaluation pass — Sunday 06:00 UTC.
  // Re-runs assignTier on Tier E rows with category-aware Y2 rules. Auto-
  // promotes women's, youth, internationals, friendlies that were stuck at
  // E into active tiers. Full audit log per autonomous reactivation.
  cron.schedule("0 6 * * 0", () => {
    logger.info("Tier E re-evaluation triggered (weekly Sunday 06:00 UTC)");
    void (async () => {
      try {
        const { reevaluateExcludedLeagues } = await import("./betfairFirstUniverse");
        const r = await reevaluateExcludedLeagues();
        logger.info(r, "Tier E re-evaluation complete");
      } catch (err) {
        logger.error({ err }, "Tier E re-evaluation failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Tier E re-evaluation scheduler active — Sunday 06:00 UTC");

  // Alert cleanup: weekly Sunday 06:00 — remove alerts older than 90 days
  cron.schedule("0 6 * * 0", () => {
    void (async () => {
      try {
        const { cleanupOldAlerts } = await import("./alerting");
        const removed = await cleanupOldAlerts(90);
        if (removed > 0) logger.info({ removed }, "Old alerts cleaned up");
      } catch (err) {
        logger.error({ err }, "Alert cleanup failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Alert cleanup active — Sunday 06:00 UTC (90-day retention)");

  // C1 (2026-05-07): odds_snapshots retention — daily 02:30 UTC.
  // Without TTL the table grew to ~18M rows / 3.3 GB. Pre-kickoff snapshots
  // for SETTLED matches are redundant once paper_bets has copied snapshot_a/
  // b/c columns at settlement time. Delete in batches to avoid long locks.
  // Match grace period: 7 days post-kickoff to allow for delayed settlements
  // and CLV backfills. Matches still in 'scheduled'/'in_play' status are
  // never touched.
  cron.schedule("30 2 * * *", () => {
    void (async () => {
      try {
        const t0 = Date.now();
        let totalDeleted = 0;
        // Delete in 100k-row batches to keep transaction sizes bounded.
        for (let i = 0; i < 50; i++) {
          const result = await db.execute(sql`
            WITH victims AS (
              SELECT os.id
              FROM odds_snapshots os
              JOIN matches m ON m.id = os.match_id
              WHERE m.status IN ('completed', 'cancelled', 'postponed', 'abandoned')
                AND m.kickoff_time < NOW() - INTERVAL '7 days'
                AND os.snapshot_time < NOW() - INTERVAL '7 days'
              LIMIT 100000
            )
            DELETE FROM odds_snapshots
            WHERE id IN (SELECT id FROM victims)
            RETURNING 1
          `);
          const rowCount = (result as any).rowCount ?? 0;
          totalDeleted += rowCount;
          if (rowCount < 100000) break;
        }
        logger.info({ totalDeleted, durationMs: Date.now() - t0 }, "odds_snapshots retention sweep complete");
      } catch (err) {
        logger.error({ err }, "odds_snapshots retention sweep failed");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("odds_snapshots retention scheduler active — daily 02:30 UTC (7-day post-kickoff retention)");

  setTimeout(async () => {
    try {
      logger.info("Startup: running OddsPapi fixture mapping + bulk prefetch + API-Football odds refresh before trading cycle");
      await safeRunOddspapiMapping();
      const [afResult, opResult] = await Promise.all([
        fetchAndStoreOddsForAllUpcoming().then((r) => {
          logger.info(r, "Startup API-Football odds refresh complete");
          return r;
        }),
        runKickoffProximityPrefetch().then(async (r) => {
          logger.info(r, "Startup OddsPapi kickoff-proximity prefetch complete");
          const dc = await derivePinnacleDCFromMatchOdds();
          logger.info(dc, "Startup post-prefetch DC derivation complete");
          const unified = await backfillPinnacleUnified();
          logger.info({ unified }, "Startup post-prefetch unified Pinnacle backfill complete");
          return r;
        }),
      ]);
    } catch (err) {
      logger.warn({ err }, "Startup odds refresh failed — non-fatal, proceeding to trading cycle");
    }
    // 2026-05-08: startup runTradingCycle warmup DISABLED. The fire-and-
    // forget invocation here was hanging deterministically on every
    // restart (likely a vps-relay HTTP call that doesn't resolve), holding
    // the tradingCycleRunning lock and blocking the */5min cron. The
    // regular cron will fire within 5 minutes of startup anyway, so the
    // warmup gives at most 5 min of earlier first-run; not worth the
    // failure mode. Stale-lock detection (5 min) provides a safety net
    // for any future deterministic hang.
    logger.info("Startup near trading cycle warmup SKIPPED — */5min cron handles first run");
  }, 30 * 1000);
  logger.info("Startup warmup scheduled — OddsPapi mapping + bulk prefetch + odds refresh in 30s (trading cycle warmup disabled 2026-05-08)");

  // Seed baseline leagues + competition config at startup (idempotent — uses onConflictDoNothing)
  void seedBaselineLeagues().catch((err) => logger.warn({ err }, "Baseline league seed failed — non-fatal"));
  void seedCompetitionConfig().catch((err) => logger.warn({ err }, "Competition config seed failed — non-fatal"));
}

// ===================== Manual triggers (for API routes) =====================

export async function runSettlementNow(): Promise<{ synced: number; settled: Awaited<ReturnType<typeof settleBets>>; backfill: { matchesUpdated: number; betsResettled: number } }> {
  if (settlementRunning) {
    logger.info("Manual settlement skipped — pipeline already running");
    return {
      synced: 0,
      settled: {
        settled: 0,
        won: 0,
        lost: 0,
        totalPnl: 0,
        paperPendingRetry: 0,
        paperTimeoutLoss: 0,
        paperAbandonmentVoid: 0,
      },
      backfill: { matchesUpdated: 0, betsResettled: 0 },
    };
  }
  settlementRunning = true;
  try {
    logger.info("Manual settlement triggered via API");
    const synced = await syncMatchResults(7);
    const settled = await settleBets();
    const backfill = await backfillCornersCardsStats();
    return { synced, settled, backfill };
  } finally {
    settlementRunning = false;
  }
}

export async function runIngestionNow(): Promise<void> {
  return safeRunIngestion();
}

export async function runXGIngestionNow(): Promise<{ inserted: number; updated: number }> {
  logger.info("Manual xG ingestion triggered");
  return runXGIngestion();
}

export async function runFeaturesNow(): Promise<
  ReturnType<typeof runFeatureEngineForUpcomingMatches>
> {
  // 2026-05-08: uses the same featureLock as the cron path (registered above).
  // Manual + cron now share the same stale-detection.
  const r = await featureLock.withLock(async () => {
    return await runFeatureEngineForUpcomingMatches();
  });
  if (r.skipped) {
    logger.warn({ reason: r.reason, heldMs: r.heldMs }, "Manual feature run skipped — lock held");
    return { processed: 0, skipped: 0, failed: 0 };
  }
  return r.value!;
}

// 2026-05-08: admin-endpoint convenience for releasing stuck locks
// without restart. Mirrors resetTradingCycleLock for the new locks.
export function resetIngestionLock(): { wasHeld: boolean; heldFor: number | null } {
  const r = ingestionLock.forceRelease();
  return { wasHeld: r.wasHeld, heldFor: r.heldMs };
}
export function resetFeatureLock(): { wasHeld: boolean; heldFor: number | null } {
  const r = featureLock.forceRelease();
  return { wasHeld: r.wasHeld, heldFor: r.heldMs };
}
export function resetExchangeBookSweepLock(): { wasHeld: boolean; heldFor: number | null } {
  const r = exchangeBookSweepLock.forceRelease();
  return { wasHeld: r.wasHeld, heldFor: r.heldMs };
}

export async function runOddspapiMappingNow(): Promise<
  ReturnType<typeof runOddspapiFixtureMapping>
> {
  const result = await runOddspapiFixtureMapping();
  // After mapping, update which discovered leagues now have confirmed Pinnacle coverage
  void updatePinnacleOddsFromActualMappings().catch((err) =>
    logger.warn({ err }, "Pinnacle coverage sync failed — non-fatal"),
  );
  return result;
}

export async function runLeagueDiscoveryNow(): Promise<ReturnType<typeof runLeagueDiscovery>> {
  logger.info("Manual league discovery triggered");
  return runLeagueDiscovery();
}

export async function runIngestDiscoveredFixturesNow(): Promise<ReturnType<typeof ingestFixturesForDiscoveredLeagues>> {
  logger.info("Manual discovered-league fixture ingestion triggered");
  return ingestFixturesForDiscoveredLeagues();
}

export async function runPinnacleCoverageUpdateNow(): Promise<ReturnType<typeof updatePinnacleOddsFromActualMappings>> {
  logger.info("Manual Pinnacle coverage sync triggered");
  return updatePinnacleOddsFromActualMappings();
}
