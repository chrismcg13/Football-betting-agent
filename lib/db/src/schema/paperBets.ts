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

export const paperBetsTable = pgTable("paper_bets", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id")
    .notNull()
    .references(() => matchesTable.id),
  marketType: text("market_type").notNull(),
  selectionName: text("selection_name").notNull(),
  betType: text("bet_type").notNull(),
  oddsAtPlacement: numeric("odds_at_placement", {
    precision: 10,
    scale: 4,
  }).notNull(),
  stake: numeric("stake", { precision: 12, scale: 2 }).notNull(),
  potentialProfit: numeric("potential_profit", { precision: 12, scale: 2 }),
  modelProbability: numeric("model_probability", { precision: 8, scale: 6 }),
  betfairImpliedProbability: numeric("betfair_implied_probability", {
    precision: 8,
    scale: 6,
  }),
  calculatedEdge: numeric("calculated_edge", { precision: 8, scale: 6 }),
  opportunityScore: numeric("opportunity_score", { precision: 6, scale: 2 }),
  modelVersion: text("model_version"),
  oddsSource: text("odds_source").default("synthetic"),
  status: text("status").notNull().default("pending"),
  settlementPnl: numeric("settlement_pnl", { precision: 12, scale: 2 }),
  placedAt: timestamp("placed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
});

export const insertPaperBetSchema = createInsertSchema(paperBetsTable).omit({
  id: true,
  placedAt: true,
});
export type InsertPaperBet = z.infer<typeof insertPaperBetSchema>;
export type PaperBet = typeof paperBetsTable.$inferSelect;
