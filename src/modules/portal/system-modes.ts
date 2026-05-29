/**
 * src/modules/portal/system-modes.ts — system_modes table accessors.
 *
 * Sub-milestone 5.1 (STRATEGY.md §24.15) implemented the READ accessors used by
 * GET /api/system-status: getLiveMode(), getPauseState(), getPauseReason(),
 * getSystemStatus().
 *
 * Sub-milestone 5.4a (STRATEGY.md §24.18) adds the WRITERS: setPauseState() and
 * setLiveMode(). They UPSERT the key/value rows; the readers above reflect the
 * change on their next read. The /pause /resume /halt command surface
 * (command-gate.ts → kill-switch.ts) and the container-runner spawn gate consume
 * these. Hot-reload of running containers (a kind:'system' nudge so warm
 * containers re-read mid-turn) is DEFERRED as a unit — the container has no
 * consumer for it today (the poll loop discards inbound kind:'system' rows and
 * config.ts reads container.json only), and pause/live-mode are enforced
 * host-side. See the deferral note in STRATEGY.md §24.18 / §16.6 / §20.2.
 *
 * The system_modes table (migration 106) is empty until first written, so
 * every reader has a safe default: live_mode=false (shadow), pause_state='active'.
 *
 * Stored values are written JSON-encoded and read defensively (JSON first, raw
 * string fallback) so the readers also tolerate hand-seeded raw values.
 *
 * See STRATEGY.md §11 + §24.15 + §24.18 + RECOVERY.md.
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

// ── Writers (Sub-milestone 5.4a) ──────────────────────────────────────────────

/**
 * UPSERT a single system_modes row. Values are JSON-encoded so the readers'
 * JSON-first `parseStored` round-trips cleanly (booleans stay booleans, null
 * stays null). `changed_at` is an ISO-ish UTC string to match the rest of the
 * schema; `changed_by` records the actor (admin user id / 'operator' / null).
 */
function writeMode(key: string, value: unknown, changedBy: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO system_modes (key, value, changed_at, changed_by)
       VALUES (@key, @value, datetime('now'), @changedBy)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         changed_at = excluded.changed_at,
         changed_by = excluded.changed_by`,
    )
    .run({ key, value: JSON.stringify(value ?? null), changedBy });
}

/**
 * Set the pause state and its reason atomically. `paused` is the soft state
 * (proactive suppressed, reactive still answered); `halted`/`killswitch` are
 * hard (the container-runner spawn gate refuses new containers). Recovery from
 * `killswitch` is intentionally manual (RECOVERY.md) — `/resume` does not clear it.
 */
export function setPauseState(
  state: PauseState,
  reason: string | null = null,
  changedBy: string | null = null,
): void {
  const tx = getDb().transaction(() => {
    writeMode('pause_state', state, changedBy);
    writeMode('pause_reason', reason, changedBy);
  });
  tx();
  log.info('system mode: pause_state set', { state, reason, changedBy });
}

/**
 * Flip live mode. `false` = shadow/dry-run (no real external side effects);
 * `true` = real outreach. External-action tools read this fresh at action time
 * (host-side), so no running-container hot-reload is required for it to take
 * effect on the next action.
 */
export function setLiveMode(on: boolean, changedBy: string | null = null): void {
  writeMode('live_mode', on, changedBy);
  log.info('system mode: live_mode set', { on, changedBy });
}
