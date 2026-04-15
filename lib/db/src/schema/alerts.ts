import { pgTable, serial, text, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const alertsTable = pgTable("alerts", {
  id: serial("id").primaryKey(),
  severity: text("severity").notNull(),
  category: text("category").notNull(),
  code: text("code").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata"),
  acknowledged: boolean("acknowledged").notNull().default(false),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  webhookSent: boolean("webhook_sent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const insertAlertSchema = createInsertSchema(alertsTable).omit({ id: true });
export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type Alert = typeof alertsTable.$inferSelect;
