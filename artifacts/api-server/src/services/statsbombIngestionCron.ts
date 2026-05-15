/**
 * Phase 3 (2026-05-15) — StatsBomb women's open-data ingest wrapper.
 *
 * Pivoted in from Phase 2b because soccerdata 1.9 dropped FotMob and
 * FBref/Sofascore are Cloudflare-blocked. StatsBomb publishes free
 * event-level JSON for the marquee women's competitions (NWSL, FAWSL,
 * Women's WC, Women's Euro) on raw.githubusercontent.com — no
 * Selenium, no scraping, no auth.
 *
 * The Python sidecar parses events.json per match, sums
 * `shot.statsbomb_xg` per side, and upserts a single per-match summary
 * row to xg_match_data with source='statsbomb'. First run pulls ~50-
 * 200 MB of event JSON across the catalogue (cached in-memory only,
 * never persisted to Neon). Subsequent runs hit the
 * `already_ingested` short-circuit and finish in seconds.
 *
 * No cron — operator-fired only via /admin/run-statsbomb-ingest. The
 * open-data repo refreshes when StatsBomb adds new seasons; one
 * manual fire per season is enough.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger";

const PYTHON_BIN = process.env["CALIBRATION_PYTHON"] ?? ".venv/bin/python";
const INGEST_SCRIPT = "scripts/python/ingest_statsbomb_women.py";

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

export interface StatsbombIngestResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string;
  spawnError?: string;
  pythonBin: string;
  scriptPath: string;
  pythonBinExists: boolean;
  scriptExists: boolean;
}

export async function runStatsbombIngest(): Promise<StatsbombIngestResult> {
  const startedAt = Date.now();
  const repoRoot = discoverRepoRoot();
  const pythonBin = path.isAbsolute(PYTHON_BIN)
    ? PYTHON_BIN
    : path.join(repoRoot, PYTHON_BIN);
  const scriptPath = path.join(repoRoot, INGEST_SCRIPT);

  const pythonBinExists = (() => {
    try { return fs.statSync(pythonBin).isFile(); } catch { return false; }
  })();
  const scriptExists = (() => {
    try { return fs.statSync(scriptPath).isFile(); } catch { return false; }
  })();

  logger.info(
    { pythonBin, scriptPath, repoRoot, pythonBinExists, scriptExists },
    "Spawning StatsBomb women's ingest",
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

  return new Promise<StatsbombIngestResult>((resolve) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    let spawnErrorMsg: string | undefined;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) logger.info({ source: "ingest_statsbomb_women.py" }, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
      const trimmed = text.trim();
      if (trimmed) logger.warn({ source: "ingest_statsbomb_women.py" }, trimmed);
    });

    child.on("error", (err) => {
      spawnErrorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      logger.error({ err, pythonBin, scriptPath }, "Failed to spawn StatsBomb ingest");
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
        logger.info({ durationMs }, "StatsBomb ingest completed cleanly");
      } else {
        logger.warn(
          { code, durationMs, stderrTail: stderrBuf.slice(-2000) },
          "StatsBomb ingest exited non-zero",
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
