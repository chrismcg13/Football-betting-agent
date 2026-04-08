import {
  db,
  agentConfigTable,
  paperBetsTable,
  matchesTable,
  complianceLogsTable,
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

async function getOpenBetsCount(): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(paperBetsTable)
    .where(eq(paperBetsTable.status, "pending"));
  return result[0]?.count ?? 0;
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

// ===================== Stake calculation =====================

function calculateKellyStake(
  bankroll: number,
  edge: number,
  backOdds: number,
  maxStakePct: number,
): number {
  if (edge <= 0 || backOdds <= 1) return 0;

  // Quarter-Kelly: stake = bankroll * (edge / (odds - 1)) * 0.25
  const kellyFraction = edge / (backOdds - 1);
  let stake = bankroll * kellyFraction * 0.25;

  // Cap at max_stake_pct of bankroll
  stake = Math.min(stake, bankroll * maxStakePct);

  // Minimum £2
  stake = Math.max(stake, 2);

  // Round to 2 dp
  return Math.round(stake * 100) / 100;
}

// ===================== Place paper bet =====================

export interface BetPlacementResult {
  placed: boolean;
  betId?: number;
  stake?: number;
  reason?: string;
}

export async function placePaperBet(
  matchId: number,
  marketType: string,
  selectionName: string,
  backOdds: number,
  modelProbability: number,
  edge: number,
  modelVersion?: string | null,
): Promise<BetPlacementResult> {
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
        reason,
      },
      timestamp: new Date(),
    });
    return { placed: false, reason };
  };

  // 1. Agent must be running
  const status = await getAgentStatus();
  if (status !== "running") {
    return logReject(`Agent is not running (status: ${status})`);
  }

  // 2. Max concurrent bets
  const [maxConcurrent, openCount] = await Promise.all([
    getConfigValue("max_concurrent_bets").then((v) => Number(v ?? "10")),
    getOpenBetsCount(),
  ]);
  if (openCount >= maxConcurrent) {
    return logReject(
      `Max concurrent bets reached (${openCount}/${maxConcurrent})`,
    );
  }

  // 3. Bankroll checks
  const bankroll = await getBankroll();
  const bankrollFloor = Number(
    (await getConfigValue("bankroll_floor")) ?? "200",
  );
  if (bankroll <= bankrollFloor) {
    return logReject(
      `Bankroll £${bankroll.toFixed(2)} at or below floor £${bankrollFloor}`,
    );
  }

  // 4. Daily loss limit
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

  // 5. Weekly loss limit
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

  // 6. Calculate stake
  const maxStakePct = Number(
    (await getConfigValue("max_stake_pct")) ?? "0.02",
  );
  const stake = calculateKellyStake(bankroll, edge, backOdds, maxStakePct);

  if (stake < 2) {
    return logReject(`Calculated stake £${stake} is below minimum £2`);
  }

  const potentialProfit =
    Math.round(stake * (backOdds - 1) * 0.98 * 100) / 100;
  const impliedProbability = 1 / backOdds;

  // 7. Insert paper bet
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
      modelVersion: modelVersion ?? null,
      status: "pending",
    })
    .returning();

  // 8. Compliance log
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
      bankrollBefore: bankroll,
      openBetsAfter: openCount + 1,
      kellyFraction: edge / (backOdds - 1),
      quarterKellyStake: stake,
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

    // 2% Betfair commission on winnings
    const settlementPnl = betWon
      ? Math.round(stake * (odds - 1) * 0.98 * 100) / 100
      : -stake;

    const newStatus = betWon ? "won" : "lost";
    const now = new Date();

    await db
      .update(paperBetsTable)
      .set({
        status: newStatus,
        settlementPnl: String(settlementPnl),
        settledAt: now,
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
      },
      "Bet settled",
    );
  }

  // Update bankroll
  if (settled > 0) {
    const currentBankroll = await getBankroll();
    const newBankroll =
      Math.round((currentBankroll + totalPnl) * 100) / 100;
    await setConfigValue("bankroll", String(newBankroll));

    await db.insert(complianceLogsTable).values({
      actionType: "bankroll_updated",
      details: {
        previous: currentBankroll,
        delta: totalPnl,
        updated: newBankroll,
        betsSettled: settled,
        won,
        lost,
      },
      timestamp: new Date(),
    });

    logger.info(
      { previous: currentBankroll, delta: totalPnl, updated: newBankroll },
      "Bankroll updated after settlement",
    );

    // Trigger model retraining if total settled bets is a multiple of 20
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
