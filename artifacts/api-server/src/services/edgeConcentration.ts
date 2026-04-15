import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import pino from "pino";

const logger = pino({ name: "edgeConcentration" });

export type SegmentClass = "exploit" | "explore" | "avoid";

export interface EdgeSegment {
  segmentKey: string;
  league: string;
  marketFamily: string;
  oddsRange: string;
  totalBets: number;
  wonBets: number;
  lostBets: number;
  winRate: number;
  roi: number;
  avgClv: number | null;
  totalPnl: number;
  totalStake: number;
  segmentClass: SegmentClass;
  compositeScore: number;
  kellyMultiplier: number;
  updatedAt: Date;
}

export function getMarketFamily(marketType: string): string {
  if (marketType.startsWith("TOTAL_CORNERS")) return "CORNERS";
  if (marketType.startsWith("TOTAL_CARDS")) return "CARDS";
  if (marketType.startsWith("OVER_UNDER")) return "OVER_UNDER";
  if (marketType === "BTTS") return "BTTS";
  if (marketType === "MATCH_ODDS") return "MATCH_ODDS";
  if (marketType === "DOUBLE_CHANCE") return "DOUBLE_CHANCE";
  if (marketType.startsWith("FIRST_HALF")) return "FIRST_HALF";
  return marketType;
}

export function getOddsRange(odds: number): string {
  if (odds < 1.5) return "<1.5";
  if (odds < 1.8) return "1.5-1.8";
  if (odds < 2.0) return "1.8-2.0";
  if (odds < 3.0) return "2.0-3.0";
  if (odds < 5.0) return "3.0-5.0";
  return "5.0+";
}

const AVOID_MARKETS = new Set(["CORNERS"]);

const MIN_ODDS_TIER1 = 1.80;

export function shouldBlockBet(
  marketType: string,
  backOdds: number,
  liveTier: string | null,
): { blocked: boolean; reason: string | null } {
  const family = getMarketFamily(marketType);

  if (AVOID_MARKETS.has(family)) {
    return {
      blocked: true,
      reason: `Edge concentration: ${family} market blocked — 90 bets, -42.5% ROI, CLV 7.6. Market family suspended.`,
    };
  }

  if (backOdds < 1.50) {
    return {
      blocked: true,
      reason: `Edge concentration: odds ${backOdds.toFixed(2)} below universal floor (1.50). Odds <1.5 show -37.7% ROI across 33 settled bets.`,
    };
  }

  if (liveTier === "tier1" && backOdds < MIN_ODDS_TIER1) {
    return {
      blocked: true,
      reason: `Edge concentration: odds ${backOdds.toFixed(2)} below Tier 1 floor (${MIN_ODDS_TIER1}). Odds <1.8 show -6.8% to -35% ROI historically.`,
    };
  }

  return { blocked: false, reason: null };
}

export function getSegmentKellyMultiplier(
  marketType: string,
  backOdds: number,
  opportunityScore: number,
): number {
  const family = getMarketFamily(marketType);

  if (AVOID_MARKETS.has(family)) return 0;

  if (backOdds < 1.50) return 0.25;
  if (backOdds < 1.80) return 0.50;

  if (family === "OVER_UNDER" && backOdds >= 2.0) return 1.0;
  if (family === "CARDS" && backOdds >= 2.0) return 0.9;
  if (family === "BTTS" && backOdds >= 2.0) return 1.0;
  if (family === "DOUBLE_CHANCE") return 0.7;

  if (opportunityScore >= 70 && opportunityScore < 80 && backOdds >= 2.0) return 1.0;
  if (opportunityScore >= 80) return 0.85;

  return 0.8;
}

export async function calculateEdgeSegments(): Promise<EdgeSegment[]> {
  const rows = await db.execute(sql`
    SELECT
      m.league,
      pb.market_type,
      pb.odds_at_placement::float AS odds,
      pb.status,
      pb.settlement_pnl::float AS pnl,
      pb.stake::float AS stake,
      pb.clv_pct::float AS clv
    FROM paper_bets pb
    JOIN matches m ON pb.match_id = m.id
    WHERE pb.status IN ('won', 'lost')
    ORDER BY pb.placed_at DESC
  `);

  const segMap = new Map<string, {
    league: string;
    marketFamily: string;
    oddsRange: string;
    won: number;
    lost: number;
    pnlSum: number;
    stakeSum: number;
    clvSum: number;
    clvCount: number;
  }>();

  for (const r of rows.rows as Record<string, unknown>[]) {
    const league = String(r.league ?? "Unknown");
    const marketFamily = getMarketFamily(String(r.market_type ?? ""));
    const odds = Number(r.odds ?? 0);
    const oddsRange = getOddsRange(odds);
    const status = String(r.status ?? "");
    const pnl = Number(r.pnl ?? 0);
    const stake = Number(r.stake ?? 0);
    const clv = r.clv !== null && r.clv !== undefined ? Number(r.clv) : null;

    const key = `${league}|${marketFamily}`;

    let seg = segMap.get(key);
    if (!seg) {
      seg = { league, marketFamily, oddsRange, won: 0, lost: 0, pnlSum: 0, stakeSum: 0, clvSum: 0, clvCount: 0 };
      segMap.set(key, seg);
    }

    if (status === "won") seg.won++;
    else seg.lost++;
    seg.pnlSum += pnl;
    seg.stakeSum += stake;
    if (clv !== null) { seg.clvSum += clv; seg.clvCount++; }
  }

  const mktSegMap = new Map<string, {
    marketFamily: string;
    won: number;
    lost: number;
    pnlSum: number;
    stakeSum: number;
    clvSum: number;
    clvCount: number;
  }>();

  for (const r of rows.rows as Record<string, unknown>[]) {
    const marketFamily = getMarketFamily(String(r.market_type ?? ""));
    const status = String(r.status ?? "");
    const pnl = Number(r.pnl ?? 0);
    const stake = Number(r.stake ?? 0);
    const clv = r.clv !== null && r.clv !== undefined ? Number(r.clv) : null;

    let seg = mktSegMap.get(marketFamily);
    if (!seg) {
      seg = { marketFamily, won: 0, lost: 0, pnlSum: 0, stakeSum: 0, clvSum: 0, clvCount: 0 };
      mktSegMap.set(marketFamily, seg);
    }

    if (status === "won") seg.won++;
    else seg.lost++;
    seg.pnlSum += pnl;
    seg.stakeSum += stake;
    if (clv !== null) { seg.clvSum += clv; seg.clvCount++; }
  }

  const segments: EdgeSegment[] = [];

  for (const [key, seg] of segMap) {
    const total = seg.won + seg.lost;
    const winRate = total > 0 ? (seg.won / total) * 100 : 0;
    const roi = seg.stakeSum > 0 ? (seg.pnlSum / seg.stakeSum) * 100 : 0;
    const avgClv = seg.clvCount > 0 ? seg.clvSum / seg.clvCount : null;

    const clvScore = avgClv !== null ? Math.min(avgClv * 0.4, 40) : 0;
    const roiScore = Math.min(Math.max(roi * 0.3, -15), 25);
    const volumeScore = Math.min(total * 0.5, 15);
    const sampleWeight = Math.min(1, Math.sqrt(total / 20));
    const compositeScore = (clvScore + roiScore + volumeScore) * sampleWeight;

    let segmentClass: SegmentClass;
    if (AVOID_MARKETS.has(seg.marketFamily)) {
      segmentClass = "avoid";
    } else if (total >= 15 && compositeScore >= 15 && (avgClv === null || avgClv > 0)) {
      segmentClass = "exploit";
    } else if (total >= 20 && roi < -10 && (avgClv === null || avgClv < 5)) {
      segmentClass = "avoid";
    } else {
      segmentClass = "explore";
    }

    const kellyMultiplier = segmentClass === "exploit" ? 1.0
      : segmentClass === "explore" ? 0.5
      : 0.25;

    segments.push({
      segmentKey: key,
      league: seg.league,
      marketFamily: seg.marketFamily,
      oddsRange: seg.oddsRange,
      totalBets: total,
      wonBets: seg.won,
      lostBets: seg.lost,
      winRate: Math.round(winRate * 10) / 10,
      roi: Math.round(roi * 10) / 10,
      avgClv: avgClv !== null ? Math.round(avgClv * 10) / 10 : null,
      totalPnl: Math.round(seg.pnlSum * 100) / 100,
      totalStake: Math.round(seg.stakeSum * 100) / 100,
      segmentClass,
      compositeScore: Math.round(compositeScore * 10) / 10,
      kellyMultiplier,
      updatedAt: new Date(),
    });
  }

  for (const [, seg] of mktSegMap) {
    const total = seg.won + seg.lost;
    const winRate = total > 0 ? (seg.won / total) * 100 : 0;
    const roi = seg.stakeSum > 0 ? (seg.pnlSum / seg.stakeSum) * 100 : 0;
    const avgClv = seg.clvCount > 0 ? seg.clvSum / seg.clvCount : null;

    const clvScore = avgClv !== null ? Math.min(avgClv * 0.4, 40) : 0;
    const roiScore = Math.min(Math.max(roi * 0.3, -15), 25);
    const volumeScore = Math.min(total * 0.5, 15);
    const sampleWeight = Math.min(1, Math.sqrt(total / 20));
    const compositeScore = (clvScore + roiScore + volumeScore) * sampleWeight;

    let segmentClass: SegmentClass;
    if (AVOID_MARKETS.has(seg.marketFamily)) {
      segmentClass = "avoid";
    } else if (total >= 15 && compositeScore >= 15 && (avgClv === null || avgClv > 0)) {
      segmentClass = "exploit";
    } else if (total >= 20 && roi < -10 && (avgClv === null || avgClv < 5)) {
      segmentClass = "avoid";
    } else {
      segmentClass = "explore";
    }

    const kellyMultiplier = segmentClass === "exploit" ? 1.0
      : segmentClass === "explore" ? 0.5
      : 0.25;

    segments.push({
      segmentKey: `ALL|${seg.marketFamily}`,
      league: "ALL",
      marketFamily: seg.marketFamily,
      oddsRange: "ALL",
      totalBets: total,
      wonBets: seg.won,
      lostBets: seg.lost,
      winRate: Math.round(winRate * 10) / 10,
      roi: Math.round(roi * 10) / 10,
      avgClv: avgClv !== null ? Math.round(avgClv * 10) / 10 : null,
      totalPnl: Math.round(seg.pnlSum * 100) / 100,
      totalStake: Math.round(seg.stakeSum * 100) / 100,
      segmentClass,
      compositeScore: Math.round(compositeScore * 10) / 10,
      kellyMultiplier,
      updatedAt: new Date(),
    });
  }

  segments.sort((a, b) => b.compositeScore - a.compositeScore);

  const exploit = segments.filter(s => s.segmentClass === "exploit").length;
  const explore = segments.filter(s => s.segmentClass === "explore").length;
  const avoid = segments.filter(s => s.segmentClass === "avoid").length;
  logger.info(
    { total: segments.length, exploit, explore, avoid },
    "Edge segments calculated",
  );

  return segments;
}

export interface OddsRangeSegment {
  oddsRange: string;
  totalBets: number;
  winRate: number;
  roi: number;
  avgClv: number | null;
  totalPnl: number;
}

export async function calculateOddsRangeSegments(): Promise<OddsRangeSegment[]> {
  const rows = await db.execute(sql`
    SELECT
      pb.odds_at_placement::float AS odds,
      pb.status,
      pb.settlement_pnl::float AS pnl,
      pb.stake::float AS stake,
      pb.clv_pct::float AS clv
    FROM paper_bets pb
    WHERE pb.status IN ('won', 'lost')
  `);

  const ranges = new Map<string, { won: number; lost: number; pnl: number; stake: number; clvSum: number; clvN: number }>();

  for (const r of rows.rows as Record<string, unknown>[]) {
    const odds = Number(r.odds ?? 0);
    const range = getOddsRange(odds);
    let seg = ranges.get(range);
    if (!seg) seg = { won: 0, lost: 0, pnl: 0, stake: 0, clvSum: 0, clvN: 0 };
    if (String(r.status) === "won") seg.won++; else seg.lost++;
    seg.pnl += Number(r.pnl ?? 0);
    seg.stake += Number(r.stake ?? 0);
    if (r.clv !== null && r.clv !== undefined) { seg.clvSum += Number(r.clv); seg.clvN++; }
    ranges.set(range, seg);
  }

  return [...ranges.entries()].map(([range, s]) => {
    const total = s.won + s.lost;
    return {
      oddsRange: range,
      totalBets: total,
      winRate: total > 0 ? Math.round((s.won / total) * 1000) / 10 : 0,
      roi: s.stake > 0 ? Math.round((s.pnl / s.stake) * 1000) / 10 : 0,
      avgClv: s.clvN > 0 ? Math.round((s.clvSum / s.clvN) * 10) / 10 : null,
      totalPnl: Math.round(s.pnl * 100) / 100,
    };
  }).sort((a, b) => b.roi - a.roi);
}

export async function voidPendingCornersBets(): Promise<{ voided: number; stakeRefunded: number }> {
  const pendingCorners = await db.execute(sql`
    SELECT id, stake::float AS stake FROM paper_bets
    WHERE status = 'pending'
    AND market_type LIKE 'TOTAL_CORNERS%'
  `);

  const rows = pendingCorners.rows as Record<string, unknown>[];
  if (rows.length === 0) {
    logger.info("No pending corners bets to void");
    return { voided: 0, stakeRefunded: 0 };
  }

  let totalStake = 0;
  for (const r of rows) {
    const id = Number(r.id);
    const stake = Number(r.stake ?? 0);
    totalStake += stake;

    await db.execute(sql`
      UPDATE paper_bets
      SET status = 'voided', settlement_pnl = 0, settled_at = NOW()
      WHERE id = ${id}
    `);
  }

  logger.info(
    { voided: rows.length, stakeRefunded: totalStake },
    "Voided all pending corners bets — edge concentration: CORNERS market suspended",
  );

  return { voided: rows.length, stakeRefunded: Math.round(totalStake * 100) / 100 };
}
