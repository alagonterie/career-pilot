/**
 * §24.144 — the `emit_tailored_resume` forcing function. The structured-output
 * guarantee lives in the handler: a stub/empty bio (or no experience) returns
 * `isError`, so the Agent SDK loop continues and the agent re-emits a real,
 * role-specific bio rather than silently flooring to the master. These branches
 * return BEFORE `sendAction` is reached, so no host round-trip / mock is needed.
 */
import { describe, expect, it } from 'bun:test';

import { emitColdEmail, emitTailoredResume } from './career-pilot.js';

const REAL_BIO = ['A senior backend engineer with a decade of platform experience, a strong fit for this distributed-systems role.'];
const REAL_EXP = [{ company: 'Acme', role: 'Senior Engineer', period: '2018–2024', bullets: ['Built the thing'] }];

describe('emit_tailored_resume handler (structured-output forcing function)', () => {
  it('rejects an empty bio with isError', async () => {
    const r = await emitTailoredResume.handler({ profile: { bio: [], experience: REAL_EXP } });
    expect(r.isError).toBe(true);
  });

  it('rejects a stub bio below the substance floor with isError', async () => {
    const r = await emitTailoredResume.handler({ profile: { bio: ['Too short.'], experience: REAL_EXP } });
    expect(r.isError).toBe(true);
  });

  it('rejects a missing/empty experience with isError', async () => {
    const r = await emitTailoredResume.handler({ profile: { bio: REAL_BIO, experience: [] } });
    expect(r.isError).toBe(true);
  });

  it('rejects a non-object profile with isError', async () => {
    const r = await emitTailoredResume.handler({ profile: 'nope' });
    expect(r.isError).toBe(true);
  });
});

const REAL_BODY =
  'Hi there, I came across your team and the role really resonates with the systems work I have been doing. I would love to share how my background maps to it. Could we find fifteen minutes? — Jane';

describe('emit_cold_email handler (structured-output forcing function)', () => {
  it('rejects an empty subject with isError', async () => {
    const r = await emitColdEmail.handler({ subject: '', body: REAL_BODY });
    expect(r.isError).toBe(true);
  });

  it('rejects a stub body below the substance floor with isError', async () => {
    const r = await emitColdEmail.handler({ subject: 'Re: your backend role', body: 'See attached.' });
    expect(r.isError).toBe(true);
  });

  it('rejects a missing body with isError', async () => {
    const r = await emitColdEmail.handler({ subject: 'Re: your backend role' });
    expect(r.isError).toBe(true);
  });
});
