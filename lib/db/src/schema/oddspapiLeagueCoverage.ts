import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const oddspapiLeagueCoverageTable = pgTable("oddspapi_league_coverage", {
  id: serial("id").primaryKey(),
  league: text("league").notNull().unique(),
  hasOdds: integer("has_odds").notNull().default(0),
  lastChecked: timestamp("last_checked", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertOddspapiLeagueCoverageSchema = createInsertSchema(
  oddspapiLeagueCoverageTable,
).omit({ id: true });
export type InsertOddspapiLeagueCoverage = z.infer<
  typeof insertOddspapiLeagueCoverageSchema
>;
export type OddspapiLeagueCoverage =
  typeof oddspapiLeagueCoverageTable.$inferSelect;
