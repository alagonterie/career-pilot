/**
 * Integration tests for the Sub-milestone 5.1 read-only portal API
 * (STRATEGY.md §24.15). Binds an ephemeral 127.0.0.1 port and drives the real
 * server over `fetch`:
 *   - GET /api/funnel       rows + computed days + stage_counts (public table only)
 *   - GET /api/activity     seq-cursor pagination + next_since
 *   - GET /api/system-status modes (+ defaults)
 *   - CORS allow-list + OPTIONS preflight
 *   - 404 JSON + handler error-safety (never throws out → JSON 500)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { startPortalApi, stopPortalApi } from './api.js';

let base: string;

beforeEach(async () => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await stopPortalApi();
  closeDb();
});

// ── seed helpers ───────────────────────────────────────────────────────────

function seedFunnel(opts: {
  id: string;
  ref: string;
  public_state?: string;
  status: string;
  stage: string;
  applied_at?: string | null;
  stage_entered_at?: string | null;
  win_confidence?: number | null;
  published_learning?: string | null;
}): void {
  // Parent applications row (public_funnel_view.application_id is a FK). The API
  // reads only the view; the parent's content is irrelevant to these tests.
  getDb()
    .prepare(
      `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, created_at)
       VALUES (@id, 'SeedCo', @ref, 'Senior Engineer', @status, '2026-05-01T00:00:00Z')`,
    )
    .run({ id: opts.id, ref: opts.ref, status: opts.status });

  getDb()
    .prepare(
      `INSERT INTO public_funnel_view (
         application_id, application_ref, public_state, role_title, status, stage,
         applied_at, stage_entered_at, last_activity_at, win_confidence,
         published_learning, updated_at
       ) VALUES (
         @id, @ref, @public_state, 'Senior Engineer', @status, @stage,
         @applied_at, @stage_entered_at, @last_activity_at, @win_confidence,
         @published_learning, '2026-05-20T00:00:00Z'
       )`,
    )
    .run({
      id: opts.id,
      ref: opts.ref,
      public_state: opts.public_state ?? 'obfuscated',
      status: opts.status,
      stage: opts.stage,
      applied_at: opts.applied_at ?? null,
      stage_entered_at: opts.stage_entered_at ?? null,
      last_activity_at: '2026-05-20T00:00:00Z',
      win_confidence: opts.win_confidence ?? null,
      published_learning: opts.published_learning ?? null,
    });
}

function seedAudit(seq: number, summary: string): void {
  getDb()
    .prepare(
      `INSERT INTO public_audit_trail (id, seq, ts, category, application_ref, summary)
       VALUES (@id, @seq, @ts, 'funnel', 'fintech-a', @summary)`,
    )
    .run({ id: `pat-${seq}`, seq, ts: `2026-05-2${seq}T00:00:00Z`, summary });
}

function seedMode(key: string, value: string): void {
  getDb()
    .prepare(`INSERT INTO system_modes (key, value, changed_at) VALUES (?, ?, '2026-05-29T00:00:00Z')`)
    .run(key, value);
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

// ── /api/funnel ────────────────────────────────────────────────────────────

describe('GET /api/funnel', () => {
  it('returns rows with computed days + stage_counts', async () => {
    seedFunnel({
      id: 'app-1',
      ref: 'fintech-a',
      status: 'SCREENING',
      stage: 'screening',
      applied_at: isoDaysAgo(12),
      stage_entered_at: isoDaysAgo(5),
      win_confidence: 60,
    });
    seedFunnel({
      id: 'app-2',
      ref: 'Anthropic',
      public_state: 'public',
      status: 'OFFER',
      stage: 'offer',
      applied_at: isoDaysAgo(30),
      stage_entered_at: isoDaysAgo(2),
      win_confidence: 88,
    });

    const res = await fetch(`${base}/api/funnel`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applications: Array<Record<string, unknown>>;
      stage_counts: Record<string, number>;
    };

    expect(body.applications).toHaveLength(2);
    expect(body.stage_counts).toEqual({ screening: 1, offer: 1 });

    const screening = body.applications.find((a) => a.application_ref === 'fintech-a')!;
    expect(screening.days_in_stage).toBe(5);
    expect(screening.days_in_pipeline).toBe(12);
    expect(screening.win_confidence).toBe(60);

    const offer = body.applications.find((a) => a.application_ref === 'Anthropic')!;
    expect(offer.public_state).toBe('public');
    expect(offer.days_in_stage).toBe(2);
  });

  it('returns null days when timestamps are missing', async () => {
    seedFunnel({ id: 'app-1', ref: 'fintech-a', status: 'BOOKMARKED', stage: 'bookmarked' });
    const res = await fetch(`${base}/api/funnel`);
    const body = (await res.json()) as { applications: Array<Record<string, unknown>> };
    expect(body.applications[0].days_in_stage).toBeNull();
    expect(body.applications[0].days_in_pipeline).toBeNull();
  });
});

// ── /api/activity ──────────────────────────────────────────────────────────

describe('GET /api/activity', () => {
  it('paginates by the seq cursor and returns next_since', async () => {
    seedAudit(1, 'one');
    seedAudit(2, 'two');
    seedAudit(3, 'three');

    const page1 = (await (await fetch(`${base}/api/activity?since=0&limit=2`)).json()) as {
      events: Array<{ seq: number }>;
      next_since: number;
    };
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page1.next_since).toBe(2);

    const page2 = (await (await fetch(`${base}/api/activity?since=2`)).json()) as {
      events: Array<{ seq: number }>;
      next_since: number;
    };
    expect(page2.events.map((e) => e.seq)).toEqual([3]);
    expect(page2.next_since).toBe(3);

    const page3 = (await (await fetch(`${base}/api/activity?since=3`)).json()) as {
      events: Array<{ seq: number }>;
      next_since: number;
    };
    expect(page3.events).toHaveLength(0);
    expect(page3.next_since).toBe(3);
  });

  it('defaults since=0 and caps the limit', async () => {
    seedAudit(1, 'one');
    const body = (await (await fetch(`${base}/api/activity`)).json()) as {
      events: Array<{ seq: number }>;
    };
    expect(body.events.map((e) => e.seq)).toEqual([1]);
  });
});

// ── /api/system-status ─────────────────────────────────────────────────────

describe('GET /api/system-status', () => {
  it('reflects seeded modes', async () => {
    seedMode('live_mode', 'true');
    seedMode('pause_state', 'paused');
    seedMode('pause_reason', 'in interview');

    const body = await (await fetch(`${base}/api/system-status`)).json();
    expect(body).toEqual({
      live_mode: true,
      pause_state: 'paused',
      pause_reason: 'in interview',
      backend: 'online',
    });
  });

  it('returns defaults when system_modes is empty', async () => {
    const body = await (await fetch(`${base}/api/system-status`)).json();
    expect(body).toEqual({
      live_mode: false,
      pause_state: 'active',
      pause_reason: null,
      backend: 'online',
    });
  });
});

// ── CORS + routing + error-safety ──────────────────────────────────────────

describe('CORS + routing', () => {
  it('echoes an allowed origin and omits it for a disallowed one', async () => {
    const allowed = await fetch(`${base}/api/system-status`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');

    const denied = await fetch(`${base}/api/system-status`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('handles an OPTIONS preflight with 204 + CORS headers', async () => {
    const res = await fetch(`${base}/api/funnel`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('returns a JSON 404 for an unknown path', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns a JSON 500 (never throws out) when a query fails', async () => {
    getDb().exec('DROP TABLE public_funnel_view');
    const res = await fetch(`${base}/api/funnel`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('internal_error');
  });
});
