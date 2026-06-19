/**
 * Upgrade tripwire (ported from NanoClaw 2.1.0's `[BREAKING]` boot guard;
 * STRATEGY.md §24.126). The host refuses to boot unless
 * `data/upgrade-state.json` records that this install reached the running code
 * version through a sanctioned path — the deploy bootstrap or a manual stamp.
 * Guards against a raw `git pull` +
 * restart landing dep-bumped code on an un-upgraded environment (a 2.1.x SDK or
 * OneCLI gateway expecting setup that didn't run).
 *
 * We port the mechanism rather than inherit it because our `src/index.ts` is
 * heavily customized and not wholesale-pulled from upstream. Two deviations
 * from upstream are deliberate (see §24.126): `set` always stamps the *code*
 * version (no override foot-gun), and `enforceUpgradeTripwire` has a test/dev
 * escape hatch so the suite and local runs don't trip.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export interface UpgradeState {
  /** The code version this install was stamped as having reached. */
  version: string;
  /** ISO-8601 stamp time. */
  updatedAt: string;
  /** Which sanctioned path wrote the marker (e.g. 'bootstrap', 'manual'). */
  via: string;
}

/** Absolute path to the marker file. */
export function markerPath(): string {
  return path.join(DATA_DIR, 'upgrade-state.json');
}

/**
 * The running code version (root `package.json`). Resolved relative to
 * `DATA_DIR` (= `<root>/data`) rather than `process.cwd()` so it's correct
 * regardless of the working directory the service unit launches from. Throws
 * if `package.json` has no version — a stamp/guard with no version is a bug,
 * not a soft failure.
 */
export function getCodeVersion(): string {
  const pkgPath = path.resolve(DATA_DIR, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error(`package.json at ${pkgPath} has no version field`);
  return pkg.version;
}

/**
 * Read the marker. Never throws — returns null when the file is missing
 * (the common, expected case), unreadable, or malformed. A malformed or
 * unreadable (non-ENOENT) marker is logged; a missing one is silent.
 */
export function readUpgradeState(): UpgradeState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(markerPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Failed to read upgrade-state.json', { err });
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UpgradeState>;
    if (typeof parsed.version === 'string' && typeof parsed.updatedAt === 'string' && typeof parsed.via === 'string') {
      return parsed as UpgradeState;
    }
    log.warn('upgrade-state.json is malformed (missing fields)', { path: markerPath() });
    return null;
  } catch (err) {
    log.warn('upgrade-state.json is not valid JSON', { err });
    return null;
  }
}

/**
 * Stamp the marker at the *current code version*. `via` is metadata only (the
 * guard checks version, not via). Version is intentionally non-overridable:
 * the marker's whole point is "I have reached THIS code version", so letting a
 * caller stamp an arbitrary version is a foot-gun.
 */
export function writeUpgradeState(via = 'manual'): UpgradeState {
  const state: UpgradeState = {
    version: getCodeVersion(),
    updatedAt: new Date().toISOString(),
    via,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(markerPath(), JSON.stringify(state, null, 2) + '\n');
  return state;
}

export type TripwireResult = { ok: true } | { ok: false; reason: string };

/**
 * Pure decision: does this marker satisfy the tripwire for `codeVersion`? The
 * unit-test seam — no filesystem, no process exit.
 */
export function evaluateTripwire(state: UpgradeState | null, codeVersion: string): TripwireResult {
  if (!state) {
    return { ok: false, reason: 'no upgrade marker (data/upgrade-state.json missing or unreadable)' };
  }
  if (state.version !== codeVersion) {
    return { ok: false, reason: `marker version ${state.version} != running code version ${codeVersion}` };
  }
  return { ok: true };
}

/** Read-from-disk wrapper around {@link evaluateTripwire}. */
export function checkUpgradeTripwire(): TripwireResult {
  return evaluateTripwire(readUpgradeState(), getCodeVersion());
}

const TRIPWIRE_MESSAGE = [
  'NanoClaw stopped: update did not go through the supported path.',
  '',
  'This install reached the current code version outside a sanctioned upgrade',
  '(the deploy bootstrap or a manual stamp).',
  'Refusing to boot so a half-applied upgrade can’t run against a stale environment.',
  '',
  'After a deliberate update, stamp the marker — then restart:',
  '  pnpm exec tsx scripts/upgrade-state.ts set',
  '',
  'Full runbook: .specs/RECOVERY.md → “Upgrade tripwire”.',
].join('\n');

/**
 * Boot gate (called at the top of `main()`, before DB init). Exits the process
 * with code 1 when the marker is missing or its version doesn't match the
 * running code. No-ops under test/dev (`VITEST`, `NODE_ENV=test`, or
 * `CP_SKIP_UPGRADE_TRIPWIRE=1`) — the tripwire protects the box/production
 * boot, not the test harness or local `pnpm dev`.
 */
export function enforceUpgradeTripwire(): void {
  if (process.env.CP_SKIP_UPGRADE_TRIPWIRE === '1' || process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return;
  }
  const result = checkUpgradeTripwire();
  if (!result.ok) {
    log.error('Upgrade tripwire engaged — refusing to boot', { reason: result.reason });
    // The full human/agent runbook goes to stderr (log.error may be JSON).
    process.stderr.write(`\n${TRIPWIRE_MESSAGE}\n\n`);
    process.exit(1);
  }
}
