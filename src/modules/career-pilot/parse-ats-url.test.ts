/**
 * `parseAtsUrl` — one fixture per accepted form (STRATEGY.md §24.201 D7 slice c
 * DoD: "parseAtsUrl fixtures pass; a malformed token is refused"). Pure string
 * parsing: nothing here touches the network.
 */
import { describe, expect, it } from 'vitest';

import { boardPublicUrl, isValidBoardToken, parseAtsJobUrl, parseAtsUrl, titleCaseToken } from './ats-watchlist.js';

const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

describe('parseAtsUrl — one fixture per form', () => {
  const cases: Array<[string, string, ReturnType<typeof parseAtsUrl>]> = [
    ['greenhouse current board', 'https://job-boards.greenhouse.io/acme', { ats: 'greenhouse', token: 'acme' }],
    [
      'greenhouse current posting',
      'https://job-boards.greenhouse.io/acme/jobs/4012345',
      { ats: 'greenhouse', token: 'acme', job_id: '4012345' },
    ],
    ['greenhouse legacy board', 'https://boards.greenhouse.io/acme', { ats: 'greenhouse', token: 'acme' }],
    [
      'greenhouse legacy posting',
      'https://boards.greenhouse.io/acme/jobs/4012345?gh_src=x',
      { ats: 'greenhouse', token: 'acme', job_id: '4012345' },
    ],
    [
      'greenhouse EU board',
      'https://job-boards.eu.greenhouse.io/acme',
      { ats: 'greenhouse', token: 'acme', region: 'eu' },
    ],
    [
      'greenhouse EU legacy posting',
      'https://boards.eu.greenhouse.io/acme/jobs/77',
      { ats: 'greenhouse', token: 'acme', job_id: '77', region: 'eu' },
    ],
    [
      'greenhouse embed board',
      'https://boards.greenhouse.io/embed/job_board?for=acme',
      { ats: 'greenhouse', token: 'acme' },
    ],
    [
      'greenhouse embed job_app posting',
      'https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345',
      { ats: 'greenhouse', token: 'acme', job_id: '4012345' },
    ],
    [
      'greenhouse embed job_app board-only',
      'https://job-boards.greenhouse.io/embed/job_app?for=acme',
      { ats: 'greenhouse', token: 'acme' },
    ],
    ['lever board', 'https://jobs.lever.co/globex', { ats: 'lever', token: 'globex' }],
    ['lever posting', `https://jobs.lever.co/globex/${UUID}`, { ats: 'lever', token: 'globex', job_id: UUID }],
    [
      'lever apply page',
      `https://jobs.lever.co/globex/${UUID.toUpperCase()}/apply`,
      { ats: 'lever', token: 'globex', job_id: UUID },
    ],
    ['lever EU board', 'https://jobs.eu.lever.co/globex', { ats: 'lever', token: 'globex', region: 'eu' }],
    ['ashby board', 'https://jobs.ashbyhq.com/hooli', { ats: 'ashby', token: 'hooli' }],
    ['ashby posting', `https://jobs.ashbyhq.com/hooli/${UUID}`, { ats: 'ashby', token: 'hooli', job_id: UUID }],
    [
      'ashby application page',
      `https://jobs.ashbyhq.com/hooli/${UUID}/application`,
      { ats: 'ashby', token: 'hooli', job_id: UUID },
    ],
    ['token is lower-cased', 'https://jobs.ashbyhq.com/Hooli', { ats: 'ashby', token: 'hooli' }],
  ];
  for (const [name, url, want] of cases) {
    it(name, () => expect(parseAtsUrl(url)).toEqual(want));
  }

  it('refuses hosts, schemes and paths that are not a fixed ATS form', () => {
    for (const url of [
      'https://www.example.com/careers',
      'https://evil.example.com/job-boards.greenhouse.io/acme',
      'https://job-boards.greenhouse.io.example.com/acme',
      'ftp://jobs.lever.co/globex',
      'https://user:pw@jobs.lever.co/globex',
      'https://jobs.lever.co:8443/globex',
      'http://127.0.0.1/acme',
      'http://169.254.169.254/latest/meta-data/',
      'https://jobs.lever.co/globex/not-a-uuid',
      'https://job-boards.greenhouse.io/acme/jobs/abc',
      'https://boards.greenhouse.io/embed/job_app?for=acme&token=abc',
      'https://boards.greenhouse.io/embed/other?for=acme',
      'https://jobs.ashbyhq.com/',
      '',
      'not a url',
      `https://jobs.lever.co/${'a'.repeat(2001)}`,
      42,
    ]) {
      expect(parseAtsUrl(url), String(url)).toBeNull();
    }
  });

  it('returns a malformed token unvalidated so the caller can refuse it as such', () => {
    const ref = parseAtsUrl('https://jobs.ashbyhq.com/-bad%20name');
    expect(ref).not.toBeNull();
    expect(isValidBoardToken(ref?.token)).toBe(false);
    // ...and the posting-only wrapper refuses it outright.
    expect(parseAtsJobUrl(`https://jobs.ashbyhq.com/-bad%20name/${UUID}`)).toBeNull();
  });

  it('parseAtsJobUrl stays a posting-only wrapper', () => {
    expect(parseAtsJobUrl('https://job-boards.greenhouse.io/acme')).toBeNull();
    expect(parseAtsJobUrl('https://job-boards.greenhouse.io/acme/jobs/1')).toEqual({
      ats: 'greenhouse',
      token: 'acme',
      job_id: '1',
    });
  });

  it('builds board pages on the fixed hosts and title-cases a token', () => {
    expect(boardPublicUrl('greenhouse', 'acme')).toBe('https://job-boards.greenhouse.io/acme');
    expect(boardPublicUrl('lever', 'globex')).toBe('https://jobs.lever.co/globex');
    expect(boardPublicUrl('ashby', 'hooli')).toBe('https://jobs.ashbyhq.com/hooli');
    expect(titleCaseToken('acme-robotics')).toBe('Acme Robotics');
  });
});
