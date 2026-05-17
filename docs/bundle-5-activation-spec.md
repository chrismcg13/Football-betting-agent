# Bundle 5 — Activation spec (locked 2026-05-17)

> **Status:** Spec lock from Chris, 2026-05-17 evening. Implementation is
> pre-staged behind `agent_config.inversion_pipeline_enabled` so activation
> is one DB UPDATE. This doc is the canonical reference for what activation
> means; if behaviour drifts from this, the code is wrong.

---

## 1. The single edge floor

`MIN_NET_EDGE = 3.0pp` applied to the **post-slippage** figure. The only
floor that matters. Replaces both `MIN_IDENTIFIED_EDGE` and
`MIN_POST_SLIPPAGE_EDGE` from earlier drafts.

`HIGH_EDGE` at 7.0pp is **telemetry only** — does not gate, does not
change Kelly sizing. Flag exists so weekly review can pattern-match the
league/market/book mix on extreme-edge candidates (high edge is often a
model artifact, not a green light).

## 2. The slippage formula

Multiplicative (replaces the earlier subtractive form
`identified - p75_slippage`):

```
expected_fill_odds    = betfair_offered × (1 − p75_slippage[market × ttk])
pinnacle_fair_odds    = 1 / pinnacle_implied
post_slippage_edge_pp = (expected_fill_odds / pinnacle_fair_odds − 1) × 100

PROCEED IF post_slippage_edge_pp >= 3.0
```

`p75_slippage` is a **fraction** (e.g. `0.015` = 1.5% odds compression).
The view (Bundle 5.I) computes it as the 75th percentile of
`GREATEST((offered − matched) / offered, 0)` — negative slippage (better
fill) is clamped to 0 because we don't plan around tailwinds.

## 3. The slippage lookup

Bucketed by `(market_type × ttk)`. TTK buckets:

| ttk_bucket | Range |
|---|---|
| `0_1h` | `kickoff_time − now < 1h` |
| `1_6h` | `1h ≤ ... < 6h` |
| `6_24h` | `6h ≤ ... < 24h` |
| `24h_plus` | `≥ 24h` |

**Fallback chain** when reading the lookup:
1. `(market_type, ttk_bucket)` cell — use if `n ≥ 30`
2. Market-type aggregate (across ttk) — use if `n ≥ 30`
3. **1.5pp default** (`p75_slippage = 0.015`) — conservative fallback

**PROCEED_WITH_CAUTION flag** on:
- `FIRST_HALF_RESULT` (any ttk)
- Any cell with `p75_slippage > 0.05` (5pp)

Flag does **not** auto-exclude. Bet still proceeds if 3pp net edge clears.
Flag is logged for review.

**Refresh cadence:** rolling 60-day window. The view (`v_slippage_p75_rolling`)
recomputes on every query — no separate cron needed; Postgres planner
handles the aggregate over ~5k rows efficiently. If load becomes a
problem later, materialise.

## 4. No TTK hard exclusion

`§A.2b` (memo) showed 24–72h is historically worst-performing. Under the
inverted pipeline (Pinnacle as edge decider, not the model), the prior
live-bet sample is **no longer representative**. The 3pp net-edge floor
is the sole gate.

The watchlist criteria (kickoff `<` 24h ∪ liquidity `>` £500 ∪ 4%/30min
mover) already bias toward sub-24h placement — don't double-gate.

## 5. Multi-sharp Kelly tiering

Sharp count = Pinnacle + non-Pinnacle slugs in `pinnacle_odds_snapshots`
within the freshness window (10 min), agreeing on direction (implied prob
within 1pp of Pinnacle's, same side):

| Sharp count | Kelly multiplier | Flag |
|---|---|---|
| 1 (Pinnacle only) | **0.5×** | — |
| 2 (Pinnacle + 1 niche) | **1.0×** | — |
| 3 (Pinnacle + Singbet + SBOBet on AH; or other 3-sharp config) | **1.0×** | `HIGH_CONVICTION` |

The 3pp floor is identical across all tiers. The Kelly multiplier
reflects conviction, not edge requirement.

## 6. High-edge integrity check (gate)

When `identified_edge_pp ≥ high_edge_flag_threshold` (default 7.0):

Three checks must all pass; any failure → **VETO** with reason
`reject_high_edge_integrity`:

1. **Selection canonical** match across `paper_bets.selection_canonical`,
   `pinnacle_odds_snapshots.selection_name` (canonicalised), and the
   Betfair `listMarketBook` outcome name (canonicalised).
2. **Snapshot freshness** — `pinnacle_odds_snapshots.captured_at` within
   30 minutes of decision time.
3. **AH handicap line match** — for `ASIAN_HANDICAP`, the line spec in
   `selection_name` must match exactly across all three sources (no
   `Home -1.5` vs `Home -1.75` cross-line confusion).

Implements `§A.1` bucket-8 lesson (−80% ROI at 10%+ edge = pure
artifact). The gate catches the same class of bug before capital deploys.

## 7. CLV circuit breaker (per market_type)

A 15-minute cron computes rolling-100-bet stake-weighted CLV per
`market_type` on the cutover universe (`bet_track IN ('live','shadow')`,
`legacy_regime = false`, post Bundle-3 fix).

If any `market_type` drops below `clv_circuit_breaker_threshold`
(default `0.0`), set `agent_config.clv_paused_<market_type> = 'true'`.

Gate reads this flag at Stage 1 entry — flagged market_types → demote
shadow with reason `clv_breaker_market_paused`. Other market_types
keep running. Manual unpause via `/api/admin/set-config`.

CLV is the leading indicator (memo Principle 5). Realised P&L is the
trailing one. The breaker catches edge decay before it shows up in
P&L variance.

## 8. Exposure controls (replaces the 0.02 cap when flag active)

When `inversion_pipeline_enabled = true`, the 0.02 single-bet cap
(bypassed via Bundle 5.D) is replaced by three new caps:

| Control | Default | Meaning |
|---|---|---|
| `per_fixture_exposure_pct` | **5.0** | max % of bankroll across all bets on the same fixture |
| `per_league_exposure_pct` | **15.0** | max % of bankroll across all open bets in the same league |
| `daily_stake_cap_pct` | **8.0** | max % of bankroll staked across all bets in a rolling 24h |

**Retained**: bankroll floor (10% starting deposit), £2 Betfair min,
Kelly fractioning, correlation 1/√k shrinkage, daily/weekly drawdown
limits, 7-loss halt, kill switch.

Three-sharp `HIGH_CONVICTION` bets can now stake 3–5% of bankroll on a
single fixture if the maths supports it; the 2% cap silently throttled
exactly those bets pre-Bundle-5.

## 9. Operator-tunable config (all DB-driven, no redeploy to change)

Nine new `agent_config` keys, seeded by `runMigrations` on first deploy:

| Key | Default |
|---|---|
| `min_net_edge_pp` | `3.0` |
| `high_edge_flag_threshold` | `7.0` |
| `kelly_multiplier_single_sharp` | `0.5` |
| `kelly_multiplier_two_sharp` | `1.0` |
| `kelly_multiplier_three_sharp` | `1.0` |
| `clv_circuit_breaker_threshold` | `0.0` |
| `per_fixture_exposure_pct` | `5.0` |
| `per_league_exposure_pct` | `15.0` |
| `daily_stake_cap_pct` | `8.0` |

Plus the activation switch `inversion_pipeline_enabled` (`'true'` to
flip).

## 10. Activation sequence

When the operator is ready to switch on:

```sql
-- Optional: pre-flight check
SELECT * FROM v_market_type_mean_bias_rolling ORDER BY n DESC;
SELECT * FROM v_slippage_p75_rolling ORDER BY n DESC;

-- Spot-check the gate decision on a representative candidate
-- POST /api/admin/inspect-inversion-gate { ... }

-- Activate (single UPDATE — atomic across all the rules above)
INSERT INTO agent_config (key, value) VALUES ('inversion_pipeline_enabled', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

To deactivate, set value to `'false'`. All Bundle 5 behaviour reverts.

## 11. Out of scope (deferred to later bundles)

- Stage 1 model-blind watchlist builder. Currently `kickoff_window` is
  declared by the caller to bypass Stage 1's legacy-candidate veto;
  candidates still come from the existing model-driven flow. Full
  Phase 2 Stage 1 (Pinnacle release timing + Betfair liquidity scan +
  movement detection) is a separate build.
- Closing-line tracking dashboard. The data capture is already in
  `closing_pinnacle_odds`; the dashboard view is Bundle 5.L companion.
- Per-book trust weights (`agent_config.sharp_book_trust_weights`).
  Original Bundle 1 E.4 — only meaningful when the niche table grows
  beyond Singbet/SBOBet.
- `compliance_logs` structured rejection enum (Bundle 6). Pre-req for
  measuring how often each gate rejects candidates.
