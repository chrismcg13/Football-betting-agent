import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
} from "drizzle-orm/pg-core";
import { matchesTable } from "./matches";

export const liquiditySnapshotsTable = pgTable("liquidity_snapshots", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id")
    .notNull()
    .references(() => matchesTable.id),
  marketType: text("market_type").notNull(),
  selectionName: text("selection_name").notNull(),
  betfairMarketId: text("betfair_market_id"),
  selectionId: integer("selection_id"),
  targetOdds: numeric("target_odds", { precision: 10, scale: 4 }),
  availableAtPrice: numeric("available_at_price", { precision: 12, scale: 2 }),
  availableWithin1Tick: numeric("available_within_1_tick", { precision: 12, scale: 2 }),
  availableWithin3Ticks: numeric("available_within_3_ticks", { precision: 12, scale: 2 }),
  totalMarketVolume: numeric("total_market_volume", { precision: 14, scale: 2 }),
  desiredStake: numeric("desired_stake", { precision: 10, scale: 2 }),
  liquidityShortfall: numeric("liquidity_shortfall", { precision: 10, scale: 2 }),
  depthData: jsonb("depth_data"),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LiquiditySnapshot = typeof liquiditySnapshotsTable.$inferSelect;
