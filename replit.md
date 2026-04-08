# Workspace

## Overview

pnpm workspace monorepo using TypeScript. This is an AI betting agent that paper-trades football bets using the Betfair Exchange Delayed API.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Database Schema (lib/db/src/schema/)

All tables for the AI betting agent:

1. **matches** — Football matches with team names, league, kickoff time, scores, Betfair event ID
2. **odds_snapshots** — Market odds snapshots from Betfair delayed API (back/lay odds)
3. **features** — Computed ML features per match (team form, H2H stats, etc.)
4. **paper_bets** — Simulated bets with edge calculation, model probability, settlement tracking
5. **model_state** — Versioned model snapshots with accuracy, calibration, feature importances
6. **learning_narratives** — AI-generated narratives about strategy shifts and model improvements
7. **compliance_logs** — Full audit trail of all agent decisions and actions
8. **agent_config** — Runtime configuration (bankroll, stake limits, edge thresholds, status)

## Agent Config Defaults

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

## API Routes

All routes are under `/api/`:

- `GET/PUT /agent-config` — read and update agent configuration
- `GET/POST/PATCH /matches` — match management
- `GET/POST /paper-bets`, `PATCH /paper-bets/:id/settle` — bet placement and settlement
- `GET/POST /odds-snapshots` — odds data ingestion
- `GET/POST /features` — ML feature storage (metadata features prefixed `_` are hidden from GET)
- `POST /features/compute` — manually trigger feature computation for all upcoming matches
- `GET/POST /model-state`, `GET /model-state/latest` — model versioning
- `GET/POST /learning-narratives` — agent learning log
- `GET/POST /compliance-logs` — compliance audit trail
- `POST /ingestion/run` — manually trigger data ingestion
- `GET /healthz` — health check

## Scheduler

Two scheduled jobs run automatically:

| Job | Schedule | Description |
|-----|----------|-------------|
| Data ingestion | Every 30 min, 06:00–23:30 UTC | Fetches matches from football-data.org (or Betfair) |
| Feature computation | Every 6 hours UTC | Computes all 12 ML features for upcoming matches |

Both jobs are guarded against concurrent runs (skip-if-busy).

## Feature Engine (`src/services/featureEngine.ts`)

Computes 12 ML features per upcoming match using football-data.org team history APIs:

| Feature | Description |
|---------|-------------|
| `home_form_last5` | Home team win rate over last 5 home games |
| `away_form_last5` | Away team win rate over last 5 away games |
| `home_goals_scored_avg` | Home team avg goals scored (last 10 home) |
| `home_goals_conceded_avg` | Home team avg goals conceded (last 10 home) |
| `away_goals_scored_avg` | Away team avg goals scored (last 10 away) |
| `away_goals_conceded_avg` | Away team avg goals conceded (last 10 away) |
| `home_btts_rate` | Both-teams-to-score rate in home team's last 10 home matches |
| `away_btts_rate` | Both-teams-to-score rate in away team's last 10 away matches |
| `home_over25_rate` | Over 2.5 goals rate in home team's last 10 home matches |
| `away_over25_rate` | Over 2.5 goals rate in away team's last 10 away matches |
| `h2h_home_win_rate` | Home win rate in last 5 H2H meetings |
| `league_position_diff` | (away rank − home rank) / total teams, normalised |

Prerequisites: Ingestion must run at least once so team IDs are stored (as `_home_team_id` / `_away_team_id` metadata features) before the feature engine can run.

API calls are sequential (not parallel) to respect the 10 req/min rate limit.

## Data Sources

The system supports two data sources, controlled by the `data_source` key in `agent_config`:

| Value | Description |
|-------|-------------|
| `football_data_fallback` | Uses football-data.org API (default — works from any region) |
| `betfair` | Uses Betfair Exchange Delayed API (requires UK/EU IP — geo-blocked on Replit) |

When `data_source=betfair`, the system tries Betfair first and automatically falls back to football-data.org if a geographic error occurs.

### football-data.org Service (`src/services/footballData.ts`)
- Tracks 11 competitions: PL, BL1, SA, PD, FL1, CL, EL, EC, WC, PPL, BSA
- Fetches matches for next 7 days
- Maps odds (where available) to `MATCH_ODDS` market snapshots
- Guards against TBD matches (null team objects from upcoming fixtures)
- Event IDs prefixed with `fd_` to avoid collision with Betfair IDs

### Betfair Service (`src/services/betfair.ts`)
- Rate-limited to 5 req/s
- Session auto-refreshes on 401/403
- 7 market types: MATCH_ODDS, OVER_UNDER_25/15/35, BTTS, CORRECT_SCORE, ASIAN_HANDICAP

## Startup

On startup (`src/index.ts`), the server runs `runMigrations()` (idempotent `CREATE TABLE IF NOT EXISTS`) before starting Express. Agent config is seeded with `ON CONFLICT (key) DO NOTHING` so defaults are only written once.
