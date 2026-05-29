/**
 * Unit tests for the Sub-milestone 5.1 system-modes read accessors
 * (STRATEGY.md §24.15): defaults when system_modes is empty, seeded reads,
 * and defensive fallback for an invalid pause_state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { getLiveMode, getPauseReason, getPauseState, getSystemStatus } from './system-modes.js';

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
