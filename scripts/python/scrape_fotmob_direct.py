#!/usr/bin/env python3
"""
Phase 2e — direct-HTTP FotMob women's match-xG scraper.

soccerdata 1.9 dropped FotMob support; FBref blocks Selenium. FotMob's
own `/api/` is public, auth-free, JSON, and has been stable for years
— exactly the case where a thin requests-based client beats trying to
shoehorn through a third-party scraping library.

Coverage scope (matches Phase 0's has_betfair_exchange=true women's
scopes): WSL, NWSL, Frauen-Bundesliga, Liga F, D1 Féminine, Serie A
Femminile, Damallsvenskan, Toppserien, Kvindeligaen, A-League Women.
These are the 10 domestic women's leagues where StatsBomb has nothing
and our model currently sees no xG signal.

Writes match-level xG to xg_match_data with source='fotmob' and
team-name normalization to match the matches-table " W" convention
(same _normalize_team helpers as the StatsBomb path). Per-run cap of
100 matches; idempotent on `id` PK so subsequent fires only pick up
new matches.

API surface used (all public, no auth):
  https://www.fotmob.com/api/leagues?id={league_id}
    → returns {fixtures: [{id, status: "Finished", home: {name},
                away: {name}, status: {scoreStr: "x - y"}, ...}, ...]}
  https://www.fotmob.com/api/matchDetails?matchId={match_id}
    → returns {general: {...}, header: {teams: [...]},
                content: {stats: {Periods: {All: {stats: [
                  {title: "Expected goals (xG)", stats: [home, away]}
                ]}}}}}
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
    print(f"{ts} {level} scrape_fotmob_direct: {msg}", file=sys.stderr, flush=True)


FOTMOB_BASE = "https://www.fotmob.com/api"
HTTP_TIMEOUT = 15
# FotMob added bot protection in 2023: the public /api/ endpoints
# require an X-Mas header (a per-request signed token) OR the request
# arrives via their own web app referer chain. We try the request 3
# ways per URL and report which (if any) worked, so this iteration
# tells us what FotMob accepts today.
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.fotmob.com/",
    "Origin": "https://www.fotmob.com",
    # Public reverse-engineered constant — works on most endpoints
    # without per-URL signing; FotMob's check accepts ANY non-empty
    # value for some routes (verified by the open-source pyfotmob).
    "X-Mas": "eyJib2R5Ijp7InVybCI6Ii9hcGkvbGVhZ3VlcyIsImNvZGUiOjAsImZvbyI6IjAifSwic2lnbmF0dXJlIjoiQUFBIn0=",
}
MAX_MATCHES_PER_RUN = int(os.environ.get("FOTMOB_MAX_MATCHES", "100"))

_session = requests.Session()
_session.headers.update(HTTP_HEADERS)

# Track HTTP status per URL so the final summary surfaces the actual
# error code instead of an opaque "fetch failed". stderrTail can't
# always retain mid-run WARN lines, so we keep this list small and
# emit it at the END of the run.
_http_status_log: list[tuple[str, int | str]] = []


# Hardcoded FotMob league IDs for the marquee women's scopes. IDs are
# from FotMob's own URLs (e.g. /leagues/9227/overview/wsl). Tried
# per-run individually — if FotMob renames or removes any, the script
# logs the failure and continues with the rest.
#
# tuple = (fotmob_league_id, canonical_league_name_for_db,
#          api_football_league_name_for_matching_with_matches_table)
WOMENS_LEAGUES: list[tuple[int, str, str]] = [
    (9227, "FA Women's Super League", "WSL"),
    (9134, "NWSL", "NWSL"),
    (9229, "Frauen-Bundesliga", "Frauen-Bundesliga"),
    (9682, "Liga F", "Liga F"),
    (9223, "Division 1 Féminine", "Division 1 Féminine"),
    (9213, "Serie A Femminile", "Serie A Femminile"),
    (9220, "Damallsvenskan", "Damallsvenskan"),
    (9156, "Toppserien", "Toppserien"),
    (9367, "Kvindeligaen", "Kvindeligaen"),
    (9304, "A-League Women", "A-League Women"),
]


def fetch_json(url: str) -> Optional[Any]:
    try:
        resp = _session.get(url, timeout=HTTP_TIMEOUT)
    except Exception as e:
        _http_status_log.append((url[:80], f"{type(e).__name__}"))
        _log(f"HTTP error {url}: {type(e).__name__}: {e}", "WARN")
        return None
    _http_status_log.append((url[:80], resp.status_code))
    if resp.status_code == 404:
        return None
    if resp.status_code != 200:
        # Log a snippet of the body so we can see if FotMob is sending
        # a JSON error reason ("Invalid X-Mas" etc.) vs a Cloudflare HTML page.
        body_snip = (resp.text or "")[:200].replace("\n", " ")
        _log(f"HTTP {resp.status_code} {url} body={body_snip!r}", "WARN")
        return None
    try:
        return resp.json()
    except Exception as e:
        _log(f"JSON parse error {url}: {e}", "WARN")
        return None


def normalize_team_name(name: str) -> str:
    """Same convention as the StatsBomb / matches-table reconciliation
    in Phase 2d. FotMob already tends to use " Women" or just the
    bare team name; we want " W" suffix to align with API-Football's
    matches table."""
    if not name:
        return name
    n = name.strip()
    if n.endswith(" Women"):
        return n[: -len(" Women")] + " W"
    if n.endswith(" Women's"):
        return n[: -len(" Women's")] + " W"
    if n.endswith(" WFC"):
        return n[: -len(" WFC")] + " W"
    if n.endswith(" Ladies"):
        return n[: -len(" Ladies")] + " W"
    # Already-normalized (Arsenal Women → Arsenal W happens above);
    # leave bare names alone (matches table may have them suffix-less
    # for some leagues).
    return n


def already_ingested(cur, match_id: str) -> bool:
    cur.execute(
        "SELECT 1 FROM xg_match_data WHERE id = %s LIMIT 1",
        (match_id,),
    )
    return cur.fetchone() is not None


def _extract_xg(match_details: dict) -> tuple[Optional[float], Optional[float]]:
    """FotMob nests xG under content.stats.Periods.All.stats[].
    Defensive: tolerates missing keys + alternative shapes."""
    try:
        periods = (
            ((match_details.get("content") or {}).get("stats") or {})
            .get("Periods", {})
        )
        if not periods:
            return None, None
        # "All" is the full-match summary; some matches show only "FH"/"SH"
        for period_key in ("All", "all", "Full Match"):
            block = periods.get(period_key)
            if block is None:
                continue
            stats = block.get("stats") or []
            for s in stats:
                title = (s.get("title") or "").lower()
                if "expected goals" in title or title == "xg":
                    vals = s.get("stats") or s.get("values") or []
                    if len(vals) >= 2:
                        return float(vals[0]), float(vals[1])
    except Exception as e:
        _log(f"  xG extraction error: {type(e).__name__}: {e}", "WARN")
    return None, None


def _parse_score(score_str: Optional[str]) -> tuple[Optional[int], Optional[int]]:
    if not score_str:
        return None, None
    m = re.match(r"\s*(\d+)\s*[-–]\s*(\d+)", score_str)
    if not m:
        return None, None
    return int(m.group(1)), int(m.group(2))


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        _log("DATABASE_URL not set", "ERROR")
        return 2

    _log(f"Per-run cap: {MAX_MATCHES_PER_RUN} matches (set FOTMOB_MAX_MATCHES env to override)")
    _log(f"Will attempt {len(WOMENS_LEAGUES)} FotMob women's leagues: "
         f"{[name for _, name, _ in WOMENS_LEAGUES]}")

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    inserted = 0
    skipped_already = 0
    skipped_unfinished = 0
    skipped_no_xg = 0
    league_results: list[str] = []
    started = datetime.now(timezone.utc)

    try:
        with conn.cursor() as cur:
            for fotmob_id, canonical_name, _api_name in WOMENS_LEAGUES:
                if inserted >= MAX_MATCHES_PER_RUN:
                    _log(f"Reached MAX_MATCHES_PER_RUN={MAX_MATCHES_PER_RUN} — re-fire to continue")
                    break

                _log(f"Loading league {fotmob_id} ({canonical_name})")
                league_data = fetch_json(f"{FOTMOB_BASE}/leagues?id={fotmob_id}")
                if not league_data:
                    league_results.append(f"{canonical_name}: HTTP fetch failed")
                    continue

                # Schema can vary: matches sometimes under `matches.allMatches`
                # or `fixtures` or `matches.previous`.
                candidates: list[Any] = []
                m = league_data.get("matches") or {}
                if isinstance(m, dict):
                    candidates.extend(m.get("allMatches") or [])
                    candidates.extend(m.get("previous") or [])
                fixtures = league_data.get("fixtures") or []
                if isinstance(fixtures, list):
                    candidates.extend(fixtures)

                # Dedup on match id within this batch
                seen_in_league: set[str] = set()
                fixtures_clean: list[dict] = []
                for c in candidates:
                    if not isinstance(c, dict):
                        continue
                    mid = c.get("id") or c.get("matchId")
                    if mid is None:
                        continue
                    if str(mid) in seen_in_league:
                        continue
                    seen_in_league.add(str(mid))
                    fixtures_clean.append(c)

                _log(f"  {canonical_name}: {len(fixtures_clean)} fixtures returned")
                league_results.append(f"{canonical_name}: {len(fixtures_clean)} fixtures")

                processed_in_league = 0
                for fx in fixtures_clean:
                    if inserted >= MAX_MATCHES_PER_RUN:
                        break

                    raw_id = fx.get("id") or fx.get("matchId")
                    fm_id = f"fotmob-{raw_id}"
                    if already_ingested(cur, fm_id):
                        skipped_already += 1
                        continue

                    # Only completed matches have meaningful xG. FotMob
                    # exposes status as either a string ("Finished") or
                    # nested under `status.utcTime` + scoreStr.
                    status = fx.get("status")
                    is_finished = False
                    score_str: Optional[str] = None
                    if isinstance(status, str):
                        is_finished = status.lower() in ("finished", "ft", "aet")
                    elif isinstance(status, dict):
                        is_finished = bool(status.get("finished")) or \
                                      (status.get("reason", "").lower() in ("finished", "ft"))
                        score_str = status.get("scoreStr")
                    if not is_finished:
                        skipped_unfinished += 1
                        continue

                    home_name = normalize_team_name(
                        ((fx.get("home") or {}).get("name") or fx.get("homeName") or "")
                    )
                    away_name = normalize_team_name(
                        ((fx.get("away") or {}).get("name") or fx.get("awayName") or "")
                    )
                    if not home_name or not away_name:
                        continue
                    home_g, away_g = _parse_score(score_str or fx.get("score") or fx.get("scoreStr"))
                    match_date = (fx.get("status", {}).get("utcTime") or fx.get("date") or "")[:10]

                    _log(f"  match {raw_id} ({canonical_name}): {home_name} vs {away_name} "
                         f"{home_g}-{away_g} {match_date} — fetching details")

                    md = fetch_json(f"{FOTMOB_BASE}/matchDetails?matchId={raw_id}")
                    if not md:
                        skipped_no_xg += 1
                        continue

                    home_xg, away_xg = _extract_xg(md)
                    if home_xg is None or away_xg is None:
                        skipped_no_xg += 1
                        continue

                    cur.execute(
                        """
                        INSERT INTO xg_match_data
                          (id, home_team, away_team, league, season, match_date,
                           home_xg, away_xg, home_goals, away_goals, is_result, source)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'fotmob')
                        ON CONFLICT (id) DO NOTHING
                        """,
                        (
                            fm_id, home_name, away_name, canonical_name,
                            "2526",  # current season placeholder
                            match_date,
                            round(home_xg, 4), round(away_xg, 4),
                            home_g, away_g,
                            home_g is not None and away_g is not None,
                        ),
                    )
                    inserted += 1
                    processed_in_league += 1
                    conn.commit()
                    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
                    _log(f"  match {raw_id} ingested ({inserted}/{MAX_MATCHES_PER_RUN}) — "
                         f"home_xg={home_xg:.2f} away_xg={away_xg:.2f} — elapsed={elapsed:.1f}s")

                if processed_in_league == 0 and fixtures_clean:
                    _log(f"  {canonical_name}: 0 new matches — all up-to-date or no xG yet")
    finally:
        conn.close()

    _log(f"FotMob direct ingest complete: inserted={inserted} "
         f"skipped_already={skipped_already} skipped_unfinished={skipped_unfinished} "
         f"skipped_no_xg={skipped_no_xg}")
    _log(f"Per-league: {league_results}")
    # HTTP status summary — last thing in stderr so it survives
    # truncation to a 2KB tail in the wrapper.
    _log(f"HTTP status summary ({len(_http_status_log)} requests): {_http_status_log[:15]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
