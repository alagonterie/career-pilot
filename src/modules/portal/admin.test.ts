/**
 * Tests for the owner-only /admin surface (STRATEGY §24.74 D5).
 *
 * `adminEnabled`: open on the dev stack, fail-closed otherwise (default config).
 * `buildAttributionReport`: aggregates clicks + unique visitors per link, the
 * by-artifact + top-country summary, and the recent-visit feed; empty on a bare
 * DB; nothing leaks beyond the two private tables.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureAtsWatchlistSeeded } from '../career-pilot/ats-watchlist.js';

import { getConfig } from '../../get-config.js';
import { getLiveMode, getPauseState } from './system-modes.js';

import {
  adminEnabled,
  applyAdminAttributionWrite,
  applyAdminControl,
  applyAdminKnobWrite,
  applyAdminLeadsWrite,
  applyAdminPersonaWrite,
  applyAdminSandboxRunDelete,
  buildAdminContacts,
  buildAdminKnobs,
  buildAdminLeads,
  buildAdminPersona,
  buildAdminPipeline,
  buildAdminSandboxRuns,
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

  it('carries expiresAt so the UI can mark a retired source (§24.177)', () => {
    seedLink('live_src', 'owner_source', null, null);
    applyAdminAttributionWrite(getDb(), { action: 'retire', slug: 'live_src' });
    const row = buildAttributionReport(getDb()).links.find((l) => l.code === 'live_src')!;
    expect(row.artifactType).toBe('owner_source');
    expect(row.expiresAt).not.toBeNull();
  });
});

describe('applyAdminAttributionWrite (§24.177 mint/retire)', () => {
  it('mints an owner source that shows up in the report (live, not expired)', () => {
    const out = applyAdminAttributionWrite(getDb(), { action: 'mint', slug: 'my_linkedin' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, code: 'my_linkedin' });
    const row = buildAttributionReport(getDb()).links.find((l) => l.code === 'my_linkedin')!;
    expect(row.artifactType).toBe('owner_source');
    expect(row.expiresAt).toBeNull();
  });

  it('retires a minted source (soft — the row stays)', () => {
    applyAdminAttributionWrite(getDb(), { action: 'mint', slug: 'gone_soon' });
    const out = applyAdminAttributionWrite(getDb(), { action: 'retire', slug: 'gone_soon' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(buildAttributionReport(getDb()).links.some((l) => l.code === 'gone_soon')).toBe(true);
  });

  it('400s on a bad action, an invalid slug, the reserved slug, and a collision', () => {
    expect(applyAdminAttributionWrite(getDb(), { action: 'nope', slug: 'x' }).status).toBe(400);
    expect(applyAdminAttributionWrite(getDb(), { action: 'mint', slug: 'Bad Slug' }).status).toBe(400);
    expect(
      (applyAdminAttributionWrite(getDb(), { action: 'mint', slug: 'master_resume_pdf' }).body as { error: string })
        .error,
    ).toBe('reserved_slug');
    applyAdminAttributionWrite(getDb(), { action: 'mint', slug: 'dupe' });
    expect(
      (applyAdminAttributionWrite(getDb(), { action: 'mint', slug: 'dupe' }).body as { error: string }).error,
    ).toBe('slug_taken');
  });
});

// ── §24.138: the control-center surface ───────────────────────────────────────

describe('buildAdminKnobs / applyAdminKnobWrite (registry − ADMIN_DENY)', () => {
  it('omits the denied recruiter-sim / dev knobs, keeps the operational levers', () => {
    const keys = buildAdminKnobs(getDb()).knobs.map((k) => k.key);
    expect(keys).not.toContain('recruiter_sim_enabled');
    expect(keys).not.toContain('recruiter_sim_prose_model');
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

describe('Sandbox runs (§24.164)', () => {
  function seedRun(id: string, company: string): void {
    getDb()
      .prepare(
        `INSERT INTO simulator_runs (id, ts, visitor_company, visitor_role, total_cost_cents, shareable, client_ip)
         VALUES (?, ?, ?, 'SWE', 5, 1, '203.0.113.9')`,
      )
      .run(id, new Date().toISOString(), company);
  }

  it('buildAdminSandboxRuns rolls up runs + stats (owner detail; no raw IP)', () => {
    seedRun('sb-1', 'Globex');
    const view = buildAdminSandboxRuns();
    expect(view.stats.total).toBe(1);
    expect(view.runs[0].visitor_company).toBe('Globex');
    expect(JSON.stringify(view.runs)).not.toContain('203.0.113.9'); // IP folded to a token
  });

  it('applyAdminSandboxRunDelete validates the id and reports the outcome', () => {
    seedRun('sb-del', 'Initech');
    expect(applyAdminSandboxRunDelete({}).status).toBe(400); // missing id
    expect(applyAdminSandboxRunDelete({ id: 123 }).status).toBe(400); // non-string
    expect(applyAdminSandboxRunDelete({ id: 'ghost' }).status).toBe(404); // unknown id
    expect(applyAdminSandboxRunDelete({ id: 'sb-del' }).status).toBe(200); // hit
    expect(buildAdminSandboxRuns().stats.total).toBe(0);
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

describe('buildAdminPersona / applyAdminPersonaWrite (§24.170)', () => {
  it('reads an empty profile: null fields, blockers present, onboarding preview', () => {
    const view = buildAdminPersona(getDb());
    expect(view.fields.full_name).toBeNull();
    expect(view.workProfile.source).toBeNull();
    expect(view.blockers.length).toBeGreaterThan(0);
    expect(typeof view.personaPreview).toBe('string');
    expect(view.readonlyFields).toContain('gmail_account');
  });

  it('writes + normalizes simple, array, number, and protected_terms fields', () => {
    expect(applyAdminPersonaWrite(getDb(), { field: 'full_name', value: 'Jane Doe' }).status).toBe(200);
    expect(applyAdminPersonaWrite(getDb(), { field: 'target_roles', value: 'Staff Eng, Infra Lead' }).status).toBe(200);
    expect(applyAdminPersonaWrite(getDb(), { field: 'comp_floor', value: '$185,000' }).status).toBe(200);
    expect(applyAdminPersonaWrite(getDb(), { field: 'protected_terms', value: ['Acme', 'Globex'] }).status).toBe(200);

    const view = buildAdminPersona(getDb());
    expect(view.fields.full_name).toBe('Jane Doe');
    expect(JSON.parse(view.fields.target_roles as string)).toEqual(['Staff Eng', 'Infra Lead']);
    expect(view.fields.comp_floor).toBe(185000);
    expect(JSON.parse(view.fields.protected_terms as string)).toEqual(['Acme', 'Globex']);
  });

  it('rejects an unknown field and the read-only gmail_account', () => {
    expect(applyAdminPersonaWrite(getDb(), { field: 'nope', value: 'x' }).status).toBe(400);
    expect(applyAdminPersonaWrite(getDb(), { field: 'gmail_account', value: 'a@b.com' }).status).toBe(400);
  });

  it('stores a valid work_profile as source=manual (never agent), validated', () => {
    const wp = { name: 'Jane Doe', title: 'Software Engineer', experience: [], education: [], links: {} };
    expect(applyAdminPersonaWrite(getDb(), { field: 'work_profile_json', value: wp }).status).toBe(200);
    const view = buildAdminPersona(getDb());
    expect(view.workProfile.source).toBe('manual');
    expect(view.workProfile.json).not.toBeNull();
  });

  it('rejects a nameless work_profile (the honesty-floor bar) and stores nothing', () => {
    expect(applyAdminPersonaWrite(getDb(), { field: 'work_profile_json', value: { experience: [] } }).status).toBe(400);
    expect(buildAdminPersona(getDb()).workProfile.json).toBeNull();
  });
});

describe('buildAdminLeads / applyAdminLeadsWrite (§24.173)', () => {
  type LeadOverrides = {
    id: string;
    source?: string;
    status?: string;
    rules_score?: number;
    rules_score_reasons?: string;
    title?: string;
    description_text?: string | null;
    first_seen_at?: string;
    last_seen_at?: string;
    source_posted_at?: string | null;
    llm_score?: number | null;
    killer_match_pushed_at?: string | null;
    closed_at?: string | null;
    closed_reason?: string | null;
    application_id?: string | null;
    apply_link_kind?: string | null;
    content_fingerprint?: string;
    company?: string;
  };
  function seedLead(over: LeadOverrides): void {
    const now = '2026-06-20T00:00:00.000Z';
    const d = {
      source: 'greenhouse',
      status: 'new',
      rules_score: 50,
      rules_score_reasons: '{"keyword_match":{"score":15}}',
      title: 'Senior Software Engineer',
      description_text: null as string | null,
      first_seen_at: now,
      last_seen_at: now,
      source_posted_at: now as string | null,
      llm_score: null as number | null,
      killer_match_pushed_at: null as string | null,
      closed_at: null as string | null,
      closed_reason: null as string | null,
      application_id: null as string | null,
      apply_link_kind: null as string | null,
      content_fingerprint: `fp-${over.id}`,
      company: 'Globex',
      ...over,
    };
    getDb()
      .prepare(
        `INSERT INTO job_leads
           (id, source, source_job_id, source_url, content_fingerprint, title, company,
            first_seen_at, last_seen_at, status, status_changed_at, rules_score, rules_score_reasons,
            description_text, source_posted_at, llm_score, killer_match_pushed_at, closed_at, closed_reason,
            application_id, apply_link_kind)
         VALUES
           (@id, @source, @id, 'https://x/' || @id, @content_fingerprint, @title, @company,
            @first_seen_at, @last_seen_at, @status, @first_seen_at, @rules_score, @rules_score_reasons,
            @description_text, @source_posted_at, @llm_score, @killer_match_pushed_at, @closed_at, @closed_reason,
            @application_id, @apply_link_kind)`,
      )
      .run(d);
  }

  it('is empty on a bare DB', () => {
    const v = buildAdminLeads(getDb());
    expect(v.leads).toHaveLength(0);
    expect(v.closed).toHaveLength(0);
    expect(v.rollup.activeTotal).toBe(0);
  });

  it('rolls up the pool + splits active vs closed, active sorted by rules_score', () => {
    seedLead({ id: 'a', rules_score: 30, status: 'new' });
    seedLead({ id: 'b', rules_score: 80, status: 'reviewed', llm_score: 71, source: 'lever' });
    seedLead({
      id: 'c',
      rules_score: 90,
      status: 'new',
      closed_at: '2026-06-21T00:00:00.000Z',
      closed_reason: 'stale',
    });

    const v = buildAdminLeads(getDb());
    expect(v.rollup.activeTotal).toBe(2);
    expect(v.rollup.closedTotal).toBe(1);
    expect(v.rollup.byStatus).toEqual({ new: 1, reviewed: 1 });
    expect(v.rollup.bySource).toEqual({ greenhouse: 1, lever: 1 });
    expect(v.rollup.llmScored).toBe(1);
    // active leads sorted rules_score DESC; the closed one is excluded.
    expect(v.leads.map((l) => l.id)).toEqual(['b', 'a']);
    expect(v.closed.map((l) => l.id)).toEqual(['c']);
    // rules_score_reasons is parsed to an object, not the raw JSON string.
    expect(typeof v.leads[0].rules_score_reasons).toBe('object');
  });

  it('set_status transitions a lead; archived soft-closes it', () => {
    seedLead({ id: 'a', status: 'new' });
    expect(applyAdminLeadsWrite(getDb(), { action: 'set_status', id: 'a', status: 'reviewed' }).status).toBe(200);
    expect(buildAdminLeads(getDb()).leads[0].status).toBe('reviewed');

    // archived → soft-close: leaves the active set, lands in closed with a reason.
    expect(
      applyAdminLeadsWrite(getDb(), { action: 'set_status', id: 'a', status: 'archived', reason: 'junk' }).status,
    ).toBe(200);
    const v = buildAdminLeads(getDb());
    expect(v.leads).toHaveLength(0);
    expect(v.closed[0]).toMatchObject({ id: 'a', status: 'archived', closed_reason: 'junk' });
  });

  it('refuses applied (agent-owned) + an unknown status + an unknown id', () => {
    seedLead({ id: 'a' });
    expect(applyAdminLeadsWrite(getDb(), { action: 'set_status', id: 'a', status: 'applied' }).status).toBe(400);
    expect(applyAdminLeadsWrite(getDb(), { action: 'set_status', id: 'a', status: 'nope' }).status).toBe(400);
    expect(applyAdminLeadsWrite(getDb(), { action: 'set_status', id: 'ghost', status: 'reviewed' }).status).toBe(404);
    expect(applyAdminLeadsWrite(getDb(), { action: 'bogus' }).status).toBe(400);
  });

  it('rescore recomputes the deterministic rules_score against the current profile', () => {
    getDb()
      .prepare(
        `INSERT INTO candidate_profile (id, target_roles, updated_at)
         VALUES (1, '["Software Engineer"]', '2026-06-06T00:00:00Z')`,
      )
      .run();
    // Seed with a deliberately-wrong stored score; the title hits the target role.
    seedLead({ id: 'a', rules_score: 0, rules_score_reasons: '{}', title: 'Senior Software Engineer' });

    const out = applyAdminLeadsWrite(getDb(), { action: 'rescore', id: 'a' });
    expect(out.status).toBe(200);
    const body = out.body as { rules_score: number; rules_score_reasons: Record<string, unknown> };
    expect(body.rules_score).toBeGreaterThan(0); // recomputed from the keyword match
    expect(body.rules_score_reasons).toHaveProperty('keyword_match');
    // persisted
    expect(buildAdminLeads(getDb()).leads[0].rules_score).toBe(body.rules_score);
  });

  it('rescore_all recomputes every ACTIVE lead (closed excluded)', () => {
    seedLead({ id: 'a', rules_score: 0 });
    seedLead({ id: 'b', rules_score: 0 });
    seedLead({ id: 'c', rules_score: 0, closed_at: '2026-06-21T00:00:00.000Z', closed_reason: 'stale' });
    const out = applyAdminLeadsWrite(getDb(), { action: 'rescore_all' });
    expect(out.status).toBe(200);
    expect((out.body as { rescored: number }).rescored).toBe(2);
  });

  // ── §24.187: batch cleanup ──────────────────────────────────────────────────

  it('bulk_set_status archives every id in the batch (soft-close, one reason)', () => {
    seedLead({ id: 'a' });
    seedLead({ id: 'b' });
    seedLead({ id: 'c' });

    const out = applyAdminLeadsWrite(getDb(), {
      action: 'bulk_set_status',
      ids: ['a', 'b'],
      status: 'archived',
      reason: 'stale pool',
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ updated: 2, missing: 0 });

    const v = buildAdminLeads(getDb());
    expect(v.leads.map((l) => l.id)).toEqual(['c']); // only the untouched one stays active
    expect(v.closed.map((l) => l.id).sort()).toEqual(['a', 'b']);
    expect(v.closed.every((l) => l.status === 'archived' && l.closed_reason === 'stale pool')).toBe(true);
  });

  it('bulk_set_status reports ids that no longer exist as `missing`', () => {
    seedLead({ id: 'a' });
    const out = applyAdminLeadsWrite(getDb(), { action: 'bulk_set_status', ids: ['a', 'ghost'], status: 'reviewed' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ updated: 1, missing: 1 });
  });

  it('bulk_set_status refuses a bad status and a bad ids payload', () => {
    seedLead({ id: 'a' });
    expect(applyAdminLeadsWrite(getDb(), { action: 'bulk_set_status', ids: ['a'], status: 'applied' }).status).toBe(
      400,
    );
    expect(applyAdminLeadsWrite(getDb(), { action: 'bulk_set_status', ids: [], status: 'reviewed' }).status).toBe(400);
    expect(applyAdminLeadsWrite(getDb(), { action: 'bulk_set_status', ids: 'a', status: 'reviewed' }).status).toBe(400);
    expect(
      applyAdminLeadsWrite(getDb(), {
        action: 'bulk_set_status',
        ids: Array.from({ length: 501 }, (_, i) => `x${i}`),
        status: 'reviewed',
      }).status,
    ).toBe(400);
  });

  it('bulk_delete hard-removes rows but only with confirm:true', () => {
    seedLead({ id: 'a' });
    seedLead({ id: 'b' });

    // no confirm → refused, nothing removed
    expect(applyAdminLeadsWrite(getDb(), { action: 'bulk_delete', ids: ['a', 'b'] }).status).toBe(400);
    expect(buildAdminLeads(getDb()).rollup.activeTotal).toBe(2);

    const out = applyAdminLeadsWrite(getDb(), { action: 'bulk_delete', ids: ['a', 'b'], confirm: true });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ deleted: 2, skipped: 0 });
    expect(buildAdminLeads(getDb()).rollup.activeTotal).toBe(0);
  });

  it('bulk_delete skips promoted leads (an application_id link must not be orphaned)', () => {
    getDb()
      .prepare(
        `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, applied_at, created_at)
         VALUES ('app-1', 'Globex', 'a fintech company', 'Senior Software Engineer', 'applied',
                 '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z')`,
      )
      .run();
    seedLead({ id: 'plain' });
    seedLead({ id: 'promoted', status: 'applied', application_id: 'app-1' });

    const out = applyAdminLeadsWrite(getDb(), {
      action: 'bulk_delete',
      ids: ['plain', 'promoted'],
      confirm: true,
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ deleted: 1, skipped: 1 });
    // the promoted lead survives the batch rather than failing it
    expect(buildAdminLeads(getDb()).leads.map((l) => l.id)).toEqual(['promoted']);
    expect(out.body).toMatchObject({ skipped_by_reason: { promoted: 1 } });
  });

  // ── §24.201 D2/D3 + §24.202 D4: tombstones + "not interested" ──────────────

  function tombstones(): Array<{ source_job_id: string; reason: string; match: string }> {
    return getDb()
      .prepare(`SELECT source_job_id, reason, match FROM job_lead_tombstones ORDER BY source_job_id`)
      .all() as Array<{ source_job_id: string; reason: string; match: string }>;
  }

  it('bulk_delete writes tombstones: id-only for a rejected-kind lead, fingerprint for a direct one', () => {
    seedLead({ id: 'agg', source: 'google_jobs', apply_link_kind: 'aggregator' });
    seedLead({ id: 'legacy', source: 'google_jobs', apply_link_kind: null }); // resolves to 'unknown'
    seedLead({ id: 'direct', source: 'google_jobs', apply_link_kind: 'company' });
    seedLead({ id: 'board', source: 'greenhouse' });

    const out = applyAdminLeadsWrite(getDb(), {
      action: 'bulk_delete',
      ids: ['agg', 'legacy', 'direct', 'board'],
      confirm: true,
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ deleted: 4, skipped: 0 });
    expect(tombstones()).toEqual([
      { source_job_id: 'agg', reason: 'link:aggregator', match: 'id' },
      { source_job_id: 'board', reason: 'deleted', match: 'fingerprint' },
      { source_job_id: 'direct', reason: 'deleted', match: 'fingerprint' },
      { source_job_id: 'legacy', reason: 'link:unknown', match: 'id' },
    ]);
  });

  it('bulk_delete of a search hit that IS a board posting also tombstones the board copy', () => {
    seedLead({ id: 'hit', source: 'google_jobs', apply_link_kind: 'ats' });
    seedLead({ id: 'agg', source: 'google_jobs', apply_link_kind: 'aggregator' });
    getDb()
      .prepare(`UPDATE job_leads SET apply_url = ?, source_url = ? WHERE id IN ('hit', 'agg')`)
      .run('https://job-boards.greenhouse.io/acme/jobs/4455667', 'https://job-boards.greenhouse.io/acme/jobs/4455667');

    const out = applyAdminLeadsWrite(getDb(), { action: 'bulk_delete', ids: ['hit', 'agg'], confirm: true });
    expect(out.body).toMatchObject({ deleted: 2 });
    const rows = getDb()
      .prepare(`SELECT source, source_job_id, reason, match FROM job_lead_tombstones ORDER BY source, source_job_id`)
      .all();
    expect(rows).toEqual([
      // a link-reason delete never reaches the board copy: the job was fine
      { source: 'google_jobs', source_job_id: 'agg', reason: 'link:aggregator', match: 'id' },
      { source: 'google_jobs', source_job_id: 'hit', reason: 'deleted', match: 'fingerprint' },
      // the board's own listing of the deleted job is refused by id
      { source: 'greenhouse', source_job_id: '4455667', reason: 'deleted', match: 'id' },
    ]);
  });

  it('bulk_delete skips-and-reports an email-linked lead instead of throwing (FKs on)', () => {
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1);
    seedLead({ id: 'plain' });
    seedLead({ id: 'linked' });
    getDb()
      .prepare(
        `INSERT INTO email_events (gmail_msg_id, thread_id, classification, confidence, linked_job_lead_id,
                                   classified_at, classified_by_run_id)
         VALUES ('m1', 't1', 'recruiter_outreach', 0.9, 'linked', '2026-06-20T00:00:00Z', 'run-1')`,
      )
      .run();

    const out = applyAdminLeadsWrite(getDb(), { action: 'bulk_delete', ids: ['plain', 'linked'], confirm: true });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, deleted: 1, skipped: 1, skipped_by_reason: { email_linked: 1 } });
    expect(buildAdminLeads(getDb()).leads.map((l) => l.id)).toEqual(['linked']);
    // no tombstone for the lead that was not deleted
    expect(tombstones().map((t) => t.source_job_id)).toEqual(['plain']);
  });

  it('not_interested archives the lead and writes a tombstone whose reach follows the reason', () => {
    for (const [id, reason, match] of [
      ['r1', 'role', 'fingerprint'],
      ['r2', 'company', 'fingerprint'],
      ['r3', 'other', 'fingerprint'],
      ['r4', 'location', 'id'],
      ['r5', 'level', 'id'],
    ] as const) {
      seedLead({ id });
      const out = applyAdminLeadsWrite(getDb(), { action: 'not_interested', id, reason });
      expect(out.status).toBe(200);
      // §24.202 D4: the response also says whether "block company" paused a board.
      expect(out.body).toEqual({
        ok: true,
        id,
        tombstone_match: match,
        title_blocklisted: false,
        title_blocklist: [],
        company_blocked: false,
      });
    }
    const closed = buildAdminLeads(getDb()).closed;
    expect(closed).toHaveLength(5);
    expect(closed.find((l) => l.id === 'r4')).toMatchObject({
      status: 'archived',
      closed_reason: 'not_interested:location',
    });
    expect(tombstones()).toEqual([
      { source_job_id: 'r1', reason: 'not_interested:role', match: 'fingerprint' },
      { source_job_id: 'r2', reason: 'not_interested:company', match: 'fingerprint' },
      { source_job_id: 'r3', reason: 'not_interested:other', match: 'fingerprint' },
      { source_job_id: 'r4', reason: 'not_interested:location', match: 'id' },
      { source_job_id: 'r5', reason: 'not_interested:level', match: 'id' },
    ]);
  });

  it('not_interested with exclude_title appends the title to the owner blocklist (deduped)', () => {
    seedLead({ id: 'a', title: 'Sales Engineer' });
    seedLead({ id: 'b', title: '  sales engineer ' });
    const out = applyAdminLeadsWrite(getDb(), {
      action: 'not_interested',
      id: 'a',
      reason: 'role',
      exclude_title: true,
    });
    expect(out.body).toMatchObject({ title_blocklisted: true });
    applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'b', reason: 'role', exclude_title: true });
    expect(getConfig<string[]>(getDb(), 'lead_title_blocklist')).toEqual(['Sales Engineer']);
  });

  it('not_interested refuses a bad reason, a missing id, and an unknown lead', () => {
    seedLead({ id: 'a' });
    expect(applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'a', reason: 'meh' }).status).toBe(400);
    expect(applyAdminLeadsWrite(getDb(), { action: 'not_interested', reason: 'role' }).status).toBe(400);
    expect(applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'ghost', reason: 'role' }).status).toBe(404);
    expect(tombstones()).toHaveLength(0);
  });

  it('not_interested 409s a promoted lead and changes nothing', () => {
    getDb()
      .prepare(
        `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, applied_at, created_at)
         VALUES ('app-1', 'Globex', 'a fintech company', 'Senior Software Engineer', 'APPLIED',
                 '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z')`,
      )
      .run();
    seedLead({ id: 'promoted', status: 'applied', application_id: 'app-1' });
    const out = applyAdminLeadsWrite(getDb(), {
      action: 'not_interested',
      id: 'promoted',
      reason: 'role',
      exclude_title: true,
    });
    expect(out).toEqual({ status: 409, body: { error: 'promoted', application_id: 'app-1' } });
    expect(buildAdminLeads(getDb()).leads[0]).toMatchObject({
      id: 'promoted',
      status: 'applied',
      closed_at: null,
      application_id: 'app-1',
    });
    expect(tombstones()).toHaveLength(0);
    expect(getConfig<string[]>(getDb(), 'lead_title_blocklist')).toEqual([]);
  });

  // §24.202 D8: the owner status controls never move a promoted lead.
  function seedPromoted(): void {
    getDb()
      .prepare(
        `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, applied_at, created_at)
         VALUES ('app-1', 'Globex', 'a fintech company', 'Senior Software Engineer', 'APPLIED',
                 '2026-06-20T00:00:00.000Z', '2026-06-20T00:00:00.000Z')`,
      )
      .run();
    seedLead({ id: 'promoted', status: 'applied', application_id: 'app-1' });
  }
  const leadState = (id: string) =>
    getDb().prepare('SELECT status, status_changed_at, closed_at, application_id FROM job_leads WHERE id = ?').get(id);

  it('set_status 409s a promoted lead and writes nothing', () => {
    seedPromoted();
    const before = leadState('promoted');
    for (const status of ['archived', 'new', 'reviewed', 'queued']) {
      const out = applyAdminLeadsWrite(getDb(), { action: 'set_status', id: 'promoted', status });
      expect(out).toEqual({ status: 409, body: { error: 'promoted', application_id: 'app-1' } });
    }
    expect(leadState('promoted')).toEqual(before);
  });

  it('bulk_set_status skips-and-reports a promoted lead, keeping every existing response field', () => {
    seedPromoted();
    seedLead({ id: 'plain' });
    const before = leadState('promoted');
    const out = applyAdminLeadsWrite(getDb(), {
      action: 'bulk_set_status',
      ids: ['plain', 'promoted', 'ghost'],
      status: 'archived',
    });
    expect(out).toEqual({
      status: 200,
      body: {
        ok: true,
        updated: 1,
        missing: 1,
        status: 'archived',
        skipped: 1,
        skipped_by_reason: { promoted: 1 },
      },
    });
    expect(leadState('promoted')).toEqual(before);
    expect(buildAdminLeads(getDb()).closed.map((l) => l.id)).toEqual(['plain']);
  });

  it('bulk_set_status reports skipped:0 and an empty reason map when nothing is promoted', () => {
    seedLead({ id: 'a' });
    const out = applyAdminLeadsWrite(getDb(), { action: 'bulk_set_status', ids: ['a'], status: 'reviewed' });
    expect(out.body).toMatchObject({ updated: 1, missing: 0, skipped: 0, skipped_by_reason: {} });
  });

  it('title_blocklist_remove takes a title back off the blocklist; the read lists it', () => {
    seedLead({ id: 'a', title: 'Sales Engineer' });
    applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'a', reason: 'role', exclude_title: true });
    expect(buildAdminLeads(getDb()).titleBlocklist).toEqual(['Sales Engineer']);

    const out = applyAdminLeadsWrite(getDb(), { action: 'title_blocklist_remove', title: '  SALES engineer ' });
    expect(out).toEqual({ status: 200, body: { ok: true, removed: true, title_blocklist: [] } });
    expect(getConfig<string[]>(getDb(), 'lead_title_blocklist')).toEqual([]);
    expect(buildAdminLeads(getDb()).titleBlocklist).toEqual([]);

    expect(applyAdminLeadsWrite(getDb(), { action: 'title_blocklist_remove', title: 'Sales Engineer' }).body).toEqual({
      ok: true,
      removed: false,
      title_blocklist: [],
    });
    expect(applyAdminLeadsWrite(getDb(), { action: 'title_blocklist_remove' }).status).toBe(400);
  });

  it('moving a not-interested lead out of archived clears its own not-interested tombstones only', () => {
    seedLead({ id: 'a' });
    seedLead({ id: 'b' });
    seedLead({ id: 'c' });
    applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'a', reason: 'role' });
    applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'b', reason: 'location' });
    applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'c', reason: 'role' });
    expect(tombstones().map((t) => t.source_job_id)).toEqual(['a', 'b', 'c']);

    // single set_status away from archived
    expect(applyAdminLeadsWrite(getDb(), { action: 'set_status', id: 'a', status: 'new' }).status).toBe(200);
    expect(tombstones().map((t) => t.source_job_id)).toEqual(['b', 'c']);
    // re-archiving through the select does not touch tombstones
    applyAdminLeadsWrite(getDb(), { action: 'set_status', id: 'b', status: 'archived' });
    expect(tombstones().map((t) => t.source_job_id)).toEqual(['b', 'c']);
    // bulk away from archived
    applyAdminLeadsWrite(getDb(), { action: 'bulk_set_status', ids: ['b'], status: 'reviewed' });
    expect(tombstones().map((t) => t.source_job_id)).toEqual(['c']);
  });

  it('the read payload carries the fields the Leads tab triages on', () => {
    seedLead({ id: 'a', source: 'google_jobs', apply_link_kind: 'ats' });
    const lead = buildAdminLeads(getDb()).leads[0];
    for (const k of [
      'apply_link_kind',
      'source',
      'source_posted_at',
      'first_seen_at',
      'application_id',
      'status',
      'closed_reason',
    ]) {
      expect(lead).toHaveProperty(k);
    }
    expect(lead.apply_link_kind).toBe('ats');
  });
});

describe('Leads sourcing: sweep_now, block_company and the sourcing read (§24.202 D4, D6)', () => {
  // These tests own the watchlist (an empty seed) and must never reach a real
  // board: any fetch fails the test.
  const emptySeed = path.join(os.tmpdir(), `nanoclaw-admin-empty-seed-${process.pid}.json`);
  beforeEach(async () => {
    fs.writeFileSync(emptySeed, '[]');
    ensureAtsWatchlistSeeded(getDb(), emptySeed);
    vi.stubGlobal('fetch', () => {
      throw new Error('network access in a unit test');
    });
    const { _awaitInFlightSweepForTesting } = await import('../career-pilot/ats-sweep.js');
    await _awaitInFlightSweepForTesting();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(emptySeed, { force: true });
  });
  function seedPlainLead(id: string, company: string): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO job_leads (id, source, source_job_id, source_url, content_fingerprint, title, company,
           first_seen_at, last_seen_at, status, status_changed_at, rules_score)
         VALUES (?, 'greenhouse', ?, 'https://x/' || ?, 'fp-' || ?, 'Senior Software Engineer', ?, ?, ?, 'new', ?, 50)`,
      )
      .run(id, id, id, id, company, now, now, now);
  }

  function seedBoard(token: string, company: string): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO ats_watchlist (ats, token, company, tier, origin, state, created_at, updated_at)
         VALUES ('greenhouse', ?, ?, 'B', 'owner', 'active', ?, ?)`,
      )
      .run(token, company, now, now);
  }

  it('the read carries `sourcing` in the admin contract shape', () => {
    const v = buildAdminLeads(getDb());
    expect(v.sourcing).toEqual({
      lastSweep: null,
      sweepRunning: false,
      lastSearch: null,
      searchQuota: {
        used_period: 0,
        monthly_quota: expect.any(Number),
        used_today: 0,
        daily_cap: expect.any(Number),
        period_start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });

    const t = '2026-11-16T10:00:00.000Z';
    getDb()
      .prepare(
        `INSERT INTO lead_source_runs (id, kind, trigger, started_at, finished_at, ok, boards_ok, boards_failed,
           new_count, refreshed_count, closed_count, reopened_count, rejected_json, failing_boards_json)
         VALUES ('run-1', 'sweep', 'manual', ?, ?, 1, 4, 1, 3, 10, 2, 1, '{"filter":5,"cap":1}',
           '[{"company":"Acme","ats":"lever","error":"HTTP 500"}]')`,
      )
      .run(t, t);
    getDb()
      .prepare(
        `INSERT INTO lead_source_runs (id, kind, trigger, started_at, finished_at, ok, rejected_json, rejected_by_site_json)
         VALUES ('s-1', 'search', 'agent', ?, ?, 1, '{"link_kind":4}', '{"RepostBoard":4}')`,
      )
      .run(t, t);
    const s = buildAdminLeads(getDb()).sourcing;
    expect(s.lastSweep).toEqual({
      id: 'run-1',
      started_at: t,
      finished_at: t,
      ok: true,
      trigger: 'manual',
      boards_ok: 4,
      boards_failed: 1,
      new: 3,
      refreshed: 10,
      closed: 2,
      reopened: 1,
      rejected: { filter: 5, cap: 1 },
      failing_boards: [{ company: 'Acme', ats: 'lever', error: 'HTTP 500' }],
    });
    expect(s.lastSearch).toEqual({ at: t, rejected: { link_kind: 4 }, rejected_by_site: { RepostBoard: 4 } });
  });

  it('sweep_now answers 202 and starts a sweep; a second call while it runs is 409 already_running', async () => {
    const { _awaitInFlightSweepForTesting } = await import('../career-pilot/ats-sweep.js');
    const first = applyAdminLeadsWrite(getDb(), { action: 'sweep_now' });
    expect(first).toEqual({ status: 202, body: { ok: true, started: true } });
    expect(buildAdminLeads(getDb()).sourcing.sweepRunning).toBe(true);
    expect(applyAdminLeadsWrite(getDb(), { action: 'sweep_now' })).toEqual({
      status: 409,
      body: { error: 'already_running' },
    });
    await _awaitInFlightSweepForTesting();
    expect(buildAdminLeads(getDb()).sourcing.lastSweep).toMatchObject({ trigger: 'manual' });
  });

  it('sweep_now is 409 halted under halted / killswitch', async () => {
    const { setPauseState } = await import('./system-modes.js');
    setPauseState('killswitch');
    expect(applyAdminLeadsWrite(getDb(), { action: 'sweep_now' })).toEqual({ status: 409, body: { error: 'halted' } });
  });

  it('not_interested with block_company pauses the company board (normalized match) and says so', () => {
    seedBoard('acme', 'Acme, Inc.');
    seedBoard('other', 'Globex');
    seedPlainLead('l1', 'ACME Inc');
    const out = applyAdminLeadsWrite(getDb(), {
      action: 'not_interested',
      id: 'l1',
      reason: 'company',
      block_company: true,
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, company_blocked: true });
    const states = getDb().prepare(`SELECT token, state FROM ats_watchlist ORDER BY token`).all();
    expect(states).toEqual([
      { token: 'acme', state: 'paused' },
      { token: 'other', state: 'active' },
    ]);
  });

  it('block_company is false when no watched board matches; nothing is paused without the flag', () => {
    seedBoard('acme', 'Acme');
    seedPlainLead('l1', 'Initech');
    seedPlainLead('l2', 'Acme');
    expect(
      applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'l1', reason: 'company', block_company: true })
        .body,
    ).toMatchObject({ company_blocked: false });
    expect(applyAdminLeadsWrite(getDb(), { action: 'not_interested', id: 'l2', reason: 'company' }).body).toMatchObject(
      {
        company_blocked: false,
      },
    );
    expect((getDb().prepare(`SELECT state FROM ats_watchlist`).get() as { state: string }).state).toBe('active');
  });
});
