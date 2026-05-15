#!/usr/bin/env python3
"""
Phase 2k (2026-05-15) — community-wrapper last try.

After raw HTTP brute-scan returned 0/1500 200s (likely either VPS IP
ban or new x-mas signing requirement on /api/leagues/*), test whether
two community wrappers — which reverse-engineer the x-mas header —
can reach the API where direct requests cannot.

Steps:
  1. Raw-request baseline: hit /api/leagues/9227 (WSL — KNOWN-GOOD ID)
     with plain requests. Distinguishes IP ban (still 403/429) from
     header-signing (200 here, but couldn't find others).
  2. Pip-install fotmob-api. Try client.get_league(9227).
  3. Pip-install PyFotMob. Try same.
  4. If ANY wrapper works, try to discover the 6 missing women's
     league IDs via its search-by-name interface (where present).

Read-only. ~2 min hard cap on the wrapper attempts.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from datetime import datetime, timezone

import requests


def _log(msg: str, level: str = "INFO") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{ts} {level} fm_wrap: {msg}", file=sys.stderr, flush=True)


HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://www.fotmob.com/",
    "Origin": "https://www.fotmob.com",
}

TARGET_NAMES = [
    "Frauen-Bundesliga",
    "Division 1 Féminine",
    "Damallsvenskan",
    "Toppserien",
    "Kvindeligaen",
    "A-League Women",
]


def step1_raw_baseline() -> dict:
    """Plain requests hit on WSL=9227. Distinguishes three cases:
      A. 200 + JSON (Content-Type application/json)        → API still open, our scan had a bug
      B. 200 + HTML (Content-Type text/html)               → endpoint now SPA-shell, JSON needs x-mas signing
      C. 403/429/Cloudflare HTML                           → IP banned, wrappers won't help"""
    _log("Step 1: raw requests baseline on /api/leagues/9227 (WSL)")
    result = {"step": 1, "ok": False, "status": None, "content_type": None,
              "is_json": False, "is_html": False, "snippet": None}
    try:
        resp = requests.get(
            "https://www.fotmob.com/api/leagues/9227",
            headers=HEADERS,
            timeout=10,
        )
        result["status"] = resp.status_code
        ctype = resp.headers.get("content-type", "")
        result["content_type"] = ctype
        result["body_len"] = len(resp.text or "")
        is_html = "text/html" in ctype.lower()
        is_json = "application/json" in ctype.lower()
        result["is_html"] = is_html
        result["is_json"] = is_json
        result["snippet"] = (resp.text or "")[:200]
        result["ok"] = resp.status_code == 200 and is_json
        _log(f"  status={resp.status_code} ctype={ctype!r} body_len={result['body_len']}")
        # If HTML, try to find league name in __NEXT_DATA__ (SSR payload)
        if is_html and resp.text:
            import re, json
            m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.+?)</script>', resp.text)
            if m:
                try:
                    nd = json.loads(m.group(1))
                    pp = (nd.get("props") or {}).get("pageProps") or {}
                    name = None
                    # Probe common shapes
                    for path_keys in (("initialState", "leagueOverview", "details", "name"),
                                      ("league", "details", "name"),
                                      ("leagueOverview", "details", "name"),
                                      ("initialState", "league", "name"),
                                      ("details", "name")):
                        cur = pp
                        for k in path_keys:
                            if isinstance(cur, dict):
                                cur = cur.get(k)
                            else:
                                cur = None
                                break
                        if isinstance(cur, str) and cur:
                            name = cur
                            result["next_data_path"] = ".".join(path_keys)
                            break
                    result["next_data_league_name"] = name
                    _log(f"  __NEXT_DATA__ extract: name={name!r}")
                except Exception as e:
                    _log(f"  __NEXT_DATA__ parse failed: {e}")
        if is_json:
            _log("  → JSON API still open — earlier scan had bug, not auth")
        elif is_html:
            _log("  → SPA HTML shell; JSON requires x-mas signing (wrappers may unlock)")
        else:
            _log(f"  → unexpected response, ctype={ctype!r}")
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
        _log(f"  exception: {e}", "WARN")
    return result


def _pip_install(pkg: str, timeout: int = 90) -> bool:
    _log(f"  pip install --quiet {pkg}")
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", pkg],
            capture_output=True, text=True, timeout=timeout,
        )
        if proc.returncode == 0:
            _log(f"  installed {pkg}")
            return True
        _log(f"  pip failed: {proc.stderr[-400:]}", "WARN")
        return False
    except Exception as e:
        _log(f"  pip exception: {e}", "WARN")
        return False


def step2_fotmob_api() -> dict:
    """Try the `fotmob-api` PyPI package (bgrnwd, active)."""
    _log("Step 2: fotmob-api wrapper")
    result = {"step": 2, "package": "fotmob-api", "ok": False}
    if not _pip_install("fotmob-api"):
        result["error"] = "pip install failed"
        return result
    # Try common import shapes
    client = None
    for import_attempt in (
        "from fotmob_api import FotMob; client = FotMob()",
        "from fotmob import FotMob; client = FotMob()",
        "import fotmob_api; client = fotmob_api.FotMob()",
        "from fotmob_api.client import FotMobClient; client = FotMobClient()",
    ):
        try:
            scope = {}
            exec(import_attempt, scope)
            client = scope.get("client")
            if client is not None:
                _log(f"  import OK via: {import_attempt}")
                result["import"] = import_attempt
                break
        except Exception as e:
            _log(f"  import attempt failed: {import_attempt} → {type(e).__name__}: {e}")
    if client is None:
        result["error"] = "no working import path"
        return result
    # Try common method names with WSL ID
    method_attempts = ["get_league", "league", "get_league_overview",
                       "leagues", "fetch_league", "get_league_details"]
    found = None
    for m in method_attempts:
        fn = getattr(client, m, None)
        if not callable(fn):
            continue
        try:
            data = fn(9227)
            if data:
                found = (m, data)
                _log(f"  method {m}(9227) returned data type={type(data).__name__}")
                break
        except Exception as e:
            _log(f"  {m}(9227) → {type(e).__name__}: {str(e)[:120]}")
    if found is None:
        result["error"] = "no working method on client"
        result["available_methods"] = [m for m in dir(client) if not m.startswith("_")][:30]
        return result
    method_name, data = found
    name = None
    if isinstance(data, dict):
        details = data.get("details") or data.get("leagueDetails") or {}
        if isinstance(details, dict):
            name = details.get("name") or details.get("leagueName")
        name = name or data.get("name") or data.get("leagueName")
    result["ok"] = True
    result["method"] = method_name
    result["wsl_name_resolved"] = name
    _log(f"  ✓ wrapper works, WSL resolves to {name!r}")
    # Try search method for missing leagues
    search_attempts = ["search", "search_leagues", "find_league", "search_league"]
    for s in search_attempts:
        fn = getattr(client, s, None)
        if not callable(fn):
            continue
        result["search_method"] = s
        result["search_results"] = {}
        for target in TARGET_NAMES:
            try:
                r = fn(target)
                # Pull league IDs from whatever shape
                ids = []
                def _walk(obj):
                    if isinstance(obj, dict):
                        lid = obj.get("leagueId") or obj.get("id") or obj.get("ccode")
                        nm = obj.get("leagueName") or obj.get("name")
                        if isinstance(lid, int) and isinstance(nm, str):
                            ids.append({"id": lid, "name": nm})
                        for v in obj.values():
                            _walk(v)
                    elif isinstance(obj, list):
                        for v in obj:
                            _walk(v)
                _walk(r)
                result["search_results"][target] = ids[:5]
                _log(f"  search({target!r}) → {len(ids)} hits, top: {ids[:3]}")
            except Exception as e:
                result["search_results"][target] = f"err: {type(e).__name__}: {e}"
        break
    return result


def step3_pyfotmob() -> dict:
    """Try the `PyFotMob` PyPI package as fallback."""
    _log("Step 3: PyFotMob wrapper")
    result = {"step": 3, "package": "PyFotMob", "ok": False}
    if not _pip_install("PyFotMob"):
        if not _pip_install("pyfotmob"):
            result["error"] = "pip install failed (both casings)"
            return result
    client = None
    for import_attempt in (
        "from PyFotMob import FotMob; client = FotMob()",
        "from pyfotmob import FotMob; client = FotMob()",
        "import PyFotMob; client = PyFotMob.FotMob()",
        "import pyfotmob; client = pyfotmob.FotMob()",
    ):
        try:
            scope = {}
            exec(import_attempt, scope)
            client = scope.get("client")
            if client is not None:
                _log(f"  import OK via: {import_attempt}")
                result["import"] = import_attempt
                break
        except Exception as e:
            _log(f"  import attempt failed: {import_attempt} → {type(e).__name__}: {e}")
    if client is None:
        result["error"] = "no working import path"
        return result
    method_attempts = ["get_league", "league", "leagues", "fetch_league"]
    for m in method_attempts:
        fn = getattr(client, m, None)
        if not callable(fn):
            continue
        try:
            data = fn(9227)
            if data:
                result["ok"] = True
                result["method"] = m
                _log(f"  ✓ PyFotMob.{m}(9227) returned data")
                return result
        except Exception as e:
            _log(f"  {m}(9227) → {type(e).__name__}: {str(e)[:120]}")
    result["error"] = "no working method"
    result["available_methods"] = [m for m in dir(client) if not m.startswith("_")][:30]
    return result


def main() -> int:
    started = time.time()
    out = {"phase": "2k_fotmob_wrapper_test", "started_at": started}

    out["step1_raw"] = step1_raw_baseline()
    out["step2_fotmob_api"] = step2_fotmob_api()
    out["step3_pyfotmob"] = step3_pyfotmob()

    out["elapsed_sec"] = round(time.time() - started, 1)

    _log("=" * 60)
    _log("FINAL WRAPPER-TEST SUMMARY:")
    s1 = out["step1_raw"]
    _log(f"  raw /api/leagues/9227 → status={s1.get('status')} ok={s1.get('ok')}")
    s2 = out["step2_fotmob_api"]
    _log(f"  fotmob-api → ok={s2.get('ok')} method={s2.get('method')} "
         f"wsl={s2.get('wsl_name_resolved')!r} err={s2.get('error')}")
    s3 = out["step3_pyfotmob"]
    _log(f"  PyFotMob → ok={s3.get('ok')} method={s3.get('method')} "
         f"err={s3.get('error')}")
    if s2.get("search_results"):
        _log("  fotmob-api search-by-name hits for 6 targets:")
        for tgt, hits in s2["search_results"].items():
            _log(f"    {tgt}: {hits if isinstance(hits, str) else hits[:3]}")
    _log("=" * 60)
    _log(f"  elapsed: {out['elapsed_sec']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
