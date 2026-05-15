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

import requests  # noqa: F401  (used by all 3 strategies)


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
    """Hit the leagues-specific sitemap directly. The first run's
    robots.txt enumeration discovered FotMob ships per-language
    sitemaps at /sitemap/<lang>/leagues.xml — but iterating all ~40
    language variants serially was eating 8+ minutes before reaching
    parse. Single English fetch is enough; leagues are language-
    agnostic (same IDs across all locales)."""
    _log("Strategy A: leagues-specific sitemap direct fetch")
    found: dict[int, str] = {}
    candidate_urls = [
        # Direct leagues-sitemap URLs FotMob actually publishes
        # (discovered via robots.txt enumeration on the previous run).
        "https://www.fotmob.com/sitemap/en/leagues.xml",
        "https://www.fotmob.com/sitemap/leagues.xml",
        # Last-resort generic sitemap candidates
        "https://www.fotmob.com/sitemap.xml",
        "https://www.fotmob.com/sitemap_leagues.xml",
    ]
    for url in candidate_urls:
        resp = fetch(session, url, timeout=15)
        if resp is None or resp.status_code != 200:
            _log(f"  {url} → {resp.status_code if resp else 'err'}")
            continue
        body = resp.text or ""
        _log(f"  {url} → 200 ({len(body)} chars)")
        # Find /leagues/ID/<slug> patterns in any sitemap XML or page.
        # The slug carries the league name, e.g. "/leagues/9229/frauen-bundesliga".
        for m in re.finditer(r"/leagues/(\d+)/?([a-z0-9\-]+)?", body):
            lid = int(m.group(1))
            slug = m.group(2) or ""
            if lid not in found:
                found[lid] = slug
        if found:
            _log(f"  parsed {len(found)} unique league IDs from this sitemap")
            break  # one successful sitemap is enough
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
                          workers: int = 8) -> list[tuple[int, str]]:
    """Sweep /api/leagues/{id} across an ID range using a thread pool.
       2026-05-15 fix: FotMob now serves SPA HTML to direct GETs (the
       JSON API requires x-mas signing). HTML responses embed the
       league name in the __NEXT_DATA__ SSR payload — extract that.
       (Confirmed by Phase 2k wrapper test: WSL=9227 resolves to 'WSL'
       via this exact path.)"""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    _log(f"Strategy C: parallel brute scan {lo}-{hi} ({hi - lo + 1} requests, {workers} workers) — HTML/__NEXT_DATA__ mode")
    found: dict[int, str] = {}
    found_women: dict[int, str] = {}

    next_data_re = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.+?)</script>', re.DOTALL)

    def _probe_one(lid: int) -> tuple[int, Optional[str]]:
        url = f"https://www.fotmob.com/api/leagues/{lid}"
        try:
            resp = session.get(url, timeout=10)
        except Exception:
            return (lid, None)
        if resp.status_code != 200:
            return (lid, None)
        body = resp.text or ""
        # Path 1: try JSON (in case the API is unblocked for this client)
        if "application/json" in resp.headers.get("content-type", "").lower():
            try:
                data = resp.json()
                if isinstance(data, dict):
                    details = data.get("details") or data.get("leagueDetails") or {}
                    name = (details.get("name") if isinstance(details, dict) else None
                            ) or data.get("name") or data.get("leagueName")
                    if isinstance(name, str) and name:
                        return (lid, name)
            except Exception:
                pass
        # Path 2: parse __NEXT_DATA__ from HTML SSR payload (the
        # primary path post-2026-05-15)
        m = next_data_re.search(body)
        if not m:
            return (lid, None)
        try:
            nd = json.loads(m.group(1))
        except Exception:
            return (lid, None)
        pp = (nd.get("props") or {}).get("pageProps") or {}
        # Probe common shapes — verified WSL via
        # initialState.leagueOverview.details.name
        for path_keys in (
            ("initialState", "leagueOverview", "details", "name"),
            ("league", "details", "name"),
            ("leagueOverview", "details", "name"),
            ("initialState", "league", "name"),
            ("details", "name"),
            ("leagueData", "details", "name"),
        ):
            cur: Any = pp
            for k in path_keys:
                if isinstance(cur, dict):
                    cur = cur.get(k)
                else:
                    cur = None
                    break
            if isinstance(cur, str) and cur:
                return (lid, cur)
        return (lid, None)

    completed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_probe_one, lid) for lid in range(lo, hi + 1)]
        for fut in as_completed(futures):
            lid, name = fut.result()
            completed += 1
            if name:
                found[lid] = name
                name_lower = name.lower()
                if any(k in name_lower for k in WOMEN_KEYWORDS):
                    found_women[lid] = name
                    _log(f"  id={lid}: women's hit: {name!r}")
            if completed % 250 == 0:
                _log(f"  progress: {completed}/{len(futures)} probed, "
                     f"{len(found)} total found, {len(found_women)} women's")
    _log(f"  scan complete: {len(found)} total leagues, {len(found_women)} women's")
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

    # 2026-05-15: --strategy CLI arg allows running each strategy
    # independently (admin endpoints split per strategy). Default
    # "all" runs every strategy sequentially as before, but Strategy
    # C is now parallelized so total runtime is ~60-90s instead of
    # ~8 min.
    strategy_filter = "all"
    for arg in sys.argv[1:]:
        if arg.startswith("--strategy="):
            strategy_filter = arg.split("=", 1)[1].lower()
            break
    _log(f"Running strategies: {strategy_filter}")

    all_candidates: list[tuple[int, str]] = []

    # Strategy A — fast probe
    a_results = strategy_a_sitemap(session) if strategy_filter in ("all", "a", "sitemap") else []
    if a_results:
        _log(f"Strategy A found {len(a_results)} league entries")
        # sitemap entries are (id, slug); the slug is usually a clue
        # so we keep them as (id, slug) for target matching too
        for lid, slug in a_results:
            slug_normalized = slug.replace("-", " ").replace("_", " ")
            all_candidates.append((lid, slug_normalized))

    # Strategy B — medium probe (30 days × 3 endpoint variants, throttled)
    b_results = (strategy_b_daily_matches(session, days=30)
                 if strategy_filter in ("all", "b", "daily-matches") else [])
    if b_results:
        _log(f"Strategy B found {len(b_results)} unique leagues via daily-matches")
        all_candidates.extend(b_results)

    # Match results so far — if A or B found what we need, skip the
    # slow brute-force scan.
    interim = match_targets(all_candidates)
    interim_hit_count = sum(1 for v in interim.values() if v)
    _log(f"After Strategies A+B: {interim_hit_count}/{len(TARGET_NAMES)} targets matched")

    if (strategy_filter in ("c", "brute")
            or (strategy_filter == "all" and interim_hit_count < len(TARGET_NAMES))):
        # Strategy C — parallel brute scan, ~30-60s
        # Allow CLI override of range so we can extend hunt for missing
        # Toppserien + Kvindeligaen IDs without rebuilding.
        lo_arg, hi_arg = 9000, 10500
        for arg in sys.argv[1:]:
            if arg.startswith("--range="):
                try:
                    a, b = arg.split("=", 1)[1].split("-", 1)
                    lo_arg, hi_arg = int(a), int(b)
                except Exception:
                    pass
        c_results = strategy_c_brute_scan(session, lo=lo_arg, hi=hi_arg, workers=8)
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
