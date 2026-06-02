/**
 * Unit tests for the dev fixture/demo data harness (STRATEGY §24.26):
 *   - seedRichFixture populates the four dynamic-page surfaces
 *   - the synthetic generator emits valid rows + bumps seq
 *   - maybeAdvanceFunnel advances an in-flight application to a valid stage
 *   - the PORTAL_MOCK_PORTKEY env seam (set → mock; unset → existing path)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { getActiveSessions, getRunningSessions } from '../../../db/sessions.js';
import { APPLICATION_STATUSES, deriveFunnelStage } from '../public-funnel-view.js';
import { getPortkeyAnalytics } from '../portkey-analytics.js';

import {
  buildSyntheticEvent,
  insertSyntheticEvent,
  maybeAdvanceFunnel,
  newGeneratorState,
  seedDeterministicBacklog,
  seedDeterministicFunnel,
  seedRichFixture,
} from './fixtures.js';

let db: Database.Database;

beforeEach(() => {
  db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('seedRichFixture', () => {
  it('populates every dynamic-page surface', () => {
    seedRichFixture(db);

    expect(count('public_audit_trail')).toBeGreaterThan(20);
    expect(count('simulator_runs')).toBeGreaterThan(0);

    // Funnel view: one row per seeded application, spanning multiple stages.
    const stages = (db.prepare('SELECT DISTINCT stage FROM public_funnel_view').all() as { stage: string }[]).map(
      (r) => r.stage,
    );
    expect(count('public_funnel_view')).toBeGreaterThan(4);
    expect(stages).toEqual(expect.arrayContaining(['applied', 'offer']));

    // Sessions feed /api/architecture's active/running counts.
    expect(getActiveSessions().length).toBeGreaterThan(0);
    expect(getRunningSessions().length).toBeGreaterThan(0);
  });

  it('keeps the public OFFER application showing a real company (obfuscated otherwise)', () => {
    seedRichFixture(db);
    const offer = db
      .prepare(`SELECT application_ref, public_state FROM public_funnel_view WHERE stage = 'offer'`)
      .get() as { application_ref: string; public_state: string } | undefined;
    expect(offer?.public_state).toBe('public');
    expect(offer?.application_ref).toBe('Wayne Enterprises');
  });
});

describe('synthetic generator', () => {
  it('builds a valid event and bumps seq on insert', () => {
    seedRichFixture(db);
    const before = (db.prepare('SELECT MAX(seq) AS m FROM public_audit_trail').get() as { m: number }).m;

    const state = newGeneratorState();
    const ev = buildSyntheticEvent(state);
    expect(ev.summary).toBeTruthy();
    expect(ev.category).toBeTruthy();

    const seq = insertSyntheticEvent(db, state);
    expect(seq).toBe(before + 1);
    expect(state.tick).toBe(1);
    expect((db.prepare('SELECT MAX(seq) AS m FROM public_audit_trail').get() as { m: number }).m).toBe(before + 1);
  });

  it('advances the stalest in-flight application to a valid next stage', () => {
    seedRichFixture(db);
    const target = db
      .prepare(
        `SELECT id, status FROM applications
          WHERE status IN ('APPLIED','SCREENING','TECH_SCREEN','SYS_DESIGN','FINAL')
          ORDER BY last_activity_at ASC LIMIT 1`,
      )
      .get() as { id: string; status: string };

    const state = newGeneratorState();
    state.tick = 5; // 5 % 5 === 0 → advance fires
    maybeAdvanceFunnel(db, state);

    const after = db.prepare('SELECT status FROM applications WHERE id = ?').get(target.id) as { status: string };
    expect(after.status).not.toBe(target.status);
    const view = db.prepare('SELECT stage FROM public_funnel_view WHERE application_id = ?').get(target.id) as {
      stage: string;
    };
    expect(view.stage).toBe(deriveFunnelStage(after.status));
  });

  it('does nothing on a non-multiple-of-5 tick', () => {
    seedRichFixture(db);
    const before = db.prepare('SELECT status FROM applications ORDER BY id').all();
    const state = newGeneratorState();
    state.tick = 3;
    maybeAdvanceFunnel(db, state);
    expect(db.prepare('SELECT status FROM applications ORDER BY id').all()).toEqual(before);
  });
});

describe('PORTAL_MOCK_PORTKEY env seam', () => {
  afterEach(() => {
    delete process.env.PORTAL_MOCK_PORTKEY;
  });

  it('returns the injected summary when set', async () => {
    process.env.PORTAL_MOCK_PORTKEY = JSON.stringify({ total_requests: 7, top_model: 'opus-4-8' });
    const res = await getPortkeyAnalytics();
    expect(res.available).toBe(true);
    expect((res.summary as { total_requests: number }).total_requests).toBe(7);
  });

  it('is inert when unset (no key → unavailable, no network)', async () => {
    delete process.env.PORTAL_MOCK_PORTKEY;
    const prevKey = process.env.PORTKEY_API_KEY;
    delete process.env.PORTKEY_API_KEY;
    const res = await getPortkeyAnalytics();
    expect(res.available).toBe(false);
    if (prevKey !== undefined) process.env.PORTKEY_API_KEY = prevKey;
  });
});

describe('seedDeterministicFunnel', () => {
  it('populates public_funnel_view across the pipeline stages with one public OFFER', () => {
    seedDeterministicFunnel(db);

    const stages = (db.prepare('SELECT stage FROM public_funnel_view').all() as { stage: string }[]).map(
      (r) => r.stage,
    );
    expect(stages).toEqual(expect.arrayContaining(['applied', 'screening', 'tech', 'final', 'offer']));

    const offer = db
      .prepare(`SELECT application_ref, public_state FROM public_funnel_view WHERE stage = 'offer'`)
      .get() as { application_ref: string; public_state: string } | undefined;
    expect(offer?.public_state).toBe('public');
    expect(offer?.application_ref).toBe('Wayne Enterprises');
  });

  it('composes with seedDeterministicBacklog without conflicting on system_modes', () => {
    // The E2E server calls both; the funnel seed must not re-write system_modes.
    expect(() => {
      seedDeterministicBacklog(db);
      seedDeterministicFunnel(db);
    }).not.toThrow();
    expect(count('public_funnel_view')).toBe(5);
    expect(count('public_audit_trail')).toBe(3);
  });
});

// Sanity: the seeded statuses are all part of the canonical vocabulary.
describe('seed integrity', () => {
  it('seeds only known application statuses', () => {
    seedRichFixture(db);
    const statuses = (db.prepare('SELECT DISTINCT status FROM applications').all() as { status: string }[]).map(
      (r) => r.status,
    );
    for (const s of statuses) {
      expect(APPLICATION_STATUSES as readonly string[]).toContain(s);
    }
  });
});
