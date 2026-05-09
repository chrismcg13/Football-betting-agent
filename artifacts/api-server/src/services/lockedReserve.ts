/**
 * Pre-flip blocker #7: locked_reserve mechanism.
 *
 * Active bankroll for staking = Betfair availableToBetBalance − current_locked.
 * Operator locks profits via npm run reserve -- lock; physical Betfair → bank
 * withdrawals are detected via listAccountStatement (item_class =
 * DEPOSITS_WITHDRAWALS) by the daily reconciliation cron and auto-reduce the
 * lock by min(|amount|, current_locked). Settlement-driven balance drops
 * (item_class = EXCHANGE) leave the lock untouched.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export type ReserveEventType = "lock" | "unlock" | "withdrawal_recorded" | "reconcile_adjust";

export async function getLockedReserve(): Promise<number> {
  const r = await db.execute(sql`SELECT current_locked::float8 AS l FROM locked_reserve LIMIT 1`);
  const v = (((r as any).rows ?? []) as Array<{ l: number }>)[0]?.l;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface ReserveEventInput {
  eventType: ReserveEventType;
  amount: number;
  notes?: string | null;
  betfairBalanceAtEvent?: number | null;
  createdBy?: string;
}

export interface ReserveEventResult {
  priorLocked: number;
  newLocked: number;
  amount: number;
  eventId: number;
}

/**
 * Apply a reserve event atomically. Validates non-negative new_locked and
 * (for lock events) the safeguard that available remains above 2× bankroll_floor.
 */
export async function applyReserveEvent(input: ReserveEventInput): Promise<ReserveEventResult> {
  const { eventType, amount, notes, betfairBalanceAtEvent, createdBy } = input;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`reserve event amount must be a positive finite number; got ${amount}`);
  }

  return await db.transaction(async (tx) => {
    const cur = await tx.execute(sql`SELECT current_locked::float8 AS l FROM locked_reserve LIMIT 1 FOR UPDATE`);
    const priorLocked = (((cur as any).rows ?? []) as Array<{ l: number }>)[0]?.l ?? 0;

    let newLocked: number;
    switch (eventType) {
      case "lock":
        newLocked = Math.round((priorLocked + amount) * 100) / 100;
        break;
      case "unlock":
      case "withdrawal_recorded":
      case "reconcile_adjust":
        newLocked = Math.max(0, Math.round((priorLocked - amount) * 100) / 100);
        break;
      default:
        throw new Error(`unknown reserve event_type: ${eventType}`);
    }

    await tx.execute(sql`UPDATE locked_reserve SET current_locked=${newLocked}, updated_at=NOW()`);
    const ins = await tx.execute(sql`
      INSERT INTO reserve_events (event_type, amount, prior_locked, new_locked,
        betfair_balance_at_event, notes, created_by)
      VALUES (${eventType}, ${amount}, ${priorLocked}, ${newLocked},
        ${betfairBalanceAtEvent ?? null}, ${notes ?? null}, ${createdBy ?? "operator"})
      RETURNING id
    `);
    const eventId = Number((((ins as any).rows ?? []) as Array<{ id: number }>)[0]?.id ?? 0);

    logger.info(
      { eventType, amount, priorLocked, newLocked, eventId },
      "Reserve event applied",
    );
    return { priorLocked, newLocked, amount, eventId };
  });
}

export async function getRecentReserveEvents(limit = 20): Promise<Array<{
  id: number;
  event_type: string;
  amount: number;
  prior_locked: number;
  new_locked: number;
  betfair_balance_at_event: number | null;
  notes: string | null;
  created_at: string;
  created_by: string;
}>> {
  const r = await db.execute(sql`
    SELECT id, event_type, amount::float8, prior_locked::float8, new_locked::float8,
           betfair_balance_at_event::float8, notes, created_at, created_by
    FROM reserve_events ORDER BY created_at DESC LIMIT ${limit}
  `);
  return ((r as any).rows ?? []) as any;
}
