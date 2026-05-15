/**
 * Bundle B analytics — Tasks 3, 5, 6, 7, 9 from the theory-plan rebake
 * (docs/back to theory plan 11.5.26.md).
 *
 * Nightly job. Recomputes per-segment stats and signal-strength verdicts
 * for every (league, market_type, bet_track) that has at least 1 settled
 * bet since the analysis-window start. Read-only against `paper_bets`;
 * writes to `analysis_segment_stats` and `analysis_signal_strength`.
 *
 * One snapshot per run, identified by `computed_at`. Composite PK keeps
 * history. Operator reads via `v_live_eligibility_candidates`.
 *
 * Live-eligibility verdict:
 *   - n >= 30 floor
 *   - qualifies on ROI       if wilson_lo95_winrate > 50
 *   - qualifies on CLV       if clv_t_stat > 1.96 AND avg_clv > 0
 *   - qualification_basis    is 'roi' | 'clv' | 'both' | 'insufficient'
 *
 * Shrinkage prior (Bayesian per Task 9):
 *   - league × market scope shrinks toward the market-type-global mean ROI
 *     with n_prior = 30 effective samples.
 */

import { db, agentConfigTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const DEFAULT_ANALYSIS_START_DATE = "2026-05-03";
const N_FLOOR = 30;
const SHRINKAGE_N_PRIOR = 30;
const CLV_T_THRESHOLD = 1.96;
const WILSON_WINRATE_THRESHOLD = 0.50;
// 2026-05-15 — conditional CLV gate. A scope is "Pinnacle-anchored" iff
// tier1_n / n >= TIER1_COVERAGE_THRESHOLD. When Pinnacle-anchored, CLV t-stat
// gate fires per the existing rule. When NOT Pinnacle-anchored (e.g. BTTS at
// 0 pct Tier-1), the CLV gate is suspended and qualification rests on Wilson +
// bootstrap alone. Threshold of 0.30 chosen as the lowest fraction at which
// CLV t-stat on the Pinnacle subset is statistically meaningful — below this
// the t-stat is computed on a sample too thin to overweight.
const TIER1_COVERAGE_THRESHOLD = 0.30;
// 2026-05-13: shrunk_roi qualification path removed. The 0.20 threshold had
// no statistical referent (Wilson 0.50 is the 1:1-payout break-even; CLV
// 1.96 is the 95% z-score; 0.20 was a magic number). With the market_type
// aggregate path (Lever A+G), any scope previously qualifying on shrunk_roi
// alone is either (a) in a market_type that qualifies at aggregate and is
// reached via that path, or (b) in a non-qualifying market_type, in which
// case shrunk_roi was statistically thin evidence to override the
// market-level rejection. Verified on Neon 2026-05-13: 3 scopes drop off
// per-scope under the new rule (Allsvenskan/Eredivisie/K-League-2 AH); all
// 3 are covered by the AH aggregate path; net emission impact zero. The
// shrunk_roi COLUMN remains computed for operator diagnostics (view
// exposure) — only the qualification disjunct is dropped.
// SHRINKAGE_N_PRIOR retained because shrunk_roi is still computed.
// 2026-05-13 Lever A+G — market_type aggregate qualification.
// A market_type is live-eligible iff ALL THREE gates pass on its full pooled
// settled-bet history: Wilson lo95 win-rate (1927), bootstrap percentile lo95
// ROI (Efron-Tibshirani 1993, B=10000), and Student-t on mean CLV (1908).
// Per-(league × market_type) scope under a qualifying market_type then
// qualifies live unless it has been *empirically disproven* (three-signal
// disproof: n>=30 AND roi<0 AND clv_t_stat<0). The disjunction with the
// existing per-scope view is applied at the placement-gate level, not here.
const MT_AGG_LEAGUE_SENTINEL = "__market_type_aggregate__";
const BOOTSTRAP_ITERATIONS = 10_000;
const BOOTSTRAP_LOWER_PERCENTILE = 0.025;

async function getAnalysisStartDate(): Promise<string> {
  const rows = await db
    .select({ value: agentConfigTable.value })
    .from(agentConfigTable)
    .where(eq(agentConfigTable.key, "analysis_start_date"));
  return rows[0]?.value ?? DEFAULT_ANALYSIS_START_DATE;
}

export interface BundleBResult {
  computed_at: string;
  segment_rows: number;
  signal_rows: number;
  qualifies_live: number;
  market_type_aggregate_rows: number;
  market_types_qualifying: number;
  duration_ms: number;
}

// Stake-weighted ROI percentile lower bound via the percentile bootstrap.
// Resamples n (stake, pnl) pairs with replacement B times, computes
// SUM(pnl)/SUM(stake) on each resample, returns the alpha-percentile of the
// empirical distribution. Distribution-free; handles fat-tailed AH win
// distributions where normal-approximation CIs misbehave.
function bootstrapPercentileLowerRoi(
  pairs: ReadonlyArray<{ stake: number; pnl: number }>,
  iterations: number,
  alpha: number,
): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  const rois: number[] = new Array(iterations);
  for (let b = 0; b < iterations; b += 1) {
    let sumStake = 0;
    let sumPnl = 0;
    for (let i = 0; i < n; i += 1) {
      const pick = pairs[Math.floor(Math.random() * n)]!;
      sumStake += pick.stake;
      sumPnl += pick.pnl;
    }
    rois[b] = sumStake > 0 ? sumPnl / sumStake : 0;
  }
  rois.sort((a, b) => a - b);
  const idx = Math.floor(alpha * iterations);
  return rois[idx] ?? null;
}

export async function runBundleBAnalytics(): Promise<BundleBResult> {
  const startedAt = Date.now();
  const computedAt = new Date();
  const analysisStart = await getAnalysisStartDate();

  logger.info({ analysisStart, computedAt }, "Bundle B analytics starting");

  // Step 1: segment-level stats. One row per (league, market_type, bet_track)
  // with n >= 1 settled bet. PnL/stake column resolved per-rail at compute
  // time so shadow uses shadow_*, live/paper uses net/settlement.
  const segmentInsert = await db.execute(sql`
    INSERT INTO analysis_segment_stats
      (computed_at, league, market_type, bet_track, n, w, stake, pnl, avg_clv, sd_clv, clv_n, tier1_n)
    SELECT
      ${computedAt}::timestamptz                                   AS computed_at,
      COALESCE(m.league, '__unknown__')                            AS league,
      pb.market_type,
      pb.bet_track,
      COUNT(*)::int                                                AS n,
      COUNT(*) FILTER (WHERE pb.status = 'won')::int               AS w,
      SUM(CASE WHEN pb.bet_track = 'shadow'
               THEN COALESCE(pb.shadow_stake, 0)
               ELSE pb.stake END)::numeric                          AS stake,
      SUM(CASE WHEN pb.bet_track = 'shadow'
               THEN COALESCE(pb.shadow_pnl, 0)
               ELSE COALESCE(pb.net_pnl, pb.settlement_pnl, 0) END)::numeric AS pnl,
      -- 2026-05-11 evening: CLV now uses COALESCE(pinnacle_clv, synthetic_clv).
      -- The clv_pct column is Pinnacle-anchored only — leagues without Pinnacle
      -- coverage (most of the non-tier-1 universe) were structurally blocked
      -- from the t-stat qualification path. Synthetic CLV from Smarkets +
      -- Matchbook + Betfair-SP weighted consensus (sharpConsensus.ts) is now
      -- a valid fallback. Per the back-to-theory plan Task 11, this is the
      -- "synthetic sharp consensus" closing-line anchor for non-Pinnacle scopes.
      AVG(COALESCE(pb.clv_pct, pb.synthetic_clv_pct))::numeric      AS avg_clv,
      STDDEV(COALESCE(pb.clv_pct, pb.synthetic_clv_pct))::numeric   AS sd_clv,
      COUNT(*) FILTER (WHERE pb.clv_pct IS NOT NULL OR pb.synthetic_clv_pct IS NOT NULL)::int AS clv_n,
      -- 2026-05-15: Tier-1 (Pinnacle) anchor count for conditional CLV gate.
      -- Scope is "Pinnacle-anchored" iff tier1_n / n >= TIER1_COVERAGE_THRESHOLD.
      COUNT(*) FILTER (WHERE pb.clv_source_tier = 1)::int          AS tier1_n
    FROM paper_bets pb
    LEFT JOIN matches m ON pb.match_id = m.id
    WHERE pb.placed_at >= ${analysisStart}::date
      AND pb.deleted_at IS NULL
      AND pb.status IN ('won', 'lost')
      -- Paper rail is deprecated post-2026-05-09 cutover (per
      -- project_paper_equals_live_eligibility). Its residual rows
      -- carry an artefact of the old Path P/S codepath (every won
      -- AH bet on "away +4" with model_probability ≈ 0.9881, 64/64
      -- wins) which dominates the per-market priors CTE below and
      -- inflates shrunk_roi for low-n shadow segments. Drop them.
      AND pb.bet_track IN ('live', 'shadow')
      -- 2026-05-15: analysis_exclusion_rules. Filters out rows from
      -- (market_type, bet_track) pairs that have an uncleared exclusion
      -- rule AND were placed before the rule's cutover. Hard cutover:
      -- pre-cutover rows excluded permanently, post-cutover rows flow.
      -- Operator advances the cutover by updating
      -- analysis_exclusion_rules.exclude_placed_before for the row.
      AND NOT EXISTS (
        SELECT 1 FROM analysis_exclusion_rules r
        WHERE r.market_type = pb.market_type
          AND r.bet_track   = pb.bet_track
          AND r.cleared_at IS NULL
          AND pb.placed_at < r.exclude_placed_before
      )
    GROUP BY m.league, pb.market_type, pb.bet_track
  `);
  const segmentRows = (segmentInsert as { rowCount: number }).rowCount ?? 0;

  // Step 2: signal-strength verdicts. Computes per-market prior inline via
  // a CTE (avoids cross-connection temp-table issues with pooled execute).
  const signalInsert = await db.execute(sql`
    WITH priors AS (
      SELECT
        market_type,
        SUM(pnl) / NULLIF(SUM(stake), 0) AS mean_roi
      FROM analysis_segment_stats
      WHERE computed_at = ${computedAt}::timestamptz
      GROUP BY market_type
    )
    INSERT INTO analysis_signal_strength
      (computed_at, league, market_type, bet_track, n,
       win_rate, wilson_lo95_winrate, roi, shrunk_roi,
       avg_clv, clv_t_stat, qualifies_live, qualification_basis)
    SELECT
      s.computed_at,
      s.league,
      s.market_type,
      s.bet_track,
      s.n,
      (s.w::numeric / NULLIF(s.n, 0))                                          AS win_rate,
      -- Wilson 95% lower bound on win rate.
      -- 2026-05-11 BUG FIX: prior formula had an extra division by (n+3.84)
      -- INSIDE the SQRT *as well as* outside, producing margin ≈ correct/10
      -- on n=100 and making lo95 ≈ centre — the bound was essentially the
      -- point estimate. That made qualifies_live fire on segments whose true
      -- Wilson lo95 was well below the threshold, over-promoting marginal
      -- scopes. Standard form: centre = (w + z²/2)/(n + z²);
      -- margin = z × SQRT(w(n-w)/n + z²/4) / (n + z²); lower = centre − margin.
      -- z=1.96, z²=3.8416, z²/2=1.9208, z²/4=0.9604.
      ((s.w + 1.92) / (s.n + 3.84)
        - 1.96 * SQRT(s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                / (s.n + 3.84))                                                AS wilson_lo95_winrate,
      (s.pnl / NULLIF(s.stake, 0))                                             AS roi,
      -- Bayesian shrunk ROI: weight observed ROI vs market-global prior
      CASE
        WHEN s.stake IS NULL OR s.stake = 0 THEN p.mean_roi
        ELSE
          (s.n::numeric / (s.n + ${SHRINKAGE_N_PRIOR})) * (s.pnl / NULLIF(s.stake, 0))
          + (${SHRINKAGE_N_PRIOR}::numeric / (s.n + ${SHRINKAGE_N_PRIOR})) * COALESCE(p.mean_roi, 0)
      END                                                                     AS shrunk_roi,
      s.avg_clv,
      -- One-sample t-stat for avg_clv vs zero
      CASE
        WHEN s.sd_clv IS NULL OR s.sd_clv = 0 OR s.clv_n < 2 THEN NULL
        ELSE (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv
      END                                                                     AS clv_t_stat,
      -- Qualifies live? (per-scope Path 1)
      -- Two independent theory-pinned paths (n>=30 AND pnl>0 are common floors):
      --   1. Wilson lo95 on raw win-rate > 0.50  (1:1-payout proof; Wilson 1927)
      --   2. CLV t-stat > 1.96 with avg_clv > 0  (closing-line proof; Student 1908)
      -- 2026-05-15 — conditional CLV gate per Finding clv_anchor_mismatch_2026_05_15:
      -- If scope is Pinnacle-anchored (tier1_n / n >= 0.30), CLV path remains
      -- available. If Pinnacle is structurally unavailable for the scope
      -- (tier1_n / n < 0.30, e.g. BTTS at 0 pct), the CLV path is suspended
      -- and qualification rests on Wilson alone. The CLV t-stat is statistically
      -- meaningless when computed on a sample where most rows have no Pinnacle
      -- anchor; suspending the gate avoids fabricating qualification from a
      -- thin Tier-1 subset.
      (
        s.n >= ${N_FLOOR}
        AND s.pnl > 0
        AND (
          ((s.w + 1.92) / (s.n + 3.84)
            - 1.96 * SQRT(s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                    / (s.n + 3.84)) > ${WILSON_WINRATE_THRESHOLD}
          OR (
            -- CLV path only available when Pinnacle-anchored.
            (s.tier1_n::numeric / NULLIF(s.n, 0)) >= ${TIER1_COVERAGE_THRESHOLD}
            AND s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
            AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > ${CLV_T_THRESHOLD}
            AND s.avg_clv > 0
          )
        )
      )                                                                       AS qualifies_live,
      -- Basis label — 'both' when both Wilson and CLV fire, otherwise the
      -- single firing signal. 'insufficient' for any non-qualifier.
      CASE
        WHEN s.n < ${N_FLOOR} THEN 'insufficient'
        WHEN s.pnl <= 0 THEN 'insufficient'
        ELSE
          CASE
            WHEN
              ((s.w + 1.92) / (s.n + 3.84)
                - 1.96 * SQRT(s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                        / (s.n + 3.84)) > ${WILSON_WINRATE_THRESHOLD}
              AND s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
              AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > ${CLV_T_THRESHOLD}
              AND s.avg_clv > 0
            THEN 'both'
            WHEN
              ((s.w + 1.92) / (s.n + 3.84)
                - 1.96 * SQRT(s.w::numeric * (s.n - s.w)::numeric / NULLIF(s.n, 0) + 0.96)
                        / (s.n + 3.84)) > ${WILSON_WINRATE_THRESHOLD}
            THEN 'roi'
            WHEN
              s.sd_clv IS NOT NULL AND s.sd_clv > 0 AND s.clv_n >= 2
              AND (s.avg_clv * SQRT(s.clv_n::numeric)) / s.sd_clv > ${CLV_T_THRESHOLD}
              AND s.avg_clv > 0
            THEN 'clv'
            ELSE 'insufficient'
          END
      END                                                                     AS qualification_basis
    FROM analysis_segment_stats s
    LEFT JOIN priors p ON p.market_type = s.market_type
    WHERE s.computed_at = ${computedAt}::timestamptz
  `);
  const signalRows = (signalInsert as { rowCount: number }).rowCount ?? 0;

  // Step 3: count qualifying segments for the log line.
  const qRes = await db.execute(sql`
    SELECT COUNT(*)::int AS q
    FROM analysis_signal_strength
    WHERE computed_at = ${computedAt}::timestamptz
      AND qualifies_live = TRUE
  `);
  const qualifiesLive =
    ((((qRes as unknown) as { rows?: Array<{ q: number }> }).rows ?? [])[0]?.q) ?? 0;

  // Step 4 (2026-05-13 Lever A+G): market_type aggregate pass. Pools every
  // settled bet across leagues per market_type, computes the three gates,
  // writes one row per market_type with league=__market_type_aggregate__.
  // The placement gate (paperTrading.ts) and lazy-promote selector
  // (lazyPromoteShadowToPaper.ts) consult v_live_eligibility_market_types
  // to authorise live placement when the per-scope view has not yet
  // accumulated enough sample to qualify on its own.
  const aggregate = await runMarketTypeAggregatePass(computedAt, analysisStart);

  const durationMs = Date.now() - startedAt;
  const result: BundleBResult = {
    computed_at: computedAt.toISOString(),
    segment_rows: segmentRows,
    signal_rows: signalRows,
    qualifies_live: qualifiesLive,
    market_type_aggregate_rows: aggregate.rows_written,
    market_types_qualifying: aggregate.qualifying,
    duration_ms: durationMs,
  };

  logger.info(result, "Bundle B analytics complete");
  return result;
}

interface MarketTypeAggregateResult {
  rows_written: number;
  qualifying: number;
}

// Pulls (market_type, stake, pnl, clv_combined, status) for every settled bet
// in the analysis window, groups by market_type, runs the three gates per
// group, writes one row per market_type into analysis_signal_strength with
// league='__market_type_aggregate__'. No hardcoded market list — every
// market_type with n >= N_FLOOR is evaluated on its own data.
async function runMarketTypeAggregatePass(
  computedAt: Date,
  analysisStart: string,
): Promise<MarketTypeAggregateResult> {
  // Raw per-bet pairs by market_type. Per-rail stake/pnl resolution mirrors
  // analysis_segment_stats (shadow uses shadow_*, live uses net_pnl) so the
  // aggregate is the union of "real money on live" + "phantom money on
  // shadow" — the same population the per-scope verdict already trusts.
  const raw = await db.execute(sql`
    SELECT
      pb.market_type,
      pb.status,
      CASE WHEN pb.bet_track = 'shadow'
           THEN COALESCE(pb.shadow_stake, 0)
           ELSE pb.stake END                                          AS stake,
      CASE WHEN pb.bet_track = 'shadow'
           THEN COALESCE(pb.shadow_pnl, 0)
           ELSE COALESCE(pb.net_pnl, pb.settlement_pnl, 0) END        AS pnl,
      COALESCE(pb.clv_pct, pb.synthetic_clv_pct)                      AS clv,
      (pb.clv_source_tier = 1)                                        AS is_tier1
    FROM paper_bets pb
    WHERE pb.placed_at >= ${analysisStart}::date
      AND pb.deleted_at IS NULL
      AND pb.status IN ('won', 'lost')
      AND pb.bet_track IN ('live', 'shadow')
      -- 2026-05-15: respect analysis_exclusion_rules (same semantics as
      -- the per-scope INSERT). Pre-cutover rows on excluded (market_type,
      -- bet_track) are filtered out before the market-type aggregate is
      -- computed.
      AND NOT EXISTS (
        SELECT 1 FROM analysis_exclusion_rules r
        WHERE r.market_type = pb.market_type
          AND r.bet_track   = pb.bet_track
          AND r.cleared_at IS NULL
          AND pb.placed_at < r.exclude_placed_before
      )
  `);
  const rows = ((raw as unknown) as {
    rows?: Array<{
      market_type: string;
      status: string;
      stake: number | string | null;
      pnl: number | string | null;
      clv: number | string | null;
      is_tier1: boolean | null;
    }>;
  }).rows ?? [];

  // Bucket per market_type.
  interface Bucket {
    pairs: Array<{ stake: number; pnl: number }>;
    wins: number;
    losses: number;
    clv: number[];
    tier1_count: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const stake = Number(r.stake ?? 0);
    if (!Number.isFinite(stake) || stake <= 0) continue;
    const pnl = Number(r.pnl ?? 0);
    if (!Number.isFinite(pnl)) continue;
    const market = r.market_type;
    let b = buckets.get(market);
    if (!b) {
      b = { pairs: [], wins: 0, losses: 0, clv: [], tier1_count: 0 };
      buckets.set(market, b);
    }
    b.pairs.push({ stake, pnl });
    if (r.status === "won") b.wins += 1;
    else if (r.status === "lost") b.losses += 1;
    const clv = r.clv == null ? null : Number(r.clv);
    if (clv != null && Number.isFinite(clv)) b.clv.push(clv);
    if (r.is_tier1) b.tier1_count += 1;
  }

  let rowsWritten = 0;
  let qualifying = 0;

  for (const [marketType, b] of buckets) {
    const n = b.wins + b.losses;
    if (n < N_FLOOR) continue;

    // Gate 1: Wilson 95% lower bound on win-rate (Wilson 1927 score interval).
    const w = b.wins;
    const winRate = w / n;
    const wilsonCentre = (w + 1.92) / (n + 3.84);
    const wilsonMargin =
      (1.96 * Math.sqrt((w * (n - w)) / n + 0.96)) / (n + 3.84);
    const wilsonLo95 = wilsonCentre - wilsonMargin;

    // Gate 2: bootstrap percentile lower bound on stake-weighted ROI.
    const bootstrapLo95 =
      bootstrapPercentileLowerRoi(b.pairs, BOOTSTRAP_ITERATIONS, BOOTSTRAP_LOWER_PERCENTILE);

    // Gate 3: Student-t on mean CLV (one-sample, vs zero).
    const clvN = b.clv.length;
    let meanClv: number | null = null;
    let sdClv: number | null = null;
    let clvT: number | null = null;
    if (clvN >= 2) {
      const sum = b.clv.reduce((s, x) => s + x, 0);
      meanClv = sum / clvN;
      const sse = b.clv.reduce((s, x) => s + (x - meanClv!) ** 2, 0);
      sdClv = Math.sqrt(sse / (clvN - 1));
      if (sdClv > 0) clvT = (meanClv * Math.sqrt(clvN)) / sdClv;
    }

    // Realised stake-weighted ROI (for the roi column, not used in gates).
    const sumStake = b.pairs.reduce((s, p) => s + p.stake, 0);
    const sumPnl = b.pairs.reduce((s, p) => s + p.pnl, 0);
    const roi = sumStake > 0 ? sumPnl / sumStake : 0;

    const pass1 = wilsonLo95 > WILSON_WINRATE_THRESHOLD;
    const pass2 = bootstrapLo95 != null && bootstrapLo95 > 0;
    const pass3 = clvT != null && clvT > CLV_T_THRESHOLD && meanClv != null && meanClv > 0;

    // 2026-05-15 — conditional CLV gate. CLV t-stat is required only when
    // scope is Pinnacle-anchored. When tier1 coverage < TIER1_COVERAGE_THRESHOLD
    // (Pinnacle structurally unavailable — e.g. BTTS), CLV gate is suspended
    // and qualification rests on Wilson + bootstrap alone.
    const tier1Coverage = b.tier1_count / n;
    const pinnacleAnchored = tier1Coverage >= TIER1_COVERAGE_THRESHOLD;
    const qualifiesLive = pass1 && pass2 && (pinnacleAnchored ? pass3 : true);
    if (qualifiesLive) qualifying += 1;

    // Basis label exposes which gate(s) carried it across the line.
    // 'three_gate_pass' or 'two_gate_pass_clv_suspended' (Pinnacle unavailable);
    // otherwise list the failed gates.
    let basis: string;
    if (qualifiesLive) {
      basis = pinnacleAnchored ? "three_gate_pass" : "two_gate_pass_clv_suspended";
    } else {
      const failed: string[] = [];
      if (!pass1) failed.push("wilson");
      if (!pass2) failed.push("bootstrap");
      if (pinnacleAnchored && !pass3) failed.push("clv_t");
      basis = `failed:${failed.join(",")}`;
    }

    await db.execute(sql`
      INSERT INTO analysis_signal_strength
        (computed_at, league, market_type, bet_track, n,
         win_rate, wilson_lo95_winrate, roi, shrunk_roi,
         avg_clv, clv_t_stat, bootstrap_lo95_roi,
         qualifies_live, qualification_basis)
      VALUES
        (${computedAt.toISOString()}::timestamptz,
         ${MT_AGG_LEAGUE_SENTINEL},
         ${marketType},
         'aggregate',
         ${n},
         ${winRate},
         ${wilsonLo95},
         ${roi},
         NULL,
         ${meanClv},
         ${clvT},
         ${bootstrapLo95},
         ${qualifiesLive},
         ${basis})
      ON CONFLICT (computed_at, league, market_type, bet_track) DO UPDATE SET
        n                    = EXCLUDED.n,
        win_rate             = EXCLUDED.win_rate,
        wilson_lo95_winrate  = EXCLUDED.wilson_lo95_winrate,
        roi                  = EXCLUDED.roi,
        avg_clv              = EXCLUDED.avg_clv,
        clv_t_stat           = EXCLUDED.clv_t_stat,
        bootstrap_lo95_roi   = EXCLUDED.bootstrap_lo95_roi,
        qualifies_live       = EXCLUDED.qualifies_live,
        qualification_basis  = EXCLUDED.qualification_basis
    `);
    rowsWritten += 1;
  }

  logger.info(
    { rows_written: rowsWritten, qualifying },
    "Market-type aggregate pass complete",
  );
  return { rows_written: rowsWritten, qualifying };
}
