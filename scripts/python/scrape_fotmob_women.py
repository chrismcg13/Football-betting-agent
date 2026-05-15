#!/usr/bin/env python3
"""
Phase 2b — FotMob women's match-xG scraper.

soccerdata's FotMob reader has the widest free coverage of women's
match-level xG (WSL, NWSL, Frauen-Bundesliga, Liga F, etc. — exactly
the scopes Phase 0 enabled has_betfair_exchange on). Writes to the
existing xg_match_data table with source='fotmob' alongside Understat's
men's rows.

Schedule: Wed 05:00 UTC weekly (one day after the FBref scraper so the
Python crons stagger). Idempotent on the match id (FotMob's stable
numeric match key).

Why this is the women's-coverage workhorse:
  - Understat is men's-only.
  - FBref's free women's allow-list in soccerdata is just
    "INT-Women's World Cup" (Phase 2a already covers it).
  - FotMob is the only free source that has match-level xG for the
    domestic women's leagues that trade on Betfair (the marquee 17
    scopes Phase 0 backfilled has_betfair_exchange=true on).

Each row landed is one match × source. The Phase 2d feature wiring
(predictionEngine.FEATURE_NAMES) reads xg_match_data → team_xg_rolling
(existing rolling-5 aggregator) → home_xg_proxy / away_xg_proxy
features fed into scorelineMatrix as λ. So this script is the
upstream-most lever for women's-scope model accuracy.
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import datetime, timezone
from typing import Optional

import pandas as pd
import psycopg2

# Force unbuffered stderr so per-league diagnostic logs flush to the
# parent (api-server) process line-by-line. First Phase 2b run came
# back with only the first INFO line in stderrTail; the per-league
# rejection summary never made it out. Most likely cause was Python's
# default block-buffered stderr when stderr is a pipe (not a TTY).
sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]


# Same hijack-resistance fix as in scrape_team_form.py — diagnostic
# checkpoints write via plain print(..., file=sys.stderr, flush=True)
# rather than through the logging module, which gets reconfigured
# downstream by soccerdata / seleniumbase and silently drops INFO
# messages off the wrapper's stderrTail.
def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} scrape_fotmob_women: {msg}", file=sys.stderr, flush=True)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s scrape_fotmob_women: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
LOG = logging.getLogger("scrape_fotmob_women")


def current_season_code(today: Optional[datetime] = None) -> str:
    today = today or datetime.now(timezone.utc)
    year = today.year
    if today.month >= 8:
        return f"{year % 100:02d}{(year + 1) % 100:02d}"
    return f"{(year - 1) % 100:02d}{year % 100:02d}"


# Candidate FotMob women's leagues. soccerdata's exact key list isn't
# stable across versions — these are the high-Kelly-ROI scopes we WANT
# to cover. Each is tried independently so one rejected key doesn't
# kill the rest. On first failure, soccerdata logs the valid keys and
# we can update this list.
FOTMOB_WOMEN_LEAGUE_CANDIDATES = [
    "ENG-Women Super League",
    "ENG-FA Women's Super League",
    "USA-NWSL",
    "USA-National Women's Soccer League",
    "GER-Frauen Bundesliga",
    "GER-Frauen-Bundesliga",
    "ESP-Liga F",
    "ESP-Primera División Femenina",
    "FRA-Division 1 Féminine",
    "ITA-Serie A Women",
    "SWE-Damallsvenskan",
    "NOR-Toppserien",
    "DEN-Kvindeligaen",
    "AUS-A-League Women",
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


def scrape_fotmob_schedules(season: str) -> pd.DataFrame:
    """Try each candidate league individually. Returns combined DataFrame."""
    try:
        import soccerdata as sd
    except ImportError:
        LOG.error("soccerdata not installed — pip install soccerdata>=1.9.0")
        raise

    # Probe soccerdata's actual FotMob allow-list so we can intersect
    # our candidate list against it and skip the per-league exception
    # path entirely. The candidate list above is best-guess based on
    # naming patterns — soccerdata's catalogue is the truth.
    try:
        all_fotmob_leagues = sd.FotMob().available_leagues()
        _log(f"FotMob exposes {len(all_fotmob_leagues)} total leagues in soccerdata catalogue")
    except Exception as e:
        _log(f"Could not enumerate FotMob.available_leagues(): {type(e).__name__}: {e}", "WARN")
        all_fotmob_leagues = []

    # Print the women's-relevant subset so the operator can see exactly
    # what FotMob ships under in this soccerdata version.
    women_keys = [k for k in all_fotmob_leagues if any(
        w in k.lower() for w in ("women", "wsl", "nwsl", "frauen", "femin", "liga f",
                                  "damallsvenskan", "toppserien", "kvinde")
    )]
    _log(f"FotMob women's-relevant keys ({len(women_keys)}): {women_keys}")

    # Match our candidates against the catalogue (case-insensitive substring)
    candidates_to_try: list[str] = []
    for c in FOTMOB_WOMEN_LEAGUE_CANDIDATES:
        if c in all_fotmob_leagues:
            candidates_to_try.append(c)
    # Plus any catalogue women's keys we didn't predict.
    for k in women_keys:
        if k not in candidates_to_try:
            candidates_to_try.append(k)
    _log(f"Will attempt {len(candidates_to_try)} FotMob leagues this run: {candidates_to_try}")

    frames: list[pd.DataFrame] = []
    accepted: list[str] = []
    rejected: list[tuple[str, str]] = []

    for league in candidates_to_try:
        _log(f"FotMob: attempting {league} ...")
        try:
            fotmob = sd.FotMob(leagues=league, seasons=season)
            sched = fotmob.read_schedule()
            if sched is None or sched.empty:
                _log(f"FotMob {league}: empty schedule (off-season or no data)")
                continue
            df = sched.reset_index()
            df["fotmob_league_key"] = league
            frames.append(df)
            accepted.append(league)
            _log(f"FotMob {league}: {len(df)} matches")
        except ValueError as e:
            msg = str(e).split("\n")[0][:200]
            _log(f"FotMob {league}: ValueError {msg}", "WARN")
            rejected.append((league, msg))
        except Exception as e:
            msg = f"{type(e).__name__}: {str(e)[:200]}"
            _log(f"FotMob {league}: {msg}", "WARN")
            rejected.append((league, msg))

    _log(f"FotMob summary: accepted={len(accepted)} rejected={len(rejected)}")
    if accepted:
        _log(f"Accepted leagues: {accepted}")
    if rejected:
        for lg, err in rejected[:10]:
            _log(f"  rejected[{lg}] = {err}")
    if not frames:
        _log("FotMob: 0 leagues returned data", "WARN")
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        LOG.error("DATABASE_URL not set"); return 2

    season = os.environ.get("SCRAPE_SEASON") or current_season_code()
    _log(f"Using season={season}")

    df = scrape_fotmob_schedules(season)
    if df.empty:
        _log("Nothing to write — exiting cleanly", "WARN"); return 0

    _log(f"FotMob total rows across leagues: {len(df)}")

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    inserted = 0
    updated = 0
    skipped_no_xg = 0

    def col(row, *names):
        for n in names:
            if n in row.index and not pd.isna(row[n]):
                return row[n]
        return None

    with conn.cursor() as cur:
        for _, row in df.iterrows():
            match_id_raw = col(row, "match_id", "game_id", "id")
            if match_id_raw is None:
                continue
            match_id = f"fotmob-{match_id_raw}"
            league = str(col(row, "fotmob_league_key", "league") or "")
            home = str(col(row, "home_team", "home") or "")
            away = str(col(row, "away_team", "away") or "")
            if not home or not away:
                continue

            home_xg = _to_float(col(row, "home_xg", "homeXg", "home_xG"))
            away_xg = _to_float(col(row, "away_xg", "awayXg", "away_xG"))
            home_g = _to_int(col(row, "home_score", "home_goals", "homeScore"))
            away_g = _to_int(col(row, "away_score", "away_goals", "awayScore"))
            match_date_raw = col(row, "date", "match_date", "kickoff")
            match_date = str(match_date_raw)[:10] if match_date_raw is not None else ""
            is_result = home_g is not None and away_g is not None

            # No xG, no value — Phase 2b is fundamentally about the xG
            # signal. Skip rows where FotMob hasn't computed xG yet
            # (typically: live + future fixtures, or low-coverage
            # competitions where FotMob's xG model didn't fire).
            if home_xg is None or away_xg is None:
                skipped_no_xg += 1
                continue

            try:
                cur.execute(
                    """
                    INSERT INTO xg_match_data
                      (id, home_team, away_team, league, season, match_date,
                       home_xg, away_xg, home_goals, away_goals, is_result, source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'fotmob')
                    ON CONFLICT (id) DO UPDATE SET
                      home_xg = EXCLUDED.home_xg,
                      away_xg = EXCLUDED.away_xg,
                      home_goals = EXCLUDED.home_goals,
                      away_goals = EXCLUDED.away_goals,
                      is_result = EXCLUDED.is_result
                    RETURNING (xmax = 0) AS inserted
                    """,
                    (
                        match_id, home, away, league, season, match_date,
                        home_xg, away_xg, home_g, away_g, is_result,
                    ),
                )
                if cur.fetchone()[0]:
                    inserted += 1
                else:
                    updated += 1
            except Exception as e:
                LOG.warning("Insert failed for %s: %s", match_id, e)
                conn.rollback()
                continue
    conn.commit()
    conn.close()
    _log(f"FotMob scrape complete: inserted={inserted} updated={updated} "
         f"skipped_no_xg={skipped_no_xg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
