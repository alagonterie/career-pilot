/**
 * The owner's read-only Pipeline tab (STRATEGY.md §24.203).
 *
 * `buildAdminPipeline` returns every new field from one seeded fixture (an
 * application with events, a scribe run with attention items and suggestions,
 * a kit, a learning, an email event, two tailored résumés with one marked sent);
 * each join degrades on its own; and no pipeline write exists — neither an
 * exported writer nor an admin POST route.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import * as adminModule from './admin.js';
import { buildAdminPipeline } from './admin.js';
import * as adminPipelineModule from './admin-pipeline.js';
import { startPortalApi, stopPortalApi } from './api.js';

const NOW = new Date('2026-11-16T12:00:00Z');

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
});

function seedApp(row: {
  id: string;
  company: string;
  role: string;
  status: string;
  stage: string;
  stageEnteredAt: string | null;
  lastActivityAt: string;
  jobUrl?: string | null;
  rationale?: string | null;
  sentResumeId?: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO applications (id, company_name, obfuscated_label, role_title, job_url, status,
                               win_confidence, win_confidence_rationale, sent_resume_id,
                               applied_at, last_activity_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 40, ?, ?, '2026-10-01T00:00:00Z', ?, '2026-10-01T00:00:00Z')`,
  ).run(
    row.id,
    row.company,
    `misc-${row.id}`,
    row.role,
    row.jobUrl ?? null,
    row.status,
    row.rationale ?? null,
    row.sentResumeId ?? null,
    row.lastActivityAt,
  );
  db.prepare(
    `INSERT INTO public_pipeline_view (application_id, application_ref, public_state, role_title, status, stage,
                                       applied_at, stage_entered_at, last_activity_at, win_confidence, updated_at)
     VALUES (?, ?, 'obfuscated', ?, ?, ?, '2026-10-01T00:00:00Z', ?, ?, 40, ?)`,
  ).run(
    row.id,
    `misc-${row.id}`,
    row.role,
    row.status,
    row.stage,
    row.stageEnteredAt,
    row.lastActivityAt,
    NOW.toISOString(),
  );
}

function seedLead(id: string, appId: string | null, firstSeen: string, applyUrl: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO job_leads (id, source, source_job_id, source_url, apply_url, content_fingerprint, title, company,
                              first_seen_at, last_seen_at, status, status_changed_at, application_id)
       VALUES (?, 'greenhouse', ?, ?, ?, ?, 'Staff Engineer', 'Acme', ?, ?, 'applied', ?, ?)`,
    )
    .run(
      id,
      `job-${id}`,
      `https://boards.example.com/${id}`,
      applyUrl,
      `fp-${id}`,
      firstSeen,
      firstSeen,
      firstSeen,
      appId,
    );
}

function seedFixture(): void {
  const db = getDb();
  // app-acme: the fully populated row. In `tech` for 10 days, past the 7-day onsite threshold.
  seedApp({
    id: 'app-acme',
    company: 'Acme',
    role: 'Staff Engineer',
    status: 'TECH_SCREEN',
    stage: 'tech',
    stageEnteredAt: '2026-11-06T12:00:00Z',
    lastActivityAt: '2026-11-15T00:00:00Z',
    jobUrl: 'https://acme.example.com/careers/1',
    rationale: 'Strong loop so far; panel feedback pending.',
    sentResumeId: 'tr-new',
  });
  // app-globex: withdrawn after the scribe ran — its attention must be dropped.
  seedApp({
    id: 'app-globex',
    company: 'Globex',
    role: 'Backend Engineer',
    status: 'WITHDRAWN',
    stage: 'withdrawn',
    stageEnteredAt: '2026-11-14T00:00:00Z',
    lastActivityAt: '2026-11-14T00:00:00Z',
  });
  // app-initech: nothing joined; in `applied` 3 days (under the 21-day threshold).
  seedApp({
    id: 'app-initech',
    company: 'Initech',
    role: 'Platform Engineer',
    status: 'APPLIED',
    stage: 'applied',
    stageEnteredAt: '2026-11-13T12:00:00Z',
    lastActivityAt: '2026-11-13T12:00:00Z',
    jobUrl: 'https://initech.example.com/jobs/9',
  });

  // Two leads for app-acme (the newer one's apply_url is the posting), one unrelated.
  seedLead('lead-old', 'app-acme', '2026-09-01T00:00:00Z', null);
  seedLead('lead-new', 'app-acme', '2026-10-01T00:00:00Z', 'https://boards.example.com/acme/apply');
  seedLead('lead-other', null, '2026-10-05T00:00:00Z', null);

  const ev = db.prepare(
    `INSERT INTO pipeline_events (id, application_id, kind, from_status, to_status, payload, source, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ev.run(
    'ev-2',
    'app-acme',
    'status_change',
    'SCREENING',
    'TECH_SCREEN',
    '{"note":"Loop booked"}',
    'agent',
    '2026-11-06T12:00:00Z',
  );
  ev.run(
    'ev-1',
    'app-acme',
    'status_change',
    'APPLIED',
    'SCREENING',
    '{"summary":"Recruiter screen"}',
    'pipeline_scribe',
    '2026-10-20T00:00:00Z',
  );
  ev.run('ev-3', 'app-acme', 'note', null, null, 'not json', 'owner', '2026-11-10T00:00:00Z');
  ev.run('ev-x', 'app-globex', 'status_change', 'APPLIED', 'WITHDRAWN', '{}', 'owner', '2026-11-14T00:00:00Z');

  // An older scribe run (ignored) and the latest one.
  const scribe = db.prepare(
    `INSERT INTO pipeline_scribe_output (id, run_at, gmail_history_id, calendar_sync_tokens,
                                         narratives_json, attention_json, suggestions_json, cheap_out, cost_usd)
     VALUES (?, ?, NULL, '{}', ?, ?, ?, 0, 0.1)`,
  );
  scribe.run(
    'run-old',
    '2026-11-10T07:30:00Z',
    JSON.stringify([{ application_id: 'app-acme', current_state: 'stale', timeline_excerpt: [] }]),
    JSON.stringify([{ priority: 'same_day', reason: 'stale', application_id: 'app-initech' }]),
    '[]',
  );
  scribe.run(
    'run-new',
    '2026-11-16T07:30:00Z',
    JSON.stringify([
      {
        company: 'Acme',
        application_id: 'app-acme',
        current_state: 'onsite_scheduled',
        last_event_at: '2026-11-15T00:00:00Z',
        timeline_excerpt: ['2026-10-20 recruiter screen', { when: '2026-11-06', what: 'loop booked' }],
      },
      { company: 'Acme', application_id: 'app-acme', current_state: 'duplicate', timeline_excerpt: [] },
    ]),
    JSON.stringify([
      { priority: 'fyi', reason: 'Panel list arrived', application_id: 'app-acme', company: 'Acme' },
      {
        priority: 'same_day',
        reason: 'Onsite tomorrow at 14:00',
        application_id: 'app-acme',
        company: 'Acme',
        action_hint: 'Prep system design',
      },
      { priority: 'action_owed', reason: 'Silent 20 days', application_id: 'app-globex', company: 'Globex' },
      { priority: 'action_owed', reason: 'Recruiter asked for times', application_id: null, company: 'Umbrella' },
      { priority: 'fyi', reason: 'New posting', company: null },
    ]),
    JSON.stringify([
      { action: 'mark_interviewing', target_id: 'app-acme', evidence_msg_id: 'msg-2', rationale: 'Loop invite' },
      { action: 'draft_followup', target_id: 'lead-new', evidence_msg_id: null, rationale: 'Thank-you note owed' },
      { action: 'create_lead', target_id: 'lead-other', evidence_msg_id: 'msg-9', rationale: 'Unrelated' },
    ]),
  );

  const kit = db.prepare(
    `INSERT INTO interview_kits (id, application_id, round, interview_type, drive_file_id, drive_url, title,
                                 interview_at, status, created_at)
     VALUES (?, 'app-acme', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  kit.run(
    'kit-1',
    'SCREENING',
    'recruiter_screen',
    'f1',
    'https://docs.example.com/kit-1',
    'Kit — Acme — Screen',
    null,
    'archived',
    '2026-10-19T00:00:00Z',
  );
  kit.run(
    'kit-2',
    'TECH_SCREEN',
    'technical_screen',
    'f2',
    'https://docs.example.com/kit-2',
    'Kit — Acme — Tech',
    '2026-11-17T14:00:00Z',
    'active',
    '2026-11-06T13:00:00Z',
  );

  db.prepare(
    `INSERT INTO learnings (id, application_id, kind, role_category, reflections, reflection_published, created_at)
     VALUES ('learn-1', 'app-acme', 'screen_pass', 'infra', ?, 1, '2026-10-21T00:00:00Z')`,
  ).run(JSON.stringify({ what_worked: 'Led with the migration story', next_time: 'Ask about on-call', score: 4 }));

  db.prepare(`UPDATE candidate_profile SET gmail_account = 'jane@example.com' WHERE id = 1`).run();
  if (!(db.prepare('SELECT 1 FROM candidate_profile WHERE id = 1').get() as unknown)) {
    db.prepare(
      `INSERT INTO candidate_profile (id, gmail_account, updated_at) VALUES (1, 'jane@example.com', '2026-11-01T00:00:00Z')`,
    ).run();
  }

  const mail = db.prepare(
    `INSERT INTO email_events (gmail_msg_id, thread_id, classification, confidence, linked_job_lead_id,
                               linked_application_id, from_addr, subject, received_at, classified_at, classified_by_run_id)
     VALUES (?, ?, ?, 0.9, ?, ?, ?, ?, ?, '2026-11-16T07:30:00Z', 'run-new')`,
  );
  // Older mail on the application itself; the newest arrives via the linked lead.
  mail.run(
    'msg-1',
    'thr-1',
    'recruiter_screen',
    null,
    'app-acme',
    'recruiter@acme.example.com',
    'Screen time',
    '2026-10-18T00:00:00Z',
  );
  mail.run(
    'msg-2',
    'thr-2',
    'onsite_invite',
    'lead-new',
    null,
    'loop@acme.example.com',
    'Your onsite loop',
    '2026-11-05T00:00:00Z',
  );
  mail.run('msg-3', 'thr-3', 'noise', 'lead-other', null, 'x@example.com', 'Unrelated', '2026-11-15T00:00:00Z');

  const tr = db.prepare(
    `INSERT INTO tailored_resumes (id, lead_id, created_at, status, bio_outcome) VALUES (?, ?, ?, ?, ?)`,
  );
  tr.run('tr-old', 'lead-old', '2026-09-02T00:00:00Z', 'ready', 'fallback_stub');
  tr.run('tr-new', 'lead-new', '2026-10-02T00:00:00Z', 'ready', 'tailored');
  tr.run('tr-failed', 'lead-new', '2026-10-03T00:00:00Z', 'failed', null);
  tr.run('tr-other', 'lead-other', '2026-10-06T00:00:00Z', 'ready', 'tailored');
}

describe('buildAdminPipeline — the §24.203 fields', () => {
  it('returns every new field from a seeded fixture', () => {
    seedFixture();
    const p = buildAdminPipeline(getDb(), { now: NOW });

    // Order unchanged: last_activity_at DESC.
    expect(p.applications.map((r) => r.application_id)).toEqual(['app-acme', 'app-globex', 'app-initech']);
    expect(p.stageCounts).toEqual({ tech: 1, withdrawn: 1, applied: 1 });
    expect(p.ghostingThresholdsDays).toEqual({ applied: 21, screen: 10, onsite: 7 });
    expect(p.ghostingStageMap).toEqual({ applied: 'applied', screening: 'screen', tech: 'onsite', final: 'onsite' });

    const acme = p.applications[0];
    expect(acme).toMatchObject({
      company_name: 'Acme',
      role_title: 'Staff Engineer',
      stage: 'tech',
      stage_entered_at: '2026-11-06T12:00:00Z',
      days_in_stage: 10,
      ghosting_threshold_days: 7,
      ghosting: true,
      win_confidence_rationale: 'Strong loop so far; panel feedback pending.',
      lead_ids: ['lead-new', 'lead-old'],
      posting_url: 'https://boards.example.com/acme/apply',
      sent_resume_id: 'tr-new',
    });

    // Timeline: oldest first; summary from payload.summary, then .note, else null.
    expect(acme.timeline).toEqual([
      {
        id: 'ev-1',
        ts: '2026-10-20T00:00:00Z',
        kind: 'status_change',
        from_status: 'APPLIED',
        to_status: 'SCREENING',
        source: 'pipeline_scribe',
        summary: 'Recruiter screen',
      },
      {
        id: 'ev-2',
        ts: '2026-11-06T12:00:00Z',
        kind: 'status_change',
        from_status: 'SCREENING',
        to_status: 'TECH_SCREEN',
        source: 'agent',
        summary: 'Loop booked',
      },
      {
        id: 'ev-3',
        ts: '2026-11-10T00:00:00Z',
        kind: 'note',
        from_status: null,
        to_status: null,
        source: 'owner',
        summary: null,
      },
    ]);

    // Narrative: the latest run's first item for this application; excerpt coerced to strings.
    expect(acme.narrative).toEqual({
      current_state: 'onsite_scheduled',
      last_event_at: '2026-11-15T00:00:00Z',
      timeline_excerpt: ['2026-10-20 recruiter screen', '{"when":"2026-11-06","what":"loop booked"}'],
    });

    // Attention: ordered same_day → action_owed → fyi; hint from action_hint.
    expect(acme.attention).toEqual([
      { priority: 'same_day', reason: 'Onsite tomorrow at 14:00', hint: 'Prep system design' },
      { priority: 'fyi', reason: 'Panel list arrived', hint: null },
    ]);
    expect(acme.attention_top).toBe('same_day');

    // Suggestions targeting the application or one of its leads only.
    expect(acme.suggestions).toEqual([
      { action: 'mark_interviewing', rationale: 'Loop invite', evidence_msg_id: 'msg-2' },
      { action: 'draft_followup', rationale: 'Thank-you note owed', evidence_msg_id: null },
    ]);

    // Last email: the newest across the application's own link and its leads'.
    expect(acme.last_email).toEqual({
      at: '2026-11-05T00:00:00Z',
      subject: 'Your onsite loop',
      from_addr: 'loop@acme.example.com',
      classification: 'onsite_invite',
      thread_id: 'thr-2',
      thread_url: 'https://mail.google.com/mail/?authuser=jane%40example.com#all/thr-2',
    });

    expect(acme.learnings).toEqual([
      {
        id: 'learn-1',
        kind: 'screen_pass',
        created_at: '2026-10-21T00:00:00Z',
        published: true,
        text: 'Led with the migration story · Ask about on-call',
      },
    ]);

    expect(acme.kits).toEqual([
      {
        round: 'TECH_SCREEN',
        interview_type: 'technical_screen',
        title: 'Kit — Acme — Tech',
        drive_url: 'https://docs.example.com/kit-2',
        status: 'active',
        interview_at: '2026-11-17T14:00:00Z',
        created_at: '2026-11-06T13:00:00Z',
      },
      {
        round: 'SCREENING',
        interview_type: 'recruiter_screen',
        title: 'Kit — Acme — Screen',
        drive_url: 'https://docs.example.com/kit-1',
        status: 'archived',
        interview_at: null,
        created_at: '2026-10-19T00:00:00Z',
      },
    ]);
    expect(acme.active_kit_url).toBe('https://docs.example.com/kit-2');

    // Ready résumés of the linked leads, newest first, the sent one marked.
    expect(acme.tailored_resumes).toEqual([
      { id: 'tr-new', lead_id: 'lead-new', created_at: '2026-10-02T00:00:00Z', bio_outcome: 'tailored', sent: true },
      {
        id: 'tr-old',
        lead_id: 'lead-old',
        created_at: '2026-09-02T00:00:00Z',
        bio_outcome: 'fallback_stub',
        sent: false,
      },
    ]);

    // Closed application: its attention is dropped by the live-state reconcile.
    const globex = p.applications[1];
    expect(globex.attention).toEqual([]);
    expect(globex.attention_top).toBeNull();
    expect(globex.ghosting_threshold_days).toBeNull(); // withdrawn is never tinted
    expect(globex.ghosting).toBe(false);

    // A row with nothing joined: empty values, posting falls back to applications.job_url.
    const initech = p.applications[2];
    expect(initech).toMatchObject({
      days_in_stage: 3,
      ghosting_threshold_days: 21,
      ghosting: false,
      lead_ids: [],
      posting_url: 'https://initech.example.com/jobs/9',
      sent_resume_id: null,
      timeline: [],
      narrative: null,
      suggestions: [],
      attention: [],
      attention_top: null,
      last_email: null,
      learnings: [],
      kits: [],
      active_kit_url: null,
      tailored_resumes: [],
    });

    // The latest run, with company-only attention shown above the table.
    expect(p.scribe).toEqual({
      run_at: '2026-11-16T07:30:00Z',
      attention_unlinked: [
        { priority: 'action_owed', reason: 'Recruiter asked for times', hint: null, company: 'Umbrella' },
        { priority: 'fyi', reason: 'New posting', hint: null, company: null },
      ],
    });
  });

  it('omits authuser from the thread link when no Gmail account is set', () => {
    seedFixture();
    getDb().prepare('UPDATE candidate_profile SET gmail_account = NULL').run();
    const acme = buildAdminPipeline(getDb(), { now: NOW }).applications[0];
    expect(acme.last_email?.thread_url).toBe('https://mail.google.com/mail/#all/thr-2');
  });

  it('degrades each join on its own: bad scribe JSON and a missing table never 500', () => {
    seedFixture();
    getDb().prepare(`UPDATE pipeline_scribe_output SET attention_json = '{oops', suggestions_json = 'null'`).run();
    getDb().exec('DROP TABLE learnings');
    const p = buildAdminPipeline(getDb(), { now: NOW });
    const acme = p.applications[0];
    expect(acme.attention).toEqual([]);
    expect(acme.suggestions).toEqual([]);
    expect(acme.learnings).toEqual([]);
    // The other joins are untouched.
    expect(acme.narrative?.current_state).toBe('onsite_scheduled');
    expect(acme.kits).toHaveLength(2);
    expect(p.scribe).toEqual({ run_at: '2026-11-16T07:30:00Z', attention_unlinked: [] });
  });

  it('serves the empty shape on a DB with no scribe run and no rows', () => {
    const p = buildAdminPipeline(getDb(), { now: NOW });
    expect(p.applications).toEqual([]);
    expect(p.stageCounts).toEqual({});
    expect(p.scribe).toBeNull();
    expect(p.ghostingThresholdsDays).toEqual({ applied: 21, screen: 10, onsite: 7 });
  });
});

describe('buildAdminPipeline — read-size caps (the tab polls every 20 s)', () => {
  it('serves the newest ADMIN_PIPELINE_TIMELINE_CAP events oldest-first, the newest learnings, and one email per app', () => {
    const { ADMIN_PIPELINE_TIMELINE_CAP, ADMIN_PIPELINE_LEARNINGS_CAP } = adminPipelineModule;
    seedApp({
      id: 'app-busy',
      company: 'Globex',
      role: 'Backend Engineer',
      status: 'APPLIED',
      stage: 'applied',
      stageEnteredAt: '2026-10-01T00:00:00Z',
      lastActivityAt: '2026-11-15T00:00:00Z',
    });
    seedLead('lead-busy', 'app-busy', '2026-09-01T00:00:00Z', null);
    const db = getDb();
    const total = ADMIN_PIPELINE_TIMELINE_CAP + 15;
    const ev = db.prepare(
      `INSERT INTO pipeline_events (id, application_id, kind, from_status, to_status, payload, source, ts)
       VALUES (?, 'app-busy', 'note', NULL, NULL, '{}', 'agent', ?)`,
    );
    const ts = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 3_600_000).toISOString();
    for (let i = 0; i < total; i++) ev.run(`busy-ev-${i}`, ts(i));
    const learn = db.prepare(
      `INSERT INTO learnings (id, application_id, kind, role_category, reflections, reflection_published, created_at)
       VALUES (?, 'app-busy', 'note', 'infra', '"x"', 0, ?)`,
    );
    for (let i = 0; i < ADMIN_PIPELINE_LEARNINGS_CAP + 5; i++) learn.run(`busy-l-${i}`, ts(i));
    const mail = db.prepare(
      `INSERT INTO email_events (gmail_msg_id, thread_id, classification, confidence, linked_job_lead_id,
                                 linked_application_id, from_addr, subject, received_at, classified_at, classified_by_run_id)
       VALUES (?, ?, 'noise', 0.9, ?, ?, 'x@example.com', ?, ?, '2026-11-16T07:30:00Z', 'r')`,
    );
    for (let i = 0; i < 40; i++) {
      // Alternate the link: half on the application, half on its lead.
      mail.run(`busy-m-${i}`, `busy-t-${i}`, i % 2 ? 'lead-busy' : null, i % 2 ? null : 'app-busy', `m${i}`, ts(i));
    }

    const busy = buildAdminPipeline(db, { now: NOW }).applications.find((a) => a.application_id === 'app-busy')!;
    expect(busy.timeline).toHaveLength(ADMIN_PIPELINE_TIMELINE_CAP);
    expect(busy.timeline[0].id).toBe(`busy-ev-${total - ADMIN_PIPELINE_TIMELINE_CAP}`);
    expect(busy.timeline.at(-1)!.id).toBe(`busy-ev-${total - 1}`);
    expect(busy.learnings).toHaveLength(ADMIN_PIPELINE_LEARNINGS_CAP);
    expect(busy.learnings[0].id).toBe(`busy-l-${ADMIN_PIPELINE_LEARNINGS_CAP + 4}`);
    expect(busy.last_email).toMatchObject({ subject: 'm39', thread_id: 'busy-t-39' });
  });
});

describe('the Pipeline tab has no write path', () => {
  const saved = process.env.ENVIRONMENT;
  afterEach(async () => {
    await stopPortalApi();
    if (saved === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = saved;
  });

  it('exports no pipeline writer', () => {
    expect('applyAdminPipelineWrite' in adminModule).toBe(false);
    expect('applyAdminPipelineWriteAsync' in adminModule).toBe(false);
    expect(Object.keys(adminPipelineModule).filter((k) => /^apply/i.test(k))).toEqual([]);
  });

  it('answers a POST to /api/admin/pipeline as an unknown route, while the GET serves', async () => {
    process.env.ENVIRONMENT = 'dev';
    const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${port}`;

    const get = await fetch(`${base}/api/admin/pipeline`);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ applications: [], scribe: null });

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/admin/pipeline`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_status', application_id: 'app-1', status: 'OFFER' }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found', path: '/api/admin/pipeline' });
    }
  });
});
