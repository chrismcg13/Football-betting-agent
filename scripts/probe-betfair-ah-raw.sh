#!/usr/bin/env bash
# Wrapper for probe-betfair-ah-raw.ts — sources .env then execs tsx.
#
# Dumps full raw JSON for AH catalogue + book responses on the given event
# IDs. Pipe to a file if needed.
#
# Usage:
#   ./scripts/probe-betfair-ah-raw.sh <eventId> [eventId...]
#   ./scripts/probe-betfair-ah-raw.sh 35600532 35608069 35607176 > /tmp/ah-probe.json
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  echo "FATAL: .env not found at $(pwd)/.env" >&2
  exit 1
fi
set -a; source .env; set +a
exec pnpm dlx tsx artifacts/api-server/src/cli/probe-betfair-ah-raw.ts "$@"
