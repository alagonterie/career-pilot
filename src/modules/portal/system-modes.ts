/**
 * src/modules/portal/system-modes.ts — system_modes table accessors.
 *
 * Sub-milestone 5.1 (STRATEGY.md §24.15) implements the READ accessors used by
 * GET /api/system-status: getLiveMode(), getPauseState(), getPauseReason(),
 * getSystemStatus(). The write/control plane (setPauseState + hot-reload +
 * the /pause /resume /halt /killswitch command-gate + the container-runner
 * pause gate) lands in Sub-milestone 5.4.
 *
 * The system_modes table (migration 106) is empty until first written, so
 * every reader has a safe default: live_mode=false (shadow), pause_state='active'.
 *
 * Stored values are read defensively (JSON first, raw string fallback) so this
 * tolerates whatever encoding 5.4's writers settle on.
 *
 * See STRATEGY.md §11 + §24.15 + RECOVERY.md.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

export type PauseState = 'active' | 'paused' | 'halted' | 'killswitch';

export interface SystemStatus {
  live_mode: boolean;
  pause_state: PauseState;
  pause_reason: string | null;
  backend: 'online';
}

const VALID_PAUSE_STATES: ReadonlySet<string> = new Set([
  'active',
  'paused',
  'halted',
  'killswitch',
]);

function readMode(key: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT value FROM system_modes WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row ? row.value : null;
  } catch (err) {
    log.error('system-modes read failed', { key, err });
    return null;
  }
}

/** Parse a stored value defensively: JSON first, fall back to the raw string. */
function parseStored(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function getLiveMode(): boolean {
  const v = parseStored(readMode('live_mode'));
  return v === true || v === 'true' || v === 1 || v === '1';
}

export function getPauseState(): PauseState {
  const v = parseStored(readMode('pause_state'));
  const s = typeof v === 'string' ? v : 'active';
  return (VALID_PAUSE_STATES.has(s) ? s : 'active') as PauseState;
}

export function getPauseReason(): string | null {
  const v = parseStored(readMode('pause_reason'));
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function getSystemStatus(): SystemStatus {
  return {
    live_mode: getLiveMode(),
    pause_state: getPauseState(),
    pause_reason: getPauseReason(),
    backend: 'online',
  };
}
