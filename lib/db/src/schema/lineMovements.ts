import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
} from "drizzle-orm/pg-core";
import { matchesTable } from "./matches";

export const lineMovementsTable = pgTable("line_movements", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id")
    .notNull()
    .references(() => matchesTable.id),
  marketType: text("market_type").notNull(),
  selectionName: text("selection_name").notNull(),
  bookmaker: text("bookmaker").notNull().default("pinnacle"),
  odds: numeric("odds", { precision: 10, scale: 4 }).notNull(),
  impliedProb: numeric("implied_prob", { precision: 8, scale: 6 }),
  previousOdds: numeric("previous_odds", { precision: 10, scale: 4 }),
  movementPct: numeric("movement_pct", { precision: 8, scale: 4 }),
  isSharpMovement: boolean("is_sharp_movement").notNull().default(false),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LineMovement = typeof lineMovementsTable.$inferSelect;
