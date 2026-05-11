import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  smallint,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Task 11 — synthetic sharp-consensus snapshots.
 *
 * One row per (match, market_type, selection, snapshot_at, source). The
 * sharpConsensus service aggregates rows across all sources for a given
 * (match, market, selection, snapshot_at) into a consensus fair probability
 * via weighted geometric mean (post de-vig). `consensus_quality` records
 * how many sources contributed (0–4 covering Pinnacle / Smarkets /
 * Matchbook / Betfair SP).
 *
 * Used by Task 11.2 (CLV pipeline integration) to compute
 * synthetic_clv_pct as a fallback / supplement to Pinnacle-only CLV.
 */
export const sharpConsensusSnapshotsTable = pgTable(
  "sharp_consensus_snapshots",
  {
    matchId: integer("match_id").notNull(),
    marketType: text("market_type").notNull(),
    selectionName: text("selection_name").notNull(),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(), // 'pinnacle' | 'smarkets' | 'matchbook' | 'betfair_sp'
    backOdds: numeric("back_odds", { precision: 10, scale: 4 }).notNull(),
    fairProbability: numeric("fair_probability", { precision: 8, scale: 6 }),
    trustWeight: numeric("trust_weight", { precision: 6, scale: 4 }),
    rawPayload: jsonb("raw_payload"),
  },
  (t) => [
    primaryKey({
      columns: [t.matchId, t.marketType, t.selectionName, t.snapshotAt, t.source],
    }),
  ],
);

export type SharpConsensusSnapshot = typeof sharpConsensusSnapshotsTable.$inferSelect;

/**
 * Consensus output — one row per (match, market_type, selection, snapshot_at).
 * Computed at query time from sharpConsensusSnapshotsTable rather than
 * materialised, so a new source coming online updates the consensus
 * automatically.
 */
export interface SharpConsensus {
  matchId: number;
  marketType: string;
  selectionName: string;
  snapshotAt: Date;
  consensusProbability: number;
  consensusFairOdds: number;
  contributingSources: string[];
  consensusQuality: number; // 0–4
}
