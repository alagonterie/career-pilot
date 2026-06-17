import { describe, it, expect } from 'bun:test';

import { sdkMessageToTraceEvents, subagentDispatchesFromMessage } from './claude.js';

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

// §24.78: subagentDispatchesFromMessage feeds the deterministic owner-path
// lifecycle trace. It must read ONLY subagent_type (PII-safe), never emitTrace-gated.
describe('subagentDispatchesFromMessage (§24.78)', () => {
  it('returns the subagent_type of an Agent dispatch', () => {
    const msg = assistant([{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'scrape-jobs', prompt: 'go' } }]);
    expect(subagentDispatchesFromMessage(msg)).toEqual(['scrape-jobs']);
  });

  it('handles the Task alias and multiple dispatches in one message', () => {
    const msg = assistant([
      { type: 'tool_use', name: 'Task', input: { subagent_type: 'funnel-curator', prompt: 'sweep' } },
      { type: 'text', text: 'and also' },
      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'research-company', prompt: 'x' } },
    ]);
    expect(subagentDispatchesFromMessage(msg)).toEqual(['funnel-curator', 'research-company']);
  });

  it('reads ONLY subagent_type — never the prompt/input (the PII-safety guarantee)', () => {
    const msg = assistant([
      { type: 'tool_use', name: 'Agent', input: { subagent_type: 'scrape-jobs', prompt: 'scan Acme + Stripe boards' } },
    ]);
    // The result is the agent name alone; no part of the prompt leaks through.
    expect(subagentDispatchesFromMessage(msg)).toEqual(['scrape-jobs']);
  });

  it('ignores non-delegation tool_use, and non-assistant / empty messages', () => {
    expect(subagentDispatchesFromMessage(assistant([{ type: 'tool_use', name: 'WebSearch', input: { query: 'x' } }]))).toEqual([]);
    expect(subagentDispatchesFromMessage(assistant([{ type: 'tool_use', name: 'Agent', input: {} }]))).toEqual([]);
    expect(subagentDispatchesFromMessage({ type: 'result', total_cost_usd: 0.04 })).toEqual([]);
    expect(subagentDispatchesFromMessage({ type: 'user' })).toEqual([]);
    expect(subagentDispatchesFromMessage(null)).toEqual([]);
  });
});
