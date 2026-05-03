# Post-Stage-4 Backlog

Items deferred out of Stage 4 (footballData.org removal + paid-API maximisation, Prompt-N), ranked-ready for prioritisation when Stage 4 wraps.

Each row: brief description · prompt-tier estimate · lift confidence (if known) · rationale for deferral.

Format: `EVIDENCE-BASED / EMPIRICAL / ANALYTICAL / HAND-WAVY` per the project's confidence-flag rule.

---

## P6 — High-leverage follow-ups, evidence-based

### P6.1 — Closing-line backfill handler (late-mapped fixtures)
- **Description:** `oddsPapi.ts:2596-2627` `fetchAndStoreClosingLineForPendingBets()` permanently misses closing line for any bet placed on a fixture that wasn't yet in `oddspapi_fixture_map` when the cron ran. Cron does not retry. Add a re-attempt loop for any pending bet whose fixture mapped post-placement and whose kickoff is still in the ±90min window.
- **Lift:** better CLV data on 5-10% of bets currently losing closing capture. Confidence: HAND-WAVY (depends on at-risk subset measurement; SQL probe in plan Part 1.6 still to run).
- **Cost:** +5 OddsPapi calls/day. ~3 hours dev.
- **Why deferred:** Stage 4 scope is footballData.org removal. CLV-handler patch is a separate ergonomic improvement that doesn't gate paper-trading volume.

### P6.2 — League-position-diff bootstrap fix (already addressed by Stage 4 Phase D)
- **Status:** SUBSUMED. Phase D ships `/standings` against API-Football and removes the hardcoded `0` at featureEngine.ts:594. **Remove from this backlog when Phase D lands.**

### P6.3 — `/odds` batching attempt (was P3.3 in earlier audits)
- **Description:** Earlier audit assumed API-Football v3 supports multi-fixture `/odds?fixture=id1-id2-...`. Stage 4 audit downgraded this to HAND-WAVY pending direct verification against the live API. If batching IS supported, current ~250-300 unbatched calls/day → ~25 batched calls/day = -225/day savings.
- **Lift:** 0% accuracy lift; pure efficiency. Frees budget headroom but cap is not the binding constraint.
- **Confidence on viability:** HAND-WAVY until tested.
- **Cost:** ~2 hours dev, ~5 min API probe to confirm.
- **Why deferred:** efficiency-only. Stage 4's apiFootball spend stays well under cap regardless.

### P6.4 — Lineup polling cadence reduction (was P3.4)
- **Description:** `scheduler.ts:2115` runs `*/15` for lineups in T-30 to T-90 window. Lineups change rarely once published. Move to `*/30` + per-fixture lock-in flag (no re-fetch after first successful capture). -90 calls/day.
- **Lift:** 0% accuracy; defensive efficiency.
- **Confidence:** EMPIRICAL.
- **Cost:** ~30 min dev.
- **Why deferred:** efficiency-only. Cap not binding.

### P6.5 — OddsPapi pre-kickoff CLV stagger (was P3.5)
- **Description:** `captureAllPendingSnapshots` (`*/5`) and `fetchAndStoreClosingLineForPendingBets` (`*/15`) hit `/odds` independently. Same-minute collisions waste ~40 calls/day. Stagger CLV cron to `:02,:17,:32,:47` to dedup with snapshot's `:00,:05,...`.
- **Lift:** 0% accuracy; pure efficiency.
- **Confidence on saving size:** HAND-WAVY (estimate -20 to -60).
- **Cost:** ~30 min dev.
- **Why deferred:** efficiency-only. Cap not binding.

### P6.6 — OddsPapi `/v4/markets` discovery + market-universe expansion
- **Description:** Goalscorer (anytime/first/last), Correct Score, HT/FT, Asian Total — confirm whether OddsPapi prices these via Pinnacle, then wire as new market types.
- **Lift:** EVIDENCE-BASED that more markets = more bet volume; ANALYTICAL on per-market edge until staking strategy is tuned.
- **Cost:** Discovery ~1 hour. Per-market wiring 4-8 hours each.
- **Why deferred:** Stage 4 is upstream — closing the football-data leak first. New market types require fresh value-detection thresholds + closing-line definitions per market.

### P6.7 — Cards re-enable
- **Description:** TOTAL_CARDS_35/45 paused 2026-04-19 due to -13% to -17% CLV (oddsPapi.ts:1021-1068). Root cause never investigated. Need: per-market CLV decomposition, line-type breakdown, model-prediction-vs-Pinnacle delta histogram BEFORE re-enabling.
- **Lift:** unknown until root cause known. Could be -5%+ if structural; could recover to neutral if data-pipeline issue.
- **Confidence:** HAND-WAVY pending investigation.
- **Cost:** ~6 hours diagnostic + variable fix scope.
- **Why deferred:** profit-protective hold. Re-enabling without investigation risks a structural -10%+ ROI drag on whatever fraction of bet volume is cards.

### P6.8 — Asian-handicap activation
- **Description:** ASIAN_HANDICAP entry exists in `MARKET_IDS` (oddsPapi.ts:126-137) and is partially modeled but never placed. Activate in value-detection / staking with appropriate threshold.
- **Lift:** EVIDENCE-BASED that AH is heavily-priced and Pinnacle-sharp; concrete edge unknown until backtested.
- **Cost:** ~6 hours dev + backtest validation.
- **Why deferred:** new market needs separate staking threshold + CLV baseline. Stage 4 is footballData removal first.

---

## P7 — OddsPapi cadence increases

### P7.1 — Bulk-prefetch 2h → 1.5h, snapshot windows tightened
- **Description:** Per Stage 4 plan Part 4.4, +9k/month spend gets us +4k bulk-prefetch calls + new T-2 bucket + CLV stagger savings. Total → ~79k/month against 100k cap.
- **Lift:** EVIDENCE-BASED that more snapshots = better velocity / steam detection. Specific edge gain HAND-WAVY.
- **Cost:** ~3 hours dev.
- **Why deferred:** cap headroom is not the binding constraint right now; bake metrics aren't asking for more snapshots. Revisit after Phase F's 15-feature model has 4 weeks of data.

---

## P8 — API-Football speculative endpoints

Each its own commit + verify cycle. None gates anything else; can ship in any order or be skipped entirely. All HAND-WAVY confidence on lift.

### P8.1 — `/predictions`
API-Football's own model output as a meta-feature. Possible signal IF orthogonal to current features. Likely correlated with public odds we already capture. ~100 calls/day. Defer until model plateau evident.

### P8.2 — `/coaches`
Coach tenure / nationality / experience. Speculative whether elite-coach effect exists at population level. ~20 calls/day. Defer.

### P8.3 — `/sidelined`
Player suspensions (red-card accumulations, etc.). Subset of injury-style signal. ~100 calls/day. Defer; better to track from /events post-match.

### P8.4 — `/transfers`
Transfer-window tracking. Marginal value; high engineering cost. Defer.

### P8.5 — `/trophies`
Historic title counts. Confounded by league quality. Skip unless model needs prestige proxy.

### P8.6 — `/events`
In-match events (goals, cards, subs). Useful for live trading; not applicable to pre-match features. Defer to live-trading phase.

---

## P9 — Alternative xG sources for non-Understat leagues

### P9.1 — FBref / StatsBomb scrape for ~25 additional leagues
- **Description:** Understat publishes only top-5 European + RFPL (if Phase B confirms). FBref / StatsBomb cover 25+ leagues with xG data. ToS ambiguous on scraping. Data lag 1-2 days.
- **Lift:** would enable Stage-2-equivalent (real xG instead of proxy) for non-Understat leagues — significant for leagues outside top-5.
- **Cost:** Legal review + scraper dev + CI hardening + 4-8 hours alias-table extension. Non-trivial.
- **Why deferred:** ToS / legal ambiguity is a blocker. Not a pure dev problem.

### P9.2 — Derive xG from API-Football events data (shot-by-shot)
- **Description:** API-Football has shot events but no native xG. Could compute xG ourselves from shot location + type metadata.
- **Lift:** unlocks xG for ALL API-Football leagues (~150-200 senior). Highest leverage but highest R&D cost.
- **Cost:** R&D-heavy. Need to validate derivation against published xG (Understat as ground-truth).
- **Why deferred:** R&D — not a deterministic implementation task.

---

## P10 — Pre-existing CLAUDE.md tickets

### P10.1 — Tier-B pre-live blockers (gate live trading, not paper)
- **Plan 4** — projection fix at `betfairLive.ts:700-714`. Drops null CLV onto every LIVE-reconciled bet.
- **Plan 5** — projection fix at `launchActivation.ts:341-371`. Dormant unless cross-DB activation invoked.
- **Why deferred:** not blocking paper trading. Will block live trading. Bundle into pre-live phase along with Plans 4 + 5 from CLAUDE.md.

### P10.2 — Tier-C residual hygiene (CLAUDE.md, opportunistic)
- **Plan 1** — `Number()` wrap on numeric-string sort in `paperTrading.ts` dedup.
- **Plan 2** — explicit `PoolClient` type in `scheduler.ts`.
- **Plan 3** — delete orphaned `approved: 1` key in `leagueDiscovery.ts:430` (no `approved` column in schema).
- **Plan 6** — extract a named `FixtureMatch` type in `oddsPapi.ts`.
- **Why deferred:** zero runtime impact. Take when touching adjacent code, not as standalone work.

---

## Out-of-scope notes

- WhoScored / Opta scraping: ToS-forbidden. Skip.
- `team_xg_rolling` row growth (no upsert): retention cron later, not blocking.
- valueDetection.ts:353-360 dead code (reads xg_proxy from empty object): cosmetic, low priority.
