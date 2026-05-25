#!/usr/bin/env bash
# scripts/recover-from-killswitch.sh
#
# Manual recovery from /killswitch state. Owner must SSH to the VM and run
# this script (or follow its steps). The killswitch is intentionally NOT
# self-resetting — recovery requires a deliberate, audited action.
#
# Full procedure: RECOVERY.md §3.
#
# Phase 0 status: PLACEHOLDER skeleton. Implementation lands in Phase 4 when
# the kill-switch control plane (src/modules/portal/kill-switch.ts) is built.
#
# What this will do (each step prompts for confirmation):
#   1. Confirm operator identity (echo current user, hostname, current state)
#   2. Re-issue OneCLI agent tokens for career-pilot and career-pilot-sandbox
#   3. Reset Portkey budget caps to configured defaults (from preferences table)
#   4. Clear the killswitch flag in system_modes (sets pause_state='active')
#   5. Bring services back online with LIVE_MODE=false (shadow mode)
#   6. Tail logs for 30s to verify no immediate errors
#   7. Print: "Recovered to shadow mode. Flip LIVE_MODE=true via Telegram when ready."
#
# Why NOT in production yet: Phase 0 doesn't have a running system to recover.

set -euo pipefail

echo "recover-from-killswitch: not yet implemented (Phase 0 scaffolding)."
echo "See RECOVERY.md §3 for the full procedure. Implementation: Phase 4."
exit 1
