# CLV / Pinnacle Coverage — Scope v3 (LOCKED)

**Status:** Architecturally locked 2026-04-19. Supersedes v1/v2.
**Revision:** 2026-04-19 16:30 UTC — corrected in-league coverage figure (was wrongly stated as 81.7% union; true intersection is 53.6%); reordered §6 with selection-filter as step 1; added realistic uplift forecast; completed §5 SHARP_SLUGS audit (CLEAN — no remediation needed); added §7 CLV capture rate sub-report.

---

## 1. Locked architectural decisions

### 1.1 Pinnacle is the SOLE CLV benchmark
- CLV (Closing Line Value) is defined exclusively against the Pinnacle closing price.
- `SHARP_SLUGS` (Sbobet, Singbet, Betfair Exchange, Pinnacle) **must not** be used as a union/surrogate in CLV calculation, CLV reporting, or CLV-derived metrics. Pinnacle is extracted by its own dedicated slug check, separate from the SHARP_SLUGS aggregation.
- Rationale: Pinnacle is the only operationally independent sharp benchmark. Betfair Exchange is our execution venue — using it as a benchmark is partially circular. Sbobet/Singbet may correlate but lack the methodological independence required for an honest CLV signal.
- `SHARP_SLUGS` may continue to be used for non-CLV purposes (sharp/soft spread, model features, line-shopping diagnostics).

### 1.2 No surrogate union for coverage metrics
- "Pinnacle coverage" means literal `source ILIKE '%pinnacle%'` in `odds_snapshots` (i.e. `api_football_real:Pinnacle` or `oddspapi_pinnacle`). Nothing else counts.

### 1.3 Matches without Pinnacle pricing are out-of-universe
- If we cannot validate CLV against a genuine Pinnacle line, we do not bet the match.
- The agent's selection criteria must enforce this. The current 39.6%-of-stake leak (§3) is a selection-criteria bug.

---

## 2. Two-metric dashboard split

The single conflated "75% Pinnacle coverage" target is killed. Replaced by two distinct metrics. **Both are intersection counts, not union.**

| Metric | Formula | Today | Target | Meaning |
|---|---|---|---|---|
| **In-league Pinnacle coverage** (quality) | matches in Pin-flagged leagues that have Pinnacle data ÷ matches in Pin-flagged leagues | **226 / 422 = 53.6%** | ≥ 80% | How well we ingest data for leagues we've decided are in-universe. Driven by `oddsPapi.ts` + `apiFootball.ts` ingestion. |
| **Universe coverage** (scope) | matches in Pin-flagged leagues ÷ all upcoming matches | **422 / 1,161 = 36.4%** | (no fixed target) | How much of the calendar we have decided is bet-eligible. Driven by `competition_config.has_pinnacle_odds` whitelist. |

**Auxiliary diagnostics (not headline):**
- 124 upcoming matches have Pinnacle data but their league is NOT flagged → these are Pinnacle pricing leagues we haven't recognised yet (whitelist-expansion candidates).
- 350 upcoming matches have Pinnacle data overall (the union number, which I previously misreported as in-league coverage).

### Dashboard spec (`/api/dashboard/pinnacle-coverage`)

```jsonc
{
  "window": "upcoming_7d",
  "asOf": "2026-04-19T16:30:00Z",
  "inLeagueCoverage": {
    "matchesInPinnacleLeagues": 422,
    "matchesInPinnacleLeaguesWithPinData": 226,
    "coveragePct": 53.6,
    "target": 80.0,
    "actionableGap": 196              // in-league matches missing Pinnacle data
  },
  "universeCoverage": {
    "totalUpcoming": 1161,
    "matchesInPinnacleLeagues": 422,
    "outOfUniverseMatches": 739,
    "scopePct": 36.4
  },
  "expansionCandidates": {
    "matchesWithPinDataInUnflaggedLeagues": 124,
    "candidateLeagueCount": 16        // see §4
  },
  "clvBenchmark": {
    "source": "pinnacle_only",
    "surrogatesAllowed": false,
    "lockedAt": "2026-04-19"
  }
}
```

**Dashboard UI changes required:**
- Replace the single "Pinnacle coverage" tile with two tiles: "In-league coverage" (headline, large) and "Universe scope" (smaller, contextual).
- Add a "Missing data — actionable" panel listing the 196 in-league matches without Pinnacle data, sorted by kickoff.
- Add an "Out-of-universe" badge to any match in the bet feed whose league is not Pinnacle-flagged.
- Add an "Expansion candidates" tile showing the 124 unflagged-league matches with Pin data (work queue for §4 review).

---

## 3. Selection-criteria audit (last 30 days)

| | Bets | Stake (£) | % of stake |
|---|---:|---:|---:|
| Total live bets (paper_bets) | 671 | 19,125.55 | 100% |
| In Pinnacle-flagged leagues | 439 | 11,559.27 | 60.4% |
| **In NON-Pinnacle leagues** | **232** | **7,566.28** | **39.6%** |

**Verdict: SELECTION-CRITERIA BUG.** ~40% of stake in the last 30 days is in leagues we cannot validate against Pinnacle. This must be fixed *before* further coverage work (§6 step 1).

### Top non-Pinnacle leagues we have been betting in (30d)

| League | Bets | Stake (£) |
|---|---:|---:|
| Serie B | 71 | 1,862.55 |
| Liga Profesional Argentina | 49 | 1,802.17 |
| Primera División | 43 | 1,314.59 |
| League Two | 29 | 1,005.29 |
| Primera A | 22 | 819.21 |
| USL Championship | 10 | 473.51 |
| 1. Division | 7 | 239.63 |
| National League - North | 1 | 49.33 |

These eight leagues account for the entire 232-bet / £7,566 non-Pinnacle exposure.

---

## 4. League whitelist verification list (Tier A + B)

**Methodology:** A league qualifies for `has_pinnacle_odds=true` only if there is hard evidence in the last 30 days that Pinnacle priced the relevant markets. Evidence: `odds_snapshots` rows where `source ILIKE '%pinnacle%'`.

### Tier A — STRONG evidence (10+ market types incl. Asian Handicap & corners)

| League | Country | Pin-priced 30d | Upcoming 7d | Markets priced |
|---|---|---:|---:|---|
| Primera División | (multi — see disambiguation below) | 26 | 49 | MO, AH, FH, O/U 0.5–4.5, corners 7.5–10.5 |
| Serie B | (multi) | 25 | 27 | MO, AH, FH, O/U 0.5–4.5, corners 8.5–10.5 |
| 1. Division | (multi) | 23 | 24 | 12 markets (full depth) |
| Liga Profesional Argentina | Argentina | 23 | 28 | 11 markets |
| League Two | (multi) | 16 | 33 | 12 markets |
| USL Championship | USA | 3 | 4 | 11 markets |

### Tier B — MODERATE evidence (3–5 markets: MO + O/U + sometimes corners)

| League | Country | Pin-priced 30d | Upcoming 7d | Markets |
|---|---|---:|---:|---|
| Primera Nacional | Argentina | 18 | 30 | MO, O/U 2.5/3.5, corners 9.5 |
| J2/J3 League | Japan | 20 | 20 | MO, O/U 2.5/3.5 |
| Czech Liga | Czech Republic | 11 | 10 | MO, O/U 2.5/3.5, corners 9.5/10.5 |
| 1. Lig | Turkey | 14 | 10 | MO, O/U 2.5/3.5, corners 9.5/10.5 |
| National 1 | France | 15 | 9 | MO, O/U 2.5/3.5, corners 9.5/10.5 |
| 2. Liga | Austria | 6 | 8 | MO, O/U 2.5/3.5, corners 9.5/10.5 |
| Primera B | Chile | 11 | 7 | MO, O/U 2.5/3.5, corners 9.5 |
| Challenge League | Switzerland | 5 | 7 | MO, O/U 2.5/3.5, corners 9.5/10.5 |
| National League - South | England | 12 | 12 | MO, O/U 2.5/3.5, corners 9.5/10.5 |
| FA Cup | England | 4 | 2 | MO, O/U 2.5/3.5, corners 9.5/10.5 |

### Country disambiguation (live data)

For ambiguous league names, the actual `(league, country)` pairs in upcoming-7d matches are:

| League name | Countries seen | Recommendation |
|---|---|---|
| Primera División | Peru (14), Venezuela (13), Bolivia (12), Chile (10) | **Flag all four**: Peru/Venezuela/Chile have direct Pin evidence (5–6 priced matches each), Bolivia has 0 matches priced — defer Bolivia until evidence appears |
| Serie B | Brazil (15), Italy (12) | Flag both — both have 6+ priced matches |
| 1. Division | Denmark (15), Norway (9) | Flag both — Denmark 9/15, Norway 2/9 both have evidence |
| League Two | England (16), China (12), Scotland (5) | **Flag England only** — China and Scotland have 0/12 and 0/5 Pin matches; defer pending evidence |

### Tier B – DEFER (country ambiguity + thin markets)

- **Premiership** (Scotland 3 / N. Ireland) — only 3 priced matches, MO + O/U only, country disambiguation needed
- **Pro League** (Belgium / Saudi Arabia) — only 3 priced matches, country disambiguation needed

### Tier C – DEFER (sparse evidence)

DFB Pokal, Coupe de France, Copa del Rey, FA WSL, NWSL Women, 1 Lyga, UEFA Youth League, 3. Division - Girone 4. All 1–3 priced matches with MO-only.

---

## 5. SHARP_SLUGS audit (COMPLETED)

> **CONFIRMED IN WRITING:** `SHARP_SLUGS` (Sbobet, Singbet, Betfair Exchange, Pinnacle) will NOT be used in any CLV calculation, CLV report, CLV-derived performance metric, or coverage-quality metric. Pinnacle is the sole CLV benchmark. This is locked in scope v3 and may not be relitigated without an explicit scope v4 decision document.

### Audit findings (executed 2026-04-19)

Grepped `SHARP_SLUGS` across `artifacts/api-server/src/`. Three references found, all in `oddsPapi.ts`:

| File:Line | Function | Purpose | CLV-touching? |
|---|---|---|---|
| `oddsPapi.ts:151` | (definition) | `const SHARP_SLUGS = new Set(["pinnacle","singbet","sbobet","pinnaclesports"])` | N/A |
| `oddsPapi.ts:2100` | `getOddspapiValidation` (line 2030) | Aggregates implied probabilities into `sharpOddsArr` for the `sharpSoftSpread` diagnostic | **NO** — Pinnacle odds are extracted separately and returned as `pinnacleOdds`/`pinnacleImplied` fields. The sharp/soft spread is a separate model feature, never written to `closing_pinnacle_odds`. |
| `oddsPapi.ts:2363` | `prefetchAndStoreOddsPapiOdds` (line 2192) | Aggregates `so.sharp.push(implied)` for sharp-vs-soft diagnostic stored alongside snapshots | **NO** — at line 2361 `if (slug.includes("pinnacle")) so.pinnacle = odds;` is the dedicated extraction that becomes `oddspapi_pinnacle` source rows. SHARP_SLUGS aggregation is independent. |

`scheduler.ts`: zero SHARP_SLUGS references.
`routes/api.ts`: zero SHARP_SLUGS references.

**CLV path verified clean.** CLV is computed exclusively from `paper_bets.closing_pinnacle_odds`, populated by:
- `fetchPreKickoffSnapshots` (line 3279)
- `backfillPinnacleUnified` (line 3141)
- `derivePinnacleDCFromMatchOdds` (line 2970)
- `backfillPinnacleOnPendingBets` (line 2892)
- `buildPinnacleValidationFromApiFootball` (line 2780)
- `fetchAndStoreClosingLineForPendingBets` (line 2630)

None of the above reference `SHARP_SLUGS`. **No code remediation required.** The architectural decision is already implemented; this audit confirms compliance.

---

## 6. Execution plan (REORDERED — selection-filter first)

**No code or DB changes will be made until you approve the per-(api_football_id) flip list in §8.**

| # | Step | Why |
|---|---|---|
| **1** | **Plug the leak first.** Modify the strategy filter (`scheduler.ts` ~ line 821) to reject any candidate match whose league is not in `competition_config WHERE has_pinnacle_odds=true`. No exceptions, no overrides. Add a `funnel_reason='non_pinnacle_league'` row to filtered_bets for visibility. | Kills the £7,566 / 39.6% non-Pinnacle stake leak immediately. Does not depend on whitelist expansion. |
| 2 | Generate `competition_config` flip list per `(api_football_id, name, country)` for Tier A + B leagues from §4 + §8. Includes INSERTs for leagues currently missing from cc (see §8 caveat). | Whitelist expansion. |
| 3 | Apply approved flip list (single `UPDATE`/`INSERT` transaction). | One-shot. |
| 4 | Trigger one `runDedicatedBulkPrefetch(7, 15000)` + one `rescueUnmappedPinnacleFixtures()` pass to ingest the newly-eligible matches. | Catch up data ingestion for the freshly-flagged universe. |
| 5 | Re-measure two-metric split. **See §6.1 for realistic forecast.** | Verify uplift. |
| 6 | Update dashboard UI per §2 spec. | Visibility. |

### 6.1 Realistic uplift forecast (Tier A + B with non-zero upcoming-7d only)

Sum of upcoming-7d matches across all 16 candidate leagues = **280**. Of those, **95** already have Pinnacle data ingested (subset of the 124 out-of-flagged matches with data).

| Metric | Now | Immediately post-flip (before re-ingestion) | Steady-state after re-ingestion |
|---|---:|---:|---:|
| **Universe coverage** | 422 / 1,161 = **36.4%** | 702 / 1,161 = **60.5%** | 60.5% (set by league flip alone — does not change with ingestion) |
| **In-league coverage** | 226 / 422 = **53.6%** | 321 / 702 = **45.7%** (drops because new leagues outpace current data) | ~75–80% if ingestion catches up to evidence baseline |
| **Bet-feed eligibility** | 422 matches | 702 matches (+66%) | 702 matches |

**Honest read:** universe coverage uplift is real (+24 pp) and arithmetic-certain. In-league coverage will *drop* immediately because we're adding 280 matches of which only 95 have data. The drop is recoverable by re-running ingestion (evidence shows Pinnacle does price these leagues), and steady-state should land at ~75–80% in-league coverage in 24–48h.

**No realistic plan reaches 80%+ in-league coverage in the same hour as the flip.** This is unavoidable.

---

## 7. CLV capture rate sub-report (separate, non-blocking)

The 16.8% capture rate quoted in §3 is misleading because it includes failed-to-place and pending bets. Real Pinnacle-flagged-league CLV capture:

| Status | Bets | Got CLV | Capture rate |
|---|---:|---:|---:|
| Total Pin-league bets (30d) | 439 | 79 | 18.0% |
| `placement_failed` | 139 | 0 | 0% (never placed → no CLV by design) |
| `pending_placement` | 4 | 0 | 0% |
| `pending` | 68 | 12 | 17.6% (CLV captured pre-kickoff but not yet settled — normal) |
| `won` | 85 | 39 | **45.9%** ← real settled CLV capture |
| `lost` | 95 | 27 | **28.4%** ← real settled CLV capture |
| `void` | 48 | 1 | 2.1% (voids typically miss CLV — kickoff cancelled) |

**Settled-and-placed bets only (won+lost): 66/180 = 36.7% CLV capture.**

**Failure modes on the missing 64% of settled bets:**

Settled Pinnacle-flagged-league bets WITHOUT CLV, by market type:
- OVER_UNDER_25: 125 missing
- BTTS: 48
- FIRST_HALF_RESULT: 47
- DOUBLE_CHANCE: 27
- TOTAL_CARDS_25: 24
- OVER_UNDER_35: 21
- MATCH_ODDS: 9
- TOTAL_CARDS_35: 3

**Implication for the +2.88% CLV figure:**

Your +2.88% CLV is computed on a sample of 79 bets (heavily weighted toward MATCH_ODDS and OVER_UNDER_25 where capture is best). It is NOT representative of the full bet population. Specifically:
- BTTS, DOUBLE_CHANCE, FIRST_HALF_RESULT, TOTAL_CARDS markets are systematically under-sampled in CLV capture (likely because `derivePinnacleDCFromMatchOdds` only handles double-chance derivation; other markets need direct Pinnacle pricing which OddsPapi/AF doesn't always provide for these markets).
- The 45.9% capture on `won` bets vs 28.4% on `lost` bets is a 17pp gap — possible **survivorship bias** in CLV measurement (winners disproportionately have CLV captured because they're disproportionately in markets we have good Pinnacle coverage for, e.g. MO).

**Recommendation (non-blocking):** treat the +2.88% CLV figure as directionally positive but not statistically representative until per-market capture is balanced. Add `clv_data_quality` filter to CLV reporting; report CLV per-market separately rather than aggregate.

---

## 8. Per-(api_football_id) flip list — for approval

**ACTION:** Each row below is either an `UPDATE` of an existing `competition_config` row or an `INSERT` of a missing row. **Nothing will be applied without your explicit greenlight.**

### 8.1 UPDATE (rows already exist in competition_config)

| api_football_id | name | country | current has_pinnacle_odds | Tier | Action |
|---:|---|---|:---:|:---:|---|
| 136 | Serie B | Italy | false | A | SET true |
| 219 | 2. Liga | Austria | false | B | SET true |
| 204 | 1. Lig | Turkey | false | B | SET true |
| 63 | National 1 | France | false | B | SET true |
| 45 | FA Cup | England | false | B | SET true |
| 255 | USL Championship | USA | false | A | SET true |
| 265 | Primera División | Chile | false | A | SET true |
| 266 | Primera B | Chile | false | B | SET true |
| 299 | Primera División | Venezuela | false | A | SET true |

### 8.2 ⚠️ MISSING from competition_config — INSERT required

The following `(name, country)` pairs have upcoming-7d matches AND Pinnacle pricing evidence but have NO row in `competition_config`. Either (a) they were never discovered by `leagueDiscovery.ts`, or (b) they were discovered under a different `country` spelling. **I am not proposing INSERT values without you confirming the api_football_id source** — these need to be looked up from the API-Football `/leagues` endpoint before INSERT.

| name | country | upcoming-7d | Pin-priced 7d | Tier | Action needed |
|---|---|---:|---:|:---:|---|
| Liga Profesional Argentina | Argentina | 28 | 19 | A | Lookup AF league_id, INSERT row, SET pin=true |
| Primera Nacional | Argentina | 30 | 13 | B | Lookup AF league_id, INSERT |
| League Two | England | 16 | 0 | A | Lookup AF league_id, INSERT (despite 0 priced — Tier A evidence base from 30d=16) |
| 1. Division | Denmark | 15 | 9 | A | Lookup AF league_id, INSERT |
| 1. Division | Norway | 9 | 2 | A | Lookup AF league_id, INSERT |
| Serie B | Brazil | 15 | 8 | A | Lookup AF league_id, INSERT |
| Primera División | Peru | 14 | 6 | A | Lookup AF league_id, INSERT |
| J2/J3 League | Japan | 20 | 0 | B | Lookup AF league_id, INSERT (30d=20 Pin-priced, 0 in upcoming likely calendar gap) |
| Czech Liga | Czech Republic | 10 | 4 | B | Lookup AF league_id, INSERT |
| Challenge League | Switzerland | 7 | 2 | B | Lookup AF league_id, INSERT |
| National League - South | England | 12 | 0 | B | Lookup AF league_id, INSERT |

### 8.3 EXPLICITLY DEFERRED (per §4)

| name | country | Reason |
|---|---|---|
| Primera División | Bolivia | 0/12 Pin-priced this week, no evidence |
| League Two | China | 0/12 Pin-priced, no evidence |
| League Two | Scotland | 0/5 Pin-priced, no evidence |
| Premiership | Scotland/N.Ireland | Only 3 matches, MO-only, country ambiguity |
| Pro League | Belgium/Saudi | Only 3 matches, country ambiguity |
| (all Tier C) | various | Sparse evidence |

---

## 9. Awaiting greenlight

Two approvals needed from you before any DB write:

1. **§6 step 1** — confirm I should modify `scheduler.ts` filter to reject non-Pinnacle-league candidates (the leak fix). This is independent of whitelist expansion and can ship first.
2. **§8.1 + §8.2** — confirm the flip list, including authorisation to look up missing `api_football_id`s via `/leagues` and INSERT new rows into `competition_config`.
