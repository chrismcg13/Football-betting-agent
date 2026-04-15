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
  { key: "min_opportunity_score", value: "50" },
  { key: "cold_market_threshold", value: "-10" },
  { key: "cold_market_min_bets", value: "10" },
  { key: "cold_market_cooldown_days", value: "14" },
  { key: "hot_streak_weeks", value: "3" },
  { key: "hot_streak_min_bets_per_week", value: "5" },
  { key: "hot_streak_bonus", value: "15" },
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
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS opportunity_score NUMERIC(6,2)
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

    // ── One-time cleanup: remove synthetic test bets that were generated
    //    during early development (odds exactly 2.1721, selection "Home").
    //    Safe to run repeatedly — no-op once already cleaned.
    const cleaned = await db.execute(sql`
      DELETE FROM paper_bets
      WHERE ABS(odds_at_placement - 2.1721) < 0.0001
        AND selection_name = 'Home'
        AND market_type = 'MATCH_ODDS'
    `);
    const deletedCount = (cleaned as any).rowCount ?? 0;
    if (deletedCount > 0) {
      logger.info({ deletedCount }, "Startup cleanup: removed synthetic 2.1721 test bets");
    }

    // ── Ensure bankroll is set to 500 (reset if it was never updated from the default)
    await db.execute(sql`
      UPDATE agent_config SET value = '500', updated_at = NOW()
      WHERE key = 'bankroll' AND value::numeric < 500
    `);

    // ── Set min_opportunity_score floor — raised to 58 after 73 settled bets collected.
    //    Only applies as default seed; manual config updates take precedence.
    await db.execute(sql`
      INSERT INTO agent_config (key, value, updated_at)
      VALUES ('min_opportunity_score', '58', NOW())
      ON CONFLICT (key) DO UPDATE SET value = '58', updated_at = NOW()
    `);

    await db.execute(sql`
      INSERT INTO agent_config (key, value, updated_at)
      VALUES ('live_opp_score_threshold', '68', NOW())
      ON CONFLICT (key) DO NOTHING
    `);

    // ── xG data layer tables (additive — do not modify existing tables)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS xg_match_data (
        id TEXT PRIMARY KEY,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        league TEXT NOT NULL,
        season TEXT NOT NULL,
        match_date TEXT NOT NULL,
        home_xg REAL,
        away_xg REAL,
        home_goals INTEGER,
        away_goals INTEGER,
        is_result BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_xg_rolling (
        id SERIAL PRIMARY KEY,
        team_name TEXT NOT NULL,
        league TEXT NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        xg_for_5 REAL,
        xg_against_5 REAL,
        xg_diff_5 REAL,
        goals_vs_xg_diff REAL,
        xg_momentum REAL,
        matches_counted INTEGER
      )
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_team_xg_rolling_team
        ON team_xg_rolling(team_name, computed_at DESC)
    `);

    // ── Add API fixture ID and stats columns to matches (idempotent) ───────
    await db.execute(sql`
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS api_fixture_id INTEGER,
        ADD COLUMN IF NOT EXISTS total_corners INTEGER,
        ADD COLUMN IF NOT EXISTS total_cards INTEGER
    `);

    // ── Pinnacle closing-line CLV column (added for professional-grade CLV) ──
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS closing_pinnacle_odds NUMERIC(10,4)
    `);

    // ── Pinnacle upgrade compliance log (idempotent — only logs once) ────────
    const upgradeLogged = await db.execute(sql`
      SELECT 1 FROM compliance_logs
      WHERE action_type = 'pinnacle_upgrade_active'
      LIMIT 1
    `);
    if (((upgradeLogged as any).rowCount ?? 0) === 0) {
      await db.execute(sql`
        INSERT INTO compliance_logs (action_type, details, timestamp)
        VALUES (
          'pinnacle_upgrade_active',
          '{"message": "Pinnacle upgrade: full validation active, 5000 req/month, CLV now uses Pinnacle closing line. Daily cap: 150, monthly cap: 4800. All candidates validated regardless of league tier or fixture window.", "dailyCap": 150, "monthlyCap": 4800, "clvSource": "pinnacle_closing_line"}',
          NOW()
        )
      `);
      logger.info("Pinnacle upgrade compliance log written");
    }

    // ── Experiment pipeline: new columns on paper_bets ──────────────────
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS data_tier TEXT NOT NULL DEFAULT 'experiment',
        ADD COLUMN IF NOT EXISTS experiment_tag TEXT,
        ADD COLUMN IF NOT EXISTS opportunity_boosted BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS original_opportunity_score REAL,
        ADD COLUMN IF NOT EXISTS boosted_opportunity_score REAL,
        ADD COLUMN IF NOT EXISTS sync_eligible BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS promotion_audit_id TEXT
    `);

    // ── Experiment registry table ────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS experiment_registry (
        id TEXT PRIMARY KEY,
        experiment_tag TEXT NOT NULL,
        league_code TEXT,
        market_type TEXT,
        data_tier TEXT NOT NULL DEFAULT 'experiment',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tier_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        current_sample_size INTEGER NOT NULL DEFAULT 0,
        current_roi REAL,
        current_clv REAL,
        current_win_rate REAL,
        current_p_value REAL,
        current_edge REAL,
        consecutive_negative_weeks INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      )
    `);

    // ── Promotion audit log ──────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS promotion_audit_log (
        id TEXT PRIMARY KEY,
        experiment_tag TEXT NOT NULL,
        previous_tier TEXT NOT NULL,
        new_tier TEXT NOT NULL,
        decision_reason TEXT NOT NULL,
        metrics_snapshot JSONB,
        thresholds_used JSONB,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_by TEXT NOT NULL DEFAULT 'auto_promotion_engine'
      )
    `);

    // ── Experiment learning journal ──────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS experiment_learning_journal (
        id TEXT PRIMARY KEY,
        analysis_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        experiment_tag TEXT,
        analysis_type TEXT NOT NULL,
        findings JSONB,
        recommendations JSONB,
        actions_taken JSONB
      )
    `);

    // ── Index for experiment lookups ─────────────────────────────────────
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_paper_bets_experiment_tag
        ON paper_bets(experiment_tag)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_paper_bets_data_tier
        ON paper_bets(data_tier)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_paper_bets_sync_eligible
        ON paper_bets(sync_eligible) WHERE sync_eligible = true
    `);

    // ── Competition config table (expansion to 200+ competitions) ─────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS competition_config (
        id SERIAL PRIMARY KEY,
        api_football_id INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'league',
        gender TEXT NOT NULL DEFAULT 'male',
        tier INTEGER NOT NULL DEFAULT 3,
        is_active BOOLEAN NOT NULL DEFAULT false,
        has_statistics BOOLEAN NOT NULL DEFAULT false,
        has_lineups BOOLEAN NOT NULL DEFAULT false,
        has_odds BOOLEAN NOT NULL DEFAULT false,
        has_events BOOLEAN NOT NULL DEFAULT false,
        has_pinnacle_odds BOOLEAN NOT NULL DEFAULT false,
        seasonal_start TEXT,
        seasonal_end TEXT,
        current_season INTEGER,
        polling_frequency TEXT NOT NULL DEFAULT 'dormant',
        last_polled_at TIMESTAMPTZ,
        total_api_calls_used INTEGER NOT NULL DEFAULT 0,
        fixture_count INTEGER NOT NULL DEFAULT 0,
        coverage_checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_competition_config_tier
        ON competition_config(tier)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_competition_config_active
        ON competition_config(is_active) WHERE is_active = true
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_competition_config_polling
        ON competition_config(polling_frequency)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS drawdown_events (
        id SERIAL PRIMARY KEY,
        environment TEXT NOT NULL DEFAULT 'development',
        event_type TEXT NOT NULL,
        high_water_mark NUMERIC NOT NULL,
        current_bankroll NUMERIC NOT NULL,
        drawdown_pct NUMERIC NOT NULL,
        limit_pct NUMERIC NOT NULL,
        would_have_triggered TEXT NOT NULL DEFAULT 'false',
        details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_drawdown_events_env_created
        ON drawdown_events(environment, created_at DESC)
    `);

    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS betfair_bet_id TEXT,
        ADD COLUMN IF NOT EXISTS betfair_market_id TEXT,
        ADD COLUMN IF NOT EXISTS betfair_status TEXT,
        ADD COLUMN IF NOT EXISTS betfair_size_matched NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS betfair_avg_price_matched NUMERIC(10,4),
        ADD COLUMN IF NOT EXISTS betfair_placed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS betfair_settled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS betfair_pnl NUMERIC(12,2)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_paper_bets_betfair_bet_id
        ON paper_bets(betfair_bet_id) WHERE betfair_bet_id IS NOT NULL
    `);

    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS live_tier TEXT
    `);

    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS pinnacle_edge_category TEXT,
        ADD COLUMN IF NOT EXISTS line_direction TEXT,
        ADD COLUMN IF NOT EXISTS pinnacle_snapshot_count INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS clv_data_quality TEXT DEFAULT 'incomplete'
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pinnacle_odds_snapshots (
        id SERIAL PRIMARY KEY,
        bet_id INTEGER REFERENCES paper_bets(id),
        match_id INTEGER NOT NULL REFERENCES matches(id),
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        snapshot_type TEXT NOT NULL,
        pinnacle_odds NUMERIC(10,4) NOT NULL,
        pinnacle_implied NUMERIC(8,6),
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_pinnacle_snapshots_bet
        ON pinnacle_odds_snapshots(bet_id) WHERE bet_id IS NOT NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_pinnacle_snapshots_match
        ON pinnacle_odds_snapshots(match_id, market_type, selection_name)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS line_movements (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        bookmaker TEXT NOT NULL DEFAULT 'pinnacle',
        odds NUMERIC(10,4) NOT NULL,
        implied_prob NUMERIC(8,6),
        previous_odds NUMERIC(10,4),
        movement_pct NUMERIC(8,4),
        is_sharp_movement BOOLEAN NOT NULL DEFAULT false,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_line_movements_match
        ON line_movements(match_id, market_type, selection_name, captured_at DESC)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS filtered_bets (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        model_prob NUMERIC(8,6) NOT NULL,
        pinnacle_implied NUMERIC(8,6) NOT NULL,
        pinnacle_odds NUMERIC(10,4),
        edge_pct NUMERIC(8,4) NOT NULL,
        filter_reason TEXT NOT NULL,
        model_odds NUMERIC(10,4),
        market_odds NUMERIC(10,4),
        opportunity_score NUMERIC(6,2),
        league TEXT,
        actual_outcome TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_filtered_bets_match
        ON filtered_bets(match_id)
    `);

    await db.execute(sql`
      UPDATE paper_bets SET clv_data_quality = 'incomplete'
      WHERE status IN ('won', 'lost') AND clv_pct IS NULL AND clv_data_quality IS NULL
    `);
    await db.execute(sql`
      UPDATE paper_bets SET clv_data_quality = 'partial'
      WHERE status IN ('won', 'lost') AND clv_pct IS NOT NULL AND closing_pinnacle_odds IS NULL AND clv_data_quality IS NULL
    `);
    await db.execute(sql`
      UPDATE paper_bets SET clv_data_quality = 'complete'
      WHERE status IN ('won', 'lost') AND closing_pinnacle_odds IS NOT NULL AND clv_data_quality IS NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_paper_bets_live_tier
        ON paper_bets(live_tier) WHERE live_tier IS NOT NULL
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS data_richness_cache (
        id SERIAL PRIMARY KEY,
        league TEXT NOT NULL,
        country TEXT NOT NULL,
        market_type TEXT NOT NULL,
        pinnacle_coverage_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
        api_football_depth INTEGER NOT NULL DEFAULT 0,
        has_statistics BOOLEAN NOT NULL DEFAULT false,
        has_lineups BOOLEAN NOT NULL DEFAULT false,
        has_events BOOLEAN NOT NULL DEFAULT false,
        fixture_frequency NUMERIC(8,2) NOT NULL DEFAULT 0,
        overall_score NUMERIC(5,2) NOT NULL DEFAULT 0,
        tier1_eligible BOOLEAN NOT NULL DEFAULT false,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(league, country, market_type)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_data_richness_tier1
        ON data_richness_cache(tier1_eligible) WHERE tier1_eligible = true
    `);

    logger.info("Migrations complete");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  }
}
