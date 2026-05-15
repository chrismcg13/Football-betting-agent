#!/usr/bin/env python3
"""
Phase 2f — direct FBref scraper bypassing Cloudflare via cloudscraper.

The earlier soccerdata path hit FBref's Cloudflare protection with a
ConnectionError even on a fully-installed Chrome/Selenium stack. The
fix is HTTP-only: cloudscraper solves Cloudflare's JS challenges from
within a normal `requests`-style client, no browser needed. We then
parse the standard "Squad Standard Stats" table with BeautifulSoup
and write a one-row-per-team season-aggregate snapshot to
team_form_scrape.

Coverage:
  - Men's Big 5 (Premier League, La Liga, Bundesliga, Serie A, Ligue 1)
  - Championship (FBref does cover EFL Championship; soccerdata's
    allow-list didn't but the URL works)
  - Women's WSL (FBref's free women's coverage was patchy at
    soccerdata's API level but the raw HTML page exists)

Writes to team_form_scrape with source='fbref', season auto-derived
from European-football calendar (Aug-Jul). Idempotent on the
(source, league, season, team, snapshot_date) unique index.

requirements.txt adds cloudscraper + beautifulsoup4 + lxml (small,
pure-python deps).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Optional

import psycopg2


def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} scrape_fbref_direct: {msg}", file=sys.stderr, flush=True)


def current_season_str() -> str:
    """FBref URL season format: 'YYYY-YYYY' (e.g. '2024-2025')."""
    today = datetime.now(timezone.utc)
    if today.month >= 8:
        return f"{today.year}-{today.year + 1}"
    return f"{today.year - 1}-{today.year}"


# FBref competition IDs from their own URLs (e.g.
# https://fbref.com/en/comps/9/2024-2025/...). Maintained manually;
# FBref hasn't renumbered these in years.
FBREF_LEAGUES: list[tuple[int, str, str, str]] = [
    # (fbref_comp_id, url_slug_suffix, canonical_name_for_db, gender)
    (9, "Premier-League", "Premier League", "male"),
    (12, "La-Liga", "La Liga", "male"),
    (20, "Bundesliga", "Bundesliga", "male"),
    (11, "Serie-A", "Serie A", "male"),
    (13, "Ligue-1", "Ligue 1", "male"),
    (10, "Championship", "Championship", "male"),
    (189, "Womens-Super-League", "FA WSL", "female"),
    (182, "NWSL", "NWSL", "female"),
]


def _make_scraper():
    try:
        import cloudscraper  # type: ignore
    except ImportError:
        _log("cloudscraper not installed — pip install cloudscraper>=1.2.71", "ERROR")
        raise
    return cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "linux", "mobile": False},
        delay=10,
    )


def _to_float(v) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except Exception:
        return None


def _to_int(v) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except Exception:
        return None


def fetch_team_stats(scraper, comp_id: int, slug: str, season: str) -> list[dict]:
    """Fetch FBref's per-team standard-stats table for a league/season.
    Returns one dict per team with keys we care about. On any error
    returns empty list and logs."""
    from bs4 import BeautifulSoup  # type: ignore

    url = f"https://fbref.com/en/comps/{comp_id}/{season}/{season}-{slug}-Stats"
    _log(f"GET {url}")
    try:
        resp = scraper.get(url, timeout=30)
    except Exception as e:
        _log(f"  fetch error: {type(e).__name__}: {e}", "WARN")
        return []
    if resp.status_code != 200:
        _log(f"  HTTP {resp.status_code} — abandoning league", "WARN")
        return []

    # FBref wraps several tables inside HTML comments to defeat naive
    # scrapers. We strip the wrapper comment around the squad-standard
    # table before bs4 parses it.
    html = resp.text
    html = html.replace("<!--", "").replace("-->", "")
    soup = BeautifulSoup(html, "lxml")

    table = soup.find("table", id="stats_squads_standard_for")
    if table is None:
        _log("  could not find stats_squads_standard_for table — page shape changed?", "WARN")
        return []

    rows: list[dict] = []
    tbody = table.find("tbody")
    if tbody is None:
        return []
    for tr in tbody.find_all("tr"):
        team_cell = tr.find("th", {"data-stat": "team"}) or tr.find("td", {"data-stat": "team"})
        if team_cell is None:
            continue
        team_name = team_cell.get_text(strip=True)
        if not team_name:
            continue

        def cell(stat: str) -> Optional[str]:
            c = tr.find("td", {"data-stat": stat})
            return c.get_text(strip=True) if c is not None else None

        rows.append({
            "team": team_name,
            "mp": cell("games"),
            "goals_for": cell("goals"),
            "xg": cell("xg"),
            "xga": cell("xg_against") or cell("xga"),
            # FBref's "stats_squads_standard_for" table reports the team's own
            # stats only — xGA / GA need a separate "_against" table that
            # we'll fold in when needed. For now collect the for-side basics.
        })
    _log(f"  parsed {len(rows)} team rows")
    return rows


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        _log("DATABASE_URL not set", "ERROR")
        return 2

    season = os.environ.get("SCRAPE_SEASON_URL") or current_season_str()
    snapshot_date = datetime.now(timezone.utc).date()
    _log(f"Using season URL slug: {season}")
    _log(f"Will attempt {len(FBREF_LEAGUES)} FBref leagues")

    scraper = _make_scraper()
    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    inserted = 0
    updated = 0
    per_league: list[str] = []

    try:
        with conn.cursor() as cur:
            for comp_id, slug, canonical, gender in FBREF_LEAGUES:
                rows = fetch_team_stats(scraper, comp_id, slug, season)
                if not rows:
                    per_league.append(f"{canonical}: 0 rows")
                    continue
                league_inserted = 0
                league_updated = 0
                for r in rows:
                    team = r["team"]
                    if not team:
                        continue
                    try:
                        cur.execute(
                            """
                            INSERT INTO team_form_scrape
                              (source, league_name, league_country, gender, season,
                               team_name, snapshot_date,
                               matches_played, xg_for, goals_for, extras)
                            VALUES ('fbref', %s, %s, %s, %s,
                                    %s, %s,
                                    %s, %s, %s, %s)
                            ON CONFLICT (source, league_name, season, team_name, snapshot_date)
                            DO UPDATE SET
                              matches_played = EXCLUDED.matches_played,
                              xg_for = EXCLUDED.xg_for,
                              goals_for = EXCLUDED.goals_for,
                              extras = EXCLUDED.extras
                            RETURNING (xmax = 0) AS inserted
                            """,
                            (
                                canonical,
                                _country_for_league(canonical),
                                gender,
                                season,
                                team,
                                snapshot_date,
                                _to_int(r.get("mp")),
                                _to_float(r.get("xg")),
                                _to_int(r.get("goals_for")),
                                json.dumps({
                                    "xga_for_table": r.get("xga"),
                                }) if r.get("xga") else None,
                            ),
                        )
                        was_insert = cur.fetchone()[0]
                        if was_insert:
                            inserted += 1
                            league_inserted += 1
                        else:
                            updated += 1
                            league_updated += 1
                    except Exception as e:
                        _log(f"  insert error for {team}: {e}", "WARN")
                        conn.rollback()
                        continue
                conn.commit()
                per_league.append(
                    f"{canonical}: inserted={league_inserted} updated={league_updated}"
                )
    finally:
        conn.close()

    _log(f"FBref scrape complete: inserted={inserted} updated={updated}")
    _log(f"Per-league: {per_league}")
    return 0


def _country_for_league(name: str) -> Optional[str]:
    return {
        "Premier League": "England",
        "Championship": "England",
        "La Liga": "Spain",
        "Bundesliga": "Germany",
        "Serie A": "Italy",
        "Ligue 1": "France",
        "FA WSL": "England",
        "NWSL": "USA",
    }.get(name)


if __name__ == "__main__":
    sys.exit(main())
