# Python sidecars

Spawned by the api-server's cron registry (`services/scheduler.ts`) as
child processes. All read `DATABASE_URL` from the inherited env; all
return non-zero on error so the wrapper logs it.

## Scripts

| Script | Schedule (UTC) | Tables written |
|---|---|---|
| `fit_calibration.py` | Mon 04:00 | `calibration_buckets` |
| `fit_dixon_coles.py` | Mon 05:00 | `scoreline_correlation`, `model_layer_enabled` |
| `scrape_team_form.py` | **disabled 2026-05-15** — FBref blocks Selenium | manual admin endpoint only; pivoting to xg_match_data aggregation |
| `scrape_fotmob_women.py` | **disabled 2026-05-15** — soccerdata 1.9 dropped FotMob | manual admin endpoint only |
| `ingest_statsbomb_women.py` | manual (per-season) | `xg_match_data` source='statsbomb' (NWSL, FAWSL, Women's WC, Women's Euro — direct HTTP, no Selenium) |
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

## Phase 2a — FBref scraper needs Chrome

The first Phase 2a run failed with `Exception: Chrome not found!
Install it first!`. soccerdata's FBref reader uses Selenium via
seleniumbase to bypass FBref's bot detection — both Chrome the
browser AND chromedriver are required.

Install on the VPS (Debian/Ubuntu):

```bash
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update && sudo apt-get install -y google-chrome-stable
# chromedriver is auto-managed by seleniumbase on first run.
```

Adds ~200 MB. Alternatively, use chromium from the default repos:

```bash
sudo apt-get install -y chromium-browser
```

(Slightly smaller but seleniumbase's defaults expect google-chrome.)

FotMob, ESPN, Understat, Football-Data.co.uk readers do NOT need
Chrome — they're plain HTTPS scrapers. Only FBref / WhoScored /
Sofascore need it.

## Manual trigger

Each script has a matching admin endpoint on the api-server:

```bash
curl -X POST http://localhost:8080/api/admin/run-calibration-fitter
curl -X POST http://localhost:8080/api/admin/run-dixon-coles-fitter
```
