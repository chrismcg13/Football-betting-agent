import {
  pgTable,
  serial,
  timestamp,
  text,
  jsonb,
  numeric,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Wave 2 #1 — autonomous-decision audit log.
 *
 * Every autonomous decision the model makes (market disable, league demote,
 * threshold tighten, feature reweight, etc.) writes a row here. Sub-phase 6
 * code (autonomous threshold management) is the primary writer; downstream
 * autonomous-action paths (sub-phase 5 event-driven graduation, sub-phase 10
 * audit cron) write here too.
 *
 * Per the strategic brief: autonomy with audit, not autonomy without
 * traceability. User reviews this table weekly and can override any decision
 * retrospectively by setting review_status = 'user_overridden'.
 *
 * Schema pinned in docs/phase-2-wave-2-schema-plan.md §2.
 */
export const modelDecisionAuditLogTable = pgTable("model_decision_audit_log", {
  id: serial("id").primaryKey(),
  decisionAt: timestamp("decision_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  decisionType: text("decision_type").notNull(),
  subject: text("subject").notNull(),
  priorState: jsonb("prior_state"),
  newState: jsonb("new_state"),
  reasoning: text("reasoning").notNull(),
  supportingMetrics: jsonb("supporting_metrics"),
  expectedImpact: numeric("expected_impact", { precision: 10, scale: 6 }),
  reviewStatus: text("review_status").notNull().default("automatic"),
});

export const insertModelDecisionAuditLogSchema = createInsertSchema(
  modelDecisionAuditLogTable,
).omit({ id: true });
export type InsertModelDecisionAuditLog = z.infer<
  typeof insertModelDecisionAuditLogSchema
>;
export type ModelDecisionAuditLog =
  typeof modelDecisionAuditLogTable.$inferSelect;
