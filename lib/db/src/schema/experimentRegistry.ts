import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
} from "drizzle-orm/pg-core";

export const experimentRegistryTable = pgTable("experiment_registry", {
  id: text("id").primaryKey(),
  experimentTag: text("experiment_tag").notNull(),
  leagueCode: text("league_code"),
  marketType: text("market_type"),
  dataTier: text("data_tier").notNull().default("experiment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  tierChangedAt: timestamp("tier_changed_at", { withTimezone: true }).notNull().defaultNow(),
  currentSampleSize: integer("current_sample_size").notNull().default(0),
  currentRoi: real("current_roi"),
  currentClv: real("current_clv"),
  currentWinRate: real("current_win_rate"),
  currentPValue: real("current_p_value"),
  currentEdge: real("current_edge"),
  consecutiveNegativeWeeks: integer("consecutive_negative_weeks").notNull().default(0),
  notes: text("notes"),
});

export type ExperimentRegistry = typeof experimentRegistryTable.$inferSelect;
