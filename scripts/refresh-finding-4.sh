#!/usr/bin/env bash
# Wrapper for refresh-finding-4-2026-05-15.ts — sources .env then execs tsx.
# One-shot, idempotent — re-runs are safe.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  echo "FATAL: .env not found at $(pwd)/.env" >&2
  exit 1
fi
set -a; source .env; set +a
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FATAL: DATABASE_URL not set after sourcing .env" >&2
  exit 1
fi
exec pnpm dlx tsx artifacts/api-server/src/cli/refresh-finding-4-2026-05-15.ts "$@"
