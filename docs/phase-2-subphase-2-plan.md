# Sub-phase 2 — Betfair-first Universe Expansion (PLAN)

**Status:** PLAN-MODE DOCUMENT. **No code lands from this document.** User reviews; implementation begins when explicitly approved.

**Authored:** 2026-05-05.
**Companion docs:** `phase-2-current-state.md` (codebase audit), `phase-2-diagnostic-findings.md` (empirical inputs), `archetype-labelling-rules.md` (locked cascade), `real-money-go-live-checklist.md` (safety boundary contract).
**Predecessors:** Phase 2.A (commits `37aca11`, `9d5db0d`, `786dd46`) shipped schema + dispatcher + shadow-stake. R6 + R6.1 (commits `29e8396`, `51ae339`) sealed CLV provenance.

---

## 0. Goal

Land an exhaustive, repeatable mechanism that maps every Betfair-tradeable football competition into `competition_config` with a correct `universe_tier`, applies archetype labels to every row (existing + new), and pre-flags Primera División for Tier D demotion before behaviour flips on.

**The brief's exact requirements (parsed):**

> (a) Pull every Betfair football competition.
> (b) Forward-map to API-Football's full ~1200 league universe. Where API-Football has a league not in `competition_config`, ADD it with appropriate `universe_tier`.
> (c) Settlement-bias check at universe-redefinition time using sub-phase 1's findings. Leagues with |B| ≥ 0.10 route to Tier D. Leagues with no historical bets defer the bias test and admit at Tier C until 30 bets accumulate.
> (d) Insert-only / non-destructive on existing rows.
> (e) Dry-run gate (`BETFAIR_REVERSE_MAPPING_DRY_RUN=true` default).
> (f) Cron at `0 7 * * *` UTC.
> (g) Algorithm: token-set ratio at 0.85, country tie-breaker, longest-active row tie-breaker.

---

## 1. Inputs locked from sub-phase 1 (NOT REVISITED HERE)

Pinned in earlier session. Do not re-debate.

| Decision | Source | Value |
|---|---|---|
| Tier A starting count (canary baseline) | `phase-2-diagnostic-findings.md` §6.4 | **149** |
| Tier B starting count | `phase-2-diagnostic-findings.md` §6.4 | **84** |
| Tier C / D starting count | `phase-2-diagnostic-findings.md` §6.4 | **0 / 0** |
| Tier E starting count (untouched by sub-phase 2) | `phase-2-diagnostic-findings.md` §6.4 | **804** |
| Fuzzy match algorithm | brief + `feedback_specify_algorithms.md` | **token-set ratio at 0.85, country pre-filter, longest-active tie-breaker** |
| Archetype rules | `archetype-labelling-rules.md` | **6-archetype set, 7-rule cascade — verbatim implementation** |
| Primera División demotion | `phase-2-diagnostic-findings.md` §10.3 | **Tier A → D, settlement_bias_index = -0.524** |
| Cron slot | brief | **`0 7 * * *` UTC** (no clash; v2 §2.3) |
| Dry-run flag default | brief | **`BETFAIR_REVERSE_MAPPING_DRY_RUN = 'true'`** |
| Two-commit discipline | `feedback_race_conditions.md` | **code-deploy → DML → behaviour-flip** |

---

## 2. Goal in mechanism terms

The cron's per-run flow:

```
1. Fetch full Betfair soccer competition list (one API call).
2. Fetch full API-Football league universe (one API call, cache for run).
3. For each Betfair competition:
     a. Map competitionRegion → AF country.
     b. Filter AF universe to candidates in same country.
     c. Score each candidate via tokenSetRatio(bf.name, af.name).
     d. Best score ≥ 0.85 wins. Ties broken by longest-active.
     e. If matched:
          - If AF league exists in competition_config: non-destructive update of betfair_competition_id + archetype.
          - If AF league NOT in competition_config: INSERT new row with full AF metadata.
     f. If unmatched: INSERT Tier D row (Betfair-only, api_football_id=NULL).
4. Apply archetype labelling pass over every row in competition_config.
5. Apply Pinnacle-reliability tier verdict (A/B/C) for matched rows.
6. (Behaviour-flip on, deferred): apply settlement-bias routing (|B|≥0.10 → D).
7. Log per-tier counts + per-bucket telemetry.
```

Step 6 is **NOT** in commit 1's cron logic — it's a one-shot DML run between commit 1 and commit 2 (per §6 below). The cron itself does not run bias routing on first land; that DML lands once and is captured in subsequent cron runs via the existing `is_active` field.

---

## 3. Decisions pinned (no deferred-to-scoping)

### 3.1 Token-set ratio implementation (LOCKED)

```ts
function normaliseLeagueName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")    // strip diacritics
    .replace(/[^a-z0-9 ]/g, " ")        // punctuation → space
    .replace(/\s+/g, " ")               // collapse whitespace
    .trim();
}

function tokenSetRatio(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(normaliseLeagueName(s).split(" ").filter((t) => t.length > 0));
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersect = 0;
  for (const t of A) if (B.has(t)) intersect++;
  return intersect / Math.min(A.size, B.size);
}
```

**Threshold:** 0.85. **Pure-JS, no library.** ~25 lines including normaliser. Inline in `betfairFirstUniverse.ts`.

### 3.2 Country pre-filter (LOCKED)

Betfair's `competitionRegion` is sometimes a 2-letter code (`"GB"`, `"ES"`, `"FR"`), sometimes a full name (`"England"`, `"Spain"`), sometimes an "international" marker. AF's `competition_config.country` is full English names (`"England"`, `"Spain"`, `"France"`, `"World"`). Mapping table:

```ts
const BETFAIR_REGION_TO_AF_COUNTRY: Record<string, string> = {
  "GB":            "England",      // Betfair region "GB" ≈ England in our AF data
  "ENGLAND":       "England",
  "SCOTLAND":      "Scotland",
  "WALES":         "Wales",
  "NORTHERN IRELAND": "Northern Ireland",
  "ES":            "Spain",
  "SPAIN":         "Spain",
  "FR":            "France",
  "FRANCE":        "France",
  "DE":            "Germany",
  "GERMANY":       "Germany",
  "IT":            "Italy",
  "ITALY":         "Italy",
  "NL":            "Netherlands",
  "NETHERLANDS":   "Netherlands",
  "PT":            "Portugal",
  "PORTUGAL":      "Portugal",
  "BR":            "Brazil",
  "BRAZIL":        "Brazil",
  "AR":            "Argentina",
  "ARGENTINA":     "Argentina",
  "MX":            "Mexico",
  "MEXICO":        "Mexico",
  "US":            "USA",
  "USA":           "USA",
  // ... ~80 mappings total covering every region observed in Betfair listCompetitions
  "INTERNATIONAL": "World",
  "WORLD":         "World",
};
```

**Strategy for unmapped regions:** if a Betfair region isn't in the table, fall back to fuzzy matching across **all** AF rows (no country filter) but with a stricter threshold of **0.95**. Logged as `unmapped_region` in the funnel for follow-up table additions.

**The full mapping table** is generated during commit 1's implementation by enumerating distinct values returned from `listCompetitions("1")` against current AF country names; the implementation must include the SQL-side audit query that surfaces gaps.

### 3.3 Longest-active tie-breaker (LOCKED)

When two AF rows score equally and both ≥ 0.85, pick the one with:

1. Highest `last_polled_at` (most recently polled = active).
2. If tie: lowest `tier` (1 > 2 > 3).
3. If still tie: lowest `id` (deterministic — the row that's been there longest).

For NEW rows (no `competition_config` row yet), tie-break by AF league `current_season` (most recent = active).

### 3.4 Tier assignment rules (LOCKED — combines brief (c) with prior v2 design)

Apply in order; first match wins:

| Signal | Tier verdict |
|---|---|
| No AF match (Betfair competition not found in AF universe) | **D** |
| Settlement bias `|B| ≥ 0.10` (data from `phase-2-diagnostic-findings.md` §3.1) | **D** |
| Matched AF, `oddspapi_league_coverage.has_odds = 1`, `last_checked` within 14 days | **A** |
| Matched AF, `oddspapi_league_coverage.has_odds = 1`, `last_checked` ≥ 14 days | **C** (stale Pinnacle) |
| Matched AF, zero historical settled bets | **C** (probationary — bias test deferred per brief (c)) |
| Matched AF, `oddspapi_league_coverage.has_odds = 0` OR row absent | **B** (no Pinnacle) |

The Tier C "probationary new league" case re-tests at 30 settled bets — that's a **sub-phase 5 deliverable** (re-evaluation cron), NOT this sub-phase. For sub-phase 2, the rule is: insert at C, leave alone.

### 3.5 Insert-only / non-destructive contract (LOCKED — brief (d))

For an EXISTING row in `competition_config`, the cron may:

- **Set** `betfair_competition_id` if currently NULL.
- **Set** `archetype` if currently NULL.
- **Update** `last_polled_at` (cron-self-housekeeping).
- **Set** `universe_tier_decided_at` if currently NULL AND tier changes.

The cron may NOT:

- Change `universe_tier` from a non-`unmapped` value to a different non-`unmapped` value.
- Overwrite an existing `betfair_competition_id` that's already set.
- Overwrite an existing `archetype` that's already set.
- Change `is_active`, `tier`, `polling_frequency`, or any field outside the four above.

For NEW rows, the cron writes the full row with all fields populated.

**Demotion (e.g., A → D after a league loses Pinnacle) is OUT OF SCOPE for sub-phase 2.** A separate auto-demotion cron lands as sub-phase 10. Within sub-phase 2 the contract is strictly "non-destructive."

### 3.6 Archetype labelling pass (LOCKED — `archetype-labelling-rules.md`)

After the reverse-mapping pass, the cron runs an archetype labelling pass over **every row in `competition_config` where `archetype IS NULL`**. Uses the 7-rule cascade verbatim from `archetype-labelling-rules.md` §3.

This pass runs once on first deploy (catches the 1,037 currently-unlabelled rows). On subsequent runs, only newly-inserted rows need labelling — the pass is still O(N) with N ≈ 1,200 rows; trivial cost.

### 3.7 Dry-run gate (LOCKED — brief (e))

Read `BETFAIR_REVERSE_MAPPING_DRY_RUN` from environment. Default `'true'` if unset.

When `'true'`: the cron runs the full discovery + scoring + tier assignment, and **logs the diff that would be applied** — but does NOT execute any INSERT or UPDATE against `competition_config`. Output goes to a structured log entry plus a summary in the cron-execution row.

When `'false'`: the cron applies the writes.

Default at first deploy is `'true'`. User reviews 1-3 dry-run reports, then flips to `'false'` (commit B in §6).

### 3.8 Cron registration (LOCKED — brief (f))

```ts
cron.schedule("0 7 * * *", () => {
  void runBetfairReverseMapping().catch((err) =>
    logger.error({ err }, "Betfair reverse mapping cron failed"),
  );
}, { timezone: "UTC" });
```

Registered in `scheduler.ts` after the existing weekly Sunday-only crons. Slot `0 7 * * *` is empty per `phase-2-current-state.md` §3.

---

## 4. Code surface — files to be created or modified

### 4.1 NEW files

**`artifacts/api-server/src/services/betfairFirstUniverse.ts`** (~400 lines)

Contains:
- `tokenSetRatio` + `normaliseLeagueName` (~25 lines).
- `BETFAIR_REGION_TO_AF_COUNTRY` mapping (~80 entries).
- `mapBetfairRegion(region)` helper.
- `archetypeFor(row)` — verbatim from `archetype-labelling-rules.md` §3 (~50 lines).
- `assignTierFromAFAndCoverage(afRow, oddsPapiCoverage, hasHistoricalBets)` — implements §3.4 rules.
- `runBetfairReverseMapping()` — main cron entry. ~150 lines including dry-run logging.
- `manualTriggerBetfairReverseMapping()` — exported for the admin endpoint.

### 4.2 EDITED files

**`artifacts/api-server/src/services/scheduler.ts`** — register cron (1 block, ~5 lines).

**`artifacts/api-server/src/routes/api.ts`** — admin trigger endpoint `POST /admin/run-betfair-reverse-mapping` (~10 lines). Returns the same dry-run report shape as cron.

### 4.3 NOT modified

- `lib/db/src/schema/*` — zero schema changes.
- `migrate.ts` — zero new migrations.
- `leagueDiscovery.ts` — preserved as-is. The existing AF discovery cron at `runLeagueDiscovery` (daily 00:30) is supplementary, not replaced.
- `paperTrading.ts` / `betfairLive.ts` — untouched.

---

## 5. Telemetry contract

The cron logs a structured summary on every run. Two outputs:

### 5.1 Cron execution row (`cron_executions` table)

`job_name = 'betfair_reverse_mapping'`, `records_processed` = total Betfair competitions seen, `success` = true iff the cron completed without exception. Existing `cron_executions` schema covers this.

### 5.2 Summary log entry (one INFO log per run)

```json
{
  "run_id": "<uuid>",
  "dry_run": true,
  "betfair_competitions_fetched": 612,
  "af_universe_size": 1187,
  "tier_assignments_proposed": {
    "A": 149,
    "B": 84,
    "C": 12,    // newly probationary
    "D": 95,    // newly Tier D (Betfair-only)
    "unchanged": 749
  },
  "writes_proposed": {
    "insert_new_rows": 95,
    "update_betfair_competition_id": 76,
    "update_archetype": 1037,
    "update_universe_tier": 0   // strictly unchanged in sub-phase 2 (insert-only contract)
  },
  "writes_applied": 0,    // 0 in dry-run mode
  "skipped_unmapped_region": 3,
  "fuzzy_match_failures": {
    "below_threshold_count": 95,
    "below_threshold_sample": [
      { "betfair_name": "Slovak Premier League", "best_af_match": "Slovakian Liga", "score": 0.50 }
    ]
  },
  "duration_ms": 8421
}
```

The dry-run report is **the** review surface. User reads 1-3 of these before flipping.

---

## 6. Two-commit discipline (LOCKED)

Per `feedback_race_conditions.md` and the brief's strategic discipline.

### 6.1 Commit A — code with dry-run default `'true'`

Files:
- `artifacts/api-server/src/services/betfairFirstUniverse.ts` (new)
- `artifacts/api-server/src/services/scheduler.ts` (edit)
- `artifacts/api-server/src/routes/api.ts` (edit)

**No behaviour change** because dry-run is on. The cron runs daily, logs the diff, applies nothing.

**Verification before progressing**: review 1-3 dry-run reports. Confirm:
- `betfair_competitions_fetched` ≥ 500 (expected ~600).
- `af_universe_size` ≥ 1000 (expected ~1200).
- `writes_proposed.insert_new_rows` between 50 and 200 (Tier D candidates).
- `writes_proposed.update_betfair_competition_id` between 50 and 200 (matched existing rows).
- `writes_proposed.update_universe_tier = 0` (insert-only contract honoured).
- `fuzzy_match_failures.below_threshold_count` < 200 (most Betfair competitions match).
- Sample below-threshold matches look genuinely unmatchable (no obvious near-misses suggesting algorithm fault).

### 6.2 DML — Primera División demotion (between commits)

User runs the SQL from `phase-2-diagnostic-findings.md` §10.3. Single UPDATE + audit-log INSERT. Idempotent.

After running, verify:
```sql
SELECT name, universe_tier, settlement_bias_index, universe_tier_decided_at
FROM competition_config
WHERE LOWER(name) = LOWER('Primera División');
```
Expected: tier='D', bias=-0.524, decided_at recent.

### 6.3 Commit B — behaviour flip

Single line change in environment / config — not a code commit at all, technically. Either:

- **Option B.1:** set environment variable `BETFAIR_REVERSE_MAPPING_DRY_RUN=false` on VPS, restart api-server.
- **Option B.2:** change the default value in code from `'true'` to `'false'` in `betfairFirstUniverse.ts`. Single-line code commit.

**Recommendation: B.1 (env var).** Easier to flip back to dry-run if any post-flip issue surfaces. Code default stays defensive.

After flip, monitor first 3 cron runs (first 72h) for tier-count drift. Canary criteria in §7.

---

## 7. Canary criteria — post-flip monitoring

Run daily after commit B / env-var flip:

```sql
SELECT universe_tier, COUNT(*) AS n
FROM competition_config
GROUP BY universe_tier
ORDER BY universe_tier;
```

| Day | Tier A | Tier B | Tier C | Tier D | Tier E |
|---|---|---|---|---|---|
| Pre-cron baseline (before flip) | 149 | 84 | 0 | 0 | 804 |
| Day 1 post-flip | **148 ± 1** (Primera División now D) | 84 ± 5 | 0-50 | 80-150 | 804 ± 5 |
| Day 7 post-flip | 148 ± 5 | 84 ± 10 | 0-50 | 80-200 | 804 ± 10 |

**Hard-stop conditions:**
- Tier A drops by >5 in any single cron run → cron is demoting unexpectedly. Investigate.
- Tier D inserts > 300 in any single cron run → fuzzy match too lax OR Betfair list expanded unexpectedly. Investigate.
- `writes_applied.update_universe_tier > 0` for any non-unmapped → insert-only contract violated. Investigate.

If any hard-stop fires: revert by env-var flip back to dry-run (no DB rollback needed).

**Soft-watch:**
- Tier B + C grows by >50 across the first 7 days → some Tier A leagues lost Pinnacle coverage during the window. Inspect `oddspapi_league_coverage` for those leagues.
- New Tier D rows that are "probably matchable" on close visual inspection → algorithm calibration issue. Lower fuzzy threshold to 0.80 in a follow-up tweak.

---

## 8. Risk register

| # | Risk | Severity | Likelihood | Mitigation | Confidence |
|---|---|---|---|---|---|
| R1 | Fuzzy match too lax → wrong AF league claimed for a Betfair competition | High | Medium | Token-set ratio at 0.85 with country pre-filter; longest-active tie-breaker; dry-run gate forces user review of below-threshold sample. | EVIDENCE-BASED on threshold; HAND-WAVY without empirical Betfair name distribution |
| R2 | Country mapping incomplete → unmapped regions fall through to no-region fuzzy at 0.95 | Medium | Medium | Funnel logs `unmapped_region` count; user adds entries in follow-up. | ANALYTICAL |
| R3 | Insert-only contract violated (universe_tier overwritten) | High | Low | Code-level guard at write site; UPDATE statements explicitly exclude universe_tier; hard-stop canary at §7. | EVIDENCE-BASED (contract is in the code, not a human policy) |
| R4 | AF /leagues call rate-limits or returns partial data | Medium | Low | One call per cron run; throttle headroom is ~64k/day cap remaining. Retry on transient failure with exponential backoff. | EVIDENCE-BASED |
| R5 | Betfair listCompetitions changes shape (e.g., adds competitions overnight) | Low | Medium | The cron is idempotent; new competitions surface as new Tier D rows next run. | ANALYTICAL |
| R6 | Archetype labelling pass mis-labels a high-value league | Medium | Low | Cascade rules verbatim from locked `archetype-labelling-rules.md`; verification SQL spot-checks known leagues post-deploy. | EVIDENCE-BASED |
| R7 | Race: cron runs while user is mid-DML on competition_config | Low | Low-medium | Cron acquires advisory lock `pg_try_advisory_lock(<job_id>)`; if locked, log and skip the run. | ANALYTICAL |
| R8 | Tier D row growth pollutes the universe with junk competitions (e.g., Betfair test competitions, simulator markets) | Low | Medium | `is_active = false` on all Tier D rows; partial unique index on `(betfair_competition_id) WHERE api_football_id IS NULL` already in place from Phase 2.A. | EVIDENCE-BASED |
| R9 | Token-set ratio mis-weights short names (e.g., "Cup") to high scores | Medium | Medium | normaliser strips punctuation; 0.85 threshold + country pre-filter both filter; tie-breaker prefers longest-active. Verification via dry-run sample. | ANALYTICAL |
| R10 | Primera División DML runs AFTER cron starts demoting → race | Low | Low | DML is run BEFORE flag-flip. Cron at dry-run can't demote anyway. After DML, the cron's first non-dry-run pass sees Primera División already at D and respects insert-only contract (no change). | EVIDENCE-BASED |

**Net risk: MEDIUM.** Per `feedback_phase_checkpoints.md`, this requires explicit confirmation gates at each commit boundary.

---

## 9. Wall-clock estimate

| Step | Time |
|---|---|
| Implementation (Commit A) | 4-6h |
| Dry-run cron run + review (1-3 cycles) | 30 min - 1h |
| Primera División DML execution | 5 min |
| Behaviour-flip (env var) + restart | 5 min |
| 24-48h passive observation + canary checks | passive |

**Active work: 4-7 hours.** **Passive watch: 24-48 hours.**

---

## 10. Quick-revert procedure

If anything misbehaves post-flip:

1. **Revert env var:** `BETFAIR_REVERSE_MAPPING_DRY_RUN=true`, restart api-server. Cron runs but applies nothing. **No DB rollback needed.**
2. **If DB rows are wrong** (e.g., Tier D rows that should have matched): manual UPDATE/DELETE, OR wait for the next cron run after threshold tweak — the cron is idempotent and will reconcile.
3. **Primera División demotion is reversible:** `UPDATE competition_config SET universe_tier = 'A' WHERE LOWER(name) = LOWER('Primera División');` — but only do this if the bias-index reading is found to be artefact (extremely unlikely given the 5.2× threshold violation).

---

## 11. Verification SQL — post-Commit-A dry-run review

```sql
-- After 1-2 dry-run cycles, the cron_executions table records each run.
-- Pull the most recent run's details for review.
SELECT id, started_at, completed_at, success, records_processed, duration_ms,
       error_message
FROM cron_executions
WHERE job_name = 'betfair_reverse_mapping'
ORDER BY started_at DESC
LIMIT 5;
```

The summary log entry (per §5.2) is in api-server stdout / pino logs — `pm2 logs api-server | grep betfair_reverse_mapping_summary | head -10`.

---

## 12. Verification SQL — post-Commit-B behaviour-flip review

```sql
-- Q-postflip-1: tier counts (compare to §7 table)
SELECT universe_tier, COUNT(*) AS n
FROM competition_config
GROUP BY universe_tier
ORDER BY universe_tier;

-- Q-postflip-2: insert-only contract honoured?
SELECT universe_tier, COUNT(*) AS n,
       MAX(universe_tier_decided_at) AS most_recent_decision
FROM competition_config
WHERE universe_tier_decided_at >= '<flag_flip_timestamp>'
GROUP BY universe_tier;
-- Expected: rows here are EITHER newly-inserted Tier D, OR previously-unmapped/E rows that gained
-- a tier verdict. NO rows where the prior universe_tier was A/B/C should appear (insert-only).

-- Q-postflip-3: archetype labelling complete
SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE archetype IS NULL) AS unlabelled
FROM competition_config;
-- Expected: unlabelled = 0.

-- Q-postflip-4: Primera División demotion stuck
SELECT name, universe_tier, settlement_bias_index, archetype
FROM competition_config
WHERE LOWER(name) = LOWER('Primera División');
-- Expected: tier='D', bias=-0.524, archetype is set (probably 'top_flight_men' or similar).

-- Q-postflip-5: betfair_competition_id coverage
SELECT
  universe_tier,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE betfair_competition_id IS NOT NULL) AS with_betfair_id
FROM competition_config
WHERE universe_tier IN ('A','B','C','D')
GROUP BY universe_tier
ORDER BY universe_tier;
-- Expected: Tier D rows always have betfair_competition_id. Tier A/B/C rows mostly do
-- (matched via cron); some legacy may not yet (next cron run will fill them).
```

---

## 13. What this plan explicitly does NOT do

- **Does not run AF /leagues full-sweep discovery** beyond the per-cron-run cache. The existing `runLeagueDiscovery` (daily 00:30, `ALL_LEAGUE_IDS` curated set) is supplementary; sub-phase 7 may broaden it.
- **Does not implement bias-routing as ongoing cron behaviour.** Primera División is the only league currently flagged; future bias-driven demotions go through sub-phase 10's auto-audit cron, not this one.
- **Does not implement re-evaluation of probationary Tier C leagues at 30 bets** (deferred to sub-phase 5).
- **Does not implement auto-demotion of A→B/C/D** (deferred to sub-phase 10 ongoing audit).
- **Does not modify or replace the existing AF league discovery (`runLeagueDiscovery`) or the existing OddsPapi reliability tracking (`updatePinnacleOddsFromActualMappings`).** Those continue running on their own crons; the Betfair-first reverse-mapping is additive.
- **Does not change scheduler.ts dispatcher behaviour** (Phase 2.B.1 dispatcher already reads `universe_tier`).
- **Does not flip `experiment_track_enabled`.** That's a separate user decision after sub-phase 2 stabilises.
- **Does not modify `BANNED_MARKETS`** (sub-phase 4).
- **Does not add `model_decision_audit_log` table** (sub-phase 6).

---

## 14. Sign-off — STOP gate

Per `feedback_phase_checkpoints.md`: medium-risk phase requires explicit confirmation before code lands.

User must approve before implementation begins:

- [ ] §3.1 token-set algorithm + 0.85 threshold OK?
- [ ] §3.2 country mapping table approach OK? (Full table generated during implementation; question is the pattern.)
- [ ] §3.3 longest-active tie-breaker OK?
- [ ] §3.4 tier assignment rules OK? (Specifically: probationary new leagues at C, not B?)
- [ ] §3.5 insert-only contract OK?
- [ ] §3.6 archetype labelling pass on every run OK?
- [ ] §3.7 dry-run flag default 'true' OK?
- [ ] §3.8 cron slot `0 7 * * *` UTC OK?
- [ ] §6 two-commit discipline (code → DML → flag-flip) OK?
- [ ] §7 canary criteria + hard-stop thresholds OK?
- [ ] §10 quick-revert via env var OK?
- [ ] §13 explicit non-goals (e.g., AF full-sweep deferred) OK?

When all 12 are confirmed (or revised + re-confirmed), Commit A implementation begins.

---

## 15. Sign-off checklist (for sub-phase completion, NOT now)

- [ ] §14 plan approval gates cleared.
- [ ] Commit A authored, typecheck + build clean, committed + pushed.
- [ ] Dry-run cron runs 1-3 times; user reviews reports.
- [ ] Below-threshold matches reviewed; no obvious near-misses.
- [ ] Primera División DML executed.
- [ ] Behaviour-flip applied (env var or commit B).
- [ ] Q-postflip-1 through Q-postflip-5 pass.
- [ ] 24-48h passive observation completes; canary criteria hold.
- [ ] Sub-phase 2 closed; sub-phase 3 plan-mode document drafted (NEXT SESSION after this one).
