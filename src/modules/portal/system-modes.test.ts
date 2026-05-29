/**
 * Unit tests for the Sub-milestone 5.1 system-modes read accessors
 * (STRATEGY.md §24.15): defaults when system_modes is empty, seeded reads,
 * and defensive fallback for an invalid pause_state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import {
  getLiveMode,
  getPauseReason,
  getPauseState,
  getSystemStatus,
  setLiveMode,
  setPauseState,
} from './system-modes.js';

describe('system-modes read accessors', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  function seedMode(key: string, value: string): void {
    db.prepare(
      `INSERT INTO system_modes (key, value, changed_at) VALUES (?, ?, '2026-05-29T00:00:00Z')`,
    ).run(key, value);
  }

  it('returns safe defaults when system_modes is empty', () => {
    expect(getLiveMode()).toBe(false);
    expect(getPauseState()).toBe('active');
    expect(getPauseReason()).toBeNull();
    expect(getSystemStatus()).toEqual({
      live_mode: false,
      pause_state: 'active',
      pause_reason: null,
      backend: 'online',
    });
  });

  it('reads seeded values', () => {
    seedMode('live_mode', 'true');
    seedMode('pause_state', 'halted');
    seedMode('pause_reason', 'cost spike');

    expect(getLiveMode()).toBe(true);
    expect(getPauseState()).toBe('halted');
    expect(getPauseReason()).toBe('cost spike');
    expect(getSystemStatus()).toEqual({
      live_mode: true,
      pause_state: 'halted',
      pause_reason: 'cost spike',
      backend: 'online',
    });
  });

  it('tolerates JSON-encoded values too', () => {
    seedMode('live_mode', 'false');
    seedMode('pause_state', '"paused"');
    expect(getLiveMode()).toBe(false);
    expect(getPauseState()).toBe('paused');
  });

  it('falls back to active for an invalid pause_state', () => {
    seedMode('pause_state', 'bogus');
    expect(getPauseState()).toBe('active');
  });
});

describe('system-modes writers (Sub-milestone 5.4a)', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  function rowCount(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM system_modes').get() as { c: number }).c;
  }

  it('setPauseState writes pause_state + reason and the readers reflect it', () => {
    setPauseState('paused', 'cost spike', 'owner-1');
    expect(getPauseState()).toBe('paused');
    expect(getPauseReason()).toBe('cost spike');
    expect(getSystemStatus().pause_state).toBe('paused');

    const row = db.prepare("SELECT value, changed_by FROM system_modes WHERE key = 'pause_state'").get() as {
      value: string;
      changed_by: string;
    };
    expect(JSON.parse(row.value)).toBe('paused'); // JSON-encoded on write
    expect(row.changed_by).toBe('owner-1');
  });

  it('setPauseState with a null reason clears the reason', () => {
    setPauseState('paused', 'temporary', 'owner-1');
    expect(getPauseReason()).toBe('temporary');
    setPauseState('active', null, 'owner-1');
    expect(getPauseState()).toBe('active');
    expect(getPauseReason()).toBeNull();
  });

  it('setLiveMode flips live_mode and the reader reflects it', () => {
    expect(getLiveMode()).toBe(false); // default
    setLiveMode(true, 'owner-1');
    expect(getLiveMode()).toBe(true);
    setLiveMode(false, 'owner-1');
    expect(getLiveMode()).toBe(false);
  });

  it('UPSERTs in place — repeated writes never duplicate a key', () => {
    setPauseState('paused', 'a', 'owner-1');
    setPauseState('halted', 'b', 'owner-2');
    setLiveMode(true, 'owner-1');
    setLiveMode(false, 'owner-1');
    // keys: pause_state, pause_reason, live_mode
    expect(rowCount()).toBe(3);
    expect(getPauseState()).toBe('halted');
    expect(getPauseReason()).toBe('b');
    expect(getLiveMode()).toBe(false);
  });
});
