import cron from "node-cron";
import { logger } from "../lib/logger";
import { runDataIngestion } from "./dataIngestion";
import { runFeatureEngineForUpcomingMatches } from "./featureEngine";
import { detectValueBets } from "./valueDetection";
import { placePaperBet, settleBets, getAgentStatus, getBankroll, deduplicatePendingBets } from "./paperTrading";
import { runAllRiskChecks } from "./riskManager";
import { getModelVersion } from "./predictionEngine";
import { runLearningLoop } from "./learningLoop";
import {
  fetchAndStoreOddsForAllUpcoming,
  fetchTeamStatsForUpcomingMatches,
} from "./apiFootball";
import { runXGIngestion } from "./xgIngestionService";
import {
  runOddspapiFixtureMapping,
  getOddspapiFixtureId,
  getOddspapiValidation,
  prefetchAndStoreOddsPapiOdds,
  type OddsPapiValidationCache,
  logDailyBudgetSummary,
} from "./oddsPapi";
import { applyCorrelationDetection, type BetCandidate } from "./correlationDetector";
import { fetchRecentFixtureResults, teamNameMatch, fetchMatchStatsForSettlement } from "./apiFootball";
import { db, agentConfigTable, leagueEdgeScoresTable, paperBetsTable, matchesTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";

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

    // 5. Detect value bets for matches kicking off in 1h–168h (full week)
    const now = new Date();
    const earliest = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    const latest   = new Date(now.getTime() + 168 * 60 * 60 * 1000);

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
    // Skip fixtures > 48h out for OddsPapi (not covered yet / budget efficiency)
    // Also skip second-division leagues (not typically on OddsPapi)
    const SECOND_DIV_LEAGUES = new Set(["Ligue 2", "2. Bundesliga", "Serie B", "Segunda División", "La Liga 2", "Segunda Division"]);
    const oddspapiEligible = rankedForOddsPapi.filter((bet) => {
      const hoursOut = (new Date(bet.kickoffTime).getTime() - Date.now()) / (1000 * 60 * 60);
      return hoursOut <= 48 && !SECOND_DIV_LEAGUES.has(bet.league ?? "");
    });
    const top5 = oddspapiEligible.slice(0, 8);
    const rest = [
      ...oddspapiEligible.slice(8),
      ...rankedForOddsPapi.filter((bet) => !oddspapiEligible.includes(bet)),
    ];

    type OddsValidation = Awaited<ReturnType<typeof getOddspapiValidation>>;

    const enhancedCandidates = await Promise.all(
      top5.map(async (bet) => {
        try {
          let validation: OddsValidation | null = null;

          const cachedMatch = oddsPapiCache.get(bet.matchId);
          if (cachedMatch) {
            const sel = bet.selectionName as keyof typeof cachedMatch;
            if (cachedMatch[sel]) {
              validation = { ...cachedMatch[sel], isContrarian: false, pinnacleAligned: false };
            }
          }

          if (!validation) {
            const oddspapiId = await getOddspapiFixtureId(bet.matchId);
            if (!oddspapiId) return { bet, validation: null, effectiveScore: bet.opportunityScore };

            validation = await getOddspapiValidation(
              oddspapiId,
              bet.marketType,
              bet.selectionName,
              bet.backOdds,
            );
          }

          // Pinnacle scoring (enhanced):
          // +10 if Pinnacle-aligned (sharp money agrees with our model)
          // -10 if contrarian (Pinnacle strongly disagrees — higher risk)
          // No flat bonus for just having Pinnacle data — focus on alignment quality
          let effectiveScore = bet.opportunityScore;
          if (validation.hasPinnacleData) {
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
              hasPinnacleData: validation.hasPinnacleData,
              pinnacleAligned: validation.pinnacleAligned,
              isContrarian: validation.isContrarian,
            },
            "OddsPapi validation scoring",
          );

          return { bet, validation, effectiveScore };
        } catch (err) {
          logger.warn({ err, matchId: bet.matchId }, "OddsPapi validation failed — using base score");
          return { bet, validation: null, effectiveScore: bet.opportunityScore };
        }
      }),
    );

    // 7. Build final candidate list with effective scores
    type BetEntry = {
      bet: typeof timely[number];
      effectiveScore: number;
      validation: OddsValidation | null;
    };

    const allEntries: BetEntry[] = [
      ...enhancedCandidates.map(({ bet, validation, effectiveScore }) => ({
        bet,
        effectiveScore,
        validation: validation ?? null,
      })),
      ...rest.map((bet) => ({
        bet,
        effectiveScore: bet.opportunityScore,
        validation: null as OddsValidation | null,
      })),
    ].sort((a, b) => b.effectiveScore - a.effectiveScore);

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
  }
}

// ===================== Sync match results from football-data.org =====================

export async function syncMatchResults(): Promise<number> {
  // Fetch recently finished fixtures from API-Football (our active data source)
  let recentFixtures: Awaited<ReturnType<typeof fetchRecentFixtureResults>>;
  try {
    recentFixtures = await fetchRecentFixtureResults(7);
  } catch (err) {
    logger.warn({ err }, "syncMatchResults: failed to fetch recent fixtures");
    return 0;
  }

  if (recentFixtures.length === 0) {
    logger.info("syncMatchResults: API-Football returned 0 finished fixtures");
    return 0;
  }

  // Get all matches in DB that are still 'scheduled' and past kickoff
  const scheduledMatches = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        eq(matchesTable.status, "scheduled"),
        sql`${matchesTable.kickoffTime} < NOW() - INTERVAL '90 minutes'`,
      ),
    );

  if (scheduledMatches.length === 0) {
    logger.info("syncMatchResults: no scheduled past matches to update");
    return 0;
  }

  let updated = 0;
  const matchedDbIds = new Set<number>();

  for (const fixture of recentFixtures) {
    const homeGoals = fixture.goals?.home ?? fixture.score?.fulltime?.home;
    const awayGoals = fixture.goals?.away ?? fixture.score?.fulltime?.away;
    if (homeGoals === null || homeGoals === undefined || awayGoals === null || awayGoals === undefined) continue;

    // Find matching DB match using fuzzy team name matching
    const dbMatch = scheduledMatches.find(
      (m) =>
        !matchedDbIds.has(m.id) &&
        teamNameMatch(m.homeTeam, fixture.teams.home.name) &&
        teamNameMatch(m.awayTeam, fixture.teams.away.name),
    );
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
export function startSettlementCron(): void {
  cron.schedule("*/5 * * * *", () => {
    void (async () => {
      try {
        const synced = await syncMatchResults();
        if (synced > 0) logger.info({ synced }, "Settlement cron: match results synced");
        const r = await settleBets();
        if (r.settled > 0) logger.info(r, "Settlement cron: bets settled");
      } catch (err) {
        logger.warn({ err }, "Settlement cron failed — non-fatal");
      }
    })();
  }, { timezone: "UTC" });
  logger.info("Settlement cron active — every 5 minutes (sync + settle)");
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
}

// ===================== Manual triggers (for API routes) =====================

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
  return runOddspapiFixtureMapping();
}
