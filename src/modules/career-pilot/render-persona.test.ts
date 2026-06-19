import { describe, expect, it } from 'vitest';

import { renderPersona, renderSandboxCandidate, type CandidateProfile } from './render-persona.js';

function profile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: 1,
    full_name: null,
    display_name: null,
    bio: null,
    target_roles: null,
    location_pref: null,
    comp_floor: null,
    master_resume: null,
    skills: null,
    github_url: null,
    linkedin_url: null,
    x_url: null,
    website_url: null,
    search_goals: null,
    headshot_path: null,
    brand_color_hsl: null,
    gmail_account: null,
    protected_terms: null,
    updated_at: '2026-05-26T00:00:00Z',
    ...overrides,
  };
}

describe('renderPersona', () => {
  describe('onboarding sentinel', () => {
    it('returns sentinel for null profile', () => {
      const out = renderPersona(null);
      expect(out).toContain('# Onboarding mode');
      expect(out).toContain('full_name');
      expect(out).toContain('comp_floor');
      expect(out).toContain('search_goals');
    });

    it('returns sentinel when only non-core (portal-styling) fields are set', () => {
      // headshot_path / brand_color_hsl don't satisfy the onboarding-completeness
      // gate (hasAnyContent), so populating them alone still triggers onboarding.
      const out = renderPersona(profile({ headshot_path: '/x.png', brand_color_hsl: '180 50% 40%' }));
      expect(out).toContain('# Onboarding mode');
    });
  });

  describe('populated profile', () => {
    const fullyPopulated = profile({
      full_name: 'Jane Doe',
      display_name: 'Jane',
      bio: 'Backend engineer, 8y, infra-leaning.',
      target_roles: JSON.stringify(['Staff Backend Engineer', 'Platform Engineer']),
      location_pref: JSON.stringify({ type: ['remote', 'hybrid'], preferred_cities: ['NYC', 'SF'] }),
      comp_floor: 220000,
      master_resume: '## Experience\n\n- Built things',
      skills: JSON.stringify(['Go', 'Rust', 'PostgreSQL']),
      github_url: 'https://github.com/jane',
      linkedin_url: 'https://linkedin.com/in/jane',
      website_url: 'https://jane.example.com',
      // x_url omitted → no X link
    });

    it('renders the full_name as the H1 header', () => {
      const out = renderPersona(fullyPopulated);
      expect(out).toMatch(/^# Jane Doe$/m);
    });

    it('renders display_name as a blockquote when distinct from full_name', () => {
      const out = renderPersona(fullyPopulated);
      expect(out).toContain('> Jane');
    });

    it('skips display_name blockquote when equal to full_name', () => {
      const out = renderPersona(profile({ full_name: 'Jane', display_name: 'Jane' }));
      expect(out).not.toMatch(/^> Jane$/m);
    });

    it('renders target_roles as a bullet list', () => {
      const out = renderPersona(fullyPopulated);
      expect(out).toContain('## Target roles');
      expect(out).toContain('- Staff Backend Engineer');
      expect(out).toContain('- Platform Engineer');
    });

    it('renders comp_floor as USD with thousands separators', () => {
      const out = renderPersona(fullyPopulated);
      expect(out).toContain('## Comp');
      expect(out).toContain('$220,000/year floor');
    });

    it('renders location_pref from the canonical {type, preferred_cities} schema (§24.100)', () => {
      const out = renderPersona(fullyPopulated);
      expect(out).toContain('## Location');
      expect(out).toContain('- Open to: remote, hybrid');
      expect(out).toContain('  - NYC');
      expect(out).toContain('  - SF');
    });

    it('omits the ## Location header entirely when the pref has no type/cities (§24.100)', () => {
      // The old reader pushed a bare "## Location" header for any non-null object;
      // an empty/unknown-shape pref must render no section, not an empty heading.
      const out = renderPersona(profile({ full_name: 'Jane', location_pref: JSON.stringify({}) }));
      expect(out).not.toContain('## Location');
    });

    it('renders links section, omitting null URLs', () => {
      const out = renderPersona(fullyPopulated);
      expect(out).toContain('## Links');
      expect(out).toContain('[GitHub](https://github.com/jane)');
      expect(out).toContain('[LinkedIn](https://linkedin.com/in/jane)');
      expect(out).toContain('[Website](https://jane.example.com)');
      expect(out).not.toContain('[X]');
    });

    it('excludes portal-styling fields (headshot_path, brand_color_hsl)', () => {
      const out = renderPersona(
        profile({
          ...fullyPopulated,
          headshot_path: '/jane.png',
          brand_color_hsl: '180 50% 40%',
        }),
      );
      expect(out).not.toContain('jane.png');
      expect(out).not.toContain('brand_color_hsl');
    });

    it('renders search_goals as an agent-facing ## Goals section (§24.101)', () => {
      const out = renderPersona(profile({ ...fullyPopulated, search_goals: 'Land a staff platform role by Q3.' }));
      expect(out).toContain('## Goals');
      expect(out).toContain('Land a staff platform role by Q3.');
    });

    it('is byte-deterministic for identical input', () => {
      const a = renderPersona(fullyPopulated);
      const b = renderPersona(fullyPopulated);
      expect(a).toBe(b);
    });
  });

  describe('partial profile', () => {
    it('renders only populated sections', () => {
      const out = renderPersona(
        profile({
          full_name: 'Jane Doe',
          target_roles: JSON.stringify(['Backend']),
          // bio, comp_floor, master_resume, skills, links all null
        }),
      );
      expect(out).toContain('# Jane Doe');
      expect(out).toContain('## Target roles');
      expect(out).not.toContain('## Background');
      expect(out).not.toContain('## Comp');
      expect(out).not.toContain('## Master resume');
      expect(out).not.toContain('## Skills');
      expect(out).not.toContain('## Links');
    });

    it('renders Links section even when only one URL is set', () => {
      const out = renderPersona(profile({ full_name: 'Jane', github_url: 'https://github.com/j' }));
      expect(out).toContain('## Links');
      expect(out).toContain('[GitHub](https://github.com/j)');
      expect(out).not.toContain('[LinkedIn]');
    });
  });

  describe('quiet hours section (§24.52)', () => {
    const p = profile({ full_name: 'Jane Doe' });

    it('renders the configured window + zone when provided', () => {
      const out = renderPersona(p, { window: '22:00-07:00', tz: 'America/Denver' });
      expect(out).toContain('## Quiet hours');
      expect(out).toContain('22:00-07:00 (America/Denver)');
    });

    it('labels an empty zone as the system zone', () => {
      const out = renderPersona(p, { window: '22:00-07:00', tz: '' });
      expect(out).toContain('22:00-07:00 (system zone)');
    });

    it('omits the section when no quiet hours are given or the window is empty (disabled)', () => {
      expect(renderPersona(p)).not.toContain('## Quiet hours');
      expect(renderPersona(p, { window: '', tz: 'America/Denver' })).not.toContain('## Quiet hours');
    });

    it('never adds the section in onboarding mode (null profile)', () => {
      const out = renderPersona(null, { window: '22:00-07:00', tz: 'America/Denver' });
      expect(out).toContain('# Onboarding mode');
      expect(out).not.toContain('## Quiet hours');
    });
  });

  describe('malformed JSON fields', () => {
    it('skips target_roles when JSON is malformed', () => {
      const out = renderPersona(profile({ full_name: 'Jane', target_roles: 'not json [' }));
      expect(out).toContain('# Jane');
      expect(out).not.toContain('## Target roles');
    });

    it('skips target_roles when it parses to a non-array', () => {
      const out = renderPersona(profile({ full_name: 'Jane', target_roles: '{"not": "an array"}' }));
      expect(out).not.toContain('## Target roles');
    });

    it('skips skills when JSON is malformed', () => {
      const out = renderPersona(profile({ full_name: 'Jane', skills: '[oops' }));
      expect(out).not.toContain('## Skills');
    });

    it('filters non-string entries in target_roles array', () => {
      const out = renderPersona(
        profile({ full_name: 'Jane', target_roles: JSON.stringify(['Engineer', 42, null, 'Architect']) }),
      );
      expect(out).toContain('- Engineer');
      expect(out).toContain('- Architect');
      expect(out).not.toContain('- 42');
      expect(out).not.toContain('- null');
    });

    it('skips location section when JSON is malformed', () => {
      const out = renderPersona(profile({ full_name: 'Jane', location_pref: 'not json' }));
      expect(out).not.toContain('## Location');
    });
  });
});

describe('renderSandboxCandidate (§24.54 — public simulator subset)', () => {
  const populated = profile({
    full_name: 'Jane Doe',
    bio: 'Backend engineer, 8y, infra-leaning.',
    target_roles: JSON.stringify(['Staff Backend Engineer']),
    location_pref: JSON.stringify({ type: ['remote'], preferred_cities: ['Denver'] }),
    comp_floor: 220000,
    master_resume: '## Experience\n\n- Built things',
    skills: JSON.stringify(['Go', 'Rust', 'PostgreSQL']),
    github_url: 'https://github.com/jane',
    search_goals: 'leave my current job for a staff role',
  });

  it('includes the resume-grade public subset', () => {
    const out = renderSandboxCandidate(populated);
    expect(out).toContain('# Jane Doe');
    expect(out).toContain('## Background');
    expect(out).toContain('## Target roles');
    expect(out).toContain('## Master resume');
    expect(out).toContain('- Go');
    expect(out).toContain('## Links');
  });

  it('excludes comp floor, quiet hours, and private search goals by design', () => {
    const out = renderSandboxCandidate(populated);
    expect(out).not.toContain('## Comp');
    expect(out).not.toContain('220,000');
    expect(out).not.toContain('## Quiet hours');
    // The candidate's private goals don't belong in the public demo (§24.101).
    expect(out).not.toContain('## Goals');
    expect(out).not.toContain('leave my current job');
  });

  it('injects an Approved-figures honesty allow-list from the real résumé numbers (§24.72)', () => {
    const p = profile({
      full_name: 'Jane Doe',
      master_resume: '## Experience\n\n- Cut latency to 137ns; 850× faster on 6.85M policies; 600+ tests.',
      bio: 'Senior engineer.',
    });
    const out = renderSandboxCandidate(p);
    expect(out).toContain('## Approved figures');
    expect(out).toContain('137');
    expect(out).toContain('850');
    expect(out).toContain('6.85');
    expect(out).toContain('600');
  });

  it('omits the Approved-figures section when the résumé has no numbers', () => {
    const p = profile({ full_name: 'Jane Doe', master_resume: '## Experience\n\n- Built and shipped things.' });
    expect(renderSandboxCandidate(p)).not.toContain('## Approved figures');
  });

  it('returns the sandbox sentinel (never the owner onboarding flow) for null/empty profiles', () => {
    for (const p of [null, profile(), profile({ comp_floor: 220000 })]) {
      const out = renderSandboxCandidate(p);
      expect(out).toContain('GENERIC senior software engineer');
      expect(out).toContain('Never ask');
      expect(out).not.toContain('# Onboarding mode');
      expect(out).not.toContain('update_profile_field');
    }
  });
});
