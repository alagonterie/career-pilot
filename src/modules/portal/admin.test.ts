/**
 * Tests for the owner-only /admin surface (STRATEGY §24.74 D5).
 *
 * `adminEnabled`: open on the dev stack, fail-closed otherwise (default config).
 * `buildAttributionReport`: aggregates clicks + unique visitors per link, the
 * by-artifact + top-country summary, and the recent-visit feed; empty on a bare
 * DB; nothing leaks beyond the two private tables.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { getConfig } from '../../get-config.js';
import { getLiveMode, getPauseState } from './system-modes.js';

import {
  adminEnabled,
  applyAdminControl,
  applyAdminKnobWrite,
  buildAdminContacts,
  buildAdminKnobs,
  buildAdminPipeline,
  buildAdminSummary,
  buildAttributionReport,
  liveModeBlockers,
} from './admin.js';

function seedLink(code: string, artifact: string, company: string | null, recipient: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO attribution_link (code, artifact_type, company, recipient, dest_path, created_at)
       VALUES (?, ?, ?, ?, '/', ?)`,
    )
    .run(code, artifact, company, recipient, new Date().toISOString());
}

function seedVisit(id: string, code: string | null, ipHash: string | null, country: string | null, ts: string): void {
  getDb()
    .prepare(
      `INSERT INTO visit_telemetry (id, ts, link_code, path, ip_hash, country, ua_class, referrer)
       VALUES (?, ?, ?, '/', ?, ?, 'desktop', NULL)`,
    )
    .run(id, ts, code, ipHash, country);
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
  delete process.env.ENVIRONMENT;
});

describe('adminEnabled', () => {
  it('is open on the dev stack', () => {
    process.env.ENVIRONMENT = 'dev';
    expect(adminEnabled()).toBe(true);
  });

  it('fails closed on a non-dev stack by default', () => {
    process.env.ENVIRONMENT = 'production';
    expect(adminEnabled()).toBe(false);
  });
});

describe('buildAttributionReport', () => {
  it('returns an empty report on a bare DB (no rows)', () => {
    const r = buildAttributionReport(getDb());
    expect(r.links).toHaveLength(0);
    expect(r.recentVisits).toHaveLength(0);
    expect(r.summary.totalClicks).toBe(0);
  });

  it('aggregates clicks + unique visitors per link with a summary + recent feed', () => {
    seedLink('out1', 'outreach', 'anthropic.com', 'jane@anthropic.com');
    seedLink('mp1', 'master_pdf', null, null);
    // out1: 3 clicks from 2 distinct IPs; mp1: 1 click.
    seedVisit('v1', 'out1', 'iphashA', 'US', '2026-06-16T10:00:00.000Z');
    seedVisit('v2', 'out1', 'iphashA', 'US', '2026-06-16T11:00:00.000Z');
    seedVisit('v3', 'out1', 'iphashB', 'CA', '2026-06-16T12:00:00.000Z');
    seedVisit('v4', 'mp1', 'iphashC', 'US', '2026-06-16T13:00:00.000Z');

    const r = buildAttributionReport(getDb());

    expect(r.links).toHaveLength(2);
    const out1 = r.links.find((l) => l.code === 'out1')!;
    expect(out1.clicks).toBe(3);
    expect(out1.uniqueVisitors).toBe(2);
    expect(out1.company).toBe('anthropic.com');
    expect(out1.recipient).toBe('jane@anthropic.com');
    expect(out1.lastClickAt).toBe('2026-06-16T12:00:00.000Z');
    const mp1 = r.links.find((l) => l.code === 'mp1')!;
    expect(mp1.clicks).toBe(1);

    expect(r.summary.totalLinks).toBe(2);
    expect(r.summary.totalClicks).toBe(4);
    expect(r.summary.totalUniqueVisitors).toBe(3);
    expect(r.summary.byArtifact).toEqual({ outreach: 1, master_pdf: 1 });
    expect(r.summary.topCountries[0]).toEqual({ country: 'US', clicks: 3 });

    // Recent feed: newest first, joined company carried through.
    expect(r.recentVisits).toHaveLength(4);
    expect(r.recentVisits[0].ts).toBe('2026-06-16T13:00:00.000Z');
    expect(r.recentVisits[r.recentVisits.length - 1].ts).toBe('2026-06-16T10:00:00.000Z');
    expect(r.recentVisits.find((v) => v.linkCode === 'out1')!.company).toBe('anthropic.com');
  });

  it('honors the recentLimit', () => {
    seedLink('out1', 'outreach', 'x.com', null);
    for (let i = 0; i < 5; i++) seedVisit(`v${i}`, 'out1', `ip${i}`, 'US', `2026-06-16T1${i}:00:00.000Z`);
    expect(buildAttributionReport(getDb(), { recentLimit: 2 }).recentVisits).toHaveLength(2);
  });
});

// ── §24.138: the control-center surface ───────────────────────────────────────

describe('buildAdminKnobs / applyAdminKnobWrite (registry − ADMIN_DENY)', () => {
  it('omits the denied recruiter-sim / dev knobs, keeps the operational levers', () => {
    const keys = buildAdminKnobs(getDb()).knobs.map((k) => k.key);
    expect(keys).not.toContain('recruiter_sim_enabled');
    expect(keys).not.toContain('dev_model_tier');
    expect(keys).toContain('owner_daily_llm_budget_usd');
    expect(keys).toContain('simulator_enabled');
  });

  it('refuses a denied key with 403 (enforced on write, not just hidden)', () => {
    const out = applyAdminKnobWrite(getDb(), { key: 'recruiter_sim_enabled', value: true });
    expect(out.status).toBe(403);
    // an unknown key is still a 400, an included one persists.
    expect(applyAdminKnobWrite(getDb(), { key: 'not_a_key', value: 1 }).status).toBe(400);
    expect(applyAdminKnobWrite(getDb(), { key: 'simulator_max_turns', value: 15 }).status).toBe(200);
    expect(getConfig<number>(getDb(), 'simulator_max_turns')).toBe(15);
  });
});

describe('buildAdminSummary', () => {
  it('rolls up mode + health + 24h cost + the container pool', async () => {
    const s = await buildAdminSummary(getDb());
    expect(s.mode).toMatchObject({ backend: 'online' });
    expect(s.pool.capacity).toBe(getConfig<number>(getDb(), 'container_max_concurrent', 4));
    expect(typeof s.spendTotalMicrousd24h).toBe('number');
    expect(s.health).toHaveProperty('findings');
    expect(s.health).toHaveProperty('counts');
    // findings are the actionable (non-ok) subset.
    expect(s.health.findings.every((f) => f.severity !== 'ok')).toBe(true);
  });
});

describe('buildAdminContacts (§24.121 store)', () => {
  function seedContact(id: string, email: string, created: string): void {
    getDb()
      .prepare(
        `INSERT INTO contact_submissions (id, name, email, company, role, source, message, fingerprint, delivered, created_at)
         VALUES (?, 'Sam Recruiter', ?, 'Acme', 'Staff Eng', 'portal', 'we are hiring', ?, 1, ?)`,
      )
      .run(id, email, `fp-${id}`, created);
  }

  it('is empty on a bare DB', () => {
    expect(buildAdminContacts(getDb()).contacts).toHaveLength(0);
  });

  it('returns recent submissions newest-first', () => {
    seedContact('c1', 'a@acme.example', '2026-06-18T10:00:00.000Z');
    seedContact('c2', 'b@acme.example', '2026-06-19T10:00:00.000Z');
    const { contacts } = buildAdminContacts(getDb());
    expect(contacts).toHaveLength(2);
    expect(contacts[0].id).toBe('c2'); // newest first
    expect(contacts[0].email).toBe('b@acme.example');
  });
});

describe('buildAdminPipeline (owner view — real names)', () => {
  it('joins the pipeline read-model to applications for the real company name', () => {
    getDb()
      .prepare(
        `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, applied_at, created_at)
         VALUES ('app-1', 'Wayne Enterprises', 'infra-e', 'Staff Engineer', 'screening', '2026-06-10T00:00:00Z', '2026-06-10T00:00:00Z')`,
      )
      .run();
    getDb()
      .prepare(
        `INSERT INTO public_pipeline_view (application_id, application_ref, public_state, role_title, status, stage, applied_at, last_activity_at, updated_at)
         VALUES ('app-1', 'infra-e', 'obfuscated', 'Staff Engineer', 'screening', 'screen', '2026-06-10T00:00:00Z', '2026-06-12T00:00:00Z', '2026-06-12T00:00:00Z')`,
      )
      .run();

    const p = buildAdminPipeline(getDb());
    expect(p.applications).toHaveLength(1);
    expect(p.applications[0]).toMatchObject({
      company_name: 'Wayne Enterprises',
      obfuscated_label: 'infra-e',
      stage: 'screen',
    });
    expect(p.stageCounts).toEqual({ screen: 1 });
  });

  it('is empty on a bare DB', () => {
    expect(buildAdminPipeline(getDb()).applications).toHaveLength(0);
  });
});

describe('applyAdminControl (mode controls)', () => {
  function seedCompleteProfile(): void {
    getDb()
      .prepare(
        `INSERT INTO candidate_profile (id, full_name, master_resume, target_roles, bio, search_goals, updated_at)
         VALUES (1, 'Jane Doe', 'resume text', '["Backend Engineer"]', 'bio', 'goals', '2026-06-06T00:00:00Z')`,
      )
      .run();
  }

  it('pause halts + resume restores', async () => {
    const paused = await applyAdminControl(getDb(), { action: 'pause' });
    expect(paused.status).toBe(200);
    expect(getPauseState()).toBe('halted');
    const resumed = await applyAdminControl(getDb(), { action: 'resume' });
    expect(resumed.status).toBe(200);
    expect(getPauseState()).toBe('active');
  });

  it('kill-switch is confirm-gated', async () => {
    expect((await applyAdminControl(getDb(), { action: 'killswitch' })).status).toBe(400); // no confirm
    const out = await applyAdminControl(getDb(), { action: 'killswitch', confirm: true });
    expect(out.status).toBe(200);
    expect(getPauseState()).toBe('killswitch');
  });

  it('set_live_mode needs confirm AND a complete-enough profile', async () => {
    // no confirm → 400
    expect((await applyAdminControl(getDb(), { action: 'set_live_mode', on: true })).status).toBe(400);
    // confirm but bare profile → 409 with the missing fields
    const blocked = await applyAdminControl(getDb(), { action: 'set_live_mode', on: true, confirm: true });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { missing: string[] }).missing.length).toBeGreaterThan(0);
    expect(getLiveMode()).toBe(false);
    // a complete profile → it flips on
    seedCompleteProfile();
    expect(liveModeBlockers(getDb().prepare('SELECT * FROM candidate_profile WHERE id = 1').get() as never)).toEqual(
      [],
    );
    const ok = await applyAdminControl(getDb(), { action: 'set_live_mode', on: true, confirm: true });
    expect(ok.status).toBe(200);
    expect(getLiveMode()).toBe(true);
  });

  it('turning live mode OFF needs no confirm', async () => {
    const out = await applyAdminControl(getDb(), { action: 'set_live_mode', on: false });
    expect(out.status).toBe(200);
    expect(getLiveMode()).toBe(false);
  });

  it('rejects an unknown action + a non-object body', async () => {
    expect((await applyAdminControl(getDb(), { action: 'nope' })).status).toBe(400);
    expect((await applyAdminControl(getDb(), null)).status).toBe(400);
  });
});
