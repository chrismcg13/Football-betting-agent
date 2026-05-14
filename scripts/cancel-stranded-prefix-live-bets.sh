#!/usr/bin/env bash
#
# Thin wrapper — sources .env and invokes the TypeScript CLI via tsx.
# psql isn't installed on the VPS, so we use the existing api-server's
# Drizzle pool via pnpm dlx tsx (same pattern as probe-betfair-ah.ts).
#
# The CLI is EXECUTABLE-only by construction. PARTIALLY_MATCHED bets
# are excluded — their matched stake is committed on Betfair regardless,
# and the post-cancel status (PARTIAL_ACCEPTED) stays in the universal
# collapse-guard liveStatuses set so the slot remains blocked. Those
# settle naturally on kickoff.
#
# Usage:
#   ./scripts/cancel-stranded-prefix-live-bets.sh             # dry-run preview
#   ./scripts/cancel-stranded-prefix-live-bets.sh --execute   # do it

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

exec pnpm dlx tsx artifacts/api-server/src/cli/cancel-stranded-prefix-live-bets.ts "$@"
