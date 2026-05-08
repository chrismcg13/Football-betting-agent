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
  // B1+B2 (2026-05-07): shadow-track noise floor. Set very low so almost
  // every positive-EV opportunity flows through as £0 shadow learning data.
  // shadow_min_edge_threshold is the absolute minimum edge required for a
  // candidate to be retained as shadow (anything below is treated as noise
  // / numerical-precision junk). shadow_min_opportunity_score is set to 0
  // to capture every score level — the only true floor is positive net EV
  // after commission (enforced separately in valueDetection).
  { key: "shadow_min_edge_threshold", value: "0.005" },
  { key: "shadow_min_opportunity_score", value: "0" },
  // D1 (2026-05-07): adaptive sample-size gates. Alternative graduation
  // path requiring overwhelming statistical evidence (n>=10 + p<=0.001 +
  // positive Kelly-growth + CLV gate + weeks-active gate). Default TRUE —
  // this is a data-driven Kelly-growth-ROI optimisation within the
  // autonomy envelope ("Graduation criteria refinements based on
  // retrospective analysis"). Every adaptive promotion logs to
  // model_decision_audit_log with full reasoning; user reviews weekly
  // and can override retrospectively per the "autonomy with audit"
  // pattern. Set to "false" to disable and run only the standard path.
  { key: "adaptive_sample_size_gates_enabled", value: "true" },
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
    // Change C (2026-04-22): add legacy_regime column. The matching view
    // (paper_bets_current) and partial index are created at the END of the
    // migrate() function, AFTER every other `ALTER TABLE paper_bets` runs,
    // because Postgres freezes a view's column list at CREATE time and any
    // later ALTER would leave the view out of sync.
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS legacy_regime BOOLEAN NOT NULL DEFAULT false
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

    // ── Phase 2.A schema migrations (2026-05-05) ─────────────────────────
    // Adds the universe-tier classification, archetype labels, shadow-stake
    // tracking, and graduation evaluation log. All ALTER statements are
    // idempotent (IF NOT EXISTS); CHECK constraints are added separately
    // via DO blocks so re-runs don't fail on existing constraint names.
    //
    // No behaviour change in this commit — the gate dispatcher, reverse-
    // mapping cron, event-driven graduation, and shadow-stake placement
    // path all land in subsequent commits per the v2 §6 Phase 2.A
    // schema-then-behaviour-flip discipline.

    // 1. competition_config — universe tier columns + nullable api_football_id
    await db.execute(sql`
      ALTER TABLE competition_config
        ALTER COLUMN api_football_id DROP NOT NULL
    `);
    await db.execute(sql`
      ALTER TABLE competition_config
        ADD COLUMN IF NOT EXISTS universe_tier TEXT NOT NULL DEFAULT 'unmapped',
        ADD COLUMN IF NOT EXISTS archetype TEXT,
        ADD COLUMN IF NOT EXISTS betfair_competition_id TEXT,
        ADD COLUMN IF NOT EXISTS warmup_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS warmup_completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS universe_tier_decided_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS settlement_bias_index NUMERIC(6,4)
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'competition_config_universe_tier_check'
        ) THEN
          ALTER TABLE competition_config
            ADD CONSTRAINT competition_config_universe_tier_check
            CHECK (universe_tier IN ('A','B','C','D','E','unmapped'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS competition_config_universe_tier_idx
        ON competition_config(universe_tier)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS competition_config_betfair_competition_id_idx
        ON competition_config(betfair_competition_id)
        WHERE betfair_competition_id IS NOT NULL
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS competition_config_betfair_only_uniq
        ON competition_config(betfair_competition_id)
        WHERE api_football_id IS NULL AND betfair_competition_id IS NOT NULL
    `);

    // 2. experiment_registry — calibration + cooldown + edge-survival columns
    await db.execute(sql`
      ALTER TABLE experiment_registry
        ADD COLUMN IF NOT EXISTS archetype TEXT,
        ADD COLUMN IF NOT EXISTS clv_source TEXT NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS warmup_completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS kelly_fraction REAL NOT NULL DEFAULT 1.0,
        ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS cooldown_eligible_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS model_version_at_abandon TEXT,
        ADD COLUMN IF NOT EXISTS experiment_phase_roi REAL,
        ADD COLUMN IF NOT EXISTS candidate_phase_roi REAL
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'experiment_registry_clv_source_check'
        ) THEN
          ALTER TABLE experiment_registry
            ADD CONSTRAINT experiment_registry_clv_source_check
            CHECK (clv_source IN ('pinnacle','market_proxy','none'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'experiment_registry_kelly_fraction_check'
        ) THEN
          ALTER TABLE experiment_registry
            ADD CONSTRAINT experiment_registry_kelly_fraction_check
            CHECK (kelly_fraction >= 0 AND kelly_fraction <= 1.0);
        END IF;
      END $$
    `);

    // 3. paper_bets — shadow-stake + universe-tier + clv-source capture
    // (must be ABOVE the view-rebuild block so SELECT * picks up new columns)
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS shadow_stake NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS shadow_stake_kelly_fraction REAL,
        ADD COLUMN IF NOT EXISTS shadow_pnl NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS universe_tier_at_placement TEXT,
        ADD COLUMN IF NOT EXISTS clv_source TEXT
    `);

    // 4. graduation_evaluation_log — new table for event-driven evaluator
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS graduation_evaluation_log (
        id TEXT PRIMARY KEY,
        experiment_tag TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        trigger_bet_id INTEGER REFERENCES paper_bets(id),
        metrics_snapshot JSONB NOT NULL,
        threshold_outcome TEXT NOT NULL,
        evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'graduation_evaluation_log_triggered_by_check'
        ) THEN
          ALTER TABLE graduation_evaluation_log
            ADD CONSTRAINT graduation_evaluation_log_triggered_by_check
            CHECK (triggered_by IN ('settlement','cron','manual'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'graduation_evaluation_log_outcome_check'
        ) THEN
          ALTER TABLE graduation_evaluation_log
            ADD CONSTRAINT graduation_evaluation_log_outcome_check
            CHECK (threshold_outcome IN ('promote','demote','hold','warmup','insufficient_data'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS gel_tag_evaluated_idx
        ON graduation_evaluation_log(experiment_tag, evaluated_at DESC)
    `);

    // ── Wave 2 #1 schema migrations (2026-05-05) ──────────────────────────
    // model_decision_audit_log: every autonomous decision the model makes
    // logs here per the strategic brief's audit mandate.
    // pending_threshold_revisions: looser threshold proposals queue here for
    // user approval (tighter is autonomous; looser requires human gate).
    //
    // Both tables are net-new (no interaction with existing data). Sub-phase 6
    // (autonomous threshold management) is the primary writer. DDL pinned in
    // docs/phase-2-wave-2-schema-plan.md §2 and §3.

    // 1. model_decision_audit_log
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS model_decision_audit_log (
        id SERIAL PRIMARY KEY,
        decision_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decision_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        prior_state JSONB,
        new_state JSONB,
        reasoning TEXT NOT NULL,
        supporting_metrics JSONB,
        expected_impact NUMERIC(10,6),
        review_status TEXT NOT NULL DEFAULT 'automatic'
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'model_decision_audit_log_review_status_check'
        ) THEN
          ALTER TABLE model_decision_audit_log
            ADD CONSTRAINT model_decision_audit_log_review_status_check
            CHECK (review_status IN ('automatic','user_reviewed','user_overridden'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS model_decision_audit_log_decided_idx
        ON model_decision_audit_log(decision_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS model_decision_audit_log_subject_idx
        ON model_decision_audit_log(decision_type, subject)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS model_decision_audit_log_review_idx
        ON model_decision_audit_log(review_status)
        WHERE review_status != 'automatic'
    `);

    // 2. pending_threshold_revisions
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pending_threshold_revisions (
        id SERIAL PRIMARY KEY,
        proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        threshold_name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        current_value JSONB NOT NULL,
        proposed_value JSONB NOT NULL,
        direction TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        supporting_metrics JSONB,
        expected_impact NUMERIC(10,6),
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_at TIMESTAMPTZ,
        reviewed_by TEXT,
        review_note TEXT
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'pending_threshold_revisions_direction_check'
        ) THEN
          ALTER TABLE pending_threshold_revisions
            ADD CONSTRAINT pending_threshold_revisions_direction_check
            CHECK (direction IN ('tighter','looser'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'pending_threshold_revisions_status_check'
        ) THEN
          ALTER TABLE pending_threshold_revisions
            ADD CONSTRAINT pending_threshold_revisions_status_check
            CHECK (status IN ('pending','approved','rejected','expired'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS pending_threshold_revisions_status_idx
        ON pending_threshold_revisions(status, proposed_at DESC)
        WHERE status = 'pending'
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS pending_threshold_revisions_scope_idx
        ON pending_threshold_revisions(threshold_name, scope)
    `);
    // Sub-phase 6.1 (2026-05-05): partial index for the resolveThreshold
    // lookup chain. Sorts by (threshold_name, scope, reviewed_at DESC) so
    // the per-call SQL `SELECT DISTINCT ON (threshold_name, scope) ... ORDER
    // BY threshold_name, scope, reviewed_at DESC` is index-only.
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS pending_threshold_revisions_approved_idx
        ON pending_threshold_revisions(threshold_name, scope, reviewed_at DESC NULLS LAST)
        WHERE status = 'approved'
    `);

    // 2026-05-06: partial unique index for pending paper-bet dedup.
    // Schema (lib/db/src/schema/paperBets.ts) declared this index but it was
    // never materialized because migrate.ts is hand-written and the declaration
    // was missed. Without it, dedup rests entirely on the SELECT-then-INSERT
    // pre-check in placeBet (paperTrading.ts:917), which has a race window
    // between parallel cycles. Real duplicates leaked to production
    // (e.g. two MO Draw 3.25 bets on A. Italiano vs Vasco placed 1 second apart).
    //
    // Step 1: idempotent cleanup of pre-existing duplicate pending rows.
    // For each (match_id, market_type, selection_canonical) group with >1
    // pending row in the index's scope, keep the newest by id and void the
    // rest. Stake on voided rows is refunded (settlement_pnl=0). Idempotent:
    // on future runs there are no duplicates so the UPDATE matches zero rows.
    await db.execute(sql`
      WITH duplicates AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY match_id, market_type, selection_canonical
                 ORDER BY id DESC
               ) AS rn
        FROM paper_bets
        WHERE status IN ('pending','pending_placement')
          AND deleted_at IS NULL
          AND selection_canonical IS NOT NULL
          AND placed_at >= '2026-04-19T20:00:00Z'
      )
      UPDATE paper_bets
      SET status = 'void',
          settlement_pnl = '0',
          gross_pnl = '0',
          commission_amount = '0',
          net_pnl = '0',
          settled_at = NOW(),
          betfair_status = COALESCE(betfair_status || '|', '') || 'VOID_DEDUP_BACKFILL'
      WHERE id IN (SELECT id FROM duplicates WHERE rn > 1)
        AND betfair_bet_id IS NULL
    `);

    // Step 2: create the partial unique index. Mirrors the Drizzle declaration
    // in lib/db/src/schema/paperBets.ts. Race-proof guarantee against parallel
    // trading cycles attempting the same (match, market, selection) bet.
    // Placement code already catches 23505 + this constraint name and converts
    // it to a friendly logReject (paperTrading.ts:1346).
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS paper_bets_unique_pending_canonical_idx
        ON paper_bets (match_id, market_type, selection_canonical)
        WHERE status IN ('pending','pending_placement')
          AND deleted_at IS NULL
          AND selection_canonical IS NOT NULL
          AND placed_at >= '2026-04-19T20:00:00Z'
    `);

    // Change C (2026-04-22): create paper_bets_current view + partial index.
    // MUST run AFTER every `ALTER TABLE paper_bets` in this migrate() —
    // Postgres freezes a view's column list at CREATE time. If a new column
    // is added to paper_bets in a future migrate, that ALTER must be placed
    // BEFORE this block (or the block must be re-executed afterward).
    await db.execute(sql`DROP VIEW IF EXISTS paper_bets_current`);
    await db.execute(sql`
      CREATE VIEW paper_bets_current AS
        SELECT * FROM paper_bets WHERE legacy_regime = false
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_paper_bets_current_placed_at
        ON paper_bets (placed_at)
        WHERE legacy_regime = false
    `);

    // Sub-phase 7.0a: injury_reports — per-fixture-per-team-per-player snapshot
    // ingested from API-Football /injuries. Idempotent fetch pattern:
    // delete-then-insert per (api_fixture_id, team_api_id) so a fresh fetch
    // always reflects the current API state (player recovers → row removed).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS injury_reports (
        id SERIAL PRIMARY KEY,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        api_fixture_id INTEGER NOT NULL,
        match_id INTEGER REFERENCES matches(id),
        team_api_id INTEGER NOT NULL,
        team_name TEXT NOT NULL,
        player_api_id INTEGER,
        player_name TEXT NOT NULL,
        injury_type TEXT NOT NULL,
        injury_reason TEXT
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'injury_reports_type_check'
        ) THEN
          ALTER TABLE injury_reports
            ADD CONSTRAINT injury_reports_type_check
            CHECK (injury_type IN ('Missing Fixture','Questionable'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS injury_reports_fixture_team_idx
        ON injury_reports(api_fixture_id, team_api_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS injury_reports_match_idx
        ON injury_reports(match_id)
        WHERE match_id IS NOT NULL
    `);

    // Sub-phase 7.x: AF metadata bundle — 4 endpoints (/transfers, /coachs,
    // /sidelined, /trophies) ingested per docs/phase-2-subphase-7-x-plan.md.
    // All idempotent delete-by-natural-key + insert-snapshot per fetch.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_transfers (
        id SERIAL PRIMARY KEY,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        team_api_id INTEGER NOT NULL,
        player_api_id INTEGER,
        player_name TEXT NOT NULL,
        transfer_date DATE,
        team_in_api_id INTEGER,
        team_in_name TEXT,
        team_out_api_id INTEGER,
        team_out_name TEXT,
        transfer_type TEXT
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS team_transfers_team_idx
        ON team_transfers(team_api_id, transfer_date DESC NULLS LAST)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS team_transfers_player_idx
        ON team_transfers(player_api_id)
        WHERE player_api_id IS NOT NULL
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_coaches (
        id SERIAL PRIMARY KEY,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        team_api_id INTEGER NOT NULL,
        coach_api_id INTEGER NOT NULL,
        coach_name TEXT NOT NULL,
        start_date DATE,
        end_date DATE,
        is_current BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS team_coaches_team_idx
        ON team_coaches(team_api_id, is_current)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS team_coaches_coach_idx
        ON team_coaches(coach_api_id)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS player_sidelined (
        id SERIAL PRIMARY KEY,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        player_api_id INTEGER NOT NULL,
        player_name TEXT NOT NULL,
        sideline_type TEXT NOT NULL,
        start_date DATE,
        end_date DATE
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS player_sidelined_player_idx
        ON player_sidelined(player_api_id, start_date DESC NULLS LAST)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS player_trophies (
        id SERIAL PRIMARY KEY,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        person_api_id INTEGER NOT NULL,
        person_type TEXT NOT NULL,
        league TEXT,
        country TEXT,
        season TEXT,
        place TEXT
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'player_trophies_person_type_check'
        ) THEN
          ALTER TABLE player_trophies
            ADD CONSTRAINT player_trophies_person_type_check
            CHECK (person_type IN ('player','coach'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS player_trophies_person_idx
        ON player_trophies(person_api_id, person_type)
    `);

    // 2026-05-07: autonomous_pauses — model self-audit's action layer.
    // Daily runModelSelfAudit() cron computes per-market and per-(league
    // × market) ROI / Kelly-growth-rate / Pinnacle-coverage metrics and
    // pauses underperforming scopes. Capital-protective only: paused
    // scopes block real-stake placement but allow shadow bets through
    // (architectural principle that £0 learning-data bets bypass capital
    // gates). Trial-mode auto-resume at 50% Kelly fraction; escalation
    // on repeat offenders.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS autonomous_pauses (
        id SERIAL PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_value TEXT NOT NULL,
        paused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paused_until TIMESTAMPTZ NOT NULL,
        resumed_at TIMESTAMPTZ,
        reason TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        metric_value NUMERIC NOT NULL,
        threshold_value NUMERIC NOT NULL,
        sample_size INTEGER NOT NULL,
        kelly_fraction_override NUMERIC,
        pause_duration_days INTEGER NOT NULL,
        escalation_level INTEGER NOT NULL DEFAULT 1,
        audit_log_id INTEGER,
        manual_override BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'autonomous_pauses_scope_type_check'
        ) THEN
          ALTER TABLE autonomous_pauses
            ADD CONSTRAINT autonomous_pauses_scope_type_check
            CHECK (scope_type IN ('market','league','league_market','archetype','tag'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS autonomous_pauses_active_idx
        ON autonomous_pauses(scope_type, scope_value)
        WHERE resumed_at IS NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS autonomous_pauses_paused_until_idx
        ON autonomous_pauses(paused_until)
        WHERE resumed_at IS NULL
    `);

    // 2026-05-07: prevent matches-table fixture-level duplicates.
    // Pre-this-commit, AF and Betfair ingestion paths each checked existence
    // by their own external id (api_fixture_id / betfair_event_id), so the
    // same real fixture sometimes ended up with multiple match_id rows. That
    // bypassed the paper_bets canonical-selection unique index (different
    // match_ids = different partitions) and double-counted predictions in
    // metrics. The application code now also fixture-key-dedups before
    // inserting; this constraint is the DB-side guarantee.
    //
    // Idempotent + safe: only adds the constraint if (a) it doesn't exist
    // yet AND (b) no fixture-level dupes are present. If dupes exist, logs
    // a warning and skips — operator runs scripts/dedup-matches-fixture-level.sql
    // on Neon to clean up, then the constraint takes hold on next migrate.
    await db.execute(sql`
      DO $$
      DECLARE
        dupes_count INT;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'matches_unique_fixture_key'
        ) THEN
          SELECT COUNT(*) INTO dupes_count
          FROM (
            SELECT 1 FROM matches
            GROUP BY home_team, away_team, kickoff_time
            HAVING COUNT(*) > 1
          ) x;

          IF dupes_count = 0 THEN
            ALTER TABLE matches
              ADD CONSTRAINT matches_unique_fixture_key
              UNIQUE (home_team, away_team, kickoff_time);
            RAISE NOTICE 'matches_unique_fixture_key constraint added';
          ELSE
            RAISE WARNING 'matches has % fixture-level duplicate groups — run scripts/dedup-matches-fixture-level.sql before constraint can be added', dupes_count;
          END IF;
        END IF;
      END $$
    `);

    // C3a (2026-05-07): API-Football /predictions per-fixture cache. AF's own
    // model output as a comparator feature (their prediction percentages plus
    // the 'advice' free-text). One row per fixture; refreshed daily. Used
    // downstream as features (af_pct_home, af_pct_draw, af_pct_away) and as
    // a meta-signal (model agreement / disagreement with AF).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS af_predictions (
        id SERIAL PRIMARY KEY,
        match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
        api_fixture_id INTEGER NOT NULL UNIQUE,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        af_winner_team_id INTEGER,
        af_winner_team_name TEXT,
        af_advice TEXT,
        af_pct_home NUMERIC(5,2),
        af_pct_draw NUMERIC(5,2),
        af_pct_away NUMERIC(5,2),
        raw JSONB NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS af_predictions_match_idx
        ON af_predictions(match_id) WHERE match_id IS NOT NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS af_predictions_fetched_idx
        ON af_predictions(fetched_at DESC)
    `);

    // C3a (2026-05-07): API-Football /standings per (league, season, team).
    // Refreshed daily for active competitions. Used downstream as features
    // (table_position, points_per_game, goal_difference, recent_form_rate).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_standings (
        id SERIAL PRIMARY KEY,
        api_team_id INTEGER NOT NULL,
        team_name TEXT NOT NULL,
        api_league_id INTEGER NOT NULL,
        season INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        played INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        draws INTEGER NOT NULL,
        losses INTEGER NOT NULL,
        goals_for INTEGER NOT NULL,
        goals_against INTEGER NOT NULL,
        points INTEGER NOT NULL,
        recent_form TEXT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS team_standings_unique
        ON team_standings(api_team_id, api_league_id, season)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS team_standings_league_idx
        ON team_standings(api_league_id, season)
    `);

    // F1 (2026-05-07): bankroll snapshots — true Kelly-growth measurement.
    // Pre-placement and post-settlement rows let us compute proper
    // LN(bankroll_after / bankroll_before) per bet vs the current
    // LN(1 + pnl/stake) proxy. Required for accurate Kelly-growth-rate
    // reporting per Phase 2 brief (primary optimisation metric).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS bankroll_snapshots (
        id SERIAL PRIMARY KEY,
        taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paper_bankroll NUMERIC(14,2) NOT NULL,
        real_bankroll NUMERIC(14,2),
        source TEXT NOT NULL,
        bet_id INTEGER REFERENCES paper_bets(id) ON DELETE SET NULL,
        notes TEXT
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS bankroll_snapshots_taken_at_idx
        ON bankroll_snapshots(taken_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS bankroll_snapshots_bet_idx
        ON bankroll_snapshots(bet_id) WHERE bet_id IS NOT NULL
    `);

    // X2 (2026-05-07): match referee assignment + per-referee aggregate stats.
    // AF /fixtures returns referee name in the fixture object. For each
    // upcoming Tier A/B/C match we capture the assignment; the rolling
    // aggregate (cards/match, pens/match etc.) is computed on demand.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS match_referees (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
        api_fixture_id INTEGER NOT NULL,
        referee_name TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS match_referees_referee_idx
        ON match_referees(referee_name)
    `);

    // X3 (2026-05-07): head-to-head history per upcoming match. Stores last
    // N H2H outcomes from AF. Used as feature: h2h_home_win_rate /
    // h2h_btts_rate / h2h_avg_total_goals.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS match_h2h (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        h2h_count INTEGER NOT NULL,
        home_wins INTEGER NOT NULL,
        away_wins INTEGER NOT NULL,
        draws INTEGER NOT NULL,
        avg_total_goals NUMERIC(5,2),
        btts_rate NUMERIC(4,3),
        raw JSONB NOT NULL
      )
    `);

    // X4 (2026-05-07): minute-by-minute fixture events for recently-settled
    // fixtures. Refines per-archetype FH/2H scaling factors with empirical
    // goal-timing data.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS fixture_events (
        id SERIAL PRIMARY KEY,
        api_fixture_id INTEGER NOT NULL,
        match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
        event_minute INTEGER NOT NULL,
        event_extra_minute INTEGER,
        event_type TEXT NOT NULL,
        event_detail TEXT,
        team_id INTEGER,
        team_name TEXT,
        player_name TEXT,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS fixture_events_match_idx
        ON fixture_events(match_id) WHERE match_id IS NOT NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS fixture_events_fixture_idx
        ON fixture_events(api_fixture_id)
    `);

    // X5 (2026-05-07): per-fixture player ratings + sub data. Feeds the
    // expected-XI baseline (C3-lineup-features) and future goalscorer
    // markets (deferred TIER B from C7).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS fixture_player_stats (
        id SERIAL PRIMARY KEY,
        api_fixture_id INTEGER NOT NULL,
        match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL,
        player_id INTEGER,
        player_name TEXT NOT NULL,
        position TEXT,
        rating NUMERIC(4,2),
        minutes_played INTEGER,
        is_starter BOOLEAN NOT NULL DEFAULT FALSE,
        is_substitute BOOLEAN NOT NULL DEFAULT FALSE,
        goals INTEGER NOT NULL DEFAULT 0,
        assists INTEGER NOT NULL DEFAULT 0,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS fixture_player_stats_unique
        ON fixture_player_stats(api_fixture_id, team_id, player_name)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS fixture_player_stats_match_idx
        ON fixture_player_stats(match_id) WHERE match_id IS NOT NULL
    `);

    // C3-lineup-features (2026-05-07): expected starting XI per team, derived
    // from accumulating _lineup_data history. start_count = how many of the
    // recent N lineups this player has started in. Used to compute the
    // key_player_missing_count feature: when a match's actual lineup is
    // captured at T-60min, count how many of the team's top-11 expected
    // starters are NOT in the actual startXI. High count = sharper
    // signal that team is weakened.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_expected_xi (
        id SERIAL PRIMARY KEY,
        team_name TEXT NOT NULL,
        player_name TEXT NOT NULL,
        start_count INTEGER NOT NULL DEFAULT 0,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS team_expected_xi_unique
        ON team_expected_xi(team_name, player_name)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS team_expected_xi_team_idx
        ON team_expected_xi(team_name, start_count DESC)
    `);

    // D1 follow-up (2026-05-07): adaptive_sample_size_gates_enabled — flip
    // existing 'false' rows to 'true'. Initial commit shipped default 'false'
    // out of overcaution per the user-approval rule on looser graduation
    // thresholds; corrected on user pushback that data-driven graduation
    // criteria fall under the model's autonomy envelope. Idempotent — only
    // affects rows still at 'false' AND only on the specific known prior
    // default (so user-set 'false' overrides post-flip aren't clobbered;
    // they would re-flip via this same statement only on the first deploy
    // that includes it).
    await db.execute(sql`
      UPDATE agent_config
      SET value = 'true', updated_at = NOW()
      WHERE key = 'adaptive_sample_size_gates_enabled'
        AND value = 'false'
        AND updated_at < '2026-05-08'::timestamptz
    `);

    // A2.1 (2026-05-07): one-shot idempotent cleanup of stale Primera División
    // bias contamination. The country-blind bug in auditCron (fixed in
    // ece5d4f) wrote a single Bolivia bias observation (-0.5240) onto all 9
    // same-named "Primera División" rows across South America via a name-only
    // WHERE. Those rows are now stuck at universe_tier='D' from
    // bias_threshold_violated despite having no per-country bias signal.
    // This cleanup nulls the spurious bias and resets tier to 'unmapped' so
    // the next reverse-mapping cron pass re-evaluates them on real Pinnacle
    // / odds data. Idempotent: matches the exact-value spurious row signature
    // (settlement_bias_index = -0.5240 + universe_tier = 'D' + name = same).
    await db.execute(sql`
      UPDATE competition_config
      SET settlement_bias_index = NULL,
          universe_tier = 'unmapped',
          universe_tier_decided_at = NOW()
      WHERE name = 'Primera División'
        AND universe_tier = 'D'
        AND settlement_bias_index = -0.5240
    `);

    // ────────────────────────────────────────────────────────────────────
    // Phase 3 (2026-05-08): switchover infrastructure
    //
    // Adds the bet_track enum column on paper_bets, plus new tables for
    // bankroll-tier cap recommendations (B2), gate monitoring (B9), the
    // live-bet whitelist snapshot (used at switchover transaction), and
    // SQL views that compute Path P + Path S evaluation pools and
    // aggregate gate components.
    //
    // All idempotent — safe to re-run on every deploy.
    // ────────────────────────────────────────────────────────────────────

    // B6: bet_track column. CHECK constraint + index.
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS bet_track TEXT
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'paper_bets_bet_track_check'
        ) THEN
          ALTER TABLE paper_bets
            ADD CONSTRAINT paper_bets_bet_track_check
            CHECK (bet_track IS NULL OR bet_track IN ('paper','shadow','live'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_paper_bets_bet_track
        ON paper_bets(bet_track)
        WHERE bet_track IS NOT NULL
    `);
    // One-shot backfill for existing rows. Live = none yet (no real bets
    // placed). Shadow = stake=0 AND shadow_stake>0. Paper = stake>0. Skips
    // rows already populated so it's idempotent on re-deploys.
    await db.execute(sql`
      UPDATE paper_bets SET bet_track = 'shadow'
      WHERE bet_track IS NULL
        AND COALESCE(stake::numeric, 0) = 0
        AND shadow_stake IS NOT NULL
        AND shadow_stake::numeric > 0
    `);
    await db.execute(sql`
      UPDATE paper_bets SET bet_track = 'paper'
      WHERE bet_track IS NULL
        AND stake::numeric > 0
        AND betfair_bet_id IS NULL
    `);
    await db.execute(sql`
      UPDATE paper_bets SET bet_track = 'live'
      WHERE bet_track IS NULL
        AND betfair_bet_id IS NOT NULL
    `);

    // B2: pending_caps table. One row per bankrollTierCaps cron evaluation;
    // switchover transaction reads the LATEST row.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pending_caps (
        id SERIAL PRIMARY KEY,
        evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        bankroll NUMERIC(12,2) NOT NULL,
        natural_tier TEXT NOT NULL,
        applied_tier TEXT NOT NULL,
        decision TEXT NOT NULL,
        pending_since TIMESTAMPTZ,
        daily_loss_limit_pct NUMERIC(6,4) NOT NULL,
        weekly_loss_limit_pct NUMERIC(6,4) NOT NULL,
        bankroll_floor NUMERIC(12,2) NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_pending_caps_evaluated_at
        ON pending_caps(evaluated_at DESC)
    `);

    // B9: gate-monitoring tables.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS gate_status (
        id SERIAL PRIMARY KEY,
        evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pool_size INTEGER NOT NULL,
        aggregate_net_roi NUMERIC,
        aggregate_net_clv NUMERIC,
        threshold_roi NUMERIC NOT NULL DEFAULT 0.03,
        threshold_clv NUMERIC NOT NULL DEFAULT 2.0,
        threshold_n INTEGER NOT NULL DEFAULT 200,
        pool_size_pass BOOLEAN NOT NULL,
        roi_pass BOOLEAN NOT NULL,
        clv_pass BOOLEAN NOT NULL,
        all_pass BOOLEAN NOT NULL,
        whitelist_size INTEGER,
        whitelist_largest_share NUMERIC,
        manifest JSONB
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_gate_status_evaluated_at
        ON gate_status(evaluated_at DESC)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS gate_clear_pending_review (
        id SERIAL PRIMARY KEY,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        manifest_hash TEXT NOT NULL,
        manifest JSONB NOT NULL,
        resolved_at TIMESTAMPTZ,
        resolution TEXT
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS gate_status_review_required (
        id SERIAL PRIMARY KEY,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reason TEXT NOT NULL,
        diagnostic JSONB NOT NULL,
        acknowledged_at TIMESTAMPTZ
      )
    `);

    // Switchover-transaction whitelist snapshot.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS live_whitelist (
        id SERIAL PRIMARY KEY,
        snapshotted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        path TEXT NOT NULL,
        market_type TEXT NOT NULL,
        league TEXT NOT NULL,
        n INTEGER,
        scope_net_roi NUMERIC,
        scope_net_clv NUMERIC,
        share_of_agg_pnl NUMERIC,
        kelly_fraction_override NUMERIC NOT NULL DEFAULT 0.5,
        live_bet_count INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'live_whitelist_path_check'
        ) THEN
          ALTER TABLE live_whitelist
            ADD CONSTRAINT live_whitelist_path_check
            CHECK (path IN ('P','S'));
        END IF;
      END $$
    `);

    // ────────────────────────────────────────────────────────────────────
    // Path P views
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`DROP VIEW IF EXISTS switchover_whitelist`);
    await db.execute(sql`DROP VIEW IF EXISTS gate_components`);
    await db.execute(sql`DROP VIEW IF EXISTS evaluation_pool`);

    await db.execute(sql`
      CREATE OR REPLACE VIEW evaluation_pool AS
      SELECT pb.*
      FROM paper_bets pb
      WHERE pb.legacy_regime = false
        AND pb.deleted_at IS NULL
        AND pb.bet_track = 'paper'
        AND pb.status IN ('won','lost')
        AND pb.clv_source = 'pinnacle'
        AND pb.gross_pnl IS NOT NULL
        AND pb.commission_amount IS NOT NULL
        AND pb.net_pnl IS NOT NULL
        AND pb.placed_at >= COALESCE(
          (SELECT value::timestamptz FROM agent_config WHERE key = 'evaluation_start_at'),
          'infinity'::timestamptz
        )
    `);

    await db.execute(sql`
      CREATE OR REPLACE VIEW gate_components AS
      WITH p AS (SELECT * FROM evaluation_pool)
      SELECT
        (SELECT COUNT(*) FROM p) AS pool_size,
        (SELECT
           CASE WHEN SUM(stake::numeric) > 0
                THEN SUM(net_pnl::numeric) / SUM(stake::numeric)
                ELSE NULL END
         FROM p) AS aggregate_net_roi,
        (SELECT AVG(clv_pct::numeric) FROM p) AS aggregate_net_clv,
        (SELECT COALESCE(json_object_agg(market_type, json_build_object(
           'n', n, 'roi', roi, 'clv', clv)), '{}'::json)
         FROM (SELECT market_type, COUNT(*) AS n,
                      ROUND(100.0 * SUM(net_pnl::numeric) / NULLIF(SUM(stake::numeric),0), 2) AS roi,
                      ROUND(AVG(clv_pct::numeric)::numeric, 2) AS clv
               FROM p GROUP BY market_type) x) AS by_market
    `);

    // ────────────────────────────────────────────────────────────────────
    // Path S views
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`DROP VIEW IF EXISTS path_s_aggregate_status`);
    await db.execute(sql`DROP VIEW IF EXISTS path_s_scope_status`);
    await db.execute(sql`DROP VIEW IF EXISTS shadow_evaluation_pool`);

    await db.execute(sql`
      CREATE OR REPLACE VIEW shadow_evaluation_pool AS
      SELECT pb.*
      FROM paper_bets pb
      WHERE pb.legacy_regime = false
        AND pb.deleted_at IS NULL
        AND pb.bet_track = 'shadow'
        AND pb.status IN ('won','lost')
        AND pb.shadow_stake IS NOT NULL
        AND pb.shadow_stake::numeric > 0
        AND pb.shadow_pnl IS NOT NULL
        AND pb.placed_at >= COALESCE(
          (SELECT value::timestamptz FROM agent_config WHERE key = 'evaluation_start_at'),
          'infinity'::timestamptz
        )
    `);

    await db.execute(sql`
      CREATE OR REPLACE VIEW path_s_scope_status AS
      WITH ranked AS (
        SELECT pb.market_type, m.league,
               pb.shadow_stake::numeric AS stk,
               pb.shadow_pnl::numeric AS pnl,
               ROW_NUMBER() OVER (
                 PARTITION BY pb.market_type, m.league
                 ORDER BY pb.placed_at
               ) AS rn,
               COUNT(*) OVER (PARTITION BY pb.market_type, m.league) AS n_total
        FROM shadow_evaluation_pool pb
        JOIN matches m ON m.id = pb.match_id
      ),
      scope AS (
        SELECT market_type, league,
               COUNT(*) AS n,
               SUM(pnl) / NULLIF(SUM(stk), 0) AS net_roi,
               SUM(pnl) FILTER (WHERE rn <= n_total/2) AS first_half_pnl,
               SUM(stk) FILTER (WHERE rn <= n_total/2) AS first_half_stk,
               SUM(pnl) FILTER (WHERE rn >  n_total/2) AS second_half_pnl,
               SUM(stk) FILTER (WHERE rn >  n_total/2) AS second_half_stk
        FROM ranked GROUP BY market_type, league
      )
      SELECT market_type, league, n, net_roi,
             first_half_pnl / NULLIF(first_half_stk,0) AS first_half_roi,
             second_half_pnl / NULLIF(second_half_stk,0) AS second_half_roi,
             (n >= 400) AS n_pass,
             (net_roi >= 0.05) AS roi_pass,
             ((first_half_pnl / NULLIF(first_half_stk,0) >= 0.03)
              AND (second_half_pnl / NULLIF(second_half_stk,0) >= 0.03)) AS split_half_pass,
             (n >= 400 AND net_roi >= 0.05
              AND (first_half_pnl / NULLIF(first_half_stk,0) >= 0.03)
              AND (second_half_pnl / NULLIF(second_half_stk,0) >= 0.03)) AS path_s_pass
      FROM scope
    `);

    await db.execute(sql`
      CREATE OR REPLACE VIEW path_s_aggregate_status AS
      WITH cleared AS (
        SELECT market_type, league
        FROM path_s_scope_status
        WHERE path_s_pass = true
      ),
      cleared_bets AS (
        SELECT pb.shadow_stake::numeric AS stk,
               pb.shadow_pnl::numeric AS pnl,
               pb.market_type
        FROM shadow_evaluation_pool pb
        JOIN matches m ON m.id = pb.match_id
        JOIN cleared c ON c.market_type = pb.market_type AND c.league = m.league
      )
      SELECT
        COUNT(*) AS pool_size_cleared,
        COUNT(DISTINCT market_type) AS distinct_markets_cleared,
        CASE WHEN SUM(stk) > 0 THEN SUM(pnl) / SUM(stk) ELSE NULL END AS aggregate_net_roi_cleared,
        (COUNT(*) >= 500) AS path_s_n_pass,
        (COUNT(DISTINCT market_type) >= 2) AS path_s_diversity_pass,
        (CASE WHEN SUM(stk) > 0 THEN SUM(pnl) / SUM(stk) ELSE NULL END >= 0.04) AS path_s_roi_pass,
        ((COUNT(*) >= 500)
         AND (COUNT(DISTINCT market_type) >= 2)
         AND (CASE WHEN SUM(stk) > 0 THEN SUM(pnl) / SUM(stk) ELSE NULL END >= 0.04)) AS path_s_aggregate_pass
      FROM cleared_bets
    `);

    // ────────────────────────────────────────────────────────────────────
    // Combined whitelist (Path P passers UNION Path S (A) passers).
    // Per-scope filter on Path P: n >= 50 (tightened from 30 per Chris's
    // §11 revision), positive net ROI, positive net CLV.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE OR REPLACE VIEW switchover_whitelist AS
      WITH agg AS (SELECT SUM(net_pnl::numeric) AS agg_pnl FROM evaluation_pool),
      path_p AS (
        SELECT 'P'::text AS path, ep.market_type, m.league,
               COUNT(*)::int AS n,
               SUM(ep.net_pnl::numeric) / NULLIF(SUM(ep.stake::numeric),0) AS scope_net_roi,
               AVG(ep.clv_pct::numeric) AS scope_net_clv,
               SUM(ep.net_pnl::numeric) / NULLIF((SELECT agg_pnl FROM agg),0) AS share_of_agg_pnl
        FROM evaluation_pool ep JOIN matches m ON m.id = ep.match_id
        GROUP BY ep.market_type, m.league
        HAVING COUNT(*) >= 50
           AND (SUM(ep.net_pnl::numeric) / NULLIF(SUM(ep.stake::numeric),0)) > 0
           AND AVG(ep.clv_pct::numeric) > 0
      ),
      path_s_pass AS (
        SELECT pss.market_type, pss.league
        FROM path_s_scope_status pss
        WHERE pss.path_s_pass = true
      ),
      path_s AS (
        SELECT 'S'::text AS path, pss.market_type, pss.league,
               pss.n::int AS n,
               pss.net_roi AS scope_net_roi,
               NULL::numeric AS scope_net_clv,
               NULL::numeric AS share_of_agg_pnl
        FROM path_s_scope_status pss
        WHERE pss.path_s_pass = true
          AND NOT EXISTS (
            SELECT 1 FROM path_p p
            WHERE p.market_type = pss.market_type AND p.league = pss.league
          )
      )
      SELECT * FROM path_p
      UNION ALL
      SELECT * FROM path_s
    `);

    // Re-create paper_bets_current view AFTER the bet_track ALTER above
    // (Postgres freezes view column lists at CREATE time).
    await db.execute(sql`DROP VIEW IF EXISTS paper_bets_current`);
    await db.execute(sql`
      CREATE VIEW paper_bets_current AS
        SELECT * FROM paper_bets WHERE legacy_regime = false
    `);

    // ────────────────────────────────────────────────────────────────────
    // URGENT (2026-05-08): missing index on features.match_id was causing
    // trading_near cron failures every ~15 min. Postgres FK references
    // don't auto-index. With ~156k rows in features, every
    // `WHERE match_id IN (hundreds-of-ids)` query did a full table scan
    // that took 500-900s and timed out. Adding the composite index
    // (match_id, feature_name) covers both single-feature lookups and
    // bulk-by-match scans. The plain (match_id) index is also a leading
    // prefix, so a separate index isn't needed.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS features_match_id_feature_name_idx
        ON features(match_id, feature_name)
    `);

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-08 Neon-cost optimization: api_usage had ZERO indexes despite
    // 100% sequential-scan rate (1M+ scans, 73B row reads). The hot query
    // pattern is WHERE date = $1 and WHERE date LIKE $1 (apiFootball.ts:
    // 594, 613). Adding a composite (date, endpoint) covers both.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS api_usage_date_endpoint_idx
        ON api_usage(date, endpoint)
    `);

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-08 Neon-cost optimization: composite index on
    // odds_snapshots(match_id, snapshot_time DESC) to support the new
    // DISTINCT ON query in valueDetection.ts. Without it Postgres sorts
    // 50k+ rows in memory per cycle. With it the query plan is
    // index-only-scan + skip-scan (one row per group). Massive table
    // (3.4 GB / 20M rows) so we use CONCURRENTLY-equivalent semantics
    // via DROP/CREATE in a separate transaction is impractical here;
    // CREATE INDEX with the existing match_id-only index already in place
    // means inserts during build are slowed but not blocked. Acceptable
    // one-time cost for ongoing efficiency.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS odds_snapshots_match_time_idx
        ON odds_snapshots(match_id, snapshot_time DESC)
    `);

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-08 Neon-cost cleanup: compliance_logs was bloated with
    // ~508k rows from action_types that were demoted on 2026-04-17 and
    // are no longer written. ~218 MB of dead data. One-shot delete; the
    // table grows back in trickle for action_types still in use.
    //
    // Targets identified via SQL audit (rows / approx size):
    //   line_movement                  272,760  (117 MB)
    //   value_detection_evaluation     182,573  ( 78 MB)
    //   value_detection_odds_source     51,736  ( 22 MB)
    // All three stopped being written on 2026-04-17. The deletion is
    // bounded by timestamp < that date for safety in case any of these
    // action_types resume writing after a future code change.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      DELETE FROM compliance_logs
      WHERE action_type IN (
        'line_movement', 'value_detection_evaluation', 'value_detection_odds_source'
      ) AND timestamp < '2026-04-18'::timestamptz
    `);

    logger.info("Migrations complete");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  }
}
