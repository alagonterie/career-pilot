/**
 * Unit tests for the kit entity-redaction belt (§24.134a).
 *
 * The belt calls Portkey/Haiku via the shared `callPortkeyChat` helper, which
 * uses global `fetch`; tests stub `fetch` and set PORTKEY_API_KEY so no real
 * network call happens. Pure helpers (parse + deterministic redact) are tested
 * directly; the orchestrating `redactKitEntities` covers gating, success, cache,
 * empty-array, and the fail-safe (→ null → caller seals) paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import {
  applyEntityRedactions,
  filterProtected,
  kitEntityRedactActive,
  parseEntityTokens,
  readProtectedTerms,
  redactKitEntities,
  __resetEntityRedactStateForTests,
} from './kit-entity-redact.js';

/** A stub Portkey completion whose content is the detector's JSON array. */
function okFetch(content: string) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  })) as unknown as typeof fetch;
}

function setBudget(db: Database.Database, usd: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO preferences (key, value, updated_at)
     VALUES ('kit_entity_redact_budget_usd_per_day', @v, '2026-06-19T00:00:00Z')`,
  ).run({ v: usd });
}

describe('kit-entity-redact', () => {
  let db: Database.Database;
  const savedKey = process.env.PORTKEY_API_KEY;
  const savedBypass = process.env.PORTKEY_BYPASS;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
    __resetEntityRedactStateForTests();
    delete process.env.PORTKEY_API_KEY;
    delete process.env.PORTKEY_BYPASS;
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.PORTKEY_API_KEY;
    else process.env.PORTKEY_API_KEY = savedKey;
    if (savedBypass === undefined) delete process.env.PORTKEY_BYPASS;
    else process.env.PORTKEY_BYPASS = savedBypass;
  });

  describe('parseEntityTokens', () => {
    it('parses a bare JSON array', () => {
      expect(parseEntityTokens('["Quicksilver","Borealis"]')).toEqual(['Quicksilver', 'Borealis']);
    });
    it('extracts an array embedded in prose', () => {
      expect(parseEntityTokens('Here are the tokens: ["Atlas", "Helios"] — redact those.')).toEqual([
        'Atlas',
        'Helios',
      ]);
    });
    it('returns null when there is no array (→ caller seals)', () => {
      expect(parseEntityTokens('I could not find anything to redact.')).toBeNull();
      expect(parseEntityTokens('')).toBeNull();
    });
    it('returns an empty list for an empty array', () => {
      expect(parseEntityTokens('[]')).toEqual([]);
    });
    it('drops too-short / too-long / placeholder tokens and dedupes case-insensitively', () => {
      const long = 'x'.repeat(80);
      expect(parseEntityTokens(`["a","Quicksilver","quicksilver","[REDACTED:infra-d]","${long}", 7]`)).toEqual([
        'Quicksilver',
      ]);
    });
  });

  describe('applyEntityRedactions', () => {
    it('replaces detected tokens with the provenance-distinct AI token, leaving the rest', () => {
      const out = applyEntityRedactions('They use Quicksilver (Rust) and gRPC at scale.', ['Quicksilver']);
      expect(out).toBe('They use [AI_REDACTED] (Rust) and gRPC at scale.');
      // generic tech NOT passed as a token is untouched
      expect(out).toContain('Rust');
      expect(out).toContain('gRPC');
    });
    it('does not redact a token embedded inside a larger word', () => {
      // 'Go' must not nuke 'Google' or 'goes'
      expect(applyEntityRedactions('Google goes far with Go.', ['Go'])).toBe('Google goes far with [AI_REDACTED].');
    });
  });

  describe('kitEntityRedactActive', () => {
    it('is enabled-by-default but still requires a configured key', () => {
      // default true (config/defaults.json) but no key → inactive
      expect(kitEntityRedactActive(db)).toBe(false);
      process.env.PORTKEY_API_KEY = 'pk-test';
      expect(kitEntityRedactActive(db)).toBe(true);
      // explicit disable wins even with a key
      db.prepare(
        `INSERT OR REPLACE INTO preferences (key, value, updated_at)
         VALUES ('kit_entity_redact_enabled', 'false', '2026-06-19T00:00:00Z')`,
      ).run();
      expect(kitEntityRedactActive(db)).toBe(false);
    });
  });

  describe('redactKitEntities', () => {
    const SECTION = "[REDACTED:infra-d]'s Quicksilver (Rust) and modern backend stack are where this applies.";

    it('returns null when Portkey is not configured (no key)', async () => {
      const fetchMock = okFetch('["Quicksilver"]');
      vi.stubGlobal('fetch', fetchMock);
      expect(await redactKitEntities(SECTION, db)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('redacts the detected codename but preserves generic tech, and caches', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      const fetchMock = okFetch('["Quicksilver"]');
      vi.stubGlobal('fetch', fetchMock);

      const first = await redactKitEntities(SECTION, db);
      expect(first).not.toContain('Quicksilver');
      expect(first).toContain('[AI_REDACTED]');
      expect(first).toContain('Rust'); // generic tech kept
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // identical input → cache hit, no second network call
      const second = await redactKitEntities(SECTION, db);
      expect(second).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns the text unchanged when the detector finds nothing', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      vi.stubGlobal('fetch', okFetch('[]'));
      const clean = 'The candidate has shipped distributed systems in Go and gRPC.';
      expect(await redactKitEntities(clean, db)).toBe(clean);
    });

    it('returns null on HTTP error (→ caller seals)', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch,
      );
      expect(await redactKitEntities(SECTION, db)).toBeNull();
    });

    it('returns null when the completion has no parseable array (→ caller seals)', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      vi.stubGlobal('fetch', okFetch('I am not sure what to redact here.'));
      expect(await redactKitEntities(SECTION, db)).toBeNull();
    });

    it('returns null when over the daily budget, without calling out', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      setBudget(db, '0.0001'); // below the per-call estimate
      const fetchMock = okFetch('["Quicksilver"]');
      vi.stubGlobal('fetch', fetchMock);
      expect(await redactKitEntities(SECTION, db)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('protected keep-list (§24.134d)', () => {
    function setProtected(json: string): void {
      db.prepare(
        `INSERT INTO candidate_profile (id, protected_terms, updated_at)
         VALUES (1, @v, '2026-06-19T00:00:00Z')
         ON CONFLICT(id) DO UPDATE SET protected_terms = @v`,
      ).run({ v: json });
    }

    it('filterProtected drops candidate-owned tokens (case-insensitive, substring-tolerant)', () => {
      expect(filterProtected(['Quicksilver', 'Acme', 'acme inc'], ['Acme'])).toEqual(['Quicksilver']);
      expect(filterProtected(['Quicksilver'], [])).toEqual(['Quicksilver']); // no keep-list = no-op
    });

    it('readProtectedTerms parses the profile JSON; [] when absent/malformed', () => {
      expect(readProtectedTerms(db)).toEqual([]); // no row yet
      setProtected('["Acme","Globex"]');
      expect(readProtectedTerms(db)).toEqual(['Acme', 'Globex']);
      setProtected('not json');
      expect(readProtectedTerms(db)).toEqual([]);
    });

    it('redactKitEntities never redacts a protected term, even when the model flags it', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      setProtected('["Acme"]');
      // The model returns a real codename AND the candidate's own employer.
      vi.stubGlobal('fetch', okFetch('["Quicksilver","Acme"]'));
      const out = await redactKitEntities('You led the rearchitecture at Acme; their Quicksilver proxy is key.', db);
      expect(out).not.toContain('Quicksilver'); // codename redacted
      expect(out).toContain('Acme'); // employer kept — filtered out of the redaction set
      expect(out).toContain('[AI_REDACTED]');
    });
  });
});
