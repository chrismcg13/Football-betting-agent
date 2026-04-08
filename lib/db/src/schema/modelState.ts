import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const modelStateTable = pgTable("model_state", {
  id: serial("id").primaryKey(),
  modelVersion: text("model_version").notNull(),
  accuracyScore: numeric("accuracy_score", { precision: 8, scale: 6 }),
  calibrationScore: numeric("calibration_score", { precision: 8, scale: 6 }),
  totalBetsTrainedOn: integer("total_bets_trained_on").notNull().default(0),
  featureImportances: jsonb("feature_importances"),
  strategyWeights: jsonb("strategy_weights"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertModelStateSchema = createInsertSchema(modelStateTable).omit({
  id: true,
  createdAt: true,
});
export type InsertModelState = z.infer<typeof insertModelStateSchema>;
export type ModelState = typeof modelStateTable.$inferSelect;
