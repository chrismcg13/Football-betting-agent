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
  // Task 24 Part B (2026-05-11): edge-aware tick chase config. minResidualEdge
  // is the model-edge floor we must keep after drift; maxDriftPct caps the
  // tolerable drift fraction in odds units (default 15%).
  { key: "edge_aware_chase_min_residual_edge", value: "0.01" },
  { key: "edge_aware_chase_max_drift_pct", value: "0.15" },
  // Task 24 Part C (2026-05-11): take-best-back placement for high-edge bets.
  // When calculatedEdge >= take_best_back_min_edge, the placement picks the
  // current best back price instead of the target — accepting up to
  // take_best_back_slippage_tolerance worth of price haircut to guarantee
  // a match. Below the slippage tolerance, demote to shadow.
  { key: "take_best_back_min_edge", value: "0.10" },
  { key: "take_best_back_slippage_tolerance", value: "0.05" },
  // Task 11 (2026-05-11): synthetic CLV consensus. Phase 3d.1 ships the
  // Smarkets fetcher only; gated behind a flag so the first deploy is a
  // no-op until the operator flips it. Matchbook + Betfair SP fetchers
  // arrive in Phase 3d.2 with their own flags.
  { key: "smarkets_ingestion_enabled", value: "false" },
  // Phase 3d.2 (2026-05-11): Matchbook + Betfair-SP fetchers. Same gating
  // pattern as smarkets — default false, operator flips via Neon when
  // ready. Matchbook polls every 15 min (same shape as Smarkets);
  // Betfair-SP polls every 60 sec to catch matches in their 90s post-
  // kickoff capture window.
  { key: "matchbook_ingestion_enabled", value: "false" },
  { key: "betfair_sp_ingestion_enabled", value: "false" },
  // Per-source trust weights for the weighted geometric-mean consensus.
  // JSON keyed by source name. Overrides the in-code defaults
  // (pinnacle=1.0, smarkets=0.8, matchbook=0.7, betfair_sp=0.9).
  {
    key: "synthetic_consensus_trust_weights",
    value: '{"pinnacle":1.0,"smarkets":0.8,"matchbook":0.7,"betfair_sp":0.9}',
  },
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

    // 2026-05-08 (Lever 4): live-placement kill switch. Seeded as 'false'
    // so live placement stays off until the operator explicitly flips it,
    // even after a fresh deploy with TRADING_MODE=LIVE. Independent of
    // env-mode so the operator can pause live placement without changing
    // environment variables or restarting.
    await db.execute(sql`
      INSERT INTO agent_config (key, value, updated_at)
      VALUES ('live_placement_enabled', 'false', NOW())
      ON CONFLICT (key) DO NOTHING
    `);

    // ── 2026-05-08 OddsPapi maximisation bundle ─────────────────────────
    // Catalogs every bookmaker OddsPapi returns + flags those with public
    // APIs. Powers future scaling: when we exceed Betfair-only capacity,
    // bet-spreading to Smarkets (1-2% commission) and Matchbook (1-1.5%)
    // halves slippage costs vs Betfair's 5%. Catalog populated by the
    // oddsPapiBookmakerCatalog service from real API responses; api_*
    // columns seeded with known integrations; rows updated via cron.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS oddspapi_bookmaker_catalog (
        slug TEXT PRIMARY KEY,
        display_name TEXT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sample_count INTEGER NOT NULL DEFAULT 0,
        markets_seen TEXT[] DEFAULT '{}',
        api_integratable BOOLEAN NOT NULL DEFAULT false,
        api_doc_url TEXT,
        commission_rate NUMERIC,
        notes TEXT
      )
    `);
    // Seed known API-integratable exchanges (lower commission than Betfair
    // for bet-spreading at scale). UK-blocked or partner-only bookmakers
    // are intentionally NOT marked api_integratable=true even if they have
    // public APIs (Pinnacle UK-block, Marathon affiliate-only).
    await db.execute(sql`
      INSERT INTO oddspapi_bookmaker_catalog (slug, display_name, api_integratable, api_doc_url, commission_rate, notes)
      VALUES
        ('betfair', 'Betfair Exchange', true, 'https://docs.developer.betfair.com', 0.05, 'Already integrated. 5% standard commission, scales down with discount rate.'),
        ('smarkets', 'Smarkets', true, 'https://docs.smarkets.com', 0.02, 'UK exchange. 2% commission standard, 1% on Pro tier (>£1k/month volume). API allows place/cancel/list orders.'),
        ('matchbook', 'Matchbook', true, 'https://help.matchbook.com/hc/en-gb/sections/115001120347', 0.015, 'UK exchange. 1.5% standard, 1% on volume tier. Lowest commission in UK market. REST API for orders.'),
        ('pinnacle', 'Pinnacle', false, 'https://pinnacleapi.github.io', NULL, 'Public API exists but UK-blocked. Cannot be used as execution venue without geo-bypass (compliance risk).'),
        ('1xbet', '1xBet', false, NULL, NULL, 'Affiliate API only. UK regulatory uncertainty.'),
        ('marathon', 'Marathon', false, NULL, NULL, 'Partner-only API.')
      ON CONFLICT (slug) DO NOTHING
    `);

    // Pinnacle line-move tracker: every detected move >= MIN_MOVE_PCT% on
    // Pinnacle for an upcoming Tier-A candidate is logged here so the
    // model can boost (or skip) bets aligned with sharp money. Used by
    // pinnacleSharpMoveDetector cron every 5 min in T-30 to T-0 window.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pinnacle_line_moves (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL,
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        prev_odds NUMERIC NOT NULL,
        new_odds NUMERIC NOT NULL,
        move_pct NUMERIC NOT NULL,
        move_type TEXT NOT NULL CHECK (move_type IN ('steam','reverse','drift','dead')),
        prev_snapshot_at TIMESTAMPTZ NOT NULL,
        new_snapshot_at TIMESTAMPTZ NOT NULL,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        minutes_to_kickoff INTEGER
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS pinnacle_line_moves_match_market_idx
        ON pinnacle_line_moves (match_id, market_type, detected_at DESC)
    `);

    // Source cross-check: when AF Pinnacle and OddsPapi Pinnacle disagree
    // on the same (match,market,selection) by more than 5% within the
    // same 30-min window, log the discrepancy. Either source can be stale;
    // the disagreement is the data-quality signal worth surfacing.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pinnacle_source_disagreements (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL,
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        af_odds NUMERIC NOT NULL,
        oddspapi_odds NUMERIC NOT NULL,
        diff_pct NUMERIC NOT NULL,
        af_snapshot_at TIMESTAMPTZ NOT NULL,
        oddspapi_snapshot_at TIMESTAMPTZ NOT NULL,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
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

    // Phase 3 C1 (2026-05-08): multi-anchor CLV tier. SMALLINT (2 bytes,
    // negligible storage). 1=Pinnacle (canonical sharp), 2=sharp non-Pinnacle
    // (Bet365/Smarkets/Matchbook/IBC etc), 3=soft books (William Hill /
    // Ladbrokes / etc), NULL=no anchor available. Path P stays Tier-1 only;
    // Path P+ admits Tier 1+2 with a higher edge cushion. Both rails (paper
    // + shadow) get tier-tagged identically — partial validation > omission.
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS clv_source_tier SMALLINT
    `);
    // One-shot backfill of existing tagged rows. Idempotent — only writes
    // where tier is NULL. clv_source values 'pinnacle' / 'pinnacle_derived'
    // are Tier-1 (both anchor against Pinnacle's actual sharp prices, just
    // via different ingestion paths).
    await db.execute(sql`
      UPDATE paper_bets
      SET clv_source_tier = 1
      WHERE clv_source IN ('pinnacle','pinnacle_derived')
        AND clv_source_tier IS NULL
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
        ADD COLUMN IF NOT EXISTS settlement_bias_index NUMERIC(6,4),
        ADD COLUMN IF NOT EXISTS devig_method TEXT NOT NULL DEFAULT 'power'
    `);
    // Task 14 (2026-05-11): seed Shin only for women's leagues — wider bookmaker
    // margins on women's football make adverse-selection bias the dominant
    // source of overround. Lower-tier men's leagues stay on 'power' until the
    // backtest evidence flips them. Idempotent — only touches rows still on
    // the 'power' default.
    await db.execute(sql`
      UPDATE competition_config
         SET devig_method = 'shin'
       WHERE devig_method = 'power'
         AND gender = 'female'
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

    // Phase 3 A4 (2026-05-08): post-flip operational tables.
    // stop_condition_actions: append-only log of every halt/alert/graduation
    // emitted by the stop-condition monitor, half-Kelly ramp, and continuous-
    // graduation paths. One row per state-transition event.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS stop_condition_actions (
        id SERIAL PRIMARY KEY,
        evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        action_type TEXT NOT NULL,
        scope_path TEXT,
        market_type TEXT,
        league TEXT,
        reason TEXT NOT NULL,
        metric_name TEXT,
        metric_value NUMERIC,
        threshold_value NUMERIC
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_stop_condition_actions_evaluated_at
        ON stop_condition_actions(evaluated_at DESC)
    `);
    // live_ramp_review_required: surfaces scopes that hit the half-Kelly
    // ramp threshold (Path P:50, Path S:100) but rolling-N net ROI ≤ 0%.
    // Idempotent — at most one unresolved row per (market_type, league).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS live_ramp_review_required (
        id SERIAL PRIMARY KEY,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scope_path TEXT NOT NULL,
        market_type TEXT NOT NULL,
        league TEXT NOT NULL,
        n INTEGER NOT NULL,
        rolling_net_roi NUMERIC NOT NULL,
        threshold INTEGER NOT NULL,
        resolved_at TIMESTAMPTZ,
        resolution TEXT
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

    // Phase 3 Path C relaxation (2026-05-08, per Chris):
    //   "P path as 2% isn't fit for purpose, no opportunities are coming
    //    through as that, we can still validate CLV after the match to
    //    learn edge."
    // Path P becomes: any settled paper bet (regardless of CLV anchor),
    // n>=200, ROI>=3%. CLV is still computed and tagged per-bet for
    // retrospective learning, but is no longer a gate-clearance condition.
    // Path P+ stays multi-anchor secondary review.
    // The Pinnacle anchor requirement (clv_source='pinnacle') is dropped
    // so unanchored paper bets enter the eval pool. CLV column stays for
    // diagnostic use in gate_components manifest.
    await db.execute(sql`
      CREATE OR REPLACE VIEW evaluation_pool AS
      SELECT pb.*
      FROM paper_bets pb
      WHERE pb.legacy_regime = false
        AND pb.deleted_at IS NULL
        AND pb.bet_track = 'paper'
        AND pb.status IN ('won','lost')
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

    // Phase 3 §12.4 audit fix (2026-05-08): v_upcoming_bets is a display
    // view (operator-facing). Pre-fix it referenced paper_bets without
    // bet_track filtering — post-flip it would intermix paper and live
    // pending bets confusingly. The §12.4 audit query
    //   SELECT viewname FROM pg_views WHERE definition ILIKE '%paper_bets%'
    //     AND definition NOT ILIKE '%bet_track%'
    // flagged this view. Add bet_track to the SELECT and a filter so the
    // view shows the bet's actual track explicitly. Display only — no
    // ROI/CLV/PnL metric depends on this view, so it's not a §12.3
    // operational-state violation, just a clarity fix.
    //
    // 2026-05-09 ROOT CAUSE FIX: this CREATE OR REPLACE VIEW renames a
    // column (was bet_mode in a prior version, now bet_track). Postgres
    // rejects that with "cannot change name of view column" because
    // CREATE OR REPLACE VIEW only permits adding columns or changing
    // their definition — never renames. Every boot since the rename was
    // deployed has died here, putting the api-server into a PM2 restart
    // loop. Fix: DROP first, then CREATE. View is display-only so no
    // dependent objects break, and no CASCADE needed.
    await db.execute(sql`DROP VIEW IF EXISTS v_upcoming_bets`);
    await db.execute(sql`
      CREATE VIEW v_upcoming_bets AS
      SELECT pb.id AS bet_id,
             pb.placed_at,
             m.kickoff_time,
             m.home_team,
             m.away_team,
             (m.home_team || ' vs ' || m.away_team) AS fixture,
             m.league,
             pb.market_type,
             pb.selection_name AS outcome,
             pb.bet_track,
             ROUND(pb.stake::numeric, 2) AS stake,
             pb.odds_at_placement AS odds,
             pb.clv_pct,
             pb.status
      FROM paper_bets pb
      JOIN matches m ON pb.match_id = m.id
      WHERE pb.deleted_at IS NULL
        AND pb.legacy_regime = false
        AND pb.status IN ('pending','pending_placement')
        AND pb.bet_track IN ('paper','shadow','live')
        AND pb.placed_at >= '2026-05-03 00:00:00+00'::timestamptz
      ORDER BY m.kickoff_time, pb.placed_at
    `);

    // ────────────────────────────────────────────────────────────────────
    // Path P+ views (Phase 3 C1, 2026-05-08): multi-anchor secondary trigger.
    // Same shape as Path P but admits Tier-1 OR Tier-2 anchored bets.
    // Path P stays Tier-1-only as the gold-standard switchover trigger.
    // Path P+ surfaces a separate manual review row when its (looser)
    // thresholds clear — Chris decides whether to flip on that signal.
    // Thresholds: n≥150, net ROI≥3%, net CLV≥1% (vs Path P's 200/3%/2%).
    // The looser CLV is justified because Tier-2 anchors have systematically
    // higher noise than Pinnacle; the 1pp floor is "above zero with
    // confidence" rather than "high-conviction".
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`DROP VIEW IF EXISTS switchover_whitelist_p_plus`);
    await db.execute(sql`DROP VIEW IF EXISTS gate_components_p_plus`);
    await db.execute(sql`DROP VIEW IF EXISTS evaluation_pool_p_plus`);

    await db.execute(sql`
      CREATE OR REPLACE VIEW evaluation_pool_p_plus AS
      SELECT pb.*
      FROM paper_bets pb
      WHERE pb.legacy_regime = false
        AND pb.deleted_at IS NULL
        AND pb.bet_track = 'paper'
        AND pb.status IN ('won','lost')
        AND pb.clv_source_tier IN (1, 2)
        AND pb.gross_pnl IS NOT NULL
        AND pb.commission_amount IS NOT NULL
        AND pb.net_pnl IS NOT NULL
        AND pb.placed_at >= COALESCE(
          (SELECT value::timestamptz FROM agent_config WHERE key = 'evaluation_start_at'),
          'infinity'::timestamptz
        )
    `);

    await db.execute(sql`
      CREATE OR REPLACE VIEW gate_components_p_plus AS
      WITH p AS (SELECT * FROM evaluation_pool_p_plus)
      SELECT
        (SELECT COUNT(*) FROM p) AS pool_size,
        (SELECT
           CASE WHEN SUM(stake::numeric) > 0
                THEN SUM(net_pnl::numeric) / SUM(stake::numeric)
                ELSE NULL END
         FROM p) AS aggregate_net_roi,
        (SELECT AVG(clv_pct::numeric) FROM p) AS aggregate_net_clv,
        (SELECT COUNT(*) FROM p WHERE clv_source_tier = 1) AS n_tier_1,
        (SELECT COUNT(*) FROM p WHERE clv_source_tier = 2) AS n_tier_2
    `);

    await db.execute(sql`
      CREATE OR REPLACE VIEW switchover_whitelist_p_plus AS
      SELECT pb.market_type, m.league,
             COUNT(*) AS n,
             SUM(pb.net_pnl::numeric) / NULLIF(SUM(pb.stake::numeric), 0) AS scope_net_roi,
             AVG(pb.clv_pct::numeric) AS scope_net_clv,
             COUNT(*) FILTER (WHERE pb.clv_source_tier = 1) AS n_tier_1,
             COUNT(*) FILTER (WHERE pb.clv_source_tier = 2) AS n_tier_2,
             COUNT(DISTINCT pb.clv_source) FILTER (WHERE pb.clv_source_tier = 2) AS distinct_t2_books
      FROM evaluation_pool_p_plus pb
      JOIN matches m ON m.id = pb.match_id
      GROUP BY pb.market_type, m.league
      HAVING COUNT(*) >= 50
         AND (SUM(pb.net_pnl::numeric) / NULLIF(SUM(pb.stake::numeric), 0)) > 0
         AND AVG(pb.clv_pct::numeric) > 0
         -- Diversity guard: if scope has Tier-2 anchored bets, require ≥2
         -- distinct Tier-2 books so we're not piggybacking a single soft.
         AND (COUNT(*) FILTER (WHERE pb.clv_source_tier = 2) = 0
              OR COUNT(DISTINCT pb.clv_source) FILTER (WHERE pb.clv_source_tier = 2) >= 2)
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
      -- Phase 3 Path C relaxation (2026-05-08): per-scope CLV>0 dropped.
      -- Scopes admit on n>=50 + scope_net_roi>0 only. CLV is computed for
      -- diagnostic but unanchored scopes (NULL CLV) still admit.
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
    // 2026-05-08 (post-RCA): data_quality_alerts table.
    // Generalised ingestion-health monitor. Populated by services/
    // dataQualityMonitor.ts (runs daily 02:00 UTC). Operator query:
    //   SELECT * FROM data_quality_alerts WHERE acknowledged_at IS NULL.
    // Tracks any external data source that has a daily volume baseline.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS data_quality_alerts (
        id SERIAL PRIMARY KEY,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source TEXT NOT NULL,
        metric TEXT NOT NULL,
        observed_value NUMERIC NOT NULL,
        baseline_value NUMERIC NOT NULL,
        baseline_window_start DATE NOT NULL,
        baseline_window_end DATE NOT NULL,
        ratio NUMERIC NOT NULL,
        threshold_ratio NUMERIC NOT NULL DEFAULT 0.5,
        severity TEXT NOT NULL,
        manifest JSONB,
        acknowledged_at TIMESTAMPTZ,
        acknowledged_note TEXT
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'data_quality_alerts_severity_check'
        ) THEN
          ALTER TABLE data_quality_alerts
            ADD CONSTRAINT data_quality_alerts_severity_check
            CHECK (severity IN ('warn','critical'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS data_quality_alerts_unack_idx
        ON data_quality_alerts(detected_at DESC) WHERE acknowledged_at IS NULL
    `);

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-08 (post-RCA): adaptive_thresholds table.
    // Bayesian recommender (services/adaptiveThresholdRecommender.ts) writes
    // recommendations here weekly Sunday 12:00 UTC. pinnaclePreBetFilter
    // and other future threshold consumers read with fallback chain
    // (tier_market → market_type → global → agent_config → hardcoded floor).
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS adaptive_thresholds (
        id SERIAL PRIMARY KEY,
        evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scope_type TEXT NOT NULL,
        scope_value TEXT NOT NULL,
        threshold_name TEXT NOT NULL,
        recommended_value NUMERIC NOT NULL,
        prior_value NUMERIC NOT NULL,
        evidence_bucket_data JSONB NOT NULL,
        posterior_summary JSONB NOT NULL,
        sample_size INTEGER NOT NULL,
        applied BOOLEAN NOT NULL DEFAULT false,
        reason TEXT
      )
    `);
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'adaptive_thresholds_scope_type_check'
        ) THEN
          ALTER TABLE adaptive_thresholds
            ADD CONSTRAINT adaptive_thresholds_scope_type_check
            CHECK (scope_type IN ('global','market_type','tier_market'));
        END IF;
      END $$
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS adaptive_thresholds_scope_recent_idx
        ON adaptive_thresholds(scope_type, scope_value, threshold_name, evaluated_at DESC)
    `);

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-08 Phase C1: Tier-B league coverage refresh.
    //
    // Background: oddspapi_league_coverage tracks per-league results from
    // the fixture-mapping cron. Leagues marked hasOdds=0 with recent
    // last_checked (< 7d ago) are EXCLUDED from prefetch. Many Tier-B
    // leagues have been silently in this state since the league-universe
    // expansion (Phase 2.A, 2026-05-03). Resetting last_checked forces
    // the next prefetch + mapping cycle to give them a fair retry.
    //
    // Idempotent: only resets where last_checked is recent. Doesn't
    // disrupt currently-mapped leagues.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      UPDATE oddspapi_league_coverage
      SET last_checked = '2025-01-01'::timestamptz
      WHERE league IN (
        SELECT name FROM competition_config
        WHERE universe_tier = 'B' AND is_active = true
      ) AND last_checked > NOW() - INTERVAL '7 days'
    `);

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-08 (post-RCA): clv_data_quality='partial_fallback' backfill.
    // Phase 2.A prefetch refocus + Pinnacle-required filter compounded on
    // 2026-05-04. Paper bets settled May 4 → fix-deploy that used the
    // api_football_real:Pinnacle fallback (rather than oddspapi_pinnacle)
    // are flagged so the Path P pool excludes them. They remain valid
    // historical learning data; just not Path-P-evaluation-grade.
    //
    // Heuristic: a paper bet settled in this window is flagged
    // 'partial_fallback' if no oddspapi_pinnacle snapshot exists for its
    // (match_id, market_type, selection_name) at any time in the 24h
    // before placed_at. The current Path P pool view filters on
    // clv_source='pinnacle'; this UPDATE additionally distinguishes the
    // fallback subset for the post-fix policy.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      UPDATE paper_bets pb
      SET clv_data_quality = 'partial_fallback'
      WHERE pb.legacy_regime = false
        AND pb.deleted_at IS NULL
        AND pb.bet_track = 'paper'
        AND pb.placed_at BETWEEN '2026-05-04 00:00:00+00'::timestamptz AND NOW()
        AND COALESCE(pb.clv_data_quality, 'incomplete') NOT IN ('partial_fallback','none')
        AND NOT EXISTS (
          SELECT 1 FROM odds_snapshots os
          WHERE os.match_id = pb.match_id
            AND os.market_type = pb.market_type
            AND os.selection_name = pb.selection_name
            AND os.source = 'oddspapi_pinnacle'
            AND os.snapshot_time BETWEEN (pb.placed_at - INTERVAL '24 hours') AND pb.placed_at
        )
    `);

    // The evaluation_pool view (gate_components etc.) already filters
    // clv_source='pinnacle'. Path P pool now ALSO needs to exclude
    // partial_fallback rows. Recreate the view with the additional filter.
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
        AND COALESCE(pb.clv_data_quality, 'incomplete') != 'partial_fallback'
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
    await db.execute(sql`
      CREATE OR REPLACE VIEW switchover_whitelist AS
      -- Phase 3 Path C relaxation (2026-05-08): per-scope CLV>0 dropped.
      -- Scopes admit on n>=50 + scope_net_roi>0 only. CLV is computed for
      -- diagnostic but unanchored scopes (NULL CLV) still admit.
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
    //
    // 2026-05-09 ROOT CAUSE FIX: even with IF NOT EXISTS, Postgres still
    // tries to acquire the table lock to verify, and on this hot table
    // (constantly written by exchange_book_sweep) the lock_timeout=5s
    // role-level setting fails the statement. This crashed startup on
    // every boot once we got past the v_upcoming_bets fix. Skip if the
    // index already exists — it does, in production — to avoid the lock
    // attempt entirely. Catch any other error so a single migration
    // failure doesn't kill the entire startup.
    // ────────────────────────────────────────────────────────────────────
    try {
      const existing = await db.execute(sql`
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'odds_snapshots'
          AND indexname = 'odds_snapshots_match_time_idx'
        LIMIT 1
      `);
      const alreadyExists = (((existing as any).rows ?? []) as unknown[]).length > 0;
      if (!alreadyExists) {
        await db.execute(sql`
          CREATE INDEX IF NOT EXISTS odds_snapshots_match_time_idx
            ON odds_snapshots(match_id, snapshot_time DESC)
        `);
        logger.info("odds_snapshots_match_time_idx created");
      } else {
        logger.debug("odds_snapshots_match_time_idx already exists — skipping");
      }
    } catch (err) {
      logger.warn({ err }, "odds_snapshots_match_time_idx migration skipped (non-fatal)");
    }

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-08 (§4.1 of root-cause-analysis): role-level Postgres
    // timeouts. Without these, a runaway query hangs indefinitely on
    // Neon, billing continuous compute and starving other crons.
    // Per-connection SETs are issued by lib/db/src/index.ts on every
    // pool connect; the role-level defaults below apply to any new
    // session that misses the pool init (e.g., direct psql).
    //
    // Limits:
    //   statement_timeout       60s — single query upper bound
    //   lock_timeout             5s — table/row lock acquisition
    //   idle_in_tx_timeout       2 min — leaked transaction cleanup
    //
    // Genuinely long jobs (migrations, full ingestion) override per-
    // session via withExtendedTimeout() in lib/db.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql.raw(`
      ALTER ROLE neondb_owner SET statement_timeout = '60s';
    `)).catch((err) => {
      logger.warn({ err }, "ALTER ROLE statement_timeout failed (non-fatal — relies on per-connection SETs)");
    });
    await db.execute(sql.raw(`
      ALTER ROLE neondb_owner SET lock_timeout = '5s';
    `)).catch((err) => {
      logger.warn({ err }, "ALTER ROLE lock_timeout failed");
    });
    await db.execute(sql.raw(`
      ALTER ROLE neondb_owner SET idle_in_transaction_session_timeout = '120s';
    `)).catch((err) => {
      logger.warn({ err }, "ALTER ROLE idle_in_transaction_session_timeout failed");
    });

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-08 (§4.2 of root-cause-analysis): cron stale-alert table.
    // Populated by services/cronHealthMonitor.ts (runs every 5 min).
    // Operator query: SELECT * FROM cron_stale_alert WHERE acknowledged_at IS NULL.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS cron_stale_alert (
        id SERIAL PRIMARY KEY,
        detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        job_name TEXT NOT NULL,
        last_success_at TIMESTAMPTZ,
        expected_cadence_ms INTEGER NOT NULL,
        alert_after_ms INTEGER NOT NULL,
        stale_ms BIGINT NOT NULL,
        manifest JSONB,
        acknowledged_at TIMESTAMPTZ,
        acknowledged_note TEXT
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS cron_stale_alert_unack_idx
        ON cron_stale_alert(detected_at DESC) WHERE acknowledged_at IS NULL
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

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-09: trading-cycle DISTINCT ON hot-path index. The query
    //   SELECT DISTINCT ON (match_id, market_type, selection_name, source) ...
    //   FROM odds_snapshots
    //   WHERE match_id IN (...) AND snapshot_time >= ...
    //   ORDER BY match_id, market_type, selection_name, source, snapshot_time DESC
    // (valueDetection.ts:1283) was running 25–30s+ on the 15M-row table
    // because the closest existing index, (match_id, snapshot_time DESC),
    // doesn't satisfy the DISTINCT ON ordering. Postgres falls back to a
    // huge in-memory sort. Adding the full key prefix lets the planner do
    // an index skip-scan: one row per group. CONCURRENTLY because the
    // table is 2.3 GB and we cannot lock writes during the build.
    // Wrapped in a sub-try so the rest of migrations succeed if this
    // index already exists or the build is in progress from a prior run.
    // ────────────────────────────────────────────────────────────────────
    try {
      await db.execute(sql.raw(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_odds_snapshots_distinct_on
           ON odds_snapshots (match_id, market_type, selection_name, source, snapshot_time DESC)`,
      ));
      logger.info("odds_snapshots DISTINCT-ON index ready");
    } catch (err) {
      logger.warn({ err }, "CREATE INDEX CONCURRENTLY for odds_snapshots failed (non-fatal — may already exist or be building)");
    }

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-09 (Bundle 9 — weather expansion): venues + match_weather tables.
    // Per Bundle 9 plan v3. Wikipedia auto-classifier feeds is_indoor /
    // is_retractable. OpenWeatherMap fetches fed by 3 triggers (T-24h /
    // T-3h / lineup-event). featureEngine consumes raw + 6 compound features
    // for retrospective predictive-power validation per cell.
    //
    // is_indoor=true short-circuits weather fetch (no row written; features
    // absent — the absence IS the signal). Default outdoor for unknown
    // classifications per plan §0.3 — less harmful than mis-emitting weather
    // for an undetected indoor stadium.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS venues (
        api_venue_id INTEGER PRIMARY KEY,
        venue_name TEXT,
        city TEXT,
        country TEXT,
        lat NUMERIC(8,5),
        lon NUMERIC(8,5),
        is_indoor BOOLEAN NOT NULL DEFAULT FALSE,
        is_retractable BOOLEAN NOT NULL DEFAULT FALSE,
        classification_text TEXT,
        wikipedia_url TEXT,
        geocoded_at TIMESTAMPTZ,
        classified_at TIMESTAMPTZ,
        geocoding_source TEXT,
        classification_source TEXT
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS venues_classification_pending_idx
        ON venues(classified_at) WHERE classified_at IS NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS venues_geocoding_pending_idx
        ON venues(geocoded_at) WHERE geocoded_at IS NULL
    `);

    // venue_api_id back-reference on matches. Idempotent ADD COLUMN IF NOT EXISTS.
    await db.execute(sql`
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS venue_api_id INTEGER
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS matches_venue_api_id_idx
        ON matches(venue_api_id) WHERE venue_api_id IS NOT NULL
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS match_weather (
        match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        trigger_source TEXT NOT NULL,
        kickoff_temp_c NUMERIC(4,1),
        kickoff_wind_kph NUMERIC(5,1),
        kickoff_precipitation_mm NUMERIC(5,2),
        kickoff_humidity_pct INTEGER,
        kickoff_cloud_pct INTEGER,
        weather_source TEXT NOT NULL DEFAULT 'openweathermap'
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS match_weather_fetched_idx
        ON match_weather(fetched_at DESC)
    `);
    logger.info("venues + match_weather + matches.venue_api_id ready");

    // ────────────────────────────────────────────────────────────────────
    // 2026-05-09 (Bundle 2 / plan v3 §M7): per-referee card-rate aggregation.
    // Joins match_referees with matches.total_cards (already populated for
    // matches with stats coverage). Sample-size floor of n>=20 is enforced
    // at the consumer side (featureEngine), not the view, so the view's
    // n_matches column lets the consumer fall back to league-average when
    // the referee is below the floor.
    //
    // Currently sparse: ~24 referee rows total / 24 distinct referees. The
    // view will return empty rows above the threshold for several weeks
    // while referee data accumulates. The pipeline is built so that lift
    // materialises automatically as data flows in.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE OR REPLACE VIEW referee_card_rates AS
      SELECT
        mr.referee_name,
        m.league,
        COUNT(*) AS n_matches,
        AVG(m.total_cards::numeric)::numeric(6,3) AS avg_cards_per_match,
        STDDEV(m.total_cards::numeric)::numeric(6,3) AS stddev_cards_per_match,
        MIN(m.total_cards) AS min_cards,
        MAX(m.total_cards) AS max_cards
      FROM match_referees mr
      JOIN matches m ON m.id = mr.match_id
      WHERE m.total_cards IS NOT NULL
        AND m.status = 'finished'
      GROUP BY mr.referee_name, m.league
    `);
    logger.info("referee_card_rates view ready");

    // ────────────────────────────────────────────────────────────────────
    // Pre-flip blocker #3 (2026-05-09): post-cutover paper-bet hard block.
    // Once agent_config.cutover_completed_at is set, no new row may be
    // inserted with bet_track='paper'. Existing rows untouched (the trigger
    // is INSERT-only); settlement UPDATEs unaffected. Belt-and-braces backstop
    // to placePaperBet's branch change.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION reject_paper_bet_after_cutover() RETURNS trigger AS $$
      DECLARE
        cutover_at TIMESTAMPTZ;
      BEGIN
        SELECT (value::timestamptz) INTO cutover_at
        FROM agent_config WHERE key = 'cutover_completed_at' LIMIT 1;

        IF cutover_at IS NOT NULL AND NEW.bet_track = 'paper' THEN
          RAISE EXCEPTION 'paper bet emission disallowed after cutover at % (match_id=%, market_type=%)',
            cutover_at, NEW.match_id, NEW.market_type;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.execute(sql`
      DROP TRIGGER IF EXISTS paper_bets_no_paper_post_cutover ON paper_bets
    `);
    await db.execute(sql`
      CREATE TRIGGER paper_bets_no_paper_post_cutover
      BEFORE INSERT ON paper_bets
      FOR EACH ROW EXECUTE FUNCTION reject_paper_bet_after_cutover()
    `);
    logger.info("paper_bets_no_paper_post_cutover trigger ready");

    // ────────────────────────────────────────────────────────────────────
    // Pre-flip blocker #7 (2026-05-09): locked_reserve singleton + audit.
    // Active bankroll for staking = Betfair availableToBetBalance − locked_reserve.
    // Operator locks profits via npm run reserve -- lock; physical Betfair → bank
    // withdrawals are detected via listAccountStatement and auto-reduce the lock.
    // ────────────────────────────────────────────────────────────────────
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS locked_reserve (
        id              SERIAL PRIMARY KEY,
        current_locked  NUMERIC(14,2) NOT NULL DEFAULT 0,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      INSERT INTO locked_reserve (current_locked)
      SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM locked_reserve)
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS reserve_events (
        id                       SERIAL PRIMARY KEY,
        event_type               TEXT NOT NULL CHECK (event_type IN ('lock','unlock','withdrawal_recorded','reconcile_adjust')),
        amount                   NUMERIC(14,2) NOT NULL,
        prior_locked             NUMERIC(14,2) NOT NULL,
        new_locked               NUMERIC(14,2) NOT NULL,
        betfair_balance_at_event NUMERIC(14,2),
        notes                    TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by               TEXT NOT NULL DEFAULT 'operator'
      )
    `);
    logger.info("locked_reserve + reserve_events tables ready");

    // ────────────────────────────────────────────────────────────────────
    // Reliability / observability schema (Phase 2 of VPS-first architecture
    // with selective Neon backup). Ten tables.
    //
    // Drizzle ORM types live in lib/db/src/schema/reliability.ts; the SQL
    // below is the source-of-truth DDL that runs on startup. Every Neon
    // writer added in Phase 3+ MUST be entered in docs/RELIABILITY.md
    // under "Why each Neon write exists."
    //
    // No foreign keys to operational tables (no FK from internal_bet_id to
    // the bets table, etc). Deliberate: reliability schema must remain
    // queryable even if upstream rows are pruned, and FK constraints fight
    // UPSERT patterns under retry. Consequence: writers must validate
    // referential integrity at write time where it matters.
    //
    // Naming note: the bets-of-record table is called `paper_bets` in the
    // schema for historical reasons (pre-cutover paper-trading era). Post-
    // 2026-05-09 cutover, paper-bet emission is permanently disabled — every
    // bet in that table is now live. The table name is a database artifact,
    // not an architectural concept.
    //
    // All reliability tables are additive-only. No ALTER TABLE in this
    // block. If a column needs adding, do it in a NEW startup block below
    // and document why. The CREATE-IF-NOT-EXISTS-on-startup model tolerates
    // additive growth but is fragile under destructive change — see
    // TODO.md "Migration model technical debt."
    // ────────────────────────────────────────────────────────────────────

    // 1. self_healing_actions — append-only audit of recovery actions.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS self_healing_actions (
        id            SERIAL PRIMARY KEY,
        occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        action_type   TEXT NOT NULL,
        component     TEXT NOT NULL,
        triggered_by  TEXT NOT NULL,
        before_state  JSONB,
        after_state   JSONB,
        detail        JSONB,
        success       BOOLEAN NOT NULL,
        error_message TEXT
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_self_healing_actions_occurred ON self_healing_actions(occurred_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_self_healing_actions_component ON self_healing_actions(component)`);

    // 2. escalations — alerts dispatched to a notification channel, with
    //    full lifecycle (raise → deliver → ack → resolve).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS escalations (
        id                SERIAL PRIMARY KEY,
        raised_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        severity          TEXT NOT NULL,
        code              TEXT NOT NULL,
        title             TEXT NOT NULL,
        message           TEXT NOT NULL,
        metadata          JSONB,
        channel           TEXT NOT NULL,
        delivered         BOOLEAN NOT NULL DEFAULT FALSE,
        delivered_at      TIMESTAMPTZ,
        delivery_error    TEXT,
        acknowledged      BOOLEAN NOT NULL DEFAULT FALSE,
        acknowledged_at   TIMESTAMPTZ,
        acknowledged_by   TEXT,
        resolved          BOOLEAN NOT NULL DEFAULT FALSE,
        resolved_at       TIMESTAMPTZ,
        resolution_note   TEXT
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_escalations_raised ON escalations(raised_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_escalations_open ON escalations(resolved, raised_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_escalations_code ON escalations(code)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_escalations_severity ON escalations(severity, raised_at)`);

    // 3. placement_reconciliation — one row per bet, in-place UPSERT.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS placement_reconciliation (
        internal_bet_id          INTEGER PRIMARY KEY,
        betfair_bet_id           TEXT,
        db_status                TEXT NOT NULL,
        betfair_status           TEXT,
        mismatch_class           TEXT,
        mismatch_first_seen_at   TIMESTAMPTZ,
        mismatch_resolved_at     TIMESTAMPTZ,
        pass_count               INTEGER NOT NULL DEFAULT 0,
        last_check_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_pass_detail         JSONB
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_placement_recon_mismatch ON placement_reconciliation(mismatch_class, last_check_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_placement_recon_betfair_id ON placement_reconciliation(betfair_bet_id)`);

    // 4. system_health — UPSERT keyed by component, ~10 rows total.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_health (
        component                  TEXT PRIMARY KEY,
        status                     TEXT NOT NULL,
        last_check_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_status_change_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        consecutive_failures       INTEGER NOT NULL DEFAULT 0,
        detail                     JSONB
      )
    `);

    // 5. reliability_daily_summary — one row per UTC day from VPS rollup.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS reliability_daily_summary (
        day                          DATE PRIMARY KEY,
        placements_attempted         INTEGER NOT NULL DEFAULT 0,
        placements_succeeded         INTEGER NOT NULL DEFAULT 0,
        placements_failed            INTEGER NOT NULL DEFAULT 0,
        bets_settled                 INTEGER NOT NULL DEFAULT 0,
        avg_settlement_lag_hours     NUMERIC(6,2),
        p95_settlement_lag_hours     NUMERIC(6,2),
        abs_drift_gbp                NUMERIC(10,2),
        rel_drift_pct                NUMERIC(6,3),
        self_healing_count           INTEGER NOT NULL DEFAULT 0,
        escalation_count             INTEGER NOT NULL DEFAULT 0,
        mismatches_open_at_eod       INTEGER NOT NULL DEFAULT 0,
        mismatches_resolved          INTEGER NOT NULL DEFAULT 0,
        net_pnl_gbp                  NUMERIC(10,2),
        detail                       JSONB,
        written_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // 6. health_5m_rollup — per-component 5-min status time-series, 14d.
    //    UPSERT (component, bucket_start) with worst-status CASE.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS health_5m_rollup (
        component         TEXT NOT NULL,
        bucket_start      TIMESTAMPTZ NOT NULL,
        dominant_status   TEXT NOT NULL,
        event_count       INTEGER NOT NULL DEFAULT 0,
        error_count       INTEGER NOT NULL DEFAULT 0,
        last_error_class  TEXT,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (component, bucket_start)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_health_5m_component_recent ON health_5m_rollup(component, bucket_start)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_health_5m_bucket ON health_5m_rollup(bucket_start)`);

    // 7. cycle_counters_5m — system-wide 5-min counters, 14d. UPSERT
    //    (bucket_start) with atomic counter increments via EXCLUDED.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS cycle_counters_5m (
        bucket_start         TIMESTAMPTZ PRIMARY KEY,
        cycles_run           INTEGER NOT NULL DEFAULT 0,
        cycles_failed        INTEGER NOT NULL DEFAULT 0,
        cycles_zero_bets     INTEGER NOT NULL DEFAULT 0,
        bets_attempted       INTEGER NOT NULL DEFAULT 0,
        bets_placed          INTEGER NOT NULL DEFAULT 0,
        bets_failed          INTEGER NOT NULL DEFAULT 0,
        betfair_api_errors   INTEGER NOT NULL DEFAULT 0,
        betfair_api_p95_ms   INTEGER,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_cycle_counters_5m_bucket ON cycle_counters_5m(bucket_start)`);

    // 8. recent_cycles_buffer — fixed ring buffer, last 500 cycles.
    //    Cap enforced by post-INSERT DELETE-by-rank in writer code (NOT DDL).
    //    Weekly storage check verifies COUNT(*) <= 550 amber / 1000 red.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS recent_cycles_buffer (
        cycle_id             TEXT PRIMARY KEY,
        cycle_type           TEXT NOT NULL,
        started_at           TIMESTAMPTZ NOT NULL,
        ended_at             TIMESTAMPTZ,
        duration_ms          INTEGER,
        steps_attempted      INTEGER NOT NULL DEFAULT 0,
        steps_succeeded      INTEGER NOT NULL DEFAULT 0,
        steps_failed         INTEGER NOT NULL DEFAULT 0,
        bets_attempted       INTEGER NOT NULL DEFAULT 0,
        bets_placed          INTEGER NOT NULL DEFAULT 0,
        terminal_outcome     TEXT NOT NULL,
        terminal_error_class TEXT,
        summary_detail       JSONB
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_recent_cycles_started ON recent_cycles_buffer(started_at)`);

    // 9. failed_cycle_breadcrumbs — full per-step trace, copied from VPS
    //    SQLite ONLY for cycles that terminated in failure. 30-day retention.
    //    UNIQUE(cycle_id, step_seq): the VPS→Neon copy is retry-prone (network
    //    blip mid-copy → half rows land → retry). Phase 3 writer must use
    //    `INSERT ... ON CONFLICT (cycle_id, step_seq) DO NOTHING` — without
    //    this constraint, retries produce duplicate breadcrumbs that mislead
    //    forensic reads.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS failed_cycle_breadcrumbs (
        id              SERIAL PRIMARY KEY,
        cycle_id        TEXT NOT NULL,
        step_seq        INTEGER NOT NULL,
        step_name       TEXT NOT NULL,
        started_at      TIMESTAMPTZ NOT NULL,
        ended_at        TIMESTAMPTZ,
        success         BOOLEAN NOT NULL,
        duration_ms     INTEGER,
        error_message   TEXT,
        detail          JSONB,
        copied_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_failed_breadcrumbs_cycle_step ON failed_cycle_breadcrumbs(cycle_id, step_seq)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_failed_breadcrumbs_copied ON failed_cycle_breadcrumbs(copied_at)`);

    // 10. mismatch_pass_history — reconciliation passes ONLY for currently
    //     mismatched bets. Bounded by open-mismatch count, not bet count.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS mismatch_pass_history (
        id                SERIAL PRIMARY KEY,
        internal_bet_id   INTEGER NOT NULL,
        betfair_bet_id    TEXT,
        pass_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        db_status         TEXT NOT NULL,
        betfair_status    TEXT,
        mismatch_class    TEXT NOT NULL,
        detail            JSONB,
        resolved          BOOLEAN NOT NULL DEFAULT FALSE,
        resolved_at       TIMESTAMPTZ
      )
    `);
    // The unique index uq_mismatch_pass_bet_at covers (internal_bet_id, pass_at)
    // for both lookup and uniqueness — no separate non-unique index needed.
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_mismatch_pass_unresolved ON mismatch_pass_history(resolved, pass_at)`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_mismatch_pass_bet_at ON mismatch_pass_history(internal_bet_id, pass_at)`);

    logger.info("Reliability observability tables ready (10 tables)");

    // Bundle B — analytics scratch tables (Task 12 from theory plan).
    // Populated nightly by runBundleBAnalytics() in services/analysisJobs.ts.
    // Composite PK keeps history; one row per (snapshot, league, market, track).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS analysis_segment_stats (
        computed_at   TIMESTAMPTZ NOT NULL,
        league        TEXT NOT NULL,
        market_type   TEXT NOT NULL,
        bet_track     TEXT NOT NULL,
        n             INTEGER NOT NULL,
        w             INTEGER NOT NULL,
        stake         NUMERIC NOT NULL,
        pnl           NUMERIC NOT NULL,
        avg_clv       NUMERIC,
        sd_clv        NUMERIC,
        clv_n         INTEGER NOT NULL,
        PRIMARY KEY (computed_at, league, market_type, bet_track)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_analysis_segment_stats_recent ON analysis_segment_stats(computed_at DESC)`);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS analysis_signal_strength (
        computed_at          TIMESTAMPTZ NOT NULL,
        league               TEXT NOT NULL,
        market_type          TEXT NOT NULL,
        bet_track            TEXT NOT NULL,
        n                    INTEGER NOT NULL,
        win_rate             NUMERIC,
        wilson_lo95_winrate  NUMERIC,
        roi                  NUMERIC,
        shrunk_roi           NUMERIC,
        avg_clv              NUMERIC,
        clv_t_stat           NUMERIC,
        qualifies_live       BOOLEAN NOT NULL DEFAULT FALSE,
        qualification_basis  TEXT NOT NULL DEFAULT 'insufficient',
        PRIMARY KEY (computed_at, league, market_type, bet_track)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_analysis_signal_strength_recent ON analysis_signal_strength(computed_at DESC)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_analysis_signal_strength_qualifies ON analysis_signal_strength(qualifies_live, computed_at DESC) WHERE qualifies_live = TRUE`);

    // Operator view — latest live-eligibility candidates, sorted by strength.
    // No UI consumer (per project memory); read via SQL editor.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_live_eligibility_candidates AS
      SELECT
        s.league,
        s.market_type,
        s.bet_track,
        s.n,
        s.win_rate,
        s.wilson_lo95_winrate,
        s.roi,
        s.shrunk_roi,
        s.avg_clv,
        s.clv_t_stat,
        s.qualifies_live,
        s.qualification_basis,
        s.computed_at
      FROM analysis_signal_strength s
      WHERE s.computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength)
        AND s.qualifies_live = TRUE
      ORDER BY
        CASE WHEN s.clv_t_stat IS NULL THEN 1 ELSE 0 END,
        s.clv_t_stat DESC NULLS LAST,
        s.shrunk_roi DESC NULLS LAST
    `);

    logger.info("Bundle B analytics tables ready");

    // Task 12 — calibration_buckets. Per-(league × market_type) calibration
    // params, fitted weekly by scripts/python/fit_calibration.py.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS calibration_buckets (
        bucket_id     SERIAL PRIMARY KEY,
        scope_league  TEXT,
        market_type   TEXT NOT NULL,
        method        TEXT NOT NULL,
        fitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        n_samples     INTEGER NOT NULL,
        params        JSONB NOT NULL,
        brier_in      NUMERIC(10,6),
        brier_out     NUMERIC(10,6),
        ece_out       NUMERIC(10,6),
        active        BOOLEAN NOT NULL DEFAULT TRUE
      )
    `);
    // Active calibration lookup: hot-path read filters on (scope_league,
    // market_type, active=true). Most buckets stay active for the week
    // between fits, so the WHERE active=true partial index keeps it small.
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS calibration_buckets_active_lookup
        ON calibration_buckets(scope_league, market_type)
        WHERE active = TRUE
    `);
    // History scan for the weekly fitter (it deactivates prior actives and
    // inserts a fresh row).
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS calibration_buckets_fitted_at
        ON calibration_buckets(fitted_at DESC)
    `);

    // Task 12 — preserve pre-calibration model probability for audit, plus
    // a backreference to the calibration_buckets row that was applied (NULL
    // if no bucket was active for the scope at emission time).
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS raw_model_probability NUMERIC(8,6),
        ADD COLUMN IF NOT EXISTS calibration_bucket_id INTEGER
    `);

    // Task 11 (Phase 3d.3) — synthetic CLV shadow columns. Parallels
    // clv_pct without touching it. Backfilled by the syntheticClv cron
    // for recently-settled bets where consensus snapshots exist within
    // ±5min of kickoff.
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS synthetic_clv_pct NUMERIC(8,3),
        ADD COLUMN IF NOT EXISTS consensus_quality SMALLINT,
        ADD COLUMN IF NOT EXISTS clv_consensus_sources JSONB
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS paper_bets_synthetic_clv_backfill
        ON paper_bets(settled_at)
        WHERE synthetic_clv_pct IS NULL
          AND status IN ('won','lost')
          AND deleted_at IS NULL
    `);

    logger.info("Calibration buckets ready (Task 12)");

    // Task 11 — sharp consensus snapshots (Phase 3d.1). One row per
    // (match × market × selection × snapshot_at × source). The
    // sharpConsensus service reads + aggregates these via weighted
    // geometric mean for the CLV pipeline (Phase 3d.2 wires it in).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sharp_consensus_snapshots (
        match_id         INTEGER NOT NULL,
        market_type      TEXT NOT NULL,
        selection_name   TEXT NOT NULL,
        snapshot_at      TIMESTAMPTZ NOT NULL,
        source           TEXT NOT NULL,
        back_odds        NUMERIC(10,4) NOT NULL,
        fair_probability NUMERIC(8,6),
        trust_weight     NUMERIC(6,4),
        raw_payload      JSONB,
        PRIMARY KEY (match_id, market_type, selection_name, snapshot_at, source)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS sharp_consensus_lookup
        ON sharp_consensus_snapshots(match_id, market_type, selection_name, snapshot_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS sharp_consensus_source_recent
        ON sharp_consensus_snapshots(source, snapshot_at DESC)
    `);

    logger.info("Sharp consensus snapshots ready (Task 11)");

    // Task 15 — daily ClubElo snapshots (Phase 4a). ~3,300 rows/day,
    // primary-key (date, team_name) for idempotent upsert.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS club_elo_snapshots (
        date        DATE NOT NULL,
        team_name   TEXT NOT NULL,
        country     TEXT,
        level       SMALLINT,
        elo         NUMERIC(8,3) NOT NULL,
        rank        INTEGER,
        from_date   DATE,
        to_date     DATE,
        PRIMARY KEY (date, team_name)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS club_elo_team_recent
        ON club_elo_snapshots(team_name, date DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS club_elo_country_level
        ON club_elo_snapshots(country, level, date DESC)
    `);

    logger.info("ClubElo snapshots ready (Task 15)");

    logger.info("Migrations complete");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  }
}
