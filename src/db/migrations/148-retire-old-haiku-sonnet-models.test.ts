/**
 * Tests for migration 148 (STRATEGY.md §24.197): stored model choices naming a
 * pre-5.5 Haiku or Sonnet move to their tier's 5.5 model; nothing else is touched.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { MODEL_OPTIONS } from '../../modules/portal/knob-registry.js';

import { RETIRED_MODEL_SUCCESSORS, migration148 } from './148-retire-old-haiku-sonnet-models.js';

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

describe('migration 148 — retire pre-5.5 Haiku and Sonnet', () => {
  it('moves each retired model to its own tier, whatever the key', () => {
    const db = seed([
      ['owner_orchestrator_model', ['claude', 'sonnet', '5'].join('-')],
      ['lead_ranking_model', ['claude', 'sonnet', '4', '6'].join('-')],
      ['owner_model_research_company', ['claude', 'haiku', '4', '5'].join('-')],
      ['some_future_model_knob', ['claude', 'haiku', '4', '5'].join('-')],
    ]);
    migration148.up(db);
    expect(values(db)).toEqual({
      owner_orchestrator_model: 'claude-sonnet-5-5',
      lead_ranking_model: 'claude-sonnet-5-5',
      owner_model_research_company: 'claude-haiku-5-5',
      some_future_model_knob: 'claude-haiku-5-5',
    });
  });

  it('leaves current models, `inherit` and non-model values untouched (incl. their updated_at)', () => {
    const db = seed([
      ['sandbox_orchestrator_model', 'claude-sonnet-5-5'],
      ['tailor_lead_model', 'claude-opus-5-5'],
      ['owner_model_draft_outreach', 'inherit'],
      ['owner_daily_llm_budget_usd', '5'],
    ]);
    migration148.up(db);
    expect(values(db)).toEqual({
      sandbox_orchestrator_model: 'claude-sonnet-5-5',
      tailor_lead_model: 'claude-opus-5-5',
      owner_model_draft_outreach: 'inherit',
      owner_daily_llm_budget_usd: '5',
    });
    const stamps = db.prepare('SELECT DISTINCT updated_at FROM preferences').all() as { updated_at: string }[];
    expect(stamps).toEqual([{ updated_at: '2026-01-01T00:00:00.000Z' }]);
  });

  it('is idempotent and tolerates a DB with no preferences table', () => {
    const db = seed([['win_confidence_model', ['claude', 'sonnet', '5'].join('-')]]);
    migration148.up(db);
    migration148.up(db);
    expect(values(db)).toEqual({ win_confidence_model: 'claude-sonnet-5-5' });
    expect(() => migration148.up(new Database(':memory:'))).not.toThrow();
  });

  it('every successor is a model that can still be selected, and none is itself retired', () => {
    for (const [retired, successor] of Object.entries(RETIRED_MODEL_SUCCESSORS)) {
      expect(MODEL_OPTIONS, `${retired} → ${successor}`).toContain(successor);
      expect(MODEL_OPTIONS).not.toContain(retired);
    }
  });
});
