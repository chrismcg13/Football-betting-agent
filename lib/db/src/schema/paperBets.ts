import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  real,
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
  enhancedOpportunityScore: numeric("enhanced_opportunity_score", { precision: 6, scale: 2 }),
  pinnacleOdds: numeric("pinnacle_odds", { precision: 10, scale: 4 }),
  pinnacleImplied: numeric("pinnacle_implied", { precision: 8, scale: 6 }),
  bestOdds: numeric("best_odds", { precision: 10, scale: 4 }),
  bestBookmaker: text("best_bookmaker"),
  betThesis: text("bet_thesis"),
  isContrarian: text("is_contrarian").default("false"),
  closingOddsProxy: numeric("closing_odds_proxy", { precision: 10, scale: 4 }),
  closingPinnacleOdds: numeric("closing_pinnacle_odds", { precision: 10, scale: 4 }),
  clvPct: numeric("clv_pct", { precision: 8, scale: 4 }),
  status: text("status").notNull().default("pending"),
  settlementPnl: numeric("settlement_pnl", { precision: 12, scale: 2 }),
  placedAt: timestamp("placed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  dataTier: text("data_tier").notNull().default("experiment"),
  experimentTag: text("experiment_tag"),
  opportunityBoosted: boolean("opportunity_boosted").notNull().default(false),
  originalOpportunityScore: real("original_opportunity_score"),
  boostedOpportunityScore: real("boosted_opportunity_score"),
  syncEligible: boolean("sync_eligible").notNull().default(false),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  promotionAuditId: text("promotion_audit_id"),
  liveTier: text("live_tier"),
  betfairBetId: text("betfair_bet_id"),
  betfairMarketId: text("betfair_market_id"),
  betfairStatus: text("betfair_status"),
  betfairSizeMatched: numeric("betfair_size_matched", { precision: 12, scale: 2 }),
  betfairAvgPriceMatched: numeric("betfair_avg_price_matched", { precision: 10, scale: 4 }),
  betfairPlacedAt: timestamp("betfair_placed_at", { withTimezone: true }),
  betfairSettledAt: timestamp("betfair_settled_at", { withTimezone: true }),
  betfairPnl: numeric("betfair_pnl", { precision: 12, scale: 2 }),
  pinnacleEdgeCategory: text("pinnacle_edge_category"),
  lineDirection: text("line_direction"),
  pinnacleSnapshotCount: integer("pinnacle_snapshot_count").default(0),
  clvDataQuality: text("clv_data_quality").default("incomplete"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  exchangeId: integer("exchange_id"),
  grossPnl: numeric("gross_pnl", { precision: 12, scale: 2 }),
  commissionRate: numeric("commission_rate", { precision: 6, scale: 4 }),
  commissionAmount: numeric("commission_amount", { precision: 12, scale: 2 }),
  netPnl: numeric("net_pnl", { precision: 12, scale: 2 }),
});

export const insertPaperBetSchema = createInsertSchema(paperBetsTable).omit({
  id: true,
  placedAt: true,
});
export type InsertPaperBet = z.infer<typeof insertPaperBetSchema>;
export type PaperBet = typeof paperBetsTable.$inferSelect;
