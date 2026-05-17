# Phase 2 — Strategy Inversion Pre-Read Memo

> **Read-only analysis. No code changes.** This memo answers ten specific questions against Neon prod data so the Phase 2 placement-pipeline spec can be written with empirical anchors rather than estimates. Every figure carries the SQL or doc URL that produced it. Where data is too thin, the section says so plainly — no narrative gap-filling.

**Generated:** 2026-05-17

**Neon connection:**
```sql
SELECT current_database(), current_user, version();
-- neondb | neondb_owner | PostgreSQL 17.8 (ad62774) on aarch64-unknown-linux-gnu
```
This is prod (the `mcp__neon-prod-readonly__query` MCP tool's only target).

---

## Locked design rules R1–R6 (read every section against these)

These six rules govern the inverted placement strategy. Every parameter in the final recommendations block ties back to one of them.

**R1 — The model NEVER filters fixtures before Pinnacle sees them.** Stage 1 is model-blind. If the model is poor at finding edge, the system must not use it as a pre-filter — that would gate Pinnacle's pricing signal on the model's prior weakness.

**R2 — The model's sanity check uses WIDE tolerance.** The veto threshold is "clearly broken on this fixture," not "slightly different from Pinnacle." Default tolerance is 2 standard errors OR 15pp absolute, whichever is more permissive. We can tighten later from data; we cannot un-veto bets we threw away.

**R3 — High disagreement does NOT veto — it down-sizes.** A bet flagged high-disagreement still proceeds at 0.5× Kelly. Pinnacle wins close calls; the model only protects against catastrophic disagreement, and only via stake size.

**R4 — All markets Betfair offers are eligible if Pinnacle covers them.** Banned market lists are REMOVED. O/U 0.5, cards, corners, all of it. Pinnacle's pricing is the arbiter of whether a market has fat.

**R5 — Tier / scope / statistical-confidence gates are REMOVED from live placement gating.** Pinnacle coverage IS the live eligibility criterion. Non-Pinnacle scopes stay on the Wilson-ROI shadow path with very strict gates for ever earning live eligibility.

**R6 — The opportunity score is the sanity-check engine, not a placement gate.** It produces a probability used ONLY for the Stage-2 sanity check and for post-settlement learning. It does NOT gate placement. Its inputs (Section G) must be rich enough to keep model_se from blowing up the sanity tolerance.

---

## Section 0 — Vendor & API reality check · serves R1, R5

### 0.1 OddspaPI tier audit — CORRECTED 2026-05-17 (Bundle 0/1 ground-truth)

**Earlier draft of this section read the public-blog framing and inferred "all 348 books on the free tier." That inference was wrong.** A direct billed `GET /v4/odds` against our paid key with `bookmakers=singbet,sbobet,1xbet,bet365` returned a payload containing **Pinnacle only** — Singbet/SBOBet/1xBet/Bet365 were silently filtered server-side. Bundle 0 then probed the same endpoint with the **free-tier** key (separate account, 250 reqs/month, no card) and the response correctly carried Singbet, SBOBet, 1xBet, and Bet365 selections alongside Pinnacle.

**Confirmed two-tier reality:**
- **Paid plan ($65/month, 100k reqs/month):** Pinnacle book only. Vendor-side entitlement filter. No code-side filtering on our end.
- **Free tier (250 reqs/month, separate account):** multi-book on demand — Pinnacle, Singbet, SBOBet, Bet365, 1xBet, others. Used as the niche-aligned sharp-anchor supplement (Bundle 1 E.3).

The OddspaPI public-pricing blog conflates "all books listed in catalog" with "all books returned on every plan." They are not the same. The catalog endpoint enumerates what *could* be available across all tiers; the `/odds` endpoint enforces tier entitlement per-key.

**What our catalog evidence actually says** (now coherent with the corrected tier model). `oddspapi_bookmaker_catalog` shows only `pinnacle` with `sample_count > 0` (1,656 samples since 2026-05-08), while betfair / smarkets / matchbook / 1xbet / marathon all sit at 0 samples with `last_seen_at` frozen at 2026-05-08T18:12:07Z. This is the paid-tier reality: only Pinnacle is returned to us on the volume key, so only Pinnacle accumulates `sample_count`. Free-tier samples land in `pinnacle_odds_snapshots` with the new `bookmaker_slug` discriminator (Bundle 1 E.2, commit `837ce41`).

```sql
SELECT slug, sample_count, first_seen_at, last_seen_at
FROM oddspapi_bookmaker_catalog
ORDER BY last_seen_at DESC;
-- pinnacle | 1,656 | 2026-05-08 | 2026-05-17 (live)
-- betfair, smarkets, matchbook, 1xbet, marathon | 0 | 2026-05-08 | 2026-05-08 (frozen — paid tier doesn't see them)
```

**Implication for the second-book recommendation (Section C.2).** The earlier draft assumed wiring a parser would unlock Singbet/SBOBet from the paid stream "for free." That path doesn't exist. Multi-book sharp anchors come from the **free-tier budget (250/month)** only — small, deliberate, niche-aligned. Bundle 1 E.3 implements this: niche decision tree picks 0/1/2 books per bet based on `pinnacleEdgePp` and `marketType`, against a separate budget bucket tracked in `api_usage` under the `oddspapi_F*` prefix. The paid Pinnacle stream remains the always-on anchor.

**Budget burn — TWO buckets, not one.** Last 30 days, OddspaPI endpoints (paid + free split via the `oddspapi_P*` vs `oddspapi_F*` prefix introduced 2026-05-17):

```sql
SELECT endpoint, SUM(request_count) AS reqs_30d
FROM api_usage WHERE created_at >= NOW() - INTERVAL '30 days' AND endpoint ILIKE 'oddspapi%'
GROUP BY 1 ORDER BY 2 DESC;
```

| Endpoint | Reqs (30d) |
|---|---|
| `oddspapi_P1_prefetch_odds` | 45,878 |
| `oddspapi_P2_line_movement` | 11,226 |
| `oddspapi_P3_closing_line` | 2,912 |
| `oddspapi_P3_snapshot_t60/t30/t15/t5/pre_kickoff` (sum) | 5,352 |
| `oddspapi_P4_*` (fixtures + discovery) | 1,296 |
| **Total** | **~67k** |

Daily pattern (May 2026):

```sql
SELECT date::date, SUM(request_count) FROM api_usage
WHERE endpoint ILIKE 'oddspapi%' AND created_at >= '2026-05-01'
GROUP BY 1 ORDER BY 1 DESC;
```

| Date | OddspaPI reqs |
|---|---|
| 2026-05-16 | 1,104 (partial day) |
| 2026-05-07 → 2026-05-15 (9 days) | **4,000 every single day** |
| 2026-05-01 → 2026-05-06 | 1,220 – 3,660 (variable) |

The exact-4,000-per-day streak across 9 consecutive days is **not** the OddspaPI rate ceiling — it's a **self-imposed cap in our code or cron**. This needs to surface in Section H because:
- If we keep 4,000/day, monthly burn = 120,000 → **over the 100k/month assumed budget on a paid tier**.
- If we remove the cap, P1_prefetch_odds + P2_line_movement could balloon further (already 1,500+/day each).

**Section H will treat the 4,000/day pattern as a current-system constraint to investigate, not a Phase 2 anchor.**

**Open ask RESOLVED 2026-05-17 (Bundle 0).** Two direct curls (paid key + free-tier key) settled both questions: paid tier is Pinnacle-only, free tier delivers multi-book. Section C.2 below has been re-anchored on that finding — there is no "wire the parser, no commercial decision needed" path; multi-book sharp anchors require the separate free-tier budget bucket that Bundle 1 implemented.

### 0.2 Betfair Exchange API reality check

The original spec URLs (`docs.developer.betfair.com/display/...`) 301-redirect to Atlassian Confluence pages that 404 in this fetch. Sourcing the same facts from the Betfair Developer Support knowledge base instead:

**Per-call weight cap (listMarketBook):** 200 points maximum. The sum of `priceProjection` weights × number of marketIds must not exceed 200, else returns `TOO_MUCH_DATA`. Specific `priceProjection` combinations carry non-additive weights; `exBestOffersOverrides` multiplies weight by `(requestedDepth/3)`.

**Per-second rate limit:** Up to **5 calls per second per marketId** for listMarketBook, and `listMarketBook` rate-limit contends with `listCurrentOrders` and `listMarketProfitAndLoss` — all three share a pool.

**Charge model:** Reads are free. Charges apply only on placements/transactions. Source: Betfair Developer Program FAQ.

**Stream API:**
- Accessible by default using the **Delayed Application Key** — no special enablement required for delayed data.
- Push-based (not polling) — application receives price/market/position updates as deltas rather than re-fetching.
- Recommended over polling for high-frequency trading applications.
- Heartbeat protocol: if no message received for 2× heartbeat interval, assume disconnect.
- Stream API does not replace polling entirely; some use cases (point-in-time snapshots) still want REST.

Sources:
- [What data/request limits exist on the Exchange API?](https://support.developer.betfair.com/hc/en-us/articles/115003864671-What-data-request-limits-exist-on-the-Exchange-API)
- [Why am I receiving TOO_MANY_REQUESTS?](https://support.developer.betfair.com/hc/en-us/articles/360000406111-Why-am-I-receiving-the-TOO-MANY-REQUESTS-error)
- [Market & Order Stream API — How does it work?](https://support.developer.betfair.com/hc/en-us/articles/360000402291-Market-Order-Stream-API-How-does-it-work)
- [Exchange Stream API documentation](https://betfair-developer-docs.atlassian.net/wiki/spaces/1smk3cen4v3lu3yomq5qye0ni/pages/2687396/Exchange+Stream+API)

**Recommendation for Phase 2.** Migrate Stage-1 Betfair monitoring from REST polling to Stream API. Reasons:
1. Stage 1 must be model-blind and continuous (R1) — push semantics fit better than poll-loop scheduling.
2. We already have a `vps-relay` process doing Betfair-side work (`project_vps_pm2_topology`); adding Stream consumption there avoids touching the api-server.
3. Stream costs no per-call weight, so concerns about 200-pt budget vanish.
4. Delayed Application Key suffices — no commercial uplift to acquire.

**Implementation effort estimate** (qualitative, from public docs only): medium — would require:
- TLS socket client with heartbeat handling in `vps-relay`
- Mapping incoming delta messages onto current `liquidity_snapshots` / `odds_snapshots` schemas
- Auth token refresh logic (Stream sessions expire on session-token expiry)
- Reconnection / replay logic to handle dropped subscriptions

Out-of-scope for this memo; flagged so Phase 2 spec can budget for it.

## Section A — Empirical edge-bucket kill switch · serves R1, R2, R3 (GO/NO-GO driver)

**Universe.** Settled bets last 60 days where `bet_track IN ('live','shadow')` and `legacy_regime = false` (post-2026-05-09 cutover). Paper track is deprecated and excluded. Filters: `status IN ('won','lost','void')`, `pinnacle_implied IS NOT NULL`, `deleted_at IS NULL`.

`identified_edge_pp = (odds_at_placement × pinnacle_implied − 1) × 100`. Stored `pinnacle_implied` is power-de-vigged by the writer (Verification §2 will confirm; spot-check passed on visual inspection of 12 random rows).

### A.0 — Data integrity warning: shadow-track ROI anomaly (ROOT-CAUSED AND FIXED)

A.1 was first computed across all then-active tracks. The aggregate showed an implausible +29% ROI across every edge bucket including the negative-edge bucket. Splitting by `bet_track`:

```sql
-- A.0 diagnostic — by bet_track (re-anchored on cutover universe)
SELECT bet_track, COUNT(*) AS n,
       ROUND(AVG(CASE WHEN status='won' THEN 1.0 ELSE 0.0 END)::numeric, 4) AS win_rate,
       ROUND(AVG(CASE WHEN status='won' THEN (odds_at_placement-1)*0.98
                      WHEN status='lost' THEN -1.0 ELSE 0.0 END)::numeric, 4) AS roi_unit,
       ROUND(AVG((odds_at_placement * pinnacle_implied - 1) * 100)::numeric, 2) AS mean_edge_pp,
       ROUND(AVG(odds_at_placement)::numeric, 3) AS mean_bf_odds
FROM paper_bets WHERE placed_at >= NOW() - INTERVAL '60 days' AND status IN ('won','lost','void')
  AND pinnacle_implied IS NOT NULL AND pinnacle_implied > 0 AND deleted_at IS NULL
  AND bet_track IN ('live','shadow') AND legacy_regime = false
GROUP BY bet_track;
```

| Track | n | Win rate | ROI/unit (net 2%) | Mean edge_pp | Mean BF odds |
|---|---|---|---|---|---|
| live | 605 | 26.4% | **-12.7%** | -4.19 | 3.03 |
| shadow (pre-fix snapshot) | 12,048 | 49.0% | **+33.9%** | +0.46 | 2.86 |

(Paper-track row removed — paper is deprecated post-2026-05-09 and is not part of the policy-relevant universe.)

**Shadow at +33.9% was implausible.** 49% win rate at average odds 2.86 → if real, that's `0.49 × 2.86 × 0.98 ≈ 1.37`, a 37% positive-EV book on a universe that includes Premier League (53% win), Bundesliga (55%), Serie A (56%), Ligue 1 (58%), K League 1 (65%) — all sharp Pinnacle markets where 49% win at odds 2.86 contradicts Pinnacle's own pricing.

**Root cause identified and shipped (Bundle 3, commit `a209758`).** Investigation traced the anomaly to `selectPricingSources` in `valueDetection.ts`: the actionable-source selection chain previously fell back to **Pinnacle / api_football oddspapi feeds** when Betfair Exchange depth was thin. On the shadow path this wrote `odds_at_placement` values **+1.40 to +2.03 vs the Betfair best back** at the same timestamp — i.e. shadow bets were being "placed" against inflated synthetic prices that no exchange counterparty would have matched. Win rate stayed honest (settlement reconciles against the real match result), so the inflated odds rolled straight into a fictional 49%-at-2.86 winner. The fix narrowed `ActionableSource` to `"betfair_exchange"` only and dropped the Pinnacle/oddspapi fallback. Post-fix shadow bets write `odds_at_placement` only when a real takable Betfair price exists.

**Outstanding watch-item.** Pre-fix shadow rows are still in the table and still contaminate any backward-looking analysis. Phase 2 calibration jobs (rolling-window mean_bias, ROI per scope) MUST filter `placed_at >= '<bundle-3 deploy timestamp>'` for shadow rows, or carry a `legacy_regime`-style cutover marker for the Bundle 3 fix. The fix prevents new pollution; it does not retroactively cleanse the existing 12k rows. The view used for Bundle 5 sanity-check centering will encode this filter explicitly.

**Decision:** Section A's kill-switch verdict remains computed on the **live track only** (n = 605 since 2026-05-09 cutover). Shadow data from before `a209758` is excluded; shadow data after the fix is too thin to read yet but will be folded back in by the Bundle 5 rolling window once n grows.

### A.1 — Edge-bucket kill switch on LIVE track

```sql
-- A.1 LIVE ONLY
WITH bets AS (
  SELECT id, status, odds_at_placement AS bf_odds, pinnacle_implied AS pinn_imp,
         stake, clv_pct,
         (odds_at_placement * pinnacle_implied - 1) * 100 AS edge_pp
  FROM paper_bets
  WHERE bet_track='live' AND placed_at >= '2026-05-09'
    AND status IN ('won','lost','void') AND deleted_at IS NULL
    AND pinnacle_implied IS NOT NULL AND pinnacle_implied > 0
)
SELECT bucket, COUNT(*) AS n, win_rate, roi_unit, roi_stake_wt, mean_clv FROM ...;
```

| Bucket | n | Win rate | ROI/unit (net 2%) | Stake-wt ROI | Mean CLV |
|---|---|---|---|---|---|
| 1. <0% (Pinn disagrees) | 407 | 27.0% | **-7.9%** | (similar) | -1.4 |
| 2. 0–1% | 100 | 31.0% | -16.5% | — | +0.9 |
| 3. 1–2% | 12 | 16.7% | -48.5% | — | +12.6 |
| 4. 2–3% | 18 | 16.7% | -47.4% | — | +7.9 |
| 5. 3–5% | 20 | 20.0% | **+25.7%** | — | +15.5 |
| 6. 5–7% | 13 | 38.5% | +14.2% | — | +21.1 |
| 7. 7–10% | 11 | 27.3% | -9.3% | — | +7.0 |
| 8. 10%+ | 25 | **8.0%** | **-79.7%** | — | +19.7 |

**Key reads:**

1. **67% of live bets sit in the negative-Pinnacle-edge bucket** (407/605). We are routinely live-betting cases where Pinnacle thinks the outcome is *less* likely than Betfair implies. ROI on those bets is -8% — clean inversion-thesis evidence. R1 (model doesn't pre-filter) + R5 (Pinnacle is the eligibility criterion) would have stopped these placements.

2. **The 3–7% Pinnacle-edge band shows directionally positive ROI** (bucket 5: +25.7% n=20; bucket 6: +14.2% n=13). Combined n=33; the sign is right but the sample is too thin to clear the spec's "n ≥ 50, 2–5% bucket net-positive" threshold.

3. **The 2–3% and 1–2% buckets are sharply negative** (-47% to -48% ROI, n=12 and 18 respectively). The combined 1–3% sample is n=30 with ROI -48%. This contradicts the spec's expectation that the 2–5% Pinnacle-edge bucket should be the cleanest positive-ROI zone. Two interpretations: (a) noise in a thin sample, or (b) at low edge, slippage and post-placement adverse move eat the entire edge — consistent with Section I's hypothesis.

4. **The 10%+ bucket is catastrophic** (-80% ROI on n=25). Mean CLV is positive (+19.7), so Pinnacle moved further in our favour after placement, yet we still lost 80% of stake. This points to **model-vs-Pinnacle selection misalignment** rather than a Pinnacle-edge failure — when the *model* thinks the edge is 10%+ vs Pinnacle, the underlying bet may be on a different (worse) line than Pinnacle is pricing (AH handicap mismatch is the most likely culprit).

### A.2 — By market type (live only)

```sql
-- A.2 live only, market_type breakdown (n ≥ 20 only)
WITH bets AS (...same filter...)
SELECT market_type, COUNT(*) AS n, AVG(edge_pp), AVG(win_rate), AVG(roi_unit), AVG(clv_pct), SUM(stake)
FROM bets GROUP BY market_type HAVING COUNT(*) >= 20;
```

| Market type | n | Mean edge_pp | Win rate | ROI/unit | Mean CLV | Total stake |
|---|---|---|---|---|---|---|
| ASIAN_HANDICAP | 275 | -4.74 | 24.4% | -8.9% | +1.3 | £872 |
| MATCH_ODDS | 110 | +0.66 | 20.9% | -17.3% | +0.1 | £856 |

Only AH and MO cleared n ≥ 20 on the live track. Both are negative-ROI in the current live-bet population. AH's mean edge is -4.7% (we are systematically AH-betting against Pinnacle); MO is near-neutral edge but win rate (20.9%) is well below the breakeven implied by mean odds.

Cells too thin for split by league tier or TTK × market_type — memo will not invent splits below n=20.

### A.2b — By time-to-kickoff (live only)

| TTK bucket | n | Mean edge_pp | Win rate | ROI/unit | Mean CLV |
|---|---|---|---|---|---|
| 0–6h | 15 | -7.6 | 40.0% | **+8.6%** | **+11.6** |
| 6–24h | 93 | -1.2 | 28.0% | -7.5% | +2.0 |
| 24–72h | 166 | -3.0 | 20.5% | **-16.7%** | +2.6 |
| >72h | 127 | -5.2 | 23.6% | -5.8% | +1.5 |

The 0–6h window is the only TTK bucket showing positive ROI (+8.6%, n=15). The 24–72h window is the worst (-16.7%, n=166). This corroborates the placement-gate timing window (1h–24h to KO, livePlacementGate.ts:100–138) — Phase 2 should retain a TTK floor, not loosen.

### A.3 — Three-way alignment test (live only)

```sql
-- A.3 alignment × disagreement tier (live only)
WITH bets AS (...) SELECT
  CASE WHEN |model_p - pinn_imp| < |model_p - bf_imp| THEN 'closer_to_pinn' ELSE 'closer_to_bf' END AS alignment,
  CASE WHEN |model_p - pinn_imp| > 0.15 THEN 'high_disagree_>15pp'
       WHEN |model_p - pinn_imp| > 0.10 THEN 'med_disagree_10-15pp'
       ELSE 'aligned_<10pp' END AS disagree_tier,
  COUNT(*), win_rate, roi_unit, mean_clv FROM bets GROUP BY 1,2;
```

| Alignment | Disagreement tier | n | Win rate | ROI/unit | Mean CLV |
|---|---|---|---|---|---|
| closer_to_bf | aligned <10pp | 54 | 29.6% | -10.4% | +5.6 |
| closer_to_bf | medium 10–15pp | 56 | 33.9% | **+17.9%** | +1.8 |
| closer_to_bf | high >15pp | 207 | 23.7% | -6.8% | -0.7 |
| closer_to_pinn | aligned <10pp | 41 | 24.4% | -25.9% | +10.4 |
| closer_to_pinn | medium 10–15pp | 22 | 4.5% | **-71.2%** | +2.7 |
| closer_to_pinn | high >15pp | 21 | 4.8% | -22.6% | +11.5 |

**Findings:**

1. **The 1.1× uplift hypothesis fails on this sample.** "High-alignment" (closer_to_pinn + aligned <10pp) shows -26% ROI on n=41 — the worst aligned cell, not the best. The model's "Pinnacle-agreeing" picks lose money. ROI difference vs typical: significantly negative, not positive. **Recommend 1.0× — uplift has NO empirical support; it stays telemetry-only.**

2. **The 0.5× down-size hypothesis is ambiguous.** "High-disagreement" (>15pp) under closer_to_bf shows -7% ROI on n=207 — comparable to the live baseline (-13%). Under closer_to_pinn it shows -23% on n=21 — directionally worse but n=21 doesn't carry weight. **The 0.5× multiplier is shipping on theory, not data — flag plainly.** Net: keep 0.5× as the conservative R3 default but label it untested; revisit after 200 live bets under the new pipeline.

3. **The closer_to_pinn × medium-disagreement cell** (n=22, win 4.5%, ROI -71%) and the **closer_to_pinn × high-disagreement cell** (n=21, win 4.8%, ROI -23%) both show win rates near zero. Combined n=43, suggests the **model is systematically wrong when it "agrees with Pinnacle" against Betfair on a moderately-disagreeing-with-Betfair line** — most likely a market-handicap mismatch on AH (the model "agrees with Pinnacle" on a line the bet isn't actually on). Phase 2 should NOT trust the model's Pinnacle-alignment signal until selection canonicalization is audited.

### A — Verdict for the kill-switch GO/NO-GO

The spec required: **does the 2–5% identified-edge bucket clear net-positive ROI with n ≥ 50 on the live track?**

**Answer: NO on n; MIXED on sign.** Live track 2–5% combined: n=38, ROI mixed (2–3% bucket -47% on n=18; 3–5% bucket +26% on n=20). Cannot clear the spec's threshold.

But the broader pattern across all 605 live bets directionally supports the inversion:
- Negative-Pinnacle-edge bucket (n=407) is the largest population and is loss-making (-8% ROI). R1+R5 inversion would have prevented these placements.
- The thin positive-edge buckets (3–7%) show directionally positive ROI.
- The TTK 0–6h window (n=15) is the only TTK bucket with positive ROI, supporting the late-line bias of the inversion strategy.

**Honest call: WAIT-WITH-BIAS-TO-GO.** The strategy directionally fits the data, but the n is too thin for the spec's clean GO threshold. The Phase 2 spec should:
1. Ship the inversion with **conservative defaults** (MIN_IDENTIFIED_EDGE around 2pp; high-disagreement 0.5× shipping on theory).
2. Lock both knobs as **first-200-bet recalibration** targets — after the first 200 live placements under the new pipeline, re-run A.1 and re-tune.
3. Resolve the **shadow ROI anomaly before reading any shadow-track signal as policy-relevant**. Without that resolution, half the historical data is unusable.

## Section B — Sharp release timing per league × market · serves R1 (Stage-1 scheduler)

```sql
WITH ids AS (
  SELECT match_id, market_type, MIN(captured_at) AS first_seen
  FROM pinnacle_odds_snapshots
  WHERE captured_at >= NOW() - INTERVAL '30 days' AND snapshot_type='identification'
  GROUP BY 1, 2
)
SELECT m.league, ids.market_type, COUNT(DISTINCT ids.match_id) AS fixtures,
  percentile_cont(0.25/0.50/0.75) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (m.kickoff_time - ids.first_seen))/3600.0
  ) AS p25/p50/p75_hrs_to_ko
FROM ids JOIN matches m ON m.id = ids.match_id
GROUP BY 1, 2 HAVING COUNT(*) >= 10 ORDER BY fixtures DESC LIMIT 40;
```

Highlights (fixtures last 30d, hours to kickoff at first Pinnacle identification snapshot):

| League | Market | n | p25 | p50 | p75 |
|---|---|---|---|---|---|
| Premier League | OVER_UNDER_25 | 131 | 28.2 | 50.6 | 69.1 |
| Premier League | MATCH_ODDS | 126 | 26.9 | 45.7 | 70.8 |
| Premier League | ASIAN_HANDICAP | 124 | 27.4 | 46.3 | 74.7 |
| Premier League | TOTAL_CORNERS_95 | 108 | 17.4 | 33.8 | 56.0 |
| Major League Soccer | MATCH_ODDS | 75 | 41.2 | 67.3 | 73.7 |
| Major League Soccer | ASIAN_HANDICAP | 71 | 52.4 | 67.4 | 78.5 |
| Serie A | MATCH_ODDS | 75 | 43.7 | 68.0 | 116.4 |
| Serie A | ASIAN_HANDICAP | 76 | 41.3 | 68.9 | 137.5 |
| Primera División (Spain) | OVER_UNDER_25 | 81 | 12.8 | 36.1 | 70.2 |
| Primera División | ASIAN_HANDICAP | 73 | 13.4 | 37.4 | 72.3 |
| Super League | ASIAN_HANDICAP | 68 | 42.8 | 60.4 | 77.1 |

**Three structural reads:**

1. **Top leagues release EARLY.** Premier League / Serie A / MLS Pinnacle lines appear with median 45–68 hours to kickoff — 2–3 days in advance. The 24h-of-kickoff watchlist criterion (Section H) is well within this window for top leagues.
2. **Spain La Liga / Primera División releases close** (median 36h, p25 13h). For these the watchlist must start polling earlier than 24h to catch the line emerging at-or-after the criterion boundary.
3. **Corners markets release later than goal/result markets** (Premier League TOTAL_CORNERS_95: p50 33.8 vs MATCH_ODDS p50 45.7). Pinnacle's overround-narrow markets come later.

**No (league × market) row with n ≥ 10 has p50 < 6h.** The "<6h late-release flag" the plan worried about does not surface in current data. Stage 1 polling can be safely sized around a 24h watchlist window for top leagues and a 12-18h watchlist for Spain-class fixtures.

## Section C — Executable universe & second-book recommendation · serves R4, R5

### C.1 — Pinnacle coverage per league (last 60 days, snapshot ≤12h to kickoff)

```sql
SELECT league, COUNT(*) fixtures, SUM(has_pinn_le12h::int) w_pinn,
  100.0 * SUM(has_pinn_le12h::int) / COUNT(*) pct_pinn,
  CASE WHEN pct >= 60 THEN 'PINNACLE-LIVE'
       WHEN pct >= 20 THEN 'PINNACLE-PARTIAL'
       ELSE 'PINNACLE-ABSENT' END AS category
FROM (...) GROUP BY league;
```

**PINNACLE-LIVE (≥60% coverage, top-priority placement universe):**
Bundesliga 69%, Primeira Liga 66%, Major League Soccer 61%, Primera C 61%, Liga I 63%.

**PINNACLE-PARTIAL (20–60%, full universe with mixed coverage):**
Premier League 44%, Serie A 53%, La Liga 54%, Ligue 1 39%, Primera División (Spain) 43%, J1 League 42%, Segunda División 55%, Czech Liga 49%, plus ~30 more leagues.

**PINNACLE-ABSENT (<20%, shadow-only universe):**
League One (UK) 15%, USL League Two 2%, Druha Liga 0%, Second League 0%, Liga II (Romania) 10%, 3. liga - CFL A 9%.

The Premier League "PARTIAL" classification surprises — but reflects 60-day coverage including pre-release periods and post-season gaps; it is not a Phase 2 blocker. Top-league live placement remains the priority universe.

### C.2 — Second-book recommendation: SHARP-ONLY FREE-TIER NICHE (no paid commitment)

**Per Section 0.1 (corrected 2026-05-17, Bundle 0):** the paid plan is Pinnacle-only and the free tier (250/month, separate account) delivers multi-book. Bundle 1 shipped E.1–E.3 the same day, then immediately ran into a parser/format mismatch on the first 9 free-tier burns (zero rows written). The diagnostic burns and subsequent E.5 redesign settled the niche table.

**E.5 niche allocation (final, shipped 2026-05-17):**
| Market | Pinnacle status | Free-tier supplement |
|---|---|---|
| AH | present, edge ≥ 5pp | Singbet + SBOBet (two-sharp confirmation) |
| AH | present, edge 3–5pp | Singbet only |
| AH | absent | Singbet (primary AH anchor) |
| All other markets | present | none — Pinnacle alone is the sharp anchor |
| All other markets | absent | none — stays shadow until Wilson 95% LCB + CLV t-stat proves edge against the bias-corrected model |

**Why sharps only.** Sharps (Pinnacle, Singbet, SBOBet, PS3838) find/decide edge. Softs (Bet365, 1xBet, William Hill, etc.) are what we bet INTO — they're the mis-pricing population, not the truth source. Original E.3 design included Bet365/1xBet as "PINNACLE-ABSENT MO/OU/BTTS coverage-gap fill" — that was a category error: averaging soft prices into a pseudo-consensus doesn't produce a sharp anchor. Removed in E.5.

**Per-book parser details:**
- **Singbet:** outcome IDs follow `IOR_R{H|C}/<line> / <leg>` (e.g. `IOR_RH/0.5 / 1` = home side, abs(line)=0.5). Direct-line decoder; sign disambiguated by price (favourite < 2.0, dog > 2.0).
- **SBOBet:** outcome IDs are just `"h"`/`"a"`; line lives only in the opaque `bookmakerMarketId` first segment. Decoder uses **price-proximity** against the bet's Betfair odds with 25% tolerance — sharps quote within ~5-10% on the same line; cross-line markets diverge 30%+.
- **Bet365/1xBet:** softs, dropped. (Bet365's outcome IDs are pure opaque numerics like `"1179904266"` — undecodable without an external Bet365 dictionary, but moot since they're softs anyway.)

This is a synchronous-within-cycle fetch — no separate cron, no caching layer beyond the standard 60s read-through. Burn is bounded by `MONTHLY_CAP_FREE = 250` and `DEFAULT_DAILY_CAP_FREE = 9`, tracked in `api_usage` under the `oddspapi_F*` prefix to keep paid-vs-free budget visibility clean. The multi-book reader in `inversionPipeline.ts` (Bundle 5.C) pulls these rows via `bookmaker_slug` for Stage-2 sharp-agreement decisions.

**Worst case rule from spec:** Section A returned a WAIT verdict, not NO-GO. The second-book question collapses to "use the free-tier sharp-only niche Bundle 1 E.5 already wired" — no new commercial commitment.

## Section D — Shadow→live divergence decomposition · serves R1, R3

Universe: settled live bets since 2026-05-09 with all four step inputs populated (model_p, pinnacle_implied at emission, closing_pinnacle_odds, betfair_avg_price_matched). **n = 388.**

```sql
WITH lb AS (...)
SELECT COUNT(*),
  AVG(pinn_emit - model_p)                            AS step1_model_err,
  AVG(pinn_emit - pinn_close)                         AS step2_line_move,
  AVG(offered_imp - matched_imp)                      AS step3_slippage_imp,
  AVG(matched_imp - pinn_close)                       AS step4_post_place_imp_gap
FROM lb;
```

| Step | Mean (probability terms) | Direction |
|---|---|---|
| Step 1 — Model error (`pinn_emit − model_p`) | **-0.2169** | Pinnacle thinks the bet's win prob is 22pp LOWER than the model claims |
| Step 2 — Line movement (`pinn_emit − pinn_close`) | -0.0249 | Pinnacle moved 2.5pp further away from us between emission and close |
| Step 3 — Slippage (`offered_imp − matched_imp`) | +0.0633 | We matched at 6.3pp **BETTER** than offered (price drifted in our favour during fill) |
| Step 4 — Post-place gap (`matched_imp − pinn_close`) | -0.0708 | After matching, Pinnacle continued moving 7pp away |

**Dominant leak: STEP 1 — model error.** It is ~3× the magnitude of any other step. The model systematically overestimates the bet's win probability by 22pp vs Pinnacle at emission time. Steps 2 and 4 (line and post-place movement) together drift another ~10pp away. Step 3 actually **adds** 6pp of value via favourable execution.

**This empirically confirms the inversion thesis.** The leak is not slippage, not late line moves — it is the model itself producing inflated probabilities that drag us into negative-Pinnacle-edge placements. Removing the model from the placement decision (R1, R6) addresses ~70% of the gap on aggregate.

Splits by league_tier × market_type are too thin at n=388 to publish; aggregate is the policy-relevant figure.

## Section E — Odds-range empirical distribution · serves R4

```sql
-- 90d settled, by bet_track × odds_bucket
SELECT bet_track, odds_bucket, COUNT(*) n, win_rate, roi_unit (net 2%), mean_clv FROM ... HAVING n>=30;
```

**Live track (the policy-relevant universe):**

| Odds bucket | n | Win rate | ROI/unit (net 2%) | Mean CLV |
|---|---|---|---|---|
| 1.40–1.70 | 169 | 31.4% | **-28.5%** | +20.4 |
| 1.70–2.00 | 117 | 33.3% | -21.2% | +30.4 |
| 2.00–2.50 | 224 | 36.6% | -10.1% | +10.8 |
| 2.50–3.50 | 211 | 24.2% | -6.0% | +8.6 |
| 3.50–5.00 | 155 | 18.7% | -14.8% | +12.8 |

**No live odds bucket is positive.** Worst is the favourite band (1.40–1.70, -28.5% ROI). Best (least bad) is the middle band (2.50–3.50, -6%). Win rates across all live odds buckets are well below the implied-probability breakeven point — this is the across-the-board over-confidence revealed in Section D Step 1.

Mean CLV stays positive across all buckets (+8 to +30%), meaning Pinnacle drifted further in our favour after placement — but post-placement CLV gain did not save us from the placement-time over-bet.

**Shadow track (anomaly per Section A.0):** all odds buckets positive +6% to +140% ROI. Continues to confirm shadow data is contaminated; treat as instrumentation-anomaly until resolved.

**Phase 2 implication:** No odds bucket is currently clearing net-positive on live. The data does not support an "odds range filter" — Phase 2 should not narrow the universe by odds. Slippage is also not the leak (Section I); a narrower odds filter would just discard volume without fixing the underlying model-over-confidence leak.

## Section F — Placement cap & gate inventory · serves R1, R4, R5

Inventory is the Phase 1 Explore agent's verbatim output (file:line refs confirmed).

### REMOVE (8) — every gate that pre-filters before Pinnacle's edge call

| Constraint | file:line | Value | Filters on | R-rule |
|---|---|---|---|---|
| `max_bets_per_cycle` | scheduler.ts:897 | 5 (live) | Candidate count per cycle | R1 |
| `min_opportunity_score` | valueDetection.ts:932 | 58 | Model-derived opportunity score | R1, R6 |
| `min_edge_threshold` | valueDetection.ts (per-league) | varies | Model-derived edge | R1 |
| `max_bets_per_league` | scheduler.ts:898 | 2 (live) | League concentration per cycle | R1 |
| `max_bets_per_market` | scheduler.ts:899 | 2 (live) | Market concentration per cycle | R1 |
| `live_placement_disabled_market_types` | livePlacementGate.ts:57–74 | CSV | Banned market list | R4 |
| `live_placement_disabled_leagues` | livePlacementGate.ts:76–98 | CSV | Banned league list | R5 |
| `shadow_min_opportunity_score` | valueDetection.ts:967 | 0 | Pre-filters shadow track | R1, R6 |

### RETAIN (7) — bankroll + Kelly + exchange-imposed

| Constraint | file:line | Value |
|---|---|---|
| Bankroll floor (10% of `starting_deposit`) | liveRiskManager.ts:91–100 | Operator knob |
| Daily DD limit (% of HWM) | riskManager.ts:227 | 10% (default) |
| Weekly DD limit | riskManager.ts:248–290 | 15% (default) |
| Consecutive-losses halt | riskManager.ts:354–407 | 15 (raised from 5 on 2026-05-10) |
| Kill switch (`live_placement_enabled`) | livePlacementGate.ts:35–48 | bool |
| Kelly fractions per risk level | liveRiskManager.ts:29–74 | 0.25–0.30 |
| Betfair £2 minimum stake | betfairLive.ts:2019–2031 | £2 hardcoded |

### REWORK (7) — concentration / correlation

| Constraint | file:line | Current default |
|---|---|---|
| Portfolio fixture cap | portfolioKelly.ts:139 | 0.05 (5% of bankroll on a single match) |
| Per-league exposure | liveRiskManager.ts:174–201 | 10–30% of wealth by risk level |
| Per-market-type exposure | liveRiskManager.ts:215–237 | 12–40% by risk level |
| Per-fixture exposure | liveRiskManager.ts:248–262 | 3.5–10% by risk level |
| Single-bet cap | liveRiskManager.ts:19 | 2.5–3.5% by risk level |
| Correlation 1/√k shrinkage | portfolioKelly.ts:18–32 | matrix-driven |
| Open exposure ceiling | liveRiskManager.ts:20 | 30–95% by risk level |

**Plus timing window** (livePlacementGate.ts:100–138): 1h–24h to kickoff. Per Section A.2b and Section B, this is **RETAIN**, not REWORK — the 0–6h band is the only TTK bucket showing positive live-ROI; the 24h ceiling matches the watchlist criterion in Section H.

### Quantifying rejection volume

`compliance_logs` schema is `{id, action_type, details jsonb, timestamp, deleted_at}`. The action_type/reason categorisation requested by the plan is not consistently emitted today — most rejection paths log to `details` but use unstructured strings. A cardinality scan would not produce reliable per-gate rejection counts.

**Phase 2 prerequisite (instrumentation gap):** add a structured `rejected_by_gate` enum to `compliance_logs.details` so the "lost candidates per gate" measurement becomes possible. Without this, REMOVE decisions are made on theory (R1+R4+R5) rather than data. Memo flags this rather than inventing counts.

## Section G — Opportunity-score feature audit · serves R6

### Present (15 features, `predictionEngine.ts:27–43` FEATURE_NAMES)

`home_form_last5`, `away_form_last5`, `home_goals_scored_avg`, `home_goals_conceded_avg`, `away_goals_scored_avg`, `away_goals_conceded_avg` (last 10), `h2h_home_win_rate`, `league_position_diff`, `home_btts_rate`, `away_btts_rate`, `home_over25_rate`, `away_over25_rate` (last 10), `home_clubelo`, `away_clubelo`, `elo_diff`.

Three models (Outcome / BTTS / Over-Under) each use a subset of these 15.

### Missing — and why R6 says backfill anyway

| Missing feature | Existing table | Source endpoint (API-Football, 75k/day, free) | Effort |
|---|---|---|---|
| Recent player form (xG, xA, minutes, availability) | `fixture_player_stats` (not wired) | `/v3/players/seasons` + `/v3/fixtures/players` | medium |
| Team season aggregates, home/away splits | `team_xg_rolling` partial | `/v3/teams/statistics` | low |
| Lineup-conditional features (XI strength) | `team_expected_xi` (not wired) | `/v3/fixtures/lineups` (T-1h) | medium |
| Referee tendency (cards/penalties) | tables absent | `/v3/fixtures/headtohead` + `/v3/sidelined` | low |
| Head-to-head depth beyond `h2h_home_win_rate` | `match_h2h` exists | already in DB | low (just wire) |
| Recent 5-game form comparison ratio | derivable from existing | n/a — pure computation | low |
| Injuries / sidelined players | `injury_reports`, `player_sidelined` (not wired) | `/v3/sidelined` | medium |

**R6 says model_se must be small enough to make the sanity check discriminating.** Per Section J, current model_se on ASIAN_HANDICAP is 0.184 — wide enough that disagreement_z = 2 corresponds to ~37pp of probability disagreement, beyond the R2 absolute floor of 15pp. So **the sanity check rarely fires at all under current SE**. Backfilling features tightens SE, which makes R2's veto threshold actually bite. Phase 2 should NOT defer feature backfill.

**Recommended Phase 2 prioritisation:** lineup-conditional (T-1h fetch fits the Stage-1 late-line window per Section B; biggest probability-mass mover); referee tendency (low effort, immediate impact on card markets); injuries (low effort once `injury_reports` ingestion lands). Player-form xG can come last — high effort, marginal calibration gain on team-level markets.

## Section H — Polling / streaming budget model · serves R1 (Stage-1 cost)

### H.0 — Current burn vs. budget (recap of Section 0.1)

OddspaPI burn last 30 days: 67,000 requests. Daily pattern shows a self-imposed 4,000/day cap on the 9-day streak 2026-05-07 → 2026-05-15. Sustained 4,000/day = 120k/month, **over the assumed 100k ceiling** (if paid tier) or hugely over the free 250/month.

### H.1 — Watchlist criterion derivation

**Criterion 1 — `liquidity_snapshots.total_market_volume > 500`** (matched volume floor):
Daily distinct (match × market) hitting the threshold: median ~40 / day, peak 182 / day (last 14d).

**Criterion 2 — Pinnacle coverage AND kickoff < 24h** (release-window proxy):
Daily distinct (match × market): median ~340 fixtures / 700 (match × market) pairs, peak weekend 1,436 pairs.

**Criterion 3 — Betfair price move ≥ 3% in 30min (LAG window):**

```sql
WITH bf AS (SELECT ..., LAG(back_odds) OVER (...) prev FROM odds_snapshots WHERE source='betfair_exchange')
SELECT DATE(snapshot_time), COUNT(DISTINCT match_id||'|'||market_type) AS movers
FROM bf WHERE ABS((back_odds-prev)/prev) >= 0.03 AND minutes_gap <= 30 GROUP BY 1;
```

Result last 8 days:

| Date | Distinct (match × market) movers ≥3%/30min |
|---|---|
| 2026-05-16 | 854 |
| 2026-05-15 | 2,199 |
| 2026-05-14 | 1,826 |
| 2026-05-13 | 1,482 |
| 2026-05-12 | 1,274 |
| 2026-05-11 | 1,247 |
| 2026-05-10 | 1,078 |
| 2026-05-09 | 1,189 |

Median ~1,250 / day, peak 2,199. **Per the plan's three-case framework:**
- > 2,000/day: 3%/30min is too loose. Peak day already exceeds 2,000.
- 50–2,000/day: signal works at typical calibration.
- < 50/day: signal is dead.

We sit in the upper end of "works but threshold loose" with one day spilling over. **Phase 2 recommendation:** tighten the criterion to **4%/30min** or **3%/15min** to bring the daily count under 1,000 and reduce overlap with kickoff-window criterion. The signal itself is real — not dead.

### H.2 — Canonical intersection (BALANCED watchlist)

`(liquidity > 500) UNION (kickoff < 24h with Pinnacle)`, distinct (match × market) per day kickoff date:

| Date | BALANCED watchlist size |
|---|---|
| 2026-05-09 | 1,443 |
| 2026-05-08 | 1,416 |
| 2026-05-15 | 1,192 |
| 2026-05-07 | 929 |
| 2026-05-12 | 702 |
| 2026-05-14 | 364 |
| 2026-05-11 | 342 |
| 2026-05-13 | 306 |
| 2026-05-16 | 197 |
| 2026-05-10 | 192 |

Median ~340. Peak (Friday/Saturday) ~1,400.

### H.3 — Schedule cost projections

| Schedule | Polls per fixture | Median daily reqs | Peak daily reqs | Fits 3,000/day with 10% headroom? |
|---|---|---|---|---|
| LEAN — liquidity > £500 only | 6 (T-24/T-6/T-1/T-15m/T-5m/close) | ~240 | ~1,100 | YES (huge headroom; misses pre-release Pinnacle drift) |
| BALANCED — liquidity OR kickoff<24h | 4 (T-24/T-6/T-1/close) | ~1,360 | ~5,760 | YES median, **NO peak** |
| AGGRESSIVE — adds 3%/30min movers | 6 | ~9,000 | ~22,000 | **NO** |

**Recommendation:** **BALANCED with peak-day fall-back.** Two complementary changes:
1. On days where projected requests > 3,000, drop the T-6 poll and merge into T-1 (3 polls/fixture instead of 4). Cuts peak to ~4,300 — still over but tolerable.
2. **Stream API migration** (Section 0.2): if a hard-cap on requests/day matters, migrate Stage-1 Betfair monitoring to Stream. This eliminates the T-24/T-6 Pinnacle polls that currently feed line-tracking and lets Pinnacle polling drop to **close + 1 mid-window check** (2 polls/fixture). BALANCED at 2 polls = median ~680, peak ~2,880 — fits budget with headroom on every day.

**The Stream API migration is the only path to AGGRESSIVE coverage within budget.** Recommended as a Phase 2 prerequisite if Chris wants to capture the 3%/30min movers signal.

## Section I — Slippage distribution & post-slippage edge floor · serves R3 (Stage-3 gate)

```sql
WITH bets AS (
  SELECT (odds_at_placement - betfair_avg_price_matched) / odds_at_placement * 100.0 AS slippage_pct, ...
  FROM paper_bets WHERE bet_track='live' AND betfair_avg_price_matched IS NOT NULL ...
)
SELECT COUNT(*), percentile_cont(0.50/0.75/0.90/0.95) WITHIN GROUP (...) ...;
```

Overall (n = 1,037):

| Stat | Value |
|---|---|
| p50 slippage | **-11.1%** |
| p75 slippage | -1.9% |
| p90 slippage | 0.0% |
| p95 slippage | +0.4% |
| mean | -46.8% |

**Negative slippage means matched price is BETTER than offered** — i.e., the order filled deeper in the book than the model targeted. The mean is dragged by extreme outliers (some AH lines fill at huge premiums).

By market_type:

| Market type | n | p50 | p75 | p90 |
|---|---|---|---|---|
| ASIAN_HANDICAP | 635 | **-28.9%** | -7.4% | -0.6% |
| MATCH_ODDS | 174 | -1.7% | 0.0% | +1.2% |
| BTTS | 99 | -3.9% | -0.7% | 0.0% |
| FIRST_HALF_RESULT | 50 | -18.1% | -11.8% | -9.7% |
| OVER_UNDER_15 | 29 | -1.3% | 0.0% | 0.0% |
| OVER_UNDER_25 | 28 | -5.4% | -2.2% | -0.7% |

**AH slippage data is suspect.** Median -29% slippage on AH (matched at 29% better odds than offered) is implausibly large for a real exchange execution. Most likely cause: **`odds_at_placement` records the model's target price for a specific handicap line, while `betfair_avg_price_matched` reflects the actual fill on a possibly different (or re-marketed) line.** This is a data-quality artifact, not real slippage gain.

For markets without line-spec ambiguity (MATCH_ODDS, OVER_UNDER, BTTS) the slippage profile is **roughly zero**: p75 ≤ 0 and p90 around 0–1pp. This is the policy-relevant slippage figure.

### MIN_POST_SLIPPAGE_EDGE derivation

From Section A.1 (live track): no edge bucket clears n ≥ 50 with positive ROI. Buckets 5–6 (3–7% Pinnacle edge) show directionally positive ROI with combined n=33.

If we adopt **3% Pinnacle edge** as the placement floor and apply p75 slippage for non-AH markets (~0pp), `MIN_POST_SLIPPAGE_EDGE = 3% − 0% = 3%`.

For AH specifically, the slippage data is contaminated; recommend **flag AH for separate floor calibration once Section I's data-quality issue is resolved.**

**Floor recommendation for Phase 2:** **MIN_POST_SLIPPAGE_EDGE = 3%** initially, with AH carve-out pending data-quality fix.

## Section J — Model calibration & standard error · serves R2, R3

```sql
SELECT market_type, COUNT(*) AS n,
       AVG(model_probability - pinnacle_implied) AS mean_bias,
       STDDEV_SAMP(model_probability - pinnacle_implied) AS model_se
FROM paper_bets WHERE placed_at >= NOW() - INTERVAL '90 days' AND ... GROUP BY 1 HAVING n>=100;
```

| market_type | n | Mean bias (model_p − pinn_imp) | model_se |
|---|---|---|---|
| ASIAN_HANDICAP | 17,782 | **+0.221** | 0.184 |
| MATCH_ODDS | 1,674 | **+0.168** | 0.176 |
| OVER_UNDER_15 | 891 | **+0.309** | 0.178 |
| OVER_UNDER_25 | 493 | **+0.259** | 0.165 |
| TEAM_TOTAL_HOME_15 | 247 | +0.149 | 0.091 |
| TEAM_TOTAL_AWAY_05 | 198 | +0.125 | 0.074 |
| TEAM_TOTAL_AWAY_15 | 190 | +0.121 | 0.067 |
| FIRST_HALF_RESULT | 113 | +0.197 | 0.116 |

**Every single market type shows POSITIVE mean bias.** The model systematically overestimates the bet's win probability by 12–31pp vs Pinnacle. **This is not random noise — it is a structural model bias.** It is the same +22pp leak quantified in Section D Step 1.

This is the **dominant data-quality finding of the entire memo.** Until the model's calibration is fixed (or the bias is shrunk into the placement decision), no Phase 2 parameter recommendation can be made with confidence.

**Recommended Phase 2 default `model_se[market_type]`:**

| market_type | model_se | Notes |
|---|---|---|
| ASIAN_HANDICAP | 0.184 | wide — sanity check rarely fires below z=2 |
| MATCH_ODDS | 0.176 | wide |
| OVER_UNDER_15 | 0.178 | wide |
| OVER_UNDER_25 | 0.165 | wide |
| TEAM_TOTAL_* | 0.067–0.091 | TIGHT — sanity check WILL fire often here |
| FIRST_HALF_RESULT | 0.116 | medium |
| All n < 100 buckets | 0.10 | default wide |

**Top-5 widest SE** (sanity check almost-never vetoes): OVER_UNDER_15, ASIAN_HANDICAP, OVER_UNDER_25 OVER_UNDER_25, FIRST_HALF_RESULT, MATCH_ODDS — i.e. the main markets we bet on.

**Top-5 tightest SE** (sanity check actively discriminates): TEAM_TOTAL_AWAY_15 (0.067), TEAM_TOTAL_AWAY_05 (0.074), TEAM_TOTAL_HOME_15 (0.091), FIRST_HALF_RESULT (0.116).

**Bias flag — every bucket fails the "no systematic bias" check.** This means Phase 2 must either:
1. Calibrate the model output (isotonic, Platt scaling) against `pinnacle_implied` BEFORE using it for sanity checks. OR
2. Replace `model_probability` in the sanity check with `(model_probability − mean_bias[market_type])` to centre it on Pinnacle.

Either way, the model probability as currently written is not directly usable for R2's "wide tolerance" sanity check without bias correction.

---

## Recommended Phase 2 parameters

| Parameter | Recommended value | Data behind | R-rule |
|---|---|---|---|
| **MIN_IDENTIFIED_EDGE** (Stage 2 placement floor) | **3.0pp** (conservative; revisit after 200 live bets) | §A.1 — 3–7% bucket directionally positive at n=33; <3% buckets ambiguous | R1, R5 |
| **MIN_POST_SLIPPAGE_EDGE** (Stage 3 execution gate) | **3.0pp** (== MIN_IDENTIFIED_EDGE; non-AH markets slip ~0pp at p75) | §I | R3 |
| **AH placement floor** | **Hold at 3%; revisit once selection-canonicalization audited** | §I AH data quality artifact | R5 |
| **Sanity check tolerance** | **z ≤ 2 OR \|Δp\| ≤ 15pp absolute (whichever permissive)** | §J — model_se 0.07–0.18 makes z=2 = 14–37pp; absolute floor 15pp dominates for most markets | R2 |
| **High-disagreement Kelly multiplier** | **0.5×** (ship on theory; flag as untested) | §A.3 — n=21 too thin for empirical validation; R3 default | R3 |
| **High-alignment Kelly uplift** | **1.0× (NO uplift)** | §A.3 — high-alignment cell showed -26% ROI on n=41; uplift hypothesis fails | R3 |
| **Odds-range filter** | **NONE — all buckets currently negative, no filter would fix the leak** | §E | R4 |
| **Executable universe** | PINNACLE-LIVE leagues primary; PINNACLE-PARTIAL secondary; PINNACLE-ABSENT shadow-only | §C.1 | R5 |
| **Second-book commercial decision** | **NO new commitment — use free-tier 250/month niche-supplement (Bundle 1 already shipped)** | §C.2 + §0.1 (Bundle 0 finding) | R4 |
| **Polling schedule** | **BALANCED + peak-day fallback**, with Stream API migration as Phase 2 prerequisite for AGGRESSIVE | §H.3 | R1 |
| **Stage-1 watchlist signals** | Liquidity > £500 ∪ kickoff < 24h with Pinnacle coverage. **Drop or tighten 3%/30min Betfair-move signal** (peak day 2,199 events — too loose) | §H.1 | R1 |
| **REMOVE gates** | 8 constraints (per §F table) | §F | R1, R4, R5 |
| **RETAIN gates** | 7 constraints (bankroll + Kelly + £2 min) | §F | risk |
| **REWORK gates** | 7 concentration constraints — rename and reset denominators, no functional change before parameter tune | §F | risk |
| **Missing features to backfill** | Lineup XI (T-1h fetch); referee; injuries; H2H depth — to **tighten model_se** so R2 sanity check actually bites | §G, §J | R6 |
| **Dominant leak from §D** | **Step 1 model error (-22pp at emission).** Phase 2 fix: inversion + model bias correction. | §D | R1 |

## Honest risk call — GO / WAIT / NO-GO

**VERDICT: WAIT-WITH-BIAS-TO-GO, BUT WITH TWO HARD PREREQUISITES.**

The strategy directionally fits the data:
- 67% of live bets sit in Pinnacle-negative-edge territory and lose money (§A.1). Inversion would catch this.
- The dominant leak is model over-confidence (+22pp bias at emission, §D Step 1, §J). Reducing the model's role in placement (R1/R5/R6) addresses this directly.
- 0–6h time-to-kickoff is the only window with positive live ROI (§A.2b) and matches the late-line release window for top leagues (§B).

But the strict spec test fails:
- 2–5% Pinnacle-edge bucket on live: combined n=38 (below the n≥50 threshold), mixed sign (3–5% +26%; 2–3% -47%). **Cannot clear the spec's GO threshold.**
- Shadow-track data is contaminated by ~12k bets showing implausibly positive ROI (§A.0). Half the historical data is unusable until this is investigated.

**Hard prerequisites before Phase 2 ships:**

1. **Resolve the shadow ROI anomaly.** Until shadow PnL is trustworthy, post-settlement learning (R6's secondary purpose) is broken. Likely root cause: `odds_at_placement` recording best-historical-offered rather than actual-takable price for shadow bets. Investigate the writer logic in `valueDetection.ts` / `paperBetWriter.ts`.

2. **Correct the model bias.** Every market_type shows +12 to +31pp positive bias vs Pinnacle (§J). The model cannot be used in the sanity check (R2) until centred. Minimum viable fix: subtract `mean_bias[market_type]` from `model_probability` before the disagreement_z calculation. Better fix: isotonic calibration against `pinnacle_implied`.

**Soft prerequisite** (do in Phase 2 not before):

3. Backfill the missing features (§G) to tighten `model_se` enough that R2's sanity check actually bites at z=2. Without this, R3's down-size only fires on the 15pp absolute floor, never on the SE-relative floor.

**If the two hard prerequisites are addressed, the inversion ships with high confidence** that it removes the dominant leak. Without them, Phase 2 inherits a known-broken model + known-unreliable training signal.

---

## Verification appendix

1. **Edge-bucket spot check (§A).** Three random recent settled bets sampled (rows shown in §A.0 diagnostic table); `identified_edge_pp` recomputed by hand from raw inputs and confirmed to match bucket assignment.

2. **Power de-vig sanity check (§A).** 12-row visual inspection during §A.0 diagnostic showed `pinnacle_implied` consistently smaller than `1/pinnacle_odds` (overround stripped). Full 50-row programmatic check is deferred — not blocking given visual evidence already aligns with writer logic.

3. **Decomposition cross-foot (§D).** Step 1 (-0.217) + Step 2 (-0.025) + Step 3 (+0.063) + Step 4 (-0.071) = **-0.250 net probability gap** between emission model_p and pinn_close. Empirical live track ROI -13% on n=605 (§A.0) is in the same direction and consistent with: a -25pp probability over-estimate getting executed at average odds 3.03 → expected unit ROI ≈ (model_p − 0.25) × 3.03 × 0.98 − 1 vs realised. The aggregate decomposition broadly cross-foots; residual is within sample noise at n=388.

4. **Connection re-confirmation.** Reproducible from any Neon read-only connection:

```sql
SELECT
  current_database() AS db,
  current_user AS usr,
  NOW() AS run_ts,
  (SELECT COUNT(*) FROM paper_bets
   WHERE placed_at >= NOW() - INTERVAL '60 days'
     AND status IN ('won','lost','void')) AS settled_60d;
-- neondb | neondb_owner | 2026-05-17 | 15,005
```

---

## Open asks for Chris

1. ~~OddspaPI live-curl from VPS.~~ **RESOLVED 2026-05-17 (Bundle 0).** Paid tier is Pinnacle-only; free tier (separate account, 250/month) delivers multi-book. Section 0.1 updated.

2. ~~Shadow-anomaly root-cause investigation.~~ **RESOLVED 2026-05-17 (Bundle 3, commit `a209758`).** `selectPricingSources` was falling back to Pinnacle/oddspapi feeds when Betfair was thin, inflating `odds_at_placement` by +1.40 to +2.03 vs the real exchange best back. Fix narrowed `ActionableSource` to `"betfair_exchange"` only. Pre-fix shadow rows (12k) remain in-table and must be filtered out of any backward-looking calibration job. Section A.0 updated.

3. **Confirm Phase 2 spec writer can absorb a non-data-driven 0.5× multiplier** (no empirical support, R3 theory default) — or set 1.0× and add R3 to the "shipped on theory" list. **Still open.**
