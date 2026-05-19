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
  // Task 24 Part D (2026-05-11): PERSIST persistence type for high-edge
  // ASIAN_HANDICAP. When enabled, unmatched portion goes to Starting
  // Price at in-play instead of LAPSE. Gated default OFF — this is a
  // money-guardrail change (exposes the residual to SP execution risk)
  // and needs explicit operator approval per feedback_autonomy_and_guardrails.
  // Flip to 'true' after observing Part C fill-rate uplift on the AH
  // segment for at least a few days.
  { key: "ah_persist_enabled", value: "false" },
  { key: "ah_persist_min_edge", value: "0.15" },
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
        SELECT * FROM paper_bets
        WHERE legacy_regime = false
          AND deleted_at IS NULL
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
        SELECT * FROM paper_bets
        WHERE legacy_regime = false
          AND deleted_at IS NULL
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

    // 2026-05-15 — Tier-1 CLV anchor count. Used by the conditional CLV gate
    // in the eligibility computation: if scope has >= 30 pct Tier-1 (Pinnacle)
    // anchoring then CLV t-stat is required for qualification; if Pinnacle is
    // structurally unavailable for the scope, the CLV gate is suspended and
    // qualification rests on Wilson + bootstrap alone. Backfilled to 0 on
    // existing rows; new rows populated by analysisJobs.runBundleBAnalytics.
    await db.execute(sql`
      ALTER TABLE analysis_segment_stats
      ADD COLUMN IF NOT EXISTS tier1_n INTEGER NOT NULL DEFAULT 0
    `);

    // Document the closing_pinnacle_odds semantic — it can hold Tier-2 anchors
    // when Pinnacle is structurally unavailable. clv_source / clv_source_tier
    // are the truth columns. Column rename deferred to a quiet maintenance
    // window; a comment for now to keep downstream queries unbroken.
    await db.execute(sql`
      COMMENT ON COLUMN paper_bets.closing_pinnacle_odds IS
      'Closing anchor odds. Sources to clv_source (clv_source_tier=1 means Pinnacle / pinnacle_derived; tier=2 means a sharp non-Pinnacle book). Despite the column name, this is NOT exclusively Pinnacle when Pinnacle coverage for the scope is unavailable (e.g. BTTS). Use clv_source / clv_source_tier for the actual anchor identity.'
    `);

    // 2026-05-15 — analysis_exclusion_rules.
    //
    // Filters (market_type, bet_track) cohorts out of analysis_segment_stats +
    // analysis_signal_strength computation when an uncleared rule exists and
    // the paper_bets row's placed_at is before the rule's cutover timestamp.
    //
    // Hard cutover semantics: pre-cutover rows are excluded permanently;
    // post-cutover rows flow through analysis cleanly. Operator advances the
    // cutover by updating exclude_placed_before for the row (typically to the
    // moment the parser fix that addressed the corrupted data was deployed).
    //
    // Reversible: DROP TABLE analysis_exclusion_rules removes the gate
    // entirely with zero touch on paper_bets. No backward-compat shims
    // needed elsewhere — the analysisJobs.ts NOT EXISTS clauses become
    // vacuously true.
    //
    // Audit trail: cleared_at / cleared_by capture when an operator decides
    // a rule is no longer needed (vs. updating exclude_placed_before which
    // keeps the rule active but advances the cutover).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS analysis_exclusion_rules (
        id                    SERIAL PRIMARY KEY,
        market_type           TEXT NOT NULL,
        bet_track             TEXT NOT NULL CHECK (bet_track IN ('live','shadow','paper')),
        exclude_placed_before TIMESTAMPTZ NOT NULL,
        reason                TEXT NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by            TEXT,
        cleared_at            TIMESTAMPTZ,
        cleared_by            TEXT,
        UNIQUE (market_type, bet_track)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_aer_market_track
        ON analysis_exclusion_rules (market_type, bet_track)
        WHERE cleared_at IS NULL
    `);

    // Initial six rules: AH / OU_15 / OU_05 × {live, shadow}. The
    // exclude_placed_before timestamp = NOW() at migration time, which
    // means ALL existing paper_bets rows for these markets are excluded
    // until the operator advances the cutover post parser-fix-deploy.
    // ON CONFLICT DO NOTHING so repeat migrations are idempotent.
    await db.execute(sql`
      INSERT INTO analysis_exclusion_rules
        (market_type, bet_track, exclude_placed_before, reason, created_by)
      VALUES
        ('ASIAN_HANDICAP','live',   NOW(), 'AH catalogue parser bug — exchangeBookSweep.ts:155 collapses N×2 runners onto Home -4/Away +4 labels with prices from one line bound to label of another. Fabricated edge signal.', 'parser-bug-2026-05-15'),
        ('ASIAN_HANDICAP','shadow', NOW(), 'AH catalogue parser bug — exchangeBookSweep.ts:155 collapses N×2 runners onto Home -4/Away +4 labels with prices from one line bound to label of another. Fabricated edge signal.', 'parser-bug-2026-05-15'),
        ('OVER_UNDER_15', 'live',   NOW(), 'OU_15 fingerprint match (77-85 pct win rate at 43 pct implied) — audit pending', 'parser-bug-2026-05-15'),
        ('OVER_UNDER_15', 'shadow', NOW(), 'OU_15 fingerprint match (77-85 pct win rate at 43 pct implied) — audit pending', 'parser-bug-2026-05-15'),
        ('OVER_UNDER_05', 'live',   NOW(), 'OU_05 fingerprint match (75 pct win rate at 46 pct implied, n=20 small but same pattern)', 'parser-bug-2026-05-15'),
        ('OVER_UNDER_05', 'shadow', NOW(), 'OU_05 fingerprint match (75 pct win rate at 46 pct implied, n=20 small but same pattern)', 'parser-bug-2026-05-15')
      ON CONFLICT (market_type, bet_track) DO NOTHING
    `);

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
    // 2026-05-13 (Lever A+G): bootstrap 95% lower bound on stake-weighted ROI
    // (Efron-Tibshirani percentile method, B=10000). Populated only on the
    // __market_type_aggregate__ rows by runBundleBAnalytics; NULL on every
    // per-(league × market_type) row.
    await db.execute(sql`
      ALTER TABLE analysis_signal_strength
        ADD COLUMN IF NOT EXISTS bootstrap_lo95_roi NUMERIC
    `);

    // Operator view — latest live-eligibility candidates, sorted by strength.
    // No UI consumer (per project memory); read via SQL editor.
    // 2026-05-11 (Task 20 partial — women's football bundle): expose
    // `is_womens_league` flag so operator can see at a glance which
    // qualifying scopes are women's leagues. Pattern-match on the league
    // name covers the common naming conventions (Women / WSL / NWSL /
    // Femenina / Féminine / Frauen / Damallsvenskan / Toppserien etc.)
    // without needing a join (analysis_signal_strength.league is the
    // canonical name; competition_config.gender carries the same info but
    // joining duplicates leagues with both male+female entries).
    // Shin de-vig is already pre-seeded for women's leagues at
    // migrate.ts:1116-1121 (gender='female' rows in competition_config).
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
        s.computed_at,
        -- 2026-05-11: is_womens_league appended at the END of the SELECT list.
        -- Postgres CREATE OR REPLACE VIEW rejects column-order changes;
        -- new columns must be appended after existing ones (cannot change
        -- name of view column 'computed_at' to 'is_womens_league' — this
        -- caused a startup crash-loop when initially placed mid-list).
        (s.league ~* '\\m(women|wsl|nwsl|femenina|féminine|feminina|frauen|damallsvenskan|toppserien|kvindeligaen)\\M')
          AS is_womens_league
      FROM analysis_signal_strength s
      WHERE s.computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength)
        AND s.qualifies_live = TRUE
      ORDER BY
        CASE WHEN s.clv_t_stat IS NULL THEN 1 ELSE 0 END,
        s.clv_t_stat DESC NULLS LAST,
        s.shrunk_roi DESC NULLS LAST
    `);

    // Task 7 / F.7 (2026-05-11 — back-to-theory plan): pre-aggregated
    // eligibility views by market and by league. These give the operator
    // a one-glance view of which scopes qualify without GROUP BY-ing the
    // raw signal-strength table by hand.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_live_eligibility_markets AS
      SELECT
        s.market_type,
        COUNT(*) FILTER (WHERE s.qualifies_live) AS n_leagues_qualifying,
        SUM(s.n)                                  AS n_bets,
        AVG(s.shrunk_roi)                         AS avg_shrunk_roi,
        AVG(s.avg_clv)                            AS avg_clv_pct,
        COUNT(*) FILTER (WHERE s.qualification_basis = 'both') AS n_both,
        COUNT(*) FILTER (WHERE s.qualification_basis = 'roi')  AS n_roi_only,
        COUNT(*) FILTER (WHERE s.qualification_basis = 'clv')  AS n_clv_only
      FROM analysis_signal_strength s
      WHERE s.computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength)
      GROUP BY s.market_type
      ORDER BY n_leagues_qualifying DESC, n_bets DESC
    `);
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_live_eligibility_leagues AS
      SELECT
        s.league,
        COUNT(*) FILTER (WHERE s.qualifies_live) AS n_markets_qualifying,
        SUM(s.n)                                 AS n_bets,
        AVG(s.shrunk_roi)                        AS avg_shrunk_roi,
        AVG(s.avg_clv)                           AS avg_clv_pct
      FROM analysis_signal_strength s
      WHERE s.computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength)
      GROUP BY s.league
      ORDER BY n_markets_qualifying DESC, n_bets DESC
    `);

    // 2026-05-13 (Lever A+G unified): market_type aggregate eligibility view.
    // Reads the __market_type_aggregate__ rows written by runBundleBAnalytics
    // (one per market_type, pooling all leagues). A market_type qualifies live
    // iff ALL THREE gates pass on the aggregate:
    //   Gate 1: Wilson 95% lower bound on win-rate          > 0.50
    //   Gate 2: bootstrap (B=10000) 95% lower bound on ROI  > 0
    //   Gate 3: Student t-stat on mean CLV                  > 1.96
    // Conjunction of three independent statistical proofs is strictly more
    // conservative than any single 95% test; joint Type I error ≤ alpha each.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_live_eligibility_market_types AS
      SELECT
        s.market_type,
        s.bet_track,
        s.n,
        s.win_rate,
        s.wilson_lo95_winrate,
        s.roi,
        s.bootstrap_lo95_roi,
        s.avg_clv,
        s.clv_t_stat,
        s.qualifies_live,
        s.computed_at
      FROM analysis_signal_strength s
      WHERE s.computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength)
        AND s.league = '__market_type_aggregate__'
        AND s.qualifies_live = TRUE
      ORDER BY s.clv_t_stat DESC NULLS LAST, s.bootstrap_lo95_roi DESC NULLS LAST
    `);

    // Bundle 1P (2026-05-16): per-scope edge-evidence view. Answers the
    // operator question "where is the soft edge?" by ranking
    // (league × market_type) scopes by Bundle-1O-filtered (sharp-anchored
    // only) CLV + Wilson + realised ROI.
    //
    // Why: Bundle 1O proved that exchange-anchored CLV (clv_source=
    // 'betfair_exchange') and legacy market_proxy-anchored CLV are not
    // edge signals — they're price drift between two of our own
    // observations. The existing analysis_signal_strength.avg_clv averages
    // over all anchors (including non-sharp). For the operator to know
    // which scopes have PROVEN soft edge vs which are noise, the metrics
    // need a sharp-source filter applied at SQL aggregation time.
    //
    // SHARP_CLV_SOURCES mirrors the allow-list in clvCalibrationAudit.ts;
    // duplication is deliberate (the canonical list lives in
    // services/oddsPapi.ts TIER_2_PRIORITY_ORDER, this view + the audit
    // both quote it because crossing TS/SQL boundary is awkward).
    //
    // Stake-weighting follows the bet_track convention from analysisJobs.ts:
    // shadow uses shadow_stake / shadow_pnl, live/paper uses stake / net_pnl.
    //
    // Bundle 1Q hardening (2026-05-16, post-Phase-1 validation):
    //   (1) Apply analysis_exclusion_rules at view level — match the filter
    //       Bundle B uses so v_scope_edge_evidence doesn't surface scopes
    //       whose "edge" is powered by parser-bug-era contaminated data.
    //   (2) Per-match-level Wilson — collapse multi-bet matches into a
    //       single binary outcome (positive PnL = match-win). Wilson on
    //       per-bet count overstates statistical confidence when the model
    //       fires 7-10 bets per match (different AH lines/sides — observed
    //       in 13-scope drill 2026-05-16, % unique matches 10-22%). The
    //       per-match Wilson is the independence-honest measure.
    //
    // Verdict semantics (Bundle 1Q):
    //   'proven'           — n_matches>=30 AND wilson_lo95_per_match>0.50 AND clv_tstat_sharp>1.96 AND avg_clv_sharp>0
    //   'weak'             — n_matches>=30 AND (wilson_lo95_per_match>0.50 OR clv_tstat_sharp>1.96)
    //   'inverted'         — n_sharp>=30 AND clv_tstat_sharp<-1.96
    //   'inconclusive'     — n_sharp>=10 AND n<30 — sample too thin
    //   'no_sharp_anchor'  — pct_sharp_coverage<0.10 — structural blind spot
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_scope_edge_evidence AS
      WITH sharp_sources(src) AS (
        VALUES
          ('pinnacle'),
          ('pinnacle_derived'),
          ('oddspapi_pinnacle'),
          ('oddspapi_smarkets'),
          ('oddspapi_matchbook'),
          ('oddspapi_sbobet'),
          ('oddspapi_sbo'),
          ('oddspapi_bet365')
      ),
      bets AS (
        SELECT
          COALESCE(m.league, '__unknown__')                            AS league,
          pb.market_type,
          pb.match_id,
          (pb.status = 'won')::int                                     AS won,
          pb.clv_pct::numeric                                          AS clv_pct,
          (pb.clv_source IN (SELECT src FROM sharp_sources))           AS is_sharp,
          CASE WHEN pb.bet_track = 'shadow'
               THEN COALESCE(pb.shadow_stake, 0)
               ELSE pb.stake END::numeric                              AS stake,
          CASE WHEN pb.bet_track = 'shadow'
               THEN COALESCE(pb.shadow_pnl, 0)
               ELSE COALESCE(pb.net_pnl, pb.settlement_pnl, 0) END::numeric AS pnl
        FROM paper_bets pb
        LEFT JOIN matches m ON pb.match_id = m.id
        WHERE pb.placed_at >= '2026-05-09'::date
          AND pb.deleted_at IS NULL
          AND pb.status IN ('won', 'lost')
          AND pb.bet_track IN ('live', 'shadow')
          -- Bundle 1Q (2026-05-16): mirror analysis_exclusion_rules filter
          -- from analysisJobs.ts. Otherwise this view surfaces "edge"
          -- powered by parser-bug-era contaminated AH bets (the 2026-05-15
          -- 21:41 rule), which is exactly the false signal that drove the
          -- original 13 "proven" scopes — 86-100% of which were pre-fix.
          AND NOT EXISTS (
            SELECT 1 FROM analysis_exclusion_rules r
            WHERE r.market_type = pb.market_type
              AND r.bet_track   = pb.bet_track
              AND r.cleared_at IS NULL
              AND pb.placed_at < r.exclude_placed_before
          )
      ),
      per_match_sharp AS (
        -- Bundle 1Q: collapse multi-bet matches to single binary outcome.
        -- A match "wins" iff the sum of its bets' pnl is positive (the
        -- model's net call on that match was right). This is the
        -- independence-honest measure when the model fires 7-10 AH bets
        -- per match across different lines / sides. Wilson on per-bet
        -- count was overstating confidence by ~3× on most scopes.
        SELECT
          league,
          market_type,
          match_id,
          (SUM(pnl) > 0)::int AS match_won,
          SUM(pnl) AS match_pnl,
          SUM(stake) AS match_stake
        FROM bets
        WHERE is_sharp AND match_id IS NOT NULL
        GROUP BY league, market_type, match_id
      ),
      agg AS (
        SELECT
          league,
          market_type,
          COUNT(*)::int                                                AS n_total,
          COUNT(*) FILTER (WHERE is_sharp)::int                        AS n_sharp,
          SUM(won)::int                                                AS w_total,
          SUM(stake)                                                   AS stake_total,
          SUM(pnl)                                                     AS pnl_total,
          SUM(stake) FILTER (WHERE is_sharp)                           AS stake_sharp,
          SUM(pnl)   FILTER (WHERE is_sharp)                           AS pnl_sharp,
          AVG(clv_pct) FILTER (WHERE is_sharp AND clv_pct IS NOT NULL) AS avg_clv_sharp,
          STDDEV(clv_pct) FILTER (WHERE is_sharp AND clv_pct IS NOT NULL) AS sd_clv_sharp,
          COUNT(*) FILTER (WHERE is_sharp AND clv_pct IS NOT NULL)::int AS clv_n_sharp
        FROM bets
        GROUP BY league, market_type
      ),
      agg_per_match AS (
        SELECT
          league,
          market_type,
          COUNT(*)::int AS n_matches,
          SUM(match_won)::int AS w_matches
        FROM per_match_sharp
        GROUP BY league, market_type
      )
      SELECT
        a.league,
        a.market_type,
        a.n_total,
        a.n_sharp,
        ROUND((a.n_sharp::numeric / NULLIF(a.n_total, 0)) * 100, 1)    AS pct_sharp_coverage,
        ROUND((a.w_total::numeric / NULLIF(a.n_total, 0)) * 100, 2)    AS win_rate_pct,
        ROUND((
          ((a.w_total + 1.92) / (a.n_total + 3.84)
            - 1.96 * SQRT(a.w_total::numeric * (a.n_total - a.w_total)::numeric
                          / NULLIF(a.n_total, 0) + 0.96) / (a.n_total + 3.84))
          * 100
        )::numeric, 2)                                                 AS wilson_lo95_winrate_pct,
        ROUND(a.avg_clv_sharp::numeric, 2)                             AS avg_clv_sharp_pct,
        -- One-sample t-stat on sharp-anchored CLV vs zero.
        ROUND((
          CASE
            WHEN a.sd_clv_sharp IS NULL OR a.sd_clv_sharp = 0 OR a.clv_n_sharp < 2 THEN NULL
            ELSE (a.avg_clv_sharp * SQRT(a.clv_n_sharp::numeric)) / a.sd_clv_sharp
          END
        )::numeric, 3)                                                 AS clv_tstat_sharp,
        ROUND(((a.pnl_sharp / NULLIF(a.stake_sharp, 0)) * 100)::numeric, 2) AS stake_weighted_roi_sharp_pct,
        ROUND(((a.pnl_total / NULLIF(a.stake_total, 0)) * 100)::numeric, 2) AS stake_weighted_roi_total_pct,
        -- Mirror qualifies_live from analysis_signal_strength for cross-reference.
        COALESCE(
          (SELECT BOOL_OR(s.qualifies_live)
             FROM analysis_signal_strength s
            WHERE s.computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength)
              AND s.league = a.league
              AND s.market_type = a.market_type),
          FALSE
        )                                                              AS qualifies_live_per_scope,
        -- Edge verdict per Bundle 1Q semantics. Wilson floor = 0.50 on the
        -- per-MATCH count (n_matches), NOT per-bet. CLV gate unchanged.
        CASE
          WHEN a.n_sharp::numeric / NULLIF(a.n_total, 0) < 0.10
            THEN 'no_sharp_anchor'
          WHEN COALESCE(am.n_matches, 0) < 30
            THEN 'inconclusive'
          WHEN a.avg_clv_sharp IS NOT NULL AND a.sd_clv_sharp > 0
               AND (a.avg_clv_sharp * SQRT(a.clv_n_sharp::numeric)) / a.sd_clv_sharp < -1.96
            THEN 'inverted'
          WHEN ((am.w_matches + 1.92) / (am.n_matches + 3.84)
                  - 1.96 * SQRT(am.w_matches::numeric * (am.n_matches - am.w_matches)::numeric
                                / NULLIF(am.n_matches, 0) + 0.96) / (am.n_matches + 3.84)) > 0.50
               AND a.avg_clv_sharp IS NOT NULL AND a.sd_clv_sharp > 0
               AND (a.avg_clv_sharp * SQRT(a.clv_n_sharp::numeric)) / a.sd_clv_sharp > 1.96
               AND a.avg_clv_sharp > 0
            THEN 'proven'
          WHEN ((am.w_matches + 1.92) / (am.n_matches + 3.84)
                  - 1.96 * SQRT(am.w_matches::numeric * (am.n_matches - am.w_matches)::numeric
                                / NULLIF(am.n_matches, 0) + 0.96) / (am.n_matches + 3.84)) > 0.50
            THEN 'weak'
          WHEN a.avg_clv_sharp IS NOT NULL AND a.sd_clv_sharp > 0
               AND (a.avg_clv_sharp * SQRT(a.clv_n_sharp::numeric)) / a.sd_clv_sharp > 1.96
               AND a.avg_clv_sharp > 0
            THEN 'weak'
          ELSE 'inconclusive'
        END                                                            AS edge_verdict,
        -- Bundle 1Q (2026-05-16): new columns APPENDED at end of SELECT.
        -- Postgres CREATE OR REPLACE VIEW rejects column-order changes —
        -- new columns must be added after existing ones (same constraint
        -- that broke is_womens_league on 2026-05-11; see line 3324).
        -- These three are the per-match independence-honest measures.
        COALESCE(am.n_matches, 0)                                       AS n_matches,
        ROUND((am.w_matches::numeric / NULLIF(am.n_matches, 0)) * 100, 2) AS match_win_rate_pct,
        ROUND((
          CASE WHEN am.n_matches > 0 THEN
            ((am.w_matches + 1.92) / (am.n_matches + 3.84)
              - 1.96 * SQRT(am.w_matches::numeric * (am.n_matches - am.w_matches)::numeric
                            / NULLIF(am.n_matches, 0) + 0.96) / (am.n_matches + 3.84))
            * 100
          END
        )::numeric, 2)                                                 AS wilson_lo95_per_match_pct
      FROM agg a
      LEFT JOIN agg_per_match am ON am.league = a.league AND am.market_type = a.market_type
      WHERE a.n_total >= 5
      ORDER BY
        CASE
          WHEN a.avg_clv_sharp IS NOT NULL AND a.sd_clv_sharp > 0 AND a.clv_n_sharp >= 2
            THEN (a.avg_clv_sharp * SQRT(a.clv_n_sharp::numeric)) / a.sd_clv_sharp
          ELSE -999
        END DESC NULLS LAST,
        am.n_matches DESC NULLS LAST,
        a.n_sharp DESC
    `);

    // Task 4 / F.4 (2026-05-11 — back-to-theory plan): banned-market
    // review view. Joins the BANNED_MARKETS list (kept as a static CTE
    // here — single source of truth still lives in paperTrading.ts but
    // this view exists so the operator can sanity-check ban rationale
    // against the latest segment signal). Any market whose
    // any_scope_qualifies=true is a candidate for removal from the
    // BANNED_MARKETS set.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_banned_market_review AS
      WITH banned (market_type, reason) AS (
        VALUES
          ('OVER_UNDER_25',   'quarantined 2026-04-20 pricing-pipeline'),
          ('OVER_UNDER_35',   'quarantined 2026-04-20 pricing-pipeline'),
          ('FIRST_HALF_RESULT','quarantined 2026-04-20 pricing-pipeline'),
          ('DOUBLE_CHANCE',   'correlated with MATCH_ODDS')
      )
      SELECT
        b.market_type,
        b.reason,
        COALESCE(SUM(s.n), 0)                       AS n_settled_since_eval_start,
        ROUND(AVG(s.roi)::numeric, 3)               AS avg_roi,
        ROUND(AVG(s.avg_clv)::numeric, 2)           AS avg_clv_pct,
        BOOL_OR(s.qualifies_live)                   AS any_scope_qualifies
      FROM banned b
      LEFT JOIN analysis_signal_strength s
        ON s.market_type = b.market_type
       AND s.computed_at = (SELECT MAX(computed_at) FROM analysis_signal_strength)
      GROUP BY b.market_type, b.reason
      ORDER BY b.market_type
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

    // Task 19 — stadium coordinates for travel/altitude/timezone features.
    // Keyed on matches.venue_api_id. Backfilled via stadiumGeocoder
    // (OSM Nominatim, 1 req/s). Altitude + timezone left NULL for now;
    // filled in follow-up PRs.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS stadium_coordinates (
        venue_api_id    INTEGER PRIMARY KEY,
        stadium_name    TEXT,
        city            TEXT,
        country         TEXT,
        lat             NUMERIC(10,6),
        lon             NUMERIC(10,6),
        altitude_m      NUMERIC(8,1),
        timezone_iana   TEXT,
        source          TEXT,
        geocoded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS stadium_coords_with_position
        ON stadium_coordinates(venue_api_id)
        WHERE lat IS NOT NULL AND lon IS NOT NULL
    `);

    logger.info("Stadium coordinates ready (Task 19)");

    // Task 21 — SHAP-on-residuals drift runs. One row per (market_type ×
    // detection run). Per-feature K-S test results in drifted_features
    // jsonb. action_taken drives whether downstream cron triggers a
    // calibration refit.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS shap_drift_runs (
        id                 SERIAL PRIMARY KEY,
        run_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        market_type        TEXT NOT NULL,
        recent_n           INTEGER NOT NULL,
        baseline_n         INTEGER NOT NULL,
        features_analysed  INTEGER NOT NULL,
        features_drifted   INTEGER NOT NULL,
        drifted_features   JSONB,
        ks_max_stat        NUMERIC(8,6),
        ks_min_pvalue      NUMERIC(10,8),
        action_taken       TEXT NOT NULL,
        notes              TEXT
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS shap_drift_runs_recent
        ON shap_drift_runs(run_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS shap_drift_runs_alerts
        ON shap_drift_runs(action_taken, run_at DESC)
        WHERE action_taken IN ('alert_warning', 'alert_critical', 'recalibration_triggered')
    `);

    logger.info("SHAP drift runs ready (Task 21)");

    // Task 17 — Monte-Carlo lookup table for drawdown-targeted Kelly
    // fractions. Daily simulation row; reader picks the latest
    // selected_fraction. Stake-sizing wire-in is Phase 5b.2.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS kelly_fraction_lookup (
        id                SERIAL PRIMARY KEY,
        computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        realised_roi      NUMERIC(10,6) NOT NULL,
        realised_stdev    NUMERIC(10,6) NOT NULL,
        sample_n          INTEGER NOT NULL,
        target_p1_pct     NUMERIC(6,3) NOT NULL,
        selected_fraction NUMERIC(5,4) NOT NULL,
        curve             JSONB NOT NULL,
        paths             INTEGER NOT NULL,
        bets_per_path     INTEGER NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS kelly_fraction_lookup_recent
        ON kelly_fraction_lookup(computed_at DESC)
    `);

    logger.info("Kelly fraction lookup ready (Task 17)");

    // Task 22 — feature attribution + lifecycle (Phase 5c).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS feature_attribution (
        period_start          DATE NOT NULL,
        feature_name          TEXT NOT NULL,
        market_type           TEXT NOT NULL,
        n_bets                INTEGER NOT NULL,
        pearson_r             NUMERIC(8,6),
        top_decile_clv_mean   NUMERIC(8,4),
        bot_decile_clv_mean   NUMERIC(8,4),
        incremental_clv       NUMERIC(8,4),
        feature_min           NUMERIC(12,6),
        feature_max           NUMERIC(12,6),
        feature_mean          NUMERIC(12,6),
        computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (period_start, feature_name, market_type)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS feature_attribution_recent
        ON feature_attribution(period_start DESC)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS feature_lifecycle (
        id                  SERIAL PRIMARY KEY,
        feature_name        TEXT NOT NULL UNIQUE,
        status              TEXT NOT NULL DEFAULT 'active',
        weak_months_count   INTEGER NOT NULL DEFAULT 0,
        last_evaluated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notes               TEXT
      )
    `);

    // Operator view: latest-period attribution sorted by weakest first
    // (largest |incremental_clv| first, with sign preserved so the
    // operator can see direction). No UI — Neon SQL editor only.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_feature_attribution_latest AS
      SELECT fa.feature_name, fa.market_type, fa.n_bets,
             fa.pearson_r,
             fa.incremental_clv,
             fa.top_decile_clv_mean, fa.bot_decile_clv_mean,
             fa.period_start,
             COALESCE(fl.status, 'active') AS lifecycle_status,
             COALESCE(fl.weak_months_count, 0) AS weak_months_count
      FROM feature_attribution fa
      LEFT JOIN feature_lifecycle fl ON fl.feature_name = fa.feature_name
      WHERE fa.period_start = (SELECT MAX(period_start) FROM feature_attribution)
      ORDER BY ABS(COALESCE(fa.incremental_clv, 0)) DESC
    `);

    logger.info("Feature attribution + lifecycle ready (Task 22)");

    // Task 13 — market correlation matrix (Phase 5d). One row per
    // (league, market_a, market_b). league='' is the global fallback
    // used when a league lacks per-pair data.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS market_correlation_matrix (
        league       TEXT NOT NULL,
        market_a     TEXT NOT NULL,
        market_b     TEXT NOT NULL,
        correlation  NUMERIC(6,4) NOT NULL,
        n_pairs      INTEGER NOT NULL,
        computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (league, market_a, market_b)
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS market_correlation_pair_lookup
        ON market_correlation_matrix(market_a, market_b)
    `);

    // Operator view — strongest correlations first (top of book for
    // recognising portfolio risks). Surfaces both per-league and global.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_market_correlations_strongest AS
      SELECT CASE WHEN league = '' THEN '<global>' ELSE league END AS scope,
             market_a, market_b,
             correlation,
             n_pairs,
             computed_at
      FROM market_correlation_matrix
      WHERE ABS(correlation) >= 0.10
        AND n_pairs >= 30
      ORDER BY ABS(correlation) DESC
    `);

    logger.info("Market correlation matrix ready (Task 13)");

    // Cron-health observability view (2026-05-11). Surfaces structured
    // success/failure for each cron run via compliance_logs rows with
    // action_type='cron_health'. Read via SQL editor when a scheduled
    // task appears to be silently failing — last_error reveals the
    // exception without needing VPS log access.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_cron_health_24h AS
      WITH runs AS (
        SELECT
          (details->>'cron')        AS cron_name,
          (details->>'status')      AS status,
          (details->>'duration_ms')::int AS duration_ms,
          details->>'error'         AS error_msg,
          timestamp                 AS ran_at
        FROM compliance_logs
        WHERE action_type = 'cron_health'
          AND timestamp >= NOW() - INTERVAL '24 hours'
      )
      SELECT
        cron_name,
        COUNT(*) FILTER (WHERE status = 'success')              AS success_24h,
        COUNT(*) FILTER (WHERE status = 'error')                AS errors_24h,
        MAX(ran_at) FILTER (WHERE status = 'success')           AS last_success_at,
        MAX(ran_at) FILTER (WHERE status = 'error')             AS last_failure_at,
        (
          SELECT error_msg
          FROM runs r2
          WHERE r2.cron_name = runs.cron_name AND r2.status = 'error'
          ORDER BY ran_at DESC LIMIT 1
        )                                                       AS last_error,
        AVG(duration_ms) FILTER (WHERE status = 'success')::int AS avg_success_ms
      FROM runs
      WHERE cron_name IS NOT NULL
      GROUP BY cron_name
      ORDER BY
        CASE WHEN MAX(ran_at) FILTER (WHERE status = 'error') > COALESCE(MAX(ran_at) FILTER (WHERE status = 'success'), '1970-01-01') THEN 0 ELSE 1 END,
        MAX(ran_at) DESC
    `);

    logger.info("Cron-health view ready");

    // Task 23 (Phase 6a) — slippage guard depth-cushion config.
    await db.execute(sql`
      INSERT INTO agent_config (key, value, updated_at)
      VALUES ('slippage_depth_cushion', '3', NOW())
      ON CONFLICT (key) DO NOTHING
    `);

    logger.info("Slippage guard config seeded (Task 23)");

    // Phase 5d.2 (Task 13 wire-in) — portfolio Kelly fixture cap.
    // Default 5% of bankroll across all bets on a single fixture.
    await db.execute(sql`
      INSERT INTO agent_config (key, value, updated_at)
      VALUES ('portfolio_fixture_cap', '0.05', NOW())
      ON CONFLICT (key) DO NOTHING
    `);

    logger.info("Portfolio Kelly fixture-cap seeded (Task 13)");

    // Seed the target_p1_pct config key so the first sim run has a value.
    await db.execute(sql`
      INSERT INTO agent_config (key, value, updated_at)
      VALUES ('drawdown_target_p1_pct', '15', NOW())
      ON CONFLICT (key) DO NOTHING
    `);

    // ── Phase 0 (2026-05-14): Women's & internationals expansion ─────────
    // Three new tables — competition_aliases (Betfair-name → AF-league-id
    // hand-curated lookup), teams (normalised teams catalogue replacing
    // free-text home_team/away_team on matches), team_aliases (per-source
    // alias map).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS competition_aliases (
        id SERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        alias TEXT NOT NULL,
        api_football_id INTEGER NOT NULL REFERENCES competition_config(api_football_id),
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS competition_aliases_source_alias_uq
        ON competition_aliases (source, alias)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        api_football_team_id INTEGER UNIQUE,
        canonical_name TEXT NOT NULL,
        country TEXT,
        gender TEXT NOT NULL DEFAULT 'male' CHECK (gender IN ('male','female')),
        is_national_team BOOLEAN NOT NULL DEFAULT false,
        clubelo_name TEXT,
        fbref_id TEXT,
        fotmob_id TEXT,
        fifa_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS teams_canonical_gender_uq
        ON teams (canonical_name, gender)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_aliases (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        alias TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS team_aliases_source_alias_uq
        ON team_aliases (source, alias)
    `);

    logger.info("Phase 0 tables ready: competition_aliases, teams, team_aliases");

    // ── Phase 1a (2026-05-14): Dixon-Coles / Sarmanov scaffolding ────────
    // scoreline_correlation holds per-scope rho values (posterior mean
    // from hierarchical Bayes fit, Phase 1b). model_layer_enabled is the
    // per-(market_type, gender) on/off decision the Phase 1c backtest
    // writes. Both empty on landing → runtime falls back to rho=0 (status
    // quo independent Poisson) and layer disabled-by-default-safe.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS scoreline_correlation (
        id SERIAL PRIMARY KEY,
        api_football_id INTEGER NOT NULL,
        market_type TEXT NOT NULL,
        copula_kind TEXT NOT NULL CHECK (copula_kind IN ('dixon_coles','sarmanov')),
        rho NUMERIC(6,4) NOT NULL,
        rho_posterior_sd NUMERIC(6,4) NOT NULL,
        group_rho NUMERIC(6,4) NOT NULL,
        n_matches INTEGER NOT NULL,
        fitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS scoreline_correlation_scope_uq
        ON scoreline_correlation (api_football_id, market_type)
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS model_layer_enabled (
        id SERIAL PRIMARY KEY,
        market_type TEXT NOT NULL,
        gender TEXT NOT NULL CHECK (gender IN ('male','female')),
        layer TEXT NOT NULL,
        enabled BOOLEAN NOT NULL,
        log_loss_baseline NUMERIC(8,6),
        log_loss_with_layer NUMERIC(8,6),
        n_backtest_bets INTEGER,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Phase 1e (2026-05-15): per-scope decision. Add api_football_id
    // column + replace the single (market_type, gender, layer) unique
    // index with two partial indexes — one for per-scope rows
    // (api_football_id NOT NULL), one for aggregate fallback
    // (api_football_id IS NULL).
    await db.execute(sql`
      ALTER TABLE model_layer_enabled
        ADD COLUMN IF NOT EXISTS api_football_id INTEGER
    `);
    await db.execute(sql`DROP INDEX IF EXISTS model_layer_enabled_scope_uq`);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS model_layer_enabled_per_scope_uq
        ON model_layer_enabled (market_type, gender, layer, api_football_id)
        WHERE api_football_id IS NOT NULL
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS model_layer_enabled_aggregate_uq
        ON model_layer_enabled (market_type, gender, layer)
        WHERE api_football_id IS NULL
    `);

    logger.info("Phase 1a tables ready: scoreline_correlation, model_layer_enabled");

    // ── Phase 2a (2026-05-14): soccerdata team-form scrape sidecar ────────
    // Summary-only — one row per (source × league × season × team ×
    // snapshot_date). Raw event data lives in the FS cache, never
    // Postgres. extras jsonb absorbs per-source fields without schema
    // churn (PPDA for FBref, shot-map summary for FotMob, etc.).
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS team_form_scrape (
        id SERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        league_name TEXT NOT NULL,
        league_country TEXT,
        gender TEXT NOT NULL DEFAULT 'male' CHECK (gender IN ('male','female')),
        season TEXT NOT NULL,
        team_name TEXT NOT NULL,
        snapshot_date DATE NOT NULL,
        matches_played INTEGER,
        xg_for NUMERIC(6,3),
        xg_against NUMERIC(6,3),
        shots_for INTEGER,
        shots_on_target_for INTEGER,
        goals_for INTEGER,
        goals_against INTEGER,
        extras JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS team_form_scrape_uq
        ON team_form_scrape (source, league_name, season, team_name, snapshot_date)
    `);

    logger.info("Phase 2a table ready: team_form_scrape");

    // ── Bundle N.1 (2026-05-16): Neon cost discipline indexes ───────────────
    // Sequential-scan amplification was 58% of the Neon bill. paper_bets had
    // ZERO index covering (market_type, placed_at) → every Bundle B aggregate,
    // CLV coverage query, dashboard pull was a full table scan. matches had
    // no (kickoff_time, status) index → every trading cycle full-scanned 6k
    // rows × 100s of times/day. api_usage had a backwards (date, endpoint)
    // index that the typical "count by endpoint over time" query couldn't
    // use. Expected aggregate egress reduction: 60-80% on these tables.
    //
    // CONCURRENTLY would be preferred but tsx/pg in migration runs inside
    // a transaction → CONCURRENTLY is not allowed. These tables are small
    // enough (paper_bets 22 MB, matches 2 MB, api_usage 34 MB) that the
    // blocking-CREATE-INDEX overhead at startup is acceptable.
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS paper_bets_market_placed_idx
        ON paper_bets (market_type, placed_at DESC)
        WHERE deleted_at IS NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS matches_kickoff_status_idx
        ON matches (kickoff_time, status)
    `);
    // api_usage: swap the backwards (date, endpoint) index for (endpoint, date)
    // matching the typical "WHERE endpoint=X ORDER BY date DESC" query shape.
    // Keep both for one deploy to avoid query-plan regressions; drop old
    // after verification (TODO N.1 follow-up).
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS api_usage_endpoint_date_idx
        ON api_usage (endpoint, date DESC)
    `);
    logger.info("Bundle N.1 indexes ready: paper_bets_market_placed_idx, matches_kickoff_status_idx, api_usage_endpoint_date_idx");

    // ── Bundle 1B.2 (2026-05-16): Club Elo fair-line CLV columns ────────────
    // Independent third CLV anchor for European fixtures where both teams
    // have an entry in club_elo_snapshots. Closes the 40-50% Pinnacle-only
    // coverage gap on mid-tier European leagues. Computed from
    // ratingDiff = elo_home + 60 - elo_away by services/clubEloFairLines.ts.
    // Drizzle silently drops unknown fields on insert/update — the schema
    // entries in lib/db/src/schema/paperBets.ts MUST match these columns
    // exactly, and lib/db/dist MUST be rebuilt after this migration runs
    // (feedback_lib_db_dist_rebuild).
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS closing_elo_fair_odds NUMERIC(10, 4),
        ADD COLUMN IF NOT EXISTS clv_elo_pct           NUMERIC(8, 4),
        ADD COLUMN IF NOT EXISTS elo_data_quality      TEXT
    `);
    // Re-create paper_bets_current view so the new columns surface through it
    // (Postgres freezes view column lists at CREATE time even with SELECT *).
    await db.execute(sql`DROP VIEW IF EXISTS paper_bets_current`);
    await db.execute(sql`
      CREATE VIEW paper_bets_current AS
        SELECT * FROM paper_bets
        WHERE legacy_regime = false
          AND deleted_at IS NULL
    `);
    logger.info("Bundle 1B.2 columns ready: paper_bets.{closing_elo_fair_odds, clv_elo_pct, elo_data_quality} + view rebuilt");

    // ── Bundle 1L FIX 1 + FIX 2 (2026-05-16) ────────────────────────────────
    // Seed defaults for the live-placement window cap + per-league demote.
    // ON CONFLICT DO NOTHING — operator overrides via /admin/set-config are
    // preserved across re-deploys; only first-time installs take the defaults.
    //
    // FIX 1 — 24h pre-kickoff cap. Bundle 1L timing-bucket audit:
    //   <24h:  +41% ROI on n=54  ← profitable
    //   24-48h: -8% ROI on n=116 ← cliff
    //   >120h: -24% ROI on n=40  ← bleeds
    //
    // FIX 2 — 6 confirmed Wilson-lo95-negative leagues. League names match
    // matches.league column exact strings (case-insensitive comparison in
    // livePlacementGate.getDisabledLeagues).
    await db.execute(sql`
      INSERT INTO agent_config (key, value)
      VALUES ('live_placement_max_hours_to_kickoff', '24')
      ON CONFLICT (key) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO agent_config (key, value)
      VALUES ('live_placement_disabled_leagues',
              'K League 1,K League 2,Super League 1,Pro League,Czech Liga,3. Liga')
      ON CONFLICT (key) DO NOTHING
    `);
    // FIX 1b — Pinnacle-aware minimum-hours floor. Default 1.0h avoids
    // the closing-line surge window where Pinnacle is sharpest and
    // Betfair Exchange liquidity dries up. Operator-tunable.
    await db.execute(sql`
      INSERT INTO agent_config (key, value)
      VALUES ('live_placement_min_hours_to_kickoff', '1')
      ON CONFLICT (key) DO NOTHING
    `);
    logger.info("Bundle 1L FIX 1+1b+2 config seeded: live_placement_min/max_hours_to_kickoff=1/24, live_placement_disabled_leagues seeded with 6-league list");

    // ── Bundle N.10 (2026-05-16): REINDEX af_predictions ────────────────────
    // 1331 rows but 9.4 MB total index = 40× table bloat. Reclaim ~9 MB.
    // pg_repack would be preferred for online; REINDEX is fine for a
    // table this small. Runs only when forced via env var so we don't
    // do it on every restart.
    if (process.env.NEON_REINDEX_AF_PREDICTIONS === "true") {
      try {
        await db.execute(sql`REINDEX TABLE af_predictions`);
        logger.info("Bundle N.10: REINDEX af_predictions complete");
      } catch (err) {
        logger.warn({ err }, "Bundle N.10: REINDEX af_predictions failed (non-fatal)");
      }
    }

    // ── Bundle 1 E.2 (2026-05-17): bookmaker_slug column ────────────────────
    // The table is still named pinnacle_odds_snapshots for historical
    // compatibility, but rows can now represent any sharp book. Free-tier
    // OddsPapi client (E.1) and the sharp-anchor fetch service (E.3, pending)
    // will write rows with bookmaker_slug ∈ {pinnacle, singbet, sbobet,
    // bet365, 1xbet, ...}. Default 'pinnacle' backfills all existing rows
    // implicitly so downstream consumers that don't know about the column
    // keep working unchanged. See docs/bundle-1-sharp-coverage-plan.md §E.2.
    await db.execute(sql`
      ALTER TABLE pinnacle_odds_snapshots
        ADD COLUMN IF NOT EXISTS bookmaker_slug TEXT NOT NULL DEFAULT 'pinnacle'
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_sharp_snapshots_book_lookup
        ON pinnacle_odds_snapshots (match_id, market_type, selection_name, bookmaker_slug, captured_at DESC)
    `);
    logger.info("Bundle 1 E.2: pinnacle_odds_snapshots.bookmaker_slug column + lookup index ready");

    // ── Bundle 5.B (2026-05-17): rolling-window mean_bias + model_se ─────────
    // Per memo §J: every market_type shows positive model-vs-Pinnacle bias
    // (12–31pp). The inversion pipeline (Bundle 5.A) bias-corrects the model
    // probability before computing R2's disagreement_z. This view exposes
    // the rolling-window mean_bias and stddev_samp(model_p − pinnacle_implied)
    // for each market_type so the gate can read the freshest calibration
    // without scanning paper_bets per placement.
    //
    // Universe filter (matches the memo's cutover anchor):
    //   bet_track IN ('live','shadow')
    //   AND legacy_regime = false
    //   AND placed_at >= '2026-05-17 08:40:00 UTC'
    //       Bundle 3 selectPricingSources fix (commit a209758) was committed
    //       at 07:40:44 UTC and deployed shortly after. 08:40 UTC is the
    //       conservative post-deploy floor that guarantees every row in the
    //       universe has clean odds_at_placement (no Pinnacle/oddspapi
    //       fallback contamination on shadow rows).
    //   AND pinnacle_implied IS NOT NULL AND pinnacle_implied > 0
    //   AND model_probability IS NOT NULL
    //   AND status IN ('won','lost','void')
    //   AND deleted_at IS NULL
    // Window: last 200 rows per market_type by placed_at DESC (the constant
    // 200 lives here, not in TS — Bundle 5.A's `mean_bias_window_n` config key
    // is read by the *reader* to gate the view's freshness, but the window
    // size itself is encoded in the SQL to keep the view planner-friendly).
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_market_type_mean_bias_rolling AS
      WITH ranked AS (
        SELECT
          market_type,
          model_probability,
          pinnacle_implied,
          ROW_NUMBER() OVER (PARTITION BY market_type ORDER BY placed_at DESC) AS rn
        FROM paper_bets
        WHERE bet_track IN ('live','shadow')
          AND legacy_regime = false
          AND placed_at >= TIMESTAMP WITH TIME ZONE '2026-05-17 08:40:00+00'
          AND pinnacle_implied IS NOT NULL AND pinnacle_implied > 0
          AND model_probability IS NOT NULL
          AND status IN ('won','lost','void')
          AND deleted_at IS NULL
      )
      SELECT
        market_type,
        COUNT(*)::int AS n,
        AVG(model_probability - pinnacle_implied)::numeric AS mean_bias,
        STDDEV_SAMP(model_probability - pinnacle_implied)::numeric AS model_se
      FROM ranked
      WHERE rn <= 200
      GROUP BY market_type
    `);
    logger.info("Bundle 5.B: v_market_type_mean_bias_rolling view ready");

    // ── Bundle 5.I (2026-05-17): per-(market × ttk) slippage p75 view ────────
    // Multiplicative slippage formula needs p75 of adverse fills (positive
    // slippage = matched worse than offered). Negative slippage (better
    // fill than offered) is clamped to 0 — we don't plan around tailwinds.
    //
    // Universe: cutover-clean live bets with a real Betfair fill price
    // (`betfair_avg_price_matched > 0`). Excludes paper-track, legacy
    // regime, and pre-Bundle-3 contaminated rows.
    //
    // TTK buckets per the locked spec: 0_1h / 1_6h / 6_24h / 24h_plus.
    // Rolling 60-day window. Cells with n<30 fall back via the reader chain
    // (cell → market aggregate → 1.5pp default).
    //
    // Recomputed on every query — view is over ~5k rows, planner-friendly.
    // Promote to a materialised view only if load profile demands.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_slippage_p75_rolling AS
      WITH bets AS (
        SELECT
          pb.market_type,
          CASE
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '1 hour'   THEN '0_1h'
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '6 hours'  THEN '1_6h'
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '24 hours' THEN '6_24h'
            ELSE                                                          '24h_plus'
          END AS ttk_bucket,
          GREATEST(
            (pb.odds_at_placement - pb.betfair_avg_price_matched) / NULLIF(pb.odds_at_placement, 0),
            0
          )::float8 AS slip_frac
        FROM paper_bets pb
        JOIN matches m ON m.id = pb.match_id
        WHERE pb.bet_track = 'live'
          AND pb.legacy_regime = false
          AND pb.placed_at >= NOW() - INTERVAL '60 days'
          AND pb.placed_at >= TIMESTAMP WITH TIME ZONE '2026-05-17 08:40:00+00'
          AND pb.deleted_at IS NULL
          AND pb.status IN ('won','lost','void')
          AND pb.betfair_avg_price_matched IS NOT NULL
          AND pb.betfair_avg_price_matched > 0
          AND pb.odds_at_placement IS NOT NULL
          AND pb.odds_at_placement > 1
      )
      SELECT
        market_type,
        ttk_bucket,
        COUNT(*)::int AS n,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY slip_frac)::numeric AS p75_slippage
      FROM bets
      GROUP BY market_type, ttk_bucket
    `);
    logger.info("Bundle 5.I: v_slippage_p75_rolling view ready");

    // ── Bundle 5.L (2026-05-17): per-market_type CLV health view ────────────
    // Rolling last-100 settled bets per market_type on the cutover universe.
    // Stake-weighted CLV is the leading indicator of edge decay (memo
    // Principle 5). The CLV circuit breaker cron reads this view every
    // 15 min; if stake_weighted_clv_pct drops below
    // clv_circuit_breaker_threshold (default 0.0) for a market_type, the
    // cron sets agent_config.clv_paused_<market_type> = 'true' and the
    // inversion gate demotes shadow on that market_type. Manual unpause
    // via /api/admin/set-config.
    //
    // Same universe filter as v_market_type_mean_bias_rolling (Bundle 5.B):
    // cutover-clean, post-Bundle-3 fix, settled with non-null clv_pct.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_clv_health_rolling AS
      WITH ranked AS (
        SELECT
          market_type,
          stake::float8 AS stake,
          clv_pct::float8 AS clv_pct,
          placed_at,
          ROW_NUMBER() OVER (PARTITION BY market_type ORDER BY placed_at DESC) AS rn
        FROM paper_bets
        WHERE bet_track IN ('live','shadow')
          AND legacy_regime = false
          AND placed_at >= TIMESTAMP WITH TIME ZONE '2026-05-17 08:40:00+00'
          AND clv_pct IS NOT NULL
          AND status IN ('won','lost','void')
          AND deleted_at IS NULL
      )
      SELECT
        market_type,
        COUNT(*)::int AS n,
        AVG(clv_pct)::numeric AS mean_clv_pct,
        CASE
          WHEN SUM(stake) > 0
            THEN (SUM(stake * clv_pct) / SUM(stake))::numeric
          ELSE AVG(clv_pct)::numeric
        END AS stake_weighted_clv_pct,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY clv_pct)::numeric AS p25_clv_pct,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY clv_pct)::numeric AS p75_clv_pct,
        MIN(placed_at) AS window_oldest,
        MAX(placed_at) AS window_newest
      FROM ranked
      WHERE rn <= 100
      GROUP BY market_type
    `);
    logger.info("Bundle 5.L: v_clv_health_rolling view ready");

    // ── Bundle 6 (2026-05-17): structured-rejection-by-gate aggregator ──────
    // SQL pivot for the "candidates lost per gate" measurement. paperTrading's
    // logReject() (post Bundle 6 refactor) emits action_type='bet_rejected'
    // with details.gate set to a value from RejectionGate enum
    // (services/rejectionGateEnum.ts). lazy_promote_* and other distinct
    // action_types are unified into the same view via COALESCE so a single
    // query gives the operator a complete per-gate funnel for the last 24h.
    //
    // Memo §F prerequisite: makes the REMOVE/RETAIN/REWORK decisions in
    // Bundle 5 data-validatable (which gates actually fire, and how often).
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_rejected_by_gate_24h AS
      SELECT
        COALESCE(details->>'gate', action_type) AS gate,
        COUNT(*)::int AS n,
        COUNT(DISTINCT (details->>'matchId'))::int AS distinct_matches,
        COUNT(DISTINCT (details->>'marketType'))::int AS distinct_market_types,
        MIN(timestamp) AS first_seen_24h,
        MAX(timestamp) AS last_seen_24h
      FROM compliance_logs
      WHERE timestamp >= NOW() - INTERVAL '24 hours'
        AND (
          action_type = 'bet_rejected'
          OR action_type LIKE 'lazy_promote_%'
          OR action_type = 'inversion_exposure_cap_trimmed'
          OR action_type = 'clv_circuit_breaker_tripped'
        )
      GROUP BY 1
      ORDER BY n DESC
    `);
    logger.info("Bundle 6: v_rejected_by_gate_24h view ready");

    // ── Bundle 7.0 (2026-05-17): Stage 0 — universe + heat-map foundation ───
    // Watch_priority_history tracks (fixture × market_type) priority scores
    // over time. The 5-min cron in services/watchPriority.ts writes one
    // snapshot row per active (fixture × market) per tick. 7-day retention
    // is enough for weight re-tuning + tier-drift analysis.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS watch_priority_history (
        id BIGSERIAL PRIMARY KEY,
        fixture_id INTEGER NOT NULL,
        market_type TEXT NOT NULL,
        computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        watch_priority_score NUMERIC(6, 3) NOT NULL,
        base_priority NUMERIC(6, 3) NOT NULL,
        model_boost NUMERIC(6, 3) NOT NULL DEFAULT 0,
        tier SMALLINT NOT NULL,
        edge_density_score NUMERIC(6, 3),
        release_proximity_score NUMERIC(6, 3),
        liquidity_score NUMERIC(6, 3),
        ttk_score NUMERIC(6, 3),
        clv_yield_score NUMERIC(6, 3),
        model_opportunity_score NUMERIC(6, 3),
        ttk_bucket TEXT,
        sharp_count_tier SMALLINT
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_watch_priority_lookup
        ON watch_priority_history (fixture_id, market_type, computed_at DESC)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_watch_priority_tier_recent
        ON watch_priority_history (tier, computed_at DESC)
    `);
    // 7-day retention housekeeping cron is registered in scheduler.ts; the
    // table itself doesn't enforce a TTL so old rows can be reviewed for
    // weight re-tune Bayesian optimisation.

    // league_market_catalogue: per (league × market_type) catalogue derived
    // from historical pinnacle_odds_snapshots — used by Stage 0 to know
    // which market types each league supports. Premier League supports
    // MO/OU/BTTS/AH/Cards/Corners; K-League 1 supports MO/OU/AH only.
    // Saves polling effort on markets the bookmaker won't price.
    //
    // 2026-05-17 hotfix: matches table doesn't have league_id (int) —
    // only league (text). Re-keyed on league text so the cron's JOIN
    // works against matches.league directly. Original CREATE was empty
    // so no data lost on schema swap.
    await db.execute(sql`DROP TABLE IF EXISTS league_market_catalogue`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS league_market_catalogue (
        league TEXT NOT NULL,
        market_type TEXT NOT NULL,
        first_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        sample_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (league, market_type)
      )
    `);
    // Seed from historical pinnacle_odds_snapshots — every (league ×
    // market_type) with ≥5 snapshots in the last 60 days. Idempotent
    // via ON CONFLICT: re-running the migration refreshes counts +
    // last_seen, never duplicates.
    await db.execute(sql`
      INSERT INTO league_market_catalogue (league, market_type, first_seen, last_seen, sample_count)
      SELECT
        m.league,
        s.market_type,
        MIN(s.captured_at) AS first_seen,
        MAX(s.captured_at) AS last_seen,
        COUNT(*)::int AS sample_count
      FROM pinnacle_odds_snapshots s
      JOIN matches m ON m.id = s.match_id
      WHERE m.league IS NOT NULL
        AND s.captured_at >= NOW() - INTERVAL '60 days'
      GROUP BY m.league, s.market_type
      HAVING COUNT(*) >= 5
      ON CONFLICT (league, market_type) DO UPDATE SET
        last_seen = EXCLUDED.last_seen,
        sample_count = EXCLUDED.sample_count
    `);
    logger.info("Bundle 7.0 hotfix: league_market_catalogue re-keyed on league text + seeded from pinnacle snapshots");

    // Scope CLV rolling view — the closed learning loop. Rolling
    // 100-bet stake-weighted CLV per (league × market_type × ttk_bucket).
    // watchPriority.historical_clv_yield_score reads from this view;
    // scopes with proven CLV rise to TIER 1, scopes that don't, decay.
    await db.execute(sql`
      CREATE OR REPLACE VIEW scope_clv_rolling_v AS
      WITH ranked AS (
        SELECT
          m.league,
          pb.market_type,
          CASE
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '1 hour'   THEN '0_1h'
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '6 hours'  THEN '1_6h'
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '24 hours' THEN '6_24h'
            ELSE                                                          '24h_plus'
          END AS ttk_bucket,
          pb.stake::float8 AS stake,
          pb.clv_pct::float8 AS clv_pct,
          ROW_NUMBER() OVER (
            PARTITION BY m.league, pb.market_type,
              CASE
                WHEN m.kickoff_time - pb.placed_at < INTERVAL '1 hour'   THEN '0_1h'
                WHEN m.kickoff_time - pb.placed_at < INTERVAL '6 hours'  THEN '1_6h'
                WHEN m.kickoff_time - pb.placed_at < INTERVAL '24 hours' THEN '6_24h'
                ELSE                                                          '24h_plus'
              END
            ORDER BY pb.placed_at DESC
          ) AS rn
        FROM paper_bets pb
        JOIN matches m ON m.id = pb.match_id
        WHERE pb.bet_track IN ('live','shadow')
          AND pb.legacy_regime = false
          AND pb.placed_at >= TIMESTAMP WITH TIME ZONE '2026-05-17 08:40:00+00'
          AND pb.clv_pct IS NOT NULL
          AND pb.status IN ('won','lost','void')
          AND pb.deleted_at IS NULL
      )
      SELECT
        league,
        market_type,
        ttk_bucket,
        COUNT(*)::int AS n,
        CASE
          WHEN SUM(stake) > 0
            THEN (SUM(stake * clv_pct) / SUM(stake))::numeric
          ELSE AVG(clv_pct)::numeric
        END AS stake_weighted_clv_pct
      FROM ranked
      WHERE rn <= 100
      GROUP BY league, market_type, ttk_bucket
    `);
    logger.info("Bundle 7.0: scope_clv_rolling_v view ready");

    // Scope edge density view — "how often does this scope produce a
    // candidate at >= 3pp identified edge?" Rolling 90 days. The
    // expected_edge_density_score component reads from this.
    await db.execute(sql`
      CREATE OR REPLACE VIEW scope_edge_density_v AS
      WITH bets AS (
        SELECT
          m.league,
          pb.market_type,
          CASE
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '1 hour'   THEN '0_1h'
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '6 hours'  THEN '1_6h'
            WHEN m.kickoff_time - pb.placed_at < INTERVAL '24 hours' THEN '6_24h'
            ELSE                                                          '24h_plus'
          END AS ttk_bucket,
          CASE
            WHEN pb.pinnacle_implied IS NOT NULL AND pb.pinnacle_implied > 0
              AND (pb.odds_at_placement::float8 * pb.pinnacle_implied::float8 - 1) * 100 >= 3.0
            THEN 1
            ELSE 0
          END AS qualifies
        FROM paper_bets pb
        JOIN matches m ON m.id = pb.match_id
        WHERE pb.placed_at >= NOW() - INTERVAL '90 days'
          AND pb.bet_track IN ('live','shadow')
          AND pb.legacy_regime = false
          AND pb.deleted_at IS NULL
      )
      SELECT
        league,
        market_type,
        ttk_bucket,
        COUNT(*)::int AS scan_count,
        SUM(qualifies)::int AS edge_count,
        CASE
          WHEN COUNT(*) > 0 THEN (100.0 * SUM(qualifies) / COUNT(*))::numeric
          ELSE 0::numeric
        END AS density_score
      FROM bets
      GROUP BY league, market_type, ttk_bucket
    `);
    logger.info("Bundle 7.0: scope_edge_density_v view ready");

    // Pinnacle release-timing view — per (league × market_type) median
    // hours-to-kickoff at first identification snapshot. Powers the
    // release_proximity_score component.
    await db.execute(sql`
      CREATE OR REPLACE VIEW scope_pinnacle_release_timing_v AS
      WITH ids AS (
        SELECT
          s.match_id,
          s.market_type,
          MIN(s.captured_at) AS first_seen
        FROM pinnacle_odds_snapshots s
        WHERE s.captured_at >= NOW() - INTERVAL '60 days'
          AND s.snapshot_type = 'identification'
          AND s.bookmaker_slug = 'pinnacle'
        GROUP BY s.match_id, s.market_type
      )
      SELECT
        m.league,
        ids.market_type,
        COUNT(*)::int AS n,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (m.kickoff_time - ids.first_seen)) / 3600.0
        )::numeric AS median_hours_to_kickoff
      FROM ids JOIN matches m ON m.id = ids.match_id
      WHERE m.kickoff_time IS NOT NULL
      GROUP BY m.league, ids.market_type
      HAVING COUNT(*) >= 10
    `);
    logger.info("Bundle 7.0: scope_pinnacle_release_timing_v view ready");

    // Bundle 7.0 config seeds — six new keys for Stage 0. All JSON or
    // numeric, operator-tunable via /api/admin/set-config without code.
    const stage0Seed: Array<{ key: string; value: string }> = [
      // Component weights (refined 2026-05-17: model is accelerator, smallest weight).
      { key: "watch_score_weights", value: JSON.stringify({
        W_edge: 0.20,
        W_release: 0.15,
        W_liquidity: 0.15,
        W_ttk: 0.20,
        W_clv: 0.20,
        W_model: 0.10,
      }) },
      // Tier thresholds (calibrated to MAX-base + additive-model range [0, 30]).
      { key: "watch_tier_thresholds", value: JSON.stringify({
        TIER_1_MIN: 20,
        TIER_2_MIN: 15,
        TIER_3_MIN: 6,
      }) },
      // Tier polling cadences (seconds for Betfair, minutes for Pinnacle).
      // Tier 1 Pinnacle uses 'signal' meaning event-driven (mover>2%/30min
      // OR T-30/15/5/0 snapshots), NOT time-driven, to fit budget.
      { key: "watch_tier_poll_cadences", value: JSON.stringify({
        TIER_1: { betfair_sec: 30,  pinnacle_min: "signal" },
        TIER_2: { betfair_sec: 120, pinnacle_min: 15 },
        TIER_3: { betfair_sec: 300, pinnacle_min: 30 },
        TIER_4: { betfair_sec: 900, pinnacle_min: "mover_only" },
      }) },
      // CLV rolling window size — n bets per scope before the CLV-yield
      // signal is considered reliable enough to weigh.
      { key: "scope_clv_window_size", value: "100" },
      // Mover signal default-on; A/B at n=200 may disable.
      { key: "mover_signal_enabled", value: "true" },
      // Watch priority history TTL — cron drops rows older than this.
      { key: "watch_priority_history_retention_days", value: "7" },
    ];
    for (const row of stage0Seed) {
      await db.insert(agentConfigTable).values(row).onConflictDoNothing({ target: agentConfigTable.key });
    }
    logger.info({ count: stage0Seed.length }, "Bundle 7.0: Stage 0 config keys seeded");

    // ── Bundle 7.A (2026-05-17): dual-track candidate classifier ─────────────
    // Every candidate is classified as 'sharp_anchored' (Pinnacle and/or
    // non-Pinnacle sharp present within freshness window) or 'model_only'
    // (no sharp anchor; gated by model + opportunity_score, shadow-only,
    // graduates via Wilson 95% LCB once scope proves edge). Stored on the
    // bet row so downstream analysis can split per-track Wilson ROI / CLV.
    //
    // Default 'sharp_anchored' for legacy rows pre-Bundle-7.A — the inversion
    // gate (Bundle 5) only fires shadow telemetry today, so legacy rows tagged
    // sharp_anchored have no behavioural impact. New rows are tagged at write
    // time via classifyCandidateTrack().
    await db.execute(sql`
      ALTER TABLE paper_bets
      ADD COLUMN IF NOT EXISTS candidate_track TEXT NOT NULL DEFAULT 'sharp_anchored'
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_paper_bets_candidate_track
        ON paper_bets (candidate_track, bet_track, placed_at DESC)
    `);
    logger.info("Bundle 7.A: paper_bets.candidate_track column + index ready");

    // ── Bundle 7.E (2026-05-17): bankroll-tier auto-scaling for caps ────────
    // Replaces Bundle 5.M's static defaults with a 4-tier table indexed by
    // detected live Betfair balance. Caps scale with proven edge without
    // manual intervention. Operator can override any tier by editing the
    // JSON, or override a specific cap by setting the matching agent_config
    // key (per_fixture_exposure_pct etc.) — explicit per-key wins.
    await db
      .insert(agentConfigTable)
      .values({
        key: "exposure_cap_tiers",
        value: JSON.stringify({
          tiers: [
            { max_bankroll_gbp: 500,    per_fixture_pct: 3.0, per_league_pct: 10.0, daily_cap_pct: 6.0,  label: "ramp" },
            { max_bankroll_gbp: 2000,   per_fixture_pct: 5.0, per_league_pct: 15.0, daily_cap_pct: 8.0,  label: "default" },
            { max_bankroll_gbp: 10000,  per_fixture_pct: 6.0, per_league_pct: 18.0, daily_cap_pct: 10.0, label: "moderate" },
            { max_bankroll_gbp: null,   per_fixture_pct: 8.0, per_league_pct: 20.0, daily_cap_pct: 12.0, label: "mature" },
          ],
        }),
      })
      .onConflictDoNothing({ target: agentConfigTable.key });
    logger.info("Bundle 7.E: exposure_cap_tiers seeded (4 bankroll bands)");

    // ── Bundle 5.N (2026-05-17): seed inversion-pipeline config keys ──────
    // Nine new operator-tunable keys, defaults match the locked spec
    // (docs/bundle-5-activation-spec.md). Plus the activation switch (kept
    // 'false' until the operator is ready). ON CONFLICT DO NOTHING — never
    // overwrite an operator-set value on re-deploy.
    const inversionSeed: Array<{ key: string; value: string }> = [
      { key: "inversion_pipeline_enabled", value: "false" },
      { key: "min_net_edge_pp", value: "3.0" },
      // Bundle 10 (2026-05-17): live-edge ceiling. Post-slip edge above
      // this value demotes to shadow even though it clears the 3pp floor.
      // 7pp picked from Bundle 9 retrospective — 7-15pp and 15-50pp
      // brackets LOST money today. Widen as data accumulates.
      { key: "inversion_live_max_edge_pp", value: "7.0" },
      // Bundle 11 (2026-05-17): freshness windows for "live at point of
      // placement". Pinnacle implied + Betfair best-back used by the
      // inversion gate (paperTrading.ts) and lazy promoter
      // (lazyPromoteShadowToPaper.ts) must be ≤ N seconds old. 180s = 3
      // min — tight enough that no inversion-gate decision uses a
      // significantly out-of-date sharp anchor. Widen if OddspaPI
      // polling can't keep up; tighten as polling cadence improves.
      { key: "pinnacle_max_age_seconds", value: "180" },
      { key: "betfair_odds_max_age_seconds", value: "180" },
      // Bundle 15.A (2026-05-18): minimum Betfair size at best-back
      // before live placement. Per Chris diagnostic #4 — "a 7% edge on
      // £20 of matchable volume isn't a strategy." Default £20 absolute.
      { key: "betfair_liquidity_floor_gbp", value: "20" },
      // Bundle 15.B (2026-05-18): max delta between Pinnacle and
      // Betfair snapshot ages. If Pinnacle is much staler than Betfair,
      // the "edge" likely reflects stale Pinnacle data not real
      // mispricing. Default 90 seconds.
      { key: "freshness_asymmetry_max_delta_seconds", value: "90" },
      // Bundle 15.C (2026-05-18): TTK-weighted Kelly multiplier curve.
      // ttk_factor = clamp(1.0 - (hours_to_ko - 1) / 23, 0.25, 1.0).
      // So T-1h ≈ 1.0, T-12h ≈ 0.52, T-23h ≈ 0.04 (clamped to 0.25).
      // Operator can tighten the floor via this knob.
      { key: "ttk_kelly_floor", value: "0.25" },
      // Bundle 16 (2026-05-18): Pinnacle line-movement direction.
      // If pinnacle_implied drops by more than this in last 10 min,
      // the gap is closing — demote. Tunable.
      { key: "pinnacle_direction_drop_threshold_pp", value: "1.0" },
      // Bundle 18 (2026-05-18): when model + Pinnacle agree direction
      // vs Betfair, apply this multiplier (two-sharp confirmation).
      // Default 1.10 (10% uplift). Capped at 1.0 in code if config is
      // wrong, so safe ceiling.
      { key: "inversion_model_agree_multiplier", value: "1.10" },
      // Bundle 16.B (2026-05-18): symmetric to Bundle 16. When Pinnacle
      // implied is RISING (moving toward Betfair price), sharp money is
      // confirming the Betfair mispricing → uplift stake. Default 1.10×,
      // hard-capped at 1.25× in code. Same threshold as Bundle 16 drop.
      { key: "pinnacle_direction_uplift_multiplier", value: "1.10" },
      // Bundle F4 (2026-05-18): edge-asymmetric Pinnacle freshness gate.
      // Tighter ceilings for marginal-edge bets where freshness matters
      // most. Calibrated against the CLV-vs-age gradient on settled live
      // bets (−4.15% ≤90s, −7.89% ≤10m, −12.66% older). Cell counts at
      // 90-180s are thin (n<10) so thresholds are starting points;
      // recalibrate after Bundle 17 / F0 accumulates more data.
      { key: "pinnacle_max_age_seconds_3to4pp", value: "90" },
      { key: "pinnacle_max_age_seconds_4to5pp", value: "120" },
      { key: "pinnacle_max_age_seconds_5plus", value: "180" },
      // Bundle F2.0 (2026-05-18): OddsPapi adaptive market-trim. When
      // true, skip AH/BTTS follow-up fetches for market_types with zero
      // qualifying scopes in analysis_signal_strength. MO base call
      // continues (free discovery via API's bundled response). Operator
      // can flip to "false" to restore legacy behaviour (fire all).
      { key: "f2_oddspapi_market_trim_enabled", value: "true" },
      // Bundle 13.D.2 (2026-05-18): halt counter windowing. Counts
      // consecutive live losses only on bets placed+settled within
      // these recent windows. Prevents bulk-reconciled historical bets
      // from spuriously firing the 7-loss halt.
      { key: "halt_counter_placed_hours", value: "24" },
      { key: "halt_counter_settled_hours", value: "6" },
      { key: "high_edge_flag_threshold", value: "7.0" },
      { key: "kelly_multiplier_single_sharp", value: "0.5" },
      { key: "kelly_multiplier_two_sharp", value: "1.0" },
      { key: "kelly_multiplier_three_sharp", value: "1.0" },
      { key: "clv_circuit_breaker_threshold", value: "0.0" },
      { key: "per_fixture_exposure_pct", value: "5.0" },
      { key: "per_league_exposure_pct", value: "15.0" },
      { key: "daily_stake_cap_pct", value: "8.0" },
      // Lazy-promote leak-guard knobs (Bundle 5.G) — also seeded here so
      // they appear in agent_config without a manual UPDATE.
      { key: "lazy_promote_min_pinnacle_edge_pp", value: "1.0" },
      { key: "lazy_promote_max_betfair_drift_pct", value: "0.05" },
    ];
    for (const row of inversionSeed) {
      await db
        .insert(agentConfigTable)
        .values(row)
        .onConflictDoNothing({ target: agentConfigTable.key });
    }
    logger.info({ count: inversionSeed.length }, "Bundle 5.N: inversion-pipeline config keys seeded (ON CONFLICT DO NOTHING)");

    // ── Bundle F0 (2026-05-18): freshness observability views ──────────
    // Three views to quantify whether F1's event-driven placement
    // actually lifts the eval-while-fresh ratio from ~4% baseline.
    // Land BEFORE F1 so we have a measurable baseline.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_freshness_actionable_writes_daily AS
      WITH pinn AS (
        SELECT snapshot_time, match_id, market_type, selection_name
        FROM odds_snapshots
        WHERE source IN ('api_football_real:Pinnacle','oddspapi_pinnacle')
          AND snapshot_time >= NOW() - INTERVAL '14 days'
      ),
      tagged AS (
        SELECT
          DATE(p.snapshot_time AT TIME ZONE 'UTC') AS day,
          EXISTS (
            SELECT 1 FROM paper_bets pb
            WHERE pb.match_id = p.match_id
              AND pb.market_type = p.market_type
              AND pb.selection_name = p.selection_name
              AND pb.bet_track = 'shadow'
              AND pb.status = 'pending'
              AND pb.placed_at <= p.snapshot_time
          ) AS is_actionable
        FROM pinn p
      )
      SELECT
        day,
        COUNT(*)::int AS total_writes,
        COUNT(*) FILTER (WHERE is_actionable)::int AS actionable_writes,
        ROUND(COUNT(*) FILTER (WHERE is_actionable) * 100.0 / NULLIF(COUNT(*), 0), 2) AS actionable_pct
      FROM tagged
      GROUP BY day
      ORDER BY day DESC
    `);
    logger.info("Bundle F0: v_freshness_actionable_writes_daily view ready");

    await db.execute(sql`
      CREATE OR REPLACE VIEW v_freshness_placement_per_write_daily AS
      WITH pinn AS (
        SELECT DATE(snapshot_time AT TIME ZONE 'UTC') AS day, COUNT(*)::int AS pinn_writes
        FROM odds_snapshots
        WHERE source IN ('api_football_real:Pinnacle','oddspapi_pinnacle')
          AND snapshot_time >= NOW() - INTERVAL '14 days'
        GROUP BY 1
      ),
      placements AS (
        SELECT
          DATE(placed_at AT TIME ZONE 'UTC') AS day,
          COUNT(*) FILTER (WHERE bet_track = 'live')::int AS live_placed,
          COUNT(*) FILTER (WHERE bet_track = 'shadow')::int AS shadow_placed
        FROM paper_bets
        WHERE placed_at >= NOW() - INTERVAL '14 days'
        GROUP BY 1
      )
      SELECT
        COALESCE(p.day, pl.day) AS day,
        COALESCE(p.pinn_writes, 0)::int AS pinn_writes,
        COALESCE(pl.live_placed, 0)::int AS live_placed,
        COALESCE(pl.shadow_placed, 0)::int AS shadow_placed,
        ROUND(COALESCE(pl.live_placed, 0) * 10000.0 / NULLIF(p.pinn_writes, 0), 2) AS live_per_10k_writes,
        ROUND(COALESCE(pl.shadow_placed, 0) * 10000.0 / NULLIF(p.pinn_writes, 0), 2) AS shadow_per_10k_writes
      FROM pinn p FULL OUTER JOIN placements pl USING (day)
      ORDER BY 1 DESC
    `);
    logger.info("Bundle F0: v_freshness_placement_per_write_daily view ready");

    // ── Bundle F1 (2026-05-18): placement_evaluation_queue ────────────────
    // Event-driven placement evaluator. Pinnacle writers (apiFootball,
    // oddsPapi) insert one row per (match × market × selection) write.
    // The 30-second drain cron picks unprocessed rows within the 180s
    // freshness window and runs the lazy-promoter agreement gate on the
    // matching pending shadow bet. Bypasses the 5-min lazy cron latency
    // so a fresh Pinnacle quote triggers re-evaluation within ~30s,
    // preserving the 180s freshness ceiling for marginal-edge bets.
    //
    // Dedupe rule (Chris 2026-05-18): skip if any LIVE placement on the
    // (match, market, selection) within 180s of the queue row's
    // captured_at. Allow re-evaluation on new Pinnacle writes within
    // the window so direction-reversal signals (Bundle 16 / 16.B) can
    // fire on second-look.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS placement_evaluation_queue (
        id BIGSERIAL PRIMARY KEY,
        match_id BIGINT NOT NULL,
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        source TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        outcome TEXT,
        bet_id BIGINT
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_peq_unprocessed
        ON placement_evaluation_queue (processed_at, captured_at)
        WHERE processed_at IS NULL
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_peq_scope_captured
        ON placement_evaluation_queue (match_id, market_type, selection_name, captured_at DESC)
    `);
    logger.info("Bundle F1: placement_evaluation_queue table + indexes ready");

    // F1 + burn-in: seed config keys
    const f1Seeds: Array<{ key: string; value: string }> = [
      // F1 drain cadence — operator-tunable
      { key: "f1_drain_seconds", value: "30" },
      // F1 dedupe window — must match pinnacle_max_age_seconds; if you
      // change one, change the other.
      { key: "f1_dedupe_window_seconds", value: "180" },
      // F2.A burn-in flag — when false, max_stake_pct (0.02) cap stays
      // active under inversion mode. Flip to true once
      // v_model_calibration_by_scope_daily shows positive stake-weighted
      // CLV on n>=200 settled F2.A bets.
      { key: "f2a_burnin_complete", value: "false" },
    ];
    for (const row of f1Seeds) {
      await db.insert(agentConfigTable).values(row).onConflictDoNothing({ target: agentConfigTable.key });
    }
    logger.info({ count: f1Seeds.length }, "Bundle F1: config keys seeded");

    // ── Bundle F2.A (2026-05-18): bootstrap_priority on competition_config ────
    // Operator override for the polling system — flag a competition for
    // accelerated discovery cadence (e.g., new WC, women's expansion).
    // Bootstrap-priority fixtures get polled every 30 min regardless of
    // their watch_priority tier.
    await db.execute(sql`
      ALTER TABLE competition_config
      ADD COLUMN IF NOT EXISTS bootstrap_priority BOOLEAN NOT NULL DEFAULT false
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_competition_config_bootstrap
        ON competition_config(bootstrap_priority) WHERE bootstrap_priority = true
    `);
    logger.info("Bundle F2.A: competition_config.bootstrap_priority column ready");

    // ── Bundle F2.A (2026-05-18): model calibration audit view ────────────
    // Daily per-scope CLV-vs-opportunity_score check. If a scope's
    // avg_opportunity_score is high but realised CLV is negative, the
    // model is over-confident there → flag for retraining. Read by
    // admin/freshness-metrics (extended) + a daily cron writes a
    // compliance alert if global stake-weighted CLV < tripwire on
    // n >= tripwire_min_n bets post-F2.A.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_model_calibration_by_scope_daily AS
      WITH base AS (
        SELECT
          DATE(pb.placed_at AT TIME ZONE 'UTC') AS day,
          m.league,
          pb.market_type,
          pb.bet_track,
          pb.stake::float8 AS stake,
          pb.shadow_stake::float8 AS shadow_stake,
          pb.clv_pct::float8 AS clv_pct,
          pb.model_probability::float8 AS model_p,
          (1.0 / NULLIF(pb.odds_at_placement::float8, 0)) AS bf_implied,
          pb.status
        FROM paper_bets pb
        JOIN matches m ON m.id = pb.match_id
        WHERE pb.placed_at >= NOW() - INTERVAL '14 days'
          AND pb.bet_track IN ('live','shadow')
          AND pb.legacy_regime = false
          AND pb.status IN ('won','lost','void')
          AND pb.clv_pct IS NOT NULL
      )
      SELECT
        day,
        league,
        market_type,
        bet_track,
        COUNT(*)::int AS n,
        ROUND(AVG(model_p)::numeric, 4) AS avg_model_p,
        ROUND(AVG(bf_implied)::numeric, 4) AS avg_bf_implied,
        ROUND(AVG(clv_pct)::numeric, 2) AS avg_clv_pct,
        ROUND(
          CASE
            WHEN SUM(COALESCE(stake, shadow_stake, 0)) > 0
            THEN SUM(COALESCE(stake, shadow_stake, 0) * clv_pct) / SUM(COALESCE(stake, shadow_stake, 0))
            ELSE AVG(clv_pct)
          END::numeric, 2
        ) AS stake_weighted_clv_pct,
        ROUND(AVG(CASE WHEN status='won' THEN 1.0 ELSE 0.0 END)::numeric, 3) AS win_rate
      FROM base
      GROUP BY day, league, market_type, bet_track
      HAVING COUNT(*) >= 5
      ORDER BY day DESC, n DESC
    `);
    logger.info("Bundle F2.A: v_model_calibration_by_scope_daily view ready");

    // ── Bundle F2.A (2026-05-18): config seeds ──────────────────────────
    // The polling tier-cadence + agreement gate + tripwire knobs.
    const f2aSeeds: Array<{ key: string; value: string }> = [
      // Polling cadences in minutes — operator-tunable
      { key: "f2a_tier1_cadence_minutes", value: "5" },
      { key: "f2a_tier2_cadence_minutes", value: "30" },
      { key: "f2a_tier3_cadence_minutes", value: "60" },
      { key: "f2a_tier4_cadence_minutes", value: "360" },
      { key: "f2a_bootstrap_cadence_minutes", value: "30" },
      // Tripwire (audit-only, no auto-pause — money guardrail boundary)
      { key: "f2a_tripwire_clv_threshold_pct", value: "-1.0" },
      { key: "f2a_tripwire_min_n", value: "50" },
      // Agreement gate kill-switch (default ON)
      { key: "f2a_agreement_gate_enabled", value: "true" },
    ];
    for (const row of f2aSeeds) {
      await db.insert(agentConfigTable).values(row).onConflictDoNothing({ target: agentConfigTable.key });
    }
    logger.info({ count: f2aSeeds.length }, "Bundle F2.A: config keys seeded");

    await db.execute(sql`
      CREATE OR REPLACE VIEW v_freshness_clv_by_age_band_daily AS
      WITH lb AS (
        SELECT
          DATE(pb.placed_at AT TIME ZONE 'UTC') AS day,
          pb.calculated_edge, pb.placed_at, pb.odds_at_placement,
          pb.closing_pinnacle_odds, pb.status,
          EXTRACT(EPOCH FROM (
            pb.placed_at - (
              SELECT MAX(os.snapshot_time)
              FROM odds_snapshots os
              WHERE os.match_id = pb.match_id
                AND os.market_type = pb.market_type
                AND os.source IN ('api_football_real:Pinnacle','oddspapi_pinnacle')
                AND os.snapshot_time <= pb.placed_at
            )
          )) AS pinn_age_s
        FROM paper_bets pb
        WHERE pb.bet_track = 'live'
          AND pb.placed_at >= NOW() - INTERVAL '14 days'
          AND pb.status IN ('won','lost')
          AND pb.calculated_edge IS NOT NULL
          AND pb.closing_pinnacle_odds IS NOT NULL
          AND pb.odds_at_placement IS NOT NULL
      )
      SELECT
        day,
        CASE
          WHEN pinn_age_s <= 90 THEN '1_le_90s'
          WHEN pinn_age_s <= 120 THEN '2_le_120s'
          WHEN pinn_age_s <= 180 THEN '3_le_180s'
          WHEN pinn_age_s <= 600 THEN '4_le_10m'
          ELSE '5_older'
        END AS age_band,
        COUNT(*)::int AS n,
        ROUND(AVG((1.0/odds_at_placement - 1.0/closing_pinnacle_odds) * 100)::numeric, 2) AS avg_clv_pct,
        ROUND(AVG(CASE WHEN status='won' THEN 1 ELSE 0 END)::numeric, 3) AS win_rate
      FROM lb
      WHERE pinn_age_s IS NOT NULL
      GROUP BY day, age_band
      ORDER BY day DESC, age_band
    `);
    logger.info("Bundle F0: v_freshness_clv_by_age_band_daily view ready");

    // ── Bundle F2.B.B (2026-05-19): Pinnacle line-movement velocity tracker ──
    // One row per (match, market, selection, window_seconds, window_end).
    // window_end is rounded to the cron tick so UPSERTs collide and don't
    // duplicate. Lazy promoter consumes via direction + is_stable; Bundle
    // B.2 will use stable windows to pin early_clv_estimate on paper_bets.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS pinnacle_line_movement (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        market_type TEXT NOT NULL,
        selection_name TEXT NOT NULL,
        window_seconds INTEGER NOT NULL,
        window_end TIMESTAMPTZ NOT NULL,
        n_snapshots INTEGER NOT NULL,
        velocity_implied_pp_per_hour NUMERIC(8,3),
        max_abs_delta_pp NUMERIC(8,3),
        last_snapshot_age_s INTEGER,
        direction TEXT,
        is_stable BOOLEAN NOT NULL DEFAULT FALSE,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS pinn_lm_unique
        ON pinnacle_line_movement
        (match_id, market_type, selection_name, window_seconds, window_end)
    `);
    // Read-side helper index: lazy promoter looks up by (match, market,
    // selection) ordered by window_end DESC to get the latest classification.
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS pinn_lm_lookup
        ON pinnacle_line_movement
        (match_id, market_type, selection_name, window_end DESC)
    `);
    logger.info("Bundle F2.B.B: pinnacle_line_movement table ready");

    // ── Bundle F2.B.B.2 (2026-05-19): velocity-derived early CLV estimate ──
    // Two columns on paper_bets. Populated by the lazy promoter when a
    // stable pinnacle_line_movement window exists for the bet's selection
    // inside the <30m TTK bucket. Strictly promotion-gate-only; settlement-
    // grade CLV stays clv_pct anchored to the actual closing snapshot.
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS early_clv_estimate NUMERIC(8,4),
        ADD COLUMN IF NOT EXISTS early_clv_estimate_quality TEXT
    `);
    logger.info("Bundle F2.B.B.2: paper_bets early_clv_estimate columns ready");

    // ── Bundle F2.B.F (2026-05-19): per-league HT goal fraction ──
    // One row per league. ht_fraction_posterior is the Bayesian-shrunk
    // value used by predictHalfTimeMatchOdds / predictSecondHalfMatchOdds.
    // Refit on demand via POST /api/admin/fit-half-fractions.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS league_half_fractions (
        id SERIAL PRIMARY KEY,
        league TEXT NOT NULL,
        n_matches INTEGER NOT NULL,
        ht_fraction_mle NUMERIC(6,4),
        ht_fraction_posterior NUMERIC(6,4) NOT NULL,
        fit_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS league_half_fractions_unique
        ON league_half_fractions (league)
    `);
    logger.info("Bundle F2.B.F: league_half_fractions table ready");

    // ── Bundle F2.B.H (2026-05-19): Beta-Binomial continuous calibration ──
    // Adds posterior counters + version pin so the calibration substrate
    // updates on every settled bet (not just weekly via fit_calibration.py)
    // without retroactively changing Kelly attribution on bets already
    // placed under the prior version.
    await db.execute(sql`
      ALTER TABLE calibration_buckets
        ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS posterior_alpha NUMERIC(12,2) NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS posterior_beta NUMERIC(12,2) NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS last_settled_bet_id INTEGER,
        ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ
    `);
    await db.execute(sql`
      ALTER TABLE paper_bets
        ADD COLUMN IF NOT EXISTS calibration_bucket_version_at_placement INTEGER
    `);
    logger.info("Bundle F2.B.H: calibration_buckets posterior + version columns ready");

    // ── Bundle F2.B.I (2026-05-19): niche-league Betfair-coverage cache ──
    // Three columns on competition_config so betfairMarketDiscovery can
    // track which leagues have ever returned a Betfair market AND apply
    // a negative-cache (skip leagues with 3+ fails and no successes in 30d).
    await db.execute(sql`
      ALTER TABLE competition_config
        ADD COLUMN IF NOT EXISTS has_betfair_coverage BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS discovery_fail_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_discovery_attempt_at TIMESTAMPTZ
    `);
    logger.info("Bundle F2.B.I: competition_config Betfair-coverage columns ready");

    // ── Bundle F2.B.L (2026-05-19): liquidity-aware deployability ──
    // One column on analysis_signal_strength tracking median Betfair
    // back-side volume at 1% slippage over the last 30d per (league x
    // market_type). v_live_eligibility_market_types filter add in v2;
    // first land the computed column for operator audit.
    await db.execute(sql`
      ALTER TABLE analysis_signal_strength
        ADD COLUMN IF NOT EXISTS median_back_volume_at_1pct_slippage_30d NUMERIC(12,2)
    `);
    logger.info("Bundle F2.B.L: analysis_signal_strength liquidity column ready");

    // ── Bundle F2.B.K (2026-05-19): cross-market predictor consistency ──
    // SQL view comparing MATCH_ODDS-derived P(home_wins) to model_probability
    // on the same match's other markets. Disagreement >2pp flags the
    // predictor for inspection. Per-bet veto (with hysteresis) deferred —
    // v1 ships the diagnostic view + admin endpoint.
    await db.execute(sql`
      CREATE OR REPLACE VIEW v_predictor_consistency AS
      WITH mo AS (
        SELECT match_id,
               MAX(model_probability::float8) FILTER (WHERE selection_name = 'Home') AS mo_home,
               MAX(model_probability::float8) FILTER (WHERE selection_name = 'Draw') AS mo_draw,
               MAX(model_probability::float8) FILTER (WHERE selection_name = 'Away') AS mo_away,
               MAX(placed_at) AS latest_mo_at
        FROM paper_bets
        WHERE market_type = 'MATCH_ODDS'
          AND deleted_at IS NULL
          AND placed_at >= NOW() - INTERVAL '24 hours'
        GROUP BY match_id
      ),
      eh AS (
        SELECT match_id,
               MAX(model_probability::float8) FILTER (WHERE selection_name = 'Home 0') AS eh_home,
               MAX(model_probability::float8) FILTER (WHERE selection_name = 'Draw 0') AS eh_draw,
               MAX(model_probability::float8) FILTER (WHERE selection_name = 'Away 0') AS eh_away
        FROM paper_bets
        WHERE market_type = 'EUROPEAN_HANDICAP'
          AND selection_name IN ('Home 0','Draw 0','Away 0')
          AND deleted_at IS NULL
          AND placed_at >= NOW() - INTERVAL '24 hours'
        GROUP BY match_id
      )
      SELECT
        mo.match_id,
        mo.mo_home, mo.mo_draw, mo.mo_away,
        eh.eh_home, eh.eh_draw, eh.eh_away,
        ABS(COALESCE(mo.mo_home, 0) - COALESCE(eh.eh_home, 0)) * 100 AS disagreement_home_pp,
        ABS(COALESCE(mo.mo_draw, 0) - COALESCE(eh.eh_draw, 0)) * 100 AS disagreement_draw_pp,
        ABS(COALESCE(mo.mo_away, 0) - COALESCE(eh.eh_away, 0)) * 100 AS disagreement_away_pp,
        mo.latest_mo_at
      FROM mo
      LEFT JOIN eh ON eh.match_id = mo.match_id
      WHERE eh.match_id IS NOT NULL
    `);
    logger.info("Bundle F2.B.K: v_predictor_consistency view ready");

    // ── Bundle F2.B.N (2026-05-19): per-league dispersion k ──
    // One row per (league, family) where family ∈ {corners, cards}.
    // Replaces hardcoded CORNERS_K_GLOBAL / CARDS_K_GLOBAL with
    // Bayesian-shrunk MoM fits.
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS league_dispersion_k (
        id SERIAL PRIMARY KEY,
        league TEXT NOT NULL,
        family TEXT NOT NULL,
        n_matches INTEGER NOT NULL,
        mean NUMERIC(8,3),
        variance NUMERIC(10,3),
        k_mle NUMERIC(8,3),
        k_posterior NUMERIC(8,3) NOT NULL,
        fit_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS league_dispersion_k_unique
        ON league_dispersion_k (league, family)
    `);
    logger.info("Bundle F2.B.N: league_dispersion_k table ready");

    logger.info("Migrations complete");
  } catch (err) {
    logger.error({ err }, "Migration failed");
    throw err;
  }
}
