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
const rationaleOf = (id: string) =>
  (
    getDb().prepare('SELECT win_confidence_rationale FROM applications WHERE id = ?').get(id) as {
      win_confidence_rationale: string | null;
    }
  ).win_confidence_rationale;

describe('scoreWinConfidence', () => {
  it('zeroes closed apps deterministically + scores active apps from the LLM', async () => {
    seedApp('a-offer', 'OFFER');
    seedApp('a-screen', 'SCREENING');
    seedApp('a-reject', 'REJECTED');
    mockPortkey(
      'Sure: {"a-offer": {"score": 97, "reason": "Offer extended — essentially decided."}, "a-screen": {"score": 40, "reason": "Just a screen invite; early days."}}',
    );

    const res = await scoreWinConfidence(getDb());

    expect(winOf('a-offer')).toBe(97);
    expect(rationaleOf('a-offer')).toContain('Offer extended');
    expect(winOf('a-screen')).toBe(40);
    expect(rationaleOf('a-screen')).toContain('screen invite');
    expect(winOf('a-reject')).toBe(0); // closed → 0, no LLM
    expect(rationaleOf('a-reject')).toContain('closed'); // deterministic closed rationale
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
    mockPortkey('{"a1": {"score": 150, "reason": "very strong"}, "a2": {"score": "n/a", "reason": "unknown"}}');
    await scoreWinConfidence(getDb());
    expect(winOf('a1')).toBe(100); // clamped
    expect(winOf('a2')).toBeNull(); // non-numeric score → left unchanged
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

  it('blends fit (candidate profile + the role JD) with momentum in the prompt', async () => {
    getDb()
      .prepare(
        'INSERT INTO candidate_profile (id, target_roles, skills, comp_floor, updated_at) VALUES (1, \'["Staff Software Engineer"]\', \'["Go","Kubernetes"]\', 180000, datetime(\'now\'))',
      )
      .run();
    getDb()
      .prepare(
        "INSERT INTO applications (id, company_name, obfuscated_label, public_state, role_title, jd_text, status, applied_at, last_activity_at, created_at) VALUES ('a1','Co','ai-a','obfuscated','Platform Engineer','Kubernetes, IaC, distributed systems','SCREENING',datetime('now'),datetime('now'),datetime('now'))",
      )
      .run();

    let body = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, opts?: { body?: string }) => {
        body = String(opts?.body ?? '');
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: '{"a1": {"score": 58, "reason": "Strong fit on Kubernetes; momentum at screening."}}',
                },
              },
            ],
          }),
        } as unknown as Response;
      }),
    );

    await scoreWinConfidence(getDb());
    expect(body).toContain('Staff Software Engineer'); // candidate target role → the fit prior
    expect(body).toContain('Kubernetes'); // candidate skill + the JD ask → fit
    expect(body).toContain('SCREENING'); // the stage → momentum
    expect(winOf('a1')).toBe(58);
    expect(rationaleOf('a1')).toContain('fit');
  });
});
