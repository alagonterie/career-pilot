/**
 * Unit tests for the location component of the deterministic lead rules-score
 * (§24.100): the canonical `{type, preferred_cities}` schema in `profileFromRow`
 * + the strong off-location demotion in `computeRulesScore`. The location score
 * is asserted via `reasons.location.score` so each case is isolated from the
 * keyword/comp/recency components.
 */
import { describe, expect, it } from 'vitest';

import type { JobLeadPayload } from '../../scrape-jobs/types.js';

import { computeRulesScore, profileFromRow, type CandidateProfileForScoring } from './lead-rules-score.js';

// A candidate who accepts remote OR a Denver hybrid — the box persona shape.
function remoteOrDenver(overrides: Partial<CandidateProfileForScoring> = {}): CandidateProfileForScoring {
  return {
    target_roles: ['Engineer'],
    skills: [],
    comp_floor_usd: undefined,
    acceptable_regions: ['US', 'GLOBAL'],
    acceptable_cities: ['Denver'],
    remote_ok: true,
    location_specified: true,
    negative_keywords: [],
    ...overrides,
  };
}

function payload(overrides: Partial<JobLeadPayload> = {}): JobLeadPayload {
  return {
    source: 'greenhouse',
    source_board_token: 'acme',
    source_job_id: 'j1',
    source_url: 'https://example.com/j1',
    title: 'Senior Engineer',
    company: 'Acme',
    ...overrides,
  };
}

function locScore(p: JobLeadPayload, profile: CandidateProfileForScoring): number {
  const reasons = computeRulesScore(p, profile).reasons.location as { score: number };
  return reasons.score;
}

describe('computeRulesScore — location component (§24.100)', () => {
  it('credits a remote role in an acceptable region (+15)', () => {
    expect(locScore(payload({ is_remote: true, remote_region: 'US' }), remoteOrDenver())).toBe(15);
  });

  it('gives partial credit for remote in an out-of-region locale (+8)', () => {
    expect(locScore(payload({ is_remote: true, remote_region: 'EU' }), remoteOrDenver())).toBe(8);
  });

  it('credits a non-remote role in a preferred city — the Denver hybrid (+15)', () => {
    const p = payload({ is_remote: false, workplace_type: 'hybrid', location_raw: 'Denver, CO' });
    const reasons = computeRulesScore(p, remoteOrDenver()).reasons.location as { score: number; matched_city: string };
    expect(reasons.score).toBe(15);
    expect(reasons.matched_city).toBe('Denver');
  });

  it('strongly demotes a definitively off-location role (non-remote, not a preferred city)', () => {
    const p = payload({ is_remote: false, workplace_type: 'onsite', location_raw: 'San Francisco, CA' });
    const reasons = computeRulesScore(p, remoteOrDenver()).reasons.location as { score: number; off_location: boolean };
    expect(reasons.score).toBe(-30);
    expect(reasons.off_location).toBe(true);
  });

  it('never penalizes an unknown location (is_remote null) — keeps it neutral', () => {
    expect(locScore(payload({ is_remote: null, location_raw: 'Anytown' }), remoteOrDenver())).toBe(0);
  });

  it('never demotes when no location preference is stated', () => {
    const noPref = remoteOrDenver({ acceptable_cities: [], remote_ok: true, location_specified: false });
    expect(locScore(payload({ is_remote: false, location_raw: 'San Francisco, CA' }), noPref)).toBe(0);
  });

  it('ranks an off-location role below an otherwise-identical preferred-city role', () => {
    const profile = remoteOrDenver();
    const denver = computeRulesScore(payload({ is_remote: false, location_raw: 'Denver, CO' }), profile).score;
    const sf = computeRulesScore(payload({ is_remote: false, location_raw: 'San Francisco, CA' }), profile).score;
    expect(denver).toBeGreaterThan(sf);
  });
});

describe('profileFromRow — canonical location_pref schema (§24.100)', () => {
  it('parses {type, preferred_cities} into remote_ok + acceptable_cities + location_specified', () => {
    const out = profileFromRow({
      location_pref: JSON.stringify({ type: ['remote', 'hybrid'], preferred_cities: ['Denver'] }),
    });
    expect(out.remote_ok).toBe(true);
    expect(out.acceptable_cities).toEqual(['Denver']);
    expect(out.location_specified).toBe(true);
  });

  it('sets remote_ok false when a stated preference omits remote', () => {
    const out = profileFromRow({ location_pref: JSON.stringify({ type: ['hybrid'], preferred_cities: ['Denver'] }) });
    expect(out.remote_ok).toBe(false);
    expect(out.location_specified).toBe(true);
  });

  it('defaults to permissive (remote_ok true, not specified) with no profile row', () => {
    const out = profileFromRow(null);
    expect(out.remote_ok).toBe(true);
    expect(out.location_specified).toBe(false);
    expect(out.acceptable_cities).toEqual([]);
  });

  it('treats an empty location_pref object as no stated preference', () => {
    const out = profileFromRow({ location_pref: JSON.stringify({}) });
    expect(out.location_specified).toBe(false);
    expect(out.remote_ok).toBe(true);
  });
});
