# §4.7 process isolation per cron domain — deferred

**Date:** 2026-05-08
**Status:** Deferred from the root-cause-fix bundle

## What this would look like

Split the api-server's 30+ scheduled jobs across 3 PM2 worker processes by
domain:

| Worker | Crons | Why isolated |
|---|---|---|
| `worker-ingestion` | data ingestion, betfair event mapping, exchange book sweep, oddspapi prefetch, line movement detection, AF predictions | Heaviest I/O traffic. Today's lineMovement event-loop saturation came from this lane. |
| `worker-trading` | trading_near, trading_far, settlement, value detection, commission attribution, gate monitor, bankroll-tier caps | Critical path. Must not be starved by ingestion noise. |
| `worker-analytics` | feature engineering, predictive power, correlation detection, ongoing audit, learning loop, metadata bundles | Heaviest CPU bursts (model retraining, feature recomputation). Won't lock up the trading lane. |

Each worker:
- Connects to the same Neon DB but with its own pool (cleaner connection accounting).
- Runs its own `node-cron` instance. node-cron's missed-execution warnings can no longer impact other workers.
- Crashes independently. PM2 restarts only the affected worker; trading keeps ticking even if ingestion goes down.
- Has its own pino log stream so the worker's logs are filterable.

Implementation sketch:
- New `artifacts/api-server/src/workers/` directory with `ingestion.ts`, `trading.ts`, `analytics.ts` entry points.
- Each entry point imports the relevant `start*Cron` functions from `services/scheduler.ts`.
- `scheduler.ts` stays as a registry; `index.ts` switches to dispatching by `WORKER_NAME` env var.
- PM2 ecosystem config (`ecosystem.config.cjs`) declares all 3 workers + `betfair-relay`.
- Migration `runMigrations()` runs only on `worker-trading`; the others wait for it via a startup gate.

## Why deferred

This is a 3-day refactor minimum. It touches every cron registration site, the PM2 deploy story, the logger configuration, and the connection-pool topology. Within today's bundle it:
- Cannot land in a single commit safely without extensive smoke testing
- Has a non-trivial risk of breaking cron registration ordering
- Has no immediate failure mode being prevented today (the other 6 fixes already neutralise the worst cases)

## When to revisit

After items §4.1–§4.6 have been in production for ~7 days and we have empirical evidence of:
- Whether the cron health monitor is actually catching outages within the alert windows
- Whether the lock-liveness wrapper has fired any auto-releases (indicating remaining deterministic hangs)
- Whether the query budget tests catch the next would-be regression

If those three checks reveal recurring lane-cross-contamination, ship §4.7. If they don't, defer indefinitely — the problem may be solved.

## Stub work done in this bundle

None of the worker-split structure is in this bundle. But the prerequisite infrastructure is:
- The cron health monitor table (`cron_stale_alert`) is per-job-name, so it works identically whether crons are colocated or split.
- The lock manager (`lib/lockManager.ts`) is in-process; if a cron moves to another worker its lock moves with it. No cross-process coordination required.
- The market-type registry is a pure data structure, agnostic to which worker invokes it.

In other words: §4.7 is a deployment refactor on top of correctly-built primitives, not a redesign. When ready, it becomes mostly mechanical.
