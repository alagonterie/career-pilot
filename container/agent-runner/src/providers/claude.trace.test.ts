import { describe, it, expect } from 'bun:test';

import { sdkMessageToTraceEvents } from './claude.js';

// §24.20: sdkMessageToTraceEvents is the pure translation from one SDK message
// to simulator trace events. Owner path (emitTrace=false) must yield nothing.

function assistant(content: unknown[], parent: string | null = null) {
  return { type: 'assistant', message: { content }, parent_tool_use_id: parent };
}

describe('sdkMessageToTraceEvents', () => {
  it('emits nothing when emitTrace is false (owner path is byte-identical)', () => {
    const msg = assistant([{ type: 'tool_use', name: 'WebSearch', input: { query: 'x' } }]);
    expect(sdkMessageToTraceEvents(msg, false)).toEqual([]);
    expect(sdkMessageToTraceEvents({ type: 'result', total_cost_usd: 0.04 }, false)).toEqual([]);
  });

  it('translates tool_use blocks into tool events with an input summary', () => {
    const msg = assistant([
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', name: 'WebSearch', input: { query: 'Acme engineering' } },
    ]);
    const events = sdkMessageToTraceEvents(msg, true);
    expect(events).toHaveLength(1);
    expect(events[0].t).toBe('tool');
    expect(events[0].name).toBe('WebSearch');
    expect(events[0].input_summary).toContain('Acme engineering');
    expect(events[0].parent_tool_use_id).toBeNull();
  });

  it('translates a Task block into a subagent event carrying subagent_type', () => {
    const msg = assistant([
      { type: 'tool_use', name: 'Task', input: { subagent_type: 'research-company', prompt: 'go' } },
    ]);
    const events = sdkMessageToTraceEvents(msg, true);
    expect(events[0].t).toBe('subagent');
    expect(events[0].subagent).toBe('research-company');
  });

  it('translates an Agent block into a subagent event too (the real wire name — §24.31 Δ)', () => {
    const msg = assistant([
      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'tailor-resume', prompt: 'go' } },
    ]);
    const events = sdkMessageToTraceEvents(msg, true);
    expect(events[0].t).toBe('subagent');
    expect(events[0].subagent).toBe('tailor-resume');
  });

  it('carries parent_tool_use_id for calls made inside a subagent', () => {
    const msg = assistant([{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://x' } }], 'toolu_parent');
    const events = sdkMessageToTraceEvents(msg, true);
    expect(events[0].parent_tool_use_id).toBe('toolu_parent');
  });

  it('translates a result message into a single result event with cost', () => {
    const events = sdkMessageToTraceEvents({ type: 'result', total_cost_usd: 0.041 }, true);
    expect(events).toEqual([{ t: 'result', cost_usd: 0.041 }]);
  });

  it('emits nothing for text-only assistant messages and non-traceable types', () => {
    expect(sdkMessageToTraceEvents(assistant([{ type: 'text', text: 'hi' }]), true)).toEqual([]);
    expect(sdkMessageToTraceEvents({ type: 'system', subtype: 'init' }, true)).toEqual([]);
    expect(sdkMessageToTraceEvents({ type: 'user' }, true)).toEqual([]);
    expect(sdkMessageToTraceEvents(null, true)).toEqual([]);
  });
});
