# Phase 3 — Paper → Live switchover: execution plan v2
**Author:** Claude (Opus 4.7) · **Date:** 2026-05-08 · **Status:** Plan for review, no code yet
**Replaces:** `phase-3-paper-to-live-switchover-plan.md` (v1)
**Approach:** Hardcoded gate (3% net ROI · 2% net CLV · ≥200 settled bets) for Pinnacle-anchored scopes; **shadow-only graduation path for non-Pinnacle scopes** (added in §11). No trial period. SQL only. Manual flip via CLI.

> **Read order:** §0 → §11 (shadow-only path) → §1–§10. The §11 addendum modifies the whitelist computation (§4.3), the switchover transaction (§5), and the post-launch graduation pipeline. Where §11 conflicts with earlier sections, **§11 wins**.

---

## 0. What changed from v1

- **Bayesian sequential framework removed.** Replaced by hardcoded aggregate gate.
- **No trial / ramp.** One switchover, one flip.
- **No UI / dashboards.** All checks are SQL queries or scheduled jobs writing to log tables.
- **Bankroll-tiered capital protection caps** with upward-only hysteresis (replaces fixed 10%/20% caps).
- **Z4 day-1 suspension** — parallel to all other prep, no sequencing.
- **Single Pinnacle-anchored evaluation pool** (your call on the §4.2 question — confirmed).
- **MATCH_ODDS only at switchover.** AH/BTTS/TEAM_TOTAL/OVER_UNDER stay shadow until exchange-capture work lands post-launch.
- **Manual flip via CLI** with manifest hash; system gates everything machine-checkable.

---

## 1. Confirmed answers to all open questions

### 1.1 Aggregate gate, per-scope whitelist
**Confirmed (your §4.1).** Aggregate gate fires switchover; live placement whitelist filters to scopes that individually contributed positively (per-scope net ROI > 0% AND per-scope net CLV > 0% on **n ≥ 50** in the Pinnacle-anchored evaluation pool — tightened from 30 per Chris's revision). Drag scopes stay in shadow.

Edge case: if filtering produces fewer than 1 whitelisted scope (e.g. one big winner is the whole edge), abort the flip — that's a single-point-of-failure scenario the brief should not tolerate. **Recommend additional rule: switchover requires ≥1 whitelisted scope AND that scope contributes ≤80% of aggregate net ROI.** If one scope is 80%+ of the edge, the model isn't generalising; we wait.

### 1.2 Evaluation pool — single Pinnacle-anchored pool
**Confirmed (your call).** Pool = settled paper bets where `clv_source='pinnacle'` AND `legacy_regime=false` AND `deleted_at IS NULL` AND `bet_track='paper'` AND `placed_at >= <fix_completion_timestamp>`. ROI and CLV both computed on the same 200 rows. No metric-asymmetry.

**Implication for timing:** at current Tier-A close-capture rate of ~60%, after the §2.1 tagging fix lands, the pool will fill at roughly `0.6 × paper_bet_settlement_rate`. Current paper-bet settlement rate is ~5–15/day (highly variable, weekend-heavy). 200 anchored bets ≈ ~5 weeks of clean operation post-fix. Faster if exchange capture for additional markets lands and the paper-bet volume increases.

### 1.3 Markets in scope at switchover — MATCH_ODDS only
**Recommended.** Reasoning:
- Only MATCH_ODDS has any C1 exchange capture today (`betfair_best_back` 100% on paper, 68% on shadow). Even MATCH_ODDS has zero `betfair_market_id` capture — that's the §1.1 hard blocker fix.
- ASIAN_HANDICAP exchange capture is 0% (1376 rows). Likely root cause: AH on Betfair is keyed per-line ("Asian Handicap −0.5"), not as a single market. Sub-phase 4.A wired AH valuation but the `getCatalogueForEvent` → `listMarketCatalogue` filter probably doesn't match AH market types. **Estimated fix work: 3 days** to map our `ASIAN_HANDICAP` + line value to the Betfair line-keyed market_id, plus 2 days to validate against live placement-side. Total ~1 week.
- BTTS: Betfair calls it `BOTH_TEAMS_TO_SCORE`. Likely a string-matching gap. **Estimate: 2 days.**
- TEAM_TOTAL_*: Betfair has separate markets `TEAM_A_OVER_UNDER_X.5` per team per goal-line. **Estimate: 4 days** (many market name permutations).
- OVER_UNDER_*: Betfair's `OVER_UNDER_X5_GOALS`. **Estimate: 2 days** (similar to BTTS, fewer permutations than TEAM_TOTAL).

**Total post-launch capture work: ~2 weeks.** Each market activates live once (a) capture is fixed AND (b) it individually has ≥30 settled paper rows passing the per-scope whitelist filter on Pinnacle-anchored data. **Do not block the switchover on this.** Switchover is MATCH_ODDS only; the universe expands organically as captures land and shadow scopes graduate.

### 1.4 Scopes <200 bets at gate-clear — stay in shadow
**Confirmed (your §4.4 option a).** Aggregate gate fires the switchover; only scopes meeting the §1.1 per-scope whitelist criteria go live. Sub-200-bet scopes stay in shadow until they individually graduate (per-scope net ROI > 0%, per-scope net CLV > 0%, per-scope n ≥ 30 in the Pinnacle-anchored pool). No second switchover ceremony — scopes graduate continuously post-launch.

### 1.5 Gate doesn't clear in 8 weeks — notify, don't auto-relax
**Confirmed (your §4.5 option b).** Implementation:
- `gate_status` table populated daily by a scheduled job (§4 below).
- After 56 days from `evaluation_start_at` without gate clearance, the daily job inserts a `gate_status_review_required` row with a diagnostic manifest:
  - Current aggregate net ROI vs 3% target
  - Current aggregate net CLV vs 2% target
  - Current pool size vs 200 target
  - Per-market and per-tier breakdowns
  - Likely-bottleneck identification (which of the three is closest to clearing? Which is furthest?)
- You query `gate_status_review_required` weekly; absence of rows = gate still clearing on schedule. Presence = decision required.

### 1.6 Production infrastructure — single VPS confirmed
- Single VPS running `~/Football-betting-agent`.
- `api-server` PM2 process hosts the Express server AND all `node-cron` schedules including Z3 (Sun 10:00), Z4 (daily 03:45), modelSelfAudit (daily 03:30).
- `vps-relay` PM2 process on the same box proxies Betfair API. Subsumes the prior DigitalOcean VPS.
- Neon for DB.
- **Implication for §1.4 (Z4 suspension):** suspension is a code edit to `artifacts/api-server/src/services/scheduler.ts` lines ~2685–2690 (comment out the Z4 `cron.schedule` block) plus a config-driven kill switch (`agent_config.z4_enabled='false'`) inside `runAutonomousTierLadder` for belt-and-braces. Same for Z3. One PM2 restart = suspension live.

### 1.7 Half-Kelly ramp — path-aware (Path P: 50 bets; Path S: 100 bets)
**Confirmed (your §4.7 option b), refined per §11 revision.** Implementation:
- The ramp is **per-scope**, not system-wide. Each scope in `live_whitelist` carries its `path` ('P' or 'S') and its own bet counter.
- A scope's `live_kelly_fraction` is derived at placement time from the scope's `path` and its counter:
  - `path='P'`: 0.5 until counter ≥ 50, then 1.0
  - `path='S'`: 0.5 until counter ≥ 100, then 1.0
- A scheduled job (every 15 min) reads each whitelisted scope's settled-live counter. If counter ≥ ramp-threshold AND rolling-N-bet net ROI > 0% (where N matches the ramp threshold), writes the scope's full-Kelly flag. If counter ≥ threshold but rolling ROI ≤ 0%, writes nothing and surfaces a `live_ramp_review_required` row for that scope.
- The `agent_config.live_kelly_fraction` setting is replaced by `live_whitelist.kelly_fraction_override` per scope (default 0.5 at graduation, set to 1.0 by the ramp job when conditions met).

### 1.8 Stop conditions post-switchover
**Confirmed with one tightening.** Your four conditions:
- Drawdown > 15% of bankroll at flip → halt new placements (existing settle naturally).
- Net ROI < −2% on rolling 50 live bets → halt.
- Net CLV < 0% on rolling 50 live bets → **push to rolling 100** (CLV variance is high at n=50, false positives likely).
- Commission deduction outside [4.5%, 5.5%] band → **alert + reconcile, do not halt**. Commission discrepancies are usually backfill-timing or 5% rounding; halting the model on a bookkeeping anomaly is over-reaction.

### 1.9 Pushback held: 3%/2%/200 hardcoded gate is the right call
You said no compromise on the gate. Two things I want on the record so we know what we accepted:
- **The gate is reachable but not easy.** Of 89 settled paper bets in the current regime, MATCH_ODDS aggregate ROI is **−11.40%** with average Pinnacle CLV of +5.47% on n=3. To clear, we need the next ~200 Pinnacle-anchored MATCH_ODDS bets (or whatever mix lands first) to swing aggregate net ROI ~14 percentage points positive. This is achievable if the underlying edge is real, but it does require the recent negative run to be variance-driven, not signal.
- **The 50% degradation absorption assumption needs occasional re-checking.** "1.5% net ROI in live is still positive" assumes the live-vs-shadow gap is ~50%. If the gap is 70%, the gate clears at 3% paper but live runs at 0.9% — still positive, marginal. Add to the post-launch monitoring (§7.5): track the actual gap; if it exceeds 70%, raise to me.

---

## 2. Blocker checklist with validation SQL

Each blocker is **complete** when its validation SQL returns the indicated result. Until all eight are complete, the gate-evaluation job (§4.4) does not run.

### 2.1 (B1) `betfair_market_id` populated on MATCH_ODDS

**Validation:**
```sql
SELECT
  COUNT(*) AS recent_mo,
  COUNT(*) FILTER (WHERE betfair_market_id IS NOT NULL) AS with_id,
  ROUND(100.0*COUNT(*) FILTER (WHERE betfair_market_id IS NOT NULL)/NULLIF(COUNT(*),0),2) AS pct
FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
WHERE pb.market_type='MATCH_ODDS' AND pb.legacy_regime=false AND pb.deleted_at IS NULL
  AND m.kickoff_time BETWEEN NOW() AND NOW() + INTERVAL '48 hours';
-- PASS: pct >= 90
```

### 2.2 (B2) Bankroll-tiered capital protection caps applied

**Validation:**
```sql
WITH br AS (SELECT value::numeric AS bankroll FROM agent_config WHERE key='bankroll'),
     expected AS (
       SELECT
         CASE
           WHEN bankroll < 1000 THEN 'tier_1_growth'
           WHEN bankroll < 5000 THEN 'tier_2_established'
           WHEN bankroll < 25000 THEN 'tier_3_strict'
           ELSE 'tier_4_premium'
         END AS tier,
         CASE
           WHEN bankroll < 1000 THEN 0.25
           WHEN bankroll < 5000 THEN 0.15
           WHEN bankroll < 25000 THEN 0.10
           ELSE 0.07
         END AS expected_daily,
         CASE
           WHEN bankroll < 1000 THEN 0.40
           WHEN bankroll < 5000 THEN 0.30
           WHEN bankroll < 25000 THEN 0.20
           ELSE 0.15
         END AS expected_weekly,
         CASE
           WHEN bankroll < 1000 THEN 150
           ELSE bankroll * 0.05
         END AS expected_floor
       FROM br
     ),
     actual AS (
       SELECT
         (SELECT value::numeric FROM agent_config WHERE key='daily_loss_limit_pct') AS daily,
         (SELECT value::numeric FROM agent_config WHERE key='weekly_loss_limit_pct') AS weekly,
         (SELECT value::numeric FROM agent_config WHERE key='bankroll_floor') AS floor
     )
SELECT e.tier, e.expected_daily, a.daily, e.expected_weekly, a.weekly, e.expected_floor, a.floor,
       (a.daily = e.expected_daily AND a.weekly = e.expected_weekly AND ABS(a.floor - e.expected_floor) < 0.01) AS pass
FROM expected e CROSS JOIN actual a;
-- PASS: pass=true (within rounding)
```

### 2.3 (B3) Commission attribution at settlement

**Validation:**
```sql
SELECT
  COUNT(*) AS recent_settled,
  COUNT(*) FILTER (WHERE gross_pnl IS NOT NULL AND commission_amount IS NOT NULL AND net_pnl IS NOT NULL) AS fully_populated,
  COUNT(*) FILTER (WHERE ABS((gross_pnl::numeric - commission_amount::numeric) - net_pnl::numeric) > 0.01) AS arithmetic_violations,
  COUNT(*) FILTER (WHERE status='won' AND gross_pnl::numeric <= settlement_pnl::numeric) AS won_gross_lte_legacy
FROM paper_bets
WHERE legacy_regime=false AND deleted_at IS NULL
  AND status IN ('won','lost') AND placed_at > NOW() - INTERVAL '7 days';
-- PASS: arithmetic_violations=0 AND won_gross_lte_legacy=0
-- (won bets must have gross_pnl > settlement_pnl because settlement_pnl was already net of commission)
```

### 2.4 (B4) Z4 suspended + 4 demotions reverted (DAY-1)

**Validation:**
```sql
-- Z4 suspended in DB-driven kill switch
SELECT value FROM agent_config WHERE key='z4_enabled';
-- PASS: 'false'

-- 4 demotion-related autonomous_pauses rows resolved
SELECT scope_type, scope_value, resumed_at IS NOT NULL AS resolved
FROM autonomous_pauses
WHERE id IN (
  SELECT (supporting_metrics->>'audit_log_id')::int
  FROM model_decision_audit_log
  WHERE decision_type IN ('tier_demoted','tier_demoted_to_shadow')
    AND decision_at >= '2026-05-08 03:30:00'::timestamp
    AND decision_at <= '2026-05-08 03:31:00'::timestamp
);
-- PASS: all rows have resolved=true OR table empty (rows manually deleted)

-- Reversal entries logged
SELECT COUNT(*) AS reversals
FROM model_decision_audit_log
WHERE decision_type='tier_demotion_reverted'
  AND decision_at > '2026-05-08 03:31:00'::timestamp;
-- PASS: reversals >= 4
```

### 2.5 (B5) Pinnacle CLV tagging fix + backfill

**Validation:**
```sql
-- Forward correctness: of bets settled in last 24h with closing_pinnacle_odds captured, all should have clv_source='pinnacle'
SELECT
  COUNT(*) FILTER (WHERE closing_pinnacle_odds IS NOT NULL) AS has_close,
  COUNT(*) FILTER (WHERE closing_pinnacle_odds IS NOT NULL AND clv_source='pinnacle') AS tagged,
  COUNT(*) FILTER (WHERE closing_pinnacle_odds IS NOT NULL AND (clv_source IS NULL OR clv_source != 'pinnacle')) AS untagged_with_close
FROM paper_bets
WHERE legacy_regime=false AND deleted_at IS NULL
  AND status IN ('won','lost')
  AND settled_at > NOW() - INTERVAL '24 hours';
-- PASS: untagged_with_close = 0

-- Backfill: of all settled bets in current regime, untagged_with_close should also be 0
SELECT COUNT(*) AS untagged_with_close_lifetime
FROM paper_bets
WHERE legacy_regime=false AND deleted_at IS NULL
  AND status IN ('won','lost')
  AND closing_pinnacle_odds IS NOT NULL
  AND (clv_source IS NULL OR clv_source != 'pinnacle');
-- PASS: untagged_with_close_lifetime = 0
```

### 2.6 (B6) `bet_track` enum migration

**Validation:**
```sql
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE bet_track IS NOT NULL) AS populated,
  COUNT(*) FILTER (WHERE bet_track='paper') AS paper,
  COUNT(*) FILTER (WHERE bet_track='shadow') AS shadow,
  COUNT(*) FILTER (WHERE bet_track='live') AS live
FROM paper_bets WHERE deleted_at IS NULL;
-- PASS: populated=total AND live=0 (no live bets pre-flip)
-- Sanity: paper rows have stake>0; shadow rows have stake=0 AND shadow_stake IS NOT NULL
```

### 2.7 (B7) Cleared-orders polling cron verified

**Validation:** code-walk confirms `scheduler.ts` has a `cron.schedule(...)` entry calling `reconcileSettlements` (or equivalent) at ≤15 min cadence; one row inserted into `cron_executions` table per run; last 24h shows ≥96 successful runs (24h × 4 runs/h) with no error rows.

```sql
SELECT
  COUNT(*) FILTER (WHERE status='success') AS ok,
  COUNT(*) FILTER (WHERE status='error') AS err,
  MAX(started_at) AS last_run
FROM cron_executions
WHERE cron_name LIKE '%reconcil%' AND started_at > NOW() - INTERVAL '24 hours';
-- PASS: ok >= 80 (allows small slack), err=0, last_run within 30 min of NOW()
```

### 2.8 (B8) `placement_failed` rows diagnosed

**Validation:** for each of the 9 placement_failed rows in last 7 days, an annotation in a new `placement_failure_diagnoses` table or `compliance_logs.action_type='placement_failure_diagnosed'` row exists with cause classification (`timeout` | `liquidity` | `mapping` | `auth` | `other`) and resolution disposition (`recoverable` | `bug_fixed` | `accept`).

```sql
WITH failed AS (
  SELECT id FROM paper_bets
  WHERE status='placement_failed' AND legacy_regime=false AND deleted_at IS NULL
    AND placed_at > NOW() - INTERVAL '7 days'
)
SELECT COUNT(*) AS failed,
       (SELECT COUNT(*) FROM compliance_logs WHERE action_type='placement_failure_diagnosed'
          AND (details->>'paper_bet_id')::int IN (SELECT id FROM failed)) AS diagnosed
FROM failed;
-- PASS: diagnosed = failed
```

---

## 3. Day-by-day execution plan

Two parallel tracks. Day 1 = the day Chris signs off this plan and pushes the start.

### Track A — Day-1 work (MUST happen first)

| Day | Item | Owner | Output | Chris involved? |
|---|---|---|---|---|
| 1 | **B4 — suspend Z3 + Z4, revert 4 demotions** | Claude → push to VPS | scheduler.ts edit, agent_config.z4_enabled='false', autonomous_pauses rows resolved, model_decision_audit_log reversal entries | Approve PR; pull/build/restart on VPS |
| 1 | Validate B4 SQL passes | Claude (Neon MCP) | Confirmation in plan thread | No |

**Track A completes day 1.** Z4 stops further damage to evaluation pool. Reversion restores three profitable scopes to DEFAULT.

### Track B — Parallel prep (starts day 1, completes by day ~10)

| Day | Item | Owner | Dependencies | Chris involved? |
|---|---|---|---|---|
| 1–2 | **B6 — `bet_track` enum migration** | Claude | None | Approve migration |
| 1–3 | **B5 — Pinnacle CLV tagging fix** | Claude | None | Approve PR |
| 4 | B5 backfill on existing rows | Claude | B5 fix landed | No |
| 1–3 | **B3 — Commission attribution at settlement** | Claude | None | Approve PR |
| 4 | B3 backfill `gross_pnl` on existing settled rows | Claude | B3 landed | No |
| 1–3 | **B2 — Bankroll-tiered caps job** (§3.1 below) | Claude | None | Approve PR + initial caps. **NB:** caps are NOT applied until switchover transaction; the job runs but writes to a `pending_caps` table, not `agent_config`. Pre-flip bankroll-protection-on-paper remains relaxed. |
| 1–4 | **B1 — `betfair_market_id` capture on MATCH_ODDS** | Claude | None | Approve PR |
| 5 | B1 backfill on rows where match in next 48h | Claude | B1 landed | No |
| 6–7 | **B7 — verify cleared-orders polling cron** | Claude | None | No |
| 6–7 | **B8 — diagnose 9 placement_failed rows** | Claude | None | Yes — review diagnoses if any are not benign |
| 8 | All 8 validation SQLs run; mark `evaluation_start_at` in agent_config | Claude | All blockers PASS | Confirm |
| 9–10 | Buffer / fix anything failing validation | Claude | — | As needed |

**Critical path is B5 (Pinnacle CLV tagging).** Without it, the evaluation pool is too small and the gate cannot fire. B1 second priority. B3 third (it's a metric correctness fix; without it, every reported ROI is wrong).

### Track C — Evaluation window (~5 weeks once Track B complete)

| Day | Item | Output |
|---|---|---|
| ~10 | `evaluation_start_at` written to agent_config | Pool population begins |
| ~10–45 | Daily gate-monitoring job runs (§4.4); writes `gate_status` rows | Visibility |
| ~30 | First mid-window check-in: gate components close to clearing? | Diagnostic |
| ~45 | Aggregate gate likely clears (200 Pinnacle-anchored bets ≈ 5 weeks at current settlement velocity) | `gate_clear_pending_review` row inserted |
| ~45 | Chris reviews manifest, runs `npm run flip-to-live -- --confirm --manifest-hash=<hash>` | Switchover |

If at day ~66 (8 weeks of evaluation post-fixes) gate still hasn't cleared, `gate_status_review_required` row inserted; Chris diagnoses.

### Track D — Post-launch (parallel to live operation)

| Item | Trigger | Notes |
|---|---|---|
| Exchange capture for AH | Post-flip, no urgency | ~3 days work |
| Exchange capture for BTTS | Post-flip | ~2 days |
| Exchange capture for OVER_UNDER_* | Post-flip | ~2 days |
| Exchange capture for TEAM_TOTAL_* | Post-flip | ~4 days |
| Replace Z4 Kelly metric, re-enable Z4 | After 50 settled live bets | Use `bankroll_snapshots`-based true Kelly growth |
| Z6 multiple-comparison correction | When first feature is close to passing | Bonferroni / FDR |

---

## 4. Gate logic — SQL only

### 4.1 Evaluation pool definition

```sql
CREATE OR REPLACE VIEW evaluation_pool AS
SELECT pb.*
FROM paper_bets pb
WHERE pb.legacy_regime = false
  AND pb.deleted_at IS NULL
  AND pb.bet_track = 'paper'
  AND pb.status IN ('won','lost')
  AND pb.clv_source = 'pinnacle'
  AND pb.gross_pnl IS NOT NULL
  AND pb.commission_amount IS NOT NULL
  AND pb.net_pnl IS NOT NULL
  AND pb.placed_at >= (SELECT value::timestamptz FROM agent_config WHERE key='evaluation_start_at');
```

### 4.2 Aggregate gate components

```sql
CREATE OR REPLACE VIEW gate_components AS
WITH p AS (SELECT * FROM evaluation_pool)
SELECT
  -- Component 1: bet count
  (SELECT COUNT(*) FROM p) AS pool_size,

  -- Component 2: aggregate net ROI (stake-weighted)
  (SELECT
     CASE WHEN SUM(stake::numeric) > 0
          THEN SUM(net_pnl::numeric) / SUM(stake::numeric)
          ELSE NULL END
   FROM p) AS aggregate_net_roi,

  -- Component 3: aggregate net CLV (mean clv_pct)
  (SELECT AVG(clv_pct::numeric) FROM p) AS aggregate_net_clv,

  -- Diagnostic: components broken down per market
  (SELECT json_object_agg(market_type, json_build_object(
     'n', n, 'roi', roi, 'clv', clv))
   FROM (SELECT market_type, COUNT(*) AS n,
                ROUND(100.0 * SUM(net_pnl::numeric) / NULLIF(SUM(stake::numeric),0), 2) AS roi,
                ROUND(AVG(clv_pct::numeric)::numeric, 2) AS clv
         FROM p GROUP BY market_type) x) AS by_market;
```

### 4.3 Whitelist computation (per-scope filter)

```sql
CREATE OR REPLACE VIEW switchover_whitelist AS
WITH per_scope AS (
  SELECT market_type, m.league,
         COUNT(*) AS n,
         SUM(net_pnl::numeric) / NULLIF(SUM(stake::numeric),0) AS scope_net_roi,
         AVG(clv_pct::numeric) AS scope_net_clv,
         SUM(net_pnl::numeric) AS scope_net_pnl_total
  FROM evaluation_pool ep JOIN matches m ON m.id = ep.match_id
  GROUP BY market_type, m.league
),
aggregate AS (SELECT SUM(net_pnl::numeric) AS agg_pnl FROM evaluation_pool)
SELECT ps.market_type, ps.league, ps.n, ps.scope_net_roi, ps.scope_net_clv,
       ps.scope_net_pnl_total / NULLIF(a.agg_pnl, 0) AS share_of_agg_pnl
FROM per_scope ps CROSS JOIN aggregate a
WHERE ps.n >= 50
  AND ps.scope_net_roi > 0
  AND ps.scope_net_clv > 0
  AND ps.market_type = 'MATCH_ODDS';  -- restricted at switchover; expand as exchange captures land
```
*Per-scope n threshold tightened from 30 to 50 per Chris's §11 revision.*

### 4.4 Gate-monitoring scheduled job

New `gate_status` table:
```sql
CREATE TABLE gate_status (
  id SERIAL PRIMARY KEY,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pool_size INT NOT NULL,
  aggregate_net_roi NUMERIC,
  aggregate_net_clv NUMERIC,
  threshold_roi NUMERIC NOT NULL DEFAULT 0.03,
  threshold_clv NUMERIC NOT NULL DEFAULT 2.0,
  threshold_n INT NOT NULL DEFAULT 200,
  pool_size_pass BOOLEAN NOT NULL,
  roi_pass BOOLEAN NOT NULL,
  clv_pass BOOLEAN NOT NULL,
  all_pass BOOLEAN NOT NULL,
  whitelist_size INT,
  whitelist_largest_share NUMERIC,
  manifest JSONB
);

CREATE TABLE gate_clear_pending_review (
  id SERIAL PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  manifest_hash TEXT NOT NULL,
  manifest JSONB NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution TEXT  -- 'flipped' | 'aborted' | 'expired'
);

CREATE TABLE gate_status_review_required (
  id SERIAL PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL,
  diagnostic JSONB NOT NULL,
  acknowledged_at TIMESTAMPTZ
);
```

Daily 04:00 UTC cron in scheduler.ts (after model_self_audit which is now suspended; the slot is free):

```ts
// Pseudocode for the cron body
async function runGateMonitor() {
  const components = await db.execute(sql`SELECT * FROM gate_components`);
  const c = components.rows[0];

  const pool_size_pass = c.pool_size >= 200;
  const roi_pass = (c.aggregate_net_roi ?? 0) >= 0.03;
  const clv_pass = (c.aggregate_net_clv ?? 0) >= 2.0;
  const all_pass = pool_size_pass && roi_pass && clv_pass;

  // Compute whitelist health
  const whitelist = await db.execute(sql`SELECT * FROM switchover_whitelist`);
  const wlSize = whitelist.rows.length;
  const wlLargestShare = wlSize > 0
    ? Math.max(...whitelist.rows.map(r => r.share_of_agg_pnl))
    : null;

  const manifest = {
    pool_size: c.pool_size,
    aggregate_net_roi: c.aggregate_net_roi,
    aggregate_net_clv: c.aggregate_net_clv,
    by_market: c.by_market,
    whitelist: whitelist.rows,
    whitelist_size: wlSize,
    whitelist_largest_share: wlLargestShare,
    bankroll: await getConfig('bankroll'),
    evaluation_start_at: await getConfig('evaluation_start_at'),
    blockers_validated_at: await getConfig('blockers_validated_at'),
  };

  await db.insert(gateStatusTable).values({
    poolSize: c.pool_size, aggregateNetRoi: c.aggregate_net_roi, aggregateNetClv: c.aggregate_net_clv,
    poolSizePass: pool_size_pass, roiPass: roi_pass, clvPass: clv_pass, allPass: all_pass,
    whitelistSize: wlSize, whitelistLargestShare: wlLargestShare,
    manifest,
  });

  // Fire pending-review row only if all_pass AND additional rules satisfied
  if (all_pass && wlSize >= 1 && wlLargestShare <= 0.80) {
    const hash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    // Insert only if no unresolved row exists
    await db.execute(sql`
      INSERT INTO gate_clear_pending_review (manifest_hash, manifest)
      SELECT ${hash}, ${manifest}::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM gate_clear_pending_review WHERE resolved_at IS NULL)
    `);
  }

  // 8-week diagnostic
  const evalStart = new Date(await getConfig('evaluation_start_at'));
  const daysElapsed = (Date.now() - evalStart.getTime()) / 86400000;
  if (daysElapsed >= 56 && !all_pass) {
    // Insert a diagnostic row only once per 7 days
    await db.execute(sql`
      INSERT INTO gate_status_review_required (reason, diagnostic)
      SELECT 'gate_not_cleared_after_56_days', ${manifest}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM gate_status_review_required
        WHERE detected_at > NOW() - INTERVAL '7 days' AND acknowledged_at IS NULL
      )
    `);
  }
}
```

### 4.5 Manual flip command

`scripts/src/flipToLive.ts` (new):
- Re-runs `gate_components` query.
- Recomputes manifest hash; aborts if mismatch with provided `--manifest-hash`.
- Verifies all 8 blockers still PASS.
- Verifies no unresolved `gate_status_review_required` rows.
- Calls `update_bankroll_tier_caps()` to set the live caps for current bankroll tier.
- Executes the §5 atomic transaction.
- Marks the `gate_clear_pending_review` row as `resolution='flipped'`.
- Writes a `compliance_logs` row.

CLI usage:
```
npm run flip-to-live -- --confirm --manifest-hash=<sha256>
```
- No `--confirm` flag → prints manifest, computes hash, exits without flipping.
- Hash mismatch → aborts.
- Any blocker FAIL → aborts with diagnostic.

---

## 5. Atomic switchover transaction

```sql
BEGIN;
  -- 1. Re-verify gate (within transaction). If false, RAISE EXCEPTION (transaction aborts).
  WITH gc AS (SELECT * FROM gate_components)
  SELECT CASE
    WHEN gc.pool_size < 200 THEN
      RAISE EXCEPTION 'Gate failed: pool_size=% < 200', gc.pool_size
    WHEN gc.aggregate_net_roi < 0.03 THEN
      RAISE EXCEPTION 'Gate failed: net_roi=% < 0.03', gc.aggregate_net_roi
    WHEN gc.aggregate_net_clv < 2.0 THEN
      RAISE EXCEPTION 'Gate failed: net_clv=% < 2.0', gc.aggregate_net_clv
  END FROM gc;

  -- 2. Apply bankroll-tiered capital protection caps for current bankroll tier
  -- (call to update_bankroll_tier_caps function written for B2)
  SELECT update_bankroll_tier_caps();

  -- 3. Flip mode flags
  UPDATE agent_config SET value='false', updated_at=NOW() WHERE key='paper_mode';
  INSERT INTO agent_config (key, value) VALUES ('live_mode_active','true')
    ON CONFLICT (key) DO UPDATE SET value='true', updated_at=NOW();
  INSERT INTO agent_config (key, value) VALUES ('paper_bet_generation_enabled','false')
    ON CONFLICT (key) DO UPDATE SET value='false', updated_at=NOW();
  INSERT INTO agent_config (key, value) VALUES ('live_kelly_fraction','0.5')
    ON CONFLICT (key) DO UPDATE SET value='0.5', updated_at=NOW();
  INSERT INTO agent_config (key, value) VALUES ('live_mode_activated_at', NOW()::text)
    ON CONFLICT (key) DO UPDATE SET value=NOW()::text, updated_at=NOW();

  -- 4. Persist whitelist (snapshot at flip)
  CREATE TABLE IF NOT EXISTS live_whitelist (
    id SERIAL PRIMARY KEY,
    snapshotted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_type TEXT NOT NULL,
    league TEXT NOT NULL,
    n INT, scope_net_roi NUMERIC, scope_net_clv NUMERIC, share_of_agg_pnl NUMERIC,
    active BOOLEAN NOT NULL DEFAULT true
  );
  INSERT INTO live_whitelist (market_type, league, n, scope_net_roi, scope_net_clv, share_of_agg_pnl)
  SELECT market_type, league, n, scope_net_roi, scope_net_clv, share_of_agg_pnl
  FROM switchover_whitelist;

  -- 5. Compliance log
  INSERT INTO compliance_logs (action_type, details, timestamp)
  SELECT 'live_mode_activated',
         jsonb_build_object(
           'gate_manifest', (SELECT manifest FROM gate_clear_pending_review WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 1),
           'whitelisted_scopes', (SELECT json_agg(row_to_json(w)) FROM switchover_whitelist w),
           'bankroll_at_flip', (SELECT value::numeric FROM agent_config WHERE key='bankroll'),
           'caps_applied', jsonb_build_object(
             'daily', (SELECT value FROM agent_config WHERE key='daily_loss_limit_pct'),
             'weekly', (SELECT value FROM agent_config WHERE key='weekly_loss_limit_pct'),
             'floor', (SELECT value FROM agent_config WHERE key='bankroll_floor')),
           'live_kelly_fraction', '0.5'
         ),
         NOW();

  -- 6. Mark the pending-review row as flipped
  UPDATE gate_clear_pending_review
  SET resolved_at = NOW(), resolution = 'flipped'
  WHERE resolved_at IS NULL;
COMMIT;
```

After commit:
- Paper bets currently `pending` settle to completion (stake>0 rows continue through existing settlement codepath).
- Shadow bet generation continues unchanged.
- `valueDetection.ts` reads `paper_bet_generation_enabled='false'` and stops emitting paper bets.
- Live placement begins on `live_whitelist.active=true` rows only.
- After 50 settled live bets at half Kelly, the §1.7 ramp-check job upgrades `live_kelly_fraction='1.0'`.

---

## 6. Bankroll-tiered caps job — implementation specifics

`updateBankrollTierCaps` lives in `services/liveRiskManager.ts`. Daily 03:00 UTC cron (early enough that settlement at ~04:00 sees correct caps).

Tier table embedded as constants:
```ts
const TIER_TABLE = [
  { max_bankroll: 1000,   tier: 'tier_1_growth',      daily: 0.25, weekly: 0.40, floor_abs: 150 },
  { max_bankroll: 5000,   tier: 'tier_2_established', daily: 0.15, weekly: 0.30, floor_pct: 0.10 },
  { max_bankroll: 25000,  tier: 'tier_3_strict',      daily: 0.10, weekly: 0.20, floor_pct: 0.05 },
  { max_bankroll: Infinity, tier: 'tier_4_premium',   daily: 0.07, weekly: 0.15, floor_pct: 0.05 },
];
```

Hysteresis state stored in agent_config:
- `current_bankroll_tier` — the tier currently applied (e.g. `tier_2_established`).
- `tier_upgrade_pending_since` — timestamp when bankroll first crossed up into a tighter tier; null if not pending.

Algorithm:
1. Read current bankroll.
2. Compute tier-by-bankroll (the "natural" tier).
3. If natural tier looser than `current_bankroll_tier` (downward) → apply immediately, clear `tier_upgrade_pending_since`, log to `model_decision_audit_log`.
4. If natural tier tighter than `current_bankroll_tier` (upward):
   - If `tier_upgrade_pending_since IS NULL` → set to NOW(), log "pending tighten".
   - If NOW() − `tier_upgrade_pending_since` ≥ 7 days → apply, clear timestamp, log "tighten applied".
   - Else → no-op, log "still pending".
5. Same tier → no-op.
6. **Capital cap values**: write `daily_loss_limit_pct`, `weekly_loss_limit_pct`, and `bankroll_floor` to agent_config matching the applied tier.

**Pre-flip state:** the job runs from day 1 (so we have 7+ days of tier observation when the gate fires) but DOES NOT write to agent_config caps. Instead, it writes to a new `pending_caps` table. Switchover transaction reads `pending_caps` and applies. **Paper-mode caps stay relaxed (99% / 0) until flip.**

---

## 7. Risk register specific to the hardcoded-gate approach

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Gate clears on lucky run; live performance underperforms paper expectation | Medium | High | (a) Bar absorbs 50% degradation by design; (b) §1.7 half-Kelly first 50 bets; (c) §1.8 stop conditions |
| R2 | Gate never clears because real edge is below 3% net ROI | Medium | Medium (delays go-live) | §1.5 8-week diagnostic; allows decision to relax bar (with scrutiny) or accept model isn't ready |
| R3 | Single market type (MATCH_ODDS) dominates evaluation pool, gate clears on a single-point-of-failure | Medium | High | §1.1 additional rule: one scope ≤80% of aggregate net PnL; aborts switchover if violated |
| R4 | Pinnacle CLV tagging fix introduces a regression (over-tags, undercaps, missing edge cases) | Medium | High (gate computed on bad data) | B5 validation SQL is explicit; backfill is verified before evaluation_start_at is set |
| R5 | Z4 is suspended but a similar autonomous machinery (Z3, modelSelfAudit) silently fires further bad demotions | Low | Medium | Day-1 work also disables Z3 and modelSelfAudit; daily SQL check on `model_decision_audit_log` for any tier_demoted/tier_promoted_autonomous rows in last 24h, alert if any |
| R6 | Paper-bet settlement velocity drops, evaluation pool grows too slowly to clear before 8-week diagnostic | Medium | Low (just delays) | Monitor `gate_status` weekly; if pool growth rate < 4 anchored bets/day, investigate Pinnacle close-capture or paper-generation pipeline |
| R7 | `placement_failed` on first live bet (e.g. market not on Betfair, listing closed, liquidity gone) | Medium | Medium | Whitelist scopes restricted to MATCH_ODDS where capture is verified; first 50 bets at half Kelly limits exposure; halt-on-rejection-rate >5% in §1.8 |
| R8 | Bankroll-tiered cap upgrade hysteresis lets bankroll grow into a tighter tier and back down within 7 days, never tightening | Low | Low | Acceptable. The asymmetry is by design — if bankroll oscillates, the looser caps are safer. Re-evaluate if observed. |
| R9 | Manifest hash collision or replay attack on flip-to-live CLI | Negligible | Low | SHA-256 on full manifest including timestamp; CLI re-checks gate at execution time; transaction aborts if gate false at commit |
| R10 | Z4 stays suspended forever (people forget to re-enable it after fix) | Medium | Low | Track in §3 Track D; reminder in `gate_status_review_required` post-50-live-bets |
| R11 | Live commission deduction at 5% on Betfair ≠ what we modelled (e.g. discount rate, market base rate < 5% for some football submarkets) | Low | Low | B3 backfill-validation includes a sanity check; live divergence monitored via §1.8 commission band rule (alert+reconcile, not halt) |
| R12 | First live bet placed before whitelist snapshot is committed (race condition) | Low | High | Switchover transaction is atomic — either everything commits including whitelist, or nothing |
| R13 | Aggregate gate clears but per-scope whitelist is empty (every scope individually negative ROI on Pinnacle-anchored subset) | Low | Medium | §1.1 additional rule: switchover requires ≥1 whitelisted scope. If aggregate clears but whitelist empty, gate logically cannot fire — investigate. |

---

## 8. Implementation sequencing — full critical path

```
DAY 1                        DAY 1-3                     DAY 4-5                    DAY 6-7         DAY 8     DAY 10           DAY 10 - ~45                 DAY ~45+
─────                        ───────                     ───────                    ───────         ─────     ──────           ────────────                 ────────
Track A (must finish day 1)
B4: Suspend Z3+Z4+modelSelfAudit
    Revert 4 demotions
    Validate B4 SQL ✓

Track B (parallel, day 1 onwards)
B6: bet_track migration ─ PR ─ deploy ✓
B5: Pinnacle CLV tagging fix ── B5 backfill ✓
B3: Commission attribution ── B3 backfill ✓
B2: Bankroll-tiered caps job (writes to pending_caps) ✓
B1: betfair_market_id capture ── B1 backfill ✓
                                                                                    B7: cleared-orders verify ✓
                                                                                    B8: 9 placement_failed diagnoses ✓

                                                                                                    DAY 8: All blockers PASS
                                                                                                    Set evaluation_start_at
                                                                                                    Gate-monitor cron writes daily

Track C — Evaluation window
                                                                                                              DAY 10–~45: pool fills with Pinnacle-anchored paper bets
                                                                                                                          gate_status row daily
                                                                                                                          weekly Chris check-in via SQL

                                                                                                                                                         DAY ~45: gate_clear_pending_review fires
                                                                                                                                                                  Chris reviews manifest
                                                                                                                                                                  npm run flip-to-live --confirm --manifest-hash=<>
                                                                                                                                                                  Switchover transaction commits
                                                                                                                                                                  Live placement begins (MATCH_ODDS, half Kelly, whitelist only)

Track D — Post-launch (parallel to live operation)
                                                                                                                                                                                       Live bet 50 → ramp to full Kelly
                                                                                                                                                                                       AH/BTTS/OU exchange capture
                                                                                                                                                                                       Z4 metric replacement + re-enable
```

**Total elapsed time: blockers ~10 days + evaluation ~35 days = ~45 days to flip.**
- If evaluation is faster (more bets/day, more Pinnacle anchoring), faster.
- If evaluation is slower or the gate doesn't clear at 8 weeks, §1.5 diagnostic fires.

**Days requiring Chris involvement:**
- Day 1: approve plan, approve Track A PR, paste VPS deploy commands.
- Days 2–7: PR approvals (B6, B5, B3, B2, B1, B7, B8). Mostly async.
- Day 8: confirm `evaluation_start_at` set.
- Day ~30: optional mid-window check-in.
- Day ~45 (or whenever): review manifest, run flip CLI.
- Day ~52: confirm half-Kelly → full-Kelly ramp (or investigate if rolling-50 ROI ≤ 0).

---

## 9. Open items where I need a final yes/no from Chris before code starts

1. **§1.1 additional rule** — single scope ≤80% of aggregate net P&L. Adds complexity to the switchover gate but kills a clear failure mode. **Confirm: include this rule? (Yes/no.)**
2. **§1.8 CLV halt window** — pushed from rolling 50 to rolling 100 to reduce CLV noise. **Confirm.**
3. **§1.8 commission band** — alert+reconcile only, not halt. **Confirm.**
4. **§6 pre-flip cap state** — I propose paper-mode caps stay relaxed (99%/0) until flip; bankroll-tier caps written to `pending_caps` table for inspection but not applied to live config. **Alternative: tighten caps to bankroll-tier values now even though they don't matter in paper mode.** Confirm preferred behaviour.
5. **§3 Track A scope** — also disable `modelSelfAudit` (which is the cron that fired the 4 bad demotions) alongside Z3 and Z4? It's the same broken metric source. **Confirm.**
6. **§11.2(A) Path S per-scope thresholds** — non-Pinnacle scopes graduate at net ROI ≥ 5%, n ≥ 400, time-ordered split-half ≥ 3% net each. **Confirmed by Chris** (split-half clarified as time-ordered).
7. **§11.2(B) Path S aggregate switchover trigger** — added per Chris: ≥2 distinct market types in cleared scopes, aggregate net ROI ≥ 4%, ≥500 settled shadow bets across cleared scopes. Either Path P **or** Path S aggregate fires the switchover. **Confirmed.**
8. **Path S half-Kelly ramp** — first 100 bets per Path S scope (vs Path P's 50). **Confirmed.**
9. **Path P per-scope filter** — n ≥ 50 (tightened from 30). **Confirmed.**

---

## 10. Two things you said you won't compromise on — rec'd as-is

- **Blockers must be fully fixed and validated by SQL before evaluation begins.** Plan reflects this — `evaluation_start_at` is set at day 8 only after all 8 validation SQLs pass. If any fail, day 9–10 buffer absorbs; if buffer exhausted, Chris decides.
- **3%/2%/200 hardcoded.** Plan reflects this — no relaxation, no ramp; only 8-week diagnostic trigger if the gate doesn't clear, and that's a decision-point for Chris, not an auto-relax.

No softening, no negotiation, no "we can probably get away with…" — the gate is the gate.

---

## 11. Path S — shadow-only graduation for non-Pinnacle scopes

### 11.1 Why this exists

The v2 plan as originally drafted gated all promotion on Pinnacle CLV anchoring. That's correct for the *initial switchover trigger* (Path P, §4) — Pinnacle is the only anchor that can validate the model is beating sharp money. But it would lock out the universe of scopes where Pinnacle coverage doesn't exist:

- Tier B leagues with sparse Pinnacle pricing (Eliteserien, Jupiler Pro League, Czech Liga, etc.)
- Tier C leagues without Pinnacle coverage at all (MLS, NWSL Women, Brasileirão Women, A-League, niche cup competitions)
- Markets Pinnacle doesn't price reliably (TEAM_TOTAL_*, some OVER_UNDER variants)

These scopes are the entire reason the shadow rail exists. They're already accumulating evidence (since 2026-05-03 per the Phase 2.A architectural note, with 1,983 shadow rows captured to date — though only ~40 settled so far, all post-fix sample sizes will be much higher by switchover time).

**Path S is the second graduation lane.** Scopes graduate to live by demonstrating durable edge in shadow, without a Pinnacle CLV requirement.

### 11.2 The Path P / Path S split

**Path P (Pinnacle-anchored)** — § 4 of v2:
- Aggregate gate: net ROI ≥ 3% AND net CLV ≥ 2% AND n ≥ 200 in the Pinnacle-anchored evaluation pool.
- Aggregate clearing **fires the system switchover** (the one and only paper→live flip).
- Per-scope whitelist filter: per-scope net ROI > 0 AND per-scope net CLV > 0 on n ≥ 30 Pinnacle-anchored bets.

**Path S (Shadow-only)** — new, this section. Two layers:

**(A) Path S per-scope graduation** — adds individual scopes to the live whitelist:
- Evaluation pool: settled shadow bets in scope (`bet_track='shadow'`, `legacy_regime=false`, `placed_at >= evaluation_start_at`).
- Three conditions, all required:
  1. **n ≥ 400** settled shadow bets in scope
  2. **Stake-weighted shadow net ROI ≥ 5%** on the full sample
  3. **Split-half consistency (time-ordered):** dividing the scope's bets into the chronologically earliest n/2 (first half) and chronologically latest n/2 (second half) — using `ROW_NUMBER() OVER (PARTITION BY scope ORDER BY placed_at)` — BOTH halves must show net ROI ≥ 3%. **Time-ordered, not random — random halves cannot detect drift; time-ordered halves can.** This is the explicit point: a scope where edge is concentrated in the first month and absent in the second month must fail this test.

**(B) Path S aggregate trigger** — fires the system switchover (alternative to Path P):
- All three conditions required:
  1. **≥ 2 distinct market types** represented in the set of Path-S-(A)-cleared scopes
  2. **Aggregate net ROI ≥ 4%** across all settled shadow bets in cleared scopes (stake-weighted)
  3. **≥ 500 total settled shadow bets** across cleared scopes
- Note: per-scope (A) requires ≥5% net ROI; aggregating across (A)-cleared scopes will mathematically clear the 4% aggregate trivially in most cases. The binding constraint here is the **500-bet minimum** plus the **2-market diversity** requirement. This means the smallest possible Path S aggregate trigger is 2 cleared scopes from different market types totalling ≥500 bets (e.g., one MATCH_ODDS scope at n=400 + one ASIAN_HANDICAP scope at n=100... no, n=100 fails (A); minimum becomes one cleared scope at n=400 + a second cleared scope at n≥100 if it independently passes, but n≥400 is required for (A) — so realistic minimum is 2 cleared scopes at n=400 each = 800 bets).

**Either Path P aggregate OR Path S aggregate triggers the system switchover.** The first to fire wins. The whitelist at switchover is UNION of Path-P-individually-cleared scopes and Path-S-(A)-individually-cleared scopes.

**Pre-flip behaviour:** both Path P and Path S evaluators run continuously from `evaluation_start_at` (day 8). The gate-monitoring cron (§4.4) checks both triggers daily.

**Post-flip behaviour:** Path P and Path S (A) both run continuously per scope; new scopes graduate as their respective evidence accumulates. Path S (B) is no longer evaluated post-flip (the system is already live).

### 11.3 shadow_pnl integrity check (data confirmed)

```sql
-- Run 2026-05-08 — shadow_pnl is populated and net of an implied 5% commission on wins
SELECT market_type, status, COUNT(*) n,
  AVG(CASE WHEN status='won'
           THEN shadow_pnl::numeric - shadow_stake::numeric*(odds_at_placement::numeric - 1)
           WHEN status='lost' THEN shadow_pnl::numeric - (-shadow_stake::numeric) END)
    ::numeric(10,4) AS avg_diff
FROM paper_bets
WHERE deleted_at IS NULL AND legacy_regime=false AND status IN ('won','lost')
  AND shadow_stake IS NOT NULL AND shadow_stake::numeric > 0
GROUP BY 1,2;
```
- Lost rows: `avg_diff = 0.0000` (perfect; shadow_pnl = −shadow_stake).
- Won rows: `avg_diff ≈ −0.5 to −2.0` per market depending on stake size — wins are deducted ~5% commission.

**Implication:** shadow ROI computed from `shadow_pnl / shadow_stake` is **already net of implied commission**. Compare directly against Path P's net ROI without applying any further adjustment. This is what we want.

**One bug to log (B8 add-on):** the integrity query found one settled won MATCH_ODDS row with `shadow_pnl IS NULL` and `shadow_stake > 0`. Likely a settlement-time race or a missing case in the commission application. Diagnose alongside the 9 placement_failed rows.

### 11.4 Why these thresholds — calibration rationale

**Why ROI 5% (vs Path P's 3%):**
- Path P's 3% is *net of commission AND CLV-anchored*. The CLV anchor adds independent statistical confirmation that the edge is against sharp money, not against our own pricing.
- Path S has no anchor. To compensate, raise the ROI bar by ~200bp. 5% net ROI is "clearly above noise" territory — at typical betting variance, n=400 with mean ROI=5% gives a t-stat ≈ 5+ (p < 0.0001), which is comfortably more rigorous than Path P's effective p < 0.01.
- Also matches Chris's "mid-tier professional sharpness" framing — 5% net ROI is near top-quartile syndicate territory.

**Why n ≥ 400 (vs Path P's 200):**
- Doubling the sample compensates for the missing CLV second-test power.
- At ~5–15 settled shadow bets per scope per week (current observed rate), n=400 takes 6–10 months of evidence per scope. Slow but defensible — these are not Pinnacle-validated, so the bar must be high.
- For high-volume scopes (e.g., a popular AH market in MLS shadow could see 3+ bets per match-day), n=400 might be reachable in 3 months.

**Why split-half ≥ 3% each, time-ordered:**
- Kills the case where cumulative ROI is +5% but came entirely from a single hot streak in (say) the first month — i.e., **drift**.
- **Time-ordered (not random)** is the load-bearing detail. Random halves would still show ~5% in each half if the underlying edge is real or if the edge was concentrated in the first month — the test wouldn't distinguish. Time-ordered halves expose drift directly: if early-period ROI is +12% and late-period ROI is −2%, average is +5% but second-half is −2% and the test fails.
- 3% threshold per half is calibrated to be just above noise — both halves must show genuine edge, not just sampling-window luck.
- Cheap to compute; meaningful filter.

**Risk if these are too tight:** scopes never graduate, non-Pinnacle universe stays shadow-only forever. Mitigation: monitor at 6 months post-launch; if no Path S graduations have happened, review whether the bar is too high.

**Risk if too loose:** unanchored scopes graduate on lucky streaks; capital deployed against fake edge. Mitigation: half-Kelly first **100** live bets per Path S scope (longer than Path P's 50; see §11.7).

### 11.5 Path S gate logic — SQL only

```sql
-- Per-scope shadow evaluation pool
CREATE OR REPLACE VIEW shadow_evaluation_pool AS
SELECT pb.*, m.league
FROM paper_bets pb JOIN matches m ON m.id = pb.match_id
WHERE pb.legacy_regime = false
  AND pb.deleted_at IS NULL
  AND pb.bet_track = 'shadow'
  AND pb.status IN ('won','lost')
  AND pb.shadow_stake IS NOT NULL AND pb.shadow_stake::numeric > 0
  AND pb.shadow_pnl IS NOT NULL
  AND pb.placed_at >= (SELECT value::timestamptz FROM agent_config WHERE key='evaluation_start_at');

-- Path S per-scope status (one row per market_type × league)
CREATE OR REPLACE VIEW path_s_scope_status AS
WITH scope AS (
  SELECT market_type, league,
         COUNT(*) AS n,
         SUM(shadow_stake::numeric) AS stk,
         SUM(shadow_pnl::numeric) AS pnl,
         SUM(shadow_pnl::numeric) / NULLIF(SUM(shadow_stake::numeric),0) AS net_roi,
         -- Split-half
         SUM(shadow_pnl::numeric) FILTER (WHERE rn <= n_total/2) AS first_half_pnl,
         SUM(shadow_stake::numeric) FILTER (WHERE rn <= n_total/2) AS first_half_stk,
         SUM(shadow_pnl::numeric) FILTER (WHERE rn > n_total/2) AS second_half_pnl,
         SUM(shadow_stake::numeric) FILTER (WHERE rn > n_total/2) AS second_half_stk
  FROM (
    SELECT market_type, league, shadow_stake, shadow_pnl,
           ROW_NUMBER() OVER (PARTITION BY market_type, league ORDER BY placed_at) AS rn,
           COUNT(*) OVER (PARTITION BY market_type, league) AS n_total
    FROM shadow_evaluation_pool
  ) ranked
  GROUP BY market_type, league
)
SELECT market_type, league, n, net_roi,
  first_half_pnl / NULLIF(first_half_stk,0) AS first_half_roi,
  second_half_pnl / NULLIF(second_half_stk,0) AS second_half_roi,
  -- Pass criteria
  (n >= 400) AS n_pass,
  (net_roi >= 0.05) AS roi_pass,
  ((first_half_pnl / NULLIF(first_half_stk,0) >= 0.03)
   AND (second_half_pnl / NULLIF(second_half_stk,0) >= 0.03)) AS split_half_pass,
  (n >= 400 AND net_roi >= 0.05
   AND (first_half_pnl / NULLIF(first_half_stk,0) >= 0.03)
   AND (second_half_pnl / NULLIF(second_half_stk,0) >= 0.03)) AS path_s_pass
FROM scope;
```

### 11.5b Path S aggregate trigger SQL

```sql
-- Aggregate state across Path-S-(A)-cleared scopes
CREATE OR REPLACE VIEW path_s_aggregate_status AS
WITH cleared AS (
  SELECT market_type, league
  FROM path_s_scope_status
  WHERE path_s_pass = true
),
cleared_bets AS (
  SELECT pb.shadow_stake::numeric AS stk, pb.shadow_pnl::numeric AS pnl, pb.market_type
  FROM shadow_evaluation_pool pb
  JOIN matches m ON m.id = pb.match_id
  JOIN cleared c ON c.market_type = pb.market_type AND c.league = m.league
)
SELECT
  COUNT(*) AS pool_size_cleared,
  COUNT(DISTINCT market_type) AS distinct_markets_cleared,
  CASE WHEN SUM(stk) > 0 THEN SUM(pnl) / SUM(stk) ELSE NULL END AS aggregate_net_roi_cleared,
  -- Pass criteria (all required)
  (COUNT(*) >= 500) AS path_s_n_pass,
  (COUNT(DISTINCT market_type) >= 2) AS path_s_diversity_pass,
  (CASE WHEN SUM(stk) > 0 THEN SUM(pnl) / SUM(stk) ELSE NULL END >= 0.04) AS path_s_roi_pass,
  ((COUNT(*) >= 500)
   AND (COUNT(DISTINCT market_type) >= 2)
   AND (CASE WHEN SUM(stk) > 0 THEN SUM(pnl) / SUM(stk) ELSE NULL END >= 0.04)) AS path_s_aggregate_pass
FROM cleared_bets;
```

The gate-monitoring cron (§4.4) is extended to evaluate both triggers:

```ts
// Extends §4.4 cron body
const pPass = await db.execute(sql`SELECT all_pass FROM gate_components`);  // Path P
const sPass = await db.execute(sql`SELECT path_s_aggregate_pass FROM path_s_aggregate_status`);  // Path S

const trigger = pPass.rows[0]?.all_pass ? 'P'
              : sPass.rows[0]?.path_s_aggregate_pass ? 'S'
              : null;

if (trigger) {
  // Insert gate_clear_pending_review row with trigger='P' or 'S'
  // Whitelist UNION includes Path P passers and Path S (A) passers regardless of trigger
}
```

**Trigger priority:** Path P preferred when both clear simultaneously (CLV-validated evidence is stronger). Manifest records both states regardless. The `compliance_logs.live_mode_activated` row records which trigger fired.



Replaces §4.3's `switchover_whitelist`:

```sql
CREATE OR REPLACE VIEW switchover_whitelist AS
-- Path P passers: Pinnacle-anchored, individually positive on net ROI AND net CLV
WITH path_p AS (
  SELECT 'P' AS path, ep.market_type, m.league,
         COUNT(*) AS n,
         SUM(ep.net_pnl::numeric) / NULLIF(SUM(ep.stake::numeric),0) AS scope_net_roi,
         AVG(ep.clv_pct::numeric) AS scope_net_clv,
         SUM(ep.net_pnl::numeric) AS scope_net_pnl_total
  FROM evaluation_pool ep JOIN matches m ON m.id = ep.match_id
  GROUP BY ep.market_type, m.league
  HAVING COUNT(*) >= 50
     AND (SUM(net_pnl::numeric) / NULLIF(SUM(stake::numeric),0)) > 0
     AND AVG(clv_pct::numeric) > 0
),
-- Path S passers: shadow-only, n >= 400, ROI >= 5%, split-half >= 3% each
path_s AS (
  SELECT 'S' AS path, market_type, league, n,
         net_roi AS scope_net_roi,
         NULL::numeric AS scope_net_clv,
         net_roi * (
           SELECT SUM(shadow_stake::numeric) FROM shadow_evaluation_pool
           WHERE market_type = pss.market_type AND match_id IN (SELECT id FROM matches WHERE league = pss.league)
         ) AS scope_net_pnl_total
  FROM path_s_scope_status pss
  WHERE path_s_pass = true
)
SELECT * FROM path_p
UNION ALL
SELECT * FROM path_s
WHERE NOT EXISTS (
  -- A scope appearing in both paths: prefer Path P (it's the stronger evidence)
  SELECT 1 FROM path_p p WHERE p.market_type = path_s.market_type AND p.league = path_s.league
);
```

The `path` column on each whitelisted scope is persisted into `live_whitelist` so post-flip monitoring can apply path-specific stop conditions (§11.7).

### 11.7 Stop conditions per path (extends §1.8)

Path-aware halts:

**Path P-graduated scopes:**
- Drawdown > 15% bankroll → halt (system-wide)
- Per-scope rolling-50-bet net ROI < −2% → halt that scope
- Per-scope rolling-100-bet net Pinnacle CLV < 0% → halt that scope (CLV anchor still meaningful)
- Commission band breach → alert+reconcile (system-wide)

**Path S-graduated scopes:**
- Drawdown > 15% bankroll → halt (system-wide)
- Per-scope rolling-50-bet net ROI < −2% → halt that scope
- **No CLV halt** (no Pinnacle anchor exists; CLV cannot be measured)
- **Tighter per-scope ROI band:** since we have no CLV anchor, per-scope rolling-100-bet net ROI < +1% triggers a "demote back to shadow" check (not an immediate halt). Reasoning: a Path S scope's claim to live operation is its sustained edge; a 100-bet window with ROI ≤ 1% net is evidence the edge has degraded.
- Commission band breach → alert+reconcile

**Path-aware Kelly ramp:**
- **Path P scopes:** half-Kelly first **50** bets per scope, then full. Pinnacle CLV anchor gives independent confirmation; shorter ramp justified.
- **Path S scopes:** half-Kelly first **100** bets per scope, then full. No CLV anchor → longer ramp to accumulate live evidence before full sizing. Rationale: at half-Kelly with 100 bets, exposure during the calibration window is 2× longer than Path P but still capped (a sustained −5% live ROI over 100 bets at half-Kelly costs ~2.5% of bankroll — bounded).
- Per-scope, not system-wide — a Path S scope newly graduating post-launch starts at half Kelly even if Path P scopes are already at full.

### 11.8 8-week diagnostic — Path S-aware

§1.5's `gate_status_review_required` row at day 56 becomes more useful with Path S evidence visible. The diagnostic now contains:
- Path P state: pool size, aggregate ROI, aggregate CLV, distance to thresholds
- Path P per-scope: which scopes are individually passing
- **Path S state:** count of scopes that have cleared Path S, count of scopes within 80% of clearing, count of scopes >5% net ROI but n < 400
- Recommendation surfaces: "Path P close but n=180; wait 2 weeks" vs "Path P stalled at 1.8% ROI; Path S has 3 cleared scopes — consider Chris-overridden Path-S-only switchover"

The 8-week diagnostic does not auto-flip on Path S evidence. Chris reviews and decides.

### 11.9 Updated risk register addendum (extends §7)

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R14 | Path S graduation on lucky non-anchored evidence — capital deployed against no real edge | Medium | High | Tight thresholds (5% / n=400 / split-half); §11.7 ROI degradation halt at 1%; half-Kelly first 50 bets |
| R15 | Path P aggregate clears but only Path S scopes have proven; live universe is small at flip | Low | Low | Acceptable. Live universe expands as Path P scopes accumulate post-launch. |
| R16 | Shadow pipeline failure means Path S evidence pool grows too slowly; non-Pinnacle universe never graduates | Medium | Medium | Shadow generation is decoupled from paper generation (already running independently); monitor settlement velocity weekly via `gate_status` row |
| R17 | shadow_pnl tagging bug (the 1 NULL we found) propagates and silently distorts Path S aggregates | Low | Medium | B8 add-on — diagnose root cause; add NOT NULL guard at settlement time; backfill any historical NULLs |
| R18 | A scope clears Path S, gets graduated, then immediately fails the 1% ROI degradation check on the first 100 live bets | Medium | Low | Halt-and-demote-to-shadow is cheap and reversible; the scope can re-graduate later if shadow re-confirms edge. The 50-bet half-Kelly ramp limits exposure during this window. |

### 11.10 Updated implementation sequencing

Adds two items to Track B:
- **B5b (shadow_pnl integrity)** — included in B8 diagnosis. Requires investigating the 1 NULL row and any others that surface during the 7-day window.
- **B9 (Path S evaluator)** — new. Day 4–7. Implements `shadow_evaluation_pool`, `path_s_scope_status` views, and updates the gate-monitoring cron to surface Path S state alongside Path P state. No new tables; reuses `gate_status` (add `path_s_passing_scopes_count` column) and `live_whitelist` (the `path` column from §11.6).

Critical path unchanged — Path S evaluator is built in parallel during the blocker week and runs continuously from day 8 alongside Path P evaluation.

### 11.11 Bottom line

- **Two switchover triggers:** Path P aggregate (3% net ROI / 2% net CLV / n≥200 Pinnacle-anchored) **or** Path S aggregate (≥2 market types / 4% net ROI / 500+ shadow bets across cleared scopes). First to fire wins; whitelist is UNION of individually-cleared scopes from both paths regardless of which trigger fired.
- **Two graduation paths post-launch:** Path P (Pinnacle-anchored, n≥50, positive net ROI + positive net CLV) and Path S (shadow-only, n≥400, net ROI ≥5%, time-ordered split-half ≥3% each).
- **Time-ordered split-half is the load-bearing detail** of Path S. Random halves miss drift; time-ordered halves catch it.
- **Path-aware Kelly ramp:** Path P 50 bets at half-Kelly; Path S 100 bets at half-Kelly (longer ramp compensates for missing CLV anchor).
- **Tier B / Tier C / niche markets are not locked out.** Eliteserien, Jupiler Pro League, MLS, Brasileirão Women, etc. have a defined, statistical, non-negotiable path. They just have to earn it — at a higher bar than Pinnacle-anchored scopes, because no anchor means more evidence required.
