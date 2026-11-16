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
  cronMaxGapHours,
  KNOB_SPECS,
  MODEL_OPTIONS,
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

/**
 * The dropdown and the pricing map are two separate lists that must agree, and
 * nothing enforced that until now. `priceTokensMicrousd` returns null for an
 * unknown model — correct (unknown ≠ free) but silent — so a model offered in the
 * UI without a pricing row doesn't fail, it just makes every call on that model
 * report no cost. That is exactly how Sonnet went unpriced from §24.134e until
 * §24.191 caught it. These are the teeth.
 */
describe('model options are priced (§24.191)', () => {
  function pricingMap(): Record<string, Record<string, number>> {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'defaults.json'), 'utf8')) as {
      preferences: { llm_pricing_usd_per_mtok: Record<string, Record<string, number>> };
    };
    return raw.preferences.llm_pricing_usd_per_mtok;
  }

  it('every selectable model has a pricing row, so no knob setting can blank the cost', () => {
    const pricing = pricingMap();
    for (const model of MODEL_OPTIONS) {
      expect(
        pricing[model],
        `${model} is offered by a model knob but has no llm_pricing_usd_per_mtok row — every call on it would report an unknown cost`,
      ).toBeTruthy();
    }
  });

  it('every pricing row carries all four rates, so a partial row cannot under-report', () => {
    const pricing = pricingMap();
    for (const model of MODEL_OPTIONS) {
      for (const rate of ['input', 'output', 'cache_read', 'cache_write']) {
        const v = pricing[model]?.[rate];
        expect(typeof v, `${model}.${rate} is missing — that term would silently price as 0`).toBe('number');
        expect(v, `${model}.${rate} must be positive`).toBeGreaterThan(0);
      }
    }
  });

  it('offers exactly one model per tier (§24.195, §24.197); retiring one needs a preferences migration', () => {
    expect(MODEL_OPTIONS.filter((m) => m.startsWith('claude-opus-'))).toEqual(['claude-opus-5-5']);
    expect(MODEL_OPTIONS.filter((m) => m.startsWith('claude-sonnet-'))).toEqual(['claude-sonnet-5-5']);
    expect(MODEL_OPTIONS.filter((m) => m.startsWith('claude-haiku-'))).toEqual(['claude-haiku-5-5']);
    expect(MODEL_OPTIONS).toHaveLength(3);
  });

  it('the pricing table carries no row for a model that can no longer be selected', () => {
    expect(Object.keys(pricingMap()).sort()).toEqual([...MODEL_OPTIONS].sort());
  });

  it('every model DEFAULT is a selectable option (a default the dropdown cannot show is unreachable)', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'defaults.json'), 'utf8')) as {
      preferences: Record<string, unknown>;
    };
    for (const [key, value] of Object.entries(raw.preferences)) {
      if (!key.endsWith('_model') || typeof value !== 'string' || value === '') continue;
      expect([...MODEL_OPTIONS, 'inherit'], `${key} defaults to "${value}", which no model knob offers`).toContain(
        value,
      );
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
    expect(validateKnobWrite('sanitization_pass3_model', 'claude-haiku-5-5').ok).toBe(true);
    expect(validateKnobWrite('sanitization_pass3_model', 'gpt-5').ok).toBe(false);
    expect(validateKnobWrite('sanitization_llm_review_aggressiveness', 'high').ok).toBe(true);
    expect(validateKnobWrite('sanitization_llm_review_aggressiveness', 'extreme').ok).toBe(false);
  });

  it('refuses a sweep-filter pattern that does not compile, at save (§24.201 D5)', () => {
    for (const key of ['ats_sweep_title_include', 'ats_sweep_title_exclude', 'ats_sweep_location_filter']) {
      expect(KNOB_SPECS[key]?.regex).toBe(true);
      expect(validateKnobWrite(key, '\\b(staff|principal)\\b')).toMatchObject({ ok: true });
      expect(validateKnobWrite(key, '')).toMatchObject({ ok: true, value: '' });
      const bad = validateKnobWrite(key, '(unclosed');
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/not a valid regular expression/);
    }
  });

  it('the shipped sweep-filter defaults compile', () => {
    const db = getDb();
    for (const key of ['ats_sweep_title_include', 'ats_sweep_title_exclude', 'ats_sweep_location_filter']) {
      expect(() => new RegExp(getConfig<string>(db, key), 'i')).not.toThrow();
    }
  });
});

describe('sweep-interval invariant (§24.201 D5)', () => {
  it('measures the longest gap between fires', () => {
    expect(cronMaxGapHours('0 */2 * * *')).toBe(2);
    expect(cronMaxGapHours('0 7 * * *')).toBe(24);
    expect(cronMaxGapHours('0 9 * * 1-5')).toBe(72); // Friday → Monday
  });

  it('the default employer-board sweep fires more often than the killer-match recency window', () => {
    // A fresh posting must land in the pool while it is still inside the alert
    // window, or killer-match can never alert on a board posting.
    const db = getDb();
    const gap = cronMaxGapHours(getConfig<string>(db, 'ats_sweep_cron'));
    const windowHours = getConfig<number>(db, 'killer_match_recency_window_hours');
    expect(gap).toBeGreaterThan(0);
    expect(gap!).toBeLessThan(windowHours);
  });

  it('refuses at save a sweep cron whose gap is not shorter than the window, and writes nothing', () => {
    const db = getDb();
    const before = getConfig<string>(db, 'ats_sweep_cron');
    const out = applyKnobWrite(db, { key: 'ats_sweep_cron', value: '0 7 * * *' });
    expect(out.status).toBe(400);
    expect((out.body as { error: string }).error).toMatch(/killer-match recency window/);
    expect(getConfig<string>(db, 'ats_sweep_cron')).toBe(before);
  });

  it('refuses at save a recency window at or below the sweep gap', () => {
    const db = getDb();
    const gap = cronMaxGapHours(getConfig<string>(db, 'ats_sweep_cron'))!;
    const out = applyKnobWrite(db, { key: 'killer_match_recency_window_hours', value: gap });
    expect(out.status).toBe(400);
    expect((out.body as { error: string }).error).toMatch(/killer-match recency window/);
    expect(applyKnobWrite(db, { key: 'killer_match_recency_window_hours', value: Math.ceil(gap) + 1 }).status).toBe(
      200,
    );
  });

  it('refuses a reset that would break the pair, and keeps the override', () => {
    const db = getDb();
    // Window 30h lets a daily sweep through; resetting the window to its
    // default would then leave a 24h gap against a shorter window.
    expect(applyKnobWrite(db, { key: 'killer_match_recency_window_hours', value: 30 }).status).toBe(200);
    expect(applyKnobWrite(db, { key: 'ats_sweep_cron', value: '0 7 * * *' }).status).toBe(200);
    const out = applyKnobWrite(db, { key: 'killer_match_recency_window_hours', reset: true });
    expect(out.status).toBe(400);
    expect(getConfig<number>(db, 'killer_match_recency_window_hours')).toBe(30);
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
