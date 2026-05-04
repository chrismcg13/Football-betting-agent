# R6 — CLV-Source Contamination Investigation

**Status:** code-evidence verdict only. SQL queries proposed for the user to run; this session has no DB access. **Not** part of the Phase 2 plan — this is a current production-state issue.

**Author:** Claude (plan-mode session, 2026-05-04)
**Trigger:** v1 review item: confirm whether `experiment_registry.currentClv` values stem from market-proxy CLV rather than Pinnacle CLV, and whether any contaminated rows have crossed the 1.5 threshold and reached `data_tier = 'promoted'`.

---

## 0. Verdict

**The bug is real, structural, and present in the current production code path. It is worse than v1 characterised.** Code analysis alone cannot tell you *how many* rows are contaminated — that needs the SQL queries proposed in §3 — but it can tell you *that* the contamination is unavoidable under current cron interleavings, and that one of the two settlement-side writers is **actively destructive** (it nulls out previously-written Pinnacle CLV when no market snapshot exists).

Severity: **MEDIUM-HIGH on production credibility, LOW on production *capital* exposure** (paper-track only for unmatched bets; real-money matched bets use a less destructive writer — see §1.2). Fix is a one-line conditional, but the data-quality damage is already done in the historical `paper_bets.clv_pct` column and in any `experiment_registry.currentClv` derived from it.

---

## 1. Three CLV writers identified

The `paper_bets.clv_pct` column is written by three distinct code paths. They run on different schedules with no coordination, and two of them produce a destructively-overlapping signal.

### 1.1 Writer A — Pinnacle pre-kickoff (true closing line)

**File:** `oddsPapi.ts:2596-2731` — `fetchAndStoreClosingLineForPendingBets`
**Cron:** `*/15 * * * *` (every 15 min) — `scheduler.ts:1948-1953` (the comment at 1947 confirms purpose: "store as `closing_pinnacle_odds` → snapshot C for three-snapshot CLV system")
**Eligibility filter:** pending bets kicking off within 90 min, with `closing_pinnacle_odds IS NULL` (`oddsPapi.ts:2620-2627`)
**What it writes (conditional):**
```ts
// oddsPapi.ts:2705-2711
await db.update(paperBetsTable).set({
  closingPinnacleOdds: String(closingOdds),
  ...(clvPct != null ? { clvPct: String(clvPct) } : {}),
}).where(eq(paperBetsTable.id, bet.id));
```
**Source of `closingOdds`:** OddsPapi `/odds` endpoint with marketId=101 (MATCH_ODDS), filtered to `slug.includes("pinnacle")` (`oddsPapi.ts:2683-2690`). This is **genuine Pinnacle closing data**.
**Coverage limitation:** only fires for fixtures where `getOddspapiFixtureId(matchId)` returns a value (line 2648). For Tier B/C leagues without OddsPapi mapping, this writer is silent.

### 1.2 Writer B — Settlement, paper-side (destructive)

**File:** `paperTrading.ts:_settleBetsInner` — CLV block at lines 1931-1966; UPDATE at 1968-1982
**Cron:** runs as part of every trading cycle (`settleBets()` invoked by the trading flow)
**Source of "closing odds":** `oddsSnapshotsTable` filtered by `(matchId, marketType, selectionName)`, ordered by `snapshotTime DESC LIMIT 1` (`paperTrading.ts:1941-1952`). **Ignores `source` column.** The latest snapshot of *any* source is used — `betfair_delayed`, `betfair_exchange`, `football_data`, `oddspapi`, `oddspapi_pinnacle`, `api_football_real:Pinnacle`, `api_football_real:1xBet`, `api_football_real:Bet365`, `derived_from_match_odds`. Inline comment at lines 1932-1937 acknowledges this is a proxy.
**What it writes — DESTRUCTIVE:**
```ts
// paperTrading.ts:1968-1980 — note: NOT conditional spread
await db.update(paperBetsTable).set({
  status: newStatus,
  settlementPnl: String(settlementPnl),
  settledAt: now,
  closingOddsProxy: closingOddsProxy != null ? String(closingOddsProxy) : null,
  clvPct: clvPct != null ? String(clvPct) : null,    // ← always written, including null
  ...
}).where(eq(paperBetsTable.id, bet.id));
```
This overwrites any prior `clv_pct` value (including a true Pinnacle one from Writer A) with whatever is computable from the latest snapshot in `odds_snapshots`. **If the latest snapshot lookup returns nothing, `clvPct` is computed as null and the prior Pinnacle CLV is destroyed.** This is the hard finding.

**Bets affected:** all unmatched bets and all paper-only bets. Real-money matched bets are deferred at `paperTrading.ts:1832-1837` (`if (bet.betfairBetId && matchedSize > 0) continue`) and routed to Writer C instead.

### 1.3 Writer C — Settlement, Betfair-real-money (non-destructive)

**File:** `betfairLive.ts:reconcileSettlements` — CLV block at lines 837-870; UPDATE at 893-909
**Cron:** runs from `reconcileSettlements()` (imported in scheduler at line 53)
**Source of "closing odds":** identical to Writer B — latest `oddsSnapshotsTable` row by `snapshotTime DESC` (`betfairLive.ts:846-857`). Source-agnostic.
**What it writes — NON-DESTRUCTIVE:**
```ts
// betfairLive.ts:893-908 — note: conditional spread
await db.update(paperBetsTable).set({
  ...,
  ...(closingOddsProxy != null ? { closingOddsProxy: String(closingOddsProxy) } : {}),
  ...(clvPct != null ? { clvPct: String(clvPct) } : {}),
}).where(eq(paperBetsTable.id, bet.id));
```
**Same source-agnostic proxy bug as Writer B** (it picks the latest snapshot regardless of source), but at least it doesn't null-clobber — if no snapshot is available, the previously-written Pinnacle CLV from Writer A survives.

### 1.4 Asymmetry summary

| Path | Pinnacle source guarantee | Overwrites prior write? | Null-clobbers prior write? |
|---|---|---|---|
| A: `fetchAndStoreClosingLineForPendingBets` | Yes (Pinnacle-filtered OddsPapi) | Conditionally — only if it computes a value | No |
| B: `paperTrading._settleBetsInner` (paper, unmatched) | No (latest of any source) | Always | **Yes — silently destroys prior Pinnacle CLV** |
| C: `betfairLive.reconcileSettlements` (real-money matched) | No (latest of any source) | Conditionally | No |

The combined behaviour for any given bet is **a function of cron-interleaving**:
- Bet placed → A writes Pinnacle CLV pre-kickoff (if eligible) →
  - If unmatched (paper-only) → B runs at FT settlement → **overwrites or nulls A's Pinnacle CLV**.
  - If real-money matched → C runs at reconciliation → preserves A's Pinnacle CLV unless a market snapshot exists.

This means: **a row's `clv_pct` value cannot be reliably attributed to any single source by inspection alone.** The forensic SQL in §3 disambiguates by comparing stored `clv_pct` against `closing_pinnacle_odds` and `closing_odds_proxy`.

---

## 2. Downstream impact: how this leaks into `experiment_registry.currentClv`

`promotionEngine.computeMetricsForExperiment` at `promotionEngine.ts:73-135` is the only writer to `experiment_registry.currentClv`. Its CLV computation:

```sql
-- promotionEngine.ts:82
COALESCE(AVG(clv_pct::numeric)
  FILTER (WHERE status IN ('won','lost') AND clv_pct IS NOT NULL), 0) as avg_clv
```

It averages `paper_bets.clv_pct` across all settled bets for an `experiment_tag`. **It does not filter or weight by source.** Whatever Writer B/C left in the column is what gets averaged. The threshold check at `promotionEngine.ts:11`:

```ts
minClv: parseFloat(process.env.PROMO_MIN_CLV ?? "1.5"),
```

is then applied to that average. The threshold is structurally Pinnacle-shaped — 1.5% sustained CLV vs Pinnacle is a strong signal — but is being applied to an average that is, in expectation, dominated by market-proxy values. **The threshold's statistical meaning collapses.** A tag can pass `currentClv ≥ 1.5` because the model consistently beats the latest API-Football back odds by 1.5%, which is a much weaker claim than beating Pinnacle's closing line by 1.5%.

There is also a candidate→promoted gate at `promotionEngine.ts:19` with `minClv: 1.0` — same structural issue.

The demotion-from-promoted gate at `promotionEngine.ts:25` (`minClv: 0`) is less structurally broken but still uses the contaminated value.

---

## 3. SQL the user needs to run (read-only — REQUIRES EXPLICIT APPROVAL)

These queries are flagged for explicit approval per project methodology, even though they are read-only. Run in dev first, prod second; compare.

### 3.1 Q1 — Distribution of CLV-source provenance across all settled bets

```sql
-- How many settled bets have clv_pct populated, and what's the apparent source?
-- v1.1 fix: qualified all columns; removed malformed "AS league_via_match" JOIN alias.
WITH classified AS (
  SELECT
    pb.id,
    pb.status,
    m.league,
    pb.odds_at_placement::numeric                      AS odds,
    pb.clv_pct::numeric                                AS clv,
    pb.closing_pinnacle_odds::numeric                  AS pin_close,
    pb.closing_odds_proxy::numeric                     AS proxy_close,
    -- Compute what clv_pct WOULD be from each source, for comparison
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

**What you're looking for:** how many bets are `pinnacle_preserved` vs `market_proxy_only` vs `pinnacle_overwritten_by_proxy`. The third category is the smoking gun — those rows had a Pinnacle closing line written by Writer A and then had it overwritten by Writer B.

### 3.2 Q2 — Per-experiment_tag CLV provenance

```sql
-- For each experiment_tag, what fraction of settled bets have which CLV provenance?
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

**What you're looking for:** experiment tags where `pct_pinnacle < 50%` are tags whose `experiment_registry.currentClv` is dominated by market-proxy values. Cross-reference with §3.3.

### 3.3 Q3 — Promotion-audit log: which tier transitions used market-proxy CLV?

```sql
-- For every promotion event, what did the metrics snapshot say about CLV
-- vs what we can reconstruct as the Pinnacle-only CLV?
SELECT
  pal.id,
  pal.experiment_tag,
  pal.previous_tier,
  pal.new_tier,
  pal.decided_at,
  (pal.metrics_snapshot ->> 'clv')::numeric AS recorded_clv,
  -- Reconstruct Pinnacle-only CLV at decision time:
  (
    SELECT ROUND(AVG(
      CASE
        WHEN pb.closing_pinnacle_odds IS NOT NULL AND pb.closing_pinnacle_odds::numeric > 1
        THEN ((pb.odds_at_placement::numeric - pb.closing_pinnacle_odds::numeric) / pb.closing_pinnacle_odds::numeric) * 100
        ELSE NULL
      END
    )::numeric, 3)
    FROM paper_bets pb
    WHERE pb.experiment_tag = pal.experiment_tag
      AND pb.status IN ('won','lost')
      AND pb.placed_at <= pal.decided_at
  ) AS pinnacle_only_clv,
  (pal.metrics_snapshot ->> 'sampleSize')::int AS sample_size,
  (pal.metrics_snapshot ->> 'roi')::numeric AS recorded_roi
FROM promotion_audit_log pal
WHERE pal.new_tier IN ('candidate', 'promoted')
ORDER BY pal.decided_at DESC;
```

**What you're looking for:** promotions where `recorded_clv ≥ 1.5` BUT `pinnacle_only_clv < 1.5` (or NULL). Those promotions would not have happened under a Pinnacle-source-required gate.

### 3.4 Q4 — Currently-promoted experiments at risk

```sql
-- Currently 'promoted' (i.e. live in production track) experiments: what's their
-- Pinnacle-only CLV vs what experiment_registry.currentClv claims?
SELECT
  er.id, er.experiment_tag, er.league_code, er.market_type, er.data_tier,
  er.current_sample_size,
  er.current_roi,
  er.current_clv AS recorded_clv,
  (
    SELECT ROUND(AVG(
      CASE
        WHEN pb.closing_pinnacle_odds IS NOT NULL AND pb.closing_pinnacle_odds::numeric > 1
        THEN ((pb.odds_at_placement::numeric - pb.closing_pinnacle_odds::numeric) / pb.closing_pinnacle_odds::numeric) * 100
        ELSE NULL
      END
    )::numeric, 3)
    FROM paper_bets pb
    WHERE pb.experiment_tag = er.experiment_tag
      AND pb.status IN ('won','lost')
  ) AS pinnacle_only_clv,
  (
    SELECT COUNT(*)
    FROM paper_bets pb
    WHERE pb.experiment_tag = er.experiment_tag
      AND pb.status IN ('won','lost')
      AND pb.closing_pinnacle_odds IS NOT NULL
  ) AS pinnacle_sample
FROM experiment_registry er
WHERE er.data_tier = 'promoted'
ORDER BY er.experiment_tag;
```

**What you're looking for:**
- Rows where `recorded_clv ≥ 1.5 AND pinnacle_only_clv < 1.0` (or NULL): currently in production on a structurally weak promotion.
- Rows where `pinnacle_sample / current_sample_size < 0.5`: less than half their bets had Pinnacle closing data. Their CLV claim is statistically unsound.

---

## 4. Recommended immediate actions (NO CODE CHANGES IN THIS DOCUMENT)

These are diagnostic and stabilising moves; each requires explicit approval before action.

1. **Run Q1-Q4 in dev, then prod.** Total query cost is small. Report findings before any further action.
2. **If Q4 returns rows** matching the §4.2 demotion criterion (pinned in §4.2 below): those experiments are in the production track on contaminated evidence. Recommended action: temporarily set `data_tier = 'candidate'` on those rows (regression to 0.25× Kelly via existing path at `paperTrading.ts:1038-1043`) pending v2 design of `clv_source`-gated thresholds. **Manual UPDATE statement, REQUIRES EXPLICIT APPROVAL.**
3. **Patch BOTH Writer B and Writer C** independently of Phase 2. v1.0 of this section proposed a one-line Writer-B patch only; that was incomplete. v1.1 of the patch covers both writers. See §4.3 for the pinned approach. **REQUIRES EXPLICIT APPROVAL.**
4. **Phase 2 still needs the `clv_source` column** as designed in v2 §3.1, because the patch only stops *new* contamination — historical contaminated rows remain. The patch + Migration 5 backfill is the durable fix.

### 4.2 Pinned demotion criterion (v1.1)

A currently-promoted experiment row should be demoted to `candidate` (0.25× Kelly) if **any** of:

```
(a) pinnacle_sample / current_sample_size < 0.5           -- Pinnacle data covers <50% of decisions
(b) pinnacle_only_clv IS NULL                              -- no Pinnacle data at all
(c) pinnacle_only_clv + 0.5 < recorded_clv                 -- recorded CLV is materially inflated vs Pinnacle truth
```

**Rationale per condition:**
- **(a) 50% threshold:** if more than half of the contributing settled bets had no Pinnacle CLV, the average is statistically dominated by market-proxy values; the recorded_clv is unreliable as a Pinnacle-shaped signal. 50% is the natural majority-split point; could tighten to 70% but 50% is the v1.1 default.
- **(b) NULL:** zero Pinnacle data → recorded CLV is entirely market-proxy → demote unambiguously.
- **(c) +0.5pp inflation:** at the 1.5% gate, a 0.5pp gap is one-third of the threshold's signal margin. This catches material inflation. Asymmetric (one-sided) on purpose: if pinnacle_only_clv > recorded_clv (deflation), the gate was met more easily on Pinnacle truth — keep promoted.

**Conjunction is OR, not AND:** any single trigger demotes. Conservative-leaning, appropriate given trust-erosion implications.

**Action:** for each row matching the criterion, the user reviews the row, decides demote/keep, and runs an explicit single-row UPDATE. No batch demotion in v1.1 — each is a manual gate.

### 4.3 Pinned patch approach (v1.1) — Writer B + Writer C

**Decision (per pre-work item 2):** filter the snapshot lookup to Pinnacle sources only AND use conditional-spread for the `clv_pct` write. Apply identically to Writer B and Writer C. Leave `closing_odds_proxy` write unchanged (column is intentionally any-source — it's a diagnostic).

**Pinnacle source set:** `["oddspapi_pinnacle", "api_football_real:Pinnacle"]` — matches the canonical set already used at `valueDetection.ts:685`, `oddsPapi.ts:2462`, `oddsPapi.ts:3142-3144`.

**Why this approach over alternatives:**
- *Filter-the-lookup* (chosen) is more efficient than *fetch-then-filter-result* and matches the precedent in the codebase.
- *Conditional spread* on the write preserves any prior Pinnacle CLV from Writer A when neither settler finds a Pinnacle snapshot. Without conditional spread, Writer B null-clobbers (the original bug).
- *Source filter at lookup* AND *conditional spread* are not really alternatives but complements (the user's prompt framed them as either-or; both are needed):
  - Filter alone (with unconditional write) → would null-clobber when no Pinnacle snapshot exists.
  - Conditional spread alone (with any-source lookup) → would still write market-proxy CLV when a non-Pinnacle snapshot is the latest.
  - Together: writes only Pinnacle CLV; if no Pinnacle snapshot found, leaves prior write alone.

**Net effect on `clv_pct` going forward:**
- For Tier A bets: Writer A writes Pinnacle pre-kickoff; Writer B/C write Pinnacle at settlement (refreshed); column stays Pinnacle-attributed.
- For Tier B/C bets: Writer A doesn't fire (no OddsPapi mapping); Writer B/C find no Pinnacle snapshot → `clv_pct` stays NULL.
- **NULL becomes the explicit signal that no Pinnacle CLV is available.** No more silent market-proxy contamination.

This is the bridge-state behaviour until Phase 2's `clv_source` column lands and Tier B/C can have CLV recorded under a non-Pinnacle source tag.

**Diff to ship (REQUIRES EXPLICIT APPROVAL — single commit, two files):**

`paperTrading.ts` (around line 1940-1980):
```ts
// 1. Add the inArray import if not already imported (it is).
// 2. Replace the snapshot lookup (lines 1941-1952):
const latestSnapshot = await db
  .select({ backOdds: oddsSnapshotsTable.backOdds })
  .from(oddsSnapshotsTable)
  .where(
    and(
      eq(oddsSnapshotsTable.matchId, bet.matchId),
      eq(oddsSnapshotsTable.marketType, bet.marketType),
      eq(oddsSnapshotsTable.selectionName, bet.selectionName),
      inArray(oddsSnapshotsTable.source, ["oddspapi_pinnacle", "api_football_real:Pinnacle"]),  // NEW
    ),
  )
  .orderBy(desc(oddsSnapshotsTable.snapshotTime))
  .limit(1);

// 3. Replace the UPDATE clv_pct field (line 1975):
//   Before: clvPct: clvPct != null ? String(clvPct) : null,
//   After:  ...(clvPct != null ? { clvPct: String(clvPct) } : {}),
// (closing_odds_proxy field unchanged — keep its any-source semantics.)
```

But note: `closing_odds_proxy` was previously computed from the SAME any-source snapshot lookup. After this patch, the snapshot used for `closing_odds_proxy` is now Pinnacle-only too. This is a semantic change for that column. **Two options:**
- **Option P (preferred):** add a SEPARATE any-source snapshot lookup for `closing_odds_proxy`, keep the existing column semantics. ~10 lines added.
- **Option Q (simpler):** let `closing_odds_proxy` semantics shift to Pinnacle-only. The column is internally-named "proxy" specifically because it was the workaround when no Pinnacle data was available — its purpose evaporates if both fields are now Pinnacle-only.

**Recommendation:** Option P. Keeps `closing_odds_proxy` as a useful diagnostic ("was there ANY closing data, even non-Pinnacle?") while the `clv_pct` write becomes Pinnacle-or-null. Two small selects rather than one — negligible cost.

`betfairLive.ts` (around line 843-908): identical surgery. Already uses conditional-spread for the write, so only the snapshot-lookup change is needed (plus the same Option-P decision for `closing_odds_proxy`).

**Verification procedure (user runs in dev):**
1. Place a synthetic test paper bet on a Tier A fixture (where Pinnacle data flows).
2. Wait for Writer A to populate `closing_pinnacle_odds` and `clv_pct` pre-kickoff.
3. After fixture FT, trigger settlement.
4. Confirm `clv_pct` matches the Pinnacle calculation (i.e., `(odds - closing_pinnacle_odds) / closing_pinnacle_odds * 100`) — not silently overwritten.
5. Repeat with a Tier B fixture (no Pinnacle): confirm `clv_pct` stays NULL after settlement (was NULL pre-settlement; should remain NULL).

---

## 5. What this investigation cannot determine without DB access

- The actual count of contaminated rows (needs Q1).
- The actual count of promotions made on contaminated evidence (needs Q3).
- The actual currently-live-in-production exposure (needs Q4).
- Whether any real-money bets have been placed under a contaminated promotion (needs Q4 join with `paper_bets` filtered to `betfair_bet_id IS NOT NULL`).

These are five short read-only queries and produce a definitive answer.

---

## 6. Confidence flags

- §1 (writers identified, line numbers, behaviour): **EVIDENCE-BASED** — every claim cited to file:line, code paths read directly.
- §2 (downstream contamination of `currentClv`): **EVIDENCE-BASED** — the engine's averaging code (`promotionEngine.ts:82`) is unambiguous.
- §3 (SQL queries): **EVIDENCE-BASED** for query intent, **ANALYTICAL** for the 0.01 floating-point tolerance threshold (Postgres numeric arithmetic is exact for the relevant precision; 0.01 is generous).
- §4.2 (recommended manual UPDATE on currently-promoted rows): **ANALYTICAL** — depends on Q4 returning rows. Defensive default if Q4 returns rows is reversion-to-candidate.
- §4.3 (one-line patch): **EVIDENCE-BASED** — patches the single destructive write site identified in §1.2.

---

## 7. Relationship to Phase 2

This investigation is **separable** from Phase 2 and should be resolved first. The Phase 2 v2 design assumes a clean `clv_source` taxonomy going forward; without addressing the historical contamination, Phase 2's retrospective threshold check (sub-phase 2.A step 3 in v1 §5) operates on poisoned data and could lock in incorrect threshold calibrations.

Recommended ordering:
1. Run Q1-Q4. (1 hour wall-clock.)
2. Decide on §4.2 (manual demote of contaminated promoted rows). (15 min decision.)
3. Ship §4.3 patch as a hotfix outside Phase 2. (30 min including review.)
4. *Then* begin Phase 2 v2 review.

If the user prefers to absorb this fix into Phase 2.A (sequenced as a pre-condition), the schema migration in v2 should add `clv_source` *and* the patch lands in the same commit as the schema. Per `feedback_race_conditions.md` discipline, schema-then-behaviour-flip would still apply: ship `clv_source` column first, backfill it from current `closing_pinnacle_odds` heuristic, then flip the gate.
