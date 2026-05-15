/**
 * FotMob community-wrapper test (Phase 2k, 2026-05-15).
 *
 * Last-resort test after raw HTTP scan returned 0/1500 200s.
 * Hypothesises that fotmob-api / PyFotMob wrappers reverse-engineer
 * the x-mas request signature and can reach the API where raw
 * requests can't. Read-only; 4-min hard kill timer.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const SCRIPT = "scripts/python/test_fotmob_wrappers.py";

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

export interface FotmobWrapperTestResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  spawnError?: string;
}

export async function runFotmobWrapperTest(): Promise<FotmobWrapperTestResult> {
  const startedAt = Date.now();
  const repoRoot = discoverRepoRoot();
  const pythonBin = path.isAbsolute(PYTHON_BIN)
    ? PYTHON_BIN
    : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, SCRIPT);

  if (!fs.existsSync(pythonBin) || !fs.existsSync(scriptPath)) {
    return {
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      stderrTail: "",
      spawnError: `python or script missing: ${pythonBin} / ${scriptPath}`,
    };
  }

  logger.info({ pythonBin, scriptPath }, "Spawning FotMob wrapper test");

  return new Promise<FotmobWrapperTestResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
    }, 4 * 60 * 1000);

    let stderrBuf = "";
    let spawnErrorMsg: string | undefined;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "test_fotmob_wrappers.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "test_fotmob_wrappers.py" }, trimmed);
    });
    child.on("error", (err) => {
      spawnErrorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      resolve({
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        stderrTail: stderrBuf.slice(-12000),
        spawnError: spawnErrorMsg,
      });
    });
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      resolve({
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
        stderrTail: stderrBuf.slice(-12000),
        ...(spawnErrorMsg ? { spawnError: spawnErrorMsg } : {}),
      });
    });
  });
}
