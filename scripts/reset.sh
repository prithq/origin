#!/usr/bin/env bash
#
# Reset Origin to a clean demo state.
#
# Clears opportunities, evidence snapshots and generated workspaces so a demo
# starts from nothing. SWITCH agents and rooms are deliberately preserved:
# re-registering would issue new API keys and recreate rooms, which is slower
# and unnecessary between runs.
#
# Usage: ./scripts/reset.sh            # clear state, keep SWITCH registrations
#        ./scripts/reset.sh --full     # also forget rooms (agents are reused)

set -euo pipefail

cd "$(dirname "$0")/.."

FULL=false
if [[ "${1:-}" == "--full" ]]; then
  FULL=true
fi

echo "Resetting Origin demo state"

rm -f data/origin-state.json
rm -rf data/evidence
rm -rf workspace

if [[ "$FULL" == "true" ]]; then
  # Rooms are recreated on next boot; agents keep their credentials so nothing
  # needs re-registering.
  rm -f data/switch-rooms.json
  echo "  cleared: state, evidence, workspaces, room records"
else
  echo "  cleared: state, evidence, workspaces"
  echo "  kept:    SWITCH agent registrations, rooms"
fi

mkdir -p data workspace

echo "Done. Restart the server if it is running."
