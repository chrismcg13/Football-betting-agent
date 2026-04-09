import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const leagueEdgeScoresTable = pgTable(
  "league_edge_scores",
  {
    id: serial("id").primaryKey(),
    league: text("league").notNull(),
    marketType: text("market_type").notNull().default("ALL"),
    totalBets: integer("total_bets").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    roiPct: real("roi_pct").notNull().default(0),
    avgClv: real("avg_clv").notNull().default(0),
    avgEdge: real("avg_edge").notNull().default(0),
    confidenceScore: real("confidence_score").notNull().default(50),
    isSeedData: integer("is_seed_data").notNull().default(1),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("league_market_unique").on(t.league, t.marketType)],
);

export const insertLeagueEdgeScoreSchema = createInsertSchema(
  leagueEdgeScoresTable,
).omit({ id: true });
export type InsertLeagueEdgeScore = z.infer<typeof insertLeagueEdgeScoreSchema>;
export type LeagueEdgeScore = typeof leagueEdgeScoresTable.$inferSelect;
