# Python sidecars

Spawned by the api-server's cron registry (`services/scheduler.ts`) as
child processes. All read `DATABASE_URL` from the inherited env; all
return non-zero on error so the wrapper logs it.

## Scripts

| Script | Schedule (UTC) | Tables written |
|---|---|---|
| `fit_calibration.py` | Mon 04:00 | `calibration_buckets` |
| `fit_dixon_coles.py` | Mon 05:00 | `scoreline_correlation`, `model_layer_enabled` |
| `shap_drift.py` | Daily 03:30 | `shap_drift_runs` |
| `feature_attribution.py` | 1st of month 04:30 | `feature_attribution`, `feature_lifecycle` |
| `compute_market_correlations.py` | 1st of month 04:45 | `market_correlation_matrix` |

## Setup on the VPS

```bash
cd ~/Football-betting-agent
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r scripts/python/requirements.txt
```

After updating `requirements.txt` (e.g. adding `penaltyblog` + `numpyro`
in Phase 1b), re-run the `pip install -r` step before the next cron
tick fires. The api-server `CALIBRATION_PYTHON` env var points at
`.venv/bin/python` by default.

## Phase 1b dependency footprint

`numpyro` pulls in `jax` + `jaxlib` (~600 MB combined). On a 4 GB VPS
this is fine inside `.venv`, but allow ~700 MB of free disk before the
install. The fit script itself runs CPU-only and uses < 200 MB RAM at
peak (a few hundred scopes × 1000 NUTS samples).

## Manual trigger

Each script has a matching admin endpoint on the api-server:

```bash
curl -X POST http://localhost:8080/api/admin/run-calibration-fitter
curl -X POST http://localhost:8080/api/admin/run-dixon-coles-fitter
```
