import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const drawdownEventsTable = pgTable("drawdown_events", {
  id: serial("id").primaryKey(),
  environment: text("environment").notNull().default("development"),
  eventType: text("event_type").notNull(),
  highWaterMark: numeric("high_water_mark").notNull(),
  currentBankroll: numeric("current_bankroll").notNull(),
  drawdownPct: numeric("drawdown_pct").notNull(),
  limitPct: numeric("limit_pct").notNull(),
  wouldHaveTriggered: text("would_have_triggered").notNull().default("false"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DrawdownEvent = typeof drawdownEventsTable.$inferSelect;
