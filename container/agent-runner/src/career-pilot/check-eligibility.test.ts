import { describe, it, expect } from 'bun:test';

import { eligibilityToWake } from './check-eligibility.js';
import type { ActionResponse } from './action.js';

type Res = ActionResponse<{ eligible: boolean; count: number; reason?: string }>;

// §24.49c: the pre-wake gate decides wake/skip from the host's eligibility
// response. Skip ONLY on a clean eligible:false; everything else fails OPEN so
// a transient host hiccup never silently drops a real killer-match.
describe('eligibilityToWake', () => {
  it('wakes when the host reports eligible work', () => {
    const res: Res = { ok: true, data: { eligible: true, count: 2 } };
    expect(eligibilityToWake('killer-match', res)).toEqual({
      wakeAgent: true,
      data: { trigger: 'killer-match', count: 2 },
    });
  });

  it('skips (wakeAgent:false) ONLY on a clean eligible:false', () => {
    const res: Res = { ok: true, data: { eligible: false, count: 0 } };
    const out = eligibilityToWake('close-detection', res);
    expect(out.wakeAgent).toBe(false);
    expect(out.data).toEqual({ trigger: 'close-detection', count: 0 });
  });

  it('fails OPEN on a host error frame (timeout / DB error)', () => {
    const res: Res = { ok: false, error: { code: 'TIMEOUT', message: 'host did not respond' } };
    expect(eligibilityToWake('killer-match', res).wakeAgent).toBe(true);
  });

  it('fails OPEN on a malformed response missing the eligible boolean', () => {
    const res = { ok: true, data: { count: 5 } } as unknown as Res;
    expect(eligibilityToWake('killer-match', res).wakeAgent).toBe(true);
  });

  it('fails OPEN on an unknown trigger', () => {
    const res: Res = { ok: true, data: { eligible: false, count: 0 } };
    // Even though the response says not-eligible, an unknown trigger is a
    // misconfiguration → wake rather than silently swallow the fire.
    expect(eligibilityToWake('daily-briefing', res).wakeAgent).toBe(true);
  });

  it('tolerates a missing count (reports null, still respects eligible)', () => {
    const res = { ok: true, data: { eligible: true } } as unknown as Res;
    expect(eligibilityToWake('killer-match', res)).toEqual({
      wakeAgent: true,
      data: { trigger: 'killer-match', count: null },
    });
  });
});
