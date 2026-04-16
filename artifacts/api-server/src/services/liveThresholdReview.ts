import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getConfigValue, setConfigValue } from "./paperTrading";

const DEFAULT_LIVE_OPP_THRESHOLD = 48;
const MIN_THRESHOLD_FLOOR = 48;
const MIN_SETTLED_FOR_ADJUSTMENT = 50;

export async function getLiveOppScoreThreshold(): Promise<number> {
  const v = await getConfigValue("live_opp_score_threshold");
  return Number(v ?? DEFAULT_LIVE_OPP_THRESHOLD);
}

export async function setLiveOppScoreThreshold(value: number): Promise<void> {
  await setConfigValue("live_opp_score_threshold", String(value));
}

interface ThresholdReviewResult {
  previousThreshold: number;
  newThreshold: number;
  adjusted: boolean;
  reason: string;
  metrics: {
    settledCount: number;
    rollingCLV: number | null;
    rollingROI: number | null;
    clvTrend: string;
    roiStddev: number | null;
    marketDiversity: number | null;
  };
}

export async function reviewLiveThreshold(): Promise<ThresholdReviewResult> {
  const currentThreshold = await getLiveOppScoreThreshold();

  const settledRows = await db.execute(sql`
    SELECT
      pb.id,
      pb.settlement_pnl,
      pb.stake,
      pb.clv_pct,
      pb.market_type,
      pb.placed_at,
      pb.settled_at
    FROM paper_bets pb
    WHERE pb.live_tier = 'tier1'
      AND pb.status IN ('won', 'lost')
      AND pb.settled_at >= NOW() - INTERVAL '30 days'
    ORDER BY pb.settled_at ASC
  `);
  const settled = (settledRows as any).rows ?? settledRows;
  const settledCount = settled.length;

  if (settledCount < MIN_SETTLED_FOR_ADJUSTMENT) {
    const reason = `Insufficient data: ${settledCount}/${MIN_SETTLED_FOR_ADJUSTMENT} Tier 1 bets settled in 30 days. No adjustment.`;
    logger.info({ settledCount, threshold: currentThreshold }, reason);
    return {
      previousThreshold: currentThreshold,
      newThreshold: currentThreshold,
      adjusted: false,
      reason,
      metrics: { settledCount, rollingCLV: null, rollingROI: null, clvTrend: "insufficient_data", roiStddev: null, marketDiversity: null },
    };
  }

  let totalStake = 0;
  let totalPnl = 0;
  let totalClv = 0;
  let clvCount = 0;
  const marketPnl: Record<string, number> = {};
  const weeklyRoi: number[] = [];
  const weeklyClv: number[] = [];

  for (const bet of settled) {
    const stake = Number(bet.stake ?? 0);
    const pnl = Number(bet.settlement_pnl ?? 0);
    const clv = bet.clv_pct != null ? Number(bet.clv_pct) : null;

    totalStake += stake;
    totalPnl += pnl;
    if (clv != null) {
      totalClv += clv;
      clvCount++;
    }

    const mt = bet.market_type ?? "unknown";
    marketPnl[mt] = (marketPnl[mt] ?? 0) + pnl;
  }

  const rollingROI = totalStake > 0 ? (totalPnl / totalStake) * 100 : 0;
  const rollingCLV = clvCount > 0 ? totalClv / clvCount : 0;

  const halfIdx = Math.floor(settled.length / 2);
  const firstHalfClv = settled.slice(0, halfIdx).reduce((sum: number, b: any) => {
    const c = b.clv_pct != null ? Number(b.clv_pct) : 0;
    return sum + c;
  }, 0) / Math.max(halfIdx, 1);
  const secondHalfClv = settled.slice(halfIdx).reduce((sum: number, b: any) => {
    const c = b.clv_pct != null ? Number(b.clv_pct) : 0;
    return sum + c;
  }, 0) / Math.max(settled.length - halfIdx, 1);
  const clvTrend = secondHalfClv > firstHalfClv + 0.5 ? "improving" : secondHalfClv < firstHalfClv - 0.5 ? "declining" : "stable";

  const weekSize = 7;
  for (let i = 0; i < settled.length; i += weekSize) {
    const chunk = settled.slice(i, i + weekSize);
    const wStake = chunk.reduce((s: number, b: any) => s + Number(b.stake ?? 0), 0);
    const wPnl = chunk.reduce((s: number, b: any) => s + Number(b.settlement_pnl ?? 0), 0);
    if (wStake > 0) weeklyRoi.push((wPnl / wStake) * 100);
    const wClv = chunk.reduce((s: number, b: any) => s + (b.clv_pct != null ? Number(b.clv_pct) : 0), 0) / chunk.length;
    weeklyClv.push(wClv);
  }

  const meanRoi = weeklyRoi.reduce((a, b) => a + b, 0) / Math.max(weeklyRoi.length, 1);
  const roiVariance = weeklyRoi.reduce((sum, r) => sum + (r - meanRoi) ** 2, 0) / Math.max(weeklyRoi.length, 1);
  const roiStddev = Math.sqrt(roiVariance);

  const marketValues = Object.values(marketPnl).map(v => Math.abs(v));
  const totalAbsPnl = marketValues.reduce((a, b) => a + b, 0);
  const herfindahl = totalAbsPnl > 0
    ? marketValues.reduce((sum, v) => sum + (v / totalAbsPnl) ** 2, 0)
    : 1;
  const marketDiversity = 1 - herfindahl;

  let newThreshold = currentThreshold;
  let reason = "";
  let adjusted = false;

  if (rollingCLV < 1 || rollingROI < 0) {
    newThreshold = currentThreshold + 3;
    reason = `Performance below minimum: CLV=${rollingCLV.toFixed(2)}% (need ≥1%), ROI=${rollingROI.toFixed(2)}% (need ≥0%). Increasing threshold by 3 → ${newThreshold}.`;
    adjusted = true;
  } else if (rollingCLV > 3 && rollingROI > 5 && settledCount >= MIN_SETTLED_FOR_ADJUSTMENT) {
    let reduction = 2;
    if (clvTrend === "declining") {
      reduction = 0;
      reason = `Strong metrics (CLV=${rollingCLV.toFixed(2)}%, ROI=${rollingROI.toFixed(2)}%) but CLV trend is declining. Holding threshold at ${currentThreshold}.`;
    } else if (roiStddev > 15) {
      reduction = 1;
      reason = `Strong metrics but volatile ROI (stddev=${roiStddev.toFixed(1)}%). Reducing threshold by 1 (conservative) → ${currentThreshold - 1}.`;
    } else if (marketDiversity < 0.3) {
      reduction = 1;
      reason = `Strong metrics but low market diversity (HHI diversity=${(marketDiversity * 100).toFixed(0)}%). Reducing by 1 (conservative) → ${currentThreshold - 1}.`;
    } else {
      reason = `Excellent performance: CLV=${rollingCLV.toFixed(2)}%, ROI=${rollingROI.toFixed(2)}%, trend=${clvTrend}, diversity=${(marketDiversity * 100).toFixed(0)}%. Reducing threshold by ${reduction} → ${currentThreshold - reduction}.`;
    }

    if (reduction > 0) {
      newThreshold = Math.max(currentThreshold - reduction, MIN_THRESHOLD_FLOOR);
      adjusted = newThreshold !== currentThreshold;
      if (!adjusted) {
        reason = `Would reduce threshold but already at floor (${MIN_THRESHOLD_FLOOR}). No change.`;
      }
    }
  } else {
    reason = `Metrics acceptable but not exceptional: CLV=${rollingCLV.toFixed(2)}%, ROI=${rollingROI.toFixed(2)}%, ${settledCount} settled. No adjustment.`;
  }

  if (adjusted) {
    await setLiveOppScoreThreshold(newThreshold);

    await db.execute(sql`
      INSERT INTO promotion_audit_log (id, experiment_tag, previous_tier, new_tier, decision_reason, metrics_snapshot, thresholds_used, decided_at, decided_by)
      VALUES (
        ${"threshold-" + Date.now()},
        ${"live_opp_score_threshold"},
        ${String(currentThreshold)},
        ${String(newThreshold)},
        ${reason},
        ${JSON.stringify({
          settledCount,
          rollingCLV,
          rollingROI,
          clvTrend,
          roiStddev,
          marketDiversity,
          weeklyRoi,
          weeklyClv,
          marketPnl,
        })},
        ${JSON.stringify({
          minSettled: MIN_SETTLED_FOR_ADJUSTMENT,
          minFloor: MIN_THRESHOLD_FLOOR,
          minPinnacleEdge: 2,
        })},
        NOW(),
        ${"live_threshold_review"}
      )
    `);
  }

  logger.info(
    { previousThreshold: currentThreshold, newThreshold, adjusted, reason, settledCount, rollingCLV, rollingROI },
    "Live threshold review complete",
  );

  return {
    previousThreshold: currentThreshold,
    newThreshold,
    adjusted,
    reason,
    metrics: {
      settledCount,
      rollingCLV: Math.round(rollingCLV * 100) / 100,
      rollingROI: Math.round(rollingROI * 100) / 100,
      clvTrend,
      roiStddev: Math.round(roiStddev * 100) / 100,
      marketDiversity: Math.round(marketDiversity * 100) / 100,
    },
  };
}
