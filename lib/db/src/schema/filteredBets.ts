import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
} from "drizzle-orm/pg-core";
import { matchesTable } from "./matches";

export const filteredBetsTable = pgTable("filtered_bets", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id")
    .notNull()
    .references(() => matchesTable.id),
  marketType: text("market_type").notNull(),
  selectionName: text("selection_name").notNull(),
  modelProb: numeric("model_prob", { precision: 8, scale: 6 }).notNull(),
  pinnacleImplied: numeric("pinnacle_implied", { precision: 8, scale: 6 }).notNull(),
  pinnacleOdds: numeric("pinnacle_odds", { precision: 10, scale: 4 }),
  edgePct: numeric("edge_pct", { precision: 8, scale: 4 }).notNull(),
  filterReason: text("filter_reason").notNull(),
  modelOdds: numeric("model_odds", { precision: 10, scale: 4 }),
  marketOdds: numeric("market_odds", { precision: 10, scale: 4 }),
  opportunityScore: numeric("opportunity_score", { precision: 6, scale: 2 }),
  league: text("league"),
  actualOutcome: text("actual_outcome"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type FilteredBet = typeof filteredBetsTable.$inferSelect;
