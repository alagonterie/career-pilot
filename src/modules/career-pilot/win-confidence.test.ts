import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { scoreWinConfidence } from './win-confidence.js';

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
  process.env.PORTKEY_API_KEY = 'pk-test';
  delete process.env.PORTKEY_BYPASS;
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  delete process.env.PORTKEY_API_KEY;
});

function seedApp(id: string, status: string): void {
  getDb()
    .prepare(
      `INSERT INTO applications
         (id, company_name, obfuscated_label, public_state, role_title, status, applied_at, last_activity_at, created_at)
       VALUES (?, ?, ?, 'obfuscated', 'Engineer', ?, datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(id, `Co ${id}`, `ai-${id}`, status);
}

function mockPortkey(content: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response,
    ),
  );
}

const winOf = (id: string) =>
  (getDb().prepare('SELECT win_confidence FROM applications WHERE id = ?').get(id) as { win_confidence: number | null })
    .win_confidence;

describe('scoreWinConfidence', () => {
  it('zeroes closed apps deterministically + scores active apps from the LLM', async () => {
    seedApp('a-offer', 'OFFER');
    seedApp('a-screen', 'SCREENING');
    seedApp('a-reject', 'REJECTED');
    mockPortkey('Sure: {"a-offer": 97, "a-screen": 40}');

    const res = await scoreWinConfidence(getDb());

    expect(winOf('a-offer')).toBe(97);
    expect(winOf('a-screen')).toBe(40);
    expect(winOf('a-reject')).toBe(0); // closed → 0, no LLM
    expect(res).toEqual({ scored: 2, closed: 1 });
    // the closed app is projected into the board too
    const view = getDb()
      .prepare('SELECT win_confidence FROM public_funnel_view WHERE application_id = ?')
      .get('a-reject') as { win_confidence: number };
    expect(view.win_confidence).toBe(0);
  });

  it('clamps out-of-range scores + ignores non-numeric ones', async () => {
    seedApp('a1', 'FINAL');
    seedApp('a2', 'APPLIED');
    mockPortkey('{"a1": 150, "a2": "n/a"}');
    await scoreWinConfidence(getDb());
    expect(winOf('a1')).toBe(100); // clamped
    expect(winOf('a2')).toBeNull(); // non-numeric → left unchanged
  });

  it('leaves scores unchanged when Portkey is not configured (best-effort)', async () => {
    delete process.env.PORTKEY_API_KEY;
    seedApp('a1', 'SCREENING');
    const res = await scoreWinConfidence(getDb());
    expect(res.scored).toBe(0);
    expect(winOf('a1')).toBeNull();
  });

  it('leaves active scores unchanged on an LLM failure, but still zeroes closed apps', async () => {
    seedApp('a-screen', 'SCREENING');
    seedApp('a-reject', 'REJECTED');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
    );
    const res = await scoreWinConfidence(getDb());
    expect(winOf('a-screen')).toBeNull(); // LLM failed → unchanged
    expect(winOf('a-reject')).toBe(0); // closed zeroing runs before the LLM
    expect(res).toEqual({ scored: 0, closed: 1 });
  });
});
