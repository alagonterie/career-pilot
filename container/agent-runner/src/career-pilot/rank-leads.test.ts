/**
 * Unit tests for the pure parts of rank-leads.ts. Ported from the
 * vitest suite that lived host-side before the §24.6 container
 * relocation.
 *
 * Network call (callHaiku / rankLeads end-to-end) is exercised by the
 * --flow=daily-briefing e2e against the real OneCLI-gated Haiku, not here.
 */
import { describe, expect, it } from 'bun:test';

import {
  buildRankingPrompt,
  computeBriefHash,
  parseAnthropicCustomHeaders,
  parseRankingResponse,
  RankLeadsError,
  type JobLeadForRanking,
} from './rank-leads.js';

const sampleLead: JobLeadForRanking = {
  id: 'L1',
  source: 'greenhouse',
  title: 'Staff Backend Engineer',
  company: 'Anthropic',
  location_raw: 'San Francisco, CA',
  workplace_type: 'remote',
  description_text: 'Building agent infrastructure. Go, Rust, Python.',
  rules_score: 75,
};

describe('parseAnthropicCustomHeaders', () => {
  it('parses newline-separated Name: value pairs (Portkey routing headers)', () => {
    const h = parseAnthropicCustomHeaders('x-portkey-provider: @anthropic-prod\nx-portkey-config: cfg-1');
    expect(h['x-portkey-provider']).toBe('@anthropic-prod');
    expect(h['x-portkey-config']).toBe('cfg-1');
  });

  it('keeps colons inside values intact (x-portkey-metadata JSON)', () => {
    const h = parseAnthropicCustomHeaders('x-portkey-metadata: {"environment":"dev","session_id":"s1"}');
    expect(h['x-portkey-metadata']).toBe('{"environment":"dev","session_id":"s1"}');
  });

  it('returns {} when unset or empty', () => {
    expect(parseAnthropicCustomHeaders(undefined)).toEqual({});
    expect(parseAnthropicCustomHeaders('')).toEqual({});
  });
});

describe('buildRankingPrompt', () => {
  it('includes brief, company, title, id, and JSON instruction', () => {
    const prompt = buildRankingPrompt([sampleLead], 'Senior backend engineer; Go, Rust; remote.');
    expect(prompt).toContain('Anthropic');
    expect(prompt).toContain('Staff Backend Engineer');
    expect(prompt).toContain('Senior backend engineer');
    expect(prompt).toContain('id=L1');
    expect(prompt).toContain('"llm_score":<0-100>');
  });

  it('truncates descriptions past 280 chars', () => {
    const longDesc = 'word '.repeat(200);
    const prompt = buildRankingPrompt(
      [{ ...sampleLead, description_text: longDesc }],
      'brief here',
    );
    const snippetLine = prompt.split('\n').find((l) => l.trimStart().startsWith('word '));
    expect(snippetLine).toBeDefined();
    expect(snippetLine!.length).toBeLessThan(300);
    expect(snippetLine).toContain('…');
  });

  it('handles missing location/workplace gracefully', () => {
    const prompt = buildRankingPrompt(
      [{ ...sampleLead, location_raw: null, workplace_type: null }],
      'brief',
    );
    expect(prompt).not.toMatch(/Anthropic \|\s*$/m);
    expect(prompt).toContain('Anthropic');
  });

  it('handles missing description', () => {
    const prompt = buildRankingPrompt(
      [{ ...sampleLead, description_text: null }],
      'brief',
    );
    expect(prompt).toContain('id=L1');
    const idx = prompt.indexOf('id=L1');
    const after = prompt.slice(idx).split('\n')[1] ?? '';
    expect(after.trim()).toBe('');
  });

  it('lists multiple leads in order', () => {
    const leads = [
      { ...sampleLead, id: 'L1', company: 'A' },
      { ...sampleLead, id: 'L2', company: 'B' },
      { ...sampleLead, id: 'L3', company: 'C' },
    ];
    const prompt = buildRankingPrompt(leads, 'brief');
    expect(prompt.indexOf('id=L1')).toBeLessThan(prompt.indexOf('id=L2'));
    expect(prompt.indexOf('id=L2')).toBeLessThan(prompt.indexOf('id=L3'));
    expect(prompt).toContain('# Postings (3)');
  });
});

describe('parseRankingResponse', () => {
  it('parses clean JSON and assigns ranks', () => {
    const text = '{"leads":[{"id":"L1","llm_score":85},{"id":"L2","llm_score":42}]}';
    const out = parseRankingResponse(text, ['L1', 'L2']);
    expect(out).toEqual([
      { id: 'L1', llm_score: 85, rank: 1 },
      { id: 'L2', llm_score: 42, rank: 2 },
    ]);
  });

  it('handles markdown-fenced JSON', () => {
    const text = '```json\n{"leads":[{"id":"L1","llm_score":50}]}\n```';
    const out = parseRankingResponse(text, ['L1']);
    expect(out).toEqual([{ id: 'L1', llm_score: 50, rank: 1 }]);
  });

  it('handles bare ``` fences', () => {
    const text = '```\n{"leads":[{"id":"L1","llm_score":33}]}\n```';
    const out = parseRankingResponse(text, ['L1']);
    expect(out).toEqual([{ id: 'L1', llm_score: 33, rank: 1 }]);
  });

  it('drops ids not in the requested set', () => {
    const text = '{"leads":[{"id":"L1","llm_score":50},{"id":"GHOST","llm_score":90}]}';
    const out = parseRankingResponse(text, ['L1']);
    expect(out).toEqual([{ id: 'L1', llm_score: 50, rank: 1 }]);
  });

  it('drops out-of-range scores', () => {
    const text = '{"leads":[{"id":"L1","llm_score":50},{"id":"L2","llm_score":150}]}';
    const out = parseRankingResponse(text, ['L1', 'L2']);
    expect(out).toEqual([{ id: 'L1', llm_score: 50, rank: 1 }]);
  });

  it('drops negative scores', () => {
    const text = '{"leads":[{"id":"L1","llm_score":-5}]}';
    expect(() => parseRankingResponse(text, ['L1'])).toThrow(RankLeadsError);
  });

  it('drops non-number scores', () => {
    const text = '{"leads":[{"id":"L1","llm_score":"50"}]}';
    expect(() => parseRankingResponse(text, ['L1'])).toThrow(RankLeadsError);
  });

  it('rounds float scores', () => {
    const text = '{"leads":[{"id":"L1","llm_score":42.7}]}';
    const out = parseRankingResponse(text, ['L1']);
    expect(out[0].llm_score).toBe(43);
  });

  it('deduplicates by id, keeping first', () => {
    const text = '{"leads":[{"id":"L1","llm_score":50},{"id":"L1","llm_score":80}]}';
    const out = parseRankingResponse(text, ['L1']);
    expect(out).toEqual([{ id: 'L1', llm_score: 50, rank: 1 }]);
  });

  it('throws PARSE_ERROR on invalid JSON', () => {
    try {
      parseRankingResponse('not json at all', ['L1']);
      throw new Error('expected RankLeadsError');
    } catch (e) {
      expect(e).toBeInstanceOf(RankLeadsError);
      expect((e as RankLeadsError).code).toBe('PARSE_ERROR');
    }
  });

  it('throws PARSE_ERROR when leads array is missing', () => {
    try {
      parseRankingResponse('{"results":[]}', ['L1']);
      throw new Error('expected RankLeadsError');
    } catch (e) {
      expect(e).toBeInstanceOf(RankLeadsError);
      expect((e as RankLeadsError).code).toBe('PARSE_ERROR');
    }
  });

  it('throws NO_VALID_SCORES when no entries pass validation', () => {
    try {
      parseRankingResponse('{"leads":[{"id":"GHOST","llm_score":50}]}', ['L1']);
      throw new Error('expected RankLeadsError');
    } catch (e) {
      expect(e).toBeInstanceOf(RankLeadsError);
      expect((e as RankLeadsError).code).toBe('NO_VALID_SCORES');
    }
  });

  it('handles ties stably (preserves first-seen order)', () => {
    const text =
      '{"leads":[{"id":"L1","llm_score":50},{"id":"L2","llm_score":50},{"id":"L3","llm_score":80}]}';
    const out = parseRankingResponse(text, ['L1', 'L2', 'L3']);
    expect(out[0]).toEqual({ id: 'L3', llm_score: 80, rank: 1 });
    expect(out[1].llm_score).toBe(50);
    expect(out[2].llm_score).toBe(50);
  });
});

describe('computeBriefHash', () => {
  it('produces stable 16-char hex', () => {
    const h = computeBriefHash('hello world');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(computeBriefHash('hello world')).toBe(h);
  });

  it('changes with content', () => {
    expect(computeBriefHash('hello')).not.toBe(computeBriefHash('hello!'));
    expect(computeBriefHash('hello')).not.toBe(computeBriefHash('hellp'));
  });

  it('normalizes whitespace', () => {
    expect(computeBriefHash('hello world')).toBe(computeBriefHash('hello  world'));
    expect(computeBriefHash('hello world')).toBe(computeBriefHash(' hello world '));
    expect(computeBriefHash('hello world')).toBe(computeBriefHash('hello\tworld'));
    expect(computeBriefHash('hello world')).toBe(computeBriefHash('hello\nworld'));
  });

  it('handles empty string', () => {
    expect(computeBriefHash('')).toMatch(/^[0-9a-f]{16}$/);
    expect(computeBriefHash('   ')).toBe(computeBriefHash(''));
  });
});
