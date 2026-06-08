import { describe, expect, it } from 'vitest';

import type { EmailClassification } from '../funnel-types.js';
import { emptySimState, mulberry32, planTick } from './scenario.js';
import type { InjectEmailIntent, SimKnobs, SimState } from './types.js';

/** Knob preset: deterministic, single-app-at-a-time, 1s steps, no noise. */
function knobs(overrides: Partial<SimKnobs> = {}): SimKnobs {
  return {
    enabled: true,
    tickIntervalSec: 1,
    minStepSec: 1,
    maxStepSec: 1,
    seedIntervalSec: 0,
    maxConcurrent: 1,
    screenPassRate: 1, // tests opt into early attrition explicitly
    offerProbability: 1,
    rejectionProbability: 0,
    ghostProbability: 0,
    noiseRatio: 0,
    dailyBudgetUsd: 1,
    jobSource: 'synthetic',
    backdate: true,
    ...overrides,
  };
}

/** Run `ticks` ticks at 1s apart, returning every inject_email intent emitted. */
function runTicks(
  state: SimState,
  k: SimKnobs,
  ticks: number,
  startMs = 1_000_000,
): {
  state: SimState;
  injects: InjectEmailIntent[];
} {
  const rng = mulberry32(42);
  let s = state;
  const injects: InjectEmailIntent[] = [];
  for (let i = 0; i < ticks; i++) {
    const plan = planTick({ state: s, knobs: k, nowMs: startMs + i * 1000, rng });
    for (const intent of plan.intents) {
      if (intent.type === 'inject_email') injects.push(intent);
    }
    s = plan.nextState;
  }
  return { state: s, injects };
}

function classes(injects: InjectEmailIntent[]): EmailClassification[] {
  return injects.map((i) => i.classification);
}

describe('recruiter-sim scenario', () => {
  it('seeds an application and emits its confirmation on the same tick', () => {
    const plan = planTick({ state: emptySimState(), knobs: knobs(), nowMs: 1_000_000, rng: mulberry32(1) });
    const seeds = plan.intents.filter((i) => i.type === 'seed_application');
    const injects = plan.intents.filter((i) => i.type === 'inject_email');
    expect(seeds).toHaveLength(1);
    expect(injects).toHaveLength(1);
    expect((injects[0] as InjectEmailIntent).classification).toBe('application_confirmation');
    expect((injects[0] as InjectEmailIntent).newThread).toBe(true);
    expect(plan.nextState.apps).toHaveLength(1);
    expect(plan.nextState.apps[0].status).toBe('active');
  });

  it('walks the full funnel to an offer when ghosting is off', () => {
    const { state, injects } = runTicks(emptySimState(), knobs({ offerProbability: 1, rejectionProbability: 0 }), 5);
    expect(classes(injects)).toEqual([
      'application_confirmation',
      'screen_invite',
      'onsite_invite',
      'next_round_update',
      'offer',
    ]);
    // The onsite invite carries a future-dated calendar invite.
    const onsite = injects.find((i) => i.classification === 'onsite_invite')!;
    expect(onsite.calendar).not.toBeNull();
    expect(onsite.calendar!.startMs).toBeGreaterThan(1_000_000);
    const app = state.apps[0];
    expect(app.status).toBe('closed');
    expect(app.outcome).toBe('offer');
  });

  it('produces a rejection at the terminal when offer probability is 0', () => {
    const { state, injects } = runTicks(emptySimState(), knobs({ offerProbability: 0, rejectionProbability: 1 }), 5);
    expect(classes(injects).at(-1)).toBe('rejection');
    expect(state.apps[0].outcome).toBe('rejection');
  });

  it('rejects at the screen step (early attrition) when screenPassRate is 0', () => {
    // Two ticks: confirmation always sends (stage 0), then the screen step is an
    // early rejection — the app never reaches an intro call. This is the realistic
    // top-of-funnel cull that keeps most apps out of the deep funnel.
    const { state, injects } = runTicks(emptySimState(), knobs({ screenPassRate: 0 }), 2);
    expect(classes(injects)).toEqual(['application_confirmation', 'screen_rejection']);
    expect(state.apps[0].status).toBe('closed');
    expect(state.apps[0].outcome).toBe('rejection');
  });

  it('advances past the screen when screenPassRate is 1', () => {
    const { injects } = runTicks(emptySimState(), knobs({ screenPassRate: 1 }), 2);
    expect(classes(injects)).toEqual(['application_confirmation', 'screen_invite']);
  });

  it('ghosts after the first reply when ghost probability is 1', () => {
    // Two ticks = exactly one app's lifecycle: confirmation always sends, then
    // the next step (screen_invite) sends and ghosts. (A third tick would free
    // the single slot and seed a fresh app — covered by the maxConcurrent test.)
    const { state, injects } = runTicks(emptySimState(), knobs({ ghostProbability: 1 }), 2);
    expect(classes(injects)).toEqual(['application_confirmation', 'screen_invite']);
    expect(state.apps).toHaveLength(1);
    expect(state.apps[0].status).toBe('ghosted');
  });

  it('never exceeds maxConcurrent active applications', () => {
    let s = emptySimState();
    const k = knobs({ maxConcurrent: 3, seedIntervalSec: 0, ghostProbability: 0 });
    const rng = mulberry32(7);
    for (let i = 0; i < 30; i++) {
      const plan = planTick({ state: s, knobs: k, nowMs: 1_000_000 + i * 1000, rng });
      s = plan.nextState;
      const active = s.apps.filter((a) => a.status === 'active').length;
      expect(active).toBeLessThanOrEqual(3);
    }
  });

  it('injects noise every tick when noiseRatio is 1 and none when 0', () => {
    const withNoise = runTicks(emptySimState(), knobs({ noiseRatio: 1 }), 3);
    expect(withNoise.injects.some((i) => i.classification === 'noise' && i.appId === null)).toBe(true);

    const noNoise = runTicks(emptySimState(), knobs({ noiseRatio: 0 }), 3);
    expect(noNoise.injects.every((i) => i.classification !== 'noise')).toBe(true);
  });

  it('backdates emails (internalDate) to a realistic past timeline, never the future', () => {
    const now = 1_000_000_000_000;
    const { injects } = runTicks(emptySimState(), knobs(), 5, now);
    for (const intent of injects) {
      expect(intent.internalDateMs).toBeLessThanOrEqual(now + 5000);
    }
    // The confirmation is dated weeks before the offer.
    const confirmation = injects.find((i) => i.classification === 'application_confirmation')!;
    const offer = injects.find((i) => i.classification === 'offer')!;
    expect(offer.internalDateMs).toBeGreaterThan(confirmation.internalDateMs);
  });

  it('only seeds again once a slot frees up (single-app cadence)', () => {
    const { state } = runTicks(emptySimState(), knobs({ maxConcurrent: 1 }), 5);
    // After 5 ticks the first app has closed (offer at tick 5); a second may seed.
    const active = state.apps.filter((a) => a.status === 'active').length;
    expect(active).toBeLessThanOrEqual(1);
  });

  it('seeds from the real-jobs pool when jobSource is real and a pool is supplied (D16)', () => {
    const seedJobs = [{ company: 'GEICO', role: 'Senior Backend Engineer', jdText: 'Build and scale infra.' }];
    const plan = planTick({
      state: emptySimState(),
      knobs: knobs({ jobSource: 'real' }),
      nowMs: 1_000_000,
      rng: mulberry32(1),
      seedJobs,
    });
    const seed = plan.intents.find((i) => i.type === 'seed_application');
    expect(seed?.type).toBe('seed_application');
    if (seed?.type !== 'seed_application') return;
    expect(seed.companyName).toBe('GEICO');
    expect(seed.roleTitle).toBe('Senior Backend Engineer');
    expect(seed.jdText).toContain('infra');
    expect(seed.obfuscatedLabel).toBe(''); // the runner derives the <industry>-<letter> label
  });

  it('falls back to the synthetic set when jobSource is real but the pool is empty', () => {
    const plan = planTick({
      state: emptySimState(),
      knobs: knobs({ jobSource: 'real' }),
      nowMs: 1_000_000,
      rng: mulberry32(1),
      seedJobs: [],
    });
    const seed = plan.intents.find((i) => i.type === 'seed_application');
    expect(seed?.type).toBe('seed_application');
    if (seed?.type !== 'seed_application') return;
    expect(seed.obfuscatedLabel.length).toBeGreaterThan(0); // synthetic companies carry a descriptive label
  });

  it('dates emails at ~now (not backdated) when backdate is off — the realistic pace', () => {
    const now = 1_000_000_000_000;
    const { injects } = runTicks(emptySimState(), knobs({ backdate: false }), 5, now);
    for (const intent of injects) {
      // realistic pace: each email is dated at its (per-tick) wall-clock time, never weeks in the past
      expect(intent.internalDateMs).toBeGreaterThanOrEqual(now);
    }
  });
});
