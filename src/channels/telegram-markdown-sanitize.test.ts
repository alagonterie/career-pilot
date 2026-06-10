import { describe, it, expect } from 'vitest';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

describe('sanitizeTelegramLegacyMarkdown', () => {
  it('downgrades CommonMark **bold** to legacy *bold*', () => {
    expect(sanitizeTelegramLegacyMarkdown('**Host path**')).toBe('*Host path*');
  });

  it('downgrades CommonMark __bold__ to legacy _italic_', () => {
    expect(sanitizeTelegramLegacyMarkdown('__label__')).toBe('_label_');
  });

  it('leaves balanced legacy *bold* and _italic_ alone', () => {
    expect(sanitizeTelegramLegacyMarkdown('a *b* c _d_ e')).toBe('a *b* c _d_ e');
  });

  it('preserves inline code spans untouched', () => {
    const input = 'see `file_name.py` and `**not bold**` here';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('preserves fenced code blocks untouched', () => {
    const input = '```\nfoo_bar **baz**\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('strips formatting chars on odd delimiter count (unbalanced *)', () => {
    expect(sanitizeTelegramLegacyMarkdown('a * b *c*')).toBe('a  b c');
  });

  it('strips formatting chars on odd delimiter count (unbalanced _)', () => {
    expect(sanitizeTelegramLegacyMarkdown('file_name has _one italic_')).toBe('filename has one italic');
  });

  it('strips brackets when unbalanced', () => {
    expect(sanitizeTelegramLegacyMarkdown('see [docs here')).toBe('see docs here');
  });

  it('leaves matched brackets (e.g. links) alone when counts balance', () => {
    const input = 'see [docs](https://example.com) for more';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('fixes the real failing message', () => {
    const input =
      'Sure! What do you want to mount, and where should it appear inside the container?\n\n' +
      '- **Host path** (on your machine): e.g. `~/projects/webapp`\n' +
      '- **Container path**: e.g. `workspace/webapp`\n' +
      '- **Read-only or read-write?**';
    const out = sanitizeTelegramLegacyMarkdown(input);
    expect(out).not.toContain('**');
    expect(out).toContain('*Host path*');
    expect(out).toContain('`~/projects/webapp`');
    expect((out.match(/\*/g) ?? []).length % 2).toBe(0);
  });

  it('is a no-op on empty string', () => {
    expect(sanitizeTelegramLegacyMarkdown('')).toBe('');
  });

  it('replaces dash list bullets with • so the adapter does not re-emit `*` markers', () => {
    expect(sanitizeTelegramLegacyMarkdown('- one\n- two')).toBe('• one\n• two');
  });

  it('preserves indented list structure', () => {
    expect(sanitizeTelegramLegacyMarkdown('  - nested')).toBe('  • nested');
  });

  it('flattens Markdown horizontal rules (---, ***, ___)', () => {
    const input = 'before\n---\n***\n___\nafter';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe('before\n⎯⎯⎯\n⎯⎯⎯\n⎯⎯⎯\nafter');
  });

  it('leaves horizontal rules inside code blocks alone', () => {
    const input = '```\n---\n```';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  // URL protection (§24.56): real lead URLs carry underscores — they must
  // never poison the odd-delimiter strip and must pass through byte-identical.

  it('keeps a bare URL with an odd underscore count intact (the gh_jid killer-match case)', () => {
    const input = 'Anthropic just posted:\n\nhttps://boards.greenhouse.io/anthropic/jobs/4567?gh_jid=4567';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('keeps a markdown link target with utm underscores intact (the SerpApi apply-link case)', () => {
    const input = '• [Staff Engineer — Acorns](https://jobs.ashbyhq.com/acorns/cf23?utm_source=google_jobs_apply) · 91';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(
      '• [Staff Engineer — Acorns](https://jobs.ashbyhq.com/acorns/cf23?utm_source=google_jobs_apply) · 91',
    );
  });

  it('keeps a Drive kit_url whose file ID contains underscores intact', () => {
    const input = 'practice kit: https://docs.google.com/document/d/1aB_cD-eF_gH/edit';
    expect(sanitizeTelegramLegacyMarkdown(input)).toBe(input);
  });

  it('still strips odd-delimiter prose while leaving an adjacent URL untouched', () => {
    const out = sanitizeTelegramLegacyMarkdown('file_name has _one italic_\nhttps://example.com/a_b_c');
    expect(out).toBe('filename has one italic\nhttps://example.com/a_b_c');
  });

  it('does not let a link target swallow its closing paren', () => {
    const out = sanitizeTelegramLegacyMarkdown('see [docs](https://example.com/x_y) now');
    expect(out).toBe('see [docs](https://example.com/x_y) now');
  });
});
