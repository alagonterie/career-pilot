import { describe, it, expect } from 'bun:test';

import { sdkSystemMessageToEvent } from './claude.js';

// §24.128: sdkSystemMessageToEvent is the pure classifier extracted from the
// streaming loop so the SDK 0.3.x discriminator shapes are testable without an
// SDK mock. The load-bearing case is rate_limit_event: at 0.3.x it is its own
// top-level message type, NOT a `system` subtype as it was read before — the
// silent break this stage fixes.

describe('sdkSystemMessageToEvent', () => {
  it('classifies the 0.3.x top-level rate_limit_event (the bumped shape)', () => {
    expect(sdkSystemMessageToEvent({ type: 'rate_limit_event', rate_limit_info: {} })).toEqual({
      type: 'error',
      message: 'Rate limit',
      retryable: false,
      classification: 'quota',
    });
  });

  it('still classifies the legacy system/rate_limit_event subtype (defensive)', () => {
    expect(sdkSystemMessageToEvent({ type: 'system', subtype: 'rate_limit_event' })).toEqual({
      type: 'error',
      message: 'Rate limit',
      retryable: false,
      classification: 'quota',
    });
  });

  it('surfaces the 0.3.x task_notification status beat', () => {
    expect(sdkSystemMessageToEvent({ type: 'system', subtype: 'task_notification', status: 'completed' })).toEqual({
      type: 'progress',
      message: 'Task completed',
    });
  });

  it('prefers the task_notification summary when present', () => {
    expect(
      sdkSystemMessageToEvent({ type: 'system', subtype: 'task_notification', status: 'completed', summary: 'kit ready' }),
    ).toEqual({ type: 'progress', message: 'kit ready' });
  });

  it('falls back to a generic task label with no status or summary', () => {
    expect(sdkSystemMessageToEvent({ type: 'system', subtype: 'task_notification' })).toEqual({
      type: 'progress',
      message: 'Task notification',
    });
  });

  it('classifies api_retry as a retryable error', () => {
    expect(sdkSystemMessageToEvent({ type: 'system', subtype: 'api_retry' })).toEqual({
      type: 'error',
      message: 'API retry',
      retryable: true,
    });
  });

  it('renders compact_boundary with the pre-compaction token count', () => {
    expect(
      sdkSystemMessageToEvent({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 12345 } }),
    ).toEqual({ type: 'result', text: 'Context compacted (12,345 tokens compacted).' });
  });

  it('maps init to an init event carrying the session id as continuation', () => {
    expect(sdkSystemMessageToEvent({ type: 'system', subtype: 'init', session_id: 'sess-abc' })).toEqual({
      type: 'init',
      continuation: 'sess-abc',
    });
  });

  it('returns null for the turn-stateful result message and anything unrecognized', () => {
    expect(sdkSystemMessageToEvent({ type: 'result', total_cost_usd: 0.04 })).toBeNull();
    expect(sdkSystemMessageToEvent({ type: 'assistant', message: { content: [] } })).toBeNull();
    expect(sdkSystemMessageToEvent({ type: 'system', subtype: 'unknown_future_subtype' })).toBeNull();
    expect(sdkSystemMessageToEvent(null)).toBeNull();
    expect(sdkSystemMessageToEvent('nope')).toBeNull();
  });
});
