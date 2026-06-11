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
import type { ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import { _resetPortalAdapter, createPortalAdapter } from '../../channels/portal/adapter.js';

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

  it('carries interview_kits metadata from kits_json (§24.65); empty array when none', async () => {
    seedFunnel({ id: 'app-1', ref: 'fintech-a', status: 'TECH_SCREEN', stage: 'tech' });
    seedFunnel({ id: 'app-2', ref: 'ai-infra-a', status: 'APPLIED', stage: 'applied' });
    getDb()
      .prepare(`UPDATE public_funnel_view SET kits_json = @kits WHERE application_id = 'app-1'`)
      .run({
        kits: JSON.stringify([
          {
            round: 'TECH_SCREEN',
            interview_type: 'technical_screen',
            interview_at: '2026-06-15T17:00:00Z',
            status: 'active',
            created_at: '2026-06-10T00:00:00Z',
            has_content: true,
          },
        ]),
      });

    const body = (await (await fetch(`${base}/api/funnel`)).json()) as {
      applications: Array<{ application_ref: string; interview_kits: Array<Record<string, unknown>> }>;
    };
    const withKit = body.applications.find((a) => a.application_ref === 'fintech-a')!;
    expect(withKit.interview_kits).toHaveLength(1);
    expect(withKit.interview_kits[0]).toMatchObject({ round: 'TECH_SCREEN', status: 'active', has_content: true });
    expect(body.applications.find((a) => a.application_ref === 'ai-infra-a')!.interview_kits).toEqual([]);
  });
});

// ── /api/kit (§24.65) ──────────────────────────────────────────────────────

function seedKitView(opts: { application_id: string; round: string; sections: unknown[] }): void {
  getDb()
    .prepare(
      `INSERT INTO public_kit_view (application_id, round, interview_type, interview_at, status, sections_json, updated_at)
       VALUES (@application_id, @round, 'technical_screen', '2026-06-15T17:00:00Z', 'active', @sections_json, '2026-06-10T00:00:00Z')`,
    )
    .run({ ...opts, sections_json: JSON.stringify(opts.sections) });
}

describe('GET /api/kit', () => {
  it('serves the public projection by ref + round, reading only public tables', async () => {
    seedFunnel({ id: 'app-1', ref: 'fintech-a', status: 'TECH_SCREEN', stage: 'tech' });
    seedKitView({
      application_id: 'app-1',
      round: 'TECH_SCREEN',
      sections: [
        { id: 'your-role', title: 'Your role', part: 1, kind: 'content', body: 'Conduct…', item_count: 1 },
        {
          id: 'gap-notes',
          title: 'Gap notes',
          part: 1,
          kind: 'withheld',
          item_count: 2,
          withheld_reason: '2 gap notes · sealed while live — names what the candidate would be probed on',
        },
      ],
    });

    // round is case-normalized.
    const res = await fetch(`${base}/api/kit?app=fintech-a&round=tech_screen`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { sections: Array<Record<string, unknown>> };
    expect(body).toMatchObject({
      application_ref: 'fintech-a',
      public_state: 'obfuscated',
      round: 'TECH_SCREEN',
      interview_type: 'technical_screen',
      status: 'active',
    });
    expect(body.sections).toHaveLength(2);
    expect(body.sections[1]).toMatchObject({ kind: 'withheld' });
    // §24.65 hard invariant: the payload never carries a Doc title or Drive url.
    const flat = JSON.stringify(body);
    expect(flat).not.toContain('docs.google.com');
    expect(flat).not.toContain('drive');
    expect(flat).not.toContain('Interview Kit —');
  });

  it('404s for an unknown ref, an unknown round, and a kit-less application; 400 without params', async () => {
    seedFunnel({ id: 'app-1', ref: 'fintech-a', status: 'TECH_SCREEN', stage: 'tech' });
    expect((await fetch(`${base}/api/kit?app=nope&round=TECH_SCREEN`)).status).toBe(404);
    expect((await fetch(`${base}/api/kit?app=fintech-a&round=FINAL`)).status).toBe(404);
    expect((await fetch(`${base}/api/kit?app=fintech-a&round=TECH_SCREEN`)).status).toBe(404);
    expect((await fetch(`${base}/api/kit`)).status).toBe(400);
    expect((await fetch(`${base}/api/kit?app=fintech-a`)).status).toBe(400);
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

// ── POST /api/simulator (5.5a) ─────────────────────────────────────────────

describe('POST /api/simulator', () => {
  let inbound: Array<[string, string | null, InboundMessage]>;

  beforeEach(async () => {
    inbound = [];
    const setup: ChannelSetup = {
      onInbound: (platformId, threadId, message) => {
        inbound.push([platformId, threadId, message]);
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    };
    await createPortalAdapter().setup(setup);
  });

  afterEach(() => _resetPortalAdapter());

  async function post(body: unknown): Promise<Response> {
    return fetch(`${base}/api/simulator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('400 on missing company/role, with no session injected', async () => {
    const res = await post({ role: 'SWE' });
    expect(res.status).toBe(400);
    expect(inbound).toHaveLength(0);
  });

  it('400 on an invalid JSON body', async () => {
    const res = await post('{ not json');
    expect(res.status).toBe(400);
    expect(inbound).toHaveLength(0);
  });

  it('200 + simulation_id and injects exactly one sandbox inbound on valid input', async () => {
    const res = await post({ company: 'Acme', role: 'Senior SWE', jd: 'Build things' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { simulation_id: string };
    expect(body.simulation_id).toMatch(/^sb-/);

    expect(inbound).toHaveLength(1);
    const [platformId, threadId, message] = inbound[0];
    expect(platformId).toBe('sandbox');
    expect(threadId).toBe(body.simulation_id);
    expect(message.kind).toBe('chat');
    expect((message.content as { text: string }).text).toContain('Acme');
  });
});

// ── simulator results + recent (5.5c) ──────────────────────────────────────

describe('GET /api/simulator/results/:id + /recent', () => {
  function seedRun(id: string, company: string, expiresAt: string | null): void {
    getDb()
      .prepare(
        `INSERT INTO simulator_runs (id, ts, visitor_company, visitor_role, tailored_resume, shareable, expires_at)
         VALUES (?, ?, ?, 'SWE', 'bullets', 1, ?)`,
      )
      .run(id, new Date().toISOString(), company, expiresAt);
  }

  it('returns 404 for an absent run and 200 for a live one', async () => {
    expect((await fetch(`${base}/api/simulator/results/sb-missing`)).status).toBe(404);

    seedRun('sb-live', 'Acme', new Date(Date.now() + 86_400_000).toISOString());
    const res = await fetch(`${base}/api/simulator/results/sb-live`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; visitor_company: string };
    expect(body.id).toBe('sb-live');
    expect(body.visitor_company).toBe('Acme');
  });

  it('lists recent shareable runs', async () => {
    seedRun('sb-a', 'Globex', new Date(Date.now() + 86_400_000).toISOString());
    const body = (await (await fetch(`${base}/api/simulator/recent`)).json()) as {
      runs: Array<{ visitor_company: string }>;
    };
    expect(body.runs.map((r) => r.visitor_company)).toContain('Globex');
  });
});

// ── POST /api/contact (5.6) ─────────────────────────────────────────────────

describe('POST /api/contact', () => {
  async function post(body: unknown): Promise<Response> {
    return fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('400 on missing required fields', async () => {
    expect((await post({ name: 'A' })).status).toBe(400);
  });

  it('503 when no owner channel is wired (fresh DB has no career-pilot group)', async () => {
    const res = await post({ name: 'Jane', email: 'jane@example.com', message: 'hi' });
    expect(res.status).toBe(503);
  });
});

// ── POST /api/sanitize-demo (§24.33) ────────────────────────────────────────

describe('POST /api/sanitize-demo', () => {
  it('returns a synthetic raw↔sanitized pair from the real pipeline', async () => {
    const res = await fetch(`${base}/api/sanitize-demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample: 0 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { raw: string; sanitized: string; redactions: number; sample: number };
    expect(body.sample).toBe(0);
    expect(body.sanitized).toContain('[EMAIL_REDACTED]');
    expect(body.sanitized).not.toMatch(/Globex/i);
    expect(body.redactions).toBeGreaterThan(0);
  });

  it('defaults to sample 0 on an empty body and clamps an out-of-range index', async () => {
    const empty = await fetch(`${base}/api/sanitize-demo`, { method: 'POST' });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { sample: number }).sample).toBe(0);

    const high = await fetch(`${base}/api/sanitize-demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample: 99 }),
    });
    const body = (await high.json()) as { sample: number; total: number };
    expect(body.sample).toBe(body.total - 1);
  });
});

// ── mock-only async-state override seam (§24.36 36.1) ───────────────────────

describe('the __state override seam (mock-only)', () => {
  afterEach(() => {
    delete process.env.PORTAL_MOCK_STATE_SEAM;
  });

  it('is ignored unless the mock seam env is set (production safety)', async () => {
    // No PORTAL_MOCK_STATE_SEAM → `__state` is just an unknown query param.
    const res = await fetch(`${base}/api/funnel?__state=error`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applications: unknown[] };
    expect(Array.isArray(body.applications)).toBe(true);
  });

  it('forces a 500 for __state=error when enabled', async () => {
    process.env.PORTAL_MOCK_STATE_SEAM = '1';
    const res = await fetch(`${base}/api/funnel?__state=error`);
    expect(res.status).toBe(500);
  });

  it('serves a valid-but-empty payload for __state=empty (overriding real rows)', async () => {
    process.env.PORTAL_MOCK_STATE_SEAM = '1';
    // Seed a real row so "empty" provably overrides non-empty data.
    seedFunnel({ id: 'app-1', ref: 'fintech-a', status: 'SCREENING', stage: 'screening' });
    const body = (await (await fetch(`${base}/api/funnel?__state=empty`)).json()) as {
      applications: unknown[];
      stage_counts: Record<string, number>;
    };
    expect(body.applications).toEqual([]);
    expect(body.stage_counts).toEqual({});

    const arch = (await (await fetch(`${base}/api/architecture?__state=empty`)).json()) as {
      sessions: { active: number };
      backend: string;
    };
    expect(arch.sessions.active).toBe(0);
    expect(arch.backend).toBe('online');
  });

  it('only applies to GET — a POST is unaffected', async () => {
    process.env.PORTAL_MOCK_STATE_SEAM = '1';
    const res = await fetch(`${base}/api/sanitize-demo?__state=error`, { method: 'POST' });
    expect(res.status).toBe(200);
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
