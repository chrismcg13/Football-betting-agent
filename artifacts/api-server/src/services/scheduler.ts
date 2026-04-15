import cron from "node-cron";
import { logger } from "../lib/logger";
import { runDataIngestion } from "./dataIngestion";
import { runFeatureEngineForUpcomingMatches } from "./featureEngine";
import { detectValueBets } from "./valueDetection";
import { placePaperBet, settleBets, getAgentStatus, getBankroll, deduplicatePendingBets, backfillCornersCardsStats } from "./paperTrading";
import { runAllRiskChecks } from "./riskManager";
import { getModelVersion } from "./predictionEngine";
import { runLearningLoop } from "./learningLoop";
import {
  fetchAndStoreOddsForAllUpcoming,
  fetchTeamStatsForUpcomingMatches,
  ingestFixturesForDiscoveredLeagues,
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
} from "./oddsPapi";
import { applyCorrelationDetection, type BetCandidate } from "./correlationDetector";
import { fetchRecentFixtureResults, teamNameMatch, fetchMatchStatsForSettlement } from "./apiFootball";
import { runLeagueDiscovery, seedBaselineLeagues, updatePinnacleOddsFromActualMappings, seedCompetitionConfig } from "./leagueDiscovery";
import { db, pool, agentConfigTable, leagueEdgeScoresTable, paperBetsTable, matchesTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { runPromotionEngine } from "./promotionEngine";
import { runWeeklyExperimentAnalysis } from "./experimentAnalysis";
import { syncDevToProd } from "./syncDevToProd";
import { reconcileSettlements, isLiveMode, getAccountFunds } from "./betfairLive";

// ===================== Status tracking =====================

export interface JobStatus {
  lastRunAt: Date | null;
  lastRunResult: "success" | "error" | "skipped" | null;
  isRunning: boolean;
  runCount: number;
}

const jobStatus: Record<string, JobStatus> = {
  ingestion:       { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  features:        { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  trading:         { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  learning:        { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
  oddspapi_map:    { lastRunAt: null, lastRunResult: null, isRunning: false, runCount: 0 },
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

// ===================== Guard flags =====================
let ingestionRunning = false;
let featureRunning = false;
let tradingCycleRunning = false;

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
    await runDataIngestion();
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
    await runFeatureEngineForUpcomingMatches();
    markRun("features", "success");
  } catch (err) {
    logger.error({ err }, "Scheduled feature computation run failed");
    markRun("features", "error");
  } finally {
    featureRunning = false;
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

export async function runTradingCycle(): Promise<{
  betsPlaced: number;
  betsSettled: number;
  riskTriggered: boolean;
}> {
  if (tradingCycleRunning) {
    logger.warn("Trading cycle already in progress — skipping this run");
    markRun("trading", "skipped");
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false };
  }

  const lockAcquired = await tryAdvisoryLock(TRADING_LOCK_ID);
  if (!lockAcquired) {
    logger.warn("Trading cycle locked by another instance — skipping");
    markRun("trading", "skipped");
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false };
  }

  tradingCycleRunning = true;
  markStart("trading");

  try {
    logger.info("Starting trading cycle");

    // 1. Settle any finished bets first
    const settlement = await settleBets();
    logger.info(
      { settled: settlement.settled, won: settlement.won, lost: settlement.lost, pnl: settlement.totalPnl },
      "Settlement complete",
    );

    // 2. Run risk checks
    const riskResult = await runAllRiskChecks();
    if (riskResult.anyTriggered) {
      logger.warn("Risk check triggered — skipping bet placement this cycle");
      markRun("trading", "success");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: true };
    }

    // 3. Check agent is running
    const agentStatus = await getAgentStatus();
    if (agentStatus !== "running") {
      logger.info({ agentStatus }, "Agent not running — skipping bet placement");
      markRun("trading", "skipped");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    // 4. Check model is available
    const modelVersion = getModelVersion();
    if (!modelVersion) {
      logger.info("No model loaded — skipping value detection");
      markRun("trading", "skipped");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    // 5. Detect value bets for matches kicking off in 1h–168h (full week)
    const now = new Date();
    const earliest = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    const latest   = new Date(now.getTime() + 168 * 60 * 60 * 1000);

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
    logger.info(
      {
        oddsPapiMatches: oddsPapiCacheRaw.size,
        afPinnacleMatches: afPinnacleCache.size,
        mergedTotal: oddsPapiCache.size,
        totalSelections: [...oddsPapiCache.values()].reduce((n, m) => n + Object.keys(m).length, 0),
      },
      "Pinnacle validation cache ready (OddsPapi + API-Football Pinnacle merged, selection-level)",
    );

    const valueSummary = await detectValueBets();
    const timely = valueSummary.valueBets.filter(
      (b) => new Date(b.kickoffTime) >= earliest && new Date(b.kickoffTime) <= latest,
    );

    logger.info(
      {
        totalValueBets: valueSummary.valueBets.length,
        timelyBets: timely.length,
        realOdds: valueSummary.realOddsCount,
        syntheticOdds: valueSummary.syntheticOddsCount,
        byMarketType: valueSummary.byMarketType,
        window: "1h-168h before kickoff",
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
    // Budget is now 150/day (5,000/month) — enough to cover every candidate.
    // No top-N slice, no second-division filter, no 48h restriction.

    type OddsValidation = Awaited<ReturnType<typeof getOddspapiValidation>>;

    // Validate all candidates. Cache hits (from scheduled bulk prefetch) are free.
    // Only cache misses trigger on-demand API calls, capped at 20/cycle to stay
    // within our daily budget. Bulk prefetch crons (6am/12pm) cover the rest.
    const MAX_ONDEMAND_PER_CYCLE = 20;
    const enhancedCandidates: Array<{ bet: typeof rankedForOddsPapi[number]; validation: OddsValidation | null; effectiveScore: number }> = [];
    let apiCallsThisCycle = 0;

    for (const bet of rankedForOddsPapi) {
      try {
        let validation: OddsValidation | null = null;

        const cachedMatch = oddsPapiCache.get(bet.matchId);
        if (cachedMatch) {
          // Cache is flat: selectionName → validation (covers all market types)
          const raw = cachedMatch[bet.selectionName];
          if (raw) {
            // Compute pinnacleAligned from cached Pinnacle implied probability vs model
            let pinnacleAligned = false;
            let isContrarian = false;
            if (raw.pinnacleImplied !== null) {
              const diff = bet.modelProbability - raw.pinnacleImplied;
              if (diff < 0) {
                // Pinnacle more bullish than model — sharp money backs our selection
                pinnacleAligned = true;
              } else if (Math.abs(diff) <= 0.03) {
                // Within 3% — effectively aligned
                pinnacleAligned = true;
              } else if (diff > 0.08) {
                // Model significantly above Pinnacle — contrarian
                isContrarian = true;
              }
            }
            validation = { ...raw, pinnacleAligned, isContrarian };
          }
        }

        if (!validation && apiCallsThisCycle < MAX_ONDEMAND_PER_CYCLE) {
          const oddspapiId = await getOddspapiFixtureId(bet.matchId);
          if (oddspapiId) {
            // Rate-limit guard: 1.2s between API calls to avoid 429s
            if (apiCallsThisCycle > 0) await new Promise((r) => setTimeout(r, 1200));
            validation = await getOddspapiValidation(
              oddspapiId,
              bet.marketType,
              bet.selectionName,
              bet.backOdds,
            );
            apiCallsThisCycle++;
          }
        }

        // Pinnacle scoring (enhanced):
        // +10 if Pinnacle-aligned (sharp money agrees with our model)
        // -10 if contrarian (Pinnacle strongly disagrees — higher risk)
        // No flat bonus for just having Pinnacle data — focus on alignment quality
        let effectiveScore = bet.opportunityScore;
        if (validation?.hasPinnacleData) {
          if (validation.pinnacleAligned) effectiveScore += 10;
          else if (validation.isContrarian) effectiveScore -= 10;
        }

        logger.info(
          {
            match: `${bet.homeTeam} vs ${bet.awayTeam}`,
            market: bet.marketType,
            selection: bet.selectionName,
            baseScore: bet.opportunityScore,
            effectiveScore,
            hasPinnacleData: validation?.hasPinnacleData ?? false,
            pinnacleAligned: validation?.pinnacleAligned ?? false,
            isContrarian: validation?.isContrarian ?? false,
            fromCache: !!oddsPapiCache.get(bet.matchId),
          },
          "OddsPapi validation scoring",
        );

        enhancedCandidates.push({ bet, validation: validation ?? null, effectiveScore });
      } catch (err) {
        logger.warn({ err, matchId: bet.matchId }, "OddsPapi validation failed — using base score");
        enhancedCandidates.push({ bet, validation: null, effectiveScore: bet.opportunityScore });
      }
    }

    // 7. Build final candidate list with effective scores
    type BetEntry = {
      bet: typeof timely[number];
      effectiveScore: number;
      validation: OddsValidation | null;
    };

    // All candidates are now enhanced (Pinnacle-validated or cache-hit).
    // Sort by effective score so the best opportunities are placed first.
    const allEntries: BetEntry[] = enhancedCandidates
      .map(({ bet, validation, effectiveScore }) => ({
        bet,
        effectiveScore,
        validation: validation ?? null,
      }))
      .sort((a, b) => b.effectiveScore - a.effectiveScore);

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

    // 8. Load config + diversity limits
    const configRows = await db.select().from(agentConfigTable);
    const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));
    const paperMode = cfg.paper_mode === "true";

    // Fix 3: Daily bet cap — top N by opportunity score, quality over quantity
    const maxDailyBets = paperMode
      ? Number(cfg.max_daily_bets_paper ?? "50")
      : Number(cfg.max_daily_bets_live ?? "15");

    const todayBetRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(paperBetsTable)
      .where(sql`date_trunc('day', ${paperBetsTable.placedAt} AT TIME ZONE 'UTC') = current_date AND status != 'void'`);
    const todayCount = Number(todayBetRows[0]?.count ?? 0);
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
    const minScore = Number(cfg.min_opportunity_score ?? "58");
    const contrarinaThreshold = 75; // contrarian bets need higher bar

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
      .where(eq(paperBetsTable.status, "pending"));
    const pendingKeys = new Set(existingPending.map((b) => `${b.matchId}|${b.marketType}|${b.selectionName}`));

    for (const entry of allEntries) {
      if (preCorrelation.length >= maxPerCycle) break;

      const { bet, effectiveScore, validation } = entry;

      // Skip if we already have a pending bet on this match+market+selection
      const dupKey = `${bet.matchId}|${bet.marketType}|${bet.selectionName}`;
      if (pendingKeys.has(dupKey)) {
        logger.debug({ matchId: bet.matchId, market: bet.marketType, selection: bet.selectionName }, "Skipping duplicate — pending bet already exists");
        continue;
      }

      const isContrarian = validation?.isContrarian ?? false;
      const scoreThreshold = isContrarian ? contrarinaThreshold : minScore;

      if (effectiveScore < scoreThreshold) {
        logger.debug(
          { matchId: bet.matchId, score: effectiveScore, threshold: scoreThreshold, isContrarian },
          "Skipping bet — below effective score threshold",
        );
        continue;
      }

      const leagueCount = leagueCounts[bet.league] ?? 0;
      if (leagueCount >= maxPerLeague) continue;

      const marketCount = marketCounts[bet.marketType] ?? 0;
      if (marketCount >= maxPerMarket) continue;

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
          (isContrarian ? "CONTRARIAN — stake reduced 60%." : pinnacleAligned ? "Pinnacle-aligned." : "") +
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
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    // 10. Correlation detection
    const { selectedBets } = await applyCorrelationDetection(preCorrelation, bankroll);

    // 11. Place the final bets
    let betsPlaced = 0;
    for (const candidate of selectedBets) {
      const extra = candidate as BetCandidate & Record<string, unknown>;
      const validation = extra._validation as Awaited<ReturnType<typeof getOddspapiValidation>> | null;
      const isContrarian = (extra._isContrarian as boolean | undefined) ?? false;
      const backOdds = (extra._backOdds as number | undefined) ?? candidate.backOdds;
      const effectiveScore = (extra._effectiveScore as number | undefined) ?? candidate.opportunityScore;
      const thesis = (extra._thesis as string | undefined) ?? undefined;

      const result = await placePaperBet(
        candidate.matchId,
        candidate.marketType,
        candidate.selectionName,
        backOdds,
        candidate.modelProbability,
        candidate.edge,
        {
          modelVersion: modelVersion ?? undefined,
          opportunityScore: effectiveScore,
          oddsSource: candidate.oddsSource,
          enhancedOpportunityScore: validation?.hasPinnacleData ? effectiveScore : null,
          pinnacleOdds: validation?.pinnacleOdds ?? null,
          pinnacleImplied: validation?.pinnacleImplied ?? null,
          bestOdds: validation?.bestOdds ?? backOdds,
          bestBookmaker: validation?.bestBookmaker ?? null,
          betThesis: thesis,
          isContrarian,
          stakeMultiplier: candidate.stakeMultiplier,
          experimentTag: candidate.experimentTag,
          dataTier: candidate.dataTier,
          opportunityBoosted: candidate.opportunityBoosted,
          originalOpportunityScore: candidate.originalOpportunityScore,
          boostedOpportunityScore: candidate.boostedOpportunityScore,
          syncEligible: candidate.syncEligible,
        },
      );

      if (result.placed) {
        betsPlaced++;
        logger.info(
          {
            matchId: candidate.matchId,
            homeTeam: candidate.homeTeam,
            awayTeam: candidate.awayTeam,
            marketType: candidate.marketType,
            selectionName: candidate.selectionName,
            backOdds: backOdds.toFixed(2),
            edge: candidate.edge.toFixed(4),
            stake: result.stake,
            oddsSource: candidate.oddsSource,
            opportunityScore: effectiveScore,
            enhanced: candidate.enhanced,
            pinnacleAligned: validation?.pinnacleAligned ?? false,
            isContrarian,
            stakeMultiplier: candidate.stakeMultiplier,
          },
          "Automated bet placed",
        );
      }
    }

    logger.info({ betsPlaced, betsSettled: settlement.settled }, "Trading cycle complete");
    markRun("trading", "success");
    return { betsPlaced, betsSettled: settlement.settled, riskTriggered: false };
  } catch (err) {
    logger.error({ err }, "Trading cycle failed");
    markRun("trading", "error");
    return { betsPlaced: 0, betsSettled: 0, riskTriggered: false };
  } finally {
    tradingCycleRunning = false;
    await releaseAdvisoryLock(TRADING_LOCK_ID);
  }
}

// ===================== Sync match results from football-data.org =====================

export async function syncMatchResults(daysBack = 2): Promise<number> {
  let recentFixtures: Awaited<ReturnType<typeof fetchRecentFixtureResults>>;
  try {
    recentFixtures = await fetchRecentFixtureResults(daysBack);
  } catch (err) {
    logger.warn({ err }, "syncMatchResults: failed to fetch recent fixtures");
    return 0;
  }

  if (recentFixtures.length === 0) {
    logger.info("syncMatchResults: API-Football returned 0 finished fixtures");
    return 0;
  }

  const scheduledMatches = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        sql`${matchesTable.kickoffTime} < NOW()`,
      ),
    );

  if (scheduledMatches.length === 0) {
    logger.info("syncMatchResults: no scheduled past matches to update");
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
    if (r.settled > 0) logger.info(r, "Settlement pipeline: bets settled");

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

  // Feature computation: every 6 hours
  cron.schedule("0 */6 * * *", () => { void safeRunFeatures(); }, { timezone: "UTC" });
  logger.info("Feature scheduler active — every 6 hours UTC");

  // Trading cycle: every 10 minutes (increased frequency for paper data collection)
  // Runs deduplication after each cycle to catch any cross-cycle duplicates.
  cron.schedule("*/10 * * * *", () => {
    void runTradingCycle().then(() => deduplicatePendingBets()).catch((err) => {
      logger.warn({ err }, "Post-trading-cycle dedup failed — non-fatal");
    });
  }, { timezone: "UTC" });
  logger.info("Trading cycle scheduler active — every 10 minutes (with post-cycle dedup)");

  // API-Football: fetch real odds every 2 hours — fresh odds for every trading cycle
  // With 75,000 req/day budget, each scan uses ~30-50 reqs, plenty of headroom
  cron.schedule("0 */2 * * *", () => {
    logger.info("API-Football odds refresh triggered by scheduler");
    void fetchAndStoreOddsForAllUpcoming().catch((err) => {
      logger.error({ err }, "API-Football odds refresh failed");
    });
  }, { timezone: "UTC" });
  logger.info("API-Football odds scheduler active — every 2 hours UTC");

  // API-Football: fetch team stats every 12 hours (~20 req)
  cron.schedule("0 */12 * * *", () => {
    logger.info("API-Football team stats refresh triggered by scheduler");
    void fetchTeamStatsForUpcomingMatches().catch((err) => {
      logger.error({ err }, "API-Football team stats refresh failed");
    });
  }, { timezone: "UTC" });
  logger.info("API-Football team stats scheduler active — every 12 hours UTC");

  // OddsPapi fixture mapping: daily at 06:05 UTC (5 min after ingestion starts)
  cron.schedule("5 6 * * *", () => {
    logger.info("OddsPapi fixture mapping triggered by scheduler");
    void safeRunOddspapiMapping();
  }, { timezone: "UTC" });
  logger.info("OddsPapi fixture mapping scheduler active — daily at 06:05 UTC");

  // OddsPapi morning bulk prefetch: daily at 06:10 UTC
  // Fetches 7 days of Pinnacle odds for all mapped fixtures (≤ 80 API calls).
  // This is the main budget allocation — populates the DB snapshot cache for the day.
  cron.schedule("10 6 * * *", () => {
    logger.info("Morning OddsPapi bulk prefetch triggered (7-day window, 80 req max)");
    void runDedicatedBulkPrefetch(7, 80)
      .then((r) => logger.info(r, "Morning OddsPapi bulk prefetch complete"))
      .catch((err) => logger.error({ err }, "Morning OddsPapi bulk prefetch failed"));
  }, { timezone: "UTC" });
  logger.info("Morning OddsPapi bulk prefetch scheduler active — daily at 06:10 UTC (80 req max)");

  // OddsPapi midday refresh: daily at 12:00 UTC
  // Refreshes odds for fixtures kicking off in the next 48h (live line movement).
  // Capped at 30 requests to stay well within daily budget.
  cron.schedule("0 12 * * *", () => {
    logger.info("Midday OddsPapi refresh triggered (2-day window, 30 req max)");
    void runDedicatedBulkPrefetch(2, 30)
      .then((r) => logger.info(r, "Midday OddsPapi refresh complete"))
      .catch((err) => logger.warn({ err }, "Midday OddsPapi refresh failed — non-fatal"));
  }, { timezone: "UTC" });
  logger.info("Midday OddsPapi refresh scheduler active — daily at 12:00 UTC (30 req max)");

  // OddsPapi budget summary: daily at 00:01 UTC
  cron.schedule("1 0 * * *", () => {
    logger.info("OddsPapi daily budget summary triggered");
    void logDailyBudgetSummary().catch((err) => {
      logger.error({ err }, "OddsPapi budget summary failed");
    });
  }, { timezone: "UTC" });
  logger.info("OddsPapi budget summary scheduler active — daily at 00:01 UTC");

  // Pre-kickoff CLV cron: every 30 minutes
  // For any pending bet kicking off in the next 90 min, fetch Pinnacle closing odds
  // and store as closing_pinnacle_odds → enables professional-grade CLV calculation
  cron.schedule("*/30 * * * *", () => {
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
  logger.info("Pre-kickoff CLV cron active — every 30 minutes (Pinnacle closing line)");

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

  cron.schedule("0 4 * * 0", () => {
    logger.info("Weekly experiment self-analysis triggered (Sunday 04:00 UTC)");
    void runWeeklyExperimentAnalysis().catch((err) => {
      logger.error({ err }, "Weekly experiment analysis failed");
    });
  }, { timezone: "UTC" });
  logger.info("Weekly experiment analysis scheduler active — Sunday 04:00 UTC");

  cron.schedule("0 */6 * * *", () => {
    logger.info("Dev→Prod sync triggered (every 6 hours)");
    void syncDevToProd().catch((err) => {
      logger.error({ err }, "Dev→Prod sync failed");
    });
  }, { timezone: "UTC" });
  logger.info("Dev→Prod sync scheduler active — every 6 hours");

  // Startup trading cycle: fire 3 minutes after server start so any restart
  // doesn't leave the cycle dormant for up to 15 minutes.
  // Also refresh odds first so the cycle has fresh market data.
  setTimeout(() => {
    logger.info("Startup odds refresh triggered (post-restart warmup)");
    void fetchAndStoreOddsForAllUpcoming()
      .then(() => {
        logger.info("Startup odds refresh complete — running trading cycle");
        return runTradingCycle();
      })
      .then((result) => {
        logger.info(result, "Startup trading cycle complete");
      })
      .catch((err) => {
        logger.warn({ err }, "Startup warmup sequence failed — non-fatal, cron will retry");
      });
  }, 3 * 60 * 1000); // 3 minutes after start
  logger.info("Startup warmup scheduled — odds refresh + trading cycle in 3 min");

  // Seed baseline leagues + competition config at startup (idempotent — uses onConflictDoNothing)
  void seedBaselineLeagues().catch((err) => logger.warn({ err }, "Baseline league seed failed — non-fatal"));
  void seedCompetitionConfig().catch((err) => logger.warn({ err }, "Competition config seed failed — non-fatal"));
}

// ===================== Manual triggers (for API routes) =====================

export async function runSettlementNow(): Promise<{ synced: number; settled: Awaited<ReturnType<typeof settleBets>>; backfill: { matchesUpdated: number; betsResettled: number } }> {
  if (settlementRunning) {
    logger.info("Manual settlement skipped — pipeline already running");
    return { synced: 0, settled: { settled: 0, won: 0, lost: 0, totalPnl: 0 }, backfill: { matchesUpdated: 0, betsResettled: 0 } };
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
