/**
 * Unit tests for the dev inspector backend (Sub-milestone 24.42b).
 *
 * Covers the load-bearing guards: the write allow-list + per-knob validation
 * (DoD #3), the onboarding-progress projection, and the DB-bound builders
 * (knobs read, sim-state join, preference persistence). The HTTP-level
 * `ENVIRONMENT==='dev'` 404 gate (DoD #1) is in dev-inspector-api.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getConfig } from '../../get-config.js';
import type { CandidateProfile } from '../career-pilot/render-persona.js';
import { SIM_KNOB_KEYS } from '../career-pilot/recruiter-sim/knobs.js';
import type { SimApp, SimState } from '../career-pilot/recruiter-sim/types.js';

import {
  applyKnobWrite,
  buildDevKnobs,
  buildDevState,
  computeOnboardingProgress,
  DEV_INSPECTOR_WRITABLE_KEYS,
  ONBOARDING_FIELD_ORDER,
  validateKnobWrite,
} from './dev-inspector.js';

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

function makeProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
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
    why_this_exists: null,
    headshot_path: null,
    brand_color_hsl: null,
    gmail_account: null,
    updated_at: '2026-06-05T00:00:00Z',
    ...overrides,
  };
}

function makeSimApp(overrides: Partial<SimApp> = {}): SimApp {
  return {
    appId: 'sim-app-1',
    company: 'Meridian Labs',
    role: 'Senior Software Engineer',
    obfuscatedLabel: 'ai-a',
    fromName: 'Meridian Labs Talent',
    fromAddress: 'talent@meridianlabs.example',
    threadId: null,
    lastMessageId: null,
    stageIndex: 1,
    status: 'active',
    outcome: null,
    createdAtMs: 1_000,
    nextFireAtMs: 2_000,
    realCursorMs: 1_500,
    ...overrides,
  };
}

// ── the write allow-list ──────────────────────────────────────────────────────

describe('DEV_INSPECTOR_WRITABLE_KEYS', () => {
  it('contains every recruiter-sim knob', () => {
    for (const key of SIM_KNOB_KEYS) {
      expect(DEV_INSPECTOR_WRITABLE_KEYS).toContain(key);
    }
  });

  it('contains the dev-loop pacing + budget + polling keys the owner asked for', () => {
    for (const key of [
      'funnel_curator_cron',
      'close_detection_cron',
      'killer_match_cron',
      'daily_briefing_time',
      'owner_daily_llm_budget_usd',
      'sandbox_daily_global_budget_usd',
      'gmail_poll_interval_sec',
      'calendar_poll_interval_sec',
    ]) {
      expect(DEV_INSPECTOR_WRITABLE_KEYS).toContain(key);
    }
  });
});

// ── validateKnobWrite (pure) ──────────────────────────────────────────────────

describe('validateKnobWrite', () => {
  it('refuses keys outside the allow-list', () => {
    expect(validateKnobWrite('live_mode', true).ok).toBe(false);
    expect(validateKnobWrite('portal_api_port', 9999).ok).toBe(false);
    expect(validateKnobWrite('definitely_not_a_key', 1).ok).toBe(false);
  });

  it('coerces booleans (native + string forms)', () => {
    expect(validateKnobWrite('recruiter_sim_enabled', true)).toMatchObject({ ok: true, stored: 'true', value: true });
    expect(validateKnobWrite('recruiter_sim_enabled', 'false')).toMatchObject({ ok: true, stored: 'false' });
    expect(validateKnobWrite('recruiter_sim_enabled', 'nope').ok).toBe(false);
  });

  it('validates number type, range, and integer-ness', () => {
    expect(validateKnobWrite('recruiter_sim_max_concurrent', 3)).toMatchObject({ ok: true, stored: '3', value: 3 });
    expect(validateKnobWrite('recruiter_sim_max_concurrent', 3.5).ok).toBe(false); // integer-only
    expect(validateKnobWrite('recruiter_sim_max_concurrent', 999).ok).toBe(false); // > max 100
    expect(validateKnobWrite('recruiter_sim_offer_probability', 0.3)).toMatchObject({ ok: true });
    expect(validateKnobWrite('recruiter_sim_offer_probability', 1.5).ok).toBe(false); // > max 1
    expect(validateKnobWrite('recruiter_sim_offer_probability', '0.4')).toMatchObject({ ok: true, value: 0.4 });
    expect(validateKnobWrite('gmail_poll_interval_sec', 5).ok).toBe(false); // < min 10
    expect(validateKnobWrite('recruiter_sim_tick_interval_sec', 'abc').ok).toBe(false);
  });

  it('validates cron expressions structurally', () => {
    expect(validateKnobWrite('funnel_curator_cron', '*/2 * * * *')).toMatchObject({ ok: true, value: '*/2 * * * *' });
    expect(validateKnobWrite('daily_briefing_time', '0 8 * * *')).toMatchObject({ ok: true });
    expect(validateKnobWrite('funnel_curator_cron', 'not a cron').ok).toBe(false);
    expect(validateKnobWrite('funnel_curator_cron', '* * * *').ok).toBe(false); // 4 fields
    expect(validateKnobWrite('funnel_curator_cron', 42).ok).toBe(false); // not a string
  });
});

// ── applyKnobWrite (persists to the preferences tier) ─────────────────────────

describe('applyKnobWrite', () => {
  it('persists a valid write so getConfig reflects it', () => {
    expect(getConfig<boolean>(getDb(), 'recruiter_sim_enabled')).toBe(false);
    const out = applyKnobWrite(getDb(), { key: 'recruiter_sim_enabled', value: true });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ key: 'recruiter_sim_enabled', value: true, applied: true });
    expect(getConfig<boolean>(getDb(), 'recruiter_sim_enabled')).toBe(true);
  });

  it('persists a number and a cron', () => {
    applyKnobWrite(getDb(), { key: 'recruiter_sim_tick_interval_sec', value: 7 });
    expect(getConfig<number>(getDb(), 'recruiter_sim_tick_interval_sec')).toBe(7);
    applyKnobWrite(getDb(), { key: 'funnel_curator_cron', value: '*/3 * * * *' });
    expect(getConfig<string>(getDb(), 'funnel_curator_cron')).toBe('*/3 * * * *');
  });

  it('rejects an unknown key without writing (400)', () => {
    const out = applyKnobWrite(getDb(), { key: 'live_mode', value: true });
    expect(out.status).toBe(400);
    const row = getDb().prepare("SELECT value FROM preferences WHERE key = 'live_mode'").get();
    expect(row).toBeUndefined();
  });

  it('rejects an out-of-range value without writing (400)', () => {
    const out = applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', value: 999 });
    expect(out.status).toBe(400);
    expect(getConfig<number>(getDb(), 'recruiter_sim_max_concurrent')).toBe(8); // unchanged default
  });

  it('rejects malformed bodies (400)', () => {
    expect(applyKnobWrite(getDb(), null).status).toBe(400);
    expect(applyKnobWrite(getDb(), 'nope').status).toBe(400);
    expect(applyKnobWrite(getDb(), { value: 1 }).status).toBe(400); // missing key
  });
});

// ── buildDevKnobs ─────────────────────────────────────────────────────────────

describe('buildDevKnobs', () => {
  it('returns one entry per writable key with current value + metadata', () => {
    const { knobs } = buildDevKnobs(getDb());
    expect(knobs).toHaveLength(DEV_INSPECTOR_WRITABLE_KEYS.length);
    const enabled = knobs.find((k) => k.key === 'recruiter_sim_enabled');
    expect(enabled).toMatchObject({ type: 'boolean', group: 'sim', value: false });
    const cron = knobs.find((k) => k.key === 'funnel_curator_cron');
    expect(cron).toMatchObject({ type: 'cron', group: 'pacing' });
    expect(cron?.note).toBeTruthy();
  });

  it('reflects a persisted override', () => {
    applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', value: 2 });
    const { knobs } = buildDevKnobs(getDb());
    expect(knobs.find((k) => k.key === 'recruiter_sim_max_concurrent')?.value).toBe(2);
  });
});

// ── buildDevState ─────────────────────────────────────────────────────────────

describe('buildDevState', () => {
  it('joins sim apps to their seeded applications rows', () => {
    getDb()
      .prepare(
        `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, applied_at, created_at)
         VALUES ('sim-app-1', 'Meridian Labs', 'ai-a', 'Senior Software Engineer', 'screening', '2026-05-09T00:00:00Z', '2026-05-09T00:00:00Z')`,
      )
      .run();
    const state: SimState = { apps: [makeSimApp({ appId: 'sim-app-1' })], lastSeedAtMs: 12_345 };

    const out = buildDevState(getDb(), state);
    expect(out.enabled).toBe(false);
    expect(out.lastSeedAtMs).toBe(12_345);
    expect(out.apps).toHaveLength(1);
    expect(out.applications).toHaveLength(1);
    expect(out.applications[0]).toMatchObject({ id: 'sim-app-1', status: 'screening' });
  });

  it('handles empty state without querying', () => {
    const out = buildDevState(getDb(), { apps: [], lastSeedAtMs: 0 });
    expect(out.apps).toEqual([]);
    expect(out.applications).toEqual([]);
  });
});

// ── computeOnboardingProgress ─────────────────────────────────────────────────

describe('computeOnboardingProgress', () => {
  it('reports nothing filled (and full_name next) for a null profile', () => {
    const p = computeOnboardingProgress(null);
    expect(p.filledCount).toBe(0);
    expect(p.totalCount).toBe(ONBOARDING_FIELD_ORDER.length);
    expect(p.complete).toBe(false);
    expect(p.nextField).toBe('full_name');
  });

  it('tracks partial progress in interview order', () => {
    const p = computeOnboardingProgress(makeProfile({ full_name: 'Jane Doe', target_roles: '["Backend Engineer"]' }));
    expect(p.filledCount).toBe(2);
    expect(p.complete).toBe(false);
    expect(p.nextField).toBe('comp_floor');
    expect(p.fields.find((f) => f.field === 'target_roles')?.filled).toBe(true);
  });

  it('treats an empty target_roles array as unfilled', () => {
    const p = computeOnboardingProgress(makeProfile({ full_name: 'Jane Doe', target_roles: '[]' }));
    expect(p.fields.find((f) => f.field === 'target_roles')?.filled).toBe(false);
    expect(p.nextField).toBe('target_roles');
  });

  it('marks complete when every onboarding field is populated', () => {
    const p = computeOnboardingProgress(
      makeProfile({
        full_name: 'Jane Doe',
        target_roles: '["Backend Engineer"]',
        comp_floor: 180000,
        master_resume: 'resume text',
        bio: 'bio text',
        why_this_exists: 'because',
      }),
    );
    expect(p.complete).toBe(true);
    expect(p.nextField).toBeNull();
    expect(p.filledCount).toBe(ONBOARDING_FIELD_ORDER.length);
  });
});
