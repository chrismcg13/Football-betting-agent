import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { teamsTable } from "./teams";

// Phase 0 (Women's & Internationals expansion, 2026-05-14).
// Per-source alias map: e.g. {team_id=42 (WSL Arsenal Women), source='betfair',
// alias='Arsenal Ladies'} → canonical team row. Replaces the previous
// runtime fuzzy match (oddsPapi.ts:1055-1116) at scale.
export const teamAliasesTable = pgTable(
  "team_aliases",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teamsTable.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // 'betfair' | 'pinnacle' | 'smarkets' | 'matchbook' | 'fbref' | 'fotmob' | 'api_football'
    alias: text("alias").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("team_aliases_source_alias_uq").on(t.source, t.alias),
  ],
);

export const insertTeamAliasSchema = createInsertSchema(teamAliasesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTeamAlias = z.infer<typeof insertTeamAliasSchema>;
export type TeamAlias = typeof teamAliasesTable.$inferSelect;
