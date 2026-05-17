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
  | { action: "PROCEED"; kellyMultiplier: 1.0; reasons: string[]; diagnostics: InversionDiagnostics }
  | { action: "DOWN_SIZE_HALF"; kellyMultiplier: 0.5; reasons: string[]; diagnostics: InversionDiagnostics }
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
    highEdgeFlagThresholdPp: await num("high_edge_flag_threshold", 7.0),
    vetoZ: await num("inversion_veto_z", 4.0),
    vetoAbsPp: await num("inversion_veto_abs_pp", 25.0),
    downsizeZ: await num("inversion_downsize_z", 2.0),
    downsizeAbsPp: await num("inversion_downsize_abs_pp", 15.0),
    meanBiasWindowN: await num("mean_bias_window_n", 200),
    slippageCautionThreshold: await num("slippage_caution_threshold", 0.05),
    defaultP75Slippage: await num("default_p75_slippage", 0.015),
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
// Stage 1 — model-blind watchlist eligibility
// ──────────────────────────────────────────────────────────────────────────

function evaluateStage1(
  candidate: InversionCandidate,
): { ok: true } | { ok: false; reason: string } {
  if (candidate.stage1Source === "legacy_model_candidate") {
    return { ok: false, reason: "stage1_model_filtered" };
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
  const demote = postSlippageEdgePp < thresholds.minNetEdgePp;
  const reasons: string[] = [];
  const flags: string[] = [];
  if (demote) reasons.push("stage3_below_net_edge_floor");
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
  const stage1 = evaluateStage1(candidate);

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

  // HIGH_EDGE telemetry flag (Bundle 5.H §1) — does NOT gate; just surfaces.
  // The actual high-edge integrity check (gate) ships in Bundle 5.K.
  const flags = [...stage3.flags];
  if (stage2.identifiedEdgePp != null && stage2.identifiedEdgePp >= thresholds.highEdgeFlagThresholdPp) {
    flags.push("high_edge");
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
  //   4. Stage 2 down-size → DOWN_SIZE_HALF (fallback; superseded by
  //                          multi-sharp tiering in Bundle 5.J)
  //   5. Else → PROCEED

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
  if (stage2.downsize) {
    return {
      action: "DOWN_SIZE_HALF",
      kellyMultiplier: 0.5,
      reasons: stage2.reasons,
      diagnostics,
    };
  }
  return {
    action: "PROCEED",
    kellyMultiplier: 1.0,
    reasons: [],
    diagnostics,
  };
}

// Test seam: clear all caches between unit-test runs.
export function _resetCalibrationCacheForTests(): void {
  calibrationCache.clear();
  slippageCache.clear();
  kickoffCache.clear();
}
