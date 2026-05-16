#!/usr/bin/env python3
"""
Weekly calibration fitter — hierarchical Bayes per-league + global per market_type.

Bundle 1N (2026-05-16) — replaces per-league isotonic MLE with hierarchical
Bayes partial-pooling. The prior isotonic fitter was producing ECE 0.40-0.60
on small-n league buckets (Brasileiro Women n=32 ECE 0.50, Copa Colombia n=55
ECE 0.56, Liga Profesional Argentina n=64 ECE 0.56) — exactly the soft-edge
scopes where calibration honesty matters most. Hierarchical Bayes shrinks
small-n league fits toward the well-calibrated global pool (AH global ECE
0.028) via the partial-pooling prior, removing the discontinuous cold-start
cliff at n=MIN_SAMPLES_PER_BUCKET.

Model per market_type m:
    alpha_global_m ~ Normal(0, 1)
    beta_global_m  ~ Normal(1, 0.5)        # centred at identity (no correction)
    sigma_alpha    ~ HalfNormal(0.5)
    sigma_beta     ~ HalfNormal(0.3)
    For league j with bets:
        alpha_j ~ Normal(alpha_global, sigma_alpha)
        beta_j  ~ Normal(beta_global,  sigma_beta)
    Per bet i in league j:
        logit(p_cal) = alpha_j + beta_j * logit(p_raw)
        won ~ Bernoulli(p_cal)

Bucket write-back: each (league, market_type) gets a 20-point grid sampled
from posterior mean of (alpha_j, beta_j). Same {breakpoints, values} JSONB
shape as isotonic, so the Node-side calibration.ts read path is unchanged.
Method tag updated to 'hierarchical_bayes_logistic'.

Per-league monotonicity check: if posterior-mean grid is not monotonic-
increasing (rare — only if beta_j posterior has substantial mass below 0),
fall back to the global posterior grid for that league (full shrinkage).
Each fallback writes one compliance_logs.calibration_bucket_monotonicity_fallback
row for visibility.

Per-market_type isotonic fallback: if NUTS diverges or fails for a given
market_type, fall back to per-league isotonic MLE (the prior method) for
THAT market_type only. Other market_types' hierarchical fits proceed.

Orphan-bucket cleanup: at start of each market_type's fit, deactivate ALL
active buckets for that market_type. Buckets covered by the new fit get
fresh inserts; buckets with zero post-cutover samples (e.g. TEAM_TOTAL_*)
get no replacement — the calibration.ts read path returns null and the
model falls back to the raw probability. This cleans up the 5 stale AH
league buckets + 3 stale TEAM_TOTAL_* globals from 2026-05-11 that the
prior fitter left orphaned.

ANALYSIS_START_DATE = '2026-05-09' (post-cutover only — unchanged from
Bundle 1M; mixing pre-cutover paper-rail rows polluted the prior isotonic
fits because paper used a different model regime and staking logic).

Env: DATABASE_URL must be set (inherited from api-server child env).
"""

from __future__ import annotations

import json
import logging
import math
import os
import sys
from typing import Optional

import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s fit_calibration: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("fit_calibration")

# Per-league write threshold. Lowered from 30 (prior isotonic cliff) to 5
# because hierarchical Bayes shrinks small-n leagues toward the global pool;
# overfit is no longer the failure mode. Below this we still skip the per-
# league bucket write (the league falls back to global via Node read path) —
# but its data still informs the global posterior through the plate.
MIN_SAMPLES_PER_BUCKET = 5

# Global per-market_type write threshold. Unchanged — below this the global
# fit itself is too noisy to be useful, and the market_type stays calibration-
# orphan (Node read path returns null, model falls back to raw probability).
MIN_SAMPLES_PER_GLOBAL = 100

# Bundle 1M (2026-05-16): tightened from 2026-05-03 (which included 6 days
# of pre-cutover paper-track rows still labelled bet_track='paper') to
# 2026-05-09 (the cutover date). Pre-cutover paper was emitted under a
# different model regime AND different staking logic; mixing it with
# post-cutover shadow/live as a single training cohort leaves the fitter
# under-correcting the post-cutover MO over-confidence. Post-cutover MO
# residual bias (per Bundle 1M audit, 2026-05-16): -55pp at p>=0.70.
ANALYSIS_START_DATE = "2026-05-09"

# Hierarchical Bayes NUTS sampling parameters. Tuned for the Bundle 1N
# corpus size (~10K rows across ~65 leagues × 5 market_types). Larger
# samples don't materially improve posterior on this scale; chosen for
# ~5-10 min total runtime across all market_types.
NUM_WARMUP = 500
NUM_SAMPLES = 1000
NUM_CHAINS = 1

# Calibration grid: 20 evenly-spaced p_raw points across [0.025, 0.975].
# Values written as posterior mean of sigmoid(alpha_j + beta_j * logit(bp)).
# Node-side calibration.ts piecewise-linearly interpolates between these
# points at runtime — no read-path change required for Bundle 1N.
GRID_POINTS = 20
GRID_BREAKPOINTS = np.linspace(0.025, 0.975, GRID_POINTS)

# Logit/sigmoid clipping bound for numerical stability. logit(0) = -inf;
# clipping at [eps, 1-eps] keeps the model finite without materially
# distorting the calibration shape.
EPS = 1e-3


def fetch_settled(conn) -> list[dict]:
    """Pull all settled bets with a non-null model_probability.

    Bundle 1M (2026-05-16) fix: switched from psycopg2 %s parameter binding
    to f-string interpolation for ANALYSIS_START_DATE. The prior version
    raised psycopg2 IndexError on Python 3.12 because the em-dash and
    en-dash characters in the SQL comment block (lines below) were being
    miscounted by psycopg2's placeholder tokenizer, leading to a mismatch
    between detected %s count and provided params tuple size.
    ANALYSIS_START_DATE is a hardcoded module constant - zero injection
    risk from inline interpolation.
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
          AND pb.bet_track IN ('live', 'shadow')
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql)
        return list(cur.fetchall())


def fetch_active_buckets_by_market(conn) -> dict[str, list[tuple[Optional[str], int]]]:
    """Return {market_type: [(scope_league, bucket_id), ...]} for every active row.

    Used to drive the orphan-cleanup pass — every market_type with any active
    bucket gets a deactivate sweep before the new fit writes its replacements.
    Market_types with no post-cutover data leave no replacements behind, so
    their stale buckets become inactive permanently (calibration-orphan).
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT market_type, scope_league, bucket_id
              FROM calibration_buckets
             WHERE active = TRUE
            """
        )
        result: dict[str, list[tuple[Optional[str], int]]] = {}
        for market_type, scope_league, bucket_id in cur.fetchall():
            result.setdefault(market_type, []).append((scope_league, bucket_id))
        return result


def deactivate_all_for_market(conn, market_type: str) -> int:
    """Set active=FALSE on every active bucket for a market_type. Returns count."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE calibration_buckets
               SET active = FALSE
             WHERE market_type = %s
               AND active = TRUE
            """,
            (market_type,),
        )
        return cur.rowcount or 0


def _clip(p: np.ndarray) -> np.ndarray:
    return np.clip(p, EPS, 1.0 - EPS)


def _logit(p: np.ndarray) -> np.ndarray:
    p = _clip(p)
    return np.log(p / (1.0 - p))


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _split_80_20_per_league(
    league_idx: np.ndarray, n_leagues: int, seed: int = 42
) -> tuple[np.ndarray, np.ndarray]:
    """Per-league stratified 80/20 split. Returns (train_mask, test_mask)."""
    rng = np.random.default_rng(seed)
    train_mask = np.zeros(len(league_idx), dtype=bool)
    test_mask = np.zeros(len(league_idx), dtype=bool)
    for j in range(n_leagues):
        rows = np.where(league_idx == j)[0]
        if len(rows) == 0:
            continue
        # n=1 → all train; n=2..4 → 1 test; n>=5 → 20% test
        n_test = max(0, int(round(len(rows) * 0.2))) if len(rows) >= 5 else (1 if len(rows) >= 2 else 0)
        shuffled = rng.permutation(rows)
        test_mask[shuffled[:n_test]] = True
        train_mask[shuffled[n_test:]] = True
    return train_mask, test_mask


def _expected_calibration_error(probs: np.ndarray, outcomes: np.ndarray, n_bins: int = 10) -> float:
    """Equal-frequency-bin ECE on (probs, outcomes). NaN if probs is empty."""
    if len(probs) == 0:
        return float("nan")
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


def fit_hierarchical_bayes(
    market_rows: list[dict], market_type: str
) -> Optional[dict]:
    """Fit hierarchical Bayes logistic calibration for one market_type.

    Returns dict with keys:
        - league_buckets: list[{scope_league, n_samples, params, brier_in,
                                brier_out, ece_out, fell_back_to_global}]
        - global_bucket:  {n_samples, params, brier_in, brier_out, ece_out}
        - method: 'hierarchical_bayes_logistic'

    Returns None if the fit fails (caller falls back to isotonic).
    """
    import jax
    import jax.numpy as jnp
    import numpyro
    import numpyro.distributions as dist
    from numpyro.infer import MCMC, NUTS

    # Prep inputs. Use raw_prob when available (post-Phase-3b emissions);
    # fall back to model_prob (which equals raw for legacy uncalibrated rows).
    probs = np.array(
        [(r["raw_prob"] if r["raw_prob"] is not None else r["model_prob"]) for r in market_rows],
        dtype=np.float64,
    )
    outcomes = np.array([r["won"] for r in market_rows], dtype=np.float64)
    leagues = [r["league"] if r["league"] else "__UNKNOWN__" for r in market_rows]

    # Map leagues to dense integer indices. Sort for reproducibility.
    unique_leagues = sorted(set(leagues))
    league_to_idx = {lg: i for i, lg in enumerate(unique_leagues)}
    league_idx = np.array([league_to_idx[lg] for lg in leagues], dtype=np.int32)
    n_leagues = len(unique_leagues)

    # Per-league 80/20 split for held-out evaluation.
    train_mask, test_mask = _split_80_20_per_league(league_idx, n_leagues, seed=42)
    if train_mask.sum() < MIN_SAMPLES_PER_GLOBAL:
        log.warning("Market %s: training set too small (n=%d < %d) — skipping hierarchical fit",
                    market_type, train_mask.sum(), MIN_SAMPLES_PER_GLOBAL)
        return None

    probs_train = probs[train_mask]
    outcomes_train = outcomes[train_mask]
    league_idx_train = league_idx[train_mask]
    p_raw_logit_train = _logit(probs_train)

    def model(p_raw_logit, league_idx_, won, n_leagues_):
        alpha_global = numpyro.sample("alpha_global", dist.Normal(0.0, 1.0))
        beta_global = numpyro.sample("beta_global", dist.Normal(1.0, 0.5))
        sigma_alpha = numpyro.sample("sigma_alpha", dist.HalfNormal(0.5))
        sigma_beta = numpyro.sample("sigma_beta", dist.HalfNormal(0.3))
        with numpyro.plate("leagues", n_leagues_):
            alpha_j = numpyro.sample("alpha", dist.Normal(alpha_global, sigma_alpha))
            beta_j = numpyro.sample("beta", dist.Normal(beta_global, sigma_beta))
        # Per-bet calibration: alpha_j[k] + beta_j[k] * logit(raw)
        logits = alpha_j[league_idx_] + beta_j[league_idx_] * p_raw_logit
        numpyro.sample("won", dist.Bernoulli(logits=logits), obs=won)

    kernel = NUTS(model)
    mcmc = MCMC(
        kernel,
        num_warmup=NUM_WARMUP,
        num_samples=NUM_SAMPLES,
        num_chains=NUM_CHAINS,
        progress_bar=False,
    )
    try:
        mcmc.run(
            jax.random.PRNGKey(0),
            p_raw_logit=jnp.array(p_raw_logit_train),
            league_idx_=jnp.array(league_idx_train),
            won=jnp.array(outcomes_train),
            n_leagues_=n_leagues,
        )
    except Exception as e:
        log.warning("NUTS fit failed for %s: %s — falling back to isotonic", market_type, e)
        return None

    samples = mcmc.get_samples()
    alpha_post = np.array(samples["alpha"])         # (NUM_SAMPLES, n_leagues)
    beta_post = np.array(samples["beta"])           # (NUM_SAMPLES, n_leagues)
    alpha_global_post = np.array(samples["alpha_global"])  # (NUM_SAMPLES,)
    beta_global_post = np.array(samples["beta_global"])    # (NUM_SAMPLES,)

    # Global posterior-mean grid (used as fallback for non-monotonic leagues
    # AND written as the scope_league=NULL bucket).
    bp_logit = _logit(GRID_BREAKPOINTS)
    global_grid_samples = _sigmoid(
        alpha_global_post[:, None] + beta_global_post[:, None] * bp_logit[None, :]
    )  # (NUM_SAMPLES, GRID_POINTS)
    global_values = global_grid_samples.mean(axis=0)
    # Force monotonic (defensive — should be inherently monotonic given priors)
    global_values = np.maximum.accumulate(global_values)

    # Compute global brier/ECE on test set using the global model.
    p_raw_logit_test = _logit(probs[test_mask])
    outcomes_test = outcomes[test_mask]
    global_p_test = _sigmoid(
        alpha_global_post[:, None] + beta_global_post[:, None] * p_raw_logit_test[None, :]
    ).mean(axis=0)
    global_p_train = _sigmoid(
        alpha_global_post[:, None] + beta_global_post[:, None] * p_raw_logit_train[None, :]
    ).mean(axis=0)
    global_brier_in = float(np.mean((global_p_train - outcomes_train) ** 2))
    global_brier_out = float(np.mean((global_p_test - outcomes_test) ** 2)) if test_mask.sum() > 0 else float("nan")
    global_ece_out = _expected_calibration_error(global_p_test, outcomes_test, n_bins=10) if test_mask.sum() >= 10 else float("nan")

    league_buckets: list[dict] = []
    for j, league_name in enumerate(unique_leagues):
        if league_name == "__UNKNOWN__":
            continue  # don't write a row for null-league bets — they fall back to global
        league_rows_train = (league_idx_train == j)
        league_rows_test = (league_idx == j) & test_mask
        n_train = int(league_rows_train.sum())
        n_test = int(league_rows_test.sum())
        n_total = n_train + n_test
        if n_total < MIN_SAMPLES_PER_BUCKET:
            continue

        # Per-league posterior-mean grid.
        alpha_j_samples = alpha_post[:, j]   # (NUM_SAMPLES,)
        beta_j_samples = beta_post[:, j]
        grid_samples_j = _sigmoid(
            alpha_j_samples[:, None] + beta_j_samples[:, None] * bp_logit[None, :]
        )
        values_j = grid_samples_j.mean(axis=0)

        # Monotonicity check. If posterior-mean grid is not monotonic (which
        # happens iff beta_j has substantial mass on both signs), fall back
        # to writing the global grid for this league. Equivalent to full
        # shrinkage — the conservative choice.
        fell_back = False
        is_monotonic = bool(np.all(np.diff(values_j) >= -1e-6))
        if not is_monotonic:
            values_j = global_values
            fell_back = True

        # Per-league diagnostics. Brier_in on training fold, brier_out on
        # test fold. ECE on test if n_test >= 10 (else NaN — too noisy).
        if n_train > 0:
            p_train_j = _sigmoid(
                alpha_j_samples[:, None] + beta_j_samples[:, None]
                * _logit(probs[train_mask][league_rows_train])[None, :]
            ).mean(axis=0)
            brier_in_j = float(np.mean((p_train_j - outcomes_train[league_rows_train]) ** 2))
        else:
            brier_in_j = float("nan")
        if n_test > 0:
            p_test_j = _sigmoid(
                alpha_j_samples[:, None] + beta_j_samples[:, None]
                * _logit(probs[league_rows_test])[None, :]
            ).mean(axis=0)
            brier_out_j = float(np.mean((p_test_j - outcomes[league_rows_test]) ** 2))
            ece_out_j = _expected_calibration_error(p_test_j, outcomes[league_rows_test], n_bins=min(10, n_test)) if n_test >= 5 else float("nan")
        else:
            brier_out_j = float("nan")
            ece_out_j = float("nan")

        league_buckets.append({
            "scope_league": league_name,
            "n_samples": n_total,
            "params": {"breakpoints": GRID_BREAKPOINTS.tolist(), "values": values_j.tolist()},
            "brier_in": brier_in_j,
            "brier_out": brier_out_j,
            "ece_out": ece_out_j,
            "fell_back_to_global": fell_back,
        })

    n_total_global = int(train_mask.sum() + test_mask.sum())
    global_bucket = {
        "scope_league": None,
        "n_samples": n_total_global,
        "params": {"breakpoints": GRID_BREAKPOINTS.tolist(), "values": global_values.tolist()},
        "brier_in": global_brier_in,
        "brier_out": global_brier_out,
        "ece_out": global_ece_out,
        "fell_back_to_global": False,
    }

    return {
        "method": "hierarchical_bayes_logistic",
        "league_buckets": league_buckets,
        "global_bucket": global_bucket,
    }


def fit_isotonic_per_league(
    market_rows: list[dict], market_type: str
) -> Optional[dict]:
    """Per-market_type fallback: per-league isotonic MLE (the prior method).

    Used only when fit_hierarchical_bayes returns None (e.g. NUTS diverged,
    JAX exception, etc.). Preserves the pre-Bundle-1N behavior for that
    market_type so the whole fitter run doesn't get blocked by one bad fit.
    """
    from sklearn.isotonic import IsotonicRegression

    by_league: dict[Optional[str], list[dict]] = {}
    for r in market_rows:
        lg = r["league"]
        by_league.setdefault(lg, []).append(r)

    def _fit_one(rows: list[dict]) -> Optional[dict]:
        probs = np.array(
            [(r["raw_prob"] if r["raw_prob"] is not None else r["model_prob"]) for r in rows],
            dtype=np.float64,
        )
        outcomes = np.array([r["won"] for r in rows], dtype=np.float64)
        if len(probs) < 30:  # original isotonic threshold (stability)
            return None
        rng = np.random.default_rng(42)
        idx = rng.permutation(len(probs))
        cut = int(len(probs) * 0.8)
        tr, te = idx[:cut], idx[cut:]
        model = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        model.fit(probs[tr], outcomes[tr])
        p_te = model.predict(probs[te])
        brier_in = float(np.mean((probs[tr] - outcomes[tr]) ** 2))
        brier_out = float(np.mean((p_te - outcomes[te]) ** 2))
        ece_out = _expected_calibration_error(p_te, outcomes[te], n_bins=10)
        breakpoints = model.X_thresholds_.astype(float).tolist()
        values = model.y_thresholds_.astype(float).tolist()
        return {
            "n_samples": len(probs),
            "params": {"breakpoints": breakpoints, "values": values},
            "brier_in": brier_in,
            "brier_out": brier_out,
            "ece_out": ece_out,
        }

    league_buckets: list[dict] = []
    for lg, rows in sorted((k, v) for k, v in by_league.items() if k is not None):
        b = _fit_one(rows)
        if b is None:
            continue
        league_buckets.append({**b, "scope_league": lg, "fell_back_to_global": False})

    global_b = _fit_one(market_rows) if len(market_rows) >= MIN_SAMPLES_PER_GLOBAL else None
    if global_b is None:
        return None
    global_bucket = {**global_b, "scope_league": None, "fell_back_to_global": False}

    return {
        "method": "isotonic",
        "league_buckets": league_buckets,
        "global_bucket": global_bucket,
    }


def _f(x: float) -> Optional[float]:
    """NaN-safe JSON-ready float. Postgres NUMERIC accepts NULL but not NaN."""
    return None if (x is None or (isinstance(x, float) and math.isnan(x))) else float(x)


def write_bucket(
    conn,
    scope_league: Optional[str],
    market_type: str,
    method: str,
    n_samples: int,
    params: dict,
    brier_in: float,
    brier_out: float,
    ece_out: float,
) -> int:
    """Insert one new active row. Caller deactivates prior actives separately."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO calibration_buckets
              (scope_league, market_type, method, n_samples, params,
               brier_in, brier_out, ece_out, active)
            VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, TRUE)
            RETURNING bucket_id
            """,
            (scope_league, market_type, method, n_samples, json.dumps(params),
             _f(brier_in), _f(brier_out), _f(ece_out)),
        )
        return cur.fetchone()[0]


def log_monotonicity_fallback(conn, scope_league: str, market_type: str) -> None:
    """Write one compliance_logs row when a league falls back to global grid.

    Bundle 1N visibility for the rare case where beta_j posterior has enough
    mass below 0 to make the posterior-mean grid non-monotonic — in which
    case we use the global grid for that league. Operator sees frequency
    of these via:
        SELECT details->>'marketType', details->>'scopeLeague', COUNT(*)
          FROM compliance_logs
         WHERE action_type = 'calibration_bucket_monotonicity_fallback'
           AND timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY 1, 2 ORDER BY 3 DESC;
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO compliance_logs (action_type, details)
            VALUES ('calibration_bucket_monotonicity_fallback', %s::jsonb)
            """,
            (json.dumps({"marketType": market_type, "scopeLeague": scope_league}),),
        )


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
        log.warning("No settled rows - nothing to fit")
        return 0

    # Group rows by market_type.
    by_market: dict[str, list[dict]] = {}
    for r in rows:
        by_market.setdefault(r["market_type"], []).append(r)

    # Snapshot of every active bucket for orphan-cleanup. Any market_type
    # with active buckets but zero post-cutover data ends up with all its
    # buckets deactivated and no replacements (calibration-orphan).
    active_buckets = fetch_active_buckets_by_market(conn)
    all_market_types = sorted(set(active_buckets.keys()) | set(by_market.keys()))

    summary = {
        "market_types_processed": 0,
        "market_types_orphaned": 0,
        "market_types_hierarchical": 0,
        "market_types_isotonic_fallback": 0,
        "buckets_written": 0,
        "monotonicity_fallbacks": 0,
    }

    for market_type in all_market_types:
        prior_active = len(active_buckets.get(market_type, []))
        deactivated = deactivate_all_for_market(conn, market_type)
        market_rows = by_market.get(market_type, [])

        # Orphan branch — no post-cutover data for this market_type.
        if not market_rows or len(market_rows) < MIN_SAMPLES_PER_GLOBAL:
            log.info("Market %s: %d active buckets deactivated; %d post-cutover rows (< %d global threshold) — left calibration-orphan",
                     market_type, deactivated, len(market_rows), MIN_SAMPLES_PER_GLOBAL)
            summary["market_types_orphaned"] += 1
            continue

        log.info("Market %s: %d post-cutover rows across %d leagues — fitting hierarchical Bayes",
                 market_type, len(market_rows),
                 len(set(r["league"] for r in market_rows if r["league"])))

        result = fit_hierarchical_bayes(market_rows, market_type)
        if result is None:
            log.warning("Market %s: hierarchical fit unsuccessful — falling back to per-league isotonic",
                        market_type)
            result = fit_isotonic_per_league(market_rows, market_type)
            if result is None:
                log.error("Market %s: isotonic fallback also failed — market left calibration-orphan",
                          market_type)
                summary["market_types_orphaned"] += 1
                continue
            summary["market_types_isotonic_fallback"] += 1
        else:
            summary["market_types_hierarchical"] += 1
        summary["market_types_processed"] += 1

        method = result["method"]
        global_b = result["global_bucket"]
        write_bucket(conn, None, market_type, method,
                     global_b["n_samples"], global_b["params"],
                     global_b["brier_in"], global_b["brier_out"], global_b["ece_out"])
        summary["buckets_written"] += 1
        log.info("Market %s: GLOBAL bucket n=%d brier_in=%.4f brier_out=%.4f ece=%.4f method=%s",
                 market_type, global_b["n_samples"],
                 global_b["brier_in"] or float("nan"),
                 global_b["brier_out"] or float("nan"),
                 global_b["ece_out"] or float("nan"),
                 method)

        for lb in result["league_buckets"]:
            if lb["fell_back_to_global"]:
                summary["monotonicity_fallbacks"] += 1
                log_monotonicity_fallback(conn, lb["scope_league"], market_type)
            write_bucket(conn, lb["scope_league"], market_type, method,
                         lb["n_samples"], lb["params"],
                         lb["brier_in"], lb["brier_out"], lb["ece_out"])
            summary["buckets_written"] += 1

    conn.commit()
    conn.close()
    log.info("Done. summary=%s", summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
