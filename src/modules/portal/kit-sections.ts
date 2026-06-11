/**
 * src/modules/portal/kit-sections.ts — pure parser for the interview-kit
 * markdown structure (STRATEGY.md §24.65).
 *
 * Kits follow the `build-interview-kit` prompt's fixed outline: two `##` part
 * headers and eight known `###` sections. The deterministic structure is what
 * makes per-section policy possible — this module splits a kit's markdown into
 * sections and classifies each:
 *
 *   safe        — no hard identifying facts; renders (sanitized) even while live
 *   identifying — quotes JD phrasing / company signal that de-anonymizes past
 *                 name redaction; sealed (count only) while the process is live
 *   gap         — the candidate's honest weak spots; ALWAYS sealed while live
 *   unknown     — anything not in the known outline; sealed by default
 *                 (fail-safe: an LLM-authored kit may drift)
 *
 * Pure + synchronous; no DB, no sanitizer (the projection layer applies both).
 */

export type KitSectionClass = 'safe' | 'identifying' | 'gap' | 'unknown';

export interface ParsedKitSection {
  /** Stable slug for TOC anchors + tests (e.g. 'scoring-rubric'). */
  id: string;
  /** Canonical display title for known sections; the authored heading text otherwise. */
  title: string;
  /** 1 | 2 per the kit's part headers; 0 = content before any part header. */
  part: number;
  cls: KitSectionClass;
  /** Raw markdown body (header line excluded). NOT sanitized — the projection owns that. */
  body: string;
  /** List items in the body (fallback: paragraphs) — drives the redaction-bar count. */
  itemCount: number;
}

interface KnownSection {
  id: string;
  title: string;
  cls: KitSectionClass;
  /** Heading matcher, applied to the normalized heading text. */
  match: (normalized: string) => boolean;
}

/** Lowercase, strip everything but letters/digits/spaces, collapse whitespace. */
function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tolerant matching: an LLM-authored heading may drift in punctuation or carry
// a parenthetical ("Gap notes (probe these honestly)") — match on the stable
// leading words, normalized.
const KNOWN_SECTIONS: KnownSection[] = [
  { id: 'your-role', title: 'Your role', cls: 'safe', match: (n) => n.startsWith('your role') },
  { id: 'scoring-rubric', title: 'Scoring rubric', cls: 'safe', match: (n) => n.startsWith('scoring rubric') },
  {
    id: 'question-themes',
    title: 'Question themes',
    cls: 'identifying',
    match: (n) => n.startsWith('question themes'),
  },
  { id: 'grounding', title: 'Grounding + caveats', cls: 'identifying', match: (n) => n.startsWith('grounding') },
  { id: 'gap-notes', title: 'Gap notes', cls: 'gap', match: (n) => n.startsWith('gap notes') },
  { id: 'recent-signal', title: 'Recent signal', cls: 'identifying', match: (n) => n.startsWith('recent signal') },
  { id: 'lean-into', title: 'Lean into', cls: 'safe', match: (n) => n.startsWith('lean into') },
  {
    id: 'questions-to-ask',
    title: 'Questions to ask',
    cls: 'identifying',
    match: (n) => n.startsWith('questions to ask'),
  },
];

function classify(headingText: string): { id: string; title: string; cls: KitSectionClass } {
  const normalized = normalizeHeading(headingText);
  for (const k of KNOWN_SECTIONS) {
    if (k.match(normalized)) return { id: k.id, title: k.title, cls: k.cls };
  }
  return {
    id: `x-${normalized.replace(/ /g, '-').slice(0, 40) || 'section'}`,
    title: headingText.trim(),
    cls: 'unknown',
  };
}

/** Which part a `##` header opens: "Part 1 …" → 1, "Part 2 …" → 2, else null. */
function parsePartHeader(headingText: string): number | null {
  const m = normalizeHeading(headingText).match(/^part (\d)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n === 1 || n === 2 ? n : null;
}

/** Count list items; fall back to blank-line-separated paragraphs; ≥1 when non-empty. */
function countItems(body: string): number {
  const lines = body.split('\n');
  let listItems = 0;
  for (const line of lines) {
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) listItems++;
  }
  if (listItems > 0) return listItems;
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length > 0) return paragraphs.length;
  return body.trim().length > 0 ? 1 : 0;
}

/**
 * Split a kit's markdown into classified sections, in document order.
 *
 * Structure handling:
 *  - `##` headers that read "Part N …" set the current part (1 or 2) and emit
 *    no section of their own (the frontend renders the part framing).
 *  - `###` headers (and any other `##`/`#` heading) open a section, classified
 *    against the known outline.
 *  - Non-empty content before the first heading becomes an 'unknown' preamble
 *    section (fail-safe: a `# Interview Kit — <Company> …` title line must
 *    never pass as content).
 *  - Markdown with no recognizable headings at all → one 'unknown' section
 *    holding everything (sealed by default downstream).
 */
export function parseKitSections(markdown: string): ParsedKitSection[] {
  const out: ParsedKitSection[] = [];
  const lines = markdown.split('\n');

  let part = 0;
  let current: { id: string; title: string; cls: KitSectionClass; part: number } | null = null;
  let buf: string[] = [];

  const flush = (): void => {
    const body = buf.join('\n').trim();
    buf = [];
    if (!current) {
      if (body.length === 0) return;
      out.push({ id: 'x-preamble', title: 'Preamble', part, cls: 'unknown', body, itemCount: countItems(body) });
      return;
    }
    out.push({ ...current, body, itemCount: countItems(body) });
    current = null;
  };

  for (const raw of lines) {
    const heading = raw.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (!heading) {
      buf.push(raw);
      continue;
    }
    const text = heading[2];
    const partNum = heading[1].length <= 2 ? parsePartHeader(text) : null;
    flush();
    if (partNum != null) {
      part = partNum;
      continue;
    }
    current = { ...classify(text), part };
  }
  flush();

  // De-duplicate ids (a drifted kit could repeat a heading) so TOC anchors stay unique.
  const seen = new Map<string, number>();
  for (const s of out) {
    const n = seen.get(s.id) ?? 0;
    seen.set(s.id, n + 1);
    if (n > 0) s.id = `${s.id}-${n + 1}`;
  }
  return out;
}
