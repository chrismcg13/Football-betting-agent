import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const matchesTable = pgTable("matches", {
  id: serial("id").primaryKey(),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  league: text("league").notNull(),
  country: text("country").notNull(),
  kickoffTime: timestamp("kickoff_time", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("scheduled"),
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  homeScoreHt: integer("home_score_ht"),
  awayScoreHt: integer("away_score_ht"),
  betfairEventId: text("betfair_event_id"),
  apiFixtureId: integer("api_fixture_id"),
  totalCorners: integer("total_corners"),
  totalCards: integer("total_cards"),
  // Bundle F2.B.P (2026-05-19): per-team final corner counts. Populated
  // by apiFootball.fetchMatchStatsForSettlement alongside totalCorners.
  // Required for MATCH_CORNERS_2WAY settlement (home_corners vs
  // away_corners comparison after handicap). NULL on legacy rows.
  homeCornersFull: integer("home_corners_full"),
  awayCornersFull: integer("away_corners_full"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertMatchSchema = createInsertSchema(matchesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMatch = z.infer<typeof insertMatchSchema>;
export type Match = typeof matchesTable.$inferSelect;
