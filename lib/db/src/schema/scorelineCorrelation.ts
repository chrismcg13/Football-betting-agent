import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 1a (2026-05-14): Dixon-Coles / Sarmanov correlation parameter
// per (league × market_type) scope. Posterior mean from a hierarchical
// Bayesian fit (Phase 1b, numpyro in the calibration sidecar). Read by
// predictionEngine.scorelineMatrix at scoring time. Empty on landing —
// the runtime falls back to rho=0 (independent Poisson, baseline).
//
// Hierarchical shrinkage shape:
//   rho_scope  ~ Normal(group_rho, sigma²)
//   group_rho  ~ Normal(0, 0.1²)         where group = (market_type, gender)
//   sigma      ~ HalfNormal(0.05)
//
// rho_posterior_sd and group_rho stored alongside the point estimate so
// the operator can audit shrinkage strength and detect drift on the
// next weekly fit.
export const scorelineCorrelationTable = pgTable(
  "scoreline_correlation",
  {
    id: serial("id").primaryKey(),
    apiFootballId: integer("api_football_id").notNull(),
    marketType: text("market_type").notNull(),
    // 'dixon_coles' | 'sarmanov' — feature_flag controlled per (mkt, gender)
    // in model_layer_enabled. Default for men's: dixon_coles. Default for
    // women's: sarmanov (Michels et al. 2023 — women's football needs the
    // Sarmanov dependence structure).
    copulaKind: text("copula_kind").notNull(),
    rho: numeric("rho", { precision: 6, scale: 4 }).notNull(),
    rhoPosteriorSd: numeric("rho_posterior_sd", { precision: 6, scale: 4 }).notNull(),
    groupRho: numeric("group_rho", { precision: 6, scale: 4 }).notNull(),
    nMatches: integer("n_matches").notNull(),
    fittedAt: timestamp("fitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("scoreline_correlation_scope_uq").on(t.apiFootballId, t.marketType),
  ],
);

export const insertScorelineCorrelationSchema = createInsertSchema(
  scorelineCorrelationTable,
).omit({ id: true });
export type InsertScorelineCorrelation = z.infer<typeof insertScorelineCorrelationSchema>;
export type ScorelineCorrelation = typeof scorelineCorrelationTable.$inferSelect;
