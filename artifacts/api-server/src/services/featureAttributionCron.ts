/**
 * Task 22 — feature attribution cron wrapper (Phase 5c).
 *
 * Spawns scripts/python/feature_attribution.py — same pattern as
 * shapDriftCron.ts and calibrationCron.ts. Python script computes
 * per-(feature × market) attribution metrics and lifecycle status.
 *
 * Schedule: monthly on the 1st at 04:30 UTC (after the SHAP drift
 * detector at 03:30 and Kelly Monte-Carlo at 03:15 so the lifecycle
 * decisions land last in the chain).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const SCRIPT = "scripts/python/feature_attribution.py";

export interface FeatureAttributionResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
}

export async function runFeatureAttribution(): Promise<FeatureAttributionResult> {
  const startedAt = Date.now();
  const repoRoot = process.env["CALIBRATION_REPO_ROOT"] ?? process.cwd();
  const pythonBin = path.isAbsolute(PYTHON_BIN) ? PYTHON_BIN : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, SCRIPT);

  logger.info({ pythonBin, scriptPath, repoRoot }, "Spawning feature attribution job");

  return new Promise<FeatureAttributionResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "feature_attribution.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "feature_attribution.py" }, trimmed);
    });

    child.on("error", (err) => {
      logger.error({ err, pythonBin, scriptPath }, "Failed to spawn feature_attribution.py");
      resolve({ exitCode: -1, durationMs: Date.now() - startedAt, stderrTail: stderrBuf.slice(-2000) });
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        logger.info({ durationMs }, "Feature attribution job completed cleanly");
      } else {
        logger.warn({ code, durationMs, stderrTail: stderrBuf.slice(-2000) }, "Feature attribution job exited non-zero");
      }
      resolve({ exitCode: code ?? -1, durationMs, stderrTail: stderrBuf.slice(-2000) });
    });
  });
}
