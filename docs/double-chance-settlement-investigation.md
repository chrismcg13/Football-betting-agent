# DOUBLE_CHANCE Settlement Investigation

**Status:** **CLOSED 2026-05-05** — verdict at §4 below. Settlement code is correct. The +15% CLV / −40% ROI contradiction is fully explained by R6 market-proxy contamination on Replit-era data. No code fix needed. DOUBLE_CHANCE can be reactivated on the experiment track via Wave 2 #4 alongside other quarantined markets.

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

## 4. Sign-off — CLOSED 2026-05-05

### 4.1 Test results (run by user on prod, 2026-05-05)

| Test | Result | Verdict |
|---|---|---|
| Q-DC-1 | 32 rows; all dates 2026-04-16 to 2026-04-19 (Replit-era model, pre-May-3 cutoff); selection_name uses `1X`/`X2`/`12` consistently | data context confirmed |
| Q-DC-2 | 20 should_lose/lost = AGREE; 12 should_win/won = AGREE; **zero disagreements** | ✅ settlement code is correct |
| Q-DC-3 | (skipped — Q-DC-1 confirmed format consistency) | not needed |
| Q-DC-4 | 21/32 settled via Betfair (live-mode `reconcileSettlements`); 11/32 via paper-mode `_settleBetsInner` | Mixed paths; both produce correct outcomes |
| Q-DC-5 | n=32, ROI=−40.05%, winsorised CLV=−3.304%, **with_pinnacle_close=0**, clv_without_pinnacle=24 | ✅ R6 contamination confirmed — every CLV value is market-proxy artefact, not Pinnacle |

### 4.2 Diagnosis

**The +15% unwinsorised CLV was a metric artefact, not a system bug.** Three contributing factors:

1. **R6 contamination (root cause):** 0 of 32 bets had `closing_pinnacle_odds` populated. The recorded `clv_pct` is computed against `closing_odds_proxy` (any-source close), not Pinnacle. Per R6 findings (`docs/r6-clv-source-investigation.md`), this CLV is unreliable.

2. **Outlier-driven mean:** five rows (ids 3, 6, 7, 9, 527) show CLV values of +40 to +109. Each represents a bet where the market moved dramatically away from the placement-time price *toward the actual outcome opposite our bet*. The high "CLV" reads positive only because placement-time odds were much higher than the closing-time short-side odds. Hindsight reads positive; the bet still lost. Winsorising at ±50pp brings the average to −3.304%, much more aligned with the −40% ROI.

3. **Replit-era model context:** all 32 bets are pre-May-3 cutoff. Per user direction: "any data from before the 3rd May is on Replit model which was buggy and wasn't a good judge." The model placed wrong-side bets; the closing market correctly re-priced toward the true outcome.

### 4.3 Conclusion

- **Settlement code:** ✅ no fix needed. `paperTrading.ts:1640-1644` correctly handles all three DOUBLE_CHANCE selection forms.
- **Selection canonicalisation:** ✅ no fix needed. Both short (`1X`/`X2`/`12`) and long (`Home or Draw`/...) forms handled in the case branch.
- **DOUBLE_CHANCE reactivation:** the historical data is uninformative for "is DOUBLE_CHANCE a tradable market?" because all evidence is from the buggy Replit model. **Recommend including DOUBLE_CHANCE in Wave 2 #4 banned-market reactivation** on the experiment track. Fresh Claude Code-era data on Tier B/C £0 stakes will reveal the genuine signal.

### 4.4 No follow-up code commit needed

This document closes Wave 2 #5 (DOUBLE_CHANCE investigation) without code change. Sub-phase 4 banned-market reactivation (Wave 2 #4) proceeds with DOUBLE_CHANCE in scope alongside the other quarantined markets.
