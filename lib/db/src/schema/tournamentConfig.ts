import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  real,
  jsonb,
} from "drizzle-orm/pg-core";

export const tournamentConfigTable = pgTable("tournament_config", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull(),
  tournamentName: text("tournament_name").notNull(),
  tournamentType: text("tournament_type").notNull().default("international"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(false),
  pollingMultiplier: real("polling_multiplier").notNull().default(1),
  softLineNations: jsonb("soft_line_nations").$type<string[]>().default([]),
  modelAdjustments: jsonb("model_adjustments").$type<Record<string, unknown>>().default({}),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TournamentConfig = typeof tournamentConfigTable.$inferSelect;
