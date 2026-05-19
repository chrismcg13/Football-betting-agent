import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Task 12 — calibration buckets. One row per (scope_league, market_type)
 * fitted by the weekly Python calibration cron. `scope_league = NULL` is
 * a market-type global fallback used when no league-specific bucket
 * exists with enough samples (n ≥ 30). Multiple historical fits are kept
 * (active flag marks the current one) for audit and rollback.
 *
 * params jsonb shape (method='isotonic'):
 *   { "breakpoints": number[], "values": number[] }
 *   — sorted parallel arrays; piecewise-linear interpolation in Node.
 */
export const calibrationBucketsTable = pgTable("calibration_buckets", {
  bucketId: serial("bucket_id").primaryKey(),
  scopeLeague: text("scope_league"), // NULL = market-type global fallback
  marketType: text("market_type").notNull(),
  method: text("method").notNull(), // 'isotonic' | 'beta' | 'raw_fallback'
  fittedAt: timestamp("fitted_at", { withTimezone: true }).notNull().defaultNow(),
  nSamples: integer("n_samples").notNull(),
  params: jsonb("params").notNull(),
  brierIn: numeric("brier_in", { precision: 10, scale: 6 }),
  brierOut: numeric("brier_out", { precision: 10, scale: 6 }),
  eceOut: numeric("ece_out", { precision: 10, scale: 6 }),
  active: boolean("active").notNull().default(true),
  // Bundle F2.B.H (2026-05-19): Beta-Binomial continuous-update columns.
  // Each settled bet increments alpha (win) or beta (loss); posterior
  // win-rate = alpha / (alpha + beta). Version bumps on each update so
  // pending bets stay pinned to the version active at placement (avoids
  // self-referential feedback — a settled bet's outcome can't retroactively
  // adjust the Kelly fraction on a sibling bet placed at the same time).
  version: integer("version").notNull().default(0),
  posteriorAlpha: numeric("posterior_alpha", { precision: 12, scale: 2 }).notNull().default("1"),
  posteriorBeta: numeric("posterior_beta", { precision: 12, scale: 2 }).notNull().default("1"),
  lastSettledBetId: integer("last_settled_bet_id"),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }),
});

export type CalibrationBucket = typeof calibrationBucketsTable.$inferSelect;
