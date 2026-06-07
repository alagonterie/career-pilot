/**
 * Pre-wake `script` body for a scheduled trigger (§24.49c).
 *
 * Stored in the task row's `content.script`; runs in the container BEFORE the
 * agent turn (`applyPreTaskScripts` → bash → bun). The CLI round-trips to the
 * host's read-only `career_pilot.check_trigger_eligibility` action and prints
 * `{ wakeAgent }`, so a no-eligible-work fire is dropped with zero model call.
 *
 * `/app/src` is the RO-mounted agent-runner source (see container-runner.ts).
 * Single source of truth so killer-match + close-detection can't drift on the
 * path or invocation.
 */
export type GatedTrigger = 'killer-match' | 'close-detection';

export function preWakeScript(trigger: GatedTrigger): string {
  return `bun /app/src/career-pilot/check-eligibility.ts ${trigger}`;
}
