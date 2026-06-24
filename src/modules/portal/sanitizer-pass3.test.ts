/**
 * Unit tests for Pass 3 (host-side semantic obfuscation) — §24.12 (F2),
 * rewritten as a DETECTION pass in §24.169.
 *
 * Pass 3 calls Portkey/Haiku via global `fetch`; tests stub `fetch` and set
 * PORTKEY_API_KEY so no real network call happens. The model now returns a JSON
 * array of substrings to redact, which the host deterministically wraps in the
 * `[AI_REDACTED]` chip. The deterministic Pass 1+2 path is covered in
 * sanitizer.test.ts; here we exercise the gating, the success/cache/failure
 * paths, the budget guard, and the withhold semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { applyPass3, pass3Active, portkeyConfigured, __resetPass3StateForTests } from './sanitizer-pass3.js';
import { sanitizeForPublic } from './sanitizer.js';

function enablePass3(db: Database.Database): void {
  db.prepare(
    `INSERT OR REPLACE INTO preferences (key, value, updated_at)
     VALUES ('sanitization_pass3_enabled', 'true', '2026-06-09T00:00:00Z')`,
  ).run();
}

function setBudget(db: Database.Database, usd: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO preferences (key, value, updated_at)
     VALUES ('sanitization_pass3_budget_usd_per_day', @v, '2026-06-09T00:00:00Z')`,
  ).run({ v: usd });
}

/** A stub Portkey completion: the detection pass returns a JSON array of the
 * substrings to redact (host then wraps each in `[AI_REDACTED]`). */
function detectFetch(tokens: string[] = []) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(tokens) } }] }),
  })) as unknown as typeof fetch;
}

describe('sanitizer-pass3', () => {
  let db: Database.Database;
  const savedKey = process.env.PORTKEY_API_KEY;
  const savedBypass = process.env.PORTKEY_BYPASS;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
    __resetPass3StateForTests();
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

  describe('portkeyConfigured', () => {
    it('is false with no key, true with a key, false when bypassed', () => {
      expect(portkeyConfigured()).toBe(false);
      process.env.PORTKEY_API_KEY = 'pk-test';
      expect(portkeyConfigured()).toBe(true);
      process.env.PORTKEY_BYPASS = 'true';
      expect(portkeyConfigured()).toBe(false);
    });
  });

  describe('pass3Active', () => {
    it('requires BOTH the enabled flag AND a configured key', () => {
      // disabled (default) + no key
      expect(pass3Active(db)).toBe(false);
      // enabled but still no key
      enablePass3(db);
      expect(pass3Active(db)).toBe(false);
      // enabled + key → active
      process.env.PORTKEY_API_KEY = 'pk-test';
      expect(pass3Active(db)).toBe(true);
      // enabled + key present but disabled flag → inactive
      db.prepare("UPDATE preferences SET value = 'false' WHERE key = 'sanitization_pass3_enabled'").run();
      expect(pass3Active(db)).toBe(false);
    });
  });

  describe('applyPass3', () => {
    it('returns null when Portkey is not configured (no key)', async () => {
      const fetchMock = detectFetch(['Acme']);
      vi.stubGlobal('fetch', fetchMock);
      expect(await applyPass3('researching Acme MI300 launch', db)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('wraps each detected substring in [AI_REDACTED], and caches it', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      const fetchMock = detectFetch(['Acme', 'MI300']);
      vi.stubGlobal('fetch', fetchMock);

      const first = await applyPass3('researching Acme MI300 launch', db);
      expect(first).toBe('researching [AI_REDACTED] [AI_REDACTED] launch');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // identical input → cache hit, no second network call
      const second = await applyPass3('researching Acme MI300 launch', db);
      expect(second).toBe('researching [AI_REDACTED] [AI_REDACTED] launch');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns the text unchanged when the model flags nothing ([])', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      vi.stubGlobal('fetch', detectFetch([]));
      expect(await applyPass3('reviewing a job posting', db)).toBe('reviewing a job posting');
    });

    it('returns null when the completion has no parseable array (→ withhold)', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'I cannot help with that.' } }] }),
        })) as unknown as typeof fetch,
      );
      expect(await applyPass3('researching Acme', db)).toBeNull();
    });

    it('returns null on HTTP error (→ caller withholds)', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch,
      );
      expect(await applyPass3('researching Acme MI300 launch', db)).toBeNull();
    });

    it('returns null when over the daily budget', async () => {
      process.env.PORTKEY_API_KEY = 'pk-test';
      setBudget(db, '0.0001'); // below the per-call estimate
      const fetchMock = detectFetch(['Acme']);
      vi.stubGlobal('fetch', fetchMock);
      expect(await applyPass3('researching Acme MI300 launch', db)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('sanitizeForPublic with Pass 3 active', () => {
    it('chips the detected entity + returns ok=true on success', async () => {
      enablePass3(db);
      process.env.PORTKEY_API_KEY = 'pk-test';
      vi.stubGlobal('fetch', detectFetch(['Acme', 'MI300']));

      const res = await sanitizeForPublic('building rubric for the Acme MI300 tech screen', { db });
      expect(res.ok).toBe(true);
      expect(res.text).toContain('[AI_REDACTED]');
      expect(res.text).not.toContain('Acme');
      expect(res.text).not.toContain('MI300');
    });

    it('WITHHOLDS (ok=false) on Pass 3 failure, returning the deterministic text', async () => {
      enablePass3(db);
      process.env.PORTKEY_API_KEY = 'pk-test';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch,
      );

      const res = await sanitizeForPublic('building rubric for the tech screen', { db });
      expect(res.ok).toBe(false);
      // text is still the deterministic Pass 1+2 result (caller withholds it)
      expect(typeof res.text).toBe('string');
    });
  });
});
