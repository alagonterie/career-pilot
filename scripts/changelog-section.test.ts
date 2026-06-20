import { describe, expect, it } from 'vitest';

import { extractSection } from './changelog-section';

// A representative Keep-a-Changelog file: an Unreleased section, then two
// released versions, the older one carrying multiple `###` subsections.
const SAMPLE = `# Changelog

## [Unreleased]

## [1.1.0] - 2026-07-01
### Added
- A second feature.

## [1.0.0] - 2026-06-20
### Added
- The first feature.
- Another line.

### Security
- A hardening note.
`;

describe('extractSection', () => {
  it('returns the body of the matching version, up to the next section', () => {
    const s = extractSection(SAMPLE, '1.0.0');
    expect(s).toContain('- The first feature.');
    expect(s).toContain('### Security'); // a `###` subsection stays in the body
    expect(s).not.toContain('A second feature'); // stops before [1.1.0]
    expect(s).not.toContain('## [1.0.0]'); // the heading itself is excluded
  });

  it('matches a `v`-prefixed tag against the bare heading', () => {
    expect(extractSection(SAMPLE, 'v1.1.0')).toContain('- A second feature.');
  });

  it('is date-format-agnostic (matches the version bracket regardless of suffix)', () => {
    const noDate = SAMPLE.replace('## [1.0.0] - 2026-06-20', '## [1.0.0]');
    expect(extractSection(noDate, '1.0.0')).toContain('- The first feature.');
  });

  it('returns empty string for an absent version (the release empty-guard)', () => {
    expect(extractSection(SAMPLE, '9.9.9')).toBe('');
  });

  it('returns empty string for a present-but-empty section', () => {
    expect(extractSection('## [Unreleased]\n\n## [2.0.0]\n', '2.0.0')).toBe('');
  });

  it('handles CRLF line endings (Windows-authored CHANGELOG)', () => {
    expect(extractSection(SAMPLE.replace(/\n/g, '\r\n'), '1.0.0')).toContain('- The first feature.');
  });
});
