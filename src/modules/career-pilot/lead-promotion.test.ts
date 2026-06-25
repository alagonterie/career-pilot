import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { reactToStatusTransitions } from './interview-kit-trigger.js';
import { promoteLeadOnApplied } from './lead-promotion.js';

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
});
afterEach(() => {
  closeDb();
});

function seedApp(
  id: string,
  over: { company_name?: string; role_title?: string; job_url?: string | null; status?: string } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO applications
         (id, company_name, obfuscated_label, public_state, role_title, job_url, status, applied_at, last_activity_at, created_at)
       VALUES (@id, @company, @label, 'obfuscated', @role, @url, @status, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run({
      id,
      company: over.company_name ?? 'Acme',
      label: `ai-${id}`,
      role: over.role_title ?? 'Backend Engineer',
      url: over.job_url ?? null,
      status: over.status ?? 'APPLIED',
    });
}

let leadSeq = 0;
function seedLead(
  over: {
    id?: string;
    source_url?: string;
    apply_url?: string | null;
    company?: string;
    title?: string;
    rules_score?: number | null;
    status?: string;
    closed_at?: string | null;
    application_id?: string | null;
  } = {},
): string {
  const id = over.id ?? `lead-${leadSeq++}`;
  getDb()
    .prepare(
      `INSERT INTO job_leads
         (id, source, source_job_id, source_url, apply_url, content_fingerprint, title, company,
          first_seen_at, last_seen_at, status, status_changed_at, rules_score, closed_at, application_id)
       VALUES (@id, 'greenhouse', @sjid, @source_url, @apply_url, @fp, @title, @company,
          datetime('now'), datetime('now'), @status, datetime('now'), @rules_score, @closed_at, @application_id)`,
    )
    .run({
      id,
      sjid: `job-${id}`,
      source_url: over.source_url ?? `https://boards.example.com/${id}`,
      apply_url: over.apply_url ?? null,
      fp: `fp-${id}`,
      title: over.title ?? 'Backend Engineer',
      company: over.company ?? 'Acme',
      status: over.status ?? 'new',
      rules_score: over.rules_score ?? 50,
      closed_at: over.closed_at ?? null,
      application_id: over.application_id ?? null,
    });
  return id;
}

const leadOf = (id: string) =>
  getDb().prepare('SELECT status, application_id FROM job_leads WHERE id = ?').get(id) as {
    status: string;
    application_id: string | null;
  };

describe('promoteLeadOnApplied', () => {
  it('links + flips the lead to applied on an exact source_url match', () => {
    seedApp('app-1', { job_url: 'https://boards.example.com/eng-42' });
    seedLead({ id: 'lead-1', source_url: 'https://boards.example.com/eng-42' });

    const res = promoteLeadOnApplied(getDb(), { application_id: 'app-1', to: 'APPLIED' });
    expect(res).toEqual({ leadId: 'lead-1', via: 'url' });
    expect(leadOf('lead-1')).toEqual({ status: 'applied', application_id: 'app-1' });
  });

  it('matches the apply_url too, and normalizes a trailing slash', () => {
    seedApp('app-1', { job_url: 'https://jobs.example.com/apply/9' });
    seedLead({ id: 'lead-1', source_url: 'https://board/x', apply_url: 'https://jobs.example.com/apply/9/' });

    const res = promoteLeadOnApplied(getDb(), { application_id: 'app-1', to: 'APPLIED' });
    expect(res).toEqual({ leadId: 'lead-1', via: 'url' });
  });

  it('falls back to normalized company + title when the URL differs', () => {
    seedApp('app-1', {
      job_url: 'https://ats.acme.com/123',
      company_name: 'Acme, Inc.',
      role_title: 'Backend Engineer',
    });
    seedLead({
      id: 'lead-1',
      source_url: 'https://boards.example.com/abc',
      company: 'Acme',
      title: 'backend  engineer',
    });

    const res = promoteLeadOnApplied(getDb(), { application_id: 'app-1', to: 'APPLIED' });
    expect(res).toEqual({ leadId: 'lead-1', via: 'company_title' });
    expect(leadOf('lead-1').status).toBe('applied');
  });

  it('does nothing when no lead matches', () => {
    seedApp('app-1', { job_url: 'https://none', company_name: 'Zzz Corp', role_title: 'Nope' });
    seedLead({ id: 'lead-1', source_url: 'https://other', company: 'Acme', title: 'Backend Engineer' });

    expect(promoteLeadOnApplied(getDb(), { application_id: 'app-1', to: 'APPLIED' })).toBeNull();
    expect(leadOf('lead-1')).toEqual({ status: 'new', application_id: null });
  });

  it('is a no-op for a non-submitted transition (BOOKMARKED)', () => {
    seedApp('app-1', { job_url: 'https://boards.example.com/eng-42' });
    seedLead({ id: 'lead-1', source_url: 'https://boards.example.com/eng-42' });

    expect(promoteLeadOnApplied(getDb(), { application_id: 'app-1', to: 'BOOKMARKED' })).toBeNull();
    expect(leadOf('lead-1').application_id).toBeNull();
  });

  it('promotes once: a second transition for an already-linked app is a no-op', () => {
    seedApp('app-1', { job_url: 'https://boards.example.com/eng-42' });
    seedLead({
      id: 'lead-1',
      source_url: 'https://boards.example.com/eng-42',
      application_id: 'app-1',
      status: 'applied',
    });
    // a second open lead that would also match by URL must NOT get linked
    seedLead({ id: 'lead-2', source_url: 'https://boards.example.com/eng-42' });

    expect(promoteLeadOnApplied(getDb(), { application_id: 'app-1', to: 'SCREENING' })).toBeNull();
    expect(leadOf('lead-2').application_id).toBeNull();
  });

  it('tie-breaks multiple company+title matches by highest rules_score', () => {
    seedApp('app-1', { job_url: null, company_name: 'Acme', role_title: 'Backend Engineer' });
    seedLead({ id: 'lead-low', company: 'Acme', title: 'Backend Engineer', rules_score: 30, source_url: 'https://a' });
    seedLead({ id: 'lead-high', company: 'Acme', title: 'Backend Engineer', rules_score: 80, source_url: 'https://b' });

    const res = promoteLeadOnApplied(getDb(), { application_id: 'app-1', to: 'APPLIED' });
    expect(res).toEqual({ leadId: 'lead-high', via: 'company_title' });
    expect(leadOf('lead-low').application_id).toBeNull();
  });

  it('skips a closed lead even on an exact URL match', () => {
    seedApp('app-1', { job_url: 'https://boards.example.com/eng-42' });
    seedLead({ id: 'lead-1', source_url: 'https://boards.example.com/eng-42', closed_at: '2026-06-20T00:00:00Z' });

    expect(promoteLeadOnApplied(getDb(), { application_id: 'app-1', to: 'APPLIED' })).toBeNull();
  });

  it('also fires through reactToStatusTransitions (the wiring)', () => {
    seedApp('app-1', { job_url: 'https://boards.example.com/eng-42' });
    seedLead({ id: 'lead-1', source_url: 'https://boards.example.com/eng-42' });

    reactToStatusTransitions(getDb(), getDb(), [{ application_id: 'app-1', from: 'BOOKMARKED', to: 'APPLIED' }]);
    expect(leadOf('lead-1')).toEqual({ status: 'applied', application_id: 'app-1' });
  });
});
