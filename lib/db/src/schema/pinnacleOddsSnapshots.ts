import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
} from "drizzle-orm/pg-core";
import { matchesTable } from "./matches";
import { paperBetsTable } from "./paperBets";

export const pinnacleOddsSnapshotsTable = pgTable("pinnacle_odds_snapshots", {
  id: serial("id").primaryKey(),
  betId: integer("bet_id").references(() => paperBetsTable.id),
  matchId: integer("match_id")
    .notNull()
    .references(() => matchesTable.id),
  marketType: text("market_type").notNull(),
  selectionName: text("selection_name").notNull(),
  snapshotType: text("snapshot_type").notNull(),
  pinnacleOdds: numeric("pinnacle_odds", { precision: 10, scale: 4 }).notNull(),
  pinnacleImplied: numeric("pinnacle_implied", { precision: 8, scale: 6 }),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PinnacleOddsSnapshot = typeof pinnacleOddsSnapshotsTable.$inferSelect;
