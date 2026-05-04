# Phase 2 — Diagnostic Findings

**Status:** **EMPIRICAL FINDINGS COMPLETE (prod only).** All SQL has been run against prod. Dev was skipped per user direction (focus is prod paper-bet integrity until real-money switch). Findings, decision-branch resolution, and Phase 2.A readiness verdict are recorded in §6 and §7. R6 patch is staged but uncommitted; recommended commit sequence in §7.

**Author:** Claude (diagnostic-and-hotfix session, 2026-05-04)
**Working tree:** `C:\Users\chris\projects\Football-betting-agent\` (git repo, branch as-of `916c6cc`)
**Constraint disclosed:** this session's shell has no `psql`, `node`, or `pnpm` available. SQL must be run by the user. R6 patch is staged in the working tree but **not committed** — pending the verification test described in §5.

---

## 0. What this session has done

| Item | Status | Notes |
|---|---|---|
| Pre-work item 1: fix R6 Q1 SQL syntax | ✅ Done | `r6-clv-source-investigation.md` §3.1 corrected; malformed `JOIN ... AS league_via_match` removed; columns qualified |
| Pre-work item 2: pin patch approach | ✅ Done | Filter snapshot lookup to Pinnacle sources + conditional-spread write. **Both Writer B and Writer C.** Documented in `r6-clv-source-investigation.md` §4.3 |
| Pre-work item 3: pin demotion criterion | ✅ Done | Three-condition OR rule documented in `r6-clv-source-investigation.md` §4.2 |
| Sequence A: Run R6 Q1-Q4 | ⏳ Awaiting user run | SQL is final; no more corrections needed |
| Sequence B: Settlement-bias SQL | ⏳ Awaiting user run | SQL re-included below for convenience |
| Sequence C: API-Football usage SQL | ⏳ Awaiting user run | |
| Sequence D: Retrospective threshold SQL | ⏳ Awaiting user run | |
| Sequence E: Sunday discovery cron audit | ✅ Done | Results in §3 below |
| Hotfix F: R6 patch | ⚠️ Staged, not committed | Two file edits in working tree; awaits verification + your approval before commit. Diff in §4 |
| Hotfix G: Manual demotion of contaminated rows | ⏳ Pending Q4 results | Cannot proceed until Q4 returns rows |
| Findings doc H | 🟡 This document — partial | Will be completed when SQL runs |

---

## 1. Pre-work corrections (decisions pinned)

### 1.1 R6 Q1 SQL fix (item 1)

The malformed clause `JOIN matches m ON m.id = pb.match_id AS league_via_match` was caused by a leftover alias from an earlier draft. Fixed in place at `r6-clv-source-investigation.md` §3.1. All column references in the CTE are now qualified (`pb.*` and `m.league`). Visual inspection shows the query is syntactically valid Postgres; full parse-check requires running it. **Run with `EXPLAIN` first as a sanity check** — if it errors, paste the message.

### 1.2 Patch approach for Writer B + Writer C (item 2)

**Decision: filter the snapshot lookup to Pinnacle sources only AND use conditional-spread for the `clv_pct` write.** Apply identically to both writers. Leave `closing_odds_proxy` semantics unchanged (intentionally any-source — diagnostic column).

**Why:**
- *Filter-the-lookup* and *conditional-spread* are not really alternatives but complements (the user's prompt framed them as either-or; both are needed):
  - Filter alone, with unconditional write, would null-clobber when no Pinnacle snapshot exists.
  - Conditional spread alone, with any-source lookup, would still write market-proxy CLV when a non-Pinnacle snapshot is the latest.
  - Together: writes only Pinnacle CLV; if no Pinnacle snapshot found, leaves prior write alone.
- The Pinnacle source set `["oddspapi_pinnacle", "api_football_real:Pinnacle"]` is the canonical pair already used at `valueDetection.ts:685`, `oddsPapi.ts:2462`, `oddsPapi.ts:3142-3144` — matching this precedent keeps the codebase consistent.
- Two separate snapshot lookups (one any-source for `closing_odds_proxy`, one Pinnacle-only for `clv_pct`) cost ~negligible at settlement frequency. Cleaner than fetching all sources and filtering in memory.

**Net effect on `clv_pct` going forward:**
- For Tier A bets: Writer A populates Pinnacle pre-kickoff; Writer B/C refresh with Pinnacle at settlement. Column stays Pinnacle-attributed.
- For Tier B/C bets: Writer A doesn't fire (no OddsPapi mapping); Writer B/C find no Pinnacle snapshot → `clv_pct` stays NULL.
- **NULL becomes the explicit signal that no Pinnacle CLV is available.**

This is the bridge-state behaviour until Phase 2's `clv_source` column lands and Tier B/C can record CLV under a non-Pinnacle source tag.

### 1.3 Demotion criterion (item 3)

Pinned at `r6-clv-source-investigation.md` §4.2. Restated here:

A currently-promoted `experiment_registry` row is a demotion candidate if **any** of:

```
(a) pinnacle_sample / current_sample_size < 0.5            -- Pinnacle data covers <50% of decisions
(b) pinnacle_only_clv IS NULL                              -- no Pinnacle data at all
(c) pinnacle_only_clv + 0.5 < recorded_clv                 -- recorded CLV materially inflated vs Pinnacle truth
```

OR (not AND). Conservative-leaning. Action per row is manual: review, decide, run single-row UPDATE.

---

## 2. Diagnostic SQL runbook (to be run by user)

**Procedure for each query:**
1. Run in **dev** first; capture output.
2. Compare to expectation; if anything looks anomalous, stop.
3. Run in **prod**; capture output.
4. Paste both outputs into the placeholder sections below.

**All queries are read-only.** No DML. No schema changes. No transactions needed (single-statement reads).

### 2.A R6 Q1-Q4 (in `r6-clv-source-investigation.md` §3.1-3.4)

| # | Query | Purpose | Result placeholder |
|---|---|---|---|
| Q1 | Provenance distribution across all settled bets | Count of `pinnacle_preserved` / `market_proxy_only` / `pinnacle_overwritten_by_proxy` / `inconsistent_pinnacle_present_but_clv_neither` / `no_clv` | **TODO — paste here** |
| Q2 | Per-experiment-tag CLV provenance | For each tag: settled count and pinnacle/market_proxy/overwritten/no_clv breakdown | **TODO — paste here** (top 50 tags by settled count is sufficient) |
| Q3 | Promotions on contaminated CLV | Promotion-audit-log rows where `recorded_clv ≥ 1.5 BUT pinnacle_only_clv < 1.0 OR NULL` | **TODO — paste here** (full row count + the rows themselves) |
| Q4 | Currently-promoted experiments at risk | Rows where data_tier='promoted' and one of §1.3 conditions triggers | **TODO — paste here** (full list — these are the demotion candidates) |

**What I'll do once results are pasted:**
- Q1 → fill the §A.1 cells in §6.
- Q2 → identify which experiment_tags are most contaminated; flag for closer review.
- Q3 → quantify how many historical promotions need provenance review.
- Q4 → list demotion candidates in §6.A; user decides per row before any UPDATE.

### 2.B Settlement-bias SQL (v2 §2.1)

Verbatim re-print for convenience:

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
    AND pb.placed_at < NOW() - INTERVAL '7 days'
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

**Scope per the user's prompt:** run this against all current dual-flag (Tier A) leagues *plus* the 65 Betfair-only leagues from the recent expansion. The query above runs across all leagues in `matches` — to scope it tightly:

```sql
-- Append before LIMIT:
AND league IN (
  SELECT name FROM competition_config
  WHERE has_betfair_exchange = true
  -- (this includes both dual-flag and Betfair-only — the union the prompt requests)
)
```

(Add this `AND` to the outer SELECT's WHERE clause, replacing the n≥15 filter or alongside it as appropriate.)

**Result placeholder:** **TODO — paste here.** Report bias_index distribution; flag any league with `|bias_index| ≥ 0.10`.

### 2.C API-Football usage SQL (v2 §2.3)

```sql
SELECT date, SUM(request_count) AS total
FROM api_usage
WHERE date >= TO_CHAR(NOW() - INTERVAL '14 days', 'YYYY-MM-DD')
  AND endpoint NOT LIKE 'oddspapi_%'
GROUP BY date ORDER BY date DESC;
```

**Acceptance:** average daily usage + 2,800 calls/day stays below 50,000 (the throttle threshold). Throttle activates at monthly projection ≥90% which corresponds to roughly 67k/day average over a 30-day month.

**Result placeholder:** **TODO — paste here.** Report 14-day average and the projected post-Phase-2 average.

### 2.D Retrospective threshold SQL (v2 §5 phase 2.A)

The query is in `phase-2-shadow-experiment-architecture-v2.md` §5 phase 2.A (the WITH `tier_a` ... SELECT block). Verbatim re-print:

```sql
WITH tier_a AS (
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

**Result placeholder:** **TODO — paste here.** I'll then:
1. Total Tier A league count.
2. WOULD_GRADUATE count and percentage → maps to v2 §5 four-branch decision tree.
3. Distribution of failures by which gate failed (need a follow-up query splitting `WOULD_FAIL` by reason — see §6.D below for the diagnostic).

**Decision-branch resolution:** TBD pending data. Branches:
- `>80%` → proceed with v2 thresholds, monitor 30d.
- `50-80%` → diagnose: low-sample cluster → lower sample threshold; low-CLV cluster → drop CLV gate (already done for `market_proxy`).
- `20-50%` → STOP: probable R6 contamination. Re-run after Migration 5 backfill.
- `<20%` → HARD STOP: redraft thresholds against actual Tier A distribution.

### 2.E Phase 2.A graduation-time-to-50-bets projection (NEW)

Per the user's prompt: "the 50-bet sample × Tier B fixture rate gives expected time-to-graduation by archetype — compute this from data".

```sql
-- Per-archetype-proxy fixture rate: how many bets per league per week do we currently
-- generate, and how long would 50 bets take?
WITH bet_pace AS (
  SELECT
    m.league,
    COUNT(*) AS total_bets,
    DATE_PART('day', NOW() - MIN(pb.placed_at))::numeric / 7.0 AS weeks_active,
    -- Crude archetype proxy via name pattern (v3 will use proper archetype column):
    CASE
      WHEN m.league ILIKE '%women%' OR m.league ILIKE '%féminine%' THEN 'women'
      WHEN m.league ILIKE '%cup%' OR m.league ILIKE '%coupe%' OR m.league ILIKE '%copa%' THEN 'cup'
      WHEN m.league ILIKE '%world cup%' OR m.league ILIKE '%nations league%' OR m.league ILIKE '%euro%' THEN 'international'
      ELSE 'other'
    END AS archetype_proxy
  FROM paper_bets pb
  JOIN matches m ON m.id = pb.match_id
  JOIN competition_config cc ON cc.name = m.league
  WHERE pb.deleted_at IS NULL AND pb.legacy_regime = false
    AND cc.has_betfair_exchange = true
    AND cc.has_pinnacle_odds = false  -- approximates Tier B/C
  GROUP BY m.league
  HAVING DATE_PART('day', NOW() - MIN(pb.placed_at)) >= 30  -- ≥30 days of activity
)
SELECT
  archetype_proxy,
  COUNT(*) AS leagues,
  ROUND(AVG(total_bets / NULLIF(weeks_active, 0))::numeric, 2) AS avg_bets_per_week,
  ROUND((50.0 / NULLIF(AVG(total_bets / NULLIF(weeks_active, 0)), 0))::numeric, 1) AS weeks_to_50_bets
FROM bet_pace
GROUP BY archetype_proxy
ORDER BY archetype_proxy;
```

**Result placeholder:** **TODO — paste here.** This estimates wall-clock time from "league enters Tier B" to "league has 50 bets ready for graduation evaluation." If the answer is, e.g., 8 weeks for `other` and 30+ weeks for `women`, that's a major calibration input for v2 §1.5 (distribution-shift detector) AND for Phase 2.C wall-clock expectations.

**Caveat:** the query relies on existing bet placement to estimate Tier B/C fixture rates; until 2.B ships, Tier B/C leagues won't have bets. Use Tier A (Pinnacle-equipped) as a proxy where Tier B/C is sparse:

```sql
-- Alternative: use Tier A pace as a proxy (fixture density should be similar)
WHERE cc.has_betfair_exchange = true  -- both A and B/C
  -- drop the "AND cc.has_pinnacle_odds = false" line
```

Run both forms and compare; the gap is informative.

---

## 3. Sunday discovery cron audit (item E — DONE)

Source: `scheduler.ts`, complete grep + per-cron-block reads.

### 3.1 Sunday-only crons (UTC, day-of-week=0)

| Time | File:line | Function | Purpose | Phase 2.A relationship |
|---|---|---|---|---|
| 02:00 | `scheduler.ts:2125-2131` | `discoverPinnacleLeagues` | OddsPapi `/v4/tournaments` discovery + Pinnacle-coverage probe | **Supplemented.** Still useful as one input to universe classification (helps decide Tier A vs B vs C). New Betfair-first cron runs alongside, not replacing this. |
| 02:30 | `scheduler.ts:2134-2140` | `syncBetfairCompetitionCoverage` | Betfair `listCompetitions("1")` matched against existing competition_config; sets `has_betfair_exchange = true` on matched rows | **REPLACED.** Current direction is forward-map (Betfair → AF). Phase 2.A inverts the loop (AF lookup *for each* Betfair competition), and additionally creates Tier D rows for unmatched Betfair competitions. The new Betfair-first reverse-mapping cron supersedes this entirely. **v2 design proposal: take this exact Sunday 02:30 slot for the new cron.** Migration risk: ensure the old cron is removed in the same commit that adds the new one — running both would double-process the Betfair list. |
| 04:00 | `scheduler.ts:2116-2122` | `runWeeklyExperimentAnalysis` | Weekly experiment self-analysis (writes to `experiment_learning_journal`) | **Retained as-is.** Operates downstream of the universe; orthogonal to 2.A. |
| 04:30 | `scheduler.ts:2142-2148` | `recalculateAllDataRichness` | Per-match data-richness scores | **Retained as-is.** |
| 05:00 | `scheduler.ts:2150-2156` | `reviewLiveThreshold` | Live threshold review job | **Retained as-is.** |
| 05:30 | `scheduler.ts:2034-2042` | `analyseSharpMovements` | Sharp-money movement analysis | **Retained as-is.** |
| 06:00 | `scheduler.ts:2263-2274` | `cleanupOldAlerts(90)` | Delete alerts older than 90 days | **Retained as-is.** |

### 3.2 Daily crons that interact with discovery

| Time | File:line | Function | Phase 2.A relationship |
|---|---|---|---|
| 00:30 | `scheduler.ts:2072-2079` | `runLeagueDiscovery` (daily) | Scans API-Football leagues → populates `competition_config` + `discovered_leagues` | **Supplemented.** Continues to populate AF-discovered leagues. New Betfair-first cron is additive. |
| 02:00 | `scheduler.ts:2024-2030` | `backfillFilteredBetOutcomes` (daily) | Audits filtered bets retrospectively | Retained, orthogonal. |

### 3.3 Phase 2.A summary

- **One replacement** required: `syncBetfairCompetitionCoverage` (Sunday 02:30) → new Betfair-first reverse-mapping cron at the same slot.
- **No retirements** needed beyond that.
- **Two supplements**: `discoverPinnacleLeagues` (Sunday 02:00) and `runLeagueDiscovery` (daily 00:30) keep running; they feed the universe-classification logic.
- **One commit gate**: removing `syncBetfairCompetitionCoverage` and adding the new cron must ship in the same commit, otherwise either both run (double-processing) or neither runs (universe stale for a week).

---

## 4. R6 patch — staged in working tree (NOT committed)

**Files modified (uncommitted):**
- `artifacts/api-server/src/services/paperTrading.ts` (+34, −18)
- `artifacts/api-server/src/services/betfairLive.ts` (+27, −9)

**Per `git diff --stat`:** `2 files changed, 68 insertions(+), 27 deletions(-)`.

**Summary of changes:**
1. `paperTrading.ts` settlement CLV block (was around lines 1931-1980): split the snapshot lookup into two —
   - `latestAnySource` for `closing_odds_proxy` (preserves diagnostic semantics).
   - `latestPinnacle` for `clv_pct`, with `inArray(oddsSnapshotsTable.source, ["oddspapi_pinnacle", "api_football_real:Pinnacle"])`.
   - The UPDATE switches `clvPct: clvPct != null ? String(clvPct) : null` (always-write, the destructive bug) to conditional spread `...(clvPct != null ? { clvPct: String(clvPct) } : {})` (matches Writer A).
2. `betfairLive.ts` reconciliation CLV block (was around lines 837-870): identical surgery —
   - Add `inArray` to the drizzle imports (line 5).
   - Same two-lookup split.
   - Conditional-spread on `clvPct` write (already conditional pre-patch; only the lookup-source change is behavioural).

**No schema changes. No new files. Inline comments updated to reflect Pinnacle-only semantics.**

### 4.1 Verification procedure (the user runs)

The user's prompt requires: "Verify with a small test: place a synthetic paper bet, let Writer A populate Pinnacle CLV, then trigger settlement and confirm Writer B no longer overwrites."

**Procedure (run in dev only):**

1. Identify a Tier A fixture about to kick off (next 60-120 min) where `oddspapi_fixture_map` has a row.
2. Manually insert a paper bet into that fixture (or wait for the natural one). Confirm `paper_bets.closing_pinnacle_odds = NULL` and `paper_bets.clv_pct = NULL` immediately after placement.
3. Wait for the next `*/15` cron firing of `fetchAndStoreClosingLineForPendingBets` (Writer A). Confirm `closing_pinnacle_odds IS NOT NULL` AND `clv_pct IS NOT NULL` and `clv_pct = (odds_at_placement - closing_pinnacle_odds) / closing_pinnacle_odds * 100`.
4. Wait for fixture FT and the next settlement cycle. Capture `clv_pct` immediately after settlement.
5. **Pass criterion:** `clv_pct` value matches step-3 value (settlement preserved Writer A's value because Pinnacle snapshot was found in the lookup).
6. **Repeat** with a Tier B/C fixture (no OddsPapi mapping, so Writer A doesn't fire). At step 4, `clv_pct` should remain NULL (was NULL at placement; should still be NULL post-settlement).

**Negative-control regression test:** find a recent settled bet from before this patch and verify the patch doesn't re-process it (the patch only changes settlement-time computation, not historical data). `git log -- paper_bets table` is a no-op proxy — there's no migration; just verify no bets older than the patch deploy time have changed `clv_pct` post-deploy.

### 4.2 What is NOT in this patch

- **No schema migration.** `clv_source` column is Phase 2.A territory.
- **No backfill.** Historical contaminated rows remain mis-tagged. Migration 5 from v2 §3.1 is the durable backfill; it's gated by Phase 2.A.
- **No production demotion of currently-promoted rows.** That's hotfix G, gated on Q4 results.

### 4.3 Git/commit instructions (for you to run)

I have not committed. Recommended commit:

```
git add artifacts/api-server/src/services/paperTrading.ts \
        artifacts/api-server/src/services/betfairLive.ts \
        docs/r6-clv-source-investigation.md \
        docs/phase-2-diagnostic-findings.md

git commit -m "$(cat <<'EOF'
R6 hotfix: filter clv_pct to Pinnacle sources at settlement

paperTrading.settleBets and betfairLive.reconcileSettlements both
computed clv_pct from the latest snapshot of *any* source in
odds_snapshots, then either unconditionally (paperTrading) or
conditionally (betfairLive) wrote it to paper_bets.clv_pct. The
promotion-engine threshold (minClv >= 1.5) is Pinnacle-shaped, so
non-Pinnacle market-proxy values systematically contaminate the
gate. Worse, paperTrading's unconditional write null-clobbered any
prior Pinnacle CLV from fetchAndStoreClosingLineForPendingBets.

Patch:
- Split the snapshot lookup into two queries: any-source for
  closing_odds_proxy (diagnostic only), Pinnacle-source-only for
  clv_pct (used by promotion-engine gate).
- Pinnacle source set: ["oddspapi_pinnacle", "api_football_real:Pinnacle"]
  (matches valueDetection.ts:685, oddsPapi.ts:2462).
- paperTrading: switch unconditional write to conditional spread to
  preserve any prior Writer-A pre-kickoff write when no Pinnacle
  snapshot exists at FT.
- betfairLive: add inArray to drizzle imports; apply same two-lookup
  split.

Net effect: clv_pct is Pinnacle-attributed or NULL going forward.
Historical contamination requires Migration 5 backfill in Phase 2.A.

See docs/r6-clv-source-investigation.md and
docs/phase-2-diagnostic-findings.md for the full investigation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

**Do NOT push without verifying §4.1 first.** If verification fails, the diff in working tree is not committed yet — `git diff` shows current state.

---

## 5. What I cannot complete in this session

| Item | Why blocked | Unblock by |
|---|---|---|
| Run R6 Q1-Q4 | No `psql`/`node`/`pnpm` available in this shell | User runs SQL, pastes results |
| Run §2.B/C/D/E SQL | Same | Same |
| Verification test (§4.1) | Requires running DB + working settlement pipeline | User runs in dev environment |
| Hotfix G (manual demotion) | Depends on Q4 results | User runs Q4, decides per row |
| Final findings + decision-branch resolution (§2.D) | Depends on retrospective query results | User runs §2.D |
| Updated graduation-phase wall-clock by archetype (item H) | Depends on §2.E results | User runs §2.E |

**Confirmation that Phase 2.A is ready to begin:** **NOT YET.** Blockers in priority order:

1. R6 Q1-Q4 must run; if Q4 returns rows, manual demotions decided.
2. R6 patch must be committed AND verified per §4.1.
3. §2.B settlement-bias SQL must run; any league with `|B| ≥ 0.10` flagged for Tier D pre-2.A.
4. §2.D retrospective threshold SQL must run; decision-branch resolved.
5. §2.E graduation-time projection must run; wall-clock for 2.C calibrated.
6. §2.C API-Football usage SQL must run; budget headroom confirmed.

Estimated user time to unblock: ~1.5-3 hours (depending on environment access). Once unblocked, the v2 design is ready to enter implementation in 2.A.

---

## 6. Empirical findings (PROD)

### 6.A Q1-aggregate — Provenance distribution

```
provenance                       n
-------------------------------- ---
market_proxy_only                205
pinnacle_overwritten_by_proxy    129
no_clv                            79
pinnacle_preserved                 9
                                 ___
                                 422 total settled bets
```

**Interpretation:** of 422 settled bets, only 9 (2%) have a clean Pinnacle CLV value in `clv_pct`.

The catastrophic figure: of 138 bets where Writer A had pre-populated Pinnacle CLV (preserved + overwritten), **129 were destroyed by Writer B/C — a 94% destruction rate.** This is the empirical confirmation of the R6 bug at production scale.

### 6.B Q2 — Per-experiment_tag CLV provenance

**Of 100+ experiment tags, exactly ONE has `pct_pinnacle ≥ 50%`** (`la-liga-over-under-35`, n=1, 100% — meaningless at that sample size).

Tags with the most settled bets and zero Pinnacle preservation:
- `bundesliga-over-under-25` (14 settled, 0% pinnacle, 6 overwritten + 5 market-proxy + 3 no-CLV)
- `major-league-soccer-btts` (12 settled, 0% pinnacle, 12 market-proxy)
- `premier-league-btts` (12 settled, 0% pinnacle, 11 market-proxy + 1 no-CLV)
- `primera-divisi-n-match-odds` (11 settled, 0% pinnacle, 8 market-proxy + 3 overwritten)
- `championship-over-under-25` (10 settled, 10% pinnacle = 1 row)
- `premier-league-match-odds` (8 settled, 12.5% pinnacle = 1 row, 6 overwritten)

**Conclusion:** every graduation evaluation the engine has performed has used contaminated CLV data. Combined with §6.C below (no promotions ever), the contamination has not yet damaged tier transitions but would have if any threshold had cleared.

### 6.C Q3 — Promotion-audit forensic

```
(no rows)
```

**`promotion_audit_log` is empty.** No tier transitions have ever been recorded. The promotion engine has run (per `experiment_learning_journal` cadence) but no `experiment_tag` has cleared the experiment→candidate gate (sample 30, ROI 3%, CLV 1.5, win rate 52%, p ≤ 0.10, weeks 3, edge 2%).

**Implication for R6:** the contamination has not corrupted any production tier transition because no tier transitions have ever happened. The R6 patch ships independently — no coordinated demotion DML required.

### 6.D Q4 — Currently-promoted experiments at risk

```
(no rows)
```

**No experiment is currently in `data_tier = 'promoted'`.** Confirms §6.C: the production track has never had a graduated experiment. No demotion candidates exist.

**Hotfix G is no longer needed.** Phase 2.A's "demote contaminated promoted rows" pre-condition is removed.

### 6.E Settlement-bias SQL results

```
league             srate_pred_win  srate_pred_lose  bias_index  n_pred_win  n_pred_lose
Primera División   0.476           1.000            -0.524      189         90
```

Only one league cleared the `n ≥ 15` filter on both confidence buckets. Primera División bias_index of −0.524 is **5.2× the v2 §1.3 |B| ≥ 0.10 threshold** — extreme structural bias against predicted-wins.

**Hypothesised cause:** API-Football fixture-result coverage gap on contentious matches (abandonments, postponements, late-finish cup ties). Predicted-wins disproportionately fail to settle.

**Action:** route Primera División to `universe_tier = 'D'` when 2.A ships. Currently in production riding biased data — even though no promotion ever fired, the per-league ROI it contributes to global metrics is upward-biased (settled subset over-represents losses-the-model-predicted, which it… got right; but *unsettled* predicted-wins are missing from the upside).

**Caveat:** the n≥15 filter excludes most leagues. Settlement-bias re-test should run quarterly with looser filter (n≥10) once 2.A data accumulates.

### 6.F API-Football 14-day usage

```
date         total
2026-05-04   8,641
2026-05-03   16,021
2026-05-02   4,488
2026-04-23   232
2026-04-22   998
2026-04-21   364
2026-04-20   1,585
```

**Daily average over 7 reported days: ~4,617 calls.** Phase 2.A adds ~2,800/day → projected ~7,400/day. Throttle threshold is 50,000/day; daily cap 75,000. **Headroom: confirmed adequate.**

**Anomaly to investigate (not blocking):** April 24 through May 1 (8 days) have no `api_usage` rows. Either logging broke, no calls happened (improbable — discovery + odds run daily), or the endpoint filter excluded everything. Worth a separate diagnostic before 2.A but does not block.

### 6.G Q7 — Retrospective threshold

32 leagues evaluated. **0 WOULD_GRADUATE. 30 fail_sample. 2 no_data.**

Top of the retrospective by ROI:
- Premier League: 44 settled, 3 weeks, ROI 26.4%, Pinnacle CLV +4.8 — would graduate at sample threshold 25, fails at 50.
- Bundesliga: 34 settled, 4 weeks, ROI 8.3%, Pinnacle CLV +85.86 (outlier-corrupted, see R14 below).
- Serie A: 31 settled, 2 weeks, ROI 4.4%, Pinnacle CLV +415.69 (outlier-corrupted).
- Primera División: 28 settled, 2 weeks, ROI 46.5%, Pinnacle CLV +16.5 — but flagged Tier D in §6.E.
- Major League Soccer: 31 settled, 2 weeks, ROI −36.4% — abandon-track territory.
- K League 1: 26 settled, 3 weeks, ROI −35% — abandon-track territory.

**Decision-branch resolution: NEW BRANCH (not in v2 §5 four-branch tree).**

The v2 §5 `<20%` branch was designed for "thresholds drafted aspirationally" or "R6 contamination". This case is neither — the failures are uniformly **`fail_sample`** (settled < 50). It is a data-immaturity issue, not a threshold-disconnect issue.

**Branch action:** lower the experiment→candidate sample threshold from 30 to 25 (env var `PROMO_MIN_SAMPLE_SIZE` at `promotionEngine.ts:8`). This unblocks the leagues at 25-44 settled bets to be evaluated. Statistical justification: at sample 25 with implied prior ~0.4-0.5, p ≤ 0.05 against breakeven is achievable on a clear edge.

**v2 §1.2 threshold table revision:**

| v2 (proposed) | v2.5 (post-empirical) | Rationale |
|---|---|---|
| Sample size ≥ 50 | **Sample size ≥ 25** | No production league has reached 50 yet; 25 is the lower bound for p-value math against implied prior |
| ROI ≥ 5% | unchanged | |
| Win rate ≥ 53% | unchanged | |
| p ≤ 0.05 | unchanged | |
| ≥ 4 weeks active | unchanged | |
| LOO test | unchanged | |
| No week ≤ −15% | unchanged | |

**R14 (NEW) — promotion-engine CLV averaging is unwinsorized.** Bundesliga's `pinnacle_clv = 85.86` and Serie A's `+415.69` are pulled by 1-3 long-shot rows with placement-vs-close gaps in the +250% to +1500% range (id 33, id 682, id 720, id 716). Arithmetic mean at `promotionEngine.ts:82` is unstable at small N. **Action: clip individual `clv_pct` values to ±50pp before averaging, OR use median.** Plan-mode for v3 (small follow-up after R6 lands and 2.A schema lands).

### 6.H Q8 — Bet pace projection

```
archetype_proxy   leagues   avg_bets_per_week   weeks_to_50_bets   weeks_to_25_bets
other             28        60.69               0.8                0.4
```

Only the "other" archetype shows up in current data — there are not yet enough bets in cup / women / international archetypes to register in the substring matcher's `has_betfair_exchange` universe.

**Caveat:** these are *placement* rates, not *settlement* rates. Raw paper_bets data shows ~60-70% of placements end as `cancelled` / `placement_failed` / `void` (not `won`/`lost`). True settled-bets-per-week per league is therefore ~15-25, not 60.

**Calibrated wall-clock estimate for Phase 2.C graduation latency:**
- Time from "league enters Tier B" to "25 settled bets accumulated" ≈ **1-2 weeks** at current pace.
- Time to 50 settled ≈ 2-4 weeks.
- This is much faster than v2 §6.D anticipated. Phase 2.C event-driven graduation will see real tier-change activity within the first month of operation, not the first quarter.

---

## 7. Phase 2.A readiness verdict and recommended next actions

### 7.1 Verdict

**READY**, conditional on the actions in §7.2.

### 7.2 Recommended package (sequenced)

**Step 1 — R6 patch ships alone first** (defensive bug fix, no calibration changes):
- Commit the staged edits to `paperTrading.ts` and `betfairLive.ts`.
- Run §4.1 verification in prod (synthetic test bet OR observe natural Tier-A bet flow for 24-48h).
- Pass criterion: `clv_pct` values on settled Tier-A bets match `(odds_at_placement - closing_pinnacle_odds) / closing_pinnacle_odds * 100` rather than the equivalent computed from `closing_odds_proxy`.

**Step 2 — v2.5 calibration adjustments** (post R6 verification):
- Lower `PROMO_MIN_SAMPLE_SIZE` from 30 to 25 (env var or default at `promotionEngine.ts:8`).
- R14 winsorization in promotion engine (±50pp clip on individual `clv_pct` values before averaging at `promotionEngine.ts:82`).
- Pre-flag Primera División for `universe_tier = 'D'` (will land with Migration 1; document the override now).

**Step 3 — Phase 2.A schema migrations and Betfair-first cron** (planned in v2 §3.1, §3.4).

### 7.3 What is NO LONGER blocking 2.A

- ✅ Hotfix G (manual demotion of contaminated promoted rows) — Q3 + Q4 empty.
- ✅ "Demote first" pre-condition for 2.B — no rows to demote.
- ✅ The 50-bet sample size requirement — replaced by 25.

### 7.4 What IS still blocking 2.A

- ⏳ R6 patch commit + verification (the one staged in working tree).
- ⏳ Confirmation that Step 2 calibration adjustments are accepted.
- ⏳ Decision: ship R6 patch and Step 2 calibration in one commit, or sequentially? **Recommendation: sequentially.** R6 is a defensive bug fix; Step 2 is calibration. Bundling muddies rollback if R6 verification fails.
- 🔍 Investigate the April 24 - May 1 `api_usage` gap — not blocking, but worth understanding before scaling.

### 7.5 Open questions for the next session

1. **Settlement-bias scope:** Q5 only flagged Primera División at n≥15. Most leagues had insufficient bucket samples. Should the v2 §2.1 admission test be relaxed to n≥10, or pooled by archetype, or deferred until 2.A data accumulates?
2. **R14 — winsorization vs median?** Mathematically these have different properties. Median is more robust; winsorization preserves more signal. Which fits the small-N graduation-decision use case better?
3. **April 24 - May 1 API usage gap:** what happened?

---

## 8. Sign-off checklist (this session)

- [x] Pre-work item 1 corrected (Q1 SQL fix in r6 doc).
- [x] Pre-work item 2 decided (filter snapshot lookup + conditional spread, both writers).
- [x] Pre-work item 3 confirmed (3-condition OR demotion criterion — but no rows match anyway).
- [x] Sunday discovery cron audit complete (§3).
- [x] R6 patch staged in working tree (NOT committed) — `paperTrading.ts` and `betfairLive.ts`.
- [x] User ran Q1 / Q1-aggregate / Q2 / Q3 / Q4 / Q5 / Q6 / Q7 / Q8 in prod.
- [x] Empirical findings recorded in §6.
- [x] Decision-branch resolution: NEW BRANCH — data-immaturity, lower sample threshold to 25.
- [x] Phase 2.A readiness verdict: READY pending §7.2 sequence.
- [ ] User commits R6 patch (per §4.3) once verification passes.
- [ ] User accepts (or refines) §7.2 Step 2 calibration adjustments.
- [ ] User decides Step 1 / Step 2 sequencing.
