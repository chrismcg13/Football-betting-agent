# CLV / Pinnacle Coverage — Scope v3 (LOCKED)

**Status:** Architecturally locked 2026-04-19. Supersedes v1/v2.

---

## 1. Locked architectural decisions

### 1.1 Pinnacle is the SOLE CLV benchmark
- CLV (Closing Line Value) is defined exclusively against the Pinnacle closing price.
- `SHARP_SLUGS` (Sbobet, Singbet, Betfair Exchange) **must not** be used in CLV calculation, CLV reporting, or CLV-derived metrics.
- Rationale: Pinnacle is the only operationally independent sharp benchmark. Betfair Exchange is our execution venue — using it as a benchmark is partially circular. Sbobet/Singbet may correlate with Pinnacle but lack the methodological independence required for an honest CLV signal.
- `SHARP_SLUGS` may continue to be used for non-CLV purposes (price discovery, line-shopping, model features).

### 1.2 No surrogate union for coverage metrics
- "Pinnacle coverage" means literal `source ILIKE '%pinnacle%'` in `odds_snapshots` (i.e. `api_football_real:Pinnacle` or `oddspapi_pinnacle`). Nothing else counts.

### 1.3 Matches without Pinnacle pricing are out-of-universe
- If we cannot validate CLV against a genuine Pinnacle line, we do not bet the match.
- The agent's selection criteria must enforce this. The current gap (see §3) is a selection-criteria bug, not a coverage bug.

---

## 2. Two-metric dashboard split

The single conflated "75% Pinnacle coverage" target is killed. Replaced by two distinct metrics:

| Metric | Formula | Today | Target | Meaning |
|---|---|---|---|---|
| **In-league Pinnacle coverage** (quality) | matches w/ Pinnacle data ÷ matches in Pinnacle-flagged leagues | 345 / 422 = **81.7%** | ≥ 90% | How well we ingest data for leagues we've decided are in-universe. Driven by `oddsPapi.ts` + `apiFootball.ts` ingestion. |
| **Universe coverage** (scope) | matches in Pinnacle-flagged leagues ÷ all upcoming matches | 422 / 1,160 = **36.4%** | (no fixed target) | How much of the calendar we have decided is bet-eligible. Driven by `competition_config.has_pinnacle_odds` whitelist. |

### Dashboard spec (`/api/dashboard/pinnacle-coverage`)

```jsonc
{
  "window": "upcoming_7d",
  "asOf": "2026-04-19T16:00:00Z",
  "inLeagueCoverage": {
    "matchesInPinnacleLeagues": 422,
    "matchesWithPinnacleData": 345,
    "byAfPinnacle": 288,
    "byOddsPapiPinnacle": 110,
    "overlap": 53,
    "coveragePct": 81.7,
    "target": 90.0,
    "missingMatches": 77         // matches in Pin leagues but no Pinnacle data — the actionable gap
  },
  "universeCoverage": {
    "totalUpcoming": 1160,
    "matchesInPinnacleLeagues": 422,
    "outOfUniverseMatches": 738,
    "scopePct": 36.4
  },
  "clvBenchmark": {
    "source": "pinnacle_only",
    "surrogatesAllowed": false,
    "lockedAt": "2026-04-19"
  }
}
```

**Dashboard UI changes required:**
- Replace the single "Pinnacle coverage" tile with two tiles: "In-league coverage" (the headline number, large) and "Universe scope" (smaller, contextual).
- Add a "Missing data — actionable" panel listing the 77 in-league matches without Pinnacle data, sorted by kickoff.
- Add a "Out-of-universe" badge to any match in the bet feed whose league is not Pinnacle-flagged.

---

## 3. Selection-criteria audit (last 30 days)

| | Bets | Stake (£) | % of stake |
|---|---:|---:|---:|
| Total live bets (paper_bets) | 671 | 19,125.55 | 100% |
| In Pinnacle-flagged leagues | 439 | 11,559.27 | 60.4% |
| **In NON-Pinnacle leagues** | **232** | **7,566.28** | **39.6%** |
| With CLV data captured | 113 (16.8%) | — | — |
| Non-Pinnacle league bets that DID get CLV | 34 | — | (mis-flagged leagues — see §4) |

**Verdict: SELECTION-CRITERIA BUG.** ~40% of stake in the last 30 days is in leagues we cannot validate against Pinnacle. This must be fixed before further coverage work.

### Top non-Pinnacle leagues we have been betting in (30d)

| League | Bets | Stake (£) | Action |
|---|---:|---:|---|
| Serie B | 71 | 1,862.55 | **Verify & whitelist** (Italy Serie B — see §4) |
| Liga Profesional Argentina | 49 | 1,802.17 | **Verify & whitelist** |
| Primera División | 43 | 1,314.59 | **Verify & whitelist (disambiguate country!)** |
| League Two | 29 | 1,005.29 | **Verify & whitelist** (England) |
| Primera A | 22 | 819.21 | Verify (Colombia) |
| USL Championship | 10 | 473.51 | **Verify & whitelist** |
| 1. Division | 7 | 239.63 | Verify (Denmark/Norway disambiguation) |
| National League - North | 1 | 49.33 | Defer — too low stake |

These eight leagues account for the entire 232-bet / £7,566 non-Pinnacle exposure.

---

## 4. League whitelist verification list

**Methodology:** A league qualifies for `has_pinnacle_odds=true` only if there is hard evidence in the last 30 days that Pinnacle priced the relevant markets. Evidence source: `odds_snapshots` rows where `source ILIKE '%pinnacle%'` (covers both `api_football_real:Pinnacle` and `oddspapi_pinnacle`). For each candidate I report the distinct match count, distinct market types Pinnacle priced, and current upcoming-7d match count.

### Tier A — STRONG evidence (10+ market types, including Asian Handicap & corners)

| League | Pin-priced matches (30d) | Upcoming 7d | Markets priced | Flag? |
|---|---:|---:|---|---|
| Primera División ⚠️ | 26 | 17 | 12 (MO, AH, FH, O/U 0.5–4.5, corners 7.5–10.5) | **YES — but disambiguate country** |
| Serie B ⚠️ | 25 | 14 | 11 | **YES — but disambiguate country** |
| 1. Division ⚠️ | 23 | 11 | 12 | **YES — but disambiguate country** |
| Liga Profesional Argentina | 23 | 19 | 11 | **YES** |
| League Two | 16 | 0 | 12 | YES (no upcoming this week, but recurring) |
| USL Championship | 3 | 3 | 11 | **YES** |

### Tier B — MODERATE evidence (3–5 market types: MO + O/U + corners)

| League | Pin-priced matches (30d) | Upcoming 7d | Markets | Flag? |
|---|---:|---:|---|---|
| J2/J3 League | 20 | 0 | MO, O/U 2.5, O/U 3.5 | YES (limited markets) |
| Primera Nacional | 18 | 13 | MO, O/U 2.5/3.5, corners 9.5 | YES |
| National 1 | 15 | 8 | MO, O/U 2.5/3.5, corners 9.5/10.5 | YES |
| 1. Lig | 14 | 0 | MO, O/U 2.5/3.5, corners 9.5/10.5 | YES |
| National League - South | 12 | 0 | MO, O/U 2.5/3.5, corners 9.5/10.5 | YES |
| Czech Liga | 11 | 4 | MO, O/U 2.5/3.5, corners 9.5/10.5 | YES |
| Primera B | 11 | 2 | MO, O/U 2.5/3.5, corners 9.5 | YES |
| 2. Liga | 6 | 1 | MO, O/U 2.5/3.5, corners 9.5/10.5 | YES |
| Challenge League | 5 | 2 | MO, O/U 2.5/3.5, corners 9.5/10.5 | YES |
| FA Cup | 4 | 1 | MO, O/U 2.5/3.5, corners 9.5/10.5 | YES |
| Premiership ⚠️ | 3 | 3 | MO, O/U 2.5, O/U 3.5 | DEFER (Scotland vs N.I. ambiguity, MO-only insufficient for our O/U strategies) |
| Pro League ⚠️ | 3 | 3 | MO, O/U 2.5, O/U 3.5 | DEFER (Belgium vs Saudi ambiguity) |

### Tier C — MARGINAL evidence (1–3 matches, MO-only or near MO-only) — DEFER

DFB Pokal, Coupe de France, Copa del Rey, FA WSL, NWSL Women, 1 Lyga, UEFA Youth League, 3. Division - Girone 4. Insufficient evidence to flag.

### ⚠️ CRITICAL DATA-QUALITY ISSUE: country disambiguation

The `matches.league` column is just a text label (no country qualifier). Several league names exist in multiple countries:
- **"Primera División"** — Spain, Argentina, Chile, Colombia, Uruguay, Paraguay, Peru, Venezuela, Costa Rica…
- **"Serie B"** — Italy, Brazil, Ecuador…
- **"1. Division"** — Denmark, Norway, Faroe Islands…
- **"Premiership"** — Scotland, Northern Ireland, England (rugby)…
- **"Pro League"** — Belgium, Saudi Arabia, UAE…

`competition_config` is keyed on `(api_football_id, name, country)`. Flipping `has_pinnacle_odds=true` by `name` alone would incorrectly enable lower divisions Pinnacle does not price. Before any flag flip, we need either:

(a) A migration that adds `matches.country` and joins on `(name, country)`, OR
(b) A lookup that flips by `api_football_id` directly per league row in `competition_config`.

**Recommended:** option (b). I will draft a per-(api_football_id) flip list for each of the verified leagues above for your review before any DB write.

---

## 5. SHARP_SLUGS confirmation (locked)

> **CONFIRMED IN WRITING:** `SHARP_SLUGS` (Sbobet, Singbet, Betfair Exchange) will NOT be used in any CLV calculation, CLV report, CLV-derived performance metric, or coverage-quality metric. Pinnacle is the sole CLV benchmark. This is locked in scope v3 and may not be relitigated without an explicit scope v4 decision document.

Files that must never reference SHARP_SLUGS for CLV purposes (audit list — verification pending):
- `artifacts/api-server/src/services/oddsPapi.ts` (CLV functions: `backfillPinnacleUnified`, `derivePinnacleDCFromMatchOdds`, `fetchPreKickoffSnapshots`)
- `artifacts/api-server/src/services/scheduler.ts` (CLV settlement path)
- `artifacts/api-server/src/routes/api.ts` (`/api/dashboard/pinnacle-coverage`, funnel report endpoints)

---

## 6. What happens next (awaiting user approval)

**No code or DB changes will be made until you approve the per-(api_football_id) flip list.** When approved, the work is:

1. Generate per-`api_football_id` flip list (one row per league × country combination from §4 Tier A + B).
2. Apply via `UPDATE competition_config SET has_pinnacle_odds=true WHERE api_football_id IN (...)`.
3. Trigger one bulk-prefetch + one rescue-mapping pass to ingest the newly-eligible matches.
4. Re-measure the two-metric split. Expected outcome: in-league coverage holds ≥ 80%; universe coverage rises from 36% → ~50–55%.
5. Tighten selection criteria so any match outside Pinnacle-flagged leagues is rejected at filter time, eliminating the 39.6% non-Pinnacle stake leak.
6. Update dashboard UI per §2 spec.
7. Audit the three files in §5 to confirm SHARP_SLUGS is not used in any CLV path.
