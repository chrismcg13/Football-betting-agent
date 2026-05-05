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
 * Wave 2 #1 — pending threshold revisions queue.
 *
 * The strategic brief mandates: tighter thresholds are autonomous (model
 * proposes + applies, logged to model_decision_audit_log); LOOSER thresholds
 * are user-approval-gated. Looser proposals queue here for human review.
 *
 * Sub-phase 6 (autonomous threshold management) is the primary writer.
 * Sub-phase 6 also implements the auto-expire cron that flips status to
 * 'expired' on stale 'pending' rows.
 *
 * Schema pinned in docs/phase-2-wave-2-schema-plan.md §3.
 */
export const pendingThresholdRevisionsTable = pgTable(
  "pending_threshold_revisions",
  {
    id: serial("id").primaryKey(),
    proposedAt: timestamp("proposed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    thresholdName: text("threshold_name").notNull(),
    scope: text("scope").notNull().default("global"),
    currentValue: jsonb("current_value").notNull(),
    proposedValue: jsonb("proposed_value").notNull(),
    direction: text("direction").notNull(),
    reasoning: text("reasoning").notNull(),
    supportingMetrics: jsonb("supporting_metrics"),
    expectedImpact: numeric("expected_impact", { precision: 10, scale: 6 }),
    status: text("status").notNull().default("pending"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
  },
);

export const insertPendingThresholdRevisionsSchema = createInsertSchema(
  pendingThresholdRevisionsTable,
).omit({ id: true });
export type InsertPendingThresholdRevision = z.infer<
  typeof insertPendingThresholdRevisionsSchema
>;
export type PendingThresholdRevision =
  typeof pendingThresholdRevisionsTable.$inferSelect;
