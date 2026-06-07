/**
 * Pre-wake eligibility CLI (§24.49c).
 *
 * Invoked by a scheduled task's pre-wake `script` BEFORE the agent turn runs
 * (`applyPreTaskScripts` → `runScript`, which parses our LAST stdout line as
 * `{ wakeAgent, data? }`). We round-trip to the host's read-only
 * `career_pilot.check_trigger_eligibility` action and print whether the turn
 * has any work to do. `wakeAgent:false` ⇒ the fire is dropped with ZERO model
 * call — the win for the every-30min killer-match cron that mostly finds nothing.
 *
 * FAIL-OPEN is load-bearing: a transient host hiccup (timeout, readonly-DB race,
 * unexpected shape) must NEVER silently drop a real killer-match. On any doubt we
 * print `{ wakeAgent:true }` and let the woken turn re-check authoritatively (and,
 * for killer-match, it's the turn — not this gate — that actually claims). Only a
 * clean `eligible:false` prints `{ wakeAgent:false }`.
 *
 * stdout carries exactly one JSON line (the contract); sendAction's own logs go
 * to stderr, so they never pollute the parsed line.
 */
import { sendAction, type ActionResponse } from './action.js';

const VALID_TRIGGERS = new Set(['killer-match', 'close-detection']);

interface EligibilityData {
  eligible: boolean;
  count: number;
  reason?: string;
}

export interface WakeDecision {
  wakeAgent: boolean;
  data: unknown;
}

/**
 * Pure mapping from a trigger + the host's action response to the wake decision.
 * Fail-open everywhere except a clean `eligible:false`. Unit-tested without the
 * round-trip; `main` supplies the real `sendAction` result.
 */
export function eligibilityToWake(trigger: string, res: ActionResponse<EligibilityData>): WakeDecision {
  if (!VALID_TRIGGERS.has(trigger)) {
    return { wakeAgent: true, data: { reason: `unknown trigger "${trigger}"` } };
  }
  if (!res.ok) {
    return { wakeAgent: true, data: { reason: `eligibility check failed: ${res.error.code}` } };
  }
  if (typeof res.data?.eligible !== 'boolean') {
    return { wakeAgent: true, data: { reason: 'malformed eligibility response' } };
  }
  return { wakeAgent: res.data.eligible, data: { trigger, count: res.data.count ?? null } };
}

async function main(): Promise<void> {
  const trigger = process.argv[2] ?? '';
  // Resolve the decision even on a bad arg (fail-open) without a round-trip.
  if (!VALID_TRIGGERS.has(trigger)) {
    console.log(JSON.stringify(eligibilityToWake(trigger, { ok: false, error: { code: 'BAD_TRIGGER', message: '' } })));
    return;
  }
  const res = await sendAction<EligibilityData>('career_pilot.check_trigger_eligibility', { trigger });
  console.log(JSON.stringify(eligibilityToWake(trigger, res)));
}

// Only run when invoked directly (the pre-wake script), not when imported by a test.
if (import.meta.main) {
  main().catch((err) => {
    // Any unexpected throw is still fail-open — never silently drop a fire.
    console.log(JSON.stringify({ wakeAgent: true, data: { reason: `eligibility check threw: ${String(err)}` } }));
  });
}
