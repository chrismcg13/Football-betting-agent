import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  timestamp,
  date,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Task 22 — feature attribution (Phase 5c).
 *
 * Monthly job per (feature × market_type) computes:
 *   - n_bets: settled bets in the window with non-null clv_pct AND
 *             non-null feature_value
 *   - pearson_r: Pearson correlation between feature_value and clv_pct
 *   - top_decile_clv_mean: mean clv_pct of bets in the feature's top decile
 *   - bot_decile_clv_mean: mean clv_pct of bets in the feature's bottom decile
 *   - incremental_clv: top_decile_clv_mean − bot_decile_clv_mean
 *                      (positive → the feature is sorting bets in the right
 *                      direction; large absolute value → strong signal)
 *
 * Persisted per period (YYYY-MM via period_start = first-of-month).
 * The reader v_feature_attribution_latest filters to the latest period.
 *
 * Lifecycle: features whose |incremental_clv| < 0.5pp for 3 consecutive
 * months are flagged deprecated_candidate via feature_lifecycle. The
 * deprecation step is operator-driven (manual review of the flag).
 */
export const featureAttributionTable = pgTable(
  "feature_attribution",
  {
    periodStart: date("period_start").notNull(),
    featureName: text("feature_name").notNull(),
    marketType: text("market_type").notNull(),
    nBets: integer("n_bets").notNull(),
    pearsonR: numeric("pearson_r", { precision: 8, scale: 6 }),
    topDecileClvMean: numeric("top_decile_clv_mean", { precision: 8, scale: 4 }),
    botDecileClvMean: numeric("bot_decile_clv_mean", { precision: 8, scale: 4 }),
    incrementalClv: numeric("incremental_clv", { precision: 8, scale: 4 }),
    featureMin: numeric("feature_min", { precision: 12, scale: 6 }),
    featureMax: numeric("feature_max", { precision: 12, scale: 6 }),
    featureMean: numeric("feature_mean", { precision: 12, scale: 6 }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.periodStart, t.featureName, t.marketType] })],
);

export const featureLifecycleTable = pgTable("feature_lifecycle", {
  id: serial("id").primaryKey(),
  featureName: text("feature_name").notNull().unique(),
  status: text("status").notNull(), // 'active' | 'deprecated_candidate' | 'deprecated'
  weakMonthsCount: integer("weak_months_count").notNull().default(0),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
});

export type FeatureAttribution = typeof featureAttributionTable.$inferSelect;
export type FeatureLifecycle = typeof featureLifecycleTable.$inferSelect;
