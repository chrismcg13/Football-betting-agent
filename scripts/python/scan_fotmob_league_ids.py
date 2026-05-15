#!/usr/bin/env python3
"""
FotMob league-ID discovery — three more strategies after search API,
master directory walk, and HTML scrape all dead-ended:

  Strategy A (sitemap.xml): FotMob exposes sitemap files at
    /sitemap.xml + /sitemap_leagues.xml + listed in /robots.txt.
    Sitemaps list every league URL with id, no auth needed.

  Strategy B (daily-matches harvest): /api/matches?date=YYYYMMDD
    returns all fixtures across all leagues on that date. Each
    fixture's leagueId + leagueName is right there in the JSON.
    Across a 30-day window we should hit at least one match for
    every in-season women's league. Throttled to 1 req/sec.

  Strategy C (brute-force ID scan): the 4 known women's IDs
    cluster in 9100-9700 (9227, 9134, 9213, 9682). Sweep 9000-
    10500 against /api/leagues/{id}, parse the name from each 200,
    filter to women's-keyword matches. ~1500 requests at 3/sec
    ≈ 8 min synchronous. Final resort.

Read-only. Reports findings in stderr summary at end. No DB writes.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests


def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} scan_fotmob: {msg}", file=sys.stderr, flush=True)


HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/xml, */*",
    "Referer": "https://www.fotmob.com/",
    "Origin": "https://www.fotmob.com",
}

WOMEN_KEYWORDS = (
    "women", "frauen", "féminin", "feminine", "femenina", "femminile",
    "dam", "topp", "kvinde", "wsl", "nwsl", "a-league w", "liga f",
)

TARGET_NAMES: dict[str, list[str]] = {
    "Frauen-Bundesliga": ["frauen-bundesliga", "frauen bundesliga"],
    "Division 1 Féminine": ["division 1 féminine", "division 1 feminine",
                            "premiere ligue", "première ligue", "d1 arkema",
                            "d1 féminine"],
    "Damallsvenskan": ["damallsvenskan", "obos damallsvenskan"],
    "Toppserien": ["toppserien"],
    "Kvindeligaen": ["kvindeligaen", "gjensidige kvindeligaen", "denmark kvinde"],
    "A-League Women": ["a-league women", "a league women", "liberty a-league",
                       "a-league w"],
}


def fetch(session: requests.Session, url: str, timeout: int = 12) -> Optional[requests.Response]:
    try:
        return session.get(url, timeout=timeout)
    except Exception as e:
        _log(f"  HTTP error {url}: {type(e).__name__}: {e}", "WARN")
        return None


def strategy_a_sitemap(session: requests.Session) -> list[tuple[int, str]]:
    """Probe known sitemap locations + robots.txt for any league URLs."""
    _log("Strategy A: sitemap.xml probes")
    found: dict[int, str] = {}
    candidate_urls = [
        "https://www.fotmob.com/sitemap.xml",
        "https://www.fotmob.com/sitemap_leagues.xml",
        "https://www.fotmob.com/sitemap-leagues.xml",
        "https://www.fotmob.com/robots.txt",
    ]
    for url in candidate_urls:
        resp = fetch(session, url)
        if resp is None or resp.status_code != 200:
            _log(f"  {url} → {resp.status_code if resp else 'err'}")
            continue
        body = resp.text or ""
        _log(f"  {url} → 200 ({len(body)} chars)")
        # If it's robots.txt, extract any Sitemap: declarations to follow
        if "robots.txt" in url:
            for m in re.finditer(r"Sitemap:\s*(\S+)", body, re.IGNORECASE):
                ext_url = m.group(1).strip()
                _log(f"    robots references sitemap: {ext_url}")
                ext_resp = fetch(session, ext_url)
                if ext_resp and ext_resp.status_code == 200:
                    body += ext_resp.text
        # Find /leagues/ID/ patterns anywhere in the body
        for m in re.finditer(r"/leagues/(\d+)/([a-z0-9\-]+)?", body):
            lid = int(m.group(1))
            slug = m.group(2) or ""
            if lid not in found:
                found[lid] = slug
    return [(lid, slug) for lid, slug in found.items()]


def strategy_b_daily_matches(session: requests.Session, days: int = 30) -> list[tuple[int, str]]:
    """Harvest /api/matches?date=YYYYMMDD across the last N days. Each
    match's leagueId + leagueName lands in the response."""
    _log(f"Strategy B: daily-matches harvest across last {days} days")
    found: dict[int, str] = {}
    today = datetime.now(timezone.utc).date()
    for i in range(days):
        date = today - timedelta(days=i)
        date_str = date.strftime("%Y%m%d")
        # Try a couple of endpoint variants
        for url_tmpl in (
            "https://www.fotmob.com/api/matches?date={d}",
            "https://www.fotmob.com/api/scoreboard?date={d}",
            "https://www.fotmob.com/api/livescore?date={d}",
        ):
            url = url_tmpl.format(d=date_str)
            resp = fetch(session, url)
            if resp is None or resp.status_code != 200:
                continue
            try:
                data = resp.json()
            except Exception:
                continue
            # Walk for {leagueId, leagueName}
            def _walk(obj):
                if isinstance(obj, dict):
                    lid = obj.get("leagueId") or obj.get("id")
                    name = (obj.get("leagueName") or obj.get("name")
                            or obj.get("league") or "")
                    if isinstance(lid, int) and isinstance(name, str) and name:
                        if lid not in found:
                            found[lid] = name
                    for v in obj.values():
                        _walk(v)
                elif isinstance(obj, list):
                    for v in obj:
                        _walk(v)
            _walk(data)
            _log(f"  {url} → 200, total unique leagues so far: {len(found)}")
            time.sleep(1.0)  # throttle
            break  # don't try other variants if this one worked
    return [(lid, name) for lid, name in found.items()]


def strategy_c_brute_scan(session: requests.Session, lo: int = 9000, hi: int = 10500,
                          throttle_secs: float = 0.35) -> list[tuple[int, str]]:
    """Sweep /api/leagues/{id} across an ID range. Known IDs:
       WSL=9227, NWSL=9134, Liga F=9682, Serie A Femminile=9213.
       Their cluster suggests women's leagues live in 9000-10500."""
    _log(f"Strategy C: brute-force scan {lo}-{hi} (~{int((hi - lo) * throttle_secs)} sec at {1.0/throttle_secs:.1f} req/s)")
    found: dict[int, str] = {}
    found_women: dict[int, str] = {}
    consecutive_errs = 0
    for lid in range(lo, hi + 1):
        url = f"https://www.fotmob.com/api/leagues/{lid}"
        try:
            resp = session.get(url, timeout=8)
        except Exception:
            consecutive_errs += 1
            if consecutive_errs >= 10:
                _log(f"  10 consecutive errors at id={lid} — backing off, breaking", "WARN")
                break
            time.sleep(2.0)
            continue
        consecutive_errs = 0
        if resp.status_code == 429:
            _log(f"  id={lid}: 429 rate-limited, backing off 30s", "WARN")
            time.sleep(30)
            continue
        if resp.status_code != 200:
            time.sleep(throttle_secs)
            continue
        try:
            data = resp.json()
        except Exception:
            time.sleep(throttle_secs)
            continue
        # Name can live at various paths in the league response
        name = None
        if isinstance(data, dict):
            details = data.get("details") or data.get("leagueDetails") or {}
            if isinstance(details, dict):
                name = details.get("name") or details.get("leagueName")
            name = name or data.get("name") or data.get("leagueName")
        if not isinstance(name, str) or not name:
            time.sleep(throttle_secs)
            continue
        found[lid] = name
        name_lower = name.lower()
        if any(k in name_lower for k in WOMEN_KEYWORDS):
            found_women[lid] = name
            _log(f"  id={lid}: women's-keyword hit: {name!r}")
        # Don't log every non-women hit, just every 100th progress marker
        if lid % 100 == 0:
            _log(f"  ...id={lid}: found {len(found)} total, {len(found_women)} women's so far")
        time.sleep(throttle_secs)
    _log(f"  scan complete: {len(found)} total leagues, {len(found_women)} women's matches")
    return [(lid, name) for lid, name in found_women.items()]


def match_targets(candidates: list[tuple[int, str]]) -> dict[str, list[tuple[int, str]]]:
    results: dict[str, list[tuple[int, str]]] = {t: [] for t in TARGET_NAMES}
    for lid, name in candidates:
        name_lower = name.lower()
        for target, variants in TARGET_NAMES.items():
            for v in variants:
                if v in name_lower:
                    results[target].append((lid, name))
                    break
    return results


def main() -> int:
    session = requests.Session()
    session.headers.update(HEADERS)

    all_candidates: list[tuple[int, str]] = []

    # Strategy A — fast probe
    a_results = strategy_a_sitemap(session)
    if a_results:
        _log(f"Strategy A found {len(a_results)} league entries")
        # sitemap entries are (id, slug); the slug is usually a clue
        # so we keep them as (id, slug) for target matching too
        for lid, slug in a_results:
            slug_normalized = slug.replace("-", " ").replace("_", " ")
            all_candidates.append((lid, slug_normalized))

    # Strategy B — medium probe (30 days × 3 endpoint variants, throttled)
    b_results = strategy_b_daily_matches(session, days=30)
    if b_results:
        _log(f"Strategy B found {len(b_results)} unique leagues via daily-matches")
        all_candidates.extend(b_results)

    # Match results so far — if A or B found what we need, skip the
    # slow brute-force scan.
    interim = match_targets(all_candidates)
    interim_hit_count = sum(1 for v in interim.values() if v)
    _log(f"After Strategies A+B: {interim_hit_count}/{len(TARGET_NAMES)} targets matched")

    if interim_hit_count < len(TARGET_NAMES):
        # Strategy C — brute force (slowest, last resort)
        c_results = strategy_c_brute_scan(session, lo=9000, hi=10500, throttle_secs=0.35)
        if c_results:
            _log(f"Strategy C found {len(c_results)} women's-keyword leagues via ID scan")
            all_candidates.extend(c_results)

    # Final match
    results = match_targets(all_candidates)

    _log("=" * 60)
    _log("FINAL LEAGUE-ID DISCOVERY SUMMARY:")
    for target, matches in results.items():
        if not matches:
            _log(f"  {target}: NO MATCHES")
            continue
        # Dedupe by id
        seen_ids: set[int] = set()
        for lid, name in matches[:8]:
            if lid in seen_ids:
                continue
            seen_ids.add(lid)
            _log(f"    → {target}: id={lid:>6}  name={name!r}")
    _log("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
