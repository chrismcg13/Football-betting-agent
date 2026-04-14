import { pool, createPool } from "@workspace/db";
import { logger } from "../lib/logger";

interface SyncResult {
  betsSynced: number;
  betsSkipped: number;
  skippedReasons: Record<string, number>;
  errors: string[];
}

export async function syncDevToProd(): Promise<SyncResult> {
  const devUrl = process.env["DEV_DATABASE_URL"];
  const prodUrl = process.env["DATABASE_URL"];
  const env = process.env["ENVIRONMENT"] ?? "development";

  if (env !== "production") {
    return { betsSynced: 0, betsSkipped: 0, skippedReasons: { not_production: 1 }, errors: ["Sync only runs in production environment"] };
  }

  if (!devUrl || !prodUrl) {
    return { betsSynced: 0, betsSkipped: 0, skippedReasons: {}, errors: ["Missing DEV_DATABASE_URL or DATABASE_URL"] };
  }

  const devPool = createPool(devUrl);
  const result: SyncResult = { betsSynced: 0, betsSkipped: 0, skippedReasons: {}, errors: [] };

  try {
    const devClient = await devPool.connect();
    try {
      const eligibleRows = await devClient.query(`
        SELECT * FROM paper_bets
        WHERE sync_eligible = true
          AND data_tier = 'promoted'
          AND status IN ('won', 'lost')
        ORDER BY placed_at ASC
      `);

      if (eligibleRows.rows.length === 0) {
        logger.info("No eligible bets to sync from dev to prod");
        return result;
      }

      const prodClient = await pool.connect();

      try {
        for (const bet of eligibleRows.rows) {
          if (bet.data_tier !== "promoted") {
            result.betsSkipped++;
            result.skippedReasons["not_promoted"] = (result.skippedReasons["not_promoted"] ?? 0) + 1;
            continue;
          }

          try {
            const existing = await prodClient.query(
              "SELECT id FROM paper_bets WHERE match_id = $1 AND market_type = $2 AND selection_name = $3 AND placed_at = $4",
              [bet.match_id, bet.market_type, bet.selection_name, bet.placed_at]
            );
            if (existing.rows.length > 0) {
              result.betsSkipped++;
              result.skippedReasons["already_exists"] = (result.skippedReasons["already_exists"] ?? 0) + 1;
              continue;
            }

            await prodClient.query(`
              INSERT INTO paper_bets (
                match_id, market_type, selection_name, bet_type, odds_at_placement,
                stake, potential_profit, model_probability, betfair_implied_probability,
                calculated_edge, opportunity_score, model_version, odds_source,
                enhanced_opportunity_score, pinnacle_odds, pinnacle_implied,
                best_odds, best_bookmaker, bet_thesis, is_contrarian,
                closing_odds_proxy, closing_pinnacle_odds, clv_pct,
                status, settlement_pnl, placed_at, settled_at,
                data_tier, experiment_tag, opportunity_boosted,
                original_opportunity_score, boosted_opportunity_score,
                sync_eligible, promoted_at, promotion_audit_id
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
                $26, $27, $28, $29, $30, $31, $32, $33, $34, $35
              )
            `, [
              bet.match_id, bet.market_type, bet.selection_name, bet.bet_type,
              bet.odds_at_placement, bet.stake, bet.potential_profit,
              bet.model_probability, bet.betfair_implied_probability,
              bet.calculated_edge, bet.opportunity_score, bet.model_version,
              bet.odds_source, bet.enhanced_opportunity_score, bet.pinnacle_odds,
              bet.pinnacle_implied, bet.best_odds, bet.best_bookmaker,
              bet.bet_thesis, bet.is_contrarian, bet.closing_odds_proxy,
              bet.closing_pinnacle_odds, bet.clv_pct, bet.status,
              bet.settlement_pnl, bet.placed_at, bet.settled_at,
              bet.data_tier, bet.experiment_tag, bet.opportunity_boosted,
              bet.original_opportunity_score, bet.boosted_opportunity_score,
              bet.sync_eligible, bet.promoted_at, bet.promotion_audit_id,
            ]);
            result.betsSynced++;
          } catch (err) {
            result.errors.push(`Failed to sync bet ${bet.id}: ${(err as Error).message}`);
          }
        }
      } finally {
        prodClient.release();
      }
    } finally {
      devClient.release();
    }
  } catch (err) {
    result.errors.push(`Sync failed: ${(err as Error).message}`);
    logger.error({ err }, "Dev→Prod sync failed");
  } finally {
    await devPool.end();
  }

  logger.info({ synced: result.betsSynced, skipped: result.betsSkipped, errors: result.errors.length }, "Dev→Prod sync complete");
  return result;
}

export async function getSyncStatus(): Promise<{ lastSync: string | null; eligible: number; synced: number }> {
  const env = process.env["ENVIRONMENT"] ?? "development";
  if (env !== "production") {
    const r = await pool.query(
      "SELECT COUNT(*) as cnt FROM paper_bets WHERE sync_eligible = true AND data_tier = 'promoted' AND status IN ('won', 'lost')"
    );
    return {
      lastSync: null,
      eligible: parseInt(r.rows[0]?.cnt ?? "0"),
      synced: 0,
    };
  }

  const devUrl = process.env["DEV_DATABASE_URL"];
  if (!devUrl) return { lastSync: null, eligible: 0, synced: 0 };

  const devPool = createPool(devUrl);
  try {
    const eligible = await devPool.query(
      "SELECT COUNT(*) as cnt FROM paper_bets WHERE sync_eligible = true AND data_tier = 'promoted' AND status IN ('won', 'lost')"
    );
    return {
      lastSync: new Date().toISOString(),
      eligible: parseInt(eligible.rows[0]?.cnt ?? "0"),
      synced: 0,
    };
  } finally {
    await devPool.end();
  }
}
