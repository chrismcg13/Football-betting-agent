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

sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]

# Earlier runs landed exitCode=0 / 4 min duration / 0 rows in the DB
# AND a stderrTail showing only the first LOG.info line. The python
# `logging` module is being hijacked downstream — likely by
# seleniumbase / soccerdata reconfiguring handlers at FBref-reader
# init. Sidestep entirely: write diagnostic checkpoints via plain
# `print(..., file=sys.stderr, flush=True)`. Nothing in third-party
# code can redirect sys.stderr writes.
def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} scrape_team_form: {msg}", file=sys.stderr, flush=True)


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


# Phase 2a — FBref leagues. soccerdata's stock FBref reader only ships
# with a limited canonical-key set (the Big 5 men's, INT cups). Wider
# coverage (Championship, lower divisions, women's domestic leagues)
# needs soccerdata's custom-leagues registration — a Phase 2b/c
# follow-up. For now we take what's free out of the box.
FBREF_LEAGUES = [
    "ENG-Premier League",
    "ESP-La Liga",
    "ITA-Serie A",
    "GER-Bundesliga",
    "FRA-Ligue 1",
    # Women's coverage — only INT-Women's World Cup is in the stock
    # FBref allow-list. WSL / NWSL / Frauen-Bundesliga land via FotMob
    # in Phase 2b.
    "INT-Women's World Cup",
]
# Gender mapping for the gender column on team_form_scrape rows.
FBREF_LEAGUE_GENDER = {
    "INT-Women's World Cup": "female",
}


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

    _log(f"Initialising FBref reader for season {season}, {len(FBREF_LEAGUES)} leagues: {FBREF_LEAGUES}")
    fbref = sd.FBref(leagues=FBREF_LEAGUES, seasons=season)
    _log("FBref reader initialised; fetching standard team_season_stats")
    try:
        # standard season-to-date team stats — soccerdata returns a
        # MultiIndex df indexed by (league, season, team).
        df = fbref.read_team_season_stats(stat_type="standard")
    except Exception as e:
        _log(f"FBref standard team_season_stats failed: {type(e).__name__}: {e}", "WARN")
        return pd.DataFrame()

    if df is None or df.empty:
        _log("FBref returned empty DataFrame", "WARN")
        return pd.DataFrame()
    _log(f"FBref returned {len(df)} rows; columns={list(df.columns)[:20]}")
    df = df.reset_index()
    _log(f"After reset_index: columns={list(df.columns)[:20]}")
    return df


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        LOG.error("DATABASE_URL not set"); return 2

    season = os.environ.get("SCRAPE_SEASON") or current_season_code()
    _log(f"Using season={season}")

    snapshot_date = datetime.now(timezone.utc).date()
    df = scrape_fbref_team_stats(season)
    if df.empty:
        _log("Nothing to write — exiting cleanly", "WARN"); return 0

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    inserted = 0
    updated = 0
    skipped_no_league = 0
    skipped_no_team = 0

    # soccerdata column names sometimes vary; we coerce defensively.
    def col(row, *names):
        for n in names:
            if n in row.index and not pd.isna(row[n]):
                return row[n]
        return None

    # Log a sample row's full column dict so the operator can see what
    # FBref actually returned — column names, types, sample values.
    if len(df) > 0:
        sample = df.iloc[0].to_dict()
        _log(f"Sample FBref row keys: {list(sample.keys())[:30]}")
        _log(f"Sample FBref row values (first 10 cols): "
             f"{ {k: str(v)[:40] for k, v in list(sample.items())[:10]} }")

    with conn.cursor() as cur:
        for _, row in df.iterrows():
            league_name = str(col(row, "league") or "")
            team_name = str(col(row, "team") or "")
            if not league_name:
                skipped_no_league += 1
                continue
            if not team_name:
                skipped_no_team += 1
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

            gender = FBREF_LEAGUE_GENDER.get(league_name, "male")
            try:
                cur.execute(
                    """
                    INSERT INTO team_form_scrape
                      (source, league_name, league_country, gender, season,
                       team_name, snapshot_date,
                       matches_played, xg_for, xg_against,
                       goals_for, goals_against, extras)
                    VALUES ('fbref', %s, %s, %s, %s,
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
                        gender,
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
    _log(f"FBref scrape complete: inserted={inserted} updated={updated} "
         f"skipped_no_league={skipped_no_league} skipped_no_team={skipped_no_team} "
         f"snapshot_date={snapshot_date}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
