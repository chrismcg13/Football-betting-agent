#!/usr/bin/env python3
"""
Task 13 — empirical market-pair correlation matrix.

Pulls settled-bet pairs from paper_bets where the same match has bets
on TWO different market types. For each (league, market_a, market_b)
pair, computes Pearson correlation between binary win/lose outcomes.

Persists per-(league × market_a × market_b) AND a global fallback
(league = '') for market_a + market_b pairs with thin per-league data.

Min 30 pairs per row; below that, skip. Pearson correlation on a
binary 0/1 series is equivalent to the φ coefficient — same formula,
unbiased on 0/1 inputs.

Cron: monthly on the 1st at 04:45 UTC (after feature attribution 04:30).
Correlation structure changes slowly (it's a league-property thing),
so monthly cadence is appropriate.

Consumer (Node): services/portfolioKelly.ts looks up the correlation
for each candidate bet pair on a fixture and shrinks the independent
Kelly fractions toward a portfolio-Kelly solution. Wire-in is deferred
to a follow-up PR; this PR populates the table only.
"""

from __future__ import annotations

import logging
import os
import sys

import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from scipy.stats import pearsonr

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s market_correlations: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("market_correlations")

MIN_PAIRS = 30
ANALYSIS_START_DATE = "2026-05-03"


def fetch_pairs(conn) -> list[dict]:
    """Pull all settled-bet pairs (a.id < b.id) on the same match where
    a.market_type != b.market_type. Returns rows with league + both
    market types + both outcomes."""
    sql = """
        SELECT
          m.league,
          a.market_type AS market_a,
          b.market_type AS market_b,
          (a.status = 'won')::int AS a_win,
          (b.status = 'won')::int AS b_win
        FROM paper_bets a
        JOIN paper_bets b
          ON a.match_id = b.match_id
         AND a.id < b.id
        JOIN matches m ON m.id = a.match_id
        WHERE a.status IN ('won','lost')
          AND b.status IN ('won','lost')
          AND a.deleted_at IS NULL
          AND b.deleted_at IS NULL
          AND a.market_type != b.market_type
          AND a.placed_at >= %s::date
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (ANALYSIS_START_DATE,))
        rows = cur.fetchall()
    # Normalise market pair to (alphabetically_smaller, alphabetically_larger)
    # so the SAME pair always groups regardless of which bet had smaller id.
    out = []
    for r in rows:
        ma, mb = r["market_a"], r["market_b"]
        aw, bw = r["a_win"], r["b_win"]
        if ma > mb:
            ma, mb = mb, ma
            aw, bw = bw, aw
        out.append({"league": r["league"], "market_a": ma, "market_b": mb, "a_win": aw, "b_win": bw})
    return out


def compute_correlation(pairs: list[dict]) -> tuple[float | None, int]:
    if len(pairs) < MIN_PAIRS:
        return None, len(pairs)
    a = np.array([p["a_win"] for p in pairs], dtype=float)
    b = np.array([p["b_win"] for p in pairs], dtype=float)
    if np.std(a) == 0 or np.std(b) == 0:
        # Both sides constant → correlation undefined / zero by convention
        return 0.0, len(pairs)
    try:
        r, _ = pearsonr(a, b)
        if not np.isfinite(r):
            return None, len(pairs)
        return float(r), len(pairs)
    except Exception:
        return None, len(pairs)


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.error("DATABASE_URL not set")
        return 2

    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    log.info("Loading market-pair outcomes")
    pairs = fetch_pairs(conn)
    log.info("Loaded %d same-match settled-bet pairs", len(pairs))
    if not pairs:
        log.warning("No pairs — nothing to compute")
        return 0

    # Group by (league, market_a, market_b)
    by_scope: dict[tuple[str, str, str], list[dict]] = {}
    by_global: dict[tuple[str, str], list[dict]] = {}
    for p in pairs:
        key = (p["league"] or "", p["market_a"], p["market_b"])
        by_scope.setdefault(key, []).append(p)
        gkey = (p["market_a"], p["market_b"])
        by_global.setdefault(gkey, []).append(p)

    rows_written = 0
    rows_skipped = 0

    with conn.cursor() as cur:
        # Per (league, ma, mb)
        for (league, ma, mb), pair_list in by_scope.items():
            r, n = compute_correlation(pair_list)
            if r is None:
                rows_skipped += 1
                continue
            cur.execute(
                """
                INSERT INTO market_correlation_matrix
                  (league, market_a, market_b, correlation, n_pairs, computed_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (league, market_a, market_b) DO UPDATE
                SET correlation = EXCLUDED.correlation,
                    n_pairs = EXCLUDED.n_pairs,
                    computed_at = EXCLUDED.computed_at
                """,
                (league, ma, mb, r, n),
            )
            rows_written += 1
            log.info("(%s, %s, %s) n=%d r=%.4f", league or "<global>", ma, mb, n, r)

        # Global fallback (league = '')
        for (ma, mb), pair_list in by_global.items():
            r, n = compute_correlation(pair_list)
            if r is None:
                continue
            cur.execute(
                """
                INSERT INTO market_correlation_matrix
                  (league, market_a, market_b, correlation, n_pairs, computed_at)
                VALUES ('', %s, %s, %s, %s, NOW())
                ON CONFLICT (league, market_a, market_b) DO UPDATE
                SET correlation = EXCLUDED.correlation,
                    n_pairs = EXCLUDED.n_pairs,
                    computed_at = EXCLUDED.computed_at
                """,
                (ma, mb, r, n),
            )
            rows_written += 1
            log.info("(GLOBAL, %s, %s) n=%d r=%.4f", ma, mb, n, r)

    conn.commit()
    conn.close()
    log.info("Done. rows_written=%d rows_skipped=%d", rows_written, rows_skipped)
    return 0


if __name__ == "__main__":
    sys.exit(main())
