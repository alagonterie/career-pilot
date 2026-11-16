/**
 * "I applied" from the /admin Leads tab + its undo (STRATEGY.md §24.201 D8).
 *
 * Real migrated in-memory DB with foreign keys ON (`initTestDb`). The two LLM
 * calls (industry classification, win-confidence) are injected mocks; global
 * `fetch` is stubbed to throw so no test can reach the network by accident. The
 * one test that exercises the REAL scorer (the late-write race) stubs `fetch`
 * with a deferred Portkey response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { applyAdminLeadsWriteAsync } from '../portal/admin.js';
import { mirrorPipelineEvent, resanitizeApplicationAuditTrail } from '../portal/public-audit.js';

import { OWNER_APPLIED_EVENT_KIND, applyAppliedFromLead, applyUndoApplied } from './actions.js';
import { reactToStatusTransitions } from './interview-kit-trigger.js';
import { scoreWinConfidence } from './win-confidence.js';

const classify = vi.fn(async (_jd: string, _title?: unknown): Promise<string | null> => 'fintech');
const score = vi.fn(async (_db: unknown): Promise<unknown> => ({ scored: 0, closed: 0 }));
const deps = { classify, scoreWinConfidence: score };

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
  classify.mockClear();
  score.mockClear();
  delete process.env.PORTKEY_API_KEY;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network is not allowed in this test');
    }),
  );
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  delete process.env.PORTKEY_API_KEY;
});

let seq = 0;
function seedLead(
  over: {
    id?: string;
    company?: string;
    title?: string;
    rules_score?: number;
    status?: string;
    closed_at?: string | null;
    closed_reason?: string | null;
    description?: string | null;
  } = {},
): string {
  const id = over.id ?? `lead-${seq++}`;
  getDb()
    .prepare(
      `INSERT INTO job_leads
         (id, source, source_job_id, source_url, apply_url, apply_link_kind, content_fingerprint, title, company,
          description_text, first_seen_at, last_seen_at, status, status_changed_at, rules_score, closed_at, closed_reason)
       VALUES (@id, 'greenhouse', @sjid, @url, @url, 'ats', @fp, @title, @company,
          @description, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', @status, '2026-11-02T00:00:00.000Z',
          @rules_score, @closed_at, @closed_reason)`,
    )
    .run({
      id,
      sjid: `job-${id}`,
      url: `https://boards.example.com/acme/jobs/${id}`,
      fp: `fp-${id}`,
      title: over.title ?? 'Backend Engineer',
      company: over.company ?? 'Acme',
      description: over.description === undefined ? 'Build payment rails for merchants.' : over.description,
      status: over.status ?? 'new',
      rules_score: over.rules_score ?? 50,
      closed_at: over.closed_at ?? null,
      closed_reason: over.closed_reason ?? null,
    });
  return id;
}

function seedApp(id: string, over: { company?: string; title?: string; status?: string; label?: string } = {}): void {
  getDb()
    .prepare(
      `INSERT INTO applications
         (id, company_name, obfuscated_label, public_state, role_title, status, applied_at, last_activity_at, created_at)
       VALUES (@id, @company, @label, 'obfuscated', @title, @status, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run({
      id,
      company: over.company ?? 'Acme',
      title: over.title ?? 'Backend Engineer',
      status: over.status ?? 'APPLIED',
      label: over.label ?? `misc-${id}`,
    });
}

function seedResume(id: string, leadId: string, status: string): void {
  getDb()
    .prepare(`INSERT INTO tailored_resumes (id, lead_id, created_at, status) VALUES (?, ?, ?, ?)`)
    .run(id, leadId, '2026-11-10T00:00:00.000Z', status);
}

const leadRow = (id: string) =>
  getDb()
    .prepare('SELECT status, application_id, closed_at, closed_reason, status_changed_at FROM job_leads WHERE id = ?')
    .get(id) as {
    status: string;
    application_id: string | null;
    closed_at: string | null;
    closed_reason: string | null;
    status_changed_at: string;
  };
const appRow = (id: string) =>
  getDb().prepare('SELECT * FROM applications WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const count = (sql: string, ...params: unknown[]) =>
  (
    getDb()
      .prepare(sql)
      .get(...params) as { n: number }
  ).n;

interface OkBody {
  ok: true;
  application_id: string;
  obfuscated_label: string;
  lead_id: string;
  prior_status: string;
  undo_until: string;
}

async function applyOk(raw: Record<string, unknown>): Promise<OkBody> {
  const out = await applyAppliedFromLead(getDb(), raw, deps);
  expect(out.status).toBe(200);
  return out.body as OkBody;
}

describe('applied_from_lead (§24.201 D8)', () => {
  it('links the CLICKED lead even when a higher-scored same-title lead exists', async () => {
    const clicked = seedLead({ rules_score: 10 });
    const better = seedLead({ rules_score: 95 });

    const body = await applyOk({ lead_id: clicked });

    expect(leadRow(clicked)).toMatchObject({ status: 'applied', application_id: body.application_id });
    // The matcher (reactor promotion) would have picked `better`; it is untouched.
    expect(leadRow(better)).toMatchObject({ status: 'new', application_id: null });
    // Exactly one lead points at the application — no synthesized manual lead.
    expect(count('SELECT COUNT(*) AS n FROM job_leads WHERE application_id = ?', body.application_id)).toBe(1);
    expect(appRow(body.application_id)).toMatchObject({
      status: 'APPLIED',
      public_state: 'obfuscated',
      company_name: 'Acme',
      role_title: 'Backend Engineer',
      job_url: `https://boards.example.com/acme/jobs/${clicked}`,
      jd_text: 'Build payment rails for merchants.',
    });
  });

  it('links an archived lead and reopens it; undo restores the archive', async () => {
    const lead = seedLead({ status: 'archived', closed_at: '2026-11-05T00:00:00.000Z', closed_reason: 'manual' });
    const body = await applyOk({ lead_id: lead });
    expect(body.prior_status).toBe('archived');
    expect(leadRow(lead)).toMatchObject({ status: 'applied', closed_at: null, closed_reason: null });

    const undo = applyUndoApplied(getDb(), { application_id: body.application_id });
    expect(undo).toEqual({ status: 200, body: { ok: true, lead_id: lead, restored_status: 'archived' } });
    expect(leadRow(lead)).toEqual({
      status: 'archived',
      application_id: null,
      closed_at: '2026-11-05T00:00:00.000Z',
      closed_reason: 'manual',
      status_changed_at: '2026-11-02T00:00:00.000Z',
    });
  });

  it('assigns the label from the shared allocator, classified from the lead description', async () => {
    seedApp('app-existing', { label: 'fintech-a', company: 'Other Co', title: 'Designer' });
    const lead = seedLead();
    const body = await applyOk({ lead_id: lead });
    expect(classify).toHaveBeenCalledWith('Build payment rails for merchants.', 'Backend Engineer');
    expect(body.obfuscated_label).toBe('fintech-b');
    expect(appRow(body.application_id)?.obfuscated_label).toBe('fintech-b');
  });

  it('falls back to misc when classification returns nothing or throws', async () => {
    classify.mockResolvedValueOnce(null);
    const a = await applyOk({ lead_id: seedLead({ company: 'Acme' }) });
    expect(a.obfuscated_label).toBe('misc-a');
    classify.mockRejectedValueOnce(new Error('boom'));
    const b = await applyOk({ lead_id: seedLead({ company: 'Beta' }) });
    expect(b.obfuscated_label).toBe('misc-b');
  });

  it('writes the note as a private owner event and NO public audit row; the public pipeline gains the card', async () => {
    const lead = seedLead();
    const body = await applyOk({ lead_id: lead, note: 'Applied via a referral from Jane Doe at Acme.' });

    const events = getDb()
      .prepare('SELECT kind, source, to_status, payload FROM pipeline_events WHERE application_id = ?')
      .all(body.application_id) as Array<{ kind: string; source: string; to_status: string; payload: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: OWNER_APPLIED_EVENT_KIND, source: 'owner', to_status: 'APPLIED' });
    expect(JSON.parse(events[0].payload)).toMatchObject({ note: 'Applied via a referral from Jane Doe at Acme.' });

    expect(count('SELECT COUNT(*) AS n FROM public_audit_trail')).toBe(0);
    const pub = getDb()
      .prepare('SELECT application_ref, stage, status FROM public_pipeline_view WHERE application_id = ?')
      .get(body.application_id) as { application_ref: string; status: string } | undefined;
    expect(pub).toMatchObject({ application_ref: body.obfuscated_label, status: 'APPLIED' });
  });

  it('a later re-sanitize of the application still publishes nothing from the owner note', async () => {
    const lead = seedLead();
    const body = await applyOk({ lead_id: lead, note: 'recruiter said the band tops out at 180k' });
    // An agent-sourced event for the same application DOES mirror — the filter is
    // on the owner source, not on the application.
    getDb()
      .prepare(
        `INSERT INTO pipeline_events (id, application_id, kind, from_status, to_status, payload, source, proactive, ts)
         VALUES ('fe-agent-2', ?, 'status_change', 'APPLIED', 'SCREENING', ?, 'agent', 0, datetime('now'))`,
      )
      .run(body.application_id, JSON.stringify({ summary: 'Moved to screening.' }));

    // The path update_application / the relabel + resanitize scripts take.
    await resanitizeApplicationAuditTrail(getDb(), body.application_id);
    // Direct mirror of the owner event is refused too.
    const ownerEventId = (
      getDb()
        .prepare('SELECT id FROM pipeline_events WHERE application_id = ? AND source = ?')
        .get(body.application_id, 'owner') as { id: string }
    ).id;
    expect(await mirrorPipelineEvent(getDb(), ownerEventId)).toBe('skipped');

    const rows = getDb().prepare('SELECT summary, details_json FROM public_audit_trail').all() as Array<{
      summary: string;
      details_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('Moved to screening.');
    for (const r of rows) {
      expect(r.summary + r.details_json).not.toMatch(/180k|owner_applied|lead_id/);
    }
  });

  it('a company-bearing scraped title is redacted on the public card, kept verbatim privately', async () => {
    const lead = seedLead({ company: 'Globex', title: 'Senior Backend Engineer - Globex Payments' });
    const body = await applyOk({ lead_id: lead });
    expect(appRow(body.application_id)?.role_title).toBe('Senior Backend Engineer - Globex Payments');
    const pub = getDb()
      .prepare('SELECT role_title FROM public_pipeline_view WHERE application_id = ?')
      .get(body.application_id) as { role_title: string };
    expect(pub.role_title).not.toMatch(/globex/i);
    expect(pub.role_title).toBe(`Senior Backend Engineer - [REDACTED:${body.obfuscated_label}] Payments`);
  });

  it('scores win-confidence after commit', async () => {
    const body = await applyOk({ lead_id: seedLead() });
    await vi.waitFor(() => expect(score).toHaveBeenCalledTimes(1));
    expect(appRow(body.application_id)).toBeDefined();
  });

  it('409s a same-company+title open application with the existing row, before any LLM spend', async () => {
    seedApp('app-dup', { company: 'Acme, Inc.', title: 'backend  engineer', status: 'SCREENING' });
    const lead = seedLead();
    const out = await applyAppliedFromLead(getDb(), { lead_id: lead }, deps);
    expect(out).toEqual({
      status: 409,
      body: {
        error: 'duplicate',
        duplicate_of: {
          id: 'app-dup',
          company_name: 'Acme, Inc.',
          role_title: 'backend  engineer',
          status: 'SCREENING',
        },
      },
    });
    expect(classify).not.toHaveBeenCalled();
    expect(leadRow(lead).application_id).toBeNull();

    const forced = await applyAppliedFromLead(getDb(), { lead_id: lead, confirm_duplicate: true }, deps);
    expect(forced.status).toBe(200);
  });

  it('does not treat a closed (rejected) application as a duplicate', async () => {
    seedApp('app-old', { status: 'REJECTED' });
    expect((await applyAppliedFromLead(getDb(), { lead_id: seedLead() }, deps)).status).toBe(200);
  });

  it('409s already_linked, 404s an unknown lead, 400s a bad date', async () => {
    const lead = seedLead();
    await applyOk({ lead_id: lead });
    expect(await applyAppliedFromLead(getDb(), { lead_id: lead, confirm_duplicate: true }, deps)).toEqual({
      status: 409,
      body: { error: 'already_linked' },
    });
    expect((await applyAppliedFromLead(getDb(), { lead_id: 'nope' }, deps)).status).toBe(404);
    for (const bad of ['2026-13-01', '2026-02-30', '11/01/2026', '2999-01-01', 5]) {
      const out = await applyAppliedFromLead(getDb(), { lead_id: seedLead(), applied_at: bad }, deps);
      expect(out.status).toBe(400);
    }
    expect((await applyAppliedFromLead(getDb(), {}, deps)).status).toBe(400);
  });

  it('stores a genuinely backdated applied_at at noon UTC', async () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    const out = await applyAppliedFromLead(
      getDb(),
      { lead_id: seedLead(), applied_at: '2026-11-03' },
      { ...deps, now: () => now },
    );
    expect(out.status).toBe(200);
    expect(appRow((out.body as OkBody).application_id)?.applied_at).toBe('2026-11-03T12:00:00.000Z');
    // Two days back is the first genuine backdate.
    const two = await applyAppliedFromLead(
      getDb(),
      { lead_id: seedLead({ company: 'Two' }), applied_at: '2026-11-14' },
      { ...deps, now: () => now },
    );
    expect(appRow((two.body as OkBody).application_id)?.applied_at).toBe('2026-11-14T12:00:00.000Z');
  });

  // The page sends the owner's LOCAL calendar date. Late evening in UTC−8 is
  // already "tomorrow" in UTC; early morning in UTC+10 is "tomorrow" locally while
  // UTC is still "today". Either way, a "today" click is now.
  it.each([
    ['omitted', undefined, '2026-11-16T03:00:00.000Z'],
    ['the UTC date', '2026-11-16', '2026-11-16T03:00:00.000Z'],
    ['the day after UTC (owner east of UTC)', '2026-11-17', '2026-11-16T20:00:00.000Z'],
    ['the day before UTC (owner west of UTC)', '2026-11-15', '2026-11-16T03:00:00.000Z'],
  ])('applied_at %s is stored as the current timestamp', async (_label, appliedAt, nowIso) => {
    const now = new Date(nowIso);
    const out = await applyAppliedFromLead(
      getDb(),
      { lead_id: seedLead(), ...(appliedAt ? { applied_at: appliedAt } : {}) },
      { ...deps, now: () => now },
    );
    expect(out.status).toBe(200);
    expect(appRow((out.body as OkBody).application_id)?.applied_at).toBe(nowIso);
  });

  it('refuses a date more than one calendar day ahead of the UTC date', async () => {
    const now = new Date('2026-11-16T23:59:00.000Z');
    const out = await applyAppliedFromLead(
      getDb(),
      { lead_id: seedLead(), applied_at: '2026-11-18' },
      { ...deps, now: () => now },
    );
    expect(out.status).toBe(400);
  });

  it('caps the note at the owner_note_max_chars knob', async () => {
    getDb()
      .prepare(
        "INSERT INTO preferences (key, value, updated_at) VALUES ('owner_note_max_chars', '10', datetime('now'))",
      )
      .run();
    const lead = seedLead();
    const long = await applyAppliedFromLead(getDb(), { lead_id: lead, note: 'x'.repeat(11) }, deps);
    expect(long).toEqual({ status: 400, body: { error: 'note exceeds 10 characters' } });
    expect(leadRow(lead).application_id).toBeNull();
    expect((await applyAppliedFromLead(getDb(), { lead_id: lead, note: 'x'.repeat(10) }, deps)).status).toBe(200);
  });

  it('a backdated application enters APPLIED on its applied date on the public card', async () => {
    const now = new Date('2026-11-16T10:00:00.000Z');
    const out = await applyAppliedFromLead(
      getDb(),
      { lead_id: seedLead(), applied_at: '2026-11-03' },
      { ...deps, now: () => now },
    );
    const appId = (out.body as OkBody).application_id;
    const pub = getDb()
      .prepare('SELECT applied_at, stage_entered_at FROM public_pipeline_view WHERE application_id = ?')
      .get(appId) as { applied_at: string; stage_entered_at: string };
    expect(pub).toEqual({ applied_at: '2026-11-03T12:00:00.000Z', stage_entered_at: '2026-11-03T12:00:00.000Z' });
  });

  it('records a ready tailored résumé of this lead; refuses one that is not ready or belongs to another lead', async () => {
    const lead = seedLead();
    const other = seedLead({ company: 'Beta' });
    seedResume('tr-ready', lead, 'ready');
    seedResume('tr-pending', lead, 'pending');
    seedResume('tr-other', other, 'ready');

    for (const bad of ['tr-pending', 'tr-other', 'tr-missing']) {
      const out = await applyAppliedFromLead(getDb(), { lead_id: lead, tailored_resume_id: bad }, deps);
      expect(out.status).toBe(400);
    }
    const body = await applyOk({ lead_id: lead, tailored_resume_id: 'tr-ready' });
    expect(appRow(body.application_id)?.sent_resume_id).toBe('tr-ready');
  });

  it('returns an undo deadline from applied_undo_window_s', async () => {
    getDb()
      .prepare(
        "INSERT INTO preferences (key, value, updated_at) VALUES ('applied_undo_window_s', '60', datetime('now'))",
      )
      .run();
    const now = new Date('2026-11-16T10:00:00.000Z');
    const out = await applyAppliedFromLead(getDb(), { lead_id: seedLead() }, { ...deps, now: () => now });
    expect((out.body as OkBody).undo_until).toBe('2026-11-16T10:01:00.000Z');
  });

  it('is routed by the async /admin leads write', async () => {
    const lead = seedLead();
    const out = await applyAdminLeadsWriteAsync(getDb(), { action: 'applied_from_lead', lead_id: lead }, deps);
    expect(out.status).toBe(200);
    const appId = (out.body as OkBody).application_id;
    const undo = await applyAdminLeadsWriteAsync(getDb(), { action: 'undo_applied', application_id: appId });
    expect(undo.status).toBe(200);
    // Existing sync actions still delegate.
    const st = await applyAdminLeadsWriteAsync(getDb(), { action: 'set_status', id: lead, status: 'reviewed' });
    expect(st.status).toBe(200);
  });
});

describe('undo_applied (§24.201 D8)', () => {
  it('with foreign keys on, removes the application, its event and public row, and restores the lead', async () => {
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1);
    const lead = seedLead({ status: 'queued' });
    const body = await applyOk({ lead_id: lead, note: 'sent it' });
    expect(count('SELECT COUNT(*) AS n FROM public_pipeline_view WHERE application_id = ?', body.application_id)).toBe(
      1,
    );

    const out = applyUndoApplied(getDb(), { application_id: body.application_id });
    expect(out).toEqual({ status: 200, body: { ok: true, lead_id: lead, restored_status: 'queued' } });
    expect(appRow(body.application_id)).toBeUndefined();
    expect(count('SELECT COUNT(*) AS n FROM pipeline_events WHERE application_id = ?', body.application_id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM public_pipeline_view WHERE application_id = ?', body.application_id)).toBe(
      0,
    );
    expect(leadRow(lead)).toMatchObject({ status: 'queued', application_id: null });
  });

  it('is refused once an email event references the application, and deletes nothing', async () => {
    const lead = seedLead();
    const body = await applyOk({ lead_id: lead });
    getDb()
      .prepare(
        `INSERT INTO email_events (gmail_msg_id, thread_id, classification, confidence, linked_application_id,
                                   classified_at, classified_by_run_id)
         VALUES ('m1', 't1', 'application_confirmation', 0.9, ?, '2026-11-16T00:00:00Z', 'run-1')`,
      )
      .run(body.application_id);

    const out = applyUndoApplied(getDb(), { application_id: body.application_id });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: 'referenced' });
    expect((out.body as { detail: string }).detail).toContain('email_events');
    expect(appRow(body.application_id)).toBeDefined();
    expect(leadRow(lead).application_id).toBe(body.application_id);
  });

  it('is refused once any other pipeline event exists for the application', async () => {
    const body = await applyOk({ lead_id: seedLead() });
    getDb()
      .prepare(
        `INSERT INTO pipeline_events (id, application_id, kind, from_status, to_status, payload, source, proactive, ts)
         VALUES ('fe-agent', ?, 'status_change', 'APPLIED', 'SCREENING', '{}', 'agent', 0, datetime('now'))`,
      )
      .run(body.application_id);
    const out = applyUndoApplied(getDb(), { application_id: body.application_id });
    expect(out.status).toBe(409);
    expect((out.body as { detail: string }).detail).toContain('pipeline_events');
  });

  it('is refused after the undo window', async () => {
    const t0 = new Date('2026-11-16T10:00:00.000Z');
    const out = await applyAppliedFromLead(getDb(), { lead_id: seedLead() }, { ...deps, now: () => t0 });
    const appId = (out.body as OkBody).application_id;
    const late = new Date(t0.getTime() + 301_000); // default window 300 s
    expect(applyUndoApplied(getDb(), { application_id: appId }, { now: () => late })).toEqual({
      status: 409,
      body: { error: 'undo_window_passed' },
    });
    const inside = new Date(t0.getTime() + 299_000);
    expect(applyUndoApplied(getDb(), { application_id: appId }, { now: () => inside }).status).toBe(200);
  });

  it('measures the undo window from when the action ran, not from a backdated applied date', async () => {
    const t0 = new Date('2026-11-16T10:00:00.000Z');
    const out = await applyAppliedFromLead(
      getDb(),
      { lead_id: seedLead(), applied_at: '2026-11-03' },
      { ...deps, now: () => t0 },
    );
    const appId = (out.body as OkBody).application_id;
    const ev = getDb().prepare('SELECT ts, payload FROM pipeline_events WHERE application_id = ?').get(appId) as {
      ts: string;
      payload: string;
    };
    expect(ev.ts).toBe('2026-11-03T12:00:00.000Z');
    expect(JSON.parse(ev.payload)).toMatchObject({ created_at: '2026-11-16T10:00:00.000Z' });

    const late = new Date(t0.getTime() + 301_000);
    expect(applyUndoApplied(getDb(), { application_id: appId }, { now: () => late }).status).toBe(409);
    const inside = new Date(t0.getTime() + 299_000);
    expect(applyUndoApplied(getDb(), { application_id: appId }, { now: () => inside }).status).toBe(200);
  });

  it('refuses an application the action did not create (no owner event)', () => {
    seedApp('app-agent');
    expect(applyUndoApplied(getDb(), { application_id: 'app-agent' }).status).toBe(404);
    expect(appRow('app-agent')).toBeDefined();
    expect(applyUndoApplied(getDb(), {}).status).toBe(400);
  });

  it('a win-confidence result that lands after the undo resurrects nothing', async () => {
    process.env.PORTKEY_API_KEY = 'pk-test';
    let release!: (content: string) => void;
    const gate = new Promise<string>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      const content = await gate;
      return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    let scoring: Promise<unknown> | undefined;
    const lead = seedLead();
    const out = await applyAppliedFromLead(
      getDb(),
      { lead_id: lead },
      {
        classify,
        scoreWinConfidence: (db) => {
          scoring = scoreWinConfidence(db as Parameters<typeof scoreWinConfidence>[0]);
          return scoring;
        },
      },
    );
    const appId = (out.body as OkBody).application_id;
    // The real scorer has read the application and is waiting on the model.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(applyUndoApplied(getDb(), { application_id: appId }).status).toBe(200);
    release(JSON.stringify({ [appId]: { score: 80, reason: 'Strong fit, early stage.' } }));
    await scoring;

    expect(appRow(appId)).toBeUndefined();
    expect(count('SELECT COUNT(*) AS n FROM public_pipeline_view WHERE application_id = ?', appId)).toBe(0);
    expect(leadRow(lead)).toMatchObject({ status: 'new', application_id: null });
  });
});

describe('reactToStatusTransitions without a session inbound DB', () => {
  it('skips the kit wake for an interview-round transition instead of throwing', () => {
    seedApp('app-r', { status: 'SCREENING' });
    expect(() =>
      reactToStatusTransitions(getDb(), null, [{ application_id: 'app-r', from: 'APPLIED', to: 'SCREENING' }]),
    ).not.toThrow();
  });
});
