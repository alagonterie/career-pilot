/**
 * Integration tests for the host-side job-lead action handlers (Phase 2.5
 * + Phase 3.1 §24.7 additions).
 *
 * Focus: `handleClaimKillerMatches` — the SELECT-for-claim transaction
 * that backs the container-side `query_killer_matches` MCP tool. Mirrors
 * `actions.integration.test.ts` harness.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { Session } from '../../types.js';

import { handleCheckTriggerEligibility, handleClaimKillerMatches, handleCloseStaleLeads } from './job-lead-actions.js';

const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-jla-test-${process.pid}`);
const inboundPath = path.join(tmpDir, 'inbound.db');

const FAKE_SESSION: Session = {
  id: 'test-session-1',
  agent_group_id: 'test-agent-group',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: '2026-05-27T00:00:00Z',
};

let inDb: Database.Database;

beforeAll(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureSchema(inboundPath, 'inbound');
});

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);

  if (inDb) inDb.close();
  inDb = openInboundDb(inboundPath);
  inDb.exec('DELETE FROM messages_in');
});

afterAll(() => {
  if (inDb) inDb.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface ResponseFrame<T = Record<string, unknown>> {
  type: string;
  requestId: string;
  frame: { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
}

function readResponse(requestId: string): ResponseFrame {
  const row = inDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(`cp-resp-${requestId}`) as
    | { content: string }
    | undefined;
  if (!row) throw new Error(`no response written for requestId=${requestId}`);
  return JSON.parse(row.content) as ResponseFrame;
}

function setPreference(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

interface LeadSeed {
  id: string;
  company: string;
  title?: string;
  source?: string;
  rules_score: number;
  source_posted_at: string | null;
  killer_match_pushed_at?: string | null;
  closed_at?: string | null;
}

function seedLead(opts: LeadSeed): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO job_leads (
        id, source, source_job_id, source_url,
        content_fingerprint, title, company,
        first_seen_at, last_seen_at,
        rules_score, rules_score_reasons,
        source_posted_at, killer_match_pushed_at, closed_at,
        status, status_changed_at
      ) VALUES (
        @id, @source, @source_job_id, @source_url,
        @fp, @title, @company,
        @now, @now,
        @rules_score, '{}',
        @source_posted_at, @killer_match_pushed_at, @closed_at,
        'new', @now
      )`,
    )
    .run({
      id: opts.id,
      source: opts.source ?? 'greenhouse',
      source_job_id: `sj-${opts.id}`,
      source_url: `https://example.com/${opts.id}`,
      fp: `fp-${opts.id}`,
      title: opts.title ?? `Role at ${opts.company}`,
      company: opts.company,
      now,
      rules_score: opts.rules_score,
      source_posted_at: opts.source_posted_at,
      killer_match_pushed_at: opts.killer_match_pushed_at ?? null,
      closed_at: opts.closed_at ?? null,
    });
}

function freshTimestamp(hoursAgo = 1): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

async function callClaim(): Promise<ResponseFrame<{ leads: Array<{ id: string }>; total: number; reason?: string }>> {
  const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;
  await handleClaimKillerMatches(
    { action: 'career_pilot.claim_killer_matches', requestId, payload: {} },
    FAKE_SESSION,
    inDb,
  );
  return readResponse(requestId) as ResponseFrame<{ leads: Array<{ id: string }>; total: number; reason?: string }>;
}

describe('handleClaimKillerMatches', () => {
  it('claims eligible leads and ignores ineligible ones', async () => {
    seedLead({
      id: 'eligible-high',
      company: 'Anthropic',
      source: 'greenhouse',
      rules_score: 95,
      source_posted_at: freshTimestamp(1),
    });
    seedLead({
      id: 'eligible-lever',
      company: 'Stripe',
      source: 'lever',
      rules_score: 92,
      source_posted_at: freshTimestamp(2),
    });
    seedLead({
      id: 'low-score',
      company: 'Linear',
      source: 'greenhouse',
      rules_score: 80,
      source_posted_at: freshTimestamp(1),
    });
    seedLead({
      id: 'too-old',
      company: 'Discord',
      source: 'greenhouse',
      rules_score: 96,
      source_posted_at: freshTimestamp(10),
    });
    seedLead({
      id: 'null-posted-at',
      company: 'Vercel',
      source: 'greenhouse',
      rules_score: 95,
      source_posted_at: null,
    });
    seedLead({
      id: 'wrong-source',
      company: 'Notion',
      source: 'ashby',
      rules_score: 95,
      source_posted_at: freshTimestamp(1),
    });
    seedLead({
      id: 'already-pushed',
      company: 'Cloudflare',
      source: 'greenhouse',
      rules_score: 99,
      source_posted_at: freshTimestamp(1),
      killer_match_pushed_at: freshTimestamp(5),
    });
    seedLead({
      id: 'closed',
      company: 'Square',
      source: 'greenhouse',
      rules_score: 99,
      source_posted_at: freshTimestamp(1),
      closed_at: freshTimestamp(5),
    });

    const res = await callClaim();
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    const ids = res.frame.data.leads.map((l) => l.id).sort();
    expect(ids).toEqual(['eligible-high', 'eligible-lever']);
    expect(res.frame.data.total).toBe(2);

    // Verify killer_match_pushed_at was populated on claimed leads only.
    const pushed = getDb()
      .prepare('SELECT id FROM job_leads WHERE killer_match_pushed_at IS NOT NULL ORDER BY id')
      .all() as Array<{ id: string }>;
    const pushedIds = pushed.map((r) => r.id).sort();
    expect(pushedIds).toEqual(['already-pushed', 'eligible-high', 'eligible-lever']);
  });

  it('second call returns empty (dedup via killer_match_pushed_at)', async () => {
    seedLead({ id: 'A', company: 'A', rules_score: 95, source_posted_at: freshTimestamp(1) });
    seedLead({ id: 'B', company: 'B', rules_score: 92, source_posted_at: freshTimestamp(2) });

    const first = await callClaim();
    if (!first.frame.ok) throw new Error('unreachable');
    expect(first.frame.data.leads).toHaveLength(2);

    const second = await callClaim();
    if (!second.frame.ok) throw new Error('unreachable');
    expect(second.frame.data.leads).toHaveLength(0);
    expect(second.frame.data.total).toBe(0);
  });

  it('empty allow-list short-circuits without scanning', async () => {
    setPreference('killer_match_source_allow_list', '[]');
    seedLead({ id: 'A', company: 'A', rules_score: 95, source_posted_at: freshTimestamp(1) });

    const res = await callClaim();
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.leads).toHaveLength(0);
    expect(res.frame.data.reason).toMatch(/source_allow_list.*empty/i);

    const stillUnclaimed = getDb().prepare('SELECT killer_match_pushed_at FROM job_leads WHERE id = ?').get('A') as {
      killer_match_pushed_at: string | null;
    };
    expect(stillUnclaimed.killer_match_pushed_at).toBeNull();
  });

  it('narrower allow-list excludes leads from other sources', async () => {
    setPreference('killer_match_source_allow_list', '["greenhouse"]');
    seedLead({ id: 'gh', company: 'A', source: 'greenhouse', rules_score: 95, source_posted_at: freshTimestamp(1) });
    seedLead({ id: 'lv', company: 'B', source: 'lever', rules_score: 95, source_posted_at: freshTimestamp(1) });

    const res = await callClaim();
    if (!res.frame.ok) throw new Error('unreachable');
    const ids = res.frame.data.leads.map((l) => l.id);
    expect(ids).toEqual(['gh']);
  });

  it('respects custom min_rules_score', async () => {
    setPreference('killer_match_min_rules_score', '95');
    seedLead({ id: 'low', company: 'A', rules_score: 92, source_posted_at: freshTimestamp(1) });
    seedLead({ id: 'high', company: 'B', rules_score: 96, source_posted_at: freshTimestamp(1) });

    const res = await callClaim();
    if (!res.frame.ok) throw new Error('unreachable');
    const ids = res.frame.data.leads.map((l) => l.id);
    expect(ids).toEqual(['high']);
  });

  it('respects custom recency_window_hours', async () => {
    setPreference('killer_match_recency_window_hours', '2');
    seedLead({ id: 'recent', company: 'A', rules_score: 95, source_posted_at: freshTimestamp(1) });
    seedLead({ id: 'too-old', company: 'B', rules_score: 95, source_posted_at: freshTimestamp(5) });

    const res = await callClaim();
    if (!res.frame.ok) throw new Error('unreachable');
    const ids = res.frame.data.leads.map((l) => l.id);
    expect(ids).toEqual(['recent']);
  });

  it('respects max_per_fire and orders by rules_score then first_seen_at', async () => {
    setPreference('killer_match_max_per_fire', '2');
    seedLead({ id: 'top', company: 'A', rules_score: 99, source_posted_at: freshTimestamp(1) });
    seedLead({ id: 'mid', company: 'B', rules_score: 95, source_posted_at: freshTimestamp(1) });
    seedLead({ id: 'low-eligible', company: 'C', rules_score: 91, source_posted_at: freshTimestamp(1) });

    const res = await callClaim();
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.leads.map((l) => l.id)).toEqual(['top', 'mid']);

    // The third eligible lead remains unclaimed and is available on the next tick.
    const stillUnclaimed = getDb()
      .prepare('SELECT id FROM job_leads WHERE killer_match_pushed_at IS NULL ORDER BY id')
      .all() as Array<{ id: string }>;
    expect(stillUnclaimed.map((r) => r.id)).toEqual(['low-eligible']);
  });

  it('suppresses leads with any prior email_events linkage (§24.9 funnel-curator integration)', async () => {
    seedLead({
      id: 'engaged',
      company: 'Acme',
      source: 'greenhouse',
      rules_score: 95,
      source_posted_at: freshTimestamp(1),
    });
    seedLead({ id: 'fresh', company: 'Stripe', source: 'lever', rules_score: 92, source_posted_at: freshTimestamp(1) });

    // Funnel-curator has linked an inbox event to the Acme lead — the
    // candidate has already engaged with that thread, so killer-match
    // should not re-push it even though it otherwise qualifies.
    getDb()
      .prepare(
        `INSERT INTO email_events (
           gmail_msg_id, thread_id, classification, confidence,
           linked_job_lead_id, linked_application_id,
           from_addr, subject, received_at, evidence_excerpt,
           classified_at, classified_by_run_id
         ) VALUES (
           'msg-acme', 'thread-acme', 'application_confirmation', 0.95,
           'engaged', NULL,
           'noreply@greenhouse.example', 'Thanks for applying', @now, 'Thanks for applying.',
           @now, 'fcr-test'
         )`,
      )
      .run({ now: new Date().toISOString() });

    const res = await callClaim();
    if (!res.frame.ok) throw new Error('unreachable');
    const ids = res.frame.data.leads.map((l) => l.id);
    expect(ids).toEqual(['fresh']);
  });

  it('returns leads with hydrated rules_score_reasons (JSON object)', async () => {
    getDb()
      .prepare(
        `INSERT INTO job_leads (
          id, source, source_job_id, source_url,
          content_fingerprint, title, company,
          first_seen_at, last_seen_at,
          rules_score, rules_score_reasons,
          source_posted_at,
          status, status_changed_at
        ) VALUES (
          'L1', 'greenhouse', 'sj-L1', 'https://example.com/L1',
          'fp-L1', 'Engineer', 'Anthropic',
          @now, @now,
          95, @reasons,
          @posted,
          'new', @now
        )`,
      )
      .run({
        now: new Date().toISOString(),
        reasons: JSON.stringify({ keyword_match: { score: 30 }, recency: { score: 15 } }),
        posted: freshTimestamp(1),
      });

    const res = await callClaim();
    if (!res.frame.ok) throw new Error('unreachable');
    const lead = res.frame.data.leads[0] as unknown as { rules_score_reasons: unknown };
    expect(typeof lead.rules_score_reasons).toBe('object');
    expect(lead.rules_score_reasons).toMatchObject({ keyword_match: { score: 30 } });
  });
});

// ── handleCloseStaleLeads (§24.8) ─────────────────────────────────────────

async function callCloseStaleLeads(): Promise<
  ResponseFrame<{ closed_count: number; threshold_days: number; cutoff: string }>
> {
  const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;
  await handleCloseStaleLeads({ action: 'career_pilot.close_stale_leads', requestId, payload: {} }, FAKE_SESSION, inDb);
  return readResponse(requestId) as ResponseFrame<{ closed_count: number; threshold_days: number; cutoff: string }>;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function seedJobLeadForClose(opts: {
  id: string;
  last_seen_at: string;
  closed_at?: string | null;
  application_id?: string | null;
  company?: string;
}): void {
  const now = new Date().toISOString();
  // Insert the application FIRST so the FK on job_leads.application_id resolves.
  if (opts.application_id) {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO applications (id, company_name, obfuscated_label, role_title, status, created_at)
         VALUES (?, ?, 'fc-test', 'Engineer', 'applied', ?)`,
      )
      .run(opts.application_id, opts.company ?? 'Acme', now);
  }
  getDb()
    .prepare(
      `INSERT INTO job_leads (
        id, source, source_job_id, source_url,
        content_fingerprint, title, company,
        first_seen_at, last_seen_at,
        rules_score, rules_score_reasons,
        status, status_changed_at,
        application_id, closed_at
      ) VALUES (
        @id, 'greenhouse', @sjid, @url,
        @fp, @title, @company,
        @first_seen, @last_seen,
        50, '{}',
        'new', @first_seen,
        @application_id, @closed_at
      )`,
    )
    .run({
      id: opts.id,
      sjid: `sj-${opts.id}`,
      url: `https://example.com/${opts.id}`,
      fp: `fp-${opts.id}`,
      title: 'Engineer',
      company: opts.company ?? 'Acme',
      first_seen: opts.last_seen_at,
      last_seen: opts.last_seen_at,
      application_id: opts.application_id ?? null,
      closed_at: opts.closed_at ?? null,
    });
}

describe('handleCloseStaleLeads', () => {
  it('closes leads with last_seen_at older than default threshold (14d)', async () => {
    seedJobLeadForClose({ id: 'stale-1', last_seen_at: daysAgoIso(20) });
    seedJobLeadForClose({ id: 'stale-2', last_seen_at: daysAgoIso(15) });
    seedJobLeadForClose({ id: 'fresh-1', last_seen_at: daysAgoIso(5) });
    seedJobLeadForClose({ id: 'fresh-2', last_seen_at: daysAgoIso(13) });

    const res = await callCloseStaleLeads();
    expect(res.frame.ok).toBe(true);
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.closed_count).toBe(2);
    expect(res.frame.data.threshold_days).toBe(14);

    const closed = getDb()
      .prepare('SELECT id, closed_reason FROM job_leads WHERE closed_at IS NOT NULL ORDER BY id')
      .all() as Array<{ id: string; closed_reason: string }>;
    expect(closed.map((r) => r.id)).toEqual(['stale-1', 'stale-2']);
    expect(closed.every((r) => r.closed_reason === 'stale')).toBe(true);
  });

  it('leaves fresh leads untouched', async () => {
    seedJobLeadForClose({ id: 'fresh', last_seen_at: daysAgoIso(3) });
    await callCloseStaleLeads();
    const row = getDb().prepare("SELECT closed_at, closed_reason FROM job_leads WHERE id = 'fresh'").get() as {
      closed_at: string | null;
      closed_reason: string | null;
    };
    expect(row.closed_at).toBeNull();
    expect(row.closed_reason).toBeNull();
  });

  it('does NOT close leads with application_id set (promoted)', async () => {
    seedJobLeadForClose({
      id: 'promoted',
      last_seen_at: daysAgoIso(30),
      application_id: 'app-promoted',
    });
    const res = await callCloseStaleLeads();
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.closed_count).toBe(0);
    const row = getDb().prepare("SELECT closed_at FROM job_leads WHERE id = 'promoted'").get() as {
      closed_at: string | null;
    };
    expect(row.closed_at).toBeNull();
  });

  it('does NOT touch already-closed leads', async () => {
    seedJobLeadForClose({
      id: 'already-closed',
      last_seen_at: daysAgoIso(30),
      closed_at: daysAgoIso(5),
    });
    const before = getDb().prepare("SELECT closed_at FROM job_leads WHERE id = 'already-closed'").get() as {
      closed_at: string;
    };
    await callCloseStaleLeads();
    const after = getDb()
      .prepare("SELECT closed_at, closed_reason FROM job_leads WHERE id = 'already-closed'")
      .get() as { closed_at: string; closed_reason: string | null };
    expect(after.closed_at).toBe(before.closed_at);
    expect(after.closed_reason).toBeNull();
  });

  it('respects custom close_detection_threshold_days preference', async () => {
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES ('close_detection_threshold_days', '7', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(new Date().toISOString());

    seedJobLeadForClose({ id: 'borderline', last_seen_at: daysAgoIso(10) });
    seedJobLeadForClose({ id: 'fresh', last_seen_at: daysAgoIso(5) });
    const res = await callCloseStaleLeads();
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.threshold_days).toBe(7);
    expect(res.frame.data.closed_count).toBe(1);

    const row = getDb().prepare('SELECT id FROM job_leads WHERE closed_at IS NOT NULL').get() as { id: string };
    expect(row.id).toBe('borderline');
  });

  it('returns closed_count=0 when no leads exist or none are stale', async () => {
    const res = await callCloseStaleLeads();
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data.closed_count).toBe(0);
    expect(res.frame.data.threshold_days).toBe(14);
  });
});

// ── handleCheckTriggerEligibility (§24.49c) ────────────────────────────────

async function callEligibility(
  trigger: unknown,
): Promise<ResponseFrame<{ trigger: string; eligible: boolean; count: number; reason?: string }>> {
  const requestId = `req-${Math.random().toString(36).slice(2, 10)}`;
  await handleCheckTriggerEligibility(
    { action: 'career_pilot.check_trigger_eligibility', requestId, payload: { trigger } },
    FAKE_SESSION,
    inDb,
  );
  return readResponse(requestId) as ResponseFrame<{
    trigger: string;
    eligible: boolean;
    count: number;
    reason?: string;
  }>;
}

describe('handleCheckTriggerEligibility', () => {
  it('killer-match: eligible=true with a count when an eligible lead exists', async () => {
    seedLead({ id: 'km-eligible', company: 'Anthropic', rules_score: 95, source_posted_at: freshTimestamp(1) });
    seedLead({ id: 'km-lowscore', company: 'Linear', rules_score: 80, source_posted_at: freshTimestamp(1) });
    const res = await callEligibility('killer-match');
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data).toMatchObject({ trigger: 'killer-match', eligible: true });
    expect(res.frame.data.count).toBe(1);
  });

  it('killer-match: eligible=false when only ineligible leads exist', async () => {
    seedLead({ id: 'km-old', company: 'Discord', rules_score: 96, source_posted_at: freshTimestamp(10) });
    seedLead({ id: 'km-low', company: 'Linear', rules_score: 80, source_posted_at: freshTimestamp(1) });
    const res = await callEligibility('killer-match');
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data).toMatchObject({ trigger: 'killer-match', eligible: false, count: 0 });
  });

  it('killer-match: the gate is READ-ONLY — does not claim (killer_match_pushed_at stays NULL)', async () => {
    seedLead({ id: 'km-eligible', company: 'Anthropic', rules_score: 95, source_posted_at: freshTimestamp(1) });
    await callEligibility('killer-match');
    const row = getDb().prepare('SELECT killer_match_pushed_at FROM job_leads WHERE id = ?').get('km-eligible') as {
      killer_match_pushed_at: string | null;
    };
    expect(row.killer_match_pushed_at).toBeNull();
  });

  it('killer-match: eligible=false with a reason when source_allow_list is empty', async () => {
    setPreference('killer_match_source_allow_list', '[]');
    seedLead({ id: 'km-eligible', company: 'Anthropic', rules_score: 95, source_posted_at: freshTimestamp(1) });
    const res = await callEligibility('killer-match');
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data).toMatchObject({ eligible: false, count: 0 });
    expect(res.frame.data.reason).toMatch(/allow_list/);
  });

  it('close-detection: eligible=true with a count when stale leads exist', async () => {
    seedJobLeadForClose({ id: 'stale-1', last_seen_at: daysAgoIso(20) });
    seedJobLeadForClose({ id: 'fresh-1', last_seen_at: daysAgoIso(5) });
    const res = await callEligibility('close-detection');
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data).toMatchObject({ trigger: 'close-detection', eligible: true });
    expect(res.frame.data.count).toBe(1);
  });

  it('close-detection: eligible=false when nothing is stale', async () => {
    seedJobLeadForClose({ id: 'fresh-1', last_seen_at: daysAgoIso(5) });
    const res = await callEligibility('close-detection');
    if (!res.frame.ok) throw new Error('unreachable');
    expect(res.frame.data).toMatchObject({ trigger: 'close-detection', eligible: false, count: 0 });
  });

  it('close-detection: the gate is READ-ONLY — does not close (closed_at stays NULL)', async () => {
    seedJobLeadForClose({ id: 'stale-1', last_seen_at: daysAgoIso(20) });
    await callEligibility('close-detection');
    const row = getDb().prepare('SELECT closed_at FROM job_leads WHERE id = ?').get('stale-1') as {
      closed_at: string | null;
    };
    expect(row.closed_at).toBeNull();
  });

  it('rejects an unknown trigger with BAD_ARGS', async () => {
    const res = await callEligibility('daily-briefing');
    expect(res.frame.ok).toBe(false);
    if (res.frame.ok) throw new Error('unreachable');
    expect(res.frame.error.code).toBe('BAD_ARGS');
  });
});
