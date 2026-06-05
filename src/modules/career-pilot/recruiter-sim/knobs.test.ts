import fs from 'fs';

import { describe, expect, it } from 'vitest';

import { SIM_KNOB_KEYS } from './knobs.js';

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
    expect(SIM_KNOB_KEYS.length).toBe(11);
  });

  it('defaults the sim to disabled (a non-dev stack must never run it)', () => {
    expect(defaults.preferences.recruiter_sim_enabled).toBe(false);
  });
});
