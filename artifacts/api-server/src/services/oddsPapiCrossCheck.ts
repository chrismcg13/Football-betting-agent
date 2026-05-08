import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * AF-vs-OddsPapi Pinnacle cross-check (2026-05-08 maximisation bundle).
 *
 * Two independent sources for the same Pinnacle prices: api_football_real:
 * Pinnacle (AF's bookmaker integration) and oddspapi_pinnacle (OddsPapi's
 * Pinnacle scrape). When they disagree by >5% on the same (match, market,
 * selection) within the same 30-min window, that's a data-quality signal —
 * one source is stale, has a parsing bug, or is showing a different line
 * (e.g. handicap mid-shift).
 *
 * Without this check, we'd silently use whichever source the closing-line
 * cron picks first, even when the other source disagrees — potentially
 * computing CLV against a stale price.
 *
 * Hourly cron. Logs disagreements to pinnacle_source_disagreements with
 * context, raises medium-severity data_quality_alerts when more than
 * 0.5% of fixtures disagree (systemic issue) or any single fixture
 * disagrees by >15% (likely a bug, not just timing).
 */

const DISAGREEMENT_THRESHOLD_PCT = 5.0;
const SYSTEMIC_ALERT_RATE = 0.005;
const ABERRANT_THRESHOLD_PCT = 15.0;

interface CrossCheckResult {
  evaluatedAt: string;
  pairsScanned: number;
  disagreements: number;
  aberrantDisagreements: number;
  alertsRaised: number;
}

export async function runOddsPapiCrossCheck(): Promise<CrossCheckResult> {
  const evaluatedAt = new Date().toISOString();

  // Find (match, market, selection) tuples that have BOTH a recent AF
  // Pinnacle snapshot AND a recent OddsPapi Pinnacle snapshot. We compare
  // the most recent of each within the same 30-min window so timing
  // skew is bounded.
  const pairs = (await db.execute(sql`
    WITH af_latest AS (
      SELECT match_id, market_type, selection_name,
             back_odds::float8 AS odds, snapshot_time,
             ROW_NUMBER() OVER (PARTITION BY match_id, market_type, selection_name ORDER BY snapshot_time DESC) AS rn
      FROM odds_snapshots
      WHERE source = 'api_football_real:Pinnacle'
        AND snapshot_time > NOW() - INTERVAL '2 hours'
    ),
    op_latest AS (
      SELECT match_id, market_type, selection_name,
             back_odds::float8 AS odds, snapshot_time,
             ROW_NUMBER() OVER (PARTITION BY match_id, market_type, selection_name ORDER BY snapshot_time DESC) AS rn
      FROM odds_snapshots
      WHERE source = 'oddspapi_pinnacle'
        AND snapshot_time > NOW() - INTERVAL '2 hours'
    )
    SELECT
      af.match_id, af.market_type, af.selection_name,
      af.odds AS af_odds, af.snapshot_time::text AS af_at,
      op.odds AS op_odds, op.snapshot_time::text AS op_at
    FROM af_latest af
    JOIN op_latest op
      ON af.match_id = op.match_id
     AND af.market_type = op.market_type
     AND af.selection_name = op.selection_name
    WHERE af.rn = 1 AND op.rn = 1
      AND ABS(EXTRACT(EPOCH FROM (af.snapshot_time - op.snapshot_time))) <= 1800
  `)) as unknown as {
    rows: Array<{
      match_id: number;
      market_type: string;
      selection_name: string;
      af_odds: number;
      af_at: string;
      op_odds: number;
      op_at: string;
    }>;
  };

  let disagreements = 0;
  let aberrantDisagreements = 0;
  let alertsRaised = 0;

  for (const row of pairs.rows) {
    if (!row.af_odds || !row.op_odds || row.af_odds <= 1 || row.op_odds <= 1) continue;

    const diffPct = (Math.abs(row.af_odds - row.op_odds) / Math.min(row.af_odds, row.op_odds)) * 100;
    if (diffPct < DISAGREEMENT_THRESHOLD_PCT) continue;

    disagreements++;
    if (diffPct >= ABERRANT_THRESHOLD_PCT) aberrantDisagreements++;

    await db.execute(sql`
      INSERT INTO pinnacle_source_disagreements (
        match_id, market_type, selection_name,
        af_odds, oddspapi_odds, diff_pct,
        af_snapshot_at, oddspapi_snapshot_at, detected_at
      ) VALUES (
        ${row.match_id}, ${row.market_type}, ${row.selection_name},
        ${row.af_odds}, ${row.op_odds}, ${diffPct},
        ${row.af_at}::timestamptz, ${row.op_at}::timestamptz, NOW()
      )
    `);

    if (diffPct >= ABERRANT_THRESHOLD_PCT) {
      logger.warn(
        {
          matchId: row.match_id, marketType: row.market_type, selectionName: row.selection_name,
          afOdds: row.af_odds, oddspapiOdds: row.op_odds, diffPct: diffPct.toFixed(2),
        },
        "Aberrant Pinnacle source disagreement (>15%) — likely parser bug or stale source",
      );

      await db.execute(sql`
        INSERT INTO data_quality_alerts (source, severity, title, detected_at, details)
        VALUES (
          'pinnacle_cross_check', 'medium',
          ${`Aberrant Pinnacle disagreement on match ${row.match_id} ${row.market_type}:${row.selection_name} (${diffPct.toFixed(1)}%)`},
          NOW(),
          ${JSON.stringify({
            matchId: row.match_id, marketType: row.market_type, selectionName: row.selection_name,
            afOdds: row.af_odds, oddspapiOdds: row.op_odds, diffPct,
          })}::jsonb
        )
      `);
      alertsRaised++;
    }
  }

  // Systemic-rate alert: if disagreement rate exceeds threshold, raise once
  if (pairs.rows.length > 0) {
    const rate = disagreements / pairs.rows.length;
    if (rate >= SYSTEMIC_ALERT_RATE && disagreements >= 5) {
      await db.execute(sql`
        INSERT INTO data_quality_alerts (source, severity, title, detected_at, details)
        VALUES (
          'pinnacle_cross_check', 'high',
          ${`Systemic Pinnacle source disagreement rate: ${(rate * 100).toFixed(2)}% across ${pairs.rows.length} pairs`},
          NOW(),
          ${JSON.stringify({ disagreements, pairsScanned: pairs.rows.length, rate, aberrantDisagreements })}::jsonb
        )
        ON CONFLICT DO NOTHING
      `);
      alertsRaised++;
    }
  }

  logger.info(
    { pairsScanned: pairs.rows.length, disagreements, aberrantDisagreements, alertsRaised, evaluatedAt },
    "Pinnacle source cross-check complete",
  );

  return {
    evaluatedAt,
    pairsScanned: pairs.rows.length,
    disagreements,
    aberrantDisagreements,
    alertsRaised,
  };
}
