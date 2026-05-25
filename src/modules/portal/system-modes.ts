/**
 * src/modules/portal/system-modes.ts — system_modes table accessor + control plane.
 *
 * Exports getLiveMode(), getPauseState(), setPauseState(), setLiveMode().
 * Implements hot-reload — writes a `kind: 'system'` `messages_in` row to all
 * active sessions on change so containers invalidate cached config within ~5s.
 *
 * External-action tools (send_outreach_email, respond_to_calendar_invite)
 * call getLiveMode() before any irreversible action. When LIVE_MODE=false,
 * the action is skipped and a "DRY_RUN: action skipped, draft saved" result
 * is returned to the agent.
 *
 * See STRATEGY.md §11 + RECOVERY.md for the full operator manual.
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 4 (STRATEGY.md §V).
 */
export {};
