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

export const discoveredLeaguesTable = pgTable("discovered_leagues", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().unique(),
  name: text("name").notNull(),
  country: text("country").notNull().default(""),
  tier: text("tier").notNull().default("unknown"),
  fixtureCount: integer("fixture_count").notNull().default(0),
  hasApiFootballOdds: boolean("has_api_football_odds").notNull().default(false),
  hasPinnacleOdds: boolean("has_pinnacle_odds").notNull().default(false),
  seedEdgeScore: integer("seed_edge_score").notNull().default(75),
  betsPlaced: integer("bets_placed").notNull().default(0),
  status: text("status").notNull().default("monitoring"),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  lastChecked: timestamp("last_checked", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  discoveryNotes: text("discovery_notes"),
});

export const insertDiscoveredLeagueSchema = createInsertSchema(discoveredLeaguesTable).omit({
  id: true,
  firstSeen: true,
  lastChecked: true,
});
export type InsertDiscoveredLeague = z.infer<typeof insertDiscoveredLeagueSchema>;
export type DiscoveredLeague = typeof discoveredLeaguesTable.$inferSelect;
