import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  numeric,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const competitionConfigTable = pgTable("competition_config", {
  id: serial("id").primaryKey(),
  // Phase 2.A: api_football_id is now nullable to support Tier-D rows
  // (Betfair-only competitions with no AF mapping). The unique constraint
  // is preserved (NULLs are not unique-violating in Postgres). A separate
  // partial unique index on betfair_competition_id WHERE api_football_id
  // IS NULL enforces uniqueness for those Tier-D rows.
  apiFootballId: integer("api_football_id").unique(),
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
  // ── Phase 2.A: universe-tier classification ────────────────────────────
  // universe_tier ∈ {A,B,C,D,E,unmapped}. Replaces the Pinnacle-only gate
  // with explicit production / experiment / training-only classification.
  // 'unmapped' is the default until the Betfair-first reverse-mapping cron
  // assigns a tier. CHECK constraint enforced at DB level via migrate.ts.
  universeTier: text("universe_tier").notNull().default("unmapped"),
  archetype: text("archetype"),
  betfairCompetitionId: text("betfair_competition_id"),
  warmupStartedAt: timestamp("warmup_started_at", { withTimezone: true }),
  warmupCompletedAt: timestamp("warmup_completed_at", { withTimezone: true }),
  universeTierDecidedAt: timestamp("universe_tier_decided_at", { withTimezone: true }),
  settlementBiasIndex: numeric("settlement_bias_index", { precision: 6, scale: 4 }),
});

export const insertCompetitionConfigSchema = createInsertSchema(competitionConfigTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCompetitionConfig = z.infer<typeof insertCompetitionConfigSchema>;
export type CompetitionConfig = typeof competitionConfigTable.$inferSelect;
