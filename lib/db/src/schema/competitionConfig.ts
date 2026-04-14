import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const competitionConfigTable = pgTable("competition_config", {
  id: serial("id").primaryKey(),
  apiFootballId: integer("api_football_id").notNull().unique(),
  name: text("name").notNull(),
  country: text("country").notNull().default(""),
  type: text("type").notNull().default("league"),
  gender: text("gender").notNull().default("male"),
  tier: integer("tier").notNull().default(3),
  isActive: boolean("is_active").notNull().default(false),
  hasStatistics: boolean("has_statistics").notNull().default(false),
  hasLineups: boolean("has_lineups").notNull().default(false),
  hasOdds: boolean("has_odds").notNull().default(false),
  hasEvents: boolean("has_events").notNull().default(false),
  hasPinnacleOdds: boolean("has_pinnacle_odds").notNull().default(false),
  seasonalStart: text("seasonal_start"),
  seasonalEnd: text("seasonal_end"),
  currentSeason: integer("current_season"),
  pollingFrequency: text("polling_frequency").notNull().default("dormant"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  totalApiCallsUsed: integer("total_api_calls_used").notNull().default(0),
  fixtureCount: integer("fixture_count").notNull().default(0),
  coverageCheckedAt: timestamp("coverage_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCompetitionConfigSchema = createInsertSchema(competitionConfigTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCompetitionConfig = z.infer<typeof insertCompetitionConfigSchema>;
export type CompetitionConfig = typeof competitionConfigTable.$inferSelect;
