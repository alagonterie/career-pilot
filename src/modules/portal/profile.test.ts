/**
 * Unit tests for the `/work` profile projection (STRATEGY.md §24.71 / 9.4b-1):
 * the pure `projectWorkProfile` (tolerant parse → WorkProfile | null) and the
 * `getPublicProfile` DB read (provenance + placeholder fallback).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { getPublicProfile, projectWorkProfile } from './profile.js';

const FULL = {
  name: 'Ada Lovelace',
  title: 'Staff Engineer · Compilers',
  bio: ['First paragraph.', 'Second paragraph.'],
  lookingFor: ['Staff — Compilers', 'Remote'],
  experience: [
    { role: 'Staff Engineer', company: 'Analytical Engines', period: '2020 — Present', bullets: ['Shipped X.'] },
  ],
  projects: [{ name: 'note-g', description: 'The first algorithm.', href: 'https://example.com', tags: ['Math'] }],
  writing: [{ title: 'On the Engine', venue: 'Journal', href: 'https://example.com/w' }],
  skills: ['Algorithms', 'Compilers'],
  education: ['Self-taught'],
  links: { github: 'https://github.com/x', linkedin: 'https://linkedin.com/in/x' },
};

/** Seed the single candidate_profile row with a work_profile_json blob. */
function seedWorkProfile(json: string | null, source = 'seed', generatedAt = '2026-06-14T00:00:00.000Z'): void {
  getDb()
    .prepare(
      `INSERT INTO candidate_profile (id, work_profile_json, work_profile_source, work_profile_generated_at, updated_at)
       VALUES (1, ?, ?, ?, ?)`,
    )
    .run(json, source, generatedAt, new Date().toISOString());
}

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('projectWorkProfile', () => {
  it('round-trips a full, well-formed blob', () => {
    const p = projectWorkProfile(JSON.stringify(FULL));
    expect(p).not.toBeNull();
    expect(p!.name).toBe('Ada Lovelace');
    expect(p!.bio).toHaveLength(2);
    expect(p!.experience[0].bullets).toEqual(['Shipped X.']);
    expect(p!.projects[0].href).toBe('https://example.com');
    expect(p!.projects[0].tags).toEqual(['Math']);
    expect(p!.writing).toHaveLength(1);
    expect(p!.links.github).toBe('https://github.com/x');
  });

  it('returns null for null / malformed / non-object / nameless input', () => {
    expect(projectWorkProfile(null)).toBeNull();
    expect(projectWorkProfile('{ not json')).toBeNull();
    expect(projectWorkProfile('[]')).toBeNull();
    expect(projectWorkProfile('"a string"')).toBeNull();
    expect(projectWorkProfile(JSON.stringify({ title: 'no name' }))).toBeNull();
    expect(projectWorkProfile(JSON.stringify({ name: '   ' }))).toBeNull();
  });

  it('tolerates a partial seed — missing arrays coerce to [], unset sections degrade', () => {
    const p = projectWorkProfile(JSON.stringify({ name: 'Grace Hopper' }));
    expect(p).not.toBeNull();
    expect(p!.name).toBe('Grace Hopper');
    expect(p!.title).toBe('');
    expect(p!.bio).toEqual([]);
    expect(p!.experience).toEqual([]);
    expect(p!.skills).toEqual([]);
    expect(p!.links).toEqual({});
    expect(p!.writing).toBeUndefined(); // optional — omitted, not []
  });

  it('drops non-string array members and empty optional fields', () => {
    const p = projectWorkProfile(
      JSON.stringify({ name: 'X', skills: ['a', 2, null, 'b'], projects: [{ name: 'P', description: 'D', href: '' }] }),
    );
    expect(p!.skills).toEqual(['a', 'b']);
    expect(p!.projects[0].href).toBeUndefined(); // empty string → omitted
    expect(p!.projects[0].tags).toBeUndefined();
  });
});

describe('getPublicProfile', () => {
  it('returns null profile + null provenance when no row exists', () => {
    expect(getPublicProfile()).toEqual({ profile: null, generated_at: null, source: null });
  });

  it('returns null profile when the row exists but the blob is unset', () => {
    seedWorkProfile(null);
    expect(getPublicProfile()).toEqual({ profile: null, generated_at: null, source: null });
  });

  it('projects the blob and surfaces provenance when populated', () => {
    seedWorkProfile(JSON.stringify(FULL), 'seed', '2026-06-14T12:00:00.000Z');
    const res = getPublicProfile();
    expect(res.profile?.name).toBe('Ada Lovelace');
    expect(res.source).toBe('seed');
    expect(res.generated_at).toBe('2026-06-14T12:00:00.000Z');
  });

  it('suppresses provenance when the blob is malformed (placeholder fallback)', () => {
    seedWorkProfile('{ broken', 'agent', '2026-06-14T12:00:00.000Z');
    const res = getPublicProfile();
    expect(res.profile).toBeNull();
    expect(res.source).toBeNull();
    expect(res.generated_at).toBeNull();
  });
});
