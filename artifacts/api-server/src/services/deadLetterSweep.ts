import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { listRegisteredMarketTypes } from "../lib/marketTypes";

/**
 * Dead-letter sweep + registry-completeness check (Lever 2 of the
 * 2026-05-08 maximisation bundle).
 *
 * Two distinct failure modes this catches:
 *
 *   1. Market-type registry drift. A new market type starts being placed
 *      (valueDetection generates it) but determineBetWon's switch lacks
 *      a case → bets settle at status='pending' forever. We caught this
 *      on 2026-05-08 with TEAM_TOTAL_* (285 stuck) but only because a
 *      human noticed. This cron runs daily and writes a data_quality_alert
 *      row whenever a market type appears in paper_bets that the registry
 *      doesn't recognise.
 *
 *   2. Settlement attempt exhaustion. Bets where the match has finished
 *      but the bet hasn't settled despite >50 attempts. These are
 *      typically a parser/resolver bug, an external data source missing
 *      stats, or a status-code mismatch between Sports Monks fixtures
 *      and our internal state. Auto-void after 50 attempts + 7d post-
 *      kickoff, and write an alert.
 *
 * Distinct from the existing startup invariant (verifyMarketTypeRegistryCoverage):
 *   - Startup runs once at boot. This runs daily and persists alerts.
 *   - Startup logs at info/warn. This persists to data_quality_alerts so
 *     the operator dashboard surfaces the gap until acknowledged.
 */

interface SweepResult {
  evaluatedAt: string;
  registryDrift: {
    missingMarketTypes: string[];
    counts: Array<{ marketType: string; count: number }>;
  };
  deadLetterStuck: {
    count: number;
    byMarket: Array<{ marketType: string; count: number; oldestPlaced: string }>;
  };
  autoVoided: number;
  alertsRaised: number;
}

const STUCK_ATTEMPTS_THRESHOLD = 50;
const STUCK_AGE_DAYS = 7;

export async function runDeadLetterSweep(): Promise<SweepResult> {
  const evaluatedAt = new Date().toISOString();
  let alertsRaised = 0;

  // ── (1) Registry drift ────────────────────────────────────────────────────
  const registered = new Set(listRegisteredMarketTypes());
  const driftRows = (await db.execute(sql`
    SELECT market_type, COUNT(*)::int AS n
    FROM paper_bets
    WHERE deleted_at IS NULL AND legacy_regime = false
    GROUP BY market_type
  `)) as unknown as { rows: Array<{ market_type: string; n: number }> };

  const driftCounts = driftRows.rows
    .filter((r) => !registered.has(r.market_type))
    .map((r) => ({ marketType: r.market_type, count: r.n }));

  const missingMarketTypes = driftCounts.map((c) => c.marketType);

  if (missingMarketTypes.length > 0) {
    logger.warn(
      { missingMarketTypes, counts: driftCounts },
      "Dead-letter sweep: market-type registry drift detected",
    );
    await db.execute(sql`
      INSERT INTO data_quality_alerts (
        source, severity, title, detected_at, details
      ) VALUES (
        'dead_letter_sweep', 'high',
        ${`Market-type registry drift — ${missingMarketTypes.length} unregistered types`},
        NOW(),
        ${JSON.stringify({ missingMarketTypes, counts: driftCounts })}::jsonb
      )
      ON CONFLICT DO NOTHING
    `);
    alertsRaised++;
  } else {
    logger.info("Dead-letter sweep: registry coverage clean");
  }

  // ── (2) Stuck-pending bets (match finished, not settled, >50 attempts) ────
  const stuckRows = (await db.execute(sql`
    SELECT pb.market_type AS market_type, COUNT(*)::int AS n,
           MIN(pb.placed_at)::text AS oldest_placed
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status = 'pending'
      AND pb.deleted_at IS NULL
      AND m.status IN ('finished','postponed','cancelled')
      AND pb.settlement_attempts >= ${STUCK_ATTEMPTS_THRESHOLD}
      AND pb.placed_at < NOW() - INTERVAL '${sql.raw(String(STUCK_AGE_DAYS))} days'
    GROUP BY pb.market_type
    ORDER BY COUNT(*) DESC
  `)) as unknown as {
    rows: Array<{ market_type: string; n: number; oldest_placed: string }>;
  };

  const byMarket = stuckRows.rows.map((r) => ({
    marketType: r.market_type,
    count: r.n,
    oldestPlaced: r.oldest_placed,
  }));
  const totalStuck = byMarket.reduce((s, m) => s + m.count, 0);

  // Auto-void: postponed/cancelled matches always void; finished matches with
  // exhausted attempts also void (the data-side bug isn't going to self-heal).
  let autoVoided = 0;
  if (totalStuck > 0) {
    const result = (await db.execute(sql`
      UPDATE paper_bets pb
      SET status = 'void',
          settled_at = NOW(),
          settlement_pnl = '0',
          gross_pnl = '0',
          net_pnl = '0',
          betfair_status = COALESCE(betfair_status, '') || ' [auto_voided_dlq]'
      FROM matches m
      WHERE m.id = pb.match_id
        AND pb.status = 'pending'
        AND pb.deleted_at IS NULL
        AND m.status IN ('finished','postponed','cancelled')
        AND pb.settlement_attempts >= ${STUCK_ATTEMPTS_THRESHOLD}
        AND pb.placed_at < NOW() - INTERVAL '${sql.raw(String(STUCK_AGE_DAYS))} days'
    `)) as unknown as { rowCount?: number };
    autoVoided = result.rowCount ?? 0;

    if (autoVoided > 0) {
      logger.warn(
        { autoVoided, byMarket },
        "Dead-letter sweep: auto-voided stuck-pending bets",
      );
      await db.execute(sql`
        INSERT INTO data_quality_alerts (
          source, severity, title, detected_at, details
        ) VALUES (
          'dead_letter_sweep', 'medium',
          ${`Stuck-pending bets auto-voided — ${autoVoided} bets across ${byMarket.length} markets`},
          NOW(),
          ${JSON.stringify({ autoVoided, byMarket, threshold: { attempts: STUCK_ATTEMPTS_THRESHOLD, days: STUCK_AGE_DAYS } })}::jsonb
        )
      `);
      alertsRaised++;

      // Audit log entry — model_decision_audit_log surfaces in the autonomy review pane
      await db.execute(sql`
        INSERT INTO model_decision_audit_log (
          decision_type, subject, prior_state, new_state, reasoning,
          supporting_metrics, review_status
        ) VALUES (
          'dlq_auto_void', 'stuck_pending_bets',
          ${JSON.stringify({ count: totalStuck })}::jsonb,
          ${JSON.stringify({ voided: autoVoided })}::jsonb,
          ${`Auto-voided ${autoVoided} bets stuck >7d post-kickoff with >${STUCK_ATTEMPTS_THRESHOLD} settlement attempts`},
          ${JSON.stringify({ byMarket })}::jsonb,
          'automatic'
        )
      `);
    }
  }

  return {
    evaluatedAt,
    registryDrift: { missingMarketTypes, counts: driftCounts },
    deadLetterStuck: { count: totalStuck, byMarket },
    autoVoided,
    alertsRaised,
  };
}
