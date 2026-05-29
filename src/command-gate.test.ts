/**
 * Unit tests for the host command gate. Covers the Sub-milestone 5.4a control
 * plane (/pause /resume /halt → { action: 'control' } for admins, deny for
 * non-admins) alongside the pre-existing filter/admin/pass classification.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { gateCommand } from './command-gate.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';

describe('gateCommand', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
    // FK off so we can seed user_roles without a parent users/agent_groups row.
    db.pragma('foreign_keys = OFF');
    // Grant 'owner-1' the owner role host-wide (agent_group_id NULL).
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES ('owner-1', 'owner', NULL, NULL, '2026-05-29T00:00:00Z')`,
    ).run();
  });

  afterEach(() => {
    closeDb();
  });

  it('classifies /pause /resume /halt as control for an admin', () => {
    expect(gateCommand('/pause', 'owner-1', 'ag-1')).toEqual({ action: 'control', command: '/pause' });
    expect(gateCommand('/resume', 'owner-1', 'ag-1')).toEqual({ action: 'control', command: '/resume' });
    expect(gateCommand('/halt', 'owner-1', 'ag-1')).toEqual({ action: 'control', command: '/halt' });
  });

  it('extracts the command from JSON content and ignores trailing reason text', () => {
    expect(gateCommand('{"text":"/halt deploying a fix"}', 'owner-1', 'ag-1')).toEqual({
      action: 'control',
      command: '/halt',
    });
  });

  it('denies control commands from a non-admin', () => {
    expect(gateCommand('/pause', 'rando', 'ag-1')).toEqual({ action: 'deny', command: '/pause' });
  });

  it('denies control commands from an unauthenticated sender (null userId)', () => {
    expect(gateCommand('/halt', null, 'ag-1')).toEqual({ action: 'deny', command: '/halt' });
  });

  it('still passes normal messages and unknown slash commands', () => {
    expect(gateCommand('hello there', 'owner-1', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/unknown-thing', 'owner-1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('still filters filtered commands and gates admin commands', () => {
    expect(gateCommand('/help', 'owner-1', 'ag-1')).toEqual({ action: 'filter' });
    expect(gateCommand('/clear', 'owner-1', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/clear', 'rando', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('is case-insensitive on the command token', () => {
    expect(gateCommand('/PAUSE', 'owner-1', 'ag-1')).toEqual({ action: 'control', command: '/pause' });
  });
});
