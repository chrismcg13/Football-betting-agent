/**
 * Task 13 — market correlation cron wrapper.
 *
 * Spawns scripts/python/compute_market_correlations.py. Same pattern
 * as calibrationCron / shapDriftCron / featureAttributionCron.
 *
 * Schedule: monthly on the 1st at 04:45 UTC, after the feature
 * attribution job (04:30) so attribution + correlation refresh land
 * in the same monthly batch.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { logger } from "../lib/logger";
import { invalidateCorrelationCache } from "./portfolioKelly";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const SCRIPT = "scripts/python/compute_market_correlations.py";

export interface MarketCorrelationResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
}

export async function runMarketCorrelations(): Promise<MarketCorrelationResult> {
  const startedAt = Date.now();
  const repoRoot = process.env["CALIBRATION_REPO_ROOT"] ?? process.cwd();
  const pythonBin = path.isAbsolute(PYTHON_BIN) ? PYTHON_BIN : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, SCRIPT);

  logger.info({ pythonBin, scriptPath, repoRoot }, "Spawning market correlation computation");

  return new Promise<MarketCorrelationResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "compute_market_correlations.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "compute_market_correlations.py" }, trimmed);
    });

    child.on("error", (err) => {
      logger.error({ err, pythonBin, scriptPath }, "Failed to spawn compute_market_correlations.py");
      resolve({ exitCode: -1, durationMs: Date.now() - startedAt, stderrTail: stderrBuf.slice(-2000) });
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        invalidateCorrelationCache();
        logger.info({ durationMs }, "Market correlations computed; portfolio-Kelly cache invalidated");
      } else {
        logger.warn({ code, durationMs, stderrTail: stderrBuf.slice(-2000) }, "Market correlations exited non-zero");
      }
      resolve({ exitCode: code ?? -1, durationMs, stderrTail: stderrBuf.slice(-2000) });
    });
  });
}
