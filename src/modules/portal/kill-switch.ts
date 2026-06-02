/**
 * src/modules/portal/kill-switch.ts — operator control-plane executor.
 *
 * command-gate.ts classifies `/pause` `/resume` `/halt` as { action: 'control' };
 * the router dispatches here for the side effects + the channel reply. Kept
 * separate from command-gate so that module stays a pure classifier.
 *
 * 5.4a (this file) — locally enforced + testable:
 *   /pause  → setPauseState('paused')   soft: proactive suppressed, reactive still answered
 *   /resume → setPauseState('active')   clears paused/halted (NOT killswitch)
 *   /halt   → setPauseState('halted')   hard: kill running containers + block new spawns
 *
 * 5.4b (this file) — /killswitch. Never fires inline: the router routes it
 *   through requestKillswitchApproval (a confirmation card). On approve, the
 *   registered handler runs executeKillswitch — the local hard-stop
 *   (setPauseState('killswitch') + kill running containers; the 5.4a spawn gate
 *   blocks new ones) plus best-effort external revocations (OneCLI token revoke,
 *   Portkey budget→0), which are NOT_WIRED today (see killswitch-external.ts).
 *   Recovery is the manual scripts/recover-from-killswitch.sh → clearKillswitch.
 *
 * See STRATEGY.md §11 + §24.18 + PORTAL.md §7 + RECOVERY.md.
 */
import { killContainer } from '../../container-runner.js';
import { getRunningSessions } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
// Import from primitive.js (not index.js) — the index has top-level side
// effects (onDeliveryAdapterReady/registerResponseHandler) that we don't want
// in kill-switch's import graph. The dispatch handler that calls our registered
// 'killswitch' handler is registered at startup via src/modules/index.js.
import { registerApprovalHandler, requestApproval, type ApprovalHandlerContext } from '../approvals/primitive.js';
import { ensureUserDm } from '../permissions/user-dm.js';

import {
  revokeOneCliAgentTokens,
  summarizeExternal,
  zeroPortkeyBudget,
  type ExternalRevocationResult,
} from './killswitch-external.js';
import { getPauseState, setLiveMode, setPauseState, type PauseState } from './system-modes.js';

export interface ControlOutcome {
  /** Confirmation text for the channel reply. */
  message: string;
  /** The pause_state after the command ran (unchanged for a refused /resume). */
  state: PauseState;
  /** How many running containers were killed (only > 0 for /halt). */
  killed: number;
}

/**
 * Injectable seams so the executor is unit-testable without a live container
 * runtime. Production passes nothing and the real implementations are used.
 */
export interface ControlDeps {
  killContainer?: (sessionId: string, reason: string) => void;
  getRunningSessions?: () => Session[];
}

/** Kill every running container; returns the count of sessions targeted. */
function killAllRunning(reason: string, deps: ControlDeps): number {
  const list = (deps.getRunningSessions ?? getRunningSessions)();
  const kill = deps.killContainer ?? killContainer;
  for (const s of list) {
    kill(s.id, reason);
  }
  return list.length;
}

/**
 * Execute a classified control command. Pure dispatch over the system-modes
 * writers + (for /halt) the container runtime. Returns a confirmation string
 * for the channel reply; never throws.
 */
export function executeControlCommand(
  command: string,
  reason: string | null = null,
  changedBy: string | null = null,
  deps: ControlDeps = {},
): ControlOutcome {
  const cmd = command.toLowerCase();

  if (cmd === '/pause') {
    setPauseState('paused', reason, changedBy);
    log.info('Control command: /pause', { changedBy, reason });
    return {
      message:
        "System paused. Proactive activity is suppressed; I'll still respond to direct messages. Send /resume to re-enable.",
      state: 'paused',
      killed: 0,
    };
  }

  if (cmd === '/halt') {
    setPauseState('halted', reason, changedBy);
    const killed = killAllRunning('halt', deps);
    log.warn('Control command: /halt', { changedBy, reason, killed });
    return {
      message: `System halted. Killed ${killed} running container(s); new spawns are blocked until /resume.`,
      state: 'halted',
      killed,
    };
  }

  if (cmd === '/resume') {
    // Killswitch recovery is intentionally manual (RECOVERY.md) — /resume must
    // not clear it. Any other state (paused/halted/active) resumes cleanly.
    if (getPauseState() === 'killswitch') {
      log.warn('Control command: /resume refused — killswitch active', { changedBy });
      return {
        message:
          'Cannot /resume: the killswitch is engaged. Recovery is manual — an operator must run scripts/recover-from-killswitch.sh.',
        state: 'killswitch',
        killed: 0,
      };
    }
    setPauseState('active', null, changedBy);
    log.info('Control command: /resume', { changedBy });
    return {
      message: 'System resumed. Proactive activity is re-enabled.',
      state: 'active',
      killed: 0,
    };
  }

  // Unknown control command — command-gate gates the set, so this is defensive.
  log.warn('Control command: unrecognized', { command, changedBy });
  return {
    message: `Unrecognized control command: ${command}.`,
    state: getPauseState(),
    killed: 0,
  };
}

/**
 * Extract the optional free-text reason after the command token, e.g.
 * `/halt deploying a fix` → "deploying a fix". Returns null when none given.
 */
export function parseControlReason(text: string): string | null {
  const rest = text
    .trim()
    .replace(/^\/\S+\s*/, '')
    .trim();
  return rest.length > 0 ? rest : null;
}

// ── /killswitch (Sub-milestone 5.4b) ──────────────────────────────────────────

export interface KillswitchResult {
  /** Always 'killswitch' after a successful run. */
  state: PauseState;
  /** How many running containers were killed. */
  killed: number;
  /** Per-system external-revocation statuses (NOT_WIRED today). */
  external: ExternalRevocationResult[];
}

export interface KillswitchDeps extends ControlDeps {
  revokeOneCli?: (agentIds: string[]) => Promise<ExternalRevocationResult>;
  zeroPortkey?: () => Promise<ExternalRevocationResult>;
}

/**
 * The catastrophic stop. Local-effective steps first (state + kill containers;
 * the spawn gate already blocks new ones), then the best-effort external tail.
 * Never throws — external seams are best-effort and the local hard-stop stands
 * on its own. Returns a structured result so the reply can be honest about what
 * was and wasn't revoked.
 */
export async function executeKillswitch(
  reason: string | null = null,
  changedBy: string | null = null,
  deps: KillswitchDeps = {},
): Promise<KillswitchResult> {
  setPauseState('killswitch', reason, changedBy);

  const list = (deps.getRunningSessions ?? getRunningSessions)();
  const kill = deps.killContainer ?? killContainer;
  const agentIds = [...new Set(list.map((s) => s.agent_group_id))];
  for (const s of list) {
    kill(s.id, 'killswitch');
  }

  const revokeOneCli = deps.revokeOneCli ?? revokeOneCliAgentTokens;
  const zeroPortkey = deps.zeroPortkey ?? zeroPortkeyBudget;
  const external = [await revokeOneCli(agentIds), await zeroPortkey()];

  log.warn('KILLSWITCH ENGAGED', { changedBy, reason, killed: list.length, external });
  return { state: 'killswitch', killed: list.length, external };
}

/**
 * Manual recovery primitive (RECOVERY.md §3). Returns the system to shadow:
 * pause_state='active' + live_mode=false (always shadow — the operator re-enables
 * live mode deliberately after observation). Does NOT re-issue OneCLI/Portkey
 * credentials — that stays a manual step while those admin APIs are NOT_WIRED.
 */
export function clearKillswitch(changedBy: string | null = null): void {
  setPauseState('active', null, changedBy);
  setLiveMode(false, changedBy);
  log.warn('Killswitch cleared — system back in shadow mode (live_mode=false)', { changedBy });
}

/** Deliver a message straight to an admin's DM, bypassing the (killed) agent. */
async function deliverToApprover(userId: string, text: string): Promise<void> {
  try {
    const mg = userId ? await ensureUserDm(userId) : null;
    const adapter = getDeliveryAdapter();
    if (mg && adapter) {
      await adapter.deliver(mg.channel_type, mg.platform_id, null, 'chat', JSON.stringify({ text }));
      return;
    }
    log.warn('killswitch reply not delivered — no DM/adapter resolved', { userId });
  } catch (err) {
    log.error('killswitch reply delivery failed', { userId, err });
  }
}

/**
 * Approval handler for action='killswitch'. Runs the killswitch, then delivers
 * the result DIRECTLY to the approver's DM — under killswitch the spawn gate
 * refuses to wake the agent container, so the standard agent-routed `notify`
 * would never reach the owner.
 */
export async function killswitchApprovalHandler(ctx: ApprovalHandlerContext): Promise<void> {
  const reason = typeof ctx.payload.reason === 'string' ? ctx.payload.reason : null;
  const changedBy = ctx.userId || (typeof ctx.payload.changedBy === 'string' ? ctx.payload.changedBy : null);

  const result = await executeKillswitch(reason, changedBy);

  const text =
    `🛑 Killswitch engaged. Killed ${result.killed} running container(s); new spawns blocked. ` +
    `External: ${summarizeExternal(result.external)}. ` +
    `Recovery is manual — SSH in and run scripts/recover-from-killswitch.sh (RECOVERY.md §3).`;
  await deliverToApprover(ctx.userId, text);
}

/**
 * Post the killswitch confirmation card to an admin. The destructive path only
 * runs after they approve (killswitchApprovalHandler). Called by the router for
 * `/killswitch` instead of executeControlCommand.
 */
export async function requestKillswitchApproval(
  session: Session,
  agentName: string,
  reason: string | null,
  changedBy: string | null,
): Promise<void> {
  await requestApproval({
    session,
    agentName,
    action: 'killswitch',
    payload: { reason, changedBy },
    title: '⚠ KILLSWITCH — revokes credentials, requires manual SSH recovery',
    question:
      'This kills all running containers, blocks new spawns, and (at deploy) revokes credentials. ' +
      'Recovery is manual. Approve only if you intend to STOP everything and keep it stopped.',
  });
}

// Register the handler at import. kill-switch.ts is statically imported by the
// router, so this runs at startup; the approvals module's response handler
// (loaded via src/modules/index.ts) dispatches approved 'killswitch' rows here.
registerApprovalHandler('killswitch', killswitchApprovalHandler);
