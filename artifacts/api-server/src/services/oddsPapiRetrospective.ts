// Sub-phase 8.a: CLV-by-time-to-kickoff retrospective.
// Per docs/phase-2-subphase-8-plan.md. Read-only analysis function +
// admin endpoint. Decides whether 8.b's polling redistribution ships.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const LOOKBACK_DAYS_DEFAULT = 90;
const HARD_FLOOR_DATE = new Date("2026-05-03T00:00:00Z");
const MIN_BUCKET_SAMPLE = 30;
const SHIP_CRITERION_PP_DELTA = 1.0;

const BUCKETS: Array<{ name: string; minMinutes: number; maxMinutes: number | null }> = [
  { name: "0-1h",   minMinutes: 0,    maxMinutes: 60 },
  { name: "1-3h",   minMinutes: 60,   maxMinutes: 180 },
  { name: "3-12h",  minMinutes: 180,  maxMinutes: 720 },
  { name: "12-24h", minMinutes: 720,  maxMinutes: 1440 },
  { name: "24h+",   minMinutes: 1440, maxMinutes: null },
];

export interface BucketStats {
  bucket: string;
  nBets: number;
  meanClvPct: number;
  medianClvPct: number;
  stddevClvPct: number;
  meanClvCiLower: number;
  meanClvCiUpper: number;
  roiPct: number | null;
  winRatePct: number;
  insufficient: boolean;
}

export interface ClvTimeBucketVariant {
  variant: "paperBets" | "combined";
  totalBets: number;
  buckets: BucketStats[];
}

export interface ClvTimeBucketVerdict {
  signalDetected: boolean;
  reason: string;
  meanClvPct0to3h: number | null;
  meanClvPct24hPlus: number | null;
  delta: number | null;
  cisOverlap: boolean | null;
}

export interface ClvTimeBucketResult {
  lookbackDays: number;
  lookbackStartDate: string;
  paperBets: ClvTimeBucketVariant;
  combined: ClvTimeBucketVariant;
  verdict: ClvTimeBucketVerdict;
  notes: string;
}

export interface ClvTimeBucketOpts {
  lookbackDays?: number;
}

interface RawBetRow {
  bucket: string;
  clv_pct: number;
  stake: number;
  pnl: number;
  is_won: number;
}

async function fetchBetsForBuckets(
  opts: { lookbackDays: number; paperOnly: boolean },
): Promise<RawBetRow[]> {
  const requestedStart = new Date(Date.now() - opts.lookbackDays * 24 * 60 * 60 * 1000);
  const lookbackStart = requestedStart > HARD_FLOOR_DATE ? requestedStart : HARD_FLOOR_DATE;

  // bucket assignment via CASE on EXTRACT(EPOCH ...)
  const bucketCase = sql`
    CASE
      WHEN EXTRACT(EPOCH FROM (m.kickoff_time - pb.placed_at)) / 60 < 60 THEN '0-1h'
      WHEN EXTRACT(EPOCH FROM (m.kickoff_time - pb.placed_at)) / 60 < 180 THEN '1-3h'
      WHEN EXTRACT(EPOCH FROM (m.kickoff_time - pb.placed_at)) / 60 < 720 THEN '3-12h'
      WHEN EXTRACT(EPOCH FROM (m.kickoff_time - pb.placed_at)) / 60 < 1440 THEN '12-24h'
      ELSE '24h+'
    END
  `;

  // Paper-only: stake > 0. Combined: stake OR shadow_stake > 0; pnl picked
  // from settlement_pnl (real) or shadow_pnl (shadow) per same convention as
  // sub-phase 6.3.5 (NULLIF(stake,0)/NULLIF(settlement_pnl,0) → fall back to
  // shadow values).
  const stakeFilter = opts.paperOnly
    ? sql`AND pb.stake::numeric > 0`
    : sql`AND (pb.stake::numeric > 0 OR pb.shadow_stake::numeric > 0)`;

  const stakeExpr = opts.paperOnly
    ? sql`pb.stake::numeric`
    : sql`COALESCE(NULLIF(pb.stake::numeric, 0), pb.shadow_stake::numeric, 0)`;

  const pnlExpr = opts.paperOnly
    ? sql`COALESCE(pb.settlement_pnl::numeric, 0)`
    : sql`COALESCE(NULLIF(pb.settlement_pnl::numeric, 0), pb.shadow_pnl::numeric, 0)`;

  const rows = await db.execute(sql`
    SELECT
      ${bucketCase} AS bucket,
      pb.clv_pct::numeric AS clv_pct,
      ${stakeExpr} AS stake,
      ${pnlExpr} AS pnl,
      CASE WHEN pb.status = 'won' THEN 1 ELSE 0 END AS is_won
    FROM paper_bets pb
    JOIN matches m ON m.id = pb.match_id
    WHERE pb.status IN ('won', 'lost')
      AND pb.legacy_regime = false
      AND pb.deleted_at IS NULL
      AND pb.clv_pct IS NOT NULL
      AND pb.placed_at >= ${lookbackStart}
      ${stakeFilter}
  `);

  return ((rows as any).rows ?? []).map((r: any) => ({
    bucket: r.bucket as string,
    clv_pct: parseFloat(r.clv_pct ?? "0"),
    stake: parseFloat(r.stake ?? "0"),
    pnl: parseFloat(r.pnl ?? "0"),
    is_won: parseInt(r.is_won ?? "0"),
  }));
}

function computeBucketStats(bucketName: string, bets: RawBetRow[]): BucketStats {
  if (bets.length === 0) {
    return {
      bucket: bucketName,
      nBets: 0,
      meanClvPct: 0,
      medianClvPct: 0,
      stddevClvPct: 0,
      meanClvCiLower: 0,
      meanClvCiUpper: 0,
      roiPct: null,
      winRatePct: 0,
      insufficient: true,
    };
  }

  const clvValues = bets.map((b) => b.clv_pct).sort((a, b) => a - b);
  const n = clvValues.length;
  const mean = clvValues.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 0
    ? (clvValues[n / 2 - 1]! + clvValues[n / 2]!) / 2
    : clvValues[(n - 1) / 2]!;
  const variance = clvValues.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  const stddev = Math.sqrt(variance);
  // Normal-approximation 95% CI on the mean: mean ± 1.96 × stddev / sqrt(n)
  const standardError = stddev / Math.sqrt(n);
  const ciHalfWidth = 1.96 * standardError;

  const totalStake = bets.reduce((s, b) => s + b.stake, 0);
  const totalPnl = bets.reduce((s, b) => s + b.pnl, 0);
  const roi = totalStake > 0 ? (totalPnl / totalStake) * 100 : null;
  const winRate = (bets.reduce((s, b) => s + b.is_won, 0) / n) * 100;

  return {
    bucket: bucketName,
    nBets: n,
    meanClvPct: round(mean, 4),
    medianClvPct: round(median, 4),
    stddevClvPct: round(stddev, 4),
    meanClvCiLower: round(mean - ciHalfWidth, 4),
    meanClvCiUpper: round(mean + ciHalfWidth, 4),
    roiPct: roi != null ? round(roi, 4) : null,
    winRatePct: round(winRate, 4),
    insufficient: n < MIN_BUCKET_SAMPLE,
  };
}

function round(v: number, dp: number): number {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

function computeAggregatedBucket(
  name: string,
  bets: RawBetRow[],
  bucketNames: string[],
): BucketStats {
  const filtered = bets.filter((b) => bucketNames.includes(b.bucket));
  return computeBucketStats(name, filtered);
}

function computeVariant(
  variant: "paperBets" | "combined",
  bets: RawBetRow[],
): ClvTimeBucketVariant {
  const buckets: BucketStats[] = BUCKETS.map((def) =>
    computeBucketStats(def.name, bets.filter((b) => b.bucket === def.name)),
  );
  return {
    variant,
    totalBets: bets.length,
    buckets,
  };
}

function computeVerdict(combined: ClvTimeBucketVariant, paperBets: ClvTimeBucketVariant): ClvTimeBucketVerdict {
  // Use the larger sample (combined) as primary verdict driver; fall back to
  // paperBets if combined is insufficient. Verdict combines 0-1h and 1-3h
  // into "0-3h" aggregate, compares with 24h+.
  const primary = combined.totalBets >= paperBets.totalBets ? combined : paperBets;

  const bucketsByName = new Map(primary.buckets.map((b) => [b.bucket, b]));
  const b0to1 = bucketsByName.get("0-1h");
  const b1to3 = bucketsByName.get("1-3h");
  const b24plus = bucketsByName.get("24h+");

  if (!b0to1 || !b1to3 || !b24plus) {
    return {
      signalDetected: false,
      reason: "missing buckets",
      meanClvPct0to3h: null,
      meanClvPct24hPlus: null,
      delta: null,
      cisOverlap: null,
    };
  }

  // Aggregate 0-1h + 1-3h → 0-3h. Need to recompute from raw because mean
  // of means is wrong when n differs.
  // Pull the raw rows from the variant; we don't have them here, so reuse
  // the helper computeAggregatedBucket via the original `bets` array — but
  // we only have BucketStats here. Workaround: weight the means by n.
  const n03 = b0to1.nBets + b1to3.nBets;
  if (n03 < MIN_BUCKET_SAMPLE) {
    return {
      signalDetected: false,
      reason: `0-3h aggregate insufficient (n=${n03} < ${MIN_BUCKET_SAMPLE})`,
      meanClvPct0to3h: null,
      meanClvPct24hPlus: null,
      delta: null,
      cisOverlap: null,
    };
  }
  if (b24plus.insufficient) {
    return {
      signalDetected: false,
      reason: `24h+ insufficient (n=${b24plus.nBets} < ${MIN_BUCKET_SAMPLE})`,
      meanClvPct0to3h: null,
      meanClvPct24hPlus: null,
      delta: null,
      cisOverlap: null,
    };
  }

  const mean03 = (b0to1.meanClvPct * b0to1.nBets + b1to3.meanClvPct * b1to3.nBets) / n03;
  // Pooled stddev for the aggregated bucket
  const var03 =
    ((b0to1.nBets - 1) * b0to1.stddevClvPct ** 2 +
      (b1to3.nBets - 1) * b1to3.stddevClvPct ** 2) /
    Math.max(1, n03 - 2);
  const sd03 = Math.sqrt(var03);
  const ci03Half = 1.96 * sd03 / Math.sqrt(n03);
  const ci03Lower = mean03 - ci03Half;
  const ci03Upper = mean03 + ci03Half;

  const delta = mean03 - b24plus.meanClvPct;
  const cisOverlap = ci03Lower <= b24plus.meanClvCiUpper && b24plus.meanClvCiLower <= ci03Upper;

  const signalDetected = delta >= SHIP_CRITERION_PP_DELTA && !cisOverlap;
  const reason = signalDetected
    ? `0-3h mean CLV ${mean03.toFixed(3)}pp exceeds 24h+ ${b24plus.meanClvPct.toFixed(3)}pp by ${delta.toFixed(3)}pp; CIs do not overlap`
    : delta < SHIP_CRITERION_PP_DELTA
      ? `0-3h mean CLV exceeds 24h+ by ${delta.toFixed(3)}pp (< ${SHIP_CRITERION_PP_DELTA}pp threshold)`
      : `0-3h vs 24h+ delta ${delta.toFixed(3)}pp meets threshold but CIs overlap`;

  return {
    signalDetected,
    reason,
    meanClvPct0to3h: round(mean03, 4),
    meanClvPct24hPlus: b24plus.meanClvPct,
    delta: round(delta, 4),
    cisOverlap,
  };
}

export async function runClvTimeBucketRetrospective(
  opts: ClvTimeBucketOpts = {},
): Promise<ClvTimeBucketResult> {
  const lookbackDays = opts.lookbackDays ?? LOOKBACK_DAYS_DEFAULT;
  const requestedStart = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const lookbackStart = requestedStart > HARD_FLOOR_DATE ? requestedStart : HARD_FLOOR_DATE;

  const paperBetsRows = await fetchBetsForBuckets({ lookbackDays, paperOnly: true });
  const combinedRows = await fetchBetsForBuckets({ lookbackDays, paperOnly: false });

  const paperBetsVariant = computeVariant("paperBets", paperBetsRows);
  const combinedVariant = computeVariant("combined", combinedRows);

  const verdict = computeVerdict(combinedVariant, paperBetsVariant);

  logger.info(
    {
      lookbackDays,
      paperBets: paperBetsVariant.totalBets,
      combined: combinedVariant.totalBets,
      signalDetected: verdict.signalDetected,
      reason: verdict.reason,
    },
    "CLV time-bucket retrospective complete",
  );

  return {
    lookbackDays,
    lookbackStartDate: lookbackStart.toISOString(),
    paperBets: paperBetsVariant,
    combined: combinedVariant,
    verdict,
    notes: "Sub-phase 8.a CLV-by-time-to-kickoff retrospective. Buckets computed on minutes from placed_at to kickoff_time. Two variants: paperBets (stake > 0 only) and combined (paper + shadow with stake/pnl source tied to which is non-zero, mirroring 6.3.5 fractional-Kelly source-selection). Lookback hard-floored at 2026-05-03 (pre-Replit-era data excluded). Verdict driven by primary variant (whichever has more bets); ship-criterion: 0-3h mean CLV exceeds 24h+ mean CLV by ≥1pp AND 95% CIs do not overlap. If signal detected, sub-commit 8.b restructures OddsPapi polling to weight closer-to-kickoff window heavier.",
  };
}
