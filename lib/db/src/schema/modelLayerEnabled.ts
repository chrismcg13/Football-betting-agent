import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  numeric,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 1a (2026-05-14): per-(market_type, gender, layer) on/off decision
// for model layers (dixon_coles, sarmanov, future layers). Owned by the
// Phase 1c backtest cron — it replays the last N months of bets with the
// layer on vs off and writes one row per (market_type, gender) cell with
// the log-loss-better verdict. The runtime consults this table before
// applying a layer; absence of a row defaults to enabled=false (safe).
//
// Per feedback_per_group_fallback_decisions: never collapse to a global
// y/n. DC might help men's AH but hurt women's OU 1.5 — each cell decides
// independently.
export const modelLayerEnabledTable = pgTable(
  "model_layer_enabled",
  {
    id: serial("id").primaryKey(),
    marketType: text("market_type").notNull(),
    gender: text("gender").notNull(), // 'male' | 'female'
    layer: text("layer").notNull(),    // 'dixon_coles' | 'sarmanov' | future
    enabled: boolean("enabled").notNull(),
    // Backtest provenance — log-loss before/after the layer was applied
    // on the cell's historical bets. Null pre-Phase-1c.
    logLossBaseline: numeric("log_loss_baseline", { precision: 8, scale: 6 }),
    logLossWithLayer: numeric("log_loss_with_layer", { precision: 8, scale: 6 }),
    nBacktestBets: integer("n_backtest_bets"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("model_layer_enabled_scope_uq").on(t.marketType, t.gender, t.layer),
  ],
);

export const insertModelLayerEnabledSchema = createInsertSchema(
  modelLayerEnabledTable,
).omit({ id: true, decidedAt: true });
export type InsertModelLayerEnabled = z.infer<typeof insertModelLayerEnabledSchema>;
export type ModelLayerEnabled = typeof modelLayerEnabledTable.$inferSelect;
