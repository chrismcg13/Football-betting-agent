/**
 * FotMob endpoint discovery probe wrapper.
 *
 * Spawns scripts/python/probe_fotmob_endpoints.py which tries 25+
 * candidate URL patterns and reports status codes + whether each
 * response body contains __NEXT_DATA__ or xG mentions. Operator-
 * triggered only via /admin/run-fotmob-probe. Read-only — never
 * touches the DB.
 *
 * Once we identify a 200-OK candidate, scrape_fotmob_direct.py gets
 * a one-line update to point at the correct URL pattern and the
 * 10-league Phase 2e pipeline is back online.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const PROBE_SCRIPT = "scripts/python/probe_fotmob_endpoints.py";

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

export interface FotmobProbeResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  spawnError?: string;
  pythonBin: string;
  scriptPath: string;
  pythonBinExists: boolean;
  scriptExists: boolean;
}

export async function runFotmobProbe(): Promise<FotmobProbeResult> {
  const startedAt = Date.now();
  const repoRoot = discoverRepoRoot();
  const pythonBin = path.isAbsolute(PYTHON_BIN)
    ? PYTHON_BIN
    : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, PROBE_SCRIPT);

  const pythonBinExists = (() => {
    try { return fs.statSync(pythonBin).isFile(); } catch { return false; }
  })();
  const scriptExists = (() => {
    try { return fs.statSync(scriptPath).isFile(); } catch { return false; }
  })();

  logger.info({ pythonBin, scriptPath, repoRoot }, "Spawning FotMob endpoint probe");

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

  return new Promise<FotmobProbeResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    let spawnErrorMsg: string | undefined;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "probe_fotmob_endpoints.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 32768) stderrBuf = stderrBuf.slice(-32768);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "probe_fotmob_endpoints.py" }, trimmed);
    });

    child.on("error", (err) => {
      spawnErrorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      resolve({
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stderrTail: stderrBuf.slice(-4000),
        spawnError: spawnErrorMsg,
        pythonBin,
        scriptPath,
        pythonBinExists,
        scriptExists,
      });
    });

    child.on("exit", (code) => {
      const durationMs = Date.now() - startedAt;
      resolve({
        exitCode: code ?? -1,
        durationMs,
        // bigger tail (4KB) since probe summary is the whole point
        stderrTail: stderrBuf.slice(-4000),
        ...(spawnErrorMsg ? { spawnError: spawnErrorMsg } : {}),
        pythonBin,
        scriptPath,
        pythonBinExists,
        scriptExists,
      });
    });
  });
}
