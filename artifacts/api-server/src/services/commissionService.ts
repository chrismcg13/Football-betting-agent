import { db, exchangesTable, paperBetsTable } from "@workspace/db";
import { eq, sql, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

export interface CommissionResult {
  grossPnl: number;
  commissionRate: number;
  commissionAmount: number;
  netPnl: number;
}

let cachedBetfairExchangeId: number | null = null;
let cachedCommissionRate: number | null = null;

export async function getBetfairExchangeId(): Promise<number> {
  if (cachedBetfairExchangeId != null) return cachedBetfairExchangeId;
  const rows = await db
    .select({ id: exchangesTable.id })
    .from(exchangesTable)
    .where(eq(exchangesTable.exchangeName, "betfair"))
    .limit(1);
  if (rows.length === 0) throw new Error("Betfair exchange not found in DB");
  cachedBetfairExchangeId = rows[0]!.id;
  return cachedBetfairExchangeId;
}

export async function getCommissionRate(exchangeName = "betfair"): Promise<number> {
  if (exchangeName === "betfair" && cachedCommissionRate != null) return cachedCommissionRate;
  const rows = await db
    .select({ commissionStructure: exchangesTable.commissionStructure })
    .from(exchangesTable)
    .where(eq(exchangesTable.exchangeName, exchangeName))
    .limit(1);
  if (rows.length === 0) return 0.05;
  const structure = rows[0]!.commissionStructure as Record<string, unknown>;
  const rate = Number(structure.standard_rate ?? 0.05);
  if (exchangeName === "betfair") cachedCommissionRate = rate;
  return rate;
}

export function calculateCommission(
  grossProfit: number,
  commissionRate: number,
  betWon: boolean,
): CommissionResult {
  if (!betWon || grossProfit <= 0) {
    return {
      grossPnl: betWon ? grossProfit : grossProfit,
      commissionRate: 0,
      commissionAmount: 0,
      netPnl: grossProfit,
    };
  }

  const commissionAmount = Math.round(grossProfit * commissionRate * 100) / 100;
  const netPnl = Math.round((grossProfit - commissionAmount) * 100) / 100;

  return {
    grossPnl: Math.round(grossProfit * 100) / 100,
    commissionRate,
    commissionAmount,
    netPnl,
  };
}

export function calculateSettlementWithCommission(
  stake: number,
  odds: number,
  betWon: boolean,
  commissionRate: number,
): CommissionResult {
  if (!betWon) {
    return {
      grossPnl: -stake,
      commissionRate: 0,
      commissionAmount: 0,
      netPnl: -stake,
    };
  }

  const grossProfit = Math.round(stake * (odds - 1) * 100) / 100;
  return calculateCommission(grossProfit, commissionRate, true);
}

export function commissionAdjustedEV(
  probability: number,
  odds: number,
  commissionRate: number,
): { grossEV: number; netEV: number; commissionCost: number } {
  const grossEV = probability * (odds - 1) - (1 - probability);
  const netEV = probability * (odds - 1) * (1 - commissionRate) - (1 - probability);
  const commissionCost = probability * (odds - 1) * commissionRate;
  return {
    grossEV: Math.round(grossEV * 10000) / 10000,
    netEV: Math.round(netEV * 10000) / 10000,
    commissionCost: Math.round(commissionCost * 10000) / 10000,
  };
}

export async function getCommissionStats(): Promise<{
  allTime: { grossProfit: number; totalCommission: number; netProfit: number; effectiveRate: number; betCount: number };
  thisMonth: { grossProfit: number; totalCommission: number; netProfit: number; effectiveRate: number; betCount: number };
  thisWeek: { grossProfit: number; totalCommission: number; netProfit: number; effectiveRate: number; betCount: number };
  today: { grossProfit: number; totalCommission: number; netProfit: number; effectiveRate: number; betCount: number };
  lifetimeGrossProfit: number;
  premiumChargeThreshold: number;
  premiumChargeWarning: boolean;
  projectedMonthlyCommission: number;
}> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);

  const weekStart = new Date(now);
  const day = weekStart.getUTCDay();
  weekStart.setUTCDate(weekStart.getUTCDate() - (day === 0 ? 6 : day - 1));
  weekStart.setUTCHours(0, 0, 0, 0);

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const rows = await db
    .select({
      grossPnl: paperBetsTable.grossPnl,
      commissionAmount: paperBetsTable.commissionAmount,
      netPnl: paperBetsTable.netPnl,
      settledAt: paperBetsTable.settledAt,
      status: paperBetsTable.status,
    })
    .from(paperBetsTable)
    .where(
      and(
        inArray(paperBetsTable.status, ["won", "lost", "void"]),
        sql`${paperBetsTable.deletedAt} IS NULL`,
      ),
    );

  const allTime = { grossProfit: 0, totalCommission: 0, netProfit: 0, effectiveRate: 0, betCount: 0 };
  const thisMonth = { grossProfit: 0, totalCommission: 0, netProfit: 0, effectiveRate: 0, betCount: 0 };
  const thisWeek = { grossProfit: 0, totalCommission: 0, netProfit: 0, effectiveRate: 0, betCount: 0 };
  const today = { grossProfit: 0, totalCommission: 0, netProfit: 0, effectiveRate: 0, betCount: 0 };
  let lifetimeGrossProfit = 0;
  let monthPositiveGross = 0;
  let weekPositiveGross = 0;
  let todayPositiveGross = 0;

  for (const row of rows) {
    const gross = Number(row.grossPnl ?? 0);
    const comm = Number(row.commissionAmount ?? 0);
    const net = Number(row.netPnl ?? 0);
    const settled = row.settledAt ? new Date(row.settledAt) : null;

    allTime.grossProfit += gross;
    allTime.totalCommission += comm;
    allTime.netProfit += net;
    allTime.betCount++;
    if (gross > 0) lifetimeGrossProfit += gross;

    if (settled && settled >= monthStart) {
      thisMonth.grossProfit += gross;
      thisMonth.totalCommission += comm;
      thisMonth.netProfit += net;
      thisMonth.betCount++;
      if (gross > 0) monthPositiveGross += gross;
    }
    if (settled && settled >= weekStart) {
      thisWeek.grossProfit += gross;
      thisWeek.totalCommission += comm;
      thisWeek.netProfit += net;
      thisWeek.betCount++;
      if (gross > 0) weekPositiveGross += gross;
    }
    if (settled && settled >= todayStart) {
      today.grossProfit += gross;
      today.totalCommission += comm;
      today.netProfit += net;
      today.betCount++;
      if (gross > 0) todayPositiveGross += gross;
    }
  }

  const calcRate = (comm: number, positiveGross: number) =>
    positiveGross > 0 ? Math.round((comm / positiveGross) * 10000) / 10000 : 0;

  allTime.effectiveRate = calcRate(allTime.totalCommission, lifetimeGrossProfit);
  thisMonth.effectiveRate = calcRate(thisMonth.totalCommission, monthPositiveGross);
  thisWeek.effectiveRate = calcRate(thisWeek.totalCommission, weekPositiveGross);
  today.effectiveRate = calcRate(today.totalCommission, todayPositiveGross);

  for (const period of [allTime, thisMonth, thisWeek, today]) {
    period.grossProfit = Math.round(period.grossProfit * 100) / 100;
    period.totalCommission = Math.round(period.totalCommission * 100) / 100;
    period.netProfit = Math.round(period.netProfit * 100) / 100;
  }

  const premiumChargeThreshold = 25000;
  const premiumChargeWarning = lifetimeGrossProfit >= premiumChargeThreshold;

  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const projectedMonthlyCommission =
    dayOfMonth > 0
      ? Math.round((thisMonth.totalCommission / dayOfMonth) * daysInMonth * 100) / 100
      : 0;

  return {
    allTime,
    thisMonth,
    thisWeek,
    today,
    lifetimeGrossProfit: Math.round(lifetimeGrossProfit * 100) / 100,
    premiumChargeThreshold,
    premiumChargeWarning,
    projectedMonthlyCommission,
  };
}

export async function getExchanges(): Promise<Array<{
  id: number;
  exchangeName: string;
  displayName: string;
  isActive: boolean;
  commissionStructure: unknown;
}>> {
  return db
    .select({
      id: exchangesTable.id,
      exchangeName: exchangesTable.exchangeName,
      displayName: exchangesTable.displayName,
      isActive: exchangesTable.isActive,
      commissionStructure: exchangesTable.commissionStructure,
    })
    .from(exchangesTable);
}
