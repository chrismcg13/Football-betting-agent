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
HTTP_TIMEOUT = 15
HTTP_HEADERS = {"User-Agent": "football-betting-agent statsbomb-ingest/1.0"}

# Per-run hard cap on matches processed. StatsBomb open-data spans
# ~800 women's matches × ~2-5 MB event JSON each = potentially several
# GB to download. The first attempt hung 20+ min on the VPS before the
# operator killed it. With this cap the run is bounded; the operator
# re-fires the admin endpoint repeatedly until the backlog clears (the
# already_ingested short-circuit means each subsequent run only fetches
# the next 100 unseen matches).
MAX_MATCHES_PER_RUN = int(os.environ.get("STATSBOMB_MAX_MATCHES", "100"))

# Single HTTP session for connection pooling + keep-alive. Without
# this, every fetch_json() opens a fresh TLS handshake — adds ~200ms
# per request on average.
_session = requests.Session()
_session.headers.update(HTTP_HEADERS)

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

# Recency cutoff. Per feedback_ingest_only_predictive_data: historical
# depth >3 yrs for women's football is dead weight — rosters /
# coaches / tactical eras have shifted, the old matches aren't
# predictive of 2026 bets, and inserting them costs Neon storage and
# dilutes any rolling-form / DC-fit aggregation that consumes the
# table. StatsBomb open-data goes back to FAWSL 2018/19 + NWSL 2018 +
# WWC 2019 — all of which fall under this cutoff.
SEASON_CUTOFF_YEAR = int(os.environ.get("STATSBOMB_SEASON_CUTOFF", "2022"))


def _season_start_year(season_name: str) -> Optional[int]:
    """Extract the START year from a StatsBomb season_name string.
    Formats vary: '2023', '2023/2024', '2024/2025'. Returns the first
    4-digit number found, or None if the string doesn't contain one.
    """
    import re
    m = re.search(r"\b(20\d{2})\b", season_name or "")
    return int(m.group(1)) if m else None


def fetch_json(url: str) -> Optional[Any]:
    try:
        resp = _session.get(url, timeout=HTTP_TIMEOUT)
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

    women_comps_all = [c for c in competitions if is_women_competition(c)]
    # Apply recency cutoff at source — per
    # feedback_ingest_only_predictive_data, never let
    # storage-irrelevant historical seasons through.
    women_comps = []
    dropped_old = []
    for c in women_comps_all:
        season_name = c.get("season_name") or ""
        start_year = _season_start_year(season_name)
        if start_year is None:
            # Defensive — keep ambiguous entries and let the operator audit
            women_comps.append(c)
            continue
        if start_year >= SEASON_CUTOFF_YEAR:
            women_comps.append(c)
        else:
            dropped_old.append(f"{c.get('competition_name')} {season_name}")
    _log(f"Found {len(women_comps_all)} women's (comp, season) entries; "
         f"{len(women_comps)} pass season cutoff ≥{SEASON_CUTOFF_YEAR} (dropped {len(dropped_old)} pre-cutoff)")
    if dropped_old:
        _log(f"Dropped pre-cutoff: {dropped_old}")
    if not women_comps:
        _log("No women's competitions pass cutoff — exiting", "WARN")
        return 0

    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    inserted = 0
    skipped_already = 0
    skipped_no_events = 0
    skipped_no_xg = 0
    matches_total = 0
    _log(f"Per-run cap: {MAX_MATCHES_PER_RUN} matches (set STATSBOMB_MAX_MATCHES env to override)")
    started = datetime.now(timezone.utc)

    try:
        with conn.cursor() as cur:
            for comp in women_comps:
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
                    _log(f"  empty matches index — skipping")
                    continue
                _log(f"  matches index has {len(matches)} entries; checking ingest state...")

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
                    home_g = m.get("home_score")
                    away_g = m.get("away_score")
                    match_date = m.get("match_date") or ""

                    # Per-match progress log BEFORE the events fetch so a hang
                    # surfaces the offending match_id immediately.
                    _log(f"  match {raw_id} ({comp_name} {season_name}): "
                         f"{home} vs {away} {home_g}-{away_g} {match_date} — fetching events")

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
                    # Commit every match — at 100 matches per run the
                    # overhead is negligible and a network drop mid-run
                    # never loses more than one match's progress.
                    conn.commit()
                    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
                    _log(f"  match {raw_id} ingested ({inserted}/{MAX_MATCHES_PER_RUN}) — "
                         f"home_xg={home_xg:.2f} away_xg={away_xg:.2f} — elapsed={elapsed:.1f}s")
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
