/**
 * Container-side request-telemetry tests (STRATEGY.md §24.68).
 *
 * Core invariants: `reportRequestTelemetry` writes one fire-and-forget
 * `record_request_telemetry` system action to outbound.db with the payload
 * shape the host handler parses, and NEVER throws into the tool path; the
 * instrumented call sites (rank-leads, serpapi-search) report usage on
 * success and status/error on failure while preserving their existing throw
 * behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { rankLeads, RankLeadsError } from './rank-leads.js';
import { searchGoogleJobs, SearchJobsError } from './serpapi-search.js';
import { reportRequestTelemetry } from './telemetry.js';

interface TelemetryRow {
  action: string;
  payload: Record<string, unknown>;
}

let outbound: Database;
const realFetch = globalThis.fetch;

function telemetryRows(): TelemetryRow[] {
  const rows = outbound.prepare("SELECT content FROM messages_out WHERE kind = 'system'").all() as Array<{
    content: string;
  }>;
  return rows
    .map((r) => JSON.parse(r.content) as { action: string; payload: Record<string, unknown> })
    .filter((c) => c.action === 'career_pilot.record_request_telemetry')
    .map((c) => ({ action: c.action, payload: c.payload }));
}

/** The fire-and-forget report is async — give its microtask/write a beat. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

beforeEach(() => {
  ({ outbound } = initTestSessionDb());
});

afterEach(() => {
  globalThis.fetch = realFetch;
  closeSessionDb();
});

describe('reportRequestTelemetry', () => {
  it('writes one system action row with the host-parsable payload', async () => {
    await reportRequestTelemetry({
      provider: 'serpapi',
      surface: 'serpapi-search',
      ok: false,
      latencyMs: 120,
      statusCode: 429,
      error: '429 Too Many Requests',
    });
    const rows = telemetryRows();
    expect(rows.length).toBe(1);
    expect(rows[0].payload.provider).toBe('serpapi');
    expect(rows[0].payload.surface).toBe('serpapi-search');
    expect(rows[0].payload.ok).toBe(false);
    expect(rows[0].payload.latency_ms).toBe(120);
    expect(rows[0].payload.status_code).toBe(429);
    expect(rows[0].payload.error).toBe('429 Too Many Requests');
    // The trust boundary: no class / session / cost in the payload.
    expect('traffic_class' in rows[0].payload).toBe(false);
    expect('cost_microusd' in rows[0].payload).toBe(false);
  });

  it('flattens usage into snake_case token fields', async () => {
    await reportRequestTelemetry({
      provider: 'portkey',
      surface: 'rank-leads',
      ok: true,
      latencyMs: 800,
      statusCode: 200,
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 100, cacheCreationTokens: null },
    });
    const p = telemetryRows()[0].payload;
    expect(p.input_tokens).toBe(1200);
    expect(p.output_tokens).toBe(300);
    expect(p.cache_read_tokens).toBe(100);
    expect(p.cache_creation_tokens).toBe(null);
    expect(p.model).toBe('claude-haiku-4-5');
  });

  it('never throws when the outbound write fails', async () => {
    outbound.exec('DROP TABLE messages_out');
    // Must resolve without throwing — telemetry must not break the tool path.
    await reportRequestTelemetry({ provider: 'gmail', surface: 'x', ok: true, latencyMs: 1 });
  });
});

describe('rank-leads telemetry', () => {
  const leads = [{ id: 'L1', source: 'greenhouse', title: 'Engineer', company: 'Acme' }];

  it('reports usage from the Anthropic /v1/messages response on success', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"leads":[{"id":"L1","llm_score":80}]}' }],
          usage: { input_tokens: 1500, output_tokens: 60, cache_read_input_tokens: 0 },
        }),
        { status: 200 },
      )) as typeof fetch;

    const out = await rankLeads(leads, 'find me a great role');
    expect(out[0].id).toBe('L1');
    await settle();

    const rows = telemetryRows();
    expect(rows.length).toBe(1);
    const p = rows[0].payload;
    expect(p.provider).toBe('portkey');
    expect(p.surface).toBe('rank-leads');
    expect(p.ok).toBe(true);
    expect(p.status_code).toBe(200);
    expect(p.input_tokens).toBe(1500);
    expect(p.output_tokens).toBe(60);
  });

  it('reports a failure row with the status on an HTTP error — and still throws', async () => {
    globalThis.fetch = (async () => new Response('overloaded', { status: 529 })) as typeof fetch;

    await expect(rankLeads(leads, 'brief')).rejects.toBeInstanceOf(RankLeadsError);
    await settle();

    const rows = telemetryRows();
    expect(rows.length).toBe(1);
    expect(rows[0].payload.ok).toBe(false);
    expect(rows[0].payload.status_code).toBe(529);
    expect(String(rows[0].payload.error)).toContain('529');
  });
});

describe('serpapi-search telemetry', () => {
  it('reports a failure row on an HTTP error — and still throws SearchJobsError', async () => {
    globalThis.fetch = (async () => new Response('quota exhausted', { status: 429 })) as typeof fetch;

    await expect(searchGoogleJobs({ query: 'software engineer' })).rejects.toBeInstanceOf(SearchJobsError);
    await settle();

    const rows = telemetryRows();
    expect(rows.length).toBe(1);
    expect(rows[0].payload.provider).toBe('serpapi');
    expect(rows[0].payload.ok).toBe(false);
    expect(rows[0].payload.status_code).toBe(429);
  });

  it('reports a success row on a clean page fetch', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ jobs_results: [] }), { status: 200 })) as typeof fetch;

    const out = await searchGoogleJobs({ query: 'software engineer' });
    expect(out).toEqual([]);
    await settle();

    const rows = telemetryRows();
    expect(rows.length).toBe(1);
    expect(rows[0].payload.ok).toBe(true);
    expect(rows[0].payload.status_code).toBe(200);
  });
});
