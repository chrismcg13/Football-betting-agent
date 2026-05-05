# Phase 2 — Execution Roadmap

**Authored:** 2026-05-05.
**Strategic source:** `docs/PHASE 2 FULL PUSH — strategic inten.txt`.
**Status:** ACTIVE — sequencing for the Phase 2 full push.

The 10 sub-phases in the strategic brief are flattened into **four execution waves**, parallel-tracking what can ship together, gating what must serialise. Each wave is independently approvable; nothing chains without explicit user trigger.

---

## Wave 1 — Close sub-phase 2 + open the firehose

**Goal:** Betfair-first universe expansion writes go live; experiment track flips on. Tier B/C bets begin placing at £0 + shadow_stake.

| # | Step | Type | Risk | Quick-revert |
|---|---|---|---|---|
| 1 | **Commit A.3** — country-adjective strip + duplicate-USA dedup. Bundles archetype-labelling-pass + go-live-checklist (already in tree). | Code commit | Low | Commit revert |
| 2 | Pre-cron Tier A snapshot | SQL (read-only) | None | n/a |
| 3 | Primera División Tier D demotion DML (§10.3 from diagnostic-findings) | DML | Low | Reverse UPDATE |
| 4 | Confirm Primera División demoted (Tier A count = 148) | SQL (read-only) | None | n/a |
| 5 | Set `BETFAIR_REVERSE_MAPPING_DRY_RUN=false` on VPS, restart api-server | Env-var flip | Low-medium | Env-var revert + restart |
| 6 | Trigger reverse-mapping cron via admin endpoint | HTTP POST | Low | n/a (cron is idempotent) |
| 7 | Post-cron Tier A snapshot | SQL (read-only) | None | n/a |
| 8 | **Diff snapshots** | SQL (read-only) | None | n/a |
| 9 | If diff is empty for Tier A rows: **flip `experiment_track_enabled=true`** | DML on agent_config | Medium | Reverse UPDATE |
| 10 | Watch one trading cycle for `tierCounts: { A: ?, B: >0, C: >0, none: 0 }` in funnel report | Log inspection | None | n/a |

**Acceptance for Wave 1 close:**
- Tier A diff (post-Primera-D-demotion vs post-cron): empty for all surviving 148 rows.
- Funnel report shows non-zero Tier B/C candidates after `experiment_track_enabled=true`.
- First Tier B/C bet placed (visible in `paper_bets WHERE shadow_stake IS NOT NULL`).

**Hard-stop conditions (HALT and investigate before flipping experiment_track):**
- Tier A diff non-empty for any row that wasn't Primera División.
- Tier A count drops below 148.
- Cron logs `writesProposed.updateUniverseTier > 0` for non-unmapped rows.

**Quick-revert ladder (most-aggressive last):**
1. Revert `experiment_track_enabled` to `'false'`.
2. Revert `BETFAIR_REVERSE_MAPPING_DRY_RUN` to `'true'`.
3. Manually undo specific Tier D rows the cron inserted that look wrong: `UPDATE competition_config SET universe_tier = 'unmapped' WHERE betfair_competition_id = ? AND created_at >= '<cron-timestamp>';`
4. Manually unset wrongly-claimed `betfair_competition_id` links.

---

## Wave 2 — R6.1 verify, decision-audit infrastructure, banned-market reactivation

**Goal:** verify R6.1 holding clean post-firehose-on, ship the autonomous-decision plumbing, investigate DOUBLE_CHANCE, then open banned markets on the experiment track.

Items ordered per user's adjustment: **schema first, investigation next, volume-amplifier last.**

| # | Step | Type | Risk | Notes |
|---|---|---|---|---|
| 0 | **Verify R6.1 in production** (commit `51ae339` already shipped) | SQL: Query 2 from r6-1 plan §6 | None | Run after ≥10 settlements have flowed through the new code post-firehose-on. R6.1 itself is NOT new code in this wave. |
| 1 | **Schema migration** — `model_decision_audit_log` + `pending_threshold_revisions` tables. Drizzle schema files + `migrate.ts` blocks. | Schema commit | Low | Idempotent CREATE TABLE IF NOT EXISTS. Empty on first deploy. |
| 2 | **DOUBLE_CHANCE investigation** — run the 5 SQL queries from `docs/double-chance-settlement-investigation.md`. Triage. | SQL (read-only) + investigation doc update | None | If selection-canonicalisation is the cause: ship a fix as a separate commit. If not: document and proceed. |
| 3 | **Sub-phase 4 — banned-market reactivation on experiment track.** Gate the `BANNED_MARKETS` filter at `paperTrading.ts:683` and `valueDetection.ts:1035` on `data_tier`. Production track keeps current bans. Experiment track bypasses entirely. | Code commit | Low-medium | Single-flag positive-gate. AH excluded — its placement code is incomplete (per current-state §4.2); AH activation is a separate sub-phase 4.A. |

**Acceptance for Wave 2 close:**
- Wave 2 #0: post-firehose Query 2 returns ≤1 misaligned row (only the known id 859 edge).
- Wave 2 #1: schema migration applies cleanly on prod; tables exist + are queryable.
- Wave 2 #2: DOUBLE_CHANCE diagnosis pinned (verdict in §2 of the investigation doc).
- Wave 2 #3: experiment-track funnel reports show non-zero placements for previously-banned market types (e.g., `OVER_UNDER_25` settled via Tier B/C).

**Hard-stop conditions:**
- Wave 2 #0: any misaligned rows beyond id 859. Halt; reopen R6.1 investigation.
- Wave 2 #3: production-track placements suddenly include banned markets. Halt — `data_tier` gate is broken; revert.

---

## Wave 3 — Event-driven learning + feature expansion

**Goal:** close the 24h cron-driven learning latency to event-driven; begin API-Football data expansion with the highest-value endpoint first.

| # | Step | Type | Risk |
|---|---|---|---|
| 1 | **Sub-phase 5 — event-driven graduation evaluator.** Hook into `_settleBetsInner`. On every settlement: recompute experiment_tag metrics, check threshold gates, fire tier transitions, write `graduation_evaluation_log`, compute archetype distribution-shift index A(archetype). | Code commit (medium-large, ~150-200 lines) | Medium |
| 2 | **Sub-phase 7.0 — `/injuries` endpoint ingestion.** Single highest-value endpoint first per brief. Add ingestion + feature: "key player injury impact." Retrospective predictive-power validation against settled bets — ship only if signal exists. | Code commit + retrospective | Medium |

Wave 3 has explicit **plan-mode docs per item** before code lands.

---

## Wave 4 — Layered enhancements (lower urgency)

| # | Step |
|---|---|
| 1 | **Sub-phase 6 — autonomous threshold management.** Weekly meta-evaluator. Tighter thresholds → autonomous (logged). Looser → `pending_threshold_revisions` for user approval. Optimisation target: log-bankroll growth. |
| 2 | **Sub-phase 7 expansion** — `/transfers`, `/coachs`, `/sidelined`, `/trophies`, weather, referees, lineup timing, fixture congestion. One commit per endpoint, gated on retrospective. |
| 3 | **Sub-phase 8 — OddsPapi kickoff-proximity.** Empirical CLV-by-time analysis first; redistribute polling if signal exists. |
| 4 | **Sub-phase 9 — probationary Kelly ratchet.** Wire `experiment_registry.kelly_fraction` into placement. |
| 5 | **Sub-phase 10 — ongoing audit cron.** Settlement-bias + feature-coverage weekly. Auto-demote rule. |
| 6 | **Phase-1 typecheck-bucket-D cleanup.** Non-strategic; tidies foundation. ~30 errors across 8 files. |

---

## Cross-wave invariants (NEVER violated)

- **Tier A behaviour byte-identical** pre/post each wave. Canary diff verifies.
- **Correlation rejection + duplicate-bet rejection** ON for both tracks at all times.
- **£0 experiment-track stake** architecturally enforced (`stake = 0`, `shadow_stake` populated separately).
- **Production-track risk controls** ON (drawdown caps, exposure limits, circuit breakers, min-stake floor, bankroll floor — currently deferred per `docs/real-money-go-live-checklist.md` until paper_mode flips).
- **Schema changes** always user-approval-gated.
- **DML changes** on production data always user-approval-gated.
- **Every autonomous decision** logs to `model_decision_audit_log` (once Wave 2 #1 ships).
- **Plan-mode doc** per sub-phase before code lands.
- **Quick-revert procedure** documented per wave.

---

## Items NOT in this roadmap (explicitly deferred to v3+)

- **Synonym handling** for fuzzy match (Pro↔Professional, Liga↔League, etc.) — leaves ~22 known fuzzy failures from sub-phase 2. Manual override pattern: UPDATE the wrong Tier D row's `betfair_competition_id` to link to the correct AF row.
- **Per-archetype graduation thresholds** — sub-phase 6 has a global threshold; per-archetype customisation deferred until 30+ candidate→promoted transitions accumulate.
- **Fuzzy-match library upgrade** to rapidfuzz-style ratios — current Jaccard-overlap is good enough for now.

---

## Sign-off discipline

- Wave 1 STOP after #10 (canary observation). Wave 2 trigger requires explicit user approval.
- Wave 2 STOP after #3 acceptance. Wave 3 trigger requires explicit user approval.
- Wave 3 STOP per item plan-mode doc. Wave 4 ordering revisable based on observed results.

This document supersedes any informal sequencing in earlier session messages. If conflict with the strategic brief: brief wins; this doc updates.
