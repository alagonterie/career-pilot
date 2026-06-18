import { describe, expect, it } from 'vitest';

import { evaluateTripwire, getCodeVersion, type UpgradeState } from './upgrade-state.js';

const state = (version: string): UpgradeState => ({
  version,
  updatedAt: '2026-06-18T00:00:00.000Z',
  via: 'test',
});

describe('evaluateTripwire (§24.126 boot-guard decision)', () => {
  it('trips when there is no marker', () => {
    const r = evaluateTripwire(null, '2.0.70');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/no upgrade marker/i);
  });

  it('trips when the marker version != the running code version', () => {
    const r = evaluateTripwire(state('2.0.69'), '2.0.70');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/2\.0\.69.*2\.0\.70/);
  });

  it('passes when the marker version matches the running code version', () => {
    expect(evaluateTripwire(state('2.0.70'), '2.0.70')).toEqual({ ok: true });
  });
});

describe('getCodeVersion', () => {
  it('reads a non-empty version from the root package.json', () => {
    expect(getCodeVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
