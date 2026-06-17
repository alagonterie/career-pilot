import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import {
  resolveProviderName,
  spawnBlockedByPause,
  wakeContainer,
  atContainerCapacity,
  _setCommittedContainerCountForTesting,
} from './container-runner.js';
import { setPauseState } from './modules/portal/system-modes.js';
import type { Session } from './types.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('spawnBlockedByPause (Sub-milestone 5.4a)', () => {
  it('blocks only halted and killswitch', () => {
    expect(spawnBlockedByPause('active')).toBe(false);
    expect(spawnBlockedByPause('paused')).toBe(false);
    expect(spawnBlockedByPause('halted')).toBe(true);
    expect(spawnBlockedByPause('killswitch')).toBe(true);
  });
});

describe('atContainerCapacity (§24.92)', () => {
  it('blocks at or above the cap, allows below', () => {
    expect(atContainerCapacity(0, 4)).toBe(false);
    expect(atContainerCapacity(3, 4)).toBe(false);
    expect(atContainerCapacity(4, 4)).toBe(true);
    expect(atContainerCapacity(5, 4)).toBe(true);
  });

  it('treats cap <= 0 as unlimited (never blocks)', () => {
    expect(atContainerCapacity(0, 0)).toBe(false);
    expect(atContainerCapacity(10, 0)).toBe(false);
    expect(atContainerCapacity(10, -1)).toBe(false);
  });
});

describe('wakeContainer pause gate (Sub-milestone 5.4a)', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  function fakeSession(): Session {
    return {
      id: 'sess-gate',
      agent_group_id: 'ag-gate',
      messaging_group_id: 'mg-gate',
      thread_id: null,
      status: 'active',
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      container_status: 'stopped',
    } as Session;
  }

  it('refuses to spawn under halted (returns false, no container)', async () => {
    setPauseState('halted', 'maintenance', 'admin');
    await expect(wakeContainer(fakeSession())).resolves.toBe(false);
  });

  it('refuses to spawn under killswitch (returns false)', async () => {
    setPauseState('killswitch', null, 'admin');
    await expect(wakeContainer(fakeSession())).resolves.toBe(false);
  });
});

describe('wakeContainer concurrency cap (§24.92)', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    _setCommittedContainerCountForTesting(null);
    closeDb();
  });

  function fakeSession(): Session {
    return {
      id: 'sess-cap',
      agent_group_id: 'ag-cap',
      messaging_group_id: 'mg-cap',
      thread_id: null,
      status: 'active',
      created_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      container_status: 'stopped',
    } as Session;
  }

  it('refuses a new spawn when already at the cap (returns false, never reaches docker)', async () => {
    // Force the committed-slot count past any sane cap (default 4) without
    // spawning. The gate short-circuits before spawnContainer, so this resolves
    // false with no container — proving the ceiling holds under load.
    _setCommittedContainerCountForTesting(99);
    await expect(wakeContainer(fakeSession())).resolves.toBe(false);
  });
});
