/**
 * search_jobs / record_job_lead result shaping — the host's insert guard
 * (stash-time rejected counts, record-time recorded:false refusals) must reach
 * the subagent intact. Pure formatters; no host round-trip needed.
 */
import { describe, expect, it } from 'bun:test';

import { SearchJobsError } from '../career-pilot/serpapi-search.js';
import { formatRecordJobLeadResult, formatSearchJobsResult, searchUnavailable } from './scrape-jobs.js';

describe('formatSearchJobsResult', () => {
  it('passes the stash rejected counts through, by reason, in structured content and text', () => {
    const summaries = [{ source: 'google_jobs', source_job_id: 'gj-1', apply_link_kind: 'ats' }];
    const r = formatSearchJobsResult('backend engineer', {
      summaries,
      stashed: 1,
      skipped: 0,
      rejected: { link_kind: 7, tombstone: 1 },
      rejected_total: 8,
    });
    expect(r.structuredContent).toEqual({
      summaries,
      total: 1,
      provider: 'google_jobs',
      rejected: { link_kind: 7, tombstone: 1 },
      rejected_total: 8,
    });
    expect(r.content[0].text).toContain('rejected 8 before caching (link_kind 7, tombstone 1)');
  });

  it('explains zero keepers: every hit rejected still reads as a reachable search', () => {
    const r = formatSearchJobsResult('q', { summaries: [], stashed: 0, skipped: 0, rejected: { link_kind: 10 } });
    expect(r.structuredContent?.total).toBe(0);
    expect(r.structuredContent?.rejected_total).toBe(10);
    expect(r.content[0].text).toMatch(/rejected 10 before caching/);
  });

  it('tolerates a host that omits rejected (no note, zero total)', () => {
    const r = formatSearchJobsResult('q', { summaries: [{}], stashed: 1, skipped: 0 });
    expect(r.structuredContent?.rejected_total).toBe(0);
    expect(r.content[0].text).not.toContain('rejected');
  });
});

describe('formatRecordJobLeadResult', () => {
  it('renders a refusal as a non-error, final answer', () => {
    const r = formatRecordJobLeadResult('google_jobs', 'gj-1', {
      recorded: false,
      reason: 'tombstone',
      detail: 'removed earlier',
    });
    expect((r as { isError?: boolean }).isError).toBeUndefined();
    expect(r.content[0].text).toContain('not recorded');
    expect(r.content[0].text).toContain('do not retry');
    expect(r.structuredContent).toMatchObject({ recorded: false, reason: 'tombstone' });
  });

  it('renders a recorded lead as before', () => {
    const r = formatRecordJobLeadResult('google_jobs', 'gj-1', {
      recorded: true,
      id: 'lead-1',
      inserted_or_updated: 'inserted',
      rules_score: 72,
      content_fingerprint: 'abcdef0123456789',
    });
    expect(r.content[0].text).toBe('job_lead inserted: google_jobs::gj-1 (id lead-1, score 72)');
  });
});

describe('searchUnavailable (search quota refusal, §24.201 D8)', () => {
  it('maps a QUOTA refusal to the existing unavailable shape with the reason', () => {
    const r = searchUnavailable(
      new SearchJobsError('QUOTA', 'search quota for this period spent (250/250 pages since 2026-11-01)'),
    );
    expect(r.structuredContent).toEqual({
      unavailable: true,
      reason: 'QUOTA: search quota for this period spent (250/250 pages since 2026-11-01)',
    });
    expect(r.content[0].text).toContain('search_jobs unavailable (QUOTA: search quota for this period spent');
    expect(r.content[0].text).not.toMatch(/fall back/i);
  });
});