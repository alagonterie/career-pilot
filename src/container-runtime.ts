/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

// Hard bound on a single `docker stop` so a wedged daemon can't hang either the
// startup orphan sweep or the shutdown path past systemd's TimeoutStopSec
// (default 90s) into a SIGKILL — which would re-orphan the very containers we're
// trying to stop. Mirrors the hardcoded `docker info` timeout below; this is a
// low-level safety bound, not a user-facing tunable.
const STOP_TIMEOUT_MS = 10_000;

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Validates the name to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe', timeout: STOP_TIMEOUT_MS });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Stop every container belonging to THIS install (label `nanoclaw-install=<slug>`).
 *
 * The shared primitive behind both lifecycle bookends:
 *   - `cleanupOrphans()` on host START — reap containers a previous run left behind.
 *   - the host `shutdown()` path — stop our own containers on the way OUT, so a
 *     deploy/restart doesn't orphan the warm ops (or a mid-turn) container to run
 *     unsupervised until the next boot reaps it (STRATEGY.md §24.91).
 *
 * Scoped by the install label so a crash-looping peer install cannot reap our
 * containers, and we cannot reap theirs. The label is stamped onto every
 * container at spawn time — see container-runner.ts. Each `docker stop` is
 * timeout-bounded (STOP_TIMEOUT_MS); a per-name stop failure (already gone) is
 * swallowed so one bad name can't abort the sweep. Returns the names stopped so
 * callers can log/reconcile. Never throws.
 */
function stopInstallContainersImpl(opts: {
  successMessage: string;
  failureMessage: string;
  reason?: string;
}): string[] {
  const { successMessage, failureMessage, reason } = opts;
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const names = output.trim().split('\n').filter(Boolean);
    for (const name of names) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (names.length > 0) {
      log.info(successMessage, { count: names.length, names });
    }
    return names;
  } catch (err) {
    log.warn(failureMessage, reason ? { reason, err } : { err });
    return [];
  }
}

/** Reap orphaned containers from this install's previous runs (host START). */
export function cleanupOrphans(): void {
  stopInstallContainersImpl({
    successMessage: 'Stopped orphaned containers',
    failureMessage: 'Failed to clean up orphaned containers',
  });
}

/**
 * Stop this install's running containers on graceful shutdown (STRATEGY.md
 * §24.91). The symmetric twin of `cleanupOrphans()`: safe because resume is via
 * the persisted SDK continuation (transcript replay), not a kept-warm container
 * — the next inbound re-spawns and continues. `reason` is logged for triage.
 */
export function stopInstallContainers(reason: string): string[] {
  return stopInstallContainersImpl({
    successMessage: 'Stopped running containers on shutdown',
    failureMessage: 'Failed to stop running containers on shutdown',
    reason,
  });
}

/** Parse the spawn epoch-ms a container name encodes (`nanoclaw-v2-<folder>-<ms>`),
 *  or null when the trailing segment isn't a timestamp. */
function parseSpawnMs(name: string): number | null {
  const m = name.match(/-(\d{10,})$/);
  return m ? Number(m[1]) : null;
}

/**
 * Pure selection (§24.112): from the install's running container names, the
 * ORPHANS to reap — those NOT in `trackedNames` (the host's in-memory set) AND
 * older than `graceMs`. The age comes free from the name's spawn timestamp, so a
 * just-spawned container still registering into the map (age < grace) is
 * protected, while an old untracked container is a genuine orphan. A name with no
 * parseable timestamp is left alone (conservative — never reap what we can't age).
 */
export function selectOrphanContainerNames(
  allNames: string[],
  trackedNames: Set<string>,
  graceMs: number,
  now: number,
): string[] {
  return allNames.filter((name) => {
    if (trackedNames.has(name)) return false;
    const spawnMs = parseSpawnMs(name);
    if (spawnMs == null) return false;
    return now - spawnMs > graceMs;
  });
}

/** List this install's running container names (label-scoped). [] on any error. */
function listInstallContainerNames(): string[] {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch (err) {
    log.warn('Failed to list install containers for orphan reconcile', { err });
    return [];
  }
}

/**
 * Reap orphaned containers the host is no longer tracking (§24.112). Run each
 * host-sweep tick: a running install container whose name isn't in `trackedNames`
 * (the host's in-memory `activeContainers`) and that has outlived `graceMs` is
 * dead weight — it can't receive work (work routes through `wakeContainer`, which
 * registers in the map), so the host has lost track of it (orphaned by a
 * restart/deploy clearing the map, or removed from the map while its docker
 * process lingered). Stop it. This closes the idle-ceiling escape hatch — the
 * §24.96 ceiling otherwise only sees map-tracked containers. Never throws;
 * returns the names stopped.
 */
export function reapUntrackedContainers(
  trackedNames: Set<string>,
  graceMs: number,
  now: number = Date.now(),
): string[] {
  const orphans = selectOrphanContainerNames(listInstallContainerNames(), trackedNames, graceMs, now);
  const reaped: string[] = [];
  for (const name of orphans) {
    try {
      stopContainer(name);
      reaped.push(name);
    } catch {
      /* already gone */
    }
  }
  if (reaped.length > 0) {
    log.info('Reaped untracked orphan containers', { count: reaped.length, names: reaped });
  }
  return reaped;
}

/**
 * Count this install's running containers (for the portal /api/architecture
 * panel). Returns `null` when the container runtime is unreachable so the
 * caller can render a graceful "runtime down" state (PORTAL §10) rather than
 * erroring. Scoped by the install label like cleanupOrphans.
 */
export function countRunningContainers(): number | null {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 },
    );
    return output.trim().split('\n').filter(Boolean).length;
  } catch (err) {
    log.warn('countRunningContainers failed (runtime unavailable?)', { err });
    return null;
  }
}
