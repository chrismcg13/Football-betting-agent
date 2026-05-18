/**
 * Bundle F1 (2026-05-18) — placement_evaluation_queue emitter + evaluator.
 *
 * The 180s Pinnacle freshness window stays. F1's job is to make sure
 * evaluation fires INSIDE that window every time Pinnacle writes a fresh
 * price on a scope that has a pending shadow bet.
 *
 * Why: pre-F1, evaluation happened only on the 5-min lazy promoter tick.
 * Pinnacle's effective inter-write gap is ~2hr p50, ~14hr p95 on most
 * scopes. A write at 14:00:00 ages past 180s by 14:03:00. The lazy
 * promoter at 14:05:00 misses it; the next Pinnacle write is hours later.
 *
 * F1's drain cron runs every 30s. When the queue has an unprocessed
 * row inside the 180s window for a (match × market × selection) with
 * a pending shadow bet AND no recent placement on the scope, the lazy
 * promoter's full gate chain runs on that scope only.
 *
 * Dedupe rule: skip if any LIVE placement on the same scope within
 * `f1_dedupe_window_seconds` (default 180). Allow re-evaluation on
 * new Pinnacle writes within the window so direction-reversal (Bundle
 * 16 / 16.B) can fire on second-look.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

export type PinnacleWriteEvent = {
  matchId: number;
  marketType: string;
  selectionName: string;
  source: string; // "api_football_real:Pinnacle" | "oddspapi_pinnacle"
  capturedAt: Date;
};

/**
 * Best-effort enqueue from a Pinnacle-source writer. Single INSERT, no
 * dedupe at write time (the drain pass handles that). Catches and logs
 * errors so a queue hiccup never blocks the writer's primary insert.
 */
export async function enqueuePinnacleWrite(event: PinnacleWriteEvent): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO placement_evaluation_queue
        (match_id, market_type, selection_name, source, captured_at)
      VALUES (${event.matchId}, ${event.marketType}, ${event.selectionName}, ${event.source}, ${event.capturedAt})
    `);
  } catch (err) {
    // Elevated from debug → warn 2026-05-18 so silent enqueue failures
    // surface in production logs (per Chris feedback after 0-row queue
    // observed despite 1,445 Pinnacle writes in 30 min post-deploy).
    logger.warn({ err: (err as Error)?.message ?? String(err), event }, "Bundle F1 enqueue failed");
  }
}

/**
 * Batched enqueue — used by the writers that produce multiple selections
 * per fixture in one pass. Single INSERT with UNNEST for speed.
 */
export async function enqueuePinnacleWriteBatch(events: PinnacleWriteEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const matchIds = events.map((e) => e.matchId);
    const marketTypes = events.map((e) => e.marketType);
    const selectionNames = events.map((e) => e.selectionName);
    const sources = events.map((e) => e.source);
    const capturedAts = events.map((e) => e.capturedAt.toISOString());
    await db.execute(sql`
      INSERT INTO placement_evaluation_queue
        (match_id, market_type, selection_name, source, captured_at)
      SELECT * FROM UNNEST(
        ${sql.raw(`ARRAY[${matchIds.join(",")}]::bigint[]`)},
        ${sql.raw(`ARRAY[${marketTypes.map((m) => `'${m.replace(/'/g, "''")}'`).join(",")}]::text[]`)},
        ${sql.raw(`ARRAY[${selectionNames.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}]::text[]`)},
        ${sql.raw(`ARRAY[${sources.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}]::text[]`)},
        ${sql.raw(`ARRAY[${capturedAts.map((t) => `'${t}'`).join(",")}]::timestamptz[]`)}
      )
    `);
  } catch (err) {
    logger.warn({ err, count: events.length }, "Bundle F1 batched enqueue failed (non-blocking)");
  }
}

export type ScopeAllowlistEntry = {
  matchId: number;
  marketType: string;
  selectionName: string;
};

/**
 * Drain unprocessed queue rows inside the freshness window. Returns
 * the scopes that need evaluation (after dedupe against recent
 * placements). Each returned scope had a fresh Pinnacle write and no
 * live placement on the same (match × market × selection) within the
 * dedupe window.
 *
 * Side effects:
 * - Marks processed rows with outcome
 * - Returns the list to feed into lazyPromoteShadowToPaper
 */
export async function drainPlacementQueue(opts: {
  freshnessWindowSeconds: number;
  dedupeWindowSeconds: number;
  maxRows?: number;
}): Promise<ScopeAllowlistEntry[]> {
  const max = opts.maxRows ?? 500;
  try {
    // Step 1: pick rows to process. Lock + return in one shot using
    // FOR UPDATE SKIP LOCKED so concurrent drainers don't double-process.
    const picked = await db.execute(sql`
      WITH picked AS (
        SELECT id, match_id, market_type, selection_name, captured_at
        FROM placement_evaluation_queue
        WHERE processed_at IS NULL
          AND captured_at >= NOW() - INTERVAL '1 second' * ${opts.freshnessWindowSeconds}
        ORDER BY captured_at DESC
        LIMIT ${max}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE placement_evaluation_queue q
      SET processed_at = NOW(), outcome = 'picked'
      FROM picked
      WHERE q.id = picked.id
      RETURNING q.id, q.match_id, q.market_type, q.selection_name, q.captured_at
    `) as unknown as {
      rows?: Array<{ id: number; match_id: number; market_type: string; selection_name: string; captured_at: string }>
    };

    const candidates = picked.rows ?? [];
    if (candidates.length === 0) return [];

    // Step 2: drop expired rows (captured_at too old to evaluate even now)
    const expired: number[] = [];
    const fresh = candidates.filter((c) => {
      const ageSec = (Date.now() - new Date(c.captured_at).getTime()) / 1000;
      if (ageSec > opts.freshnessWindowSeconds) {
        expired.push(c.id);
        return false;
      }
      return true;
    });
    if (expired.length > 0) {
      await db.execute(sql`
        UPDATE placement_evaluation_queue
        SET outcome = 'expired_at_drain'
        WHERE id = ANY(${sql.raw(`ARRAY[${expired.join(",")}]::bigint[]`)})
      `);
    }

    if (fresh.length === 0) return [];

    // Step 3: dedupe against recent LIVE placements on same scope
    const allowed: ScopeAllowlistEntry[] = [];
    const dedupeSec = opts.dedupeWindowSeconds;
    for (const c of fresh) {
      try {
        const recent = await db.execute(sql`
          SELECT 1 FROM paper_bets
          WHERE match_id = ${c.match_id}
            AND market_type = ${c.market_type}
            AND selection_name = ${c.selection_name}
            AND bet_track = 'live'
            AND placed_at >= NOW() - INTERVAL '1 second' * ${dedupeSec}
          LIMIT 1
        `) as unknown as { rows?: unknown[] };
        if ((recent.rows ?? []).length > 0) {
          await db.execute(sql`
            UPDATE placement_evaluation_queue
            SET outcome = 'dedupe_recent_placement'
            WHERE id = ${c.id}
          `);
        } else {
          allowed.push({
            matchId: c.match_id,
            marketType: c.market_type,
            selectionName: c.selection_name,
          });
        }
      } catch (err) {
        logger.debug({ err, id: c.id }, "Bundle F1 dedupe check failed — skipping scope");
      }
    }
    return allowed;
  } catch (err) {
    logger.warn({ err }, "Bundle F1 drainPlacementQueue failed");
    return [];
  }
}
