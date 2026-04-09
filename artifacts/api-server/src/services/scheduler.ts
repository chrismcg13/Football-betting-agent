import cron from "node-cron";
import { logger } from "../lib/logger";
import { runDataIngestion } from "./dataIngestion";
import { runFeatureEngineForUpcomingMatches } from "./featureEngine";
import { detectValueBets } from "./valueDetection";
import { computeEnhancedOpportunityScore } from "./valueDetection";
import { placePaperBet, settleBets, getAgentStatus, getBankroll } from "./paperTrading";
import { runAllRiskChecks } from "./riskManager";
import { getModelVersion } from "./predictionEngine";
import { runLearningLoop } from "./learningLoop";
import {
  fetchAndStoreOddsForAllUpcoming,
  fetchTeamStatsForUpcomingMatches,
} from "./apiFootball";
import {
  runOddspapiFixtureMapping,
  getOddspapiFixtureId,
  getOddspapiValidation,
  prefetchAndStoreOddsPapiOdds,
  type OddsPapiValidationCache,
  logDailyBudgetSummary,
} from "./oddsPapi";
import { applyCorrelationDetection, type BetCandidate } from "./correlationDetector";
import { db, agentConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

    // 5. Detect value bets for matches kicking off in 1h–96h
    const now = new Date();
    const earliest = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    const latest   = new Date(now.getTime() + 96 * 60 * 60 * 1000);

    // 5a. Pre-fetch OddsPapi Match Odds for mapped matches into odds_snapshots
    //     so value detection treats those as real (not synthetic) odds
    const oddsPapiCache: OddsPapiValidationCache = await prefetchAndStoreOddsPapiOdds(earliest, latest, 12);
    logger.info({ matchesPrefetched: oddsPapiCache.size }, "OddsPapi pre-fetch done — running value detection");

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
        window: "1h-96h before kickoff",
      },
      "Value detection complete for trading cycle",
    );

    if (timely.length === 0) {
      markRun("trading", "success");
      return { betsPlaced: 0, betsSettled: settlement.settled, riskTriggered: false };
    }

    // 6. OddsPapi enhancement for top 5 candidates
    // Score-sort the timely bets and enrich the top 5 with Pinnacle validation
    const sorted = [...timely].sort((a, b) => b.opportunityScore - a.opportunityScore);
    const top5 = sorted.slice(0, 5);
    const rest = sorted.slice(5);

    const enhancedCandidates = await Promise.all(
      top5.map(async (bet) => {
        try {
          // Check pre-fetch cache first (zero budget cost); fall back to live call for non-MATCH_ODDS
          let validation: Awaited<ReturnType<typeof getOddspapiValidation>> | null = null;

          const cachedMatch = oddsPapiCache.get(bet.matchId);
          if (cachedMatch) {
            const sel = bet.selectionName as keyof typeof cachedMatch;
            if (cachedMatch[sel]) {
              validation = { ...cachedMatch[sel], isContrarian: false, pinnacleAligned: false };
            }
          }

          if (!validation) {
            const oddspapiId = await getOddspapiFixtureId(bet.matchId);
            if (!oddspapiId) return { bet, validation: null, enhancedScore: null };

            validation = await getOddspapiValidation(
              oddspapiId,
              bet.marketType,
              bet.selectionName,
              bet.backOdds,
            );
          }

          // Only enhance when Pinnacle data is available — no-data runs reduce score by ~10 pts
          if (!validation.hasPinnacleData) {
            logger.info(
              {
                match: `${bet.homeTeam} vs ${bet.awayTeam}`,
                market: bet.marketType,
                selection: bet.selectionName,
                baseScore: bet.opportunityScore,
                reason: "no Pinnacle data — keeping base score",
              },
              "OddsPapi: skipping enhancement (no data)",
            );
            return { bet, validation, enhancedScore: null };
          }

          const enhanced = computeEnhancedOpportunityScore({
            edge: bet.edge,
            modelProbability: bet.modelProbability,
            backOdds: validation.bestOdds ?? bet.backOdds,
            segmentBetCount: bet.segmentBetCount,
            segmentRoi: bet.segmentRoi,
            hotStreakBonus: bet.hotStreakBonus,
            pinnacleImplied: validation.pinnacleImplied,
            sharpSoftSpread: validation.sharpSoftSpread,
            oddsUpliftPct: validation.oddsUpliftPct,
          });

          logger.info(
            {
              match: `${bet.homeTeam} vs ${bet.awayTeam}`,
              market: bet.marketType,
              selection: bet.selectionName,
              baseScore: bet.opportunityScore,
              enhancedScore: enhanced.score,
              pinnacleAligned: enhanced.pinnacleAligned,
              isContrarian: enhanced.isContrarian,
              hasPinnacleData: validation.hasPinnacleData,
            },
            "OddsPapi enhanced scoring",
          );

          return { bet, validation, enhancedScore: enhanced };
        } catch (err) {
          logger.warn({ err, matchId: bet.matchId }, "OddsPapi enhancement failed for bet — using base score");
          return { bet, validation: null, enhancedScore: null };
        }
      }),
    );

    // 7. Build final candidate list with effective scores
    type BetEntry = {
      bet: typeof timely[number];
      effectiveScore: number;
      enhancedScore: ReturnType<typeof computeEnhancedOpportunityScore> | null;
      validation: Awaited<ReturnType<typeof getOddspapiValidation>> | null;
    };

    const allEntries: BetEntry[] = [
      ...enhancedCandidates.map(({ bet, validation, enhancedScore }) => ({
        bet,
        effectiveScore: enhancedScore?.score ?? bet.opportunityScore,
        enhancedScore: enhancedScore ?? null,
        validation: validation ?? null,
      })),
      ...rest.map((bet) => ({
        bet,
        effectiveScore: bet.opportunityScore,
        enhancedScore: null as ReturnType<typeof computeEnhancedOpportunityScore> | null,
        validation: null as Awaited<ReturnType<typeof getOddspapiValidation>> | null,
      })),
    ].sort((a, b) => b.effectiveScore - a.effectiveScore);

    // 8. Load config + diversity limits
    const configRows = await db.select().from(agentConfigTable);
    const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));
    const maxPerCycle = Number(cfg.max_bets_per_cycle ?? "5");
    const maxPerLeague = Number(cfg.max_bets_per_market ?? "2"); // using market key as proxy
    const maxPerMarket = Number(cfg.max_bets_per_market ?? "2");
    const minScore = Number(cfg.min_opportunity_score ?? "65");
    const contrarinaThreshold = 75; // contrarian bets need higher bar

    // 9. Apply diversity rules
    const leagueCounts: Record<string, number> = {};
    const marketCounts: Record<string, number> = {};
    const preCorrelation: BetCandidate[] = [];
    const bankroll = await getBankroll();

    for (const entry of allEntries) {
      if (preCorrelation.length >= maxPerCycle) break;

      const { bet, effectiveScore, enhancedScore, validation } = entry;
      const isContrarian = enhancedScore?.isContrarian ?? false;
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
      const thesis = validation?.hasPinnacleData
        ? `Backing ${bet.selectionName} at ${backOdds.toFixed(2)} from ${validation.bestBookmaker ?? "best available"}. ` +
          `Model: ${(bet.modelProbability * 100).toFixed(1)}%, Pinnacle implies: ${((validation.pinnacleImplied ?? 0) * 100).toFixed(1)}%. ` +
          `Edge: ${(bet.edge * 100).toFixed(1)}% using best available price. ` +
          (validation.sharpSoftSpread ? `Sharp-soft spread: ${(validation.sharpSoftSpread * 100).toFixed(1)}%. ` : "") +
          (isContrarian ? "CONTRARIAN — stake reduced 60%." : enhancedScore?.pinnacleAligned ? "Pinnacle-aligned." : "")
        : `Backing ${bet.selectionName} at ${bet.backOdds.toFixed(2)}. Model: ${(bet.modelProbability * 100).toFixed(1)}%, Edge: ${(bet.edge * 100).toFixed(1)}%.`;

      // Estimate Kelly stake for correlation check
      const kellyFraction = Math.min(0.02 * (effectiveScore / 65), 0.05);
      const estimatedStake = Math.round(bankroll * kellyFraction * 100) / 100;

      preCorrelation.push({
        ...bet,
        stakeMultiplier: 1.0,
        estimatedStake,
        enhanced: !!enhancedScore,
        // Store extra data for placement
        _validation: validation,
        _enhancedScore: enhancedScore,
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
      const enhancedScore = extra._enhancedScore as ReturnType<typeof computeEnhancedOpportunityScore> | null;
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
          enhancedOpportunityScore: enhancedScore?.score ?? null,
          pinnacleOdds: validation?.pinnacleOdds ?? null,
          pinnacleImplied: validation?.pinnacleImplied ?? null,
          bestOdds: validation?.bestOdds ?? null,
          bestBookmaker: validation?.bestBookmaker ?? null,
          betThesis: thesis,
          isContrarian,
          stakeMultiplier: candidate.stakeMultiplier,
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
            pinnacleAligned: enhancedScore?.pinnacleAligned,
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
  }
}

// ===================== Scheduler =====================

export function startScheduler(): void {
  logger.info("Starting schedulers");

  // Data ingestion: every 30 min, 06:00–23:30 UTC
  cron.schedule("*/30 6-23 * * *", () => { void safeRunIngestion(); }, { timezone: "UTC" });
  logger.info("Ingestion scheduler active — every 30 min, 06:00–23:30 UTC");

  // Feature computation: every 6 hours
  cron.schedule("0 */6 * * *", () => { void safeRunFeatures(); }, { timezone: "UTC" });
  logger.info("Feature scheduler active — every 6 hours UTC");

  // Trading cycle: every 15 minutes
  cron.schedule("*/15 * * * *", () => { void runTradingCycle(); }, { timezone: "UTC" });
  logger.info("Trading cycle scheduler active — every 15 minutes");

  // API-Football: fetch real odds every 8 hours (biggest budget item ~30 req)
  cron.schedule("0 */8 * * *", () => {
    logger.info("API-Football odds refresh triggered by scheduler");
    void fetchAndStoreOddsForAllUpcoming().catch((err) => {
      logger.error({ err }, "API-Football odds refresh failed");
    });
  }, { timezone: "UTC" });
  logger.info("API-Football odds scheduler active — every 8 hours UTC");

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

  // OddsPapi budget summary: daily at 00:01 UTC
  cron.schedule("1 0 * * *", () => {
    logger.info("OddsPapi daily budget summary triggered");
    void logDailyBudgetSummary().catch((err) => {
      logger.error({ err }, "OddsPapi budget summary failed");
    });
  }, { timezone: "UTC" });
  logger.info("OddsPapi budget summary scheduler active — daily at 00:01 UTC");

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
}

// ===================== Manual triggers (for API routes) =====================

export async function runIngestionNow(): Promise<void> {
  return safeRunIngestion();
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
  return runOddspapiFixtureMapping();
}
