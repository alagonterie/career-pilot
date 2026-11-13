/**
 * Tests for migration 147 (STRATEGY.md §24.195): stored model choices naming a
 * retired Opus move to the one remaining Opus; nothing else is touched.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { migration147 } from './147-retire-old-opus-models.js';

function seed(rows: Array<[string, string]>): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const ins = db.prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of rows) ins.run(k, v, '2026-01-01T00:00:00.000Z');
  return db;
}

function values(db: Database.Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.prepare('SELECT key, value FROM preferences').all() as { key: string; value: string }[]) {
    out[r.key] = r.value;
  }
  return out;
}

describe('migration 147 — retire old Opus models', () => {
  it('rewrites every retired-Opus value to Opus 5.5, whatever the key', () => {
    const db = seed([
      ['tailor_lead_model', 'claude-opus-5'],
      ['owner_model_build_interview_kit', 'claude-opus-4-8'],
      ['some_future_model_knob', 'claude-opus-5'],
    ]);
    migration147.up(db);
    expect(values(db)).toEqual({
      tailor_lead_model: 'claude-opus-5-5',
      owner_model_build_interview_kit: 'claude-opus-5-5',
      some_future_model_knob: 'claude-opus-5-5',
    });
  });

  it('leaves non-Opus and already-current values untouched (incl. their updated_at)', () => {
    const db = seed([
      ['win_confidence_model', 'claude-sonnet-4-6'],
      ['owner_model_draft_outreach', 'inherit'],
      ['kit_entity_redact_model', 'claude-opus-5-5'],
      ['owner_daily_llm_budget_usd', '5'],
    ]);
    migration147.up(db);
    expect(values(db)).toEqual({
      win_confidence_model: 'claude-sonnet-4-6',
      owner_model_draft_outreach: 'inherit',
      kit_entity_redact_model: 'claude-opus-5-5',
      owner_daily_llm_budget_usd: '5',
    });
    const stamps = db.prepare('SELECT DISTINCT updated_at FROM preferences').all() as { updated_at: string }[];
    expect(stamps).toEqual([{ updated_at: '2026-01-01T00:00:00.000Z' }]);
  });

  it('is idempotent and tolerates a DB with no preferences table', () => {
    const db = seed([['tailor_lead_model', 'claude-opus-5']]);
    migration147.up(db);
    migration147.up(db);
    expect(values(db)).toEqual({ tailor_lead_model: 'claude-opus-5-5' });
    expect(() => migration147.up(new Database(':memory:'))).not.toThrow();
  });
});
