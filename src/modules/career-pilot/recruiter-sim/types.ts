/**
 * Recruiter-sim — domain types (Sub-milestone 9.3b, STRATEGY.md §24.40).
 *
 * A DEV-ONLY fixture (D13): the deterministic backbone that drives the
 * candidate agent's proactive funnel by injecting realistic recruiter/ATS email
 * into the single dev mailbox (D14). These types describe the pure scenario
 * model; the Gmail/Calendar injection + Haiku prose are decoupled adapters
 * (later commits). Nothing here performs I/O.
 */
import type { EmailClassification } from '../funnel-types.js';

/** Tunable knobs — the `recruiter_sim_*` config keys (D13). */
export interface SimKnobs {
  enabled: boolean;
  /** How often the host tick runs. */
  tickIntervalSec: number;
  /** Min/max wall-clock gap between a scenario's steps (the "speed" dial — smaller = faster). */
  minStepSec: number;
  maxStepSec: number;
  /** How often a new simulated application is seeded (while below maxConcurrent). */
  seedIntervalSec: number;
  maxConcurrent: number;
  /** Terminal-branch split: chance of offer vs rejection (normalized over the two). */
  offerProbability: number;
  rejectionProbability: number;
  /** Per non-first step, chance the thread ghosts (stops — close-detection's trigger). */
  ghostProbability: number;
  /** Per tick, chance of injecting a standalone `noise` email (classifier precision). */
  noiseRatio: number;
  /** Daily Haiku-spend cap for the prose, on top of the dev caps. */
  dailyBudgetUsd: number;
}

export type SimAppStatus = 'active' | 'ghosted' | 'closed';
export type SimOutcome = 'offer' | 'rejection';

/** One simulated application walking the funnel. Persisted in the sidecar state. */
export interface SimApp {
  appId: string;
  company: string;
  role: string;
  obfuscatedLabel: string;
  /** Synthetic recruiter identity for this company (display name + From address). */
  fromName: string;
  fromAddress: string;
  /** Gmail thread to reply within — null until the runner fills it after the first inject. */
  threadId: string | null;
  /** Index of the NEXT funnel email to emit. `>= STAGES.length` → the terminal email. */
  stageIndex: number;
  status: SimAppStatus;
  /** Decided when the terminal email is emitted. */
  outcome: SimOutcome | null;
  createdAtMs: number;
  /** Wall-clock time the next step is due. */
  nextFireAtMs: number;
  /** The "realistic timeline" cursor used to backdate injected Date headers (the speed-knob gift). */
  realCursorMs: number;
}

export interface SimState {
  apps: SimApp[];
  lastSeedAtMs: number;
}

export interface SimCalendarInvite {
  summary: string;
  startMs: number;
  durationMin: number;
}

/**
 * A recruiter/ATS email to inject (the runner turns this into a Gmail
 * `messages.insert`). The recipient is ALWAYS the dev account (the runner's
 * constant, re-checked against the self-only allow-list) — it is not carried
 * here, so no intent can ever name a non-self recipient.
 */
export interface InjectEmailIntent {
  type: 'inject_email';
  /** The linked simulated application, or null for standalone noise. */
  appId: string | null;
  classification: EmailClassification;
  /** true → start a new thread; false → reply within `threadId`. */
  newThread: boolean;
  threadId: string | null;
  fromName: string;
  fromAddress: string;
  subject: string;
  /** The always-correct backbone body (used as-is when Haiku is off/over budget). */
  deterministicBody: string;
  /** The Haiku prompt to enrich the body (D2: deterministic-backbone + Haiku split). */
  prosePrompt: string;
  /** Backdated received time (the speed-knob gift via `internalDateSource=dateHeader`). */
  internalDateMs: number;
  calendar: SimCalendarInvite | null;
}

/** Create a new application row so the funnel-curator has something to link to. */
export interface SeedApplicationIntent {
  type: 'seed_application';
  appId: string;
  companyName: string;
  obfuscatedLabel: string;
  roleTitle: string;
  appliedAtMs: number;
}

export type SimIntent = SeedApplicationIntent | InjectEmailIntent;

export interface TickPlan {
  intents: SimIntent[];
  nextState: SimState;
}
