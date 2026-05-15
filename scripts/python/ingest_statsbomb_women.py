#!/usr/bin/env python3
"""
Phase 3 (pivoted from Phase 2b) — StatsBomb open-data women's match-xG.

soccerdata 1.9 dropped FotMob support entirely. FBref blocks Selenium.
Sofascore needs Selenium and would hit the same Cloudflare wall.
StatsBomb publishes free event-level data for the marquee women's
competitions (NWSL, FAWSL, FIFA Women's World Cup, Women's Euro) as
static JSON on GitHub — no scraper, no auth, no rate-limit risk.

Per-match xG is the sum of shot.statsbomb_xg over all shot events for
each side. Written to xg_match_data with source='statsbomb' alongside
the existing Understat (men's) rows.

Idempotent: skips matches whose statsbomb-prefixed id is already in
xg_match_data. First run downloads ~50-200 MB of event JSON across the
women's-competition catalogue; subsequent runs only fetch new matches.
Per-match event JSON is parsed in-memory and discarded — Neon stores
only the per-match xG summary row (1 row × ~150 bytes ≈ trivial
storage growth).

Network: only requests against raw.githubusercontent.com. No deps
beyond stdlib + psycopg2 + requests.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Any, Optional

import psycopg2
import requests


def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} ingest_statsbomb_women: {msg}", file=sys.stderr, flush=True)


STATSBOMB_BASE = "https://raw.githubusercontent.com/statsbomb/open-data/master/data"
HTTP_TIMEOUT = 30
HTTP_HEADERS = {"User-Agent": "football-betting-agent statsbomb-ingest/1.0"}

# Competitions we want — filtered by gender='female' or known women's
# tournament names. StatsBomb's free open-data covers (as of writing):
#   - NWSL (USA)
#   - FA Women's Super League (England)
#   - FIFA Women's World Cup
#   - UEFA Women's Euro
#   - (some men's competitions too — World Cup, Champions League finals,
#      Messi La Liga career — out of scope for this ingest)
WOMEN_COMPETITION_KEYWORDS = (
    "women",
    "nwsl",
    "fa wsl",
    "wsl",
    "fawsl",
)


def fetch_json(url: str) -> Optional[Any]:
    try:
        resp = requests.get(url, headers=HTTP_HEADERS, timeout=HTTP_TIMEOUT)
    except Exception as e:
        _log(f"HTTP error {url}: {type(e).__name__}: {e}", "WARN")
        return None
    if resp.status_code == 404:
        return None  # expected for missing events
    if resp.status_code != 200:
        _log(f"HTTP {resp.status_code} {url}", "WARN")
        return None
    try:
        return resp.json()
    except Exception as e:
        _log(f"JSON parse error {url}: {e}", "WARN")
        return None


def is_women_competition(comp: dict) -> bool:
    gender = (comp.get("competition_gender") or "").lower()
    if gender == "female":
        return True
    name = (comp.get("competition_name") or "").lower()
    return any(k in name for k in WOMEN_COMPETITION_KEYWORDS)


def already_ingested(cur, match_id: str) -> bool:
    cur.execute(
        "SELECT 1 FROM xg_match_data WHERE id = %s LIMIT 1",
        (match_id,),
    )
    return cur.fetchone() is not None


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        _log("DATABASE_URL not set", "ERROR")
        return 2

    _log("Fetching StatsBomb competitions.json")
    competitions = fetch_json(f"{STATSBOMB_BASE}/competitions.json")
    if not competitions:
        _log("Could not fetch competitions index", "ERROR")
        return 1

    women_comps = [c for c in competitions if is_women_competition(c)]
    _log(f"Found {len(women_comps)} women's (comp, season) entries out of {len(competitions)} total")
    if not women_comps:
        _log("No women's competitions in open-data — exiting", "WARN")
        return 0

    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    inserted = 0
    skipped_already = 0
    skipped_no_events = 0
    skipped_no_xg = 0
    matches_total = 0

    try:
        with conn.cursor() as cur:
            for comp in women_comps:
                comp_id = comp.get("competition_id")
                season_id = comp.get("season_id")
                comp_name = comp.get("competition_name") or "?"
                season_name = comp.get("season_name") or "?"
                if comp_id is None or season_id is None:
                    continue

                matches_url = f"{STATSBOMB_BASE}/matches/{comp_id}/{season_id}.json"
                _log(f"Loading matches: {comp_name} {season_name} ({comp_id}/{season_id})")
                matches = fetch_json(matches_url)
                if not matches:
                    continue

                for m in matches:
                    matches_total += 1
                    raw_id = m.get("match_id")
                    if raw_id is None:
                        continue
                    sb_id = f"statsbomb-{raw_id}"

                    if already_ingested(cur, sb_id):
                        skipped_already += 1
                        continue

                    home = (m.get("home_team") or {}).get("home_team_name") or ""
                    away = (m.get("away_team") or {}).get("away_team_name") or ""
                    home_g = m.get("home_score")
                    away_g = m.get("away_score")
                    match_date = m.get("match_date") or ""

                    # Fetch event-level data and compute per-team xG.
                    events_url = f"{STATSBOMB_BASE}/events/{raw_id}.json"
                    events = fetch_json(events_url)
                    if not events:
                        skipped_no_events += 1
                        continue

                    home_xg = 0.0
                    away_xg = 0.0
                    have_xg = False
                    for e in events:
                        shot = e.get("shot")
                        if not shot:
                            continue
                        xg = shot.get("statsbomb_xg")
                        if xg is None:
                            continue
                        have_xg = True
                        team_name = (e.get("team") or {}).get("name") or ""
                        if team_name == home:
                            home_xg += float(xg)
                        elif team_name == away:
                            away_xg += float(xg)

                    if not have_xg:
                        skipped_no_xg += 1
                        continue

                    cur.execute(
                        """
                        INSERT INTO xg_match_data
                          (id, home_team, away_team, league, season, match_date,
                           home_xg, away_xg, home_goals, away_goals, is_result, source)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'statsbomb')
                        ON CONFLICT (id) DO NOTHING
                        """,
                        (
                            sb_id, home, away, comp_name, season_name, match_date,
                            round(home_xg, 4), round(away_xg, 4),
                            home_g, away_g,
                            home_g is not None and away_g is not None,
                        ),
                    )
                    inserted += 1
                    # Commit every 50 matches so a network drop in the
                    # middle of a long run doesn't lose all progress.
                    if inserted % 50 == 0:
                        conn.commit()
                        _log(f"Committed batch — total inserted so far: {inserted}")
        conn.commit()
    finally:
        conn.close()

    _log(
        f"StatsBomb ingest complete: inserted={inserted} "
        f"skipped_already_ingested={skipped_already} "
        f"skipped_no_events={skipped_no_events} "
        f"skipped_no_xg={skipped_no_xg} matches_seen={matches_total}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
