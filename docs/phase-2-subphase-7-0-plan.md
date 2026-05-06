# Phase 2 Sub-phase 7.0 — `/injuries` ingestion + feature (PLAN)

**Authored:** 2026-05-06.
**Strategic source:** `docs/PHASE 2 FULL PUSH — strategic inten.txt` sub-phase 7.
**Roadmap entry:** `docs/phase-2-execution-roadmap.md` Wave 3 #2 / Wave 4 #2.

> Audit API-Football endpoints currently NOT ingested. /injuries first per brief. Add ingestion + feature: "key player injury impact." Each new feature ships as its own sub-commit with retrospective predictive-power validation against existing settled bets. Features that show no genuine signal don't ship.

## Goal

Make team-injury data queryable per fixture, validate predictive power against settled bets, ship a "key-injury impact" feature only if a signal exists. Three independent sub-commits.

## Sub-commit 7.0a — schema + prospective ingestion (NOW)

### Schema (migrate.ts)

```sql
CREATE TABLE injury_reports (
  id SERIAL PRIMARY KEY,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  api_fixture_id INTEGER NOT NULL,
  match_id INTEGER REFERENCES matches(id),
  team_api_id INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  player_api_id INTEGER,
  player_name TEXT NOT NULL,
  injury_type TEXT NOT NULL,         -- 'Missing Fixture' | 'Questionable'
  injury_reason TEXT,
  CHECK (injury_type IN ('Missing Fixture','Questionable'))
);
CREATE INDEX injury_reports_fixture_team_idx ON injury_reports(api_fixture_id, team_api_id);
CREATE INDEX injury_reports_match_idx ON injury_reports(match_id) WHERE match_id IS NOT NULL;
```

### Code (apiFootball.ts)

- `fetchAndStoreInjuriesForFixture(apiFixtureId, matchId)` — calls `/injuries?fixture=<id>`, idempotent **delete-then-insert** per `api_fixture_id` (so a player who has recovered between fetches no longer appears in the latest snapshot).
- `fetchInjuriesForUpcomingMatches()` — orchestrator selecting `paper_bets.status='pending'` + `matches.kickoff_time` in the next 24h with non-null `api_fixture_id`. Per-call budget gate via `canMakeRequest()`.

### Cron (scheduler.ts)

- Daily at `0 6 * * *` UTC. Sits before European morning kickoffs and after most overnight settlements have flowed.

### Verification

48-72h post-deploy, expect non-zero rows:
```sql
SELECT COUNT(*) AS rows, COUNT(DISTINCT api_fixture_id) AS fixtures FROM injury_reports;
```
Zero feature wiring → zero behaviour change in betting.

### Quick-revert

Code revert. Table can stay (idempotent CREATE TABLE IF NOT EXISTS).

---

## Sub-commit 7.0b — historical backfill + retrospective predictive-power validation (LATER, after 3+ days of forward data)

After 7.0a has been live ≥3 days:

### Backfill

For each settled `paper_bet` (post-2026-05-03 to limit API spend), call `/injuries?fixture=<id>` once. ~100-200 API calls total at current scale.

### Candidate feature definitions

- `home_injuries_missing_count`, `away_injuries_missing_count`
- `home_key_injuries_missing_count`, `away_key_injuries_missing_count` — "key" defined as `player_api_id` appearing in lineup_capture data for that team's last 5 fixtures (proxy for regular starter)
- `injuries_diff` = `home_missing − away_missing`

### Predictive-power test

For each settled bet, attach injury features at placement-time. Compute correlation with:
- (a) bet outcome (won/lost)
- (b) per-unit return `r_i = settlement_pnl / stake` (or shadow_* for shadow bets)
- (c) Kelly-growth contribution `g_i = ln(max(0.001, 1 + kelly_fraction × r_i))`

Significance test: bootstrap CI on the correlation.

### Ship-criterion (must clear at least one):

- Correlation magnitude ≥ 0.05 with 95% CI excluding zero, OR
- ROI / Kelly-growth difference between high-injury vs low-injury subsets with effect size ≥ 0.2 standardised.

### Output

- New admin endpoint `POST /admin/run-injury-feature-retrospective` returning per-feature verdict + n + correlation + CI.
- Findings documented in `docs/phase-2-subphase-7-0-retrospective-findings.md`.

### Decision gate

- Any feature passes → proceed to 7.0c.
- None pass → close 7.0 with no live wiring; document and move to next AF endpoint.

### Quick-revert

Code revert removes endpoint and validation function. Backfilled data persists harmlessly.

---

## Sub-commit 7.0c — wire winning feature(s) into prediction (CONDITIONAL on 7.0b verdict)

Only ships if 7.0b shows signal.

- Add validated feature(s) to `featureEngine.computeFeaturesForMatch` — read from `injury_reports` joined to fixture.
- Add to `predictionEngine` consumption path (matching pattern of existing AF features like team-stats).
- Pre-deploy canary: snapshot 24h of model outputs pre-deploy, post-deploy diff. Tier-A behaviour byte-identical.

### Quick-revert

Code revert (removes from featureEngine + predictionEngine; `injury_reports` rows remain harmlessly).

---

## Cross-cutting

### API budget impact

~50-100 calls/day at current scale. Well within 75k/day budget.

### Autonomy / approval

- Feature engineering is in the model's autonomy envelope (per strategic brief line 53).
- Retrospective decision-gate is data-driven, not user-approval-gated.
- Schema change in 7.0a IS user-approval-gated (per strategic brief CONTINUOUS REQUIREMENTS) — addressed by this plan-mode doc.

### Cross-wave invariants reaffirmed

- Tier A behaviour byte-identical (no feature wiring in 7.0a).
- Correlation + duplicate-bet rejection unchanged.
- £0 experiment-track stake unchanged.
- Risk controls unchanged.
- Every autonomous decision logs to `model_decision_audit_log` (no autonomous decisions in 7.0a — pure ingestion).

## Wall-clock

- 7.0a: ~1.5h implementation + verification. (THIS COMMIT)
- 7.0b: ~2-3h after 3+ days forward data accumulated.
- 7.0c: ~1h conditional on 7.0b verdict.

## What this sub-phase does NOT do

- Does not modify settlement logic.
- Does not modify prediction engine in 7.0a (only conditional in 7.0c).
- Does not bundle other AF endpoints (`/transfers`, `/coachs`, etc.) — each is a separate sub-phase.
- Does not pre-judge whether the feature will ship — verdict comes from 7.0b's retrospective.
