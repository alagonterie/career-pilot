/**
 * Integration tests for the gated dev inspector endpoints (Sub-milestone 24.42b).
 *
 * The non-negotiable guard (DoD #1): every `/api/dev/*` route returns 404 unless
 * `ENVIRONMENT==='dev'` — so the candidate's real PII (served by
 * `/api/dev/persona`) is unreachable on a non-dev (public) stack. `isDevEnv()`
 * is read at request time, so the same running server flips behaviour with the
 * env var (mirrors the live-toggle semantics).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { startPortalApi, stopPortalApi } from './api.js';

let base: string;
const savedEnv = process.env.ENVIRONMENT;

beforeEach(async () => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await stopPortalApi();
  closeDb();
  if (savedEnv === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = savedEnv;
});

async function postKnob(body: unknown): Promise<Response> {
  return fetch(`${base}/api/dev/knobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postReset(body: unknown): Promise<Response> {
  return fetch(`${base}/api/dev/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/dev/* — hard gate (ENVIRONMENT !== "dev")', () => {
  beforeEach(() => {
    delete process.env.ENVIRONMENT;
  });

  it('404s every dev endpoint on a non-dev stack', async () => {
    for (const p of ['/api/dev/state', '/api/dev/knobs', '/api/dev/persona']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
    }
    const post = await postKnob({ key: 'recruiter_sim_enabled', value: true });
    expect(post.status).toBe(404);
    const reset = await postReset({ scope: 'everything' });
    expect(reset.status).toBe(404); // reset is invisible off the dev stack too
  });

  it('also 404s when ENVIRONMENT is production', async () => {
    process.env.ENVIRONMENT = 'production';
    const res = await fetch(`${base}/api/dev/persona`);
    expect(res.status).toBe(404);
  });
});

describe('/api/dev/* — on the dev stack', () => {
  beforeEach(() => {
    process.env.ENVIRONMENT = 'dev';
  });

  it('GET /api/dev/knobs returns the writable knob set', async () => {
    const res = await fetch(`${base}/api/dev/knobs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { knobs: Array<{ key: string }> };
    expect(Array.isArray(body.knobs)).toBe(true);
    expect(body.knobs.some((k) => k.key === 'recruiter_sim_enabled')).toBe(true);
    expect(body.knobs.some((k) => k.key === 'pipeline_scribe_cron')).toBe(true);
  });

  it('GET /api/dev/state returns sim state + applications arrays', async () => {
    const res = await fetch(`${base}/api/dev/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; apps: unknown[]; applications: unknown[] };
    expect(body).toHaveProperty('enabled');
    expect(Array.isArray(body.apps)).toBe(true);
    expect(Array.isArray(body.applications)).toBe(true);
  });

  it('GET /api/dev/persona returns the onboarding sentinel for an empty profile', async () => {
    const res = await fetch(`${base}/api/dev/persona`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profile: unknown;
      candidateMd: string;
      onboarding: { nextField: string | null; complete: boolean };
    };
    expect(body.profile).toBeNull();
    expect(body.onboarding.nextField).toBe('full_name');
    expect(body.onboarding.complete).toBe(false);
    expect(typeof body.candidateMd).toBe('string');
  });

  it('POST /api/dev/knobs persists a valid knob, reflected on the next read', async () => {
    const ok = await postKnob({ key: 'recruiter_sim_max_concurrent', value: 2 });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { applied: boolean; value: number };
    expect(body).toMatchObject({ applied: true, value: 2 });

    const after = (await (await fetch(`${base}/api/dev/knobs`)).json()) as {
      knobs: Array<{ key: string; value: unknown }>;
    };
    expect(after.knobs.find((k) => k.key === 'recruiter_sim_max_concurrent')?.value).toBe(2);
  });

  it('POST /api/dev/knobs rejects a non-allow-listed key (400)', async () => {
    const res = await postKnob({ key: 'live_mode', value: true });
    expect(res.status).toBe(400);
  });

  it('POST /api/dev/knobs rejects an out-of-range value (400)', async () => {
    const res = await postKnob({ key: 'recruiter_sim_max_concurrent', value: 999 });
    expect(res.status).toBe(400);
  });

  it('POST /api/dev/reset { scope: "pipeline-data" } returns 200 with the cleared shape', async () => {
    const res = await postReset({ scope: 'pipeline-data' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string; cleared: Record<string, number>; halted: boolean };
    expect(body.scope).toBe('pipeline-data');
    expect(body.halted).toBe(false);
    expect(typeof body.cleared).toBe('object');
  });

  it('POST /api/dev/reset rejects an unknown scope + an ambiguous body (400)', async () => {
    expect((await postReset({ scope: 'nuke-everything' })).status).toBe(400);
    expect((await postReset({ scope: 'profile', field: 'bio' })).status).toBe(400);
    expect((await postReset({})).status).toBe(400);
  });
});
