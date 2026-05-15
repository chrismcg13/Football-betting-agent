#!/usr/bin/env bash
#
# Wrapper for apply-strategic-findings-2026-05-15.ts.
# Sources .env, then execs tsx on the CLI.
# Idempotent — re-runs are no-ops via experiment_tag check.
#
# Usage (one-shot, from repo root):
#   ./scripts/apply-strategic-findings.sh

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

exec pnpm dlx tsx artifacts/api-server/src/cli/apply-strategic-findings-2026-05-15.ts "$@"
