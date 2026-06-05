import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HAIKU_EST_COST_USD, enrichBody, portkeyConfigured, sanitizeProse } from './prose.js';
import type { InjectEmailIntent } from './types.js';

const intent: InjectEmailIntent = {
  type: 'inject_email',
  appId: 'sim-1',
  classification: 'application_confirmation',
  newThread: true,
  threadId: null,
  fromName: 'Acme Talent',
  fromAddress: 'talent@acme.example',
  subject: 'We received your application',
  deterministicBody: 'Thanks for applying. We will be in touch.',
  prosePrompt: 'Rewrite this confirmation.',
  internalDateMs: 0,
  calendar: null,
};

const SAVED = { key: process.env.PORTKEY_API_KEY, bypass: process.env.PORTKEY_BYPASS };

describe('recruiter-sim prose', () => {
  beforeEach(() => {
    delete process.env.PORTKEY_API_KEY;
    delete process.env.PORTKEY_BYPASS;
  });
  afterEach(() => {
    if (SAVED.key === undefined) delete process.env.PORTKEY_API_KEY;
    else process.env.PORTKEY_API_KEY = SAVED.key;
    if (SAVED.bypass === undefined) delete process.env.PORTKEY_BYPASS;
    else process.env.PORTKEY_BYPASS = SAVED.bypass;
  });

  it('portkeyConfigured reflects the key + bypass flag', () => {
    expect(portkeyConfigured()).toBe(false);
    process.env.PORTKEY_API_KEY = 'pk-test';
    expect(portkeyConfigured()).toBe(true);
    process.env.PORTKEY_BYPASS = 'true';
    expect(portkeyConfigured()).toBe(false);
  });

  it('uses the deterministic body when Portkey is not configured (no network)', async () => {
    const res = await enrichBody(intent, 1);
    expect(res.usedLlm).toBe(false);
    expect(res.body).toBe(intent.deterministicBody);
    expect(res.estCostUsd).toBe(0);
  });

  it('uses the deterministic body when over budget — without calling out', async () => {
    process.env.PORTKEY_API_KEY = 'pk-test'; // configured, but budget gates before any fetch
    const res = await enrichBody(intent, HAIKU_EST_COST_USD / 2);
    expect(res.usedLlm).toBe(false);
    expect(res.body).toBe(intent.deterministicBody);
  });

  it('sanitizeProse trims, strips a Subject line and surrounding quotes, and caps length', () => {
    expect(sanitizeProse('  Hello there, this is a fine body of text.  ')).toBe(
      'Hello there, this is a fine body of text.',
    );
    expect(sanitizeProse('Subject: hi\nThe real body content goes right here.')).toBe(
      'The real body content goes right here.',
    );
    expect(sanitizeProse('"A quoted body that is long enough to keep."')).toBe(
      'A quoted body that is long enough to keep.',
    );
    expect(sanitizeProse('x'.repeat(3000)).length).toBe(1500);
  });

  it('sanitizeProse throws on an implausibly short completion', () => {
    expect(() => sanitizeProse('ok')).toThrow(/too short/);
  });
});
