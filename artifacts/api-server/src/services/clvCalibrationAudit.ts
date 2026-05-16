import { db, paperBetsTable, matchesTable, complianceLogsTable } from "@workspace/db";
import { sql, and, eq, isNotNull, inArray, gte } from "drizzle-orm";
import { logger } from "../lib/logger";

// Bundle 1O (2026-05-16): sharp-anchor sources only. A CLV measured against
// the Betfair Exchange close (which is the venue we're TRADING ON) is not
// an edge signal — it's just price drift between two of our own observations.
// Per Neon audit 2026-05-16, 32.2% of BTTS settled bets (n=115) and 3.1% of
// AH settled bets (n=298) had clv_source='betfair_exchange'. Including them
// in the CLV calibration regression pollutes the slope/t-stat for those
// scopes. The sharp-anchor allow-list mirrors TIER_2_PRIORITY_ORDER in
// oddsPapi.ts but EXCLUDES betfair_exchange specifically.
const SHARP_CLV_SOURCES = [
  "pinnacle",
  "pinnacle_derived",
  "oddspapi_pinnacle",
  "oddspapi_smarkets",
  "oddspapi_matchbook",
  "oddspapi_sbobet",
  "oddspapi_sbo",
  "oddspapi_bet365",
  // Bundle 1U.2 (2026-05-16): direct Matchbook ingestion writes
  // source='matchbook' (per SharpSource type in sharpConsensus.ts), distinct
  // from oddspapi_matchbook. Both are sharp exchange data and belong in the
  // edge-validation pool. Without this entry, matchbook-anchored bets were
  // being excluded from clvCalibrationAudit regressions.
  "matchbook",
];

// Bundle 1C.1 (2026-05-16): CLV-vs-ROI calibration regression.
//
// The strategic question this answers: is our CLV signal an HONEST predictor
// of realised ROI? A bet with +5% CLV should realise +5% ROI long-run; that's
// what calibrated CLV looks like. If the regression slope of realised_ROI vs
// CLV_decile_midpoint is much less than 1.0, our CLV is noise (and any
// Kelly allocation built on top will produce confidently-wrong fractions).
// If slope is much greater than 1.0, CLV under-predicts and we're under-
// allocating Kelly on real edge.
//
// Per operator escalation 2026-05-16: "edge is the most vital thing to
// having a successful model." This is the calibration of the measurement
// instrument before we scale on top of it.
//
// Scope rules:
//   - Bins bets by CLV decile (10 buckets, 10th percentile boundaries).
//   - Computes mean realised PnL per decile (over stake — so realised ROI %).
//   - Fits ordinary least squares: realised_ROI = slope × CLV_midpoint + intercept.
//   - Reports (slope, intercept, R², bin counts).
//   - VOID bets excluded — only won/lost contribute.
//
// Acceptance gate for downstream consumers (Bundle 2B per-scope Kelly):
//   - slope ∈ [0.6, 1.5] AND R² ≥ 0.3  →  CLV honest enough to drive Kelly
//   - Otherwise: scope CLV measurement is noisy; Kelly fraction stays low,
//     scope flagged for special review.
//
// Storage: one row per (scope) per run into compliance_logs.
//   action_type = 'clv_calibration_audit'
//   details = full regression output + bin populations

const CLV_DECILE_BOUNDS = [-100, -10, -5, -2.5, -1, 1, 2.5, 5, 10, 25, 200];
// 10 deciles formed by 11 boundaries above. Midpoints used for the regression
// x-axis. Extremes (-100, +200) catch unusual outlier CLV values.

interface BinStats {
  decile: number;          // 0..9
  midpointPct: number;     // CLV decile midpoint (e.g. -7.5, -3.75, ...)
  nBets: number;
  meanRoiPct: number;      // mean realised ROI in this bin (PnL / stake × 100)
  totalStake: number;
  totalPnl: number;
}

export interface CalibrationResult {
  scope: string;           // 'PORTFOLIO' | `${marketType}:${leagueLabel}`
  marketType: string | null;
  leagueId: string | null;
  nTotalBets: number;
  nNonEmptyBins: number;
  slope: number | null;        // null if regression undefined (n < 2 bins)
  intercept: number | null;
  rSquared: number | null;
  bins: BinStats[];
  // Truth-test verdict:
  //   'inverted'   — slope < 0 AND R² ≥ 0.3 (CLV ANTI-predicts realised ROI;
  //                  worst pathology — pre-Bundle-1N MO sat here at slope=-0.69,
  //                  R²=0.32 but was labelled 'honest' under the prior abs()-based logic)
  //   'honest'     — slope ∈ [0.6, 1.5] AND R² ≥ 0.3
  //   'noisy'      — slope ∈ [0, 0.6) OR R² < 0.3
  //   'underpredicts' — slope > 1.5 (CLV signal stronger than thought)
  //   'insufficient_data' — n < 50 bets total OR < 4 non-empty bins
  verdict: "inverted" | "honest" | "noisy" | "underpredicts" | "insufficient_data";
}

function decileMidpoint(idx: number): number {
  return (CLV_DECILE_BOUNDS[idx] + CLV_DECILE_BOUNDS[idx + 1]) / 2;
}

function assignDecile(clvPct: number): number {
  // Linear scan is fine for 10 boundaries.
  for (let i = 0; i < CLV_DECILE_BOUNDS.length - 1; i++) {
    if (clvPct >= CLV_DECILE_BOUNDS[i] && clvPct < CLV_DECILE_BOUNDS[i + 1]) return i;
  }
  return CLV_DECILE_BOUNDS.length - 2; // last bin catches edge
}

// Ordinary least squares on (midpoint, meanRoi) weighted by bin count.
// Returns null slope/intercept/R² when fewer than 2 non-empty bins.
function fitRegression(bins: BinStats[]): { slope: number | null; intercept: number | null; rSquared: number | null } {
  const nonEmpty = bins.filter((b) => b.nBets > 0);
  if (nonEmpty.length < 2) return { slope: null, intercept: null, rSquared: null };

  let sumW = 0, sumWX = 0, sumWY = 0, sumWXX = 0, sumWXY = 0, sumWYY = 0;
  for (const b of nonEmpty) {
    const w = b.nBets;
    const x = b.midpointPct;
    const y = b.meanRoiPct;
    sumW += w;
    sumWX += w * x;
    sumWY += w * y;
    sumWXX += w * x * x;
    sumWXY += w * x * y;
    sumWYY += w * y * y;
  }
  const meanX = sumWX / sumW;
  const meanY = sumWY / sumW;
  const varX = sumWXX / sumW - meanX * meanX;
  const covXY = sumWXY / sumW - meanX * meanY;
  if (varX < 1e-9) return { slope: null, intercept: null, rSquared: null };

  const slope = covXY / varX;
  const intercept = meanY - slope * meanX;
  // R² = 1 − SSres / SStot, weighted form.
  const ssTotal = sumWYY / sumW - meanY * meanY;
  const ssExplained = slope * covXY;
  const rSquared = ssTotal < 1e-9 ? 0 : Math.max(0, Math.min(1, ssExplained / ssTotal));
  return { slope, intercept, rSquared };
}

function verdict(
  nTotal: number,
  nNonEmptyBins: number,
  slope: number | null,
  rSquared: number | null,
): CalibrationResult["verdict"] {
  if (nTotal < 50 || nNonEmptyBins < 4 || slope == null || rSquared == null) {
    return "insufficient_data";
  }
  // Bundle 1N (2026-05-16) fix: a negative slope with meaningful R² is the
  // WORST pathology — CLV anti-predicts realised ROI, so a "positive CLV"
  // bet realises NEGATIVE ROI on average. The prior abs()-based logic
  // labelled this 'honest' because |slope| > 0.6 AND R² > 0.3 both passed.
  // Pre-Bundle-1N MO baseline (slope=-0.6906, R²=0.3175) was being
  // reported 'honest' under the broken logic — masking the most dangerous
  // calibration failure as healthy.
  if (slope < 0 && rSquared >= 0.3) return "inverted";
  if (slope > 1.5) return "underpredicts";
  if (slope < 0.6 || rSquared < 0.3) return "noisy";
  return "honest";
}

interface SettledBetRow {
  marketType: string;
  league: string | null;
  stake: string;
  netPnl: string | null;
  clvPct: string | null;
}

function computeBins(rows: SettledBetRow[]): { bins: BinStats[]; nTotal: number } {
  const bins: BinStats[] = Array.from({ length: 10 }, (_, i) => ({
    decile: i,
    midpointPct: decileMidpoint(i),
    nBets: 0,
    meanRoiPct: 0,
    totalStake: 0,
    totalPnl: 0,
  }));
  let nTotal = 0;
  for (const r of rows) {
    const clv = r.clvPct == null ? null : Number(r.clvPct);
    const stake = Number(r.stake);
    const pnl = r.netPnl == null ? null : Number(r.netPnl);
    if (clv == null || !Number.isFinite(clv) || stake <= 0 || pnl == null || !Number.isFinite(pnl)) continue;
    const idx = assignDecile(clv);
    bins[idx].nBets += 1;
    bins[idx].totalStake += stake;
    bins[idx].totalPnl += pnl;
    nTotal += 1;
  }
  for (const b of bins) {
    b.meanRoiPct = b.totalStake > 0 ? (b.totalPnl / b.totalStake) * 100 : 0;
  }
  return { bins, nTotal };
}

async function pullSettledBets(opts?: { marketType?: string; leagueId?: string }): Promise<SettledBetRow[]> {
  const conditions = [
    inArray(paperBetsTable.status, ["won", "lost"]),
    isNotNull(paperBetsTable.clvPct),
    // Bundle 1O: sharp anchors only — drop betfair_exchange-anchored CLV
    // and NULL clv_source (which is "no anchor available"). See SHARP_CLV_SOURCES
    // comment above for the full reasoning.
    inArray(paperBetsTable.clvSource, SHARP_CLV_SOURCES),
    gte(paperBetsTable.placedAt, sql`NOW() - INTERVAL '180 days'`),
  ];
  if (opts?.marketType) conditions.push(eq(paperBetsTable.marketType, opts.marketType));

  // league filter via matches join when scoped per-league
  if (opts?.leagueId) {
    const rows = await db
      .select({
        marketType: paperBetsTable.marketType,
        league: matchesTable.league,
        stake: paperBetsTable.stake,
        netPnl: paperBetsTable.netPnl,
        clvPct: paperBetsTable.clvPct,
      })
      .from(paperBetsTable)
      .innerJoin(matchesTable, eq(paperBetsTable.matchId, matchesTable.id))
      .where(and(...conditions, eq(matchesTable.league, opts.leagueId)))
      .limit(50000);
    return rows;
  }

  const rows = await db
    .select({
      marketType: paperBetsTable.marketType,
      league: sql<string | null>`NULL`,
      stake: paperBetsTable.stake,
      netPnl: paperBetsTable.netPnl,
      clvPct: paperBetsTable.clvPct,
    })
    .from(paperBetsTable)
    .where(and(...conditions))
    .limit(50000);
  return rows as SettledBetRow[];
}

export async function runClvCalibrationAudit(opts?: {
  marketType?: string;
  leagueId?: string;
}): Promise<CalibrationResult> {
  const rows = await pullSettledBets(opts);
  const { bins, nTotal } = computeBins(rows);
  const nNonEmptyBins = bins.filter((b) => b.nBets > 0).length;
  const { slope, intercept, rSquared } = fitRegression(bins);
  const result: CalibrationResult = {
    scope: opts?.marketType && opts?.leagueId
      ? `${opts.marketType}:${opts.leagueId}`
      : opts?.marketType ?? "PORTFOLIO",
    marketType: opts?.marketType ?? null,
    leagueId: opts?.leagueId ?? null,
    nTotalBets: nTotal,
    nNonEmptyBins,
    slope: slope == null ? null : Math.round(slope * 10000) / 10000,
    intercept: intercept == null ? null : Math.round(intercept * 10000) / 10000,
    rSquared: rSquared == null ? null : Math.round(rSquared * 10000) / 10000,
    bins,
    verdict: verdict(nTotal, nNonEmptyBins, slope, rSquared),
  };
  return result;
}

export interface CalibrationAuditRunResult {
  portfolio: CalibrationResult;
  perMarketType: CalibrationResult[];
  durationMs: number;
}

/**
 * Weekly cron entrypoint. Computes portfolio-wide + per-marketType calibration
 * for the major scopes (AH, MO, BTTS, OU_15, OU_25), writes one compliance_logs
 * row per scope. Bundle 2B's per-scope Kelly allocator reads the latest row to
 * decide whether to trust the CLV signal for that scope.
 */
export async function runClvCalibrationAuditWeekly(): Promise<CalibrationAuditRunResult> {
  const start = Date.now();
  const portfolio = await runClvCalibrationAudit();
  const marketTypes = ["ASIAN_HANDICAP", "MATCH_ODDS", "BTTS", "OVER_UNDER_15", "OVER_UNDER_25"];
  const perMarketType: CalibrationResult[] = [];
  for (const mt of marketTypes) {
    perMarketType.push(await runClvCalibrationAudit({ marketType: mt }));
  }
  const rows = [portfolio, ...perMarketType].map((r) => ({
    actionType: "clv_calibration_audit" as const,
    details: r as unknown as Record<string, unknown>,
  }));
  try {
    await db.insert(complianceLogsTable).values(rows);
  } catch (err) {
    logger.warn({ err, rows: rows.length }, "Failed to write clv_calibration_audit rows (non-fatal)");
  }
  const durationMs = Date.now() - start;
  logger.info(
    {
      portfolio: { n: portfolio.nTotalBets, slope: portfolio.slope, r2: portfolio.rSquared, verdict: portfolio.verdict },
      perMarketType: perMarketType.map((r) => ({
        scope: r.scope, n: r.nTotalBets, slope: r.slope, r2: r.rSquared, verdict: r.verdict,
      })),
      durationMs,
    },
    "Bundle 1C.1 CLV calibration audit complete",
  );
  return { portfolio, perMarketType, durationMs };
}
