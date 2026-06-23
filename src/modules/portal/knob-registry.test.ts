/**
 * Tests for the canonical knob registry (STRATEGY §24.138).
 *
 * The load-bearing test is COVERAGE: every `config/defaults.json` preferences
 * key must be either spec'd in `KNOB_SPECS` or explicitly listed in
 * `UNSPEC_KNOBS` — so a newly-added default fails CI until a conscious
 * include/deny decision is made (the teeth behind "don't forget a knob", D1).
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getConfig } from '../../get-config.js';

import {
  ADMIN_DENY,
  ADMIN_KNOB_KEYS,
  ALL_KNOB_KEYS,
  KNOB_SPECS,
  UNSPEC_KNOBS,
  applyKnobWrite,
  buildKnobs,
  validateKnobWrite,
} from './knob-registry.js';

function defaultsPreferenceKeys(): string[] {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'defaults.json'), 'utf8')) as {
    preferences: Record<string, unknown>;
  };
  return Object.keys(raw.preferences);
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('coverage — every defaults.json preferences key is decided', () => {
  it('is spec’d in KNOB_SPECS or explicitly in UNSPEC_KNOBS', () => {
    for (const key of defaultsPreferenceKeys()) {
      const decided = key in KNOB_SPECS || key in UNSPEC_KNOBS;
      expect(decided, `${key}: add it to KNOB_SPECS (editable knob) or UNSPEC_KNOBS (with a reason)`).toBe(true);
    }
  });

  it('never lists a key in BOTH KNOB_SPECS and UNSPEC_KNOBS', () => {
    for (const key of Object.keys(UNSPEC_KNOBS)) {
      expect(KNOB_SPECS[key], `${key} is in both KNOB_SPECS and UNSPEC_KNOBS`).toBeUndefined();
    }
  });

  it('every spec key + every UNSPEC key is a real defaults.json preferences key (no stale entries)', () => {
    const prefKeys = new Set(defaultsPreferenceKeys());
    for (const key of ALL_KNOB_KEYS) {
      expect(prefKeys.has(key), `KNOB_SPECS["${key}"] has no default in config/defaults.json`).toBe(true);
    }
    for (const key of Object.keys(UNSPEC_KNOBS)) {
      expect(prefKeys.has(key), `UNSPEC_KNOBS["${key}"] is not a defaults.json preferences key`).toBe(true);
    }
  });
});

describe('ADMIN_DENY / ADMIN_KNOB_KEYS invariants', () => {
  it('ADMIN_KNOB_KEYS = the registry minus ADMIN_DENY', () => {
    expect(ADMIN_KNOB_KEYS).toEqual(ALL_KNOB_KEYS.filter((k) => !ADMIN_DENY.has(k)));
  });

  it('every ADMIN_DENY key is a real registry spec (denies the recruiter-sim dial incl. its prose model)', () => {
    for (const key of ADMIN_DENY) {
      expect(KNOB_SPECS[key], `ADMIN_DENY key ${key} is not in the registry`).toBeTruthy();
    }
    expect(ADMIN_DENY.has('recruiter_sim_enabled')).toBe(true);
    expect(ADMIN_DENY.has('recruiter_sim_prose_model')).toBe(true);
  });

  it('no ADMIN_KNOB_KEYS key is denied, and the included set carries the operational levers', () => {
    for (const key of ADMIN_KNOB_KEYS) expect(ADMIN_DENY.has(key)).toBe(false);
    for (const key of [
      'owner_daily_llm_budget_usd',
      'sandbox_daily_global_budget_usd',
      'simulator_enabled',
      'contact_relay_enabled',
      'telemetry_capture',
      'quiet_hours',
      'daily_briefing_time',
    ]) {
      expect(ADMIN_KNOB_KEYS).toContain(key);
    }
  });
});

describe('validateKnobWrite — text knobs (§24.138)', () => {
  it('validates quiet_hours against its HH:MM-HH:MM pattern (empty allowed → disables)', () => {
    expect(validateKnobWrite('quiet_hours', '22:00-07:00')).toMatchObject({ ok: true, value: '22:00-07:00' });
    expect(validateKnobWrite('quiet_hours', '')).toMatchObject({ ok: true, value: '' });
    expect(validateKnobWrite('quiet_hours', 'late').ok).toBe(false);
    expect(validateKnobWrite('quiet_hours', 42).ok).toBe(false);
  });

  it('enforces a text maxLength', () => {
    expect(validateKnobWrite('interview_kit_folder_name', 'Career Pilot Kits')).toMatchObject({ ok: true });
    expect(validateKnobWrite('interview_kit_folder_name', 'x'.repeat(201)).ok).toBe(false);
  });

  it('validates the model + aggressiveness enums', () => {
    expect(validateKnobWrite('sanitization_pass3_model', 'claude-haiku-4-5').ok).toBe(true);
    expect(validateKnobWrite('sanitization_pass3_model', 'gpt-5').ok).toBe(false);
    expect(validateKnobWrite('sanitization_llm_review_aggressiveness', 'high').ok).toBe(true);
    expect(validateKnobWrite('sanitization_llm_review_aggressiveness', 'extreme').ok).toBe(false);
  });
});

describe('applyKnobWrite — scoped allow-list (ADMIN_KNOB_KEYS)', () => {
  it('refuses a denied key but accepts an included one (the /admin scope)', () => {
    const db = getDb();
    // recruiter_sim_enabled is a valid spec, but denied for /admin → refused.
    expect(applyKnobWrite(db, { key: 'recruiter_sim_enabled', value: true }, ADMIN_KNOB_KEYS).status).toBe(400);
    // an included knob persists.
    expect(applyKnobWrite(db, { key: 'simulator_max_turns', value: 12 }, ADMIN_KNOB_KEYS).status).toBe(200);
    expect(getConfig<number>(db, 'simulator_max_turns')).toBe(12);
  });

  it('resetAll over ADMIN_KNOB_KEYS leaves a dev-only (denied) override intact', () => {
    const db = getDb();
    applyKnobWrite(db, { key: 'recruiter_sim_max_concurrent', value: 3 }); // dev path (full registry)
    applyKnobWrite(db, { key: 'simulator_max_turns', value: 12 }, ADMIN_KNOB_KEYS);
    applyKnobWrite(db, { resetAll: true }, ADMIN_KNOB_KEYS);
    expect(getConfig<number>(db, 'simulator_max_turns')).toBe(30); // reset to default
    expect(getConfig<number>(db, 'recruiter_sim_max_concurrent')).toBe(3); // dev-only override survives
  });
});

describe('buildKnobs', () => {
  it('returns one entry per requested key with value + metadata, excluding denied keys for /admin', () => {
    const db = getDb();
    const knobs = buildKnobs(db, ADMIN_KNOB_KEYS);
    expect(knobs).toHaveLength(ADMIN_KNOB_KEYS.length);
    expect(knobs.map((k) => k.key)).not.toContain('recruiter_sim_enabled');
    const sim = knobs.find((k) => k.key === 'simulator_enabled');
    expect(sim).toMatchObject({ type: 'boolean', group: 'simulator', default: true });
    const quiet = knobs.find((k) => k.key === 'quiet_hours');
    expect(quiet).toMatchObject({ type: 'text', group: 'notify' });
  });
});
