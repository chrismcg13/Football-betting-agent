# Bundle 2C — Kelly Sizing & Cap-Lift Framework

**Status:** Analysis complete (2026-05-16). Framework implementation deferred until Bundle 1N is verified.
**Edge category (per `feedback_edge_is_prime_directive`):** MAXIMISE — turns proven calibration into more growth without taking on catastrophic drawdown.
**Money guardrail:** All cap changes require operator commit per P4. Framework proposes; operator decides.

---

## 1 — Background

The `max_stake_pct = 0.02` cap has been doing two jobs simultaneously since paper-cutover:

1. **Genuine risk budget** — prevents catastrophic per-bet loss.
2. **Hidden calibration shrinkage** — papers over the model's over-confident raw probabilities (which want ~8.4% avg stake before Bundle 1N).

Bundle 1M (MO fix) + Bundle 1N (hierarchical Bayes per-league calibration) take over job #2 properly. Once 1N is verified, the cap is freed to do its real job: risk budget. This document captures the analysis behind the gated cap-lift framework that takes advantage of that.

---

## 2 — Empirical data (shadow corpus, 2026-05-03 → 2026-05-16, n=11,246 settled bets)

### 2.1 Per-bet log-growth by opportunity-score band

| opp_band | n | avg log-growth/bet at K=0.25 + cap=0.02 | % capped |
|---|---:|---:|---:|
| 90+ | 927 | 0.01031 | 96.7% |
| 80-89 | 713 | 0.00985 | 91.0% |
| 70-79 | 1,238 | 0.01030 | 82.1% |
| 60-69 | 1,764 | 0.00962 | 89.2% |
| 50-59 | 2,304 | 0.01024 | 90.5% |
| <50 | 4,300 | 0.00377 | 70.5% |

**Reading:** per-bet log-growth is essentially flat across opp_bands ≥50 once the cap binds. Concentration of capital in high-opp bets does NOT improve per-bet growth at current cap.

### 2.2 Wilson lo95 on capped vs uncapped bets

| Cohort | n | win rate | Wilson lo95 | avg flat ROI per unit |
|---|---:|---:|---:|---:|
| Would have been capped (raw stake > 0.02) | 9,251 | 56.23% | **55.22%** | +49.05% |
| Would NOT have been capped (raw stake ≤ 0.02) | 1,995 | 40.45% | 38.32% | +3.15% |

**Reading:** the bets the cap is mechanically downsizing are the ones with statistically validated edge (Wilson lo95 >> 50%). The cap is mechanically capping precisely where edge is real.

### 2.3 Cap-binding rate, pre vs post Bundle 1N

(Post-1N modelled by shrinking p_raw 60% toward p_implied — proxy for hierarchical-Bayes shrinkage observed on MO post-1M: raw 0.85 → calibrated 0.38.)

| State | Cap | Avg raw stake intent | % bets at cap |
|---|---:|---:|---:|
| Pre-1N | 0.02 | 8.36% | **82.3%** |
| **Post-1N** | **0.02** | **3.34%** | **59.2%** |
| Post-1N | 0.04 | 3.34% | 33.6% |
| Post-1N | 0.10 | 3.34% | 0.0% |

**Reading:** Bundle 1N reduces the model's avg raw stake intent from 8.36% → 3.34% (calibration honestly tamps down over-confidence). The cap stops being a constant constraint and becomes a real risk-budget tool.

### 2.4 Total log-growth and max drawdown, multiple cap × K combinations

| Scenario | 13d log-growth | vs baseline | Max drawdown | Notes |
|---|---:|---:|---:|---|
| **baseline: K=0.25 + cap=0.02** | 86.1 | 1.0× | **49.0%** | Current state |
| Post-1N: K=0.25 + cap=0.04 (extrapolated) | ~160 | ~1.9× | ~55-60% | Recommended first lift target |
| Post-1N: K=0.25 + cap=0.05 (extrapolated) | ~200 | ~2.3× | ~60-65% | Recommended second lift target |
| Post-1N: K=0.25 + no cap | 251.2 | **2.9×** | 62.9% | Tolerable but pushes the envelope |
| Post-1N: K=0.50 + no cap | 452.9 | 5.3× | **87.7%** | Near-ruin DD — disqualified |
| Pre-1N: K=0.25 + no cap | 539.0 | 6.3× | **93.3%** | Catastrophic — disqualified |
| Pre-1N: K=0.50 + no cap | 847.7 | 9.8× | **99.9%** | Bankroll wiped — disqualified |

**Reading:**
- Pre-1N + no cap = bankroll death. The cap's job #2 (papering over miscalibration) is what's keeping this safe today.
- Post-1N + K=0.25 + raised-cap path is the growth + safety frontier.
- K=0.50 disqualifies on drawdown math at every cap level worth considering. Per fractional-Kelly theory, K=0.5 doubles per-bet variance for 1.5× growth — below the breakeven.

---

## 3 — Decisions

### 3.1 K stays at 0.25, permanently

The narrow-vs-broad analysis is unambiguous: at all cap levels, K=0.25 broad (opp_score ≥ 50) beats K=0.50 narrow (opp_score ≥ 80) by ~5× growth because volume × cap-bound stake dominates per-bet edge concentration. Moving K above 0.25 also crosses the drawdown-acceptance threshold.

**Do not touch K. K=0.25 is the answer.**

### 3.2 Cap stays at 0.02 until Bundle 1N is verified

Pre-1N, the cap is doing job #2 (miscalibration shrinkage). Removing or raising it now would be removing a load-bearing wall before the replacement is in place.

### 3.3 Post-1N, cap lifts on a DATA-GATED schedule, never calendar-gated

No "T+14d" or "T+30d" cap reviews. Cap moves through 0.02 → 0.04 → 0.05 → review based on rolling-window evidence accumulating from settled bets. This is the framework spec in §4.

---

## 4 — Graduated Cap-Lift Framework (the permanent monitoring layer)

Cap moves through steps **0.02 → 0.04 → 0.05 → review**. Each step requires BOTH gates to pass on a rolling window of ≥300 settled bets since the last cap change.

### 4.1 GATE A — Calibration evidence (per market_type)

All four must hold on the rolling window since the last cap change:

- **CLV slope Wilson lo95 ≥ +0.5** — CLV is positive and statistically separated from zero (the Bundle 1C.1 audit produces this number per market_type)
- **Median per-league ECE on active hierarchical buckets ≤ 0.15** — calibration is well-behaved, no per-league bucket is firing miscalibrated stakes
- **n_settled since last cap change ≥ 300** — sufficient sample to trust the slope/ECE measurements
- **No regime alarm fired in the rolling window** — `data_quality_alerts` for regime drift is clean

### 4.2 GATE B — Drawdown headroom (portfolio-wide)

All three must hold:

- **Realised max drawdown since last cap change ≤ 70% of theoretical max DD at current cap** — material headroom remains before hitting psychological pain threshold
- **No daily 10% / weekly 20% kill switch trip** in the rolling window
- **Stake-weighted realised ROI ≥ 0%** — model is at least breaking even on the recent window; do not scale into a losing trend

### 4.3 LIFT TRIGGER

Both gates pass on a rolling window of ≥300 settled bets since the last cap change → cap lifts by one step. Operator commits the change via Neon UPDATE on `agent_config.max_stake_pct`. **Framework proposes; operator decides.** P4 unchanged.

### 4.4 HOLD TRIGGER

Either gate fails → cap holds at current step. No lift, no demotion. Re-evaluate when the next 100 bets settle.

### 4.5 DEMOTION TRIGGER (autonomous safety)

If at any cap step the realised drawdown exceeds 75% of theoretical max DD at that cap, OR a kill switch trips, OR median ECE deteriorates by >0.05 from the last cap change → cap auto-reverts by one step and flags for operator review. **Autonomous because it pulls risk down, not up.**

### 4.6 Ceiling

**0.05 is a hard ceiling on automatic lifts.** Any move beyond 0.05 requires an explicit operator design decision, not the framework. This is the boundary where fractional-Kelly theory says additional growth no longer justifies additional variance for our edge profile.

---

## 5 — Implementation (Bundle 2C, ships AFTER Bundle 1N is verified)

### 5.1 New nightly job — `capLiftEvaluator.ts`

Reads current cap from `agent_config.max_stake_pct`. Computes Gate A and Gate B on rolling window since last cap change. Decides one of **LIFT / HOLD / DEMOTE / FLAG**.

### 5.2 Audit log — `compliance_logs.cap_lift_evaluation`

Every nightly recompute writes one row per market_type AND one portfolio-wide row. Captures gate inputs, gate outputs, recommendation. Operator can replay the decision trail at any time.

### 5.3 Operator surface — `v_cap_lift_status` view

Shows current cap, gates passing/failing, bets settled since last change, estimated next decision point. Operator reads this when making the call to lift.

### 5.4 LIFT action

Job *proposes*. Operator commits via:

```sql
UPDATE agent_config SET value = '0.04' WHERE key = 'max_stake_pct';
-- (then bounce api-server to flush cache)
```

### 5.5 DEMOTE action

Autonomous. Job UPDATEs `agent_config.max_stake_pct` directly to the prior step. Writes `compliance_logs.cap_demotion` row. Notifies operator. Reasoning: this is risk pulling DOWN, which always honours P4's spirit even when written autonomously.

---

## 6 — Guardrails

- **G1.** Cap lifts require operator commit. The framework proposes; operator decides. P4 unchanged.
- **G2.** Cap demotions are autonomous safety. No operator needed to pull the lever down.
- **G3.** K multiplier stays at 0.25. Do NOT touch K. The narrow-vs-broad analysis confirms K=0.25 broad is optimal at all cap levels; K=0.50 disqualifies on drawdown math.
- **G4.** 0.05 is a hard ceiling on the gated path. Anything beyond requires an explicit operator design decision, not the framework.

---

## 7 — Caveats on the underlying analysis

1. **Shadow data has zero slippage.** Real cash trading absorbs some growth between shadow simulation and live realisation.
2. **13-day sample is short for drawdown analysis.** One bad week could shift the picture. The framework's rolling-window approach handles this by requiring ≥300 fresh bets per cap-change decision.
3. **The 0.6 shrinkage proxy for post-1N** is an estimate based on observed MO calibration post-Bundle-1M. The actual 1N effect could be more or less aggressive. The gate framework absorbs this — first lift triggers off post-1N empirical data, not the proxy.
4. **Drawdown metric is cumulative log-growth trough.** Real-cash bankroll dynamics differ from this metric in details (e.g. concurrent open positions, settlement lag).
5. **The "% at cap" reading depends on the over-confidence direction** of the model. If 1N over-shrinks (calibration becomes too pessimistic), the % at cap could drop further than predicted; gates would never trigger and the cap-lift framework would correctly never propose a lift.

---

## 8 — Source data and verification

Two key Neon queries that produced the data behind this analysis:

### Query A — Per-bet log-growth by opp_band at K=0.25 + cap=0.02

```sql
WITH bets AS (
  SELECT
    CASE
      WHEN opportunity_score >= 90 THEN '90+'
      WHEN opportunity_score >= 80 THEN '80-89'
      WHEN opportunity_score >= 70 THEN '70-79'
      WHEN opportunity_score >= 60 THEN '60-69'
      WHEN opportunity_score >= 50 THEN '50-59'
      ELSE '<50'
    END AS opp_band,
    odds_at_placement AS odds,
    (status = 'won')::int AS won,
    LEAST(0.02, GREATEST(0, 0.25 * (model_probability * odds_at_placement - 1)
        / NULLIF(odds_at_placement - 1, 0))) AS stake
  FROM paper_bets
  WHERE placed_at >= '2026-05-03' AND deleted_at IS NULL
    AND status IN ('won','lost') AND bet_track = 'shadow'
    AND model_probability IS NOT NULL AND odds_at_placement > 1.01
)
SELECT opp_band, COUNT(*) AS n,
       ROUND(AVG(LN(1 + stake * (CASE WHEN won=1 THEN odds-1 ELSE -1 END)))::numeric, 5)
         AS avg_log_growth_per_bet,
       ROUND(100.0 * COUNT(*) FILTER (WHERE stake = 0.02)::numeric / COUNT(*), 1)
         AS pct_capped
FROM bets WHERE stake > 0
GROUP BY opp_band ORDER BY opp_band DESC;
```

### Query B — Cap vs no-cap simulation with max drawdown

(Full query in conversation transcript 2026-05-16; condensed pattern: cumulative log-growth per scenario via `SUM() OVER (ORDER BY bet_idx)`, then `MIN(cum - MAX(cum) OVER (...))` for the worst peak-to-trough trough.)

Re-run both quarterly to keep the data fresh. The cap-lift framework's own rolling-window queries (Bundle 2C implementation) supersede these for actual decisions.

---

## 9 — Execution order

| When | Action |
|---|---|
| 2026-05-16 (now) | Ship Bundle 1N (commit, deploy, fitter run, verify) |
| 2026-05-16 (now) | Write this document (`docs/bundle_2c_kelly_sizing.md`) |
| After 1N verified | Build Bundle 2C cap-lift framework + view |
| After 2C ships | Framework runs nightly. First cap lift evaluated when gates have sufficient post-1N sample |

The two questions:

- **Accurate edge?** YES — Bundle 1N fixes calibration so the cap can stop doing its hidden shrinkage job. Bundle 2C framework gates any cap change on validated edge evidence.
- **Kelly growth ROI?** YES — the analysis shows 1.9-2.9× growth lift available from cap relaxation, gated safely on data-driven evidence rather than calendar dates.

---

## 10 — Related memory entries

- [[feedback_edge_is_prime_directive]] — every decision serves find / prove accurate / validate / maximise; this work is the "maximise" leg.
- [[feedback_autonomy_and_guardrails]] — money guardrails (cap) are operator-only; framework cannot autonomously raise cap.
- [[feedback_track_b_over_track_a]] — sizing/allocation work compounds; this is Track B.
- [[project_kelly_growth_formula]] — `½ × edge² / variance` is the per-period growth metric; the ½ factor is why doubling K does not double growth.
- [[project_adaptive_kelly_factor]] — the existing `f_lo/f̂` multiplier coexists with this framework; both shrink stake when uncertainty is high. The cap is the absolute ceiling on top.
- [[feedback_hierarchical_bayes_over_mle_fallback]] — Bundle 1N is the calibration-side application of this principle; Bundle 2C consumes its output.
