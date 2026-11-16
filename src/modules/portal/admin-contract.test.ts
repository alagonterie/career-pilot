/**
 * The host ⇄ frontend contract for the /admin Watchlist, Pipeline and agent
 * actions (STRATEGY.md §24.202 D6–D7, §24.203, §24.204).
 *
 * The frontend (`frontend/src/lib/use-admin.ts`) types these bodies by hand.
 * This file pins the EXACT key sets those types rely on, read from the real host
 * builders and handlers on a seeded in-memory DB, so a rename on either side
 * fails here instead of silently rendering nothing. It also pins the status
 * codes / error codes the UI branches on, and that every new route sits behind
 * the `adminEnabled()` gate (and that no pipeline write route exists).
 *
 * When a key list below changes, change the matching frontend type in the same
 * commit.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../../db/schema.js';
import type { Session } from '../../types.js';
import { type AgentActionDeps, completeAdminAction } from '../career-pilot/agent-actions.js';
import { ensureAtsWatchlistSeeded, upsertBoard } from '../career-pilot/ats-watchlist.js';
import { OPS_THREAD_ID } from '../career-pilot/ops-session.js';

import { applyAdminWatchlistWriteAsync, buildAdminLeads, buildAdminPipeline, buildAdminWatchlist } from './admin.js';
import { readAdminAction, readAdminActions, writeAdminAction } from './admin-actions.js';
import { startPortalApi, stopPortalApi } from './api.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-admin-contract-${process.pid}`);
const emptySeed = path.join(tmpDir, 'empty-seed.json');
const GROUP_ID = 'ag-owner';
const OPS_ID = 'sess-ops';

const keys = (o: unknown): string[] => Object.keys(o as Record<string, unknown>).sort();
const sorted = (k: readonly string[]): string[] => [...k].sort();

// ── the key sets the frontend types rely on (frontend/src/lib/use-admin.ts) ──

const WATCHLIST_VIEW = ['boards', 'counts', 'caps'];
const WATCHLIST_BOARD = [
  'id',
  'ats',
  'token',
  'company',
  'tier',
  'origin',
  'state',
  'notes',
  'last_ok_at',
  'last_error',
  'consecutive_failures',
  'consecutive_absent',
  'leads_found',
  'last_hit_at',
  'created_at',
  'updated_at',
  'open_leads',
  'board_url',
];
const WATCHLIST_COUNTS = ['total', 'active', 'paused', 'absent', 'by_origin'];
const WATCHLIST_CAPS = ['max_boards', 'counted', 'max_auto_adds_per_run'];
const SWEEP_PREVIEW = [
  'ok',
  'total',
  'current',
  'proposed',
  'newly_dropped',
  'newly_kept',
  'sample_newly_dropped',
  'sample_newly_kept',
];
const SWEEP_COUNTS = ['keep', 'drop', 'drop_by_reason'];

const PIPELINE_VIEW = ['applications', 'stageCounts', 'ghostingThresholdsDays', 'ghostingStageMap', 'scribe'];
const PIPELINE_ROW = [
  'application_id',
  'company_name',
  'obfuscated_label',
  'role_title',
  'status',
  'stage',
  'applied_at',
  'last_activity_at',
  'win_confidence',
  'stage_entered_at',
  'days_in_stage',
  'ghosting_threshold_days',
  'ghosting',
  'win_confidence_rationale',
  'lead_ids',
  'posting_url',
  'sent_resume_id',
  'timeline',
  'narrative',
  'suggestions',
  'attention',
  'attention_top',
  'last_email',
  'learnings',
  'kits',
  'active_kit_url',
  'tailored_resumes',
];
const PIPELINE_TIMELINE = ['id', 'ts', 'kind', 'from_status', 'to_status', 'source', 'summary'];
const PIPELINE_NARRATIVE = ['current_state', 'last_event_at', 'timeline_excerpt'];
const PIPELINE_ATTENTION = ['priority', 'reason', 'hint'];
const PIPELINE_SUGGESTION = ['action', 'rationale', 'evidence_msg_id'];
const PIPELINE_LAST_EMAIL = ['at', 'subject', 'from_addr', 'classification', 'thread_id', 'thread_url'];
const PIPELINE_LEARNING = ['id', 'kind', 'created_at', 'published', 'text'];
const PIPELINE_KIT = ['round', 'interview_type', 'title', 'drive_url', 'status', 'interview_at', 'created_at'];
const PIPELINE_RESUME = ['id', 'lead_id', 'created_at', 'bio_outcome', 'sent'];
const PIPELINE_SCRIBE = ['run_at', 'attention_unlinked'];

const ACTIONS_LIST = ['actions', 'meta'];
const ACTION_ROW = [
  'id',
  'kind',
  'series',
  'lead_id',
  'company',
  'title',
  'application_id',
  'round',
  'note',
  'status',
  'error',
  'created_at',
  'started_at',
  'completed_at',
  'expires_at',
  'has_result',
];
const ACTION_DETAIL = [...ACTION_ROW, 'result_md', 'result_json', 'progress'];
const ACTION_PROGRESS = ['ts', 'agent', 'text'];
const OUTREACH_RESULT = ['subject', 'body', 'to', 'research_md'];
const KIT_RESULT = ['kit_url', 'title', 'round'];
const ACTIONS_META = [
  'pause_state',
  'can_enqueue',
  'daily_cap',
  'used_today',
  'note_max_chars',
  'ttl_minutes',
  'guard_minutes',
  'compose_authuser',
  'run_now',
  'kit_rounds',
];
const RUN_NOW_STATE = ['in_flight_action_id', 'next_scheduled_at', 'guarded'];
const LEAD_ACTIONS_SUMMARY = ['in_flight', 'latest'];
const ACTION_BRIEF = ['id', 'status', 'created_at', 'completed_at', 'has_result'];

// ── fixture ──────────────────────────────────────────────────────────────────

let inDb: Database.Database;
let outDb: Database.Database;
let deps: AgentActionDeps;

const opsSession = {
  id: OPS_ID,
  agent_group_id: GROUP_ID,
  messaging_group_id: null,
  thread_id: OPS_THREAD_ID,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: new Date().toISOString(),
} as unknown as Session;

function seedLead(id: string, appId: string | null = null): void {
  const t = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO job_leads (id, source, source_job_id, source_url, apply_url, content_fingerprint, title, company,
                              first_seen_at, last_seen_at, status, status_changed_at, application_id,
                              source_board_token, rules_score)
       VALUES (?, 'greenhouse', ?, 'https://job-boards.greenhouse.io/acme/jobs/' || ?,
               'https://job-boards.greenhouse.io/acme/jobs/' || ?, 'fp-' || ?, 'Senior Engineer', 'Acme',
               ?, ?, 'new', ?, ?, 'acme', 50)`,
    )
    .run(id, id, id, id, id, t, t, t, appId);
}

function seedApp(id: string, stage: string, status: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO applications (id, company_name, obfuscated_label, role_title, job_url, status, win_confidence,
                               win_confidence_rationale, applied_at, last_activity_at, created_at)
     VALUES (?, 'Acme', ?, 'Senior Engineer', 'https://example.com/job', ?, 40, 'Solid loop',
             '2026-10-01T00:00:00Z', '2026-11-15T00:00:00Z', '2026-10-01T00:00:00Z')`,
  ).run(id, `misc-${id}`, status);
  db.prepare(
    `INSERT INTO public_pipeline_view (application_id, application_ref, public_state, role_title, status, stage,
                                       applied_at, stage_entered_at, last_activity_at, win_confidence, updated_at)
     VALUES (?, ?, 'obfuscated', 'Senior Engineer', ?, ?, '2026-10-01T00:00:00Z', '2026-11-06T00:00:00Z',
             '2026-11-15T00:00:00Z', 40, '2026-11-16T00:00:00Z')`,
  ).run(id, `misc-${id}`, status, stage);
}

function seedPipelineJoins(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO pipeline_events (id, application_id, kind, from_status, to_status, payload, source, ts)
     VALUES ('ev-1', 'app-1', 'status_change', 'APPLIED', 'TECH_SCREEN', '{"summary":"Loop booked"}', 'agent',
             '2026-11-06T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO pipeline_scribe_output (id, run_at, gmail_history_id, calendar_sync_tokens,
                                         narratives_json, attention_json, suggestions_json, cheap_out, cost_usd)
     VALUES ('run-1', '2026-11-16T07:30:00Z', NULL, '{}', ?, ?, ?, 0, 0.1)`,
  ).run(
    JSON.stringify([
      {
        application_id: 'app-1',
        current_state: 'onsite',
        last_event_at: '2026-11-15T00:00:00Z',
        timeline_excerpt: ['x'],
      },
    ]),
    JSON.stringify([
      { priority: 'same_day', reason: 'Onsite tomorrow', application_id: 'app-1', action_hint: 'Prep' },
      { priority: 'fyi', reason: 'Recruiter wrote', application_id: null, company: 'Globex' },
    ]),
    JSON.stringify([
      { action: 'mark_interviewing', target_id: 'app-1', evidence_msg_id: 'msg-1', rationale: 'Invite' },
    ]),
  );
  db.prepare(
    `INSERT INTO interview_kits (id, application_id, round, interview_type, drive_file_id, drive_url, title,
                                 interview_at, status, created_at)
     VALUES ('kit-1', 'app-1', 'TECH_SCREEN', 'technical_screen', 'f1', 'https://docs.example.com/kit-1',
             'Kit — Acme — Tech', NULL, 'active', '2026-11-06T01:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO learnings (id, application_id, kind, role_category, reflections, reflection_published, created_at)
     VALUES ('learn-1', 'app-1', 'screen_pass', 'infra', '{"what_worked":"stories"}', 0, '2026-10-21T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO email_events (gmail_msg_id, thread_id, classification, confidence, linked_job_lead_id,
                               linked_application_id, from_addr, subject, received_at, classified_at,
                               classified_by_run_id)
     VALUES ('msg-1', 'thr-1', 'onsite_invite', 0.9, NULL, 'app-1', 'loop@acme.example.com', 'Your loop',
             '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z', 'run-1')`,
  ).run();
  db.prepare(
    `INSERT INTO tailored_resumes (id, lead_id, created_at, status, bio_outcome)
     VALUES ('tr-1', 'lead-app', '2026-10-02T00:00:00Z', 'ready', 'tailored')`,
  ).run();
}

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(emptySeed, '[]');
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
  ensureAtsWatchlistSeeded(getDb(), emptySeed);
  createAgentGroup({
    id: GROUP_ID,
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  inDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  outDb = new Database(':memory:');
  outDb.exec(OUTBOUND_SCHEMA);
  deps = {
    now: () => new Date(),
    ops: () => ({ agentGroupId: GROUP_ID, sessionId: OPS_ID, open: () => ({ inDb, outDb, close() {} }) }),
  };
  seedApp('app-1', 'tech', 'TECH_SCREEN');
  seedApp('app-2', 'applied', 'APPLIED');
  seedLead('lead-1');
  seedLead('lead-2');
  seedLead('lead-app', 'app-1');
  // The host must never reach the network here.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network is off in tests');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  inDb.close();
  outDb.close();
  closeDb();
});

// ── watchlist ────────────────────────────────────────────────────────────────

describe('contract: GET /api/admin/watchlist', () => {
  it('serves exactly the view, board, counts and caps keys the frontend types', () => {
    expect(upsertBoard(getDb(), { ats: 'greenhouse', token: 'acme', company: 'Acme', origin: 'owner' }).ok).toBe(true);
    const view = buildAdminWatchlist(getDb());
    expect(keys(view)).toEqual(sorted(WATCHLIST_VIEW));
    expect(view.boards).toHaveLength(1);
    expect(keys(view.boards[0])).toEqual(sorted(WATCHLIST_BOARD));
    expect(keys(view.counts)).toEqual(sorted(WATCHLIST_COUNTS));
    expect(keys(view.caps)).toEqual(sorted(WATCHLIST_CAPS));
    // id is a number (INTEGER primary key), open_leads counts this board's open leads
    expect(typeof view.boards[0].id).toBe('number');
    expect(view.boards[0]).toMatchObject({ open_leads: 3, board_url: 'https://job-boards.greenhouse.io/acme' });
  });

  it('keeps the same keys on an un-migrated DB (empty view)', () => {
    getDb().exec('DROP TABLE ats_watchlist');
    const view = buildAdminWatchlist(getDb());
    expect(keys(view)).toEqual(sorted(WATCHLIST_VIEW));
    expect(keys(view.counts)).toEqual(sorted(WATCHLIST_COUNTS));
    expect(keys(view.caps)).toEqual(sorted(WATCHLIST_CAPS));
  });
});

describe('contract: POST /api/admin/watchlist', () => {
  it('already_listed carries the board (company + state) — the refusal message names it', async () => {
    upsertBoard(getDb(), { ats: 'lever', token: 'globex', company: 'Globex', origin: 'owner' });
    const out = await applyAdminWatchlistWriteAsync(getDb(), {
      action: 'add_by_url',
      url: 'https://jobs.lever.co/globex',
    });
    expect(out.status).toBe(409);
    const body = out.body as { error: string; board: Record<string, unknown> };
    expect(keys(body)).toEqual(['board', 'error']);
    expect(body.error).toBe('already_listed');
    expect(keys(body.board)).toEqual(sorted(WATCHLIST_BOARD));
    expect(body.board).toMatchObject({ company: 'Globex', state: 'active' });
  });

  it('an unsupported action keeps the `unknown action: <x>` prefix (the UI detects an older host by it)', async () => {
    expect(await applyAdminWatchlistWriteAsync(getDb(), { action: 'rename' })).toEqual({
      status: 400,
      body: { error: 'unknown action: rename' },
    });
  });

  it.each([
    ['ats_sweep_title_include', '(unclosed'],
    ['ats_sweep_title_exclude', '[bad'],
    ['ats_sweep_location_filter', '*nope'],
    ['ats_sweep_title_include', 'x'.repeat(1001)],
    ['ats_sweep_max_age_days', -1],
    ['ats_sweep_max_age_days', 1.5],
    ['ats_sweep_max_new_per_run', 5], // a knob, but not a previewable filter
  ])('preview_filters validates %s = %j → 400 invalid_filter {field, message}', async (field, value) => {
    const out = await applyAdminWatchlistWriteAsync(getDb(), {
      action: 'preview_filters',
      // a valid key first: a bad one later in the object is still caught
      filters: { ats_sweep_max_age_days: 30, [field]: value },
    });
    expect(out.status).toBe(400);
    const body = out.body as Record<string, unknown>;
    expect(keys(body)).toEqual(['error', 'field', 'message']);
    expect(body).toMatchObject({ error: 'invalid_filter', field, message: expect.any(String) });
  });

  it('preview_filters success carries exactly the SweepFilterPreview keys', async () => {
    const out = await applyAdminWatchlistWriteAsync(getDb(), {
      action: 'preview_filters',
      filters: { ats_sweep_title_include: 'Senior' },
    });
    expect(out.status).toBe(200);
    const body = out.body as Record<string, Record<string, unknown>>;
    expect(keys(body)).toEqual(sorted(SWEEP_PREVIEW));
    expect(keys(body.current)).toEqual(sorted(SWEEP_COUNTS));
    expect(keys(body.proposed)).toEqual(sorted(SWEEP_COUNTS));
  });
});

// ── pipeline ─────────────────────────────────────────────────────────────────

describe('contract: GET /api/admin/pipeline', () => {
  it('serves exactly the view and row keys, and every nested item shape the detail renders', () => {
    seedPipelineJoins();
    getDb().prepare(`UPDATE applications SET sent_resume_id = 'tr-1' WHERE id = 'app-1'`).run();
    const p = buildAdminPipeline(getDb());
    expect(keys(p)).toEqual(sorted(PIPELINE_VIEW));
    expect(p.applications).toHaveLength(2);
    for (const row of p.applications) expect(keys(row)).toEqual(sorted(PIPELINE_ROW));

    const r = p.applications.find((a) => a.application_id === 'app-1')!;
    expect(keys(r.timeline[0])).toEqual(sorted(PIPELINE_TIMELINE));
    expect(keys(r.narrative)).toEqual(sorted(PIPELINE_NARRATIVE));
    expect(keys(r.attention[0])).toEqual(sorted(PIPELINE_ATTENTION));
    expect(keys(r.suggestions[0])).toEqual(sorted(PIPELINE_SUGGESTION));
    expect(keys(r.last_email)).toEqual(sorted(PIPELINE_LAST_EMAIL));
    expect(keys(r.learnings[0])).toEqual(sorted(PIPELINE_LEARNING));
    expect(keys(r.kits[0])).toEqual(sorted(PIPELINE_KIT));
    expect(keys(r.tailored_resumes[0])).toEqual(sorted(PIPELINE_RESUME));
    expect(r.attention_top).toBe('same_day');
    expect(keys(p.scribe)).toEqual(sorted(PIPELINE_SCRIBE));
    expect(keys(p.scribe!.attention_unlinked[0])).toEqual(sorted([...PIPELINE_ATTENTION, 'company']));
  });

  it("each row's stage is exactly a key of stageCounts (the stage filter compares them directly)", () => {
    const p = buildAdminPipeline(getDb());
    const stages = p.applications.map((a) => a.stage);
    expect(sorted(stages)).toEqual(['applied', 'tech']);
    expect(sorted(Object.keys(p.stageCounts))).toEqual(sorted([...new Set(stages)]));
    for (const s of stages) expect(p.stageCounts[s]).toBeGreaterThan(0);
  });
});

// ── agent actions ────────────────────────────────────────────────────────────

describe('contract: /api/admin/actions', () => {
  it('POST enqueue → 202 {ok, action_id, status: queued}', () => {
    const out = writeAdminAction(getDb(), { action: 'enqueue', kind: 'research_company', lead_id: 'lead-1' }, deps);
    expect(out.status).toBe(202);
    expect(keys(out.body)).toEqual(['action_id', 'ok', 'status']);
    expect(out.body).toEqual({ ok: true, action_id: expect.any(String), status: 'queued' });
  });

  it('409 in_flight names the holder; 409 duplicate carries action_id (null when only a task is pending)', () => {
    const first = writeAdminAction(getDb(), { action: 'enqueue', kind: 'research_company', lead_id: 'lead-1' }, deps);
    const held = (first.body as { action_id: string }).action_id;
    expect(writeAdminAction(getDb(), { action: 'enqueue', kind: 'draft_outreach', lead_id: 'lead-1' }, deps)).toEqual({
      status: 409,
      body: { error: 'in_flight', action_id: held },
    });

    const run = writeAdminAction(getDb(), { action: 'run_now', series: 'job_scrape' }, deps);
    expect(run.status).toBe(202);
    const runId = (run.body as { action_id: string }).action_id;
    expect(writeAdminAction(getDb(), { action: 'run_now', series: 'job_scrape' }, deps)).toEqual({
      status: 409,
      body: { error: 'duplicate', action_id: runId },
    });
    // A pending run-now one-shot with no row (the row was cleared): the key is present, its value null.
    getDb().prepare('DELETE FROM agent_actions WHERE id = ?').run(runId);
    const dup = writeAdminAction(getDb(), { action: 'run_now', series: 'job_scrape' }, deps);
    expect(dup).toEqual({ status: 409, body: { error: 'duplicate', action_id: null } });
    expect(keys(dup.body)).toEqual(['action_id', 'error']);
  });

  it('GET /<id> answers 404 {error: not_found} for an unknown id', () => {
    expect(readAdminAction(getDb(), 'act-unknown', deps)).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('the list, the meta and every row carry exactly the frontend keys; kit_rounds are the raw constants', () => {
    writeAdminAction(getDb(), { action: 'enqueue', kind: 'research_company', lead_id: 'lead-1' }, deps);
    writeAdminAction(getDb(), { action: 'run_now', series: 'daily_briefing' }, deps);
    const out = readAdminActions(getDb(), null, deps);
    expect(out.status).toBe(200);
    const body = out.body as { actions: Record<string, unknown>[]; meta: Record<string, unknown> };
    expect(keys(body)).toEqual(sorted(ACTIONS_LIST));
    expect(body.actions).toHaveLength(2);
    for (const row of body.actions) expect(keys(row)).toEqual(sorted(ACTION_ROW));
    expect(keys(body.meta)).toEqual(sorted(ACTIONS_META));
    const runNow = body.meta.run_now as Record<string, unknown>;
    expect(keys(runNow)).toEqual(['daily_briefing', 'job_scrape']);
    expect(keys(runNow.job_scrape)).toEqual(sorted(RUN_NOW_STATE));
    expect(keys(runNow.daily_briefing)).toEqual(sorted(RUN_NOW_STATE));
    expect(body.meta.kit_rounds).toEqual(['SCREENING', 'TECH_SCREEN', 'SYS_DESIGN', 'FINAL']);
  });

  it('the single-action read carries the detail keys, and both result_json shapes', () => {
    // research: progress row inside the window
    const research = (
      writeAdminAction(getDb(), { action: 'enqueue', kind: 'draft_outreach', lead_id: 'lead-1' }, deps).body as {
        action_id: string;
      }
    ).action_id;
    getDb()
      .prepare("UPDATE agent_actions SET status = 'running', started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), research);
    getDb()
      .prepare(
        `INSERT INTO public_audit_trail (id, seq, ts, category, agent_name, proactive, summary, details_json)
         VALUES ('p1', 1, ?, 'subagent_progress', 'research-company', 0, 'reading', ?)`,
      )
      .run(new Date(Date.now() - 30_000).toISOString(), JSON.stringify({ session_id: OPS_ID }));
    const running = readAdminAction(getDb(), research, deps).body as Record<string, unknown> & {
      progress: unknown[];
    };
    expect(keys(running)).toEqual(sorted(ACTION_DETAIL));
    expect(running.progress).toHaveLength(1);
    expect(keys(running.progress[0])).toEqual(sorted(ACTION_PROGRESS));

    // outreach result
    expect(
      completeAdminAction(
        getDb(),
        opsSession,
        { action_id: research, ok: true, subject: 'Hi', body: 'Hello' },
        new Date(),
      ),
    ).toMatchObject({ ok: true });
    const outreach = readAdminAction(getDb(), research, deps).body as { result_json: unknown };
    expect(keys(outreach.result_json)).toEqual(sorted(OUTREACH_RESULT));

    // kit result (read from interview_kits when the acknowledged turn ends)
    const kit = (
      writeAdminAction(
        getDb(),
        { action: 'enqueue', kind: 'build_interview_kit', lead_id: 'lead-app', round: 'TECH_SCREEN' },
        deps,
      ).body as { action_id: string }
    ).action_id;
    seedPipelineJoins(); // writes the active TECH_SCREEN kit for app-1
    const msg = (
      getDb().prepare('SELECT message_id FROM agent_actions WHERE id = ?').get(kit) as { message_id: string }
    ).message_id;
    outDb
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run(msg, 'completed', new Date().toISOString());
    const done = readAdminAction(getDb(), kit, deps).body as { status: string; result_json: unknown };
    expect(done.status).toBe('done');
    expect(keys(done.result_json)).toEqual(sorted(KIT_RESULT));
  });
});

describe('contract: GET /api/admin/leads — the per-lead actions summary', () => {
  it('every lead carries {in_flight, latest}; a brief carries exactly its keys; the view carries agentActions', () => {
    writeAdminAction(getDb(), { action: 'enqueue', kind: 'research_company', lead_id: 'lead-1' }, deps);
    const view = buildAdminLeads(getDb());
    expect(view.agentActions).toBeDefined();
    expect(keys(view.agentActions)).toEqual(sorted(ACTIONS_META));
    const all = [...view.leads, ...view.closed];
    expect(all.length).toBeGreaterThan(0);
    for (const l of all) expect(keys(l.actions)).toEqual(sorted(LEAD_ACTIONS_SUMMARY));
    const l1 = all.find((l) => l.id === 'lead-1')!;
    expect(keys(l1.actions!.latest)).toEqual(['research_company']);
    expect(keys(l1.actions!.latest.research_company)).toEqual(sorted(ACTION_BRIEF));
  });
});

// ── the gate ────────────────────────────────────────────────────────────────

describe('contract: every new admin route sits behind adminEnabled(); no pipeline write route', () => {
  const saved = process.env.ENVIRONMENT;
  afterEach(async () => {
    await stopPortalApi();
    if (saved === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = saved;
  });

  it('404s each route off the dev stack with the gate body, and answers on dev', async () => {
    vi.unstubAllGlobals(); // this test talks to the local server
    const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${port}`;
    const call = (method: string, p: string, body?: unknown) =>
      fetch(`${base}${p}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/watchlist'],
      ['POST', '/api/admin/watchlist', { action: 'remove', id: 1 }],
      ['POST', '/api/admin/watchlist', { action: 'preview_filters', filters: {} }],
      ['GET', '/api/admin/pipeline'],
      ['GET', '/api/admin/actions'],
      ['GET', '/api/admin/actions?lead_id=lead-1'],
      ['GET', '/api/admin/actions/act-1'],
      ['POST', '/api/admin/actions', { action: 'run_now', series: 'job_scrape' }],
      ['POST', '/api/admin/leads', { action: 'add_lead_by_url', url: 'https://jobs.lever.co/acme/x' }],
    ];

    process.env.ENVIRONMENT = 'production';
    for (const [method, p, body] of routes) {
      const r = await call(method, p, body);
      expect([method, p, r.status]).toEqual([method, p, 404]);
      expect(await r.json()).toMatchObject({ error: 'not_found', path: p.split('?')[0] });
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get()).toEqual({ n: 0 });

    process.env.ENVIRONMENT = 'dev';
    for (const p of ['/api/admin/watchlist', '/api/admin/pipeline', '/api/admin/actions']) {
      expect([p, (await call('GET', p)).status]).toEqual([p, 200]);
    }
    // Pipeline is read-only: no write method is routed.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = await call(method, '/api/admin/pipeline', method === 'DELETE' ? undefined : { action: 'set_stage' });
      expect([method, r.status]).toEqual([method, 404]);
      expect(await r.json()).toEqual({ error: 'not_found', path: '/api/admin/pipeline' });
    }
  });
});
