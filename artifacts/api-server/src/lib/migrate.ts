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

    await db.execute(sql`
      INSERT INTO agent_config (key, value, updated_at)
      VALUES ('min_opportunity_score', '48', NOW())
      ON CONFLICT (key) DO NOTHING
    `);

    await db.execute(sql`
      INSERT INTO agent_config (key, value, updated_at)
      VALUES ('live_opp_score_threshold', '48', NOW())
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

    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS odds_source TEXT DEFAULT 'synthetic',
        ADD COLUMN IF NOT EXISTS enhanced_opportunity_score NUMERIC(6,2),
        ADD COLUMN IF NOT EXISTS pinnacle_odds NUMERIC(10,4),
        ADD COLUMN IF NOT EXISTS pinnacle_implied NUMERIC(8,6),
        ADD COLUMN IF NOT EXISTS best_odds NUMERIC(10,4),
        ADD COLUMN IF NOT EXISTS best_bookmaker TEXT,
        ADD COLUMN IF NOT EXISTS bet_thesis TEXT,
        ADD COLUMN IF NOT EXISTS is_contrarian TEXT DEFAULT 'false',
        ADD COLUMN IF NOT EXISTS closing_odds_proxy NUMERIC(10,4),
        ADD COLUMN IF NOT EXISTS clv_pct NUMERIC(8,4)
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
      CREATE TABLE IF NOT EXISTS liquidity_snapshots (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        betfair_market_id TEXT,
        selection_id INTEGER,
        target_odds NUMERIC(10,4),
        available_at_price NUMERIC(12,2),
        available_within_1_tick NUMERIC(12,2),
        available_within_3_ticks NUMERIC(12,2),
        total_market_volume NUMERIC(14,2),
        desired_stake NUMERIC(10,2),
        liquidity_shortfall NUMERIC(10,2),
        depth_data JSONB,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_liquidity_snapshots_match
        ON liquidity_snapshots(match_id, market_type)
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

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        code TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata JSONB,
        acknowledged BOOLEAN NOT NULL DEFAULT false,
        acknowledged_at TIMESTAMPTZ,
        webhook_sent BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_alerts_severity_ack
        ON alerts(severity, acknowledged)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_alerts_created_at
        ON alerts(created_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_alerts_code
        ON alerts(code)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS cron_executions (
        id SERIAL PRIMARY KEY,
        job_name TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        success BOOLEAN,
        records_processed INTEGER DEFAULT 0,
        error_message TEXT,
        duration_ms INTEGER
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_cron_executions_job_name
        ON cron_executions(job_name, started_at DESC)
    `);

    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    `);
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS settlement_attempts INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_settlement_attempt_at TIMESTAMPTZ
    `);
    // C1: Betfair exchange snapshot capture columns (additive, idempotent)
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS betfair_best_back NUMERIC(10,4),
        ADD COLUMN IF NOT EXISTS betfair_best_back_size NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS betfair_best_lay NUMERIC(10,4),
        ADD COLUMN IF NOT EXISTS betfair_best_lay_size NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS exchange_fetch_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS betfair_selection_id NUMERIC(20,0)
    `);
    // Prompt 5: actionable / fair-value pricing-pipeline columns (additive, idempotent)
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS actionable_price NUMERIC(10,4),
        ADD COLUMN IF NOT EXISTS actionable_source TEXT,
        ADD COLUMN IF NOT EXISTS fair_value_odds NUMERIC(10,4),
        ADD COLUMN IF NOT EXISTS fair_value_source TEXT,
        ADD COLUMN IF NOT EXISTS validator_best_odds NUMERIC(10,4)
    `);
    await db.execute(sql`
      ALTER TABLE compliance_logs
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    `);
    await db.execute(sql`
      ALTER TABLE alerts
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS exchanges (
        id SERIAL PRIMARY KEY,
        exchange_name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT false,
        api_base_url TEXT,
        commission_structure JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      INSERT INTO exchanges (exchange_name, display_name, is_active, api_base_url, commission_structure)
      VALUES (
        'betfair',
        'Betfair Exchange',
        true,
        'https://api.betfair.com/exchange',
        '{"type": "net_winnings", "standard_rate": 0.05, "premium_charge_threshold": 25000, "premium_charge_rate": 0.20, "premium_charge_max_rate": 0.60, "discount_tiers": [{"min_points": 0, "rate": 0.05}, {"min_points": 1000, "rate": 0.04}, {"min_points": 5000, "rate": 0.03}], "notes": "Commission on net market winnings only. Premium Charge applies above £25k lifetime profit."}'
      )
      ON CONFLICT (exchange_name) DO UPDATE SET
        commission_structure = EXCLUDED.commission_structure,
        updated_at = NOW()
    `);

    await db.execute(sql`
      INSERT INTO exchanges (exchange_name, display_name, is_active, api_base_url, commission_structure)
      VALUES
        ('smarkets', 'Smarkets', false, 'https://api.smarkets.com/v3', '{"type": "net_winnings", "standard_rate": 0.02, "notes": "Flat 2% commission on net winnings"}'),
        ('betdaq', 'BETDAQ', false, 'https://api.betdaq.com', '{"type": "net_winnings", "standard_rate": 0.02, "notes": "2% commission, occasionally 0% promotions"}'),
        ('matchbook', 'Matchbook', false, 'https://api.matchbook.com', '{"type": "net_winnings", "standard_rate": 0.018, "notes": "1.8% commission, competitive for high volume"}')
      ON CONFLICT (exchange_name) DO NOTHING
    `);

    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS exchange_id INTEGER REFERENCES exchanges(id),
        ADD COLUMN IF NOT EXISTS gross_pnl NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(6,4),
        ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS net_pnl NUMERIC(12,2)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS commission_tracking (
        id SERIAL PRIMARY KEY,
        exchange_id INTEGER NOT NULL REFERENCES exchanges(id),
        period_type TEXT NOT NULL,
        period_start DATE NOT NULL,
        gross_profit NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_commission NUMERIC(14,2) NOT NULL DEFAULT 0,
        net_profit NUMERIC(14,2) NOT NULL DEFAULT 0,
        effective_rate NUMERIC(6,4),
        bet_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(exchange_id, period_type, period_start)
      )
    `);

    await db.execute(sql`
      UPDATE paper_bets
      SET exchange_id = (SELECT id FROM exchanges WHERE exchange_name = 'betfair' LIMIT 1)
      WHERE exchange_id IS NULL
    `);

    await db.execute(sql`
      UPDATE paper_bets
      SET
        gross_pnl = CASE
          WHEN status = 'won' THEN ROUND(stake::numeric * (odds_at_placement::numeric - 1), 2)
          WHEN status = 'lost' THEN -stake::numeric
          WHEN status = 'void' THEN 0
          ELSE NULL
        END,
        commission_rate = CASE WHEN status = 'won' THEN 0.0500 ELSE 0 END,
        commission_amount = CASE
          WHEN status = 'won' THEN ROUND(stake::numeric * (odds_at_placement::numeric - 1) * 0.05, 2)
          ELSE 0
        END,
        net_pnl = CASE
          WHEN status = 'won' THEN ROUND(stake::numeric * (odds_at_placement::numeric - 1) * 0.95, 2)
          WHEN status = 'lost' THEN -stake::numeric
          WHEN status = 'void' THEN 0
          ELSE NULL
        END
      WHERE gross_pnl IS NULL AND status IN ('won', 'lost', 'void')
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS tournament_config (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL UNIQUE,
        tournament_name TEXT NOT NULL,
        tournament_type TEXT NOT NULL DEFAULT 'international',
        start_date TIMESTAMPTZ,
        end_date TIMESTAMPTZ,
        is_active BOOLEAN NOT NULL DEFAULT false,
        polling_multiplier REAL NOT NULL DEFAULT 1,
        soft_line_nations JSONB DEFAULT '[]'::jsonb,
        model_adjustments JSONB DEFAULT '{}'::jsonb,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      ALTER TABLE tournament_config
        DROP CONSTRAINT IF EXISTS tournament_config_tournament_id_key
    `);
    await db.execute(sql`
      ALTER TABLE tournament_config
        ADD CONSTRAINT tournament_config_tournament_id_key UNIQUE (tournament_id)
    `);

    await db.execute(sql`
      INSERT INTO tournament_config (tournament_id, tournament_name, tournament_type, start_date, end_date, is_active, polling_multiplier, soft_line_nations, model_adjustments, notes)
      VALUES
        (1, 'FIFA World Cup 2026', 'world_cup', '2026-06-11T00:00:00Z', '2026-07-19T00:00:00Z', false, 3,
         '["Saudi Arabia","Japan","South Korea","Australia","Iran","Qatar","UAE","Iraq","Uzbekistan","Jordan","Morocco","Tunisia","Senegal","Nigeria","Cameroon","Ghana","Algeria","Egypt","Ivory Coast","Mali","Canada","Costa Rica","Honduras","El Salvador","Jamaica","Panama","New Zealand","Peru","Ecuador","Paraguay","Bolivia","Venezuela","Indonesia","Thailand","Palestine","Bahrain","Oman","China"]',
         '{"home_advantage_reduced": true, "form_weight_reduced": 0.7, "international_break_factor": 1.15, "squad_depth_important": true, "neutral_venue_adjustment": true}',
         'FIFA World Cup 2026 — USA/Canada/Mexico. 48 teams, expanded format. Soft lines expected on non-traditional nations in group stage.'),
        (5, 'UEFA Nations League 2024-25', 'continental', '2024-09-01T00:00:00Z', '2025-06-30T00:00:00Z', false, 1.5,
         '[]',
         '{"form_weight_reduced": 0.8, "international_break_factor": 1.1}',
         'Nations League — lower motivation in some matches, squad rotation common.'),
        (9, 'Copa America 2028', 'continental', null, null, false, 2,
         '["Venezuela","Bolivia","Paraguay","Peru","Ecuador"]',
         '{"home_advantage_reduced": true, "neutral_venue_adjustment": true}',
         'Future Copa America — placeholder for forward planning.'),
        (15, 'WCQ - UEFA', 'qualifier', '2024-03-01T00:00:00Z', '2026-03-31T00:00:00Z', true, 2,
         '["Georgia","North Macedonia","Kosovo","Armenia","Azerbaijan","Kazakhstan","Faroe Islands","Gibraltar","Andorra","San Marino","Liechtenstein","Moldova","Belarus","Luxembourg"]',
         '{"international_break_factor": 1.1, "qualifying_motivation_high": true}',
         'UEFA World Cup 2026 qualifiers — active now. Smaller nations have softer lines.'),
        (29, 'WCQ - CONMEBOL', 'qualifier', '2023-09-01T00:00:00Z', '2026-03-31T00:00:00Z', true, 2,
         '["Bolivia","Venezuela","Paraguay","Peru"]',
         '{"international_break_factor": 1.1, "altitude_factor": true}',
         'CONMEBOL qualifiers — active. Bolivia home altitude advantage significant.'),
        (31, 'WCQ - CONCACAF', 'qualifier', '2024-06-01T00:00:00Z', '2026-03-31T00:00:00Z', true, 2,
         '["El Salvador","Honduras","Jamaica","Panama","Trinidad and Tobago","Guatemala","Suriname","Curacao","Haiti"]',
         '{"international_break_factor": 1.1}',
         'CONCACAF qualifiers — soft lines on Central American/Caribbean nations.'),
        (33, 'WCQ - CAF', 'qualifier', '2023-11-01T00:00:00Z', '2025-11-30T00:00:00Z', true, 2,
         '["Tanzania","Mozambique","Benin","Central African Republic","Rwanda","Burkina Faso","Guinea","Comoros","Mauritania","Cape Verde","Namibia","Zimbabwe","Zambia","Malawi","Uganda","Kenya","Libya","Sudan"]',
         '{"international_break_factor": 1.15, "data_sparse": true}',
         'CAF qualifiers — very soft lines, but data sparsity is a concern.'),
        (30, 'WCQ - AFC', 'qualifier', '2023-10-01T00:00:00Z', '2026-03-31T00:00:00Z', true, 2,
         '["Uzbekistan","Jordan","Oman","Bahrain","Palestine","Thailand","Indonesia","Vietnam","Malaysia","Philippines","India","China","Tajikistan","Kyrgyzstan","Turkmenistan"]',
         '{"international_break_factor": 1.1}',
         'AFC qualifiers — active. Middle East/SE Asia have soft lines.')
      ON CONFLICT (tournament_id) DO UPDATE SET
        tournament_name = EXCLUDED.tournament_name,
        tournament_type = EXCLUDED.tournament_type,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        is_active = EXCLUDED.is_active,
        polling_multiplier = EXCLUDED.polling_multiplier,
        soft_line_nations = EXCLUDED.soft_line_nations,
        model_adjustments = EXCLUDED.model_adjustments,
        notes = EXCLUDED.notes,
        updated_at = NOW()
    `);

    await db.execute(sql`
      ALTER TABLE competition_config
        ADD COLUMN IF NOT EXISTS competition_type TEXT NOT NULL DEFAULT 'league',
        ADD COLUMN IF NOT EXISTS seasonal_phase TEXT NOT NULL DEFAULT 'unknown'
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS discovered_leagues (
        id SERIAL PRIMARY KEY,
        league_id INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        country TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL DEFAULT 'unknown',
        fixture_count INTEGER NOT NULL DEFAULT 0,
        has_api_football_odds BOOLEAN NOT NULL DEFAULT false,
        has_pinnacle_odds BOOLEAN NOT NULL DEFAULT false,
        seed_edge_score INTEGER NOT NULL DEFAULT 75,
        bets_placed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'monitoring',
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_checked TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ,
        discovery_notes TEXT
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS api_usage (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS league_edge_scores (
        id SERIAL PRIMARY KEY,
        league TEXT NOT NULL,
        market_type TEXT NOT NULL DEFAULT 'ALL',
        total_bets INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        roi_pct REAL NOT NULL DEFAULT 0,
        avg_clv REAL NOT NULL DEFAULT 0,
        avg_edge REAL NOT NULL DEFAULT 0,
        confidence_score REAL NOT NULL DEFAULT 50,
        is_seed_data INTEGER NOT NULL DEFAULT 1,
        last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(league, market_type)
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS odds_history (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        bookmaker TEXT NOT NULL DEFAULT 'market',
        odds NUMERIC(10,4) NOT NULL,
        snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        previous_odds NUMERIC(10,4),
        odds_change_pct NUMERIC(10,4),
        direction TEXT,
        hours_to_kickoff NUMERIC(10,2)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS odds_history_match_idx ON odds_history(match_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS odds_history_time_idx ON odds_history(snapshot_time)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS oddspapi_fixture_map (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        oddspapi_fixture_id TEXT NOT NULL,
        cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(match_id)
      )
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS oddspapi_league_coverage (
        id SERIAL PRIMARY KEY,
        league TEXT NOT NULL UNIQUE,
        has_odds INTEGER NOT NULL DEFAULT 0,
        last_checked TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS qualification_path TEXT
    `);

    logger.info("Migrations complete");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  }
}
