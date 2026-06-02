/**
 * Integration + unit tests for the Phase 5 BFF-readiness read-model
 * (STRATEGY.md §24.14):
 *   - deriveFunnelStage / isKnownApplicationStatus (pure)
 *   - upsertPublicFunnelView (projection: obfuscated vs public application_ref,
 *     stage mapping, stage_entered_at, sanitized published_learning, refresh)
 *   - public_audit_trail.seq monotonic cursor (across both writers + resanitize)
 *   - migration 123 backfill
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { migration123 } from '../../db/migrations/123-audit-seq.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import { handleRecordProgress } from '../career-pilot/actions.js';

import { mirrorFunnelEvent, resanitizeApplicationAuditTrail } from './public-audit.js';
import { deriveFunnelStage, isKnownApplicationStatus, upsertPublicFunnelView } from './public-funnel-view.js';

// ── Fixture ──────────────────────────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-pfv-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_SESSION: Session = {
  id: 'pfv-session-1',
  agent_group_id: 'test-agent-group',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-05-26T00:00:00Z',
};

let db: Database.Database;
let inDb: Database.Database;

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  db = initTestDb();
  runMigrations(db);

  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function seedApp(opts: {
  id: string;
  company_name: string;
  obfuscated_label: string;
  public_state?: string;
  status?: string;
  role_title?: string;
  win_confidence?: number | null;
  applied_at?: string | null;
  last_activity_at?: string | null;
}): void {
  db.prepare(
    `INSERT INTO applications (
       id, company_name, company_aliases, obfuscated_label, public_state,
       role_title, status, win_confidence, applied_at, last_activity_at, created_at
     ) VALUES (
       @id, @company_name, NULL, @obfuscated_label, @public_state,
       @role_title, @status, @win_confidence, @applied_at, @last_activity_at, @created_at
     )`,
  ).run({
    id: opts.id,
    company_name: opts.company_name,
    obfuscated_label: opts.obfuscated_label,
    public_state: opts.public_state ?? 'obfuscated',
    role_title: opts.role_title ?? 'Senior Engineer',
    status: opts.status ?? 'APPLIED',
    win_confidence: opts.win_confidence ?? null,
    applied_at: opts.applied_at ?? '2026-05-01T00:00:00Z',
    last_activity_at: opts.last_activity_at ?? '2026-05-10T00:00:00Z',
    created_at: '2026-05-01T00:00:00Z',
  });
}

function seedEvent(opts: {
  id: string;
  application_id: string;
  to_status?: string | null;
  payload?: string;
  ts?: string;
}): void {
  db.prepare(
    `INSERT INTO funnel_events (id, application_id, kind, from_status, to_status, payload, source, ts)
     VALUES (@id, @application_id, 'status_change', NULL, @to_status, @payload, 'agent', @ts)`,
  ).run({
    id: opts.id,
    application_id: opts.application_id,
    to_status: opts.to_status ?? null,
    payload: opts.payload ?? '{}',
    ts: opts.ts ?? '2026-05-10T00:00:00Z',
  });
}

function seedLearning(opts: {
  id: string;
  application_id: string;
  reflections: string;
  published?: boolean;
  created_at?: string;
}): void {
  db.prepare(
    `INSERT INTO learnings (id, application_id, kind, role_category, reflections, reflection_published, created_at)
     VALUES (@id, @application_id, 'rejection', 'fintech', @reflections, @published, @created_at)`,
  ).run({
    id: opts.id,
    application_id: opts.application_id,
    reflections: opts.reflections,
    published: opts.published ? 1 : 0,
    created_at: opts.created_at ?? '2026-05-12T00:00:00Z',
  });
}

interface ViewRow {
  application_id: string;
  application_ref: string;
  public_state: string;
  role_title: string | null;
  status: string;
  stage: string;
  applied_at: string | null;
  stage_entered_at: string | null;
  last_activity_at: string | null;
  win_confidence: number | null;
  published_learning: string | null;
  updated_at: string;
}

function readView(applicationId: string): ViewRow | undefined {
  return db.prepare('SELECT * FROM public_funnel_view WHERE application_id = ?').get(applicationId) as
    | ViewRow
    | undefined;
}

function progressContent(payload: Record<string, unknown>): Record<string, unknown> {
  return { requestId: `req-${Math.random().toString(36).slice(2, 8)}`, payload };
}

// ── deriveFunnelStage (pure) ─────────────────────────────────────────────

describe('deriveFunnelStage', () => {
  it.each([
    ['BOOKMARKED', 'bookmarked'],
    ['APPLIED', 'applied'],
    ['SCREENING', 'screening'],
    ['TECH_SCREEN', 'tech'],
    ['SYS_DESIGN', 'tech'],
    ['FINAL', 'final'],
    ['OFFER', 'offer'],
    ['REJECTED', 'rejected'],
    ['WITHDRAWN', 'withdrawn'],
  ])('maps %s → %s', (status, stage) => {
    expect(deriveFunnelStage(status)).toBe(stage);
  });

  it('is case-insensitive', () => {
    expect(deriveFunnelStage('applied')).toBe('applied');
  });

  it('passes an unknown status through lowercased (never null/empty)', () => {
    expect(deriveFunnelStage('SOMETHING_NEW')).toBe('something_new');
  });

  it('falls back to "applied" for null/empty', () => {
    expect(deriveFunnelStage(null)).toBe('applied');
    expect(deriveFunnelStage('')).toBe('applied');
    expect(deriveFunnelStage(undefined)).toBe('applied');
  });
});

describe('isKnownApplicationStatus', () => {
  it('recognizes canonical statuses (case-insensitively)', () => {
    expect(isKnownApplicationStatus('APPLIED')).toBe(true);
    expect(isKnownApplicationStatus('applied')).toBe(true);
  });
  it('rejects unknown statuses', () => {
    expect(isKnownApplicationStatus('BOGUS')).toBe(false);
  });
});

// ── upsertPublicFunnelView ───────────────────────────────────────────────

describe('upsertPublicFunnelView', () => {
  it('projects an obfuscated application with the derived stage', () => {
    seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a', status: 'SCREENING' });
    upsertPublicFunnelView(db, 'app-1');

    const v = readView('app-1');
    expect(v).toBeDefined();
    expect(v!.application_ref).toBe('fintech-a');
    expect(v!.public_state).toBe('obfuscated');
    expect(v!.status).toBe('SCREENING');
    expect(v!.stage).toBe('screening');
    expect(v!.role_title).toBe('Senior Engineer');
  });

  it('shows the real company name when public_state=public', () => {
    seedApp({
      id: 'app-1',
      company_name: 'Acme Corp',
      obfuscated_label: 'fintech-a',
      public_state: 'public',
      status: 'OFFER',
    });
    upsertPublicFunnelView(db, 'app-1');

    const v = readView('app-1');
    expect(v!.application_ref).toBe('Acme Corp');
    expect(v!.stage).toBe('offer');
  });

  it('carries win_confidence', () => {
    seedApp({ id: 'app-1', company_name: 'Acme', obfuscated_label: 'fintech-a', win_confidence: 72 });
    upsertPublicFunnelView(db, 'app-1');
    expect(readView('app-1')!.win_confidence).toBe(72);
  });

  it('derives stage_entered_at from the latest matching funnel_event', () => {
    seedApp({ id: 'app-1', company_name: 'Acme', obfuscated_label: 'fintech-a', status: 'APPLIED' });
    seedEvent({ id: 'fe-1', application_id: 'app-1', to_status: 'APPLIED', ts: '2026-05-05T00:00:00Z' });
    upsertPublicFunnelView(db, 'app-1');
    expect(readView('app-1')!.stage_entered_at).toBe('2026-05-05T00:00:00Z');
  });

  it('falls back to last_activity_at when no matching event exists', () => {
    seedApp({
      id: 'app-1',
      company_name: 'Acme',
      obfuscated_label: 'fintech-a',
      status: 'FINAL',
      last_activity_at: '2026-05-18T00:00:00Z',
    });
    upsertPublicFunnelView(db, 'app-1');
    expect(readView('app-1')!.stage_entered_at).toBe('2026-05-18T00:00:00Z');
  });

  it('includes a sanitized published-learning excerpt (real name + PII absent)', () => {
    seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
    seedLearning({
      id: 'lrn-1',
      application_id: 'app-1',
      published: true,
      reflections: JSON.stringify({
        what_worked: 'Strong rapport with the Acme Corp panel.',
        what_didnt: 'Reach me at jane@acme.com next time.',
      }),
    });
    upsertPublicFunnelView(db, 'app-1');

    const v = readView('app-1');
    expect(v!.published_learning).toBeTruthy();
    expect(v!.published_learning!).toContain('[REDACTED:fintech-a]');
    expect(v!.published_learning!).not.toContain('Acme Corp');
    expect(v!.published_learning!).not.toContain('jane@acme.com');
  });

  it('omits unpublished learnings', () => {
    seedApp({ id: 'app-1', company_name: 'Acme', obfuscated_label: 'fintech-a' });
    seedLearning({
      id: 'lrn-1',
      application_id: 'app-1',
      published: false,
      reflections: JSON.stringify({ what_worked: 'private note' }),
    });
    upsertPublicFunnelView(db, 'app-1');
    expect(readView('app-1')!.published_learning).toBeNull();
  });

  it('refreshes application_ref after a public_state flip (re-upsert)', () => {
    seedApp({ id: 'app-1', company_name: 'Acme Corp', obfuscated_label: 'fintech-a' });
    upsertPublicFunnelView(db, 'app-1');
    expect(readView('app-1')!.application_ref).toBe('fintech-a');

    db.prepare("UPDATE applications SET public_state = 'public' WHERE id = 'app-1'").run();
    upsertPublicFunnelView(db, 'app-1');

    const v = readView('app-1');
    expect(v!.application_ref).toBe('Acme Corp');
    expect(v!.public_state).toBe('public');
  });

  it('is a no-op (no throw, no row) when the application does not exist', () => {
    expect(() => upsertPublicFunnelView(db, 'missing')).not.toThrow();
    expect(readView('missing')).toBeUndefined();
  });
});

// ── public_audit_trail.seq cursor ────────────────────────────────────────

describe('public_audit_trail.seq', () => {
  function seqs(): number[] {
    return (db.prepare('SELECT seq FROM public_audit_trail ORDER BY seq ASC').all() as Array<{ seq: number }>).map(
      (r) => r.seq,
    );
  }

  it('assigns strictly increasing seq across mirrorFunnelEvent inserts', () => {
    seedApp({ id: 'app-1', company_name: 'Acme', obfuscated_label: 'fintech-a' });
    seedEvent({ id: 'fe-1', application_id: 'app-1', payload: JSON.stringify({ note: 'one' }) });
    seedEvent({ id: 'fe-2', application_id: 'app-1', payload: JSON.stringify({ note: 'two' }) });
    seedEvent({ id: 'fe-3', application_id: 'app-1', payload: JSON.stringify({ note: 'three' }) });

    expect(mirrorFunnelEvent(db, 'fe-1')).toBe('inserted');
    expect(mirrorFunnelEvent(db, 'fe-2')).toBe('inserted');
    expect(mirrorFunnelEvent(db, 'fe-3')).toBe('inserted');

    expect(seqs()).toEqual([1, 2, 3]);
  });

  it('continues one monotonic sequence across both writers (mirror + record_progress)', async () => {
    seedApp({ id: 'app-1', company_name: 'Acme', obfuscated_label: 'fintech-a' });
    seedEvent({ id: 'fe-1', application_id: 'app-1', payload: JSON.stringify({ note: 'one' }) });
    seedEvent({ id: 'fe-2', application_id: 'app-1', payload: JSON.stringify({ note: 'two' }) });

    expect(mirrorFunnelEvent(db, 'fe-1')).toBe('inserted'); // seq 1 (funnel)
    await handleRecordProgress(
      progressContent({ subagent_name: 'research-company', stage: 'start', detail: 'digging in' }),
      FAKE_SESSION,
      inDb,
    ); // seq 2 (subagent_progress)
    expect(mirrorFunnelEvent(db, 'fe-2')).toBe('inserted'); // seq 3 (funnel)

    const rows = db.prepare('SELECT seq, category FROM public_audit_trail ORDER BY seq ASC').all() as Array<{
      seq: number;
      category: string;
    }>;
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.category)).toEqual(['funnel', 'subagent_progress', 'funnel']);
  });

  it('re-mirrored rows after resanitize sort after surviving rows (fresh MAX+1 seq)', () => {
    // Two apps so a surviving row preserves the MAX counter when app-1's row
    // is deleted + re-mirrored. (When ALL higher rows are deleted, MAX+1
    // legitimately reuses a freed seq — acceptable for a forward tail, since
    // new fetchers always re-read from the cursor.)
    seedApp({
      id: 'app-1',
      company_name: 'Acme Corp',
      obfuscated_label: 'fintech-a',
      public_state: 'public',
    });
    seedApp({ id: 'app-2', company_name: 'Globex', obfuscated_label: 'retail-a' });
    seedEvent({ id: 'fe-1', application_id: 'app-1', payload: JSON.stringify({ note: 'call with Acme Corp' }) });
    seedEvent({ id: 'fe-2', application_id: 'app-2', payload: JSON.stringify({ note: 'note for Globex' }) });

    expect(mirrorFunnelEvent(db, 'fe-1')).toBe('inserted'); // seq 1
    expect(mirrorFunnelEvent(db, 'fe-2')).toBe('inserted'); // seq 2
    const app2Seq = (
      db.prepare("SELECT seq FROM public_audit_trail WHERE source_funnel_event_id = 'fe-2'").get() as { seq: number }
    ).seq;

    db.prepare("UPDATE applications SET public_state = 'obfuscated' WHERE id = 'app-1'").run();
    expect(resanitizeApplicationAuditTrail(db, 'app-1')).toEqual({ rewritten: 1, deleted: 1 });

    const app1Seq = (
      db.prepare("SELECT seq FROM public_audit_trail WHERE source_funnel_event_id = 'fe-1'").get() as { seq: number }
    ).seq;
    expect(app1Seq).toBeGreaterThan(app2Seq);

    // No duplicate seq across the table.
    const all = seqs();
    expect(new Set(all).size).toBe(all.length);
  });
});

// ── migration 123 backfill ───────────────────────────────────────────────

describe('migration 123 backfill', () => {
  it('assigns 1..N over existing rows in (ts, id) order', () => {
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE public_audit_trail (
        id        TEXT PRIMARY KEY,
        ts        TEXT NOT NULL,
        category  TEXT NOT NULL,
        summary   TEXT NOT NULL
      );
    `);
    const ins = raw.prepare("INSERT INTO public_audit_trail (id, ts, category, summary) VALUES (?, ?, 'funnel', ?)");
    ins.run('c', '2026-01-03T00:00:00Z', 'c');
    ins.run('a', '2026-01-01T00:00:00Z', 'a');
    ins.run('b', '2026-01-02T00:00:00Z', 'b');

    migration123.up(raw);

    const rows = raw.prepare('SELECT id, seq FROM public_audit_trail ORDER BY seq ASC').all() as Array<{
      id: string;
      seq: number;
    }>;
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    raw.close();
  });
});
