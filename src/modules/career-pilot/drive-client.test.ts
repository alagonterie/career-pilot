import { describe, expect, it } from 'vitest';

import { buildMultipartRelated, docUrl, kitMarkdownToHtml } from './drive-client.js';

describe('docUrl', () => {
  it('builds the canonical Google Doc edit URL', () => {
    expect(docUrl('abc123')).toBe('https://docs.google.com/document/d/abc123/edit');
  });
});

describe('buildMultipartRelated', () => {
  it('assembles a metadata part + a media part with CRLF and closing boundary', () => {
    const body = buildMultipartRelated(
      'B0',
      { name: 'x', mimeType: 'application/vnd.google-apps.document' },
      'text/html',
      '<h1>Hi</h1>',
    );
    expect(body).toContain('--B0\r\n');
    expect(body).toContain('Content-Type: application/json; charset=UTF-8');
    expect(body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(body).toContain('Content-Type: text/html');
    expect(body).toContain('<h1>Hi</h1>');
    expect(body.trimEnd().endsWith('--B0--')).toBe(true);
    expect(body).toContain('\r\n'); // CRLF-delimited
  });
});

describe('kitMarkdownToHtml', () => {
  it('wraps output in html/body even for empty input', () => {
    const html = kitMarkdownToHtml('');
    expect(html.startsWith('<html><body>')).toBe(true);
    expect(html.trimEnd().endsWith('</body></html>')).toBe(true);
  });

  it('converts ATX headings to h1..h3', () => {
    expect(kitMarkdownToHtml('# Title')).toContain('<h1>Title</h1>');
    expect(kitMarkdownToHtml('## Sub')).toContain('<h2>Sub</h2>');
    expect(kitMarkdownToHtml('### Deep')).toContain('<h3>Deep</h3>');
  });

  it('renders inline bold, code, and links', () => {
    const html = kitMarkdownToHtml('Lean on **throughput** and `latency` per [the blog](https://x.test/p).');
    expect(html).toContain('<strong>throughput</strong>');
    expect(html).toContain('<code>latency</code>');
    expect(html).toContain('<a href="https://x.test/p">the blog</a>');
  });

  it('groups consecutive bullets into a single <ul>', () => {
    const html = kitMarkdownToHtml('- one\n- two\n- three');
    expect(html).toContain('<ul>');
    expect((html.match(/<li>/g) ?? []).length).toBe(3);
    expect((html.match(/<ul>/g) ?? []).length).toBe(1);
    expect(html).toContain('</ul>');
  });

  it('renders ordered lists as <ol> and closes the prior list on type switch', () => {
    const html = kitMarkdownToHtml('1. first\n2. second\n\n- bullet');
    expect(html).toContain('<ol>');
    expect(html).toContain('</ol>');
    expect(html).toContain('<ul>');
  });

  it('renders --- as an <hr />', () => {
    expect(kitMarkdownToHtml('a\n\n---\n\nb')).toContain('<hr />');
  });

  it('escapes HTML special chars in text content', () => {
    const html = kitMarkdownToHtml('compare a < b && c > d');
    expect(html).toContain('a &lt; b &amp;&amp; c &gt; d');
    expect(html).not.toContain('a < b');
  });

  it('treats blank-line-separated text as paragraphs', () => {
    const html = kitMarkdownToHtml('first para\n\nsecond para');
    expect((html.match(/<p>/g) ?? []).length).toBe(2);
  });
});
