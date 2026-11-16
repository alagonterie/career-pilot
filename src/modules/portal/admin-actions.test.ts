/**
 * §24.202 — the /admin side of agent actions: the list/detail/enqueue routes,
 * the per-lead summary + meta on the Leads read, bulk_delete skipping a lead
 * with an action in flight, and the adminEnabled() gate over real HTTP.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { INBOUND_SCHEMA } from '../../db/schema.js';
import type { AgentActionDeps } from '../career-pilot/agent-actions.js';

import { applyAdminLeadsWrite, buildAdminLeads } from './admin.js';
import { readAdminAction, readAdminActions, writeAdminAction } from './admin-actions.js';
import { startPortalApi, stopPortalApi } from './api.js';

const T0 = new Date('2026-11-16T12:00:00.000Z');
let inDb: Database.Database;
let deps: AgentActionDeps;

function seedLead(id: string): void {
  const t = T0.toISOString();
  getDb()
    .prepare(
      `INSERT INTO job_leads (id, source, source_job_id, source_url, content_fingerprint, title, company,
                              first_seen_at, last_seen_at, status, status_changed_at, rules_score)
       VALUES (?, 'greenhouse', ?, 'https://x/' || ?, 'fp-' || ?, 'Senior Engineer', 'Acme', ?, ?, 'new', ?, 50)`,
    )
    .run(id, id, id, id, t, t, t);
}

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
  inDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  deps = {
    now: () => T0,
    ops: () => ({ agentGroupId: 'ag', sessionId: 'sess-ops', open: () => ({ inDb, outDb: null, close() {} }) }),
  };
  seedLead('lead-1');
  seedLead('lead-2');
});

afterEach(() => {
  inDb.close();
  closeDb();
});

function enqueue(lead: string): string {
  const out = writeAdminAction(getDb(), { action: 'enqueue', kind: 'research_company', lead_id: lead }, deps);
  expect(out.status).toBe(202);
  return (out.body as { action_id: string }).action_id;
}

describe('GET /api/admin/actions (+ /<id>)', () => {
  it('lists newest first with meta, filters by lead, and serves one action', () => {
    const a = enqueue('lead-1');
    const b = enqueue('lead-2');
    const all = readAdminActions(getDb(), null, deps);
    expect(all.status).toBe(200);
    const body = all.body as { actions: { id: string; expires_at: string; has_result: boolean }[]; meta: unknown };
    expect(body.actions.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(body.actions[0].expires_at).toBe(new Date(T0.getTime() + 30 * 60_000).toISOString());
    expect(body.meta).toMatchObject({ used_today: 2, can_enqueue: true });
    const one = readAdminActions(getDb(), 'lead-2', deps).body as { actions: { id: string }[] };
    expect(one.actions.map((r) => r.id)).toEqual([b]);

    expect(readAdminAction(getDb(), a, deps)).toMatchObject({
      status: 200,
      body: { id: a, status: 'queued', result_md: null, result_json: null, progress: [] },
    });
    expect(readAdminAction(getDb(), 'act-nope', deps)).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('404s every route on an un-migrated DB', () => {
    getDb().exec('DROP TABLE agent_actions');
    expect(readAdminActions(getDb(), null, deps).status).toBe(404);
    expect(readAdminAction(getDb(), 'x', deps).status).toBe(404);
    expect(writeAdminAction(getDb(), { action: 'run_now', series: 'job_scrape' }, deps).status).toBe(404);
  });

  it('serves progress rows from the ops session inside the action window', () => {
    const id = enqueue('lead-1');
    getDb()
      .prepare("UPDATE agent_actions SET status = 'running', started_at = ? WHERE id = ?")
      .run('2026-11-16T12:01:00.000Z', id);
    const ins = getDb().prepare(
      `INSERT INTO public_audit_trail (id, seq, ts, category, agent_name, proactive, summary, details_json)
       VALUES (?, ?, ?, 'subagent_progress', 'research-company', 0, ?, ?)`,
    );
    ins.run('p0', 1, '2026-11-16T12:00:30.000Z', 'before the window', JSON.stringify({ session_id: 'sess-ops' }));
    ins.run(
      'p1',
      2,
      '2026-11-16T12:02:00.000Z',
      'reading the careers page',
      JSON.stringify({ session_id: 'sess-ops' }),
    );
    ins.run('p2', 3, '2026-11-16T12:02:30.000Z', 'another session', JSON.stringify({ session_id: 'sess-chat' }));
    const detail = readAdminAction(getDb(), id, { ...deps, now: () => new Date('2026-11-16T12:05:00.000Z') }).body as {
      progress: unknown[];
    };
    expect(detail.progress).toEqual([
      { ts: '2026-11-16T12:02:00.000Z', agent: 'research-company', text: 'reading the careers page' },
    ]);
  });
});

describe('GET /api/admin/leads — agent-action additions', () => {
  it('adds actions to every lead and agentActions to the view', () => {
    deps.now = () => new Date(); // the Leads read observes on the real clock
    const id = enqueue('lead-1');
    const view = buildAdminLeads(getDb());
    const l1 = view.leads.find((l) => l.id === 'lead-1')!;
    const l2 = view.leads.find((l) => l.id === 'lead-2')!;
    expect(l1.actions).toMatchObject({ in_flight: true, latest: { research_company: { id, status: 'queued' } } });
    expect(l2.actions).toEqual({ in_flight: false, latest: {} });
    expect(view.agentActions).toMatchObject({ daily_cap: 12, used_today: 1, kit_rounds: expect.any(Array) });
  });

  it('omits both when agent_actions is not migrated', () => {
    getDb().exec('DROP TABLE agent_actions');
    const view = buildAdminLeads(getDb());
    expect(view.agentActions).toBeUndefined();
    expect(view.leads[0].actions).toBeUndefined();
  });
});

describe('bulk_delete skips a lead with an action in flight', () => {
  it('reports action_in_flight and keeps the lead', () => {
    deps.now = () => new Date();
    enqueue('lead-1');
    const out = applyAdminLeadsWrite(getDb(), { action: 'bulk_delete', ids: ['lead-1', 'lead-2'], confirm: true });
    expect(out).toEqual({
      status: 200,
      body: { ok: true, deleted: 1, skipped: 1, skipped_by_reason: { action_in_flight: 1 } },
    });
    expect(getDb().prepare("SELECT id FROM job_leads WHERE id = 'lead-1'").get()).toEqual({ id: 'lead-1' });
  });
});

describe('/api/admin/actions sits behind adminEnabled()', () => {
  const saved = process.env.ENVIRONMENT;
  afterEach(async () => {
    await stopPortalApi();
    if (saved === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = saved;
  });

  it('404s reads and writes off the dev stack, serves them on dev', async () => {
    const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${port}`;
    const post = (body: unknown) =>
      fetch(`${base}/api/admin/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    process.env.ENVIRONMENT = 'production';
    expect((await fetch(`${base}/api/admin/actions`)).status).toBe(404);
    expect((await fetch(`${base}/api/admin/actions/act-1`)).status).toBe(404);
    const denied = await post({ action: 'enqueue', kind: 'research_company', lead_id: 'lead-1' });
    expect(denied.status).toBe(404);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM agent_actions').get()).toEqual({ n: 0 });

    process.env.ENVIRONMENT = 'dev';
    const list = await fetch(`${base}/api/admin/actions`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ actions: [], meta: { can_enqueue: false } });
    expect((await fetch(`${base}/api/admin/actions/act-1`)).status).toBe(404);
    const bad = await fetch(`${base}/api/admin/actions`, { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid JSON body' });
    // no ops session on this stack → refused, nothing written
    const r = await post({ action: 'enqueue', kind: 'research_company', lead_id: 'lead-1' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'no_ops_session' });
  });
});
