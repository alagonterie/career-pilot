/**
 * Unit tests for the dev inspector backend (Sub-milestone 24.42b).
 *
 * Covers the load-bearing guards: the write allow-list + per-knob validation
 * (DoD #3), the onboarding-progress projection, and the DB-bound builders
 * (knobs read, sim-state join, preference persistence). The HTTP-level
 * `ENVIRONMENT==='dev'` 404 gate (DoD #1) is in dev-inspector-api.test.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { getConfig } from '../../get-config.js';
import { inboundDbPath, sessionsBaseDir } from '../../session-manager.js';
import { OPS_THREAD_ID } from '../career-pilot/ops-session.js';
import type { CandidateProfile } from '../career-pilot/render-persona.js';
import { SIM_KNOB_KEYS } from '../career-pilot/recruiter-sim/knobs.js';
import type { SimApp, SimState } from '../career-pilot/recruiter-sim/types.js';

import {
  applyDevControl,
  applyDevReset,
  applyDevSweep,
  applyKnobWrite,
  buildDevKnobs,
  buildDevState,
  computeOnboardingProgress,
  DEV_INSPECTOR_WRITABLE_KEYS,
  enqueueSweepTask,
  ONBOARDING_FIELD_ORDER,
  simUpcoming,
  validateKnobWrite,
} from './dev-inspector.js';
import { getPauseState } from './system-modes.js';

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
    search_goals: null,
    headshot_path: null,
    brand_color_hsl: null,
    gmail_account: null,
    protected_terms: null,
    work_profile_json: null,
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
      'pipeline_scribe_cron',
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
    expect(validateKnobWrite('recruiter_sim_daily_budget_usd', 'abc').ok).toBe(false);
  });

  it('validates cron expressions structurally', () => {
    expect(validateKnobWrite('pipeline_scribe_cron', '*/2 * * * *')).toMatchObject({ ok: true, value: '*/2 * * * *' });
    expect(validateKnobWrite('daily_briefing_time', '0 8 * * *')).toMatchObject({ ok: true });
    expect(validateKnobWrite('pipeline_scribe_cron', 'not a cron').ok).toBe(false);
    expect(validateKnobWrite('pipeline_scribe_cron', '* * * *').ok).toBe(false); // 4 fields
    expect(validateKnobWrite('pipeline_scribe_cron', 42).ok).toBe(false); // not a string
  });

  it('validates an enum against its options (sandbox_orchestrator_model)', () => {
    expect(validateKnobWrite('sandbox_orchestrator_model', 'claude-haiku-4-5')).toMatchObject({
      ok: true,
      stored: 'claude-haiku-4-5',
      value: 'claude-haiku-4-5',
    });
    expect(validateKnobWrite('sandbox_orchestrator_model', 'claude-sonnet-4-6')).toMatchObject({ ok: true });
    expect(validateKnobWrite('sandbox_orchestrator_model', 'gpt-5').ok).toBe(false); // not an allowed option
    expect(validateKnobWrite('sandbox_orchestrator_model', 42).ok).toBe(false); // not a string
  });

  it('validates the recruiter-sim enum toggles (job source + pace)', () => {
    expect(validateKnobWrite('recruiter_sim_job_source', 'real')).toMatchObject({ ok: true, value: 'real' });
    expect(validateKnobWrite('recruiter_sim_job_source', 'synthetic')).toMatchObject({ ok: true });
    expect(validateKnobWrite('recruiter_sim_job_source', 'bogus').ok).toBe(false);
    expect(validateKnobWrite('recruiter_sim_pace', 'realistic')).toMatchObject({ ok: true, value: 'realistic' });
    expect(validateKnobWrite('recruiter_sim_pace', 'fast')).toMatchObject({ ok: true });
    expect(validateKnobWrite('recruiter_sim_pace', 'turbo').ok).toBe(false);
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
    applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', value: 5 });
    expect(getConfig<number>(getDb(), 'recruiter_sim_max_concurrent')).toBe(5);
    applyKnobWrite(getDb(), { key: 'pipeline_scribe_cron', value: '*/3 * * * *' });
    expect(getConfig<string>(getDb(), 'pipeline_scribe_cron')).toBe('*/3 * * * *');
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

// ── reset to default ──────────────────────────────────────────────────────────

describe('applyKnobWrite — reset', () => {
  it('{ key, reset } deletes the override so the value falls back to the default', () => {
    applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', value: 2 });
    expect(getConfig<number>(getDb(), 'recruiter_sim_max_concurrent')).toBe(2);

    const out = applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', reset: true });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ key: 'recruiter_sim_max_concurrent', reset: true, value: 8 });
    expect(getConfig<number>(getDb(), 'recruiter_sim_max_concurrent')).toBe(8); // back to defaults.json
    const row = getDb().prepare("SELECT value FROM preferences WHERE key = 'recruiter_sim_max_concurrent'").get();
    expect(row).toBeUndefined(); // the override row is gone
  });

  it('refuses to reset a non-allow-listed key (400)', () => {
    expect(applyKnobWrite(getDb(), { key: 'live_mode', reset: true }).status).toBe(400);
  });

  it('{ resetAll } clears every writable override but leaves non-writable prefs intact', () => {
    applyKnobWrite(getDb(), { key: 'recruiter_sim_enabled', value: true });
    applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', value: 2 });
    // a non-writable preference the page must never touch
    getDb()
      .prepare("INSERT INTO preferences (key, value, updated_at) VALUES ('portal_api_port', '3002', datetime('now'))")
      .run();

    const out = applyKnobWrite(getDb(), { resetAll: true });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ resetAll: true });
    expect(getConfig<boolean>(getDb(), 'recruiter_sim_enabled')).toBe(false); // default
    expect(getConfig<number>(getDb(), 'recruiter_sim_max_concurrent')).toBe(8); // default
    // the non-writable pref survives
    const row = getDb().prepare("SELECT value FROM preferences WHERE key = 'portal_api_port'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('3002');
  });
});

// ── buildDevKnobs ─────────────────────────────────────────────────────────────

describe('buildDevKnobs', () => {
  it('returns one entry per writable key with current value + metadata', () => {
    const { knobs } = buildDevKnobs(getDb());
    expect(knobs).toHaveLength(DEV_INSPECTOR_WRITABLE_KEYS.length);
    const enabled = knobs.find((k) => k.key === 'recruiter_sim_enabled');
    expect(enabled).toMatchObject({ type: 'boolean', group: 'sim', value: false });
    const cron = knobs.find((k) => k.key === 'pipeline_scribe_cron');
    expect(cron).toMatchObject({ type: 'cron', group: 'curator' });
    expect(cron?.note).toBeTruthy();
  });

  it('reflects a persisted override', () => {
    applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', value: 2 });
    const { knobs } = buildDevKnobs(getDb());
    expect(knobs.find((k) => k.key === 'recruiter_sim_max_concurrent')?.value).toBe(2);
  });

  it('exposes each knob default + tracks overridden across write/reset', () => {
    const before = buildDevKnobs(getDb()).knobs.find((k) => k.key === 'recruiter_sim_max_concurrent');
    expect(before).toMatchObject({ default: 8, overridden: false });

    applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', value: 2 });
    const after = buildDevKnobs(getDb()).knobs.find((k) => k.key === 'recruiter_sim_max_concurrent');
    expect(after).toMatchObject({ value: 2, default: 8, overridden: true });

    applyKnobWrite(getDb(), { key: 'recruiter_sim_max_concurrent', reset: true });
    const reset = buildDevKnobs(getDb()).knobs.find((k) => k.key === 'recruiter_sim_max_concurrent');
    expect(reset).toMatchObject({ value: 8, overridden: false });
  });

  it('exposes the §24.67 sessions knobs with write validation', () => {
    const db = getDb();
    const sessionKeys = buildDevKnobs(db)
      .knobs.filter((k) => k.group === 'sessions')
      .map((k) => k.key)
      .sort();
    expect(sessionKeys).toEqual([
      'container_idle_timeout_sec', // §24.96 — the (chat) idle-container ceiling
      'container_orphan_reap_grace_sec', // §24.112 — the orphan reaper
      'ops_container_idle_timeout_sec', // §24.114 — the short ops ceiling
      'ops_mirror_to_chat',
      'ops_transcript_rotate_age_days',
      'ops_transcript_rotate_bytes',
    ]);

    expect(applyKnobWrite(db, { key: 'ops_transcript_rotate_bytes', value: 1_048_576 }).status).toBe(200);
    expect(getConfig<number>(db, 'ops_transcript_rotate_bytes')).toBe(1_048_576);
    expect(applyKnobWrite(db, { key: 'ops_transcript_rotate_bytes', value: 1024 }).status).toBe(400); // below min
    expect(applyKnobWrite(db, { key: 'ops_mirror_to_chat', value: false }).status).toBe(200);
    expect(getConfig<boolean>(db, 'ops_mirror_to_chat')).toBe(false);
    expect(applyKnobWrite(db, { key: 'ops_transcript_rotate_age_days', reset: true }).status).toBe(200);
  });

  it('exposes the chat + ops idle-container ceiling knobs (§24.96/§24.114), write-validated', () => {
    const db = getDb();
    const chat = buildDevKnobs(db).knobs.find((k) => k.key === 'container_idle_timeout_sec');
    expect(chat).toMatchObject({ default: 600, group: 'sessions', type: 'number' }); // 10 min
    const ops = buildDevKnobs(db).knobs.find((k) => k.key === 'ops_container_idle_timeout_sec');
    expect(ops).toMatchObject({ default: 60, group: 'sessions', type: 'number' }); // short ops ceiling

    expect(applyKnobWrite(db, { key: 'container_idle_timeout_sec', value: 900 }).status).toBe(200);
    expect(getConfig<number>(db, 'container_idle_timeout_sec')).toBe(900);
    expect(applyKnobWrite(db, { key: 'container_idle_timeout_sec', value: 30 }).status).toBe(400); // below the 60s min
    expect(applyKnobWrite(db, { key: 'ops_container_idle_timeout_sec', value: 90 }).status).toBe(200);
    expect(getConfig<number>(db, 'ops_container_idle_timeout_sec')).toBe(90);
  });

  it('exposes the §24.68 telemetry knobs with write validation', () => {
    const db = getDb();
    const telemetryKeys = buildDevKnobs(db)
      .knobs.filter((k) => k.group === 'telemetry')
      .map((k) => k.key)
      .sort();
    // §24.138: the health_* knobs moved to their own 'health' group (below); the
    // 'telemetry' group is now capture + the retention/prune pairs.
    expect(telemetryKeys).toEqual([
      'owner_subagent_trace_emit_enabled',
      'request_telemetry_prune_interval_sec',
      'request_telemetry_retention_days',
      'telemetry_capture',
      'visit_telemetry_prune_interval_sec',
      'visit_telemetry_retention_days',
    ]);

    expect(applyKnobWrite(db, { key: 'request_telemetry_retention_days', value: 7 }).status).toBe(200);
    expect(getConfig<number>(db, 'request_telemetry_retention_days')).toBe(7);
    expect(applyKnobWrite(db, { key: 'request_telemetry_retention_days', value: 0 }).status).toBe(400); // below min
    expect(applyKnobWrite(db, { key: 'telemetry_capture', value: false }).status).toBe(200);
    expect(getConfig<boolean>(db, 'telemetry_capture')).toBe(false);
    expect(applyKnobWrite(db, { key: 'telemetry_capture', reset: true }).status).toBe(200);
    expect(getConfig<boolean>(db, 'telemetry_capture')).toBe(true); // back to the default
  });

  it('exposes the §24.138 health knobs as their own group, write-validated', () => {
    const db = getDb();
    const healthKeys = buildDevKnobs(db)
      .knobs.filter((k) => k.group === 'health')
      .map((k) => k.key)
      .sort();
    expect(healthKeys).toEqual([
      'health_cascade_silent_window_hours',
      'health_check_interval_sec',
      'health_failure_streak_threshold',
      'health_orphan_response_warn_count',
      'health_outbound_backlog_warn_count',
      'health_series_overdue_threshold_sec',
      'health_stale_pending_threshold_sec',
      'health_surface_stale_hours',
    ]);

    expect(applyKnobWrite(db, { key: 'health_check_interval_sec', value: 59 }).status).toBe(400); // below min 60
    expect(applyKnobWrite(db, { key: 'health_check_interval_sec', value: 7200 }).status).toBe(200);
    expect(getConfig<number>(db, 'health_check_interval_sec')).toBe(7200);
    expect(applyKnobWrite(db, { key: 'health_failure_streak_threshold', value: 5 }).status).toBe(200);
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
    // makeSimApp is at stageIndex 1 → the next email it has queued is screen_invite.
    expect(out.apps[0]).toMatchObject({ appId: 'sim-app-1', upcoming: 'screen_invite', totalStages: 4 });
    expect(out.applications).toHaveLength(1);
    expect(out.applications[0]).toMatchObject({ id: 'sim-app-1', status: 'screening' });
  });

  it('handles empty state without querying', () => {
    const out = buildDevState(getDb(), { apps: [], lastSeedAtMs: 0 });
    expect(out.apps).toEqual([]);
    expect(out.applications).toEqual([]);
  });

  it('drops a sidecar app whose applications row is gone (post-reset display reconcile, §24.48)', () => {
    // One sim app has a live DB row; the other is an orphan (its row was cleared by
    // a reset) — the panel must show only the live one, matching runOneTick's reconcile.
    getDb()
      .prepare(
        `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, applied_at, created_at)
         VALUES ('sim-app-1', 'Meridian Labs', 'ai-a', 'Senior Software Engineer', 'screening', '2026-05-09T00:00:00Z', '2026-05-09T00:00:00Z')`,
      )
      .run();
    const state: SimState = {
      apps: [makeSimApp({ appId: 'sim-app-1' }), makeSimApp({ appId: 'orphan-app' })],
      lastSeedAtMs: 5,
    };

    const out = buildDevState(getDb(), state);
    expect(out.apps.map((a) => a.appId)).toEqual(['sim-app-1']); // orphan dropped
    expect(out.applications).toHaveLength(1);
  });
});

// ── simUpcoming ───────────────────────────────────────────────────────────────

describe('simUpcoming', () => {
  it('maps an active stageIndex to the next queued classification', () => {
    expect(simUpcoming(makeSimApp({ stageIndex: 0 }))).toBe('application_confirmation');
    expect(simUpcoming(makeSimApp({ stageIndex: 1 }))).toBe('screen_invite');
    expect(simUpcoming(makeSimApp({ stageIndex: 2 }))).toBe('onsite_invite');
  });

  it('reports the terminal decision once past the linear stages', () => {
    expect(simUpcoming(makeSimApp({ stageIndex: 4 }))).toContain('final decision');
  });

  it('reports the end state for a ghosted or closed app', () => {
    expect(simUpcoming(makeSimApp({ status: 'ghosted' }))).toContain('ghosted');
    expect(simUpcoming(makeSimApp({ status: 'closed', outcome: 'offer' }))).toContain('offer');
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

  it('asks for location_pref after comp_floor, and treats an empty {} as unfilled', () => {
    const base = { full_name: 'Jane Doe', target_roles: '["Backend Engineer"]', comp_floor: 180000 };
    // comp_floor filled but location_pref absent → location_pref is next.
    expect(computeOnboardingProgress(makeProfile(base)).nextField).toBe('location_pref');
    // an empty object is not a populated preference.
    expect(computeOnboardingProgress(makeProfile({ ...base, location_pref: '{}' })).nextField).toBe('location_pref');
    // a real object fills it → next is master_resume.
    expect(
      computeOnboardingProgress(makeProfile({ ...base, location_pref: '{"remote":true,"cities":["NYC"]}' })).nextField,
    ).toBe('master_resume');
  });

  it('marks complete when every onboarding field is populated', () => {
    const p = computeOnboardingProgress(
      makeProfile({
        full_name: 'Jane Doe',
        target_roles: '["Backend Engineer"]',
        comp_floor: 180000,
        location_pref: '{"remote":true,"cities":["NYC"]}',
        master_resume: 'resume text',
        bio: 'bio text',
        search_goals: 'because',
      }),
    );
    expect(p.complete).toBe(true);
    expect(p.nextField).toBeNull();
    expect(p.filledCount).toBe(ONBOARDING_FIELD_ORDER.length);
  });
});

describe('applyDevControl (§24.43e pause LLM spend)', () => {
  it('pause → halts (pause_state=halted) AND turns the sim off', () => {
    const db = getDb();
    applyKnobWrite(db, { key: 'recruiter_sim_enabled', value: true }); // sim on first
    const out = applyDevControl(db, { action: 'pause' });
    expect(out.status).toBe(200);
    expect((out.body as { pauseState: string; simEnabled: boolean }).pauseState).toBe('halted');
    expect((out.body as { simEnabled: boolean }).simEnabled).toBe(false);
    expect(getPauseState()).toBe('halted');
    expect(getConfig<boolean>(db, 'recruiter_sim_enabled')).toBe(false);
  });

  it('resume → back to active (sim stays off)', () => {
    const db = getDb();
    applyDevControl(db, { action: 'pause' });
    const out = applyDevControl(db, { action: 'resume' });
    expect((out.body as { pauseState: string }).pauseState).toBe('active');
    expect(getPauseState()).toBe('active');
  });

  it('rejects unknown actions + non-object bodies (400, no state change)', () => {
    const db = getDb();
    expect(applyDevControl(db, { action: 'nope' }).status).toBe(400);
    expect(applyDevControl(db, null).status).toBe(400);
    expect(applyDevControl(db, { action: 'killswitch' }).status).toBe(400); // not reachable here
    expect(getPauseState()).toBe('active'); // nothing mutated
  });
});

describe('on-demand sweep (§24.43c)', () => {
  it('enqueueSweepTask inserts a one-shot pipeline-scribe trigger row', () => {
    const tmpDir = path.join(os.tmpdir(), `nanoclaw-cp-sweep-test-${process.pid}`);
    const inboundPath = path.join(tmpDir, 'inbound.db');
    fs.mkdirSync(tmpDir, { recursive: true });
    ensureSchema(inboundPath, 'inbound');
    const inDb = openInboundDb(inboundPath);
    try {
      inDb.exec('DELETE FROM messages_in');
      const id = enqueueSweepTask(inDb);
      const row = inDb
        .prepare('SELECT kind, status, recurrence, content, series_id FROM messages_in WHERE id = ?')
        .get(id) as { kind: string; status: string; recurrence: string | null; content: string; series_id: string };
      expect(row.kind).toBe('task');
      expect(row.status).toBe('pending');
      expect(row.recurrence).toBeNull(); // one-shot — won't clone
      expect(row.series_id).toBe(id); // its own series, not 'pipeline-scribe'
      expect((JSON.parse(row.content) as { prompt: string }).prompt).toBe('[scheduled trigger: pipeline-scribe]');
    } finally {
      inDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('applyDevSweep returns 200 + converts from email_events; no owner session → not enqueued', async () => {
    const out = await applyDevSweep();
    expect(out.status).toBe(200);
    expect((out.body as { converted: number }).converted).toBe(0); // nothing seeded
    expect((out.body as { sweepEnqueued: boolean }).sweepEnqueued).toBe(false);
  });

  it('applyDevSweep does not enqueue a curator pass when the owner group has no active session', async () => {
    createAgentGroup({
      id: 'ag-owner',
      name: 'Career Pilot',
      folder: 'career-pilot',
      agent_provider: null,
      created_at: '2026-06-06T00:00:00Z',
    });
    expect(((await applyDevSweep()).body as { sweepEnqueued: boolean }).sweepEnqueued).toBe(false);
  });

  it('applyDevSweep targets the OPS session (§24.67), never the newest chat session', async () => {
    createAgentGroup({
      id: 'ag-owner',
      name: 'Career Pilot',
      folder: 'career-pilot',
      agent_provider: null,
      created_at: '2026-06-06T00:00:00Z',
    });
    const insertSession = getDb().prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, 'ag-owner', NULL, ?, NULL, 'active', 'stopped', NULL, ?)`,
    );
    insertSession.run('sess-ops', OPS_THREAD_ID, '2026-06-06T00:00:00Z');
    // Chat session is NEWER — the old findSessionByAgentGroup lookup would pick it.
    insertSession.run('sess-chat', null, '2026-06-07T00:00:00Z');

    const groupDir = path.join(sessionsBaseDir(), 'ag-owner');
    for (const sess of ['sess-ops', 'sess-chat']) {
      fs.mkdirSync(path.join(groupDir, sess), { recursive: true });
      ensureSchema(inboundDbPath('ag-owner', sess), 'inbound');
    }
    try {
      const out = await applyDevSweep();
      expect((out.body as { sweepEnqueued: boolean }).sweepEnqueued).toBe(true);

      const taskCount = (sess: string): number => {
        const db = openInboundDb(inboundDbPath('ag-owner', sess));
        try {
          return (db.prepare("SELECT count(*) AS n FROM messages_in WHERE kind = 'task'").get() as { n: number }).n;
        } finally {
          db.close();
        }
      };
      expect(taskCount('sess-ops')).toBe(1);
      expect(taskCount('sess-chat')).toBe(0);
    } finally {
      fs.rmSync(groupDir, { recursive: true, force: true });
    }
  });
});

// ── applyDevReset (§24.48) ────────────────────────────────────────────────────

describe('applyDevReset (§24.48 dev reset controls)', () => {
  function seedProfile(): void {
    getDb()
      .prepare(
        `INSERT INTO candidate_profile (id, full_name, master_resume, updated_at)
         VALUES (1, 'Jane Doe', 'master resume text', '2026-06-06T00:00:00Z')`,
      )
      .run();
  }

  function seedApplication(): void {
    getDb()
      .prepare(
        `INSERT INTO applications (id, company_name, obfuscated_label, role_title, status, applied_at, created_at)
         VALUES ('app-1', 'Meridian Labs', 'ai-a', 'Senior Software Engineer', 'screening', '2026-05-09T00:00:00Z', '2026-05-09T00:00:00Z')`,
      )
      .run();
  }

  function seedSession(): void {
    createAgentGroup({
      id: 'ag-owner',
      name: 'Career Pilot',
      folder: 'career-pilot',
      agent_provider: null,
      created_at: '2026-06-06T00:00:00Z',
    });
    getDb()
      .prepare(
        `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
         VALUES ('sess-1', 'ag-owner', NULL, NULL, NULL, 'active', 'stopped', '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')`,
      )
      .run();
  }

  const profileExists = (): boolean =>
    getDb().prepare('SELECT 1 FROM candidate_profile WHERE id = 1').get() !== undefined;
  const appCount = (): number => (getDb().prepare('SELECT count(*) AS n FROM applications').get() as { n: number }).n;
  const sessionCount = (): number => (getDb().prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;

  it("'pipeline-data' clears the board but keeps profile + sessions, no halt", () => {
    seedProfile();
    seedApplication();
    seedSession();

    const out = applyDevReset(getDb(), { scope: 'pipeline-data' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ scope: 'pipeline-data', halted: false });
    expect((out.body as { cleared: Record<string, number> }).cleared.applications).toBe(1);
    expect(appCount()).toBe(0);
    expect(profileExists()).toBe(true); // persona preserved
    expect(sessionCount()).toBe(1); // conversation preserved
    expect(getPauseState()).toBe('active'); // no halt
  });

  it("'profile' deletes the candidate_profile row (onboarding restarts), no halt, pipeline intact", () => {
    seedProfile();
    seedApplication();

    const out = applyDevReset(getDb(), { scope: 'profile' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ scope: 'profile', halted: false });
    expect((out.body as { cleared: Record<string, number> }).cleared.candidate_profile).toBe(1);
    expect(profileExists()).toBe(false);
    expect(appCount()).toBe(1); // pipeline untouched
    expect(getPauseState()).toBe('active');
  });

  it("'conversation' halts + turns the sim off + clears sessions, keeps profile", () => {
    applyKnobWrite(getDb(), { key: 'recruiter_sim_enabled', value: true });
    seedProfile();
    seedSession();

    const out = applyDevReset(getDb(), { scope: 'conversation' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ scope: 'conversation', halted: true });
    const cleared = (out.body as { cleared: Record<string, number> }).cleared;
    expect(cleared.sessions).toBe(1);
    expect(cleared).toHaveProperty('transcripts'); // dir absent in tests → 0, but present
    expect(sessionCount()).toBe(0);
    expect(profileExists()).toBe(true); // profile preserved by this scope
    expect(getPauseState()).toBe('halted');
    expect(getConfig<boolean>(getDb(), 'recruiter_sim_enabled')).toBe(false); // sim off
  });

  it("'everything' is true pre-bootstrap — clears pipeline + profile + sessions, halts", () => {
    seedProfile();
    seedApplication();
    seedSession();

    const out = applyDevReset(getDb(), { scope: 'everything' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ scope: 'everything', halted: true });
    expect(appCount()).toBe(0);
    expect(profileExists()).toBe(false);
    expect(sessionCount()).toBe(0);
    expect(getPauseState()).toBe('halted');
  });

  it('per-field reset NULLs one onboarding field, keeps the rest, no halt', () => {
    seedProfile();

    const out = applyDevReset(getDb(), { field: 'master_resume' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ field: 'master_resume', halted: false });
    expect((out.body as { cleared: Record<string, number> }).cleared.master_resume).toBe(1);
    const row = getDb().prepare('SELECT full_name, master_resume FROM candidate_profile WHERE id = 1').get() as {
      full_name: string | null;
      master_resume: string | null;
    };
    expect(row.master_resume).toBeNull();
    expect(row.full_name).toBe('Jane Doe'); // other fields untouched
    expect(getPauseState()).toBe('active');
  });

  it('accepts every onboarding field for per-field reset', () => {
    seedProfile();
    for (const field of ONBOARDING_FIELD_ORDER) {
      expect(applyDevReset(getDb(), { field }).status).toBe(200);
    }
  });

  it('rejects a non-onboarding field (400) without touching the row', () => {
    seedProfile();
    // github_url is a real column but NOT an onboarding field → not resettable here.
    expect(applyDevReset(getDb(), { field: 'github_url' }).status).toBe(400);
    expect(applyDevReset(getDb(), { field: 'nonsense' }).status).toBe(400);
    expect(profileExists()).toBe(true);
  });

  it('rejects ambiguous / empty / unknown input (400, no state change)', () => {
    seedApplication();
    expect(applyDevReset(getDb(), null).status).toBe(400);
    expect(applyDevReset(getDb(), {}).status).toBe(400); // neither scope nor field
    expect(applyDevReset(getDb(), { scope: 'profile', field: 'bio' }).status).toBe(400); // both
    expect(applyDevReset(getDb(), { scope: 'nuke-everything' }).status).toBe(400); // unknown scope
    expect(appCount()).toBe(1); // nothing wiped
    expect(getPauseState()).toBe('active');
  });
});
