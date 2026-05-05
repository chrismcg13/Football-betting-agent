# Phase 2 — Shadow Experiment Architecture (v1)

**Status:** v1 design draft for review. **Not for implementation.** No code edits, no migrations, no commits, no deploys made by this document.

**Author:** Claude (plan-mode session, 2026-05-04)
**Working tree:** `C:\Users\chris\projects\Football-betting-agent\` (commit unknown — git not initialised in working dir; replit-style)
**Cited code state:** as of files read 2026-05-04
**Methodology:** investigation first, design after. Every numerical claim cited to file:line OR flagged ANALYTICAL/HAND-WAVY. Every schema and DML change flagged **REQUIRES EXPLICIT APPROVAL**.
**Note on `CLAUDE.md`:** the original prompt references `CLAUDE.md`. There is no `CLAUDE.md` in the repo; `replit.md` (project root) is the equivalent project-context document and was used as the source of truth.

---

## 0. Executive Summary

The current dual-flag gate (`has_pinnacle_odds AND has_betfair_exchange`, `scheduler.ts:944-948`) does two distinct jobs simultaneously: (1) it acts as a **market-quality validator** by requiring a Pinnacle line for CLV computation, and (2) it acts as a **universe gatekeeper** by deciding which leagues are bet-eligible. Conflating these is the architectural bug. Pinnacle is a fast external sharp benchmark — useful but not the only path to evidence. The graduated experiment pipeline (already partially built — `experimentRegistry`, `promotionEngine.ts`, `promotion_audit_log`) is a slow internal benchmark that does not require Pinnacle. Both should be legitimate paths to live capital, with different latency, cost, and trust profiles.

The proposed redesign is a **three-track system** (Production / Experiment / Training-only) seated on top of a **Betfair-first universe definition** (Betfair Exchange's `listCompetitions("1")` is the trading universe by definition; everything else is overlay metadata). For each Betfair competition we attempt forward mapping to API-Football (settlement + features) and to OddsPapi/Pinnacle (CLV benchmark), classifying leagues into tiers A-E. Tier A (Betfair + AF + Pinnacle) is production. Tier B/C (Betfair + AF, no/unreliable Pinnacle) is experiment-track at £0 shadow stake, with internal-data-driven graduation. Tier D (Betfair only, unmapped) is logged for manual investigation. Tier E (AF only, no Betfair) feeds training data without execution. The 138-league dual-eligible count from the recent expansion becomes a *verification target* (Tier A should equal 138 ± the substring-matcher noise band) for the universe migration in sub-phase 2.A.

The dangerous failure mode is **self-referential graduation**: an internally-biased model graduates a league by exploiting its own bias and then loses real money. The mitigation has two parts. First, the existing 3-tier promotion engine (experiment → candidate → promoted, `promotionEngine.ts:6-38`) is reused as the probationary mechanism — candidate-tier already runs at `CANDIDATE_STAKE_MULTIPLIER = 0.25` (line 40). Second, the user's proposed thresholds (50+ bets, ROI > 5%, WR > 53%, p < 0.05) become the *experiment→candidate* gate (stricter than current defaults), and a new candidate→promoted gate evaluates against *live* (real-money) performance for an additional ~100 bets. The graduation question is not "does the data look good?" — it is "does the data look good when the bets that produced it actually went out the door, and continue to look good when real money rides on them?"

The redesign requires (a) **schema additions** (universe tier, archetype, Betfair competition id, shadow stake — all flagged below), (b) **gate logic restructuring** at `scheduler.ts:923-1027` to dispatch by tier rather than reject by flag, (c) an **event-driven graduation evaluator** to close the worst-case 28h latency gap (learning cron 03:00 UTC + promotion cron 04:00 UTC), and (d) a **Betfair-first reverse-mapping discovery cron** to invert the current `syncBetfairCompetitionCoverage` (`leagueDiscovery.ts:1147-1280`) which only annotates pre-existing AF-derived rows.

This work is sequenced as five sub-phases (2.A schema + universe; 2.B three-track gate; 2.C event-driven graduation; 2.D probationary/Kelly-fractional bankroll segmentation; 2.E ongoing audit). Each is independently shippable behind feature flags with explicit approval gates. Estimated wall-clock 7-12 implementation days across the 5 sub-phases, plus 24-48h monitor windows after each medium+ phase. Plan-mode for v2/v3 will iterate on this document; no code lands until v3 is approved per sub-phase.

---

## 1. "What does graduation mean?" — The framing question

This is the most important page of the document. Every other design decision is downstream of it.

### 1.1 The claim

A league has **graduated** when we trust internal performance data alone (no external sharp benchmark) sufficiently to allocate real capital to bets in that league at unconstrained Kelly fraction. Graduation is a *trust assertion about the model* on a *specific data subset*, not a property of the league.

### 1.2 What evidence is sufficient?

A graduated league must clear all of:
- **Sample size**: ≥50 settled bets in the league (v1 default; per-archetype overridable). Below this, single-team variance dominates; ROI/WR estimates are too noisy.
- **Profitability**: ROI ≥ 5% (v1 default). Tighter than current `experimentToCandidate` threshold of 3% (`promotionEngine.ts:9`) because non-Pinnacle leagues lack the sharp-benchmark CLV that catches structural mis-pricing.
- **Statistical confidence**: Win rate vs implied-probability prior with p < 0.05 (one-sided z-test). The existing `computePValue` (`promotionEngine.ts:53-61`) is reusable. **Note**: current `experimentToCandidate.maxPValue` is 0.10; we tighten to 0.05.
- **Time stability**: ≥3 weeks active *and* not all profit concentrated in one week (≤60% of total ROI from any single week — new check).
- **No catastrophic week**: max single-week ROI drawdown ≤ −15% across the sample window.
- **Probationary survival**: ≥100 *real-money* candidate-tier bets at 25% Kelly with ROI ≥ 0% before full promotion. This is the candidate→promoted gate. The existing `candidateToPromoted` block (`promotionEngine.ts:16-22`) is reusable; we adjust thresholds.

### 1.3 What is the failure mode if wrong?

Three failure modes, ranked by severity:

1. **Self-referential graduation (highest risk).** Model has a systematic bias (e.g., overweights home form for women's leagues where home-advantage prior is different). It generates fake edge in those leagues during the experiment phase, "graduates" them on its own confidence, then loses real money. Evidence: the model and the evaluator are the same system; positive feedback is structurally available.
   - **Mitigation:** the candidate→promoted gate runs on *real-money* bets at 25% Kelly. If the model's edge is illusory, real-money performance reveals it before full promotion at minimal capital cost (~£300-£800 estimated drawdown per failed graduation at 0.25× Kelly on ~100 bets — ANALYTICAL).
   - **Residual risk:** real-money 25%-Kelly bets are still real losses. Accepted with monitoring.

2. **Settlement-gap false positives.** Bets in a league don't settle (API-Football missing fixture results), so the bet is voided or stuck pending. The model's evaluation never sees a "lost" outcome. Apparent ROI is biased upward.
   - **Mitigation:** see §2 (settlement audit) — leagues with <90% settlement on a 50-fixture sample are excluded from the experiment track entirely.

3. **Selection bias from £0 stake decisions.** The £0 shadow-stake decisions are made under different liquidity/exposure constraints than real-money decisions. If the model is more aggressive at £0 (no exposure cap), graduated leagues may not perform identically when real money applies the cap.
   - **Mitigation:** the candidate→promoted gate validates under real-money constraints. Accepted-with-monitoring otherwise.

### 1.4 Rollback procedure when a graduated league starts losing

The existing demotion logic (`promotionEngine.ts:268-290`, `demotionPromotedToCandidate`) handles this. Trigger conditions: rolling-30 ROI < 0, OR CLV < 0, OR ≥3 consecutive negative weeks. v1 keeps these; v2 may tighten.

**Quick-revert (manual):** set `data_tier = 'candidate'` on `experiment_registry` row + flip `competition_config.universe_tier = 'B'` for the league. Existing 0.25× Kelly multiplier reapplies on next cycle. No code deploy required.

**Hard kill:** set `competition_config.is_active = false` for the league. All trading paths skip it.

### 1.5 Distinguishing "genuinely profitable" from "ran hot"

This is the unsolved hard problem of small-sample sports betting. Mitigations:
- p<0.05 against implied-probability prior eliminates the easiest version of the question.
- Probationary candidate-tier (100 real-money bets at 0.25× Kelly) is the empirical answer: re-test in production conditions before trusting.
- **Per-archetype baselines** (v2 work): if the women's-football archetype shows median graduated-league ROI of −2% but this specific league shows +6%, that's stronger than +6% in isolation. Out of v1 scope; flagged as open question.

### 1.6 Confidence on this section

- §1.2 thresholds: **ANALYTICAL** — derived from existing promotion-engine defaults plus user-stated v1 targets. Will need retrospective validation against existing `paper_bets` data once Phase 2.A is in place.
- §1.3 mitigations: **EVIDENCE-BASED** for #2 (settlement audit query is concrete); **ANALYTICAL** for #1 magnitude estimate.
- §1.4 rollback paths: **EVIDENCE-BASED** — existing demotion code paths verified at `promotionEngine.ts:256-290`.

---

## 2. Investigation findings

### 2.1 Settlement coverage audit (Investigation #1)

**Finding (analytical, requires DB confirmation):** Settlement is gated by `matches.status ∈ SETTLEMENT_MATCH_STATUSES` AND non-null `homeScore` / `awayScore` (`paperTrading.ts:1770-1817`). Score population is driven by `fetchRecentFixtureResults` (`apiFootball.ts:714-736`) which filters API-Football `/fixtures` by date and `status.short ∈ {FT, AET, PEN}`. **Therefore: settlement coverage ≡ API-Football fixture-status coverage.**

**Empirical % settlement on a 50-fixture sample of non-Pinnacle Betfair-tradeable leagues:** **CANNOT BE ANSWERED FROM CODE READ ALONE — REQUIRES DB QUERY.** Confidence: HAND-WAVY without it. The query is straightforward read-only and is proposed below for execution under §6 sub-phase 2.A as the first verification gate; do NOT run as part of this plan-mode session.

**Proposed verification SQL (REQUIRES EXPLICIT APPROVAL TO RUN — read-only, but flagged for completeness):**
```sql
-- Sample 50 most recent finished fixtures per league among Betfair-flagged non-Pinnacle leagues
WITH eligible AS (
  SELECT name FROM competition_config
  WHERE has_betfair_exchange = true AND has_pinnacle_odds = false
),
recent AS (
  SELECT m.league, m.id, m.status, m.home_score, m.away_score,
         ROW_NUMBER() OVER (PARTITION BY m.league ORDER BY m.kickoff_time DESC) AS rn
  FROM matches m
  WHERE m.league IN (SELECT name FROM eligible)
    AND m.kickoff_time < NOW() - INTERVAL '2 days'
    AND m.kickoff_time > NOW() - INTERVAL '60 days'
)
SELECT
  league,
  COUNT(*) AS sample_size,
  SUM(CASE WHEN status IN ('finished','full-time','after-extra-time','penalty-shootout')
             AND home_score IS NOT NULL AND away_score IS NOT NULL THEN 1 ELSE 0 END) AS settled,
  ROUND(100.0 * SUM(CASE WHEN status IN ('finished','full-time','after-extra-time','penalty-shootout')
             AND home_score IS NOT NULL AND away_score IS NOT NULL THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS pct_settled
FROM recent WHERE rn <= 50
GROUP BY league
ORDER BY pct_settled ASC NULLS FIRST
LIMIT 100;
```

**v1 design rule (regardless of sample numbers):** archetypes that historically lack reliable AF result coverage should be excluded from Tier A/B/C and routed to Tier D. Empirically suspected (HAND-WAVY without query): lower-tier amateur leagues, friendlies-only competitions, women's lower divisions in non-major federations. Inclusion gate is **≥90% settlement on a 50-fixture rolling sample**.

### 2.2 Feature coverage audit (Investigation #2)

**Finding (evidence-based):** `featureEngine.ts:550-571` defines the AF-fallback chain:

```
hasDbHistory = homeHistCount >= 3 && awayHistCount >= 3   // line 552
homeForm5  = hasDbHistory ? homeFormDb : (homeAfForm ?? 0.5)              // line 566
homeGoals  = hasDbHistory ? homeGoalsDb : (homeAfGoalsFor ?? 1.3)         // line 568
... etc
```

There are **3 fallback layers**:
1. DB history (≥3 home + ≥3 away matches in `matches` table)
2. API-Football team stats (`home_af_form_last10`, `home_af_goals_scored_avg`, etc.) when (1) fails
3. Hardcoded constants (0.5 form, 1.3 goals, 0.4 H2H, etc.) when (2) also fails

**Implications for the experiment track:**
- A new league entering at Phase 2.A start has **zero** DB history. Layer (1) fails.
- For lower-division and women's leagues, AF stats endpoints often return empty bodies (HAND-WAVY without empirical query — verifiable via `SELECT count(*) FROM features WHERE feature_name LIKE '%_af_%' AND match_id IN (SELECT id FROM matches WHERE league = '<name>')`). Layer (2) likely fails.
- Layer (3) defaults give the model a near-neutral input. Predictions in this regime are essentially the prior — value detection will fire only on extreme price misalignments and is statistically suspect.

**v1 warm-up rule:** A league enters Tier B/C at universe-tier flag time but **does NOT count toward the graduation 50-bet sample** until either (a) ≥3 settled DB matches per team for ≥80% of teams in the league exist, OR (b) AF team-stats coverage ≥70% of fixtures shows non-null `home_af_*`. Whichever comes first. The `experiment_registry.tier_changed_at` already tracks the entry timestamp — we add a `warmup_completed_at` column.

**v1 sparse-feature exclusion:** archetypes flagged with feature-coverage <40% on layer (2) are routed to Tier D (no betting) until coverage improves.

### 2.3 Compute cost projection (Investigation #3)

**Finding (evidence-based):**
- Daily cap: `MAX_DAILY_CAP = 75_000` (`apiFootball.ts:30`)
- Monthly cap: `MONTHLY_CAP = 75_000 * 30 = 2,250,000` (`apiFootball.ts:26`)
- Throttle trigger: monthly projection ≥ 90% (`apiFootball.ts:578`) → daily cap halves to ~37,500
- Polling tiers (`apiFootball.ts:1148-1153`):
  - `high`: every cycle (cron `*/30 * * * *` → 48 cycles/day)
  - `medium`: every 6h (`hour % 6 === 0`)
  - `low`: every 12h (`hour % 12 === 0`)
  - `dormant`: never
- Default for non-Pinnacle leagues (`apiFootball.ts:1131-1135`): if `tier === 1` → high; if `hasPinnacleOdds` → high; if `tier === 2` → low; else → dormant.

**Critical gap:** Tier B/C leagues under the current rules default to `dormant` (no `hasPinnacleOdds`, almost certainly `tier ∉ {1,2}`). They will not be polled. The experiment track requires a new polling tier or a flag override.

**Projection (ANALYTICAL):** 400-700 experiment leagues at "low" cadence (1×/12h = 2 cycles/day per league). Each cycle's odds fetch is ~1-3 API calls per fixture (per `fetchAndStoreOddsForFixture`). At ~5 fixtures/league/week ≈ 0.7 fixtures/league/day:
- 700 leagues × 2 polls/day × 0.7 fixtures × 2 calls/fixture ≈ **~1,960 calls/day** added.
- Plus settlement queries: `fetchRecentFixtureResults` runs per-day-of-window (~7 calls/day for Tier B/C combined — small).
- Plus team-stats fetches (`fetchTeamStatsForUpcomingMatches`): ~2 calls per new fixture, amortised ~700-1,400 calls/day.
- Plus H2H lookups (`fetchH2HFromApiFootball` at `featureEngine.ts:597`): 1 call per match per feature run, ~400/day.

**Total estimated added load: ~3,000-5,000 calls/day** on top of current usage. Within 75k daily cap headroom UNLESS current usage is already >70k/day. Verification SQL (read-only, REQUIRES EXPLICIT APPROVAL to run):

```sql
SELECT date, SUM(request_count) AS total
FROM api_usage
WHERE date >= TO_CHAR(NOW() - INTERVAL '14 days', 'YYYY-MM-DD')
  AND endpoint NOT LIKE 'oddspapi_%'
GROUP BY date ORDER BY date DESC;
```

If average daily usage is currently >65k, sub-phase 2.A must include polling-cadence redesign before the universe expansion. v1 proposal: introduce **"experiment"** polling tier = 1×/24h (i.e., `hour === 6` only) for Tier B/C. Halves the projected addition to ~1,000 calls/day. Tradeoff: 24h staleness on odds for low-priority leagues is acceptable for a £0 shadow track; less acceptable in Tier A.

**v1 throttling guardrail:** if `apiFootballThrottled === true` (50% cap activated), skip Tier C polling entirely; keep Tier B at minimum cadence.

### 2.4 Existing experiment pipeline audit (Investigation #4)

**Findings (evidence-based, schema verified at `lib/db/src/schema/`):**

| Table | Purpose | Phase-2 sufficiency |
|---|---|---|
| `experiment_registry` (`experimentRegistry.ts:9-25`) | Per-tag tier state, current metrics | **Partial.** Has `leagueCode`, `marketType`, `dataTier`, `currentSampleSize`, ROI/CLV/WR/p-value, `consecutiveNegativeWeeks`. **Missing for Phase 2:** `archetype`, `warmupCompletedAt`, `kellyFraction`, `lastEvaluatedAt`. |
| `promotion_audit_log` (`promotionAuditLog.ts:8-18`) | Tier-change audit trail | **Sufficient.** `metricsSnapshot` jsonb already accommodates archetype context. |
| `experiment_learning_journal` (`experimentLearningJournal.ts:8-16`) | Cron-run findings/recommendations log | **Sufficient.** No structural change needed. |
| `paper_bets` (`paperBets.ts:18-124`) | Bet records | **Partial.** Already has `dataTier`, `experimentTag`, `qualificationPath`, `liveTier`, `syncEligible`, `promotedAt`, `promotionAuditId`. **Missing for Phase 2:** `shadowStake` (numeric, the Kelly recommendation when actual stake = 0). |
| `competition_config` (`competitionConfig.ts:12-36`) | League-level eligibility | **Mostly absent.** Has `hasPinnacleOdds`, `hasBetfairExchange`, `tier ∈ {1,2,3}`. **Missing for Phase 2:** `universeTier ∈ {A,B,C,D,E}`, `archetype`, `betfairCompetitionId`, `warmupStartedAt`. |
| `discovered_leagues` (`discoveredLeagues.ts:12-28`) | Auto-discovered (AF-side) candidates | Used by current discovery. Largely orthogonal — kept as-is. |
| `oddspapi_league_coverage` (`oddspapiLeagueCoverage.ts:11-18`) | OddsPapi-side coverage | Sufficient for Tier C lookup. |

**Promotion engine (`promotionEngine.ts`) audit:**
- Already implements 3-tier + abandoned (lines 6-38). v1 *thresholds* match the design intent at experiment→candidate (current 3% ROI, proposed 5%; current p≤0.10, proposed p≤0.05). **Adjustable via env vars** (`PROMO_MIN_ROI`, `PROMO_MAX_P_VALUE` etc.) — no code change needed for threshold tightening.
- Already has `CANDIDATE_STAKE_MULTIPLIER = 0.25` (line 40) which IS the probationary mechanism. **Reuse, do not duplicate.**
- Already keyed by `experimentTag`, but per-league graduation needs `experimentTag` to be either the league name or a `<league>:<archetype>` composite. v1 proposal: tag format `LEAGUE_<canonical_name_lower>` for league-level experiments; composite forms reserved for v2.
- **Critical gap (analytical):** the engine requires `currentClv ≥ 1.5` for promotion (line 11). Tier B/C bets have CLV computed against the latest API-Football snapshot (`paperTrading.ts:1939-1957`) — same source, different time = a much weaker signal than Pinnacle CLV. Threshold semantics do not transfer. **v1 proposal:** add a new column `clv_source ∈ {'pinnacle','market_proxy','none'}` to `experiment_registry` and gate threshold by source. For `market_proxy` source, drop minClv requirement and substitute a stricter ROI/p-value compound.

### 2.5 Learning cron latency (Investigation #5)

**Findings (evidence-based, scheduler.ts):**
- Learning loop: `cron.schedule("0 3 * * *", ...)` (line 2021) → daily 03:00 UTC.
- Promotion engine: `cron.schedule("0 4 * * *", ...)` (line 2070) → daily 04:00 UTC.
- Weekly experiment analysis: `cron.schedule("0 4 * * 0", ...)` (line 2092) → Sundays 04:00 UTC.
- Settlement is opportunistic — runs as part of every trading cycle (`settleBets()` invoked inside the trading flow) but matches must already have `home_score`/`away_score` populated by `syncMatchResults` which is itself cron-driven.

**Latency gap:** A bet that crosses graduation threshold via settlement at, say, Sunday 23:59 UTC does not graduate until Monday 04:00 UTC at earliest. **Worst-case ~28h end-to-end latency** between threshold-crossing settlement and tier change in DB.

**Why this matters:**
- During those 28h, subsequent bets in the same league/tag are sized at the OLD tier's Kelly fraction. If the league was about to graduate from candidate (0.25× Kelly) to promoted (1× Kelly), 28h of bets are under-sized.
- Conversely, if a league was about to be demoted from promoted → candidate due to a losing streak, 28h of bets stay at full Kelly.

**v1 mitigation (proposed in §3.4):** event-driven evaluation triggered on each settlement — incremental update of `experiment_registry` metrics, then a tier-change check. Falls back to the existing 03:00/04:00 crons as a safety net.

---

## 3. Proposed architecture

### 3.1 Schema changes — REQUIRES EXPLICIT APPROVAL

Each ALTER below is a separate migration file, sequenced as described in §6.

**Migration 1 — `competition_config` universe tier columns** (REQUIRES EXPLICIT APPROVAL):
```sql
ALTER TABLE competition_config
  ADD COLUMN universe_tier TEXT NOT NULL DEFAULT 'unmapped'
    CHECK (universe_tier IN ('A','B','C','D','E','unmapped')),
  ADD COLUMN archetype TEXT,  -- nullable; backfill in separate step
  ADD COLUMN betfair_competition_id TEXT,  -- nullable; backfill from Betfair sync
  ADD COLUMN warmup_started_at TIMESTAMPTZ,
  ADD COLUMN warmup_completed_at TIMESTAMPTZ,
  ADD COLUMN universe_tier_decided_at TIMESTAMPTZ;
CREATE INDEX competition_config_universe_tier_idx ON competition_config(universe_tier);
CREATE INDEX competition_config_betfair_competition_id_idx ON competition_config(betfair_competition_id) WHERE betfair_competition_id IS NOT NULL;
```

**Migration 2 — `experiment_registry` extensions** (REQUIRES EXPLICIT APPROVAL):
```sql
ALTER TABLE experiment_registry
  ADD COLUMN archetype TEXT,
  ADD COLUMN clv_source TEXT NOT NULL DEFAULT 'none'
    CHECK (clv_source IN ('pinnacle','market_proxy','none')),
  ADD COLUMN warmup_completed_at TIMESTAMPTZ,
  ADD COLUMN kelly_fraction REAL NOT NULL DEFAULT 1.0
    CHECK (kelly_fraction >= 0 AND kelly_fraction <= 1.0),
  ADD COLUMN last_evaluated_at TIMESTAMPTZ;
```

**Migration 3 — `paper_bets` shadow stake** (REQUIRES EXPLICIT APPROVAL):
```sql
ALTER TABLE paper_bets
  ADD COLUMN shadow_stake NUMERIC(12,2),  -- Kelly recommendation when actual stake forced to 0
  ADD COLUMN universe_tier_at_placement TEXT;  -- denormalized for retrospective queries
```

**Migration 4 — new `graduation_evaluation_log`** (REQUIRES EXPLICIT APPROVAL):
```sql
CREATE TABLE graduation_evaluation_log (
  id TEXT PRIMARY KEY,
  experiment_tag TEXT NOT NULL,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('settlement','cron','manual')),
  trigger_bet_id INTEGER REFERENCES paper_bets(id),
  metrics_snapshot JSONB NOT NULL,
  threshold_outcome TEXT NOT NULL CHECK (threshold_outcome IN ('promote','demote','hold','warmup','insufficient_data')),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX gel_tag_evaluated_idx ON graduation_evaluation_log(experiment_tag, evaluated_at DESC);
```

**Migration discipline (per memory feedback `feedback_race_conditions.md`):** schema migration and behavioural switch ship in **two separate commits** with backfill in between. v1 sequencing in §6.

### 3.2 Three-track gate logic

The current gate at `scheduler.ts:923-1027` is a single rejection filter. The redesign restructures this into a **dispatcher**:

```
candidates from value detection
    │
    ▼
[Universe-tier lookup]  — single SQL: SELECT name, universe_tier, archetype FROM competition_config
    │
    ├─ Tier A → PRODUCTION track   (existing dual-flag rules continue to apply
    │                               — Pinnacle CLV gate, exposure caps, drawdown
    │                               circuit breakers, 1× Kelly with all multipliers)
    │
    ├─ Tier B → EXPERIMENT track   (£0 actual stake; record shadow_stake = Kelly recommendation;
    │   or C                        bypass risk circuits; bypass exposure caps; data_tier='experiment'
    │                               in paper_bets; experiment_tag = 'LEAGUE_<canonical>')
    │
    ├─ Tier D → REJECT (logged for manual investigation)
    │
    └─ Tier E → never reaches here (no Betfair = no candidates generated)

Tier-A candidates also pass through:
    [Pinnacle CLV gate (existing pinnacle_pre_bet_filter)]
    [Permanent-disabled-markets filter]
    [Per-market edge floor filter]
    [Correlation detection — already runs]
    [placePaperBet → Kelly stake calc → exposure gate → live concentration gate]

Tier-B/C candidates skip the Pinnacle CLV gate entirely. They still pass through:
    [Permanent-disabled-markets filter]   ← keep, applies universally
    [Per-market edge floor filter]        ← keep
    [Correlation detection]               ← keep, applies universally
    [Stake = 0; record shadow_stake]      ← NEW path in placePaperBet
```

**Where the £0 stake bypass happens:** inside `placePaperBet`, specifically the existing stake calculation block (`paperTrading.ts:962-1054`). New branch:

```ts
// NEW: Tier B/C shadow-stake path
if (universeTier === 'B' || universeTier === 'C') {
  const shadowStake = stake;  // what Kelly would have recommended
  stake = 0;                  // actual stake
  // ... record shadow_stake in DB
  // Skip the minimum-stake check at line 1056-1058
  // Skip exposure check at line 1071-1086 (irrelevant at stake=0 but defensive)
  // Skip live concentration check at line 1089-1094
}
```

**How risk controls are bypassed without weakening production safety:**
- The bypass is *positively gated* by `universeTier ∈ {B,C}`. Tier-A code path is **untouched**.
- The bypass is bracketed in a single `if` block; review surface area is minimal.
- £0 stake is genuinely £0 — exposure aggregation already sums non-negative numbers. A Tier B bet contributes 0 to `getTotalPendingExposure()`.
- Drawdown circuit breakers measure realised P&L; £0 stakes can never produce realised P&L, so they are invisible to circuit-breaker math.

**Rollback:** flip a config flag `experiment_track_enabled` to `false` and the dispatcher routes Tier B/C candidates to REJECT. No DB migration rollback required.

### 3.3 Graduation engine design

**When does it run:**
- **Event-driven (primary path):** at the end of `_settleBetsInner()` (`paperTrading.ts:1747`), after each batch of settled bets, for each unique `experiment_tag` touched, recompute `experimentMetrics` for that tag and check threshold conditions. If threshold crossed, immediately update `experiment_registry.dataTier` and `kellyFraction`, and write a `graduation_evaluation_log` row.
- **Cron-driven (safety net):** the existing `runPromotionEngine` at 04:00 UTC continues to run. It now serves as a reconciler for any tag whose settlement was missed event-side (e.g., `reconcileSettlements` for real-money matched bets at `paperTrading.ts:1832-1837` runs out-of-band).

**Per-archetype threshold overrides:**
- v1 default thresholds are the values in §1.2.
- An optional `agent_config` row keyed `graduation_thresholds_<archetype>` (JSON) can override per-archetype. v2 work to define the override schema; v1 ships with global defaults only.

**Tier-change logic (v1):**

| Current tier | Trigger | New tier | Stake multiplier |
|---|---|---|---|
| `experiment` (Tier B/C, £0) | Sample ≥50 ∧ ROI ≥5% ∧ WR ≥53% ∧ p ≤0.05 ∧ ≥3 weeks ∧ no week >60% concentration | `candidate` (real-money 0.25× Kelly) | 0.25 |
| `experiment` | Sample ≥50 ∧ ROI ≤−10% ∧ p ≤0.10 | `abandoned` | 0 (no further bets) |
| `candidate` | Real-money sample ≥100 ∧ candidate-tier ROI ≥0% ∧ no >−15% week | `promoted` | 1.0 |
| `candidate` | Real-money ROI < −5% | `experiment` | 0 (back to £0) |
| `promoted` | Rolling-30 ROI < 0 OR ≥3 consecutive negative weeks | `candidate` | 0.25 |

**How Kelly fraction ratchets:** stored on `experiment_registry.kelly_fraction`. Read by `placePaperBet` and applied as a multiplier in the existing stake-multiplier chain (already supports `dataTier === 'candidate'` at `paperTrading.ts:1038-1043`). Generalise this block to read from registry rather than hardcoded constant — but keep the env var override for emergency adjustment.

**Demotion is fast-path, not waiting for cron.** If a settled bet pushes a tag below the demotion threshold, demotion happens in the same settlement transaction. This is asymmetric with promotion (which respects warm-up) by design — we want to remove capital from underperforming leagues immediately.

### 3.4 Discovery sequence redesign — Betfair-first

**Current flow** (`leagueDiscovery.ts:1147-1280`, `syncBetfairCompetitionCoverage`):
```
For each Betfair listCompetitions("1") result:
    Try to match to existing competition_config row (4-pass: strict, loose, slug, substring).
    If match: SET has_betfair_exchange = true.
    If no match: log unmatched, drop on the floor.
```

**Problem:** Betfair competitions that have no AF-derived competition_config row are silently invisible. Tier D ("Betfair only, no AF") exists *only* in the unmatched-log JSON, never in the schema.

**Proposed flow** (Betfair-first):
```
For each Betfair listCompetitions("1") result:
    Step 1: Persist Betfair competition_id + name + region to a new staging row
            (or upsert into competition_config with a sentinel api_football_id = NULL ... see note).
    Step 2: Forward-map to API-Football via the existing 4-pass matcher.
            On match → competition_config row exists; populate betfair_competition_id, archetype.
            On no match → competition_config row created with universe_tier='D', api_football_id=NULL.
    Step 3: Forward-map to OddsPapi/Pinnacle via discoverPinnacleLeagues + oddspapi_league_coverage lookup.
            Found + reliable → universe_tier='A'.
            Found but unreliable (recent AF-Pinnacle disagreement, or stale) → universe_tier='C'.
            Not found → universe_tier='B'.
    Step 4: Assign archetype (rules below).
    Step 5: Set warmup_started_at = NOW() if newly entering Tier B/C.
```

**Note on `api_football_id`:** the column is currently `NOT NULL` and `UNIQUE` (`competitionConfig.ts:14`). To support Tier D rows (Betfair-only, no AF), this constraint needs relaxing — the new migration **REQUIRES EXPLICIT APPROVAL** to make `api_football_id` nullable. Alternative: keep Tier D out of `competition_config` and put it in a separate `unmapped_betfair_competitions` table. v1 default: relax the constraint. Cite for v2 review as Open Question #3.

**Archetype labelling rules (v1, deterministic + library-assisted):**
- Library: `string-similarity` (already a likely candidate from existing fuzzy code; verify in `package.json` before committing — flagged as DECISION-NEEDED below) at threshold 0.85 for label keyword matching.
- Source signals: Betfair `competitionName`, `competitionRegion`; Drizzle `competition_config.country`, `name`, `gender`, `type`.
- Rule order (first match wins):
  1. `gender = 'female' OR name ILIKE '%women%' OR name ILIKE '%féminine%' OR name ILIKE '%nữ%'` → `women`
  2. `name ILIKE '%cup%' OR name ILIKE '%coupe%' OR name ILIKE '%copa%'` → `cup`
  3. `type = 'cup'` → `cup`
  4. `name ILIKE '%world cup%' OR name ILIKE '%nations league%' OR name ILIKE '%euro%' OR name ILIKE '%qualifier%'` → `international`
  5. `tier = 1 AND gender = 'male' AND type = 'league'` → `top_flight_men`
  6. `tier ≥ 2 AND type = 'league'` → `lower_division`
  7. fallback → `other`

**Verification:** the same query that powered the dual-flag backfill should show that Tier A leagues equal the current 138 dual-eligible count ± a small noise band (the 4-pass matcher's substring-pass rate, typically ±5). Verification SQL post-migration:
```sql
SELECT universe_tier, COUNT(*) FROM competition_config GROUP BY universe_tier ORDER BY universe_tier;
-- Expected: A=138±5, B=variable (target ~400-700), C=small (~30-80), D=many (~200-400 unmapped)
```

If Tier A diverges meaningfully from 138, **STOP and investigate** before flipping any behaviour. This is a verification gate per `feedback_phase_checkpoints.md`.

### 3.5 Sub-phase decomposition (overview — detailed in §6)

Confirmed sequencing:

- **2.A — Universe redefinition (low-medium risk).** Schema migrations 1, 3, 4 (no behavioural switch); reverse-mapping cron implementation; archetype assignment; verification: Tier A count = 138 ± noise band.
- **2.B — Three-track gate logic (medium risk).** `placePaperBet` shadow-stake path; gate dispatcher; feature flag `experiment_track_enabled`. Production track strictly unchanged.
- **2.C — Per-league event-driven graduation (medium-high risk).** Event-driven evaluator hook in `_settleBetsInner`; tier-change side-effects; quick-revert flag.
- **2.D — Probationary tier with reduced-Kelly bankroll segmentation (medium risk).** Generalise `dataTier === 'candidate'` stake-mult path to read `experiment_registry.kelly_fraction`; ratchet logic.
- **2.E — Ongoing settlement and feature audit (low risk).** Audit cron that flags leagues whose settlement coverage falls below 90%; demotes their universe tier automatically.

---

## 4. Risk section

| # | Risk | Severity | Likelihood | Mitigation | Confidence |
|---|---|---|---|---|---|
| R1 | Self-referential graduation: model exploits its own bias to graduate leagues that lose real money | High | Medium | Probationary candidate tier (100 real-money bets at 0.25× Kelly) before full promotion. Fast-path demotion on negative real-money streak. | EVIDENCE-BASED (existing demotion code) |
| R2 | Settlement gaps producing zero-signal bets on Tier B/C | High | Medium-high (HAND-WAVY without §2.1 query) | <90% settlement coverage = exclusion from experiment track. Sub-phase 2.E ongoing audit. | EVIDENCE-BASED (settlement code path); HAND-WAVY on coverage % |
| R3 | API-Football compute-cost explosion at 700-league scale | Medium | Low-medium | New "experiment" polling tier at 24h cadence; throttle-aware skip of Tier C when monthly projection ≥90%. | ANALYTICAL (projection in §2.3) |
| R4 | Feature-distribution drift on long-tail archetypes (women's lower divisions, friendlies) | High | High | Warm-up period requirement (≥3 DB matches per team OR ≥70% AF stats coverage). Sparse-feature exclusion (<40% layer-2) → Tier D. | EVIDENCE-BASED (fallback chain at `featureEngine.ts:550-571`) |
| R5 | Archetype mislabelling causing wrong graduation thresholds (v2 only — v1 uses globals) | Low for v1 | n/a for v1 | v2 work. v1 ships with global thresholds; archetype label is recorded but not used for threshold lookup. | EVIDENCE-BASED (threshold lookup is intentional v2-deferred) |
| R6 | CLV-source ambiguity: market-proxy CLV (`paperTrading.ts:1953`) used as if it were Pinnacle CLV by promotion engine | Medium | High (current bug in disguise) | Add `clv_source` column; gate `minClv` threshold by source. Tier B/C's `clv_source = 'market_proxy'` does NOT use the same threshold. | EVIDENCE-BASED |
| R7 | Race condition: a candidate's tier is read mid-cycle, changes due to a settlement, and bets place at stale fraction | Low | Low-medium | Read `experiment_registry` row inside the same transaction as `placePaperBet`. Even on stale read, the worst case is one cycle's worth of mis-sized bets — bounded loss. | ANALYTICAL |
| R8 | Tier D ("Betfair only, no AF") row growth pollutes `competition_config` if `api_football_id` constraint is relaxed | Low | Medium | Index Tier D rows separately. Optional v2 cleanup: separate `unmapped_betfair_competitions` table. | ANALYTICAL |
| R9 | The £0 stake creates a placement record but no execution; if ANY downstream code assumes `paper_bets.stake > 0`, it breaks | Medium | Medium | Audit pass during 2.B implementation: grep for `stake > 0`, `stake = 0`, division by `stake`. At minimum ROI computations: `total_pnl / total_staked` (`promotionEngine.ts:81-82`) — `total_staked = 0` for pure-shadow tags would produce divide-by-zero. **Already partially guarded** (`totalStaked > 0 ? ... : 0` at line 102) but needs systematic check. | ANALYTICAL |
| R10 | The graduation thresholds are user-stated v1 defaults; no retrospective backtest validates that historical Tier A leagues would have passed them | Medium | n/a | Sub-phase 2.A includes a read-only retrospective query: would current Tier A leagues have graduated under proposed thresholds at their historical sample sizes? If not, the thresholds are too tight. | ANALYTICAL |

---

## 5. Sub-phase plan with wall-clock and approval gates

Per memory feedback `feedback_plan_format.md` and `feedback_phase_checkpoints.md`: low-risk phases batched, medium+ phases require explicit confirmation before proceeding.

### Phase 2.A — Universe redefinition (LOW-MEDIUM RISK)

**Goal:** add schema; build Betfair-first reverse-mapping cron; classify all current `competition_config` rows + new Betfair-only rows into universe_tier ∈ {A,B,C,D}. **No behavioural change** — gate logic still uses `has_pinnacle_odds AND has_betfair_exchange`.

**Wall-clock:** 1.5–2 days implementation + 24h passive observation.

**Two-commit discipline:** (i) schema migration 1 + 3 + 4; (ii) reverse-mapping cron implementation + backfill of existing rows + archetype labelling. Behavioural switch deferred to 2.B.

**Verification gates (in order):**
1. After migration 1: `SELECT count(*) FROM competition_config WHERE universe_tier = 'unmapped'` = total row count (no nulls).
2. After backfill cron run 1: Tier A count ≈ 138 (current dual-flag count) ± 5. **STOP if outside band.**
3. Retrospective threshold check: would current Tier A leagues have crossed proposed graduation thresholds at their historical sample sizes? Run analytical SQL (read-only). **STOP and revisit thresholds if <50% of Tier A would have graduated.**

**Approvals required:** schema migrations (×3); retrospective query; threshold acceptance after step 3.

**Quick-revert:** drop new columns; the gate logic still reads `has_pinnacle_odds AND has_betfair_exchange` from the unchanged columns. Zero behavioural impact.

### Phase 2.B — Three-track gate logic (MEDIUM RISK)

**Goal:** `placePaperBet` gains shadow-stake path for Tier B/C; gate dispatcher at `scheduler.ts:923` reads `universe_tier` and routes accordingly. Tier A code path strictly unchanged.

**Wall-clock:** 2 days implementation + 48h monitor window.

**Approvals required (STOP-AND-DECIDE before this phase even though pre-approved structurally):**
- Confirm zero Tier-A behaviour change via canary: run trading cycle in a staging environment, snapshot bet placements, compare to a pre-2.B snapshot. Bet count, stakes, and metadata must match exactly for Tier-A candidates.
- Set `experiment_track_enabled = false` in agent_config initially. Deploy. Confirm Tier A behaviour intact for 24h. THEN flip flag to `true`.

**Monitor window (48h, per `feedback_plan_format.md`):**
- Watch: Tier B bet count growth (sanity check: should be substantial — hundreds to low thousands per day at 700-league scale, ANALYTICAL).
- Watch: Tier A bet count vs prior week — must be unchanged ± Pinnacle/Betfair coverage natural drift.
- Watch: API-Football daily usage trend.
- Quick-revert: flip flag `experiment_track_enabled` to `false`. No deploy needed.

### Phase 2.C — Event-driven graduation engine (MEDIUM-HIGH RISK)

**Goal:** post-settlement evaluator updates `experiment_registry` and triggers tier changes inline. The 03:00/04:00 crons remain as reconcilers.

**Wall-clock:** 2.5–3 days implementation + 48h monitor + 7-day review.

**Approvals required (HARD STOP before implementation begins):**
- Approve thresholds in §1.2 (or revised values from 2.A retrospective).
- Approve the v1 design choice that demotion is fast-path while promotion respects warm-up.
- Approve the divide-by-zero/ROI edge cases in `promotionEngine.computeMetricsForExperiment` for `total_staked = 0` (pure-shadow tags).

**Monitor window (48h initial, 7-day review):**
- Watch: number of tier transitions per day. v1 baseline expectation: 0-3/day during steady state (HAND-WAVY).
- Watch: any tag transitioning experiment → candidate → experiment within 7 days = thrashing; investigate.
- Watch: `graduation_evaluation_log` rows — completeness check.

**Quick-revert:** disable the new event-driven hook (single feature flag `event_driven_graduation_enabled`). Falls back to crons-only (current behaviour).

### Phase 2.D — Probationary tier with reduced-Kelly bankroll segmentation (MEDIUM RISK)

**Goal:** generalise the existing `dataTier === 'candidate'` stake-mult path (`paperTrading.ts:1038-1043`) to read `experiment_registry.kelly_fraction`; add ratchet logic so Kelly fraction can step up as candidate accrues good real-money bets.

**Wall-clock:** 1.5–2 days + 7-day monitor.

**Approvals required:** ratchet schedule (v1 proposal: stay at 0.25× until candidate→promoted threshold, then 1.0×; no intermediate steps in v1. v2 may add 0.5× step.).

**Quick-revert:** restore the hardcoded `CANDIDATE_STAKE_MULT = 0.25`. Zero risk to Tier A.

### Phase 2.E — Ongoing settlement and feature audit (LOW RISK)

**Goal:** new daily cron runs the §2.1 settlement query and §2.2 feature-coverage query, demotes any league whose coverage drops below threshold to Tier D.

**Wall-clock:** 1 day implementation + 24h monitor.

**Approvals required:** the auto-demotion threshold (90% settlement, 40% layer-2 features). v1 proposal: alert-only on first run, auto-demote after one week of confirmation.

**Quick-revert:** disable cron; no schema change to revert.

---

### Sub-phase risk summary table

| Phase | Risk | Wall-clock | Monitor | Pre-approval gate | Quick-revert |
|---|---|---|---|---|---|
| 2.A | Low-medium | 1.5-2d + 24h | Tier A count = 138 ± 5; retrospective threshold OK | Schema migrations; retrospective SQL | Drop columns |
| 2.B | Medium | 2d + 48h | Tier-A bet count unchanged; API budget headroom | Canary diff; flag-off deploy first | Flip `experiment_track_enabled = false` |
| 2.C | Medium-high | 2.5-3d + 48h + 7d review | Tier-transition rate sane; no thrashing | Threshold approval; divide-by-zero audit | Flag-off event hook → crons-only |
| 2.D | Medium | 1.5-2d + 7d | Kelly fraction reads correctly; no over-staking | Ratchet schedule | Hardcoded 0.25× restored |
| 2.E | Low | 1d + 24h | Auto-demotions sensible | Alert-only first; auto-demote after week | Disable cron |

**Total wall-clock: ~9-11 implementation days + ~5-8 days of monitor windows = 2-3 calendar weeks elapsed (assuming sequential).**

**Cumulative pre-approvals required: 11+** (3 schema migrations, 1 retrospective SQL, 1 canary diff, 1 flag-off→on transition, 1 threshold sheet, 1 divide-by-zero audit, 1 ratchet schedule, 1 audit threshold).

---

## 6. Open questions for v2 review

1. **Tier D persistence: relax `api_football_id` NOT NULL or separate table?** Current preference is to relax the constraint and add Tier D rows directly to `competition_config`. Argument for separate table: cleaner read of "real" leagues. Argument against: forks the universe across two tables, complicates queries. **DECISION-NEEDED in v2.**

2. **Per-archetype graduation thresholds: when do we collect the data to define them?** v1 ships with global thresholds. v2 needs a backfill: bucket existing settled bets by archetype, compute archetype-specific ROI/WR/p baselines, set per-archetype thresholds = baseline + safety margin. Need to define the safety margin. **DECISION-NEEDED in v2.**

3. **Fuzzy-match library and threshold for Betfair-side reverse-mapping.** The existing 4-pass matcher in `leagueDiscovery.ts` (strict, loose, slug, substring) is reusable but tuned for AF-side names. Betfair `competitionName` strings have different conventions (region prefixes, sponsor stripping). Per memory feedback `feedback_specify_algorithms.md`: pin the algorithm + library + threshold + tie-breaker explicitly before code lands. v1 proposal: reuse existing 4-pass at the same thresholds; if accuracy <95% on a 50-row manual audit, revisit in v2 with a specific alternative (likely `string-similarity`'s Sørensen-Dice at 0.85 with country-prefix normalisation pre-pass). **DECISION-NEEDED in v2 after audit run.**

4. **CLV-source threshold calibration for Tier B/C.** §2.4 notes the existing `minClv = 1.5` applies to Pinnacle CLV. For market-proxy CLV (Tier B/C), what's the right number — or do we drop the CLV requirement and substitute a stricter ROI/p compound? v1 default: drop CLV requirement for `clv_source = 'market_proxy'`, retain ROI ≥5%, WR ≥53%, p ≤0.05. v2 may calibrate.

5. **Concurrency/race window between settlement-driven graduation and in-flight cycle.** §4 R7 notes a stale-read window. v1 mitigation is "small bounded loss." v2 may want explicit transactional read of registry inside `placePaperBet`. **DESIGN-CHOICE in v2.**

6. **Promotion-engine `experiment_tag` schema for league-level experiments.** v1 proposal: `LEAGUE_<canonical_name_lower>` (e.g., `LEAGUE_albanian_superliga`). Composite forms like `LEAGUE_<x>__MARKET_<y>` reserved for v2. **CONFIRM in v2 review** that the v1 form is sufficient for current ambitions.

7. **What happens when a Tier A league loses Pinnacle pricing?** Current rule: Tier A → goes Tier B (no Pinnacle). But its real-money bets continue while reclassification propagates. v1 proposal: auto-downgrade to Tier B sets data_tier = 'experiment' on the league's experiment_registry row, but in-flight pending bets at the moment of downgrade run to settlement at their original tier. **CONFIRM in v2 review.**

8. **The `is_active = false` Tier D safety net.** All Tier D rows should set `is_active = false` to be defensive. Confirm this is acceptable or whether some Tier D rows should still feed Tier E training.

9. **Sub-phase 2.E threshold for auto-demotion to Tier D from settlement coverage drift.** v1 proposal: 90% on a 50-fixture rolling sample; confirm via 1 week of dry-run logs before enabling auto-demote.

10. **Roll-forward of the recently-shipped Phase 1 multi-market Pinnacle probe.** The original prompt notes Phase 1 (101/102/104 disjunction) is *superseded* but may still ship. Decision needed: do we land Phase 1 before Phase 2.A, or skip it entirely now that Phase 2 exists? Phase 1 expands Tier A under the *current* gate; under the new design, those leagues become Tier B by default until Pinnacle fans out. **DECISION-NEEDED — out of scope for this document but blocks the work order.**

---

## 7. What this document explicitly does NOT do

- Does not propose any code edits.
- Does not run any SQL migrations or DML.
- Does not ship Phase 1 multi-market Pinnacle probe.
- Does not conflate with F.2 bootstrap fix or 12→15 feature model swap (model-quality work, parked).
- Does not commit anything to git. (Repo is not a git working tree at session time; even if it were, no commits would be made.)
- Does not deploy.
- Does not modify Tier A behaviour even by accident — the design is positively gated by `universe_tier ∈ {B,C}` for every new path.

---

## 8. Sign-off checklist for v2 progression

Before this document advances to v2, the following need explicit decisions or data:

- [ ] Run the read-only settlement-coverage SQL in §2.1; confirm or revise the 90% threshold.
- [ ] Run the read-only API-Football usage SQL in §2.3; confirm cost projection headroom.
- [ ] Run the retrospective threshold check in §5 phase 2.A: would current Tier A leagues have graduated under proposed thresholds?
- [ ] Decide Open Questions #1, #2, #3, #10.
- [ ] Confirm or revise the v1 thresholds in §1.2.
- [ ] Confirm sub-phase ordering in §5.

When all of the above are resolved, draft v2.
