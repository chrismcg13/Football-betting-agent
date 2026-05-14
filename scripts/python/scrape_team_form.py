#!/usr/bin/env python3
"""
Phase 2a — team-form scraper sidecar.

Pulls season-to-date team statistics from FBref via soccerdata and
upserts one summary row per (source × league × season × team ×
snapshot_date) into team_form_scrape. Run weekly on Tue 05:00 UTC
(scheduler.ts cron) or fired manually via
POST /api/admin/run-team-form-scrape.

Current scope (Phase 2a): FBref men's Big 5 + England Championship.
Subsequent phases will add:
  - Phase 2b: FotMob match-level xG for women's leagues (WSL, NWSL,
    Frauen-Bundesliga, Damallsvenskan, A-League W) — covers gap where
    FBref's free women's coverage is patchy.
  - Phase 2c: Sofascore team form-ratings + SoFIFA squad-strength.
  - Phase 2d: wire features into predictionEngine.FEATURE_NAMES.

Idempotent: UPSERT on the (source, league, season, team, snapshot_date)
unique index. Re-running on the same day overwrites; running fresh on
a different day appends.

Env: DATABASE_URL (inherited from api-server child-process env).
soccerdata caches HTTP responses to ~/.cache/soccerdata so re-runs
within a season are essentially free outside the cache TTL.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Optional

import pandas as pd
import psycopg2

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s scrape_team_form: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
LOG = logging.getLogger("scrape_team_form")

# Season convention: soccerdata uses 'YYZZ' (e.g. '2526' = 2025/26).
# Auto-derive based on European football calendar (Aug-May).
def current_season_code(today: Optional[datetime] = None) -> str:
    today = today or datetime.now(timezone.utc)
    year = today.year
    # Aug-Dec → year/year+1; Jan-Jul → year-1/year
    if today.month >= 8:
        return f"{year % 100:02d}{(year + 1) % 100:02d}"
    return f"{(year - 1) % 100:02d}{year % 100:02d}"


# Phase 2a — FBref men's leagues. soccerdata's `available_leagues()`
# lists the canonical keys; these are the high-Kelly-ROI scopes that
# already trade live on Betfair.
FBREF_MENS_LEAGUES = [
    "ENG-Premier League",
    "ENG-Championship",
    "ESP-La Liga",
    "ITA-Serie A",
    "GER-Bundesliga",
    "FRA-Ligue 1",
]


def _to_int(v) -> Optional[int]:
    if v is None or pd.isna(v):
        return None
    try:
        return int(v)
    except Exception:
        return None


def _to_float(v) -> Optional[float]:
    if v is None or pd.isna(v):
        return None
    try:
        return float(v)
    except Exception:
        return None


def scrape_fbref_team_stats(season: str) -> pd.DataFrame:
    """Return a DataFrame with columns (league, team, MP, xG, xGA, ...)."""
    try:
        import soccerdata as sd
    except ImportError:
        LOG.error("soccerdata not installed — pip install soccerdata>=1.9.0")
        raise

    LOG.info("Initialising FBref reader for season %s, %d leagues", season, len(FBREF_MENS_LEAGUES))
    fbref = sd.FBref(leagues=FBREF_MENS_LEAGUES, seasons=season)
    try:
        # standard season-to-date team stats — soccerdata returns a
        # MultiIndex df indexed by (league, season, team).
        df = fbref.read_team_season_stats(stat_type="standard")
    except Exception as e:
        LOG.warning("FBref standard team_season_stats failed: %s", e)
        return pd.DataFrame()

    if df is None or df.empty:
        LOG.warning("FBref returned empty DataFrame")
        return pd.DataFrame()
    LOG.info("FBref returned %d team-rows", len(df))
    return df.reset_index()


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        LOG.error("DATABASE_URL not set"); return 2

    season = os.environ.get("SCRAPE_SEASON") or current_season_code()
    LOG.info("Using season=%s", season)

    snapshot_date = datetime.now(timezone.utc).date()
    df = scrape_fbref_team_stats(season)
    if df.empty:
        LOG.warning("Nothing to write — exiting cleanly"); return 0

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    inserted = 0
    updated = 0

    # soccerdata column names sometimes vary; we coerce defensively.
    def col(row, *names):
        for n in names:
            if n in row.index and not pd.isna(row[n]):
                return row[n]
        return None

    with conn.cursor() as cur:
        for _, row in df.iterrows():
            league_name = str(col(row, "league") or "")
            team_name = str(col(row, "team") or "")
            if not league_name or not team_name:
                continue
            mp = _to_int(col(row, "MP", "Matches", "matches"))
            xg = _to_float(col(row, "xG", "xG_for", "xg_for"))
            xga = _to_float(col(row, "xGA", "xG_against", "xga"))
            gf = _to_int(col(row, "GF", "Gls", "goals_for"))
            ga = _to_int(col(row, "GA", "goals_against"))

            # Catch additional fields into extras for future feature
            # extraction without schema churn.
            extras = {}
            for k in ("xGD", "xGD/90", "Poss", "Pts", "W", "D", "L", "Att", "Cmp"):
                v = col(row, k)
                if v is not None:
                    if isinstance(v, (pd.Timestamp,)):
                        v = str(v)
                    try:
                        extras[k] = float(v) if isinstance(v, (int, float)) else str(v)
                    except Exception:
                        extras[k] = str(v)

            try:
                cur.execute(
                    """
                    INSERT INTO team_form_scrape
                      (source, league_name, league_country, gender, season,
                       team_name, snapshot_date,
                       matches_played, xg_for, xg_against,
                       goals_for, goals_against, extras)
                    VALUES ('fbref', %s, %s, 'male', %s,
                            %s, %s,
                            %s, %s, %s,
                            %s, %s, %s)
                    ON CONFLICT (source, league_name, season, team_name, snapshot_date)
                    DO UPDATE SET
                      matches_played = EXCLUDED.matches_played,
                      xg_for = EXCLUDED.xg_for,
                      xg_against = EXCLUDED.xg_against,
                      goals_for = EXCLUDED.goals_for,
                      goals_against = EXCLUDED.goals_against,
                      extras = EXCLUDED.extras
                    RETURNING (xmax = 0) AS inserted
                    """,
                    (
                        league_name,
                        league_name.split("-")[0] if "-" in league_name else None,
                        season,
                        team_name,
                        snapshot_date,
                        mp, xg, xga, gf, ga,
                        json.dumps(extras) if extras else None,
                    ),
                )
                was_insert = cur.fetchone()[0]
                if was_insert:
                    inserted += 1
                else:
                    updated += 1
            except Exception as e:
                LOG.warning("Insert failed for (%s, %s): %s", league_name, team_name, e)
                conn.rollback()
                # Re-open transaction for next iteration.
                continue
    conn.commit()
    conn.close()
    LOG.info("FBref scrape complete: inserted=%d updated=%d snapshot_date=%s",
             inserted, updated, snapshot_date)
    return 0


if __name__ == "__main__":
    sys.exit(main())
