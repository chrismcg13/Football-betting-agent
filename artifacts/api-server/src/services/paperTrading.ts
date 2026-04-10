import {
  db,
  agentConfigTable,
  paperBetsTable,
  matchesTable,
  complianceLogsTable,
  oddsSnapshotsTable,
} from "@workspace/db";
import { eq, and, gte, lt, inArray, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { retrainIfNeeded } from "./predictionEngine";

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
      openBetsAfter: openCount + 1,
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

function determineBetWon(
  marketType: string,
  selectionName: string,
  homeScore: number,
  awayScore: number,
): boolean {
  switch (marketType) {
    case "MATCH_ODDS":
      if (selectionName === "Home") return homeScore > awayScore;
      if (selectionName === "Draw") return homeScore === awayScore;
      if (selectionName === "Away") return awayScore > homeScore;
      return false;

    case "BTTS":
      if (selectionName === "Yes") return homeScore > 0 && awayScore > 0;
      if (selectionName === "No") return !(homeScore > 0 && awayScore > 0);
      return false;

    case "OVER_UNDER_25":
      if (selectionName === "Over 2.5 Goals")
        return homeScore + awayScore > 2;
      if (selectionName === "Under 2.5 Goals")
        return homeScore + awayScore <= 2;
      return false;

    default:
      return false;
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
    const betWon = determineBetWon(
      bet.marketType,
      bet.selectionName,
      match.homeScore,
      match.awayScore,
    );

    const settlementPnl = betWon
      ? Math.round(stake * (odds - 1) * 0.98 * 100) / 100
      : -stake;

    const newStatus = betWon ? "won" : "lost";
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

    if (betWon) won++;
    else lost++;
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
