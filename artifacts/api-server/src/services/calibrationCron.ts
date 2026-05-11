/**
 * Task 12 — calibration cron wrapper.
 *
 * Spawns the Python fitter (scripts/python/fit_calibration.py) as a
 * child process. Inherits DATABASE_URL from the api-server env. After
 * the fit completes, invalidates the in-process calibration cache so
 * the new active buckets land on the hot path immediately rather than
 * waiting up to 5 min for the TTL.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { logger } from "../lib/logger";
import { invalidateCalibrationCache } from "./calibration";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const FITTER_SCRIPT = "scripts/python/fit_calibration.py";

export interface CalibrationFitResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
}

export async function runCalibrationFitter(): Promise<CalibrationFitResult> {
  const startedAt = Date.now();
  // Resolve relative to the repo root. The compiled api-server bundle
  // sits at artifacts/api-server/dist/index.mjs; process.cwd() depends
  // on how PM2 launched the worker. CALIBRATION_REPO_ROOT lets ops
  // override if needed; otherwise we fall back to cwd.
  const repoRoot = process.env["CALIBRATION_REPO_ROOT"] ?? process.cwd();
  const pythonBin = path.isAbsolute(PYTHON_BIN) ? PYTHON_BIN : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, FITTER_SCRIPT);

  logger.info({ pythonBin, scriptPath, repoRoot }, "Spawning calibration fitter");

  return new Promise<CalibrationFitResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      // Forward stdout to logger at info level — the Python script logs
      // one line per fitted bucket.
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "fit_calibration.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      // Cap buffer to ~16KB.
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "fit_calibration.py" }, trimmed);
    });

    child.on("error", (err) => {
      logger.error({ err, pythonBin, scriptPath }, "Failed to spawn calibration fitter");
      resolve({
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stderrTail: stderrBuf.slice(-2000),
      });
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        invalidateCalibrationCache();
        logger.info({ durationMs }, "Calibration fitter completed cleanly; cache invalidated");
      } else {
        logger.warn({ code, durationMs, stderrTail: stderrBuf.slice(-2000) }, "Calibration fitter exited non-zero");
      }
      resolve({
        exitCode: code ?? -1,
        durationMs,
        stderrTail: stderrBuf.slice(-2000),
      });
    });
  });
}
