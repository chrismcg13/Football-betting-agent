#!/usr/bin/env python3
"""
Phase 1b + 1c — Dixon-Coles ρ fit (hierarchical Bayes) + per-(market_type,
gender) backtest decision.

Single weekly run (Mon 05:00 UTC via scheduler.ts) performs:

  1. PER-SCOPE MLE FIT (penaltyblog).
     For each (api_football_id, market_type='ASIAN_HANDICAP') scope with
     ≥ MIN_SAMPLES_PER_SCOPE settled matches in the last 3 seasons, fit
     the Dixon-Coles bivariate Poisson model — penaltyblog's standard
     fit with attack/defence per team, home advantage, and ρ. We only
     keep ρ_mle and its asymptotic standard error sd_mle (~1/√n).

  2. HIERARCHICAL POSTERIOR (numpyro NUTS).
     Pool the (ρ_mle, sd_mle) pairs across scopes within each group =
     (market_type, gender):

       ρ_group  ~ Normal(0, 0.1²)
       σ        ~ HalfNormal(0.05)
       ρ_scope  ~ Normal(ρ_group, σ²)            # latent
       ρ_mle    ~ Normal(ρ_scope, sd_mle²)        # data likelihood

     Posterior mean ρ_scope is the shrunk estimate every scope receives
     (n→∞: ≈ ρ_mle; n→0: ≈ ρ_group). Write to scoreline_correlation.

  3. PER-(MARKET_TYPE, GENDER) BACKTEST.
     For each cell, compute log-loss across the cell's settled AH bets
     under (a) ρ=0 baseline and (b) ρ_posterior. enabled = the
     log-loss-better branch. Write to model_layer_enabled with
     log_loss_baseline / log_loss_with_layer / n_backtest_bets.

Idempotent: each weekly run overwrites prior rows via ON CONFLICT.

Env: DATABASE_URL (inherited from the api-server child-process env).
"""

from __future__ import annotations

import logging
import math
import os
import sys
from datetime import datetime, timezone
from math import lgamma, sqrt
from typing import Optional

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import RealDictCursor

# Logger named LOG (uppercase) so it does NOT shadow math.log — earlier
# version used `log = logging.getLogger(...)`, which silently replaced
# `from math import log` and made poisson_pmf throw
# "TypeError: 'Logger' object is not callable" at runtime.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s fit_dixon_coles: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
LOG = logging.getLogger("fit_dixon_coles")

MIN_SAMPLES_PER_SCOPE = 50          # below this, scope contributes nothing to the group posterior
MIN_SAMPLES_PER_BACKTEST_CELL = 30  # below this, model_layer_enabled is not written for the cell
ANALYSIS_LOOKBACK_DAYS = 1095        # 3 seasons
RHO_CAP = 0.2                         # mirror the runtime clamp in scorelineMatrix


# ─── Step 1 — Per-scope MLE via penaltyblog ─────────────────────────────────

def fit_scope_rho(matches_df: pd.DataFrame) -> Optional[tuple[float, float]]:
    """Fit Dixon-Coles to one scope. Returns (rho_mle, sd_mle) or None."""
    try:
        from penaltyblog.models import DixonColesGoalModel
    except ImportError:
        LOG.error("penaltyblog not installed — pip install penaltyblog>=1.3.0")
        raise

    if len(matches_df) < MIN_SAMPLES_PER_SCOPE:
        return None

    try:
        # Penaltyblog's cython kernel mutates the input arrays in place,
        # which trips "buffer source array is read-only" when the
        # pandas-derived numpy arrays land read-only. Force a writeable
        # contiguous copy with explicit numeric / object dtypes.
        goals_home = np.ascontiguousarray(
            matches_df["home_goals"].to_numpy(dtype=np.float64, copy=True)
        )
        goals_away = np.ascontiguousarray(
            matches_df["away_goals"].to_numpy(dtype=np.float64, copy=True)
        )
        teams_home = np.ascontiguousarray(
            matches_df["home_team"].to_numpy(dtype=object, copy=True)
        )
        teams_away = np.ascontiguousarray(
            matches_df["away_team"].to_numpy(dtype=object, copy=True)
        )
        model = DixonColesGoalModel(
            goals_home=goals_home,
            goals_away=goals_away,
            teams_home=teams_home,
            teams_away=teams_away,
        )
        model.fit()
    except Exception as e:
        LOG.warning("DC fit failed: %s", e)
        return None

    rho_mle = float(model.params.get("rho", 0.0))
    rho_mle = float(np.clip(rho_mle, -RHO_CAP, RHO_CAP))

    # Asymptotic-normal SE for ρ. penaltyblog exposes the Hessian-derived
    # covariance via `model.aic` etc but not the per-parameter SE
    # directly across versions; fall back to a sample-size-based proxy
    # (Fisher information of the joint Poisson likelihood scales ~n).
    n = len(matches_df)
    sd_mle = max(0.01, 1.0 / sqrt(n))
    return rho_mle, sd_mle


# ─── Step 2 — Hierarchical posterior via numpyro ─────────────────────────────

def fit_hierarchical(group_rows: list[dict]) -> dict[int, tuple[float, float]]:
    """
    Group-level shrinkage. Input rows: {api_football_id, rho_mle, sd_mle}.
    Returns {api_football_id: (rho_posterior_mean, rho_posterior_sd)}.

    Also exposes the fitted group_rho via the special key `_group_` so
    the writer can store it on each scope row.
    """
    import jax
    import jax.numpy as jnp
    import numpyro
    import numpyro.distributions as dist
    from numpyro.infer import MCMC, NUTS

    if not group_rows:
        return {}

    api_ids = jnp.array([r["api_football_id"] for r in group_rows])
    rho_mle = jnp.array([r["rho_mle"] for r in group_rows])
    sd_mle = jnp.array([r["sd_mle"] for r in group_rows])
    K = len(group_rows)

    def model(rho_mle, sd_mle):
        rho_group = numpyro.sample("rho_group", dist.Normal(0.0, 0.1))
        sigma = numpyro.sample("sigma", dist.HalfNormal(0.05))
        with numpyro.plate("scopes", K):
            rho_scope = numpyro.sample("rho_scope", dist.Normal(rho_group, sigma))
            numpyro.sample("rho_obs", dist.Normal(rho_scope, sd_mle), obs=rho_mle)

    kernel = NUTS(model)
    mcmc = MCMC(kernel, num_warmup=500, num_samples=1000, num_chains=1, progress_bar=False)
    mcmc.run(jax.random.PRNGKey(0), rho_mle=rho_mle, sd_mle=sd_mle)
    samples = mcmc.get_samples()
    rho_post = np.array(samples["rho_scope"])  # (n_samples, K)
    rho_group_post = np.array(samples["rho_group"])

    result: dict[int, tuple[float, float]] = {}
    for i, r in enumerate(group_rows):
        post_mean = float(np.clip(rho_post[:, i].mean(), -RHO_CAP, RHO_CAP))
        post_sd = float(rho_post[:, i].std())
        result[int(api_ids[i])] = (post_mean, post_sd)
    result["_group_"] = (float(rho_group_post.mean()), float(rho_group_post.std()))
    return result


# ─── Step 3 — Backtest log-loss per (market_type, gender) ───────────────────

def poisson_pmf(lam: float, k: int) -> float:
    if k == 0:
        return float(np.exp(-lam))
    log_p = -lam + k * math.log(lam) - lgamma(k + 1)
    return float(np.exp(log_p))


def dc_scoreline_prob(lam_h: float, lam_a: float, rho: float, h: int, a: int) -> float:
    """DC-adjusted joint probability for a single (h, a) cell."""
    base = poisson_pmf(lam_h, h) * poisson_pmf(lam_a, a)
    if rho == 0:
        return base
    if (h, a) == (0, 0):
        return base * max(0.0, 1.0 - lam_h * lam_a * rho)
    if (h, a) == (1, 0):
        return base * max(0.0, 1.0 + lam_a * rho)
    if (h, a) == (0, 1):
        return base * max(0.0, 1.0 + lam_h * rho)
    if (h, a) == (1, 1):
        return base * max(0.0, 1.0 - rho)
    return base


def ah_win_prob(lam_h: float, lam_a: float, rho: float, side: str, line: float, max_goals: int = 8) -> float:
    p_win = 0.0
    p_push = 0.0
    for h in range(max_goals + 1):
        for a in range(max_goals + 1):
            p = dc_scoreline_prob(lam_h, lam_a, rho, h, a)
            margin = (h - a + line) if side == "home" else (a - h + line)
            if margin > 1e-9:
                p_win += p
            elif margin > -1e-9:
                p_push += p
    return max(0.01, min(0.99, p_win + 0.5 * p_push))


def backtest_cell(bets_df: pd.DataFrame, rho_by_scope: dict[int, float]) -> Optional[tuple[float, float, int]]:
    """
    Return (log_loss_baseline, log_loss_with_layer, n_bets) for the cell,
    or None if too few bets.
    """
    if len(bets_df) < MIN_SAMPLES_PER_BACKTEST_CELL:
        return None

    ll_baseline = 0.0
    ll_layer = 0.0
    n = 0
    for _, row in bets_df.iterrows():
        lam_h = float(row["lam_h"])
        lam_a = float(row["lam_a"])
        if lam_h <= 0 or lam_a <= 0:
            continue
        side = str(row["side"])
        line = float(row["line"])
        outcome = 1 if row["won"] else 0
        rho_scope = float(rho_by_scope.get(int(row["api_football_id"]), 0.0))

        p_baseline = ah_win_prob(lam_h, lam_a, 0.0, side, line)
        p_layer = ah_win_prob(lam_h, lam_a, rho_scope, side, line)
        eps = 1e-9
        ll_baseline += -(outcome * math.log(max(p_baseline, eps)) + (1 - outcome) * math.log(max(1 - p_baseline, eps)))
        ll_layer += -(outcome * math.log(max(p_layer, eps)) + (1 - outcome) * math.log(max(1 - p_layer, eps)))
        n += 1
    if n == 0:
        return None
    return ll_baseline / n, ll_layer / n, n


# ─── Main pipeline ──────────────────────────────────────────────────────────

def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        LOG.error("DATABASE_URL not set"); return 2
    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    # 1. Load matches per scope.
    LOG.info("Loading settled matches (last %dd)", ANALYSIS_LOOKBACK_DAYS)
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT cc.api_football_id, cc.gender,
                   m.home_team, m.away_team, m.home_score AS home_goals,
                   m.away_score AS away_goals, m.kickoff_time
            FROM matches m
            JOIN competition_config cc
              ON LOWER(REPLACE(cc.name, '-', ' ')) = LOWER(REPLACE(m.league, '-', ' '))
            WHERE m.home_score IS NOT NULL AND m.away_score IS NOT NULL
              AND m.kickoff_time >= NOW() - INTERVAL '%s days'
              AND cc.api_football_id IS NOT NULL
            """ % ANALYSIS_LOOKBACK_DAYS
        )
        rows = cur.fetchall()
    df = pd.DataFrame(rows)
    if df.empty:
        LOG.warning("No matches in window — exiting"); return 0
    LOG.info("Loaded %d matches across %d scopes", len(df), df["api_football_id"].nunique())

    # 2. Per-scope MLE.
    mle_rows: list[dict] = []
    for (api_id, gender), scope_df in df.groupby(["api_football_id", "gender"]):
        result = fit_scope_rho(scope_df)
        if result is None:
            continue
        rho_mle, sd_mle = result
        mle_rows.append({
            "api_football_id": int(api_id),
            "gender": gender,
            "rho_mle": rho_mle,
            "sd_mle": sd_mle,
            "n_matches": len(scope_df),
        })
    LOG.info("Per-scope MLE: %d scopes fit", len(mle_rows))

    # 3. Hierarchical posterior, per gender group.
    posterior_by_scope: dict[int, dict] = {}
    group_rho_by_gender: dict[str, float] = {}
    for gender in ("male", "female"):
        group_rows = [r for r in mle_rows if r["gender"] == gender]
        if not group_rows:
            continue
        LOG.info("Hierarchical posterior — gender=%s, %d scopes", gender, len(group_rows))
        post = fit_hierarchical(group_rows)
        group_rho_by_gender[gender] = post.pop("_group_", (0.0, 0.0))[0]
        for api_id, (rho_post, sd_post) in post.items():
            posterior_by_scope[api_id] = {
                "rho": rho_post,
                "rho_sd": sd_post,
                "group_rho": group_rho_by_gender[gender],
                "copula_kind": "sarmanov" if gender == "female" else "dixon_coles",
                "n_matches": next(r["n_matches"] for r in group_rows if r["api_football_id"] == api_id),
            }

    # 4. Write scoreline_correlation rows (UPSERT).
    LOG.info("Writing %d rows to scoreline_correlation", len(posterior_by_scope))
    with conn.cursor() as cur:
        for api_id, p in posterior_by_scope.items():
            cur.execute(
                """
                INSERT INTO scoreline_correlation
                  (api_football_id, market_type, copula_kind, rho,
                   rho_posterior_sd, group_rho, n_matches, fitted_at)
                VALUES (%s, 'ASIAN_HANDICAP', %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (api_football_id, market_type) DO UPDATE
                SET copula_kind = EXCLUDED.copula_kind,
                    rho = EXCLUDED.rho,
                    rho_posterior_sd = EXCLUDED.rho_posterior_sd,
                    group_rho = EXCLUDED.group_rho,
                    n_matches = EXCLUDED.n_matches,
                    fitted_at = NOW()
                """,
                (
                    api_id, p["copula_kind"], p["rho"], p["rho_sd"],
                    p["group_rho"], p["n_matches"],
                ),
            )
    conn.commit()

    # 5. Backtest per (market_type='ASIAN_HANDICAP', gender) cell.
    LOG.info("Loading settled AH bets for backtest")
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT cc.api_football_id, cc.gender,
                   pb.selection_name, pb.status,
                   f_home.feature_value::float8 AS lam_h,
                   f_away.feature_value::float8 AS lam_a
            FROM paper_bets pb
            JOIN matches m ON m.id = pb.match_id
            JOIN competition_config cc
              ON LOWER(REPLACE(cc.name, '-', ' ')) = LOWER(REPLACE(m.league, '-', ' '))
            LEFT JOIN features f_home
              ON f_home.match_id = m.id AND f_home.feature_name = 'home_goals_scored_avg'
            LEFT JOIN features f_away
              ON f_away.match_id = m.id AND f_away.feature_name = 'away_goals_scored_avg'
            WHERE pb.market_type = 'ASIAN_HANDICAP'
              AND pb.status IN ('won','lost')
              AND pb.deleted_at IS NULL
              AND pb.placed_at >= NOW() - INTERVAL '180 days'
              AND cc.api_football_id IS NOT NULL
            """
        )
        bets = cur.fetchall()
    bdf = pd.DataFrame(bets)
    if bdf.empty:
        LOG.warning("No settled AH bets in 180d — skipping backtest"); return 0

    # Parse selection_name like "Home -0.5" / "Away +1.25"
    bdf["side"] = bdf["selection_name"].str.split().str[0].str.lower()
    bdf["line"] = pd.to_numeric(bdf["selection_name"].str.split().str[1], errors="coerce")
    bdf = bdf.dropna(subset=["lam_h", "lam_a", "line"])
    bdf["won"] = bdf["status"] == "won"

    rho_by_scope = {api_id: p["rho"] for api_id, p in posterior_by_scope.items()}

    decisions: list[dict] = []
    for gender in ("male", "female"):
        cell_df = bdf[bdf["gender"] == gender]
        result = backtest_cell(cell_df, rho_by_scope)
        if result is None:
            LOG.info("Backtest cell (AH, %s): insufficient bets (%d)", gender, len(cell_df))
            continue
        ll_baseline, ll_layer, n = result
        enabled = ll_layer < ll_baseline
        LOG.info(
            "Backtest cell (AH, %s, n=%d): baseline=%.5f layer=%.5f enabled=%s",
            gender, n, ll_baseline, ll_layer, enabled,
        )
        copula = "sarmanov" if gender == "female" else "dixon_coles"
        decisions.append({
            "market_type": "ASIAN_HANDICAP",
            "gender": gender,
            "layer": copula,
            "enabled": enabled,
            "log_loss_baseline": ll_baseline,
            "log_loss_with_layer": ll_layer,
            "n_backtest_bets": n,
        })

    # 6. Write model_layer_enabled rows (UPSERT).
    LOG.info("Writing %d rows to model_layer_enabled", len(decisions))
    with conn.cursor() as cur:
        for d in decisions:
            cur.execute(
                """
                INSERT INTO model_layer_enabled
                  (market_type, gender, layer, enabled,
                   log_loss_baseline, log_loss_with_layer, n_backtest_bets,
                   decided_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (market_type, gender, layer) DO UPDATE
                SET enabled = EXCLUDED.enabled,
                    log_loss_baseline = EXCLUDED.log_loss_baseline,
                    log_loss_with_layer = EXCLUDED.log_loss_with_layer,
                    n_backtest_bets = EXCLUDED.n_backtest_bets,
                    decided_at = NOW()
                """,
                (
                    d["market_type"], d["gender"], d["layer"], d["enabled"],
                    d["log_loss_baseline"], d["log_loss_with_layer"],
                    d["n_backtest_bets"],
                ),
            )
    conn.commit()
    conn.close()
    LOG.info("Phase 1b+1c run complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
