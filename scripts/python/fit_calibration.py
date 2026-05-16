#!/usr/bin/env python3
"""
Task 12 — weekly calibration fitter.

Reads settled paper_bets, fits scikit-learn IsotonicRegression per
(league, market_type) bucket with n >= 30 samples, plus a market_type
global fallback bucket (scope_league=NULL) for low-sample league
scopes. Writes results to calibration_buckets as JSONB params:

    { "breakpoints": [...], "values": [...] }

The Node side (services/calibration.ts) reads the active row for each
(league, market_type) and does piecewise-linear interpolation in-
process. The Python script runs once a week (Mon 04:00 UTC via cron in
scheduler.ts) plus manually on-demand for the initial seed.

Idempotent: deactivates all prior actives for each bucket before
inserting the new active row. Audit history is preserved.

Env: DATABASE_URL must be set (same connection string the Node side
uses; the cron child process inherits the api-server env).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Tuple

import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from sklearn.isotonic import IsotonicRegression

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s fit_calibration: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("fit_calibration")

MIN_SAMPLES_PER_BUCKET = 30
MIN_SAMPLES_PER_GLOBAL = 100
# Bundle 1M (2026-05-16): tightened from 2026-05-03 (which included 6 days
# of pre-cutover paper-track rows still labelled bet_track='paper') to
# 2026-05-09 (the cutover date). Pre-cutover paper was emitted under a
# different model regime AND different staking logic; mixing it with
# post-cutover shadow/live as a single training cohort leaves the fitter
# under-correcting the post-cutover MO over-confidence. Post-cutover MO
# residual bias (per Bundle 1M audit, 2026-05-16): -55pp at p>=0.70.
ANALYSIS_START_DATE = "2026-05-09"


def fetch_settled(conn) -> list[dict]:
    """Pull all settled bets with a non-null model_probability.

    Bundle 1M (2026-05-16) fix: switched from psycopg2 %s parameter binding
    to f-string interpolation for ANALYSIS_START_DATE. The prior version
    raised psycopg2 IndexError on Python 3.12 because the em-dash and
    en-dash characters in the SQL comment block (lines below) were being
    miscounted by psycopg2's placeholder tokenizer, leading to a mismatch
    between detected %s count and provided params tuple size.
    ANALYSIS_START_DATE is a hardcoded module constant — zero injection
    risk from inline interpolation. Comment characters preserved (the
    rationale matters more than the original parameter-binding style).
    """
    sql = f"""
        SELECT
          pb.model_probability::float8 AS model_prob,
          pb.raw_model_probability::float8 AS raw_prob,
          (pb.status = 'won')::int AS won,
          pb.market_type,
          m.league
        FROM paper_bets pb
        LEFT JOIN matches m ON pb.match_id = m.id
        WHERE pb.placed_at >= '{ANALYSIS_START_DATE}'::date
          AND pb.deleted_at IS NULL
          AND pb.status IN ('won', 'lost')
          AND pb.model_probability IS NOT NULL
          -- Paper rail is deprecated post-2026-05-09 cutover. Its
          -- residual rows are an artefact of the old Path P/S
          -- codepath (every won AH bet on "away +4" at ~99% predicted
          -- probability, 64/64 wins) which would make isotonic
          -- regression report "perfectly calibrated at 0.99" — a
          -- false signal that under-corrects predictions in the
          -- 0.5-0.9 band where shadow + live actually bet.
          AND pb.bet_track IN ('live', 'shadow')
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql)
        return list(cur.fetchall())


def fit_isotonic(probs: np.ndarray, outcomes: np.ndarray) -> tuple[dict, float, float, float]:
    """Fit IsotonicRegression and return (params, brier_in, brier_out, ece).

    Held-out: 80/20 split by random shuffle (seeded).
    Brier on the held-out fold; ECE computed on the held-out fold via
    10 equal-frequency bins.
    """
    n = len(probs)
    rng = np.random.default_rng(42)
    idx = rng.permutation(n)
    cut = int(n * 0.8)
    train_idx, test_idx = idx[:cut], idx[cut:]

    model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    model.fit(probs[train_idx], outcomes[train_idx])

    # Brier in: training-set Brier of RAW probabilities.
    p_train_raw = probs[train_idx]
    y_train = outcomes[train_idx]
    brier_in = float(np.mean((p_train_raw - y_train) ** 2))

    # Brier out: held-out Brier of CALIBRATED probabilities.
    p_test_cal = model.predict(probs[test_idx])
    y_test = outcomes[test_idx]
    brier_out = float(np.mean((p_test_cal - y_test) ** 2))

    # ECE out: 10-bin equal-frequency on the held-out fold.
    ece = _expected_calibration_error(p_test_cal, y_test, n_bins=10)

    # Extract breakpoints/values from the fitted IsotonicRegression.
    # sklearn exposes them as X_thresholds_ and y_thresholds_.
    breakpoints = model.X_thresholds_.astype(float).tolist()
    values = model.y_thresholds_.astype(float).tolist()
    params = {"breakpoints": breakpoints, "values": values}
    return params, brier_in, brier_out, ece


def _expected_calibration_error(probs: np.ndarray, outcomes: np.ndarray, n_bins: int = 10) -> float:
    if len(probs) == 0:
        return float("nan")
    # Equal-frequency binning so every bin has approx the same sample size.
    order = np.argsort(probs)
    bin_edges = np.linspace(0, len(probs), n_bins + 1, dtype=int)
    ece = 0.0
    n = len(probs)
    for i in range(n_bins):
        lo, hi = bin_edges[i], bin_edges[i + 1]
        if hi <= lo:
            continue
        bin_idx = order[lo:hi]
        p_bin = probs[bin_idx]
        y_bin = outcomes[bin_idx]
        gap = abs(p_bin.mean() - y_bin.mean())
        ece += (len(bin_idx) / n) * gap
    return float(ece)


def write_bucket(conn, scope_league: str | None, market_type: str,
                 method: str, n_samples: int, params: dict,
                 brier_in: float, brier_out: float, ece: float) -> int:
    """Deactivate prior actives for this scope, insert new active row."""
    with conn.cursor() as cur:
        if scope_league is None:
            cur.execute(
                """
                UPDATE calibration_buckets
                   SET active = FALSE
                 WHERE scope_league IS NULL
                   AND market_type = %s
                   AND active = TRUE
                """,
                (market_type,),
            )
        else:
            cur.execute(
                """
                UPDATE calibration_buckets
                   SET active = FALSE
                 WHERE scope_league = %s
                   AND market_type = %s
                   AND active = TRUE
                """,
                (scope_league, market_type),
            )
        cur.execute(
            """
            INSERT INTO calibration_buckets
              (scope_league, market_type, method, n_samples, params,
               brier_in, brier_out, ece_out, active)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, TRUE)
            RETURNING bucket_id
            """,
            (scope_league, market_type, method, n_samples,
             json.dumps(params), brier_in, brier_out, ece),
        )
        return cur.fetchone()[0]


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.error("DATABASE_URL not set")
        return 2

    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    log.info("Loading settled bets since %s", ANALYSIS_START_DATE)
    rows = fetch_settled(conn)
    log.info("Loaded %d settled rows", len(rows))
    if not rows:
        log.warning("No settled rows — nothing to fit")
        return 0

    # Group by (league, market_type) and (market_type) — the global fallback.
    by_scope: dict[tuple[str | None, str], list[dict]] = {}
    by_market: dict[str, list[dict]] = {}
    for r in rows:
        if r["league"]:
            by_scope.setdefault((r["league"], r["market_type"]), []).append(r)
        by_market.setdefault(r["market_type"], []).append(r)

    buckets_fit = 0
    buckets_skipped = 0

    # Per-(league, market_type) buckets at n >= MIN_SAMPLES_PER_BUCKET.
    for (league, market_type), bucket_rows in sorted(by_scope.items()):
        # Prefer raw_model_probability if present (post-Phase-3b emissions);
        # fall back to model_probability for legacy rows where raw is null.
        # In the legacy case the stored value is the raw sigmoid anyway
        # because calibration wasn't applied — so it's the correct training
        # input either way.
        probs = np.array(
            [(r["raw_prob"] if r["raw_prob"] is not None else r["model_prob"]) for r in bucket_rows],
            dtype=float,
        )
        outcomes = np.array([r["won"] for r in bucket_rows], dtype=float)
        if len(probs) < MIN_SAMPLES_PER_BUCKET:
            buckets_skipped += 1
            continue
        try:
            params, brier_in, brier_out, ece = fit_isotonic(probs, outcomes)
        except Exception as e:  # noqa: BLE001 — log + continue
            log.warning("Fit failed for (%s, %s): %s", league, market_type, e)
            buckets_skipped += 1
            continue
        write_bucket(conn, league, market_type, "isotonic",
                     len(probs), params, brier_in, brier_out, ece)
        buckets_fit += 1
        log.info("Fit %s × %s n=%d brier_in=%.4f brier_out=%.4f ece=%.4f",
                 league, market_type, len(probs), brier_in, brier_out, ece)

    # Market-type global fallback (scope_league = NULL).
    for market_type, market_rows in sorted(by_market.items()):
        probs = np.array(
            [(r["raw_prob"] if r["raw_prob"] is not None else r["model_prob"]) for r in market_rows],
            dtype=float,
        )
        outcomes = np.array([r["won"] for r in market_rows], dtype=float)
        if len(probs) < MIN_SAMPLES_PER_GLOBAL:
            buckets_skipped += 1
            continue
        try:
            params, brier_in, brier_out, ece = fit_isotonic(probs, outcomes)
        except Exception as e:  # noqa: BLE001
            log.warning("Fit failed for global (%s): %s", market_type, e)
            buckets_skipped += 1
            continue
        write_bucket(conn, None, market_type, "isotonic",
                     len(probs), params, brier_in, brier_out, ece)
        buckets_fit += 1
        log.info("Fit GLOBAL × %s n=%d brier_in=%.4f brier_out=%.4f ece=%.4f",
                 market_type, len(probs), brier_in, brier_out, ece)

    conn.commit()
    conn.close()
    log.info("Done. Buckets fit=%d skipped=%d", buckets_fit, buckets_skipped)
    return 0


if __name__ == "__main__":
    sys.exit(main())
