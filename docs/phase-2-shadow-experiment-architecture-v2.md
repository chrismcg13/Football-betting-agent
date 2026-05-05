# Phase 2 — Shadow Experiment Architecture (v2)

**Status:** v2 design draft for review. **Not for implementation.** No code edits, no migrations, no commits, no deploys made by this document. v1 is preserved at `docs/phase-2-shadow-experiment-architecture-v1.md`.

**Author:** Claude (plan-mode session, 2026-05-04)
**Working tree:** `C:\Users\chris\projects\Football-betting-agent\`
**Methodology:** investigation-driven, evidence-cited, no code-write tools used.
**Note on `CLAUDE.md`:** the original prompt referred to `CLAUDE.md`; the repo uses `replit.md` as the project-context document.

**Memory citations honesty check (per v2 review item #12):** the four memory files cited in v1 (`feedback_race_conditions.md`, `feedback_phase_checkpoints.md`, `feedback_specify_algorithms.md`, `feedback_plan_format.md`) all exist on disk at `C:\Users\chris\.claude\projects\C--Users-chris\memory\`; their contents were read directly and citations match. No fabrication. Continued in v2.

---

## 0. Changelog from v1

| Item | v1 | v2 |
|---|---|---|
| Probationary→full-live threshold (§1.2.6) | ROI ≥ 0% on 100 candidate-tier bets | Edge-survival: candidate ROI ≥ 50% of experiment shadow ROI, p ≤ 0.10 vs breakeven, no >−10% week |
| Time-stability rule (§1.2.4) | "≤60% of total ROI from any single week" | Leave-one-week-out: min ROI excluding any single week ≥ graduation threshold |
| Settlement-bias check (§1.3.2 / §2.1) | 90% absolute coverage | Structural-bias test on settlement rate across confidence buckets |
| Polling cadence (§2.3) | "1×/24h, hour TBD" | Concrete hour `0 7 * * *` with non-stacking justification |
| Open Question #1 (Tier D persistence) | "Decide in v2" | **Decided:** relax `api_football_id NOT NULL`; Tier D in `competition_config` with `is_active=false` |
| Open Question #10 (Phase 1 land-or-skip) | "Decide in v2" | **Decided:** ship Phase 1; route newly-Pinnacle leagues through Tier B/C as pipeline calibration |
| Shadow-stake Kelly fraction (§3.1, §3.2) | "shadow_stake = Kelly recommendation" | **Specified:** shadow_stake = full_Kelly × 0.25 (matches candidate-tier) |
| Retrospective decision tree (§5 phase 2.A) | "STOP if <50% pass" | Four-branch decision tree |
| CLV proxy alternatives (§4 R12) | not addressed | Added: Betfair Exchange volume-weighted closing line investigation |
| Distribution-shift framing (§1.5) | not addressed | Added: shadow track is also a feature-distribution drift detector |
| Permanent-demotion readmission (§3.3, R11) | "abandoned is terminal" | Added: 90-day cooldown + retrain-trigger readmission path |
| R6 (CLV-source contamination) | flagged as Phase-2 design input | **Now blocking precondition** — see `docs/r6-clv-source-investigation.md` |

---

## 1. "What does graduation mean?" — refined framing

### 1.1 The claim (unchanged from v1)

A league has **graduated** when we trust internal performance data alone (no external sharp benchmark) sufficiently to allocate real capital to bets in that league at unconstrained Kelly fraction. Graduation is a *trust assertion about the model* on a *specific data subset*, not a property of the league.

### 1.2 Sufficient evidence (revised)

A graduated league must clear **all** of:

1. **Sample size** ≥ 50 settled bets in the league (v1 default; per-archetype overridable in v3).
2. **Profitability**: ROI ≥ 5%.
3. **Statistical confidence**: WR vs implied-probability prior with p ≤ 0.05 (one-sided z-test). Reuse `computePValue` at `promotionEngine.ts:53-61`.
4. **Time stability — leave-one-week-out (LOO) test (changed)**: with weeks-of-activity ≥ 4, recompute ROI excluding each week k in turn. Pass if `min_k(ROI_without_k) ≥ threshold` where `threshold` = the same 5% used in §1.2.2. This replaces the v1 "≤60% concentration" rule. Mathematical motivation: LOO directly tests "does a single week dominate the result?" while being trivially robust to gaming and not requiring an arbitrary concentration cap. Where weeks < 4, the test is undefined and the bet does not graduate yet (use the 4-weeks-active gate). **Confidence: ANALYTICAL.**
5. **No catastrophic week**: max single-week ROI ≤ −15% disqualifies. Distinct from §1.2.4 — LOO catches drag spread across weeks; this catches a single bad week below tolerance.
6. **Probationary survival — edge-survival test (changed)**: ≥100 *real-money* candidate-tier bets at 0.25× Kelly. Pass if ALL of:
   - **Edge retention**: candidate-phase ROI ≥ 50% of experiment-phase shadow ROI. (E.g., experiment showed shadow ROI = 8%; candidate must show ROI ≥ 4%.)
   - **Statistical significance vs breakeven**: p ≤ 0.10 against breakeven (one-sided z-test on candidate-phase WR vs implied-prob prior).
   - **No catastrophic week** during candidate phase: max single-week ROI ≥ −10%.

   Replaces v1's "ROI ≥ 0% on 100 candidate-tier bets". The v1 form was "didn't blow up" — too permissive. Edge retention is the explicit object: did the edge survive execution friction (slippage, exposure-cap effects, real-money concentration limits, the 5-minute pre-kickoff price drift Betfair Exchange exhibits)?

   **Why 50%?** Two reasons combined:
   - Empirically (HAND-WAVY, no calibration data on this codebase yet): in liquid markets, real-money execution friction historically erodes 30-50% of paper-shadow edge — slippage, partial fills, mid-market price drift between signal and order placement, exposure-cap rejections of correlated bets. Tier B/C will likely be at the upper end of this band due to thin liquidity.
   - Mathematically: 50% is a defensible "majority of the edge survives" threshold, and is conservative without being so strict that legitimately-profitable leagues are gated forever.

   **Per-archetype overrides** (v3 work): high-friction archetypes (women's lower divisions, friendlies, low-liquidity cup rounds) may need 30%; low-friction archetypes (top-flight men's leagues with thick Exchange liquidity) can hold 50%+. v2 ships with global 50% and a flag for v3 archetype calibration.

   **Calibration audit (v3)**: once 30+ candidate→promoted transitions accumulate, run retrospective: for transitions that underperformed in promoted phase, what was their experiment→candidate edge-retention ratio? If consistently <50%, the threshold is correctly tight; if some were 60%+ and still failed, raise to 60%.

### 1.3 Failure modes (refined)

1. **Self-referential graduation.** As v1. Mitigation: candidate-tier 0.25× Kelly + edge-survival test (§1.2.6). EVIDENCE-BASED.
2. **Settlement-gap false positives — REFRAMED FROM v1.** v1 proposed an absolute 90% settlement-coverage threshold. v2 replaces this with a structural-bias test (see §2.1 reframed): the question is not "do enough fixtures settle?" but "does the unsettled set show structural bias against the model's predictions?" If the model predicts upsets and upsets disproportionately fail to settle (e.g., AF doesn't reliably report unusual results), then ROI is biased upward even at 95% settlement. Conversely, even at 60% settlement, if the unsettled fraction is independent of predicted outcome, ROI estimates remain unbiased and the league can graduate.
3. **Selection bias from £0 stake decisions.** Mitigation unchanged from v1.

### 1.4 Rollback procedure (unchanged from v1)

Demotion code paths verified at `promotionEngine.ts:268-290`. Quick-revert via `experiment_registry.data_tier = 'candidate'` + `competition_config.universe_tier = 'B'`. Hard kill via `is_active = false`.

### 1.5 NEW — Shadow track as feature-distribution drift detector

Per-archetype performance differences in the experiment pipeline are **not just graduation tuning** — they are **feature-distribution drift signals**. Specifically:

If women's-league predictions systematically underperform men's-league predictions at the same sample size, the gap is **a model issue, not an edge issue**. The model was trained on a feature distribution dominated by men's leagues; when fed women's-league inputs (different home-advantage prior, different scoring distribution, different injury/lineup signal density), the predictions are mis-calibrated. The "edge" the model thinks it sees is calibration error.

**Concrete metric (v2 design, v3 implementation):** per-archetype anomalous-underperformance index:

```
A(archetype) = (ROI(archetype) − ROI(global)) / sqrt(N(archetype))
```

Where N is the archetype sample size. Negative A persisting at |A| > 1.5 across two consecutive 30-day rolling windows: flag for model-bug investigation, not threshold tightening. Recorded in `experiment_learning_journal.findings` with `analysisType = 'distribution_drift'`.

**Why this matters for the design:** if a Tier B/C archetype shows persistent A(archetype) << 0, *do not* respond by tightening that archetype's graduation thresholds — that just hides the bug. The correct response is feature-engineering review (do `home_af_*` stats from women's leagues mean what the model thinks they mean?) and potentially per-archetype model fine-tuning (out of scope for Phase 2, but Phase 2 surfaces the data that justifies it).

**Confidence:** ANALYTICAL — the metric is reasonable but unvalidated until v3 has data. Adjust normalisation factor (sqrt(N) vs log(N) vs N) once empirical behaviour is observed.

### 1.6 Confidence flags (refined)

- §1.2 thresholds (excluding the 50% number): ANALYTICAL — derived from existing engine defaults plus design intent.
- §1.2.6 50% retention number: HAND-WAVY in v2; recalibration plan flagged for v3.
- §1.3 mitigations: EVIDENCE-BASED (#1 reuses verified demotion code); ANALYTICAL (#2 reframing — see §2.1 below).
- §1.4 rollback: EVIDENCE-BASED.
- §1.5 distribution-shift framing: ANALYTICAL.

---

## 2. Investigation findings (revised in §2.1, §2.3, §2.4; §2.2/§2.5 unchanged)

### 2.1 Settlement coverage — REFRAMED as structural-bias test

The v1 framing was: "find leagues where settlement rate < 90% on a 50-fixture sample, exclude them." This is the wrong test. It treats settlement coverage as if it were the metric of interest, when the metric of interest is *bias*.

**Reframed test (v2):** for each league with ≥30 historical bets, compute:

```
settlement_rate(predicted_win)  = bets settled in {won,lost,void} / total bets   for bets where model_probability > 0.55
settlement_rate(predicted_lose) = bets settled in {won,lost,void} / total bets   for bets where model_probability < 0.45
```

Then the structural-bias index:

```
B(league) = settlement_rate(predicted_win) − settlement_rate(predicted_lose)
```

If `|B| < 0.05`: settlement is unbiased; the league can be admitted to the experiment track regardless of absolute coverage (down to a floor of ~50% — below that, sample-size pain dominates anyway).
If `0.05 ≤ |B| < 0.10`: borderline; admit at Tier C (probationary, will re-test on accumulating data).
If `|B| ≥ 0.10`: structural bias detected; route to Tier D (no betting) until investigated.

**Why a confidence-bucketed test:** if the model predicts both wins and losses and BOTH fail to settle at the same rate, the unsettled fraction is independent of predicted outcome → ROI estimate from settled subset is unbiased. The model's decision is the only quantity we get to use as a proxy for "true outcome," because we never observe true outcomes for unsettled bets.

**Edge case:** for new leagues with no historical bets, defer the bias test until 30 bets accumulate; admit at Tier C in the interim.

**Verification SQL (read-only — REQUIRES EXPLICIT APPROVAL to run):**

```sql
WITH bet_outcomes AS (
  SELECT
    m.league,
    pb.id,
    pb.model_probability::numeric AS p,
    CASE WHEN pb.status IN ('won','lost','void') THEN 1 ELSE 0 END AS settled
  FROM paper_bets pb
  JOIN matches m ON m.id = pb.match_id
  WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
    AND pb.placed_at < NOW() - INTERVAL '7 days'  -- give settlement time
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
WHERE n_pred_win >= 15 AND n_pred_lose >= 15
ORDER BY ABS(srate_pred_win - srate_pred_lose) DESC NULLS LAST
LIMIT 100;
```

**Acceptance gate during 2.A:** for each league entering Tier B/C, compute the bias index. If `|B| ≥ 0.10`, route to Tier D regardless of other signals. Re-evaluate quarterly.

**Confidence:** EVIDENCE-BASED on the code path (settlement filter at `paperTrading.ts:1770-1780`); ANALYTICAL on the 0.05 / 0.10 thresholds.

### 2.2 Feature coverage (unchanged from v1)

See v1 §2.2.

### 2.3 Compute cost — concrete polling-cadence specification (revised)

**Decision:** the "experiment" polling tier runs at `0 7 * * *` (once daily, 07:00 UTC).

**Justification (concrete, non-stacking):** existing tier cron interaction:
- "high" → every cycle (cron `*/30 * * * *` → 48 times/day)
- "medium" → `hour % 6 === 0` → 00:00, 06:00, 12:00, 18:00
- "low" → `hour % 12 === 0` → 00:00, 12:00
- learning loop → `0 3 * * *` (03:00)
- promotion engine → `0 4 * * *` (04:00)
- pre-kickoff CLV (`*/15 * * * *`) — runs every 15 min, ignored for clash analysis
- daily league discovery → `30 0 * * *` (00:30)
- Sunday-only crons: 02:00, 02:30, 04:00, 04:30, 05:00, 05:30, 06:00 (per `scheduler.ts` audit in v1)

Hour 07:00 UTC is **outside all of the above**. It avoids:
- Stacking on 06:00 medium-tier triggers and 06:30 daily.
- Stacking on Sunday 06:00 cron.
- Stacking on 03:00 learning / 04:00 promotion.
- The `0 7 * * *` form makes it a true daily cron (not Sunday-only) so the Tier B/C polling fires every day.

**Cron form:**
```ts
cron.schedule("0 7 * * *", () => { void safeRunExperimentTierOdds(); }, { timezone: "UTC" });
```

(This is a documentation-level specification; no code change in this document.)

**Re-projection at this cadence:**
- 700 leagues × 1 poll/day × ~0.7 fixtures/league/day × 2 calls/fixture ≈ **~980 calls/day** for odds.
- Plus ~700-1,400 calls/day for team stats (amortised, unchanged from v1 estimate).
- Plus ~400 calls/day for H2H lookups.
- **Total added load: ~2,000-2,800 calls/day** — well within the daily 75k cap, and within the 50% throttled cap of ~37,500.

**Throttle behaviour:** if `apiFootballThrottled === true`, skip Tier C polling; keep Tier B at the same `0 7 * * *` cadence. Tier B is the higher-priority experiment subset (clean architecture; "no Pinnacle" is the only blocker).

**Confidence:** EVIDENCE-BASED on cron audit; ANALYTICAL on call-count projection.

### 2.4 Existing experiment pipeline — refined with R6 dependency

See v1 §2.4 plus this addition: **the `clv_source` column from v1 §3.1 is now load-bearing for v2 thresholds.** The CLV threshold `minClv ≥ 1.5` is dropped entirely for `clv_source = 'market_proxy'` and replaced with the stricter ROI/p-value compound in §1.2. The CLV threshold is retained for `clv_source = 'pinnacle'` rows. Until R6 is resolved (separate document, `docs/r6-clv-source-investigation.md`), historical `experiment_registry.currentClv` values cannot be reliably attributed to either source — Phase 2 schema migration must include backfill of `clv_source` from `closing_pinnacle_odds` heuristic.

### 2.5 Learning cron latency (unchanged from v1)

See v1 §2.5.

---

## 3. Proposed architecture (revised)

### 3.1 Schema changes — REQUIRES EXPLICIT APPROVAL

Each migration is a separate commit, sequenced as described in §6.

**Migration 1 — `competition_config` universe tier** (REQUIRES EXPLICIT APPROVAL, **revised from v1**):

```sql
ALTER TABLE competition_config
  ALTER COLUMN api_football_id DROP NOT NULL,             -- NEW: enable Tier D rows
  ADD COLUMN universe_tier TEXT NOT NULL DEFAULT 'unmapped'
    CHECK (universe_tier IN ('A','B','C','D','E','unmapped')),
  ADD COLUMN archetype TEXT,
  ADD COLUMN betfair_competition_id TEXT,
  ADD COLUMN warmup_started_at TIMESTAMPTZ,
  ADD COLUMN warmup_completed_at TIMESTAMPTZ,
  ADD COLUMN universe_tier_decided_at TIMESTAMPTZ,
  ADD COLUMN settlement_bias_index NUMERIC(6,4);          -- NEW: from §2.1 test
CREATE INDEX competition_config_universe_tier_idx
  ON competition_config(universe_tier);
CREATE INDEX competition_config_betfair_competition_id_idx
  ON competition_config(betfair_competition_id)
  WHERE betfair_competition_id IS NOT NULL;
CREATE UNIQUE INDEX competition_config_betfair_only_uniq
  ON competition_config(betfair_competition_id)
  WHERE api_football_id IS NULL;                          -- NEW: enforce uniqueness for Tier D-only rows
```

**Decision on Open Question #1 (v1):** **relax `api_football_id NOT NULL`**, store Tier D rows directly in `competition_config` with `is_active = false`. Rationale: separate table forks the universe; queries that need "all leagues we know about" become harder. Defensive: the new `universe_tier` index + `api_football_id IS NULL` partial unique index disambiguate.

**Migration 2 — `experiment_registry` extensions** (REQUIRES EXPLICIT APPROVAL, **revised**):

```sql
ALTER TABLE experiment_registry
  ADD COLUMN archetype TEXT,
  ADD COLUMN clv_source TEXT NOT NULL DEFAULT 'none'
    CHECK (clv_source IN ('pinnacle','market_proxy','none')),
  ADD COLUMN warmup_completed_at TIMESTAMPTZ,
  ADD COLUMN kelly_fraction REAL NOT NULL DEFAULT 1.0
    CHECK (kelly_fraction >= 0 AND kelly_fraction <= 1.0),
  ADD COLUMN last_evaluated_at TIMESTAMPTZ,
  ADD COLUMN abandoned_at TIMESTAMPTZ,                    -- NEW: cooldown tracking
  ADD COLUMN cooldown_eligible_at TIMESTAMPTZ,            -- NEW: 90-day cooldown end
  ADD COLUMN model_version_at_abandon TEXT,               -- NEW: readmission trigger
  ADD COLUMN experiment_phase_roi REAL,                   -- NEW: edge-survival comparison anchor
  ADD COLUMN candidate_phase_roi REAL;                    -- NEW: edge-survival comparison value
```

**Migration 3 — `paper_bets` shadow stake** (REQUIRES EXPLICIT APPROVAL, **revised**):

```sql
ALTER TABLE paper_bets
  ADD COLUMN shadow_stake NUMERIC(12,2),
  ADD COLUMN shadow_stake_kelly_fraction REAL,            -- NEW: documents which fraction was used
  ADD COLUMN universe_tier_at_placement TEXT,
  ADD COLUMN clv_source TEXT;                             -- NEW: tag at write time
```

**Shadow-stake specification (per v2 review item #2):**
`shadow_stake = full_Kelly_stake × 0.25` for Tier B/C bets. The 0.25 multiplier matches `CANDIDATE_STAKE_MULTIPLIER` at `promotionEngine.ts:40` and `paperTrading.ts:1039`. **Rationale:** to enable apples-to-apples comparison between experiment-phase shadow P&L and candidate-phase real P&L, both must be computed from the same Kelly fraction. Otherwise the edge-survival test in §1.2.6 ("candidate ROI ≥ 50% of experiment ROI") compares stakes with different volatility profiles and the ratio is uninterpretable.

The actual stake placed is £0; the recommended stake (recorded in `shadow_stake`) is `0.25 × full_Kelly`. The `shadow_stake_kelly_fraction` column documents which fraction was applied at placement time so future Kelly-fraction policy changes don't retroactively confuse the comparison.

**Migration 4 — new `graduation_evaluation_log`** (REQUIRES EXPLICIT APPROVAL, unchanged from v1).

**Migration 5 — backfill `clv_source` for historical rows** (REQUIRES EXPLICIT APPROVAL, **NEW in v2** to handle R6):

```sql
-- Heuristic backfill: rows with non-null closing_pinnacle_odds where clv_pct is
-- consistent with the Pinnacle calculation are tagged 'pinnacle'; rows where
-- clv_pct exists but closing_pinnacle_odds is NULL are 'market_proxy'; the rest
-- are 'none'.
UPDATE paper_bets
SET clv_source = CASE
  WHEN clv_pct IS NULL THEN 'none'
  WHEN closing_pinnacle_odds IS NOT NULL
    AND ABS(clv_pct::numeric -
            ((odds_at_placement::numeric - closing_pinnacle_odds::numeric)
             / closing_pinnacle_odds::numeric) * 100) < 0.01
    THEN 'pinnacle'
  WHEN closing_pinnacle_odds IS NULL AND clv_pct IS NOT NULL THEN 'market_proxy'
  ELSE 'market_proxy'  -- pinnacle was overwritten; tag as proxy
END
WHERE clv_source IS NULL;
```

This is the historical clean-up. Run AFTER R6's one-line patch (per `r6-clv-source-investigation.md` §4.3) is shipped, otherwise new bets will continue to be mis-tagged.

**Migration discipline:** schema-then-behaviour-flip with backfill between (per `feedback_race_conditions.md`). v1 sequencing in §6 still applies, with one extra commit gate for migration 5 between 2.A and 2.B.

### 3.2 Three-track gate logic (unchanged from v1 in shape; refined re shadow-stake)

The dispatcher structure at `scheduler.ts:923-1027` is unchanged from v1 §3.2. The shadow-stake implementation in `placePaperBet` is now concrete:

```ts
// In paperTrading.placePaperBet, just before the existing minStake check at line 1056:
if (universeTier === 'B' || universeTier === 'C') {
  const fullKellyStake = stake;
  const SHADOW_KELLY_FRACTION = 0.25;
  // shadow_stake captures what the candidate-tier-equivalent Kelly recommendation was
  shadowStake = Math.round(fullKellyStake * SHADOW_KELLY_FRACTION * 100) / 100;
  shadowStakeKellyFraction = SHADOW_KELLY_FRACTION;
  stake = 0;
  // Skip min-stake check, exposure check, live-concentration check (defensive — at stake=0 they're moot)
}
```

The actual write to `paper_bets` populates both `shadow_stake` and `shadow_stake_kelly_fraction`. This makes the experiment vs candidate phase comparison numerically clean.

**Comparison methodology for §1.2.6 edge-survival test:**

```
experiment_phase_roi = SUM(shadow_pnl) / SUM(shadow_stake)
                       where data_tier='experiment' AND shadow_stake_kelly_fraction = 0.25

candidate_phase_roi  = SUM(settlement_pnl) / SUM(stake)
                       where data_tier='candidate' AND status IN ('won','lost')

edge_retention_ratio = candidate_phase_roi / experiment_phase_roi
```

For `shadow_pnl`: at settlement of a Tier B/C bet, compute what P&L would have been at `shadow_stake` and store it in a new column `shadow_pnl` (added to migration 3). Out of v1 scope; in v2 scope.

**Adding to migration 3:**
```sql
ALTER TABLE paper_bets ADD COLUMN shadow_pnl NUMERIC(12,2);
```

### 3.3 Graduation engine — refined with cooldown and edge-survival

**When does it run** (unchanged from v1): event-driven on settlement, with cron reconciler.

**Tier-change logic (v2):**

| Current tier | Trigger | New tier | Stake mult |
|---|---|---|---|
| `experiment` (Tier B/C, £0) | All §1.2 gates met (sample, ROI, p, LOO, no-bad-week, ≥4 weeks) | `candidate` | 0.25 |
| `experiment` | Sample ≥50 ∧ ROI ≤−10% ∧ p ≤0.10 | `abandoned` | 0 |
| `candidate` | All §1.2.6 gates met (edge retention ≥50%, p ≤0.10 vs breakeven, no week ≤−10%) | `promoted` | 1.0 |
| `candidate` | candidate-phase ROI < −5% | `experiment` | 0 (back to £0) |
| `promoted` | rolling-30 ROI < 0 OR ≥3 consecutive negative weeks | `candidate` | 0.25 |
| `abandoned` | NEW — see below | `experiment` (re-entry) | 0 |

**Permanent-demotion cooldown & readmission (NEW):**

`abandoned` is no longer terminal. Readmission requires **all** of:
1. **Cooldown elapsed**: at least 90 days since `abandoned_at` (i.e., `cooldown_eligible_at = abandoned_at + 90 days` — set automatically at abandonment).
2. **Triggering condition** (any one of):
   - **Major model retrain**: model version major-component differs from `model_version_at_abandon`. Major-component = the part before the first `-` in version string (e.g., `v1.20.0-retrain-400bets` → `v1.20.0`). Defined here so retrain version semantics are concrete.
   - **Manual review**: an `agent_config` row with key `readmit_<experiment_tag>` exists, with explicit human-set value containing a reason (logged into `experiment_learning_journal`).
   - **Archetype reclassification**: if the league's archetype was reassigned by the discovery cron (e.g., a women's league initially mis-labelled as men's was corrected), readmit with the new archetype baseline.
3. **No silent auto-readmit**: cooldown expiry alone does not readmit. One of the three triggers above must fire.

**Why the cooldown:** without this, `abandoned` is permanent and the universe shrinks monotonically — every retrain or feature rollout that fixes a bug doesn't get a chance to revisit the abandoned league. Conversely, no-cooldown auto-readmit risks bouncing the same broken league through the pipeline repeatedly. 90 days is "one quarter of fresh fixtures plus monitoring" — long enough for a model retrain cycle to complete and short enough that legitimately-improved leagues don't wait a year.

**Why model-version-tied readmission:** the model that abandoned a league is the same model that would re-evaluate it without the version trigger. With the trigger, readmission is gated on "the underlying analyst (model) has materially changed."

**Confidence:** ANALYTICAL on the 90-day window; concrete on the trigger semantics.

### 3.4 Discovery sequence redesign — Betfair-first (revised, decision recorded)

Flow shape unchanged from v1 §3.4. The `api_football_id NOT NULL` constraint relaxation is now **decided** (per item #7 above) — Migration 1 above implements it. Tier D rows in `competition_config` carry `api_football_id = NULL`, `universe_tier = 'D'`, `is_active = false`.

**Archetype labelling rules (unchanged from v1)** plus the matcher decision:
- **Library**: token-set ratio (intersection/min set size over normalised tokens) — per `feedback_specify_algorithms.md` recommendation. Inline implementation, ~25 lines, no library dependency. Threshold 0.85. Country as secondary tie-breaker. The existing 4-pass matcher (`leagueDiscovery.ts:1170-1145`) is reused for AF-side; the Betfair-name-side matcher uses token-set ratio with country-prefix normalisation pre-pass.

### 3.5 Sub-phase decomposition (unchanged shape; details in §6)

---

## 4. Risk section (revised)

| # | Risk | Severity | Likelihood | Mitigation | Confidence |
|---|---|---|---|---|---|
| R1 | Self-referential graduation | High | Medium | Edge-survival test (§1.2.6) — explicitly tests "did paper edge survive execution" not just "didn't blow up" | EVIDENCE-BASED |
| R2 | Settlement-coverage producing biased ROI | High | Medium-high | Structural-bias test (§2.1 reframed) — confidence-bucket settlement comparison detects directional bias even at lower coverage | EVIDENCE-BASED on test design; HAND-WAVY without §2.1 SQL run |
| R3 | API-Football compute explosion | Medium | Low | Concrete `0 7 * * *` cadence projects to ~2,000-2,800 calls/day; throttle-aware skip of Tier C | ANALYTICAL |
| R4 | Feature-distribution drift on long-tail archetypes | High | High | Warm-up period (§2.2 v1); distribution-shift detector (§1.5 NEW) flags model bugs vs threshold-tuning needs | EVIDENCE-BASED on warm-up; ANALYTICAL on detector |
| R5 | Archetype mislabelling (v3 issue) | Low for v1/v2 | n/a | Globals in v1/v2; archetype label is recorded but not threshold-active until v3 | EVIDENCE-BASED |
| R6 | CLV-source ambiguity (PRE-EXISTING BUG) | Medium-high (production credibility) | Confirmed (see r6-clv-source-investigation.md) | One-line patch outside Phase 2 stops new contamination; backfill via Migration 5; clv_source-gated thresholds in §2.4 going forward | EVIDENCE-BASED — code paths verified, SQL queries provided for empirical extent |
| R7 | Race condition on stale tier read | Low | Low-medium | Read `experiment_registry` row inside the `placePaperBet` transaction. Bounded loss = one cycle's bets at stale fraction. | ANALYTICAL |
| R8 | Tier D row growth in `competition_config` | Low | Medium | Partial unique index on `betfair_competition_id WHERE api_football_id IS NULL`; `is_active = false` defensively. v3 cleanup if pollution observed. | ANALYTICAL |
| R9 | Divide-by-zero on shadow-stake-only tags in `computeMetricsForExperiment` | Medium | Medium | Existing guard at `promotionEngine.ts:102` (`totalStaked > 0 ? ... : 0`) handles ROI; CLV averaging is null-safe; **systematic grep audit gated as pre-condition for sub-phase 2.B** | EVIDENCE-BASED on existing guards; ANALYTICAL on completeness |
| R10 | Thresholds drafted aspirationally (no historical Tier-A backtest) | Medium | Medium | Sub-phase 2.A retrospective with 4-branch decision tree (§5) | ANALYTICAL |
| R11 | Permanent demotion shrinks universe monotonically (NEW in v2) | Medium | Medium | 90-day cooldown + retrain-trigger or manual-review readmit (§3.3) — no silent auto-readmit | ANALYTICAL |
| R12 | NEW — Betfair Exchange volume-weighted closing line as Tier B/C CLV proxy fails for thin markets | Medium | Medium-high | Investigation deferred to v3. Flagged: if pursued, add `betfair_vw_closing_odds` column and only trust it when matched-volume in the closing 5-minute window exceeds a (TBD) liquidity floor. v2 ships without it; market-proxy CLV continues to be tagged distinctly. | ANALYTICAL |
| R13 | NEW — Edge-survival test depends on shadow_stake matching candidate-tier Kelly fraction | Medium | Low | Schema migration 3 includes `shadow_stake_kelly_fraction` column; comparison methodology in §3.2 reads this column rather than assuming a constant | EVIDENCE-BASED |

---

## 5. Sub-phase plan (revised, with retrospective decision tree)

### Phase 2.A — Universe redefinition (LOW-MEDIUM RISK)

**Goal, two-commit discipline, wall-clock 1.5-2d + 24h:** unchanged from v1.

**Verification gates (revised):**

1. After migration 1: `SELECT COUNT(*) FROM competition_config WHERE universe_tier = 'unmapped'` = total row count (no nulls).
2. After backfill cron run 1: Tier A count ≈ 138 ± 5 (current dual-flag count).
3. **Settlement-bias check on all Tier-A and Tier-B candidate leagues** (§2.1 SQL): mark leagues with `|B| ≥ 0.10` as Tier D before any 2.B work begins.
4. **Retrospective threshold check — 4-branch decision tree (NEW in v2):**

   **Branch logic:**

   | Pass rate | Action | Justification |
   |---|---|---|
   | `>80%` | **Proceed.** Thresholds are roughly correctly calibrated. Continue with v1/v2 thresholds. Re-evaluate after 30d of fresh data. | Most historical Tier A would have graduated under the proposed gates → gates are not aspirationally tight. |
   | `50-80%` | **Defensible-but-tight.** Two diagnoses: (a) if failures cluster at low-sample-size leagues (< 50 bets), the issue is the sample-size threshold — consider lowering to 40 with same ROI/p; (b) if failures cluster at low-CLV-but-positive-ROI leagues, the issue is the CLV threshold — given R6 contamination, drop the CLV threshold from v2's defaults entirely (already done for `clv_source = 'market_proxy'`; consider for `clv_source = 'pinnacle'` too, pending R6 SQL findings). Make the diagnosis explicit and proceed under the adjusted thresholds. | Most failed cases sit at the boundary; a small adjustment likely suffices. |
   | `20-50%` | **STOP — possible R6 contamination.** Investigate whether retrospective is run on contaminated CLV. Re-run on Pinnacle-only CLV (Q4 from r6-clv-source-investigation.md). If still 20-50%, redraft thresholds based on Tier A's empirical distribution: e.g., set ROI floor to median(Tier-A ROI) − 2pp. | Either the data is contaminated or the thresholds are materially miscalibrated. Both need investigation before proceeding. |
   | `<20%` | **HARD STOP — fundamental disconnect.** Threshold drafting was aspirational rather than empirical. Either the proposed graduation gates are too tight to ever clear, OR retrospective data is heavily contaminated. Redraft thresholds based on actual Tier A distribution + a defensive safety margin (e.g., median-10%, but recompute the ROI/p/CLV jointly for Tier A and use the upper-confidence-bound rather than median). | If <20% of historically-validated leagues would clear the gate, the gate isn't measuring the right thing. |

   The retrospective SQL (READ-ONLY, REQUIRES EXPLICIT APPROVAL):

   ```sql
   WITH tier_a AS (
     -- Approximate "current Tier A" via dual-flag pre-Phase-2 truth
     SELECT name FROM competition_config
     WHERE has_pinnacle_odds = true AND has_betfair_exchange = true
   ),
   per_league_metrics AS (
     SELECT
       m.league,
       COUNT(*) FILTER (WHERE pb.status IN ('won','lost')) AS settled,
       SUM(pb.settlement_pnl::numeric) FILTER (WHERE pb.status IN ('won','lost')) AS pnl,
       SUM(pb.stake::numeric)         FILTER (WHERE pb.status IN ('won','lost')) AS stake_total,
       AVG(CASE WHEN pb.closing_pinnacle_odds IS NOT NULL AND pb.closing_pinnacle_odds::numeric > 1
                THEN ((pb.odds_at_placement::numeric - pb.closing_pinnacle_odds::numeric) / pb.closing_pinnacle_odds::numeric) * 100
                ELSE NULL END) FILTER (WHERE pb.status IN ('won','lost')) AS pinnacle_clv,
       COUNT(DISTINCT date_trunc('week', pb.placed_at)) AS weeks
     FROM paper_bets pb
     JOIN matches m ON m.id = pb.match_id
     WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
       AND m.league IN (SELECT name FROM tier_a)
     GROUP BY m.league
   )
   SELECT
     league,
     settled, weeks,
     CASE WHEN stake_total > 0 THEN ROUND(100.0 * pnl / stake_total, 2) END AS roi_pct,
     ROUND(pinnacle_clv::numeric, 3) AS pinnacle_clv,
     CASE WHEN settled >= 50 AND pnl/NULLIF(stake_total,0) >= 0.05 AND weeks >= 3
          THEN 'WOULD_GRADUATE'
          ELSE 'WOULD_FAIL' END AS verdict_v2
   FROM per_league_metrics
   ORDER BY roi_pct DESC NULLS LAST;
   ```

**Approvals required for 2.A:** schema migrations 1, 3, 4, 5; settlement-bias SQL run; retrospective SQL run; decision-branch action confirmation.

**Quick-revert:** drop new columns; existing dual-flag gate continues to work.

### Phase 2.B — Three-track gate (MEDIUM RISK)

Wall-clock 2d + 48h watch.

**Pre-conditions before 2.B begins:**
- 2.A complete and verified.
- R6 patch shipped (per r6-clv-source-investigation.md §4.3).
- Migration 5 (`clv_source` backfill) executed and verified non-null on all `clv_pct IS NOT NULL` rows.
- Divide-by-zero audit complete (R9): grep for `/ stake`, `/ totalStaked`, `stake > 0`, `totalStaked = 0` across `services/`. Confirm all paths handle the shadow-stake (stake=0) case.

**Approvals required:** canary diff (Tier A bet count = pre-2.B exactly); flag-off deploy → 24h confirm → flag-on flip.

**Monitor window (48h):** unchanged from v1.

**Quick-revert:** flip `experiment_track_enabled = false`. No DB rollback needed.

### Phase 2.C — Event-driven graduation (MEDIUM-HIGH RISK)

Wall-clock 2.5-3d + 48h + 7d review.

**Approvals required:** v2 §1.2 thresholds confirmed (after retrospective); LOO test logic; edge-survival 50% number; cooldown 90-day window confirmed.

**Monitor window:** unchanged from v1 plus distribution-drift detector noise check — confirm A(archetype) values are computable and not dominated by outliers.

### Phase 2.D — Probationary tier with reduced-Kelly bankroll segmentation (MEDIUM RISK)

Wall-clock 1.5-2d + 7d.

**v2 refinement:** the ratchet schedule remains `0.25× → 1.0×` with no intermediate step. v3 may add `0.5×` step if data justifies. Confirmed v2 default.

### Phase 2.E — Ongoing settlement and feature audit (LOW RISK)

Wall-clock 1d + 24h.

**v2 refinement:** the audit cron now runs both the structural-bias SQL (§2.1) and the feature-coverage SQL (§2.2) on a weekly cadence. Auto-demotion to Tier D triggers if `|B| ≥ 0.10` for two consecutive runs (avoids single-noisy-week false positives). Alert-only on first run.

### Sub-phase risk summary table (revised)

| Phase | Risk | Wall-clock | Pre-conditions | Monitor | Quick-revert |
|---|---|---|---|---|---|
| 2.A | Low-med | 1.5-2d + 24h | None | Tier A count = 138 ± 5; bias-index for all leagues; retrospective decision-branch resolved | Drop new columns |
| 2.B | Med | 2d + 48h | 2.A complete; R6 patch shipped; Migration 5 verified; divide-by-zero audit passed | Tier-A count unchanged; budget headroom | `experiment_track_enabled = false` |
| 2.C | Med-high | 2.5-3d + 48h + 7d | 2.B stable; thresholds confirmed | Transition rate; no thrashing; distribution-drift index sanity | `event_driven_graduation_enabled = false` (falls back to crons) |
| 2.D | Med | 1.5-2d + 7d | 2.C stable | Kelly fraction reads correctly | Restore hardcoded 0.25× |
| 2.E | Low | 1d + 24h | 2.D stable | Auto-demotions sensible | Disable cron |

**Cumulative pre-approvals required: 14+** (5 schema migrations including R6 backfill; settlement-bias SQL; retrospective SQL; decision-branch resolution; canary diff; flag-off→on transition; threshold sheet incl. edge-survival 50%; LOO test logic; cooldown 90-day; ratchet schedule; audit threshold).

---

## 6. Open questions for v3

(Resolved-in-v2 marked.)

1. ✅ **RESOLVED in v2:** `api_football_id NOT NULL` relaxed; Tier D rows in `competition_config` with `is_active = false` and partial unique index.
2. **Per-archetype graduation thresholds.** v3 work. Trigger: 30+ candidate→promoted transitions accumulated. Methodology: bucket transitions by archetype, compute archetype-specific edge-retention distribution, set per-archetype 50% override = `median(retention) − 1 stddev` (capped at 30% floor and 70% ceiling). DECISION-NEEDED at v3 review.
3. **Fuzzy-match library and threshold for Betfair-side reverse-mapping.** v2 specifies token-set ratio at 0.85 inline. Re-audit after 50-row manual check during 2.A; if accuracy <95%, revisit.
4. **CLV-source threshold calibration for `clv_source = 'pinnacle'` after R6 cleanup.** v2 retains v1 CLV gate at 1.5 only for clean Pinnacle source. Once R6 backfill (Migration 5) executes, run a new retrospective on cleaned data and confirm 1.5 is still the right number for sharp benchmark.
5. **Concurrency/race on registry stale read.** v2 design specifies "read inside `placePaperBet` transaction"; v3 may want explicit FOR UPDATE locking. DESIGN-CHOICE in v3.
6. **`experiment_tag` schema for league-level vs market-level experiments.** v2 keeps `LEAGUE_<canonical>` form; v3 may add `LEAGUE_<x>__MARKET_<y>` composites once we have evidence of per-market edge variation within leagues.
7. **What happens when a Tier A league loses Pinnacle pricing.** v2 specifies: auto-downgrade to Tier B; in-flight bets settle at original tier; new bets at Tier B (£0). Confirm in v3.
8. **`is_active = false` Tier D as Tier E training-only feed.** v2 question: should some Tier D rows still feed Tier E training (i.e., AF-only-no-Betfair leagues with reliable result data)? v2 default: NO — Tier D and Tier E are mutually exclusive (Tier E is `has_betfair_exchange = false AND has_api_football = true`; Tier D is `has_betfair_exchange = true AND has_api_football = false`). Confirm in v3.
9. **Sub-phase 2.E auto-demotion threshold.** v2 specifies two-consecutive-week trigger; confirm 1 week of dry-run before enabling.
10. ✅ **RESOLVED in v2:** Phase 1 multi-market Pinnacle probe lands BEFORE 2.A. Newly-Pinnacle-discovered leagues route through Tier B/C, not auto-Tier-A. Rationale: validated leagues with independent Pinnacle confirmation are the cleanest possible test of the experiment pipeline. If they don't graduate cleanly through Tier B/C → Tier A, the pipeline has a problem and we discover it on calibrated leagues rather than in the long tail. Phase 1 itself is a single-cron-update job; its work order is unchanged.
11. **Per-archetype Betfair Exchange closing-line liquidity.** R12 deferred to v3. Need empirical: for each Tier B/C league, what's the matched-volume distribution in the kickoff-minus-5-min window? If P50 < (TBD floor, e.g., £500), the Exchange-VW closing line is not a usable sharp proxy and the design must rely on ROI/p/WR alone. INVESTIGATION-DEFERRED to v3.
12. **Distribution-shift detector calibration.** §1.5 metric `A(archetype)` uses sqrt(N) normalisation; once data accumulates, compare to log(N), N, and other forms. Pick the one that gives stable rank ordering. v3 work.

---

## 7. What this document explicitly does NOT do

- Does not propose any code edits. (R6 patch in `r6-clv-source-investigation.md` is recommended but separate.)
- Does not run any SQL or DML.
- Does not make `clv_source` a hard requirement before v2 backfill — Migration 5 handles historical rows.
- Does not modify Tier A behaviour.
- Does not commit, push, or deploy.

---

## 8. Sign-off checklist for v3 progression

Before this document advances to v3, the following must resolve:

- [ ] Run Q1-Q4 from `r6-clv-source-investigation.md` and report counts.
- [ ] Apply R6 one-line patch (`paperTrading.ts:1975` conditional spread) per r6-clv-source-investigation.md §4.3.
- [ ] Run §2.1 settlement-bias SQL on Tier-A/B candidates.
- [ ] Run §2.3 API-Football usage SQL; confirm cost projection headroom.
- [ ] Run §5 phase 2.A retrospective SQL; resolve to one of four decision branches.
- [ ] Confirm or revise §1.2 thresholds (LOO logic, edge-survival 50%, no-week-≤-15%).
- [ ] Confirm §3.3 cooldown 90-day window and triggers.
- [ ] Confirm §3.2 shadow-stake = 0.25 × full Kelly.
- [ ] Decide v3 open questions #2, #4, #11, #12 (or defer to v4).

When all resolved, draft v3 against the empirical findings.
