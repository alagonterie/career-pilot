/**
 * Tests for migration 142 (STRATEGY.md §24.152): the funnel→pipeline rename of
 * the two career-pilot tables + the funnel_curator_* preference keys.
 *
 * Exercises migration142.up directly against a seeded pre-142 schema so the
 * data-preservation + idempotency guarantees are proven without the full chain.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { migration142 } from './142-funnel-to-pipeline-rename.js';

function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
  );
}

function indexNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name),
  );
}

function seedPre142(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE funnel_events (
      id             INTEGER PRIMARY KEY,
      application_id TEXT NOT NULL,
      ts             TEXT NOT NULL,
      kind           TEXT
    );
    CREATE INDEX idx_funnel_events_app ON funnel_events(application_id, ts DESC);

    CREATE TABLE public_funnel_view (
      application_id TEXT PRIMARY KEY,
      stage          TEXT NOT NULL,
      status         TEXT
    );
    CREATE INDEX idx_public_funnel_view_stage ON public_funnel_view(stage);

    CREATE TABLE funnel_curator_output (
      id     TEXT PRIMARY KEY,
      run_at TEXT NOT NULL
    );
    CREATE INDEX idx_funnel_curator_output_run_at ON funnel_curator_output(run_at DESC);

    CREATE TABLE public_audit_trail (
      seq                    INTEGER PRIMARY KEY,
      source_funnel_event_id TEXT
    );
    CREATE INDEX idx_audit_source_fe ON public_audit_trail(source_funnel_event_id);

    CREATE TABLE preferences (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO funnel_events (id, application_id, ts, kind) VALUES (?, ?, ?, ?)').run(
    1,
    'app-1',
    '2026-06-01T00:00:00Z',
    'stage_change',
  );
  db.prepare('INSERT INTO funnel_curator_output (id, run_at) VALUES (?, ?)').run('run-1', '2026-06-01T07:30:00Z');
  db.prepare('INSERT INTO public_audit_trail (seq, source_funnel_event_id) VALUES (?, ?)').run(1, 'fe-1');
  db.prepare('INSERT INTO public_funnel_view (application_id, stage, status) VALUES (?, ?, ?)').run(
    'app-1',
    'interview',
    'active',
  );
  // Two overridden knobs — the rename must preserve their values.
  db.prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(
    'funnel_curator_enabled',
    'false',
    '2026-06-01T00:00:00Z',
  );
  db.prepare('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(
    'funnel_curator_cron',
    '0 9 * * *',
    '2026-06-01T00:00:00Z',
  );
  return db;
}

describe('migration 142 — funnel→pipeline rename', () => {
  it('renames all three tables + their indexes + the audit column, preserving rows', () => {
    const db = seedPre142();
    migration142.up(db);

    const tables = tableNames(db);
    expect(tables.has('pipeline_events')).toBe(true);
    expect(tables.has('funnel_events')).toBe(false);
    expect(tables.has('public_pipeline_view')).toBe(true);
    expect(tables.has('public_funnel_view')).toBe(false);
    expect(tables.has('pipeline_scribe_output')).toBe(true);
    expect(tables.has('funnel_curator_output')).toBe(false);

    const idx = indexNames(db);
    expect(idx.has('idx_pipeline_events_app')).toBe(true);
    expect(idx.has('idx_funnel_events_app')).toBe(false);
    expect(idx.has('idx_public_pipeline_view_stage')).toBe(true);
    expect(idx.has('idx_public_funnel_view_stage')).toBe(false);
    expect(idx.has('idx_pipeline_scribe_output_run_at')).toBe(true);
    expect(idx.has('idx_funnel_curator_output_run_at')).toBe(false);

    const auditCols = new Set(
      (db.prepare('SELECT name FROM pragma_table_info(?)').all('public_audit_trail') as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(auditCols.has('source_pipeline_event_id')).toBe(true);
    expect(auditCols.has('source_funnel_event_id')).toBe(false);

    expect(
      (db.prepare('SELECT application_id FROM pipeline_events WHERE id = 1').get() as { application_id: string })
        .application_id,
    ).toBe('app-1');
    expect(
      (db.prepare('SELECT stage FROM public_pipeline_view WHERE application_id = ?').get('app-1') as { stage: string })
        .stage,
    ).toBe('interview');
    expect((db.prepare('SELECT id FROM pipeline_scribe_output').get() as { id: string }).id).toBe('run-1');
    expect(
      (db.prepare('SELECT source_pipeline_event_id AS v FROM public_audit_trail WHERE seq = 1').get() as { v: string })
        .v,
    ).toBe('fe-1');
  });

  it('renames funnel_curator_* preference keys, preserving overridden values', () => {
    const db = seedPre142();
    migration142.up(db);

    expect(db.prepare("SELECT 1 FROM preferences WHERE key = 'funnel_curator_enabled'").get()).toBeUndefined();
    expect(
      (db.prepare("SELECT value FROM preferences WHERE key = 'pipeline_scribe_enabled'").get() as { value: string })
        .value,
    ).toBe('false');
    expect(
      (db.prepare("SELECT value FROM preferences WHERE key = 'pipeline_scribe_cron'").get() as { value: string }).value,
    ).toBe('0 9 * * *');
  });

  it('is idempotent — a second up() is a no-op and does not throw', () => {
    const db = seedPre142();
    migration142.up(db);
    expect(() => migration142.up(db)).not.toThrow();

    const tables = tableNames(db);
    expect(tables.has('pipeline_events')).toBe(true);
    expect(tables.has('funnel_events')).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM pipeline_events').get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare("SELECT value FROM preferences WHERE key = 'pipeline_scribe_enabled'").get() as { value: string })
        .value,
    ).toBe('false');
  });
});
