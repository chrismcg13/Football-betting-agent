# DOUBLE_CHANCE Settlement Investigation

**Status:** investigation document only. **No code fix proposed.** **No sub-phase ship is bundled with this work.** Per the strategic brief: "Investigate before sub-phase 4 reactivates DOUBLE_CHANCE on the experiment track."

**Authored:** 2026-05-05, sub-phase 1 of the strategic Phase 2 push.
**Trigger:** banned-market history audit (`docs/phase-2-diagnostic-findings.md` §6.2) returned a structurally implausible result for DOUBLE_CHANCE: **+15.156% winsorised CLV alongside −40.05% ROI on 32 settled bets**.

---

## 0. The structural impossibility

CLV measures whether we got "good" prices versus the closing line. ROI measures whether the actual settled-bet outcomes produced returns. For these two metrics to disagree by ~55 percentage points on the same 32 bets, **at least one is computed against the wrong data**.

Possible causes, ranked by likelihood:

1. **Settlement code mis-attributes outcomes.** If `paperTrading.ts:_resolveBet` does not have a `case "DOUBLE_CHANCE"` block, the function falls through to `default: return null` (`paperTrading.ts:1751-1752`) and the bet gets voided. But the data shows 32 settled (`status IN ('won','lost')`) — so either there's a path I haven't found, OR the settlements happened via a different writer.
2. **Selection canonicalisation mismatch.** DOUBLE_CHANCE has selections like "1X" (home or draw), "X2" (draw or away), "12" (home or away). If the canonical name in `paper_bets.selection_name` differs from what the resolver expects, the wrong outcome could be applied.
3. **Pre-quarantine vs post-R6 data.** All 32 settled bets are 2026-04-16 to 2026-04-19; the quarantine added 2026-04-20; R6 hotfix shipped 2026-05-05. The CLV in `clv_pct` could have been written by the pre-R6 destructive writer and is therefore Pinnacle-attributed-only on a subset (per current-state §1.3). The +15% winsorised CLV could be an artefact of which subset got Pinnacle-tagged.
4. **Pre-`legacy_regime` data.** The `legacy_regime = false` filter is supposed to gate to the post-`legacy_regime` migration data only; if any of the 32 bets are pre-flag, the data quality is unknown.

---

## 1. SQL diagnostics — run before any code change

These queries are read-only. Run them in order; subsequent queries depend on the row IDs returned by Q-DC-1.

### 1.1 Q-DC-1 — full per-bet detail

```sql
SELECT
  pb.id, pb.match_id, m.league, m.country,
  pb.market_type, pb.selection_name, pb.selection_canonical,
  pb.odds_at_placement, pb.stake,
  pb.status, pb.settlement_pnl,
  pb.closing_pinnacle_odds, pb.closing_odds_proxy, pb.clv_pct,
  pb.legacy_regime,
  m.home_team, m.away_team, m.home_score, m.away_score, m.status AS match_status,
  pb.placed_at, pb.settled_at,
  pb.opportunity_score, pb.experiment_tag, pb.data_tier
FROM paper_bets pb
JOIN matches m ON m.id = pb.match_id
WHERE pb.market_type = 'DOUBLE_CHANCE'
  AND pb.deleted_at IS NULL
  AND pb.legacy_regime = false
  AND pb.status IN ('won','lost')
ORDER BY pb.placed_at;
```

**What we're looking for:**
- The exact value of `selection_name` and `selection_canonical` for every bet.
- Whether `home_score`/`away_score`/`match_status` are populated (so the resolver had information to act on).
- Whether `status='won'` rows correspond to outcomes consistent with the selection (e.g., a "1X" bet should be `won` iff `home_score >= away_score`).
- Whether `closing_pinnacle_odds` is populated (suggesting Writer A ran pre-kickoff for these matches).

### 1.2 Q-DC-2 — selection-vs-outcome consistency check

For each bet, compute what the outcome SHOULD be based on `home_score` and `away_score` and compare to recorded `status`.

```sql
WITH dc_bets AS (
  SELECT
    pb.id,
    pb.selection_name,
    pb.status,
    m.home_score, m.away_score,
    CASE
      WHEN pb.selection_name ILIKE '1X' OR pb.selection_name ILIKE '%home%or%draw%' OR pb.selection_name ILIKE 'Home or Draw'
        THEN CASE WHEN m.home_score >= m.away_score THEN 'should_win' ELSE 'should_lose' END
      WHEN pb.selection_name ILIKE 'X2' OR pb.selection_name ILIKE '%draw%or%away%' OR pb.selection_name ILIKE 'Draw or Away'
        THEN CASE WHEN m.away_score >= m.home_score THEN 'should_win' ELSE 'should_lose' END
      WHEN pb.selection_name ILIKE '12' OR pb.selection_name ILIKE '%home%or%away%' OR pb.selection_name ILIKE 'Home or Away'
        THEN CASE WHEN m.home_score <> m.away_score THEN 'should_win' ELSE 'should_lose' END
      ELSE 'unknown_selection'
    END AS expected_outcome
  FROM paper_bets pb
  JOIN matches m ON m.id = pb.match_id
  WHERE pb.market_type = 'DOUBLE_CHANCE'
    AND pb.deleted_at IS NULL
    AND pb.legacy_regime = false
    AND pb.status IN ('won','lost')
    AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
)
SELECT
  expected_outcome, status,
  CASE
    WHEN expected_outcome = 'should_win'  AND status = 'won'  THEN 'agree'
    WHEN expected_outcome = 'should_lose' AND status = 'lost' THEN 'agree'
    WHEN expected_outcome = 'should_win'  AND status = 'lost' THEN 'DISAGREE_should_be_won'
    WHEN expected_outcome = 'should_lose' AND status = 'won'  THEN 'DISAGREE_should_be_lost'
    ELSE 'unknown'
  END AS verdict,
  COUNT(*) AS n
FROM dc_bets
GROUP BY expected_outcome, status, verdict
ORDER BY verdict, expected_outcome, status;
```

**What we're looking for:**
- If `verdict = 'DISAGREE_*'` rows exist in significant numbers → settlement code is mis-attributing.
- If most rows are `unknown_selection` → selection canonicalisation is the culprit (the resolver doesn't recognise the selection format we wrote).
- If everything is `agree` → settlement is correct; the −40% ROI is real, and the +15% CLV is the anomaly to chase.

### 1.3 Q-DC-3 — distinct selection_name + selection_canonical values

Diagnoses canonicalisation mismatches.

```sql
SELECT
  selection_name,
  selection_canonical,
  COUNT(*) AS n,
  SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) AS won,
  SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS lost
FROM paper_bets
WHERE market_type = 'DOUBLE_CHANCE'
  AND deleted_at IS NULL
  AND legacy_regime = false
GROUP BY selection_name, selection_canonical
ORDER BY n DESC;
```

**What we're looking for:**
- Multiple distinct `selection_name` values for the same logical bet ("1X", "Home or Draw", "Home/Draw") with different status distributions → canonicalisation didn't unify them, and the resolver only handles one form.
- `selection_canonical` NULL rows → the canonicalisation pass never fired.

### 1.4 Q-DC-4 — settlement code path origin

Where did the settled status come from? Three possible writers:
- `paperTrading.ts:_settleBetsInner` (paper-mode primary path)
- `betfairLive.ts:reconcileSettlements` (live-mode reconciliation; `isLiveMode()`-gated)
- A direct DML or admin endpoint

```sql
-- Check whether any DOUBLE_CHANCE bet has a betfair_bet_id (which would
-- route it through reconcileSettlements rather than settleBets).
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE betfair_bet_id IS NOT NULL) AS with_betfair_id,
  COUNT(*) FILTER (WHERE betfair_settled_at IS NOT NULL) AS with_betfair_settled,
  COUNT(*) FILTER (WHERE betfair_pnl IS NOT NULL) AS with_betfair_pnl
FROM paper_bets
WHERE market_type = 'DOUBLE_CHANCE'
  AND deleted_at IS NULL
  AND legacy_regime = false
  AND status IN ('won','lost');
```

**Interpretation:**
- `with_betfair_id = 0` → all settlements went through `paperTrading.ts:_settleBetsInner`.
- `with_betfair_id > 0` AND `with_betfair_settled > 0` → some went through live-mode reconciliation.

### 1.5 Q-DC-5 — CLV-vs-ROI recompute on raw data

Sanity-check the headline finding by recomputing both metrics from scratch on the raw rows.

```sql
SELECT
  COUNT(*) AS n,
  SUM(stake::numeric) AS stake_total,
  SUM(settlement_pnl::numeric) AS pnl_total,
  ROUND(100.0 * SUM(settlement_pnl::numeric) / NULLIF(SUM(stake::numeric), 0), 2) AS roi_pct,
  AVG(LEAST(50, GREATEST(-50, clv_pct::numeric))) AS clv_winsorised_avg,
  AVG(clv_pct::numeric) AS clv_unwinsorised_avg,
  COUNT(*) FILTER (WHERE clv_pct > 0) AS pos_clv_n,
  COUNT(*) FILTER (WHERE clv_pct < 0) AS neg_clv_n,
  COUNT(*) FILTER (WHERE clv_pct IS NULL) AS null_clv_n
FROM paper_bets
WHERE market_type = 'DOUBLE_CHANCE'
  AND deleted_at IS NULL
  AND legacy_regime = false
  AND status IN ('won','lost');
```

**What we're looking for:**
- Confirm the −40.05% / +15.156% headline.
- Distribution: how many of the 32 have `clv_pct IS NULL`? If most are null, the +15% average is computed on a small subset and may not be representative.
- Unwinsorised average: is the +15% an artefact of one or two extreme positive outliers that the winsorisation didn't fully damp?

---

## 2. Hypothesis triage

Once the SQL above is run, the diagnosis maps as follows:

| Q-DC-2 result | Q-DC-3 result | Likely cause | Fix surface |
|---|---|---|---|
| Mostly `agree` | Single canonical form | **CLV calc is broken for DOUBLE_CHANCE.** Look at the Pinnacle snapshot semantics for combined-outcome markets — the closing-line value calc may be applying `(odds - close)/close * 100` against an odds value that doesn't represent the same combined-selection event. | `paperTrading.ts:1968-1980` (CLV block); validate `oddsSnapshotsTable` row has matching selection. |
| Mostly `DISAGREE_*` | Single canonical form | **Settlement resolver mis-implements DOUBLE_CHANCE.** Either `_resolveBet` is missing the case (returns null → void → impossible since these settled), or the case has wrong logic. | `paperTrading.ts` → grep for `case "DOUBLE_CHANCE"`; if missing, find the alternate writer; if present, audit logic. |
| Many `unknown_selection` | Multiple distinct selection_name values | **Canonicalisation never unified the formats.** The resolver expects "1X" but writes saved "Home or Draw" (or similar). | `valueDetection.ts` and `paperTrading.canonicalSelectionName` — DC-specific normalisation pass missing or wrong. |
| Settlements have betfair_bet_id | n/a | **Live-mode reconciliation wrote them.** `betfairLive.ts:reconcileSettlements` does not implement market-specific outcome resolution — it just trusts Betfair's `cleared.betOutcome`. The CLV calc and the outcome-from-Betfair are independent paths; CLV vs ROI mismatch is then a property of what Betfair reports vs what we computed. | Probably not a code bug; but worth understanding the case-mix. |

---

## 3. What this document explicitly does NOT do

- **Does not propose any code change.** The fix surface depends on the SQL diagnosis.
- **Does not recommend reactivating DOUBLE_CHANCE.** That's a sub-phase 4 decision and requires this investigation to land first.
- **Does not modify `BANNED_MARKETS`** at `paperTrading.ts:445-464`.

---

## 4. Sign-off (when complete)

- [ ] Q-DC-1 results pasted.
- [ ] Q-DC-2 verdict (agree / DISAGREE / unknown_selection breakdown).
- [ ] Q-DC-3 selection-canonical distribution.
- [ ] Q-DC-4 origin attribution.
- [ ] Q-DC-5 raw-data sanity check.
- [ ] Diagnosis pinned in §2 table.
- [ ] Fix surface identified.
- [ ] Decision: reactivate (after fix) / leave permanently banned / further investigation.

This document is the durable record of what the bug was and how it was diagnosed. The fix (if any) ships as a separate commit referencing this document by name in the commit message.
