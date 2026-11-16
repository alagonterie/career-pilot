/**
 * Migration 154 (STRATEGY.md §24.201 D6d): a STORED killer-match allow-list gains
 * 'ashby'; an absent row, an empty list, a list that has it, and a non-array are
 * left alone.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { KILLER_MATCH_ALLOW_LIST_KEY, migration154 } from './154-killer-match-allow-ashby.js';

function db(value?: string): Database.Database {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  if (value !== undefined) {
    d.prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(
      KILLER_MATCH_ALLOW_LIST_KEY,
      value,
      '2026-01-01T00:00:00.000Z',
    );
  }
  return d;
}

function stored(d: Database.Database): { value: string; updated_at: string } | undefined {
  return d.prepare('SELECT value, updated_at FROM preferences WHERE key = ?').get(KILLER_MATCH_ALLOW_LIST_KEY) as
    | { value: string; updated_at: string }
    | undefined;
}

describe('migration 154 — append ashby to a stored killer-match allow-list', () => {
  it('appends ashby to a stored override', () => {
    const d = db('["greenhouse","lever"]');
    migration154.up(d);
    expect(JSON.parse(stored(d)!.value)).toEqual(['greenhouse', 'lever', 'ashby']);
    migration154.up(d); // idempotent
    expect(JSON.parse(stored(d)!.value)).toEqual(['greenhouse', 'lever', 'ashby']);
  });

  it('leaves an empty list (alerts deliberately off), a list with ashby, and a non-array untouched', () => {
    for (const v of ['[]', '["ashby","lever"]', 'not json', '{"a":1}']) {
      const d = db(v);
      migration154.up(d);
      expect(stored(d)).toEqual({ value: v, updated_at: '2026-01-01T00:00:00.000Z' });
    }
  });

  it('is a no-op without a row or without the table', () => {
    const d = db();
    migration154.up(d);
    expect(stored(d)).toBeUndefined();
    expect(() => migration154.up(new Database(':memory:'))).not.toThrow();
  });
});
