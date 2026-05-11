/**
 * Task 11 — sharp consensus algorithm (Phase 3d.1).
 *
 * Computes a single consensus fair probability for (match, market, selection)
 * by combining multiple sharp sources via weighted geometric mean on the
 * de-vigged probabilities. Each source's odds are first de-vigged using
 * the league's configured method (Task 14: power or Shin), then the
 * fair probabilities are aggregated with per-source trust weights.
 *
 * Geometric mean (not arithmetic) — minimises log-loss under standard
 * probabilistic-forecasting assumptions and is the right combinator for
 * probability point estimates that should average multiplicatively.
 *
 *   p_consensus = exp( Σ w_i × ln(p_i) / Σ w_i )
 *
 * Default trust weights (per plan):
 *   pinnacle = 1.0   (gold-standard sharp book)
 *   smarkets = 0.8   (commission-only exchange, sharp but thinner)
 *   matchbook = 0.7  (commission-only exchange, regional)
 *   betfair_sp = 0.9 (Starting Price, post-kickoff; adds back some
 *                     crowd-vig the agent is trying to escape)
 *
 * Overridable via agent_config: synthetic_consensus_trust_weights as JSON.
 *
 * This module is pure-functional + a DB writer/reader. The hot-path CLV
 * pipeline (Phase 3d.2) will consume the consensus output via
 * computeConsensusForSnapshot below.
 */

import { db, sharpConsensusSnapshotsTable, agentConfigTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { devig, type DevigMethod } from "./devig";
import { canonicalSelectionName } from "./paperTrading";

export type SharpSource = "pinnacle" | "smarkets" | "matchbook" | "betfair_sp";

const DEFAULT_TRUST_WEIGHTS: Record<SharpSource, number> = {
  pinnacle: 1.0,
  smarkets: 0.8,
  matchbook: 0.7,
  betfair_sp: 0.9,
};

let cachedWeights: { value: Record<SharpSource, number>; fetchedAt: number } | null = null;
const WEIGHTS_TTL_MS = 5 * 60 * 1000;

export async function getTrustWeights(): Promise<Record<SharpSource, number>> {
  const now = Date.now();
  if (cachedWeights && now - cachedWeights.fetchedAt < WEIGHTS_TTL_MS) {
    return cachedWeights.value;
  }
  try {
    const rows = await db
      .select({ value: agentConfigTable.value })
      .from(agentConfigTable)
      .where(eq(agentConfigTable.key, "synthetic_consensus_trust_weights"))
      .limit(1);
    const raw = rows[0]?.value;
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>;
      const merged = { ...DEFAULT_TRUST_WEIGHTS, ...parsed } as Record<SharpSource, number>;
      cachedWeights = { value: merged, fetchedAt: now };
      return merged;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to parse synthetic_consensus_trust_weights — using defaults");
  }
  cachedWeights = { value: DEFAULT_TRUST_WEIGHTS, fetchedAt: now };
  return DEFAULT_TRUST_WEIGHTS;
}

/**
 * Persist a snapshot from a single sharp source. Idempotent — composite
 * PK lets the upsert silently drop duplicates within the same second.
 *
 * `oddsBySelection` is the post-fetch raw book for one runner (back odds
 * across all outcomes for the same market, e.g. {home, draw, away} for
 * MATCH_ODDS). De-vig runs on this group via the league's configured
 * method; fair_probability is stored per row.
 */
export async function persistSourceSnapshot(args: {
  matchId: number;
  marketType: string;
  source: SharpSource;
  snapshotAt: Date;
  oddsBySelection: Record<string, number>;
  devigMethod: DevigMethod;
  rawPayload?: unknown;
}): Promise<{ rowsInserted: number }> {
  const selections = Object.keys(args.oddsBySelection);
  const odds = selections.map((sel) => args.oddsBySelection[sel]!);
  if (odds.length === 0 || odds.some((o) => !Number.isFinite(o) || o <= 1)) {
    return { rowsInserted: 0 };
  }
  const fair = devig(odds, args.devigMethod);
  const weights = await getTrustWeights();
  const trustWeight = weights[args.source] ?? 0.5;

  const rows = selections.map((sel, i) => ({
    matchId: args.matchId,
    marketType: args.marketType,
    // Phase 3d.3: canonicalise so cross-source consensus joins line up
    // with paper_bets.selection_canonical. Smarkets contract_ids stay
    // contract_ids after canonicalisation (unique strings, just won't
    // match paper_bets.selection_canonical until the Smarkets contract
    // → name resolution lands).
    selectionName: canonicalSelectionName(args.marketType, sel),
    snapshotAt: args.snapshotAt,
    source: args.source,
    backOdds: String(odds[i]!),
    fairProbability: String(fair[i] ?? ""),
    trustWeight: String(trustWeight),
    rawPayload: args.rawPayload as never,
  }));

  await db
    .insert(sharpConsensusSnapshotsTable)
    .values(rows)
    .onConflictDoNothing();

  return { rowsInserted: rows.length };
}

/**
 * Compute consensus for one (match, market, selection) at a given snapshot
 * time. Reads all source rows within `windowMs` of `snapshotAt`, applies
 * trust weights, and returns the weighted geometric-mean fair probability.
 *
 * Returns null when no sources are available within the window.
 */
export async function computeConsensusForSnapshot(args: {
  matchId: number;
  marketType: string;
  selectionName: string;
  snapshotAt: Date;
  windowMs?: number;
}): Promise<{
  consensusProbability: number;
  consensusFairOdds: number;
  contributingSources: SharpSource[];
  consensusQuality: number;
} | null> {
  const windowMs = args.windowMs ?? 30 * 60 * 1000; // ±30 min
  const lo = new Date(args.snapshotAt.getTime() - windowMs);
  const hi = new Date(args.snapshotAt.getTime() + windowMs);
  // Phase 3d.3: lookup selection name is canonicalised to match how
  // persistSourceSnapshot stores it.
  const canonicalSel = canonicalSelectionName(args.marketType, args.selectionName);

  const rows = await db
    .select({
      source: sharpConsensusSnapshotsTable.source,
      fairProbability: sharpConsensusSnapshotsTable.fairProbability,
      trustWeight: sharpConsensusSnapshotsTable.trustWeight,
    })
    .from(sharpConsensusSnapshotsTable)
    .where(
      and(
        eq(sharpConsensusSnapshotsTable.matchId, args.matchId),
        eq(sharpConsensusSnapshotsTable.marketType, args.marketType),
        eq(sharpConsensusSnapshotsTable.selectionName, canonicalSel),
        sql`${sharpConsensusSnapshotsTable.snapshotAt} BETWEEN ${lo} AND ${hi}`,
      ),
    );

  if (rows.length === 0) return null;

  // Weighted geometric mean on fair probabilities: exp(Σ w_i ln p_i / Σ w_i)
  let lnSum = 0;
  let weightSum = 0;
  const sources = new Set<SharpSource>();
  for (const r of rows) {
    const p = r.fairProbability != null ? Number(r.fairProbability) : NaN;
    const w = r.trustWeight != null ? Number(r.trustWeight) : 0;
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(w) || w <= 0) continue;
    lnSum += w * Math.log(p);
    weightSum += w;
    sources.add(r.source as SharpSource);
  }

  if (weightSum <= 0) return null;
  const consensusProbability = Math.exp(lnSum / weightSum);
  if (!Number.isFinite(consensusProbability) || consensusProbability <= 0 || consensusProbability >= 1) {
    return null;
  }

  return {
    consensusProbability,
    consensusFairOdds: 1 / consensusProbability,
    contributingSources: [...sources],
    consensusQuality: sources.size,
  };
}
