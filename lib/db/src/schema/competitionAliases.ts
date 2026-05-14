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
import { competitionConfigTable } from "./competitionConfig";

// Phase 0 (Women's & Internationals expansion, 2026-05-14).
// Hand-curated map from a feed-side competition name (Betfair / Pinnacle /
// Smarkets / Matchbook etc.) onto an API-Football league id. Used as a
// fail-closed lookup BEFORE the betfairFirstUniverse fuzzy match — needed
// because Betfair often names women's competitions differently from
// API-Football (e.g. "FA Women's Super League" vs "WSL", "Frauen-Bundesliga"
// vs "Bundesliga Frauen") and the fuzzy threshold either misses the match
// or false-positives onto the men's league of the same name.
export const competitionAliasesTable = pgTable(
  "competition_aliases",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(), // 'betfair' | 'pinnacle' | 'smarkets' | 'matchbook'
    alias: text("alias").notNull(),    // the feed-side competition name
    apiFootballId: integer("api_football_id")
      .notNull()
      .references(() => competitionConfigTable.apiFootballId),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("competition_aliases_source_alias_uq").on(t.source, t.alias),
  ],
);

export const insertCompetitionAliasSchema = createInsertSchema(
  competitionAliasesTable,
).omit({ id: true, createdAt: true });
export type InsertCompetitionAlias = z.infer<typeof insertCompetitionAliasSchema>;
export type CompetitionAlias = typeof competitionAliasesTable.$inferSelect;
