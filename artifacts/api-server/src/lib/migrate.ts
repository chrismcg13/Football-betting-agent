import { db } from "@workspace/db";
import {
  agentConfigTable,
  matchesTable,
  oddsSnapshotsTable,
  featuresTable,
  paperBetsTable,
  modelStateTable,
  learningNarrativesTable,
  complianceLogsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

const DEFAULT_AGENT_CONFIG: Array<{ key: string; value: string }> = [
  { key: "bankroll", value: "500" },
  { key: "max_stake_pct", value: "0.02" },
  { key: "daily_loss_limit_pct", value: "0.05" },
  { key: "weekly_loss_limit_pct", value: "0.10" },
  { key: "bankroll_floor", value: "200" },
  { key: "max_concurrent_bets", value: "10" },
  { key: "min_edge_threshold", value: "0.03" },
  { key: "agent_status", value: "running" },
];

export async function runMigrations() {
  logger.info("Running startup migrations...");

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        league TEXT NOT NULL,
        country TEXT NOT NULL,
        kickoff_time TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        home_score INTEGER,
        away_score INTEGER,
        betfair_event_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS odds_snapshots (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        back_odds NUMERIC(10,4),
        lay_odds NUMERIC(10,4),
        snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL DEFAULT 'betfair_delayed'
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS features (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        feature_name TEXT NOT NULL,
        feature_value NUMERIC(15,6),
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS paper_bets (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        bet_type TEXT NOT NULL,
        odds_at_placement NUMERIC(10,4) NOT NULL,
        stake NUMERIC(12,2) NOT NULL,
        potential_profit NUMERIC(12,2),
        model_probability NUMERIC(8,6),
        betfair_implied_probability NUMERIC(8,6),
        calculated_edge NUMERIC(8,6),
        model_version TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        settlement_pnl NUMERIC(12,2),
        placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at TIMESTAMPTZ
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS model_state (
        id SERIAL PRIMARY KEY,
        model_version TEXT NOT NULL,
        accuracy_score NUMERIC(8,6),
        calibration_score NUMERIC(8,6),
        total_bets_trained_on INTEGER NOT NULL DEFAULT 0,
        feature_importances JSONB,
        strategy_weights JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS learning_narratives (
        id SERIAL PRIMARY KEY,
        narrative_type TEXT NOT NULL,
        narrative_text TEXT NOT NULL,
        related_data JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS compliance_logs (
        id SERIAL PRIMARY KEY,
        action_type TEXT NOT NULL,
        details JSONB NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS agent_config (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const { key, value } of DEFAULT_AGENT_CONFIG) {
      await db.execute(sql`
        INSERT INTO agent_config (key, value, updated_at)
        VALUES (${key}, ${value}, NOW())
        ON CONFLICT (key) DO NOTHING
      `);
    }

    logger.info("Migrations complete");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  }
}
