import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Task 17 — Monte-Carlo lookup table for drawdown-targeted Kelly fractions.
 *
 * One row per simulation run. Each run computes realised (ROI, stdev)
 * from the last N settled bets, then Monte-Carlo simulates 10,000
 * 90-day forward paths per kelly_fraction ∈ {0.05, 0.10, ..., 1.0}
 * and picks the highest fraction whose 1st-percentile drawdown ≤
 * target_p1_pct.
 *
 * Reader: services/dynamicKelly.ts.getDynamicKellyFraction() reads
 * the latest row. If absent (cron hasn't run yet) returns null and
 * the caller falls back to its default fraction with a compliance log.
 */
export const kellyFractionLookupTable = pgTable("kelly_fraction_lookup", {
  id: serial("id").primaryKey(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  realisedRoi: numeric("realised_roi", { precision: 10, scale: 6 }).notNull(),
  realisedStdev: numeric("realised_stdev", { precision: 10, scale: 6 }).notNull(),
  sampleN: integer("sample_n").notNull(),
  targetP1Pct: numeric("target_p1_pct", { precision: 6, scale: 3 }).notNull(),
  selectedFraction: numeric("selected_fraction", { precision: 5, scale: 4 }).notNull(),
  // Full fraction → p1-drawdown curve for audit / inspection
  curve: jsonb("curve").notNull(),
  paths: integer("paths").notNull(),
  betsPerPath: integer("bets_per_path").notNull(),
});

export type KellyFractionLookup = typeof kellyFractionLookupTable.$inferSelect;
