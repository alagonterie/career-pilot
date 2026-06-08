import fs from 'fs';

import { beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { SIM_KNOB_KEYS, readSimKnobs } from './knobs.js';

const defaultsUrl = new URL('../../../../config/defaults.json', import.meta.url);
const defaults = JSON.parse(fs.readFileSync(defaultsUrl, 'utf8')) as {
  preferences: Record<string, unknown>;
};

describe('recruiter-sim knobs', () => {
  it('every SIM_KNOB_KEY has a default in config/defaults.json (else getConfig throws at runtime)', () => {
    for (const key of SIM_KNOB_KEYS) {
      expect(defaults.preferences, `missing default for ${key}`).toHaveProperty(key);
    }
  });

  it('exposes the full knob set with no duplicates', () => {
    expect(new Set(SIM_KNOB_KEYS).size).toBe(SIM_KNOB_KEYS.length);
    expect(SIM_KNOB_KEYS).toContain('recruiter_sim_enabled');
    expect(SIM_KNOB_KEYS).toContain('recruiter_sim_screen_pass_rate');
    expect(SIM_KNOB_KEYS).toContain('recruiter_sim_job_source');
    expect(SIM_KNOB_KEYS).toContain('recruiter_sim_pace');
    expect(SIM_KNOB_KEYS.length).toBe(10); // −4 timing knobs (folded into the pace preset) +2 enum toggles
  });

  it('defaults the sim to disabled (a non-dev stack must never run it)', () => {
    expect(defaults.preferences.recruiter_sim_enabled).toBe(false);
  });
});

describe('readSimKnobs — pace presets + job source (D16/D17)', () => {
  beforeEach(() => {
    closeDb();
    runMigrations(initTestDb());
  });

  function setPref(key: string, value: string): void {
    getDb()
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  it('resolves the fast preset by default (backdated, minute-scale)', () => {
    const k = readSimKnobs(getDb());
    expect(k.backdate).toBe(true);
    expect(k.minStepSec).toBe(30);
    expect(k.maxStepSec).toBe(150);
    expect(k.tickIntervalSec).toBe(20);
    expect(k.jobSource).toBe('real'); // defaults.json default
  });

  it('resolves the realistic preset (real-time, day-scale) when recruiter_sim_pace=realistic', () => {
    setPref('recruiter_sim_pace', 'realistic');
    const k = readSimKnobs(getDb());
    expect(k.backdate).toBe(false);
    expect(k.minStepSec).toBe(86_400);
    expect(k.maxStepSec).toBe(604_800);
    expect(k.seedIntervalSec).toBe(172_800);
  });

  it('reads the job-source toggle', () => {
    setPref('recruiter_sim_job_source', 'synthetic');
    expect(readSimKnobs(getDb()).jobSource).toBe('synthetic');
  });
});
