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
 * 5.4b (deferred) — /killswitch adds, after the local steps above, OneCLI agent
 *   token revoke + Portkey budget→0. Those are external-admin, best-effort, gated
 *   behind an admin confirmation card; recovery is the manual
 *   scripts/recover-from-killswitch.sh. Not wired here yet — see STRATEGY.md §24.18.
 *
 * See STRATEGY.md §11 + §24.18 + PORTAL.md §7 + RECOVERY.md.
 */
import { killContainer } from '../../container-runner.js';
import { getRunningSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

import { getPauseState, setPauseState, type PauseState } from './system-modes.js';

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
  const rest = text.trim().replace(/^\/\S+\s*/, '').trim();
  return rest.length > 0 ? rest : null;
}
