/**
 * Recruiter-sim scenario state machine (Sub-milestone 9.3b, STRATEGY.md §24.40).
 *
 * Pure + deterministic (the D2 backbone): given the current sim state, the
 * knobs, the wall-clock `now`, and an injectable RNG, `planTick` returns the
 * side-effect INTENTS for this tick (seed a new application / inject an email)
 * plus the next state. No I/O, no LLM — the runner executes the intents.
 *
 * Each simulated application walks the funnel:
 *   seed (apply) → application_confirmation → screen_invite → onsite_invite (+Calendar)
 *               → next_round_update → terminal { offer | rejection }
 * with a per-step ghost chance (the thread goes quiet — close-detection's trigger).
 * Most applications never get a screen, though: a top-of-funnel `screenPassRate`
 * gate sends an early `screen_rejection` right after the confirmation (the
 * realistic cull — applied, auto-confirmed, then passed over), so only a minority
 * reach the deeper stages.
 *
 * The wall-clock pace is compressed (steps seconds/minutes apart — the speed
 * knob) while each email's Date header is BACKDATED along a realistic multi-week
 * timeline, so the funnel's days-in-stage looks real on the portal.
 */
import type { EmailClassification } from '../funnel-types.js';
import { STAGE_CLASSIFICATIONS, buildEmailContent, buildNoiseContent } from './templates.js';
import type {
  InjectEmailIntent,
  SeedApplicationIntent,
  SimApp,
  SimKnobs,
  SimOutcome,
  SimState,
  TickPlan,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Realistic day-gap [min, max] to the NEXT stage, indexed by current stage. */
const STAGE_REAL_DAYS: Array<[number, number]> = [
  [3, 9], // application_confirmation → screen_invite
  [2, 6], // screen_invite → onsite_invite
  [3, 7], // onsite_invite → next_round_update
  [4, 10], // next_round_update → terminal
];

/** How far in the past a freshly-seeded application's "applied" date sits. */
const SEED_BACKDATE_DAYS: [number, number] = [16, 28];

const COMPANIES: Array<{ name: string; label: string }> = [
  { name: 'Meridian Labs', label: 'Series B data-infra startup' },
  { name: 'Northwind Systems', label: 'Mid-size cloud platform' },
  { name: 'Helix Robotics', label: 'Late-stage robotics company' },
  { name: 'Lumen Analytics', label: 'Series A analytics startup' },
  { name: 'Cobalt Software', label: 'Public B2B SaaS company' },
  { name: 'Vantage Networks', label: 'Growth-stage fintech' },
  { name: 'Atlas Compute', label: 'Series C infrastructure company' },
  { name: 'Bright Harbor', label: 'Seed-stage developer-tools startup' },
  { name: 'Quill & Cipher', label: 'Mid-size security company' },
  { name: 'Drift Logic', label: 'Series B AI startup' },
];

const ROLES = [
  'Senior Software Engineer',
  'Backend Engineer',
  'Full-Stack Engineer',
  'Platform Engineer',
  'Software Engineer, Infrastructure',
  'Staff Software Engineer',
];

// ── seedable RNG (so tests are deterministic) ────────────────────────────────

/** mulberry32 — a tiny deterministic PRNG. Returns a function yielding [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Inclusive integer in [min, max]. */
function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function randDaysMs(rng: () => number, range: [number, number]): number {
  return randInt(rng, range[0], range[1]) * DAY_MS;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ── intent builders ──────────────────────────────────────────────────────────

/** Build an inject intent for an app's email at the given classification. */
function buildAppInject(app: SimApp, classification: EmailClassification, internalDateMs: number): InjectEmailIntent {
  const content = buildEmailContent(classification, { company: app.company, role: app.role });
  const newThread = app.threadId === null;
  return {
    type: 'inject_email',
    appId: app.appId,
    classification,
    newThread,
    threadId: app.threadId,
    fromName: app.fromName,
    fromAddress: app.fromAddress,
    subject: content.subject,
    deterministicBody: content.deterministicBody,
    prosePrompt: content.prosePrompt,
    internalDateMs,
    calendar: null,
  };
}

function pickOutcome(knobs: SimKnobs, rng: () => number): SimOutcome {
  const total = knobs.offerProbability + knobs.rejectionProbability;
  if (total <= 0) return 'rejection';
  return rng() < knobs.offerProbability / total ? 'offer' : 'rejection';
}

/** Seed a new simulated application (returns the app state + the DB-seed intent). */
function makeSeed(nowMs: number, rng: () => number): { app: SimApp; intent: SeedApplicationIntent } {
  const { name, label } = pick(rng, COMPANIES);
  const role = pick(rng, ROLES);
  const appId = `sim-${nowMs}-${Math.floor(rng() * 1e9).toString(36)}`;
  const appliedAtMs = nowMs - randDaysMs(rng, SEED_BACKDATE_DAYS);
  const app: SimApp = {
    appId,
    company: name,
    role,
    obfuscatedLabel: label,
    fromName: `${name} Talent`,
    fromAddress: `talent@${slug(name)}.example`,
    threadId: null,
    lastMessageId: null,
    stageIndex: 0,
    status: 'active',
    outcome: null,
    createdAtMs: nowMs,
    nextFireAtMs: nowMs, // fire the confirmation immediately (this tick)
    realCursorMs: appliedAtMs,
  };
  const intent: SeedApplicationIntent = {
    type: 'seed_application',
    appId,
    companyName: name,
    obfuscatedLabel: label,
    roleTitle: role,
    appliedAtMs,
  };
  return { app, intent };
}

/**
 * Advance one active, due application by one step. Mutates `app` (stage / ghost /
 * close / timers) and returns the email intent to inject this step.
 */
function stepApp(app: SimApp, knobs: SimKnobs, nowMs: number, rng: () => number): InjectEmailIntent {
  const stage = app.stageIndex;
  const internalDateMs = Math.min(app.realCursorMs, nowMs); // never future-date

  // Terminal: past the linear stages → emit offer or rejection, then close.
  if (stage >= STAGE_CLASSIFICATIONS.length) {
    const outcome = app.outcome ?? pickOutcome(knobs, rng);
    app.outcome = outcome;
    app.status = 'closed';
    return buildAppInject(app, outcome === 'offer' ? 'offer' : 'rejection', internalDateMs);
  }

  // Top-of-funnel attrition: most applications are passed over right after the
  // confirmation. At the screen step, only `screenPassRate` advance to an intro
  // call; the rest get an early rejection and close — the realistic cull that
  // keeps the deep funnel sparse. (The very first email, the confirmation at
  // stage 0, always sends.)
  if (stage === 1 && rng() >= knobs.screenPassRate) {
    app.status = 'closed';
    app.outcome = 'rejection';
    return buildAppInject(app, 'screen_rejection', internalDateMs);
  }

  const classification = STAGE_CLASSIFICATIONS[stage];
  const intent = buildAppInject(app, classification, internalDateMs);

  // Calendar invite rides along with the interview invitation (future meeting).
  if (classification === 'onsite_invite') {
    intent.calendar = {
      summary: `${app.company} — ${app.role} interview`,
      startMs: nowMs + randInt(rng, 1, 5) * DAY_MS,
      durationMin: 45,
    };
  }

  // March the realistic timeline toward the next stage, and schedule the next
  // (compressed) wall-clock fire.
  app.realCursorMs += randDaysMs(rng, STAGE_REAL_DAYS[stage]);
  app.nextFireAtMs = nowMs + randInt(rng, knobs.minStepSec, knobs.maxStepSec) * 1000;

  // Ghost chance (never on the very first email).
  if (stage > 0 && rng() < knobs.ghostProbability) {
    app.status = 'ghosted';
  } else {
    app.stageIndex = stage + 1;
  }
  return intent;
}

function makeNoiseInject(nowMs: number, rng: () => number): InjectEmailIntent {
  const content = buildNoiseContent(randInt(rng, 0, 3));
  return {
    type: 'inject_email',
    appId: null,
    classification: 'noise',
    newThread: true,
    threadId: null,
    fromName: 'Dev Digest',
    fromAddress: 'digest@newsletter.example',
    subject: content.subject,
    deterministicBody: content.deterministicBody,
    prosePrompt: content.prosePrompt,
    internalDateMs: nowMs - randInt(rng, 0, 48) * 60 * 60 * 1000,
    calendar: null,
  };
}

// ── the tick planner (pure) ──────────────────────────────────────────────────

export interface PlanTickInput {
  state: SimState;
  knobs: SimKnobs;
  nowMs: number;
  rng: () => number;
}

/**
 * Plan one tick: seed at most one new application (when due + below capacity),
 * advance every active application whose step is due, and occasionally inject a
 * noise email. Returns the intents to execute and the next state. Pure.
 */
export function planTick(input: PlanTickInput): TickPlan {
  const { knobs, nowMs, rng } = input;
  const intents: TickPlan['intents'] = [];
  const apps: SimApp[] = input.state.apps.map((a) => ({ ...a }));
  let lastSeedAtMs = input.state.lastSeedAtMs;

  // 1. Seed a new application if due and below capacity.
  const activeCount = apps.filter((a) => a.status === 'active').length;
  if (activeCount < knobs.maxConcurrent && nowMs - lastSeedAtMs >= knobs.seedIntervalSec * 1000) {
    const { app, intent } = makeSeed(nowMs, rng);
    apps.push(app);
    intents.push(intent);
    lastSeedAtMs = nowMs;
  }

  // 2. Advance each active application whose step is due.
  for (const app of apps) {
    if (app.status !== 'active') continue;
    if (nowMs < app.nextFireAtMs) continue;
    intents.push(stepApp(app, knobs, nowMs, rng));
  }

  // 3. Occasional standalone noise (classifier-precision filler).
  if (rng() < knobs.noiseRatio) {
    intents.push(makeNoiseInject(nowMs, rng));
  }

  return { intents, nextState: { apps, lastSeedAtMs } };
}

/** A fresh, empty sim state. */
export function emptySimState(): SimState {
  return { apps: [], lastSeedAtMs: 0 };
}
