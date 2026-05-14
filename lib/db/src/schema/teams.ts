import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 0 (Women's & Internationals expansion, 2026-05-14).
// Normalised teams catalogue. Pre-Phase-0 the codebase only knew teams as
// free-text columns home_team / away_team on the matches table, with fuzzy
// name matching at runtime — a pattern that scales poorly to ~100 new
// women's clubs and 48 World Cup nationals with names spelled differently
// across each upstream feed. Owned upstream by the seed-from-fixtures
// backfill cron (Phase 0b); fuzzy resolution in oddsPapi.ts collapses to
// an alias-table lookup that fails closed.
export const teamsTable = pgTable(
  "teams",
  {
    id: serial("id").primaryKey(),
    apiFootballTeamId: integer("api_football_team_id").unique(),
    canonicalName: text("canonical_name").notNull(),
    country: text("country"),
    // 'male' | 'female' — separate columns so a club's men's and women's
    // sides are distinct rows (same canonical_name, different gender).
    gender: text("gender").notNull().default("male"),
    isNationalTeam: boolean("is_national_team").notNull().default(false),
    clubeloName: text("clubelo_name"),
    fbrefId: text("fbref_id"),
    fotmobId: text("fotmob_id"),
    fifaCode: text("fifa_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("teams_canonical_gender_uq").on(t.canonicalName, t.gender),
  ],
);

export const insertTeamSchema = createInsertSchema(teamsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type Team = typeof teamsTable.$inferSelect;
