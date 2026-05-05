# Wave 2 #4 — Banned-market reactivation on experiment track (PLAN)

**Status:** PLAN-MODE. **No code change in this document.** User reviews; implementation begins on explicit approval.

**Authored:** 2026-05-05.
**Predecessors:** Wave 2 #1 (decision-audit schema) shipped + verified. Wave 2 #5 (DOUBLE_CHANCE investigation) closed — settlement is correct, no code fix needed, DOUBLE_CHANCE in reactivation scope.
**Source:** strategic brief sub-phase 4.

---

## 1. Goal

Reactivate every currently-quarantined market on the experiment track only. Production track (Tier A real-money) keeps the existing bans untouched. Net effect: experiment track admits Tier B/C bets across `OVER_UNDER_25`, `OVER_UNDER_35`, `FIRST_HALF_RESULT`, `DOUBLE_CHANCE`, plus the zero-history quarantines (`OVER_UNDER_05`, `OVER_UNDER_15`, `TOTAL_CARDS_45`, `TOTAL_CARDS_55`, `TOTAL_CORNERS_75`/`85`/`95`/`105`/`115`, `FIRST_HALF_OU_05`).

**Excluded from this commit:** `ASIAN_HANDICAP`. Per current-state §4.2, AH placement is functionally incomplete (`valueDetection.ts` doesn't generate AH candidates, `exchangeBookSweep.ts` skips AH, `oddsPapi.ts` excludes AH from prefetch). AH activation requires building the value-detection pipeline for it — separate sub-phase 4.A, NOT bundled here.

---

## 2. Mechanism (LOCKED)

The `BANNED_MARKETS` set at `paperTrading.ts:445-464` is the single source of truth. Imported at four call sites:

1. `paperTrading.ts:683` — placement hardstop (rejects bet at `placePaperBet` entry)
2. `paperTrading.ts:2468-2519` — `voidBannedMarketBets` settlement-time void (refund pending bets on banned markets)
3. `valueDetection.ts:1035` — pre-pricing filter (excludes from candidate generation)
4. `oddsPapi.ts:2130-2131` — comment-only reference (prefetch exclusion mirror)

The fix is to gate sites 1 and 3 on `data_tier`. Sites 2 and 4 stay unchanged:
- Site 2 (`voidBannedMarketBets`) is invoked specifically to clean up bets placed on banned markets — irrelevant to experiment-track reactivation. Leave as-is.
- Site 4 (oddsPapi prefetch) is a comment-only reference. The actual prefetch market list at `oddsPapi.ts:2752-2754` says "Exclude: ASIAN_HANDICAP, banned markets…" — this excludes from PREFETCH but not from valueDetection's market loop. We need experiment-track candidates to have odds data; if oddsPapi prefetch excludes them, those candidates won't have Pinnacle data (which is fine — they're Tier B/C anyway, no Pinnacle expected). **Leave the prefetch exclusion alone.**

So the substantive change is at TWO sites only.

---

## 3. Code-level change (LOCKED — diff in §3.1 + §3.2)

### 3.1 `paperTrading.ts:683` — placement hardstop

Current:
```ts
// ── Banned-market hardstop (uses module-level BANNED_MARKETS) ─────────────
if (BANNED_MARKETS.has(marketType)) {
  logger.warn({ matchId, marketType, selectionName }, "HARDSTOP: Banned market — bet blocked at placement");
  return logReject(`Banned market ${marketType} — bet blocked at placement (hardstop)`);
}
```

Proposed:
```ts
// ── Banned-market hardstop (uses module-level BANNED_MARKETS) ─────────────
// Wave 2 #4 (2026-05-05): production track keeps bans; experiment track
// (Tier B/C, £0 stake architectural guarantee) bypasses them. Strategic
// intent: let the model re-prove edge or non-edge with current
// post-Replit-migration infrastructure. £0 stake means zero capital at
// risk; correlation + duplicate-bet rejection still applies.
const isShadowBet = universeTier === "B" || universeTier === "C";
if (BANNED_MARKETS.has(marketType) && !isShadowBet) {
  logger.warn({ matchId, marketType, selectionName }, "HARDSTOP: Banned market — bet blocked at placement");
  return logReject(`Banned market ${marketType} — bet blocked at placement (hardstop)`);
}
if (BANNED_MARKETS.has(marketType) && isShadowBet) {
  logger.info(
    { matchId, marketType, selectionName, universeTier },
    "Wave 2 #4: experiment-track shadow bet on previously-banned market — admitted for relearning",
  );
}
```

**Note:** `isShadowBet` is already declared at `paperTrading.ts:651` (per the Phase 2.B.2 commit). The new check at line ~683 reuses the existing variable — no redeclaration.

### 3.2 `valueDetection.ts:1035` — pre-pricing filter

Current:
```ts
// Banned-market hardstop (cheap check before pricing selection)
if (BANNED_MARKETS.has(marketType)) continue;
```

Proposed:
```ts
// Banned-market hardstop (cheap check before pricing selection).
// Wave 2 #4 (2026-05-05): experiment track (Tier B/C) bypasses bans —
// candidates flow through to placement where the data_tier-gated
// hardstop confirms £0 stake. Production track (Tier A) keeps bans.
const isExperimentTrack = (matchUniverseTier === "B" || matchUniverseTier === "C");
if (BANNED_MARKETS.has(marketType) && !isExperimentTrack) continue;
```

**Subtle:** `valueDetection.ts` is a pre-dispatcher producer; it doesn't know per-candidate which tier the match belongs to. We need to source `matchUniverseTier` from the existing match-level loop (looking up `competition_config.universe_tier` for the league once per match, not per selection).

The existing match loop at valueDetection.ts already loads `competition_config` rows (per the dispatcher data load at scheduler.ts:954). We need a similar lookup or pass-through. Most-likely: load a `Map<matchId, universeTier>` once at top of `detectValueBets()` and pass it through.

This is a slightly bigger surgery than §3.1. Let me itemise:

1. At top of `detectValueBets()` (after the existing data preloads): query `competition_config` joined to `matches` to build `Map<matchId, universeTier>`.
2. Inside the per-match loop: look up `matchUniverseTier` from that map.
3. Use it in the line 1035 check.

Estimated +25-35 lines including the data load.

### 3.3 What this does NOT do

- **Does not modify `BANNED_MARKETS` constant.** Production track still rejects all 14 markets at placement.
- **Does not modify `voidBannedMarketBets`.** Settlement-time refund logic untouched.
- **Does not modify oddsPapi prefetch exclusions.** Banned markets stay out of Pinnacle prefetch (irrelevant for Tier B/C anyway).
- **Does not include ASIAN_HANDICAP.** AH is not in `BANNED_MARKETS` — it's value-detection-incomplete. Separate sub-phase 4.A.
- **Does not change correlation / duplicate-bet rejection.** Both stay ON for both tracks per the brief's invariant.

---

## 4. Risk register

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Production track accidentally places real bets on banned markets | Critical | Very low | Positive gating (`!isShadowBet` / `!isExperimentTrack`). Tier A rows have `universeTier = 'A'`, never B/C. Architectural guarantee. |
| R2 | Experiment track produces too many candidates, overwhelming exposure caps | Low | Medium | shadow_stake bypasses exposure cap (already established in Phase 2.B.2 at `paperTrading.ts:1108`). No real capital at risk anyway. |
| R3 | DOUBLE_CHANCE has selection-canonicalisation issues we missed in Wave 2 #5 | Low | Low | Q-DC-2 explicitly tested — 20/20 should_lose=lost, 12/12 should_win=won, **zero disagreements**. Settlement is verified correct. |
| R4 | Cards/Corners markets need `has_statistics = true` on competition_config (per `paperTrading.ts:701-723`) | Medium | Medium | Tier B leagues may not have `has_statistics`. The existing check is at `paperTrading.ts:701-723` and rejects with reason "No corners/cards stats coverage". This pre-dates Wave 2 #4 and stays as-is. Cards/corners selections that would have been rejected anyway stay rejected. Net: no new risk; just narrows the reactivation effective for those markets. |
| R5 | New volume swamps the trading cycle, causing latency or pm2 OOM | Medium | Low-medium | Trading cycle is already running healthily with ~250 selections evaluated per cycle. Adding banned markets adds ~100-200 more selections (most filter at no_betfair_exchange). Hard ceiling = 5000 daily bet budget; well within. |
| R6 | DOUBLE_CHANCE's `has_betfair_exchange = false` competition_configs reject upstream | Low | Low | The exchange-book sweep populates betfair_exchange snapshots independently of has_betfair_exchange flag (per Wave 1.5 #1 audit). Tier B with bf_exchange snapshots will admit DOUBLE_CHANCE candidates. |
| R7 | Settlement code coverage for the reactivated markets isn't 100% | Low | Low | All 14 banned markets have settlement code per current-state §4.1. DOUBLE_CHANCE verified Wave 2 #5. Other markets have settlement code blocks at `paperTrading.ts:1646-1748`. |

**Net risk: LOW.** The architecture (positive gating on universe_tier ∈ {B,C}) is the same pattern Phase 2.B.2 already shipped for the £0-stake-bypass. Production track is untouchable.

---

## 5. Wall-clock + sequencing

- Read existing match loop in `valueDetection.ts` to find the right place to inject the universe_tier lookup: 5 min
- Implement §3.1 (paperTrading): 5 min
- Implement §3.2 (valueDetection): 15-20 min (data preload + lookup integration)
- Build + commit + push: 5 min
- VPS pull + build + restart: 5 min
- Verification: 10 min (look for shadow bets in newly-reactivated markets via SQL)

**Total: ~45-60 min.** Single tight commit.

---

## 6. Verification SQL — post-deploy

```sql
-- W4-T1: shadow bets placed on previously-banned markets since deploy
SELECT
  market_type,
  COUNT(*) AS bets,
  COUNT(*) FILTER (WHERE shadow_stake IS NOT NULL) AS shadow,
  COUNT(*) FILTER (WHERE stake::numeric > 0) AS real_stake,
  MIN(placed_at) AS first_placed,
  MAX(placed_at) AS most_recent
FROM paper_bets
WHERE market_type IN (
  'OVER_UNDER_25','OVER_UNDER_35','FIRST_HALF_RESULT','DOUBLE_CHANCE',
  'OVER_UNDER_05','OVER_UNDER_15','TOTAL_CARDS_45','TOTAL_CARDS_55',
  'TOTAL_CORNERS_75','TOTAL_CORNERS_85','TOTAL_CORNERS_95',
  'TOTAL_CORNERS_105','TOTAL_CORNERS_115','FIRST_HALF_OU_05'
)
  AND placed_at >= '<deploy_timestamp_utc>'
  AND deleted_at IS NULL
  AND legacy_regime = false
GROUP BY market_type
ORDER BY bets DESC;
```

**Pass:** at least one row with `shadow > 0` for at least one previously-banned market. Within 10-15 min of deploy, expect 5-15 such bets to appear (depends on what fixtures are in the trading window).

```sql
-- W4-T2: confirm no production-track placements on banned markets
SELECT
  market_type,
  universe_tier_at_placement,
  COUNT(*) AS bets,
  COUNT(*) FILTER (WHERE stake::numeric > 0) AS real_stake_violations
FROM paper_bets
WHERE market_type IN (
  'OVER_UNDER_25','OVER_UNDER_35','FIRST_HALF_RESULT','DOUBLE_CHANCE',
  'OVER_UNDER_05','OVER_UNDER_15','TOTAL_CARDS_45','TOTAL_CARDS_55',
  'TOTAL_CORNERS_75','TOTAL_CORNERS_85','TOTAL_CORNERS_95',
  'TOTAL_CORNERS_105','TOTAL_CORNERS_115','FIRST_HALF_OU_05'
)
  AND placed_at >= '<deploy_timestamp_utc>'
  AND deleted_at IS NULL
  AND legacy_regime = false
GROUP BY market_type, universe_tier_at_placement
ORDER BY market_type, universe_tier_at_placement;
```

**Pass criterion:** `real_stake_violations = 0` for ALL rows. Tier A rows should have zero hits — production track must not place on banned markets.

```sql
-- W4-T3: Tier A behaviour byte-identical (no new placements on banned markets)
SELECT COUNT(*) AS tier_a_banned_market_violations
FROM paper_bets
WHERE market_type IN (
  'OVER_UNDER_25','OVER_UNDER_35','FIRST_HALF_RESULT','DOUBLE_CHANCE',
  'OVER_UNDER_05','OVER_UNDER_15','TOTAL_CARDS_45','TOTAL_CARDS_55',
  'TOTAL_CORNERS_75','TOTAL_CORNERS_85','TOTAL_CORNERS_95',
  'TOTAL_CORNERS_105','TOTAL_CORNERS_115','FIRST_HALF_OU_05'
)
  AND placed_at >= '<deploy_timestamp_utc>'
  AND universe_tier_at_placement = 'A'
  AND deleted_at IS NULL
  AND legacy_regime = false;
-- Expected: 0
```

**HARD-STOP CONDITION:** if `tier_a_banned_market_violations > 0`, immediately revert by reverting the commit + restarting api-server. The architectural guarantee is broken.

---

## 7. Quick-revert procedure

If anything misbehaves post-deploy:

1. **Revert the commit:** `git revert <commit_hash>` + push + pull on VPS + rebuild + restart. Behaviour returns to "all banned markets blocked on both tracks."
2. **Soft-revert (no code change):** flip `experiment_track_enabled = 'false'` in agent_config. This stops Tier B/C placements entirely — including the newly-admitted banned-market shadow bets.

---

## 8. What this commit does NOT do

- Does not change `BANNED_MARKETS` set membership (additions/removals).
- Does not modify `voidBannedMarketBets` settlement-time logic.
- Does not modify oddsPapi prefetch exclusions.
- Does not include `ASIAN_HANDICAP` (separate sub-phase 4.A).
- Does not change correlation / duplicate-bet rejection (both stay ON).
- Does not modify `BANNED_MARKETS` membership.

---

## 9. Sign-off — STOP

Code commits affecting placement code paths are user-approval-gated per Wave 2 discipline. Approve any/all:

- [ ] §3.1 paperTrading.ts placement-hardstop diff OK?
- [ ] §3.2 valueDetection.ts pre-pricing-filter diff approach OK? (Note the additional data preload — biggest scope item.)
- [ ] §3.3 explicit non-goals OK?
- [ ] §4 risk register accepted?
- [ ] §6 verification SQL set OK?
- [ ] §7 quick-revert procedure OK?

If approved: I read the relevant valueDetection.ts code paths to find the right injection point, write the diff, commit, push, hand you the deploy + verification SQL.

Stopping. Awaiting Wave 2 #4 approval.
