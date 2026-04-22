import {
  pgTable,
  pgView,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  real,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  // ── Pricing-pipeline fix: actionable vs fair-value separation ─────────
  // actionable_* = price actually placed on, sourced from Betfair Exchange only.
  // fair_value_* = sharp-consensus reference used for CLV-style edge calc.
  // odds_at_placement / odds_source above are kept as backwards-compatible
  // mirrors of actionable_price / actionable_source for new rows.
  // validator_best_odds = diagnostic only — captured but NOT used for placement.
  actionablePrice: numeric("actionable_price", { precision: 10, scale: 4 }),
  actionableSource: text("actionable_source"),
  fairValueOdds: numeric("fair_value_odds", { precision: 10, scale: 4 }),
  fairValueSource: text("fair_value_source"),
  validatorBestOdds: numeric("validator_best_odds", { precision: 10, scale: 4 }),
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
  qualificationPath: text("qualification_path"),
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
  // ── C1: Betfair exchange snapshot capture ──────────────────────────────
  // Captured at placement time from listMarketCatalogue + listMarketBook
  // (delayed app key). Used post-hoc to compute (a) cross-spread realism
  // for our backed price vs the market's best lay, and (b) queue position
  // vs the prevailing best back. Null if capture failed (no event id, no
  // catalogue, no market, no selection, or upstream API error). Never
  // blocks placement.
  betfairBestBack: numeric("betfair_best_back", { precision: 10, scale: 4 }),
  betfairBestBackSize: numeric("betfair_best_back_size", { precision: 12, scale: 2 }),
  betfairBestLay: numeric("betfair_best_lay", { precision: 10, scale: 4 }),
  betfairBestLaySize: numeric("betfair_best_lay_size", { precision: 12, scale: 2 }),
  exchangeFetchAt: timestamp("exchange_fetch_at", { withTimezone: true }),
  betfairSelectionId: numeric("betfair_selection_id", { precision: 20, scale: 0 }),
  grossPnl: numeric("gross_pnl", { precision: 12, scale: 2 }),
  commissionRate: numeric("commission_rate", { precision: 6, scale: 4 }),
  commissionAmount: numeric("commission_amount", { precision: 12, scale: 2 }),
  netPnl: numeric("net_pnl", { precision: 12, scale: 2 }),
  selectionCanonical: text("selection_canonical"),
  settlementAttempts: integer("settlement_attempts").notNull().default(0),
  lastSettlementAttemptAt: timestamp("last_settlement_attempt_at", { withTimezone: true }),
  // ── Legacy regime tag (Change C, 2026-04-22) ──────────────────────────
  // Bets placed before the Prompt-5 pricing-pipeline cutover are flagged
  // legacy_regime=true. Dashboard / metric / experiment endpoints read from
  // the paper_bets_current view (legacy_regime=false). Settlement, audit,
  // reconciliation, and risk paths read directly from this table.
  legacyRegime: boolean("legacy_regime").notNull().default(false),
}, (table) => ({
  uniquePendingBet: uniqueIndex("paper_bets_unique_pending_canonical_idx")
    .on(table.matchId, table.marketType, table.selectionCanonical)
    .where(
      sql`status IN ('pending','pending_placement') AND deleted_at IS NULL AND selection_canonical IS NOT NULL AND placed_at >= '2026-04-19T20:00:00Z'`,
    ),
}));

export const insertPaperBetSchema = createInsertSchema(paperBetsTable).omit({
  id: true,
  placedAt: true,
});
export type InsertPaperBet = z.infer<typeof insertPaperBetSchema>;
export type PaperBet = typeof paperBetsTable.$inferSelect;

// ── paper_bets_current view (Change C, 2026-04-22) ───────────────────────
// Read-only view: SELECT * FROM paper_bets WHERE legacy_regime = false.
// The view itself is created via raw SQL in lib/migrate.ts (DROP VIEW +
// CREATE VIEW after every paper_bets ALTER). `.existing()` here tells
// Drizzle the view exists in the database and not to emit DDL for it.
// Column shape mirrors paperBetsTable so query results have identical types.
// All writes (INSERT/UPDATE/DELETE) MUST go through paperBetsTable directly.
export const paperBetsCurrentView = pgView("paper_bets_current", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id").notNull(),
  marketType: text("market_type").notNull(),
  selectionName: text("selection_name").notNull(),
  betType: text("bet_type").notNull(),
  oddsAtPlacement: numeric("odds_at_placement", { precision: 10, scale: 4 }).notNull(),
  stake: numeric("stake", { precision: 12, scale: 2 }).notNull(),
  potentialProfit: numeric("potential_profit", { precision: 12, scale: 2 }),
  modelProbability: numeric("model_probability", { precision: 8, scale: 6 }),
  betfairImpliedProbability: numeric("betfair_implied_probability", { precision: 8, scale: 6 }),
  calculatedEdge: numeric("calculated_edge", { precision: 8, scale: 6 }),
  opportunityScore: numeric("opportunity_score", { precision: 6, scale: 2 }),
  modelVersion: text("model_version"),
  oddsSource: text("odds_source"),
  actionablePrice: numeric("actionable_price", { precision: 10, scale: 4 }),
  actionableSource: text("actionable_source"),
  fairValueOdds: numeric("fair_value_odds", { precision: 10, scale: 4 }),
  fairValueSource: text("fair_value_source"),
  validatorBestOdds: numeric("validator_best_odds", { precision: 10, scale: 4 }),
  enhancedOpportunityScore: numeric("enhanced_opportunity_score", { precision: 6, scale: 2 }),
  pinnacleOdds: numeric("pinnacle_odds", { precision: 10, scale: 4 }),
  pinnacleImplied: numeric("pinnacle_implied", { precision: 8, scale: 6 }),
  bestOdds: numeric("best_odds", { precision: 10, scale: 4 }),
  bestBookmaker: text("best_bookmaker"),
  betThesis: text("bet_thesis"),
  isContrarian: text("is_contrarian"),
  closingOddsProxy: numeric("closing_odds_proxy", { precision: 10, scale: 4 }),
  closingPinnacleOdds: numeric("closing_pinnacle_odds", { precision: 10, scale: 4 }),
  clvPct: numeric("clv_pct", { precision: 8, scale: 4 }),
  status: text("status").notNull(),
  settlementPnl: numeric("settlement_pnl", { precision: 12, scale: 2 }),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  dataTier: text("data_tier").notNull(),
  experimentTag: text("experiment_tag"),
  opportunityBoosted: boolean("opportunity_boosted").notNull(),
  originalOpportunityScore: real("original_opportunity_score"),
  boostedOpportunityScore: real("boosted_opportunity_score"),
  syncEligible: boolean("sync_eligible").notNull(),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  promotionAuditId: text("promotion_audit_id"),
  liveTier: text("live_tier"),
  qualificationPath: text("qualification_path"),
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
  pinnacleSnapshotCount: integer("pinnacle_snapshot_count"),
  clvDataQuality: text("clv_data_quality"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  exchangeId: integer("exchange_id"),
  betfairBestBack: numeric("betfair_best_back", { precision: 10, scale: 4 }),
  betfairBestBackSize: numeric("betfair_best_back_size", { precision: 12, scale: 2 }),
  betfairBestLay: numeric("betfair_best_lay", { precision: 10, scale: 4 }),
  betfairBestLaySize: numeric("betfair_best_lay_size", { precision: 12, scale: 2 }),
  exchangeFetchAt: timestamp("exchange_fetch_at", { withTimezone: true }),
  betfairSelectionId: numeric("betfair_selection_id", { precision: 20, scale: 0 }),
  grossPnl: numeric("gross_pnl", { precision: 12, scale: 2 }),
  commissionRate: numeric("commission_rate", { precision: 6, scale: 4 }),
  commissionAmount: numeric("commission_amount", { precision: 12, scale: 2 }),
  netPnl: numeric("net_pnl", { precision: 12, scale: 2 }),
  selectionCanonical: text("selection_canonical"),
  settlementAttempts: integer("settlement_attempts").notNull(),
  lastSettlementAttemptAt: timestamp("last_settlement_attempt_at", { withTimezone: true }),
  legacyRegime: boolean("legacy_regime").notNull(),
}).existing();
