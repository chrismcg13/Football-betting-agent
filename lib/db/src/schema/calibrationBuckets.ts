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
});

export type CalibrationBucket = typeof calibrationBucketsTable.$inferSelect;
