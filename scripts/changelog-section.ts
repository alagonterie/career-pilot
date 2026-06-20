#!/usr/bin/env tsx
/**
 * Extract one version's release notes from CHANGELOG.md (Keep-a-Changelog).
 *
 * The release workflow (.github/workflows/release.yml) calls this on a `v*` tag
 * push to build the GitHub Release body from the matching `## [x.y.z]` section
 * (STRATEGY §24.139 D4-3). Kept pure + unit-tested (changelog-section.test.ts) so
 * the release mechanism is verifiable locally — the workflow is the thin shell
 * around `extractSection`, and an empty section fails the release (no empty
 * release for an un-changelogged tag).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Strip a leading `v` so a `v1.0.0` tag matches a `## [1.0.0]` heading. */
function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, '');
}

/**
 * Return the body of the `## [<version>]` section — every line after its heading
 * up to (but excluding) the next `## ` heading or EOF — trimmed. Date-agnostic:
 * the version bracket matches regardless of any ` - YYYY-MM-DD` suffix. Returns
 * '' when the section is absent or has no body (the release.yml empty-guard).
 */
export function extractSection(changelog: string, version: string): string {
  const v = normalizeVersion(version);
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`^##\\s+\\[${escaped}\\]`);
  const nextSectionRe = /^##\s+/;
  const lines = changelog.split(/\r?\n/);

  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return '';

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (nextSectionRe.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/**
 * CLI: `tsx scripts/changelog-section.ts <version> [path]`. Prints the section to
 * stdout; exits 1 (with a stderr message) when the section is empty/absent, so a
 * tag without a changelog entry fails the release rather than cutting an empty one.
 */
function main(argv: string[]): void {
  const [version, path = 'CHANGELOG.md'] = argv;
  if (!version) {
    process.stderr.write('usage: changelog-section <version> [path]\n');
    process.exit(2);
  }
  const section = extractSection(readFileSync(path, 'utf8'), version);
  if (!section) {
    process.stderr.write(`No CHANGELOG section for version "${version}" in ${path}\n`);
    process.exit(1);
  }
  process.stdout.write(section + '\n');
}

// Run only when invoked directly (basename match is cross-platform — tsx keeps
// argv[1] as the script path; under vitest argv[1] is the runner, so this is a
// no-op on import).
if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
