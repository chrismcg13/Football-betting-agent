import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Task 13 — empirical correlation matrix between bet outcomes across
 * markets on the same fixture.
 *
 * Computed monthly by scripts/python/compute_market_correlations.py:
 *   - For each (league, market_a, market_b) pair (a < b alphabetically
 *     to deduplicate), pull all settled-bet pairs where the same
 *     match has bets on both markets.
 *   - Compute Pearson correlation of binary (won=1, lost=0) outcomes.
 *   - Persist correlation, n_pairs, and a global market-pair fallback
 *     (league=NULL) for sparse league scopes.
 *
 * Consumer: services/portfolioKelly.ts.applyCorrelationShrinkage().
 * Independent Kelly over-bets correlated pairs (BTTS-Yes ↔ Over 2.5
 * ρ ≈ 0.5-0.7 in football). Portfolio Kelly shrinks each leg's
 * fraction by a correlation-aware factor to keep Σf_i × Σρ_ij within
 * the bankroll allocation cap.
 */
export const marketCorrelationMatrixTable = pgTable(
  "market_correlation_matrix",
  {
    league: text("league").notNull(), // empty string '' = global fallback
    marketA: text("market_a").notNull(),
    marketB: text("market_b").notNull(),
    correlation: numeric("correlation", { precision: 6, scale: 4 }).notNull(),
    nPairs: integer("n_pairs").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.league, t.marketA, t.marketB] })],
);

export type MarketCorrelation = typeof marketCorrelationMatrixTable.$inferSelect;
