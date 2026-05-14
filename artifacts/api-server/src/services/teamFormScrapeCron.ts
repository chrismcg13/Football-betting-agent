/**
 * Phase 2a (2026-05-14) — team-form scraper cron wrapper.
 *
 * Spawns scripts/python/scrape_team_form.py as a child process. Mirrors
 * the dixonColesFitCron / calibrationCron pattern: discoverRepoRoot to
 * resolve .venv and the script (PM2 starts api-server with cwd =
 * artifacts/api-server, not the repo root), pre-spawn existence checks,
 * diagnostic-rich return shape.
 *
 * Default schedule: Tue 05:00 UTC weekly (scheduler.ts cron), one hour
 * after the calibration fitter (Mon 04:00) and the Dixon-Coles fitter
 * (Mon 05:00) so the three weekly Python sidecars don't pile up.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const SCRAPER_SCRIPT = "scripts/python/scrape_team_form.py";

function discoverRepoRoot(): string {
  const explicit = process.env["CALIBRATION_REPO_ROOT"];
  if (explicit) return explicit;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export interface TeamFormScrapeResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  spawnError?: string;
  pythonBin: string;
  scriptPath: string;
  pythonBinExists: boolean;
  scriptExists: boolean;
}

export async function runTeamFormScrape(): Promise<TeamFormScrapeResult> {
  const startedAt = Date.now();
  const repoRoot = discoverRepoRoot();
  const pythonBin = path.isAbsolute(PYTHON_BIN)
    ? PYTHON_BIN
    : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, SCRAPER_SCRIPT);

  const pythonBinExists = (() => {
    try { return fs.statSync(pythonBin).isFile(); } catch { return false; }
  })();
  const scriptExists = (() => {
    try { return fs.statSync(scriptPath).isFile(); } catch { return false; }
  })();

  logger.info(
    { pythonBin, scriptPath, repoRoot, pythonBinExists, scriptExists },
    "Spawning team-form scraper",
  );

  if (!pythonBinExists || !scriptExists) {
    const reason = !pythonBinExists
      ? `Python binary not found at ${pythonBin}`
      : `Script not found at ${scriptPath}`;
    logger.error({ pythonBin, scriptPath, repoRoot }, reason);
    return {
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      stderrTail: "",
      spawnError: reason,
      pythonBin,
      scriptPath,
      pythonBinExists,
      scriptExists,
    };
  }

  return new Promise<TeamFormScrapeResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    let spawnErrorMsg: string | undefined;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "scrape_team_form.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "scrape_team_form.py" }, trimmed);
    });

    child.on("error", (err) => {
      spawnErrorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      logger.error({ err, pythonBin, scriptPath }, "Failed to spawn team-form scraper");
      resolve({
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stderrTail: stderrBuf.slice(-2000),
        spawnError: spawnErrorMsg,
        pythonBin,
        scriptPath,
        pythonBinExists,
        scriptExists,
      });
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        logger.info({ durationMs }, "Team-form scraper completed cleanly");
      } else {
        logger.warn(
          { code, durationMs, stderrTail: stderrBuf.slice(-2000) },
          "Team-form scraper exited non-zero",
        );
      }
      resolve({
        exitCode: code ?? -1,
        durationMs,
        stderrTail: stderrBuf.slice(-2000),
        ...(spawnErrorMsg ? { spawnError: spawnErrorMsg } : {}),
        pythonBin,
        scriptPath,
        pythonBinExists,
        scriptExists,
      });
    });
  });
}
