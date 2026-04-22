import { db, paperBetsCurrentView, matchesTable } from "@workspace/db";
import { eq, and, gte, lte, desc, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isLeagueMarketTier1Eligible } from "./dataRichness";
import { commissionAdjustedEV, getCommissionRate } from "./commissionService";
import { getEffectiveLimits } from "./liveRiskManager";

interface CandidateBet {
  betId: number;
  matchId: number;
  fixture: string;
  league: string;
  country: string;
  marketType: string;
  selectionName: string;
  odds: number;
  stake: number;
  opportunityScore: number;
  modelProbability: number;
  dataTier: string;
  pinnacleOdds: number;
  pinnacleImplied: number;
  pinnacleEdgePct: number;
  dataRichTier1: boolean;
  path: "promoted" | "data_richness";
  commAdjEV: number;
  clvPct: number | null;
  kickoffTime: string;
}

interface ThresholdBucket {
  threshold: number;
  totalInWindow: number;
  passedOppScore: number;
  passedTierFilter: number;
  hasPinnacle: number;
  passedPinnacleEdge: number;
  passedDataRichness: number;
  qualifiedTier1: number;
  candidates: CandidateBet[];
  totalStake: number;
  totalStakePct: number;
}

interface ThresholdAssessmentResult {
  timestamp: string;
  scanWindow: { from: string; to: string };
  totalPaperBets: number;
  balance: number;
  commissionRate: number;
  limits: {
    maxSingleBet: number;
    maxOpenExposure: number;
    maxLeagueExposure: number;
  };
  buckets: ThresholdBucket[];
  stepDown: { threshold: number; qualified: number; incremental: number }[];
  clvAnalysis: {
    betsAt65Not68: number;
    avgClvPct: number | null;
    medianClvPct: number | null;
    posClvCount: number;
    negClvCount: number;
    noClvCount: number;
    clvValues: { betId: number; fixture: string; oppScore: number; clvPct: number | null }[];
  };
  exposureCheck: {
    totalStakeAt65: number;
    pctOfBalance: number;
    withinMaxExposure: boolean;
    leagueBreakdown: { league: string; stake: number; pct: number; withinLimit: boolean }[];
  };
  recommendation: {
    threshold: number;
    reasoning: string;
  };
}

export async function runThresholdAssessment(low: number, high: number): Promise<ThresholdAssessmentResult> {
  const now = new Date();
  const minKickoff = new Date(now.getTime() + 30 * 60 * 1000);
  const maxKickoff = new Date(now.getTime() + 72 * 60 * 60 * 1000);

  const commRate = await getCommissionRate();
  const limits = await getEffectiveLimits();

  const rows = await db
    .select({
      betId: paperBetsCurrentView.id,
      matchId: paperBetsCurrentView.matchId,
      marketType: paperBetsCurrentView.marketType,
      selectionName: paperBetsCurrentView.selectionName,
      oddsAtPlacement: paperBetsCurrentView.oddsAtPlacement,
      stake: paperBetsCurrentView.stake,
      opportunityScore: paperBetsCurrentView.opportunityScore,
      modelProbability: paperBetsCurrentView.modelProbability,
      dataTier: paperBetsCurrentView.dataTier,
      pinnacleOdds: paperBetsCurrentView.pinnacleOdds,
      pinnacleImplied: paperBetsCurrentView.pinnacleImplied,
      clvPct: paperBetsCurrentView.clvPct,
      homeTeam: matchesTable.homeTeam,
      awayTeam: matchesTable.awayTeam,
      league: matchesTable.league,
      country: matchesTable.country,
      kickoffTime: matchesTable.kickoffTime,
      betfairEventId: matchesTable.betfairEventId,
    })
    .from(paperBetsCurrentView)
    .innerJoin(matchesTable, eq(paperBetsCurrentView.matchId, matchesTable.id))
    .where(
      and(
        eq(paperBetsCurrentView.status, "pending"),
        isNull(paperBetsCurrentView.deletedAt),
        gte(matchesTable.kickoffTime, minKickoff),
        lte(matchesTable.kickoffTime, maxKickoff),
      ),
    )
    .orderBy(desc(paperBetsCurrentView.opportunityScore));

  const enriched: {
    row: typeof rows[0];
    oppScore: number;
    dataTier: string;
    pinnOdds: number | null;
    pinnImpl: number | null;
    modelProb: number;
    edgePct: number;
    isRichData: boolean;
    isPromoted: boolean;
    caEV: number;
    clv: number | null;
  }[] = [];

  for (const row of rows) {
    const oppScore = Number(row.opportunityScore ?? 0);
    const dataTier = row.dataTier ?? "experiment";
    const pinnOdds = row.pinnacleOdds ? Number(row.pinnacleOdds) : null;
    const pinnImpl = row.pinnacleImplied ? Number(row.pinnacleImplied) : null;
    const modelProb = Number(row.modelProbability ?? 0);
    const edgePct = pinnImpl != null ? (modelProb - pinnImpl) * 100 : -999;

    const isRichData = await isLeagueMarketTier1Eligible(
      row.league ?? "",
      row.country ?? "",
      row.marketType,
    );
    const isPromoted = dataTier === "promoted";

    const odds = Number(row.oddsAtPlacement);
    const ev = commissionAdjustedEV(modelProb, odds, commRate);
    const clv = row.clvPct ? Number(row.clvPct) : null;

    enriched.push({
      row,
      oppScore,
      dataTier,
      pinnOdds,
      pinnImpl,
      modelProb,
      edgePct,
      isRichData,
      isPromoted,
      caEV: ev.netEV,
      clv,
    });
  }

  const thresholds = [];
  for (let t = high; t >= low; t--) {
    thresholds.push(t);
  }

  const buckets: ThresholdBucket[] = [];

  for (const threshold of thresholds) {
    let passedOppScore = 0;
    let passedTierFilter = 0;
    let hasPinnacle = 0;
    let passedPinnacleEdge = 0;
    let passedDataRichness = 0;
    const candidates: CandidateBet[] = [];

    for (const e of enriched) {
      if (e.oppScore < threshold) continue;
      passedOppScore++;

      if (e.dataTier === "abandoned" || e.dataTier === "demoted" || e.dataTier === "opportunity_boosted") continue;
      passedTierFilter++;

      if (e.pinnOdds == null || e.pinnImpl == null) continue;
      hasPinnacle++;

      if (e.edgePct < 2) continue;
      passedPinnacleEdge++;

      if (!e.isPromoted && !e.isRichData) continue;
      passedDataRichness++;

      if (e.caEV <= 0) continue;

      candidates.push({
        betId: e.row.betId,
        matchId: e.row.matchId,
        fixture: `${e.row.homeTeam} vs ${e.row.awayTeam}`,
        league: e.row.league ?? "",
        country: e.row.country ?? "",
        marketType: e.row.marketType,
        selectionName: e.row.selectionName,
        odds: Number(e.row.oddsAtPlacement),
        stake: Number(e.row.stake),
        opportunityScore: e.oppScore,
        modelProbability: e.modelProb,
        dataTier: e.dataTier,
        pinnacleOdds: e.pinnOdds!,
        pinnacleImplied: e.pinnImpl!,
        pinnacleEdgePct: Math.round(e.edgePct * 100) / 100,
        dataRichTier1: e.isRichData,
        path: e.isPromoted ? "promoted" : "data_richness",
        commAdjEV: Math.round(e.caEV * 10000) / 10000,
        clvPct: e.clv,
        kickoffTime: e.row.kickoffTime?.toISOString() ?? "",
      });
    }

    const totalStake = candidates.reduce((s, c) => s + c.stake, 0);

    buckets.push({
      threshold,
      totalInWindow: rows.length,
      passedOppScore,
      passedTierFilter,
      hasPinnacle,
      passedPinnacleEdge,
      passedDataRichness,
      qualifiedTier1: candidates.length,
      candidates,
      totalStake,
      totalStakePct: limits.liveBalance > 0 ? Math.round((totalStake / limits.liveBalance) * 10000) / 100 : 0,
    });
  }

  const stepDown = buckets.map((b, i) => ({
    threshold: b.threshold,
    qualified: b.qualifiedTier1,
    incremental: i === 0 ? b.qualifiedTier1 : b.qualifiedTier1 - buckets[i - 1]!.qualifiedTier1,
  }));

  const at65 = buckets.find(b => b.threshold === low);
  const at68 = buckets.find(b => b.threshold === high);
  const at65Ids = new Set((at65?.candidates ?? []).map(c => c.betId));
  const at68Ids = new Set((at68?.candidates ?? []).map(c => c.betId));
  const onlyAt65 = (at65?.candidates ?? []).filter(c => !at68Ids.has(c.betId));

  const clvValues = onlyAt65.map(c => ({
    betId: c.betId,
    fixture: c.fixture,
    oppScore: c.opportunityScore,
    clvPct: c.clvPct,
  }));

  const clvsWithData = clvValues.filter(c => c.clvPct != null).map(c => c.clvPct!);
  const sortedClvs = [...clvsWithData].sort((a, b) => a - b);
  const medianClv = sortedClvs.length > 0
    ? sortedClvs.length % 2 === 0
      ? (sortedClvs[sortedClvs.length / 2 - 1]! + sortedClvs[sortedClvs.length / 2]!) / 2
      : sortedClvs[Math.floor(sortedClvs.length / 2)]!
    : null;

  const clvAnalysis = {
    betsAt65Not68: onlyAt65.length,
    avgClvPct: clvsWithData.length > 0 ? Math.round((clvsWithData.reduce((s, v) => s + v, 0) / clvsWithData.length) * 100) / 100 : null,
    medianClvPct: medianClv != null ? Math.round(medianClv * 100) / 100 : null,
    posClvCount: clvsWithData.filter(v => v > 0).length,
    negClvCount: clvsWithData.filter(v => v < 0).length,
    noClvCount: clvValues.filter(c => c.clvPct == null).length,
    clvValues,
  };

  const allAt65 = at65?.candidates ?? [];
  const leagueStakes: Record<string, number> = {};
  for (const c of allAt65) {
    leagueStakes[c.league] = (leagueStakes[c.league] ?? 0) + c.stake;
  }
  const leagueBreakdown = Object.entries(leagueStakes).map(([league, stake]) => ({
    league,
    stake,
    pct: limits.liveBalance > 0 ? Math.round((stake / limits.liveBalance) * 10000) / 100 : 0,
    withinLimit: stake <= limits.maxLeagueExposure,
  }));

  const totalStakeAt65 = at65?.totalStake ?? 0;
  const exposureCheck = {
    totalStakeAt65,
    pctOfBalance: limits.liveBalance > 0 ? Math.round((totalStakeAt65 / limits.liveBalance) * 10000) / 100 : 0,
    withinMaxExposure: totalStakeAt65 <= limits.maxOpenExposure,
    leagueBreakdown,
  };

  let recThreshold = high;
  let reasoning = "";

  const countAt = (t: number) => buckets.find(b => b.threshold === t)?.qualifiedTier1 ?? 0;

  if (countAt(high) > 0) {
    recThreshold = high;
    reasoning = `Current threshold ${high} already produces ${countAt(high)} qualifying bets. No reason to lower.`;
  } else if (countAt(high - 1) > 0 && clvAnalysis.avgClvPct != null && clvAnalysis.avgClvPct > 0) {
    recThreshold = high - 1;
    reasoning = `Threshold ${high - 1} adds ${countAt(high - 1)} bets with positive avg CLV (${clvAnalysis.avgClvPct}%). These are good bets being filtered.`;
  } else if (countAt(high - 2) > 0 && clvAnalysis.avgClvPct != null && clvAnalysis.avgClvPct > 0) {
    recThreshold = high - 2;
    reasoning = `Threshold ${high - 2} adds ${countAt(high - 2)} bets. Average CLV ${clvAnalysis.avgClvPct}% is positive — bets have genuine edge.`;
  } else if (countAt(low) > 0 && clvAnalysis.avgClvPct != null && clvAnalysis.avgClvPct > 0) {
    recThreshold = low;
    reasoning = `Threshold ${low} adds ${countAt(low)} bets with positive avg CLV. Acceptable for launch volume.`;
  } else if (countAt(low) > 0) {
    recThreshold = low;
    reasoning = `Threshold ${low} adds ${countAt(low)} bets but CLV data is insufficient to assess quality. Proceed with caution or wait for more data.`;
  } else {
    recThreshold = high;
    reasoning = `No bets qualify at any threshold ${low}-${high}. The constraint is Pinnacle coverage and data richness, not the threshold. Keep at ${high} and focus on improving Pinnacle data capture.`;
  }

  const result: ThresholdAssessmentResult = {
    timestamp: now.toISOString(),
    scanWindow: { from: minKickoff.toISOString(), to: maxKickoff.toISOString() },
    totalPaperBets: rows.length,
    balance: limits.liveBalance,
    commissionRate: commRate,
    limits: {
      maxSingleBet: limits.maxSingleBet,
      maxOpenExposure: limits.maxOpenExposure,
      maxLeagueExposure: limits.maxLeagueExposure,
    },
    buckets,
    stepDown,
    clvAnalysis,
    exposureCheck,
    recommendation: {
      threshold: recThreshold,
      reasoning,
    },
  };

  logger.info(
    { stepDown, recommendation: result.recommendation, clvSummary: { avg: clvAnalysis.avgClvPct, median: clvAnalysis.medianClvPct, pos: clvAnalysis.posClvCount, neg: clvAnalysis.negClvCount } },
    "Threshold assessment complete",
  );

  return result;
}
