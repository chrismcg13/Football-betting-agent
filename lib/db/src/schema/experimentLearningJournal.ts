import {
  pgTable,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const experimentLearningJournalTable = pgTable("experiment_learning_journal", {
  id: text("id").primaryKey(),
  analysisDate: timestamp("analysis_date", { withTimezone: true }).notNull().defaultNow(),
  experimentTag: text("experiment_tag"),
  analysisType: text("analysis_type").notNull(),
  findings: jsonb("findings"),
  recommendations: jsonb("recommendations"),
  actionsTaken: jsonb("actions_taken"),
});

export type ExperimentLearningJournal = typeof experimentLearningJournalTable.$inferSelect;
