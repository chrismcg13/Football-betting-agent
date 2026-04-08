import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { matchesTable } from "./matches";

export const oddsSnapshotsTable = pgTable("odds_snapshots", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id")
    .notNull()
    .references(() => matchesTable.id),
  marketType: text("market_type").notNull(),
  selectionName: text("selection_name").notNull(),
  backOdds: numeric("back_odds", { precision: 10, scale: 4 }),
  layOdds: numeric("lay_odds", { precision: 10, scale: 4 }),
  snapshotTime: timestamp("snapshot_time", { withTimezone: true })
    .notNull()
    .defaultNow(),
  source: text("source").notNull().default("betfair_delayed"),
});

export const insertOddsSnapshotSchema = createInsertSchema(
  oddsSnapshotsTable,
).omit({ id: true });
export type InsertOddsSnapshot = z.infer<typeof insertOddsSnapshotSchema>;
export type OddsSnapshot = typeof oddsSnapshotsTable.$inferSelect;
