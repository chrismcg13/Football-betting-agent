# Workspace

## Overview

This project is an AI betting agent designed for paper-trading football bets. It leverages the Betfair Exchange Delayed API for market data and API-Football v3 for real odds and match information. The agent's core purpose is to identify value bets, manage a simulated bankroll, and continuously learn and adapt its betting strategy based on performance.

The system features a robust data ingestion pipeline, a sophisticated feature engineering engine for machine learning models, and a dynamic prediction engine that employs logistic regression models. It includes comprehensive risk management protocols, an opportunity scoring system to identify promising bets, and a sophisticated experiment-to-promotion pipeline for rigorously testing and deploying new betting strategies. The agent aims for autonomous operation, continuous self-improvement, and transparent auditability of all decisions.

## User Preferences

I prefer iterative development, with a focus on delivering small, functional increments.
Please use clear and concise language in your explanations.
For any significant architectural changes or new feature implementations, please ask for my approval before proceeding.
I value well-structured and readable code, favoring functional programming paradigms where appropriate.
Ensure all database schema changes are clearly documented and backward-compatible if possible.
Do not make changes to files related to UI/UX unless explicitly requested.
Do not make changes to folder `src/tests`.

## System Architecture

The project is structured as a pnpm monorepo utilizing TypeScript 5.9, Node.js 24, and pnpm as the package manager. The backend API is built with Express 5, interacting with a PostgreSQL database via Drizzle ORM. Data validation is handled by Zod.

**Key Features:**

*   **Data Models:** A comprehensive database schema (PostgreSQL + Drizzle ORM) tracks matches, odds snapshots, computed ML features, paper bets, model states, learning narratives, compliance logs, agent configurations, and API usage.
*   **Agent Configuration:** Runtime settings such as bankroll, stake limits, edge thresholds, and diversity rules are dynamically configurable.
*   **API Endpoints:** A RESTful API provides endpoints for managing agent configuration, matches, paper bets, odds ingestion, feature computation, ML predictions, model management, value bet detection, learning narratives, compliance logs, data ingestion triggers, and a rich set of dashboard analytics.
*   **Market Types & Models:** Supports various football market types (e.g., Match Odds, BTTS, Over/Under, Asian Handicap, Cards, Corners), each potentially leveraging specific ML models (e.g., Logistic Regression, Poisson).
*   **Opportunity Scoring:** A 5-component scoring system (Edge, Confidence, Odds Sweet Spot, Market Quality, Form Alignment) identifies high-value betting opportunities, with real odds prioritized over synthetic ones.
*   **Staking Strategy:** Implements Kelly Criterion-based staking tiers, adjusted by opportunity score and market type (e.g., 0.7x multiplier for cards/corners).
*   **Diversity Rules:** Per-cycle limits on total bets, bets per league, and bets per market type to manage risk concentration.
*   **Prediction Engine:** Employs logistic regression models for core predictions, with Poisson heuristics for specific markets. Models are bootstrapped from historical data, auto-loaded on startup, and retrained after significant new data accumulation.
*   **Feature Engine:** Computes 17 machine learning features per upcoming match, including team form, goal averages, BTTS rates, H2H statistics, and league position differentials.
*   **Scheduler:** Orchestrates automated jobs for data ingestion, feature computation, trading cycles, bet settlement, odds fetching, team stats updates, and a daily learning loop.
*   **Line Movement Tracking:** Monitors and logs significant odds changes (>5%) for compliance and analytical purposes, categorizing them as shortening or drifting.
*   **League Coverage:** Tracks 117+ competitions across three tiers (Tier 1: 36 international/continental, Tier 2: 70 top domestic/cups, Tier 3: 11 lower divisions) with a `competition_config` table storing coverage metadata (statistics, lineups, events, Pinnacle odds, polling frequency). Daily league discovery auto-expands coverage (290+ discovered). Fixture ingestion runs twice daily. API budget: 75K calls/month with daily target of 2,500. Dashboard shows Competition Coverage panel with tier/type/gender breakdowns and API budget utilisation.
*   **xG Intelligence:** Integrates Expected Goals (xG) data, derived from the internal feature engine, to inform predictions and team performance analysis.
*   **Risk Management:** Dual-mode circuit breaker system. **Dev mode** (NODE_ENV≠production): log-only — agent never self-pauses, all would-have-triggered events logged to `drawdown_events` table with `would_have_triggered=true`. Legacy gross-loss/floor placement gates are also bypassed in dev. **Prod mode**: high-water-mark (HWM) drawdown model — daily pause at ≥10% drawdown (configurable), weekly at ≥20%, catastrophic stop at >50%. HWM tracked in `agent_config` (keys: `high_water_mark`, `hwm_updated_at`). `setConfigValue` uses upsert for safe persistence. Dashboard shows circuit breaker banner (mode, HWM, drawdown %, distance to limits) and recent event log. Endpoints: `/api/admin/circuit-breaker-status`, `/api/admin/resume-agent`.
*   **Experiment Pipeline:** A robust system to manage betting strategies through experiment, candidate, and promoted tiers, with statistical evidence driving progression. This includes schema extensions for `paper_bets`, new tables (`experiment_registry`, `promotion_audit_log`, `experiment_learning_journal`), and a daily promotion engine. Candidate bets use reduced stakes, and in production, only promoted strategies are allowed to place bets.
*   **Settlement Architecture:** Settlement cron runs every 2 minutes. `syncMatchResults` fetches finished fixtures from API-Football and matches to DB using `apiFixtureId` (primary) then fuzzy team name matching (fallback). Backfill re-settles voided bets (all markets) only when voided >1hr after placement (protects dedup/admin voids). `apiFixtureId` stored during fixture ingestion for reliable matching.
*   **Stats Coverage Guard:** Corners/cards bets are blocked at placement for leagues where API-Football doesn't provide `statistics_fixtures` coverage (stored in `competition_config.has_statistics`). 144 leagues have stats coverage; ~870 don't. Bug fix: the coverage field name was `statistics_fixtures` not `statistics` — corrected in `leagueDiscovery.ts`. Prevents wasted stakes on unsettleable bets.
*   **Environment Isolation:** Strict separation of development and production databases, with a controlled synchronization mechanism for promoted strategies.
*   **Startup Process:** Automated database migrations and agent configuration seeding on server startup.

## External Dependencies

*   **Betfair Exchange API:** Used for paper-trading and live trading football bets via VPS proxy (`BETFAIR_PROXY_URL`). Live trading uses `LIVE_BETFAIR_KEY` with real money placement through `betfairLive.ts` service.
*   **API-Football v3 (via RapidAPI):** Primary source for real odds, match results, team statistics (yellow cards, corners, shots), and fixture data. Budget usage is tracked.
*   **PostgreSQL:** The primary database for all application data.
*   **OddsPapi:** Used for bulk prefetching and refreshing Pinnacle odds, with budget tracking and coverage reporting.
*   **football-data.org:** (DISABLED) Previously used for data ingestion; now replaced by API-Football v3.
*   **StatsBomb/Fotmob:** (Implicitly via internal feature engine) Data sources for Expected Goals (xG) which are then processed by the internal feature engine.

## Production Safety

*   **Startup Safety Check:** In production (`ENVIRONMENT=production`), the server checks `DATABASE_URL` hostname against known dev hosts (`helium`, `localhost`, `127.0.0.1`). If it matches, the server aborts with a FATAL error. No dependency on `DEV_DATABASE_URL` being set.
*   **Production Quarantine:** `placePaperBet()` blocks experiment-tier and opportunity-boosted bets in production. Only promoted-tier bets are allowed.
*   **Sync Double-Gate:** `syncDevToProd.ts` requires both `sync_eligible=true AND data_tier='promoted'` to sync bets from dev to prod.
*   **Candidate Stake Reduction:** Candidate-tier bets use 25% Kelly multiplier (configurable via `CANDIDATE_STAKE_MULTIPLIER` env var).
*   **ENVIRONMENT env var:** Set to `"production"` in the artifact.toml production run config.
*   **Live Trading Safety (`betfairLive.ts`):**
    - `TRADING_MODE=PAPER` (dev) / `TRADING_MODE=LIVE` (prod). Live placement only when LIVE.
    - Startup health checks must pass or schedulers/trading engine are disabled (hard-stop).
    - Balance staleness: if cached balance is >1hr old, live bets are skipped (paper bet preserved).
    - Non-retryable errors (INSUFFICIENT_FUNDS, MARKET_SUSPENDED, etc.) are never retried.
    - £2 minimum stake enforced. Non-exchange markets (corners/cards) are paper-only.
    - Live bankroll from Betfair account used for stake sizing in LIVE mode (falls back to config bankroll if unavailable).
    - 30-min settlement reconciliation cron + 15-min balance refresh in LIVE mode.
    - 12hr proactive session refresh with auto-retry on INVALID_SESSION.
    - `paper_bets` table extended with `betfair_*` columns for tracking live bet state.
*   **Two-Tier Live System (`dataRichness.ts`, `liveThresholdReview.ts`):**
    - **Tier 1 (live money):** Bets qualify if: opportunity score >= configurable threshold (default 68, floor 60), data richness >= 70%, Pinnacle odds available with >= 2% edge vs current Pinnacle implied, AND either (a) data-rich market path or (b) promoted strategy path. Experiment/candidate tier bets NEVER qualify.
    - **Tier 2 (paper only):** All bets not meeting Tier 1 criteria stay in the experiment pipeline. No changes to experiment graduation gates.
    - **Data richness scoring:** `data_richness_cache` table tracks league-market combos with composite score (Pinnacle coverage 30%, statistics 20%, lineups 10%, events 10%, fixture depth 15%, frequency 15%). Recalculated weekly (Sunday 04:30 UTC) + on startup.
    - **Adaptive threshold:** Weekly review (Sunday 05:00 UTC) adjusts the opportunity score threshold based on 30-day rolling Tier 1 performance. Requires 50+ settled bets. Factors: CLV trend, ROI stability (stddev), market diversity (Herfindahl). Changes logged to `promotion_audit_log`.
    - **`live_tier` column** on `paper_bets` (independent of `data_tier`) tracks tier1/tier2 assignment per bet.
    - **API:** `/api/admin/live-tier-stats` returns threshold, tier breakdown, and data richness summary.

## Experiment Pipeline

*   **Tag Format:** `{league-slug}-{market-type-slug}` (league-market granularity, NOT per-match)
*   **Promotion Thresholds (env-var configurable):**
    - Experiment → Candidate: ≥30 bets, ≥3% ROI, ≥1.5% CLV, ≥52% WR, ≤0.10 p-value, ≥3 weeks, ≥2% edge
    - Candidate → Promoted: ≥20 bets, ≥2% ROI, ≥1% CLV, ≤0.05 p-value, ≥2 weeks
    - Demotion (promoted→candidate): rolling 30-bet window, ROI<0% or CLV<0% or 3 consecutive negative weeks
    - Demotion (candidate→experiment): ROI<-5% or CLV<0%
    - Abandon: ≥50 bets, ROI<-10%, p-value≤0.10
*   **Dashboard:** `/experiments` page shows experiments sorted by sample size (only those with ≥1 bet shown), with progress bars (Sample, ROI, CLV, Win Rate, P-Value, Edge), distance-to-promotion metrics, bets/week velocity, estimated weeks to evaluation, last bet timestamp, and manual promote/demote with full audit logging. Abandoned experiments shown greyed out with strikethrough at bottom. 4-column summary (Total Active, Experiments, Candidates, Promoted) + "Closest to Promotion" spotlight card.
*   **Go Live Readiness Panel:** Overview page shows weighted readiness score (6 criteria: sample size 30%, promoted strategy 25%, CLV 15%, ROI 10%, win rate 10%, bankroll growth 10%). Includes pace estimate and estimated days to target. API: `/api/admin/go-live-readiness`.
*   **Demo Day Panel:** Enhanced with pipeline snapshot (promoted/candidate/experiment counts) and betting pace estimate.
*   **Crons:** Promotion engine daily at 04:00 UTC, experiment analysis Sundays at 04:00, dev→prod sync every 6 hours.
*   **Excluded Markets (abandoned):** OVER_UNDER_05 (all leagues) — unfavourable risk/reward structure (~92% base win rate). 8 experiment tags set to `abandoned` tier. Historical bet data preserved for audit.
*   **Production Schedulers:** All schedulers (betting, settlement, ML training, data ingestion) are DISABLED in production. Production only serves the dashboard API. Data flows exclusively via syncDevToProd pipeline.