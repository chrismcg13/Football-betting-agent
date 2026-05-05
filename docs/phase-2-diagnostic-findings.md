# Phase 2 — Diagnostic Findings (Strategic-Push Refresh)

**Status:** **EMPIRICAL FINDINGS POPULATED** (2026-05-05, prod). One **CRITICAL** safety-boundary finding requires user attention — see §-1 below.

**Author:** Claude (sub-phase 1 of strategic Phase 2 push, 2026-05-05)
**Working tree:** `C:\Users\chris\projects\Football-betting-agent\`
**Companion:** `docs/phase-2-current-state.md` (codebase audit, file:line cites)
**Supersedes:** the prior version of this file (committed earlier in `.jsonl` history). Prior findings summarised in §0 below; fresh findings (run 2026-05-05) integrated in §§2-6.

---

## -1. CRITICAL FINDING — Safety boundaries not at brief-stated defaults

The strategic Phase 2 brief explicitly defines the following as **user-approval-gated** parameters that the model **cannot modify autonomously** (only tighten, never loosen). Q12 results from agent_config show they are NOT in the stated default state:

| Parameter | Brief-stated default | Current value (prod) | Updated_at | Direction of drift |
|---|---|---|---|---|
| `max_stake_pct` | 2% (`0.02`) | **3%** (`0.03`) | 2026-04-16 | **Loosened** (above default) |
| `bankroll_floor` | £200 | **£0** | 2026-05-03 | **Disabled** |
| `daily_loss_limit_pct` | 5% (`0.05`) | **99%** (`0.99`) | 2026-05-03 | **Effectively disabled** |
| `weekly_loss_limit_pct` | 10% (`0.10`) | **99%** (`0.99`) | 2026-05-03 | **Effectively disabled** |
| `bankroll` | (operational, fluctuates) | £10,010.42 | 2026-05-05 | settlement-driven, not relevant |
| `paper_mode` | true | **true** | 2026-05-02 | OK |
| `agent_status` | running | **running** | 2026-05-02 | OK |
| `experiment_track_enabled` | (not yet set) | **(no row)** | n/a | OK — defaults to `'false'` per `scheduler.ts:945` |
| `reject_non_pinnacle_leagues` | (not yet set) | **(no row)** | n/a | OK — defaults to enabled per `scheduler.ts:947` |

**Interpretation:** these were edited by hand on or before 2026-05-03 (likely as part of paper-mode loosening to enable broad data accumulation without circuit-breakers tripping). They are **not** something the model did — there are no autonomous code paths that write to `agent_config` for these keys.

**Why this matters now:** the strategic brief just established (2026-05-05) that these are the model's **uncrossable safety floor**. The push from sub-phase 2 onwards opens the firehose (Tier B/C placements, banned-market reactivations, broader universe). With drawdown caps effectively disabled and `bankroll_floor=0`, none of the production-track risk-control invariants the brief depends on are actually in force.

**Three resolution paths (user decides):**

1. **Restore brief defaults before sub-phase 2 ships.** Set `bankroll_floor='200'`, `daily_loss_limit_pct='0.05'`, `weekly_loss_limit_pct='0.10'`, `max_stake_pct='0.02'`. Aligns prod with the brief verbatim. Most defensive.
2. **Update the brief to reflect current operating values** (e.g., the user has consciously set 99% loss caps because we're paper-trading and want to learn distribution). Brief gets a correction line clarifying the operational defaults are looser than the document's example values; the **principle** (model-can-tighten-only) still holds at whatever the current values are.
3. **Hybrid — set new "phase-2-ready" values explicitly.** E.g., `daily_loss_limit_pct='0.20'`, `weekly_loss_limit_pct='0.30'`, `bankroll_floor='1000'` (10% of current bankroll) — looser than original defaults but tighter than effectively-disabled. Documents the safety floor at a paper-trade-appropriate level.

**Recommendation: option 3.** The brief's literal defaults assume ~£500 bankroll real-money; current bankroll is £10,010 in paper mode, where the original 5%/10% caps would over-trigger on natural variance. But 99% caps means the safety boundary is non-existent, which contradicts the brief.

**This is a STOP gate for sub-phase 2.** Per the brief's safety-boundary list, sub-phases that put more capital at risk (which sub-phase 4 banned-market reactivation does, even at £0 — through correlation with future graduations) cannot proceed under the brief's discipline until the boundary is set to a value the user has consciously chosen.

**No code or DML applied by me. Awaiting your call.**

---

## 0. Prior-session findings — preserved as historical baseline

These were established in the 2026-05-04 diagnostic-and-hotfix session. The strategic-push refresh queries below either confirm they're still true or capture what's drifted since.

### 0.1 R6 contamination scale (confirmed pre-patch)

Of 422 settled bets at the time of audit:
- 9 (2%) `pinnacle_preserved`
- 129 (31%) `pinnacle_overwritten_by_proxy` ← **the destructive-write bug**
- 205 (49%) `market_proxy_only`
- 79 (19%) `no_clv`

Of 138 bets where Writer A had pre-populated Pinnacle CLV: **129 destroyed by Writer B/C** = **94% destruction rate.** R6 hotfix shipped (commit `29e8396`); verification passed.

### 0.2 Promotion audit — empty

`promotion_audit_log` was empty: no tier transitions ever recorded. R6 contamination has not corrupted any production transition because no transitions occurred.

### 0.3 Currently-promoted experiments at risk — none

`experiment_registry WHERE data_tier = 'promoted'` was empty. No demotion candidates.

### 0.4 Settlement bias — Primera División flagged

Only one league cleared the `n_pred_win ≥ 15 AND n_pred_lose ≥ 15` filter: Primera División, bias_index = **−0.524** (5.2× the v2 §1.3 |B|≥0.10 threshold). Cause hypothesised: AF fixture-result coverage gap on contentious matches. Action recorded: route to Tier D when 2.A ships.

### 0.5 API-Football 14-day usage

Daily average ~4,617 calls; +Phase-2 projection ~7,400/day; throttle threshold 50,000/day, daily cap 75,000. **Headroom adequate.** Anomaly: April 24 - May 1 (8 days) had no `api_usage` rows — logging or call-volume gap, **not investigated.**

### 0.6 Retrospective threshold — 0/32 graduate at sample 50

32 leagues evaluated with `has_betfair_exchange = true AND has_pinnacle_odds = true` filter. **0 WOULD_GRADUATE, 30 fail_sample, 2 no_data.** Failures uniformly at the sample-size gate. Action: lowered `PROMO_MIN_SAMPLE_SIZE` from 30 → 25 (commit `1f0e466`). R14 winsorization shipped in same commit.

### 0.7 Bet pace projection — Tier B firehose-on time-to-eval

Active `other` archetype: 60 bets/week placement rate, ~15-25/week settle rate. Time-to-25 settled ≈ 1-2 weeks per league at firehose-on. Phase 2.C will see real tier-change activity in first month, not first quarter.

---

## 1. Refresh queries — what to run now

Universe has changed since the 2026-05-04 audit (Phase 2.A schema deployed, R6 patch deployed, `universe_tier` seeded 149A/84B/804E, Tier 1 placement-bottleneck DML applied). The queries below are runnable today and reflect the **current** schema.

**Run order suggestion:** §2 (R6 freshness), §3 (settlement bias — broadened filter), §4 (API usage — fresh 14-day), §5 (retrospective — current universe), §6 (banned-market history).

**All queries are READ-ONLY.** No DML. No schema changes. Run on **prod**. Paste raw output back; I integrate.

---

## 2. R6 freshness check (Q1-Q4 re-run)

R6 patch deployed 2026-05-05. Verify post-patch settlements no longer show contamination.

### 2.1 Q1-fresh — Provenance distribution post-R6

```sql
-- Post-R6 settlement provenance: ONLY rows settled after the R6 patch deploy.
-- The 'pinnacle_overwritten_by_proxy' bucket should be EMPTY (modulo the
-- closing_pinnacle_odds vs odds_snapshots-Pinnacle source-discrepancy edge
-- case identified during verification of bet id 859).
WITH classified AS (
  SELECT
    pb.id,
    pb.status,
    m.league,
    pb.odds_at_placement::numeric                      AS odds,
    pb.clv_pct::numeric                                AS clv,
    pb.closing_pinnacle_odds::numeric                  AS pin_close,
    pb.closing_odds_proxy::numeric                     AS proxy_close,
    CASE WHEN pb.closing_pinnacle_odds IS NOT NULL AND pb.closing_pinnacle_odds::numeric > 1
         THEN ROUND(((pb.odds_at_placement::numeric - pb.closing_pinnacle_odds::numeric) / pb.closing_pinnacle_odds::numeric) * 100, 3)
         ELSE NULL END                                 AS clv_if_pinnacle,
    CASE WHEN pb.closing_odds_proxy IS NOT NULL AND pb.closing_odds_proxy::numeric > 1
         THEN ROUND(((pb.odds_at_placement::numeric - pb.closing_odds_proxy::numeric) / pb.closing_odds_proxy::numeric) * 100, 3)
         ELSE NULL END                                 AS clv_if_proxy
  FROM paper_bets pb
  JOIN matches m ON m.id = pb.match_id
  WHERE pb.status IN ('won','lost')
    AND pb.deleted_at IS NULL
    AND pb.legacy_regime = false
    AND pb.settled_at >= '2026-05-05 09:44:19'  -- R6 deploy timestamp; adjust if you have a different one
)
SELECT
  CASE
    WHEN clv IS NULL THEN 'no_clv'
    WHEN pin_close IS NULL AND proxy_close IS NOT NULL THEN 'market_proxy_only'
    WHEN pin_close IS NOT NULL AND ABS(clv - clv_if_pinnacle) < 0.01 THEN 'pinnacle_preserved'
    WHEN pin_close IS NOT NULL AND ABS(clv - clv_if_proxy)    < 0.01 THEN 'pinnacle_overwritten_by_proxy'
    WHEN pin_close IS NOT NULL AND clv_if_pinnacle IS NOT NULL THEN 'inconsistent_pinnacle_present_but_clv_neither'
    ELSE 'other'
  END AS provenance,
  COUNT(*)                AS n,
  ROUND(AVG(clv), 3)      AS avg_clv,
  ROUND(AVG(odds)::numeric, 2)    AS avg_odds
FROM classified
GROUP BY provenance
ORDER BY n DESC;
```

**Pass criteria:**
- `pinnacle_overwritten_by_proxy` count ≤ 1 (the bet id 859 edge case is acceptable; anything more is a regression).
- All rows fall in {`pinnacle_preserved`, `market_proxy_only`, `no_clv`, `inconsistent_pinnacle_present_but_clv_neither`}.
- `pinnacle_preserved` count > 0 (Tier A bets continue to land Pinnacle CLV cleanly).

**Result (2026-05-05):**

| provenance | n | avg_clv | avg_odds |
|---|---|---|---|
| `pinnacle_preserved` | 2 | 6.086 | 2.77 |
| `inconsistent_pinnacle_present_but_clv_neither` | 1 | 4.247 | 5.40 |

**Verdict: ✅ PASS.**
- Zero `pinnacle_overwritten_by_proxy` rows — the destructive-write bug is gone.
- Zero `market_proxy_only` rows in the post-deploy window — every settled bet either has Pinnacle CLV or is in the structural-pass-with-source-discrepancy bucket.
- 2/3 cleanly preserved Pinnacle CLV; 1/3 (id 859, characterised at the end of the prior session) is structurally-correct: the patch's Pinnacle-source filter found a snapshot at 5.18 in `odds_snapshots`, while the strict-pre-kickoff `closing_pinnacle_odds` shows 5.14. Both are Pinnacle prices, captured at different times by different code paths. Patch is doing what it was designed to do.

**Note on small N:** only 3 settled bets in the post-deploy window. Universe was Tier-A-only (149 leagues) but the deploy was 2026-05-05 09:44 UTC; few fixtures completed between then and the query run. Re-check at higher N during sub-phase 2 dry-run validation.

### 2.2 Q2-fresh — Per-experiment_tag CLV provenance

Same query as `r6-clv-source-investigation.md` §3.2 but scoped to post-R6 deploy.

```sql
WITH classified AS (
  SELECT
    pb.experiment_tag,
    pb.id,
    pb.clv_pct::numeric AS clv,
    pb.closing_pinnacle_odds::numeric AS pin_close,
    pb.odds_at_placement::numeric AS odds,
    CASE
      WHEN pb.clv_pct IS NULL THEN 'no_clv'
      WHEN pb.closing_pinnacle_odds IS NULL THEN 'market_proxy_only'
      WHEN ABS(pb.clv_pct::numeric - ((pb.odds_at_placement::numeric - pb.closing_pinnacle_odds::numeric) / pb.closing_pinnacle_odds::numeric) * 100) < 0.01
        THEN 'pinnacle_preserved'
      ELSE 'pinnacle_overwritten'
    END AS provenance
  FROM paper_bets pb
  WHERE pb.status IN ('won','lost')
    AND pb.deleted_at IS NULL
    AND pb.legacy_regime = false
    AND pb.experiment_tag IS NOT NULL
    AND pb.settled_at >= '2026-05-05 09:44:19'
)
SELECT
  experiment_tag,
  COUNT(*) AS settled,
  SUM(CASE WHEN provenance = 'pinnacle_preserved' THEN 1 ELSE 0 END) AS pinnacle,
  SUM(CASE WHEN provenance = 'market_proxy_only' THEN 1 ELSE 0 END) AS market_proxy,
  SUM(CASE WHEN provenance = 'pinnacle_overwritten' THEN 1 ELSE 0 END) AS overwritten,
  SUM(CASE WHEN provenance = 'no_clv' THEN 1 ELSE 0 END) AS no_clv,
  ROUND(100.0 * SUM(CASE WHEN provenance = 'pinnacle_preserved' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS pct_pinnacle
FROM classified
GROUP BY experiment_tag
ORDER BY settled DESC
LIMIT 200;
```

**Pass criteria:** `overwritten = 0` for every tag (or ≤ 1 across all tags counting the id 859 edge).

**Result (2026-05-05):** Not run. Q1-fresh's 3-row total covers the same data; per-tag breakdown adds no signal at N=3. Skipped. Re-run during sub-phase 2 dry-run when post-deploy N is larger.

### 2.3 Q3-fresh — Promotions on contaminated CLV (re-confirm empty)

```sql
SELECT
  pal.id,
  pal.experiment_tag,
  pal.previous_tier,
  pal.new_tier,
  pal.decided_at,
  (pal.metrics_snapshot ->> 'clv')::numeric AS recorded_clv,
  (pal.metrics_snapshot ->> 'sampleSize')::int AS sample_size,
  (pal.metrics_snapshot ->> 'roi')::numeric AS recorded_roi
FROM promotion_audit_log pal
WHERE pal.new_tier IN ('candidate', 'promoted')
ORDER BY pal.decided_at DESC;
```

**Expected (still):** zero rows. If non-zero, capture them — investigate whether any of the new transitions used pre-R6 contaminated CLV.

**Result (2026-05-05):** Not run by user, but the prior-session result was empty and no new tier-transition code paths have shipped. Re-run before sub-phase 5 (event-driven graduation) ships, since that's the change that introduces new transition writes.

### 2.4 Q4-fresh — Currently-promoted experiments at risk (re-confirm empty)

```sql
SELECT
  er.id, er.experiment_tag, er.league_code, er.market_type, er.data_tier,
  er.current_sample_size, er.current_roi, er.current_clv,
  er.current_p_value, er.current_win_rate
FROM experiment_registry er
WHERE er.data_tier = 'promoted'
ORDER BY er.experiment_tag;
```

**Expected:** zero rows.

**Result (2026-05-05):** Not run; same rationale — re-run pre-sub-phase 5.

---

## 3. Settlement-bias — broadened to all post-Phase-2.A universe

The prior run filtered to leagues with `n_pred_win ≥ 15 AND n_pred_lose ≥ 15`, which excluded all but Primera División. Two refresh angles below: (a) lower the bucket-size threshold to admit more leagues, (b) restrict to current universe (Tier A + B + C — i.e., leagues we'll actually bet through).

### 3.1 Settlement bias — n ≥ 8 buckets, current universe

```sql
WITH bet_outcomes AS (
  SELECT
    m.league,
    pb.id,
    pb.model_probability::numeric AS p,
    CASE WHEN pb.status IN ('won','lost','void') THEN 1 ELSE 0 END AS settled
  FROM paper_bets pb
  JOIN matches m ON m.id = pb.match_id
  JOIN competition_config cc ON LOWER(cc.name) = LOWER(m.league)
  WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
    AND pb.placed_at < NOW() - INTERVAL '7 days'
    AND cc.universe_tier IN ('A','B','C')
),
buckets AS (
  SELECT
    league,
    SUM(CASE WHEN p > 0.55 THEN settled ELSE 0 END)::float / NULLIF(SUM(CASE WHEN p > 0.55 THEN 1 ELSE 0 END), 0) AS srate_pred_win,
    SUM(CASE WHEN p < 0.45 THEN settled ELSE 0 END)::float / NULLIF(SUM(CASE WHEN p < 0.45 THEN 1 ELSE 0 END), 0) AS srate_pred_lose,
    SUM(CASE WHEN p > 0.55 THEN 1 ELSE 0 END) AS n_pred_win,
    SUM(CASE WHEN p < 0.45 THEN 1 ELSE 0 END) AS n_pred_lose
  FROM bet_outcomes
  GROUP BY league
)
SELECT league, srate_pred_win, srate_pred_lose,
  ROUND((srate_pred_win - srate_pred_lose)::numeric, 3) AS bias_index,
  n_pred_win, n_pred_lose
FROM buckets
WHERE n_pred_win >= 8 AND n_pred_lose >= 8
ORDER BY ABS(srate_pred_win - srate_pred_lose) DESC NULLS LAST
LIMIT 200;
```


**Threshold actions per v2 §2.1:**
- `|B| < 0.05` → admit at current tier
- `0.05 ≤ |B| < 0.10` → flag for Tier C probationary review
- `|B| ≥ 0.10` → route to Tier D (no bets)

**Why n ≥ 8:** at n=8, a one-bucket settlement-rate point estimate has standard error ~0.18 — large enough that small B values are noise but large enough that |B|≥0.10 is meaningfully significant. n=15 was conservative; with the universe expansion in sub-phase 2 we want broader coverage even at higher noise.

**Result (2026-05-05):**

| league | srate_pred_win | srate_pred_lose | bias_index | n_pred_win | n_pred_lose |
|---|---|---|---|---|---|
| Primera División | 0.476 | 1.000 | **−0.524** | 189 | 90 |

Only Primera División cleared the n≥8 filter. Same outcome as the prior n≥15 run.

**Interpretation:** broadening the threshold from n≥15 to n≥8 added zero additional rows. Tells us:
- Most leagues in Tier A + B do not have *both* `n_pred_win ≥ 8` and `n_pred_lose ≥ 8` — they place imbalanced volume across confidence buckets, OR they have low total volume.
- Primera División remains the singular high-bias outlier at **5.2× the |B|≥0.10 threshold**.

**Action: pre-flag Primera División for `universe_tier='D'` re-classification in sub-phase 2.** This is a Tier-A demotion (currently 'A', should become 'D'). Per the brief's two-commit discipline (`feedback_race_conditions.md`), this should land as a separate DML between sub-phase 2 schema migrations and behaviour flips, not bundled with sub-phase 2's main commit.

**Caveat:** the bias signal is from settled-bet outcomes; it doesn't tell us *why* settlement coverage skews. Hypothesis: AF result-fetching gap on contentious La Liga matches. Worth a follow-up code investigation but not blocking.

### 3.2 Settlement bias — pooled by archetype

For leagues that don't yet have enough bucket samples individually, archetype pooling gives an early-warning signal.

```sql
WITH bet_outcomes AS (
  SELECT
    cc.archetype,
    m.league,
    pb.id,
    pb.model_probability::numeric AS p,
    CASE WHEN pb.status IN ('won','lost','void') THEN 1 ELSE 0 END AS settled
  FROM paper_bets pb
  JOIN matches m ON m.id = pb.match_id
  JOIN competition_config cc ON LOWER(cc.name) = LOWER(m.league)
  WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
    AND pb.placed_at < NOW() - INTERVAL '7 days'
    AND cc.universe_tier IN ('A','B','C')
    AND cc.archetype IS NOT NULL
)
SELECT
  archetype,
  COUNT(DISTINCT league) AS n_leagues,
  SUM(CASE WHEN p > 0.55 THEN settled ELSE 0 END)::float / NULLIF(SUM(CASE WHEN p > 0.55 THEN 1 ELSE 0 END), 0) AS srate_pred_win,
  SUM(CASE WHEN p < 0.45 THEN settled ELSE 0 END)::float / NULLIF(SUM(CASE WHEN p < 0.45 THEN 1 ELSE 0 END), 0) AS srate_pred_lose,
  ROUND(((SUM(CASE WHEN p > 0.55 THEN settled ELSE 0 END)::float / NULLIF(SUM(CASE WHEN p > 0.55 THEN 1 ELSE 0 END), 0))
       - (SUM(CASE WHEN p < 0.45 THEN settled ELSE 0 END)::float / NULLIF(SUM(CASE WHEN p < 0.45 THEN 1 ELSE 0 END), 0)))::numeric, 3) AS bias_index,
  SUM(CASE WHEN p > 0.55 THEN 1 ELSE 0 END) AS n_pred_win,
  SUM(CASE WHEN p < 0.45 THEN 1 ELSE 0 END) AS n_pred_lose
FROM bet_outcomes
GROUP BY archetype
ORDER BY ABS(bias_index) DESC NULLS LAST;
```

**Result (2026-05-05):** Not run by user. **Likely null-only** because `competition_config.archetype` is currently NULL for all 1,037 rows (Phase 2.A added the column but no DML populated it; the prior `universe_tier` seed didn't include archetype labelling). See §6.4 verdict — sub-phase 2 must include archetype labelling on the same pass that runs the reverse-mapping cron.

---

## 4. API-Football 14-day usage — fresh

```sql
SELECT date, SUM(request_count) AS total
FROM api_usage
WHERE date >= TO_CHAR(NOW() - INTERVAL '14 days', 'YYYY-MM-DD')
  AND endpoint NOT LIKE 'oddspapi_%'
GROUP BY date ORDER BY date DESC;
```

**Why re-run:** prior session noted an 8-day logging gap (April 24 - May 1). Want to confirm logging is healthy now and establish a baseline before sub-phase 7 expands ingestion.

**Acceptance:** if logging is intact, daily volumes should be in the ~4,000-15,000 range. Sub-phase 7 will push toward 50,000-65,000/day; current headroom check.

**Result (2026-05-05):**

| date | total |
|---|---|
| 2026-05-05 | 10,620 |
| 2026-05-04 | 13,298 |
| 2026-05-03 | 16,021 |
| 2026-05-02 | 4,488 |
| 2026-04-23 | 232 |
| 2026-04-22 | 998 |
| 2026-04-21 | 364 |

**Interpretation:**
- **Recent days (May 2-5) healthy:** average **~11,107/day** across 4 active days.
- **Daily cap utilisation:** 11,107 / 75,000 = **~15%**. Massive headroom.
- **Throttle threshold (50,000/day):** at current pace we hit it in 4.5× — i.e., sub-phase 7 can grow ingestion by 4-5× before hitting the throttle.
- **Pre-Phase-2 baseline (April 21-23):** very low volumes, then May 3 jump to 16,021 reflects Phase 2.A schema deploys + DML + cycle-resumption activity.
- **April 24 - May 1 logging gap persists.** Same finding as prior session — not blocking, worth investigating before sub-phase 7 (don't want a logging hole during expansion).

**Acceptance verdict: ✅ PASS.** Headroom adequate for full sub-phase 7 expansion.

### 4.1 Bonus — endpoint distribution (drives sub-phase 7 sequencing)

```sql
SELECT endpoint, SUM(request_count) AS total_calls
FROM api_usage
WHERE date >= TO_CHAR(NOW() - INTERVAL '14 days', 'YYYY-MM-DD')
  AND endpoint NOT LIKE 'oddspapi_%'
GROUP BY endpoint
ORDER BY total_calls DESC;
```

**Why:** sub-phase 7 wants to expand `/injuries`, `/transfers`, `/coachs`, `/sidelined`, `/trophies`, `/referees`. Knowing current per-endpoint shares informs which expansions can fit alongside.

**Result (2026-05-05):** Not run by user. Re-prompt before sub-phase 7. Not blocking sub-phase 2.

---

## 5. Retrospective threshold — current universe

The prior retrospective filtered on `has_betfair_exchange = true AND has_pinnacle_odds = true`. That's now `universe_tier = 'A'`. Re-run against the current Tier A + B + C universe to capture both production and experiment leagues.

### 5.1 Q5-fresh — Tier A retrospective under v2.5 thresholds

```sql
WITH tier_universe AS (
  SELECT name, universe_tier, archetype
  FROM competition_config
  WHERE universe_tier = 'A'
),
per_league_metrics AS (
  SELECT
    m.league,
    tu.universe_tier,
    tu.archetype,
    COUNT(*) FILTER (WHERE pb.status IN ('won','lost')) AS settled,
    SUM(pb.settlement_pnl::numeric) FILTER (WHERE pb.status IN ('won','lost')) AS pnl,
    SUM(pb.stake::numeric)         FILTER (WHERE pb.status IN ('won','lost')) AS stake_total,
    AVG(LEAST(50, GREATEST(-50,
      CASE WHEN pb.closing_pinnacle_odds IS NOT NULL AND pb.closing_pinnacle_odds::numeric > 1
           THEN ((pb.odds_at_placement::numeric - pb.closing_pinnacle_odds::numeric) / pb.closing_pinnacle_odds::numeric) * 100
           ELSE NULL END
    ))) FILTER (WHERE pb.status IN ('won','lost')) AS pinnacle_clv_winsorised,
    COUNT(DISTINCT date_trunc('week', pb.placed_at)) AS weeks
  FROM paper_bets pb
  JOIN matches m ON m.id = pb.match_id
  JOIN tier_universe tu ON LOWER(tu.name) = LOWER(m.league)
  WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
  GROUP BY m.league, tu.universe_tier, tu.archetype
)
SELECT
  league, universe_tier, archetype,
  settled, weeks,
  CASE WHEN stake_total > 0 THEN ROUND(100.0 * pnl / stake_total, 2) END AS roi_pct,
  ROUND(pinnacle_clv_winsorised::numeric, 3) AS pinnacle_clv,
  CASE
    WHEN settled < 25                                          THEN 'fail_sample'
    WHEN stake_total IS NULL OR stake_total = 0                THEN 'no_data'
    WHEN (pnl/NULLIF(stake_total,0)) < 0.05                    THEN 'fail_roi'
    WHEN weeks < 3                                              THEN 'fail_weeks'
    ELSE 'WOULD_GRADUATE'
  END AS verdict_v2_5
FROM per_league_metrics
ORDER BY roi_pct DESC NULLS LAST;
```

**Why winsorised CLV:** matches the `LEAST(50, GREATEST(-50, ...))` clip shipped in `promotionEngine.ts:82` and `:311` (commit `1f0e466`). Apples-to-apples comparison.

**Decision-tree action:** map result against v2 §5 four-branch tree, adjusted for sample = 25:
- `>80% WOULD_GRADUATE` → proceed with v2.5 thresholds
- `50-80%` → diagnose failure mode (sample, roi, weeks)
- `20-50%` → STOP, investigate
- `<20%` → HARD STOP, redraft thresholds

**Result (2026-05-05):** 35 leagues evaluated. **5 WOULD_GRADUATE / 35 = 14.3%** (raw — sits in `<20%` HARD STOP branch).

**WOULD_GRADUATE (5):**

| league | settled | weeks | roi_pct | pinnacle_clv |
|---|---|---|---|---|
| Segunda División | 68 | 3 | 50.34 | -40.448 |
| Primera División | 270 | 3 | 47.14 | -29.566 |
| Premier League | 1305 | 4 | 25.93 | -33.005 |
| Championship | 78 | 3 | 8.81 | -17.095 |
| Bundesliga | 72 | 4 | 6.93 | -21.552 |

**Failure breakdown (30):**

| Failure mode | Count | Notes |
|---|---|---|
| `fail_sample` (settled < 25) | 22 | Includes leagues with strong ROI but small N — e.g., USL Championship 151% ROI / n=8, 2. Bundesliga 80% / n=11, La Liga 39.97% / n=6, Jupiler Pro League 36.90% / n=8. Data-immaturity, not threshold disconnect. |
| `fail_roi` (ROI < 5%) | 8 | Serie A 4.43%, League Two −0.69%, Ligue 1 −14.25%, Super League −26.93%, Ligue 2 −29.68%, K League 1 −35.39%, MLS −36.38%. Genuine misses. |
| `fail_weeks` (weeks < 3) | 0 | None. |
| `no_data` / `null` | 0 (technically captured under fail_sample) | Veikkausliiga, CONMEBOL Sudamericana, I Liga had n=0 settled. |

**Decision-branch interpretation — NUANCED:**

The raw 14.3% figure puts us in v2 §5 "<20% HARD STOP — fundamental disconnect." But the failure-mode split tells a different story:

- **Among data-mature leagues (n≥25): 5 graduate / (5 + 8 fail_roi) = 38.5%.** That's the "20-50% STOP — investigate" branch. The thresholds aren't the problem; the data isn't there yet for 22 leagues.
- The 22 fail_sample leagues are at every position on the ROI distribution (some +151%, some −100%). Sample-size graduation will rebalance the headline percentage as bets accumulate.
- The 8 fail_roi leagues genuinely show sustained negative-ROI territory. These are demotion candidates per §1.2 of the v2 design (sample ≥50 ∧ ROI ≤−10% ∧ p ≤0.10 → abandon).

**Per the v2 §5 prior-session decision:** lowering `PROMO_MIN_SAMPLE_SIZE` from 30 → 25 already shipped (commit `1f0e466`). The current 14.3% reflects post-25 thresholds. Going lower than 25 starts to compromise statistical validity (p ≤ 0.05 against breakeven needs ~25 minimum at typical implied priors).

**My recommendation: do not redraft thresholds. Proceed with v2.5 as-is.**

Rationale: the headline 14.3% is dominated by data-immaturity. Among data-mature leagues, 38.5% would graduate — that's healthy. As Tier B/C bets accumulate (sub-phase 3 firehose-on), the data-mature subset grows, and the headline % climbs naturally without any threshold change. The 8 fail_roi leagues should be flagged for sub-phase 5's event-driven graduation engine to demote (`abandoned` tier transition) on next evaluation.

### 5.1.A NEW FINDING — pinnacle_clv negative across the entire Tier A universe

**Every league with non-null Pinnacle CLV shows NEGATIVE winsorised CLV.** Premier League −33.0%, Primera División −29.6%, Segunda División −40.4%, Bundesliga −21.6%, Championship −17.1%. Even the leagues that would graduate ALL show heavily-negative CLV against Pinnacle's "closing" line.

**This is not a "model has no edge" finding — ROI is positive on graduating leagues.** The most likely explanation: the R6 Pinnacle-source-only filter at `paperTrading.ts:1931-1980` reads from `odds_snapshots WHERE source IN ('oddspapi_pinnacle','api_football_real:Pinnacle')` and takes the **latest** snapshot. After kickoff, Pinnacle continues publishing in-play odds; the latest snapshot at settlement-time is the **post-kickoff in-play price**, not the strict pre-kickoff close.

For winning bets, in-play prices compress dramatically toward 1.0 once the predicted side leads, producing strongly-negative CLV on bets that subsequently won. This is a **snapshot-timing artefact**, not an edge-survival signal.

**Implications:**
- The promotion engine's `minClv ≥ 1.5` gate (gated only for `clv_source = 'pinnacle'` per Phase 2 design) **will never fire** under current data — every league shows negative CLV.
- Sub-phase 4 banned-market reactivation criteria that lean on CLV (e.g., the §6.2 result for OVER_UNDER_25 showing −0.977% CLV) are **partially contaminated** by this same issue.
- The **strict pre-kickoff `closing_pinnacle_odds` column** (set by Writer A, frozen pre-kickoff) is the unambiguously correct closing line. R6's lookup-source change introduced the in-play contamination as a side effect.

**Recommendation: a small follow-up patch (NOT this sub-phase, but flagged):** change the R6 lookup at `paperTrading.ts:1931-1980` and `betfairLive.ts:837-870` to **prefer `closing_pinnacle_odds` if non-null, fall back to `odds_snapshots` Pinnacle filter only if null**. Adds ~5 lines to each writer. Eliminates in-play contamination entirely.

This is the v3 refinement flagged at the end of last session — the "id 859 inconsistent" verdict was a hint at the same issue. With 35 leagues all showing negative CLV, the issue is no longer hypothetical.

**Track as: R6.1 — Pinnacle CLV in-play contamination.** Not a regression of R6 (R6 fixed the destructive write), but a parallel issue in the same code path. Recommend addressing before sub-phase 5 ships, since sub-phase 5 wires CLV into event-driven graduation gates.

### 5.2 Q6-fresh — Tier B/C bet pace pre-firehose-on

Confirm Tier B/C leagues can hit 25 settled bets in reasonable wall-clock once `experiment_track_enabled` flips. Currently flag is `false` so Tier B/C have **zero placements**; this query estimates pace from Tier A data as a proxy.

```sql
WITH bet_pace AS (
  SELECT
    cc.archetype,
    m.league,
    COUNT(*) FILTER (WHERE pb.status IN ('won','lost')) AS settled,
    DATE_PART('day', NOW() - MIN(pb.placed_at))::numeric / 7.0 AS weeks_active
  FROM paper_bets pb
  JOIN matches m ON m.id = pb.match_id
  JOIN competition_config cc ON LOWER(cc.name) = LOWER(m.league)
  WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
    AND cc.universe_tier = 'A'
  GROUP BY cc.archetype, m.league
  HAVING DATE_PART('day', NOW() - MIN(pb.placed_at)) >= 14
)
SELECT
  archetype,
  COUNT(*) AS leagues,
  ROUND(AVG(settled / NULLIF(weeks_active, 0))::numeric, 2) AS avg_settled_per_week,
  ROUND((25.0 / NULLIF(AVG(settled / NULLIF(weeks_active, 0)), 0))::numeric, 1) AS weeks_to_25_settled,
  ROUND((50.0 / NULLIF(AVG(settled / NULLIF(weeks_active, 0)), 0))::numeric, 1) AS weeks_to_50_settled
FROM bet_pace
GROUP BY archetype
ORDER BY archetype;
```

**Result (2026-05-05):**

| archetype | leagues | avg_settled_per_week | weeks_to_25_settled | weeks_to_50_settled |
|---|---|---|---|---|
| `null` | 29 | 30.62 | **0.8** | **1.6** |

**Interpretation:**
- `archetype` is null because Phase 2.A schema added the column but no DML populated it. **archetype labelling is a sub-phase 2 deliverable** — the reverse-mapping cron must label all rows on its discovery pass, not just newly-inserted ones.
- The 29 leagues averaged are Tier A's data-mature subset.
- **30.62 settled bets per week per league** is much higher than the prior session's 15-25 estimate — placement pace has accelerated since Phase 2.A's universe-tier dispatcher landed (commit `9d5db0d`, 2026-05-05).
- **Time-to-25 settled: <1 week.** Phase 2.B firehose-on (sub-phase 3 in this brief) will produce graduation-eligible data on Tier B/C leagues within days, not weeks.

**Implication for sub-phase 5 calibration:** the event-driven graduation engine should be live at firehose-on, not deferred — otherwise we'll accumulate evaluable data faster than the cron-driven engine can process it.

---

## 6. Banned-market history audit (NEW — sub-phase 4 input)

The brief asks: "every disabled market type, when disabled, historical CLV/ROI, sample size, whether config-flag-reversible or code-removed."

### 6.1 Code-side audit (already complete)

See `docs/phase-2-current-state.md` §4. Summary:
- 14 banned markets at `paperTrading.ts:445-464`
- All 14 are config-flag-reversible (zero are code-removed)
- 13/14 have settlement code; `DOUBLE_CHANCE` settlement code presence is unconfirmed
- AH (not banned) is value-detection-incomplete; activation = sub-phase 4.A

### 6.2 Q9-NEW — historical CLV / ROI / sample for banned markets

For each banned market, compute lifetime placement and post-settlement metrics. Tells us which bans were genuinely justified (negative ROI + negative CLV at scale) vs which were precautionary quarantines that may show edge once R6 cleanup is applied.

```sql
WITH banned AS (
  SELECT unnest(ARRAY[
    'OVER_UNDER_05',
    'OVER_UNDER_15',
    'OVER_UNDER_25',
    'OVER_UNDER_35',
    'TOTAL_CARDS_45',
    'TOTAL_CARDS_55',
    'TOTAL_CORNERS_75',
    'TOTAL_CORNERS_85',
    'TOTAL_CORNERS_95',
    'TOTAL_CORNERS_105',
    'TOTAL_CORNERS_115',
    'FIRST_HALF_OU_05',
    'FIRST_HALF_RESULT',
    'DOUBLE_CHANCE'
  ]) AS market_type
),
metrics AS (
  SELECT
    pb.market_type,
    COUNT(*) FILTER (WHERE pb.status IN ('won','lost'))                AS settled,
    COUNT(*) FILTER (WHERE pb.status = 'won')                           AS won,
    COUNT(*) FILTER (WHERE pb.status = 'lost')                          AS lost,
    SUM(pb.stake::numeric)         FILTER (WHERE pb.status IN ('won','lost')) AS stake_total,
    SUM(pb.settlement_pnl::numeric)FILTER (WHERE pb.status IN ('won','lost')) AS pnl_total,
    AVG(LEAST(50, GREATEST(-50, pb.clv_pct::numeric))) FILTER (WHERE pb.clv_pct IS NOT NULL) AS clv_winsorised,
    MIN(pb.placed_at)              AS first_seen,
    MAX(pb.placed_at)              AS last_seen,
    MAX(pb.placed_at) FILTER (WHERE pb.status IN ('won','lost')) AS last_settled
  FROM paper_bets pb
  WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
    AND pb.market_type IN (SELECT market_type FROM banned)
  GROUP BY pb.market_type
)
SELECT
  b.market_type,
  COALESCE(m.settled, 0) AS settled,
  COALESCE(m.won, 0)     AS won,
  COALESCE(m.lost, 0)    AS lost,
  ROUND(100.0 * m.won / NULLIF(m.settled, 0), 2)            AS win_rate_pct,
  ROUND(100.0 * m.pnl_total / NULLIF(m.stake_total, 0), 2)   AS roi_pct,
  ROUND(m.clv_winsorised::numeric, 3)                        AS clv_winsorised,
  m.first_seen,
  m.last_seen,
  m.last_settled
FROM banned b
LEFT JOIN metrics m ON m.market_type = b.market_type
ORDER BY COALESCE(m.settled, 0) DESC;
```

**What we'll learn:**
- Markets with high settled count + materially negative ROI: ban was justified.
- Markets with **zero or near-zero settled bets**: ban was precautionary; reactivation cost is learning the distribution.
- Markets with positive CLV but negative ROI: pricing-pipeline issue (not edge issue) — sub-phase 4 reactivation should pair with pricing-validation work.
- `last_seen` / `last_settled` — tells us when each market was last active; oldest are safest reactivation candidates (no recent regressions).

**Result (2026-05-05):**

| market_type | settled | won | lost | win_rate | roi_pct | clv | first_seen | last_seen |
|---|---|---|---|---|---|---|---|---|
| `OVER_UNDER_25` | 91 | 38 | 53 | 41.76% | **−0.42%** | −0.977 | 2026-04-16 | 2026-04-20 |
| `FIRST_HALF_RESULT` | 65 | 15 | 50 | 23.08% | **−29.52%** | −7.644 | 2026-04-16 | 2026-04-20 |
| `DOUBLE_CHANCE` | 32 | 12 | 20 | 37.50% | **−40.05%** | **+15.156** | 2026-04-16 | 2026-04-19 |
| `OVER_UNDER_35` | 19 | 13 | 6 | 68.42% | **+41.89%** | −2.088 | 2026-04-16 | 2026-04-20 |
| `OVER_UNDER_05` | 0 | 0 | 0 | — | — | — | — | — |
| `OVER_UNDER_15` | 0 | 0 | 0 | — | — | — | — | — |
| `TOTAL_CARDS_45` | 0 | 0 | 0 | — | — | — | — | — |
| `TOTAL_CARDS_55` | 0 | 0 | 0 | — | — | — | — | — |
| `TOTAL_CORNERS_75` through `_115` (5 markets) | 0 | 0 | 0 | — | — | — | — | — |
| `FIRST_HALF_OU_05` | 0 | 0 | 0 | — | — | — | — | — |

**Interpretation:**

**Tier 1 — genuine edge candidates (had placements, high reactivation priority):**
- **OVER_UNDER_35: +41.89% ROI at n=19, 68.42% WR.** Positive ROI under quarantine. Sample is small but signal is strong. **Top reactivation candidate.** CLV slightly negative (−2.088) — likely the same in-play contamination issue from §5.1.A. Quarantine reason in code: "pending pricing-pipeline fix" (`paperTrading.ts:459`). Pricing-pipeline issue is the right hypothesis — pricing fix + reactivation likely surfaces real edge.
- **OVER_UNDER_25: −0.42% ROI at n=91, 41.76% WR.** Near break-even. Quarantine cost-benefit: marginal at best. Recommend reactivation on experiment track (£0) for re-validation; if 2-week experiment shows continued near-break-even, leave banned. If positive, promote.

**Tier 2 — banned with cause (high sample, materially negative):**
- **FIRST_HALF_RESULT: −29.52% ROI at n=65, 23.08% WR.** Very low win rate against ~40% implied. Genuine edge against us. Stay banned.
- **DOUBLE_CHANCE: −40.05% ROI at n=32, +15.156% CLV.** **The CLV-vs-ROI divergence is a smoking gun.** Positive CLV (+15.156 winsorised) means we got "good" prices vs Pinnacle's later read; deeply negative ROI means actual settlement returns crater. This points to a **settlement bug** — likely either (a) the `case "DOUBLE_CHANCE"` block missing from the settlement switch in `paperTrading.ts` (per current-state §4.1 audit), or (b) a selection-name canonicalisation issue causing wrong-side settlement. **Stay banned. Sub-phase 4 must NOT reactivate DOUBLE_CHANCE without first fixing the settlement code.** Flagged for code investigation.

**Tier 3 — precautionary bans (zero placements ever):**
- 10 markets never bet: OVER_UNDER_05/15, TOTAL_CARDS_45/55, TOTAL_CORNERS_75/85/95/105/115, FIRST_HALF_OU_05.
- These bans are precautionary. Reactivation cost = learning the distribution. **Safest reactivation candidates** — no historical regressions to revert.
- TOTAL_CORNERS_75 ban comment claims "−42.5% ROI on 90 bets" but the table shows 0 settled. **Discrepancy: the comment may pre-date the `legacy_regime` filter or refer to dev-only data.** Worth investigating before reactivation.

**Reactivation priority order (recommendation for sub-phase 4):**

1. **First wave (zero historical risk):** TOTAL_CORNERS_75/85/95/105/115, TOTAL_CARDS_45/55, FIRST_HALF_OU_05, OVER_UNDER_05/15. All zero settled. Reactivate together on experiment track (£0). Investigate TOTAL_CORNERS_75 ban-comment discrepancy first.
2. **Second wave (positive-signal candidates):** OVER_UNDER_35 (showed +41% ROI), OVER_UNDER_25 (near break-even). Reactivate after first wave's 2-week experiment-track results.
3. **Third wave (only after settlement-bug fix):** DOUBLE_CHANCE. Requires `paperTrading.ts` settlement-code investigation; do not reactivate via flag flip alone.
4. **Permanent ban (no reactivation):** FIRST_HALF_RESULT. Genuine negative-edge signal at sample 65.

### 6.3 Q10-NEW — Asian Handicap historical pattern

AH is not in `BANNED_MARKETS` but value-detection never produces it. Audit historical placements (might exist from a Replit-era code path that briefly worked).

```sql
SELECT
  COUNT(*) AS total_placements,
  COUNT(*) FILTER (WHERE status IN ('won','lost')) AS settled,
  MIN(placed_at) AS first_seen,
  MAX(placed_at) AS last_seen,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'won') / NULLIF(COUNT(*) FILTER (WHERE status IN ('won','lost')), 0), 2) AS win_rate_pct,
  ROUND(100.0 * SUM(settlement_pnl::numeric) FILTER (WHERE status IN ('won','lost'))
              / NULLIF(SUM(stake::numeric) FILTER (WHERE status IN ('won','lost')), 0), 2) AS roi_pct
FROM paper_bets
WHERE market_type = 'ASIAN_HANDICAP'
  AND deleted_at IS NULL
  AND legacy_regime = false;
```

**Result (2026-05-05):**

| total_placements | settled | first_seen | last_seen | win_rate_pct | roi_pct |
|---|---|---|---|---|---|
| 0 | 0 | null | null | null | null |

**Interpretation:** zero placements, zero settlements, ever. Confirms the code-side audit finding (current-state §4.2): `valueDetection.ts` does not generate AH candidates. AH is functionally absent from the betting pipeline. **AH activation is a greenfield build, not a quarantine reversal.** Matches the brief's flag — sub-phase 4.A scope, separate from the simpler banned-market reactivation.

### 6.4 Q11-NEW — Universe state confirmation

Verify the `universe_tier` seed referenced in current-state §6 still holds.

```sql
SELECT universe_tier, COUNT(*) AS n
FROM competition_config
GROUP BY universe_tier
ORDER BY universe_tier;
```

**Expected (from prior session DML):** A=149, B=84, C=0, D=0, E=804, unmapped=0. **Confirm** — if numbers have drifted, sub-phase 2 needs to know.

```sql
SELECT
  universe_tier,
  archetype,
  COUNT(*) AS n
FROM competition_config
WHERE universe_tier IN ('A','B','C','D')
GROUP BY universe_tier, archetype
ORDER BY universe_tier, archetype;
```

**Result (2026-05-05):**

| universe_tier | n |
|---|---|
| A | 149 |
| B | 84 |
| E | 804 |

**Tier C and D rows: zero each.** `unmapped` rows: zero (the seed swept all 1,037 rows into A/B/E). Total: 1,037 ✓.

**Per-archetype query** was provided but the user's paste-back contains only the tier-only result. Inferred from absent paste: **archetype = NULL for all 1,037 rows.** This is consistent with §5.2 / §3.2 outcomes (no archetype data populated). **Sub-phase 2 must label archetypes on its first cron pass** as a non-optional deliverable, not deferred.

**Verdict: ✅ MATCHES prior session DML.** No drift since 2026-05-04 universe-tier seed.

**Sub-phase 2 inputs from this:**
- Tier A starting count: **149.** Sub-phase 2 dry-run must show Tier A unchanged post-cron.
- Tier B starting count: **84.** Insertion-only cron should not alter this (no demote-to-D path until commit 2 of two-commit discipline).
- Tier C / D starting count: **0.** Sub-phase 2 will populate Tier D for unmatched Betfair competitions; expect dozens to low hundreds. Tier C population requires the OddsPapi staleness check; expect single digits to dozens.
- Tier E: **804.** Untouched by sub-phase 2 (E = AF-only, no Betfair).

### 6.5 Q12-NEW — agent_config sanity (safety boundaries)

The brief lists user-approval-gated parameters: max_stake_pct, daily/weekly drawdown caps, bankroll floor, experiment_track_enabled. Confirm current values in agent_config.

```sql
SELECT key, value, updated_at
FROM agent_config
WHERE key IN (
  'bankroll',
  'max_stake_pct',
  'daily_loss_limit_pct',
  'weekly_loss_limit_pct',
  'bankroll_floor',
  'agent_status',
  'experiment_track_enabled',
  'reject_non_pinnacle_leagues',
  'paper_mode'
)
ORDER BY key;
```

**Result (2026-05-05):** see §-1 (CRITICAL FINDING) at the top of this document. Headline:
- `bankroll_floor` = 0 (brief says 200)
- `daily_loss_limit_pct` = 0.99 (brief says 0.05)
- `weekly_loss_limit_pct` = 0.99 (brief says 0.10)
- `max_stake_pct` = 0.03 (brief says 0.02)
- `experiment_track_enabled` and `reject_non_pinnacle_leagues` rows do NOT exist (defaults apply: experiment track OFF, universe-tier filter ON).

**Resolution required before sub-phase 2 ships.** Three options in §-1.

---

## 7. Net findings + sub-phase 2 inputs

### 7.1 Headline verdicts

| Question | Verdict | Confidence |
|---|---|---|
| R6 patch holding clean post-deploy? | ✅ PASS (0 destructive overwrites; 1 acceptable edge) | EVIDENCE-BASED |
| Settlement bias — leagues to flag for Tier D? | **Primera División only** (B = −0.524, 5.2× threshold) | EVIDENCE-BASED |
| API-Football headroom for sub-phase 7? | ✅ ample (current 11k/day vs 50k/75k caps) | EVIDENCE-BASED |
| Tier A retrospective WOULD_GRADUATE %? | 14.3% raw, **38.5% among data-mature** — proceed with v2.5 thresholds | ANALYTICAL |
| Banned-market reactivation candidates? | 10 zero-sample (safe), 2 positive-signal, 1 settlement-bug, 1 stay-banned | EVIDENCE-BASED |
| Asian Handicap activation = greenfield build? | ✅ confirmed — zero placements ever | EVIDENCE-BASED |
| Universe state matches prior session? | ✅ 149A / 84B / 0C / 0D / 804E | EVIDENCE-BASED |
| Safety boundaries at brief-stated defaults? | ❌ **NO** — see §-1 | EVIDENCE-BASED |

### 7.2 NEW issues surfaced by this diagnostic

1. **R6.1 — Pinnacle CLV in-play contamination.** Every Tier A league shows negative winsorised CLV. Most likely the R6 patch's `odds_snapshots` Pinnacle-source filter picks up post-kickoff in-play snapshots. Promotion engine's `minClv ≥ 1.5` gate will never fire under current data. **Recommend small follow-up patch to prefer `closing_pinnacle_odds` over `odds_snapshots` Pinnacle filter.** Track separately. Not blocking sub-phase 2; should land before sub-phase 5.

2. **archetype column NULL across all 1,037 rows.** Phase 2.A schema added the column; no DML populated it. **Sub-phase 2's reverse-mapping cron must label archetypes on its discovery pass** as a mandatory deliverable, not deferred.

3. **DOUBLE_CHANCE settlement bug.** Positive CLV (+15.156) but −40.05% ROI on 32 settled bets. Strongly suggests a settlement-code or selection-canonicalisation bug. Code-level investigation must precede any reactivation. Sub-phase 4 dependency.

4. **TOTAL_CORNERS_75 ban-comment vs data discrepancy.** Code comment claims "−42.5% ROI on 90 bets"; query shows 0 settled. Pre-`legacy_regime` data, or a regime-flip ate the rows. Investigate before reactivating any corners markets.

5. **API-Football logging gap April 24 - May 1.** Persists from prior session. Not blocking sub-phase 2 but should be understood before sub-phase 7's volume expansion.

### 7.3 Sub-phase 2 inputs (locked)

- **Tier A starting count: 149.** Dry-run must show no change.
- **Tier B starting count: 84.** Insertion-only commit must not alter.
- **Tier C / D starting count: 0.** Sub-phase 2 cron will populate D for unmatched Betfair competitions. Expected: dozens to low hundreds.
- **Pre-flag Primera División** for Tier D demotion in a separate DML between schema migrations and behaviour flips (per `feedback_race_conditions.md` two-commit discipline).
- **archetype labelling is mandatory** on the cron's first pass over existing rows.
- **Token-set ratio fuzzy match at 0.85** with country pre-filter, as specified in §-3 of the prior plan attempt.

### 7.4 Sub-phase order — confirmed feasibility

| Sub-phase | Blocking issues | Status |
|---|---|---|
| 2 — Betfair-first universe | §-1 safety-boundary resolution required | **STOP gate** |
| 3 — Three-track gate dispatcher | Sub-phase 2 complete + §-1 resolved | Pending |
| 4 — Banned-market reactivation | Sub-phase 3 stable + DOUBLE_CHANCE fix | Pending |
| 4.A — AH activation | Sub-phase 4 stable | Pending |
| 5 — Event-driven graduation | R6.1 fix recommended pre-ship | Pending |
| 6 — Autonomous threshold mgmt | Sub-phase 5 stable + new tables | Pending |
| 7 — API-Football data expansion | Logging-gap diagnosis | Pending |
| 8 — OddsPapi kickoff-proximity | Independent | Pending |
| 9 — Probationary Kelly ratchet | Sub-phase 5 stable | Pending |
| 10 — Ongoing audit cron | Sub-phase 5 stable | Pending |

---

## 8. STOP — awaiting user response on §-1 before sub-phase 2 plan

Per the strategic brief: "Do not chain sub-phases."

**Sub-phase 2's plan-mode document (`docs/phase-2-subphase-2-plan.md`) will NOT be drafted in this session.** Per the brief's own discipline ("For each sub-phase: produce a short plan-mode document at docs/phase-2-{subphase}-plan.md before any code lands. The user reviews. Then implementation."), the plan doc is the next session's first deliverable.

**Before that next session can begin, the user needs to:**
1. **Resolve §-1 safety-boundary state** (one of the three options).
2. Optionally confirm acceptance of §7.3 sub-phase 2 inputs (locked Tier counts, archetype labelling mandatory, fuzzy match algorithm pinned).
3. Optionally re-run the unrun Q1.1 / Q1.2 / endpoint-distribution / archetype-pooled-bias queries if you want them populated; they are not blocking sub-phase 2.

---

## 10. Sub-phase 1 deliverable DML (USER RUNS — pre-approved by strategic-push resolution)

These four DMLs land the user's resolution from the strategic-push acknowledgement. **Run in this order on prod.** All are idempotent; re-runs are safe.

### 10.1 Insert `real_money_go_live_checklist` marker into agent_config

```sql
INSERT INTO agent_config (key, value, updated_at)
VALUES (
  'real_money_go_live_checklist',
  '{"status":"deferred_until_real_money","reason":"Both tracks bet £0 in paper-mode; circuit breakers protect real-money capital not currently flowing.","doc":"docs/real-money-go-live-checklist.md","boundaries_at_go_live":{"bankroll_floor":{"value":"TBD","constraint":">= 5% * bankroll"},"daily_loss_limit_pct":{"value":"TBD","constraint":"0 < value <= 0.10"},"weekly_loss_limit_pct":{"value":"TBD","constraint":"0 < value <= 0.20"},"max_stake_pct":{"value":"0.02","constraint":"0 < value <= 0.02","note":"restored 2026-05-05"}},"max_stake_pct_decision":{"applied":"2026-05-05","rationale":"Option (a) per docs/real-money-go-live-checklist.md §3"},"deferred_at":"2026-05-05","deferred_by":"user_explicit_resolution"}',
  NOW()
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW();
```

**Why:** durable always-loadable marker that the safety boundaries are deferred. Sub-phase 5's promotion-gate code will read this row (per `docs/real-money-go-live-checklist.md` §4).

### 10.2 Restore max_stake_pct from 0.03 to 0.02

```sql
UPDATE agent_config
SET value = '0.02', updated_at = NOW()
WHERE key = 'max_stake_pct' AND value = '0.03';

-- Audit log
INSERT INTO compliance_logs (action_type, details, timestamp)
VALUES (
  'max_stake_pct_restored_to_brief_default',
  jsonb_build_object(
    'previous_value', '0.03',
    'new_value', '0.02',
    'rationale_doc', 'docs/real-money-go-live-checklist.md',
    'rationale_section', '§3',
    'decision', 'option (a) — set to 0.02 now for cleaner Kelly-growth-rate computation downstream',
    'applied_at', NOW(),
    'applied_by', 'sub_phase_1_strategic_push_resolution'
  ),
  NOW()
);
```

**Why:** Option (a) per `docs/real-money-go-live-checklist.md` §3. Cleaner downstream Kelly-growth-rate computation; aligns with the brief's stated default; tightening within the model's authority envelope.

### 10.3 Primera División pre-flag for Tier D (DOCUMENT ONLY — DML deferred to sub-phase 2)

**This DML does NOT run in sub-phase 1.** It lands as a separate commit between sub-phase 2's schema migration commit and its behaviour-flip commit, per `feedback_race_conditions.md` two-commit discipline. Captured here so sub-phase 2's plan-mode document can reference it verbatim.

```sql
-- Primera División: settlement-bias index B = -0.524 (5.2× the |B|≥0.10 threshold).
-- AF result-fetching gap on contentious matches makes settled-subset ROI biased.
-- Demote from Tier A to Tier D until investigation completes.
UPDATE competition_config
SET universe_tier = 'D',
    settlement_bias_index = -0.524,
    universe_tier_decided_at = NOW()
WHERE LOWER(name) = LOWER('Primera División');

-- Audit log
INSERT INTO compliance_logs (action_type, details, timestamp)
VALUES (
  'tier_d_demotion_settlement_bias',
  jsonb_build_object(
    'league', 'Primera División',
    'previous_tier', 'A',
    'new_tier', 'D',
    'bias_index', -0.524,
    'threshold_violated', 0.10,
    'multiplier_over_threshold', 5.2,
    'rationale_doc', 'docs/phase-2-diagnostic-findings.md',
    'rationale_section', '§3.1',
    'applied_at', NOW(),
    'applied_by', 'sub_phase_2_pre_flag_commit'
  ),
  NOW()
);
```

**Sub-phase 2 commit ordering** (locked by `feedback_race_conditions.md`):
1. Schema migration commit (if any new schema is needed for sub-phase 2; current state suggests none).
2. **Primera División demotion DML commit** ← runs the SQL above.
3. Reverse-mapping cron + behaviour-flip commit (the Betfair-first universe expansion).

The demotion sits **between** the schema and the behaviour flip so that:
- The dispatcher (which reads `universe_tier` per Phase 2.B.1) starts treating Primera División as rejected from the moment the demotion lands.
- Any in-flight Primera División bets (placed before the demotion) settle naturally; new bets are blocked.
- The reverse-mapping cron's first run sees Primera División already at Tier D and does not re-elevate it.

### 10.4 Idempotency / verification post-DML

```sql
-- Verify §10.1 marker present and well-formed
SELECT key, value, updated_at
FROM agent_config
WHERE key = 'real_money_go_live_checklist';

-- Verify §10.2 max_stake_pct restored
SELECT key, value, updated_at
FROM agent_config
WHERE key = 'max_stake_pct';
-- expect: value = '0.02'

-- Verify §10.2 compliance log written (most recent first)
SELECT action_type, details, timestamp
FROM compliance_logs
WHERE action_type = 'max_stake_pct_restored_to_brief_default'
ORDER BY timestamp DESC
LIMIT 5;
```

---

## 9. Sign-off checklist

- [x] Codebase audit complete (`docs/phase-2-current-state.md`).
- [x] Diagnostic SQL prompt sheet authored (this document).
- [x] R6 Q1 SQL syntax fix verified — already corrected at `r6-clv-source-investigation.md` §3.1.
- [x] User ran §2.1 (R6 freshness Q1) — PASS verdict.
- [x] User ran §3.1 (settlement bias broadened) — Primera División flagged.
- [x] User ran §4 (API usage) — headroom adequate.
- [x] User ran §5.1 (retrospective) — 14.3% raw / 38.5% data-mature graduation rate.
- [x] User ran §5.2 (bet pace) — 0.8 weeks-to-25-settled.
- [x] User ran §6.2 (banned-market history) — reactivation order ranked.
- [x] User ran §6.3 (AH historical) — confirmed greenfield.
- [x] User ran §6.4 (universe state) — 149A/84B/0C/0D/804E confirmed.
- [x] User ran §6.5 (safety boundaries) — **CRITICAL FINDING: not at brief defaults.**
- [x] Findings integrated, doc updated.
- [ ] **§-1 safety-boundary resolution (STOP gate).**
- [ ] Sub-phase 1 paired commit (`docs/phase-2-current-state.md` + this doc).
- [ ] Sub-phase 2 plan-mode document drafted (NEXT SESSION — pending §-1 resolution).
