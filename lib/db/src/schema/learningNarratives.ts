import { pgTable, serial, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const learningNarrativesTable = pgTable("learning_narratives", {
  id: serial("id").primaryKey(),
  narrativeType: text("narrative_type").notNull(),
  narrativeText: text("narrative_text").notNull(),
  relatedData: jsonb("related_data"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertLearningNarrativeSchema = createInsertSchema(
  learningNarrativesTable,
).omit({ id: true, createdAt: true });
export type InsertLearningNarrative = z.infer<
  typeof insertLearningNarrativeSchema
>;
export type LearningNarrative = typeof learningNarrativesTable.$inferSelect;
