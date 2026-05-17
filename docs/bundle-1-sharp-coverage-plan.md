# Bundle 1 — Sharp-book coverage expansion (plan, pre-approval)

> **Status:** Plan-only. No code changes. Approval required before implementation.
> **Generated:** 2026-05-17. Bundle 0 result documented in `phase2-strategy-inversion-pre-read.md` §0.1 (after memo correction). Subscription is **Pinnacle-only paid** + **separate free-tier account required** for non-Pinnacle sharps.

---

## E.5 — Post-deployment subtractive redesign (added 2026-05-17 evening)

The original plan (Sections C, E.3, F below) was built before we'd seen actual response shapes from non-Pinnacle books. After E.1/E.2/E.3 shipped, the first 9 free-tier burns wrote zero rows. Four diagnostic curls revealed why, and Chris's strategic guidance ("sharps find/decide edge; softs are what we bet INTO, not learn FROM") settled the redesign direction.

**Outcome-ID schemas, by book** (`bookmakerOutcomeId` on the v4 `/odds` response):

| Book | Class | Format | Decodable? |
|---|---|---|---|
| Pinnacle | sharp | `"home"`, `"draw"`, `"away"`, `"0.75/over"` (slash) | ✓ Already in parser (Pinnacle pre-existed) |
| Singbet  | sharp | `"IOR_RH/0.5 / 1"`, `"IOR_RC/0.5 / 1"`, `"IOR_HMH"` (cryptic mnemonic) | ✓ Per-book decoder (shipped E.5) |
| SBOBet   | sharp | `"h"`, `"a"` only — line in opaque `bookmakerMarketId` first segment | ✓ Price-proximity match against bet's Betfair odds (shipped E.5) |
| **Bet365** | **soft** | `"1179904266"` (opaque numeric, no semantic content) | ✗ Undecodable — but irrelevant: softs aren't sharp anchors |
| **1xBet** | **soft** | (not retested; same class as Bet365) | ✗ + irrelevant |

**Niche table — E.5 final (replaces the C-section Tier 1/2/3/Reserve table above):**

| Market | Pinnacle status | Free-tier supplement |
|---|---|---|
| AH | present, edge ≥ 5pp | Singbet + SBOBet (two-sharp confirmation) |
| AH | present, edge 3–5pp | Singbet only |
| AH | absent | Singbet (primary anchor) |
| **All other markets** | present | none — Pinnacle is the only sharp anchor for MO/OU/BTTS/corners/cards/halftime/team-total/etc. |
| All other markets | absent | none. Stays shadow until proves edge via Wilson 95% LCB on win-rate + CLV t-stat against the now-bias-corrected model (Bundle 5.B), then graduates via the existing `v_live_eligibility` two-path gate |

**Why dropped:**
- Bet365/1xBet are **softs**, not sharps — using them as edge anchors was a category error. The soft-edge prime directive says we find edge where softs mis-price *relative to sharps*, not by averaging soft prices into a "consensus".
- SBOBet line decode is brittle (opaque marketId) but the 25%-tolerance price-proximity matcher handles same-line lookups reliably. Deferred-then-shipped same day after seeing the full multi-line response.

**Why kept simple:**
- Phase 2 inversion (Bundle 5) will route ALL Pinnacle-covered markets as live-eligible candidates — including previously-banned ones (corners, cards, halftime, team-total). The current shadow flood is biased toward AH because the *pre-inversion* model finds AH-heavy candidates; that bias will disappear when Pinnacle's pricing drives placement instead.
- Singbet/SBOBet are AH specialists. They don't price MO/OU/BTTS broadly enough to be reliable anchors there. PINNACLE-ABSENT non-AH stays shadow until empirical proof — *not* until "we find another sharp for non-AH".

**Pinnacle fallback (E.5).** The 250/month free-tier budget is tight; bursts of qualifying candidates can exhaust it. When the free-tier path degrades — daily/monthly cap hit, key missing, decoder miss — the bet still has Pinnacle as its sharp anchor via the paid prefetch path (`pinnacle_odds_snapshots` rows with `bookmaker_slug='pinnacle'` already exist for every Pinnacle-covered fixture). `sharpAnchorFetch` returns `outcome='pinnacle_fallback'` in that case and logs at INFO level — acceptable degradation, not a failure. The "hard" degradation outcomes (`budget_exhausted` / `free_tier_disabled` / `fetch_failed`) now only fire when Pinnacle is ALSO absent (PINNACLE-ABSENT scope), at which point Bundle 5 Stage 2 demotes the candidate to shadow. Net: free-tier exhaustion never breaks placement when Pinnacle is present.

The Sections C / E.3 / F below remain as the original design rationale and original bookmaker trust-weight scaffolding. The actual shipped behaviour is governed by E.5.

---

## Bundle 0 evidence summary

Two billed OddspaPI requests settled the subscription question definitively:

1. **Default `/odds` call** (no `bookmakers=` param): returned 74 KB JSON, `bookmakerOdds` keys = `["pinnacle"]` only.
2. **Explicit `bookmakers=pinnacle,singbet,sbobet,bet365,1xbet,ps3838`**: returned `HTTP/2 403`, body:
   ```json
   {"error":{"message":"Restricted bookmaker(s).","code":"RESTRICTED_ACCESS",
     "details":"Restricted bookmakers: singbet, sbobet, bet365, 1xbet, ps3838.
                You do not have access to these bookmakers."}}
   ```
   `RESTRICTED_ACCESS` is per-bookmaker entitlement gating, not a rate or scope limit.

The catalog evidence (only `pinnacle` with `sample_count > 0` in `oddspapi_bookmaker_catalog`) was correct all along. The OddspaPI public marketing copy ("all 350+ bookmakers on the free tier") refers to *free-tier accounts*, not paid plans — paid plans are per-book à la carte.

## Operating model

| Bucket | Account | Plan | Monthly cap | Books we can ask for |
|---|---|---|---|---|
| **Bucket P** | Existing paid OddspaPI account | Pinnacle plan | 100,000 req/month | `pinnacle` (+ `pinnacle2`) — single-book responses |
| **Bucket F** | Separate free-tier OddspaPI account | Free | 250 req/month | All 350+ slugs subject to free-tier coverage policy |
| **Bucket A** | API-Football | Existing | 75,000 req/day | Lineups, injuries, referees, team stats, player data — NOT odds (different value entirely) |

Two buckets are independent. A free-tier call does not draw from the paid 100k Pinnacle budget. Free tier requires a separate API key in `.env` (proposed name: `ODDSPAPI_FREE_KEY`).

---

## A — Books currently being filtered out (audit)

**None at the paid plan level.** Bundle 3 fix (just shipped at commit `a209758`) already stops the api_football/oddspapi Pinnacle fallback from being used as actionable. With paid plan returning only Pinnacle, there are no other books in the response payload to discard. The "filtering out books we already paid for" hypothesis from the memo's first draft was wrong.

**At free-tier level we currently have nothing** because the account doesn't exist yet. Step 1 of implementation is to register it.

## B — Coverage gap analysis (from memo §C.1)

Recap (last 60 days, ≤12h to kickoff):

| Category | Leagues (selection) |
|---|---|
| **PINNACLE-LIVE** (≥60% coverage) | Bundesliga 69%, Primeira Liga 66%, MLS 61%, Liga I 63%, Primera C 61% |
| **PINNACLE-PARTIAL** (20–60%) | Premier League 44%, La Liga 54%, Serie A 53%, Ligue 1 39%, Primera División Spain 43% — most top leagues + ~30 others |
| **PINNACLE-ABSENT** (<20%) | League One UK 15%, USL League Two 2%, Druha Liga 0%, Liga II 10% |

Bucket F's 250 requests/month should target the **PINNACLE-PARTIAL gaps in top-league fixtures** (where Pinnacle didn't post but Singbet/SBOBet probably did) AND the **PINNACLE-LIVE high-conviction AH bets** (where Pinnacle did post and we want two-sharp cross-validation per R3 + G7).

## C — Surgical 250/month allocation

**Budget: 250 requests/month = ~8.3/day.**

Critical lever: one `/odds` call can request multiple bookmakers via `bookmakers=` (verified in Bundle 0 — the parameter accepts comma-separated lists). **One free-tier call returning `singbet + sbobet + smarkets + matchbook` is one request, not four.** This multiplies the effective budget by 4-5×.

**Per-fixture call pattern (proposed):**

```
GET /v4/odds?apiKey=$ODDSPAPI_FREE_KEY
  &fixtureId={...}
  &marketId={101|104}             # 1x2 or AH only
  &bookmakers=singbet,sbobet,smarkets,matchbook,ps3838,m8bet,cmd368,nova88
```

One call, eight sharp anchors. Across-fixture call routing:

| Fixture priority | Trigger | Calls/day |
|---|---|---|
| **Tier 1 — AH high-conviction** | Pinnacle ≥5pp identified-edge on AH market in PINNACLE-LIVE league | ~4 |
| **Tier 2 — AH medium-conviction** | Pinnacle 3–5pp identified-edge AH | ~2 |
| **Tier 3 — Non-AH cross-validation** | Pinnacle ≥3pp on MO/OU/BTTS in top-5 leagues | ~2 |
| **Reserve** | Held back for late-line opportunities + retry on failures | ~0.3 |

Total ≈ 8.3/day = 250/month. Above this, the system gracefully degrades to single-sharp (Pinnacle-only) gating with 0.5× Kelly per R3.

**Gating logic per G7:**
- Single-sharp (Pinnacle only, free-tier exhausted or fixture missed): `MIN_IDENTIFIED_EDGE = 3pp`, Kelly = 0.5× per R3 default.
- Two-sharp agreement (Pinnacle + ≥1 of Singbet/SBOBet within 1pp same direction): `MIN_IDENTIFIED_EDGE = 2pp`, Kelly = 1.0×.
- Three-sharp agreement (Pinnacle + Singbet + SBOBet, or equivalent): `MIN_IDENTIFIED_EDGE = 1.5pp`, Kelly = 1.0× (uplift 1.1× still flagged "ship on theory, no §A.3 data support yet").

Hard daily/monthly caps enforced in code:
- Daily: 9 calls (1-call buffer above the steady-state).
- Monthly: 250 calls (hard stop; route to "no_sharp_confirm" rejection beyond this).

## D — Single-call multi-book optimisation: verification step

Bundle 0 has not yet proven the free-tier `bookmakers=` filter returns multiple books in one response. Implementation Step 1 is the **Test 3 curl** from the earlier message:

```bash
# After registering free account and getting $FREE_KEY:
URL="https://api.oddspapi.io/v4/odds?apiKey=$FREE_KEY&fixtureId=id1000002361061671&marketId=101&bookmakers=pinnacle,singbet,sbobet,bet365"
curl -sS "$URL" -o /tmp/oddspapi_freetier.json
jq '.bookmakerOdds | keys' /tmp/oddspapi_freetier.json
```

Expected: `["bet365", "pinnacle", "singbet", "sbobet"]`. If only `["pinnacle"]` returns, free-tier marketing copy is misleading and Bundle 1 stops here — we'd need to escalate to OddspaPI support before any more work.

Verification step burns **1 free-tier request** (1/250). Worth it — every subsequent implementation choice depends on this answer.

## E — Parser wiring (the actual code work)

### E.1 New env var + new client
- Add `ODDSPAPI_FREE_KEY` to `.env` schema (read in `services/oddsPapi.ts` alongside existing `ODDSPAPI_KEY`).
- New `fetchOddsPapiFree<T>()` function — mirrors `fetchOddsPapi` but reads `ODDSPAPI_FREE_KEY`, tracks against separate budget counter (`api_usage.endpoint = 'oddspapi_free_*'`).
- New rate-limit guard: `canMakeOddspapiFreeRequest(n)` enforcing daily 9 / monthly 250.

### E.2 Generic sharp-odds storage
- **Option 1 (recommended): extend `pinnacle_odds_snapshots`** → rename to `sharp_odds_snapshots` and add `bookmaker_slug TEXT NOT NULL` column. Backfill `bookmaker_slug = 'pinnacle'` for existing 134k rows.
- Option 2: new table `sharp_book_snapshots` mirrored from `pinnacle_odds_snapshots` schema. Simpler but doubles the JOIN surface in downstream consumers.

Recommend Option 1. The existing `pinnacle_*` column names everywhere in code can stay as historical naming; new code uses the generic table.

### E.3 Free-tier consumer
- New service `services/sharpAnchorFetch.ts`:
  - Input: candidate fixture × market identified by valueDetection as edge candidate.
  - Decides whether to spend a free-tier call: passes G5/G6 (Pinnacle covers AND ≥3pp edge AND today's-budget-not-exhausted).
  - Calls `/v4/odds` with appropriate `bookmakers=` list (different for AH vs MO/OU).
  - Parses response; writes one row per (book × selection) to `sharp_odds_snapshots`.
  - Returns multi-book consensus to `valueDetection` for gating decision.

### E.4 Bookmaker slug → trust weight mapping
Add `agent_config.sharp_book_trust_weights` JSON with seed values:
- pinnacle: 1.0 (anchor)
- singbet: 0.95 (#1 AH sharp)
- sbobet: 0.90
- ps3838: 0.95 (Pinnacle twin)
- smarkets: 0.70 (exchange)
- matchbook: 0.65
- m8bet / cmd368 / nova88: 0.80
Operator-tuneable via `/api/admin/set-config`.

## F — Cross-validation gating wired into Stage 2

Per R3 + G7:

```
sharp_books_agreeing = count of (book in {pinnacle, singbet, sbobet, ps3838, m8bet, cmd368, nova88}
                       where |book_implied - pinnacle_implied| < 0.01
                       AND sign(book_edge_pp) == sign(pinnacle_edge_pp))

if sharp_books_agreeing >= 3 and identified_edge_pp >= 1.5:
    proceed, kelly_multiplier = 1.0   # uplift to 1.1 flagged but disabled
elif sharp_books_agreeing >= 2 and identified_edge_pp >= 2.0:
    proceed, kelly_multiplier = 1.0
elif sharp_books_agreeing == 1 and identified_edge_pp >= 3.0:
    proceed, kelly_multiplier = 0.5   # R3 down-size, theory default
else:
    reject "below_sharp_confirmation_threshold"
```

All four reasons logged to `compliance_logs` with `rejected_by_gate` enum (Bundle 6 work).

---

## G — Bonus: other free-tier endpoints worth using (Chris's "see what else is there")

OddspaPI v4 endpoint catalogue, ranked by potential value to the model on the 250-request budget:

| Endpoint | What it returns | Value to us | Worth allocating? |
|---|---|---|---|
| **`/v4/historical-odds`** | Past line movements per fixture | Collapses our multi-pass closing-line backfill into ONE call per settled fixture. Also gives us complete pre-game line trajectory for §D Step 2 decomposition. | **YES** — biggest single leverage. Allocate ~30 requests/month: triggered nightly for top-tier settled-yesterday fixtures. |
| **`/v4/odds-by-tournaments`** | Bulk odds filtered by competition IDs | One call returns ALL fixtures × ALL books for a competition. Premier League matchday = 1 call instead of 5-10 per-fixture calls. **5× budget amplification** if it works with `bookmakers=` filter. | **YES** — allocate ~10/month for top-5 league matchdays. Verify in implementation Step 1 it accepts `bookmakers=`. |
| **`/v4/settlements`** | Match results / payouts | Currently sourced from API-Football. Deduplicating here frees API-Football budget for feature backfill (G6 priority list). | **MAYBE** — depends on free-tier latency. If results land within 1h of full-time, allocate 10-20/month for top-fixture settlement; otherwise skip and keep API-Football for results. |
| **`/v4/scores`** | Final scores | Same as `/settlements`. | **NO** — API-Football already covers this reliably; not worth a free-tier slot. |
| **`/v4/fixtures`, `/v4/fixture`** | Fixture metadata | We have this via `oddspapi_fixture_map`. | **NO**. |
| **`/v4/leagues`, `/v4/tournaments`, `/v4/sports`, `/v4/markets`, `/v4/participants`** | Reference metadata | Self-discovered or one-off. | **NO**. |
| **`/v4/account`, `/v4/refresh-api-key`** | Account ops | One-off. | **NO**. |

**Revised 250/month budget:**

| Use | Calls/month | % |
|---|---|---|
| Sharp-anchor fetches (per-fixture, multi-book) | 200 | 80% |
| `/historical-odds` for CLV backfill (~1 per top-tier settled fixture/day) | 30 | 12% |
| `/odds-by-tournaments` for top-5 matchdays (5 leagues × 1-2/month) | 10 | 4% |
| `/settlements` results dedup (if proven faster than API-Football) | 10 | 4% |

**Endpoints OddspaPI does NOT offer:** injuries, referees, lineups, team stats, player performance. **API-Football remains the only source for the feature-backfill work in memo §G.** OddspaPI free tier is not a substitute for API-Football; it is purely a sharp-anchor + line-history layer.

---

## Implementation steps (in order, after approval)

1. **Chris registers free OddspaPI account.** Different email from the paid account. Save the free API key in `~/Football-betting-agent/.env` as `ODDSPAPI_FREE_KEY=...`. Restart api-server + worker-data so it loads.
2. **Verification curl (D above).** I run from the VPS once Chris confirms the env var is in place. ~1 free-tier request consumed. Expected: 4 bookmaker keys returned.
3. **If verification passes:** I draft code changes for E.1 → E.4. New commit, push, deploy via canonical block. Verify in production that `sharp_odds_snapshots` is receiving non-Pinnacle rows.
4. **Wire F into Stage 2 of placement pipeline.** Happens AS PART OF Bundle 5 inversion pipeline build (Bundle 5 spec depends on this multi-book gating logic). Same code change.
5. **Backfill historical-odds endpoint** (G row 1) for the §D CLV decomposition work. Separate cron job sized at ~1/day for top-fixture settled-yesterday.
6. **`/odds-by-tournaments` test** (G row 2) — 1 free-tier request to verify it accepts `bookmakers=`. If yes, replace per-fixture sharp fetches on top-league matchdays.

## Verification (end-to-end)

After each implementation step:
- `SELECT COUNT(*), bookmaker_slug FROM sharp_odds_snapshots WHERE captured_at >= NOW() - INTERVAL '1 hour' GROUP BY 2;` — confirms multi-book writes.
- `SELECT date::date, SUM(request_count) FROM api_usage WHERE endpoint LIKE 'oddspapi_free%' GROUP BY 1;` — confirms free-budget burn is under 9/day.
- Sample placement decision: pick a Tier-1 fixture, dump the compliance_logs row, confirm `sharp_books_agreeing` reflects the multi-book input.

## Out of scope

- Upgrading the paid plan to include more bookmakers. Per-bookmaker pricing not investigated yet; if Chris wants this we'd need OddspaPI's per-bookmaker price list.
- Other sharp data sources (BetBurger, RebelBetting, etc.). Out of scope until OddspaPI's free-tier coverage is empirically known.
- WebSocket streaming. Paid feature; not needed for Bundle 1.

## Approval ask

Need explicit go from Chris on:
1. Register the second OddspaPI free account (Chris's task — 5 min).
2. Plan structure above (this doc).
3. Implementation step ordering.
4. Trust weights seed values (Section E.4) — operator-set so technically just an initial value, but worth a sanity-check.

I will NOT touch code until items 1-3 are approved.
