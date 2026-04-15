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
*   **Live Performance** (`/dashboard/performance`): P&L chart (cumulative, 90 days), league breakdown, market type breakdown, Tier 1 vs Tier 2 stats, execution quality panel, model health section.
*   **Experiment Lab** (`/dashboard/experiments`): Tier pipeline (experiment → candidate → promoted), Tier 1 qualification badges, progress bars, distance-to-promotion, manual promotion controls, tooltips for CLV/ROI/p-value.
*   **Agent Brain** (`/dashboard/agent-brain`): Learning narratives, self-generated insights.
*   **Audit Trail** (`/dashboard/compliance`): Compliance and transparency logs.

**Shared Components (layout.tsx):** `LiveTierBadge`, `InfoTooltip`, `BetStatusBadge`, `OddsSourceBadge`.

**Hooks (use-dashboard.ts):** `useSummary`, `useBets`, `usePerformance`, `useClvStats`, `useBetsByLeague`, `useBetsByMarket`, `useInPlayBets`, `useUpcomingBets`, `useExecutionMetrics`, `useLiveSummary`, `useAgentRecommendations`, `useModelHealth`, `useLiveTierStats`, `useExperiments`, `useRunPromotionEngine`, `useManualPromote`.

**API Endpoints consumed:** `/api/dashboard/summary`, `/api/dashboard/bets`, `/api/dashboard/performance`, `/api/dashboard/clv-stats`, `/api/dashboard/bets/by-league`, `/api/dashboard/bets/by-market`, `/api/dashboard/in-play`, `/api/dashboard/upcoming-bets`, `/api/dashboard/execution-metrics`, `/api/dashboard/live-summary`, `/api/dashboard/agent-recommendations`, `/api/admin/experiments`.