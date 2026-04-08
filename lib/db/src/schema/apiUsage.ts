import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const apiUsageTable = pgTable("api_usage", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  endpoint: text("endpoint").notNull(),
  requestCount: integer("request_count").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertApiUsageSchema = createInsertSchema(apiUsageTable).omit({
  id: true,
  createdAt: true,
});
export type InsertApiUsage = z.infer<typeof insertApiUsageSchema>;
export type ApiUsage = typeof apiUsageTable.$inferSelect;
