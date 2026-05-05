# Archetype Labelling Rules

**Purpose:** define the deterministic rules that assign `competition_config.archetype` for every row. Sub-phase 2's reverse-mapping cron MUST apply these rules on its first pass, including over already-existing rows. Downstream phases (sub-phase 5 distribution-shift detector, sub-phase 6 autonomous threshold management) depend on archetype-keyed logic; if archetype is null, those features silently degrade.

**Authored:** 2026-05-05, sub-phase 1 of the strategic Phase 2 push.
**Source:** `docs/phase-2-shadow-experiment-architecture-v1.md` §3.4 + diagnostic findings §6.4.

---

## 0. Why this exists

The Phase 2.A schema migration added `competition_config.archetype TEXT` (nullable) at `migrate.ts:931`. The migration shipped 2026-05-05 (commit `37aca11`). **No DML has populated the column.** All 1,037 rows in `competition_config` currently have `archetype = NULL` (per diagnostic §6.4 inferred result).

The strategic brief flagged this in the resolution message: "Sub-phase 2's reverse-mapping cron MUST label archetypes on its first pass as a non-optional deliverable." This document locks the algorithm so that sub-phase 2's plan-mode document doesn't have to re-derive it.

---

## 1. The valid archetype set (LOCKED)

```
women              -- women's leagues at any tier
cup                -- domestic cup competitions
international      -- World Cup, continental qualifiers, Nations League, etc.
top_flight_men     -- tier-1 men's national league
lower_division     -- tier ≥ 2 men's national league
other              -- fallback (unmatched)
```

**Six values.** The CHECK constraint on the column is left unconstrained (TEXT, no CHECK) intentionally — v3 may extend the set with archetype refinements (e.g., `youth`, `friendly`, `cup_lower_round`). Sub-phase 6's per-archetype threshold management treats unknown values the same as `other`.

---

## 2. Source signals

The labeller draws from these fields on each `competition_config` row:

| Field | Type | Provenance |
|---|---|---|
| `name` | TEXT | League name (canonical AF-side or Betfair-side after fuzzy match) |
| `country` | TEXT | Country / region |
| `gender` | TEXT | `'male'` / `'female'` (set by AF-side discovery) |
| `type` | TEXT | `'league'` / `'cup'` / `'international'` (set by AF-side discovery) |
| `tier` | INTEGER | `1` / `2` / `3` (set by `classifyLeague()` at `leagueDiscovery.ts:72`) |

**For Tier-D rows (Betfair-only, `api_football_id IS NULL`):** AF-derived fields (`gender`, `type`, `tier`) may be unset or default. The labeller must handle missing values gracefully — fall through to name-based heuristics.

---

## 3. The 7-rule cascade (FIRST MATCH WINS — order matters)

```
function archetypeFor(row):
  let n = lower(row.name)
  let c = lower(row.country)

  // Rule 1: women's leagues — explicit first to avoid being captured by tier rules
  if row.gender == 'female' or
     n.includes('women') or
     n.includes('féminine') or n.includes('feminine') or
     n.includes('femenina') or
     n.includes('nữ') or n.includes('nu '):  // Vietnamese women's; trailing space avoids false positives
    return 'women'

  // Rule 2: international tournaments and qualifiers
  if n.includes('world cup') or
     n.includes('nations league') or
     n.includes('euro ') or n.endsWith(' euro') or
     n.includes('qualifier') or n.includes('qualifying') or
     n.includes('wcq ') or n.startsWith('wcq ') or
     n.includes('copa america') or
     n.includes('afcon') or n.includes('africa cup of nations') or
     n.includes('asian cup') or
     n.includes('concacaf') or
     n.includes('uefa nations'):
    return 'international'

  // Rule 3: cups (domestic and supra-national that aren't already 'international')
  // Tested AFTER international so "FA Cup" doesn't get caught by rule 2's "euro"
  // false-positive paths.
  if n.includes('cup') or n.includes('coupe') or n.includes('copa') or
     n.includes('pokal') or n.includes('beker') or n.includes('coppa') or
     n.includes('taça') or n.includes('taca') or
     row.type == 'cup':
    return 'cup'

  // Rule 4: explicit type=international from AF-side
  if row.type == 'international':
    return 'international'

  // Rule 5: top-flight men's leagues
  if (row.tier == 1 or row.tier == null) and
     (row.gender == 'male' or row.gender == null) and
     (row.type == 'league' or row.type == null):
    return 'top_flight_men'

  // Rule 6: lower-division men's leagues
  if row.tier >= 2 and
     (row.type == 'league' or row.type == null):
    return 'lower_division'

  // Rule 7: fallback
  return 'other'
```

**Why rule 1 first:** women's leagues at tier 1 would otherwise be mis-classified as `top_flight_men` by rule 5 (because `gender='male'` defaults if missing). Always test gender-female first.

**Why rule 3 (cup) before rule 4 (type=international):** AF-side `type='international'` is sometimes set on continental cup tournaments that should logically be `cup` archetype. The text-pattern rule 3 catches "Copa Libertadores" before rule 4 demotes it.

**Why `n.includes('euro ')` with trailing space and `n.endsWith(' euro')`:** avoids false positive on "Eurocup" / "Europa League" (those are continental cups, handled at rule 3).

**Why tier null defaults to top_flight in rule 5:** Tier-D rows (Betfair-only) often have null tier; treating them as top_flight_men by default is the safest assumption pending more data. Rule 6 will downgrade if tier ≥ 2 was explicitly captured.

---

## 4. Application contract

Sub-phase 2's reverse-mapping cron must:

1. **First-pass DML** — label every existing row in `competition_config` where `archetype IS NULL`. Single UPDATE per row, idempotent. Run inside the dry-run gate of the cron's first deployment.
2. **Subsequent rows** — every new row inserted by the cron (Betfair-only Tier-D rows, mid-cycle additions) gets labelled at insert time, not deferred.
3. **Re-labelling on update** — if AF-side discovery changes `tier`, `gender`, or `type` on an existing row, the cron's next pass MUST re-evaluate archetype for that row. Archetype is a derived field; it stays consistent with its inputs.
4. **Logging** — at each cron run, log a count of `(insert, update, no-change)` for archetype assignments. Telemetry feeds the funnel report.
5. **No null on success** — after the first cron pass completes, no `competition_config` row should have `archetype IS NULL`. A null is a labelling-failure signal; alert and investigate.

---

## 5. Verification SQL — run after first cron pass

```sql
-- Q-archetype-1: every row labelled?
SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE archetype IS NULL) AS unlabelled,
  COUNT(*) FILTER (WHERE archetype = 'women') AS women,
  COUNT(*) FILTER (WHERE archetype = 'cup') AS cup,
  COUNT(*) FILTER (WHERE archetype = 'international') AS intl,
  COUNT(*) FILTER (WHERE archetype = 'top_flight_men') AS top_men,
  COUNT(*) FILTER (WHERE archetype = 'lower_division') AS lower,
  COUNT(*) FILTER (WHERE archetype = 'other') AS other
FROM competition_config;
```

**Pass criterion:** `unlabelled = 0`.

```sql
-- Q-archetype-2: spot-check known leagues
SELECT name, country, tier, gender, type, archetype
FROM competition_config
WHERE name IN (
  'Premier League', 'La Liga', 'Serie A',                 -- expect top_flight_men
  'Championship', 'Serie B', '2. Bundesliga',             -- expect lower_division
  'FA Cup', 'Coupe de France', 'Copa del Rey',            -- expect cup
  'UEFA Champions League', 'World Cup',                   -- expect international
  'Premier League Women', 'National Women''s Soccer League' -- expect women (if present)
)
ORDER BY archetype, name;
```

**Pass criterion:** spot-checked rows have the archetypes the comment suggests.

```sql
-- Q-archetype-3: distribution sanity
-- Expect roughly: top_flight_men ~150, lower_division ~300, cup ~80,
-- international ~30, women ~100, other ~400 (rough, depends on AF coverage).
SELECT archetype, COUNT(*) AS n,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM competition_config
GROUP BY archetype
ORDER BY n DESC;
```

**Pass criterion:** no archetype dominates >70% (would suggest a broken rule); no archetype = 0 (would suggest a missing rule path).

---

## 6. Locked decisions to NOT revisit in sub-phase 2

The following are pinned here. Sub-phase 2's plan document inherits them; do not re-debate.

- **Six archetype values.** Not three, not twelve. Six.
- **`other` is the universal fallback** — no row stays unlabelled.
- **First-match-wins cascade order** — women → international → cup → AF-international → top_flight_men → lower_division → other.
- **Rules 1-3 use case-insensitive substring match on `name`**, not regex, not fuzzy match. Substring is the correct primitive for keyword-pattern detection.
- **Tier null defaults to top_flight_men** — until AF-side discovery confirms otherwise.
- **`women` covers all gendered leagues, not just top-tier**. Tier rules don't apply to women's leagues — they're their own archetype because their feature distribution differs from men's.
- **Mixed gender / unknown gender → treated as male** for purposes of the cascade. v3 may add a `mixed` archetype if data justifies.

---

## 7. v3 deferred items (NOT for sub-phase 2)

- Per-archetype graduation thresholds (sub-phase 6 work, gated on 30+ candidate→promoted transitions).
- Archetype refinement: `youth`, `friendly`, `cup_lower_round`, `playoff_round`. Defer until usage justifies.
- Archetype assignment based on Betfair's `competitionRegion` rather than `country`. Defer.
- Multi-language pattern coverage beyond the listed terms (e.g., Vietnamese, Japanese, Arabic, Russian-script women's-league terms). Add patterns case-by-case as the universe expands.

---

## 8. Sign-off

- [x] Six-archetype set locked.
- [x] Cascade order pinned.
- [x] Source signal list documented.
- [x] Application contract for sub-phase 2 cron pinned.
- [x] Verification SQL written.
- [ ] Sub-phase 2's plan-mode document references this file (NEXT SESSION).
- [ ] Sub-phase 2's reverse-mapping cron implementation imports the cascade verbatim (sub-phase 2 ship).
- [ ] First-pass labelling DML runs (sub-phase 2 ship).
- [ ] Verification queries pass (sub-phase 2 ship).

This document is the canonical reference for archetype semantics. Future autonomous changes to archetype assignment must reference this file, log the change in `model_decision_audit_log` (sub-phase 6), and update this file in the same commit.
