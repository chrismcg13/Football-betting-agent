# Phase 3 — Paper → Live switchover: planning brief
**Author:** Claude (Opus 4.7) · **Date:** 2026-05-08 · **Status:** Plan for review, not implementation
**Scope:** Phase 1 audit, Phase 2 commission, Phase 3 statistical framework, Phase 4 live infra, Phase 5 switchover, Phase 6 thresholds.

---

## 1. Executive summary

The switchover gate as currently designed cannot be trusted, because the metric the autonomous tier-ladder uses to graduate or demote scopes is structurally broken. Three of four demotions in the last 24h hit profitable scopes. Until that metric is replaced and the Pinnacle-close anchor coverage closes, **no autonomous paper→live transition should fire**.

**Top findings (every claim has SQL inline below):**

1. **The `kelly_growth_per_bet` proxy is not Kelly growth.** It computes `AVG(LN(GREATEST(0.0001, 1 + pnl/stake)))` — i.e., log-return assuming each bet stakes 100% of bankroll. A losing bet contributes ~−9.21 (the floor), a 50% loss contributes −0.69, a winning bet at odds 2 contributes +0.69. The threshold (`-0.005`) is calibrated to *true* Kelly growth (where a 2% stake loss contributes −0.02). The two are **2–3 orders of magnitude apart**, so the gate fires on essentially anything with a normal mix of wins and losses.
2. **Three of four demotions in the last 24h hit profitable scopes.** `archetype:lower_division` (n=385, ROI=+18.2%, PnL=+£548) demoted. `archetype:top_flight_men` (n=41, ROI=+12.7%, PnL=+£32) demoted. `market:BTTS` (n=8, ROI=+69.7%, PnL=+£154) demoted to SHADOW_ONLY on a `DATA_COVERAGE_GAP` trigger that has a `min_sample=5` floor — an n=8 sample should never autonomously move anything.
3. **Pinnacle CLV anchor coverage is nowhere near where downstream code assumes it is.** Of 129 settled bets (89 paper + 40 shadow), 91 (70.5%) have a Pinnacle close captured but only 28 (21.7%) get tagged `clv_source='pinnacle'`. On Tier-A paper, only 16.7% (7/42) settle with the Pinnacle CLV tag. The brief's "Tier A 10.2%" figure is plausible as a per-fixture metric but is not how the downstream code reads coverage; see §3.5.
4. **`bankroll_snapshots` is 12 hours old.** First row: `2026-05-07 23:04`. The brief assumes this is the source of truth for true Kelly growth — it cannot be, retrospectively, because the data does not exist before yesterday.
5. **Cross-market evidence pile is one market deep.** Of 89 settled paper bets, 80 are `MATCH_ODDS` (currently −11.4% ROI on Pinnacle-anchored coverage of 3.75%) and 9 are `BTTS` (0% Pinnacle coverage). The §5.3 cross-market validation requirement (3 markets × ≥100 bets) is unreachable on current settlement velocity; rough projection puts a credible gate-clearing date well into Q3 2026 even with no further pipeline issues.
6. **No data has graduated past `experiment` tier.** Every settled bet in the current regime carries `data_tier='experiment'`. The `candidate` and `promoted` tiers are empty in production.
7. **`commission_tracking` is empty.** The schema exists but the rolling 52-week gross-profit aggregator that drives Expert Fee modelling is not running. This is the input to the §4 commission model and must exist before live.
8. **`ASIAN_HANDICAP` exchange-snapshot capture is silently failing.** 1,376 shadow rows, 0 with `betfair_market_id`, 0 with `betfair_best_back`. Sub-phase 4.A wired AH valuation but not the C1 capture path.

**Headline recommendation:**
- Do **not** flip live mode on the existing autonomous machinery. Replace the kelly_growth proxy first, replumb CLV-source tagging, re-run the 30-day evaluation cleanly, then revisit.
- Adopt a **sequential Bayesian framework with hard sample-size floors and a CLV-anchored secondary gate** (§5). The user's proposed θ=1.5% net ROI / α=0.01 is reasonable but I would push minimum-n higher than 100 per scope (see §5.1) and would tighten the per-market floor based on AH variance.
- Invert the asymmetry the brief proposes for autonomous threshold movement: **autonomous tightening is fine only if it uses a metric that isn't broken.** Right now we have evidence the autonomous tightening path *is* the bigger risk (the 4 bad demotions), not loosening.

---

## 2. Methodology and pushback on the brief

Before findings, three points where I disagree with the framing:

**A. "Tier A 10.2% Pinnacle coverage" is not what the data shows.**
The brief's tier-coverage numbers (Tier A 10.2%, B 1.1%, C 0.0%) appear to come from an older measurement. Today's evidence:
- Tier-A *competitions* with `has_pinnacle_odds=true`: 140/140 (100%). This is a league-level boolean and is meaningless for switchover decisions.
- Tier-A *settled paper bets* with `closing_pinnacle_odds` captured: 25/42 (59.5%).
- Tier-A *settled paper bets* tagged `clv_source='pinnacle'`: 7/42 (16.7%).
- Tier-C *recent matches* with any Pinnacle snapshot: 93/695 in last 30d (13.4%).

The relevant metric for switchover is the third line (CLV-anchored at settlement), and it is 16.7% on the highest-coverage tier. This is the actual constraint and it's much worse than the brief's phrasing suggests.

**B. "Variance-driven autonomous loosening is the biggest risk" — only half right.**
Right now the realised risk is **variance-driven autonomous tightening**. The Z4 ladder demoted three profitable scopes in a single cron run. The user's instinct that loosening is the structural risk is correct in steady state, but in the current regime tightening is also broken because the metric is broken.

**C. "Switchover is automatic when 7 conditions are met" — keep the gate, but require a manual GO from Chris on the final flip.**
Every condition in §7.1 should be machine-checkable, but the act of flipping `paper_mode=false` should require Chris's signed approval on the day of, against the latest evidence. The asymmetry the brief itself flags ("the first live bet is irreversible") demands a human in the loop on the final action even if every gate is green. The cost is one Slack/email; the upside is catching subtle issues that no checklist enumerates. I recommend: machine puts an "ALL GREEN" alert in front of Chris with a 24-hour timestamped manifest of every check; Chris flips the flag with a CLI command. No "the system did it itself" failure mode.

If you disagree, say so and we can revisit; but I would push back on full-autonomous flip.

---

## 3. Phase 1 — Audit findings (with SQL inline)

### 3.1 Universe state and config

```sql
SELECT key, value FROM agent_config
WHERE key IN ('paper_mode','bankroll','starting_deposit','max_stake_pct',
              'min_edge_threshold','min_opportunity_score','live_opp_score_threshold',
              'shadow_min_edge_threshold','shadow_min_opportunity_score',
              'daily_loss_limit_pct','weekly_loss_limit_pct',
              'daily_drawdown_limit_pct','weekly_drawdown_limit_pct')
ORDER BY key;
```
Result (excerpt):
- `paper_mode = 'true'`
- `bankroll = 9683.96`, `starting_deposit = 1044`
- `max_stake_pct = 0.02` (correct per non-negotiables)
- `min_edge_threshold = 0.005`, `min_opportunity_score = 30`, `live_opp_score_threshold = 63`
- `shadow_min_opportunity_score = 0`, `shadow_min_edge_threshold = 0.005`
- **`daily_loss_limit_pct = 0.99`, `weekly_loss_limit_pct = 0.99`, `daily_drawdown_limit_pct = 99`, `weekly_drawdown_limit_pct = 99`** — the strategy loss caps that protect real bankroll have been relaxed for paper mode. **Before the live flip, these must be restored to ≤0.10 daily / ≤0.20 weekly per the non-negotiables.**

The `real_money_go_live_checklist` row is `status: deferred_until_real_money` with TBD values for `bankroll_floor`, `daily_loss_limit_pct`, `weekly_loss_limit_pct`. Switchover cannot fire while these are TBD.

### 3.2 Bet pipeline and settlement integrity

**Where bets live:** all paper, shadow, and (post-flip) live bets share the `paper_bets` table. `stake>0` distinguishes paper, `stake=0 AND shadow_stake IS NOT NULL` is shadow, and `betfair_bet_id IS NOT NULL` will mark live. The `legacy_regime=false` flag isolates the post-2026-04-22 pipeline. There is **no `live_bets` table** — see §6.1 for the recommendation.

**Settlement source:** real match outcomes via `matches.home_score / away_score`:
```sql
SELECT COUNT(*) AS settled,
       COUNT(*) FILTER (WHERE m.home_score IS NOT NULL AND m.away_score IS NOT NULL) AS has_score
FROM paper_bets pb JOIN matches m ON m.id=pb.match_id
WHERE pb.deleted_at IS NULL AND pb.legacy_regime=false
  AND pb.status IN ('won','lost') AND pb.stake::numeric > 0;
```
Result: `settled=89, has_score=89` (100%). Settlement is grounded in real outcomes, not the placement odds feed. Confirms §10 Q6.

**Settlement P&L correctness:**
```sql
SELECT market_type, status, COUNT(*) AS n,
       AVG(CASE WHEN status='won' THEN pnl - s*(o-1)
                WHEN status='lost' THEN pnl - (-s) END)::numeric(10,4) AS avg_diff
FROM (SELECT market_type, status, stake::numeric s, odds_at_placement::numeric o, settlement_pnl::numeric pnl
      FROM paper_bets WHERE legacy_regime=false AND deleted_at IS NULL
        AND status IN ('won','lost') AND stake::numeric>0) x
GROUP BY 1,2;
```
- `MATCH_ODDS lost` n=56, avg_diff=0.0000 (perfect)
- `MATCH_ODDS won` n=24, **avg_diff=−0.7535** (wins are deducted ~5% — commission already applied)
- `BTTS lost` n=4, avg_diff=0.0000
- `BTTS won` n=5, **avg_diff=−2.0845** (commission applied)

**Finding:** `settlement_pnl` is **already net of commission** at 5% on wins. This is the wrong column to use as `gross_pnl`. The schema has separate `gross_pnl`, `commission_amount`, `net_pnl` columns but the modelSelfAudit Z4 analysis uses `settlement_pnl` directly (lines 240/268/296/324 of `modelSelfAudit.ts`). The downstream "Kelly growth" computation is **doubly distorted**: wrong formula AND wrong input.

**Pricing-pipeline integrity:** the recently-fixed leak (commits `3c8c1fb` then revert `0768781`) is no longer dropping snapshots. Last-7d funnel:
```sql
SELECT CURRENT_DATE - placed_at::date AS d,
       COUNT(*) FILTER (WHERE stake::numeric>0) AS paper,
       COUNT(*) FILTER (WHERE stake::numeric=0 AND shadow_stake IS NOT NULL) AS shadow,
       COUNT(*) FILTER (WHERE status='placement_failed') AS failed
FROM paper_bets WHERE legacy_regime=false AND deleted_at IS NULL
  AND placed_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 1;
```
- d=0: 0 paper / 132 shadow / 0 failed
- d=1: 56 / 1861 / 0 *(spike — likely a backfill or surge — needs context)*
- d=2: 49 / 22 / 0
- d=3: 22 / 6 / 0
- d=4: 18 / 0 / 6 *(placement_failed cluster)*
- d=5: 32 / 0 / 3

**Finding:** placement-failed events on d=4 and d=5 (9 total) — the failure mode needs auditing before live; a `placement_failed` row in paper costs nothing, but in live it could mean an unmatched bet leaking unseen.

### 3.3 The Z-series autonomous machinery

**Z1 / Z3 / Z5 — `autonomousThresholdRevision.ts`.** The literal logic:
- `lookupScopedThreshold(base, ctx, default)` reads `agent_config` keys with precedence `per_league > per_market > per_archetype > global`. Used at value-detection time.
- `runZ3RetrospectiveRevision()` (referenced from cron, not shown above) is a weekly proposer. **`pending_threshold_revisions` table is empty in prod.** Either Z3 hasn't run, or it has run and proposed nothing. No `applied`/`proposed`/`reverted` rows in `model_decision_audit_log` — every autonomous decision is logged with `review_status='automatic'`.

**Z4 — `autonomousTierLadder.ts`.** Daily 03:45 cron. Promotes/demotes leagues on the proxy:
```sql
AVG(LN(1 + LEAST(GREATEST(pb.settlement_pnl::numeric / NULLIF(GREATEST(pb.stake::numeric, COALESCE(pb.shadow_stake::numeric, 0)), 0), -0.99), 5)))
```
This is `LN(1 + clamp(pnl/stake, [-0.99, 5]))`. For a losing bet it is `LN(0.01) = -4.605`. The thresholds (±0.005) are 1000× smaller than the natural per-bet variance of this metric. The ladder's promotion threshold of `n≥30` is below any sane statistical floor.

**Z6 — `featurePredictivePower.ts`.** 45 features evaluated in one batch (run id `feature-pp-1778193133812-c3gjle`, 2026-05-07 22:32). Top reported p-values:
```
home_af_goals_conceded_avg   p=0.060546   r=0.184   n=103   passes=false
home_goals_conceded_avg      p=0.068427   r=0.178   n=104   passes=false
home_btts_rate               p=0.070427   r=0.176   n=104   passes=false
```
**No Bonferroni / FDR correction visible.** With 45 features at α=0.05, expected false-positive count ~2.25. Even Bonferroni-corrected α would need to be 0.05/45 ≈ 0.0011. None of the reported features pass even un-corrected, so this is currently a non-issue, but the moment a feature does pass we'd need correction logic in place.

**Demotion log — the 4 demotions in last 24h:**

```sql
SELECT decision_at, decision_type, subject, supporting_metrics
FROM model_decision_audit_log
WHERE decision_type IN ('tier_demoted','tier_demoted_to_shadow')
ORDER BY decision_at DESC;
```

| Subject | n (real) | ROI | log_growth/bet | Reason | Verdict |
|---|---|---|---|---|---|
| `archetype:lower_division` | 385 | **+18.21%** (PnL +£548) | −6.097 | KELLY_GROWTH_ANOMALY | Bug — profitable, wrongly demoted |
| `archetype:top_flight_men` | 41 | **+12.75%** (PnL +£32) | −6.156 | KELLY_GROWTH_ANOMALY | Bug — profitable, wrongly demoted |
| `market:MATCH_ODDS` | 80 | −11.40% (PnL −£66) | −6.085 | KELLY_GROWTH_ANOMALY | Direction plausible, magnitude wrong |
| `market:BTTS` | 8 | **+69.72%** (PnL +£154) | n/a (no CLV) | DATA_COVERAGE_GAP | Bug — n=8 should not autonomously demote anything; profitable scope dropped because Pinnacle close isn't being captured for BTTS |

**Verdict on §3.3:** The autonomous tightening pathway is firing on a malformed metric. Z3 has not yet observably fired anything (so its loosening risk is theoretical). Z4 is actively misclassifying scopes today. Recommendation in §5.5.

### 3.4 Metric-correctness audit

| Metric | State | Issue |
|---|---|---|
| Gross P&L | Stored in `gross_pnl` column | Mostly null on legacy rows; populated post-pricing-pipeline cutover |
| Net P&L | Stored in `net_pnl` and `settlement_pnl` (these duplicate) | `settlement_pnl` is **already net of 5% commission on wins** — using it for analysis treats it as gross and underweights wins by ~5% in any ratio computation |
| Win rate | Inferred from `status IN ('won','lost')` | No void/push handling visible; AH half-wins not yet settled (0 settled in current regime) |
| CLV | `clv_pct`, `clv_source` | Capture is broken on most market types: BTTS 0/9, ASIAN_HANDICAP 0 settled. On Tier-A: 16.7%. See §3.5. |
| ROI | `pnl/stake` (turnover-based) | OK for fixed-stake markets. AH not yet settled; partial-win denominator unverified. |
| Kelly growth (true) | `bankroll_snapshots` | **Only 12 hours of history.** Started 2026-05-07 23:04. Cannot evaluate retrospective Kelly growth. |
| Kelly growth (proxy) | `AVG(LN(GREATEST(0.0001, 1+pnl/stake)))` | **Broken.** Unit-stake-of-bankroll arithmetic. See §3.3. |

```sql
-- bankroll_snapshots
SELECT COUNT(*) AS n, MIN(taken_at) AS first, MAX(taken_at) AS last,
       MIN(paper_bankroll) AS min_pb, MAX(paper_bankroll) AS max_pb,
       COUNT(*) FILTER (WHERE real_bankroll IS NOT NULL) AS has_real
FROM bankroll_snapshots;
```
Result: `n=1843, first=2026-05-07T23:04, last=2026-05-08T10:35, min_pb=9630, max_pb=9719, has_real=0`.

### 3.5 Tier coverage and Pinnacle anchoring

```sql
SELECT universe_tier, COUNT(*) n_competitions,
       COUNT(*) FILTER (WHERE has_pinnacle_odds) AS pinnacle,
       COUNT(*) FILTER (WHERE betfair_competition_id IS NOT NULL) AS bf_id
FROM competition_config GROUP BY 1 ORDER BY 1;
```
| Tier | Comps | has_pinnacle (league flag) | has_betfair_id |
|---|---|---|---|
| A | 140 | 140 (100%) | 48 (34%) |
| B | 147 | 5 (3.4%) | 20 (13.6%) |
| C | 755 | 15 (2.0%) | 55 (7.3%) |
| D | 65 | 0 | 65 (100%) |
| unmapped | 9 | 9 | 4 |

Per-bet coverage at settlement:
```sql
SELECT universe_tier_at_placement AS tier,
       COUNT(*) settled,
       ROUND(100.0*COUNT(*) FILTER (WHERE closing_pinnacle_odds IS NOT NULL)/NULLIF(COUNT(*),0),2) AS close_pct,
       ROUND(100.0*COUNT(*) FILTER (WHERE clv_source='pinnacle')/NULLIF(COUNT(*),0),2) AS clv_pinn_pct
FROM paper_bets WHERE legacy_regime=false AND deleted_at IS NULL AND status IN ('won','lost')
GROUP BY 1 ORDER BY 1;
```
| tier | settled | close_pct | clv_pinn_pct |
|---|---|---|---|
| A | 42 | **59.52** | **16.67** |
| B | 26 | 46.15 | **53.85** |
| null | 61 | 88.52 | 11.48 |

**Findings:**
- Tier-A close-capture works ~60% of the time, but only ~17% gets the Pinnacle CLV tag. The gap is a **CLV-source labelling bug** (the close is captured but not flagged), not a data acquisition gap.
- Tier-B has fewer settled bets but a *higher* CLV-pinnacle rate (53.85%). This suggests the labelling is path-dependent on market type or league, not a uniform pipeline failure.
- The bets with `null` `universe_tier_at_placement` (n=61) are pre-Phase 2.A bets that ran before tier denormalisation shipped.

**Tier-C pinnacle trajectory:**
```sql
WITH tier_c AS (SELECT id, name FROM competition_config WHERE universe_tier='C'),
     tier_c_match_ids AS (
       SELECT m.id FROM matches m JOIN tier_c c ON m.league=c.name
       WHERE m.kickoff_time >= NOW() - INTERVAL '30 days')
SELECT (SELECT COUNT(*) FROM tier_c_match_ids) AS matches_30d,
       COUNT(DISTINCT pos.match_id) AS matches_with_pinn_30d
FROM pinnacle_odds_snapshots pos
WHERE pos.match_id IN (SELECT id FROM tier_c_match_ids);
```
Result: `matches_30d=695, matches_with_pinn_30d=93` → **13.4% of Tier-C matches have Pinnacle data**. Above the brief's "0%" but well below 50%. At current crawl rate of ~3 matches/day per Tier-C league this gap closes very slowly. **Tier-C cannot satisfy the §5.2 CLV gate.** Tier-C bets remain in shadow indefinitely under the recommended framework.

### 3.6 Market-type bettability and exchange capture

```sql
SELECT market_type, COUNT(*) n,
       COUNT(*) FILTER (WHERE betfair_best_back IS NOT NULL)::float/COUNT(*) AS bf_back_pct,
       COUNT(*) FILTER (WHERE betfair_market_id IS NOT NULL)::float/COUNT(*) AS bf_mkt_id_pct
FROM paper_bets WHERE legacy_regime=false AND deleted_at IS NULL
GROUP BY 1 ORDER BY 1;
```
| market_type | n | bf_back_pct | bf_mkt_id_pct |
|---|---|---|---|
| MATCH_ODDS (paper) | 124 | 100% | 0% |
| MATCH_ODDS (shadow) | 261 | 68% | 0% |
| ASIAN_HANDICAP (shadow) | **1376** | **0%** | 0% |
| BTTS | 117 | 0% | 0% |
| TEAM_TOTAL_* | 279 | 0% | 0% |
| OVER_UNDER_* | 40 | varied 0–100% | 0% |

**Findings:**
- **`betfair_market_id` is never populated.** Even on MATCH_ODDS where C1 capture succeeds for selection_id and best_back, the market_id column is empty across the entire dataset. This is a schema/code gap that will block live placement: **placeOrders requires marketId**.
- ASIAN_HANDICAP (the largest shadow volume) has zero exchange capture. Placement on AH live is currently impossible — the data pipeline doesn't know which Betfair market to target.
- BTTS, TEAM_TOTAL_*, OVER_UNDER_05 have zero capture. Likely Betfair listing under different market type names; sub-phase 4.B was supposed to extend the sweep but the audit-log shows `betfair_unmapped_market_observed` 15× on 2026-05-07 — the discovery is finding markets but not mapping them through.

---

## 4. Phase 2 — Commission and Expert Fee model

### 4.1 Research summary (cited)

**Base commission (Market Base Rate):** UK customers pay **5% of net winnings** on standard markets. Formula: `commission = net_winnings × MBR × (1 - discount_rate)`. Discount Rate is a loyalty mechanic; default for new accounts is 0%. Commission is per-market, not per-bet, on net market position.
- Sources: [Betfair: What is Commission and how is it calculated?](https://support.betfair.com/app/answers/detail/413-exchange-what-is-commission-and-how-is-it-calculated/), [Betfair: What is the Market Base Rate?](https://support.betfair.com/app/answers/detail/412-exchange-what-is-the-market-base-rate/), [Betting.co.uk Betfair commissions 2026](https://www.betting.co.uk/reviews/betfair/commission/), [Caan Berry Betfair Exchange Review](https://caanberry.com/betfair-exchange-review/).

**Expert Fee (replaced Premium Charge on 2025-01-06):**
- Trigger: 52-week rolling gross profit > **£25,000** AND > 100 markets bet on AND lifetime profit > 0.
- Schedule (marginal, on the slice over £25k):
  - £0–£25,000: **0%**
  - £25,000–£100,000: **20%**
  - >£100,000: **40%** (capped)
- Applied weekly. **Buffer mechanism:** `Buffer = (Commission Generated / Fee Rate) − Gross Profit Since Last Fee Paid`. Buffer represents the gross profit that can be won before incurring further Expert Fees.
- Returns to 0% if 52-week profit drops back below £25k.
- Sources: [Caan Berry: How Betfair Expert Fee Works](https://caanberry.com/how-betfair-expert-fee-works/), [Bet Angel: Betfair Expert Fee](https://www.betangel.com/betfair-expert-fee/), [Pinnacle Odds Dropper: Betfair 2025 commission switch](https://www.pinnacleoddsdropper.com/blog/betfair-exchange-switch-to-new-commission-structure-for-2025), [GamingSoft 2025 commission guide](https://www.gamingsoft.com/blog/2025/10/betfair-commission-fees-in-2025-what-you-need-to-know/).

**Voids and partial matches:**
- Voided bets (`status=void`): no commission. The codepath in `paperTrading.ts` already writes `settlementPnl='0'` on voids.
- Partial matches: commission on the matched portion only. `betfair_size_matched` and `betfair_avg_price_matched` columns exist for this; `reconcileSettlements` is the authoritative path and defers `settleBets` for matched real-money bets.
- Multi-runner markets: commission is on the net market position (sum of P&L across all selections in that market). Our schema treats one row = one bet on one selection; multi-leg same-market positions need a `market_position_id` if we're going to compute commission correctly. **Currently we don't — flagged as Phase 4 work.**
- Cash-out: commission applies as if the market settled at the cashed-out price.

### 4.2 What needs to be built

**`commission_model` module** (new) with this signature:
```ts
calculateLiveCommission(input: {
  marketId: string;
  grossProfit: number;       // signed, gross of any fee
  marketBaseRate: number;    // defaults to 0.05
  discountRate: number;      // defaults to 0
  lifetime52wGrossProfit: number;  // input to Expert Fee
  totalMarketsBet52w: number;
  isLifetimeProfit: boolean;
}): { commission, expertFeeAttributable, netPnl }
```
- `commission = max(0, grossProfit) × marketBaseRate × (1 − discountRate)` (per market — multi-runner aggregation pending)
- `expertFeeAttributable` only > 0 if all three trigger conditions met. Tier 20% on slice 25k–100k, 40% above. Buffer-aware (track `commission_generated_since_last_fee`).

**`commission_tracking` table population.** Schema already exists (`exchange_id, period_type, period_start, gross_profit, total_commission, net_profit, effective_rate, bet_count, updated_at`) but is empty. Daily cron writes:
- `period_type='daily'` on settlement
- `period_type='weekly_52w_rolling'` on Sunday for Expert Fee inputs
- `period_type='lifetime'` for the lifetime-profit gate

**Forward projection query** (queryable by user):
```sql
-- "When does Expert Fee engage at current trajectory?"
SELECT period_start, gross_profit, total_commission,
       gross_profit - 25000 AS slack_to_expert_fee,
       CASE WHEN gross_profit > 25000 THEN 0.2*(gross_profit-25000) ELSE 0 END AS projected_fee_at_band1
FROM commission_tracking
WHERE period_type='weekly_52w_rolling'
ORDER BY period_start DESC LIMIT 4;
```

**Net Kelly growth metric.** Replace the `LN(1+pnl/stake)` proxy throughout the codebase with:
```sql
-- True log-bankroll growth using bankroll_snapshots
SELECT b.bet_id,
       LN(b.paper_bankroll / lag_paper_bankroll) AS log_growth
FROM (SELECT bs.*, LAG(paper_bankroll) OVER (ORDER BY taken_at) AS lag_paper_bankroll
      FROM bankroll_snapshots bs WHERE source='paper_bet_settle') b
WHERE b.bet_id IS NOT NULL;
```
Aggregate over rolling windows. **Note:** because bankroll_snapshots only has 12h history, we cannot retrospectively backfill — but we can start from now and require the §5 evaluation window of 21 days minimum, beginning when this metric is correct.

### 4.3 Implication for the £200/2% guardrails

At £9,683 bankroll, 2% max stake = £193.68. £200 floor is ~2% of starting bankroll (£10k) — reasonable. With base commission 5% on net winnings, the per-bet expected net of a 1.5% gross-edge bet looks like:
- Gross edge: 1.5% × stake = 0.015 × £193 = £2.90
- Commission on win: 5% × £193 (typical even-money win profit) = £9.65 deducted from any winning bet
- Effective net edge: ~0.5% (commission roughly halves the gross edge at typical odds)

**This is why the SPRT θ in §5.1 should be set against *net* ROI, not gross.** The brief's θ=1.5% net is correct. With gross-of-commission edge of ~3%, the system needs to be ~2× sharper than a no-commission counterfactual. Most paper edges in our current data are <2% gross; once netted these are barely positive expectation.

---

## 5. Phase 3 — Statistical significance framework

### 5.1 Sequential Bayesian gate (recommended over SPRT)

The brief proposes SPRT. Bayesian sequential testing is operationally easier and equivalent in power for our setup. Recommendation:

**Per scope (market × universe_tier or market × league depending on volume):**

- **Posterior on net ROI:** Normal-Normal conjugate. Prior `μ ~ N(0, σ_prior²)` with `σ_prior = 0.02` (reflecting 2% as a reasonable upper-bound on edge). Update with observed per-bet net P&L / stake. Posterior mean and variance updated on each settled bet.
- **Promotion criterion:** `P(net_ROI > 0.005 | data) > 0.99`. The 0.005 threshold (50bp net edge) reflects the user's "we care about small but durable edge" framing.
- **Demotion criterion (symmetric):** `P(net_ROI < -0.005 | data) > 0.99`.
- **Hard sample-size floor:** **n ≥ 200 settled bets per scope.** Brief proposed 100; I'd push higher because:
  - Median per-bet stake variance with AH and 2% Kelly stakes is high.
  - Posterior tightens slowly when σ_observed is high.
  - With ~2% true edge and σ ~ 1.0 per bet (typical for football betting), 95% CI half-width is `1.96 × 1.0 / √n`. n=100 → ±0.20; n=200 → ±0.14; n=500 → ±0.088. The 0.005 threshold sits inside the n=100 CI even with perfect data — i.e., n=100 cannot statistically distinguish a 0.5% edge from zero.
- **Asymmetric priors:** I'd permit the demotion test to fire at n ≥ 100 (lower floor for capital protection), so a clearly losing scope stops sooner than a clearly winning scope earns promotion.

Pushback on §5.1 of the brief: **n=100 is too low** for the chosen θ at the realistic σ. Either raise n or raise θ. I'd raise n.

### 5.2 CLV-anchored secondary gate

Required in addition to §5.1. Same Bayesian posterior on Pinnacle CLV %:

- Promote only if `P(mean_CLV > 0.01 | data, clv_source='pinnacle') > 0.99` over **n ≥ 100 Pinnacle-anchored bets**.
- Discard from the count any bet where `clv_source != 'pinnacle'` — **`market_proxy` and `none` are not evidence**. They're informational. This means a scope cannot graduate if it sits in a market or league with a Pinnacle close-capture failure (current state of BTTS, AH, TEAM_TOTAL_*).

This gate is what protects against the failure mode where the model is "winning" against its own priced lines (a circular feedback loop) rather than against sharp money.

### 5.3 Cross-market validation

Brief proposes 3 markets × 2 league tiers × 21 days. I'd accept this with one tightening:

- The 3 markets must include **at least 1 market with structurally different settlement risk**. MATCH_ODDS, OVER_UNDER_25, and BTTS are all 90-minute outcome markets correlated through goal counts. Adding ASIAN_HANDICAP or DRAW_NO_BET shifts the correlation structure. Otherwise "3 markets passing" can effectively be one statistical event in 3 trenchcoats.

### 5.4 Drawdown discipline

15% peak-to-trough rule from the brief is reasonable. I'd add:

- The drawdown counter resets only when *both* (a) bankroll exceeds prior HWM, AND (b) per-scope posteriors maintain promotion-eligible status.
- If drawdown crosses 10% (warning) — alert Chris but continue evaluation.
- If 15% — full evaluation reset, all per-scope posteriors revert to prior, evaluation window restarts.

### 5.5 What replaces Z1 / Z3 / Z4

**Z1 (per-scope thresholds):** keep the `agent_config` per-scope storage and `lookupScopedThreshold` helper. They are sound.

**Z3 (weekly retrospective revision):** **disable autonomous loosening entirely** until §5 framework is operational AND has cleared at least one full evaluation window with the new metric. After that, allow loosening only when the same Bayesian posterior used for promotion clears the same bar. **Tightening is fine to keep autonomous, but only on the new metric.**

**Z4 (tier ladder):** **suspend immediately.** Do not run again until:
1. The `kelly_growth_per_bet` proxy is replaced with true bankroll-snapshot Kelly growth.
2. Sample-size floors are raised (n ≥ 100 for any demotion, n ≥ 200 for any promotion).
3. The `BTTS n=8 → SHADOW` demotion is reverted.
4. The thresholds are re-calibrated against the *correct* metric scale.

Until that happens, an interim manual review of any tier movement is required.

**Z6 (feature predictive power):** add Bonferroni or Benjamini-Hochberg FDR correction in `featurePredictivePower.ts`. With 45 features this lowers per-feature significance to ~0.0011. Currently moot (no features pass), but fix before relying on the output.

---

## 6. Phase 4 — Live infrastructure

### 6.1 Live bet lifecycle

**Recommendation: do NOT add a separate `live_bets` table.** Reuse `paper_bets` with the existing `betfair_bet_id`/`betfair_status`/`betfair_pnl` columns and add:
- `bet_track` enum column: `paper | shadow | live` — denormalised at insert time, indexed.
- Backfill: paper rows with `stake>0 AND betfair_bet_id IS NULL` → `paper`. Shadow rows → `shadow`. (No live exists yet.)

Rationale: divergent code paths are the single biggest source of switchover risk (per §3.2 brief). One table, one settlement codepath, one Z-machinery feed.

**Settlement reconciliation via Betfair `listClearedOrders`:** the codepath exists in `liveReconciliation.ts` and `betfairLive.ts:settleBets` already defers matched-real-money bets to it. Confirm by code-walk that:
- Cleared-orders polling cron is wired to scheduler (verify in `scheduler.ts`).
- Polling cadence is ≤15 min (Betfair retains cleared orders 90 days, but earlier capture means earlier reconciliation alerts).

**Commission attribution per bet:** populate `gross_pnl`, `commission_rate`, `commission_amount`, `net_pnl` columns at settlement time using the §4.2 module. **Stop using `settlement_pnl` as gross.**

**CLV computation:** identical pipeline for paper, shadow, live. Captured at the same trigger (event `MATCH_STARTED` or 5-min-pre-kickoff fallback).

**Bankroll source of truth:** Betfair `getAccountFunds.balance` for live; system-tracked `paper_bankroll` for paper/shadow. Never hardcode. The `live_breaker_paused_until` agent_config key (currently set to a past date) becomes load-bearing here.

### 6.2 Live performance metrics

All queryable via SQL; no caches. Suggested view:

```sql
CREATE VIEW live_performance_overview AS
SELECT
  bet_track,
  universe_tier_at_placement AS tier,
  market_type,
  COUNT(*) FILTER (WHERE status IN ('won','lost','void')) AS settled,
  COUNT(*) FILTER (WHERE status='won') AS won,
  COUNT(*) FILTER (WHERE status='lost') AS lost,
  COUNT(*) FILTER (WHERE status='void') AS voids,
  ROUND(100.0*COUNT(*) FILTER (WHERE status='won')/NULLIF(COUNT(*) FILTER (WHERE status IN ('won','lost')),0),2) AS win_pct,
  SUM(gross_pnl::numeric) AS gross_pnl,
  SUM(commission_amount::numeric) AS commission,
  SUM(net_pnl::numeric) AS net_pnl,
  ROUND(100.0*SUM(net_pnl::numeric)/NULLIF(SUM(stake::numeric),0),2) AS net_roi_pct,
  AVG(clv_pct::numeric) FILTER (WHERE clv_source='pinnacle')::numeric(8,4) AS mean_pinn_clv,
  COUNT(*) FILTER (WHERE clv_source='pinnacle') AS n_pinn_anchored
FROM paper_bets
WHERE legacy_regime=false AND deleted_at IS NULL
GROUP BY 1,2,3;
```

### 6.3 Live vs shadow comparison during ramp

Brief is right: keep shadow running **on the same scopes that have graduated to live**. This is the only way to detect the "paper overstates by 50%" effect Chris flagged. Add a daily comparison report:

```sql
SELECT market_type, universe_tier_at_placement,
       AVG(net_roi) FILTER (WHERE bet_track='live') AS live_roi,
       AVG(net_roi) FILTER (WHERE bet_track='shadow') AS shadow_roi,
       AVG(net_roi) FILTER (WHERE bet_track='live') - AVG(net_roi) FILTER (WHERE bet_track='shadow') AS gap
FROM (...) GROUP BY 1,2;
```
**Trigger:** if the gap exceeds −50% of shadow_roi (i.e., live ROI is less than half shadow ROI) over n≥30 paired bets, halt new live placements pending review.

### 6.4 Real-time anomaly detection

Wire to existing `alerts` table. Triggers:
- Bet rejection rate > 5% over last hour → halt.
- Matched amount < 95% of requested over last 10 placements → flag (don't halt; AH liquidity varies).
- Settlement lag > 24h on any cleared bet → alert.
- Commission deduction outside [4.5%, 5.5%] band → halt + investigate.
- Bankroll drift between Betfair-reported `getAccountFunds` and `bankroll_snapshots.real_bankroll` > £5 → halt + reconcile.

---

## 7. Phase 5 — Switchover mechanics

### 7.1 The switchover gate (revised)

All seven of these must be machine-true before the user is asked to flip:

1. **Statistical:** ≥3 distinct market types each pass §5.1 Bayesian net-ROI gate at n≥200 with `P(net_ROI > 0.005) > 0.99`.
2. **CLV anchor:** same scopes pass §5.2 with n≥100 Pinnacle-anchored bets and `P(mean_CLV > 0.01) > 0.99`.
3. **Cross-market:** §5.3 — markets span ≥2 league tiers and include ≥1 structurally-different correlation profile (e.g., one of {AH, DNB} alongside MATCH_ODDS / OVER_UNDER).
4. **Drawdown:** no §5.4 reset in the last 21 days.
5. **Infra:** ≥10 dry-run placements have round-tripped through the live API codepath with `dry_run=true` (the order is built, the API call is made up to the final stage, the request is logged and rejected by a feature flag). Dry-run telemetry is captured and reviewed.
6. **Capital:** `getAccountFunds.balance ≥ 5 × max_stake_pct × bankroll`. With £9,683 × 2% = £193.68 max stake, that requires ~£1,000 minimum balance for the headroom check.
7. **Override audit:** in the last 7 days, no `model_decision_audit_log` entries with `review_status='reverted'` or compliance_logs with `actionType='manual_override'`. Indicates Chris hasn't recently disagreed with the autonomous machinery.
8. *(Added)* **Capital protection caps restored:** `daily_loss_limit_pct ≤ 0.10`, `weekly_loss_limit_pct ≤ 0.20`, `bankroll_floor ≥ 0.05 × bankroll`. Currently all relaxed to 99% / 0 — see §3.1.
9. *(Added)* **Z-machinery clean:** Z4 has been re-enabled with the corrected metric, and at least 7 days of Z4 evaluations show no demotions on profitable scopes. (Sanity check.)

The user is notified at 5/9 (early warning) and 9/9 (gate clear). **At 9/9 the system stops and requires Chris to flip the flag with a CLI command** — see §2.C.

### 7.2 The switchover act

Atomic transaction:
```sql
BEGIN;
  UPDATE agent_config SET value='false', updated_at=NOW() WHERE key='paper_mode';
  UPDATE agent_config SET value='true', updated_at=NOW() WHERE key='live_mode_active';
  -- paper bet generation gated on live_mode_active=false in valueDetection.ts
  INSERT INTO compliance_logs (action_type, details, timestamp)
    VALUES ('live_mode_activated', '{"approved_by":"chris","gate_manifest_hash":"..."}', NOW());
COMMIT;
```
- Paper bets currently `pending` settle to completion via the existing path (don't strand them; the table is shared).
- Shadow bet generation continues unchanged.
- The first scope to receive a live bet is the highest-posterior-confidence one.
- **First live bet is at minimum stake**: `min(£2, 0.5% × bankroll)` = £2 at current bankroll. Full Kelly engages only after **10 settled live bets per scope** confirm the live-vs-shadow gap is in the [−50%, +20%] band.

### 7.3 Shadow → live promotion pipeline (steady state)

After the initial flip, scopes promote when they *individually* clear §5.1 + §5.2. The Z-machinery (corrected) drives this. Demotion: a live scope that triggers symmetric §5.1 bar at `P(net_ROI < -0.005) > 0.99` falls back to shadow — never to "off."

### 7.4 Post-flip paper generation

Permanently disabled as described in the brief. The codepath stays in `valueDetection.ts` behind a feature flag (`paper_bet_generation_enabled`, default false post-flip). Paper history preserved indefinitely as the calibration record.

### 7.5 Rollback plan

If first 50 settled live bets show net ROI < −1% or Pinnacle-anchored CLV < −1%:
- Halt new live placements (existing matched bets settle naturally).
- Do **not** re-enable paper bets.
- Re-evaluate §5.1 with live-only posterior (fresh prior).
- User review of audit log and post-mortem before resuming.
- A second halt within 30 days returns the system to **shadow-only across all scopes** indefinitely until a manual review concludes the failure mode is understood.

---

## 8. Phase 6 — Threshold review across tiers

| Threshold | Current | Recommended | Rationale |
|---|---|---|---|
| `min_edge_threshold` | 0.005 | Keep | OK as candidate-generation floor |
| `min_opportunity_score` | 30 | Keep (but tighten per-scope via Z1) | OK as floor; Z1 raises per scope |
| `live_opp_score_threshold` | 63 | Keep, gate on §5.1 posterior | Replaces opp-score-only gate with statistical gate |
| `shadow_min_opportunity_score` | 0 | Keep | Shadow explores aggressively |
| `max_stake_pct` | 0.02 | Keep — locked | Non-negotiable |
| `bankroll_floor` | 0 | **0.05 × bankroll** before flip | Per §3.1; currently TBD |
| `daily_loss_limit_pct` | 0.99 | **0.07** at flip | Per non-negotiables; currently relaxed |
| `weekly_loss_limit_pct` | 0.99 | **0.15** at flip | Per non-negotiables; currently relaxed |
| `KELLY_GROWTH_NEGATIVE_THRESHOLD` (Z4) | -0.005 | **Replace metric, not threshold** | Current threshold targets true Kelly growth on 2%-Kelly bets, ~0.0002 magnitude. |
| `SEVERE_ROI_MIN_SAMPLE` | 10 | **30** | n=10 is too small to distinguish bad luck from bad market |
| `COVERAGE_GAP_MIN_SAMPLE` | 5 | **30** | n=5 demoting a market is the BTTS-n=8 failure mode |
| `KELLY_GROWTH_MIN_SAMPLE` | 30 | **100** for demotion, 200 for promotion | See §5.1 — n=30 cannot distinguish ±0.5% edge from zero |
| Tier-A graduation (Z2) | currently empty path | §5.1 + §5.2 gates | No scope has graduated; design the gate now before traffic |
| Tier-C → live | impossible (no Pinnacle) | Stay impossible until §6 statistical-anchor model defined | See §8.1 below |

### 8.1 Statistical anchor for non-Pinnacle scopes (brief §6 ask)

Pinnacle is the gold standard but not the only valid anchor. For scopes without Pinnacle coverage (Tier C, niche markets), an alternative anchor:

- **Sharp-consensus proxy:** weighted median of {Pinnacle if available, Smarkets, Matchbook, top-2 sharpest of Bet365/William Hill/Unibet by category}. Weight by reverse-of-overround-divergence.
- **Validation requirement:** before this proxy can graduate any scope, it must demonstrate ≥0.85 correlation with Pinnacle close on a held-out training set of ≥500 paired observations from a Pinnacle-anchored scope. Use the existing Tier-A bets as the calibration set once the Pinnacle-tagging bug is fixed (§3.5).
- **Evidence threshold:** Bayesian gate identical to §5.2 but with σ_prior inflated 1.5× to reflect the weaker anchor.

This is the "statistical theoretical model" the brief asks for in §6. It's an extension, not a replacement. **It cannot ship until the Pinnacle-tagging bug (§3.5) is fixed and 500+ paired observations exist.**

---

## 9. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Z4 continues misclassifying scopes in next cron run before fix lands | High | High (capital impact when live) | Suspend Z4 cron immediately (manual `agent_status=paused` for Z4 only, or comment out scheduler entry) |
| R2 | Pinnacle CLV labelling bug suppresses most evidence — switchover gate never clears | High | Medium (delays go-live, doesn't risk capital) | Fix `clv_source='pinnacle'` tagging path; backfill on existing closed rows where `closing_pinnacle_odds IS NOT NULL` |
| R3 | Capital protection caps still relaxed at flip moment | Medium | Catastrophic (uncapped daily loss) | Hard pre-flip check (#8 in §7.1); refuse flip if any cap > recommendation |
| R4 | First live bet placed on `betfair_market_id`-missing market type | Medium | High (placement fails or worse) | Block live placement for any market where `betfair_market_id IS NULL` on the matched paper/shadow row |
| R5 | Expert Fee triggers on unexpected sustained profit, surprise drag on net ROI | Low (need £25k profit/52w) | Medium | §4.2 forward-projection query; alert at £15k 52w gross profit (60% of trigger) |
| R6 | Live vs shadow ROI gap > 50% — paper-mode-overstated edge confirmed | Medium | High (loses money) | §6.3 daily comparison; halt on −50% gap × n≥30 |
| R7 | Shadow → live promotion pipeline circular feedback (model graduates against own pricing) | Medium | High (looks profitable, isn't) | §5.2 hard gate — cannot graduate without Pinnacle-anchored evidence |
| R8 | bankroll_snapshots history too short to evaluate true Kelly growth at flip time | High | Medium (gates can't fire) | Start fix today; require 21-day clean window before flip |
| R9 | Multi-runner market commission miscomputed (one row per selection, not per market position) | Low (we don't currently bet multi-leg same-market) | Medium | Add `market_position_id` schema field before any multi-leg betting; gate live on single-selection-per-market |
| R10 | `placement_failed` rows on d=4/d=5 indicate a real placement bug not yet diagnosed | Medium | High (could mean unmatched bets in live) | Investigate the 9 placement_failed rows from last 7d before flip |

---

## 10. Implementation sequencing (critical path)

```
A. Suspend Z4 cron + revert 3 wrongful demotions      (immediate, ≤1 day)
B. Fix Kelly-growth proxy → replace with bankroll_snapshots-based metric  (3 days)
C. Fix clv_source='pinnacle' tagging                  (2 days)
D. Backfill Pinnacle CLV tagging on existing rows     (1 day; runs after C)
E. Diagnose ASIAN_HANDICAP exchange-capture failure   (3 days)
F. Diagnose BTTS / TEAM_TOTAL_* / OVER_UNDER_05 unmapped-market issue  (3 days, parallel with E)
G. Backfill / build betfair_market_id population      (2 days, parallel)
H. Stand up commission_tracking population            (3 days)
I. Build commission_model module (§4.2)               (3 days, depends on H)
J. Add Z6 multiple-comparison correction              (1 day)
K. Re-run Z4 with corrected metric, validate          (7 days minimum, depends on B)
L. Disable Z3 autonomous loosening (config flag)      (≤1 day)
M. Implement §5.1 Bayesian sequential gate            (5 days, depends on B)
N. Implement §5.2 CLV-anchored gate                   (3 days, depends on C/D)
O. Build live-bet `bet_track` enum + schema migration (1 day)
P. Wire dry-run live placement codepath               (3 days)
Q. Build §6.2 live_performance_overview view + alerts (2 days)
R. 21-day evaluation window with new metrics          (21 days, depends on K, L, M, N)
S. Pre-flip checklist automation (§7.1)               (3 days)
T. Restore capital protection caps (config change at flip) (≤1 day)
U. Manual GO from Chris + flip                        (≤1 day)
```

**Critical path:** A → B → K → R → S → T → U. **Earliest credible flip date: ~6 weeks from start of fixes**, dominated by R (the 21-day clean-evaluation window). Faster only if multiple parallel fixes complete cleanly.

---

## 11. Open questions still unresolved

1. **Where does the production system run?** Brief mentions a VPS deploy and Replit history; I haven't traced where crons live or which environment runs `runAutonomousTierLadder` / `runModelSelfAudit`. Need to confirm before disabling Z4 — disabling means editing scheduler, and the scheduler location matters.
2. **What is `automatic` review_status semantically?** Is it "applied without review" or "logged for review but not yet seen"? The 4 bad demotions were marked `automatic` and the tier was actually changed (per `autonomous_pauses` insert). Need clarity on the human-in-loop expectation here.
3. **Is the Phase 2.A `shadow_stake_kelly_fraction` the same as Z6's `kelly_fraction_override`?** Two parallel Kelly-fraction systems exist (`shadowStakeKellyFraction` per-bet on `paper_bets` and `kelly_fraction_override` per-scope in `autonomous_pauses`). Need to confirm interaction at placement time.
4. **`d=1: 1861 shadow bets` — is the d=1 spike a real surge or a backfill?** 1861 in one day is ~10× the d=2 rate. If it's a backfill, the 30d windows in modelSelfAudit / autonomousTierLadder are seeing a non-stationary input.
5. **Is there a cleared-orders polling cron in `scheduler.ts`?** §6.1 reconciliation depends on it. Did not verify in this audit.
6. **Tier-C Pinnacle crawl rate.** 13.4% over 30d. Is the prefetch cron running? At what cadence? Need code-walk to project the trajectory beyond "long way to 50%."
7. **The 9 `placement_failed` rows in last 7 days — what failure mode?** Need to inspect the rows individually + any associated audit_log entries. May be benign (timeouts) or may be a class-of-bug worth fixing pre-flip.
8. **`shadow_pnl` is recorded on settled shadow bets — how does it correlate with what live ROI would have been?** §3.2 brief asks if shadow at £0 truly differs from paper. Need a paired-sample analysis once we have ≥30 same-fixture, same-market paper-vs-shadow bets, which we don't have yet (paper and shadow currently target different scopes).
9. **What's the right θ for net ROI?** I propose 0.005 (50bp). Brief proposes 0.015 (1.5%). At commission 5% on wins (~halving gross edge), 1.5% net edge requires ~3% gross edge — most of our paper edges are <2%. With θ=1.5%, the gate may never clear. With θ=0.5%, the gate is more reachable but the variance of estimation at n=200 is ±0.14, so the test is barely powered. **This is the single biggest design question and worth a direct call.**

---

## 12. Recommendations summary

1. **Suspend Z4 immediately.** It's actively misclassifying profitable scopes.
2. **Rebuild the Kelly metric on bankroll_snapshots before re-enabling.**
3. **Fix Pinnacle CLV tagging.** It's the closing gate — until 70%+ of Tier-A bets are anchored, no §5.2 gate can fire.
4. **Tighten the autonomous tightening pathway, don't loosen the loosening pathway.** The user's framing has the priority right but the real failure mode flipped.
5. **Push the manual flip in §7.1 — keep all 9 gates automatic but require Chris to push the button.** The asymmetry the brief itself identifies demands a human in the loop.
6. **Resolve θ before implementation.** 50bp vs 150bp net ROI changes everything downstream. With 5% commission on wins, 50bp is the more honest target; 150bp may be unreachable.
7. **Earliest credible flip: ~6 weeks.** Critical path is the 21-day clean evaluation window after fixes land, not the fixes themselves.
