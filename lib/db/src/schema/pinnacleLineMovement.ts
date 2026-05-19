import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { matchesTable } from "./matches";

// Bundle F2.B.B (2026-05-19): Pinnacle line-movement velocity tracker.
//
// We snapshot Pinnacle continuously but never compute Δprice/Δt. That
// blinds us to sharp-money signal — Pinnacle converging on our side after
// placement is a CLV-positive signal we should follow; Pinnacle walking
// away is edge erosion we should respect (demote, cancel pending promote).
//
// One row per (match, market, selection, window_seconds, window_end).
// window_end is rounded to the nearest cron tick so back-to-back runs
// hit the same UPSERT key and don't duplicate.
//
// is_stable: max_abs_delta_pp < 0.3pp AND n_snapshots >= TTK-bucket floor.
// Stable windows near kickoff supply the early_clv_estimate column on
// paper_bets (Bundle B.2). NEVER used for settlement-grade CLV — that
// stays clv_pct anchored to the actual closing snapshot.
//
// direction encodes sign of velocity (rising/falling/stable). The lazy
// promoter joins on this and interprets "rising/falling" relative to
// the bet's back-side to classify converging_with_us vs walking_away.
export const pinnacleLineMovementTable = pgTable(
  "pinnacle_line_movement",
  {
    id: serial("id").primaryKey(),
    matchId: integer("match_id")
      .notNull()
      .references(() => matchesTable.id),
    marketType: text("market_type").notNull(),
    selectionName: text("selection_name").notNull(),
    // Window length in seconds — varies with TTK bucket. <30m TTK uses 300s,
    // 30-60m uses 600s, 1-4h uses 1800s, 4h+ uses 3600s.
    windowSeconds: integer("window_seconds").notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    nSnapshots: integer("n_snapshots").notNull(),
    // Signed change in implied probability per hour. Positive = implied prob
    // rising over the window (Pinnacle thinks the selection is more likely).
    velocityImpliedPpPerHour: numeric("velocity_implied_pp_per_hour", {
      precision: 8,
      scale: 3,
    }),
    // Max single-step jump in implied prob within the window (pp). Used by
    // the stability gate alongside n_snapshots.
    maxAbsDeltaPp: numeric("max_abs_delta_pp", { precision: 8, scale: 3 }),
    // Age in seconds of the newest snapshot at compute time. Lets the
    // consumer reject classifications computed against stale tails.
    lastSnapshotAgeS: integer("last_snapshot_age_s"),
    // 'rising' (velocity > +0.5 pp/hr) | 'falling' (< -0.5) | 'stable'.
    direction: text("direction"),
    // TRUE when stable AND n_snapshots clears the TTK bucket floor.
    // Bundle B.2 reads this to pin early_clv_estimate.
    isStable: boolean("is_stable").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqByWindow: uniqueIndex("pinn_lm_unique").on(
      t.matchId,
      t.marketType,
      t.selectionName,
      t.windowSeconds,
      t.windowEnd,
    ),
  }),
);

export const insertPinnacleLineMovementSchema = createInsertSchema(
  pinnacleLineMovementTable,
).omit({ id: true, computedAt: true });
export type InsertPinnacleLineMovement = z.infer<
  typeof insertPinnacleLineMovementSchema
>;
export type PinnacleLineMovement = typeof pinnacleLineMovementTable.$inferSelect;
