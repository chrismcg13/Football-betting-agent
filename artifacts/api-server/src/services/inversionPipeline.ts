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

export interface InversionDiagnostics {
  identifiedEdgePp: number | null;
  postSlippageEdgePp: number | null;
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
}

export interface InversionThresholds {
  minPostSlippageEdgePp: number;
  vetoZ: number;
  vetoAbsPp: number;
  downsizeZ: number;
  downsizeAbsPp: number;
  meanBiasWindowN: number;
}

export interface InversionCandidate {
  matchId: number;
  marketType: string;
  selectionName: string;
  backOdds: number;
  pinnacleImplied: number | null;
  rawModelProbability: number;
  stage1Source: Stage1Source;
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
    minPostSlippageEdgePp: await num("inversion_min_post_slip_edge", 3.0),
    vetoZ: await num("inversion_veto_z", 4.0),
    vetoAbsPp: await num("inversion_veto_abs_pp", 25.0),
    downsizeZ: await num("inversion_downsize_z", 2.0),
    downsizeAbsPp: await num("inversion_downsize_abs_pp", 15.0),
    meanBiasWindowN: await num("mean_bias_window_n", 200),
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
//   AND placed_at >= '2026-05-17'  -- post Bundle 3 selectPricingSources fix
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
// Slippage floor table — memo §I
// ──────────────────────────────────────────────────────────────────────────

const P75_SLIPPAGE_PP: Record<string, number> = {
  MATCH_ODDS: 0.0,
  BTTS: 0.0,
  OVER_UNDER_15: 0.0,
  OVER_UNDER_25: 2.2,
  OVER_UNDER_35: 2.2,
  FIRST_HALF_RESULT: 11.8,
  // ASIAN_HANDICAP intentionally absent — Bundle 4 follow-up. Falls through
  // to the default below until selection canonicalisation re-validates the
  // §I slippage signal for AH.
};
const P75_SLIPPAGE_DEFAULT_PP = 2.0;

function getP75SlippagePp(marketType: string): number {
  return P75_SLIPPAGE_PP[marketType] ?? P75_SLIPPAGE_DEFAULT_PP;
}

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
// Stage 3 — Post-slippage edge gate
// ──────────────────────────────────────────────────────────────────────────

function evaluateStage3(
  identifiedEdgePp: number,
  marketType: string,
  thresholds: InversionThresholds,
): { postSlippageEdgePp: number; demote: boolean; reasons: string[] } {
  const p75Slip = getP75SlippagePp(marketType);
  const postSlippageEdgePp = identifiedEdgePp - p75Slip;
  const demote = postSlippageEdgePp < thresholds.minPostSlippageEdgePp;
  const reasons: string[] = [];
  if (demote) {
    reasons.push("stage3_below_post_slippage_floor");
  }
  return { postSlippageEdgePp, demote, reasons };
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

  // Stage 3 — Post-slippage edge gate (only meaningful when Stage 2 returned
  // an identified edge; otherwise demote)
  const stage3 = stage2.identifiedEdgePp != null
    ? evaluateStage3(stage2.identifiedEdgePp, candidate.marketType, thresholds)
    : { postSlippageEdgePp: null as number | null, demote: true, reasons: ["stage3_no_edge_input"] };

  const diagnostics: InversionDiagnostics = {
    identifiedEdgePp: stage2.identifiedEdgePp,
    postSlippageEdgePp: stage3.postSlippageEdgePp,
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
  };

  // Order of precedence:
  //   1. Stage 1 reject → VETO (structural failure: model-filtered candidate)
  //   2. Stage 2 veto    → VETO (catastrophic disagreement)
  //   3. Stage 2 no anchor OR Stage 3 demote → DEMOTE_SHADOW
  //   4. Stage 2 down-size → DOWN_SIZE_HALF
  //   5. Else → PROCEED

  if (!stage1.ok) {
    return {
      action: "VETO",
      reasons: [stage1.reason],
      diagnostics,
    };
  }
  if (stage2.veto) {
    return {
      action: "VETO",
      reasons: stage2.reasons,
      diagnostics,
    };
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

// Test seam: clear the calibration cache between unit-test runs.
export function _resetCalibrationCacheForTests(): void {
  calibrationCache.clear();
}
