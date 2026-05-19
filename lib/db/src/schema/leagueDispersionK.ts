import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Bundle F2.B.N (2026-05-19): per-league NegBin dispersion k fit.
//
// Method-of-Moments: k = mean^2 / (variance - mean). Bayesian-shrunk
// toward a global prior (k=2.5 corners, k=2.0 cards) with prior strength
// 20 so leagues with <100 settled matches lean on the global. Used by
// predictTotalCorners / predictTotalCards in lieu of the hardcoded
// CORNERS_K_GLOBAL / CARDS_K_GLOBAL constants.
//
// family ∈ {'corners', 'cards'}. Composite uniqueness on (league, family).
// Refit on demand via POST /api/admin/fit-dispersion-k; cron promotion
// after operator confirms stable cadence.
export const leagueDispersionKTable = pgTable(
  "league_dispersion_k",
  {
    id: serial("id").primaryKey(),
    league: text("league").notNull(),
    family: text("family").notNull(), // 'corners' | 'cards'
    nMatches: integer("n_matches").notNull(),
    mean: numeric("mean", { precision: 8, scale: 3 }),
    variance: numeric("variance", { precision: 10, scale: 3 }),
    kMle: numeric("k_mle", { precision: 8, scale: 3 }),
    kPosterior: numeric("k_posterior", { precision: 8, scale: 3 }).notNull(),
    fitAt: timestamp("fit_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqByLeagueFamily: uniqueIndex("league_dispersion_k_unique").on(
      t.league,
      t.family,
    ),
  }),
);

export const insertLeagueDispersionKSchema = createInsertSchema(
  leagueDispersionKTable,
).omit({ id: true, fitAt: true });
export type InsertLeagueDispersionK = z.infer<typeof insertLeagueDispersionKSchema>;
export type LeagueDispersionK = typeof leagueDispersionKTable.$inferSelect;
