import {
  pgTable,
  text,
  integer,
  numeric,
  date,
  smallint,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Task 15 — daily ClubElo snapshots.
 *
 * Source: api.clubelo.com — free public CSV API. ~3,300 clubs across 55
 * countries, 5 tiers, back to 1955. We fetch one row per club per day
 * via the all-clubs date endpoint and upsert here.
 *
 * `team_name` is the canonical ClubElo name (e.g. "ManCity"). Joining to
 * our matches.home_team / away_team requires a fuzzy / synonym mapping
 * pass — that's Phase 4a.2 (feature-engine integration).
 *
 * Volume estimate: ~3,300 rows/day. Daily retention indefinite (small
 * footprint; allows historical regressions). At ~150 bytes/row that's
 * ~150 MB/year — comfortable.
 */
export const clubEloSnapshotsTable = pgTable(
  "club_elo_snapshots",
  {
    date: date("date").notNull(),
    teamName: text("team_name").notNull(),
    country: text("country"),
    level: smallint("level"), // 1 = top tier; nullable for retired/transitional rows
    elo: numeric("elo", { precision: 8, scale: 3 }).notNull(),
    rank: integer("rank"),
    fromDate: date("from_date"), // ClubElo's "from" — date the rating was first set
    toDate: date("to_date"),     // ClubElo's "to"   — when it changes next
  },
  (t) => [primaryKey({ columns: [t.date, t.teamName] })],
);

export type ClubEloSnapshot = typeof clubEloSnapshotsTable.$inferSelect;
