/**
 * Unit tests for the server-rendered résumé PDF (STRATEGY §24.72 / 9.4b-r1).
 * Verifies the renderer EMPIRICALLY — a real `@react-pdf/renderer` render whose
 * output starts with the `%PDF-` magic header — rather than trusting the API
 * blind, plus the omit-when-empty footer.
 */
import { describe, expect, it } from 'vitest';

import type { Identity, WorkProfile } from './profile.js';
import { masterFooter, renderResumePdf } from './resume-pdf.js';

const PROFILE: WorkProfile = {
  name: 'Ada Lovelace',
  title: 'Senior Software Engineer · Team Lead',
  bio: ['Builds real systems end to end.'],
  lookingFor: ['Staff / Lead', 'Remote'],
  experience: [
    {
      role: 'Staff Engineer',
      company: 'Analytical Engines',
      period: '2020 — Present',
      bullets: ['Shipped X.', 'Led Y.'],
    },
  ],
  projects: [{ name: 'note-g', description: 'The first algorithm.', href: 'https://example.com/g', tags: ['Math'] }],
  writing: [{ title: 'On the Engine', venue: 'Journal' }],
  skills: ['Algorithms', 'Compilers'],
  education: ['Self-taught'],
  links: {},
};

const IDENTITY: Identity = {
  email: 'ada@x.dev',
  github: 'https://github.com/ada',
  linkedin: 'https://www.linkedin.com/in/ada',
  x: null,
  website: null,
};

const EMPTY_IDENTITY: Identity = { email: null, github: null, linkedin: null, x: null, website: null };

function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

describe('renderResumePdf', () => {
  it('renders a non-empty, valid PDF from a full profile', async () => {
    const buf = await renderResumePdf(PROFILE, IDENTITY, masterFooter());
    expect(buf.length).toBeGreaterThan(1000);
    expect(isPdf(buf)).toBe(true);
  });

  it('tolerates a minimal profile (empty sections omitted, still a valid PDF)', async () => {
    const min: WorkProfile = {
      name: 'X',
      title: '',
      bio: [],
      lookingFor: [],
      experience: [],
      projects: [],
      skills: [],
      education: [],
      links: {},
    };
    const buf = await renderResumePdf(min, EMPTY_IDENTITY, masterFooter());
    expect(isPdf(buf)).toBe(true);
  });
});

describe('masterFooter', () => {
  it('omits the host when no portal URL env is set (no faked URL)', () => {
    const a = process.env.PORTAL_PUBLIC_URL;
    const b = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.PORTAL_PUBLIC_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    try {
      expect(masterFooter()).toBe('◇ Composed by my AI agent system');
    } finally {
      if (a !== undefined) process.env.PORTAL_PUBLIC_URL = a;
      if (b !== undefined) process.env.NEXT_PUBLIC_APP_URL = b;
    }
  });

  it('appends the host when the env is set', () => {
    const a = process.env.PORTAL_PUBLIC_URL;
    process.env.PORTAL_PUBLIC_URL = 'https://hire.example.com/';
    try {
      expect(masterFooter()).toBe('◇ Composed by my AI agent system · hire.example.com');
    } finally {
      if (a === undefined) delete process.env.PORTAL_PUBLIC_URL;
      else process.env.PORTAL_PUBLIC_URL = a;
    }
  });
});
