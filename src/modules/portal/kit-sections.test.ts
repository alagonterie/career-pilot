/**
 * kit-sections parser (§24.65): the canonical two-part outline parses into
 * classified sections; anything outside the known outline fails SAFE
 * (class 'unknown' → sealed downstream).
 */
import { describe, expect, it } from 'vitest';

import { parseKitSections } from './kit-sections.js';

const CANONICAL_KIT = `## Part 1 — Interviewer operating manual

### Your role
Conduct a realistic technical screen for Senior Platform Engineer at Wayne Enterprises.
Ask one question at a time and wait for the spoken answer.

### Scoring rubric
- Problem decomposition — strong: names subproblems unprompted; weak: dives into code.
- Distributed-systems tradeoffs — strong: reasons about failure modes; weak: recites tools.
- Communication — strong: thinks aloud; weak: silent leaps.

### Question themes
- Multi-region failover (JD: "design for regional outage") — opener: "Walk me through…"
- Cost-per-inference awareness (JD: "optimize serving costs") — opener: "Your bill doubled…"

### Grounding + caveats
- Series B, $40M raised in April led by Example Ventures.
- Stack: Go, Kafka, Kubernetes operators.

### Gap notes (probe these honestly)
- JD wants Kubernetes operators in production; the resume shows Helm charts only.

## Part 2 — Candidate quick-reference

### Recent signal
- Launched the realtime product last month.
- Eng-blog post on their Kafka migration.

### Lean into
- The 40% latency win on the ingestion pipeline (Go).

### Questions to ask
- How is the operator rollout sequenced across regions?
`;

describe('parseKitSections (§24.65)', () => {
  it('parses the canonical kit into the eight known sections with parts + classes', () => {
    const sections = parseKitSections(CANONICAL_KIT);
    expect(sections.map((s) => [s.id, s.part, s.cls])).toEqual([
      ['your-role', 1, 'safe'],
      ['scoring-rubric', 1, 'safe'],
      ['question-themes', 1, 'identifying'],
      ['grounding', 1, 'identifying'],
      ['gap-notes', 1, 'gap'],
      ['recent-signal', 2, 'identifying'],
      ['lean-into', 2, 'safe'],
      ['questions-to-ask', 2, 'identifying'],
    ]);
    // Canonical display titles, independent of authored parentheticals.
    expect(sections.find((s) => s.id === 'gap-notes')?.title).toBe('Gap notes');
    expect(sections.find((s) => s.id === 'grounding')?.title).toBe('Grounding + caveats');
  });

  it('counts list items per section (paragraphs as the fallback)', () => {
    const sections = parseKitSections(CANONICAL_KIT);
    expect(sections.find((s) => s.id === 'scoring-rubric')?.itemCount).toBe(3);
    expect(sections.find((s) => s.id === 'question-themes')?.itemCount).toBe(2);
    // "Your role" has no list — its single paragraph counts as 1.
    expect(sections.find((s) => s.id === 'your-role')?.itemCount).toBe(1);
  });

  it('tolerates drifted headings (numbered lists, missing parentheticals, punctuation)', () => {
    const md = [
      '## Part 1 - interviewer manual',
      '### Gap Notes',
      '1. first gap',
      '2) second gap',
      '### Grounding and caveats:',
      'One paragraph of facts.',
    ].join('\n');
    const sections = parseKitSections(md);
    expect(sections.map((s) => [s.id, s.cls, s.itemCount])).toEqual([
      ['gap-notes', 'gap', 2],
      ['grounding', 'identifying', 1],
    ]);
  });

  it('treats content before any heading as an unknown preamble (a title line never passes as content)', () => {
    const md = `Interview Kit — Wayne Enterprises — Tech Screen\n\n${CANONICAL_KIT}`;
    const sections = parseKitSections(md);
    expect(sections[0]).toMatchObject({ id: 'x-preamble', cls: 'unknown', part: 0 });
    expect(sections[0].body).toContain('Wayne Enterprises');
  });

  it('classifies unrecognized headings as unknown, keeping the authored title for the projection to decide', () => {
    const md = '## Part 2 — Candidate quick-reference\n### Why Initech is exciting\n- because reasons\n';
    const sections = parseKitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].cls).toBe('unknown');
    expect(sections[0].title).toBe('Why Initech is exciting');
    expect(sections[0].part).toBe(2);
  });

  it('markdown with no headings at all becomes a single sealed-by-default unknown section', () => {
    const sections = parseKitSections('just a blob of text\n\nwith two paragraphs');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ id: 'x-preamble', cls: 'unknown', itemCount: 2 });
  });

  it('empty input parses to no sections', () => {
    expect(parseKitSections('')).toEqual([]);
    expect(parseKitSections('\n\n  \n')).toEqual([]);
  });

  it('de-duplicates repeated heading ids so TOC anchors stay unique', () => {
    const md = '### Recent signal\n- a\n### Recent signal\n- b\n';
    const ids = parseKitSections(md).map((s) => s.id);
    expect(ids).toEqual(['recent-signal', 'recent-signal-2']);
  });
});
