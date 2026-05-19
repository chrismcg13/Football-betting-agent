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

// Bundle F2.B.F (2026-05-19): per-league half-time goal fraction.
//
// Empirical posterior of (ht_goals / ft_goals) per league, Bayesian-
// shrunk toward global 0.45 with prior strength k=100 — global prior
// dominates until ~100 matches; per-league signal takes over above that.
// Used by predictHalfTimeMatchOdds + predictSecondHalfMatchOdds to
// split full-match xGoals into HT and SH lambdas.
//
// Refit via admin endpoint POST /api/admin/fit-half-fractions or
// automatically on a future scheduled cron. Rolling 12-month window
// captures rule-change drift; season carry-forward deferred (matches
// table has no season_id column).
//
// Per-league spread observed in source data ranges 0.385–0.477 across
// the top leagues — meaningful 9pp envelope around the hardcoded 0.45
// that the existing predictHalfTimeFullTime uses, so per-league signal
// is non-trivial for the HT/SH separately-priced markets.
export const leagueHalfFractionsTable = pgTable(
  "league_half_fractions",
  {
    id: serial("id").primaryKey(),
    league: text("league").notNull(),
    nMatches: integer("n_matches").notNull(),
    htFractionMle: numeric("ht_fraction_mle", { precision: 6, scale: 4 }),
    htFractionPosterior: numeric("ht_fraction_posterior", {
      precision: 6,
      scale: 4,
    }).notNull(),
    fitAt: timestamp("fit_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqByLeague: uniqueIndex("league_half_fractions_unique").on(t.league),
  }),
);

export const insertLeagueHalfFractionsSchema = createInsertSchema(
  leagueHalfFractionsTable,
).omit({ id: true, fitAt: true });
export type InsertLeagueHalfFractions = z.infer<
  typeof insertLeagueHalfFractionsSchema
>;
export type LeagueHalfFractions = typeof leagueHalfFractionsTable.$inferSelect;
