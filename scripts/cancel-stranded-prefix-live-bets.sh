#!/usr/bin/env bash
#
# Cancel unmatched portions of pre-parser-fix (pre-2026-05-14 18:00 UTC)
# live AH bets that are holding (market_id, selection_id) slots the
# correctly-routed parser now wants.
#
# Why this exists: the buggy AH parser silently mis-routed every internal
# selection_name to whichever Betfair runner came first per side. The
# post-fix parser routes precisely, but the universal collapse guard
# correctly refuses to place a new bet onto a slot already held by a
# pre-fix bet. ~272 stranded positions are blocking ~16 currently-eligible
# leagues from placing.
#
# What it does:
#   - Selects pending live AH bets placed BEFORE the parser-fix deploy
#     where betfair_status is still EXECUTABLE / PARTIALLY_MATCHED and
#     kickoff is in the future.
#   - For each, hits POST /api/admin/cancel-bet with the internal bet id.
#     Betfair cancels only the UNMATCHED portion — any matched stake
#     stays committed and settles per the original outcome.
#   - The freed (market, selection) slot becomes available to the next
#     lazy-promote cycle for correctly-routed placements.
#
# Symmetric to Block ZERO scope-demote: an eligible scope's slots should
# only be held by bets that are correct under the current routing model.
#
# Usage:
#   ./scripts/cancel-stranded-prefix-live-bets.sh             # dry-run
#   ./scripts/cancel-stranded-prefix-live-bets.sh --execute   # do it

set -euo pipefail

cd "$(dirname "$0")/.."

# Load DATABASE_URL etc.
if [[ ! -f .env ]]; then
  echo "FATAL: .env not found at $(pwd)/.env" >&2
  exit 1
fi
set -a; source .env; set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FATAL: DATABASE_URL not set after sourcing .env" >&2
  exit 1
fi

# Parser-fix deploy cutoff. Any live AH bet placed before this routed
# through the buggy pickAhMarketForLine + findSelectionId collapse path.
CUTOFF="2026-05-14 18:00:00+00"
API_HOST="${API_HOST:-http://localhost:8080}"
SLEEP_BETWEEN="${SLEEP_BETWEEN:-0.4}"

# Default mode: dry-run. Require explicit --execute to actually cancel.
MODE="dry-run"
if [[ "${1:-}" == "--execute" ]]; then
  MODE="execute"
elif [[ "${1:-}" == "--dry-run" || -z "${1:-}" ]]; then
  MODE="dry-run"
else
  echo "Usage: $0 [--dry-run | --execute]" >&2
  exit 2
fi

LOG="cancel-stranded-$(date -u +%Y%m%dT%H%M%SZ).log"
echo "Mode: $MODE"
echo "Cutoff: $CUTOFF (UTC)"
echo "API host: $API_HOST"
echo "Audit log: $LOG"
echo

# Pull candidate list from Postgres
CANDIDATES=$(psql "$DATABASE_URL" -t -A -F'|' --no-psqlrc <<SQL
SELECT
  pb.id,
  pb.betfair_bet_id,
  pb.selection_name,
  pb.betfair_status,
  COALESCE(pb.betfair_size_matched, 0)::text,
  pb.match_id,
  m.league,
  to_char(m.kickoff_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI')
FROM paper_bets pb
JOIN matches m ON m.id = pb.match_id
WHERE pb.bet_track = 'live'
  AND pb.market_type = 'ASIAN_HANDICAP'
  AND pb.placed_at < '$CUTOFF'::timestamptz
  AND pb.betfair_market_id IS NOT NULL
  AND pb.betfair_selection_id IS NOT NULL
  AND pb.status = 'pending'
  -- EXECUTABLE only: 0% matched, fully cancellable, slot fully releasable.
  -- PARTIALLY_MATCHED excluded — its matched stake is committed on Betfair
  -- regardless, and the post-cancel betfair_status (PARTIAL_ACCEPTED) is
  -- still in the collapse-guard liveStatuses set, so the slot stays
  -- blocked. Those settle naturally on kickoff; nothing to gain by
  -- cancelling the unmatched residual.
  AND pb.betfair_status = 'EXECUTABLE'
  AND COALESCE(pb.betfair_size_matched, 0) = 0
  AND m.kickoff_time > NOW()
  AND pb.deleted_at IS NULL
ORDER BY pb.id;
SQL
)

if [[ -z "$CANDIDATES" ]]; then
  echo "No stranded pre-parser-fix live AH bets found. Backlog already cleared."
  exit 0
fi

N=$(printf '%s\n' "$CANDIDATES" | wc -l)
echo "Found $N stranded live AH bet(s) holding slots the new parser wants."
echo

# Show a preview either way
{
  printf "%-8s %-16s %-14s %-22s %-9s %-7s %-30s %s\n" \
    "betId" "betfairBetId" "selectionName" "betfairStatus" "matched" "matchId" "league" "kickoff"
  printf '%s\n' "$CANDIDATES" | head -20 | awk -F'|' '{
    printf "%-8s %-16s %-14s %-22s %-9s %-7s %-30s %s\n",
      $1, $2, $3, $4, $5, $6, substr($7,1,30), $8
  }'
  if [[ $N -gt 20 ]]; then
    echo "...(showing first 20 of $N)"
  fi
} | tee -a "$LOG"

if [[ "$MODE" == "dry-run" ]]; then
  echo
  echo "DRY RUN — pass --execute to cancel the unmatched portions."
  echo "Each cancel keeps any matched stake on Betfair; only unmatched is released."
  exit 0
fi

echo
echo "Executing. Rate-limit: ${SLEEP_BETWEEN}s between calls."
echo

OK=0
FAIL=0
SKIPPED=0
I=0

while IFS='|' read -r id bf_id sel bf_status matched match_id league kickoff; do
  I=$((I + 1))
  [[ -z "$id" ]] && continue

  # Re-check live status right before cancelling. Avoids cancelling a bet
  # that settled or was already cancelled between candidate listing and
  # our turn (cron + relay run in parallel).
  CURRENT_STATUS=$(psql "$DATABASE_URL" -t -A --no-psqlrc -c \
    "SELECT betfair_status FROM paper_bets WHERE id = $id" 2>/dev/null || echo "")

  case "$CURRENT_STATUS" in
    EXECUTABLE)
      ;;
    *)
      SKIPPED=$((SKIPPED + 1))
      printf "[%3d/%d] SKIP bet=%s status_now=%s\n" \
        "$I" "$N" "$id" "${CURRENT_STATUS:-unknown}" | tee -a "$LOG"
      continue
      ;;
  esac

  HTTP=$(curl -s -o /tmp/cancel-resp.$$ -w "%{http_code}" \
    --max-time 30 \
    -H 'Content-Type: application/json' \
    -X POST "$API_HOST/api/admin/cancel-bet" \
    -d "{\"internalBetId\": $id}" || echo "000")

  if [[ "$HTTP" == "200" ]]; then
    OK=$((OK + 1))
    printf "[%3d/%d] OK   bet=%-6s bf=%-12s sel='%-12s' status=%-22s matched=%s league='%s'\n" \
      "$I" "$N" "$id" "$bf_id" "$sel" "$bf_status" "$matched" "$league" | tee -a "$LOG"
  else
    FAIL=$((FAIL + 1))
    BODY=$(cat /tmp/cancel-resp.$$ 2>/dev/null | head -c 200 || true)
    printf "[%3d/%d] FAIL bet=%-6s http=%s body=%s\n" \
      "$I" "$N" "$id" "$HTTP" "$BODY" | tee -a "$LOG"
  fi
  rm -f /tmp/cancel-resp.$$

  sleep "$SLEEP_BETWEEN"
done <<< "$CANDIDATES"

echo
echo "Done. cancelled=$OK failed=$FAIL skipped=$SKIPPED total=$N"
echo "Audit log: $LOG"
