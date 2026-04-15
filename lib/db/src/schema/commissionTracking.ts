import { pgTable, serial, text, timestamp, integer, numeric, date } from "drizzle-orm/pg-core";
import { exchangesTable } from "./exchanges";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const commissionTrackingTable = pgTable("commission_tracking", {
  id: serial("id").primaryKey(),
  exchangeId: integer("exchange_id").notNull().references(() => exchangesTable.id),
  periodType: text("period_type").notNull(),
  periodStart: date("period_start").notNull(),
  grossProfit: numeric("gross_profit", { precision: 14, scale: 2 }).notNull().default("0"),
  totalCommission: numeric("total_commission", { precision: 14, scale: 2 }).notNull().default("0"),
  netProfit: numeric("net_profit", { precision: 14, scale: 2 }).notNull().default("0"),
  effectiveRate: numeric("effective_rate", { precision: 6, scale: 4 }),
  betCount: integer("bet_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCommissionTrackingSchema = createInsertSchema(commissionTrackingTable).omit({ id: true });
export type InsertCommissionTracking = z.infer<typeof insertCommissionTrackingSchema>;
export type CommissionTracking = typeof commissionTrackingTable.$inferSelect;
