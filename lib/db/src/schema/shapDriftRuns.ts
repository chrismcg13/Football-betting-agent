import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Task 21 — SHAP-on-residuals drift detection runs.
 *
 * Nightly cron computes SHAP value distributions for the latest N bets
 * per market_type vs a rolling baseline. Per-feature Kolmogorov-Smirnov
 * test flags significant distribution shifts. ≥2 features drifting at
 * p<0.01 → warning; ≥3 → critical + auto-trigger calibration refit.
 */
export const shapDriftRunsTable = pgTable("shap_drift_runs", {
  id: serial("id").primaryKey(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  marketType: text("market_type").notNull(),
  recentN: integer("recent_n").notNull(),
  baselineN: integer("baseline_n").notNull(),
  featuresAnalysed: integer("features_analysed").notNull(),
  featuresDrifted: integer("features_drifted").notNull(),
  driftedFeatures: jsonb("drifted_features"), // [{feature, ks_stat, p_value, mean_shift}]
  ksMaxStat: numeric("ks_max_stat", { precision: 8, scale: 6 }),
  ksMinPvalue: numeric("ks_min_pvalue", { precision: 10, scale: 8 }),
  actionTaken: text("action_taken").notNull(), // 'no_action' | 'alert_warning' | 'alert_critical' | 'recalibration_triggered'
  notes: text("notes"),
});

export type ShapDriftRun = typeof shapDriftRunsTable.$inferSelect;
