/**
 * Phase 2e (2026-05-15) — direct-HTTP FotMob women's match-xG scraper.
 *
 * The previous Phase 2b path tried to reach FotMob via soccerdata 1.9,
 * which dropped FotMob support entirely. This wrapper drives a thin
 * scripts/python/scrape_fotmob_direct.py that uses FotMob's own
 * `/api/` endpoints (public, auth-free, JSON). Same wrapper pattern
 * as the StatsBomb + Dixon-Coles + team-form sidecars:
 * discoverRepoRoot + pre-spawn existence checks + diagnostic-rich
 * return.
 *
 * Default schedule: none — operator-fired only via
 * /admin/run-fotmob-direct. After verification we can add a weekly
 * cron (every Sunday so it captures the week's completed fixtures
 * before the Monday calibration / DC fit chain).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const SCRAPER_SCRIPT = "scripts/python/scrape_fotmob_direct.py";

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

export interface FotmobDirectScrapeResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  spawnError?: string;
  pythonBin: string;
  scriptPath: string;
  pythonBinExists: boolean;
  scriptExists: boolean;
}

export async function runFotmobDirectScrape(): Promise<FotmobDirectScrapeResult> {
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
    "Spawning FotMob direct-HTTP scraper",
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

  return new Promise<FotmobDirectScrapeResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    let spawnErrorMsg: string | undefined;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "scrape_fotmob_direct.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "scrape_fotmob_direct.py" }, trimmed);
    });

    child.on("error", (err) => {
      spawnErrorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      logger.error({ err, pythonBin, scriptPath }, "Failed to spawn FotMob direct scraper");
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
        logger.info({ durationMs }, "FotMob direct scraper completed cleanly");
      } else {
        logger.warn(
          { code, durationMs, stderrTail: stderrBuf.slice(-2000) },
          "FotMob direct scraper exited non-zero",
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
