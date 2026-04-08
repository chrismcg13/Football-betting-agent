import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { matchesTable } from "./matches";

export const featuresTable = pgTable("features", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id")
    .notNull()
    .references(() => matchesTable.id),
  featureName: text("feature_name").notNull(),
  featureValue: numeric("feature_value", { precision: 15, scale: 6 }),
  computedAt: timestamp("computed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertFeatureSchema = createInsertSchema(featuresTable).omit({
  id: true,
});
export type InsertFeature = z.infer<typeof insertFeatureSchema>;
export type Feature = typeof featuresTable.$inferSelect;
