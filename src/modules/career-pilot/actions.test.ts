import { describe, expect, it } from 'vitest';

import { _testing } from './actions.js';

const { encodeSuffix, slugify, deriveIndustry, normalizeProfileValue } = _testing;

describe('normalizeProfileValue', () => {
  it('stores array fields as clean JSON regardless of how the agent serialized them', () => {
    // a real array
    expect(normalizeProfileValue('target_roles', ['Staff Engineer', 'Senior Engineer'])).toBe(
      '["Staff Engineer","Senior Engineer"]',
    );
    // a clean JSON-array string
    expect(normalizeProfileValue('target_roles', '["Staff Engineer","Senior Engineer"]')).toBe(
      '["Staff Engineer","Senior Engineer"]',
    );
    // a human comma list
    expect(normalizeProfileValue('skills', 'Go, Rust, TypeScript')).toBe('["Go","Rust","TypeScript"]');
    // empty → an empty array, never null-shaped junk
    expect(normalizeProfileValue('target_roles', '')).toBe('[]');
  });

  it('repairs the over-escaped JSON the agent actually stored (the 5/6 onboarding bug)', () => {
    const overEscaped = '[\\"Senior Software Engineer\\", \\"Staff Software Engineer\\"]';
    const out = normalizeProfileValue('target_roles', overEscaped) as string;
    expect(JSON.parse(out)).toEqual(['Senior Software Engineer', 'Staff Software Engineer']);
  });

  it('coerces comp_floor to a number, stripping currency formatting', () => {
    expect(normalizeProfileValue('comp_floor', 165000)).toBe(165000);
    expect(normalizeProfileValue('comp_floor', '$165,000')).toBe(165000);
    expect(normalizeProfileValue('comp_floor', 'not a number')).toBeNull();
  });

  it('passes plain string fields through and maps null/undefined to null', () => {
    expect(normalizeProfileValue('bio', 'Senior engineer.')).toBe('Senior engineer.');
    expect(normalizeProfileValue('full_name', null)).toBeNull();
    expect(normalizeProfileValue('full_name', undefined)).toBeNull();
  });
});

describe('encodeSuffix', () => {
  it('maps 0..25 to a..z', () => {
    expect(encodeSuffix(0)).toBe('a');
    expect(encodeSuffix(1)).toBe('b');
    expect(encodeSuffix(25)).toBe('z');
  });

  it('rolls over to two-letter labels at 26', () => {
    expect(encodeSuffix(26)).toBe('aa');
    expect(encodeSuffix(27)).toBe('ab');
    expect(encodeSuffix(51)).toBe('az');
    expect(encodeSuffix(52)).toBe('ba');
  });

  it('clamps negative + non-integer inputs', () => {
    expect(encodeSuffix(-1)).toBe('a');
    expect(encodeSuffix(2.7)).toBe('c');
  });
});

describe('slugify', () => {
  it('lowercases and collapses non-alphanumeric to dashes', () => {
    expect(slugify('Fintech')).toBe('fintech');
    expect(slugify('AI / Infra')).toBe('ai-infra');
    expect(slugify('series-b SaaS')).toBe('series-b-saas');
  });

  it('strips leading/trailing dashes', () => {
    expect(slugify('-fintech-')).toBe('fintech');
    expect(slugify('!!! fintech ???')).toBe('fintech');
  });

  it('falls back to "misc" on empty/garbage input', () => {
    expect(slugify('')).toBe('misc');
    expect(slugify('???')).toBe('misc');
  });

  it('caps length at 24 chars', () => {
    expect(slugify('this-is-a-very-long-industry-slug-that-keeps-going').length).toBeLessThanOrEqual(24);
  });
});

describe('deriveIndustry', () => {
  it('returns "misc" when patch has no jd_analyzed', () => {
    expect(deriveIndustry({})).toBe('misc');
    expect(deriveIndustry({ company_name: 'Acme' })).toBe('misc');
  });

  it('extracts role_category from jd_analyzed JSON', () => {
    expect(deriveIndustry({ jd_analyzed: JSON.stringify({ role_category: 'fintech' }) })).toBe('fintech');
    expect(deriveIndustry({ jd_analyzed: JSON.stringify({ role_category: 'AI / Infra' }) })).toBe('ai-infra');
  });

  it('falls back to "misc" when jd_analyzed JSON is malformed', () => {
    expect(deriveIndustry({ jd_analyzed: 'not json [' })).toBe('misc');
  });

  it('falls back to "misc" when jd_analyzed has no role_category', () => {
    expect(deriveIndustry({ jd_analyzed: JSON.stringify({ level: 'Staff' }) })).toBe('misc');
  });
});
