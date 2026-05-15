# CLAUDE.md — Football Betting Agent

> **Read this file at the start of every new session.** It is the single source of truth for the agent's strategic principles, architecture, and operational context. If you find something in code that contradicts it, prefer the code (then update this file). If you find something here that contradicts a memory entry, prefer this file.

---

## 1 — Mission

**Maximise Kelly growth ROI.** Every architectural decision, every gate, every threshold change comes back to: *does this make the long-run geometric growth rate of bankroll higher?* If a change cannot be justified in those terms, it does not ship.

This is a Kelly-criterion autonomous trading agent that bets football markets on Betfair Exchange real-money (live) and in £0 shadow mode (learning).

## 2 — Principles (non-negotiable)

1. **Statistical theory, not hardcoded limits.** No magic constants for "max bets per day", "max stake", "min edge". Every limit is derived from a probabilistic statement (Wilson lower bound on ROI, Kelly-fraction discount on uncertain edge, CLV-based exit signal, etc.). If a number appears in code with no statistical justification, treat it as a bug.
2. **The model is autonomous over betting decisions.** What to bet, when, at what edge — model's call.
3. **Money guardrails are operator-only.** Stake fractions, bankroll caps, circuit breakers, kill switches require explicit Chris approval. Code changes to anything that gates real-money flow need a clear ask.
4. **Continuous learning.** Every settled bet feeds Wilson ROI, CLV, calibration buckets, and tier eligibility. Past performance updates the prior; the prior updates future stakes.
5. **CLV is the leading indicator, ROI is the trailing indicator.** Sample-size-poor decisions rely on CLV against Pinnacle close; sample-size-rich decisions rely on realised Wilson-bounded ROI.
6. **Every metric the system relies on for graduation or staking has a periodic verification check.** Every input feeding the eligibility view, the Kelly factor, the CLV t-stat, or the calibration sanity gate must have an automated audit running without human intervention that writes `data_quality_alerts` on drift. If no such check exists, the metric is **assumed-untrusted** until one is built. Pinnacle availability is not a precondition for graduation; the statistical gate is. Markets without Pinnacle coverage qualify on Wilson + bootstrap alone, CLV gate suspended for that scope.
7. **The gate is statistical, not temporal.** Every project milestone is expressed as "condition met when X" — not "expected in N days." Calendar projections are useful for fixture-rate planning but are never commitments. The data decides when a market becomes eligible; the system waits for statistical sufficiency, not calendar time. A scope re-qualifies when n is sufficient at the empirical p̂ to clear the gate, regardless of whether that takes 10 days or 60. Capital commitments built on pre-fix or pre-clean-data edge numbers are hypotheses, not plans.

## 3 — Bet types

| Type | Stake | Purpose |
|---|---|---|
| **Shadow** | £0 (recorded against `shadow_stake` for ledger-only EV calc) | Learning opportunities — anything below the live-eligibility bar. Built up so scopes can graduate. |
| **Live** | Real money — minimum £2 (Betfair Exchange cap); maximum = `0.25 × Kelly × tier-adjusted bankroll fraction` | Only fires for scopes that pass eligibility (§5). |

Every shadow bet must still be **placeable on Betfair Exchange** — its scope (`league × market_type`) must have a graduation pathway. Shadow bets in scopes with no Betfair exchange pathway are dead weight and should not be written.

## 4 — Tier ladder

Tiers describe data maturity for a `(league × market_type)` scope, not blanket trust:

| Tier | Meaning | Kelly multiplier |
|---|---|---|
| A | Proven — large sample, positive Wilson ROI lower bound, strong Pinnacle CLV | full 0.25 Kelly |
| B | Promising — partial sample, edge survives but Wilson bound weaker | discounted Kelly (factor < 1) |
| C | Experimental — small sample, evidence still accumulating | further discount |
| D | Cold — insufficient evidence to live-bet, shadow only | shadow only |
| E | Suspended / cooled — bad performance, paused until evidence inverts | shadow only |

Tiers are **assigned per scope**, not per league. A league may be Tier A on AH and Tier C on BTTS.

The tier ladder is now superseded by the **`v_live_eligibility_*` views** as the sole structural gate — these compute live-eligibility from the live data (Wilson ROI + Pinnacle coverage) rather than from a hardcoded tier whitelist. Tier B/C in proven scopes deploy capital under the same risk gates as Tier A as of 2026-05-12 (`project_shadow_bets_principle`).

## 5 — Live-bet eligibility (the hard gate)

A bet routes live iff **one** of two paths qualifies the scope, AND the bet itself isn't disproven downstream. **Per `project_eligibility_two_path_gate`, post-2026-05-13:**

**Path 1 — per-scope qualification** (`v_live_eligibility_candidates`): the (league × market_type) has ≥ 1 of:
- **Wilson 95% lower bound on win-rate > 0.50** (n ≥ 30, pnl > 0) — Wilson 1927
- **CLV t-stat > 1.96 with avg_clv > 0** (n ≥ 30, pnl > 0) — Student 1908

The `shrunk_roi > 0.20` path was **dropped 2026-05-13** (commit `4e94db1`) — 0.20 was a magic number without statistical referent; redundant with Path 2.

**Path 2 — market-type aggregate** (`v_live_eligibility_market_types`, Lever A+G): the market_type passes **all three** gates on pooled history:
1. Wilson 95% lower bound on win-rate > 0.50
2. **Bootstrap 95% lower bound on stake-weighted ROI > 0** (Efron-Tibshirani 1993, B=10000, computed in JS in `analysisJobs.ts`)
3. Student t-stat on mean CLV > 1.96

AND the specific (league × market_type) is NOT **three-signal disproven**: `n ≥ 30 AND roi < 0 AND clv_t_stat < 0`. The carve-out mirrors the three-gate logic in reverse — one bad signal isn't enough, three independent bad signals are.

**Currently qualifying market_types (snapshot 2026-05-13):** ASIAN_HANDICAP (n=6224), OVER_UNDER_15 (n=60). Everything else is shadow-only.

Other live-routing requirements (unchanged):
- **Edge / opportunity score** above per-scope floors (emission-stage gates in `valueDetection.ts`)
- **Scope is Betfair-tradeable** (`project_scope_tradeability_rule`)
- **Kill switch on** (`live_placement_enabled = true`)

Once eligibility passes, **sizing is set by the adaptive Kelly factor — see §7.**

Paper-bet eligibility == live-bet eligibility post-2026-05-09 cutover. `qualifiesForTier1` and Path P/S are deprecated (`project_paper_equals_live_eligibility`).

## 6 — CLV / Closing-line value

CLV is computed against **Pinnacle** as the sharpest book. Coverage of closing prices comes from four feeds, in priority order:

1. **Pinnacle** (primary CLV anchor)
2. **Betfair Exchange** (graduation pathway, secondary CLV reference)
3. **Smarkets**
4. **Matchbook**

`closing_pinnacle_odds` on `paper_bets` is the strict-pre-kickoff Pinnacle close, written by Writer A (`oddsPapi.fetchAndStoreClosingLineForPendingBets`). If non-null, it is the authoritative CLV reference and takes precedence over `odds_snapshots`. `clv_source` is tagged `pinnacle` when a Pinnacle anchor exists; `none` otherwise (gating `clv_pct` semantics).

## 7 — Stake sizing

For an eligible bet at decimal odds `b+1` on a `(league, market_type)` scope with realised win-rate `p̂` and Wilson lo95 `p_lo`:

```
stake = bankroll
      × kellyFull                          [= (model_p − implied_p) / (odds − 1)]
      × kellyFractionForScore(opp_score)   [score-keyed base fraction 0.125–0.5]
      × tierKellyFraction                  [experiment_registry.kelly_fraction, usually 1.0]
      × adaptiveKellyFactor                [NEW — Wilson-LCB / Kelly-LCB ratio, see below]
      × (1 − correlationLoad)              [portfolio shrinkage per fixture cap]
      then clipped at: bankroll × max_stake_pct (0.02)
                       liveLimits.maxSingleBetPct
                       Betfair £2 minimum (else demote to shadow)
```

**Adaptive Kelly factor (shipped 2026-05-13, `project_adaptive_kelly_factor`):**
```
f̂      = p̂   − (1 − p̂)   / b   Kelly at point estimate
f_lo    = p_lo − (1 − p_lo) / b   Kelly at Wilson lower bound
raw     = f_lo / f̂                ∈ (0, 1]
factor  = min(raw, path_cap)      path_cap = 1.0 (per_scope) | 0.33 (aggregate_only)
```
- Asymptotes → 1 as n → ∞ (n=30 → ~0.34; n=300 → ~0.79; n=3000 → ~0.93).
- **Replaces** the binary `experiment_registry.warmup_completed_at` gate. That column is informational only now; no code reads it for placement.
- **f̂ ≤ 0** demotes with reason `scope_eligible_but_negative_kelly` — a distinct calibration-drift signal (qualified scope but specific odds yield non-positive Kelly under empirical p̂).
- **Do NOT use `p_lo / p̂`** (win-rate ratio) — Kelly is nonlinear in p; overstates by 20-100% at small n.

Other rules:
- **Kelly base 0.25** assumption is gone — kellyFractionForScore (0.125–0.5) is now the primary base, modulated by adaptive factor. Operator-set knob: `dynamic_kelly_min_fraction` floor.
- **Betfair Exchange minimum = £2** — bets sized below £2 demote to shadow with reason `kelly_below_min_stake`.
- **`max_stake_pct = 0.02`** absolute cap per bet. Money guardrail; needs operator approval to change.
- **`portfolio_fixture_cap = 0.05`** correlation cap per fixture across a basket.
- **No daily-loss caps, no bankroll floors** — kill switch + 7-loss halt are the only operator guardrails (`risk guardrails: strip exposure caps + bankroll floors`, 2026-05-12).

## 8 — Architecture

### Repos / workspace layout (pnpm workspace)

```
~/Football-betting-agent/
├── artifacts/
│   ├── api-server/     # the trading agent — Express, esbuild single-bundle dist/index.mjs
│   ├── dashboard/      # NOT USED — no front end exists for this project
│   └── mockup-sandbox/ # NOT USED
├── lib/
│   ├── db/             # Drizzle ORM schema + pg
│   ├── api-zod/        # request/response schemas
│   ├── api-spec/
│   └── api-client-react/
├── scripts/
├── vps-relay/          # separate process — runs on VPS for Betfair liquidity polling
└── docs/
```

Operator interacts via **SQL views + CLI commands only**. There is **no front end** (`project_no_front_end`). Do not reference `/dashboard/*` routes or UI tabs.

### Build topology

- api-server is a **single-bundle esbuild** — only `src/index.ts` is bundled into `dist/index.mjs`. `src/cli/*.ts` is **not** separately built — admin actions must be wired via HTTP endpoints (`reference_api_server_build_topology`).
- pnpm workspace root has a `preinstall` hook that rejects npm.
- `pnpm run build` at root chains a broken typecheck gate; use the filtered build below.

### Three PM2 processes on the VPS (post 2026-05-09 worker-split)

| Process | Role | Notes |
|---|---|---|
| `api-server` | `WORKER_ROLE=api` — HTTP + trading-decision crons | Port 8080 |
| `worker-data` | `WORKER_ROLE=data` — ingestion + scoring crons | Background only |
| `betfair-relay` | Liquidity polling against Betfair (separate codebase in `vps-relay/`) | Generally untouched by api-server deploys |

Both api-server and worker-data run from the **same compiled bundle** but with different `WORKER_ROLE` env vars. They must be restarted **together** on every deploy — otherwise split-brain across the cron registry (`project_vps_pm2_topology`, `reference_vps_deploy`).

## 9 — Ops

### Database
- **Neon Postgres** — `DATABASE_URL` in `~/Football-betting-agent/.env` on VPS.
- I (Claude) query via the `mcp__neon-prod-readonly__query` MCP tool — never ask Chris to run SQL (`feedback_post_deploy_sql_checks`).
- Verification SQL after every deploy.

### Ports & paths
- **api-server: port 8080** (never 3000) (`reference_api_server_port`).
- Admin endpoints: `POST http://localhost:8080/api/admin/...`
  - `/api/admin/cancel-bet` — cancel a single bet by `internalBetId`
  - `/api/admin/reconcile-settlements` — force-run Betfair settlement reconciliation
  - `/api/admin/cancel-orphan-orders` — orphan-detection cleanup
  - `/api/admin/settle` — full settlement pipeline (sync results + settle + backfill)
  - `/api/admin/set-config` — set agent_config key/value (e.g. flip `live_placement_enabled`)
  - `/api/admin/run-bundle-b` — force-recompute analysis_signal_strength + market-type aggregate (deterministic; safe to fire any time)
  - `/api/admin/run-lazy-promote` — promote qualifying pending shadow bets → live now (skips waiting for the cron tick)
  - `/api/admin/run-near-cycle` — fire a trading cycle immediately (1-48h kickoff window) + dedup
- Note: admin routes in `api.ts` are mounted at `/api/admin/...`. Hitting `/admin/...` returns 404; hitting `/api/<anything-not-defined>` falls through to `launchRouter` whose `requireDevEnvironment` middleware returns 403 in production.

### Deploy workflow
**Build on the VPS, never locally.** Claude commits + pushes from Windows; Chris pulls + builds + restarts on the VPS (`feedback_build_deploy_workflow`).

**Canonical deploy block** — paste literally after every push (`reference_vps_deploy`, `feedback_use_canonical_deploy_block`):

```bash
cd ~/Football-betting-agent && \
  git pull && \
  pnpm install && \
  pnpm run typecheck:libs && \
  pnpm --filter "@workspace/api-server" run build && \
  pm2 restart api-server worker-data && \
  sleep 20 && \
  pm2 status
```

Then tail logs separately:
```bash
pm2 logs api-server  --lines 50 --nostream | grep -E "ready|FATAL|error"
pm2 logs worker-data --lines 50 --nostream | grep -E "ready|FATAL|error"
```

**Do not use** `pnpm run build` (root, broken typecheck gate) or `pnpm -r --if-present run build` (drags in `mockup-sandbox` and `dashboard`, which fail without `PORT`).

### `betfair_selection_id` / lib/db dist rebuilds
Drizzle silently drops unknown fields on insert/update. After any schema change in `lib/db/src/schema/*`, **force-rebuild `lib/db/dist`** — incremental tsc may miss new columns (`feedback_lib_db_dist_rebuild`).

## 10 — Defensive coding rules (lessons baked in from real incidents)

These exist because something went wrong. Do not relax without an equally strong replacement:

1. **Always paste the canonical deploy block after every push.** Do not reference it generically (`feedback_vps_deploy_commands`, `feedback_use_canonical_deploy_block`).
2. **Investigate root cause before patching.** No hot-fixes around the obstacle. Full 5-whys before code touches an outage (`feedback_root_cause_first`).
3. **After any settlement-logic change, audit ALL historical settlements.** Encode the new algorithm in SQL, find every disagreement with the stored status, backfill via UPDATE (`feedback_settlement_audit_after_logic_changes`).
4. **Plan execution, not reframing.** Once a product decision is made, plans execute it; note new findings once, don't relitigate (`feedback_plan_execution_not_reframing`).
5. **Commit messages omit the Claude Co-Authored-By footer** — it's hardcoded to one model and misleading (`feedback_commit_messages`).
6. **Universal collapse guard for placement** (shipped 2026-05-12). Before every `placeOrders`, check that no other internal bet for this match already has a live Betfair position on `(betfair_market_id, betfair_selection_id)`. Catches every "different internal selections collapsed to one Betfair selection" bug class, regardless of where it originated. See `artifacts/api-server/src/services/betfairLive.ts` near the start of `placeLiveBetOnBetfair`.
7. **`reconcileSettlements` must chunk `betfair_bet_id`s** to ≤200 per `listClearedOrders` call. Betfair caps at 250 → silent 400 → silent zero-reconciliation under load. Shipped 2026-05-12.
8. **Backfill / re-settlement jobs MUST exclude live-rail bets.** Any code that locally re-derives a bet's outcome via `determineBetWon(...)` and posts `applyBatchPnl(...)` MUST filter `bet_track IN ('paper','shadow') AND betfair_bet_id IS NULL`. Otherwise it injects phantom PnL — local ledger moves without a wallet event, Trigger C trips (£152 trip 2026-05-13 18:25 UTC, ~£622 cumulative phantom before fix). Shipped 2026-05-13 (`feedback_backfill_must_skip_live_bets`).
9. **`agent_config.bankroll` is FROZEN post-cutover (2026-05-09).** All `applyBatchPnl` / `setBankrollAbsolute` writes are bookkeeping-only (compliance log, no actual write). Any operator reset must go via Neon UPDATE. Live stake sizing reads `liveLimits.liveBalance` from Betfair API, not from this field (`project_paper_bankroll_frozen`).

## 11 — Key SQL views & tables

- `paper_bets` — every bet, shadow and live, settled and pending. Authoritative.
- `live_bets_current` — view filtered to `bet_track='live' AND legacy_regime=false AND placed_at >= cutover_completed_at`.
- `paper_bets_current` — shadow-track equivalent.
- `analysis_signal_strength` — per-(league × market × bet_track) Wilson lo95 / shrunk_roi / CLV t-stat / `qualifies_live`. Also holds `__market_type_aggregate__` rows (Lever A+G) with `bootstrap_lo95_roi` populated. Recomputed each Bundle B run.
- `v_live_eligibility_candidates` / `_leagues` / `_markets` — per-scope eligibility views.
- **`v_live_eligibility_market_types`** — market-type aggregate qualifiers (2026-05-13, Lever A+G). Read by the placement gate as the OR partner to per-scope.
- `v_upcoming_bets` — what's about to fire.
- `compliance_logs` — append-only audit trail. Every config change, settlement, placement failure, collapse-guard fire, PnL reconciliation lands a row here. **`bet_placed` rows now carry `adaptiveKelly = { pHat, pLo, fHat, fLo, rawFactor, cappedFactor, path }` for sizing audit, and `liveEligibilityPath` ∈ {`per_scope`, `market_type_aggregate`, null}.**
- `agent_config` — runtime feature flags / thresholds. Read-through 60s cache for hot keys. **`bankroll` is FROZEN post-cutover (`project_paper_bankroll_frozen`).** Live stake sizing reads `liveLimits.liveBalance` from the Betfair API; `agent_config.bankroll` is paper-era residual only.

### PnL columns on `paper_bets` (post 2026-05-12 reconcile)

`betfair_pnl` is the **authoritative wallet impact** from Betfair. Everything else derives:
```
net_pnl        = betfair_pnl
settlement_pnl = betfair_pnl
gross_pnl      = betfair_pnl / 0.95        (won) ; betfair_pnl (lost) ; 0 (void)
commission_amt = gross_pnl - net_pnl       (won) ; 0 (else)
status         = sign(betfair_pnl)         (won/lost) ; void if 0 + Betfair voided
```

**Backfill / re-settlement jobs MUST filter to `bet_track IN ('paper','shadow') AND betfair_bet_id IS NULL`** (`feedback_backfill_must_skip_live_bets`). Live bets are settled by Betfair's listClearedOrders via `reconcileSettlements` / `live_statement_reconciliation`. Local re-derivation on a Betfair-managed bet injects phantom PnL and trips Trigger C drift.

## 12 — Out-of-scope reminders

- **No dashboard, no UI work.** Operator is SQL + CLI only.
- **Do not modify Stakes / circuit breakers / bankroll caps without explicit Chris approval** (`feedback_autonomy_and_guardrails`).
- **Do not commit changes unless explicitly asked.**

## 13 — Reading list at session start

1. **This file (CLAUDE.md)** — strategic context, principles, ops.
2. `~/.claude/.../memory/MEMORY.md` — auto-memory index (loaded automatically).
3. `git log -10 --oneline` — what shipped recently.
4. Open Neon → quick smoke check on `paper_bets` (recent placements, pending count, recent compliance_logs) before suggesting any change.

If anything below the "Principles" section is contradicted by the current code, **trust the code** and update this file.
