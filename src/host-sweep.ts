/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import { getConfig } from './get-config.js';
import { getPauseState, type PauseState } from './modules/portal/system-modes.js';
import {
  countDueMessages,
  countDueReactiveMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, openOutboundDbRw, inboundDbPath, heartbeatPath } from './session-manager.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container — the DEFAULT. If the heartbeat
// file hasn't been touched in this long, the container is either stuck or doing
// genuinely nothing — kill and restart on the next inbound. Tunable live via the
// `container_idle_timeout_sec` preference (/dev, future /admin); this constant is
// the fallback + the default decideStuckAction uses when no override is passed
// (§24.96).
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;

/** The configured idle ceiling in ms (preference `container_idle_timeout_sec`,
 *  default 1800 s = ABSOLUTE_CEILING_MS). Read each sweep tick so a /dev change
 *  applies live; falls back to the constant on any config/db error. */
function configuredCeilingMs(): number {
  try {
    return getConfig<number>(getDb(), 'container_idle_timeout_sec', ABSOLUTE_CEILING_MS / 1000) * 1000;
  } catch {
    return ABSOLUTE_CEILING_MS;
  }
}
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
  /** Idle ceiling override (§24.96). Defaults to ABSOLUTE_CEILING_MS so the
   *  decision stays pure + unchanged when callers omit it. */
  absoluteCeilingMs?: number;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const absoluteCeilingMs = args.absoluteCeilingMs ?? ABSOLUTE_CEILING_MS;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(absoluteCeilingMs, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

/**
 * Whether a cold container wake should be suppressed this tick given the
 * system pause state (Sub-milestone 5.4a, STRATEGY.md §24.18).
 *
 *   - `halted` / `killswitch` — suppress every cold wake (hard stop).
 *   - `paused` — soft: suppress only when there is no due *reactive* (direct-
 *     message) work; a direct message still wakes, a proactive cron does not.
 *   - `active` — never suppress.
 *
 * Pure so the policy is unit-testable without running the sweep.
 */
export function shouldSuppressColdWake(pauseState: PauseState, dueReactiveCount: number): boolean {
  if (pauseState === 'halted' || pauseState === 'killswitch') return true;
  if (pauseState === 'paused' && dueReactiveCount === 0) return true;
  return false;
}

let running = false;

// Last-run stamp for the §24.80 architecture `sweep` freshness probe. In-process
// (the /api/architecture handler runs in the same host process) — no per-tick DB
// write. `null` until the first sweep completes; a silent loop lets the age grow,
// which the endpoint turns into a `down` badge.
let lastSweepAtMs: number | null = null;

/** Ms-epoch of the last completed sweep tick, or `null` before the first. */
export function getLastSweepAtMs(): number | null {
  return lastSweepAtMs;
}

/** Test seam — set/clear the last-sweep stamp without running the loop. */
export function _setLastSweepAtForTesting(ms: number | null): void {
  lastSweepAtMs = ms;
}

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    // 0. Keep the career-pilot ops-session topology in place (STRATEGY.md
    // §24.67): the dedicated machine-traffic session exists, the five
    // recurring series live in it, misplaced live copies elsewhere are
    // retired. Internally throttled + idempotent; never throws. Before the
    // session loop so a session created here is swept from its first tick.
    // MODULE-HOOK:career-pilot-ops-bootstrap:start
    const { ensureOpsTopology } = await import('./modules/career-pilot/ops-session.js');
    ensureOpsTopology();
    // MODULE-HOOK:career-pilot-ops-bootstrap:end

    // 0b. Observability maintenance (STRATEGY.md §24.68): prune the
    // request_telemetry retention window + run the proactive health check
    // (deduped owner alert on NEW critical findings). Internally throttled
    // per step; best-effort, never throws.
    // MODULE-HOOK:career-pilot-observability:start
    const { runTelemetryMaintenance } = await import('./modules/career-pilot/health-alert.js');
    await runTelemetryMaintenance();
    // MODULE-HOOK:career-pilot-observability:end

    // 0c. Reap sandbox sessions orphaned by an interrupted run (STRATEGY.md
    // §24.69 Δ): a public/sim run cut off by a host restart loses its in-memory
    // accumulator, so finalize → teardown never retires its session and the
    // sandbox session-topology count grows forever. Best-effort, never throws.
    // Before the session loop so a reaped session drops out of this same tick.
    // MODULE-HOOK:career-pilot-sandbox-reap:start
    const { reapStaleSandboxSessions } = await import('./modules/portal/simulator.js');
    reapStaleSandboxSessions();
    // MODULE-HOOK:career-pilot-sandbox-reap:end

    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  // Stamp AFTER the work (incl. an error path): "time since the loop last
  // completed a tick" is the honest freshness signal — a wedged iteration that
  // never reaches here lets the age grow, which is exactly the `down` we want.
  lastSweepAtMs = Date.now();
  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 1b. Expire orphaned action-response rows (cp-resp-* past their consumer's
    // polling deadline) so they can't crowd real work out of the poll loop's
    // newest-N prompt window (STRATEGY.md §24.66). Before the due-count below
    // so a freshly expired pile stops masking due tasks within one tick.
    // MODULE-HOOK:career-pilot-orphan-responses:start
    const { expireOrphanedActionResponses } = await import('./modules/career-pilot/orphan-responses.js');
    expireOrphanedActionResponses(inDb, session);
    // MODULE-HOOK:career-pilot-orphan-responses:end

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      // Pause gate (Sub-milestone 5.4a, STRATEGY.md §24.18). `halted`/
      // `killswitch` block every cold wake (wakeContainer also refuses, this
      // just avoids the call). `paused` is soft: still wake for a due reactive
      // (direct) message, but skip a wake whose only due work is proactive
      // (heartbeat cron / agent system rows). `getPauseState()` defaults to
      // `active` when system_modes is absent, so this is inert for upstream.
      const pauseState = getPauseState();
      const suppress = pauseState !== 'active' && shouldSuppressColdWake(pauseState, countDueReactiveMessages(inDb));
      if (suppress) {
        log.debug('Suppressing wake under pause state', { sessionId: session.id, pauseState, dueCount });
      } else {
        log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
        // wakeContainer never throws — transient spawn failures (OneCLI down,
        // etc.) return false and leave messages pending for the next tick.
        await wakeContainer(session);
      }
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
    absoluteCeilingMs: configuredCeilingMs(),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
