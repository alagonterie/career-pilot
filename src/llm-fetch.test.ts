/**
 * Tests for the shared Portkey chat-completions helper (STRATEGY.md §24.68 D5).
 *
 * Core invariants: usage is read from BOTH response shapes (OpenAI
 * prompt/completion_tokens and Anthropic input/output_tokens) and degrades to
 * nulls when absent; cost is priced from the defaults map; a telemetry row
 * lands on success AND on every failure mode (HTTP error, network reject,
 * non-JSON body, empty completion) before the error reaches the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { callPortkeyChat, extractUsage, portkeyConfigured } from './llm-fetch.js';

interface Row {
  provider: string;
  surface: string;
  traffic_class: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_microusd: number | null;
  status_code: number | null;
  ok: number;
  error: string | null;
  details_json: string | null;
}

function rows(): Row[] {
  return getDb().prepare('SELECT * FROM request_telemetry').all() as Row[];
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const COMPLETION = { choices: [{ message: { content: 'hello world' } }] };

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
  process.env.PORTKEY_API_KEY = 'pk-test';
  delete process.env.PORTKEY_BYPASS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PORTKEY_API_KEY;
  closeDb();
});

describe('portkeyConfigured', () => {
  it('reflects the key + bypass flag', () => {
    delete process.env.PORTKEY_API_KEY;
    expect(portkeyConfigured()).toBe(false);
    process.env.PORTKEY_API_KEY = 'pk-test';
    expect(portkeyConfigured()).toBe(true);
    process.env.PORTKEY_BYPASS = 'true';
    expect(portkeyConfigured()).toBe(false);
    delete process.env.PORTKEY_BYPASS;
  });
});

describe('extractUsage', () => {
  it('reads the OpenAI shape', () => {
    expect(
      extractUsage({ prompt_tokens: 200, completion_tokens: 150, prompt_tokens_details: { cached_tokens: 50 } }),
    ).toEqual({ inputTokens: 200, outputTokens: 150, cacheReadTokens: 50, cacheCreationTokens: null });
  });

  it('reads the Anthropic passthrough shape', () => {
    expect(
      extractUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 7 });
  });

  it('degrades to nulls for missing/garbage usage', () => {
    expect(extractUsage(undefined)).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
    expect(extractUsage({ prompt_tokens: 'NaN' }).inputTokens).toBeNull();
  });
});

describe('callPortkeyChat', () => {
  it('returns text + usage + priced cost and records a success row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ ...COMPLETION, usage: { prompt_tokens: 200, completion_tokens: 150 } })),
    );
    const result = await callPortkeyChat({
      surface: 'recruiter-sim-prose',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 320,
    });
    expect(result.text).toBe('hello world');
    expect(result.usage.inputTokens).toBe(200);
    // 200 in × $1/MTok + 150 out × $5/MTok on Haiku = 950 µUSD
    expect(result.costMicrousd).toBe(950);

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].ok).toBe(1);
    expect(r[0].provider).toBe('portkey');
    expect(r[0].surface).toBe('recruiter-sim-prose');
    expect(r[0].traffic_class).toBe('host');
    expect(r[0].model).toBe('claude-haiku-4-5');
    expect(r[0].input_tokens).toBe(200);
    expect(r[0].cost_microusd).toBe(950);
    expect(JSON.parse(r[0].details_json as string).raw_usage.prompt_tokens).toBe(200);
  });

  it('succeeds with null tokens when usage is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(COMPLETION)));
    const result = await callPortkeyChat({
      surface: 'win-confidence',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
    });
    expect(result.text).toBe('hello world');
    expect(result.usage.inputTokens).toBeNull();
    expect(result.costMicrousd).toBeNull();
    expect(rows()[0].ok).toBe(1);
    expect(rows()[0].input_tokens).toBeNull();
  });

  it('records a failure row and throws on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })));
    await expect(
      callPortkeyChat({ surface: 'win-confidence', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }),
    ).rejects.toThrow('portkey HTTP 401');
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].ok).toBe(0);
    expect(r[0].status_code).toBe(401);
    expect(r[0].error).toContain('401');
  });

  it('records a failure row with a NULL status on a network reject', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await expect(
      callPortkeyChat({ surface: 'sanitizer-pass3', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(rows()[0].ok).toBe(0);
    expect(rows()[0].status_code).toBeNull();
  });

  it('records a failure row on an empty completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ choices: [] })));
    await expect(
      callPortkeyChat({ surface: 'win-confidence', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }),
    ).rejects.toThrow('no content');
    expect(rows()[0].ok).toBe(0);
    expect(rows()[0].status_code).toBe(200);
  });

  it('sends the provider slug in the model field and the surface in metadata', async () => {
    const fetchMock = vi.fn(async () => okResponse(COMPLETION));
    vi.stubGlobal('fetch', fetchMock);
    process.env.PORTKEY_AI_PROVIDER = 'anthropic-prod';
    await callPortkeyChat({
      surface: 'sanitizer-pass3',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      model: 'claude-haiku-4-5',
    });
    delete process.env.PORTKEY_AI_PROVIDER;
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/chat/completions');
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe('@anthropic-prod/claude-haiku-4-5');
    const headers = init.headers as Record<string, string>;
    expect(JSON.parse(headers['x-portkey-metadata']).surface).toBe('sanitizer-pass3');
  });
});
