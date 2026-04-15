import { pgTable, serial, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const exchangesTable = pgTable("exchanges", {
  id: serial("id").primaryKey(),
  exchangeName: text("exchange_name").notNull().unique(),
  displayName: text("display_name").notNull(),
  isActive: boolean("is_active").notNull().default(false),
  apiBaseUrl: text("api_base_url"),
  commissionStructure: jsonb("commission_structure").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertExchangeSchema = createInsertSchema(exchangesTable).omit({ id: true });
export type InsertExchange = z.infer<typeof insertExchangeSchema>;
export type Exchange = typeof exchangesTable.$inferSelect;
