/**
 * Unit tests for the Tier-2 mechanical honesty guardrail (STRATEGY §24.72 D5 /
 * 9.4b-r2 + the résumé-quality rework): the tailored résumé must trace to the
 * master. Identity + employer/role/dates are forced; bullets are SNAPPED to the
 * master's verbatim wording (reworded → corrected, fabricated → dropped, all-miss
 * → master bullets); skills/projects (flat + grouped) are filtered to the master;
 * an invented employer is rejected.
 */
import { describe, expect, it } from 'vitest';

import type { WorkProfile } from './profile.js';
import { extractTailoredResumeBlock, stripTailoredResumeBlock, validateTailoredResume } from './tailored-resume.js';

const MASTER: WorkProfile = {
  name: 'Alexander LaGonterie',
  title: 'Senior Software Engineer · Team Lead',
  bio: ['Master bio.'],
  lookingFor: ['Staff / Lead'],
  experience: [
    {
      role: 'Senior Software Engineer',
      company: 'Vertafore',
      period: '2021 — Present',
      bullets: [
        'Built a Rust in-memory authorization engine answering security checks 850 times faster than the SQL it replaced.',
        'Architected the .NET backend using CQRS and hybrid event sourcing over a live legacy database.',
      ],
    },
    {
      role: 'Software Engineer',
      company: 'AuthEngine',
      period: '2019 — 2021',
      bullets: ['Owned a TypeScript services layer from prototype to production.'],
    },
  ],
  projects: [
    { name: 'career-pilot', description: 'This portal.', href: 'https://example.com/cp', tags: ['AI'] },
    { name: 'TMS', description: 'A system.', tags: ['Go'] },
  ],
  skills: ['TypeScript', 'Go', 'Cloudflare', 'AI Agents', 'Rust', 'CQRS', 'gRPC'],
  education: ['BS Computer Science, State University'],
  links: { github: 'https://github.com/alagonterie' },
};

describe('validateTailoredResume — identity + structure forced from the master', () => {
  it('forces name/title/links and employer/role/dates, and education verbatim', () => {
    const emitted = {
      name: 'TOTALLY WRONG NAME',
      title: 'Inflated Title',
      bio: ['Tailored summary aimed at the role.'],
      experience: [
        {
          role: 'Sr. Software Engineer', // rephrased title
          company: 'Vertafore',
          period: 'whenever', // wrong dates
          bullets: ['Built a Rust authorization engine that answered security checks 850 times faster than SQL.'],
        },
      ],
      links: { github: 'https://github.com/IMPOSTER' },
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.ok).toBe(true);
    const p = res.profile!;
    expect(p.name).toBe('Alexander LaGonterie');
    expect(p.title).toBe('Senior Software Engineer · Team Lead');
    expect(p.links).toEqual({ github: 'https://github.com/alagonterie' });
    expect(p.experience[0].role).toBe('Senior Software Engineer');
    expect(p.experience[0].period).toBe('2021 — Present');
    expect(p.education).toEqual(['BS Computer Science, State University']);
  });
});

describe('validateTailoredResume — bullets selected/ordered, never reworded into fiction', () => {
  it('snaps a reworded bullet to the master verbatim and drops a fabricated one', () => {
    const emitted = {
      name: 'X',
      experience: [
        {
          role: 'Senior Software Engineer',
          company: 'Vertafore',
          period: '2021 — Present',
          bullets: [
            'Built a Rust authorization engine that answered security checks 850 times faster than SQL.', // reworded → snaps
            'Optimized PostgreSQL data pipelines, reducing query latency by 60 percent.', // fabricated → dropped
          ],
        },
      ],
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.ok).toBe(true);
    expect(res.profile!.experience[0].bullets).toEqual([
      'Built a Rust in-memory authorization engine answering security checks 850 times faster than the SQL it replaced.',
    ]);
  });

  it('falls back to the master bullets when every tailored bullet misses', () => {
    const emitted = {
      name: 'X',
      experience: [
        {
          role: 'Software Engineer',
          company: 'AuthEngine',
          period: '2019 — 2021',
          bullets: ['Led a cross-functional cloud migration to Kubernetes.'], // unrelated → dropped
        },
      ],
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.profile!.experience[0].bullets).toEqual([
      'Owned a TypeScript services layer from prototype to production.',
    ]);
  });
});

describe('validateTailoredResume — skills/projects filtered to the master', () => {
  it('drops invented flat skills and projects', () => {
    const emitted = {
      name: 'X',
      skills: ['Go', 'Rust', 'Kubernetes', 'PostgreSQL'], // Kubernetes + PostgreSQL invented
      projects: [
        { name: 'TMS', description: 'd' },
        { name: 'Invented Startup', description: 'fake' },
      ],
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.profile!.skills).toEqual(['Go', 'Rust']);
    expect(res.profile!.projects.map((p) => p.name)).toEqual(['TMS']);
  });

  it('filters grouped skills to the master set, drops empty groups, re-derives the flat union', () => {
    const emitted = {
      name: 'X',
      skillGroups: [
        { category: 'Languages', items: ['Rust', 'TypeScript', 'COBOL'] }, // COBOL invented → dropped
        { category: 'Imaginary', items: ['Telepathy'] }, // all invented → group dropped
        { category: 'Backend', items: ['CQRS', 'gRPC'] },
      ],
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.profile!.skillGroups).toEqual([
      { category: 'Languages', items: ['Rust', 'TypeScript'] },
      { category: 'Backend', items: ['CQRS', 'gRPC'] },
    ]);
    expect(res.profile!.skills).toEqual(['Rust', 'TypeScript', 'CQRS', 'gRPC']);
  });
});

describe('validateTailoredResume — fabrication is rejected', () => {
  it('rejects an experience at a company not in the master', () => {
    const emitted = {
      name: 'X',
      experience: [
        { role: 'Staff Engineer', company: 'Google', period: '2020 — Present', bullets: ['Invented role.'] },
        { role: 'Senior Software Engineer', company: 'Vertafore', period: '2021 — Present', bullets: ['Real.'] },
      ],
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.ok).toBe(false);
    expect(res.profile).toBeUndefined();
    expect(res.errors.join(' ')).toContain('Google');
  });

  it('rejects a non-object emission', () => {
    expect(validateTailoredResume(null, MASTER).ok).toBe(false);
    expect(validateTailoredResume('not an object', MASTER).ok).toBe(false);
    expect(validateTailoredResume([1, 2], MASTER).ok).toBe(false);
  });

  // The live reliability bug: the sandbox is asked for a WorkProfile WITHOUT
  // identity (name/title/links come from the master), but projection requires a
  // name — so a faithful, spec-correct no-name emit was being rejected and the
  // gift silently went missing. A no-name emit must validate, identity forced.
  it('accepts the instructed no-name shape, forcing identity from the master', () => {
    const res = validateTailoredResume(
      {
        bio: ['A summary written for this role.'],
        experience: [
          {
            company: 'Vertafore',
            role: 'Senior Software Engineer',
            period: '2021 — Present',
            bullets: ['Built a Rust authorization engine that answered security checks 850 times faster than SQL.'],
          },
        ],
        skillGroups: [{ category: 'Languages', items: ['Rust', 'TypeScript'] }],
      },
      MASTER,
    );
    expect(res.ok).toBe(true);
    expect(res.profile!.name).toBe('Alexander LaGonterie');
    expect(res.profile!.title).toBe('Senior Software Engineer · Team Lead');
    expect(res.profile!.experience[0].bullets[0]).toContain('Rust in-memory authorization engine');
  });
});

describe('extractTailoredResumeBlock', () => {
  it('parses the tagged fence, preferring it over a plain json fence', () => {
    const out = [
      'Here is the pitch.',
      '```json\n{"name":"decoy"}\n```',
      'And the résumé:',
      '```tailored-resume-json\n{"name":"Real","skills":["Go"]}\n```',
    ].join('\n\n');
    expect(extractTailoredResumeBlock(out)).toEqual({ name: 'Real', skills: ['Go'] });
  });

  it('falls back to the last json fence, and returns null when absent/malformed', () => {
    expect(extractTailoredResumeBlock('```json\n{"name":"X"}\n```')).toEqual({ name: 'X' });
    expect(extractTailoredResumeBlock('no fence here')).toBeNull();
    expect(extractTailoredResumeBlock('```tailored-resume-json\n{ not json\n```')).toBeNull();
  });

  // The live failure (§24.72 9.4b-r2): the agent put `tailored-resume-json` on a
  // LABEL LINE inside a ```json fence (or on the ```json info line) instead of
  // tagging the fence — extraction must read it either way, not silently drop it.
  it('parses a ```json fence whose first inner line is the tailored-resume-json label', () => {
    const out = [
      'Here are your bullets and outreach.',
      '```json',
      'tailored-resume-json',
      '{"name":"Real","experience":[],"skills":["Go"]}',
      '```',
    ].join('\n');
    expect(extractTailoredResumeBlock(out)).toEqual({ name: 'Real', experience: [], skills: ['Go'] });
  });

  it('parses the tag on the ```json info line (```json tailored-resume-json)', () => {
    const out = '```json tailored-resume-json\n{"name":"Real","bio":["x"]}\n```';
    expect(extractTailoredResumeBlock(out)).toEqual({ name: 'Real', bio: ['x'] });
  });
});

describe('stripTailoredResumeBlock', () => {
  it('removes the tagged fence and collapses the gap, keeping the prose', () => {
    const out = 'Bullets + outreach.\n\n```tailored-resume-json\n{"name":"X"}\n```\n\nThanks.';
    expect(stripTailoredResumeBlock(out)).toBe('Bullets + outreach.\n\nThanks.');
  });

  // The live leak: the same label-line ```json variant that broke extraction also
  // slipped past the strip → raw JSON showed under the outreach email. Strip it.
  it('strips a ```json fence carrying the tailored-resume-json label line', () => {
    const out = [
      'Bullets + outreach.',
      '',
      '```json',
      'tailored-resume-json',
      '{"name":"X","experience":[]}',
      '```',
      '',
      'Thanks.',
    ].join('\n');
    expect(stripTailoredResumeBlock(out)).toBe('Bullets + outreach.\n\nThanks.');
  });
});
