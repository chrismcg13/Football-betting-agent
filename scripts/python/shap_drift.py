#!/usr/bin/env python3
"""
Task 21 — SHAP-on-residuals drift detection.

For each market_type, compares two windows of recent settled bets:
  - recent:   last N bets (default 500)
  - baseline: the 1,500 bets immediately before that

For each per-bet feature in the `features` table, runs a two-sample
Kolmogorov-Smirnov test on the feature's distribution in each window.
A feature with p < 0.01 is flagged as drifted. ≥2 drifted = warning;
≥3 drifted = critical + log a hint to retrain.

This first ship uses raw feature values from `features` table as proxies
for SHAP "feature importance" (a feature whose VALUE distribution has
shifted is likely to have its SHAP distribution shifted too — they're
correlated). A future iteration can integrate the `shap` library
properly to compute true SHAP values against the loaded LR model.

Writes one row per market_type per run to `shap_drift_runs`. Side
effects beyond the DB row are bounded: it does NOT call retrain
directly; the recalibration trigger is the next pass through the
Phase 3b calibration cron (Monday 04:00 UTC) which sees the recent
drift_runs and decides whether to refit.

Env: DATABASE_URL must be set (inherited from api-server when called
via Node child_process.spawn — same pattern as fit_calibration.py).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from scipy.stats import ks_2samp

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s shap_drift: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("shap_drift")

RECENT_N = 500
BASELINE_N = 1500
KS_P_THRESHOLD = 0.01
MIN_SAMPLES_PER_FEATURE = 20

# Feature names to monitor — keep aligned with predictionEngine.FEATURE_NAMES
# plus any model-input shadow features we want to track for drift even
# before they're wired in.
MONITORED_FEATURES = [
    "home_form_last5",
    "away_form_last5",
    "home_goals_scored_avg",
    "home_goals_conceded_avg",
    "away_goals_scored_avg",
    "away_goals_conceded_avg",
    "h2h_home_win_rate",
    "league_position_diff",
    "home_btts_rate",
    "away_btts_rate",
    "home_over25_rate",
    "away_over25_rate",
    # Shadow features (Phase 4) — monitored for drift even though
    # they're not yet in the model. If they drift here, we know the
    # signal they'd carry is changing and might want to wire them in.
    "home_clubelo",
    "away_clubelo",
    "elo_diff",
]


def fetch_window(conn, market_type: str, limit: int, offset: int = 0) -> dict[str, list[float]]:
    """Return {feature_name: [values...]} for `limit` settled bets of
    market_type, ordered by placed_at DESC, offset by `offset`."""
    sql = """
        WITH bets AS (
          SELECT id, match_id, placed_at
          FROM paper_bets
          WHERE market_type = %s
            AND status IN ('won','lost')
            AND deleted_at IS NULL
          ORDER BY placed_at DESC
          LIMIT %s OFFSET %s
        )
        SELECT f.feature_name, f.feature_value::float8 AS value
        FROM bets b
        JOIN features f ON f.match_id = b.match_id
        WHERE f.feature_name = ANY(%s)
    """
    out: dict[str, list[float]] = {name: [] for name in MONITORED_FEATURES}
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (market_type, limit, offset, MONITORED_FEATURES))
        for row in cur.fetchall():
            v = row["value"]
            if v is not None:
                out[row["feature_name"]].append(float(v))
    return out


def analyse_market(conn, market_type: str) -> dict:
    """Run the drift comparison for one market_type. Returns a result
    dict suitable for insertion into shap_drift_runs."""
    recent = fetch_window(conn, market_type, RECENT_N, 0)
    baseline = fetch_window(conn, market_type, BASELINE_N, RECENT_N)

    drifted = []
    analysed = 0
    ks_max_stat = 0.0
    ks_min_p = 1.0

    for feat in MONITORED_FEATURES:
        r = recent.get(feat, [])
        b = baseline.get(feat, [])
        if len(r) < MIN_SAMPLES_PER_FEATURE or len(b) < MIN_SAMPLES_PER_FEATURE:
            continue
        analysed += 1
        try:
            stat, pvalue = ks_2samp(np.array(r), np.array(b))
        except Exception as e:  # noqa: BLE001
            log.warning("ks_2samp failed for %s/%s: %s", market_type, feat, e)
            continue
        ks_max_stat = max(ks_max_stat, float(stat))
        ks_min_p = min(ks_min_p, float(pvalue))
        if pvalue < KS_P_THRESHOLD:
            mean_shift = float(np.mean(r) - np.mean(b))
            drifted.append({
                "feature": feat,
                "ks_stat": float(stat),
                "p_value": float(pvalue),
                "mean_shift": mean_shift,
                "n_recent": len(r),
                "n_baseline": len(b),
            })

    n_drifted = len(drifted)
    if n_drifted >= 3:
        action = "alert_critical"
        notes = "≥3 features drifted at p<0.01 — recommend calibration refit"
    elif n_drifted >= 2:
        action = "alert_warning"
        notes = "≥2 features drifted at p<0.01"
    else:
        action = "no_action"
        notes = None

    return {
        "market_type": market_type,
        "recent_n": RECENT_N,
        "baseline_n": BASELINE_N,
        "features_analysed": analysed,
        "features_drifted": n_drifted,
        "drifted_features": drifted,
        "ks_max_stat": ks_max_stat if analysed else None,
        "ks_min_pvalue": ks_min_p if analysed else None,
        "action_taken": action,
        "notes": notes,
    }


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.error("DATABASE_URL not set")
        return 2

    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    # Pull the market_types that have enough volume for the window split.
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT market_type, COUNT(*) AS n
            FROM paper_bets
            WHERE status IN ('won','lost') AND deleted_at IS NULL
            GROUP BY market_type
            HAVING COUNT(*) >= %s
            ORDER BY n DESC
            """,
            (RECENT_N + BASELINE_N,),
        )
        markets = [r["market_type"] for r in cur.fetchall()]
    log.info("Analysing %d market_types with sufficient volume", len(markets))

    results = []
    for mt in markets:
        try:
            r = analyse_market(conn, mt)
        except Exception as e:  # noqa: BLE001
            log.warning("Analysis failed for %s: %s", mt, e)
            continue
        results.append(r)
        log.info(
            "%s: analysed=%d drifted=%d action=%s",
            mt, r["features_analysed"], r["features_drifted"], r["action_taken"],
        )

    # Persist results.
    with conn.cursor() as cur:
        for r in results:
            cur.execute(
                """
                INSERT INTO shap_drift_runs
                  (market_type, recent_n, baseline_n,
                   features_analysed, features_drifted, drifted_features,
                   ks_max_stat, ks_min_pvalue, action_taken, notes)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s)
                """,
                (
                    r["market_type"], r["recent_n"], r["baseline_n"],
                    r["features_analysed"], r["features_drifted"],
                    json.dumps(r["drifted_features"]),
                    r["ks_max_stat"], r["ks_min_pvalue"],
                    r["action_taken"], r["notes"],
                ),
            )

    conn.commit()
    conn.close()
    n_crit = sum(1 for r in results if r["action_taken"] == "alert_critical")
    n_warn = sum(1 for r in results if r["action_taken"] == "alert_warning")
    log.info("Done. critical=%d warning=%d total=%d", n_crit, n_warn, len(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
