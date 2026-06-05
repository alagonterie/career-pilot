/**
 * Recruiter-sim runner (Sub-milestone 9.3b, STRATEGY.md §24.40).
 *
 * The host-side loop that ties the pieces together. Double-gated: it only does
 * work when `ENVIRONMENT==='dev'` AND `recruiter_sim_enabled` — so a non-dev
 * stack never runs it, and the owner can toggle it live (the future §24.42 page)
 * without a restart. `.unref()`'d like the other host timers.
 *
 * Each tick: load + reconcile the sidecar state, plan via the pure state machine,
 * then execute the intents — seed `applications` rows, and inject emails
 * (Haiku-enriched or deterministic) + Calendar invites through the gateway.
 * Scenario bookkeeping lives in a dev-only sidecar JSON file; the seeded
 * applications are real DB rows the funnel-curator links against.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { DATA_DIR } from '../../../config.js';
import { getDb } from '../../../db/connection.js';
import { log } from '../../../log.js';
import { fetchDevAccount, insertCalendarEvent, insertEmail } from './inject.js';
import { readSimKnobs } from './knobs.js';
import { enrichBody } from './prose.js';
import { emptySimState, planTick } from './scenario.js';
import type { InjectEmailIntent, SeedApplicationIntent, SimKnobs, SimState } from './types.js';

const FIRST_TICK_DELAY_MS = 10_000;
const MIN_TICK_INTERVAL_MS = 5_000;

let running = false;
let timer: NodeJS.Timeout | null = null;
let devAccountCache: string | null = null;
let dailySpentUsd = 0;
let budgetDayKey = '';

/** The sim only does anything on the deployed dev stack. */
export function isRecruiterSimEnv(): boolean {
  return process.env.ENVIRONMENT === 'dev';
}

function simStatePath(): string {
  return path.join(DATA_DIR, 'recruiter-sim-state.json');
}

// ── sidecar state persistence ────────────────────────────────────────────────

export function loadState(file: string): SimState {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as SimState;
    if (!parsed || !Array.isArray(parsed.apps)) return emptySimState();
    return { apps: parsed.apps, lastSeedAtMs: parsed.lastSeedAtMs ?? 0 };
  } catch {
    return emptySimState();
  }
}

export function saveState(file: string, state: SimState): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/** Drop sim apps whose `applications` row no longer exists (e.g. after reset:dev). */
export function reconcileState(db: Database.Database, state: SimState): SimState {
  if (state.apps.length === 0) return state;
  const ids = state.apps.map((a) => a.appId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM applications WHERE id IN (${placeholders})`).all(...ids) as Array<{
    id: string;
  }>;
  const present = new Set(rows.map((r) => r.id));
  const apps = state.apps.filter((a) => present.has(a.appId));
  return { apps, lastSeedAtMs: state.lastSeedAtMs };
}

/** Insert the simulated application row (status `applied`, obfuscated). */
export function seedApplicationRow(db: Database.Database, intent: SeedApplicationIntent): void {
  const appliedAt = new Date(intent.appliedAtMs).toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO applications
       (id, company_name, obfuscated_label, public_state, role_title, status, applied_at, last_activity_at, created_at)
     VALUES (?, ?, ?, 'obfuscated', ?, 'applied', ?, ?, ?)`,
  ).run(
    intent.appId,
    intent.companyName,
    intent.obfuscatedLabel,
    intent.roleTitle,
    appliedAt,
    appliedAt,
    new Date().toISOString(),
  );
}

// ── the tick ─────────────────────────────────────────────────────────────────

async function executeInject(
  intent: InjectEmailIntent,
  devAccount: string,
  nextState: SimState,
  knobs: SimKnobs,
): Promise<void> {
  const app = intent.appId ? (nextState.apps.find((a) => a.appId === intent.appId) ?? null) : null;

  const budgetRemaining = Math.max(0, knobs.dailyBudgetUsd - dailySpentUsd);
  const prose = await enrichBody(intent, budgetRemaining);
  dailySpentUsd += prose.estCostUsd;

  const result = await insertEmail(intent, prose.body, devAccount, app?.lastMessageId ?? null);
  if (!result.ok) {
    log.warn('recruiter-sim: email inject failed', { error: result.error, classification: intent.classification });
    return;
  }
  if (app) {
    if (result.threadId) app.threadId = result.threadId;
    if (result.messageId) app.lastMessageId = result.messageId;
  }
  if (intent.calendar) {
    const cal = await insertCalendarEvent(intent.calendar, devAccount);
    if (!cal.ok) log.warn('recruiter-sim: calendar inject failed', { error: cal.error });
  }
  log.info('recruiter-sim injected', {
    classification: intent.classification,
    app: intent.appId,
    usedLlm: prose.usedLlm,
  });
}

async function runOneTick(db: Database.Database, knobs: SimKnobs): Promise<void> {
  if (!devAccountCache) {
    devAccountCache = await fetchDevAccount();
    if (!devAccountCache) {
      log.warn('recruiter-sim: dev account unknown (gateway/Gmail not reachable) — skipping tick');
      return;
    }
    log.info('recruiter-sim: dev mailbox resolved', { account: devAccountCache });
  }
  const devAccount = devAccountCache;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDayKey) {
    budgetDayKey = today;
    dailySpentUsd = 0;
  }

  const file = simStatePath();
  const state = reconcileState(db, loadState(file));
  const plan = planTick({ state, knobs, nowMs: Date.now(), rng: Math.random });

  for (const intent of plan.intents) {
    if (intent.type === 'seed_application') {
      try {
        seedApplicationRow(db, intent);
      } catch (err) {
        log.warn('recruiter-sim: seed application failed', { err });
      }
    } else {
      await executeInject(intent, devAccount, plan.nextState, knobs);
    }
  }
  saveState(file, plan.nextState);
}

function scheduleNext(ms: number): void {
  timer = setTimeout(() => void tick(), ms);
  if (typeof timer.unref === 'function') timer.unref();
}

async function tick(): Promise<void> {
  if (!running) return;
  let intervalMs = 20_000;
  try {
    const db = getDb();
    const knobs = readSimKnobs(db);
    intervalMs = Math.max(MIN_TICK_INTERVAL_MS, knobs.tickIntervalSec * 1000);
    // The loop runs continuously in dev so the `enabled` knob toggles live;
    // it just does nothing while disabled.
    if (knobs.enabled && isRecruiterSimEnv()) {
      await runOneTick(db, knobs);
    }
  } catch (err) {
    log.error('recruiter-sim tick failed', { err });
  }
  if (running) scheduleNext(intervalMs);
}

/** Start the dev-only recruiter-sim loop. No-op outside ENVIRONMENT=dev. */
export function startRecruiterSim(): void {
  if (running) return;
  if (!isRecruiterSimEnv()) {
    log.debug('recruiter-sim: not the dev environment — loop not started');
    return;
  }
  running = true;
  scheduleNext(FIRST_TICK_DELAY_MS);
  log.info('recruiter-sim host loop started (dev)');
}

export function stopRecruiterSim(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// Test seams.
export function _resetBudgetForTesting(): void {
  dailySpentUsd = 0;
  budgetDayKey = '';
  devAccountCache = null;
}
