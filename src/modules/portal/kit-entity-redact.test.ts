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
  kitEntityRedactActive,
  parseEntityTokens,
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
      expect(parseEntityTokens('["EdgeProxy","Borg"]')).toEqual(['EdgeProxy', 'Borg']);
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
      expect(parseEntityTokens(`["a","EdgeProxy","edgeproxy","[REDACTED:infra-d]","${long}", 7]`)).toEqual(['EdgeProxy']);
    });
  });

  describe('applyEntityRedactions', () => {
    it('replaces detected tokens (word-boundary, case-insensitive) and leaves the rest', () => {
      const out = applyEntityRedactions('They use EdgeProxy (Rust) and gRPC at scale.', ['EdgeProxy']);
      expect(out).toBe('They use [REDACTED] (Rust) and gRPC at scale.');
      // generic tech NOT passed as a token is untouched
      expect(out).toContain('Rust');
      expect(out).toContain('gRPC');
    });
    it('does not redact a token embedded inside a larger word', () => {
      // 'Go' must not nuke 'Google' or 'goes'
      expect(applyEntityRedactions('Google goes far with Go.', ['Go'])).toBe('Google goes far with [REDACTED].');
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
    const SECTION = "[REDACTED:infra-d]'s EdgeProxy (Rust) and modern backend stack are where this applies.";

    it('returns null when Portkey is not configured (no key)', async () => {
      const fetchMock = okFetch('["EdgeProxy"]');
      vi.stubGlobal('fetch', fetchMock);
      expect(await redactKitEntities(SECTION, db)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('redacts the detected codename but preserves generic tech, and caches', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      const fetchMock = okFetch('["EdgeProxy"]');
      vi.stubGlobal('fetch', fetchMock);

      const first = await redactKitEntities(SECTION, db);
      expect(first).not.toContain('EdgeProxy');
      expect(first).toContain('[REDACTED]');
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
      const fetchMock = okFetch('["EdgeProxy"]');
      vi.stubGlobal('fetch', fetchMock);
      expect(await redactKitEntities(SECTION, db)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
