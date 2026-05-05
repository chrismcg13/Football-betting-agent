import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { paperBetsTable } from "./paperBets";

// ── Phase 2.A: graduation evaluation log ─────────────────────────────────
// Records every threshold evaluation performed by the graduation engine —
// both event-driven (on settlement) and cron-driven (the existing 04:00
// reconciler). Distinct from promotion_audit_log: this captures EVERY
// evaluation including the 99% that produce no tier change. Useful for:
//   - retrospectively understanding why a tag did/didn't promote
//   - spotting threshold-edge cases that need calibration
//   - confirming event-driven evaluator runs aren't being missed
//
// trigger_bet_id is nullable so cron-driven evaluations can record without
// linking to a specific settlement.
//
// threshold_outcome ∈ {'promote','demote','hold','warmup','insufficient_data'}
//   - promote: tag advanced (experiment→candidate, candidate→promoted)
//   - demote:  tag regressed (candidate→experiment, promoted→candidate)
//   - hold:    no change; thresholds checked, no transition condition met
//   - warmup:  tag still inside warmup window; thresholds skipped
//   - insufficient_data: not enough samples to even evaluate
export const graduationEvaluationLogTable = pgTable(
  "graduation_evaluation_log",
  {
    id: text("id").primaryKey(),
    experimentTag: text("experiment_tag").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    triggerBetId: integer("trigger_bet_id").references(() => paperBetsTable.id),
    metricsSnapshot: jsonb("metrics_snapshot").notNull(),
    thresholdOutcome: text("threshold_outcome").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tagEvaluatedIdx: index("gel_tag_evaluated_idx").on(
      table.experimentTag,
      table.evaluatedAt,
    ),
  }),
);

export type GraduationEvaluationLog =
  typeof graduationEvaluationLogTable.$inferSelect;
