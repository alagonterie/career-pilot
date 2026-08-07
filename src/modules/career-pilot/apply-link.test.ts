import { describe, expect, it } from 'vitest';

import { classifyApplyLink, pickApplyLink } from './apply-link.js';

/**
 * §24.190. The bug these lock down: the adapter used to take `apply_options[0]`,
 * i.e. Google's ordering, so a posting that surfaced via an aggregator was stored
 * with the aggregator's URL even when a direct link sat one slot below it.
 */
describe('classifyApplyLink (§24.190)', () => {
  it('recognizes known ATS hosts, including subdomains', () => {
    expect(classifyApplyLink('https://boards.greenhouse.io/stripe/jobs/123', 'Stripe')).toBe('ats');
    expect(classifyApplyLink('https://jobs.lever.co/acme/abc', 'Acme')).toBe('ats');
    expect(classifyApplyLink('https://jobs.ashbyhq.com/acorns/cf23', 'Acorns')).toBe('ats');
    expect(classifyApplyLink('https://acme.wd1.myworkdayjobs.com/careers/job/x', 'Acme')).toBe('ats');
    expect(classifyApplyLink('https://www.workatastartup.com/jobs/77', 'Nango')).toBe('ats');
  });

  it("recognizes the hiring company's own site, including a careers subdomain", () => {
    expect(classifyApplyLink('https://stripe.com/careers/jobs/123', 'Stripe')).toBe('company');
    expect(classifyApplyLink('https://careers.socket.dev/roles/1', 'Socket.dev')).toBe('company');
    expect(classifyApplyLink('https://www.acmecorp.com/jobs', 'Acme Corp')).toBe('company');
  });

  it('does NOT mistake an aggregator for the company', () => {
    expect(classifyApplyLink('https://www.jobleads.com/us/job/abc', 'Socket.dev')).toBe('unknown');
    expect(classifyApplyLink('https://www.ziprecruiter.com/c/x/Job/y', 'Stripe')).toBe('unknown');
    expect(classifyApplyLink('https://www.glassdoor.com/job-listing/x', 'Acorns')).toBe('unknown');
  });

  // Found by running the backfill against real prod leads: aggregators routinely
  // list THEMSELVES as the employer, on a generic hosting platform. Matching any
  // host label would "confirm" them as the company and hide exactly the leads
  // whose real employer is unknown.
  it('does NOT accept a company-named SUBDOMAIN of an unrelated domain', () => {
    expect(classifyApplyLink('https://flexboard.9y.liveblog365.com/job/1', 'FlexBoard')).toBe('unknown');
    expect(classifyApplyLink('https://remoteclickjobs-production.up.railway.app/job/x', 'remote click jobs')).toBe(
      'unknown',
    );
  });

  it('accepts YC job pages as direct (a company listing, not a reposter index)', () => {
    expect(classifyApplyLink('https://www.ycombinator.com/companies/nango/jobs/KplJ2YB', 'Nango')).toBe('ats');
  });

  it('is defensive about junk input', () => {
    expect(classifyApplyLink('not-a-url', 'Stripe')).toBe('unknown');
    expect(classifyApplyLink('', 'Stripe')).toBe('unknown');
    // A 1-2 char company can't be matched on without absurd false positives.
    expect(classifyApplyLink('https://x.com/jobs', 'X')).toBe('unknown');
  });
});

describe('pickApplyLink (§24.190)', () => {
  it('picks the direct ATS link even when the aggregator is FIRST — the actual reported bug', () => {
    const out = pickApplyLink(
      [
        { title: 'JobLeads', link: 'https://www.jobleads.com/us/job/abc' },
        { title: 'Greenhouse', link: 'https://boards.greenhouse.io/socketdev/jobs/9' },
      ],
      'Socket.dev',
      null,
    );
    expect(out.url).toBe('https://boards.greenhouse.io/socketdev/jobs/9');
    expect(out.kind).toBe('ats');
  });

  it("prefers the company's own site over an ATS", () => {
    const out = pickApplyLink(
      [
        { title: 'LinkedIn', link: 'https://www.linkedin.com/jobs/view/1' },
        { title: 'Greenhouse', link: 'https://boards.greenhouse.io/stripe/jobs/9' },
        { title: 'Stripe', link: 'https://stripe.com/careers/jobs/9' },
      ],
      'Stripe',
      null,
    );
    expect(out.url).toBe('https://stripe.com/careers/jobs/9');
    expect(out.kind).toBe('company');
  });

  it('ranks the source_link fallback ALONGSIDE the options, not merely last', () => {
    // Google's source_link is often the most direct link of the lot.
    const out = pickApplyLink(
      [{ title: 'JobLeads', link: 'https://www.jobleads.com/us/job/abc' }],
      'Acorns',
      'https://jobs.ashbyhq.com/acorns/cf23',
    );
    expect(out.url).toBe('https://jobs.ashbyhq.com/acorns/cf23');
    expect(out.kind).toBe('ats');
  });

  it('marks a lead AGGREGATOR when no direct link exists anywhere', () => {
    const out = pickApplyLink(
      [
        { title: 'JobLeads', link: 'https://www.jobleads.com/us/job/abc' },
        { title: 'Talent.com', link: 'https://www.talent.com/view?id=1' },
      ],
      'VetsEZ',
      null,
    );
    // Still returns a usable link — but flags that it's all we have, which is
    // also the signal that the company attribution is unverified.
    expect(out.url).toBe('https://www.jobleads.com/us/job/abc');
    expect(out.kind).toBe('aggregator');
  });

  it('handles no options at all', () => {
    expect(pickApplyLink([], 'Acme', null)).toEqual({ url: null, kind: 'unknown' });
    expect(pickApplyLink(undefined, 'Acme', null)).toEqual({ url: null, kind: 'unknown' });
    expect(pickApplyLink([{ title: 'x' }], 'Acme', null)).toEqual({ url: null, kind: 'unknown' });
  });

  it('keeps the first best when several tie, so the result is deterministic', () => {
    const out = pickApplyLink(
      [
        { title: 'Greenhouse', link: 'https://boards.greenhouse.io/a/jobs/1' },
        { title: 'Lever', link: 'https://jobs.lever.co/a/2' },
      ],
      'Acme',
      null,
    );
    expect(out.url).toBe('https://boards.greenhouse.io/a/jobs/1');
  });
});
