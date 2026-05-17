/**
 * Inversion pipeline — Bundle 5 (PRE-STAGE, gated off by default)
 *
 * Implements the Phase 2 strategy-inversion three-stage placement gate
 * described in docs/phase2-strategy-inversion-pre-read.md (sections R1–R6,
 * §A.3 alignment test, §I slippage floor, §J calibration / mean_bias).
 *
 * The pipeline is NOT wired into paperTrading.placePaperBet yet. This file
 * is a pure-function skeleton + feature-flag harness. When
 * `agent_config.inversion_pipeline_enabled = 'true'`, callers may invoke
 * `evaluateInversionGate(candidate)` to obtain a structured PROCEED /
 * DOWN_SIZE_HALF / VETO / DEMOTE_SHADOW decision.
 *
 * Three stages:
 *   1. Model-blind watchlist eligibility — validates the candidate arrived
 *      via a model-blind path (Stage-1 watchlist, NOT model opportunity
 *      score). For pre-stage this is a structural contract check: the
 *      caller must pass `stage1Source ∈ {'liquidity_watchlist',
 *      'kickoff_window', 'pinnacle_release'}`. Model-derived candidates are
 *      rejected with reason `stage1_model_filtered`.
 *
 *   2. Pinnacle confirm + wide-tolerance sanity check —
 *        identified_edge_pp = (odds × pinnacle_implied − 1) × 100
 *        bias-corrected model_p = raw_model_p − mean_bias[market_type]
 *        |Δp| = |bias-corrected model_p − pinnacle_implied|
 *        disagreement_z = |Δp| / model_se[market_type]
 *      VETO if (disagreement_z > VETO_Z AND |Δp| > VETO_ABS_PP) — both must
 *      fire (R2 wide tolerance: "clearly broken on this fixture", not
 *      "slightly different from Pinnacle").
 *      DOWN_SIZE_HALF if disagreement_z > 2.0 OR |Δp| > 15pp (R3 default —
 *      ships on theory; see memo §A.3 verdict).
 *      Else PROCEED.
 *
 *   3. Post-slippage edge gate —
 *        post_slippage_edge_pp = identified_edge_pp − p75_slippage_pp[market_type]
 *      DEMOTE_SHADOW if post_slippage_edge_pp < MIN_POST_SLIPPAGE_EDGE.
 *      Else PROCEED.
 *
 * Inputs come from:
 *   - Pinnacle implied: written by Writer A (oddsPapi pre-bet fetch).
 *   - Multi-book sharp anchors: written by sharpAnchorFetch (Bundle 1 E.3).
 *     Consensus de-vig computed via devigPower across all available books;
 *     boosts confidence when ≥2 sharps agree within 1pp.
 *   - mean_bias[market_type]: from v_market_type_mean_bias_rolling
 *     (Bundle 5.B view, last N=200 settled bets, cutover universe).
 *   - p75_slippage_pp[market_type]: hardcoded constants from memo §I until
 *     a v_slippage_percentiles view ships in Bundle 6.
 *
 * Feature flags (agent_config keys):
 *   inversion_pipeline_enabled    'true'  → callers may invoke
 *   inversion_min_post_slip_edge  '3.0'   → MIN_POST_SLIPPAGE_EDGE in pp
 *   inversion_veto_z              '4.0'   → veto z-score (R2 wide tolerance)
 *   inversion_veto_abs_pp         '25.0'  → veto absolute pp floor
 *   inversion_downsize_z          '2.0'   → R3 down-size z-score
 *   inversion_downsize_abs_pp     '15.0'  → R3 down-size absolute pp floor
 *   mean_bias_window_n            '200'   → rolling-window size
 *
 * Verification ladder (memo §A.3, §I, §J):
 *   - Stage 1 — placeholder; full Stage-1 build is the Phase 2 product spec.
 *   - Stage 2 — pulls bias + se from v_market_type_mean_bias_rolling. If the
 *     view is empty (cold-start), defaults to bias=0 and se=0.10 (wide).
 *   - Stage 3 — slippage p75 defaults to 0pp for non-AH markets per memo §I;
 *     AH is flagged for separate calibration until selection canonicalisation
 *     ships (Bundle 4 follow-up).
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, pinnacleOddsSnapshotsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { getConfigValue } from "./paperTrading";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type Stage1Source =
  | "liquidity_watchlist"
  | "kickoff_window"
  | "pinnacle_release"
  | "legacy_model_candidate"; // present for migration; auto-rejects in Stage 1

export type InversionDecision =
  | {
      action: "PROCEED";
      /**
       * Bundle 5.J — driven by sharp-count tier, not the legacy fixed 1.0×.
       * 0.5 (1 sharp) | 1.0 (2 sharps) | 1.0 (3 sharps + HIGH_CONVICTION).
       */
      kellyMultiplier: number;
      reasons: string[];
      diagnostics: InversionDiagnostics;
    }
  | { action: "VETO"; reasons: string[]; diagnostics: InversionDiagnostics }
  | { action: "DEMOTE_SHADOW"; reasons: string[]; diagnostics: InversionDiagnostics };

export type TtkBucket = "0_1h" | "1_6h" | "6_24h" | "24h_plus";

export interface InversionDiagnostics {
  identifiedEdgePp: number | null;
  postSlippageEdgePp: number | null;
  expectedFillOdds: number | null;
  p75Slippage: number | null;
  slippageSource: "cell" | "market_aggregate" | "default" | null;
  ttkBucket: TtkBucket | null;
  rawModelP: number | null;
  biasCorrectedModelP: number | null;
  meanBias: number | null;
  modelSe: number | null;
  pinnacleImplied: number | null;
  multiBookConsensusP: number | null;
  multiBookCount: number;
  /** Bundle 5.J — count of sharps agreeing with Pinnacle (within 1pp implied, same direction). */
  sharpCount: number;
  agreeingSlugs: string[];
  isHighConviction: boolean;
  disagreementPp: number | null;
  disagreementZ: number | null;
  stage1Source: Stage1Source;
  thresholds: InversionThresholds;
  /** Telemetry-only flags — don't gate, just surface for review. */
  flags: string[];
}

export interface InversionThresholds {
  /**
   * Bundle 5.H locked spec: MIN_NET_EDGE (post-slippage) is the single
   * floor. Replaces the earlier minPostSlippageEdgePp + minIdentifiedEdgePp
   * split. Default 3.0pp.
   */
  minNetEdgePp: number;
  /**
   * Bundle 10 (2026-05-17): live-edge ceiling. Post-slip edge above
   * this demotes to shadow — only the 3-7pp sweet-spot proceeds live
   * while we accumulate data on higher brackets.
   */
  liveEdgeCeilingPp: number;
  /** Telemetry-only flag threshold; does NOT gate. Default 7.0pp. */
  highEdgeFlagThresholdPp: number;
  vetoZ: number;
  vetoAbsPp: number;
  /**
   * R3 down-size from earlier spec is superseded by multi-sharp Kelly
   * tiering (Bundle 5.J). Retained here as a fallback in case the
   * sharp-count signal is unavailable.
   */
  downsizeZ: number;
  downsizeAbsPp: number;
  meanBiasWindowN: number;
  /** PROCEED_WITH_CAUTION threshold — flagged if p75_slippage > this. */
  slippageCautionThreshold: number;
  /** Fallback p75_slippage (fraction) when neither cell nor market aggregate has n>=30. */
  defaultP75Slippage: number;
  /** Bundle 5.J — Kelly tier multipliers per agreeing-sharp count. */
  kellySingleSharp: number;
  kellyTwoSharps: number;
  kellyThreeSharps: number;
}

export interface InversionCandidate {
  matchId: number;
  marketType: string;
  selectionName: string;
  backOdds: number;
  pinnacleImplied: number | null;
  rawModelProbability: number;
  stage1Source: Stage1Source;
  /**
   * Optional kickoff_time. When omitted, evaluateInversionGate looks it
   * up from the matches table. Pass it through when the caller already
   * has the value to save one round-trip per gate call.
   */
  kickoffTime?: Date | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Feature flag — single read-through point. Default OFF.
// ──────────────────────────────────────────────────────────────────────────

export async function isInversionPipelineEnabled(): Promise<boolean> {
  const raw = (await getConfigValue("inversion_pipeline_enabled"))?.toLowerCase()?.trim();
  return raw === "true";
}

async function readThresholds(): Promise<InversionThresholds> {
  const num = async (key: string, fallback: number): Promise<number> => {
    const raw = await getConfigValue(key);
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    minNetEdgePp: await num("min_net_edge_pp", 3.0),
    /**
     * Bundle 10 (2026-05-17): live-edge ceiling. Post-slip edge above
     * this value demotes to shadow even though it clears the 3pp floor.
     * Bundle 9 retrospective: 7-15pp and 15-50pp brackets LOST money
     * (−37%, −31% ROI), >50pp is synthetic-Pinnacle territory. Only
     * the 3-7pp sweet spot showed positive ROI (+200% on n=48).
     * Operator-tunable to widen the band as data accumulates.
     */
    liveEdgeCeilingPp: await num("inversion_live_max_edge_pp", 7.0),
    highEdgeFlagThresholdPp: await num("high_edge_flag_threshold", 7.0),
    vetoZ: await num("inversion_veto_z", 4.0),
    vetoAbsPp: await num("inversion_veto_abs_pp", 25.0),
    downsizeZ: await num("inversion_downsize_z", 2.0),
    downsizeAbsPp: await num("inversion_downsize_abs_pp", 15.0),
    meanBiasWindowN: await num("mean_bias_window_n", 200),
    slippageCautionThreshold: await num("slippage_caution_threshold", 0.05),
    defaultP75Slippage: await num("default_p75_slippage", 0.015),
    kellySingleSharp: await num("kelly_multiplier_single_sharp", 0.5),
    kellyTwoSharps: await num("kelly_multiplier_two_sharp", 1.0),
    kellyThreeSharps: await num("kelly_multiplier_three_sharp", 1.0),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Bundle 5.B — rolling-window mean_bias + model_se reader
// ──────────────────────────────────────────────────────────────────────────
//
// Reads from the v_market_type_mean_bias_rolling view (Bundle 5.B migration).
// If the view is unavailable (pre-migration deploy) or the (market_type)
// bucket has n < 30, returns null bias and null se — callers fall back to
// the wide R2 default (se = 0.10, bias = 0).
//
// Universe filter (encoded in the view):
//   bet_track IN ('live','shadow') AND legacy_regime = false
//   AND placed_at >= '2026-05-17 08:40:00 UTC'  -- post Bundle 3 deploy
//   AND pinnacle_implied IS NOT NULL
//   AND model_probability IS NOT NULL
//   AND status IN ('won','lost','void')
// then window last N=200 per market_type by placed_at DESC.

export interface MarketTypeCalibration {
  meanBias: number | null; // E[model_p − pinnacle_implied]
  modelSe: number | null; // stddev_samp(model_p − pinnacle_implied)
  n: number;
}

const calibrationCache = new Map<string, { value: MarketTypeCalibration; expiresAt: number }>();
const CALIBRATION_TTL_MS = 5 * 60 * 1000;

export async function getMarketTypeCalibration(
  marketType: string,
): Promise<MarketTypeCalibration> {
  const now = Date.now();
  const hit = calibrationCache.get(marketType);
  if (hit && hit.expiresAt > now) return hit.value;

  try {
    const rows = await db.execute(sql`
      SELECT mean_bias, model_se, n
      FROM v_market_type_mean_bias_rolling
      WHERE market_type = ${marketType}
      LIMIT 1
    `);
    const row = ((rows as any).rows ?? [])[0] as
      | { mean_bias: string | number | null; model_se: string | number | null; n: string | number | null }
      | undefined;
    const n = row?.n != null ? Number(row.n) : 0;
    const value: MarketTypeCalibration = {
      meanBias: row?.mean_bias != null && n >= 30 ? Number(row.mean_bias) : null,
      modelSe: row?.model_se != null && n >= 30 ? Number(row.model_se) : null,
      n,
    };
    calibrationCache.set(marketType, { value, expiresAt: now + CALIBRATION_TTL_MS });
    return value;
  } catch (err) {
    // View doesn't exist yet (pre-migration) or query failed. Fall through to
    // safe-default behaviour: caller will use bias=0 and se=0.10. Cache the
    // null result briefly so we don't hammer the DB.
    logger.debug({ err, marketType }, "v_market_type_mean_bias_rolling unavailable — defaults applied");
    const value: MarketTypeCalibration = { meanBias: null, modelSe: null, n: 0 };
    calibrationCache.set(marketType, { value, expiresAt: now + 30_000 });
    return value;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Bundle 5.C — multi-book agreement reader from pinnacle_odds_snapshots
// ──────────────────────────────────────────────────────────────────────────
//
// At Stage 2, we want to know whether Bundle 1 E.3 wrote sharp-anchor prices
// for this (match × market × selection) within the last MULTIBOOK_FRESHNESS_MS.
// If yes, de-vig per-bookmaker (overround-stripped via Power method using
// every selection of the market for that book) and compute a stake-weight-1
// arithmetic mean of the bookmaker implied probabilities. Returns null when
// only Pinnacle is present — Stage 2 then falls back to pinnacle_implied
// alone.
//
// The full multi-selection per-book de-vig requires the market's complete
// outcome set. For the pre-stage skeleton we approximate by returning the
// raw 1/odds per book and noting in diagnostics that proper de-vig is
// deferred to Bundle 5.C.2 (cross-selection fetch).

const MULTIBOOK_FRESHNESS_MS = 10 * 60 * 1000;

export interface MultiBookSnapshot {
  bookmakerSlug: string;
  rawImpliedProbability: number; // 1/odds — overround NOT stripped
  capturedAt: Date;
}

export async function readMultiBookSnapshots(
  matchId: number,
  marketType: string,
  selectionName: string,
): Promise<MultiBookSnapshot[]> {
  const cutoff = new Date(Date.now() - MULTIBOOK_FRESHNESS_MS);
  const rows = await db
    .select({
      bookmakerSlug: pinnacleOddsSnapshotsTable.bookmakerSlug,
      pinnacleOdds: pinnacleOddsSnapshotsTable.pinnacleOdds,
      pinnacleImplied: pinnacleOddsSnapshotsTable.pinnacleImplied,
      capturedAt: pinnacleOddsSnapshotsTable.capturedAt,
    })
    .from(pinnacleOddsSnapshotsTable)
    .where(
      and(
        eq(pinnacleOddsSnapshotsTable.matchId, matchId),
        eq(pinnacleOddsSnapshotsTable.marketType, marketType),
        eq(pinnacleOddsSnapshotsTable.selectionName, selectionName),
        gte(pinnacleOddsSnapshotsTable.capturedAt, cutoff),
      ),
    )
    .orderBy(desc(pinnacleOddsSnapshotsTable.capturedAt));

  // De-duplicate to the latest snapshot per bookmaker_slug.
  const latestPerSlug = new Map<string, MultiBookSnapshot>();
  for (const r of rows) {
    const slug = r.bookmakerSlug ?? "pinnacle";
    if (latestPerSlug.has(slug)) continue;
    const odds = r.pinnacleOdds != null ? Number(r.pinnacleOdds) : null;
    if (odds == null || !Number.isFinite(odds) || odds <= 1) continue;
    latestPerSlug.set(slug, {
      bookmakerSlug: slug,
      rawImpliedProbability: 1 / odds,
      capturedAt: r.capturedAt ?? new Date(),
    });
  }
  return [...latestPerSlug.values()];
}

// Multi-book consensus: arithmetic mean of raw implied probabilities across
// distinct sharp books. Returns null when n < 1 or every book returned NaN.
//
// NB: this is the "consensus-as-input" estimator, not a de-vigged book — it
// intentionally averages raw 1/odds so Stage 2 can detect agreement vs.
// pinnacle_implied (which IS de-vigged) and treat the spread as a sharp-
// confidence signal. Full multi-selection de-vig per book lands in Bundle
// 5.C.2 once we fetch every selection's odds in the same call.
export function computeMultiBookConsensus(snapshots: MultiBookSnapshot[]): {
  consensusP: number | null;
  bookCount: number;
} {
  if (snapshots.length === 0) return { consensusP: null, bookCount: 0 };
  const probs = snapshots
    .map((s) => s.rawImpliedProbability)
    .filter((p) => Number.isFinite(p) && p > 0 && p < 1);
  if (probs.length === 0) return { consensusP: null, bookCount: 0 };
  const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
  return { consensusP: mean, bookCount: probs.length };
}

// ──────────────────────────────────────────────────────────────────────────
// Bundle 5.J — sharp-agreement count + Kelly tiering
// ──────────────────────────────────────────────────────────────────────────
//
// Per the locked spec (docs/bundle-5-activation-spec.md §5):
//   1 sharp  (Pinnacle alone)      → 0.5× Kelly
//   2 sharps (Pinnacle + 1 niche)  → 1.0× Kelly
//   3 sharps (Pinnacle + 2 niches) → 1.0× Kelly + HIGH_CONVICTION flag
//
// "Agreeing" non-Pinnacle sharp = raw_implied within 1pp of Pinnacle AND
// same edge direction (both think the bet is +EV or both -EV vs backOdds).
// The 3pp floor is identical across tiers — only the Kelly multiplier
// reflects conviction.
//
// Books not in SHARP_BOOK_SLUGS (Bet365, 1xBet, etc.) are softs and never
// contribute to the sharp count even if they appear in pinnacle_odds_snapshots
// (defensive — pre-E.5 we may have stored some soft rows).

export const SHARP_BOOK_SLUGS = new Set<string>(["pinnacle", "singbet", "sbobet", "ps3838"]);
const SHARP_AGREEMENT_TOLERANCE = 0.01; // 1pp implied-prob agreement band

export interface SharpAgreementResult {
  sharpCount: number;
  agreeingSlugs: string[];
}

export function countAgreeingSharps(
  pinnacleImplied: number,
  backOdds: number,
  snapshots: MultiBookSnapshot[],
): SharpAgreementResult {
  // Pinnacle is the always-on anchor via the paid prefetch; it counts as 1
  // sharp regardless of whether a row appears in the multi-book snapshot
  // result (the snapshot reader's freshness window may have just missed it
  // — Pinnacle data is authoritative via the candidate's pinnacleImplied).
  const agreeingSlugs: string[] = ["pinnacle"];
  if (!Number.isFinite(pinnacleImplied) || pinnacleImplied <= 0) {
    return { sharpCount: 0, agreeingSlugs: [] };
  }
  const pinnEdge = backOdds * pinnacleImplied - 1; // +ve if +EV per Pinnacle
  const pinnDirection = pinnEdge > 0 ? 1 : -1;

  for (const s of snapshots) {
    const slug = (s.bookmakerSlug ?? "").toLowerCase();
    if (slug === "pinnacle") continue; // already counted above
    if (!SHARP_BOOK_SLUGS.has(slug)) continue; // softs skipped (defensive)
    if (!Number.isFinite(s.rawImpliedProbability)) continue;
    const delta = Math.abs(s.rawImpliedProbability - pinnacleImplied);
    if (delta > SHARP_AGREEMENT_TOLERANCE) continue;
    const snapEdge = backOdds * s.rawImpliedProbability - 1;
    const snapDirection = snapEdge > 0 ? 1 : -1;
    if (snapDirection !== pinnDirection) continue;
    agreeingSlugs.push(slug);
  }
  return { sharpCount: agreeingSlugs.length, agreeingSlugs };
}

export function kellyMultiplierForSharpCount(
  sharpCount: number,
  thresholds: InversionThresholds,
): { multiplier: number; highConviction: boolean } {
  if (sharpCount >= 3) {
    return { multiplier: thresholds.kellyThreeSharps, highConviction: true };
  }
  if (sharpCount === 2) {
    return { multiplier: thresholds.kellyTwoSharps, highConviction: false };
  }
  return { multiplier: thresholds.kellySingleSharp, highConviction: false };
}

// ──────────────────────────────────────────────────────────────────────────
// Bundle 5.I — per-(market × ttk) p75_slippage reader
// ──────────────────────────────────────────────────────────────────────────
//
// Reads from v_slippage_p75_rolling (Bundle 5.I migration). Fallback chain
// per the locked spec (docs/bundle-5-activation-spec.md §3):
//   1. (market_type, ttk_bucket) cell with n >= 30
//   2. market_type aggregate across all ttks with n >= 30
//   3. default p75_slippage from agent_config (defaultP75Slippage, 0.015)
//
// p75_slippage is a FRACTION (e.g. 0.015 = 1.5% odds compression). The view
// already computes it as GREATEST((offered − matched) / offered, 0) — adverse
// fills only; negative slippage clamped to 0. The reader returns the source
// so diagnostics can show whether the cell, aggregate, or default fired.

export interface SlippageLookup {
  p75Slippage: number;
  source: "cell" | "market_aggregate" | "default";
  n: number;
}

const slippageCache = new Map<string, { value: SlippageLookup; expiresAt: number }>();
const SLIPPAGE_TTL_MS = 15 * 60 * 1000;

export function computeTtkBucket(kickoffTime: Date, decisionTime: Date = new Date()): TtkBucket {
  const hoursToKickoff = (kickoffTime.getTime() - decisionTime.getTime()) / 3_600_000;
  if (hoursToKickoff < 1) return "0_1h";
  if (hoursToKickoff < 6) return "1_6h";
  if (hoursToKickoff < 24) return "6_24h";
  return "24h_plus";
}

export async function getP75Slippage(
  marketType: string,
  ttkBucket: TtkBucket,
  defaultP75: number,
): Promise<SlippageLookup> {
  const cacheKey = `${marketType}|${ttkBucket}|${defaultP75}`;
  const now = Date.now();
  const hit = slippageCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.value;

  try {
    // Cell lookup first
    const cell = await db.execute(sql`
      SELECT n::int AS n, p75_slippage::float8 AS p75
      FROM v_slippage_p75_rolling
      WHERE market_type = ${marketType} AND ttk_bucket = ${ttkBucket}
      LIMIT 1
    `);
    const cellRow = ((cell as any).rows ?? [])[0] as { n: number; p75: number } | undefined;
    if (cellRow && cellRow.n >= 30 && Number.isFinite(cellRow.p75)) {
      const value: SlippageLookup = { p75Slippage: cellRow.p75, source: "cell", n: cellRow.n };
      slippageCache.set(cacheKey, { value, expiresAt: now + SLIPPAGE_TTL_MS });
      return value;
    }

    // Market-type aggregate (sum n, weighted p75) — done via the same view
    // by aggregating across all ttk buckets. We use SUM(n) and a
    // re-percentile over the underlying raw data isn't available from the
    // grouped view, so approximate via n-weighted mean of cell p75s. This
    // is a coarse fallback; the spec accepts it for sparse markets.
    const agg = await db.execute(sql`
      SELECT
        SUM(n)::int AS n,
        SUM(p75_slippage::float8 * n) / NULLIF(SUM(n), 0) AS p75_weighted
      FROM v_slippage_p75_rolling
      WHERE market_type = ${marketType}
    `);
    const aggRow = ((agg as any).rows ?? [])[0] as { n: number; p75_weighted: number | null } | undefined;
    if (aggRow && aggRow.n >= 30 && aggRow.p75_weighted != null && Number.isFinite(aggRow.p75_weighted)) {
      const value: SlippageLookup = {
        p75Slippage: aggRow.p75_weighted,
        source: "market_aggregate",
        n: aggRow.n,
      };
      slippageCache.set(cacheKey, { value, expiresAt: now + SLIPPAGE_TTL_MS });
      return value;
    }
  } catch (err) {
    // View unavailable (pre-migration deploy) or query failed. Fall through
    // to the safe default — never block the gate on telemetry-source
    // problems.
    logger.debug({ err, marketType, ttkBucket }, "v_slippage_p75_rolling unavailable — using default");
  }

  const value: SlippageLookup = {
    p75Slippage: defaultP75,
    source: "default",
    n: 0,
  };
  slippageCache.set(cacheKey, { value, expiresAt: now + 30_000 });
  return value;
}

const MARKETS_FORCE_CAUTION = new Set(["FIRST_HALF_RESULT"]);

// ──────────────────────────────────────────────────────────────────────────
// Bundle 5.K — high-edge integrity check (≥7pp identified edge)
// ──────────────────────────────────────────────────────────────────────────
//
// Per the locked spec (docs/bundle-5-activation-spec.md §6) + memo §A.1
// bucket-8 lesson (-80% ROI at 10%+ edge = pure artifact):
//
//   When identified_edge_pp >= high_edge_flag_threshold (default 7.0),
//   three integrity checks must all pass; ANY failure → VETO with reason
//   'reject_high_edge_integrity'.
//
//   (a) A fresh Pinnacle snapshot exists for the EXACT (matchId,
//       marketType, selectionName) tuple captured within 30 minutes.
//       Catches stale-anchor leaks.
//
//   (b) The snapshot's pinnacle_implied matches the candidate's
//       pinnacleImplied within 0.005 (0.5pp). Catches plumbing
//       inconsistencies where the candidate was sized against one
//       snapshot but a different snapshot is now authoritative.
//
//   (c) For ASIAN_HANDICAP, the selectionName parses cleanly as
//       "Home/Away ±N" (line spec well-formed). Bundle 4 canonicalisation
//       already enforces this at the writer, but a high-edge bet with a
//       malformed line is exactly the bucket-8 failure mode — re-check
//       defensively.
//
// The Betfair side check from the spec (listMarketBook outcome name
// match) is intentionally deferred to a separate cron-style audit, not
// a gate-time blocking call — it would add ~200ms per high-edge candidate
// and triple the relay-API budget. The (a)+(b)+(c) checks above catch the
// internal-data-flow leak class; Betfair-side drift is caught by the
// existing slippage / fill-price reconciliation in placeLiveBetOnBetfair.

interface HighEdgeIntegrityResult {
  ok: boolean;
  reasons: string[];
}

async function evaluateHighEdgeIntegrity(
  candidate: InversionCandidate,
): Promise<HighEdgeIntegrityResult> {
  const reasons: string[] = [];

  // (a) + (b): fresh Pinnacle snapshot exists and matches candidate's
  //            pinnacleImplied.
  try {
    const r = await db.execute(sql`
      SELECT pinnacle_implied::float8 AS pi
      FROM pinnacle_odds_snapshots
      WHERE match_id = ${candidate.matchId}
        AND market_type = ${candidate.marketType}
        AND selection_name = ${candidate.selectionName}
        AND bookmaker_slug = 'pinnacle'
        AND captured_at >= NOW() - INTERVAL '30 minutes'
      ORDER BY captured_at DESC
      LIMIT 1
    `);
    const row = ((r as any).rows ?? [])[0] as { pi: number | null } | undefined;
    if (!row || row.pi == null || !Number.isFinite(row.pi)) {
      reasons.push("integrity_no_fresh_pinnacle_snapshot");
      return { ok: false, reasons };
    }
    if (candidate.pinnacleImplied != null) {
      const diff = Math.abs(row.pi - candidate.pinnacleImplied);
      if (diff > 0.005) {
        reasons.push("integrity_pinnacle_implied_mismatch");
        return { ok: false, reasons };
      }
    }
  } catch (err) {
    // DB hiccup — fail SAFE on a high-edge candidate (better to skip a
    // suspect bet than to fire one with unverified anchor data). The
    // logger.debug here surfaces the underlying error for ops.
    logger.debug({ err, matchId: candidate.matchId }, "high-edge integrity query failed — failing safe");
    reasons.push("integrity_check_query_failed");
    return { ok: false, reasons };
  }

  // (c) AH line spec well-formed.
  if (candidate.marketType === "ASIAN_HANDICAP") {
    const ahLineSpec = /^(Home|Away)\s+([+-]?\d+(?:\.\d+)?)$/;
    if (!ahLineSpec.test(candidate.selectionName)) {
      reasons.push("integrity_ah_line_unparseable");
      return { ok: false, reasons };
    }
  }

  return { ok: true, reasons: [] };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 1 — model-blind watchlist eligibility + CLV-breaker market pause
// ──────────────────────────────────────────────────────────────────────────

async function evaluateStage1(
  candidate: InversionCandidate,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (candidate.stage1Source === "legacy_model_candidate") {
    return { ok: false, reason: "stage1_model_filtered" };
  }
  // Bundle 5.L — CLV circuit breaker. The 15-min cron writes
  // clv_paused_<MARKET_TYPE>='true' when rolling stake-weighted CLV on a
  // market_type drops below clv_circuit_breaker_threshold. Demote shadow
  // until manual unpause.
  const pauseKey = `clv_paused_${candidate.marketType.toUpperCase()}`;
  const pauseRaw = (await getConfigValue(pauseKey))?.toLowerCase()?.trim();
  if (pauseRaw === "true") {
    return { ok: false, reason: "clv_breaker_market_paused" };
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 2 — Pinnacle confirm + R2 wide-tolerance sanity check
// ──────────────────────────────────────────────────────────────────────────

interface Stage2Output {
  identifiedEdgePp: number | null;
  biasCorrectedModelP: number | null;
  meanBias: number | null;
  modelSe: number | null;
  disagreementPp: number | null;
  disagreementZ: number | null;
  veto: boolean;
  downsize: boolean;
  reasons: string[];
}

async function evaluateStage2(
  candidate: InversionCandidate,
  thresholds: InversionThresholds,
): Promise<Stage2Output> {
  const reasons: string[] = [];
  const { backOdds, pinnacleImplied, rawModelProbability, marketType } = candidate;

  if (pinnacleImplied == null || pinnacleImplied <= 0) {
    // R5 — no Pinnacle anchor means no live eligibility. Caller demotes.
    reasons.push("stage2_no_pinnacle_anchor");
    return {
      identifiedEdgePp: null,
      biasCorrectedModelP: null,
      meanBias: null,
      modelSe: null,
      disagreementPp: null,
      disagreementZ: null,
      veto: false,
      downsize: false,
      reasons,
    };
  }

  const identifiedEdgePp = (backOdds * pinnacleImplied - 1) * 100;

  // Bias-correct the model probability before computing disagreement_z.
  // Memo §J: every market_type shows positive bias (model overstates win
  // prob by 12–31pp). Subtracting the rolling mean centres the disagreement
  // on Pinnacle, making R2's sanity check actually fire on genuine model
  // breakage rather than the structural over-confidence.
  const calibration = await getMarketTypeCalibration(marketType);
  const meanBias = calibration.meanBias ?? 0;
  const modelSe = calibration.modelSe ?? 0.10; // wide R2 default
  const biasCorrectedModelP = rawModelProbability - meanBias;
  const disagreementPp = Math.abs(biasCorrectedModelP - pinnacleImplied) * 100;
  const disagreementZ = modelSe > 0 ? Math.abs(biasCorrectedModelP - pinnacleImplied) / modelSe : 0;

  let veto = false;
  let downsize = false;

  // R2 veto: BOTH thresholds must fire — z > VETO_Z AND |Δp| > VETO_ABS_PP.
  // The wide tolerance is intentional: "clearly broken on this fixture",
  // not "slightly different from Pinnacle". Defaults: z>4 AND |Δp|>25pp.
  if (disagreementZ > thresholds.vetoZ && disagreementPp > thresholds.vetoAbsPp) {
    veto = true;
    reasons.push("stage2_veto_catastrophic_disagreement");
  }

  // R3 down-size: EITHER trigger fires the 0.5× multiplier. Defaults:
  // z>2.0 OR |Δp|>15pp. Memo §A.3 verdict: shipping on theory, not data;
  // first-200-bet recalibration target. Skip if veto already set.
  if (!veto && (disagreementZ > thresholds.downsizeZ || disagreementPp > thresholds.downsizeAbsPp)) {
    downsize = true;
    reasons.push(
      disagreementZ > thresholds.downsizeZ
        ? "stage2_downsize_high_z"
        : "stage2_downsize_high_abs_pp",
    );
  }

  return {
    identifiedEdgePp,
    biasCorrectedModelP,
    meanBias,
    modelSe,
    disagreementPp,
    disagreementZ,
    veto,
    downsize,
    reasons,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 3 — Multiplicative post-slippage net-edge gate (Bundle 5.I)
// ──────────────────────────────────────────────────────────────────────────
//
// Per the locked spec (docs/bundle-5-activation-spec.md §2):
//   expected_fill_odds    = betfair_offered × (1 − p75_slippage)
//   pinnacle_fair_odds    = 1 / pinnacle_implied
//   post_slippage_edge_pp = (expected_fill_odds / pinnacle_fair_odds − 1) × 100
//                         = (expected_fill_odds × pinnacle_implied − 1) × 100
//   PROCEED IF post_slippage_edge_pp >= MIN_NET_EDGE (default 3.0pp)
//
// The 3pp floor is the SOLE placement gate. TTK is not a hard exclusion —
// the watchlist already biases toward sub-24h placement via the kickoff +
// liquidity + 4%/30min mover criteria (no double-gating).

interface Stage3Output {
  postSlippageEdgePp: number | null;
  expectedFillOdds: number | null;
  p75Slippage: number | null;
  slippageSource: SlippageLookup["source"] | null;
  ttkBucket: TtkBucket;
  demote: boolean;
  flags: string[];
  reasons: string[];
}

async function evaluateStage3(
  backOdds: number,
  pinnacleImplied: number,
  marketType: string,
  ttkBucket: TtkBucket,
  thresholds: InversionThresholds,
): Promise<Stage3Output> {
  const slip = await getP75Slippage(marketType, ttkBucket, thresholds.defaultP75Slippage);
  const expectedFillOdds = backOdds * (1 - slip.p75Slippage);
  const postSlippageEdgePp = (expectedFillOdds * pinnacleImplied - 1) * 100;
  // Bundle 10 (2026-05-17): TWO demote paths — below floor OR above
  // ceiling. Above-ceiling bets get a distinct reason
  // 'stage3_above_live_edge_ceiling' so compliance_logs analytics can
  // separate sub-floor noise from high-edge artifact territory.
  const belowFloor = postSlippageEdgePp < thresholds.minNetEdgePp;
  const aboveCeiling = postSlippageEdgePp > thresholds.liveEdgeCeilingPp;
  const demote = belowFloor || aboveCeiling;
  const reasons: string[] = [];
  const flags: string[] = [];
  if (belowFloor) reasons.push("stage3_below_net_edge_floor");
  if (aboveCeiling) reasons.push("stage3_above_live_edge_ceiling");
  // PROCEED_WITH_CAUTION flag — informational only, never gates (per spec).
  if (MARKETS_FORCE_CAUTION.has(marketType)) {
    flags.push("proceed_with_caution_first_half_result");
  }
  if (slip.p75Slippage > thresholds.slippageCautionThreshold) {
    flags.push("proceed_with_caution_high_slippage");
  }
  return {
    postSlippageEdgePp,
    expectedFillOdds,
    p75Slippage: slip.p75Slippage,
    slippageSource: slip.source,
    ttkBucket,
    demote,
    flags,
    reasons,
  };
}

// Helper for the top-level evaluator: get the candidate's kickoff time
// when caller didn't pass it. One small query per gate call; cached briefly
// since the gate may fire multiple times in a single trading cycle for the
// same fixture.
const kickoffCache = new Map<number, { value: Date | null; expiresAt: number }>();
const KICKOFF_CACHE_TTL_MS = 60_000;

async function resolveKickoffTime(
  matchId: number,
  override: Date | null | undefined,
): Promise<Date | null> {
  if (override) return override;
  const now = Date.now();
  const hit = kickoffCache.get(matchId);
  if (hit && hit.expiresAt > now) return hit.value;
  try {
    const r = await db.execute(sql`
      SELECT kickoff_time FROM matches WHERE id = ${matchId} LIMIT 1
    `);
    const row = ((r as any).rows ?? [])[0] as { kickoff_time: string | Date | null } | undefined;
    const value = row?.kickoff_time
      ? row.kickoff_time instanceof Date
        ? row.kickoff_time
        : new Date(row.kickoff_time)
      : null;
    kickoffCache.set(matchId, { value, expiresAt: now + KICKOFF_CACHE_TTL_MS });
    return value;
  } catch (err) {
    logger.debug({ err, matchId }, "resolveKickoffTime failed — falling back to no-ttk");
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Top-level evaluator
// ──────────────────────────────────────────────────────────────────────────

export async function evaluateInversionGate(
  candidate: InversionCandidate,
): Promise<InversionDecision> {
  const thresholds = await readThresholds();

  // Stage 1 — model-blind watchlist eligibility
  const stage1 = await evaluateStage1(candidate);

  // Bundle 5.C — multi-book reader (informational at Stage 2; fed into
  // diagnostics whether or not we end up using it for the decision).
  const multiBook = await readMultiBookSnapshots(
    candidate.matchId,
    candidate.marketType,
    candidate.selectionName,
  );
  const { consensusP, bookCount } = computeMultiBookConsensus(multiBook);

  // Stage 2 — Pinnacle confirm + sanity check
  const stage2 = await evaluateStage2(candidate, thresholds);

  // Stage 3 — Multiplicative post-slippage net-edge gate (Bundle 5.I).
  // Needs kickoff time to bucket TTK. Resolve from the candidate's
  // override or the matches table (60s cache).
  const kickoff = await resolveKickoffTime(candidate.matchId, candidate.kickoffTime);
  const ttkBucket: TtkBucket = kickoff ? computeTtkBucket(kickoff) : "24h_plus";

  const stage3 =
    stage2.identifiedEdgePp != null && candidate.pinnacleImplied != null && candidate.pinnacleImplied > 0
      ? await evaluateStage3(
          candidate.backOdds,
          candidate.pinnacleImplied,
          candidate.marketType,
          ttkBucket,
          thresholds,
        )
      : ({
          postSlippageEdgePp: null,
          expectedFillOdds: null,
          p75Slippage: null,
          slippageSource: null,
          ttkBucket,
          demote: true,
          flags: [],
          reasons: ["stage3_no_edge_input"],
        } satisfies Stage3Output);

  // Bundle 5.J — sharp-count tiering. Always computed (even when we'll
  // ultimately veto/demote) so diagnostics shows the count we would have
  // staked at. Pinnacle is the always-on anchor when candidate.pinnacleImplied
  // is non-null; non-Pinnacle sharps in multiBook are agreement-checked.
  const sharpAgreement = candidate.pinnacleImplied != null && candidate.pinnacleImplied > 0
    ? countAgreeingSharps(candidate.pinnacleImplied, candidate.backOdds, multiBook)
    : { sharpCount: 0, agreeingSlugs: [] };
  const { multiplier: sharpMultiplier, highConviction: isHighConviction } =
    kellyMultiplierForSharpCount(sharpAgreement.sharpCount, thresholds);

  // HIGH_EDGE telemetry flag (Bundle 5.H §1) — does NOT gate; just surfaces.
  // The actual high-edge integrity check (gate) ships in Bundle 5.K.
  const flags = [...stage3.flags];
  if (stage2.identifiedEdgePp != null && stage2.identifiedEdgePp >= thresholds.highEdgeFlagThresholdPp) {
    flags.push("high_edge");
  }
  if (isHighConviction) {
    flags.push("high_conviction");
  }

  const diagnostics: InversionDiagnostics = {
    identifiedEdgePp: stage2.identifiedEdgePp,
    postSlippageEdgePp: stage3.postSlippageEdgePp,
    expectedFillOdds: stage3.expectedFillOdds,
    p75Slippage: stage3.p75Slippage,
    slippageSource: stage3.slippageSource,
    ttkBucket: stage3.ttkBucket,
    rawModelP: candidate.rawModelProbability,
    biasCorrectedModelP: stage2.biasCorrectedModelP,
    meanBias: stage2.meanBias,
    modelSe: stage2.modelSe,
    pinnacleImplied: candidate.pinnacleImplied,
    multiBookConsensusP: consensusP,
    multiBookCount: bookCount,
    sharpCount: sharpAgreement.sharpCount,
    agreeingSlugs: sharpAgreement.agreeingSlugs,
    isHighConviction,
    disagreementPp: stage2.disagreementPp,
    disagreementZ: stage2.disagreementZ,
    stage1Source: candidate.stage1Source,
    thresholds,
    flags,
  };

  // Order of precedence:
  //   1. Stage 1 reject → VETO (structural failure: model-filtered candidate)
  //   2. Stage 2 veto    → VETO (catastrophic disagreement)
  //   3. Stage 2 no anchor OR Stage 3 demote → DEMOTE_SHADOW
  //   4. PROCEED with multiplier from sharp-count tiering. The legacy R3
  //      disagreement-based downsize remains as a SAFETY OVERRIDE — if
  //      Stage 2 flagged catastrophic disagreement (below veto threshold
  //      but still extreme), force 0.5× even if the sharp tier said 1.0×.

  if (!stage1.ok) {
    return { action: "VETO", reasons: [stage1.reason], diagnostics };
  }
  if (stage2.veto) {
    return { action: "VETO", reasons: stage2.reasons, diagnostics };
  }
  if (stage2.identifiedEdgePp == null || stage3.demote) {
    return {
      action: "DEMOTE_SHADOW",
      reasons: [...stage2.reasons, ...stage3.reasons],
      diagnostics,
    };
  }

  // Bundle 5.K — high-edge integrity check. Runs ONLY when identified
  // edge is high enough to be suspicious. Failure → VETO (better to skip
  // a suspicious bet than to fire one with unverified plumbing). Implements
  // the §A.1 bucket-8 lesson: 10%+ edge bets historically posted -80% ROI,
  // pure artifact.
  if (
    stage2.identifiedEdgePp != null &&
    stage2.identifiedEdgePp >= thresholds.highEdgeFlagThresholdPp
  ) {
    const integrity = await evaluateHighEdgeIntegrity(candidate);
    if (!integrity.ok) {
      return {
        action: "VETO",
        reasons: ["reject_high_edge_integrity", ...integrity.reasons],
        diagnostics,
      };
    }
  }
  // Apply the sharp-tier multiplier, with the R3 disagreement override as a
  // safety floor (never UP-size from a downsize signal, only down-size from
  // an up-size signal).
  const finalMultiplier = stage2.downsize
    ? Math.min(sharpMultiplier, thresholds.kellySingleSharp)
    : sharpMultiplier;
  return {
    action: "PROCEED",
    kellyMultiplier: finalMultiplier,
    reasons: stage2.downsize ? ["stage2_downsize_override_applied"] : [],
    diagnostics,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Bundle 5.M — exposure-caps trim (replaces 0.02 single-bet cap)
// ──────────────────────────────────────────────────────────────────────────
//
// Per the locked spec (docs/bundle-5-activation-spec.md §8): when the
// inversion flag is on, the 0.02 single-bet cap is bypassed (Bundle 5.D
// already does this) and replaced with three new caps applied at the
// stake-clamp step in paperTrading.ts:
//
//   per_fixture_exposure_pct (default 5.0)  — max % bankroll across all
//                                              bets on the same matchId
//   per_league_exposure_pct  (default 15.0) — max % bankroll across all
//                                              open bets in the same league
//   daily_stake_cap_pct      (default 8.0)  — max % bankroll staked in a
//                                              rolling 24h
//
// The helper returns the (possibly trimmed) stake plus the binding-cap
// reason so callers can log structured rejections. When trimmed below the
// £2 Betfair minimum, the existing kelly_below_min_stake demote-shadow
// path in paperTrading kicks in unchanged.

export interface ExposureCapsResult {
  stake: number;
  trimmed: boolean;
  bindingCap: "fixture" | "league" | "daily" | null;
  caps: {
    perFixturePct: number;
    perLeaguePct: number;
    dailyStakeCapPct: number;
  };
  exposure: {
    fixtureAlreadyStaked: number;
    leagueAlreadyStaked: number;
    dailyAlreadyStaked: number;
  };
  /** Bundle 7.E — which bankroll-tier band selected the caps. */
  tierLabel?: string;
}

const exposureCache = new Map<string, { value: number; expiresAt: number }>();
const EXPOSURE_TTL_MS = 30_000;

async function readExposure(cacheKey: string, queryFn: () => Promise<number>): Promise<number> {
  const now = Date.now();
  const hit = exposureCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.value;
  try {
    const value = await queryFn();
    exposureCache.set(cacheKey, { value, expiresAt: now + EXPOSURE_TTL_MS });
    return value;
  } catch (err) {
    logger.debug({ err, cacheKey }, "exposure lookup failed — defaulting to 0");
    return 0;
  }
}

/**
 * Bundle 7.E — bankroll-tier auto-scaling.
 *
 * The 4-tier table lives in agent_config.exposure_cap_tiers (JSON).
 * Detected live bankroll picks the matching band; per-key overrides
 * in agent_config (per_fixture_exposure_pct etc.) win over the table
 * for that specific cap — provides a "pin this cap" escape hatch.
 */
interface ExposureCapTier {
  max_bankroll_gbp: number | null; // null = top tier (unbounded)
  per_fixture_pct: number;
  per_league_pct: number;
  daily_cap_pct: number;
  label: string;
}

const DEFAULT_CAP_TIERS: ExposureCapTier[] = [
  { max_bankroll_gbp: 500,   per_fixture_pct: 3.0, per_league_pct: 10.0, daily_cap_pct: 6.0,  label: "ramp" },
  { max_bankroll_gbp: 2000,  per_fixture_pct: 5.0, per_league_pct: 15.0, daily_cap_pct: 8.0,  label: "default" },
  { max_bankroll_gbp: 10000, per_fixture_pct: 6.0, per_league_pct: 18.0, daily_cap_pct: 10.0, label: "moderate" },
  { max_bankroll_gbp: null,  per_fixture_pct: 8.0, per_league_pct: 20.0, daily_cap_pct: 12.0, label: "mature" },
];

export async function getExposureCapsForBankroll(bankroll: number): Promise<{
  perFixturePct: number;
  perLeaguePct: number;
  dailyStakeCapPct: number;
  tierLabel: string;
}> {
  let tiers: ExposureCapTier[] = DEFAULT_CAP_TIERS;
  try {
    const raw = await getConfigValue("exposure_cap_tiers");
    if (raw) {
      const parsed = JSON.parse(raw) as { tiers?: ExposureCapTier[] };
      if (Array.isArray(parsed?.tiers) && parsed.tiers.length > 0) tiers = parsed.tiers;
    }
  } catch (err) {
    logger.warn({ err }, "exposure_cap_tiers JSON parse failed — using defaults");
  }
  // Pick the first tier whose max_bankroll_gbp is null OR >= bankroll.
  // Iterate in declared order — assumes table is sorted ascending by cap.
  const tier =
    tiers.find((t) => t.max_bankroll_gbp == null || bankroll <= t.max_bankroll_gbp) ??
    tiers[tiers.length - 1]!;

  // Per-key explicit overrides — operator can pin any single cap.
  const overrideNum = async (key: string): Promise<number | null> => {
    const raw = await getConfigValue(key);
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const fixtureOverride = await overrideNum("per_fixture_exposure_pct");
  const leagueOverride = await overrideNum("per_league_exposure_pct");
  const dailyOverride = await overrideNum("daily_stake_cap_pct");

  return {
    perFixturePct: fixtureOverride ?? tier.per_fixture_pct,
    perLeaguePct: leagueOverride ?? tier.per_league_pct,
    dailyStakeCapPct: dailyOverride ?? tier.daily_cap_pct,
    tierLabel: tier.label,
  };
}

export async function applyInversionExposureCaps(args: {
  proposedStake: number;
  bankroll: number;
  matchId: number;
  league: string | null;
}): Promise<ExposureCapsResult> {
  const { proposedStake, bankroll, matchId, league } = args;

  // Bundle 7.E — bankroll-tier auto-scaling. Tier picked from
  // exposure_cap_tiers JSON; per-key explicit overrides win.
  const tierCaps = await getExposureCapsForBankroll(bankroll);
  const caps = {
    perFixturePct: tierCaps.perFixturePct,
    perLeaguePct: tierCaps.perLeaguePct,
    dailyStakeCapPct: tierCaps.dailyStakeCapPct,
  };

  // Current exposure — three lookups, all cached briefly. Each is filtered
  // to live bets only (shadow doesn't consume bankroll).
  const fixtureAlreadyStaked = await readExposure(`fix|${matchId}`, async () => {
    const r = await db.execute(sql`
      SELECT COALESCE(SUM(stake::float8), 0) AS s
      FROM paper_bets
      WHERE match_id = ${matchId}
        AND bet_track = 'live'
        AND status IN ('pending', 'pending_placement')
        AND deleted_at IS NULL
    `);
    return Number(((r as any).rows ?? [])[0]?.s ?? 0);
  });

  const leagueAlreadyStaked = league
    ? await readExposure(`lge|${league}`, async () => {
        const r = await db.execute(sql`
          SELECT COALESCE(SUM(pb.stake::float8), 0) AS s
          FROM paper_bets pb
          JOIN matches m ON m.id = pb.match_id
          WHERE m.league = ${league}
            AND pb.bet_track = 'live'
            AND pb.status IN ('pending', 'pending_placement')
            AND pb.deleted_at IS NULL
        `);
        return Number(((r as any).rows ?? [])[0]?.s ?? 0);
      })
    : 0;

  const dailyAlreadyStaked = await readExposure("daily|24h", async () => {
    const r = await db.execute(sql`
      SELECT COALESCE(SUM(stake::float8), 0) AS s
      FROM paper_bets
      WHERE bet_track = 'live'
        AND placed_at >= NOW() - INTERVAL '24 hours'
        AND deleted_at IS NULL
    `);
    return Number(((r as any).rows ?? [])[0]?.s ?? 0);
  });

  const fixtureBudget = Math.max(0, bankroll * caps.perFixturePct / 100 - fixtureAlreadyStaked);
  const leagueBudget = Math.max(0, bankroll * caps.perLeaguePct / 100 - leagueAlreadyStaked);
  const dailyBudget = Math.max(0, bankroll * caps.dailyStakeCapPct / 100 - dailyAlreadyStaked);

  // Find the binding cap, if any.
  const candidates: Array<{ stake: number; cap: ExposureCapsResult["bindingCap"] }> = [
    { stake: fixtureBudget, cap: "fixture" },
    { stake: leagueBudget, cap: "league" },
    { stake: dailyBudget, cap: "daily" },
  ];
  let stake = proposedStake;
  let bindingCap: ExposureCapsResult["bindingCap"] = null;
  for (const c of candidates) {
    if (c.stake < stake) {
      stake = c.stake;
      bindingCap = c.cap;
    }
  }
  // Round to 2dp.
  stake = Math.round(stake * 100) / 100;

  return {
    stake,
    trimmed: bindingCap !== null,
    bindingCap,
    caps,
    exposure: {
      fixtureAlreadyStaked,
      leagueAlreadyStaked,
      dailyAlreadyStaked,
    },
    tierLabel: tierCaps.tierLabel,
  };
}

// Test seam: clear all caches between unit-test runs.
export function _resetCalibrationCacheForTests(): void {
  calibrationCache.clear();
  slippageCache.clear();
  kickoffCache.clear();
  exposureCache.clear();
}
