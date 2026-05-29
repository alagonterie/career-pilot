/**
 * Unit tests for the Sub-milestone 5.4a control-plane executor
 * (STRATEGY.md §24.18): /pause /resume /halt transitions, /halt killing
 * running containers, the manual-recovery guard on /resume under killswitch,
 * and reason parsing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { Session } from '../../types.js';

import { executeControlCommand, parseControlReason } from './kill-switch.js';
import { getPauseReason, getPauseState, setPauseState } from './system-modes.js';

function fakeSession(id: string): Session {
  return {
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    status: 'active',
    created_at: '2026-05-29T00:00:00Z',
    last_active: '2026-05-29T00:00:00Z',
    container_status: 'running',
  } as Session;
}

describe('executeControlCommand', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('/pause transitions to paused and reports it', () => {
    const out = executeControlCommand('/pause', null, 'owner-1');
    expect(out.state).toBe('paused');
    expect(out.killed).toBe(0);
    expect(out.message.toLowerCase()).toContain('paused');
    expect(getPauseState()).toBe('paused');
  });

  it('/resume returns to active from paused', () => {
    setPauseState('paused', 'earlier', 'owner-1');
    const out = executeControlCommand('/resume', null, 'owner-1');
    expect(out.state).toBe('active');
    expect(getPauseState()).toBe('active');
    expect(getPauseReason()).toBeNull();
  });

  it('/halt transitions to halted and kills every running container', () => {
    const kill = vi.fn();
    const out = executeControlCommand('/halt', 'deploying', 'owner-1', {
      getRunningSessions: () => [fakeSession('s1'), fakeSession('s2')],
      killContainer: kill,
    });

    expect(out.state).toBe('halted');
    expect(out.killed).toBe(2);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith('s1', 'halt');
    expect(kill).toHaveBeenCalledWith('s2', 'halt');
    expect(getPauseState()).toBe('halted');
    expect(getPauseReason()).toBe('deploying');
    expect(out.message).toContain('2 running container');
  });

  it('/resume refuses to clear an engaged killswitch (manual recovery only)', () => {
    setPauseState('killswitch', 'incident', 'owner-1');
    const out = executeControlCommand('/resume', null, 'owner-1');
    expect(out.state).toBe('killswitch');
    expect(out.message).toContain('recover-from-killswitch.sh');
    // State unchanged — still engaged.
    expect(getPauseState()).toBe('killswitch');
  });

  it('/halt with no running containers reports zero killed', () => {
    const out = executeControlCommand('/halt', null, 'owner-1', {
      getRunningSessions: () => [],
      killContainer: vi.fn(),
    });
    expect(out.killed).toBe(0);
    expect(out.message).toContain('0 running container');
  });
});

describe('parseControlReason', () => {
  it('returns the text after the command token', () => {
    expect(parseControlReason('/halt deploying a fix')).toBe('deploying a fix');
    expect(parseControlReason('/pause   cost spike  ')).toBe('cost spike');
  });

  it('returns null when no reason is given', () => {
    expect(parseControlReason('/pause')).toBeNull();
    expect(parseControlReason('/resume   ')).toBeNull();
  });
});
