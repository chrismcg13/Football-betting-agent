# Phase 2 Sub-phase 7.x — AF metadata ingestion bundle (PLAN)

**Authored:** 2026-05-06.
**Strategic source:** `docs/PHASE 2 FULL PUSH — strategic inten.txt` sub-phase 7 endpoint list.
**Predecessor:** sub-phase 7.0a (`/injuries` ingestion, commit `bda4cbe`).

> Audit API-Football endpoints currently NOT ingested. Each new feature ships as its own sub-commit with retrospective predictive-power validation against existing settled bets. Features that show no genuine signal don't ship.

## Goal

Bundle the 4 remaining pure-AF endpoints (`/transfers`, `/coachs`, `/sidelined`, `/trophies`) into a single ingestion-only commit. Same pattern as 7.0a: schema + idempotent fetch + cron, no feature wiring. Retrospective predictive-power validation comes later (sub-phase 7.x.b) and decides which features ship.

## Scope — what's IN this commit

4 endpoints, 4 tables, 4 fetch functions, 2 orchestrators, 1 cron.

| Endpoint | Per-X | Storage | Cadence |
|---|---|---|---|
| `/transfers?team=N` | per team | `team_transfers` (one row per transfer event) | weekly, TTL-gated |
| `/coachs?team=N` | per team | `team_coaches` (one row per (team, coach, start)) | weekly, TTL-gated |
| `/sidelined?player=N` | per player | `player_sidelined` (one row per sideline period) | weekly, TTL-gated |
| `/trophies?player=N` or `coach=N` | per person | `player_trophies` (one row per trophy) | weekly, TTL-gated |

## Scope — what's NOT in this commit (deferred)

- **Weather** — different API source ("native or supplementary free API" per brief). Provider choice + budget design separate. Sub-phase 7.5 candidate.
- **Referees** — likely already in `/fixtures` enriched data or `/teams/statistics`; needs investigation, not new ingestion.
- **Lineup confirmation timing** — derivation from existing `capturePreKickoffLineups` (when row was inserted vs kickoff). Feature engineering, not ingestion.
- **Fixture congestion** — derivation; `computeDaysSinceLastMatch` already exists at featureEngine.ts:212. Feature engineering, not ingestion.
- **Feature wiring into prediction** — gated by 7.x.b retrospective validation.

## Schema (migrate.ts)

```sql
team_transfers (
  id, fetched_at, team_api_id, player_api_id, player_name,
  transfer_date, team_in_*, team_out_*, transfer_type
)
team_coaches (
  id, fetched_at, team_api_id, coach_api_id, coach_name,
  start_date, end_date, is_current
)
player_sidelined (
  id, fetched_at, player_api_id, player_name,
  sideline_type, start_date, end_date
)
player_trophies (
  id, fetched_at, person_api_id, person_type ∈ ('player','coach'),
  league, country, season, place
)
```

Indexes on the natural lookup keys: `(team_api_id, transfer_date DESC)`, `(team_api_id, is_current)`, `(player_api_id, start_date DESC)`, `(person_api_id, person_type)`.

## Idempotency

All 4 endpoints use **delete-by-natural-key + insert-snapshot** within a single fetch:
- `team_transfers`: delete by `team_api_id`, then insert all rows from response.
- `team_coaches`: delete by `team_api_id`, then insert all (team, coach, start) tuples filtered to the requested team's career entries.
- `player_sidelined`: delete by `player_api_id`, then insert all rows from response.
- `player_trophies`: delete by `(person_api_id, person_type)`, then insert all rows from response.

Same pattern as 7.0a's injury_reports.

## Orchestration

**Per-team orchestrator** (transfers + coaches):
- Seed: distinct `team_api_id` values from `_af_home_team_id` / `_af_away_team_id` features for fixtures kicking off in the next 7 days with placed bets.
- TTL-gate: skip if any row for that team was fetched < 6 days ago.

**Per-player orchestrator** (sidelined + trophies):
- Seed: distinct `player_api_id` from `injury_reports` rows fetched in last 30 days. Coverage grows organically as 7.0a injury data accumulates.
- TTL-gate: skip if any row for that player was fetched < 6 days ago.

## Cron

Single weekly cron at `0 7 * * 0` UTC (Sunday 07:00 UTC). Runs both orchestrators sequentially. Sits between Sunday 06:00 (injuries) and 08:00 (threshold proposal generator) — empty slot.

## API budget

- First cron run: ~50-100 teams × 2 endpoints + ~20-50 unique players × 2 endpoints = 150-300 calls.
- Steady state (TTL-skipped): ~50 calls/week.
- Trivial against 75k/day budget.

## Verification (post-deploy, after first Sunday firing)

```sql
SELECT 'team_transfers' AS tbl, COUNT(*) AS rows, COUNT(DISTINCT team_api_id) AS keys FROM team_transfers
UNION ALL SELECT 'team_coaches',     COUNT(*), COUNT(DISTINCT team_api_id) FROM team_coaches
UNION ALL SELECT 'player_sidelined', COUNT(*), COUNT(DISTINCT player_api_id) FROM player_sidelined
UNION ALL SELECT 'player_trophies',  COUNT(*), COUNT(DISTINCT person_api_id) FROM player_trophies;
```

Expect non-zero `rows` and `keys` for all 4 tables. Player tables coverage depends on `injury_reports` accumulation from 7.0a.

## Sub-commit 7.x.b (LATER, after 1-2 weeks of accumulation)

Retrospective predictive-power validation, mirrors 7.0b structure:

Candidate features (computed read-only against settled bets):
- **Transfers:** `home_transfers_in_last_30d`, `away_transfers_in_last_30d`, `transfers_diff`
- **Coaches:** `home_coach_tenure_days`, `away_coach_tenure_days`, `home_coach_changed_recently` (within 30d)
- **Sidelined:** `home_long_term_injuries_count`, `away_long_term_injuries_count` (filter to active sidelined periods)
- **Trophies:** `home_coach_trophy_count`, `away_coach_trophy_count` (proxy for elite-coach effect)

Ship-criterion (per feature): correlation magnitude ≥ 0.05 with 95% CI excluding zero, OR Kelly-growth subset effect ≥ 0.2 standardised. Each feature ships independently if it passes.

## Sub-commit 7.x.c (CONDITIONAL on 7.x.b)

Wire validated feature(s) into `featureEngine.computeFeaturesForMatch` + `predictionEngine`. Tier A canary diff for byte-identicality.

## Risk

| # | Risk | Mitigation |
|---|---|---|
| 1 | Endpoint shape drift (AF changes response format) | Per-endpoint try/catch in orchestrator; a single broken endpoint doesn't block the others. |
| 2 | Per-player query coverage limited by injury_reports growth | Acceptable — 7.0a started accumulating 6h ago; player coverage broadens over weeks. Out-of-band team-roster ingestion is a future expansion. |
| 3 | TTL-skip miscalibration causes redundant API calls | 6-day TTL with weekly cron leaves 1-day slack; explicit `MAX(fetched_at)` lookup before each call. |
| 4 | Single-revert blast radius (4 endpoints in one commit) | All 4 are ingestion-only — zero behaviour change in betting. Revert removes them all but doesn't damage existing data. |

## Wall-clock

- 7.x: ~2.5h implementation + verification. (THIS COMMIT)
- 7.x.b: ~2-3h after data accumulates.
- 7.x.c: conditional on 7.x.b verdict.

## Quick-revert

Code revert. Tables can stay (idempotent CREATE TABLE IF NOT EXISTS). No betting behaviour change → no rollback complexity.

## What this sub-phase does NOT do

- Does not modify settlement, prediction, or betting paths.
- Does not bundle weather/referees/derivations.
- Does not pre-judge feature shipping — gated by 7.x.b retrospective.
- Does not extend `capturePreKickoffLineups` to store player IDs (deferred — current player-id seed via injury_reports is sufficient for 7.x.b validation).
