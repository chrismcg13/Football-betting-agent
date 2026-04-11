import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { matchesTable } from "./matches";

export const oddsHistoryTable = pgTable(
  "odds_history",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => matchesTable.id),
    marketType: text("market_type").notNull(),
    selectionName: text("selection_name").notNull(),
    bookmaker: text("bookmaker").notNull().default("market"),
    odds: numeric("odds", { precision: 10, scale: 4 }).notNull(),
    snapshotTime: timestamp("snapshot_time", { withTimezone: true })
      .notNull()
      .defaultNow(),
    previousOdds: numeric("previous_odds", { precision: 10, scale: 4 }),
    oddsChangePct: numeric("odds_change_pct", { precision: 10, scale: 4 }),
    direction: text("direction"),
    hoursToKickoff: numeric("hours_to_kickoff", { precision: 10, scale: 2 }),
  },
  (t) => [
    index("odds_history_match_idx").on(t.matchId),
    index("odds_history_time_idx").on(t.snapshotTime),
  ],
);

export type OddsHistory = typeof oddsHistoryTable.$inferSelect;
