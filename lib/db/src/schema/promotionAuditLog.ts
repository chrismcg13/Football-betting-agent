import {
  pgTable,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const promotionAuditLogTable = pgTable("promotion_audit_log", {
  id: text("id").primaryKey(),
  experimentTag: text("experiment_tag").notNull(),
  previousTier: text("previous_tier").notNull(),
  newTier: text("new_tier").notNull(),
  decisionReason: text("decision_reason").notNull(),
  metricsSnapshot: jsonb("metrics_snapshot"),
  thresholdsUsed: jsonb("thresholds_used"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  decidedBy: text("decided_by").notNull().default("auto_promotion_engine"),
});

export type PromotionAuditLog = typeof promotionAuditLogTable.$inferSelect;
