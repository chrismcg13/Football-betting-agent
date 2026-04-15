# Overview

This project is an AI betting agent designed for paper-trading football bets, leveraging the Betfair Exchange Delayed API and API-Football v3 for data. Its primary goal is to identify value bets, manage a simulated bankroll, and continuously refine its betting strategy. The system includes a data ingestion pipeline, a feature engineering engine for machine learning models (logistic regression), risk management, and an experiment-to-promotion pipeline for strategy deployment. The agent aims for autonomous operation, continuous self-improvement, and transparent decision-making.

# User Preferences

I prefer iterative development, with a focus on delivering small, functional increments.
Please use clear and concise language in your explanations.
For any significant architectural changes or new feature implementations, please ask for my approval before proceeding.
I value well-structured and readable code, favoring functional programming paradigms where appropriate.
Ensure all database schema changes are clearly documented and backward-compatible if possible.
Do not make changes to files related to UI/UX unless explicitly requested.
Do not make changes to folder `src/tests`.

# System Architecture

The project is a pnpm monorepo using TypeScript 5.9, Node.js 24, and Express 5 for the backend API, interacting with a PostgreSQL database via Drizzle ORM. Zod handles data validation.

**Key Architectural Decisions & Features:**

*   **Data Models:** Comprehensive schema for matches, odds, ML features, paper bets, model states, learning narratives, compliance, agent configurations, and API usage.
*   **Agent Configuration:** Dynamic settings for bankroll, stake limits, edge thresholds, and diversity rules.
*   **API Endpoints:** RESTful API for managing configurations, data, predictions, and analytics.
*   **Market Types & Models:** Supports various football market types (Match Odds, BTTS, Over/Under, Asian Handicap, Cards, Corners) with specific ML models (e.g., Logistic Regression, Poisson).
*   **Opportunity Scoring:** A 5-component system (Edge, Confidence, Odds Sweet Spot, Market Quality, Form Alignment) to identify high-value bets.
*   **Staking Strategy:** Kelly Criterion-based tiers, adjusted by opportunity score and market type.
*   **Diversity Rules:** Per-cycle limits on total bets, bets per league, and bets per market type.
*   **Prediction Engine:** Uses logistic regression, bootstrapped from historical data, auto-loaded, and retrained.
*   **Feature Engine:** Computes 17 ML features per upcoming match (e.g., team form, H2H stats).
*   **Scheduler:** Orchestrates automated jobs for data ingestion, feature computation, trading cycles (tiered by fixture proximity), bet settlement, and daily learning loops.
*   **North Star Metrics & Continuous Learning:** Tracks CLV, ROI, Win Rate. Generates weekly model health reports, detects market regimes, tracks edge decay, and provides agent recommendations for resource utilization and enhancement.
*   **Line Movement Tracking:** Logs significant odds changes (>5%) for analysis and compliance.
*   **League Coverage:** Tracks 1,021 competitions across three tiers with metadata for coverage and polling frequency.
*   **xG Intelligence:** Integrates Expected Goals data from the internal feature engine.
*   **Risk Management (Circuit Breaker):** Dual-mode system (Dev/Prod). Production mode implements a high-water-mark drawdown model for pausing/halting agent operation based on loss thresholds.
*   **Experiment Pipeline:** Manages betting strategies through experiment, candidate, and promoted tiers, with statistical evidence driving progression and reduced stakes for unproven strategies.
*   **Settlement Architecture:** Cron-based settlement of bets, scoped to leagues with pending bets, fetching results from API-Football.
*   **Edge Concentration:** Segments bets by league, market family, and odds range to classify opportunities as `exploit`, `explore`, or `avoid`, applying segmented Kelly multipliers.
*   **Stats Coverage Guard:** Blocks card bets for leagues without `statistics_fixtures` coverage in API-Football.
*   **Environment Isolation:** Strict separation of development and production databases.
*   **Liquidity Tracking:** Logs Betfair order book depth after bet placements for aggregate shortfall analysis.
*   **Order Management:** Monitors live Betfair orders for partial fills, canceling unmatched orders near kickoff based on price chase limits.
*   **Startup Process:** Automated database migrations and agent configuration seeding.
*   **Production Safety:** Includes startup checks, quarantine of experiment/opportunity-boosted bets, dual-gate sync for dev-to-prod, reduced candidate stake, and a comprehensive live trading safety system (`liveRiskManager.ts`) with progressive risk levels, concentration limits, and multi-level circuit breakers. A two-tier live system differentiates between live-money bets (Tier 1) and paper-only bets (Tier 2) based on opportunity score, data richness, and Pinnacle validation.

# External Dependencies

*   **Betfair Exchange API:** For paper and live trading, accessed via a VPS relay for bet placement, balance polling, and market data.
*   **API-Football v3 (via RapidAPI):** Primary source for real odds, match results, team statistics, and fixture data. Features budget management and tiered fetching.
*   **PostgreSQL:** The primary database.
*   **OddsPapi:** Used for sharp-line validation, best-odds layering, and line movement tracking, with budget allocation based on priority. Implements a three-snapshot CLV system.
*   **StatsBomb/Fotmob:** (Implicitly via internal feature engine) Provides Expected Goals (xG) data.

# Dashboard (artifacts/dashboard)

React + Vite frontend using Wouter routing, TanStack Query, Recharts, and shadcn/ui. Dark theme throughout.

**Pages:**
*   **Overview** (`/dashboard/`): In-play bets with live scores, upcoming bets with countdown, agent recommendations, execution metrics, stat cards (Profit, ROI, Win Rate, CLV).
*   **Bet History** (`/dashboard/bets`): In-play section at top, full bet table with Betfair execution details (fill status, matched size, avg price, P&L), CLV/Pinnacle columns, expandable reasoning with bet thesis. LiveTierBadge for Tier 1/2 classification.
*   **Live Performance** (`/dashboard/performance`): P&L chart (cumulative, 90 days), league breakdown, market type breakdown, Tier 1 vs Tier 2 stats, execution quality panel, Commission & Costs section (gross/net P&L, effective rate, projected monthly commission, Premium Charge warning at £20k+, exchange list), model health section.
*   **Experiment Lab** (`/dashboard/experiments`): Tier pipeline (experiment → candidate → promoted), Tier 1 qualification badges, progress bars, distance-to-promotion, manual promotion controls, tooltips for CLV/ROI/p-value.
*   **Agent Brain** (`/dashboard/agent-brain`): Learning narratives, self-generated insights.
*   **Audit Trail** (`/dashboard/compliance`): Compliance and transparency logs.
*   **Alerts** (`/dashboard/alerts`): System alerts with severity filtering (critical/warning/info), dismiss/dismiss-all, test alert firing, detection runner. Notification badge in sidebar shows unread count with red (critical) or amber (warning) coloring. Summary cards show per-severity breakdown.

**Shared Components (layout.tsx):** `LiveTierBadge`, `InfoTooltip`, `BetStatusBadge`, `OddsSourceBadge`.

**Hooks (use-dashboard.ts):** `useSummary`, `useBets`, `usePerformance`, `useClvStats`, `useBetsByLeague`, `useBetsByMarket`, `useInPlayBets`, `useUpcomingBets`, `useExecutionMetrics`, `useLiveSummary`, `useAgentRecommendations`, `useModelHealth`, `useLiveTierStats`, `useExperiments`, `useRunPromotionEngine`, `useManualPromote`, `useAlerts`, `useUnreadAlertCount`, `useAcknowledgeAlert`, `useAcknowledgeAllAlerts`, `useFireTestAlert`, `useRunAlertDetection`, `useCommissionStats`.

**API Endpoints consumed:** `/api/dashboard/summary`, `/api/dashboard/bets`, `/api/dashboard/performance`, `/api/dashboard/clv-stats`, `/api/dashboard/bets/by-league`, `/api/dashboard/bets/by-market`, `/api/dashboard/in-play`, `/api/dashboard/upcoming-bets`, `/api/dashboard/execution-metrics`, `/api/dashboard/live-summary`, `/api/dashboard/agent-recommendations`, `/api/admin/experiments`, `/api/alerts`, `/api/alerts/unread-count`, `/api/alerts/:id/acknowledge`, `/api/alerts/acknowledge-all`, `/api/alerts/test`, `/api/alerts/run-detection`, `/api/dashboard/commission`.

# Alerting System

**Schema:** `lib/db/src/schema/alerts.ts` — `alerts` table with severity, category, code, title, message, metadata (JSONB), acknowledged flag, webhook delivery tracking. Deduplication via cooldown windows (critical=1h, warning=4h, info=24h).

**Services:**
*   `alerting.ts`: Core CRUD (createAlert with dedup, acknowledge, getAlerts with pagination/filtering, getUnreadCount with per-severity breakdown, cleanupOldAlerts with 90-day retention, webhook delivery).
*   `alertDetection.ts`: 20+ detection checks across categories: connectivity (Betfair/API-Football/VPS), risk (drawdown, exposure, consecutive losses), performance (CLV decay, ROI decline, win rate), execution (fill rate, latency), anomaly (statistical outliers), milestone (bet count, profit targets), system (API budget, no-bet detection, cron health/missed-run detection).

# Operational Resilience (6-Phase Hardening)

**Phase 1 — API Resilience:** `resilientFetch.ts` provides 30s timeout, 3× exponential backoff retry, per-service circuit breaker (5 failures/10min → 15min cooldown). Wired into `apiFootball.ts` and `oddsPapi.ts`. Graceful degradation: API-Football circuit open → +5 opportunity score threshold.

**Phase 2 — Bet Lifecycle Safety:** DB transaction wrapping (bet insert + compliance log in BEGIN/COMMIT/ROLLBACK). PENDING_PLACEMENT status set before Betfair API call; PLACEMENT_FAILED on failure/exception. `reconcileStalePlacements()` checks Betfair cleared orders hourly.

**Phase 3 — Cron Monitoring:** `cron_executions` table tracks every job run (start/end/success/error/duration). `trackCronExecution()` wrapper in `safeRunIngestion` and `safeRunFeatures`. Trading cycle logs success/error to cron_executions. `checkCronHealth()` alert detection fires warning/critical for missed cron runs (trading 2+ misses = critical).

**Phase 4 — Shutdown & Recovery:** SIGTERM/SIGINT handlers with idempotent shutdown flag. 2s grace period for in-flight operations, then reconcile stale placements and log shutdown to compliance. Startup reconciliation runs `reconcileStalePlacements()` before serving traffic.

**Phase 5 — Database Safety:** `deleted_at` column on `paper_bets`, `compliance_logs`, `alerts`. DELETE operations converted to soft deletes (UPDATE SET deleted_at). Alert queries filter `deleted_at IS NULL`.

**Phase 6 — Budget Projections:** Monthly usage projection (avg daily × days in month) on both API-Football and OddsPapi. Auto-throttle at 90% projected usage halves daily cap. Dashboard sidebar shows projection percentage with throttle warning (red "THROTTLED" indicator).

**Scheduler crons:** Alert detection every 5 min, anomaly detection daily 04:30 UTC, cleanup weekly Sunday 06:00 UTC.

# Commission Tracking

**Schema:** `exchanges` table (Betfair 5% standard, Smarkets 2%, Betdaq 2%, Matchbook 1.8%). `commissionTracking` table for future per-market tracking. Commission columns on `paper_bets`: `grossPnl`, `commissionRate`, `commissionAmount`, `netPnl`, `exchangeId`.

**Service (`commissionService.ts`):** `calculateSettlementWithCommission()` — 5% on gross winnings only (losses = no commission). `commissionAdjustedEV()` — pre-bet EV check: `netEV = p*(odds-1)*(1-rate) - (1-p)`. `getCommissionStats()` — all-time/month/week/today breakdown with effective rate computed against sum of positive gross wins. `getExchanges()` — lists all exchanges. Premium Charge warning at £20k+ (threshold £25k).

**Integration points:** Value detection (`valueDetection.ts`) skips bets with positive gross EV but negative net EV after commission. Potential profit in `paperTrading.ts` uses commission-adjusted calculation. Settlement paths track gross/net separately. Summary endpoint includes `totalGrossPnl`, `totalCommission`, `grossRoiPct`.

**Dashboard:** Overview shows "Net Profit" with gross/commission breakdown in subtitle. Performance page has Commission & Costs section with 4 stat cards, weekly/today breakdowns, exchange list with active indicators, and Premium Charge warning banners.