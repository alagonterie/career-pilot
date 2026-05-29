/**
 * Focused tests for `parseAgentMessages` — the pure parser used by
 * `dispatchResultText` to split agent output into deliverable blocks +
 * scratchpad. Covers both the strict path (complete <message>...</message>
 * blocks) and the lenient salvage path for dangling open tags (task #87).
 */
import { describe, it, expect } from 'bun:test';

import { parseAgentMessages, detectAgentTextEmission } from './poll-loop.js';

describe('parseAgentMessages — strict path', () => {
  it('parses a single complete block, body trimmed', () => {
    const r = parseAgentMessages('<message to="owner">Hi there</message>');
    expect(r.parseMode).toBe('strict');
    expect(r.blocks).toEqual([{ toName: 'owner', body: 'Hi there' }]);
    expect(r.scratchpad).toBe('');
  });

  it('parses multiple blocks in source order', () => {
    const r = parseAgentMessages(
      '<message to="owner">First</message>\n<message to="other">Second</message>',
    );
    expect(r.parseMode).toBe('strict');
    expect(r.blocks).toEqual([
      { toName: 'owner', body: 'First' },
      { toName: 'other', body: 'Second' },
    ]);
  });

  it('collects bare prose between blocks as scratchpad', () => {
    const r = parseAgentMessages(
      'prefix scratch\n<message to="owner">delivered</message>\ntrailing scratch',
    );
    expect(r.parseMode).toBe('strict');
    expect(r.blocks).toEqual([{ toName: 'owner', body: 'delivered' }]);
    expect(r.scratchpad).toContain('prefix scratch');
    expect(r.scratchpad).toContain('trailing scratch');
  });

  it('strips <internal>...</internal> from scratchpad', () => {
    const r = parseAgentMessages(
      '<internal>thinking out loud</internal>\n<message to="owner">visible</message>',
    );
    expect(r.parseMode).toBe('strict');
    expect(r.blocks).toEqual([{ toName: 'owner', body: 'visible' }]);
    expect(r.scratchpad).not.toContain('thinking out loud');
  });
});

describe('parseAgentMessages — lenient salvage (task #87)', () => {
  it('salvages a single dangling <message to="X"> with no close (the GLM failure mode)', () => {
    const r = parseAgentMessages(
      '<message to="owner">This body has no close tag because GLM forgot',
    );
    expect(r.parseMode).toBe('lenient-recovered');
    expect(r.blocks).toEqual([
      { toName: 'owner', body: 'This body has no close tag because GLM forgot' },
    ]);
    expect(r.scratchpad).toBe('');
  });

  it('treats text BEFORE the dangling open as scratchpad', () => {
    const r = parseAgentMessages(
      'some leading prose\n<message to="owner">body content',
    );
    expect(r.parseMode).toBe('lenient-recovered');
    expect(r.blocks[0].body).toBe('body content');
    expect(r.scratchpad).toContain('some leading prose');
  });

  it('strips <internal>...</internal> from a lenient body', () => {
    const r = parseAgentMessages(
      '<message to="owner">visible content\n<internal>private thought</internal>\nmore visible',
    );
    expect(r.parseMode).toBe('lenient-recovered');
    expect(r.blocks[0].body).toContain('visible content');
    expect(r.blocks[0].body).toContain('more visible');
    expect(r.blocks[0].body).not.toContain('private thought');
  });

  it('does NOT trigger lenient mode when ANY complete block parses', () => {
    // First block closes correctly; second is dangling. Strict mode wins;
    // the second dangling open is part of the scratchpad after the first.
    const r = parseAgentMessages(
      '<message to="owner">first complete</message>\n<message to="other">dangling',
    );
    expect(r.parseMode).toBe('strict');
    expect(r.blocks).toEqual([{ toName: 'owner', body: 'first complete' }]);
    expect(r.scratchpad).toContain('<message to="other">dangling');
  });

  it('does NOT salvage when multiple dangling opens exist (ambiguous)', () => {
    const r = parseAgentMessages(
      '<message to="owner">first body\n<message to="other">second body',
    );
    expect(r.parseMode).toBe('no-blocks');
    expect(r.blocks).toEqual([]);
    // The text becomes scratchpad — operators see "no blocks parsed" warning.
    expect(r.scratchpad).toContain('first body');
    expect(r.scratchpad).toContain('second body');
  });

  it('does NOT salvage when the dangling block body is empty after trimming', () => {
    const r = parseAgentMessages('<message to="owner">   \n  ');
    expect(r.parseMode).toBe('no-blocks');
    expect(r.blocks).toEqual([]);
  });
});

describe('parseAgentMessages — no-blocks path', () => {
  it('returns no-blocks for bare text with no message tags at all', () => {
    const r = parseAgentMessages('just some bare text from the agent');
    expect(r.parseMode).toBe('no-blocks');
    expect(r.blocks).toEqual([]);
    expect(r.scratchpad).toBe('just some bare text from the agent');
  });

  it('returns no-blocks for empty input', () => {
    const r = parseAgentMessages('');
    expect(r.parseMode).toBe('no-blocks');
    expect(r.blocks).toEqual([]);
    expect(r.scratchpad).toBe('');
  });
});

describe('detectAgentTextEmission — GLM <Agent>-text failure (§24.13)', () => {
  it('detects a self-closing <Agent> with subagent_type + prompt (the observed failure)', () => {
    const text =
      'I\'ll research Anthropic for you now.\n\n' +
      '<Agent subagent_type="research-company" prompt="Research Anthropic for a Staff Backend Engineer." />';
    const r = detectAgentTextEmission(text);
    expect(r).toHaveLength(1);
    expect(r[0].tool).toBe('Agent');
    expect(r[0].subagentType).toBe('research-company');
    expect(r[0].prompt).toBe('Research Anthropic for a Staff Backend Engineer.');
  });

  it('detects a non-self-closing open tag', () => {
    const r = detectAgentTextEmission('<Agent subagent_type="scrape-jobs">do the thing</Agent>');
    expect(r).toHaveLength(1);
    expect(r[0].tool).toBe('Agent');
    expect(r[0].subagentType).toBe('scrape-jobs');
  });

  it('detects the <Task> alias', () => {
    const r = detectAgentTextEmission('<Task subagent_type="tailor-resume" prompt="x" />');
    expect(r).toHaveLength(1);
    expect(r[0].tool).toBe('Task');
    expect(r[0].subagentType).toBe('tailor-resume');
  });

  it('returns prompt:null when the tag has subagent_type but no prompt', () => {
    const r = detectAgentTextEmission('<Agent subagent_type="prep-interview" />');
    expect(r).toHaveLength(1);
    expect(r[0].subagentType).toBe('prep-interview');
    expect(r[0].prompt).toBeNull();
  });

  it('detects multiple emissions in one output', () => {
    const r = detectAgentTextEmission(
      '<Agent subagent_type="research-company" />\nthen\n<Agent subagent_type="tailor-resume" />',
    );
    expect(r).toHaveLength(2);
    expect(r.map((e) => e.subagentType)).toEqual(['research-company', 'tailor-resume']);
  });

  // --- Negatives / production-safety invariant ---

  it('returns [] for a well-formed <message> block (production-safety: real Claude path)', () => {
    expect(detectAgentTextEmission('<message to="owner">Here are your results.</message>')).toEqual([]);
  });

  it('returns [] for prose that merely mentions the Agent tool', () => {
    expect(detectAgentTextEmission('I will use the Agent tool to delegate this to research-company.')).toEqual([]);
  });

  it('returns [] for a fenced code sample (no XML tag)', () => {
    expect(detectAgentTextEmission('```\nAgent({ subagent_type: "research-company" })\n```')).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(detectAgentTextEmission('')).toEqual([]);
  });
});
