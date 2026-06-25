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
      ...over,
    };
    getDb()
      .prepare(
        `INSERT INTO job_leads
           (id, source, source_job_id, source_url, content_fingerprint, title, company,
            first_seen_at, last_seen_at, status, status_changed_at, rules_score, rules_score_reasons,
            description_text, source_posted_at, llm_score, killer_match_pushed_at, closed_at, closed_reason)
         VALUES
           (@id, @source, @id, 'https://x/' || @id, 'fp-' || @id, @title, 'Globex',
            @first_seen_at, @last_seen_at, @status, @first_seen_at, @rules_score, @rules_score_reasons,
            @description_text, @source_posted_at, @llm_score, @killer_match_pushed_at, @closed_at, @closed_reason)`,
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
});
