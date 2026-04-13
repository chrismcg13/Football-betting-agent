import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { matchesTable } from "./matches";

export const oddspapiFixtureMapTable = pgTable("oddspapi_fixture_map", {
  id: serial("id").primaryKey(),
  matchId: integer("match_id")
    .notNull()
    .references(() => matchesTable.id),
  oddspapiFixtureId: text("oddspapi_fixture_id").notNull(),
  cachedAt: timestamp("cached_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  unique("oddspapi_fixture_map_match_id_unique").on(t.matchId),
]);

export const insertOddspapiFixtureMapSchema = createInsertSchema(
  oddspapiFixtureMapTable,
).omit({ id: true });
export type InsertOddspapiFixtureMap = z.infer<
  typeof insertOddspapiFixtureMapSchema
>;
export type OddspapiFixtureMap =
  typeof oddspapiFixtureMapTable.$inferSelect;
