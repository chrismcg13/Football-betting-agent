#!/usr/bin/env python3
"""
FotMob endpoint discovery probe.

Phase 2e returned HTTP 404 on every `https://www.fotmob.com/api/leagues?id=X`
call. FotMob's web app at fotmob.com clearly still works, so they
serve data from somewhere — they just restructured. This script
tries every plausible URL pattern for ONE league (WSL = id 9227) and
reports status codes + body snippets, so we can identify whichever
endpoint variant still returns JSON. Once found, scrape_fotmob_direct
gets a one-line fix to point at the correct path.

Covers:
  - Multiple path conventions (/api/leagues?id, /api/leagues/9227,
    /api/v2/...)
  - Multiple subdomains (www, api, m, mobile)
  - Embedded JSON in the public HTML league page (Next.js apps often
    embed __NEXT_DATA__ that contains the same data the API serves)
  - GraphQL endpoint probe

Run via /admin/run-fotmob-probe (operator-triggered only). Logs
status + length-of-body + first-200-chars for every candidate.
Idempotent + read-only — never touches the DB.
"""

from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone

import requests


def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} probe_fotmob: {msg}", file=sys.stderr, flush=True)


HEADERS_BASE = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.fotmob.com/",
    "Origin": "https://www.fotmob.com",
}

# Probe target: WSL has league id 9227 in the old API. If they
# renumbered, this may now be wrong, but a 404 on every endpoint
# variant would tell us that too.
PROBE_LEAGUE_ID = 9227
PROBE_LEAGUE_SLUG = "wsl"
PROBE_TEAM_ID = 9526      # Arsenal Women — used for team-shaped endpoints
PROBE_MATCH_ID = 3795506  # arbitrary WSL match — used for match-detail endpoints

# 25+ URL patterns to try. Categorised by hypothesis.
ENDPOINT_CANDIDATES = [
    # Original (known 404 — included for confirmation)
    ("legacy", f"https://www.fotmob.com/api/leagues?id={PROBE_LEAGUE_ID}"),
    ("legacy_with_season", f"https://www.fotmob.com/api/leagues?id={PROBE_LEAGUE_ID}&season=2024/2025"),

    # Path-based variants
    ("path_v1", f"https://www.fotmob.com/api/leagues/{PROBE_LEAGUE_ID}"),
    ("path_v1_overview", f"https://www.fotmob.com/api/leagues/{PROBE_LEAGUE_ID}/overview"),
    ("path_v1_table", f"https://www.fotmob.com/api/leagues/{PROBE_LEAGUE_ID}/table"),
    ("path_v1_matches", f"https://www.fotmob.com/api/leagues/{PROBE_LEAGUE_ID}/matches"),

    # /api/v2 family
    ("v2_query", f"https://www.fotmob.com/api/v2/leagues?id={PROBE_LEAGUE_ID}"),
    ("v2_path", f"https://www.fotmob.com/api/v2/leagues/{PROBE_LEAGUE_ID}"),

    # /api/data — Next.js apps often expose this for SSR
    ("data_path", f"https://www.fotmob.com/api/data/leagues/{PROBE_LEAGUE_ID}"),
    ("data_query", f"https://www.fotmob.com/api/data/leagues?id={PROBE_LEAGUE_ID}"),

    # Renamed resource
    ("competition_path", f"https://www.fotmob.com/api/competitions/{PROBE_LEAGUE_ID}"),
    ("competition_query", f"https://www.fotmob.com/api/competition?id={PROBE_LEAGUE_ID}"),
    ("tournament_path", f"https://www.fotmob.com/api/tournaments/{PROBE_LEAGUE_ID}"),

    # Other resources
    ("league_overview", f"https://www.fotmob.com/api/leagueOverview?id={PROBE_LEAGUE_ID}"),
    ("league_singular", f"https://www.fotmob.com/api/league?id={PROBE_LEAGUE_ID}"),
    ("matches_query", f"https://www.fotmob.com/api/matches?leagueId={PROBE_LEAGUE_ID}"),

    # Alt subdomains
    ("api_subdomain", f"https://api.fotmob.com/leagues?id={PROBE_LEAGUE_ID}"),
    ("api_v1_subdomain", f"https://api.fotmob.com/v1/leagues/{PROBE_LEAGUE_ID}"),
    ("api_v2_subdomain", f"https://api.fotmob.com/v2/leagues/{PROBE_LEAGUE_ID}"),
    ("m_subdomain", f"https://m.fotmob.com/api/leagues?id={PROBE_LEAGUE_ID}"),
    ("mobile_subdomain", f"https://api.mobile.fotmob.com/leagues?id={PROBE_LEAGUE_ID}"),

    # Match details (we need this too, for xG extraction)
    ("matchdetails_query", f"https://www.fotmob.com/api/matchDetails?matchId={PROBE_MATCH_ID}"),
    ("matchdetails_path", f"https://www.fotmob.com/api/matches/{PROBE_MATCH_ID}"),
    ("matchdetails_v2", f"https://www.fotmob.com/api/v2/matches/{PROBE_MATCH_ID}"),

    # Public HTML page — Next.js apps embed __NEXT_DATA__ JSON that
    # often contains everything the API would return. We can extract
    # it via regex from the HTML.
    ("html_overview", f"https://www.fotmob.com/leagues/{PROBE_LEAGUE_ID}/overview/{PROBE_LEAGUE_SLUG}"),
    ("html_root", f"https://www.fotmob.com/leagues/{PROBE_LEAGUE_ID}"),

    # GraphQL probe (POST tested separately)
    ("graphql_probe", "https://www.fotmob.com/api/graphql"),
]


def probe_one(session: requests.Session, label: str, url: str) -> dict:
    try:
        resp = session.get(url, timeout=10)
    except Exception as e:
        _log(f"{label}: HTTP error {type(e).__name__}: {e}", "WARN")
        return {"label": label, "url": url, "status": f"err:{type(e).__name__}",
                "body_len": 0, "body_snip": ""}

    body = resp.text or ""
    snip = body[:300].replace("\n", " ").replace("\r", "")

    # Detect embedded Next.js __NEXT_DATA__ inside HTML responses
    next_data_marker = ""
    if "__NEXT_DATA__" in body:
        next_data_marker = " [HAS __NEXT_DATA__]"
    if '"xg"' in body or '"expectedGoals"' in body:
        next_data_marker += " [MENTIONS XG]"

    _log(f"{label} → {resp.status_code} body_len={len(body)}{next_data_marker} "
         f"snip={snip!r}")
    return {
        "label": label,
        "url": url,
        "status": resp.status_code,
        "body_len": len(body),
        "body_snip": snip[:200],
        "has_next_data": "__NEXT_DATA__" in body,
        "mentions_xg": '"xg"' in body or '"expectedGoals"' in body,
    }


def main() -> int:
    _log(f"Probing {len(ENDPOINT_CANDIDATES)} FotMob endpoint candidates "
         f"(league_id={PROBE_LEAGUE_ID}, match_id={PROBE_MATCH_ID})")

    session = requests.Session()
    session.headers.update(HEADERS_BASE)

    results = []
    for label, url in ENDPOINT_CANDIDATES:
        results.append(probe_one(session, label, url))

    # GraphQL POST probe — different shape from GET
    try:
        gq_resp = session.post(
            "https://www.fotmob.com/api/graphql",
            json={"query": "{ __typename }"},
            timeout=10,
        )
        _log(f"graphql_post → {gq_resp.status_code} body_len={len(gq_resp.text)} "
             f"snip={gq_resp.text[:200]!r}")
        results.append({
            "label": "graphql_post",
            "status": gq_resp.status_code,
            "body_len": len(gq_resp.text),
        })
    except Exception as e:
        _log(f"graphql_post: HTTP error {type(e).__name__}: {e}", "WARN")

    # Summary — pinned to END of stderr so it survives the 2KB tail truncation
    _log("=" * 60)
    _log("PROBE SUMMARY:")
    successes = [r for r in results if isinstance(r.get("status"), int) and r["status"] == 200]
    interesting = [r for r in results if r.get("has_next_data") or r.get("mentions_xg")]
    for r in results:
        flag = ""
        if r.get("status") == 200:
            flag = "  ✓ 200"
        elif r.get("has_next_data"):
            flag = "  ← __NEXT_DATA__"
        elif r.get("mentions_xg"):
            flag = "  ← mentions xG"
        _log(f"  {r['label']:20s} status={r.get('status')}{flag}")
    _log(f"200-OK candidates: {[r['label'] for r in successes]}")
    _log(f"Interesting (embedded data / xG): {[r['label'] for r in interesting]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
