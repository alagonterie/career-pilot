#!/usr/bin/env bash
# scripts/recover-from-killswitch.sh
#
# Manual recovery from /killswitch state. Owner must SSH to the VM and run this
# (or follow its steps). The killswitch is intentionally NOT self-resetting —
# recovery requires a deliberate, audited action. Full procedure: RECOVERY.md §3.
#
# This is a thin wrapper around the testable TS recovery
# (scripts/recover-from-killswitch.ts), which clears the killswitch flag and
# returns the system to SHADOW mode (live_mode stays false). The external
# re-issues (OneCLI tokens, Portkey budget) and the VM service restart are still
# manual — they are NOT_WIRED until the deploy phase (see killswitch-external.ts).

set -euo pipefail

cd "$(dirname "$0")/.."

read -r -p "I have reviewed the incident and want to recover to SHADOW mode [y/N]: " ok
if [[ "${ok:-}" != "y" && "${ok:-}" != "Y" ]]; then
  echo "Aborted. Killswitch remains engaged."
  exit 1
fi

# Clears the killswitch flag in system_modes -> pause_state='active', live_mode=false.
pnpm exec tsx scripts/recover-from-killswitch.ts

echo ""
echo "Remaining manual steps (until deploy automates them):"
echo "  - Restart the host service so containers re-spawn on the next message."
echo "  - Verify the portal shows the SHADOW MODE badge."
echo "  - Re-enable live mode (/setmode live) only after observation."
