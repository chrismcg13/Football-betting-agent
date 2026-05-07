-- ============================================================================
-- Matches-table fixture-level dedup (one-shot, run on Neon prod)
-- ----------------------------------------------------------------------------
-- Background: matches table accumulated 462 fixture-level duplicates post-May-3
-- because API-Football and Betfair-driven ingestion paths each check existence
-- by their own ID (api_fixture_id / betfair_event_id) but not by the natural
-- fixture key (home_team, away_team, kickoff_time). When AF and Betfair both
-- return the same real fixture, two match rows result. Knock-on effect: the
-- canonical-selection unique index on paper_bets is bypassed (different
-- match_ids count as distinct contexts), so prediction metrics double-count.
--
-- This script:
--   1. Builds a canonical_map: earliest match_id per (home, away, kickoff)
--   2. For each dependent table, reassigns FK references from dupe → canonical,
--      deleting any conflicting rows in tables with uniqueness on match_id
--   3. Deletes the dupe match rows
--   4. Adds UNIQUE constraint on (home_team, away_team, kickoff_time) so this
--      class of bug can't regress
--
-- Idempotent: re-running after the first successful execution is a no-op
-- (canonical_map will be empty, nothing to update or delete).
--
-- Heavy: odds_snapshots has ~2.7M rows to remap. Run during a quiet trading
-- window (low European fixture density). Estimated runtime 5-15 minutes.
--
-- Wrap in a transaction so the unique constraint addition is atomic with the
-- dedup. If anything fails partway, ROLLBACK leaves the system in its
-- previous state.
-- ============================================================================

BEGIN;

-- 1. Canonical map: which dupe match_ids should remap to which canonical
DROP TABLE IF EXISTS _match_canonical_map;
CREATE TEMP TABLE _match_canonical_map AS
SELECT
  m.id AS dupe_match_id,
  FIRST_VALUE(m.id) OVER (
    PARTITION BY m.home_team, m.away_team, m.kickoff_time
    ORDER BY m.id
  ) AS canonical_match_id
FROM matches m;
-- Keep only rows that need remapping
DELETE FROM _match_canonical_map WHERE dupe_match_id = canonical_match_id;
CREATE INDEX ON _match_canonical_map (dupe_match_id);

SELECT COUNT(*) AS dupe_match_id_rows_to_remap FROM _match_canonical_map;

-- 2a. paper_bets: not unique on match_id. Direct UPDATE.
UPDATE paper_bets pb
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE pb.match_id = cm.dupe_match_id;

-- 2b. features: likely unique on (match_id) or (match_id, feature_name).
-- Pre-clean conflicts: if a row exists for canonical AND for dupe, keep canonical.
DELETE FROM features f
WHERE f.match_id IN (SELECT dupe_match_id FROM _match_canonical_map)
  AND EXISTS (
    SELECT 1 FROM features f2
    JOIN _match_canonical_map cm ON cm.canonical_match_id = f2.match_id
    WHERE cm.dupe_match_id = f.match_id
      AND f2.feature_name = f.feature_name
  );
UPDATE features f
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE f.match_id = cm.dupe_match_id;

-- 2c. odds_snapshots: not unique on match_id (multiple snapshots per match).
-- Direct UPDATE — heavy (~2.7M rows).
UPDATE odds_snapshots os
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE os.match_id = cm.dupe_match_id;

-- 2d. odds_history: not unique on match_id.
UPDATE odds_history oh
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE oh.match_id = cm.dupe_match_id;

-- 2e. pinnacle_odds_snapshots: not unique on match_id.
UPDATE pinnacle_odds_snapshots pos
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE pos.match_id = cm.dupe_match_id;

-- 2f. line_movements: not unique on match_id.
UPDATE line_movements lm
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE lm.match_id = cm.dupe_match_id;

-- 2g. liquidity_snapshots: not unique on match_id.
UPDATE liquidity_snapshots ls
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE ls.match_id = cm.dupe_match_id;

-- 2h. filtered_bets: not unique on match_id.
UPDATE filtered_bets fb
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE fb.match_id = cm.dupe_match_id;

-- 2i. injury_reports: not unique on match_id (multiple players per match).
UPDATE injury_reports ir
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE ir.match_id = cm.dupe_match_id;

-- 2j. oddspapi_fixture_map: likely unique on match_id. Pre-clean conflicts.
DELETE FROM oddspapi_fixture_map ofm
WHERE ofm.match_id IN (SELECT dupe_match_id FROM _match_canonical_map)
  AND EXISTS (
    SELECT 1 FROM oddspapi_fixture_map ofm2
    JOIN _match_canonical_map cm ON cm.canonical_match_id = ofm2.match_id
    WHERE cm.dupe_match_id = ofm.match_id
  );
UPDATE oddspapi_fixture_map ofm
SET match_id = cm.canonical_match_id
FROM _match_canonical_map cm
WHERE ofm.match_id = cm.dupe_match_id;

-- 3. Now safe to delete the dupe match rows
DELETE FROM matches m
USING _match_canonical_map cm
WHERE m.id = cm.dupe_match_id;

-- 4. Add the unique constraint that prevents this class of bug from regressing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'matches_unique_fixture_key'
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_unique_fixture_key
      UNIQUE (home_team, away_team, kickoff_time);
  END IF;
END $$;

-- 5. Verify state post-dedup
SELECT
  (SELECT COUNT(*) FROM matches) AS total_matches,
  (SELECT COUNT(*) FROM (
    SELECT 1 FROM matches GROUP BY home_team, away_team, kickoff_time HAVING COUNT(*) > 1
  ) x) AS remaining_fixture_dupes,
  (SELECT 1 FROM pg_constraint WHERE conname = 'matches_unique_fixture_key') AS unique_constraint_present;

COMMIT;
