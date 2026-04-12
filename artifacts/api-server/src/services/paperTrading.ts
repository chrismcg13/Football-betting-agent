import {
  db,
  agentConfigTable,
  paperBetsTable,
  matchesTable,
  complianceLogsTable,
  oddsSnapshotsTable,
} from "@workspace/db";
import { eq, and, gte, lt, inArray, desc, sql, isNull, or } from "drizzle-orm";
import { logger } from "../lib/logger";
import { retrainIfNeeded } from "./predictionEngine";
import { fetchMatchStatsForSettlement, getFixturesForDate, teamNameMatch } from "./apiFootball";

// ===================== Config helpers =====================

export async function getConfigValue(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, key));
  return rows[0]?.value ?? null;
}

export async function setConfigValue(
  key: string,
  value: string,
): Promise<void> {
  await db
    .update(agentConfigTable)
    .set({ value, updatedAt: new Date() })
    .where(eq(agentConfigTable.key, key));
}

export async function getBankroll(): Promise<number> {
  const v = await getConfigValue("bankroll");
  return Number(v ?? "500");
}

// ===================== Bet placement pre-checks =====================

async function getTotalPendingExposure(): Promise<number> {
  const result = await db
    .select({ total: sql<number>`COALESCE(SUM(${paperBetsTable.stake}::numeric), 0)` })
    .from(paperBetsTable)
    .where(eq(paperBetsTable.status, "pending"));
  return Number(result[0]?.total ?? 0);
}

async function getTodaysLoss(): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${paperBetsTable.settlementPnl}::numeric) FILTER (WHERE ${paperBetsTable.settlementPnl}::numeric < 0), 0)`,
    })
    .from(paperBetsTable)
    .where(gte(paperBetsTable.settledAt, todayStart));
  return Math.abs(result[0]?.total ?? 0);
}

async function getWeeklyLoss(): Promise<number> {
  const weekStart = new Date();
  const day = weekStart.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  weekStart.setUTCDate(weekStart.getUTCDate() - daysToMonday);
  weekStart.setUTCHours(0, 0, 0, 0);
  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${paperBetsTable.settlementPnl}::numeric) FILTER (WHERE ${paperBetsTable.settlementPnl}::numeric < 0), 0)`,
    })
    .from(paperBetsTable)
    .where(gte(paperBetsTable.settledAt, weekStart));
  return Math.abs(result[0]?.total ?? 0);
}

export async function getAgentStatus(): Promise<string> {
  return (await getConfigValue("agent_status")) ?? "running";
}

// ===================== Dynamic stake sizing =====================

const NEW_MARKET_TYPES = new Set(["TOTAL_CARDS_35", "TOTAL_CARDS_45", "TOTAL_CORNERS_95", "TOTAL_CORNERS_105"]);

function kellyFractionForScore(opportunityScore: number, marketType?: string): number {
  let fraction: number;
  if (opportunityScore >= 88) fraction = 0.5;
  else if (opportunityScore >= 80) fraction = 0.375;
  else if (opportunityScore >= 72) fraction = 0.25;
  else fraction = 0.125; // 65-72
  // 0.7x multiplier for new unproven market types
  if (marketType && NEW_MARKET_TYPES.has(marketType)) fraction *= 0.7;
  return fraction;
}

function calculateDynamicKellyStake(
  bankroll: number,
  edge: number,
  backOdds: number,
  maxStakePct: number,
  opportunityScore: number,
  marketType?: string,
): number {
  if (edge <= 0 || backOdds <= 1) return 0;

  const fraction = kellyFractionForScore(opportunityScore, marketType);
  const kellyFull = edge / (backOdds - 1);
  let stake = bankroll * kellyFull * fraction;

  stake = Math.min(stake, bankroll * maxStakePct);
  stake = Math.max(stake, 2);

  return Math.round(stake * 100) / 100;
}

// ===================== Place paper bet =====================

export interface BetPlacementResult {
  placed: boolean;
  betId?: number;
  stake?: number;
  reason?: string;
}

export interface PaperBetOptions {
  modelVersion?: string | null;
  opportunityScore?: number;
  oddsSource?: string;
  enhancedOpportunityScore?: number | null;
  pinnacleOdds?: number | null;
  pinnacleImplied?: number | null;
  bestOdds?: number | null;
  bestBookmaker?: string | null;
  betThesis?: string | null;
  isContrarian?: boolean;
  stakeMultiplier?: number;
}

export async function placePaperBet(
  matchId: number,
  marketType: string,
  selectionName: string,
  backOdds: number,
  modelProbability: number,
  edge: number,
  options: PaperBetOptions = {},
): Promise<BetPlacementResult> {
  const {
    modelVersion,
    opportunityScore,
    oddsSource,
    enhancedOpportunityScore,
    pinnacleOdds,
    pinnacleImplied,
    bestOdds,
    bestBookmaker,
    betThesis,
    isContrarian = false,
    stakeMultiplier = 1.0,
  } = options;
  const score = opportunityScore ?? 65;

  const logReject = async (reason: string) => {
    logger.info({ matchId, marketType, selectionName, reason }, "Bet rejected");
    await db.insert(complianceLogsTable).values({
      actionType: "bet_rejected",
      details: {
        matchId,
        marketType,
        selectionName,
        backOdds,
        modelProbability,
        edge,
        opportunityScore: score,
        reason,
      },
      timestamp: new Date(),
    });
    return { placed: false, reason };
  };

  const status = await getAgentStatus();
  if (status !== "running") {
    return logReject(`Agent is not running (status: ${status})`);
  }

  const bankroll = await getBankroll();
  const bankrollFloor = Number(
    (await getConfigValue("bankroll_floor")) ?? "200",
  );
  if (bankroll <= bankrollFloor) {
    return logReject(
      `Bankroll £${bankroll.toFixed(2)} at or below floor £${bankrollFloor}`,
    );
  }

  const dailyLossLimitPct = Number(
    (await getConfigValue("daily_loss_limit_pct")) ?? "0.05",
  );
  const dailyLoss = await getTodaysLoss();
  const dailyLossLimit = bankroll * dailyLossLimitPct;
  if (dailyLoss >= dailyLossLimit) {
    return logReject(
      `Daily loss limit hit: £${dailyLoss.toFixed(2)} >= £${dailyLossLimit.toFixed(2)}`,
    );
  }

  const weeklyLossLimitPct = Number(
    (await getConfigValue("weekly_loss_limit_pct")) ?? "0.10",
  );
  const weeklyLoss = await getWeeklyLoss();
  const weeklyLossLimit = bankroll * weeklyLossLimitPct;
  if (weeklyLoss >= weeklyLossLimit) {
    return logReject(
      `Weekly loss limit hit: £${weeklyLoss.toFixed(2)} >= £${weeklyLossLimit.toFixed(2)}`,
    );
  }

  const maxStakePct = Number(
    (await getConfigValue("max_stake_pct")) ?? "0.02",
  );
  let stake = calculateDynamicKellyStake(
    bankroll,
    edge,
    backOdds,
    maxStakePct,
    score,
    marketType,
  );

  // Apply contrarian and correlation multipliers
  if (isContrarian) stake = Math.round(stake * 0.6 * 100) / 100;
  if (stakeMultiplier !== 1.0) stake = Math.round(stake * stakeMultiplier * 100) / 100;

  if (stake < 2) {
    return logReject(`Calculated stake £${stake} is below minimum £2`);
  }

  // ── Exposure-based risk gate ─────────────────────────────────────────────
  // In paper_mode this check is skipped to maximise data collection speed.
  // When paper_mode=false it reinstates automatically for live trading.
  const paperMode = (await getConfigValue("paper_mode")) === "true";
  if (!paperMode) {
    const maxExposurePct = Number(
      (await getConfigValue("max_exposure_pct")) ?? "0.20",
    );
    const currentExposure = await getTotalPendingExposure();
    const maxExposure = bankroll * maxExposurePct;
    if (currentExposure + stake > maxExposure) {
      return logReject(
        `Exposure limit breached: current £${currentExposure.toFixed(2)} + new stake £${stake.toFixed(2)} = £${(currentExposure + stake).toFixed(2)} would exceed ${(maxExposurePct * 100).toFixed(0)}% of bankroll £${maxExposure.toFixed(2)}`,
      );
    }
  }

  const potentialProfit =
    Math.round(stake * (backOdds - 1) * 0.98 * 100) / 100;
  const impliedProbability = 1 / backOdds;

  const [bet] = await db
    .insert(paperBetsTable)
    .values({
      matchId,
      marketType,
      selectionName,
      betType: "back",
      oddsAtPlacement: String(backOdds),
      stake: String(stake),
      potentialProfit: String(potentialProfit),
      modelProbability: String(modelProbability),
      betfairImpliedProbability: String(impliedProbability),
      calculatedEdge: String(edge),
      opportunityScore: String(score),
      modelVersion: modelVersion ?? null,
      oddsSource: oddsSource ?? "synthetic",
      enhancedOpportunityScore: enhancedOpportunityScore != null ? String(enhancedOpportunityScore) : null,
      pinnacleOdds: pinnacleOdds != null ? String(pinnacleOdds) : null,
      pinnacleImplied: pinnacleImplied != null ? String(pinnacleImplied) : null,
      bestOdds: bestOdds != null ? String(bestOdds) : null,
      bestBookmaker: bestBookmaker ?? null,
      betThesis: betThesis ?? null,
      isContrarian: String(isContrarian),
      status: "pending",
    })
    .returning();

  const kellyFraction = kellyFractionForScore(score);

  await db.insert(complianceLogsTable).values({
    actionType: "bet_placed",
    details: {
      betId: bet?.id,
      matchId,
      marketType,
      selectionName,
      backOdds,
      stake,
      potentialProfit,
      modelProbability,
      impliedProbability,
      edge,
      opportunityScore: score,
      bankrollBefore: bankroll,
      kellyFraction,
      dynamicKellyFraction: kellyFraction,
      modelVersion,
    },
    timestamp: new Date(),
  });

  logger.info(
    {
      betId: bet?.id,
      matchId,
      marketType,
      selectionName,
      backOdds,
      stake,
      edge: edge.toFixed(4),
      opportunityScore: score,
      kellyFraction,
    },
    "Paper bet placed",
  );

  return { placed: true, betId: bet?.id, stake };
}

// ===================== Determine bet outcome from match result =====================

// Returns true (won), false (lost), or null (void — data unavailable, stake refunded)
function determineBetWon(
  marketType: string,
  selectionName: string,
  homeScore: number,
  awayScore: number,
  matchStats?: { totalCorners: number | null; totalCards: number | null } | null,
): boolean | null {
  const totalGoals = homeScore + awayScore;

  switch (marketType) {
    case "MATCH_ODDS":
      if (selectionName === "Home") return homeScore > awayScore;
      if (selectionName === "Draw") return homeScore === awayScore;
      if (selectionName === "Away") return awayScore > homeScore;
      return null;

    case "BTTS":
      if (selectionName === "Yes") return homeScore > 0 && awayScore > 0;
      if (selectionName === "No") return !(homeScore > 0 && awayScore > 0);
      return null;

    case "DOUBLE_CHANCE":
      if (selectionName === "Home or Draw" || selectionName === "1X") return homeScore >= awayScore;
      if (selectionName === "Away or Draw" || selectionName === "X2") return awayScore >= homeScore;
      if (selectionName === "Home or Away" || selectionName === "12") return homeScore !== awayScore;
      return null;

    case "OVER_UNDER_05":
      if (selectionName.startsWith("Over")) return totalGoals > 0;
      if (selectionName.startsWith("Under")) return totalGoals === 0;
      return null;

    case "OVER_UNDER_15":
      if (selectionName.startsWith("Over")) return totalGoals > 1;
      if (selectionName.startsWith("Under")) return totalGoals <= 1;
      return null;

    case "OVER_UNDER_25":
      if (selectionName.startsWith("Over")) return totalGoals > 2;
      if (selectionName.startsWith("Under")) return totalGoals <= 2;
      return null;

    case "OVER_UNDER_35":
      if (selectionName.startsWith("Over")) return totalGoals > 3;
      if (selectionName.startsWith("Under")) return totalGoals <= 3;
      return null;

    case "OVER_UNDER_45":
      if (selectionName.startsWith("Over")) return totalGoals > 4;
      if (selectionName.startsWith("Under")) return totalGoals <= 4;
      return null;

    case "ASIAN_HANDICAP": {
      // selectionName examples: "Home -0.5", "Away +1.5", "Home -1", "Away 0"
      const parts = selectionName.split(" ");
      const side = parts[0]; // "Home" or "Away"
      const handicap = parseFloat(parts[1] ?? "0");
      const adjustedHome = homeScore + (side === "Home" ? handicap : -handicap);
      const adjustedAway = awayScore + (side === "Away" ? handicap : -handicap);
      if (Math.abs(handicap % 1) === 0.25) {
        // Split bet: half each on nearest 0.5 lines
        const lower = handicap - 0.25;
        const upper = handicap + 0.25;
        const adjHomeLow = homeScore + (side === "Home" ? lower : -lower);
        const adjHomeHigh = homeScore + (side === "Home" ? upper : -upper);
        const winLow = side === "Home" ? adjHomeLow > awayScore : adjustedAway > homeScore + lower;
        const winHigh = side === "Home" ? adjHomeHigh > awayScore : adjustedAway > homeScore + upper;
        if (winLow && winHigh) return true;
        if (!winLow && !winHigh) return false;
        return null; // half-win/half-loss treated as void for simplicity
      }
      if (side === "Home") return adjustedHome > awayScore;
      if (side === "Away") return adjustedAway > homeScore;
      return null;
    }

    // ─── Corners markets — use stored stats ───────────────────────────────────
    case "TOTAL_CORNERS_75":
    case "TOTAL_CORNERS_85":
    case "TOTAL_CORNERS_95":
    case "TOTAL_CORNERS_105":
    case "TOTAL_CORNERS_115": {
      if (!matchStats || matchStats.totalCorners === null) return null;
      // Parse threshold from market type: "TOTAL_CORNERS_95" → 9.5
      const suffix = marketType.split("_").pop()!;
      const threshold = parseInt(suffix, 10) / 10;
      if (selectionName.startsWith("Over")) return matchStats.totalCorners > threshold;
      if (selectionName.startsWith("Under")) return matchStats.totalCorners < threshold;
      return null;
    }

    // ─── Cards markets — use stored stats ────────────────────────────────────
    case "TOTAL_CARDS_25":
    case "TOTAL_CARDS_35":
    case "TOTAL_CARDS_45":
    case "TOTAL_CARDS_55": {
      if (!matchStats || matchStats.totalCards === null) return null;
      const suffix = marketType.split("_").pop()!;
      const threshold = parseInt(suffix, 10) / 10;
      if (selectionName.startsWith("Over")) return matchStats.totalCards > threshold;
      if (selectionName.startsWith("Under")) return matchStats.totalCards < threshold;
      return null;
    }

    case "FIRST_HALF_RESULT":
    case "FIRST_HALF_OU_05":
    case "FIRST_HALF_OU_15":
      return null; // void — no half-time score data available

    default:
      return null; // void unknown markets rather than forcing a loss
  }
}

// ===================== Settle bets =====================

export interface SettlementResult {
  settled: number;
  won: number;
  lost: number;
  totalPnl: number;
}

export async function settleBets(): Promise<SettlementResult> {
  const pendingBets = await db
    .select()
    .from(paperBetsTable)
    .where(eq(paperBetsTable.status, "pending"));

  if (pendingBets.length === 0) {
    return { settled: 0, won: 0, lost: 0, totalPnl: 0 };
  }

  const uniqueMatchIds = [...new Set(pendingBets.map((b) => b.matchId))];
  const finishedMatches = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        inArray(matchesTable.id, uniqueMatchIds),
        eq(matchesTable.status, "finished"),
      ),
    );

  const matchMap = new Map(finishedMatches.map((m) => [m.id, m]));

  let settled = 0;
  let won = 0;
  let lost = 0;
  let totalPnl = 0;

  for (const bet of pendingBets) {
    const match = matchMap.get(bet.matchId);
    if (!match) continue;
    if (match.homeScore === null || match.awayScore === null) continue;

    const stake = Number(bet.stake);
    const odds = Number(bet.oddsAtPlacement);
    const outcome = determineBetWon(
      bet.marketType,
      bet.selectionName,
      match.homeScore,
      match.awayScore,
      { totalCorners: match.totalCorners ?? null, totalCards: match.totalCards ?? null },
    );

    // null = void (data unavailable) — refund stake, no PnL impact
    const isVoid = outcome === null;
    const betWon = outcome === true;

    const settlementPnl = isVoid
      ? 0
      : betWon
        ? Math.round(stake * (odds - 1) * 0.98 * 100) / 100
        : -stake;

    const newStatus = isVoid ? "void" : betWon ? "won" : "lost";
    const now = new Date();

    // ── CLV: compare placement odds vs closing odds proxy ──────────────
    // NOTE: True CLV should use Pinnacle closing odds. The odds_snapshots table
    // does not have a separate Pinnacle source — it stores API-Football real odds
    // (1xBet / Bet365). We use the latest snapshot as the best available proxy.
    // Pinnacle odds at placement time are stored in bet.pinnacleOdds but those
    // are opening prices, not closing prices. Until a Pinnacle closing-odds fetch
    // is added to the settlement flow, this remains a market-proxy CLV.
    let closingOddsProxy: number | null = null;
    let clvPct: number | null = null;
    try {
      const latestSnapshot = await db
        .select({ backOdds: oddsSnapshotsTable.backOdds })
        .from(oddsSnapshotsTable)
        .where(
          and(
            eq(oddsSnapshotsTable.matchId, bet.matchId),
            eq(oddsSnapshotsTable.marketType, bet.marketType),
            eq(oddsSnapshotsTable.selectionName, bet.selectionName),
          ),
        )
        .orderBy(desc(oddsSnapshotsTable.snapshotTime))
        .limit(1);
      if (latestSnapshot[0]?.backOdds) {
        closingOddsProxy = Number(latestSnapshot[0].backOdds);
        if (closingOddsProxy > 1) {
          clvPct = ((odds - closingOddsProxy) / closingOddsProxy) * 100;
          clvPct = Math.round(clvPct * 1000) / 1000;
          logger.info(
            { betId: bet.id, placementOdds: odds, closingOddsProxy, clvPct },
            "CLV calculated (proxy: latest API-Football snapshot — not Pinnacle closing odds)",
          );
        }
      }
    } catch (_err) {
      // CLV is best-effort; don't block settlement
    }

    await db
      .update(paperBetsTable)
      .set({
        status: newStatus,
        settlementPnl: String(settlementPnl),
        settledAt: now,
        closingOddsProxy: closingOddsProxy != null ? String(closingOddsProxy) : null,
        clvPct: clvPct != null ? String(clvPct) : null,
      })
      .where(eq(paperBetsTable.id, bet.id));

    await db.insert(complianceLogsTable).values({
      actionType: "bet_settled",
      details: {
        betId: bet.id,
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        marketType: bet.marketType,
        selectionName: bet.selectionName,
        odds,
        stake,
        outcome: newStatus,
        settlementPnl,
        opportunityScore: Number(bet.opportunityScore ?? 0),
        commission: betWon
          ? Math.round(stake * (odds - 1) * 0.02 * 100) / 100
          : 0,
      },
      timestamp: now,
    });

    if (!isVoid && betWon) won++;
    else if (!isVoid) lost++;
    totalPnl += settlementPnl;
    settled++;

    logger.info(
      {
        betId: bet.id,
        matchId: match.id,
        outcome: newStatus,
        settlementPnl,
        opportunityScore: bet.opportunityScore,
      },
      "Bet settled",
    );
  }

  if (settled > 0) {
    const currentBankroll = await getBankroll();
    const newBankroll =
      Math.round((currentBankroll + totalPnl) * 100) / 100;
    await setConfigValue("bankroll", String(newBankroll));

    await db.insert(complianceLogsTable).values({
      actionType: "bankroll_updated",
      details: {
        bankrollBefore: currentBankroll,
        bankrollAfter: newBankroll,
        delta: totalPnl,
        betsSettled: settled,
        won,
        lost,
        reason: "settlement",
      },
      timestamp: new Date(),
    });

    logger.info(
      { previous: currentBankroll, delta: totalPnl, updated: newBankroll },
      "Bankroll updated after settlement",
    );

    const totalSettledResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(paperBetsTable)
      .where(inArray(paperBetsTable.status, ["won", "lost"]));
    const totalSettled = totalSettledResult[0]?.count ?? 0;

    if (totalSettled > 0 && totalSettled % 20 === 0) {
      logger.info(
        { totalSettled },
        "Triggering model retraining after settlement milestone",
      );
      void retrainIfNeeded().catch((err) =>
        logger.error({ err }, "Retraining after settlement failed"),
      );
    }
  }

  return { settled, won, lost, totalPnl };
}

// ===================== Backfill stats for voided corners/cards bets =====================

const CORNERS_CARDS_MARKETS = new Set([
  "TOTAL_CORNERS_75", "TOTAL_CORNERS_85", "TOTAL_CORNERS_95", "TOTAL_CORNERS_105", "TOTAL_CORNERS_115",
  "TOTAL_CARDS_25", "TOTAL_CARDS_35", "TOTAL_CARDS_45", "TOTAL_CARDS_55",
]);

export async function backfillCornersCardsStats(): Promise<{ matchesUpdated: number; betsResettled: number }> {
  // 1. Find finished matches with voided corners/cards bets that have no stats yet
  const voidedBets = await db
    .select({ matchId: paperBetsTable.matchId, marketType: paperBetsTable.marketType })
    .from(paperBetsTable)
    .where(eq(paperBetsTable.status, "void"));

  const relevantMatchIds = [
    ...new Set(
      voidedBets
        .filter((b) => CORNERS_CARDS_MARKETS.has(b.marketType))
        .map((b) => b.matchId),
    ),
  ];

  if (relevantMatchIds.length === 0) {
    return { matchesUpdated: 0, betsResettled: 0 };
  }

  const matches = await db
    .select()
    .from(matchesTable)
    .where(
      and(
        inArray(matchesTable.id, relevantMatchIds),
        eq(matchesTable.status, "finished"),
        or(isNull(matchesTable.totalCorners), isNull(matchesTable.totalCards)),
      ),
    );

  if (matches.length === 0) {
    logger.info("backfillCornersCardsStats: no finished matches need stats backfill");
    return { matchesUpdated: 0, betsResettled: 0 };
  }

  // 2. Group matches by date and fetch fixtures to find their API fixture IDs
  const dateGroups = new Map<string, typeof matches>();
  for (const m of matches) {
    const dateStr = m.kickoffTime.toISOString().slice(0, 10);
    if (!dateGroups.has(dateStr)) dateGroups.set(dateStr, []);
    dateGroups.get(dateStr)!.push(m);
  }

  const matchIdToFixtureId = new Map<number, number>();

  for (const [date, dateMatches] of dateGroups) {
    const fixtures = await getFixturesForDate(date);
    const finished = fixtures.filter(
      (f) => f.fixture.status.short === "FT" || f.fixture.status.short === "AET" || f.fixture.status.short === "PEN",
    );
    for (const dbMatch of dateMatches) {
      // If we already have an apiFixtureId stored, use it
      if (dbMatch.apiFixtureId) {
        matchIdToFixtureId.set(dbMatch.id, dbMatch.apiFixtureId);
        continue;
      }
      const fixture = finished.find(
        (f) =>
          teamNameMatch(dbMatch.homeTeam, f.teams.home.name) &&
          teamNameMatch(dbMatch.awayTeam, f.teams.away.name),
      );
      if (fixture) {
        matchIdToFixtureId.set(dbMatch.id, fixture.fixture.id);
      } else {
        logger.warn(
          { matchId: dbMatch.id, home: dbMatch.homeTeam, away: dbMatch.awayTeam, date },
          "backfillCornersCardsStats: could not find API fixture",
        );
      }
    }
  }

  // 3. Fetch stats and update matches
  let matchesUpdated = 0;
  for (const dbMatch of matches) {
    const fixtureId = matchIdToFixtureId.get(dbMatch.id);
    if (!fixtureId) continue;

    const stats = await fetchMatchStatsForSettlement(fixtureId);
    if (!stats) {
      logger.warn({ matchId: dbMatch.id, fixtureId }, "backfillCornersCardsStats: no stats from API");
      continue;
    }

    await db
      .update(matchesTable)
      .set({
        apiFixtureId: fixtureId,
        totalCorners: stats.totalCorners,
        totalCards: stats.totalCards,
      })
      .where(eq(matchesTable.id, dbMatch.id));

    logger.info(
      { matchId: dbMatch.id, fixtureId, totalCorners: stats.totalCorners, totalCards: stats.totalCards },
      "backfillCornersCardsStats: stats stored for match",
    );
    matchesUpdated++;
  }

  // 4. Re-settle voided corners/cards bets for matches now having stats
  const updatedMatchIds = [...matchIdToFixtureId.keys()];
  if (updatedMatchIds.length === 0) return { matchesUpdated, betsResettled: 0 };

  const updatedMatches = await db
    .select()
    .from(matchesTable)
    .where(inArray(matchesTable.id, updatedMatchIds));
  const updatedMatchMap = new Map(updatedMatches.map((m) => [m.id, m]));

  const voidedCornersCardsBets = await db
    .select()
    .from(paperBetsTable)
    .where(
      and(
        eq(paperBetsTable.status, "void"),
        inArray(paperBetsTable.matchId, updatedMatchIds),
      ),
    );

  let betsResettled = 0;
  let pnlDelta = 0;

  for (const bet of voidedCornersCardsBets) {
    if (!CORNERS_CARDS_MARKETS.has(bet.marketType)) continue;
    const match = updatedMatchMap.get(bet.matchId);
    if (!match || match.homeScore === null || match.awayScore === null) continue;
    if (match.totalCorners === null && match.totalCards === null) continue;

    const outcome = determineBetWon(
      bet.marketType,
      bet.selectionName,
      match.homeScore,
      match.awayScore,
      { totalCorners: match.totalCorners ?? null, totalCards: match.totalCards ?? null },
    );

    if (outcome === null) continue; // still not determinable

    const stake = Number(bet.stake);
    const odds = Number(bet.oddsAtPlacement);
    const betWon = outcome === true;
    const settlementPnl = betWon ? Math.round(stake * (odds - 1) * 0.98 * 100) / 100 : -stake;
    const newStatus = betWon ? "won" : "lost";

    await db
      .update(paperBetsTable)
      .set({ status: newStatus, settlementPnl: String(settlementPnl) })
      .where(eq(paperBetsTable.id, bet.id));

    pnlDelta += settlementPnl;
    betsResettled++;

    logger.info(
      { betId: bet.id, market: bet.marketType, selection: bet.selectionName, newStatus, settlementPnl },
      "backfillCornersCardsStats: voided bet re-settled",
    );
  }

  // 5. Update bankroll for the PnL delta
  if (betsResettled > 0) {
    const bankrollStr = await getConfigValue("bankroll");
    const bankroll = parseFloat(bankrollStr ?? "500");
    const newBankroll = Math.round((bankroll + pnlDelta) * 100) / 100;
    await setConfigValue("bankroll", String(newBankroll));
    logger.info(
      { betsResettled, pnlDelta, bankroll, newBankroll },
      "backfillCornersCardsStats: bankroll updated after re-settlement",
    );
  }

  return { matchesUpdated, betsResettled };
}
