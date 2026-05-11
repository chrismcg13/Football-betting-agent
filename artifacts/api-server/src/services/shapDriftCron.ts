/**
 * Task 21 — SHAP-on-residuals drift detector cron wrapper.
 *
 * Spawns scripts/python/shap_drift.py — same pattern as
 * calibrationCron.ts. Python script computes K-S tests per
 * (market_type × feature) on a recent vs baseline window and writes
 * results to shap_drift_runs. Node side only orchestrates.
 *
 * Schedule: daily 03:30 UTC. Reads results into a brief summary log
 * line + the SQL view tail.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const SCRIPT = "scripts/python/shap_drift.py";

export interface ShapDriftRunResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
}

export async function runShapDrift(): Promise<ShapDriftRunResult> {
  const startedAt = Date.now();
  const repoRoot = process.env["CALIBRATION_REPO_ROOT"] ?? process.cwd();
  const pythonBin = path.isAbsolute(PYTHON_BIN) ? PYTHON_BIN : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, SCRIPT);

  logger.info({ pythonBin, scriptPath, repoRoot }, "Spawning SHAP drift detector");

  return new Promise<ShapDriftRunResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "shap_drift.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "shap_drift.py" }, trimmed);
    });

    child.on("error", (err) => {
      logger.error({ err, pythonBin, scriptPath }, "Failed to spawn shap_drift.py");
      resolve({ exitCode: -1, durationMs: Date.now() - startedAt, stderrTail: stderrBuf.slice(-2000) });
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        logger.info({ durationMs }, "SHAP drift detector completed cleanly");
      } else {
        logger.warn({ code, durationMs, stderrTail: stderrBuf.slice(-2000) }, "SHAP drift detector exited non-zero");
      }
      resolve({ exitCode: code ?? -1, durationMs, stderrTail: stderrBuf.slice(-2000) });
    });
  });
}
