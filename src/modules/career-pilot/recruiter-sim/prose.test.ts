import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const SAVED = {
  key: process.env.PORTKEY_API_KEY,
  bypass: process.env.PORTKEY_BYPASS,
  env: process.env.ENVIRONMENT,
};

describe('recruiter-sim prose', () => {
  beforeEach(() => {
    delete process.env.PORTKEY_API_KEY;
    delete process.env.PORTKEY_BYPASS;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (SAVED.key === undefined) delete process.env.PORTKEY_API_KEY;
    else process.env.PORTKEY_API_KEY = SAVED.key;
    if (SAVED.bypass === undefined) delete process.env.PORTKEY_BYPASS;
    else process.env.PORTKEY_BYPASS = SAVED.bypass;
    if (SAVED.env === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = SAVED.env;
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

  it('sends the §24.46 observability headers when enriching (metadata + trace id)', async () => {
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.ENVIRONMENT = 'dev';
    let headers: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'A nicely rewritten confirmation email body.' } }] }),
        } as unknown as Response;
      }),
    );
    const res = await enrichBody(intent, 1, intent.appId ?? undefined);
    expect(res.usedLlm).toBe(true);
    expect(headers['x-portkey-trace-id']).toBe('sim-1'); // intent.appId → groups the app's emails
    expect(JSON.parse(headers['x-portkey-metadata'])).toEqual({ environment: 'dev', surface: 'recruiter-sim-prose' });
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
