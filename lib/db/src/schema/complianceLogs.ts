import { pgTable, serial, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const complianceLogsTable = pgTable("compliance_logs", {
  id: serial("id").primaryKey(),
  actionType: text("action_type").notNull(),
  details: jsonb("details").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const insertComplianceLogSchema = createInsertSchema(
  complianceLogsTable,
).omit({ id: true });
export type InsertComplianceLog = z.infer<typeof insertComplianceLogSchema>;
export type ComplianceLog = typeof complianceLogsTable.$inferSelect;
