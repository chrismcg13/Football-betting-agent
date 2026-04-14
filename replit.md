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
*   **League Coverage:** Tracks 39 leagues across five tiers, with dynamic season logic adjustments. A discovery bonus mechanism encourages initial betting in new leagues to gather data.
*   **xG Intelligence:** Integrates Expected Goals (xG) data, derived from the internal feature engine, to inform predictions and team performance analysis.
*   **Risk Management:** Implements circuit breakers (daily/weekly loss limits), a bankroll floor, cold market filtering, and hot-streak detection to safeguard the simulated bankroll.
*   **Experiment Pipeline:** A robust system to manage betting strategies through experiment, candidate, and promoted tiers, with statistical evidence driving progression. This includes schema extensions for `paper_bets`, new tables (`experiment_registry`, `promotion_audit_log`, `experiment_learning_journal`), and a daily promotion engine. Candidate bets use reduced stakes, and in production, only promoted strategies are allowed to place bets.
*   **Settlement Architecture:** A comprehensive pipeline for syncing match results, settling paper bets, and backfilling missing statistics, supporting various market types and handling void bets.
*   **Environment Isolation:** Strict separation of development and production databases, with a controlled synchronization mechanism for promoted strategies.
*   **Startup Process:** Automated database migrations and agent configuration seeding on server startup.

## External Dependencies

*   **Betfair Exchange Delayed API:** Used for paper-trading football bets.
*   **API-Football v3 (via RapidAPI):** Primary source for real odds, match results, team statistics (yellow cards, corners, shots), and fixture data. Budget usage is tracked.
*   **PostgreSQL:** The primary database for all application data.
*   **OddsPapi:** Used for bulk prefetching and refreshing Pinnacle odds, with budget tracking and coverage reporting.
*   **football-data.org:** (DISABLED) Previously used for data ingestion; now replaced by API-Football v3.
*   **StatsBomb/Fotmob:** (Implicitly via internal feature engine) Data sources for Expected Goals (xG) which are then processed by the internal feature engine.