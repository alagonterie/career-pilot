import { describe, expect, it } from 'vitest';

import { buildMultipartRelated, docUrl } from './drive-client.js';

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

describe('buildMultipartRelated (kit markdown media)', () => {
  it('carries the raw markdown as a text/markdown media part (§24.182)', () => {
    const md = '# Title\n\n**bold** and *italic*\n\n1. one\n2. two';
    const body = buildMultipartRelated(
      'B1',
      { name: 'k', mimeType: 'application/vnd.google-apps.document' },
      'text/markdown',
      md,
    );
    expect(body).toContain('Content-Type: text/markdown');
    expect(body).toContain('# Title');
    expect(body).toContain('**bold** and *italic*'); // markdown handed over verbatim — no HTML conversion
  });
});
