#!/usr/bin/env python3
"""
Phase 3b — StatsBomb open-data men's match-xG ingest.

Mirror of ingest_statsbomb_women.py but filtered to men's
competitions. StatsBomb's free open-data men's coverage:

  - FIFA World Cup 2022 (64 matches, full event xG)
  - UEFA Euro 2020 (51 matches)
  - UEFA Euro 2024 (51 matches)
  - UEFA Champions League finals (every year)
  - 2003/04 Arsenal Invincibles
  - Messi La Liga career
  - Some men's national team friendlies

Most relevant for our model:
  - WC 2022 + Euro 2024: directly inform pricing for upcoming
    FIFA World Cup 2026 (June, ~5 weeks away). All 48 WC 2026
    qualified national teams have at least one prior tournament
    in StatsBomb's WC 2022 or Euro 2024 corpus.
  - CL finals: marginal Kelly value but free data is free data —
    captures top European club xG.

Same recency cutoff (season >= 2022) as the women's ingest per
feedback_ingest_only_predictive_data. Per-run cap, per-match
progress logging, ON CONFLICT idempotent UPSERT.

Network: only requests against raw.githubusercontent.com. No deps
beyond stdlib + psycopg2 + requests.
"""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Optional

import psycopg2
import requests


def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} ingest_statsbomb_mens: {msg}", file=sys.stderr, flush=True)


STATSBOMB_BASE = "https://raw.githubusercontent.com/statsbomb/open-data/master/data"
HTTP_TIMEOUT = 15
HTTP_HEADERS = {"User-Agent": "football-betting-agent statsbomb-mens-ingest/1.0"}

MAX_MATCHES_PER_RUN = int(os.environ.get("STATSBOMB_MAX_MATCHES", "100"))
SEASON_CUTOFF_YEAR = int(os.environ.get("STATSBOMB_SEASON_CUTOFF", "2022"))

# Competition-keyword skip-list for women's (we have the dedicated
# women's ingest for those — don't double-write here).
WOMEN_KEYWORDS = (
    "women",
    "nwsl",
    "fa wsl",
    "wsl",
    "fawsl",
    "féminin",
)


def _session_factory():
    s = requests.Session()
    s.headers.update(HTTP_HEADERS)
    return s


_session = _session_factory()


def fetch_json(url: str) -> Optional[Any]:
    try:
        resp = _session.get(url, timeout=HTTP_TIMEOUT)
    except Exception as e:
        _log(f"HTTP error {url}: {type(e).__name__}: {e}", "WARN")
        return None
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        _log(f"HTTP {resp.status_code} {url}", "WARN")
        return None
    try:
        return resp.json()
    except Exception as e:
        _log(f"JSON parse error {url}: {e}", "WARN")
        return None


def is_mens_competition(comp: dict) -> bool:
    """Inverse filter from the women's ingest: anything that is NOT
    flagged female gender AND doesn't have a women's keyword in the
    name. StatsBomb's catalogue tags competition_gender as 'male' or
    'female' (mostly accurate)."""
    gender = (comp.get("competition_gender") or "").lower()
    if gender == "female":
        return False
    name = (comp.get("competition_name") or "").lower()
    if any(k in name for k in WOMEN_KEYWORDS):
        return False
    return True


def _season_start_year(season_name: str) -> Optional[int]:
    m = re.search(r"\b(20\d{2})\b", season_name or "")
    return int(m.group(1)) if m else None


def already_ingested(cur, match_id: str) -> bool:
    cur.execute("SELECT 1 FROM xg_match_data WHERE id = %s LIMIT 1", (match_id,))
    return cur.fetchone() is not None


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        _log("DATABASE_URL not set", "ERROR")
        return 2

    competitions = fetch_json(f"{STATSBOMB_BASE}/competitions.json")
    if not competitions:
        _log("Could not fetch competitions index", "ERROR")
        return 1

    mens_all = [c for c in competitions if is_mens_competition(c)]
    mens_in_cutoff = []
    dropped_old = []
    for c in mens_all:
        season_name = c.get("season_name") or ""
        sy = _season_start_year(season_name)
        if sy is None:
            mens_in_cutoff.append(c)
        elif sy >= SEASON_CUTOFF_YEAR:
            mens_in_cutoff.append(c)
        else:
            dropped_old.append(f"{c.get('competition_name')} {season_name}")
    _log(f"Found {len(mens_all)} men's (comp, season) entries; "
         f"{len(mens_in_cutoff)} pass season cutoff ≥{SEASON_CUTOFF_YEAR}; "
         f"dropped {len(dropped_old)}")
    if dropped_old:
        _log(f"Dropped pre-cutoff: {dropped_old[:10]}...")
    if not mens_in_cutoff:
        _log("No in-cutoff men's competitions — exiting", "WARN")
        return 0
    _log(f"In-cutoff men's competitions: "
         f"{[(c.get('competition_name'), c.get('season_name')) for c in mens_in_cutoff[:20]]}")
    _log(f"Per-run cap: {MAX_MATCHES_PER_RUN} matches")

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    inserted = 0
    skipped_already = 0
    skipped_no_events = 0
    skipped_no_xg = 0
    matches_total = 0
    started = datetime.now(timezone.utc)

    try:
        with conn.cursor() as cur:
            for comp in mens_in_cutoff:
                if inserted >= MAX_MATCHES_PER_RUN:
                    _log(f"Reached MAX_MATCHES_PER_RUN={MAX_MATCHES_PER_RUN} — re-fire to continue")
                    break
                comp_id = comp.get("competition_id")
                season_id = comp.get("season_id")
                comp_name = comp.get("competition_name") or "?"
                season_name = comp.get("season_name") or "?"
                if comp_id is None or season_id is None:
                    continue

                matches_url = f"{STATSBOMB_BASE}/matches/{comp_id}/{season_id}.json"
                _log(f"Loading matches index: {comp_name} {season_name} ({comp_id}/{season_id})")
                matches = fetch_json(matches_url)
                if not matches:
                    continue
                _log(f"  matches index has {len(matches)} entries")

                for m in matches:
                    if inserted >= MAX_MATCHES_PER_RUN:
                        break
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
                    if not home or not away:
                        continue
                    home_g = m.get("home_score")
                    away_g = m.get("away_score")
                    match_date = m.get("match_date") or ""

                    _log(f"  match {raw_id} ({comp_name} {season_name}): "
                         f"{home} vs {away} {home_g}-{away_g} {match_date} — fetching events")
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
                    conn.commit()
                    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
                    _log(f"  match {raw_id} ingested ({inserted}/{MAX_MATCHES_PER_RUN}) — "
                         f"home_xg={home_xg:.2f} away_xg={away_xg:.2f} — elapsed={elapsed:.1f}s")
    finally:
        conn.close()

    _log(f"StatsBomb men's ingest complete: inserted={inserted} "
         f"skipped_already_ingested={skipped_already} "
         f"skipped_no_events={skipped_no_events} "
         f"skipped_no_xg={skipped_no_xg} matches_seen={matches_total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
