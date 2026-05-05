import {
  pgTable,
  text,
  timestamp,
  integer,
  real,
} from "drizzle-orm/pg-core";

export const experimentRegistryTable = pgTable("experiment_registry", {
  id: text("id").primaryKey(),
  experimentTag: text("experiment_tag").notNull(),
  leagueCode: text("league_code"),
  marketType: text("market_type"),
  dataTier: text("data_tier").notNull().default("experiment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  tierChangedAt: timestamp("tier_changed_at", { withTimezone: true }).notNull().defaultNow(),
  currentSampleSize: integer("current_sample_size").notNull().default(0),
  currentRoi: real("current_roi"),
  currentClv: real("current_clv"),
  currentWinRate: real("current_win_rate"),
  currentPValue: real("current_p_value"),
  currentEdge: real("current_edge"),
  consecutiveNegativeWeeks: integer("consecutive_negative_weeks").notNull().default(0),
  notes: text("notes"),
  // ── Phase 2.A extensions ─────────────────────────────────────────────
  // Per-archetype calibration substrate (v3 work activates threshold
  // overrides keyed on archetype; v2 just records the label).
  archetype: text("archetype"),
  // CLV provenance — gates the minClv threshold by source. Pinnacle-source
  // CLV uses the existing 1.5pp threshold; market_proxy and none drop the
  // CLV requirement entirely. Backfilled by Migration 5 from heuristic.
  clvSource: text("clv_source").notNull().default("none"),
  warmupCompletedAt: timestamp("warmup_completed_at", { withTimezone: true }),
  // Probationary-Kelly fraction — read by placePaperBet when sizing.
  // Defaults to 1.0 for promoted, 0.25 for candidate (set by promotion
  // engine on tier change). Future ratchet steps (e.g. 0.5×) live here.
  kellyFraction: real("kelly_fraction").notNull().default(1.0),
  lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
  // Cooldown / readmission tracking for permanently-demoted experiments.
  abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
  cooldownEligibleAt: timestamp("cooldown_eligible_at", { withTimezone: true }),
  modelVersionAtAbandon: text("model_version_at_abandon"),
  // Edge-survival comparison anchors for candidate→promoted gate.
  experimentPhaseRoi: real("experiment_phase_roi"),
  candidatePhaseRoi: real("candidate_phase_roi"),
});

export type ExperimentRegistry = typeof experimentRegistryTable.$inferSelect;
