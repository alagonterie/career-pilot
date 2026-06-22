import { describe, it, expect } from 'bun:test';

import { isRecordCallToolName, sdkResultToTurnTelemetry } from './claude.js';

// §24.34: per-turn telemetry capture. sdkResultToTurnTelemetry is the pure
// derivation from an SDK `result` message (record_calls is added by the
// caller). isRecordCallToolName is the portal-worthy tool-name matcher.

const modelUsage = {
  'claude-opus-4-8': {
    inputTokens: 12000,
    outputTokens: 800,
    cacheReadInputTokens: 9000,
    cacheCreationInputTokens: 0,
    costUSD: 0.039,
  },
  'claude-haiku-4-5': {
    inputTokens: 4000,
    outputTokens: 200,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0.002,
  },
};

function result(extra: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.041,
    duration_ms: 1234,
    duration_api_ms: 1100,
    num_turns: 3,
    modelUsage,
    ...extra,
  };
}

describe('sdkResultToTurnTelemetry', () => {
  it('returns null for any non-result message', () => {
    expect(sdkResultToTurnTelemetry({ type: 'assistant', message: { content: [] } })).toBeNull();
    expect(sdkResultToTurnTelemetry({ type: 'system', subtype: 'init' })).toBeNull();
    expect(sdkResultToTurnTelemetry(null)).toBeNull();
    expect(sdkResultToTurnTelemetry('nope')).toBeNull();
  });

  it('derives the per-turn economics from a result message', () => {
    const t = sdkResultToTurnTelemetry(result());
    expect(t).not.toBeNull();
    // Primary model = the highest-cost one.
    expect(t!.model_used).toBe('claude-opus-4-8');
    // tokens = sum of input + output across models.
    expect(t!.tokens).toBe(12000 + 800 + 4000 + 200);
    // cost_cents = round(0.041 * 100) = 4.
    expect(t!.cost_cents).toBe(4);
    // any model read from cache → cache_hit.
    expect(t!.cache_hit).toBe(1);
    expect(t!.latency_ms).toBe(1234);
    expect(t!.details.num_turns).toBe(3);
    expect(t!.details.duration_api_ms).toBe(1100);
    expect(t!.details.total_cost_usd).toBe(0.041);
    expect(t!.details.model_usage['claude-haiku-4-5'].cost_usd).toBe(0.002);
  });

  it('sets cache_hit=0 when no model read from cache', () => {
    const t = sdkResultToTurnTelemetry(
      result({ modelUsage: { 'claude-opus-4-8': { inputTokens: 100, outputTokens: 50, costUSD: 0.01 } } }),
    );
    expect(t!.cache_hit).toBe(0);
  });

  it('rounds sub-cent turns to 0 cents (the known cost_cents fidelity limit)', () => {
    const t = sdkResultToTurnTelemetry(result({ total_cost_usd: 0.004 }));
    expect(t!.cost_cents).toBe(0);
  });

  it('falls back to cumulative result usage when modelUsage is absent', () => {
    const t = sdkResultToTurnTelemetry({
      type: 'result',
      total_cost_usd: 0.02,
      usage: { input_tokens: 500, output_tokens: 120 },
    });
    expect(t!.tokens).toBe(620);
    expect(t!.model_used).toBeNull();
    expect(t!.cache_hit).toBe(0);
  });

  it('is defensive against missing/garbage fields', () => {
    const t = sdkResultToTurnTelemetry({ type: 'result' });
    expect(t).toEqual({
      model_used: null,
      tokens: 0,
      cost_cents: 0,
      cache_hit: 0,
      latency_ms: 0,
      details: { num_turns: 0, duration_api_ms: 0, total_cost_usd: 0, model_usage: {} },
    });
  });
});

describe('isRecordCallToolName', () => {
  it('matches the record_* MCP tools by suffix (robust to the server prefix)', () => {
    expect(isRecordCallToolName('mcp__career-pilot__record_pipeline_event')).toBe(true);
    expect(isRecordCallToolName('mcp__career-pilot__record_progress')).toBe(true);
    expect(isRecordCallToolName('mcp__cp__record_progress')).toBe(true);
  });

  it('rejects other tools and non-strings', () => {
    expect(isRecordCallToolName('mcp__career-pilot__record_job_lead')).toBe(false);
    expect(isRecordCallToolName('mcp__career-pilot__update_application')).toBe(false);
    expect(isRecordCallToolName('WebSearch')).toBe(false);
    expect(isRecordCallToolName('Task')).toBe(false);
    expect(isRecordCallToolName(undefined)).toBe(false);
    expect(isRecordCallToolName(123)).toBe(false);
  });
});
