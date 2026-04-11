# Workspace

## Overview

pnpm workspace monorepo using TypeScript. This is an AI betting agent that paper-trades football bets using the Betfair Exchange Delayed API and API-Football v3 for real odds.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Database Schema (lib/db/src/schema/)

All tables for the AI betting agent:

1. **matches** — Football matches with team names, league, kickoff time, scores, Betfair event ID
2. **odds_snapshots** — Market odds snapshots from all bookmakers (back/lay odds)
3. **features** — Computed ML features per match (team form, H2H stats, API-Football extras, market consensus/spread)
4. **paper_bets** — Simulated bets with edge, model probability, odds source, settlement tracking
5. **model_state** — Versioned model snapshots with accuracy, calibration, feature importances
6. **learning_narratives** — AI-generated narratives about strategy shifts and model improvements
7. **compliance_logs** — Full audit trail of all agent decisions and actions (including line movements)
8. **agent_config** — Runtime configuration (bankroll, stake limits, edge thresholds, status, diversity rules)
9. **api_usage** — Daily API-Football request budget tracker (cap: 75,000 req/day)
10. **oddspapi_fixture_map** — Maps internal match IDs to OddsPapi fixture IDs for Pinnacle validation
11. **league_edge_scores** — Dynamic league+market edge confidence scores (seeded, updated by learning loop)
12. **oddspapi_league_coverage** — Cache of which leagues OddsPapi covers (avoids wasted requests)
13. **xg_match_data** — Expected goals data from StatsBomb/Fotmob (ingested daily)
14. **team_xg_rolling** — Rolling xG averages per team (used as ML features)
15. **odds_history** — Per-bookmaker odds snapshots with line movement tracking (>5% triggers compliance log)

## Agent Config Defaults (21 keys)

| Key | Default |
|-----|---------|
| bankroll | 500 |
| max_stake_pct | 0.02 |
| daily_loss_limit_pct | 0.05 |
| weekly_loss_limit_pct | 0.10 |
| bankroll_floor | 200 |
| max_concurrent_bets | 10 |
| min_edge_threshold | 0.03 |
| agent_status | running |
| opportunity_score_threshold | 65 |
| max_bets_per_cycle | 5 |
| max_bets_per_league | 2 |
| max_bets_per_market | 2 |
| cold_market_min_volume | 100 |
| hot_streak_window | 10 |
| hot_streak_win_rate | 0.70 |
| odds_sweet_spot_min | 1.9 |
| odds_sweet_spot_max | 3.2 |
| synthetic_odds_score_cap | 55 |
| cards_corners_kelly_multiplier | 0.7 |
| api_football_daily_budget | 75000 |
| data_source | football_data_fallback |

## API Routes

All routes are under `/api/`:

- `GET/PUT /agent-config` — read and update agent configuration
- `GET/POST/PATCH /matches` — match management
- `GET/POST /paper-bets`, `PATCH /paper-bets/:id/settle` — bet placement and settlement
- `GET/POST /odds-snapshots` — odds data ingestion
- `GET/POST /features` — ML feature storage
- `POST /features/compute` — manually trigger feature computation
- `GET /predictions/status`, `GET /predictions/:matchId` — ML predictions
- `POST /predictions/bootstrap`, `/retrain`, `/load` — model management
- `GET /value-bets` — detect value bets (compliance-logged)
- `GET/POST /model-state`, `GET /model-state/latest` — model versioning
- `GET/POST /learning-narratives` — agent learning log
- `GET/POST /compliance-logs` — compliance audit trail
- `POST /ingestion/run` — manually trigger data ingestion
- `POST /features/run` — manually trigger feature computation
- `POST /trading/run` — manually trigger trading cycle
- `GET /dashboard/summary` — dashboard KPIs
- `GET /dashboard/performance` — performance chart data
- `GET /dashboard/bets` — paginated bet history (with oddsSource)
- `GET /dashboard/bets/by-league` — bets grouped by league
- `GET /dashboard/bets/by-market` — bets grouped by market
- `GET /dashboard/viability` — opportunity pipeline
- `GET /dashboard/model` — model metrics
- `GET /dashboard/narratives` — learning narratives
- `GET /dashboard/api-budget` — API-Football daily quota status
- `POST /odds/fetch` — manually trigger API-Football odds ingestion
- `POST /agent/control` — start/pause/stop agent
- `GET /healthz` — health check

## Market Types

| Market | Description | Model |
|--------|-------------|-------|
| MATCH_ODDS | 1X2 outcome | Logistic Regression |
| BTTS | Both teams to score | Logistic Regression |
| OVER_UNDER_05 | Over/under 0.5 goals | Poisson |
| OVER_UNDER_15 | Over/under 1.5 goals | Poisson |
| OVER_UNDER_25 | Over/under 2.5 goals | Logistic Regression |
| OVER_UNDER_35 | Over/under 3.5 goals | Poisson |
| OVER_UNDER_45 | Over/under 4.5 goals | Poisson |
| DOUBLE_CHANCE | 1X / X2 / 12 | Derived from outcome probs |
| FIRST_HALF_RESULT | HT 1X2 | Scaled from full-match probs |
| FIRST_HALF_OU_05 | HT over/under 0.5 | Poisson (half-lambda) |
| FIRST_HALF_OU_15 | HT over/under 1.5 | Poisson (half-lambda) |
| ASIAN_HANDICAP | AH lines | Pass-through (real odds only) |
| TOTAL_CARDS_35 | Total cards > 3.5 | Poisson heuristic |
| TOTAL_CARDS_45 | Total cards > 4.5 | Poisson heuristic |
| TOTAL_CARDS_25 | Total cards > 2.5 | Poisson heuristic |
| TOTAL_CARDS_55 | Total cards > 5.5 | Poisson heuristic |
| TOTAL_CORNERS_85 | Total corners > 8.5 | Poisson heuristic |
| TOTAL_CORNERS_95 | Total corners > 9.5 | Poisson heuristic |
| TOTAL_CORNERS_105 | Total corners > 10.5 | Poisson heuristic |
| TOTAL_CORNERS_115 | Total corners > 11.5 | Poisson heuristic |

Cards/corners models use a 0.7× Kelly multiplier until sufficient settled data accumulates.

## Opportunity Scoring System (valueDetection.ts)

5-component score (0–100), threshold: **65**. Synthetic odds hard-capped at **55** (blocks them from being placed):

| Component | Weight | Description |
|-----------|--------|-------------|
| Edge component | 30 | Model edge vs implied probability |
| Confidence | 20 | Model confidence (distance from 0.5) |
| Odds sweet spot | 20 | Bonus for odds 1.9–3.2 |
| Market quality | 15 | Volume/liquidity |
| Form alignment | 15 | Hot/cold streak detection |

Real odds (Bet365/Bwin/1xBet via API-Football) required to score above 65. Synthetic odds score ≤ 55.

## Kelly Staking Tiers

| Score | Fraction | Use case |
|-------|----------|----------|
| 88+ | 1/2 Kelly | Very high confidence |
| 80–88 | 3/8 Kelly | High confidence |
| 72–80 | 1/4 Kelly | Standard |
| 65–72 | 1/8 Kelly | Conservative |

Cards/corners: all tiers multiplied by 0.7×.

## Diversity Rules (Scheduler)

Per trading cycle:
- Max **5 bets** total
- Max **2 bets** per league
- Max **2 bets** per market type

## Prediction Engine (src/services/predictionEngine.ts)

Three logistic regression models trained via one-vs-all, bootstrapped from historical season data. Cards/corners use Poisson heuristics until bet data accumulates.

**Bootstrap training**: Fetches last season's finished matches, computes rolling features, trains models, stores weights in `model_state`.

**Auto-load on startup**: Server loads latest model from DB at boot.

**Retraining**: After every 20 new settled paper bets, `retrainIfNeeded()` rebuilds all 3 LR models.

**Hyperparameters**: 500 gradient steps, learning rate 0.005.

## API-Football Integration (src/services/apiFootball.ts)

- **Budget**: 75,000 req/day cap tracked in `api_usage` table (previously 90/day)
- **Fixture mapping**: Discovers upcoming matches (7-day window) and fuzzy-matches team names
- **Real odds**: Fetches ALL bookmakers (20+) for upcoming fixtures in a single API call every 2h
- **Team stats**: Fetches yellow cards avg, corners avg, shots stats (every 12h)
- **Budget endpoint**: `GET /api/dashboard/api-budget` → `{used, cap:75000, remaining, date}`
- **Freshness**: 2-hour odds freshness window (skip if fetched within 2h)
- **Source format**: `api_football_real:${bookmakerName}` (e.g. `api_football_real:Bet365`)

## Feature Engine (src/services/featureEngine.ts)

Computes 17 ML features per upcoming match:

| Feature | Description |
|---------|-------------|
| `home_form_last5` | Home team win rate over last 5 home games |
| `away_form_last5` | Away team win rate over last 5 away games |
| `home_goals_scored_avg` | Home team avg goals scored (last 10 home) |
| `home_goals_conceded_avg` | Home team avg goals conceded (last 10 home) |
| `away_goals_scored_avg` | Away team avg goals scored (last 10 away) |
| `away_goals_conceded_avg` | Away team avg goals conceded (last 10 away) |
| `home_btts_rate` | BTTS rate in home team's last 10 home matches |
| `away_btts_rate` | BTTS rate in away team's last 10 away matches |
| `home_over25_rate` | Over 2.5 rate in home team's last 10 home matches |
| `away_over25_rate` | Over 2.5 rate in away team's last 10 away matches |
| `h2h_home_win_rate` | Home win rate in last 5 H2H meetings |
| `league_position_diff` | (away rank − home rank) / total teams |
| `home_yellow_cards_avg` | Home team avg yellow cards (API-Football) |
| `away_yellow_cards_avg` | Away team avg yellow cards (API-Football) |
| `corners_avg` | Combined corners average |
| `shots_on_target_avg` | Avg shots on target |
| `goal_momentum` | Recent scoring trend |

## Scheduler (src/services/scheduler.ts)

| Job | Schedule | Description |
|-----|----------|-------------|
| Data ingestion | Every 30 min, 24/7 | Fetches upcoming matches from football-data.org (7-day window) |
| Feature computation | Every 6 hours UTC | Computes all ML features |
| Trading cycle | Every 10 minutes | Detects value bets, places paper bets |
| Settlement | Every 5 minutes | Syncs match results from API-Football, then settles pending bets |
| API-Football odds | Every 2 hours, 24/7 | ALL bookmakers (20+) in single call, 2h freshness window |
| OddsPapi Pinnacle | Every 10 min (trading) | Top-8 fixtures ≤48h only, skips 2nd-div leagues, capped 7/day |
| API-Football team stats | Every 12 hours UTC | Fetches cards/corners/shots stats |
| Learning loop | Daily at 03:00 UTC | Generates narratives, retrains model |
| xG ingestion | Daily at 05:00 UTC | Derives team xG rolling stats from internal feature engine |

## Line Movement Tracking (src/services/lineMovement.ts)

- Detects significant odds changes (>5% threshold) per bookmaker per selection
- Stores history in `odds_history` table (per-bookmaker snapshots)
- Categorizes as "shortening" (odds decreasing) or "drifting" (odds increasing)
- Hours to kickoff recorded for each movement
- Dashboard: `GET /api/dashboard/line-movements` → last 50 significant movements
- Compliance log: `line_movement` action type for every significant shift

## League Edge Scores (src/services/valueDetection.ts)

18 leagues seeded with edge scores in `league_edge_scores` table:

| Tier | Score | Leagues |
|------|-------|---------|
| 85 | Premier League, Bundesliga, La Liga, Serie A, Ligue 1 | Top-5 |
| 82 | Ligue 2, 2. Bundesliga, Scottish Premiership | Tier 2 |
| 80 | Primeira Liga | |
| 75 | Championship | |
| 72 | Belgian Pro League, Swiss Super League | |
| 70 | Eredivisie, MLS, Nordic leagues | |
| 65 | J-League, K League | |

Bonus in opportunity score: `(leagueEdgeScore - 50) / 5`, capped ±10 points.

## New Dashboard Endpoints

- `GET /api/dashboard/scan-stats` — `{leaguesActive, fixturesUpcoming, marketsPerFixture, lineMovementsToday, budgetUsedToday, budgetCap}`
- `GET /api/dashboard/line-movements` — Last 50 significant line movements with direction and hours to KO

## xG Intelligence Layer

Sourced from the **internal feature engine** (not Understat — their HTML no longer embeds data):
- `home_xg_proxy` and `away_xg_proxy` features computed for every upcoming fixture in the `features` table
- `xgIngestionService.ts` reads these features, populates `xg_match_data` and `team_xg_rolling`
- Dashboard widget: sortable table of top teams by xG Diff (5-match rolling), Goals vs xG, Momentum
- Trigger manually: `POST /api/xg/refresh`
- View data: `GET /api/xg/teams`
- Populated: 131+ teams across Premier League, Bundesliga, La Liga, Serie A, Ligue 1, etc.

## Risk Management

- **Circuit breakers**: Daily and weekly loss limits halt the agent automatically
- **Bankroll floor**: Agent stops at minimum bankroll (£200 default)
- **Cold market filtering**: Skips markets with insufficient volume
- **Hot-streak detection**: Adjusts confidence scoring based on recent performance
- **Diversity rules**: Prevents concentration risk across leagues/markets

## Dashboard (artifacts/dashboard)

React + Vite SPA at `/dashboard/`:

- **Overview** — Bankroll, P&L, ROI, win rate, cumulative chart
- **Bet History** — Paginated bet log with odds source badges (Bet365/Bwin/1xBet/Synthetic), status, edge, score
- **Performance** — Daily P&L charts, market breakdowns
- **Viability** — Opportunity pipeline, upcoming markets
- **Learning & Model** — Model accuracy, narratives, feature importances
- **Compliance** — Audit trail
- **Sidebar** — API Budget progress bar (0/90 requests), agent controls, bankroll

## Data Sources

| Value | Description |
|-------|-------------|
| `football_data_fallback` | Uses football-data.org API (DISABLED — account suspended Apr 2026) |
| `betfair` | Uses Betfair Exchange Delayed API (geo-blocked on Replit) |
| `api_football_real` | API-Football v3 via RapidAPI — primary source for odds + match results |

Real odds for value scoring come from API-Football v3 (key: `API_FOOTBALL_KEY` secret).

**Note**: football-data.org API account is disabled. Match result syncing now uses API-Football `/fixtures` endpoint. Settlement flow: `syncMatchResults()` (API-Football) → `settleBets()` (paperTrading).

## Settlement Architecture

- `syncMatchResults()` in `scheduler.ts`: Fetches finished fixtures from API-Football for last 7 days, matches to DB matches via fuzzy team name matching (`teamNameMatch`), updates status='finished' with scores.
- `determineBetWon()` in `paperTrading.ts`: Handles MATCH_ODDS, BTTS, DOUBLE_CHANCE (1X/X2/12), OVER_UNDER_05/15/25/35/45, ASIAN_HANDICAP. Returns `null` (void/refund) for TOTAL_CORNERS_*, TOTAL_CARDS_*, FIRST_HALF_RESULT (data not available in match score).
- Bankroll updated at settlement time only (not deducted at placement). Void bets = PnL 0 (stake refunded implicitly).

## Startup

On startup (`src/index.ts`), the server runs `runMigrations()` (idempotent `CREATE TABLE IF NOT EXISTS`) before starting Express. Agent config is seeded with `ON CONFLICT (key) DO NOTHING` so defaults are only written once.
