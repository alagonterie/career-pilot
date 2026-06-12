/**
 * Tests for the request-telemetry recorder (STRATEGY.md §24.68).
 *
 * Core invariants: rows land with the input faithfully coerced; the
 * `telemetry_capture` kill switch suppresses writes; error text is truncated;
 * the pricing map prices known models and returns null for unknown ones; the
 * prune deletes strictly-older-than rows only; nothing ever throws.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import {
  pruneRequestTelemetry,
  priceTokensMicrousd,
  recordRequestTelemetry,
  TELEMETRY_ERROR_CAP,
} from './request-telemetry.js';

interface Row {
  id: string;
  ts: string;
  provider: string;
  surface: string;
  traffic_class: string;
  session_id: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_microusd: number | null;
  latency_ms: number;
  status_code: number | null;
  ok: number;
  error: string | null;
  trace_id: string | null;
  details_json: string | null;
}

function allRows(): Row[] {
  return getDb().prepare('SELECT * FROM request_telemetry ORDER BY ts').all() as Row[];
}

beforeEach(() => {
  initTestDb();
  runMigrations(getDb());
});

afterEach(() => {
  closeDb();
});

describe('recordRequestTelemetry', () => {
  it('writes a success row with all fields', () => {
    recordRequestTelemetry({
      provider: 'portkey',
      surface: 'recruiter-sim-prose',
      trafficClass: 'host',
      ok: true,
      latencyMs: 412,
      statusCode: 200,
      model: 'claude-haiku-4-5',
      inputTokens: 200,
      outputTokens: 150,
      cacheReadTokens: 0,
      cacheCreationTokens: null,
      costMicrousd: 950,
      traceId: 'trace-1',
      details: { raw_usage: { prompt_tokens: 200 } },
    });
    const rows = allRows();
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.provider).toBe('portkey');
    expect(r.surface).toBe('recruiter-sim-prose');
    expect(r.traffic_class).toBe('host');
    expect(r.ok).toBe(1);
    expect(r.status_code).toBe(200);
    expect(r.input_tokens).toBe(200);
    expect(r.output_tokens).toBe(150);
    expect(r.cost_microusd).toBe(950);
    expect(r.latency_ms).toBe(412);
    expect(r.error).toBeNull();
    expect(r.trace_id).toBe('trace-1');
    expect(JSON.parse(r.details_json as string)).toEqual({ raw_usage: { prompt_tokens: 200 } });
  });

  it('writes a failure row with a status code and no tokens', () => {
    recordRequestTelemetry({
      provider: 'gmail',
      surface: 'sim-inject',
      trafficClass: 'host',
      ok: false,
      latencyMs: 90,
      statusCode: 401,
      error: 'gmail insert HTTP 401: invalid_grant',
    });
    const r = allRows()[0];
    expect(r.ok).toBe(0);
    expect(r.status_code).toBe(401);
    expect(r.input_tokens).toBeNull();
    expect(r.error).toContain('invalid_grant');
  });

  it('truncates error text to the cap', () => {
    recordRequestTelemetry({
      provider: 'serpapi',
      surface: 'serpapi-search',
      trafficClass: 'host',
      ok: false,
      latencyMs: 5,
      error: 'x'.repeat(TELEMETRY_ERROR_CAP + 500),
    });
    expect((allRows()[0].error as string).length).toBe(TELEMETRY_ERROR_CAP);
  });

  it('respects the telemetry_capture kill switch', () => {
    getDb()
      .prepare("INSERT INTO preferences (key, value, updated_at) VALUES ('telemetry_capture', 'false', datetime('now'))")
      .run();
    recordRequestTelemetry({ provider: 'portkey', surface: 'x', trafficClass: 'host', ok: true, latencyMs: 1 });
    expect(allRows()).toHaveLength(0);
  });

  it('never throws — even with no table', () => {
    getDb().exec('DROP TABLE request_telemetry');
    expect(() =>
      recordRequestTelemetry({ provider: 'portkey', surface: 'x', trafficClass: 'host', ok: true, latencyMs: 1 }),
    ).not.toThrow();
  });

  it('rejects an invalid traffic class at the schema level', () => {
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO request_telemetry (id, ts, provider, surface, traffic_class, latency_ms, ok)
           VALUES ('rt-x', '2026-06-12T00:00:00Z', 'portkey', 'x', 'bogus', 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe('priceTokensMicrousd', () => {
  it('prices a typical Haiku prose call at ~950 µUSD', () => {
    // 200 in × $1/MTok + 150 out × $5/MTok = $0.00095 = 950 µUSD
    const cost = priceTokensMicrousd(getDb(), 'claude-haiku-4-5', { inputTokens: 200, outputTokens: 150 });
    expect(cost).toBe(950);
  });

  it('includes cache lanes', () => {
    const cost = priceTokensMicrousd(getDb(), 'claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000, // $0.10
      cacheCreationTokens: 1_000_000, // $1.25
    });
    expect(cost).toBe(1_350_000);
  });

  it('returns null for a model not in the pricing map', () => {
    expect(priceTokensMicrousd(getDb(), 'unknown-model', { inputTokens: 100 })).toBeNull();
    expect(priceTokensMicrousd(getDb(), null, { inputTokens: 100 })).toBeNull();
  });
});

describe('pruneRequestTelemetry', () => {
  function insertAt(id: string, ts: string): void {
    getDb()
      .prepare(
        `INSERT INTO request_telemetry (id, ts, provider, surface, traffic_class, latency_ms, ok)
         VALUES (?, ?, 'portkey', 'x', 'host', 1, 1)`,
      )
      .run(id, ts);
  }

  it('deletes strictly-older-than rows and keeps the boundary row', () => {
    const now = Date.now();
    const retentionDays = 30;
    insertAt('rt-old', new Date(now - 31 * 86_400_000).toISOString());
    // Just inside the window (a minute newer than the cutoff) — must survive.
    insertAt('rt-boundary', new Date(now - retentionDays * 86_400_000 + 60_000).toISOString());
    insertAt('rt-new', new Date(now).toISOString());

    const deleted = pruneRequestTelemetry(getDb(), retentionDays);
    expect(deleted).toBe(1);
    expect(allRows().map((r) => r.id).sort()).toEqual(['rt-boundary', 'rt-new']);
  });

  it('returns 0 when the table is absent', () => {
    getDb().exec('DROP TABLE request_telemetry');
    expect(pruneRequestTelemetry(getDb(), 30)).toBe(0);
  });
});
