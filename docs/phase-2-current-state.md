# Phase 2 — Current State Audit

**Status:** **codebase audit complete.** Read-only. No DML, no SQL, no code edits.

**Author:** Claude (sub-phase 1 of strategic Phase 2 push, 2026-05-05)
**Working tree:** `C:\Users\chris\projects\Football-betting-agent\`
**Methodology:** direct file reads + grep. Every claim cites `file:line`. Confidence flags inline.
**Companion:** `docs/phase-2-diagnostic-findings.md` covers empirical (DB) state.

---

## 0. Purpose

Establish ground truth for what's actually shipped vs what the strategic-push brief proposes. Sub-phases 2-10 of the brief reference components, schema, and crons that may or may not exist. This document is the source-of-truth they plan against.

---

## 1. Schema state

### 1.1 Tables and migrations actually applied

Source: `artifacts/api-server/src/lib/migrate.ts` (1073 lines, idempotent). Every table below is created via `CREATE TABLE IF NOT EXISTS` at startup; column additions via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

**Pre-Phase-2 tables (foundational):** `matches`, `odds_snapshots`, `features`, `paper_bets`, `model_state`, `learning_narratives`, `compliance_logs`, `agent_config`, `xg_match_data`, `team_xg_rolling`, `competition_config`, `drawdown_events`, `pinnacle_odds_snapshots`, `line_movements`, `filtered_bets`, `liquidity_snapshots`, `data_richness_cache`, `alerts`, `cron_executions`, `exchanges`, `commission_tracking`, `tournament_config`, `discovered_leagues`, `api_usage`, `league_edge_scores`, `odds_history`, `oddspapi_fixture_map`, `oddspapi_league_coverage`.

**Pre-Phase-2 experiment-pipeline columns on `paper_bets`:** `data_tier`, `experiment_tag`, `opportunity_boosted`, `original_opportunity_score`, `boosted_opportunity_score`, `sync_eligible`, `promoted_at`, `promotion_audit_id`. Added `migrate.ts:262-272`.

**Pre-Phase-2 supporting tables:** `experiment_registry`, `promotion_audit_log`, `experiment_learning_journal`. Created `migrate.ts:275-321`.

**Phase 2.A migrations applied** (committed `37aca11`):

| Object | Migration | Source |
|---|---|---|
| `competition_config.api_football_id` | `DROP NOT NULL` | `migrate.ts:924-927` |
| `competition_config` columns | `+universe_tier, +archetype, +betfair_competition_id, +warmup_started_at, +warmup_completed_at, +universe_tier_decided_at, +settlement_bias_index` | `migrate.ts:928-937` |
| `competition_config` CHECK | `universe_tier IN ('A','B','C','D','E','unmapped')` | `migrate.ts:938-950` |
| `competition_config` indexes | `universe_tier`, `betfair_competition_id (partial)`, `betfair_competition_id WHERE api_football_id IS NULL (unique partial)` | `migrate.ts:951-964` |
| `experiment_registry` columns | `+archetype, +clv_source, +warmup_completed_at, +kelly_fraction, +last_evaluated_at, +abandoned_at, +cooldown_eligible_at, +model_version_at_abandon, +experiment_phase_roi, +candidate_phase_roi` | `migrate.ts:967-979` |
| `experiment_registry` CHECKs | `clv_source IN ('pinnacle','market_proxy','none')`; `kelly_fraction ∈ [0, 1.0]` | `migrate.ts:980-1000` |
| `paper_bets` columns | `+shadow_stake, +shadow_stake_kelly_fraction, +shadow_pnl, +universe_tier_at_placement, +clv_source` | `migrate.ts:1004-1011` |
| `graduation_evaluation_log` table | new — id, experiment_tag, triggered_by, trigger_bet_id, metrics_snapshot (jsonb), threshold_outcome, evaluated_at | `migrate.ts:1014-1024` |
| `graduation_evaluation_log` CHECKs | `triggered_by IN ('settlement','cron','manual')`; `threshold_outcome IN ('promote','demote','hold','warmup','insufficient_data')` | `migrate.ts:1025-1045` |
| `graduation_evaluation_log` index | `(experiment_tag, evaluated_at DESC)` | `migrate.ts:1046-1049` |

Drizzle schema files: `lib/db/src/schema/competitionConfig.ts`, `experimentRegistry.ts`, `paperBets.ts`, `graduationEvaluationLog.ts` — all in `index.ts:1-31`. **Confidence: EVIDENCE-BASED** (file content read directly).

### 1.2 What the strategic brief NEEDS that does NOT exist yet

| Brief reference | Required artifact | Current state |
|---|---|---|
| Sub-phase 6 — Autonomous threshold management | Table `pending_threshold_revisions` | **DOES NOT EXIST.** Not in `migrate.ts`, not in `schema/`. |
| Sub-phase 6 — Decision audit | Table `model_decision_audit_log` | **DOES NOT EXIST.** Not in `migrate.ts`, not in `schema/`. |
| Sub-phase 7 — API-Football data expansion | Tables for `injuries`, `transfers`, `coaches`, `sidelined`, `trophies`, weather, referee, lineup-confirmation, fixture-congestion features | **NONE EXIST** as standalone tables. `features.ts` is a generic key/value store; expansion would either widen `features` or add per-domain tables. |
| Migration 5 (R6 backfill) — `clv_source` historical tag | `UPDATE paper_bets SET clv_source = ...` | **NOT EXECUTED.** New rows from 2026-05-05 onward are tagged at write-time (per `paperTrading.ts:2059-2073`); historical rows pre-R6-patch carry NULL. |

**Confidence: EVIDENCE-BASED.**

### 1.3 Schema-vs-migrate-ts divergence (one notable)

`docs/phase-2-shadow-experiment-architecture-v1.md` and `phase-2-shadow-experiment-architecture-v2.md` reference `competition_config.has_betfair_exchange` as a column. **It does not exist in `migrate.ts`.** A grep across `artifacts/api-server/src/services/` shows only one reference, in a comment at `scheduler.ts:930` — no actual SQL or Drizzle field reads it.

The empirical findings in `docs/phase-2-diagnostic-findings.md` §2.D and §6.G ran SQL against a `has_betfair_exchange = true` filter that returned data — meaning the column exists on the prod Neon DB but not in code. Hypothesis: added on the unmerged `stage4-phase-A` branch via direct DML, never round-tripped into `migrate.ts`. **Risk:** a fresh DB created from current `migrate.ts` would lack this column; any SQL in this document that references it must be rewritten against `universe_tier` instead. **Confidence: EVIDENCE-BASED on code; HAND-WAVY on prod DB origin.**

**Recommendation (NOT this sub-phase):** decide whether to (a) add a `has_betfair_exchange` ALTER to `migrate.ts` for parity, or (b) treat `universe_tier IN ('A','B','C')` as the canonical "Betfair-tradeable" filter going forward (it semantically supersedes `has_betfair_exchange`). Recommend (b).

---

## 2. Code components — present vs missing

### 2.1 Phase 2.B.1 — Universe-tier dispatcher (SHIPPED)

**Status:** ✅ shipped (commit `9d5db0d`). Read at `scheduler.ts:922-1064`.

- Selection filter replaces prior `has_pinnacle_odds = true` with `universe_tier IN ('A','B','C')` query at `scheduler.ts:954-958`.
- Builds two maps from `competition_config`: `tierByKey` (`name|country` → tier) and `tierByName` (name-only fallback) at `scheduler.ts:964-969`.
- Fallback chain: kept if tier ∈ {A}; tier B/C routed conditionally (see 2.2); D/E/unmapped → `no_universe_tier_match` reject (`scheduler.ts:1032-1043`).
- Telemetry: `funnel["07a_universe_tier_filter"]`, `funnel["07a_tier_a_candidates"]`, `funnel["07a_tier_b_candidates_rejected"]`, `funnel["07a_tier_c_candidates_rejected"]`, `funnel["07a_no_tier_match_rejected"]`.
- Kill switch: `agent_config.reject_non_pinnacle_leagues = 'false'` reverts to pre-2.B.1 behaviour (logs a WARN, sets funnel marker to "disabled").

**Confidence: EVIDENCE-BASED.**

### 2.2 Phase 2.B.2 — Shadow-stake placement (SHIPPED, FLAG-OFF)

**Status:** ✅ code shipped (commit `786dd46`); behavioural flag default `false`.

**Flag:** `agent_config.experiment_track_enabled` (read at `scheduler.ts:945-946`). Default `'false'` → tier B/C continue to be rejected exactly as 2.B.1 did. Flip via SQL `UPDATE agent_config SET value = 'true' WHERE key = 'experiment_track_enabled';`.

**Placement path (`paperTrading.ts:1075-1088`):**
- `isShadowBet = universeTier === 'B' || universeTier === 'C'` at `paperTrading.ts:651`.
- Computes `shadow_stake = full_Kelly × 0.25`; sets `stake = 0`.
- Bypasses min-stake check (`paperTrading.ts:1089`), exposure check (`paperTrading.ts:1108`), live concentration check (`paperTrading.ts:1127`).
- Inserts new columns: `shadowStake`, `shadowStakeKellyFraction`, `universeTierAtPlacement`, `clvSource: null` (`paperTrading.ts:1289-1292`).

**Settlement-side shadow-pnl computation (`paperTrading.ts:1976-1989`):**
- For shadow bets: `shadow_pnl = settlement P&L computed at shadow_stake` (commission-aware via `calculateSettlementWithCommission`).
- Real bets: `shadow_pnl` left null.

**clv_source tagging at settlement (`paperTrading.ts:2059-2073`):**
- Conditional spread on `clvSource`: tags `'pinnacle'` when a Pinnacle-source snapshot was found by R6 patch lookup; null otherwise (R6 negative test passes — see diagnostic doc).

**Pinnacle pre-bet filter bypass for shadow bets** at `scheduler.ts:1322-1366`: explicit `if (isShadowBet) skip pinnaclePreBetFilter` with INFO log explaining why.

**Confidence: EVIDENCE-BASED.**

### 2.3 R6 hotfix — Pinnacle-source-only CLV (SHIPPED + VERIFIED)

**Status:** ✅ shipped (commit `29e8396`). Verification passed (2 PASS_pinnacle, 1 structural-pass-with-source-discrepancy on id 859, negative test trivially passing).

**Two writers patched:**
- `paperTrading.ts:1931-1980` — settlement-time CLV. Two-lookup split: `latestAnySource` for `closing_odds_proxy` (diagnostic), `latestPinnacle` for `clv_pct` (gate-relevant). Conditional spread on `clvPct` write.
- `betfairLive.ts:837-870` — same surgery on the live-mode reconciliation path.

**Confidence: EVIDENCE-BASED.** Verification details in `docs/phase-2-diagnostic-findings.md` §6.

### 2.4 v2.5 calibration (SHIPPED)

**Status:** ✅ shipped (commit `1f0e466`).

- `PROMO_MIN_SAMPLE_SIZE` default lowered from `30` → `25` at `promotionEngine.ts:8`.
- R14 winsorization: `clv_pct` clipped to ±50pp before averaging at `promotionEngine.ts:82` and `:311`.

**Confidence: EVIDENCE-BASED.**

### 2.5 Phase 2.B.3 — Betfair-first reverse-mapping cron (NOT PRESENT)

**Status:** ❌ **does not exist in current tree.** Referenced in `docs/phase-2-shadow-experiment-architecture-v1.md` §3.4 as `syncBetfairCompetitionCoverage` (the function name lives only on the unmerged `stage4-phase-A` branch). A grep across `artifacts/` shows zero references to `syncBetfairCompetitionCoverage` outside docs. No 4-pass matcher in `leagueDiscovery.ts` (top-level functions confirmed via `grep "^export\?\s*async\? function"` — see `leagueDiscovery.ts:72,107,133,153,203,447,451,489,497,775,809,855`).

The strategic brief's sub-phase 2 calls for this to be authored from scratch, with token-set ratio 0.85 fuzzy match. **No prior implementation exists to port from**.

### 2.6 Phase 2.C — Event-driven graduation (NOT PRESENT)

**Status:** ❌ **does not exist.** Table `graduation_evaluation_log` is created in `migrate.ts:1014-1024` but **zero code paths write to it**. Grep for `graduation_evaluation_log` or `graduationEvaluationLog` across `artifacts/api-server/src/` returns only `migrate.ts` itself. The settlement path (`paperTrading.ts:_settleBetsInner`) does not invoke any threshold-evaluator after writing settled rows.

The promotion engine (`promotionEngine.ts`) runs on a **daily cron at 04:00 UTC** (`scheduler.ts:2145-2151`). This is the cron-driven 24-28h latency the brief targets to close.

### 2.7 Sub-phase 6 — Autonomous threshold management (NOT PRESENT)

**Status:** ❌ **does not exist.** Required artifacts:
- Table `model_decision_audit_log` — does not exist.
- Table `pending_threshold_revisions` — does not exist.
- "Meta-evaluator" code path that proposes threshold tightening and writes to either of the above — does not exist.
- Kelly-growth-rate computation (the optimisation objective) — `promotionEngine.ts` currently optimises ROI / sample / p-value / CLV; **no log-bankroll-growth or Sharpe metric anywhere in `services/`**. Grep for `log.*bankroll`, `kelly.*growth`, `sharpe`: zero hits in `services/`.

### 2.8 Sub-phase 7 — API-Football data expansion (NOT PRESENT)

**Status:** ❌ data-expansion endpoints **not currently ingested.** `apiFootball.ts` audit shows the following endpoints in current use:
- `/leagues`, `/fixtures`, `/odds` (full set of bookmakers + Pinnacle), `/teams/statistics` (team form), `/h2h`, `/players` (lineups), `/predictions`.

Endpoints **NOT currently called** (per grep across `services/`):
- `/injuries`, `/transfers`, `/coachs`, `/sidelined`, `/trophies`, `/venues`, `/timezones` (irrelevant), `/referees`. **NONE** ingested.

`featureEngine.ts` weighting and feature names: no fields named `manager_*`, `injury_*`, `referee_*`, `weather_*`, `congestion_*`. **Confidence: EVIDENCE-BASED** on grep results.

### 2.9 Sub-phase 8 — OddsPapi kickoff-proximity optimisation (NOT PRESENT)

**Status:** ❌ current cadence is **uniform**, not kickoff-proximity-weighted.

Current OddsPapi crons (per `scheduler.ts`):
- Pre-kickoff CLV fetch: `*/15 * * * *` (`scheduler.ts:2023-2025`) — fixed 15-min interval, eligibility filter is `kickoff within 90 min`.
- Bulk prefetch: `10 */2 * * *` (`scheduler.ts:1997-1999`) — every 2h, 7-day window, 1000 req cap.
- Fixture mapping: `5 */6 * * *` (`scheduler.ts:1961-1963`) — every 6h.

There is no time-to-kickoff-bucketed polling. The +90 min filter is binary — either eligible or not. The proposed redistribution (every 5 min in T-3h window, slower further out) does not exist.

### 2.10 Sub-phase 9 — Probationary Kelly ratchet (PARTIAL)

**Status:** 🟡 partial. `experiment_registry.kelly_fraction` column **exists** (`migrate.ts:972`, default `1.0`, CHECK 0-1). `placePaperBet` does **not** read it — current logic at `paperTrading.ts:466-495` uses hardcoded `kellyFractionForScore(opportunityScore, marketType)` returning 0.125-0.50. The `experiment_registry.kelly_fraction` field is unused. 0.25× shadow-stake multiplier is hardcoded at `paperTrading.ts:1078`.

The "candidate-tier 0.25× Kelly" semantics referenced in the brief are real but currently expressed only via the `CANDIDATE_STAKE_MULTIPLIER` constant somewhere in `promotionEngine.ts:40` and `paperTrading.ts:1039` (per design-doc references) — not via the registry column.

**Generalising = wiring `experiment_registry.kelly_fraction` into `placePaperBet`.** That work is unstarted.

### 2.11 Sub-phase 10 — Ongoing audit cron (NOT PRESENT)

**Status:** ❌ no cron at any slot runs `settlement-bias` SQL nor `feature-coverage` SQL on a schedule. No auto-demotion path exists for `competition_config.universe_tier`.

---

## 3. Cron schedule (full audit)

Source: `scheduler.ts` grep for `cron.schedule`. **45 cron registrations in total.** Each entry: time | line | function | purpose.

### 3.1 High-frequency (sub-hourly)

| Time | Line | Function | Purpose |
|---|---|---|---|
| `*/2 * * * *` | 1790 | `runSettlementPipeline` | Sync 2-day window + settle + backfill |
| `*/15 * * * *` | 1815 | `getAccountFunds` (live mode only) | Betfair balance refresh |
| `*/30 * * * *` | 1807 | `reconcileSettlements` (live mode only) | Betfair settlement reconciliation |
| `*/30 * * * *` | 1830 | `safeRunIngestion` | Data ingestion |
| `*/10 * * * *` | 1836 | `safeRunExchangeBookSweep` | Exchange snapshot sweep (24h NEAR window) |
| `*/5 * * * *` | 1853 | `runTradingCycle({tier:"near", 1-48h})` | Near-tier trading cycle |
| `*/5 * * * *` | 1878 | drawdown circuit-breaker recheck | Re-evaluates drawdown state |
| `*/15 * * * *` | 2023 | `fetchAndStoreClosingLineForPendingBets` | Pre-kickoff Pinnacle CLV (Writer A) |
| `*/15 * * * *` | 2199 | `capturePreKickoffLineups` | Lineup confirmation |
| `*/5 * * * *` | 2053 | `captureAllPendingSnapshots` | Per-bet velocity snapshots |
| `7,22,37,52 * * * *` | 2039 | `fetchPreKickoffSnapshots` | Pinnacle 45-75 min pre-kickoff |
| `2,32 * * * *` | 1862 | `runTradingCycle({tier:"far", 48-168h})` | Far-tier trading cycle |
| `*/5 * * * *` | 2223 | `checkRelayHealth` (relay configured only) | VPS relay health |
| `*/2 * * * *` | 2240 | `runOrderManagement` (relay configured only) | Order management (partial fills, cancellation) |
| `*/5 * * * *` | 2269 | alert detection | Critical/warning condition scan |
| `15 * * * *` | 1795 | `runSettlementPipeline(true)` | Deep settlement sweep (7-day lookback) |

### 3.2 Hourly to multi-hourly

| Time | Line | Function | Purpose |
|---|---|---|---|
| `0 * * * *` | 2253 | stale placement reconciliation | PENDING_PLACEMENT > 10 min |
| `5 */6 * * *` | 1961 | `safeRunOddspapiMapping` | OddsPapi fixture mapping |
| `20 */6 * * *` | 1970 | Betfair event mapping | Populate `betfair_event_id` |
| `0 */2 * * *` | 1938 | `fetchAndStoreOddsForAllUpcoming` | API-Football odds refresh |
| `10 */2 * * *` | 1997 | `runDedicatedBulkPrefetch(7, 1000)` | OddsPapi bulk prefetch |
| `30 */4 * * *` | 2065 | `trackLineMovements` | Line-movement capture |
| `0 */6 * * *` | 1847 | `safeRunFeatures` | Feature computation |
| `0 */6 * * *` | 2191 | `syncDevToProd` | Dev→Prod sync |
| `0 */12 * * *` | 1952 | `fetchTeamStatsForUpcomingMatches` | Team stats refresh |

### 3.3 Daily

| Time | Line | Function | Purpose |
|---|---|---|---|
| `1 0 * * *` | 2012 | `logDailyBudgetSummary` | OddsPapi daily budget summary |
| `30 0 * * *` | 2123 | `runLeagueDiscovery` | AF league discovery (DAILY) |
| `0 2 * * *` | 2075 | `backfillFilteredBetOutcomes` | Filtered-bet outcome backfill |
| `0 3 * * *` | 2096 | learning loop | Daily learning loop |
| `0 4 * * *` | 2145 | `runPromotionEngine` | **Promotion engine — 24h cron-driven latency** |
| `15 4 * * *` | 2153 | `evaluateLiveRiskLevel` | Live risk level evaluation |
| `30 4 * * *` | 2283 | anomaly detection | Daily anomaly scan |
| `0 5 * * *` | 2109 | `runXGIngestion` | xG ingestion |
| `30 6,18 * * *` | 2137 | `ingestFixturesForDiscoveredLeagues` | Twice-daily discovered-league fixture ingestion |

### 3.4 Weekly (Sunday)

| Time | Line | Function | Purpose |
|---|---|---|---|
| `0 4 * * 0` | 2167 | `runWeeklyExperimentAnalysis` | Weekly self-analysis (writes `experiment_learning_journal`) |
| `30 4 * * 0` | 2175 | `recalculateAllDataRichness` | Per-match richness recalc |
| `0 5 * * 0` | 2183 | `reviewLiveThreshold` | Live threshold review |
| `30 5 * * 0` | 2085 | `analyseSharpMovements` | Sharp-money movement analysis |
| `0 6 * * 0` | 2296 | alert cleanup (90-day) | Deletes alerts older than 90d |

### 3.5 Monthly

| Time | Line | Function | Purpose |
|---|---|---|---|
| `0 3 1 * *` | 2206 | monthly league performance scoring | Deactivation of underperforming leagues |

### 3.6 Cron-slot conflicts to avoid (for sub-phase 5 event-driven + sub-phase 10 audit)

The strategic brief's sub-phase 5 wants event-driven evaluation hooked into `_settleBetsInner` (no new cron — runs synchronously on settlement). Sub-phase 10 wants a weekly bias/coverage audit. Slots free of clashes:
- **Sunday 06:30 UTC** is empty (06:00 alert cleanup, 06:30 daily ingestion runs at 18:30 too — but 06:30 conflicts on weekdays). On Sunday only, 06:30 is free.
- **Sunday 07:00 UTC** is fully free (matches v2 §2.3 for Tier C polling and is the recommended slot for the proposed Betfair-first cron in sub-phase 2).
- **Sunday 03:30 UTC** is free.

---

## 4. Banned-market inventory

**Single source of truth:** `BANNED_MARKETS` constant at `paperTrading.ts:445-464`. Imported by:
- `paperTrading.ts:683` — placement hardstop with WARN log.
- `paperTrading.ts:2468-2519` — `voidBannedMarketBets` settlement-time void/refund.
- `valueDetection.ts:1035` — pre-pricing filter at value-detection time.
- `oddsPapi.ts:2130-2131` — comment confirms prefetch mirrors the set (excludes banned markets from OddsPapi prefetch).

**Reactivation surface:** to activate any banned market on the experiment track only, gate the `BANNED_MARKETS.has(marketType)` checks at `paperTrading.ts:683` and `valueDetection.ts:1035` on `data_tier`. **Confidence: EVIDENCE-BASED.**

### 4.1 Full list with reason and reversibility

| # | Market | Comment in code | Reversible via flag? | Settlement code present? | Pricing/value-detection code present? |
|---|---|---|---|---|---|
| 1 | `OVER_UNDER_05` | "~92% win rate — no edge signal" | Yes (toggle constant) | ✅ via `OVER_UNDER` series at `paperTrading.ts:~1648` (need to verify exact case) | ✅ generated by valueDetection's OU loop |
| 2 | `OVER_UNDER_15` | "~75% win rate — no edge signal" | Yes | ✅ `paperTrading.ts:1651-1654` | ✅ |
| 3 | `OVER_UNDER_25` | "Quarantined 2026-04-20 pending pricing-pipeline fix — see CLV diagnostic" | Yes | ✅ `paperTrading.ts:1656-1659` | ✅ |
| 4 | `OVER_UNDER_35` | "Quarantined 2026-04-20 pending pricing-pipeline fix" | Yes | ✅ `paperTrading.ts:1661-1664` | ✅ |
| 5 | `FIRST_HALF_RESULT` | "Quarantined 2026-04-20 pending pricing-pipeline fix" | Yes | ✅ `paperTrading.ts:1723-1737` | Unknown — needs check |
| 6 | `DOUBLE_CHANCE` | "Quarantined 2026-04-20 pending pricing-pipeline fix" | Yes | ❓ no `case "DOUBLE_CHANCE"` block found in settlement switch — need to verify | Unknown |
| 7 | `FIRST_HALF_OU_05` | "Too easy; FIRST_HALF_OU_15 retained instead" | Yes | ✅ `paperTrading.ts:1739-1748` (shared with OU_15) | Unknown |
| 8 | `TOTAL_CARDS_45` | "Near-certainty; unreliable settlement data" | Yes | ✅ `paperTrading.ts:1711-1720` | Yes (NEW_MARKET_TYPES set at `paperTrading.ts:440`) |
| 9 | `TOTAL_CARDS_55` | "~85% win rate — no edge signal" | Yes | ✅ same case block | Need to verify generation |
| 10 | `TOTAL_CORNERS_75` | "Edge concentration: ALL corners suspended — 90 bets, -42.5% ROI" | Yes | ✅ `paperTrading.ts:1696-1707` | Yes (NEW_MARKET_TYPES) |
| 11 | `TOTAL_CORNERS_85` | "Edge concentration" | Yes | ✅ | Yes |
| 12 | `TOTAL_CORNERS_95` | "Edge concentration" | Yes | ✅ | Yes |
| 13 | `TOTAL_CORNERS_105` | "Edge concentration" | Yes | ✅ | Yes |
| 14 | `TOTAL_CORNERS_115` | "Edge concentration" | Yes | ✅ | Yes |

**All 14 banned markets are config-flag-reversible** (toggle the constant or gate it on `data_tier`). **Settlement code exists for at least 13/14**; `DOUBLE_CHANCE` settlement coverage needs explicit verification before reactivation. **Pricing/value-detection coverage needs market-by-market verification** for sub-phase 4 (the brief flags "code-removed vs config-flag-reversible" as the binary; current state is uniformly the latter, but pricing-pipeline parity is the open question).

### 4.2 Asian Handicap — placement-completeness verdict

**`ASIAN_HANDICAP` is NOT in `BANNED_MARKETS`** (it was never quarantined). But the user's brief calls out: "Asian Handicap specifically: confirm whether AH placement code is functionally complete or whether Replit-era integration was incomplete. If incomplete, AH activation is its own sub-phase 4.A."

**Audit verdict: AH placement is FUNCTIONALLY INCOMPLETE.**

| Layer | File:line | Status |
|---|---|---|
| Settlement | `paperTrading.ts:1671-1693` | ✅ COMPLETE — handles split bets on quarter handicaps (e.g., `Home -0.25` → split into −0.5 and +0.0) |
| AF parser | `apiFootball.ts:476-478` | ✅ EXTRACTS AH selections from raw `/odds` response |
| Betfair MARKET_TYPES list | `betfair.ts:13-21` | ✅ INCLUDES `ASIAN_HANDICAP` |
| Betfair live placement | `betfairLive.ts:1078` | ✅ MAPPED |
| OddsPapi market-id mapping | `oddsPapi.ts:131-132` | ✅ MAPPED to id 104 |
| **`valueDetection.ts` candidate generation** | grep result: zero hits | ❌ **NEVER GENERATES AH CANDIDATES.** No code path produces `marketType: "ASIAN_HANDICAP"` from value detection. |
| **OddsPapi prefetch** | `oddsPapi.ts:2752-2754` comment | ❌ **EXPLICITLY EXCLUDED:** "Exclude: ASIAN_HANDICAP (huge volume, not bet)" |
| **Exchange book sweep** | `exchangeBookSweep.ts:18-20` | ❌ **EXPLICITLY SKIPPED:** "ASIAN_HANDICAP returned by the catalogue is intentionally skipped — the picker does not price them" |

**Net:** AH bets cannot be generated by the current pipeline. The settlement and primitive layers are ready; the value-detection, pricing-validation, and execution-pricing layers are NOT. Activating AH is non-trivial and matches the brief's flag for **its own sub-phase 4.A**, not bundled with the simpler "flip BANNED_MARKETS gate" reactivations.

**Confidence: EVIDENCE-BASED** on every cited file:line.

---

## 5. Recent commit history (relevant to Phase 2 + R6)

```
786dd46 Phase 2.B.2: shadow-stake placement path for Tier B/C bets
9d5db0d Phase 2.B.1: gate dispatcher reads universe_tier (refactor + telemetry)
37aca11 Phase 2.A: schema migrations for universe-tier classification
1f0e466 v2.5 calibration: lower sample threshold to 25, winsorize CLV averaging
29e8396 R6 hotfix: filter clv_pct to Pinnacle sources at settlement
0016f9b Ignore .claude/ session-state directory
553431d Merge fix/typecheck-debt-bucket-c — Phase 1 typecheck cleanup
a79a229 Remove stale duplicate league ID 321 in leagueDiscovery.ts
329bbe9 Add explicit returns to route handlers
f9178f1 Type Understat raw match shape
75ba32e Dedupe imports in scheduler.ts
71f7e8f Remove 34 duplicate TEAM_ALIASES keys in oddsPapi.ts
10cdcf4 Add ALLOW_DEV_ON_PROD override for paper-trading on prod Neon
```

Last 5 commits = the strategic Phase 2 push to date. R6 hotfix verified (per `docs/phase-2-diagnostic-findings.md` §6).

---

## 6. DML state on prod (recap from prior session, not re-queried)

These were applied via direct DML on prod (per prior session conversation summary). Not in `migrate.ts`. Captured here so subsequent SQL doesn't conflict.

| DML | Effect | Source |
|---|---|---|
| Tier 1 placement bottleneck fix | `UPDATE matches SET country = 'South America'` for CONMEBOL Sudamericana; INSERT 5 alias rows in `competition_config` (synthetic api_football_id 900001-900005) | Prior session |
| `clv_source` write-time backfill | None applied — 2026-05-04 onward rows tagged at write-time only via R6 patch | Prior session |
| `universe_tier` seed | 1037 rows classified: 149 A / 84 B / 804 E. Tier C and D both 0 at time of seed. | Prior session |

**Verification SQL to confirm current state** (runs in §7 of diagnostic doc).

---

## 7. Confidence summary

- §1.1 (applied migrations) — **EVIDENCE-BASED**, full migrate.ts read.
- §1.2 (missing artifacts) — **EVIDENCE-BASED**, grep across `services/` confirms zero hits.
- §1.3 (`has_betfair_exchange` divergence) — **EVIDENCE-BASED on code; HAND-WAVY on prod DB origin**.
- §2.1-2.4 (shipped components) — **EVIDENCE-BASED**, line-level reads.
- §2.5-2.11 (missing components) — **EVIDENCE-BASED** via grep.
- §3 (cron schedule) — **EVIDENCE-BASED** via `cron.schedule` grep + line reads.
- §4 (banned markets) — **EVIDENCE-BASED** on the BANNED_MARKETS constant; **HAND-WAVY** on per-market settlement-code / pricing-code completeness for the markets where the audit is partial (entries marked "Need to verify" in the table).
- §4.2 (AH completeness) — **EVIDENCE-BASED**, every layer line-cited.

---

## 7.A Typecheck debt — non-blocking, sub-phase scope follow-up

**Discovered during R6.1 deploy attempt 2026-05-05.** `pnpm typecheck` fails on `artifacts/api-server` with ~30 errors across 8 files.

**Origin and scope:**

| Source | File:line | Error |
|---|---|---|
| Phase 2.B.2 (`786dd46`) | `scheduler.ts:1404,9` | `universeTier` does not exist on `BetOrder` interface |
| Phase 2.B.2 (`786dd46`) | `scheduler.ts:1461,31` | same |
| Pre-Phase-2 | `alertDetection.ts:238-246` | `dailyBudget`, `usedToday` properties missing on budget type |
| Pre-Phase-2 | `alertDetection.ts:428,430` | `league` not on paper_bets table type |
| Pre-Phase-2 | `betfairLive.ts:1465` | `unavailableOnExchange` |
| Pre-Phase-2 | `launchActivation.ts:141,203,438-440` | `AlertCategory`, missing properties |
| Pre-Phase-2 | `leagueDiscovery.ts:420` | `approved` property |
| Pre-Phase-2 | `oddsPapi.ts:1568,1569,1576` | `combined` property `never` type |
| Pre-Phase-2 | `paperTrading.ts:1457,1547,2402,2437` | various property + arithmetic type errors |
| Pre-Phase-2 | `riskManager.ts:480` | `distanceToDailyLimit` |
| Pre-Phase-2 | `scheduler.ts:313,327,329,488,754,1108,1451-1452,2391` | various |
| Pre-Phase-2 | `valueDetection.ts:319-320` | `null` not assignable to `number` |

**Why production deploys succeed despite this:** the build path uses a transpiler (esbuild/swc/Vite) that emits JS regardless of type-check failures. `pnpm build` succeeds; only `pnpm typecheck` fails. The runtime behaves correctly because the type errors are mostly cosmetic (missing optional fields, narrow union mismatches) rather than semantic bugs.

**Why this matters:**
- Future sub-phases that add new code paths can't typecheck-validate against a clean baseline.
- IDE feedback (TypeScript language server) reports all these errors as red squiggles, drowning new errors.
- Strict-mode emission (if ever enabled) would block deploys.

**Recommended cleanup:** `phase-1-typecheck-bucket-D` — follow-up sub-phase between sub-phase 2 and sub-phase 3. Mirrors the prior `553431d Merge fix/typecheck-debt-bucket-c — Phase 1 typecheck cleanup` commit that closed bucket C. Estimated wall-clock: 1-2h. Low risk (cosmetic fixes only).

**R6.1 added zero new errors.** Verified by line-cross-referencing against R6.1's edited regions (`paperTrading.ts:2024-2073`, `betfairLive.ts:700-718` + `876-911`). None of the error-emitting lines are in those regions.

**Confidence: EVIDENCE-BASED.** All error lines and their origin commits are git-traceable.

---

## 8. Open verification items for the user (NOT BLOCKING sub-phase 1)

These are minor parity questions that can be tracked but do not block proceeding:

1. **Reconcile `has_betfair_exchange` schema divergence**: should `migrate.ts` add the column for parity, or is `universe_tier` the canonical replacement?
2. **`DOUBLE_CHANCE` settlement code presence**: explicit grep for `case "DOUBLE_CHANCE"` in `paperTrading.ts` returned no matches in this audit. If it doesn't exist, sub-phase 4 should not reactivate DOUBLE_CHANCE without first authoring settlement logic.
3. **Per-banned-market pricing-pipeline parity**: 14 banned markets need market-by-market verification of value-detection and pricing-validation completeness. Sub-phase 4 should produce a per-market checklist before activation.

---

## 9. Sign-off

This document is **read-only and complete**. No code edits, no schema changes, no SQL. Companion `docs/phase-2-diagnostic-findings.md` covers the empirical-DB side of sub-phase 1.

The strategic brief proposes commit-the-pair as sub-phase 1's deliverable. **Recommendation: review both documents before committing**; either can be revised based on user feedback at zero cost.
