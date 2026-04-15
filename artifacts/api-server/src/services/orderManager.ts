import { logger } from "../lib/logger";
import { db, paperBetsTable } from "@workspace/db";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import {
  isRelayConfigured,
  relayGetBetStatus,
  relayCancelBet,
  relayGetLiquidity,
} from "./vpsRelay";

const FILL_ACCEPT_PCT = 70;
const FILL_WAIT_PCT = 30;
const WAIT_DURATION_MS = 5 * 60 * 1000;
const CANCEL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TICK_CHASE = 2;
const REASSESS_WINDOW_MS = 2 * 60 * 60 * 1000;

export const BETFAIR_TICKS = [
  1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.10,
  1.12, 1.14, 1.16, 1.18, 1.20, 1.22, 1.24, 1.26, 1.28, 1.30,
  1.32, 1.34, 1.36, 1.38, 1.40, 1.42, 1.44, 1.46, 1.48, 1.50,
  1.52, 1.54, 1.56, 1.58, 1.60, 1.62, 1.64, 1.66, 1.68, 1.70,
  1.72, 1.74, 1.76, 1.78, 1.80, 1.82, 1.84, 1.86, 1.88, 1.90,
  1.92, 1.94, 1.96, 1.98, 2.00,
  2.02, 2.04, 2.06, 2.08, 2.10, 2.12, 2.14, 2.16, 2.18, 2.20,
  2.22, 2.24, 2.26, 2.28, 2.30, 2.32, 2.34, 2.36, 2.38, 2.40,
  2.42, 2.44, 2.46, 2.48, 2.50,
  2.52, 2.54, 2.56, 2.58, 2.60, 2.62, 2.64, 2.66, 2.68, 2.70,
  2.72, 2.74, 2.76, 2.78, 2.80, 2.82, 2.84, 2.86, 2.88, 2.90,
  2.92, 2.94, 2.96, 2.98, 3.00,
  3.05, 3.10, 3.15, 3.20, 3.25, 3.30, 3.35, 3.40, 3.45, 3.50,
  3.55, 3.60, 3.65, 3.70, 3.75, 3.80, 3.85, 3.90, 3.95, 4.00,
  4.10, 4.20, 4.30, 4.40, 4.50, 4.60, 4.70, 4.80, 4.90, 5.00,
  5.10, 5.20, 5.30, 5.40, 5.50, 5.60, 5.70, 5.80, 5.90, 6.00,
  6.20, 6.40, 6.60, 6.80, 7.00, 7.20, 7.40, 7.60, 7.80, 8.00,
  8.50, 9.00, 9.50, 10.0, 10.5, 11.0, 11.5, 12.0, 12.5, 13.0,
  13.5, 14.0, 14.5, 15.0, 15.5, 16.0, 16.5, 17.0, 17.5, 18.0,
  18.5, 19.0, 19.5, 20.0,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  32, 34, 36, 38, 40, 42, 44, 46, 48, 50,
  55, 60, 65, 70, 75, 80, 85, 90, 95, 100,
  110, 120, 130, 140, 150, 160, 170, 180, 190, 200,
  210, 220, 230, 240, 250, 260, 270, 280, 290, 300,
  310, 320, 330, 340, 350, 360, 370, 380, 390, 400,
  410, 420, 430, 440, 450, 460, 470, 480, 490, 500,
  510, 520, 530, 540, 550, 560, 570, 580, 590, 600,
  610, 620, 630, 640, 650, 660, 670, 680, 690, 700,
  710, 720, 730, 740, 750, 760, 770, 780, 790, 800,
  810, 820, 830, 840, 850, 860, 870, 880, 890, 900,
  910, 920, 930, 940, 950, 960, 970, 980, 990, 1000,
];

export function ticksAway(price1: number, price2: number): number {
  const idx1 = findTickIndex(price1);
  const idx2 = findTickIndex(price2);
  if (idx1 === -1 || idx2 === -1) return Infinity;
  return Math.abs(idx1 - idx2);
}

export function findTickIndex(price: number): number {
  for (let i = 0; i < BETFAIR_TICKS.length; i++) {
    if (Math.abs(BETFAIR_TICKS[i] - price) < 0.001) return i;
  }
  let closest = 0;
  let minDiff = Math.abs(BETFAIR_TICKS[0] - price);
  for (let i = 1; i < BETFAIR_TICKS.length; i++) {
    const diff = Math.abs(BETFAIR_TICKS[i] - price);
    if (diff < minDiff) {
      minDiff = diff;
      closest = i;
    }
  }
  return closest;
}

export function getTicksWithin(targetPrice: number, tickCount: number): { min: number; max: number } {
  const idx = findTickIndex(targetPrice);
  const minIdx = Math.max(0, idx - tickCount);
  const maxIdx = Math.min(BETFAIR_TICKS.length - 1, idx + tickCount);
  return { min: BETFAIR_TICKS[minIdx], max: BETFAIR_TICKS[maxIdx] };
}

async function tryCancelAndVerify(betfairBetId: string): Promise<{ cancelled: boolean; error?: string }> {
  try {
    const result = await relayCancelBet(betfairBetId);
    if (result.cancelled) return { cancelled: true };
    return { cancelled: false, error: result.error ?? result.reason ?? "cancel returned false" };
  } catch (err) {
    return { cancelled: false, error: String(err) };
  }
}

async function acceptPartialAndCancel(
  betId: number,
  betfairBetId: string,
  sizeMatched: number,
  avgPriceMatched: number,
  statusLabel: string,
): Promise<boolean> {
  const cancelResult = await tryCancelAndVerify(betfairBetId);
  if (!cancelResult.cancelled) {
    logger.warn(
      { betfairBetId, error: cancelResult.error },
      "Cancel failed — will re-check next cycle",
    );
    return false;
  }

  await db.update(paperBetsTable).set({
    betfairStatus: statusLabel,
    betfairSizeMatched: String(sizeMatched),
    betfairAvgPriceMatched: String(avgPriceMatched),
    stake: String(sizeMatched),
  }).where(eq(paperBetsTable.id, betId));
  return true;
}

export async function runOrderManagement(): Promise<{
  checked: number;
  accepted: number;
  cancelled: number;
  resubmitted: number;
}> {
  if (!isRelayConfigured()) {
    return { checked: 0, accepted: 0, cancelled: 0, resubmitted: 0 };
  }

  const liveBets = await db
    .select()
    .from(paperBetsTable)
    .where(
      and(
        eq(paperBetsTable.status, "pending"),
        isNotNull(paperBetsTable.betfairBetId),
        sql`${paperBetsTable.betfairStatus} IN ('EXECUTABLE', 'PARTIALLY_MATCHED')`,
      ),
    );

  if (liveBets.length === 0) {
    return { checked: 0, accepted: 0, cancelled: 0, resubmitted: 0 };
  }

  let accepted = 0;
  let cancelled = 0;
  let resubmitted = 0;

  for (const bet of liveBets) {
    try {
      const betfairBetId = bet.betfairBetId!;
      const status = await relayGetBetStatus(betfairBetId);

      if (!status) {
        logger.warn(
          { betfairBetId, betId: bet.id },
          "Bet status 404 from relay — marking for manual review",
        );
        await db.update(paperBetsTable).set({
          betfairStatus: "STATUS_UNKNOWN",
        }).where(eq(paperBetsTable.id, bet.id));
        continue;
      }

      const placedAt = bet.betfairPlacedAt ? new Date(bet.betfairPlacedAt).getTime() : (bet.placedAt ? new Date(bet.placedAt).getTime() : Date.now());
      const elapsed = Date.now() - placedAt;
      const fillPct = status.fillPct;
      const hasMatchedPortion = status.sizeMatched > 0;

      if (status.status === "EXECUTION_COMPLETE") {
        logger.info(
          { betId: betfairBetId, sizeMatched: status.sizeMatched },
          "Order fully matched",
        );
        await db.update(paperBetsTable).set({
          betfairStatus: "MATCHED",
          betfairSizeMatched: String(status.sizeMatched),
          betfairAvgPriceMatched: String(status.averagePriceMatched),
        }).where(eq(paperBetsTable.id, bet.id));
        accepted++;
        continue;
      }

      if (fillPct >= FILL_ACCEPT_PCT) {
        logger.info(
          { betId: betfairBetId, fillPct, sizeMatched: status.sizeMatched },
          "Order >70% filled — accepting partial, cancelling remainder",
        );
        if (await acceptPartialAndCancel(bet.id, betfairBetId, status.sizeMatched, status.averagePriceMatched, "PARTIAL_ACCEPTED")) {
          accepted++;
        }
        continue;
      }

      if (fillPct >= FILL_WAIT_PCT && elapsed < WAIT_DURATION_MS) {
        logger.debug(
          { betId: betfairBetId, fillPct, elapsedMs: elapsed },
          "Order 30-70% filled — waiting for more matches",
        );
        continue;
      }

      if (fillPct >= FILL_WAIT_PCT && elapsed >= WAIT_DURATION_MS) {
        logger.info(
          { betId: betfairBetId, fillPct, sizeMatched: status.sizeMatched },
          "Order 30-70% filled, wait expired — accepting matched portion",
        );
        if (await acceptPartialAndCancel(bet.id, betfairBetId, status.sizeMatched, status.averagePriceMatched, "PARTIAL_ACCEPTED")) {
          accepted++;
        }
        continue;
      }

      if (fillPct < FILL_WAIT_PCT && elapsed >= CANCEL_TIMEOUT_MS) {
        logger.info(
          { betId: betfairBetId, fillPct, elapsedMs: elapsed, hasMatchedPortion },
          "Order <30% filled after 10 minutes — cancelling",
        );
        const cancelResult = await tryCancelAndVerify(betfairBetId);
        if (!cancelResult.cancelled) {
          logger.warn({ betfairBetId, error: cancelResult.error }, "Cancel failed for low-fill — will retry next cycle");
          continue;
        }

        if (hasMatchedPortion) {
          await db.update(paperBetsTable).set({
            betfairStatus: "PARTIAL_ACCEPTED",
            betfairSizeMatched: String(status.sizeMatched),
            betfairAvgPriceMatched: String(status.averagePriceMatched),
            stake: String(status.sizeMatched),
          }).where(eq(paperBetsTable.id, bet.id));
          accepted++;
        } else {
          await db.update(paperBetsTable).set({
            betfairStatus: "CANCELLED_LOW_FILL",
            status: "void",
          }).where(eq(paperBetsTable.id, bet.id));
          cancelled++;
        }
        continue;
      }

      const matchKickoff = bet.matchId
        ? await db.execute(sql`SELECT kickoff_time FROM matches WHERE id = ${bet.matchId}`)
        : null;
      const kickoffTime = matchKickoff?.rows?.[0]
        ? new Date((matchKickoff.rows[0] as any).kickoff_time).getTime()
        : null;

      if (kickoffTime && kickoffTime - Date.now() < REASSESS_WINDOW_MS && status.sizeRemaining > 0) {
        const targetOdds = Number(bet.oddsAtPlacement);
        const bestBackPrice = await getBestBackPrice(bet, targetOdds);
        const tickDistance = ticksAway(targetOdds, bestBackPrice);

        if (tickDistance <= MAX_TICK_CHASE) {
          logger.debug(
            { betId: betfairBetId, targetOdds, bestBackPrice, tickDistance },
            "Order near kickoff but within tick chase limit — leaving open",
          );
        } else {
          logger.info(
            { betId: betfairBetId, targetOdds, bestBackPrice, tickDistance, kickoffIn: Math.round((kickoffTime - Date.now()) / 60000) + "min" },
            "Unmatched order near kickoff — cancelling (exceeds 2-tick chase limit)",
          );
          const cancelResult = await tryCancelAndVerify(betfairBetId);
          if (!cancelResult.cancelled) {
            logger.warn({ betfairBetId, error: cancelResult.error }, "Cancel failed near kickoff — will retry next cycle");
            continue;
          }

          if (hasMatchedPortion) {
            await db.update(paperBetsTable).set({
              betfairStatus: "PARTIAL_NEAR_KICKOFF",
              betfairSizeMatched: String(status.sizeMatched),
              betfairAvgPriceMatched: String(status.averagePriceMatched),
              stake: String(status.sizeMatched),
            }).where(eq(paperBetsTable.id, bet.id));
            accepted++;
          } else {
            await db.update(paperBetsTable).set({
              betfairStatus: "CANCELLED_NEAR_KICKOFF",
              status: "void",
            }).where(eq(paperBetsTable.id, bet.id));
            cancelled++;
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err, betId: bet.betfairBetId },
        "Order management check failed for bet",
      );
    }
  }

  if (accepted > 0 || cancelled > 0 || resubmitted > 0) {
    logger.info(
      { checked: liveBets.length, accepted, cancelled, resubmitted },
      "Order management cycle complete",
    );
  }

  return { checked: liveBets.length, accepted, cancelled, resubmitted };
}

async function getBestBackPrice(bet: any, fallbackOdds: number): Promise<number> {
  try {
    if (!bet.betfairMarketId) return fallbackOdds;

    const liquidity = await relayGetLiquidity(bet.betfairMarketId);
    if (!liquidity?.runners?.length) return fallbackOdds;

    const runner = liquidity.runners[0];
    const bestBack = runner.backPrices?.[0]?.price;
    return bestBack ?? fallbackOdds;
  } catch {
    return fallbackOdds;
  }
}
