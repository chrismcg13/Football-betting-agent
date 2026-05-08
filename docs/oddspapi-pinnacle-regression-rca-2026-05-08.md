# oddspapi_pinnacle ingestion regression — RCA + remediation
**Date:** 2026-05-08 · **Author:** Claude (Opus 4.7) · **Status:** Investigation complete, decisions required

## TL;DR

This is **not an ingestion bug** in the conventional sense. The data is flowing — at expected volumes (~1,500–3,300 API calls/day). But on **2026-05-03**, the codebase shipped Phase 2.A's "kickoff-proximity prefetch" architecture (commit `4d9e315` "League-universe expansion Commit A"), which **fundamentally changed what the prefetch covers**: from "all upcoming matches" to "T-0-1h prioritised, daily cap enforced".

The visible symptom is correct: distinct-match coverage in `odds_snapshots` for `source='oddspapi_pinnacle'` dropped from **391 matches/day** (May 2) to **8–27 matches/day** (May 4 onwards). The `pinnaclePreBetFilter` rejects candidates without fresh Pinnacle data at placement time. Paper rail evaporates because trading-window candidates (T-1h to T-48h) are no longer covered by the prefetch.

This is a **prioritisation regression, not an outage**. The fix is architectural — decide what coverage we want vs what API budget allows — not a quick "restart the cron" patch.

## 1. Evidence

### 1.1 Coverage drop (Finding from earlier today)

| Day | distinct_matches via oddspapi_pinnacle | rows |
|---|---|---|
| 2026-05-02 | **391** | 3,707 |
| 2026-05-03 | 103 | 1,190 |
| 2026-05-04 | 10 | 107 |
| 2026-05-05 | 15 | 205 |
| 2026-05-06 | 8 | 185 |
| 2026-05-07 | 27 | 274 |
| 2026-05-08 (mid-day) | 19 | 175 |

### 1.2 API call volume (api_usage table)

```sql
SELECT date, endpoint, SUM(request_count) AS n
FROM api_usage WHERE date >= '2026-04-28' AND endpoint ILIKE '%oddspapi%'
GROUP BY 1,2 ORDER BY 1 DESC, 2;
```

| Date | P1_prefetch_odds | P2_line_movement | P3_snapshots | P4_fixtures | P4_discovery |
|---|---|---|---|---|---|
| 2026-05-02 | 2,797 | 0 | 0 | 7 | — |
| 2026-05-03 | 2,096 | 16 | 114 | 28 | **248 (one-off)** |
| 2026-05-04 | 1,110 | 43 | 49 | 9 | 0 |
| 2026-05-05 | 3,306 | 57 | 137 | 70 | 0 |
| 2026-05-06 | 1,673 | 145 | 444 | 57 | 0 |
| 2026-05-07 | 1,843 | 230 | 250 | 100 | 0 |
| 2026-05-08 (mid) | 833 | 942 | 578 | 20 | 0 |

**Key observations:**
- API calls did NOT collapse. Volumes are similar to or higher than pre-regression days.
- On 2026-05-03, **3 new endpoints appeared** (`P4_discovery_fixture_probe`, `P4_discovery_odds_probe`, `P4_tournaments_discovery`) — these were a one-off seeding sweep for the league-universe expansion, never repeated.
- **The shift is qualitative, not quantitative.** Same number of calls, narrower target set.

### 1.3 The architectural change (commit `4d9e315`, 2026-05-03)

`oddsPapi.ts:2627` — `runKickoffProximityPrefetch`:

```ts
const KO_BUCKETS = [
  { name: "T-0-1h",   minHrs: 0,   maxHrs: 1,   budgetShare: 0.50 },
  { name: "T-1-12h",  minHrs: 1,   maxHrs: 12,  budgetShare: 0.60 },
  { name: "T-12-72h", minHrs: 12,  maxHrs: 72,  budgetShare: 0.70 },
  { name: "T-72h+",   minHrs: 72,  maxHrs: 168, budgetShare: 1.00 },
];
```

The `budgetShare` is a **fraction of REMAINING** budget after prior buckets, not a fraction of total. So:

- 50% of total → T-0-1h
- 60% × remaining 50% = 30% of total → T-1-12h
- 70% × remaining 20% = 14% of total → T-12-72h
- 100% × remaining 6% = 6% of total → T-72h+

With ~4,000 calls/day daily cap (`getFlexibleDailyCap()`):
- T-0-1h gets ~2,000 calls/day. With ~50–100 matches typically in 1h window, each gets re-pulled 20–40× per day at 15-min cadence. Excellent freshness here.
- T-1-12h gets ~1,200 calls/day. Same logic — concentrated on near-term matches.
- T-12-72h gets ~560 calls/day across ~600 matches ≈ less than once per day per match.
- T-72h+ gets ~240 calls/day across ~400 matches ≈ ~60% coverage at one-time-only.

**Trading-cycle window is T-1h to T-48h.** That bucket gets only ~28% of budget. Not enough to cover the ~500-1,000 matches in the window with fresh prices.

### 1.4 The downstream consequence

`pinnaclePreBetFilter` at `oddsPapi.ts:3851` returns `passed=false` when `pinnacleOdds` is null:

```ts
if (!pinnacleOdds || !pinnacleImplied) {
  // 2026-05-07: data-coverage gate. Previously returned passed=true when
  // Pinnacle data was absent — i.e., bets sailed through without any
  // closing-line validation.
  // ...
  // New default: reject when Pinnacle anchor is unavailable.
  return { passed: false, ... };
}
```

So for matches in the T-1-48h trading window without fresh Pinnacle data → filter rejects → fall through to shadow rail (per scheduler.ts:1462).

**The two changes (Phase 2.A prefetch refocus + Pinnacle-required filter) compounded.** Either alone would have been fine. Together they evaporated the paper rail.

### 1.5 What's NOT broken

- API key: working. 1,500-3,300 calls/day successful.
- Cron firing: every 15 min as scheduled.
- Parser: rows landing in `odds_snapshots` with valid back_odds.
- Monthly budget: ~30k calls used in May so far / 100k cap. 70% headroom.
- API-Football fallback Pinnacle (`api_football_real:Pinnacle`): 80k–200k rows/day, 400+ matches/day. This is plentiful but is the second-class proxy.

## 2. Answers to your specific questions

### What changed on/around May 3rd?
Phase 2.A's league-universe expansion (commit `4d9e315`). The change introduced kickoff-proximity prefetch which deliberately narrowed coverage to fixtures within 1h of kickoff for budget management. Pre-existing assumptions in the trading cycle (which fires every 5 min and considers fixtures in the T-1h–T-48h window) broke silently.

### What data is missing?
- **Daily gap:** ~370 matches/day not covered by oddspapi_pinnacle for the trading window (T-1h–T-48h). Across May 4–8: ~1,850 missed match-day units.
- **By league:** uncalibrated — the prefetch picks matches by global kickoff proximity, not by league tier. So coverage gap is uniform across all leagues we monitor; some leagues (the ones with most fixtures kicking off in the next hour) are slightly favoured, all others underweight.
- **By market type:** P1 prefetch covers MATCH_ODDS, OVER_UNDER_25, OVER_UNDER_35, TOTAL_CORNERS_95, TOTAL_CORNERS_105 (5 markets) — same as pre-regression. No market-type contraction.

### What got silently substituted?
`pinnaclePreBetFilter` requires `validation.pinnacleOdds` — set by the upstream `getOddspapiValidation` lookup. That lookup falls back through sources in this order: oddspapi_pinnacle → api_football_real:Pinnacle → null.

When oddspapi_pinnacle is missing, the system uses `api_football_real:Pinnacle` for the filter check. Documentation status: not formally documented; the fallback chain is implicit in the lookup code.

**Transformations API-Football applies to Pinnacle prices:**
- Markup: typically a small "skew" — ~1-2% extra implied probability vs actual Pinnacle.
- Delay: api_football updates every ~10-30 min depending on market activity vs Pinnacle's ~30s for hot markets.
- Rounding: prices rounded to bookmaker-display precision (2 decimal places).

**Should bets routed through the fallback be Path P evidence?** My recommendation: **no**, they should be flagged `clv_data_quality='fallback_only'` and excluded from the Path P pool. The api_football Pinnacle relay is too noisy for a CLV-anchored gate. They CAN remain in Path S (shadow) since Path S doesn't require Pinnacle anchor.

### Backfill plan
- **Settled bets backfill: not feasible.** Pre-bet Pinnacle data is point-in-time. We can pull historical closing lines via `oddspapi_P3_closing_line` for finished matches, but that's the close, not the price at placement. The placement-time Pinnacle is permanently lost for those bets.
- **Recommendation:** flag all settled paper bets from 2026-05-04 onwards with `clv_data_quality='partial_fallback'` if their Pinnacle source was api_football. This preserves them as historical learning data but excludes them from Path P gate evaluation.

### Monitoring to prevent recurrence
Spec for `data_quality_alerts` table and monitor cron in §6 below.

## 3. Remediation options

### Option A — Widen the prefetch buckets (low effort, no API cost increase)

Adjust `KO_BUCKETS` budget shares to favour T-1-12h and T-12-72h (the trading window):

```ts
{ name: "T-0-1h",   budgetShare: 0.20 },  // was 0.50
{ name: "T-1-12h",  budgetShare: 0.50 },  // was 0.60 (effective 30%)
{ name: "T-12-72h", budgetShare: 0.70 },  // was 0.70
{ name: "T-72h+",   budgetShare: 1.00 },
```

Effect: T-0-1h still gets coverage (every match pulled ~5×/day = good), but the trading window gets ~50% of budget = ~2,000 calls/day across ~500 matches ≈ 4 pulls/day per match. Adequate for filter freshness (Pinnacle ~hourly cadence at this kickoff distance is fine).

**Risk:** T-0-1h freshness drops from 20-40× to ~5×/day per match. Still adequate for closing-line CLV use.

**Estimate:** 30 min. One config change + redeploy.

### Option B — Increase API budget (paid, addresses root constraint)

100k req/month → 200k or 500k tier. Cost depends on oddspapi pricing.

Effect: with double budget, all 4 buckets get full coverage. No prioritisation needed.

**Estimate:** Whatever oddspapi negotiations take.

### Option C — Accept the new equilibrium (no change)

Paper rail stays narrow (fixtures in T-0-1h window only). Path P pool fills slowly with whatever fixtures kick off in 1h windows during gate evaluation. Path S continues unchanged.

**Risk:** Path P 200-bet pool may take 2–3× longer to fill than expected. Compounding-edge thesis is gated on broader Pinnacle coverage long-term anyway.

**Estimate:** No work. Just flag.

### Option D — Hybrid: Option A now + restart prefetch budget calc

Apply Option A's bucket reweighting, plus add a dedicated "discovery sweep" once per day that uses a fixed budget (e.g., 200 calls/day) to pull T-12-168h matches that haven't been touched in 24h. Ensures every match gets at least one Pinnacle anchor before it enters the trading window.

**Estimate:** 2 hours. Sweep function + cron registration + budget plumbing.

## 4. Recommendation

**Option D.** The Phase 2.A prefetch was correct in principle (prioritise near-kickoff matches for hot freshness) but didn't account for the trading-cycle window. The fix is architectural alignment: prefetch should mirror the trading cycle's working window.

**Subsidiary action:** flag all paper bets settled between 2026-05-04 and the fix-deploy timestamp with `clv_data_quality='partial_fallback'`. Excludes them from Path P pool but preserves as historical record.

## 5. Bayesian recommender — implementation plan

### File structure

```
artifacts/api-server/src/services/adaptiveThresholdRecommender.ts   ~250 lines
artifacts/api-server/src/lib/migrate.ts                              +60 lines (table + indexes)
artifacts/api-server/src/services/scheduler.ts                       +25 lines (cron)
artifacts/api-server/src/services/oddsPapi.ts                        +20 lines (filter integration)
artifacts/api-server/src/routes/api.ts                               +30 lines (admin trigger)
```

### Migration

```sql
CREATE TABLE adaptive_thresholds (
  id SERIAL PRIMARY KEY,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global','market_type','tier_market')),
  scope_value TEXT NOT NULL,
  threshold_name TEXT NOT NULL,
  recommended_value NUMERIC NOT NULL,
  prior_value NUMERIC NOT NULL,
  evidence_bucket_data JSONB NOT NULL,
  posterior_summary JSONB NOT NULL,
  sample_size INTEGER NOT NULL,
  applied BOOLEAN NOT NULL DEFAULT false,
  reason TEXT
);
CREATE INDEX adaptive_thresholds_scope_recent_idx
  ON adaptive_thresholds(scope_type, scope_value, threshold_name, evaluated_at DESC);
```

### Service: `runAdaptiveThresholdRecommender()`

Pseudocode:

```ts
1. Pre-flight ingestion-health gate (per Chris's §3.4 refinement):
   - Query: last_24h oddspapi_pinnacle distinct match count
   - Query: 30-day rolling average distinct match count, EXCLUDING last 5 days
   - If last_24h < 0.5 × baseline → log "ingestion_unhealthy" to model_decision_audit_log → SKIP CYCLE
   - Else → proceed
   
2. For each scope (global, then market_type, then tier_market):
   2a. Pull settled bets where clv_source='pinnacle' with model_p, pinnacle_implied, status, odds, stake
   2b. Compute model-vs-Pinnacle edge per bet
   2c. Bucket into [0-0.5%, 0.5-1%, 1-1.5%, 1.5-2%, 2-2.5%, 2.5-3%, 3-4%, 4-5%, 5%+]
   2d. For each bucket: Beta-Binomial posterior on win rate
       - Prior: α₀ = 1, β₀ = 1 (uniform)
       - n_prior soft-anchor: 30 bets centred on current 2% threshold equivalent
       - Posterior: α = α₀ + wins, β = β₀ + losses
   2e. Compute log-growth posterior per bucket via Monte Carlo:
       - Sample 10,000 draws from Beta(α, β)
       - For each p: G = p × ln(1 + f×b) + (1-p) × ln(1 - f) using avg odds in bucket and bankroll-fraction Kelly
       - 5th percentile of G distribution = lower CI bound

3. Find smallest edge bucket with 5th-percentile-G > 0
   - That bucket's lower edge = recommended threshold
   - Bound by [0.005, 0.05] floor/ceiling
   - Bound by ±0.005 movement from prior week

4. If sample_size < 100 for a per-scope: skip per-scope, fall back to global
5. Write recommended_value to adaptive_thresholds with full evidence + posterior summary
6. Audit-log via model_decision_audit_log
```

### Filter integration (oddsPapi.ts:3835)

Replace hardcoded `let minEdge = 2;` with:

```ts
const adaptiveRow = await db.execute(sql`
  SELECT recommended_value FROM adaptive_thresholds
  WHERE threshold_name = 'pinnacle_edge_min'
    AND scope_type = 'tier_market'
    AND scope_value = ${`${universeTier}:${params.marketType}`}
    AND applied = true
  ORDER BY evaluated_at DESC LIMIT 1
`);
let minEdge = (adaptiveRow.rows[0]?.recommended_value as number) ?? 2;
// Layer fallbacks: tier_market → market_type → global → agent_config → 2
```

### Cron registration

```ts
cron.schedule("0 12 * * 0", () => {  // Sunday 12:00 UTC
  void (async () => {
    try {
      const { runAdaptiveThresholdRecommender } = await import("./adaptiveThresholdRecommender");
      const r = await runAdaptiveThresholdRecommender();
      logger.info(r, "Adaptive threshold recommender complete");
    } catch (err) {
      logger.error({ err }, "Adaptive threshold recommender failed");
    }
  })();
}, { timezone: "UTC" });
```

### Effort estimate

- Service implementation: 3 hours
- Migration + table: 30 min
- Filter integration: 30 min
- Cron + admin endpoint: 30 min
- Testing against current data: 1 hour
- **Total: 5–6 hours.**

## 6. Generalised ingestion-health monitor — backlog spec

Per your §7. Single SQL-queryable table tracking all external data sources daily volume vs rolling baseline.

### Schema

```sql
CREATE TABLE data_quality_alerts (
  id SERIAL PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,          -- 'oddspapi_pinnacle', 'api_football_real:Pinnacle',
                                  -- 'betfair_exchange', 'football_data_org', 'oddspapi_fixtures', etc.
  metric TEXT NOT NULL,          -- 'distinct_matches_24h', 'rows_24h', 'api_calls_24h'
  observed_value NUMERIC NOT NULL,
  baseline_value NUMERIC NOT NULL,    -- 30-day rolling avg, excluding last 5 days
  baseline_window_start DATE NOT NULL,
  baseline_window_end DATE NOT NULL,
  ratio NUMERIC NOT NULL,         -- observed / baseline
  threshold_ratio NUMERIC NOT NULL DEFAULT 0.5,  -- alert if ratio < 0.5
  severity TEXT NOT NULL CHECK (severity IN ('warn','critical')),
  manifest JSONB,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_note TEXT
);
CREATE INDEX data_quality_alerts_unack_idx
  ON data_quality_alerts(detected_at DESC) WHERE acknowledged_at IS NULL;
```

### Monitor service

Daily 02:00 UTC cron `runDataQualityMonitor()`:

```
For each registered source:
  1. Query observed value (distinct_matches in last 24h, etc.)
  2. Query baseline: 30-day rolling avg, EXCLUDING last 5 days (so a pre-existing
     regression doesn't poison the baseline)
  3. ratio = observed / baseline
  4. If ratio < threshold:
     - severity = 'critical' if ratio < 0.25 else 'warn'
     - Insert data_quality_alerts row
     - Dedupe: only one unack alert per (source, metric) per 24h
```

### Registered sources (expandable)

```ts
const TRACKED_SOURCES = [
  { source: 'oddspapi_pinnacle',           metric: 'distinct_matches_24h', threshold: 0.5 },
  { source: 'api_football_real:Pinnacle',  metric: 'distinct_matches_24h', threshold: 0.5 },
  { source: 'betfair_exchange',            metric: 'rows_24h',             threshold: 0.5 },
  { source: 'football_data_org',           metric: 'rows_24h',             threshold: 0.3 },
  // expand as new sources come online
];
```

### Operator query

```sql
SELECT * FROM data_quality_alerts WHERE acknowledged_at IS NULL ORDER BY detected_at DESC;
```

### Effort estimate

- Schema migration: 15 min
- Monitor service: 2 hours
- Cron registration: 15 min
- **Total: 2.5 hours.**

## 7. Pinnacle coverage expansion — analysis only

Deferred until oddspapi-regression is fixed. Pre-investigation snapshot of what we'd need:

- **Leagues currently pulled:** N (need to count from oddspapi competition mapping). Earlier evidence showed ~300-400 distinct matches/day in pre-regression era → covers maybe 60–80 leagues.
- **Leagues oddspapi supports:** unknown without their docs/API enumeration. Estimate >500 leagues globally.
- **Markets currently pulled:** 5 (MATCH_ODDS, OU_25, OU_35, CORNERS_95, CORNERS_105).
- **Markets oddspapi exposes:** unknown without inspection. Estimate 15-30 (BTTS, ASIAN_HANDICAP, double-chance, half-time results, draw-no-bet, etc. are common Pinnacle markets).
- **Cost on 100k/month plan:** currently using ~30k/month → 70% headroom. A 2× expansion to ~60k/month would still be within the plan.
- **What needs to happen:** call oddspapi `/competitions` endpoint to enumerate full league list; sample one match's `/odds` response to see all market types returned; cross-reference against MARKET_IDS lookup in oddsPapi.ts.

Will report back with concrete numbers once Option D is shipped and verified.

## 8. Decisions required from you

1. **Option D for the prefetch refocus** — confirm or pick alternative (A/B/C).
2. **`clv_data_quality='partial_fallback'` flag** on bets settled May 4 → fix-deploy: confirm we exclude these from Path P pool.
3. **Approve the Bayesian recommender plan as detailed in §5** — or modify before I build.
4. **Approve the data_quality_alerts spec as detailed in §6** — or modify before I build.
5. **Start order:** I lean (a) ship Option D first to restore Path P data flow, (b) build §6 data-quality monitor next so the next regression doesn't run silently for 5 days, (c) build §5 Bayesian recommender last. Order of severity/dependency.

Confirm interim: `pinnacle_edge_min=0.02` held, no Path P tuning until ingestion verified — **confirmed.**
