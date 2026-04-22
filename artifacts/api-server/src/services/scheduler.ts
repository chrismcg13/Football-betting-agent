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
  getApiBudgetStatus,
} from "./apiFootball";
import { runXGIngestion } from "./xgIngestionService";
import {
  runOddspapiFixtureMapping,
  getOddspapiFixtureId,
  getOddspapiValidation,
  prefetchAndStoreOddsPapiOdds,
  loadOddsPapiCacheFromSnapshots,
  runDedicatedBulkPrefetch,
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
import { fetchRecentFixtureResults, teamNameMatch, fetchMatchStatsForSettlement, getLeaguesWithPendingBets, fetchAndStoreOddsForAllUpcoming, backfillPinnacleSnapshotsFromAf } from "./apiFootball";
import { runLeagueDiscovery, seedBaselineLeagues, updatePinnacleOddsFromActualMappings, seedCompetitionConfig } from "./leagueDiscovery";
import { db, pool, agentConfigTable, leagueEdgeScoresTable, paperBetsTable, matchesTable } from "@workspace/db";
import { eq, and, inArray, sql, gte, lte } from "drizzle-orm";
import { runPromotionEngine } from "./promotionEngine";
import { runWeeklyExperimentAnalysis } from "./experimentAnalysis";
import { syncDevToProd } from "./syncDevToProd";
import { reconcileSettlements, isLiveMode, getAccountFunds } from "./betfairLive";
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
let ingestionRunning = false;
let featureRunning = false;
let tradingCycleRunning = false;
let exchangeBookSweepRunning = false;

// ===================== Safe wrappers =====================

async function safeRunIngestion(): Promise<void> {
  if (ingestionRunning) {
    logger.warn("Data ingestion already in progress — skipping this run");
    markRun("ingestion", "skipped");
    return;
  }
  ingestionRunning = true;
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
  } finally {
    ingestionRunning = false;
  }
}

async function safeRunFeatures(): Promise<void> {
  if (featureRunning) {
    logger.warn("Feature computation already in progress — skipping this run");
    markRun("features", "skipped");
    return;
  }
  featureRunning = true;
  markStart("features");
  try {
    await trackCronExecution("features", async () => {
      await runFeatureEngineForUpcomingMatches();
    });
    markRun("features", "success");
  } catch (err) {
    logger.error({ err }, "Scheduled feature computation run failed");
    markRun("features", "error");
  } finally {
    featureRunning = false;
  }
}

// ===================== Exchange book sweep =====================
// Populates odds_snapshots with source='betfair_exchange' rows so the Prompt 5
// venue-anchored pricing picker has live exchange data to consume. Runs
// unconditionally whenever Betfair credentials are configured — NOT gated on
// agent_config.data_source.

async function safeRunExchangeBookSweep(): Promise<void> {
  if (exchangeBookSweepRunning) {
    logger.warn("Exchange book sweep already in progress — skipping this run");
    markRun("exchange_book_sweep", "skipped");
    return;
  }
  exchangeBookSweepRunning = true;
  markStart("exchange_book_sweep");
  try {
    await trackCronExecution("exchange_book_sweep", async () => {
      const r = await runExchangeBookSweep();
      return r.snapshotsWritten;
    });
    markRun("exchange_book_sweep", "success");
  } catch (err) {
    logger.error({ err }, "Scheduled exchange book sweep failed");
    markRun("exchange_book_sweep", "error");
  } finally {
    exchangeBookSweepRunning = false;
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
    logger.warn({ tier }, "Trading cycle already in progress — skipping this run");
    markRun("trading", "skipped");
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false, tier, fixtureWindowHours: maxHours };
  }

  tradingCycleRunning = true;
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

    const todayBetRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(paperBetsTable)
      .where(sql`date_trunc('day', ${paperBetsTable.placedAt} AT TIME ZONE 'UTC') = current_date AND status != 'void' AND deleted_at IS NULL`);
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

      if (effectiveScore < minScore) {
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

      // Generate thesis
      const backOdds = validation?.bestOdds ?? bet.backOdds;
      const pinnacleAligned = validation?.pinnacleAligned ?? false;
      const leagueEdgeScore = leagueEdgeMap.get(bet.league) ?? 50;
      const leagueBonusStr = leagueEdgeScore !== 50 ? ` League edge score: ${leagueEdgeScore.toFixed(0)}.` : "";
      const thesis = validation?.hasPinnacleData
        ? `Backing ${bet.selectionName} at ${backOdds.toFixed(2)} from ${validation.bestBookmaker ?? "best available"}. ` +
          `Model: ${(bet.modelProbability * 100).toFixed(1)}%, Pinnacle implies: ${((validation.pinnacleImplied ?? 0) * 100).toFixed(1)}%. ` +
          `Edge: ${(bet.edge * 100).toFixed(1)}% using best available price. ` +
          (validation.sharpSoftSpread ? `Sharp-soft spread: ${(validation.sharpSoftSpread * 100).toFixed(1)}%. ` : "") +
          (isContrarian ? "CONTRARIAN — Pinnacle-misaligned." : pinnacleAligned ? "Pinnacle-aligned." : "") +
          leagueBonusStr
        : `Backing ${bet.selectionName} at ${bet.backOdds.toFixed(2)}. Model: ${(bet.modelProbability * 100).toFixed(1)}%, Edge: ${(bet.edge * 100).toFixed(1)}%.${leagueBonusStr}`;

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
        _effectiveScore: effectiveScore,
        _isContrarian: isContrarian,
      } as BetCandidate & Record<string, unknown>);

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

    // ─── PINNACLE-LEAGUE SELECTION FILTER (scope v3 §6 step 1) ───
    // Reject any candidate whose match league is NOT in competition_config WHERE has_pinnacle_odds=true.
    // Rationale: if we cannot validate CLV against a genuine Pinnacle line, we do not bet the match.
    // Toggle via reject_non_pinnacle_leagues config flag (default "true"). Logs every rejection
    // for the first 7 days for audit. Set flag to "false" for instant rollback without redeploy.
    {
      const flagRaw = (await getConfigValue("reject_non_pinnacle_leagues")) ?? "true";
      const flagEnabled = flagRaw.toLowerCase() === "true";
      if (!flagEnabled) {
        logger.warn(
          { tier, candidates: selectedBets.length },
          "Pinnacle-league filter DISABLED via reject_non_pinnacle_leagues=false (rollback mode)",
        );
        funnel["07a_pinnacle_league_filter"] = "disabled" as unknown as number;
      } else if (selectedBets.length > 0) {
        const ccRows = await db.execute(sql`
          SELECT LOWER(name) AS name, LOWER(country) AS country
          FROM competition_config WHERE has_pinnacle_odds = true
        `);
        const ccData = ((ccRows as unknown as { rows?: Array<{ name: string; country: string }> }).rows
          ?? (ccRows as unknown as Array<{ name: string; country: string }>));
        const pinKey = new Set<string>();
        const pinName = new Set<string>();
        for (const r of ccData) {
          pinName.add(r.name);
          pinKey.add(`${r.name}|${r.country}`);
        }

        const matchIds = Array.from(new Set(selectedBets.map((b) => b.matchId)));
        // Fix: drizzle's sql template interpolates JS arrays as ($1, $2, ...)
        // tuples, which Postgres rejects for ANY(). Use inArray() for proper
        // array binding. Also short-circuit on empty input to avoid an
        // invalid empty-IN query.
        const matchMeta = new Map<number, { league: string; country: string }>();
        if (matchIds.length > 0) {
          const matchRows = await db
            .select({
              id: matchesTable.id,
              league: sql<string>`LOWER(${matchesTable.league})`.as("league"),
              country: sql<string>`LOWER(COALESCE(${matchesTable.country}, ''))`.as("country"),
            })
            .from(matchesTable)
            .where(inArray(matchesTable.id, matchIds));
          for (const r of matchRows) {
            matchMeta.set(Number(r.id), { league: r.league ?? "", country: r.country ?? "" });
          }
        }

        const before = selectedBets.length;
        const rejectionDetails: Array<{ matchId: number; league: string; country: string; market: string; selection: string }> = [];
        const kept: BetCandidate[] = [];
        for (const c of selectedBets) {
          const meta = matchMeta.get(c.matchId);
          const league = meta?.league ?? "";
          const country = meta?.country ?? "";
          // Strict country match when matches.country is populated; fall back to name-only otherwise.
          const inPinLeague = country
            ? (pinKey.has(`${league}|${country}`) || (pinName.has(league) && country === ""))
            : pinName.has(league);
          if (!inPinLeague) {
            rejectionDetails.push({
              matchId: c.matchId,
              league: league || "(unknown)",
              country: country || "(unknown)",
              market: c.marketType,
              selection: c.selectionName,
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
              pinLeaguesLoaded: pinName.size,
              sampleRejections: rejectionDetails.slice(0, 25),
              totalRejections: rejectionDetails.length,
              scope: "v3_section6_step1_audit",
            },
            "Pinnacle-league selection filter rejected non-Pinnacle-league candidates",
          );
        } else {
          logger.info(
            { tier, kept: selectedBets.length, pinLeaguesLoaded: pinName.size },
            "Pinnacle-league filter: all candidates in Pinnacle leagues",
          );
        }
        funnel["07a_rejected_non_pinnacle_league"] = rejected;
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
    }

    const betOrders: BetOrder[] = [];

    for (const candidate of selectedBets) {
      const extra = candidate as BetCandidate & Record<string, unknown>;
      const validation = extra._validation as Awaited<ReturnType<typeof getOddspapiValidation>> | null;
      const isContrarian = (extra._isContrarian as boolean | undefined) ?? false;
      const backOdds = (extra._backOdds as number | undefined) ?? candidate.backOdds;
      const effectiveScore = (extra._effectiveScore as number | undefined) ?? candidate.opportunityScore;
      const thesis = (extra._thesis as string | undefined) ?? undefined;

      let filterPassed = true;
      let filterEdgeCategory: string | null = null;
      let filterLineDirection: string | null = null;
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
        });

        filterEdgeCategory = filterResult.edgeCategory !== "filtered" ? filterResult.edgeCategory : null;
        filterLineDirection = filterResult.lineDirection !== "unknown" ? filterResult.lineDirection : null;

        if (!filterResult.passed) {
          logger.info(
            {
              matchId: candidate.matchId,
              market: candidate.marketType,
              selection: candidate.selectionName,
              edgePct: filterResult.edgePct.toFixed(2),
              reason: filterResult.filterReason,
              lineDirection: filterResult.lineDirection,
            },
            "Bet filtered out by Pinnacle pre-bet filter",
          );
          filterPassed = false;
        }
      } catch (filterErr) {
        logger.error({ err: filterErr, matchId: candidate.matchId }, "Pinnacle pre-bet filter error — allowing bet through");
      }

      if (!filterPassed) continue;

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
      });
    }

    funnel["08_post_pinnacle_filter"] = betOrders.length;
    funnel["08b_pinnacle_filtered_out"] = selectedBets.length - betOrders.length;

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
    cron.schedule("*/30 * * * *", () => {
      logger.info("Betfair settlement reconciliation triggered");
      void reconcileSettlements().catch((err) =>
        logger.warn({ err }, "Betfair reconciliation failed — non-fatal"),
      );
    }, { timezone: "UTC" });
    logger.info("Betfair settlement reconciliation active — every 30 minutes");

    cron.schedule("*/15 * * * *", () => {
      void getAccountFunds().catch((err) =>
        logger.warn({ err }, "Betfair balance refresh failed — non-fatal"),
      );
    }, { timezone: "UTC" });
    logger.info("Betfair balance refresh active — every 15 minutes");
  }
}

// ===================== Scheduler =====================

export function startScheduler(): void {
  logger.info("Starting schedulers");

  // Data ingestion: every 30 min, 24/7 (matches scheduled globally at all hours)
  cron.schedule("*/30 * * * *", () => { void safeRunIngestion(); }, { timezone: "UTC" });
  logger.info("Ingestion scheduler active — every 30 min, 24/7");

  // Exchange book sweep: every 10 minutes, populates odds_snapshots with
  // source='betfair_exchange' for the venue-anchored pricing picker. Runs
  // unconditionally, independent of data_source config flag.
  cron.schedule("*/10 * * * *", () => { void safeRunExchangeBookSweep(); }, { timezone: "UTC" });
  logger.info("Exchange book sweep scheduler active — every 10 minutes (24h NEAR window)");

  // Startup warmup: run one sweep ~30s after boot so the first population
  // doesn't have to wait the full 10-minute cron interval.
  setTimeout(() => {
    logger.info("Exchange book sweep startup warmup triggered (T+30s)");
    void safeRunExchangeBookSweep();
  }, 30_000);

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
  cron.schedule("20 */6 * * *", () => {
    logger.info("Betfair event mapping triggered by scheduler");
    void trackCronExecution("betfair_event_map", async () => {
      const { mapBetfairEventsToFixtures } = await import("./betfairEventMapping");
      const stats = await mapBetfairEventsToFixtures(72);
      logger.info(stats, "Betfair event mapping stats");
      return stats.fixturesUpdated;
    }).catch((err) => logger.error({ err }, "Betfair event mapping failed"));
  }, { timezone: "UTC" });
  logger.info("Betfair event mapping scheduler active — every 6 hours UTC");

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

  // OddsPapi bulk prefetch: every 2 hours (was 4h — increased to lift Pinnacle
  // coverage on newly-mapped fixtures; per-run cap stays at 1000 and the
  // daily cap of 5000 is enforced by getEffectiveDailyCap, so we cannot
  // exceed budget. In practice cache reuse means runs after the first stay
  // small.)
  cron.schedule("10 */2 * * *", () => {
    logger.info("OddsPapi bulk prefetch triggered (7-day window, 1000 req max)");
    void runDedicatedBulkPrefetch(7, 1000)
      .then(async (r) => {
        logger.info(r, "OddsPapi bulk prefetch complete");
        const dc = await derivePinnacleDCFromMatchOdds();
        logger.info(dc, "Post-prefetch DC derivation complete");
        const unified = await backfillPinnacleUnified();
        logger.info({ unified }, "Post-prefetch unified Pinnacle backfill complete");
      })
      .catch((err) => logger.error({ err }, "OddsPapi bulk prefetch pipeline failed"));
  }, { timezone: "UTC" });
  logger.info("OddsPapi bulk prefetch scheduler active — every 2 hours UTC (1000 req max, 5000 daily cap enforced)");

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

  setTimeout(async () => {
    try {
      logger.info("Startup: running OddsPapi fixture mapping + bulk prefetch + API-Football odds refresh before trading cycle");
      await safeRunOddspapiMapping();
      const [afResult, opResult] = await Promise.all([
        fetchAndStoreOddsForAllUpcoming().then((r) => {
          logger.info(r, "Startup API-Football odds refresh complete");
          return r;
        }),
        runDedicatedBulkPrefetch(7, 1000).then(async (r) => {
          logger.info(r, "Startup OddsPapi bulk prefetch complete");
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
    logger.info("Startup near trading cycle triggered (post-restart warmup)");
    void runTradingCycle({ tier: "near", minHoursAhead: 1, maxHoursAhead: 48 })
      .then((result) => {
        logger.info(result, "Startup near trading cycle complete");
      })
      .catch((err) => {
        logger.warn({ err }, "Startup warmup failed — non-fatal, cron will retry");
      });
  }, 30 * 1000);
  logger.info("Startup warmup scheduled — OddsPapi mapping + bulk prefetch + odds refresh + trading cycle in 30s");

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
  if (featureRunning) {
    logger.warn("Feature computation already in progress");
    return { processed: 0, skipped: 0, failed: 0 };
  }
  featureRunning = true;
  try {
    return await runFeatureEngineForUpcomingMatches();
  } finally {
    featureRunning = false;
  }
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
