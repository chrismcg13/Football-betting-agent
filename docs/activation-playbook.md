# Phase 2 Inversion — Activation Playbook

> **One DB UPDATE flips the inversion pipeline on.** This doc covers the
> pre-flight checks, the flip itself, what to watch for the first 24h,
> and the rollback procedure if anything goes sideways.

---

## 0. Pre-flight — DO NOT SKIP

Run each query. Don't proceed if any returns unexpected results.

### 0.1 — Model is loaded and producing predictions

```sql
-- Recent bets show non-null opportunity_score → predictions firing
SELECT COUNT(*) AS recent_bets, AVG(opportunity_score) AS avg_score
FROM paper_bets
WHERE placed_at >= NOW() - INTERVAL '30 minutes'
  AND opportunity_score IS NOT NULL;
```
Expected: `recent_bets > 0` and `avg_score > 30`. Anything else means the
model isn't loading — fix that first.

### 0.2 — Stage 0 watch-priority is computing

```sql
SELECT tier, COUNT(*) AS n
FROM (
  SELECT DISTINCT ON (fixture_id, market_type) tier
  FROM watch_priority_history
  WHERE computed_at >= NOW() - INTERVAL '15 minutes'
  ORDER BY fixture_id, market_type, computed_at DESC
) latest
GROUP BY tier ORDER BY tier;
```
Expected: 4 tiers populated with sensible counts (e.g. T1: 100-500,
T3: bulk). T4 empty is expected (CLV-yield neutral default).

### 0.3 — Stage 1 watchlist is emitting

```bash
curl -s -X POST http://localhost:8080/api/admin/run-stage1-watchlist \
  | python3 -m json.tool
```
Expected: `candidates_emitted > 0`, `errors: 0`, mix across `liquidity`
/ `kickoff_window` / `mover` sources.

### 0.4 — Mean-bias view has data (for the bias-correction step)

```sql
SELECT market_type, n,
       ROUND(mean_bias::numeric, 4) AS bias,
       ROUND(model_se::numeric, 4) AS se
FROM v_market_type_mean_bias_rolling
WHERE n >= 30
ORDER BY n DESC;
```
Expected: at least ASIAN_HANDICAP row with `n >= 30`. Other markets
may not have reached the threshold — that's OK; gate falls back to
neutral defaults.

### 0.5 — Slippage view populated

```sql
SELECT market_type, ttk_bucket, n,
       ROUND(p75_slippage::numeric, 4) AS p75
FROM v_slippage_p75_rolling
ORDER BY n DESC;
```
Expected: at least one (market × ttk) cell with `n >= 30`. Cells
below threshold fall back to market-aggregate, then 1.5pp default.

### 0.6 — R1 invariant test passes

```bash
curl -s -X POST http://localhost:8080/api/admin/run-watch-priority-tests \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('passed' if d['summary']['failed']==0 else 'FAILED')"
```
Expected: `passed`. The "model can only raise priority" rule is
verified on deployed code.

### 0.7 — Dry-run on recent shadow telemetry

```bash
curl -s -X POST http://localhost:8080/api/admin/inversion-dry-run \
  -H "Content-Type: application/json" \
  -d '{"sampleSize": 50}' \
  | python3 -m json.tool
```
Expected: `would_have_placed` count, distribution of gate decisions
(PROCEED / DOWN_SIZE_HALF / DEMOTE_SHADOW / VETO), top reasons. Use
this to gut-check what activation will look like.

---

## 1. The flip

Once 0.1-0.7 are green:

```sql
-- Activate the inversion pipeline (atomic, reversible)
INSERT INTO agent_config (key, value)
VALUES ('inversion_pipeline_enabled', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

That's it. Atomic. Reversible.

**Bundle 10 (2026-05-17) — live placement is restricted to the 3-7pp
post-slip sweet spot.** Bundle 9 retrospective on 4,511 settled bets
proved 3-7pp is the only Pinnacle-edge bracket with positive ROI
(+200% on n=48). 7-15pp lost −37%, 15-50pp lost −31%, >50pp is
synthetic-Pinnacle artifact territory. To protect capital while data
accumulates on the wider band, Stage 3 demotes-to-shadow ANY candidate
whose post-slip edge exceeds `inversion_live_max_edge_pp` (default
7.0). The shadow track still records these for future analysis.

**Bundle 11 (2026-05-17) — live-at-placement Pinnacle + Betfair
freshness.** Chris's clarification: "Pinnacle odds of 3-7pp [edge]
must be valid at the point of bet placement and the odds Betfair is
giving." Two config knobs cap the age of any sharp anchor or
executable price used by the gate:

- `pinnacle_max_age_seconds` (default 180s = 3 min)
- `betfair_odds_max_age_seconds` (default 180s)

Three call sites enforce: paperTrading.ts Pinnacle DB fallback
(stale rows ignored), pre-gate Pinnacle-coverage prefilter (skip the
gate entirely when no fresh Pinnacle — saves cycles + log noise +
force-shadow demotes when inversion pipeline is active), and the
lazy promoter (both Pinnacle and Betfair freshness windows, plus the
stored-odds fallback REMOVED — promotion now requires a live Betfair
best-back). New compliance log action_type
`inversion_skipped_no_fresh_pinnacle` exposes coverage gaps.

Widen the ceiling as confidence grows:

```sql
-- Once 7-15pp has accumulated 100+ settled bets and ROI is positive
UPDATE agent_config SET value = '15.0' WHERE key = 'inversion_live_max_edge_pp';
```

What activates the instant the flag flips:
- The 0.02 single-bet cap is bypassed; Bundle 5.M exposure caps apply
  (per-fixture 5%, per-league 15%, daily 8% — auto-scaled by Bundle
  7.E bankroll tiers).
- Bundle 7.C gates bypass for sharp-anchored candidates: 6 upstream
  gates (per-cycle, per-league, per-market caps; disabled markets;
  disabled leagues; min_opportunity_score; min_edge_threshold;
  shadow_min_opportunity_score).
- Bundle 7.D `prioritiseAndAllocate` becomes the trading cron's
  allocator (sorts by post_slippage_edge_pp DESC, opp_score DESC).
- Bundle 5.J multi-sharp Kelly tiering applies: 1 sharp = 0.5×,
  2 = 1.0×, 3 = 1.0× + HIGH_CONVICTION flag.
- Bundle 5.K high-edge integrity check fires on ≥7pp candidates.
- Bundle 5.L CLV circuit breaker pauses any market_type with rolling
  100-bet stake-weighted CLV < 0.

What stays the same:
- `live_placement_enabled` kill switch still gates real-money
  placement; flip that separately when ready.
- Daily / weekly drawdown limits, 7-loss halt, £2 Betfair min stake.
- The Stage 0 watch-priority cron (it was always producing scores,
  just not consuming them).

---

## 2. First 24h — what to watch

### 2.1 — Bet flow (every 15 min initially)

```sql
SELECT
  date_trunc('hour', placed_at) AS hour,
  bet_track, candidate_track,
  COUNT(*) AS n,
  ROUND(SUM(stake)::numeric, 2) AS staked,
  ROUND(AVG(opportunity_score)::numeric, 1) AS avg_score
FROM paper_bets
WHERE placed_at >= NOW() - INTERVAL '24 hours'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;
```

Watch for:
- `bet_track='live'` rows appearing post-flip with `candidate_track='sharp_anchored'`
  — expected behaviour
- Live bets on `candidate_track='model_only'` — **shouldn't happen**;
  model-only retains its gates and stays shadow
- Daily stake totals — should approach but not exceed `daily_stake_cap_pct`
  × bankroll

### 2.2 — Inversion gate shadow telemetry (1-hour window)

```sql
SELECT details->>'gateAction' AS action,
       COUNT(*) AS n,
       ROUND(AVG((details->'diagnostics'->>'sharpCount')::float8), 1) AS avg_sharps,
       ROUND(AVG((details->>'kellyMultiplier')::float8), 2) AS avg_mult
FROM compliance_logs
WHERE action_type = 'inversion_gate_shadow'
  AND timestamp >= NOW() - INTERVAL '1 hour'
GROUP BY 1 ORDER BY 2 DESC;
```

Distribution should be sensible:
- PROCEED dominates (most candidates have edge and a sharp anchor)
- DOWN_SIZE_HALF for 1-sharp cases (Pinnacle alone)
- DEMOTE_SHADOW for no-edge or no-Pinnacle
- VETO should be rare (catastrophic Stage 2 disagreement OR
  reject_high_edge_integrity at ≥7pp)

### 2.3 — Exposure usage

```sql
WITH today AS (
  SELECT match_id, m.league, pb.stake
  FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
  WHERE pb.placed_at >= NOW() - INTERVAL '24 hours'
    AND pb.bet_track = 'live'
)
SELECT
  (SELECT ROUND(SUM(stake)::numeric, 2) FROM today) AS total_staked_24h,
  (SELECT ROUND(MAX(t.fixture_stake)::numeric, 2)
   FROM (SELECT match_id, SUM(stake) AS fixture_stake FROM today GROUP BY 1) t
  ) AS biggest_fixture_stake,
  (SELECT ROUND(MAX(t.league_stake)::numeric, 2)
   FROM (SELECT league, SUM(stake) AS league_stake FROM today GROUP BY 1) t
  ) AS biggest_league_stake;
```

Cross-reference vs bankroll × tier caps. Trim shouldn't be hit often;
when it is, the binding cap is logged in compliance_logs
`inversion_exposure_cap_trimmed` action_type.

### 2.4 — CLV health (rolling 100 bets per market_type)

```sql
SELECT market_type, n,
       ROUND(stake_weighted_clv_pct::numeric, 2) AS sw_clv,
       ROUND(mean_clv_pct::numeric, 2) AS mean_clv
FROM v_clv_health_rolling
ORDER BY n DESC;
```

Any market_type with `sw_clv < 0` over n>=30 will trigger the
circuit breaker (auto-pause). Check `agent_config` for
`clv_paused_<MARKET_TYPE>` entries.

### 2.5 — Gate rejection histogram

```sql
SELECT gate, n, distinct_matches, last_seen_24h
FROM v_rejected_by_gate_24h
ORDER BY n DESC LIMIT 15;
```

Pre-flip: legacy gates dominate (min_opportunity_score etc.).
Post-flip: those gates should DROP sharply and inversion gates
(stage1/2/3 reasons, reject_high_edge_integrity) appear.

---

## 3. Rollback procedure

If anything goes sideways:

```sql
UPDATE agent_config
SET value = 'false'
WHERE key = 'inversion_pipeline_enabled';
```

Effective immediately on the next placement cycle (5 min). All Bundle
5 + 7 behaviour reverts to defaults-off:
- 0.02 single-bet cap returns
- 6 upstream gates apply unconditionally again
- Legacy allocator + diversity caps resume
- Multi-sharp Kelly tiering no-ops (was only computed in shadow logger)

If specific market_types are misbehaving, the CLV circuit breaker
already auto-pauses them per-market. Manual pause:

```sql
INSERT INTO agent_config (key, value)
VALUES ('clv_paused_<MARKET_TYPE>', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Where `<MARKET_TYPE>` is the upper-case form (e.g. `ASIAN_HANDICAP`).
Manual unpause: set value to `'false'` or delete the row.

---

## 4. Known caveats

1. **Model retrain pending.** Bundle 7.F added 6 new features
   (referee, lineup × 2, injuries × 2, form-diff). Bundle 8.0
   defensive loader accepts the existing 15-feature model and
   ignores positions 15..20 at inference. The features are computed
   and stored; they don't influence model output until a fresh
   retrain runs. Trigger via `POST /api/admin/force-retrain` after
   verifying ≥20 settled bets exist with full feature vectors.

2. **Mover-signal A/B at n=200.** Bundle 7.B logs every mover to
   `compliance_logs` with `action_type='mover_signal_detected'` +
   `bet_subsequently_placed` (backfilled by settlement). Once 200
   mover-triggered settled bets exist, compare ROI + CLV vs
   non-mover-triggered. If lift not present, set
   `mover_signal_enabled = 'false'` in agent_config.

3. **Stage 1 watchlist is observational pre-flip; consumed post-flip**
   via Bundle 8.A wiring (`prioritiseAndAllocate` in scheduler.ts).
   Before the flip, Stage 1 just logs candidate counts; placement
   still flows through the legacy valueDetection path. After the
   flip, the union of valueDetection + Stage 1 emissions flows
   through the prioritiser.

4. **Bootstrap is broken**, loop-retrain is not. The football-data
   bootstrap path returns 0 samples; rely on the daily loop-retrain
   cron (or `/admin/force-retrain`) which uses settled paper_bets.
