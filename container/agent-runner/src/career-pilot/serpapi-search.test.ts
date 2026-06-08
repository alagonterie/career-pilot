/**
 * Unit tests for the pure + fetch parts of serpapi-search.ts (§24.50).
 *
 * Field shapes mirror a live `google_jobs` response (probed 2026-06-08).
 * The end-to-end OneCLI-gated fetch is exercised by --flow=scrape-jobs; here
 * we mock `globalThis.fetch` so no network / key is needed.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  normalizeGoogleJob,
  parseRelativePostedAt,
  parseSalaryString,
  searchGoogleJobs,
  SearchJobsError,
  type SerpApiJob,
} from './serpapi-search.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');
const DAY = 86_400_000;

describe('parseRelativePostedAt', () => {
  it('converts "N days ago" to an absolute ISO timestamp', () => {
    const r = parseRelativePostedAt('6 days ago', NOW);
    expect(r).toBe(new Date(NOW.getTime() - 6 * DAY).toISOString());
  });

  it('handles hours, weeks, and months', () => {
    expect(parseRelativePostedAt('2 hours ago', NOW)).toBe(new Date(NOW.getTime() - 2 * 3_600_000).toISOString());
    expect(parseRelativePostedAt('3 weeks ago', NOW)).toBe(new Date(NOW.getTime() - 3 * 7 * DAY).toISOString());
    expect(parseRelativePostedAt('1 month ago', NOW)).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
  });

  it('treats "30+ days ago" as 30 days (the floor)', () => {
    expect(parseRelativePostedAt('30+ days ago', NOW)).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
  });

  it('handles today / yesterday', () => {
    expect(parseRelativePostedAt('today', NOW)).toBe(NOW.toISOString());
    expect(parseRelativePostedAt('Just posted', NOW)).toBe(NOW.toISOString());
    expect(parseRelativePostedAt('yesterday', NOW)).toBe(new Date(NOW.getTime() - DAY).toISOString());
  });

  it('returns null for absent / unparseable input', () => {
    expect(parseRelativePostedAt(undefined, NOW)).toBeNull();
    expect(parseRelativePostedAt(null, NOW)).toBeNull();
    expect(parseRelativePostedAt('', NOW)).toBeNull();
    expect(parseRelativePostedAt('sometime', NOW)).toBeNull();
  });
});

describe('parseSalaryString', () => {
  it('parses an en-dash K range with "a year"', () => {
    // en-dash separator (U+2013), as Google returns it
    expect(parseSalaryString('180K–240K a year')).toEqual({
      comp_min_usd: 180_000,
      comp_max_usd: 240_000,
      comp_period: 'year',
    });
  });

  it('parses a hyphen range with $ and "a year"', () => {
    expect(parseSalaryString('$160K - $180K a year')).toEqual({
      comp_min_usd: 160_000,
      comp_max_usd: 180_000,
      comp_period: 'year',
    });
  });

  it('parses an hourly rate', () => {
    expect(parseSalaryString('$50.00 an hour')).toEqual({
      comp_min_usd: 50,
      comp_max_usd: 50,
      comp_period: 'hour',
    });
  });

  it('parses a single comma-formatted annual figure', () => {
    expect(parseSalaryString('$200,000 a year')).toEqual({
      comp_min_usd: 200_000,
      comp_max_usd: 200_000,
      comp_period: 'year',
    });
  });

  it('expands an M suffix', () => {
    expect(parseSalaryString('1M a year').comp_min_usd).toBe(1_000_000);
  });

  it('returns nulls when there is no salary', () => {
    expect(parseSalaryString('')).toEqual({ comp_min_usd: null, comp_max_usd: null, comp_period: null });
    expect(parseSalaryString(undefined)).toEqual({ comp_min_usd: null, comp_max_usd: null, comp_period: null });
  });
});

const REMOTE_JOB: SerpApiJob = {
  title: 'Senior Backend Engineer, AI Team',
  company_name: 'Acorns',
  location: 'Anywhere',
  via: 'Jobs',
  share_link: 'https://www.google.com/search?ibp=htl;jobs&q=...',
  source_link: 'https://jobs.ashbyhq.com/acorns/cf23e51e',
  description: 'Harness AI to build a customer-support virtual agent. Python, LLMs, RAG, AWS.',
  extensions: ['Work from home', 'Full-time'],
  detected_extensions: { work_from_home: true, schedule_type: 'Full-time', posted_at: '5 days ago' },
  apply_options: [
    { title: 'Jobs', link: 'https://jobs.ashbyhq.com/acorns/cf23e51e?utm_source=google_jobs_apply' },
    { title: 'Glassdoor', link: 'https://www.glassdoor.com/job-listing/...' },
  ],
  job_id: 'eyJqb2JfdGl0bGUiOiJTZW5pb3Ig',
};

describe('normalizeGoogleJob', () => {
  it('maps the verified google_jobs shape onto a JobLeadPayload', () => {
    const p = normalizeGoogleJob(REMOTE_JOB, NOW);
    expect(p).not.toBeNull();
    expect(p!.source).toBe('google_jobs');
    expect(p!.source_job_id).toBe('eyJqb2JfdGl0bGUiOiJTZW5pb3Ig');
    expect(p!.source_url).toBe('https://jobs.ashbyhq.com/acorns/cf23e51e'); // prefers source_link
    expect(p!.apply_url).toBe('https://jobs.ashbyhq.com/acorns/cf23e51e?utm_source=google_jobs_apply');
    expect(p!.company).toBe('Acorns');
    expect(p!.is_remote).toBe(true);
    expect(p!.workplace_type).toBe('remote');
    expect(p!.remote_region).toBe('GLOBAL'); // "Anywhere"
    expect(p!.employment_type).toBe('full-time');
    expect(p!.source_posted_at).toBe(new Date(NOW.getTime() - 5 * DAY).toISOString());
    expect(p!.source_board_token).toBeNull();
    expect(p!.description_html).toBeNull();
    expect(p!.raw_payload.via).toBe('Jobs');
  });

  it('parses salary into comp fields when present', () => {
    const withSalary: SerpApiJob = {
      ...REMOTE_JOB,
      location: 'United States',
      detected_extensions: { ...REMOTE_JOB.detected_extensions, salary: '180K–240K a year', work_from_home: true },
    };
    const p = normalizeGoogleJob(withSalary, NOW)!;
    expect(p.comp_min_usd).toBe(180_000);
    expect(p.comp_max_usd).toBe(240_000);
    expect(p.comp_period).toBe('year');
    expect(p.comp_currency).toBe('USD');
    expect(p.remote_region).toBe('US'); // remote + "United States"
  });

  it('leaves comp null and posted_at null when the source omits them', () => {
    const sparse: SerpApiJob = {
      title: 'Platform Engineer',
      company_name: 'Stripe',
      location: 'New York, NY',
      source_link: 'https://stripe.com/jobs/123',
      detected_extensions: { schedule_type: 'Full-time' }, // no salary, no posted_at, no work_from_home
      job_id: 'abc',
    };
    const p = normalizeGoogleJob(sparse, NOW)!;
    expect(p.comp_min_usd).toBeNull();
    expect(p.comp_period).toBeNull();
    expect(p.source_posted_at).toBeNull();
    expect(p.is_remote).toBeNull(); // never guessed
    expect(p.workplace_type).toBeNull();
  });

  it('returns null when job_id or title is missing (can\'t dedup/judge)', () => {
    expect(normalizeGoogleJob({ ...REMOTE_JOB, job_id: undefined }, NOW)).toBeNull();
    expect(normalizeGoogleJob({ ...REMOTE_JOB, title: undefined }, NOW)).toBeNull();
  });
});

// ── fetch (mocked) ───────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => Response): void {
  globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof fetch;
}

describe('searchGoogleJobs', () => {
  it('normalizes a 200 result and dedups by job_id within a run', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            jobs_results: [REMOTE_JOB, REMOTE_JOB], // duplicate id → deduped to 1
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const out = await searchGoogleJobs({ query: 'senior backend engineer', location: 'United States' });
    expect(out.length).toBe(1);
    expect(out[0].source).toBe('google_jobs');
  });

  it('treats a 200 + {error} body as zero results (search worked, found nothing)', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "Google hasn't returned any results" }), { status: 200 }));
    const out = await searchGoogleJobs({ query: 'nonsense query zzz' });
    expect(out).toEqual([]);
  });

  it('throws SearchJobsError on an HTTP error (missing/invalid key, 429, 5xx)', async () => {
    stubFetch(() => new Response('{"error":"You must be logged in"}', { status: 401 }));
    await expect(searchGoogleJobs({ query: 'senior backend engineer' })).rejects.toBeInstanceOf(SearchJobsError);
  });

  it('rejects an empty query', async () => {
    await expect(searchGoogleJobs({ query: '   ' })).rejects.toBeInstanceOf(SearchJobsError);
  });
});
