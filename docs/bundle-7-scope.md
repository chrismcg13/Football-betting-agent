# Bundle 7 — Phase 2 activation prerequisites (scope, 2026-05-17 — UPDATED)

> **Status:** SCOPE LOCKED 2026-05-17 (evening). Sequences the work that
> must ship BEFORE `inversion_pipeline_enabled='true'` is flipped.
> Bundle 5 pre-stage was Stages 2 + 3 of the gate. Bundle 7 is
> Stage 0 (universe + heat map), Stage 1 (model-blind watchlist),
> dual-track candidate classification, gate-bypass for sharps,
> prioritiser, bankroll-tier auto-scaling, mover-signal quality
> filter, and full §G feature backfill. Pipeline is incomplete
> without Stage 0.
>
> **Decision rule from Chris:** "Phase 1 and 2 up to and including
> feature backfill before turning on. Telemetry dashboard is out of
> scope — logging + health checks only. We are doing this properly."
>
> **Lock-in decisions (2026-05-17 evening):**
> 1. Ship ALL sub-bundles (no partial bundle).
> 2. Feature backfill includes HIGH + MEDIUM + LOW priority — full §G.
> 3. Capacity ceilings: bankroll-tier auto-scaling (4 tiers, see 7.E).
> 4. Mover signal: PRIMARY watchlist trigger with 4-condition quality
>    filter (see 7.B).
> 5. **Stage 0 universe + heat-map system added as 7.0** — the pipeline
>    is incomplete without it.

---

## What the Phase 2 spec actually requires

The memo's R1 says "the model NEVER filters fixtures before Pinnacle
sees them." Bundle 5 built the gate that consumes candidates, but did
NOT change where candidates come from — they still arrive via
`valueDetection.ts` (model-driven opportunity-score path) with eight
upstream filters still active:

- `max_bets_per_cycle` (scheduler.ts) — 5 live / unlimited shadow
- `min_opportunity_score` (valueDetection.ts) — 60
- `min_edge_threshold` (valueDetection.ts, per-league)
- `max_bets_per_league` (scheduler.ts) — 2 live
- `max_bets_per_market` (scheduler.ts) — 2 live
- `live_placement_disabled_market_types` (livePlacementGate.ts) — CSV
- `live_placement_disabled_leagues` (livePlacementGate.ts) — CSV
- `shadow_min_opportunity_score` (valueDetection.ts) — 0

When the inversion flag flips, those filters STILL run upstream of the
gate. A bet with `opportunity_score = 55` gets rejected by
`min_opportunity_score = 60` before ever reaching
`evaluateInversionGate`. For R1 to be true, this has to change.

But Chris's nuance from the spec lock:

> Where leagues don't have a sharp edge, the model still uses opportunity
> score and learns with a CLV afterwards to build wilson ROI confidence.

So we don't simply *delete* the model path. We split candidates into two
tracks based on whether a sharp anchor exists:

| Track | Anchor | Gate | Placement |
|---|---|---|---|
| **Sharp-anchored** | Pinnacle ± Singbet/SBOBet | Inversion gate (Bundle 5) — 3pp net edge, multi-sharp Kelly tiering | Live-eligible |
| **Model-only** | None (PINNACLE-ABSENT + niche-absent) | Legacy `min_opportunity_score` + `min_edge_threshold` | Shadow-only, accumulates CLV vs Pinnacle close, graduates to live via Wilson 95% LCB once scope proves edge |

Pinnacle/Singbet/SBOBet now cover most placed-on leagues (post-Bundle-1
maximisation), so the sharp-anchored track will carry the bulk of
volume. The model-only track is the learning rail for the long tail.

---

## Sub-bundle structure (sequencing matters)

### 7.0 — Stage 0: universe management & heat map (foundation)

**The layer ABOVE candidate evaluation.** Without it, polling is blind
(blows budget) or relies on the candidate filter to find everything
(misses fast-window edge). Stage 0 runs continuously, feeding tier
assignments and polling cadences to Stage 1.

**Layer 1 — Universe enumeration**
- Daily 04:00 UTC cron fetches all fixtures next 7 days from
  API-Football across all Pinnacle-mapped leagues.
- Inserts into new `universe` table: `(fixture_id, league_id,
  kickoff_time, status)` + `universe_markets` table:
  `(fixture_id, market_type, market_types_expected)`.
- `market_types_expected` derived from historical
  `pinnacle_odds_snapshots` per (league × market_type) —
  e.g. Premier League supports MO/OU/BTTS/AH/Cards/Corners; K-League 1
  supports MO/OU/AH only.
- ~3,000 (fixture × market) rows in active universe at any time.
- API-Football cost: ~50 requests/day, negligible.

**Layer 2 — Watch priority scoring (every 5 min)**

**Refined formula (2026-05-17 lock-in — model as accelerator, never veto):**

```
base_priority = MAX(                                   // strongest single signal
    W_edge      × expected_edge_density_score,
    W_release   × pinnacle_release_proximity_score,
    W_liquidity × betfair_liquidity_score,
    W_ttk       × time_to_kickoff_score,
    W_clv       × historical_clv_yield_score
)
model_boost = W_model × model_opportunity_score        // non-negative; ≥ 0 always
watch_priority_score = base_priority + model_boost
```

**The R1-preserving rule:** model can ONLY raise priority, never
lower. A fixture the model has zero confidence in still gets the
same base priority. Watchlist INCLUSION (Stage 1) stays model-blind;
this scoring affects POLLING CADENCE only.

Defaults (operator-tunable via `agent_config.watch_score_weights` JSON):
- W_edge = 0.20 (empirical edge density per scope)
- W_release = 0.15 (Pinnacle release-window proximity)
- W_liquidity = 0.15 (current Betfair matched volume)
- W_ttk = 0.20 (time-to-kickoff weighting)
- W_clv = 0.20 (rolling CLV yield per scope — primary learning loop)
- **W_model = 0.10** (model opportunity score — accelerator only,
  intentionally smallest weight per Section J's +12-31pp model bias)

CLV is twice the model weight. Empirical track record trumps model
prediction. As model bias narrows over time (Bundle 5.B mean_bias
view), W_model can creep up — but on data, not faith.

Each component (full definitions in the original spec) is 0-100,
data-driven from rolling windows. The CLV component is the **closed
learning loop**: scopes that produced positive CLV in the rolling
100-bet window get higher priority next cycle; scopes that didn't,
decay. The system finds its own hot scopes from data — not from
human picks like "I think AH is better in Bundesliga."

**Score ranges under max-base + additive-model:**
- Max base contribution: 0.20 × 100 = 20 (single component at 100)
- Max model contribution: 0.10 × 100 = 10
- Total range: [0, 30]
- Uniform 80-across-all-base: max(16, 12, 12, 16, 16) = 16 (penalises
  uniform mediocrity)
- Spike 100 on one base + 0 elsewhere: 20 (rewards strong single signal)

**Behavioural verification (must hold under the rule):**
- High CLV + good release + good liquidity, model silent → still TIER 1
- Warm base + model edge flag → promoted from TIER 2 to TIER 1
- HOT base + zero model → still TIER 1 (model silence ≠ cold)
- Model edge flag + all base cold → TIER 3 at best (model alone
  cannot push past base components)

**Tier thresholds (calibrated to the new score range, operator-tunable):**
- TIER 1 HOT: score ≥ 20 (one base component at 100, OR warm base + model amplification)
- TIER 2 WARM: 15 ≤ score < 20 (one base at ~75)
- TIER 3 COOL: 6 ≤ score < 15 (model alone, or one base at ~30)
- TIER 4 COLD: score < 6

**Unit test (required for Stage 0 ship):**
Simulate two fixtures with identical base_priority components and
ZERO vs 100 model_opportunity_score. Assert:
1. Both have identical or non-decreasing tier (model_boost ≥ 0).
2. Both are watched at the configured cadence — neither is excluded.
3. Score with model=100 = score with model=0 + (W_model × 100).
4. Tier1-ceiling fixtures stay TIER 1 regardless of model score.

**Layer 3 — Tier assignment & polling cadence**

Every 5 min, sort by `watch_priority_score`:

| Tier | Score | Betfair poll | Pinnacle poll | Expected count |
|---|---|---|---|---|
| 1 HOT | ≥80 | 30s (Stream when available) | signal-driven + T-30/15/5/0 snapshots | 30-80 fixtures |
| 2 WARM | 50-79 | 2 min | 15 min | 200-400 |
| 3 COOL | 20-49 | 5 min | 30 min | 800-1,500 |
| 4 COLD | <20 | 15 min | mover-signal only | rest |

**Budget projection (verified to fit ≤3,300/day Pinnacle reqs):**

| Tier | Pinnacle reqs/day | Notes |
|---|---|---|
| 1 | ~700 | Signal-driven (mover>2%/30min OR ttk snapshots) — NOT time-driven; mandatory or budget blows |
| 2 | ~600 | 15-min cadence |
| 3 | ~800 | 30-min cadence |
| 4 | ~200 | Mover-signal only |
| Discovery | ~400 | Universe fetch + early-release sampling |
| Buffer | ~600 | |
| **Total** | **~3,300** | Fits the paid plan ceiling |

**Critical rule for Tier 1 Pinnacle polling:** signal-driven, not
time-driven. Time-driven 30s polling on 60 Tier-1 fixtures would
exceed the budget. Triggers:
- Initial promotion to Tier 1 (baseline snapshot)
- Betfair moves >2%/30min on the fixture
- Snapshot moments: T-30min, T-15min, T-5min, T-0
- Otherwise: reuse the latest snapshot.

**Instrumentation tables (new):**
- `universe` (fixture_id PK, league_id, kickoff_time, status)
- `universe_markets` (fixture_id, market_type, market_types_expected)
- `watch_priority_history` (fixture_id, market_type, score, tier,
  computed_at) — keep 7 days for backtesting / weight re-tune
- `scope_clv_rolling_v` (materialised view: league × market × ttk ×
  sharp_count_tier → stake_weighted_clv_pct, n) — refreshed nightly
- `scope_edge_density_v` (materialised view: scope → edge_count,
  scan_count, density) — refreshed nightly

**Configuration keys (DB-driven, seeded via migrate.ts):**
- `watch_score_weights` JSON: W_edge, W_release, W_liquidity, W_ttk, W_clv
- `tier_thresholds`: TIER_1_MIN=80, TIER_2_MIN=50, TIER_3_MIN=20
- `tier_poll_cadences`: Betfair seconds, Pinnacle minutes per tier
- `scope_clv_window_size`: 100 bets
- `weight_retune_frequency`: monthly

**Files:** new `services/stage0Universe.ts`, `services/watchPriority.ts`,
`services/scopeClvAggregator.ts`; migrate.ts ALTER + view DDL;
scheduler.ts cron registration (daily 04:00 universe fetch + 5-min
priority recomputation).

**Estimated size:** ~800 LOC, 2-3 days.

### 7.A — Dual-track candidate classification (foundation)

Every candidate, at emission, is tagged `track ∈ {sharp_anchored,
model_only}` based on:

```
sharp_anchored = pinnacle_implied IS NOT NULL
              OR ANY non-Pinnacle sharp in pinnacle_odds_snapshots
                 within 10-min freshness for (matchId, marketType, selectionName)
```

If false → `model_only`.

Implementation: a small helper `classifyCandidateTrack(matchId,
marketType, selectionName)` in `services/candidateTracking.ts`.

paperTrading.ts records the track on the bet row (new column
`paper_bets.candidate_track`) so downstream analysis can split. Cron
that aggregates per-track Wilson ROI / CLV t-stat per scope is needed
for the model-only graduation path.

**Files:** new `candidateTracking.ts`; migrate.ts ALTER TABLE; minor
hook in paperTrading.

### 7.B — Stage 1 model-blind watchlist builder + mover quality filter

New service `stage1Watchlist.ts` that runs every 5 min and consumes
**Stage 0 tier assignments** to decide which fixtures to actively
emit candidates from. Candidates emerge only from TIER 1/2/3 fixtures
on their respective polling cadence; TIER 4 requires explicit
mover-signal entry.

**Watchlist union (model-blind, all signals fire on their own):**
- `liquidity_snapshots.total_market_volume > £500` (per memo §H
  BALANCED) — always a candidate
- Pinnacle coverage AND `kickoff_time < 24h` (release-window proxy)
- **PRIMARY mover signal** — 4-condition quality filter:
  - Betfair back-odds move ≥ 4% in rolling 30-min window
  - Market matched volume > £200 (filter retail/illiquid noise)
  - Kickoff within 12h (movers far out are usually data corrections,
    not info)
  - Direction is genuine money flow — shorter on the back side OR
    longer on the lay side (not bid/ask widening)

Expected daily mover count post-filter: ~150 median, ~300-500 peak.
Manageable inside Stage 2 budget.

**Mover instrumentation (every mover gets a structured row in
compliance_logs):**
```
mover_signal_present   = true
mover_pct_30min        = <value>
matched_volume_at_trigger = <value>
hours_to_kickoff       = <value>
bet_subsequently_placed = <bool>
bet_settled_outcome    = <won|lost|void|null>   // backfilled on settlement
```

**Mover A/B at n=200 settled bets:** compare ROI + CLV of
mover-triggered candidates vs non-mover-triggered. If mover ROI lift
≥ 2pp OR positive CLV delta → keep signal. If equal/negative → drop
to "C: information-only" by setting `mover_signal_enabled = 'false'`
in agent_config. No auto-disable; manual decision after n=200 review.

Output is the same `Candidate` shape consumed by `placePaperBet`.
The watchlist builder does NOT call the model — it emits every
(match × market × selection) on Betfair that meets ANY of the three
criteria above.

The existing `valueDetection.ts` emission path becomes the
**model-only** track (continues to use opportunity score + model edge)
restricted to scopes WITHOUT a sharp anchor. Within sharp-anchored
scopes, the model is no longer the candidate source.

**Files:** new `stage1Watchlist.ts`; new `moverDetector.ts`;
scheduler.ts wiring; trim valueDetection's scope.

**Estimated size:** ~400 LOC (300 watchlist + 100 mover), 1.5 days.

### 7.C — REMOVE / BYPASS the 8 upstream gates (track-aware)

The eight gates split by track:

| Gate | Sharp-anchored | Model-only |
|---|---|---|
| `max_bets_per_cycle` | BYPASS — capacity governed by 7.D/7.E | RETAIN (5) |
| `min_opportunity_score` | BYPASS — model doesn't gate | RETAIN (60) |
| `min_edge_threshold` per-league | BYPASS — 3pp Pinnacle floor takes over | RETAIN |
| `max_bets_per_league` | BYPASS — `per_league_exposure_pct` (Bundle 5.M, 15%) governs | RETAIN (2) |
| `max_bets_per_market` | BYPASS — concentration is by exposure pct, not count | RETAIN (2) |
| `live_placement_disabled_market_types` | BYPASS — R4: all Betfair markets eligible if Pinnacle covers | RETAIN |
| `live_placement_disabled_leagues` | BYPASS — R5: Pinnacle coverage IS eligibility | RETAIN |
| `shadow_min_opportunity_score` | BYPASS for sharp-anchored shadow | RETAIN (0) |

Implementation: each gate-check site reads the candidate's track and
skips when `track='sharp_anchored' AND inversion_pipeline_enabled=true`.
This is mechanical but touches ~8 different files.

**Files:** scheduler.ts (3 caps); valueDetection.ts (3 gates);
livePlacementGate.ts (2 ban lists).

### 7.D — Candidate prioritiser (replaces per-cycle hard cap)

Per Chris's spec:

> If it finds 2 bets same edge but our model scores one a higher
> opportunity score that bet is higher priority if it was a choice of
> only 1 could be placed.

New file `candidatePrioritizer.ts`:

```
priority_key = (
  post_slippage_edge_pp DESC,        // primary
  opportunity_score      DESC,        // tie-break
  identified_edge_pp     DESC         // final tie-break — rare
)
```

Each cycle:
1. valueDetection + Stage 1 watchlist BOTH emit candidates (unioned).
2. Prioritiser sorts by `priority_key`.
3. Allocator streams them through `placePaperBet` in priority order.
4. Allocator stops when ANY capacity ceiling would be breached on the
   next placement (per-fixture, per-league, daily-stake, open-exposure).
5. Remaining candidates fall through to shadow if shadow capacity
   allows.

Currently the cron places candidates in (whatever order) until
`max_bets_per_cycle` (5) is hit. Under the new design there's no
hard count cap — capital governs.

**Files:** new `candidatePrioritizer.ts`; scheduler.ts cron wiring.

### 7.E — Capacity ceiling auto-scaling (bankroll-tier)

Bundle 5.M shipped static defaults (5/15/8). Replaced now by
**bankroll-tier auto-scaling**: detected live Betfair balance picks
the appropriate tier each cycle. Caps scale with proven edge without
manual intervention.

| Bankroll tier | `per_fixture_exposure_pct` | `per_league_exposure_pct` | `daily_stake_cap_pct` | Rationale |
|---|---|---|---|---|
| < £500 | 3.0 | 10.0 | 6.0 | Conservative — protect ramp |
| £500 – £2,000 | 5.0 | 15.0 | 8.0 | Default (current setting) |
| £2,000 – £10,000 | 6.0 | 18.0 | 10.0 | Moderate loosening — proven edge |
| > £10,000 | 8.0 | 20.0 | 12.0 | Mature — Pinnacle Premium Charge consideration kicks in here |

Implementation:
- `getExposureCapsForBankroll(bankroll)` → returns the three pct
  values based on the tier table.
- Tier table itself lives in `agent_config.exposure_cap_tiers` as
  JSON so operator can tune any threshold without code.
- `applyInversionExposureCaps()` in `inversionPipeline.ts` (Bundle
  5.M shipped) is amended to call `getExposureCapsForBankroll()`
  every invocation rather than reading three static keys.
- Operator override: if `per_fixture_exposure_pct` (etc.) is set
  explicitly in `agent_config` outside the JSON tier table, the
  explicit value wins for that key. Provides a "pin this cap" escape
  hatch.

**Other ceilings RETAINED** (unchanged from current spec):
- Open-exposure ceiling per risk level (liveRiskManager)
- Bankroll floor 10% starting_deposit (liveRiskManager)
- £2 Betfair min (hardcoded)
- Concurrent-bet correlation 1/√k (portfolioKelly)

**Files:** amend `inversionPipeline.applyInversionExposureCaps`;
extend migrate.ts seed with `exposure_cap_tiers` JSON.

**Estimated size:** ~60 LOC + JSON seed, half-day.

### 7.F — Feature backfill (memo §G)

The model-only track needs richer features to tighten `model_se` so
its Wilson-LCB graduation path is realistic. Per memo §G priorities:

| Feature | Source | Effort | Priority |
|---|---|---|---|
| Lineup XI (T-1h fetch) | API-Football `/v3/fixtures/lineups` | medium | HIGH — biggest probability-mass mover |
| Referee tendency | API-Football `/v3/fixtures/headtohead` + referee table | low | HIGH — low effort, immediate impact on card markets |
| Injuries / sidelined | API-Football `/v3/sidelined` | medium | HIGH |
| H2H depth beyond `h2h_home_win_rate` | `match_h2h` (already in DB) | low | MEDIUM — just wire it |
| Recent 5-game form ratio | derivable from existing | low | MEDIUM |
| Team season aggregates / H-A splits | API-Football `/v3/teams/statistics` | low | LOW |
| Player season form (xG, xA, minutes) | API-Football `/v3/players/seasons` | medium | LOW (player-level is marginal for team markets) |

Each feature gets:
1. Storage (new column or table)
2. Ingestion service (API-Football call, scheduled)
3. predictionEngine.ts FEATURE_NAMES extension
4. Backfill script for historical fixtures

API-Football has 75k/day free, so budget isn't the constraint.

This is independent of 7.A-E and can ship in parallel. **Estimated
size:** ~1000-1500 LOC across 6-8 files. Multi-day work.

**Files:** new ingestion services; lib/db schema additions; migrate.ts;
predictionEngine FEATURE_NAMES; new backfill scripts.

---

## Activation sequence — five deploys, each independently safe

| Deploy | Sub-bundles | Risk |
|---|---|---|
| **D1** | 7.0 Stage 0 (universe + heat map foundation) | Zero — nothing yet consumes tier assignments; tables populate, scoring writes to `watch_priority_history`. |
| **D2** | 7.A dual-track classifier + 7.E bankroll-tier auto-scaling | Zero — track tag stored on bets, used by 7.C; auto-scaling only fires when inversion flag is on. |
| **D3** | 7.B Stage 1 watchlist + mover quality filter | Low — Stage 1 candidates can land in `placePaperBet` alongside legacy model candidates, but inversion gate still shadow-only. |
| **D4** | 7.C track-aware gate bypass + 7.D prioritiser | Low — bypass only fires when flag is on; prioritiser orders the union of valueDetection + Stage 1 emissions. |
| **D5** | 7.F feature backfill (full §G: lineup, referee, injuries, H2H depth, 5-game form, team season aggregates, player season form) | Low — additive features; predictionEngine reads them when present. |
| **Verify** | 24-48h of shadow telemetry: gate decisions, prioritiser ordering, per-track Wilson ROI accumulating, mover-signal A/B (will need n=200) | — |
| **Flip the flag** | `UPDATE agent_config SET value='true' WHERE key='inversion_pipeline_enabled'` | — |

Shadow telemetry from Bundle 5.E (`inversion_gate_shadow` rows in
compliance_logs) already accumulates. After D3 ships, additional rows
will show: did Stage 1 surface the same candidates the model would
have? Where does it diverge? That's the pre-flip validation signal.

The mover-signal A/B requires n=200 settled mover-triggered bets
before a verdict — this may extend the pre-flip window if mover
volume is sparse.

## Out of scope per Chris

- **Telemetry dashboard / front end.** No UI. SQL queries on
  compliance_logs + v_rejected_by_gate_24h + v_clv_health_rolling +
  v_market_type_mean_bias_rolling + v_slippage_p75_rolling +
  watch_priority_history + scope_clv_rolling_v are the operator
  interface. Logging IS the dashboard.
- **Per-book trust weights** (Bundle 1 E.4 original). Marginal value
  with only Singbet+SBOBet in the niche.
- **Stream API migration** (memo §0.2 / §H). Recommended for
  AGGRESSIVE coverage; deferred. Bundle 7 ships polling-only.

## Estimated effort

| Sub-bundle | LOC | Time |
|---|---|---|
| 7.0 (Stage 0 universe + heat map) | ~800 | 2-3 days |
| 7.A (track classifier) | ~100 | half-day |
| 7.B (Stage 1 watchlist + mover filter) | ~400 | 1.5 days |
| 7.C (track-aware gate bypass) | ~200 | half-day |
| 7.D (prioritiser + allocator) | ~250 | 1 day |
| 7.E (bankroll-tier auto-scaling) | ~60 | half-day |
| 7.F (full §G feature backfill, 7 features) | ~1500 | 4-5 days |
| **Total** | **~3,300 LOC** | **10-12 days** |

7.0 and 7.F are the long poles. 7.A-E sequenced as 3-4 days of
focused work between them.

---

## All four decisions: LOCKED (2026-05-17 evening)

1. ✓ Ship ALL sub-bundles (no partial bundle, no priority cuts).
2. ✓ Feature backfill = full §G (HIGH + MEDIUM + LOW priorities).
3. ✓ Capacity ceilings = bankroll-tier auto-scaling (4 tiers, see 7.E).
4. ✓ Mover signal = PRIMARY with 4-condition quality filter (see 7.B);
     A/B at n=200 settled mover bets; manual disable if no lift.
5. ✓ Stage 0 (universe + heat map) added as 7.0; pipeline is
     incomplete without it.
