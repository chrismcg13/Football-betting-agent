import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  date,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 2 (Women's & Internationals expansion, 2026-05-14).
// One row per (source × league × season × team × snapshot_date) snapshot
// of team-level form data scraped from external sources (FBref, FotMob,
// Sofascore — added by Phase 2b/2c). Strictly summary-only — no raw
// event payloads, since Neon storage is a Kelly-growth subtraction
// (see project_kelly_growth_formula). Per-source extras land in the
// jsonb `extras` column to avoid schema churn each time a new field
// shows up on one source but not another.
//
// team_name is the source's spelling, NOT the canonical team. The
// teams + team_aliases tables (Phase 0) handle resolution downstream
// when bets are evaluated. snapshot_date is the wall-clock date the
// scrape captured, NOT the match date — same scope can be scraped
// repeatedly over a season as form evolves.
export const teamFormScrapeTable = pgTable(
  "team_form_scrape",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),       // 'fbref' | 'fotmob' | 'sofascore'
    leagueName: text("league_name").notNull(),    // soccerdata league key, e.g. 'ENG-Premier League'
    leagueCountry: text("league_country"),
    gender: text("gender").notNull().default("male"), // 'male' | 'female'
    season: text("season").notNull(),         // e.g. '2526' (soccerdata convention)
    teamName: text("team_name").notNull(),
    snapshotDate: date("snapshot_date").notNull(),
    matchesPlayed: integer("matches_played"),
    xgFor: numeric("xg_for", { precision: 6, scale: 3 }),
    xgAgainst: numeric("xg_against", { precision: 6, scale: 3 }),
    shotsFor: integer("shots_for"),
    shotsOnTargetFor: integer("shots_on_target_for"),
    goalsFor: integer("goals_for"),
    goalsAgainst: integer("goals_against"),
    extras: jsonb("extras"),    // per-source extras (PPDA, deep completions, sub-ratings, etc.)
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("team_form_scrape_uq").on(
      t.source,
      t.leagueName,
      t.season,
      t.teamName,
      t.snapshotDate,
    ),
  ],
);

export const insertTeamFormScrapeSchema = createInsertSchema(
  teamFormScrapeTable,
).omit({ id: true, createdAt: true });
export type InsertTeamFormScrape = z.infer<typeof insertTeamFormScrapeSchema>;
export type TeamFormScrape = typeof teamFormScrapeTable.$inferSelect;
