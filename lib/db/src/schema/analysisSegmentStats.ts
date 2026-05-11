import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

export const analysisSegmentStatsTable = pgTable(
  "analysis_segment_stats",
  {
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    league: text("league").notNull(),
    marketType: text("market_type").notNull(),
    betTrack: text("bet_track").notNull(),
    n: integer("n").notNull(),
    w: integer("w").notNull(),
    stake: numeric("stake").notNull(),
    pnl: numeric("pnl").notNull(),
    avgClv: numeric("avg_clv"),
    sdClv: numeric("sd_clv"),
    clvN: integer("clv_n").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.computedAt, t.league, t.marketType, t.betTrack] }),
  ],
);

export type AnalysisSegmentStat = typeof analysisSegmentStatsTable.$inferSelect;
