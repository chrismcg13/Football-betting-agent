import {
  pgTable,
  text,
  real,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const xgMatchDataTable = pgTable("xg_match_data", {
  id: text("id").primaryKey(),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  league: text("league").notNull(),
  season: text("season").notNull(),
  matchDate: text("match_date").notNull(),
  homeXg: real("home_xg"),
  awayXg: real("away_xg"),
  homeGoals: integer("home_goals"),
  awayGoals: integer("away_goals"),
  isResult: boolean("is_result").default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const insertXgMatchDataSchema = createInsertSchema(xgMatchDataTable).omit({ createdAt: true });
export type InsertXgMatchData = z.infer<typeof insertXgMatchDataSchema>;
export type XgMatchData = typeof xgMatchDataTable.$inferSelect;
