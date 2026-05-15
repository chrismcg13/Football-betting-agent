/**
 * FotMob league-ID multi-strategy scan wrapper (Phase 2j).
 *
 * Sister to fotmobIdFinderCron — different script
 * (scan_fotmob_league_ids.py) that tries sitemap, daily-matches
 * harvest, and brute-force ID range scan. Up to ~10 min synchronous
 * for the brute-force pass.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const SCAN_SCRIPT = "scripts/python/scan_fotmob_league_ids.py";

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

export interface FotmobIdScanResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  spawnError?: string;
  pythonBin: string;
  scriptPath: string;
  pythonBinExists: boolean;
  scriptExists: boolean;
}

export async function runFotmobIdScan(strategy: string = "all"): Promise<FotmobIdScanResult> {
  const startedAt = Date.now();
  const repoRoot = discoverRepoRoot();
  const pythonBin = path.isAbsolute(PYTHON_BIN)
    ? PYTHON_BIN
    : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, SCAN_SCRIPT);

  const pythonBinExists = (() => {
    try { return fs.statSync(pythonBin).isFile(); } catch { return false; }
  })();
  const scriptExists = (() => {
    try { return fs.statSync(scriptPath).isFile(); } catch { return false; }
  })();

  logger.info({ pythonBin, scriptPath, repoRoot }, "Spawning FotMob ID scan");

  if (!pythonBinExists || !scriptExists) {
    return {
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      stderrTail: "",
      spawnError: !pythonBinExists
        ? `Python binary not found at ${pythonBin}`
        : `Script not found at ${scriptPath}`,
      pythonBin,
      scriptPath,
      pythonBinExists,
      scriptExists,
    };
  }

  return new Promise<FotmobIdScanResult>((resolve) => {
    const args = strategy && strategy !== "all"
      ? [scriptPath, `--strategy=${strategy}`]
      : [scriptPath];
    const child = spawn(pythonBin, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Hard 6-minute timeout — kill the child if it hangs so the
    // admin endpoint never blocks beyond that.
    const killTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
    }, 6 * 60 * 1000);

    let stderrBuf = "";
    let spawnErrorMsg: string | undefined;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "scan_fotmob_league_ids.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "scan_fotmob_league_ids.py" }, trimmed);
    });

    child.on("error", (err) => {
      spawnErrorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      resolve({
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stderrTail: stderrBuf.slice(-8000),
        spawnError: spawnErrorMsg,
        pythonBin,
        scriptPath,
        pythonBinExists,
        scriptExists,
      });
    });

    child.on("exit", (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - startedAt;
      resolve({
        exitCode: code ?? -1,
        durationMs,
        // 8KB tail since the FINAL SUMMARY plus per-strategy logs
        // are the whole point and span more than the standard 2KB.
        stderrTail: stderrBuf.slice(-8000),
        ...(spawnErrorMsg ? { spawnError: spawnErrorMsg } : {}),
        pythonBin,
        scriptPath,
        pythonBinExists,
        scriptExists,
      });
    });
  });
}
