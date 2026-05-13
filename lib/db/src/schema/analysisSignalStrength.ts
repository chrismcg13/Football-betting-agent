import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

export const analysisSignalStrengthTable = pgTable(
  "analysis_signal_strength",
  {
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    league: text("league").notNull(),
    marketType: text("market_type").notNull(),
    betTrack: text("bet_track").notNull(),
    n: integer("n").notNull(),
    winRate: numeric("win_rate"),
    wilsonLo95Winrate: numeric("wilson_lo95_winrate"),
    roi: numeric("roi"),
    shrunkRoi: numeric("shrunk_roi"),
    avgClv: numeric("avg_clv"),
    clvTStat: numeric("clv_t_stat"),
    bootstrapLo95Roi: numeric("bootstrap_lo95_roi"),
    qualifiesLive: boolean("qualifies_live").notNull().default(false),
    qualificationBasis: text("qualification_basis").notNull().default("insufficient"),
  },
  (t) => [
    primaryKey({ columns: [t.computedAt, t.league, t.marketType, t.betTrack] }),
  ],
);

export type AnalysisSignalStrength = typeof analysisSignalStrengthTable.$inferSelect;
