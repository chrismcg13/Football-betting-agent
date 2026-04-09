import {
  pgTable,
  serial,
  text,
  real,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const teamXgRollingTable = pgTable("team_xg_rolling", {
  id: serial("id").primaryKey(),
  teamName: text("team_name").notNull(),
  league: text("league").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  xgFor5: real("xg_for_5"),
  xgAgainst5: real("xg_against_5"),
  xgDiff5: real("xg_diff_5"),
  goalsVsXgDiff: real("goals_vs_xg_diff"),
  xgMomentum: real("xg_momentum"),
  matchesCounted: integer("matches_counted"),
});

export const insertTeamXgRollingSchema = createInsertSchema(teamXgRollingTable).omit({ id: true });
export type InsertTeamXgRolling = z.infer<typeof insertTeamXgRollingSchema>;
export type TeamXgRolling = typeof teamXgRollingTable.$inferSelect;
