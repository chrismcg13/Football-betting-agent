#!/usr/bin/env python3
"""
FotMob league-ID re-discovery — exhaustive search for the 6 women's
leagues whose hardcoded IDs returned 404 in the 2026-05-15 probe.

Strategies tried in order, with results merged:
  1. FotMob search API: /api/searchapi/search?term=<query>
                       and /api/searchapi/suggest?term=<query>
  2. Master leagues directory: /api/allLeagues, /api/leagues
  3. HTML scrape of /leagues (parse <a> tags pointing at /leagues/N)
  4. HTML scrape of country-filtered pages (/leagues?country=...)
  5. __NEXT_DATA__ extraction from any of the above HTML responses

Targets (with name variants to handle league renames):
  Frauen-Bundesliga           also "Bundesliga Frauen"
  Division 1 Féminine          renamed in 2024 to "Première Ligue"
  Damallsvenskan
  Toppserien
  Kvindeligaen                 also "Gjensidige Kvindeligaen"
  A-League Women               also "Liberty A-League"

Read-only. Operator-fired only.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import quote

import requests


def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} find_fotmob_ids: {msg}", file=sys.stderr, flush=True)


HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/html, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.fotmob.com/",
    "Origin": "https://www.fotmob.com",
}

TARGETS: list[tuple[str, list[str]]] = [
    ("Frauen-Bundesliga", ["frauen bundesliga", "bundesliga frauen", "frauen-bundesliga", "1. frauen-bundesliga", "google bundesliga frauen"]),
    ("Division 1 Féminine", ["division 1 féminine", "division 1 feminine", "premiere ligue", "première ligue", "d1 arkema", "d1 féminine"]),
    ("Damallsvenskan", ["damallsvenskan", "obos damallsvenskan", "sweden damallsvenskan"]),
    ("Toppserien", ["toppserien", "norway toppserien"]),
    ("Kvindeligaen", ["kvindeligaen", "gjensidige kvindeligaen", "denmark women", "denmark kvindeliga"]),
    ("A-League Women", ["a-league women", "a league women", "liberty a-league", "a-league w", "australia women"]),
]


def fetch_text(session: requests.Session, url: str) -> Optional[str]:
    try:
        resp = session.get(url, timeout=12)
    except Exception as e:
        _log(f"  HTTP error {url}: {type(e).__name__}: {e}", "WARN")
        return None
    _log(f"  GET {url} → {resp.status_code} body_len={len(resp.text)}")
    if resp.status_code != 200:
        return None
    return resp.text


def fetch_json(session: requests.Session, url: str) -> Optional[Any]:
    text = fetch_text(session, url)
    if text is None:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def walk_for_leagues(obj: Any, sink: list[dict]) -> None:
    """Recursively find dict-like league entries in any JSON shape.
    Heuristic: a league-shaped dict has 'name' AND one of {'id',
    'leagueId', 'ccode'}. Stop descending into matches/players/etc
    that don't add leagues."""
    if isinstance(obj, dict):
        if (("id" in obj or "leagueId" in obj) and isinstance(obj.get("name"), str)
                and len(obj.get("name") or "") < 100):
            sink.append(obj)
        for v in obj.values():
            walk_for_leagues(v, sink)
    elif isinstance(obj, list):
        for v in obj:
            walk_for_leagues(v, sink)


def extract_next_data(html: str) -> Optional[dict]:
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(\{.*?\})</script>',
                  html, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def regex_extract_league_links(html: str) -> list[tuple[int, str]]:
    """Find /leagues/<id>/ patterns in HTML <a> tags. Returns
    (id, anchor_text). De-duplicates by id."""
    found: dict[int, str] = {}
    for m in re.finditer(
        r'<a[^>]+href="/leagues/(\d+)[^"]*"[^>]*>([^<]{1,80})</a>', html
    ):
        lid = int(m.group(1))
        if lid not in found:
            found[lid] = m.group(2).strip()
    return [(lid, name) for lid, name in found.items()]


def match_targets(candidates: list[dict], html_anchors: list[tuple[int, str]]) -> dict[str, list[tuple[int, str, str]]]:
    """For each target, score every candidate against every name
    variant. Return up to 5 best matches per target."""
    results: dict[str, list[tuple[int, str, str]]] = {t[0]: [] for t in TARGETS}
    seen: dict[str, set[tuple[int, str]]] = {t[0]: set() for t in TARGETS}

    # Score JSON candidates
    for cand in candidates:
        cand_name = (cand.get("name") or "").strip()
        cand_id = cand.get("id") or cand.get("leagueId")
        cand_ccode = (cand.get("ccode") or "").lower()
        if not cand_name or cand_id is None:
            continue
        cand_lower = cand_name.lower()
        for target, variants in TARGETS:
            for v in variants:
                if v in cand_lower:
                    key = (int(cand_id), cand_name)
                    if key not in seen[target]:
                        seen[target].add(key)
                        results[target].append((int(cand_id), cand_name, f"json({cand_ccode})"))
                    break

    # Score HTML anchor candidates
    for lid, anchor in html_anchors:
        anchor_lower = anchor.lower()
        for target, variants in TARGETS:
            for v in variants:
                if v in anchor_lower:
                    key = (lid, anchor)
                    if key not in seen[target]:
                        seen[target].add(key)
                        results[target].append((lid, anchor, "html_anchor"))
                    break
    return results


def main() -> int:
    session = requests.Session()
    session.headers.update(HEADERS)

    candidates: list[dict] = []
    html_anchors: list[tuple[int, str]] = []

    # Strategy 1 — search API per target
    _log("Strategy 1: /api/searchapi/{search,suggest} per target query")
    for _, variants in TARGETS:
        for v in variants[:3]:  # cap variants to keep request count bounded
            for endpoint in ("/api/searchapi/search", "/api/searchapi/suggest"):
                data = fetch_json(session, f"https://www.fotmob.com{endpoint}?term={quote(v)}")
                if data:
                    sink: list[dict] = []
                    walk_for_leagues(data, sink)
                    candidates.extend(sink)

    # Strategy 2 — master directory
    _log("Strategy 2: /api/allLeagues + /api/leagues directory walk")
    for url in ("https://www.fotmob.com/api/allLeagues",
                "https://www.fotmob.com/api/leagues"):
        data = fetch_json(session, url)
        if data:
            sink: list[dict] = []
            walk_for_leagues(data, sink)
            _log(f"  {url}: walked {len(sink)} league-like entries")
            candidates.extend(sink)

    # Strategy 3 — HTML /leagues page (might list ALL competitions
    # in the SSR'd Next.js bundle even when the API restricts).
    _log("Strategy 3: HTML scrape of /leagues + __NEXT_DATA__ extraction")
    for url in ("https://www.fotmob.com/leagues",
                "https://www.fotmob.com/leagues/women",
                "https://www.fotmob.com/leagues?type=women"):
        html = fetch_text(session, url)
        if html:
            # Anchor-tag regex
            anchors = regex_extract_league_links(html)
            _log(f"  {url}: {len(anchors)} league anchors found")
            html_anchors.extend(anchors)
            # __NEXT_DATA__ extraction
            nd = extract_next_data(html)
            if nd:
                sink: list[dict] = []
                walk_for_leagues(nd, sink)
                _log(f"  {url}: __NEXT_DATA__ walk yielded {len(sink)} entries")
                candidates.extend(sink)

    # Strategy 4 — country-filtered HTML pages
    _log("Strategy 4: country-filtered HTML pages")
    country_pages = [
        ("germany", "Frauen-Bundesliga"),
        ("france", "Division 1 Féminine"),
        ("sweden", "Damallsvenskan"),
        ("norway", "Toppserien"),
        ("denmark", "Kvindeligaen"),
        ("australia", "A-League Women"),
    ]
    for country, _ in country_pages:
        for url_tmpl in (
            f"https://www.fotmob.com/leagues?country={country}",
            f"https://www.fotmob.com/countries/{country}",
        ):
            html = fetch_text(session, url_tmpl)
            if html:
                anchors = regex_extract_league_links(html)
                _log(f"  {url_tmpl}: {len(anchors)} anchors")
                html_anchors.extend(anchors)
                nd = extract_next_data(html)
                if nd:
                    sink: list[dict] = []
                    walk_for_leagues(nd, sink)
                    candidates.extend(sink)

    _log(f"Total candidates: {len(candidates)} (json) + {len(html_anchors)} (html anchors)")

    # Merge + match
    results = match_targets(candidates, html_anchors)

    _log("=" * 60)
    _log("LEAGUE-ID DISCOVERY SUMMARY:")
    for target, matches in results.items():
        if not matches:
            _log(f"  {target}: NO MATCHES — try manual fotmob.com search")
            continue
        # Show top 5 matches
        _log(f"  {target}: {len(matches)} matches")
        for lid, name, source in matches[:5]:
            _log(f"    → id={lid:>6}  name={name!r}  ({source})")
    _log("=" * 60)
    _log("Update WOMENS_LEAGUES in scrape_fotmob_direct.py with the "
         "confirmed IDs and re-fire the scraper.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
