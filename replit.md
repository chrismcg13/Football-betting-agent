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
- `GET/POST /features` — ML feature storage
- `GET/POST /model-state`, `GET /model-state/latest` — model versioning
- `GET/POST /learning-narratives` — agent learning log
- `GET/POST /compliance-logs` — compliance audit trail
- `GET /healthz` — health check

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
