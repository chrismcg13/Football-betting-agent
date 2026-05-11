#!/usr/bin/env python3
"""
Task 22 — feature attribution.

Monthly job. For each (feature × market_type), measures how strongly the
feature sorts bet CLV outcome:
  - pearson_r: Pearson correlation between feature_value and clv_pct
  - incremental_clv: top-decile mean clv_pct − bottom-decile mean clv_pct

Then updates feature_lifecycle:
  - weak month = |incremental_clv| < 0.5pp AND |pearson_r| < 0.05
  - 3 consecutive weak months → status = 'deprecated_candidate'
  - any non-weak month resets weak_months_count to 0

Operator-driven: deprecation is flagged, not enforced. A periodic
review removes flagged features from FEATURE_NAMES in code.

Env: DATABASE_URL must be set.
"""

from __future__ import annotations

import logging
import os
import sys
from datetime import date

import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from scipy.stats import pearsonr

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s feature_attribution: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("feature_attribution")

WEAK_INCREMENTAL_CLV_THRESHOLD = 0.5  # pp
WEAK_PEARSON_THRESHOLD = 0.05
MIN_BETS_PER_BUCKET = 50

# Monitored features — keep aligned with predictionEngine.FEATURE_NAMES + shadow features.
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
    # Phase 4 shadow features
    "home_clubelo",
    "away_clubelo",
    "elo_diff",
]


def period_start_first_of_month() -> date:
    today = date.today()
    return date(today.year, today.month, 1)


def fetch_bet_feature_clv(conn, market_type: str, feature_name: str) -> tuple[np.ndarray, np.ndarray]:
    """Return parallel arrays (feature_value, clv_pct) for settled bets
    of `market_type` since the analysis-start date."""
    sql = """
        SELECT f.feature_value::float8 AS fv,
               pb.clv_pct::float8       AS clv
        FROM paper_bets pb
        JOIN features f ON f.match_id = pb.match_id AND f.feature_name = %s
        WHERE pb.market_type = %s
          AND pb.status IN ('won', 'lost')
          AND pb.deleted_at IS NULL
          AND pb.clv_pct IS NOT NULL
          AND f.feature_value IS NOT NULL
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (feature_name, market_type))
        rows = cur.fetchall()
    fv = np.array([r["fv"] for r in rows], dtype=float)
    clv = np.array([r["clv"] for r in rows], dtype=float)
    return fv, clv


def analyse_feature_market(conn, market_type: str, feature_name: str) -> dict | None:
    fv, clv = fetch_bet_feature_clv(conn, market_type, feature_name)
    if len(fv) < MIN_BETS_PER_BUCKET:
        return None

    # Pearson correlation. Guard against zero-variance.
    if np.std(fv) == 0 or np.std(clv) == 0:
        pearson_r = None
    else:
        try:
            r, _p = pearsonr(fv, clv)
            pearson_r = float(r) if np.isfinite(r) else None
        except Exception:  # noqa: BLE001
            pearson_r = None

    # Top vs bottom decile CLV mean.
    q10 = float(np.quantile(fv, 0.10))
    q90 = float(np.quantile(fv, 0.90))
    bot_mask = fv <= q10
    top_mask = fv >= q90
    bot_n = int(np.sum(bot_mask))
    top_n = int(np.sum(top_mask))
    if bot_n < 10 or top_n < 10:
        return None
    bot_mean = float(np.mean(clv[bot_mask]))
    top_mean = float(np.mean(clv[top_mask]))
    incremental = top_mean - bot_mean

    return {
        "feature_name": feature_name,
        "market_type": market_type,
        "n_bets": int(len(fv)),
        "pearson_r": pearson_r,
        "top_decile_clv_mean": top_mean,
        "bot_decile_clv_mean": bot_mean,
        "incremental_clv": incremental,
        "feature_min": float(np.min(fv)),
        "feature_max": float(np.max(fv)),
        "feature_mean": float(np.mean(fv)),
    }


def upsert_attribution(conn, period_start: date, rec: dict) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO feature_attribution
              (period_start, feature_name, market_type, n_bets, pearson_r,
               top_decile_clv_mean, bot_decile_clv_mean, incremental_clv,
               feature_min, feature_max, feature_mean)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (period_start, feature_name, market_type) DO UPDATE
            SET n_bets = EXCLUDED.n_bets,
                pearson_r = EXCLUDED.pearson_r,
                top_decile_clv_mean = EXCLUDED.top_decile_clv_mean,
                bot_decile_clv_mean = EXCLUDED.bot_decile_clv_mean,
                incremental_clv = EXCLUDED.incremental_clv,
                feature_min = EXCLUDED.feature_min,
                feature_max = EXCLUDED.feature_max,
                feature_mean = EXCLUDED.feature_mean,
                computed_at = NOW()
            """,
            (
                period_start, rec["feature_name"], rec["market_type"],
                rec["n_bets"], rec["pearson_r"],
                rec["top_decile_clv_mean"], rec["bot_decile_clv_mean"],
                rec["incremental_clv"],
                rec["feature_min"], rec["feature_max"], rec["feature_mean"],
            ),
        )


def update_lifecycle(conn, feature_name: str, this_month_weak: bool) -> tuple[str, int]:
    """Update feature_lifecycle row for this feature. Returns (status, weak_months_count)."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT status, weak_months_count FROM feature_lifecycle WHERE feature_name = %s",
            (feature_name,),
        )
        row = cur.fetchone()

    if row is None:
        new_count = 1 if this_month_weak else 0
        new_status = "active"
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO feature_lifecycle
                  (feature_name, status, weak_months_count, last_evaluated_at)
                VALUES (%s, %s, %s, NOW())
                ON CONFLICT (feature_name) DO NOTHING
                """,
                (feature_name, new_status, new_count),
            )
        return new_status, new_count

    current_count = int(row["weak_months_count"])
    new_count = current_count + 1 if this_month_weak else 0
    new_status = row["status"]
    if new_count >= 3 and new_status == "active":
        new_status = "deprecated_candidate"
    elif not this_month_weak and new_status == "deprecated_candidate":
        # Recovered — back to active.
        new_status = "active"

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE feature_lifecycle
            SET status = %s, weak_months_count = %s, last_evaluated_at = NOW()
            WHERE feature_name = %s
            """,
            (new_status, new_count, feature_name),
        )
    return new_status, new_count


def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.error("DATABASE_URL not set")
        return 2

    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    period = period_start_first_of_month()
    log.info("Computing feature attribution for period_start=%s", period)

    # Market types with enough volume.
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT market_type, COUNT(*) AS n
            FROM paper_bets
            WHERE status IN ('won','lost') AND deleted_at IS NULL
              AND clv_pct IS NOT NULL
            GROUP BY market_type
            HAVING COUNT(*) >= 100
            ORDER BY n DESC
            """,
        )
        markets = [r["market_type"] for r in cur.fetchall()]
    log.info("Markets eligible: %s", markets)

    # Track per-feature weak-month flag (weak iff weak in ALL markets that had data).
    per_feature_weak: dict[str, list[bool]] = {f: [] for f in MONITORED_FEATURES}

    for mt in markets:
        for feat in MONITORED_FEATURES:
            rec = analyse_feature_market(conn, mt, feat)
            if rec is None:
                continue
            upsert_attribution(conn, period, rec)
            inc = abs(rec["incremental_clv"])
            pr = abs(rec["pearson_r"] or 0)
            is_weak = inc < WEAK_INCREMENTAL_CLV_THRESHOLD and pr < WEAK_PEARSON_THRESHOLD
            per_feature_weak[feat].append(is_weak)
            log.info(
                "%s × %s: n=%d r=%.3f incr=%.3fpp weak=%s",
                mt, feat, rec["n_bets"], rec["pearson_r"] or 0,
                rec["incremental_clv"], is_weak,
            )

    # Lifecycle update: feature is weak THIS MONTH iff weak in every market it appeared in.
    for feat, results in per_feature_weak.items():
        if not results:
            continue
        weak_overall = all(results)
        status, count = update_lifecycle(conn, feat, weak_overall)
        if status == "deprecated_candidate":
            log.warning("%s flagged as deprecated_candidate (%d weak months)", feat, count)
        else:
            log.info("%s status=%s weak_count=%d", feat, status, count)

    conn.commit()
    conn.close()
    log.info("Feature attribution complete for %s", period)
    return 0


if __name__ == "__main__":
    sys.exit(main())
