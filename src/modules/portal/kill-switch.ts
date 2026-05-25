/**
 * src/modules/portal/kill-switch.ts — three-tier emergency control plane.
 *
 *   /pause     — soft. Proactive paused, reactive still works.
 *   /halt      — hard. Kills containers, queues webhooks, portal degrades.
 *   /killswitch — catastrophic. Revokes OneCLI tokens, Portkey budget=0,
 *                 serves static "paused for review" page. Requires SSH +
 *                 scripts/recover-from-killswitch.sh to come back.
 *
 * Triggered by NanoClaw command-gate.ts on Telegram `/pause` / `/halt` /
 * `/killswitch` commands. Also surfaced on /admin via signed POST.
 *
 * The /killswitch handler does five things in sequence (see STRATEGY.md §11):
 *   1. setPauseState('killswitch', reason)
 *   2. MAX_CONCURRENT_CONTAINERS=0 env override + kill running containers
 *   3. oneCliClient.revokeAgent(...) for all agent IDs
 *   4. portkeyClient.setBudget(0)
 *   5. Update system_modes → portal Worker reads + serves static page
 *
 * See PORTAL.md §7 + RECOVERY.md for the full operator manual.
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 4 (STRATEGY.md §V).
 */
export {};
