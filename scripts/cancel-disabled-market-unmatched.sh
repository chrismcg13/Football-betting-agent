#!/usr/bin/env bash
#
# Thin wrapper — sources .env and invokes the TypeScript CLI via tsx.
# psql isn't installed on the VPS, so we use the existing api-server's
# Drizzle pool via pnpm dlx tsx (same pattern as cancel-stranded-prefix-
# live-bets.sh).
#
# Cancels EXECUTABLE (0% matched) live Betfair bets whose market_type
# is currently in agent_config.live_placement_disabled_market_types.
# Companion to the per-market kill switch in livePlacementGate.ts.
#
# PARTIALLY_MATCHED bets are excluded — matched stake is committed on
# Betfair regardless, post-cancel status (PARTIAL_ACCEPTED) keeps the
# slot blocked under collapse-guard, settles naturally on kickoff.
#
# Usage:
#   ./scripts/cancel-disabled-market-unmatched.sh             # dry-run preview
#   ./scripts/cancel-disabled-market-unmatched.sh --execute   # do it

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

exec pnpm dlx tsx artifacts/api-server/src/cli/cancel-disabled-market-unmatched.ts "$@"
