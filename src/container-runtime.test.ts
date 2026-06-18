import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  stopInstallContainers,
  selectOrphanContainerNames,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

// Mirror the module-private STOP_TIMEOUT_MS so call assertions stay readable.
const STOP_TIMEOUT_MS = 10_000;

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names (timeout-bounded)', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
      timeout: STOP_TIMEOUT_MS,
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('selectOrphanContainerNames', () => {
  // Real container names carry a 13-digit Date.now() suffix (nanoclaw-v2-<folder>-<ms>).
  const NOW = 1_700_000_000_000;
  const TRACKED = 'nanoclaw-v2-career-pilot-1699999900000'; // tracked → never reaped
  const OLD = 'nanoclaw-v2-career-pilot-1699999000000'; // untracked, age 1_000_000ms
  const YOUNG = 'nanoclaw-v2-career-pilot-1699999999000'; // untracked, age 1_000ms
  const tracked = new Set([TRACKED]);
  const all = [TRACKED, OLD, YOUNG, 'onecli-postgres-1'];

  it('reaps only untracked containers older than the grace', () => {
    expect(selectOrphanContainerNames(all, tracked, 100_000, NOW)).toEqual([OLD]);
  });

  it('never reaps a tracked container, even when old', () => {
    expect(selectOrphanContainerNames([TRACKED], tracked, 0, NOW)).toEqual([]);
  });

  it('protects a just-spawned (within-grace) untracked container', () => {
    expect(selectOrphanContainerNames([YOUNG], new Set(), 100_000, NOW)).toEqual([]);
  });

  it('leaves a name with no parseable spawn timestamp alone (conservative)', () => {
    expect(selectOrphanContainerNames(['onecli', 'some-tool'], new Set(), 0, NOW)).toEqual([]);
  });
});

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
      timeout: STOP_TIMEOUT_MS,
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
      timeout: STOP_TIMEOUT_MS,
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});

// --- stopInstallContainers (shutdown path, STRATEGY.md §24.91) ---

describe('stopInstallContainers', () => {
  it('stops the install-labeled containers and returns their names', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-ops-1\nnanoclaw-sb-2\n');
    mockExecSync.mockReturnValue('');

    const names = stopInstallContainers('host-shutdown');

    expect(names).toEqual(['nanoclaw-ops-1', 'nanoclaw-sb-2']);
    // ps filtered by the install label, then a timeout-bounded stop per name.
    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-ops-1`, {
      stdio: 'pipe',
      timeout: STOP_TIMEOUT_MS,
    });
    expect(log.info).toHaveBeenCalledWith('Stopped running containers on shutdown', {
      count: 2,
      names: ['nanoclaw-ops-1', 'nanoclaw-sb-2'],
    });
  });

  it('returns an empty list and logs nothing when there is nothing to stop', () => {
    mockExecSync.mockReturnValueOnce('');

    const names = stopInstallContainers('host-shutdown');

    expect(names).toEqual([]);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('swallows a ps failure (returns []) and warns with the reason', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker daemon wedged');
    });

    const names = stopInstallContainers('host-shutdown'); // must not throw

    expect(names).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Failed to stop running containers on shutdown',
      expect.objectContaining({ reason: 'host-shutdown', err: expect.any(Error) }),
    );
  });
});
