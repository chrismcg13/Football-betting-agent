/**
 * Phase 1b + 1c (2026-05-14) — Dixon-Coles ρ hierarchical-Bayes fit
 * cron wrapper. Mirrors the calibrationCron.ts pattern: spawn the
 * Python sidecar (scripts/python/fit_dixon_coles.py), stream stdout/
 * stderr through pino, return exit code + stderr tail.
 *
 * The Python script performs per-scope MLE via penaltyblog, then
 * pools into a hierarchical posterior via numpyro NUTS, then
 * back-tests per (market_type, gender) cell. Two table writes:
 * scoreline_correlation (per-scope ρ) and model_layer_enabled (cell
 * on/off + log-loss provenance). Both idempotent.
 *
 * Schedule: weekly Mon 05:00 UTC (after the calibration fitter at
 * 04:00). The runtime reads both tables with a 60s cache via
 * services/dixonColes.ts.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const FITTER_SCRIPT = "scripts/python/fit_dixon_coles.py";

export interface DixonColesFitResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
}

export async function runDixonColesFitter(): Promise<DixonColesFitResult> {
  const startedAt = Date.now();
  const repoRoot = process.env["CALIBRATION_REPO_ROOT"] ?? process.cwd();
  const pythonBin = path.isAbsolute(PYTHON_BIN)
    ? PYTHON_BIN
    : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, FITTER_SCRIPT);

  logger.info({ pythonBin, scriptPath, repoRoot }, "Spawning Dixon-Coles fitter");

  return new Promise<DixonColesFitResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "fit_dixon_coles.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "fit_dixon_coles.py" }, trimmed);
    });

    child.on("error", (err) => {
      logger.error({ err, pythonBin, scriptPath }, "Failed to spawn Dixon-Coles fitter");
      resolve({
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stderrTail: stderrBuf.slice(-2000),
      });
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        logger.info({ durationMs }, "Dixon-Coles fitter completed cleanly");
      } else {
        logger.warn(
          { code, durationMs, stderrTail: stderrBuf.slice(-2000) },
          "Dixon-Coles fitter exited non-zero",
        );
      }
      resolve({
        exitCode: code ?? -1,
        durationMs,
        stderrTail: stderrBuf.slice(-2000),
      });
    });
  });
}
