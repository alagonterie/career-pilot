/**
 * Unit tests for the Tier-2 mechanical honesty guardrail (STRATEGY §24.72 D5 /
 * 9.4b-r2): the tailored résumé must trace to the master — invent an employer →
 * reject; rephrased titles/dates → corrected; invented skills/projects → dropped.
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
    { role: 'Senior Software Engineer', company: 'Vertafore', period: '2021 — Present', bullets: ['Did A.', 'Did B.'] },
    { role: 'Software Engineer', company: 'AuthEngine', period: '2019 — 2021', bullets: ['Did C.'] },
  ],
  projects: [
    { name: 'career-pilot', description: 'This portal.', href: 'https://example.com/cp', tags: ['AI'] },
    { name: 'TMS', description: 'A system.', tags: ['Go'] },
  ],
  skills: ['TypeScript', 'Go', 'Cloudflare', 'AI Agents'],
  education: ['BS Computer Science, State University'],
  links: { github: 'https://github.com/alagonterie' },
};

describe('validateTailoredResume — honest tailoring', () => {
  it('accepts a re-ordered, re-bulleted subset and forces identity from the master', () => {
    const emitted = {
      name: 'TOTALLY WRONG NAME',
      title: 'Inflated Title',
      bio: ['Tailored summary aimed at the role.'],
      experience: [
        // Only Vertafore, re-bulleted toward the role; agent rephrased the title.
        {
          role: 'Sr. Software Engineer',
          company: 'Vertafore',
          period: 'forever',
          bullets: ['Tailored bullet for the role.'],
        },
      ],
      skills: ['Go', 'Cloudflare'],
      projects: [{ name: 'career-pilot', description: 'Tailored project blurb.' }],
      links: { github: 'https://github.com/IMPOSTER' },
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.ok).toBe(true);
    const p = res.profile!;
    // Identity forced from master.
    expect(p.name).toBe('Alexander LaGonterie');
    expect(p.title).toBe('Senior Software Engineer · Team Lead');
    expect(p.links).toEqual({ github: 'https://github.com/alagonterie' });
    // Experience role + period corrected to the master's; tailored bullet kept.
    expect(p.experience[0].role).toBe('Senior Software Engineer');
    expect(p.experience[0].period).toBe('2021 — Present');
    expect(p.experience[0].bullets).toEqual(['Tailored bullet for the role.']);
    // Education taken from master verbatim even though omitted by the agent.
    expect(p.education).toEqual(['BS Computer Science, State University']);
    // Project name/href forced, tailored description kept.
    expect(p.projects[0]).toEqual({
      name: 'career-pilot',
      description: 'Tailored project blurb.',
      href: 'https://example.com/cp',
    });
  });

  it('drops invented skills and projects (not in the master)', () => {
    const emitted = {
      name: 'X',
      experience: [{ role: 'Software Engineer', company: 'AuthEngine', period: '2019 — 2021', bullets: ['b'] }],
      skills: ['Go', 'Rust', 'Kubernetes'], // Rust + Kubernetes invented
      projects: [
        { name: 'TMS', description: 'd' },
        { name: 'Invented Startup', description: 'fake' },
      ],
    };
    const res = validateTailoredResume(emitted, MASTER);
    expect(res.ok).toBe(true);
    expect(res.profile!.skills).toEqual(['Go']); // Rust/Kubernetes dropped
    expect(res.profile!.projects.map((p) => p.name)).toEqual(['TMS']); // invented project dropped
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

  it('rejects a non-WorkProfile / nameless emission', () => {
    expect(validateTailoredResume(null, MASTER).ok).toBe(false);
    expect(validateTailoredResume({ title: 'no name' }, MASTER).ok).toBe(false);
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
});

describe('stripTailoredResumeBlock', () => {
  it('removes the tagged fence and collapses the gap, keeping the prose', () => {
    const out = 'Bullets + outreach.\n\n```tailored-resume-json\n{"name":"X"}\n```\n\nThanks.';
    expect(stripTailoredResumeBlock(out)).toBe('Bullets + outreach.\n\nThanks.');
  });
});
