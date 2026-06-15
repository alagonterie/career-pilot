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
  name: 'Jane Doe',
  title: 'Senior Software Engineer · Team Lead',
  bio: ['Master bio.'],
  lookingFor: ['Staff / Lead'],
  experience: [
    {
      role: 'Senior Software Engineer',
      company: 'Acme Corp',
      period: '2021 — Present',
      bullets: [
        'Built a Rust in-memory authorization engine answering security checks 850 times faster than the SQL it replaced.',
        'Architected the .NET backend using CQRS and hybrid event sourcing over a live legacy database.',
      ],
    },
    {
      role: 'Software Engineer',
      company: 'AuthService',
      period: '2019 — 2021',
      bullets: ['Owned a TypeScript services layer from prototype to production.'],
    },
  ],
  projects: [
    { name: 'career-pilot', description: 'This portal.', href: 'https://example.com/cp', tags: ['AI'] },
    { name: 'CoreSvc', description: 'A system.', tags: ['Go'] },
  ],
  skills: ['TypeScript', 'Go', 'Cloudflare', 'AI Agents', 'Rust', 'CQRS', 'gRPC'],
  skillGroups: [
    { category: 'Languages', items: ['TypeScript', 'Go', 'Rust'] },
    { category: 'Backend', items: ['CQRS', 'gRPC'] },
    { category: 'Cloud & AI', items: ['Cloudflare', 'AI Agents'] },
  ],
  education: ['BS Computer Science, State University'],
  links: { github: 'https://github.com/janedoe' },
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
          company: 'Acme Corp',
          period: 'whenever', // wrong dates
          bullets: ['Built a Rust authorization engine that answered security checks 850 times faster than SQL.'],
        },
      ],
      links: { github: 'https://github.com/IMPOSTER' },
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.ok).toBe(true);
    const p = res.profile!;
    expect(p.name).toBe('Jane Doe');
    expect(p.title).toBe('Senior Software Engineer · Team Lead');
    expect(p.links).toEqual({ github: 'https://github.com/janedoe' });
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
          company: 'Acme Corp',
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
          company: 'AuthService',
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

describe('validateTailoredResume — quality floor: never a worse subset of the master', () => {
  it('always presents the master’s full skills + groups (agent skill subsetting/inventions ignored)', () => {
    const emitted = {
      skillGroups: [{ category: 'Backend & Systems', items: ['Rust', 'Python', 'COBOL'] }], // sparse + invented
      skills: ['Rust', 'Python'],
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.profile!.skills).toEqual(MASTER.skills);
    expect(res.profile!.skillGroups).toEqual(MASTER.skillGroups);
  });

  it('falls back to the master’s bio when the agent emits an empty/stub summary', () => {
    expect(validateTailoredResume({ bio: [] }, MASTER).profile!.bio).toEqual(MASTER.bio);
    expect(validateTailoredResume({ bio: ['too short'] }, MASTER).profile!.bio).toEqual(MASTER.bio);
  });

  it('keeps a substantive role-written bio', () => {
    const roleBio = [
      'A summary written specifically for this distributed-systems platform role, 80+ chars of real prose.',
    ];
    expect(validateTailoredResume({ bio: roleBio }, MASTER).profile!.bio).toEqual(roleBio);
  });

  it('falls back to the master’s projects when the agent drops them (keeps a valid selection otherwise)', () => {
    expect(validateTailoredResume({ projects: [] }, MASTER).profile!.projects.map((p) => p.name)).toEqual(
      MASTER.projects.map((p) => p.name),
    );
    const picked = validateTailoredResume({ projects: [{ name: 'CoreSvc', description: 'd' }] }, MASTER);
    expect(picked.profile!.projects.map((p) => p.name)).toEqual(['CoreSvc']);
  });

  // The exact "trash again — a worse version of the master" failure: the agent
  // emits a skeleton (no summary, no projects, two skills). The floor must turn
  // that into a complete résumé — master summary, full skills, the real project —
  // while keeping the agent's experience selection.
  it('floors a skeleton emit to master-quality (the worse-than-master fix)', () => {
    const skeleton = {
      bio: [],
      experience: [
        {
          company: 'Acme Corp',
          role: 'Senior Software Engineer',
          period: '2021 — Present',
          bullets: ['Built a Rust authorization engine that answered security checks 850 times faster than SQL.'],
        },
      ],
      projects: [],
      skills: ['Rust', 'Python'],
      skillGroups: [{ category: 'Backend & Systems', items: ['Rust', 'Python'] }],
    };
    const res = validateTailoredResume(skeleton, MASTER);
    expect(res.ok).toBe(true);
    const p = res.profile!;
    expect(p.bio).toEqual(MASTER.bio); // summary restored
    expect(p.skills).toEqual(MASTER.skills); // full skill set restored
    expect(p.skillGroups).toEqual(MASTER.skillGroups);
    expect(p.projects.map((x) => x.name)).toEqual(MASTER.projects.map((x) => x.name)); // project restored
    expect(p.experience[0].bullets[0]).toContain('Rust in-memory authorization engine'); // agent selection kept
  });
});

describe('validateTailoredResume — fabrication is rejected', () => {
  it('rejects an experience at a company not in the master', () => {
    const emitted = {
      name: 'X',
      experience: [
        { role: 'Staff Engineer', company: 'Google', period: '2020 — Present', bullets: ['Invented role.'] },
        { role: 'Senior Software Engineer', company: 'Acme Corp', period: '2021 — Present', bullets: ['Real.'] },
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
            company: 'Acme Corp',
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
    expect(res.profile!.name).toBe('Jane Doe');
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
