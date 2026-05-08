# oddspapi coverage expansion — analysis & recommendations
**Date:** 2026-05-08 · **Author:** Claude (Opus 4.7) · **Status:** Analysis only — recommendations require Chris's approval before any implementation.

## TL;DR

- **API budget headroom is huge: only 17–22% of 100k monthly cap used.** Plenty of room to expand.
- **The cost model isn't "calls per market"** — one `/odds` call returns ALL markets for a fixture. Adding markets to the persistence loop costs ZERO extra API budget.
- **Three coverage gaps, ranked by Path P value:**
  1. **ASIAN_HANDICAP not in PREFETCH_TARGETS** at all. We generate 1,391 pending shadow AH bets but oddspapi never captures AH Pinnacle. Highest-impact gap.
  2. **BTTS / DOUBLE_CHANCE / OU_45 listed in PREFETCH_TARGETS but produce 0 rows** in `oddspapi_pinnacle` — silent failure to parse / persist.
  3. **Only 110 of 1,029 active leagues have any oddspapi coverage** (11%). 880 leagues uncovered.
- **Recommended sequencing:** fix the silent-failure markets (gap 2) first because they cost nothing in budget. Then add ASIAN_HANDICAP. Then expand league breadth using the freed Path P throughput as guidance.

---

## 1. Current usage vs cap

### 1.1 Monthly oddspapi calls

```sql
SELECT date_trunc('month', date::date) AS month,
       SUM(request_count)::int AS total_calls,
       ROUND(100.0 * SUM(request_count) / 100000.0, 2) AS pct_of_cap
FROM api_usage WHERE endpoint LIKE 'oddspapi_%'
GROUP BY 1 ORDER BY 1 DESC;
```

| Month | Calls | % of 100k cap |
|---|---|---|
| 2026-04 | 17,584 | **17.6%** |
| 2026-03 | 22,375 | **22.4%** |
| 2026-05 (mid-month) | ~28,000 → projecting ~52,000 by month-end | **~52%** |

**Headroom: 48–82% of cap unused.** Even with the in-flight Option D discovery sweep (+~6,000 calls/month) and Bayesian recommender's analytical reads, comfortable.

### 1.2 Per-priority budget allocation (from oddsPapi.ts:85)

```ts
const PRIORITY_MONTHLY_BUDGETS: Record<string, number> = {
  P1: 40_000,  // bulk prefetch
  P2: 30_000,  // line movement
  P3: 20_000,  // closing line + pre-kickoff snapshots (T-5/15/30/60)
  P4: 10_000,  // fixture mapping + discovery
};
```

Current April usage by priority (from `api_usage`):
- P1: ~12,000 / 40,000 (30%)
- P2: ~3,000 / 30,000 (10%)
- P3: ~1,000 / 20,000 (5%)
- P4: ~700 / 10,000 (7%)

**P3 and P4 are particularly under-used.** P3 = closing-line CLV captures (the gold standard for Path P evaluation) is at 5% of its allocation.

---

## 2. League coverage analysis

### 2.1 The numbers

```sql
WITH active_leagues AS (
  SELECT DISTINCT name AS league, country FROM competition_config WHERE is_active=true
),
covered_leagues AS (
  SELECT DISTINCT m.league, m.country
  FROM odds_snapshots os JOIN matches m ON m.id = os.match_id
  WHERE os.source IN ('oddspapi','oddspapi_pinnacle')
    AND os.snapshot_time > NOW() - INTERVAL '30 days'
)
SELECT
  (SELECT COUNT(*) FROM active_leagues) AS leagues_we_track,
  (SELECT COUNT(*) FROM covered_leagues) AS leagues_with_oddspapi_coverage;
```

| Metric | Count |
|---|---|
| Active leagues we monitor | **1,029** |
| Leagues with any oddspapi coverage in last 30 days | **110** |
| Leagues uncovered | **880 (85%)** |

### 2.2 Top 30 covered leagues (by matches/30d)

| League | Country | Matches/30d |
|---|---|---|
| Liga Profesional Argentina | Argentina | 44 |
| Major League Soccer | USA | 33 |
| Primera Nacional | Argentina | 33 |
| J2/J3 League | Japan | 30 |
| Ligue 2 | France | 29 |
| Serie A | Italy | 27 |
| La Liga | Spain | 27 |
| Ligue 1 | France | 27 |
| CONMEBOL Sudamericana | South America | 27 |
| Primera División Apertura | Uruguay | 26 |
| Bundesliga | Germany | 26 |
| League Two | England | 24 |
| USL Championship | USA | 23 |
| League One | England | 22 |
| Premier League | England | 22 |
| Serie A | Brazil | 20 |
| Segunda División | Spain | 19 |
| Primeira Liga | Portugal | 18 |
| Eredivisie | Netherlands | 18 |
| Bundesliga | Austria | 17 |

For the covered leagues, coverage is **comprehensive** — every match captured. The shape of the gap is: of ~1,029 leagues, the heavy hitters (top 110) get full coverage; the long tail (880 leagues) gets nothing.

### 2.3 What 880 uncovered leagues represent

Mostly Tier C and D leagues per the universe-tier classification. Many are:
- Lower-division European leagues (3rd-tier+)
- Asian / African / Pacific islands leagues
- Cup competitions (where oddspapi may not cover at all)
- Women's football leagues
- Reserve / youth competitions

**Not all are commercially valuable.** Estimate ~150–200 of the 880 are realistic Path P candidates given Pinnacle would price them.

---

## 3. Market coverage analysis

### 3.1 What we currently capture in `oddspapi_pinnacle`

From `odds_snapshots` last 30 days:

| Market | Distinct matches | Rows |
|---|---|---|
| MATCH_ODDS | 912 | 2,993 |
| OVER_UNDER_25 | 906 | 1,982 |
| OVER_UNDER_35 | 798 | 1,765 |
| TOTAL_CORNERS_95 | 623 | 1,402 |
| TOTAL_CORNERS_105 | 414 | 914 |

Five markets actually showing up.

### 3.2 What `PREFETCH_TARGETS` says we WANT to capture

From `oddsPapi.ts:2168`:

```ts
const PREFETCH_TARGETS = [
  // Match Winner
  { marketType: "MATCH_ODDS", selectionName: "Home/Draw/Away" },
  // Goals O/U
  { marketType: "OVER_UNDER_25", "Over/Under 2.5" },
  { marketType: "OVER_UNDER_35", "Over/Under 3.5" },
  { marketType: "OVER_UNDER_45", "Over/Under 4.5" },
  // Corners
  { marketType: "TOTAL_CORNERS_95", "Over/Under 9.5 Corners" },
  { marketType: "TOTAL_CORNERS_105", "Over/Under 10.5 Corners" },
  // BTTS
  { marketType: "BTTS", "Yes/No" },
  // Double Chance
  { marketType: "DOUBLE_CHANCE", "1X/X2/12" },
];
```

**Listed but NOT showing up in `oddspapi_pinnacle`:**
- BTTS (0 rows captured despite being in targets)
- DOUBLE_CHANCE (0 rows)
- OVER_UNDER_45 (0 rows)

This is a silent persistence-or-parser failure. Possible causes:
- Oddspapi response doesn't include these markets for our queried fixtures
- `extractSelections`/`getSelectionOdds` selection-name matching doesn't find them
- They're returned but the bookmaker has no Pinnacle quote for that specific market

**Investigation needed before "expansion" can be claimed complete on these three.**

### 3.3 Critical gap: ASIAN_HANDICAP

`PREFETCH_TARGETS` does NOT include ASIAN_HANDICAP at all. Yet we have:
- **1,391 pending shadow ASIAN_HANDICAP bets** in current pool
- 0 captured ASIAN_HANDICAP Pinnacle rows in `oddspapi_pinnacle`

So Path P for AH is structurally impossible. AH represents the largest single market in our shadow rail and it cannot graduate to live via Path P without Pinnacle anchor capture.

**`MARKET_IDS` in oddsPapi.ts line 126 includes `ASIAN_HANDICAP: 104`** — the API-side mapping exists. The selection-name handling (e.g., "Home -1.5", "Away +2") is the missing piece, plus adding entries to `PREFETCH_TARGETS`.

### 3.4 The cost model insight

Comment at `oddsPapi.ts:2051`:
> "The /odds endpoint returns ALL markets regardless of marketId; default to 101 (1x2)"

**One API call returns the full market book for a fixture.** Adding markets to `PREFETCH_TARGETS` and the persistence loop costs **zero extra API calls**. The constraint is parsing logic, not budget.

---

## 4. Recommendations

### Phase A — Fix what's already specified (zero API cost)

**A1. Diagnose why BTTS / DOUBLE_CHANCE / OU_45 produce 0 rows in `oddspapi_pinnacle`.**
Capture a sample raw response from `/odds` for one fixture and inspect:
- Does the response include these markets?
- If yes, is there a Pinnacle quote? (Some bookmakers don't quote all markets)
- If yes, why does our parser miss it? (selection-name matching is the most likely culprit)

Fix the parser/selection-name match. **Effort: 2 hours including a one-fixture diagnostic curl.**

**A2. Add ASIAN_HANDICAP to `PREFETCH_TARGETS` + selection-name handling.**
- AH selection format: `"Home +0.5"`, `"Away -1.5"`, etc. Multiple lines per fixture (one row per line).
- The persistence layer currently keys snapshots on (match, market, selection). With AH, selections are line-specific — need to ensure dedup logic handles this.
- AH at Pinnacle is generally one or two lines (the main line + an alternative). Keep persistence simple: store all returned AH lines.
- **Effort: 4 hours (parser + persistence + integration test).**

### Phase B — Expand market depth on covered leagues (zero API cost)

After A1+A2, add:
- **OVER_UNDER_15** (sometimes Pinnacle quotes this; widely-traded)
- **TEAM_TOTAL_HOME / TEAM_TOTAL_AWAY** at common lines (0.5, 1.5, 2.5)
- **FIRST_HALF_RESULT** + **FIRST_HALF_OU_05** + **FIRST_HALF_OU_15**
- **TOTAL_CARDS_X** (35, 45, 55) — Pinnacle quotes these inconsistently; expect partial coverage

**Effort: 1-2 days for parser support across all these markets.** Same `/odds` calls; just save more.

### Phase C — Expand league breadth (incremental API cost)

Once Phase A+B are stable and we have data on what markets actually populate from oddspapi for current leagues:

**C1. Add the next 50 highest-priority uncovered leagues** (selected by: (a) Tier B in our universe classification, (b) liquid Pinnacle markets per third-party knowledge, (c) currently-active competitions).
- Estimated cost: ~50 leagues × ~25 matches/month × ~30 calls/match (snapshot cadence) = 37,500 calls/month
- Combined with current ~30k = ~67,500 → still within 100k cap
- **Effort: 1 day (configuration changes + monitoring how much actually fills).**

**C2. Add Tier C leagues by demand signal.** Once Path P is filling and gates are clearing on Tier B, expand to Tier C leagues that have shown shadow-rail edge (Path S graduations).
- Cost depends on exactly which leagues but probably 20–40k calls/month additional.
- **Effort: per-cohort, ~half-day each as we onboard.**

### Phase D — Maximise P3 (closing-line) usage

P3 budget: 20,000/month allocated, ~1,000 used. Massive headroom.

Closing-line CLV is the bedrock of Path P evaluation. Right now we capture closing line for a tiny fraction of bets. Expanding here would:
- Improve CLV calibration
- Surface more Path P scopes as eligible for graduation
- Reduce false negatives in the Pinnacle filter

Specifically, the `fetchAndStoreClosingLineForPendingBets` cron runs every 30 min. If we expand its lookback window from "next 90 minutes" to "next 4 hours", we'd capture closing prices for more bets without exceeding P3 budget.

**Effort: 30 min (config change + monitoring). Cost: ~5,000-10,000 calls/month.**

---

## 5. Recommended sequencing & total cost

| Phase | What | API cost / month | Engineering effort | Path P / Path S value |
|---|---|---|---|---|
| A1 | Diagnose+fix BTTS/DC/OU_45 silent failure | 0 | 2 hr | Adds 3 markets × 110 leagues |
| A2 | Add ASIAN_HANDICAP capture | 0 | 4 hr | **Largest single uplift — unlocks ~1,400 pending bets for Path P** |
| B  | Add OU_15, TEAM_TOTAL, FH_*, CARDS | 0 | 1-2 days | Doubles supported markets |
| C1 | Add 50 Tier-B leagues | +37k | 1 day | Expands universe ~50% |
| D  | P3 expanded closing-line capture | +7k | 30 min | Better CLV calibration |
| C2 | Add Tier-C leagues per demand | +30-40k | per cohort, ½ day | Expands universe ~100% |

**Total estimated API monthly usage at full expansion: ~90-95k of 100k cap.**
**Total engineering effort: ~5-7 days across all phases.**

---

## 6. Decisions required from Chris

1. **Approve Phase A (A1+A2) immediately?** Highest leverage per hour. Zero API cost. Unlocks ASIAN_HANDICAP for Path P which is currently the largest blocked-bet category.
2. **Approve Phase B (deeper market support)?** Slightly more engineering but no API cost.
3. **Approve Phase C1 (Tier B league expansion)?** First incremental API spend. ~37k/month additional.
4. **Approve Phase D (P3 closing-line widening)?** Small change, huge CLV value. ~7k/month additional.
5. **Hold Phase C2 until we see how A+B+C1 perform?** I lean yes — let the gate evaluation produce signal before expanding further.

I'll wait for direction before implementing any of A–D.

---

## 7. Side-finding worth flagging

The `oddspapi_pinnacle` source returns 0 rows for BTTS, DOUBLE_CHANCE, and OVER_UNDER_45 despite these being in `PREFETCH_TARGETS` for over 3 weeks. **Nobody noticed.** The new `data_quality_alerts` monitor (just shipped) tracks volumes by source but not by (source × market) — it only detects total source collapse, not partial-market silent failures.

Worth adding `(source, market_type)` granularity to the data-quality monitor in a follow-up. Backlog item; not urgent given Phase A1 will manually confirm.
