import { defineConfig } from 'vitest/config';

// Upstream-NanoClaw test files that consistently fail on Windows due to
// environment-specific issues (NOT regressions in our code):
//
//   - scripts/q.test.ts (×7): the q.ts CLI helper does shell-style arg
//     quoting that breaks on cmd.exe / PowerShell parsing
//   - setup/platform.test.ts (×1): commandExists("node") returns false
//     on Windows even when node is on PATH (different exe extension handling)
//   - src/modules/scheduling/recurrence.test.ts (×2): EBUSY on
//     `fs.rmSync` of a SQLite DB the test just used — Windows file-handle
//     release timing
//   - src/modules/scheduling/db.test.ts (×6): same EBUSY pattern
//   - src/host-core.test.ts (×3): symlink-attack-prevention tests that
//     need `mklink` / developer-mode privileges Windows doesn't give by
//     default
//
// These would all pass on Linux/macOS. We skip them on Windows so the
// local-test signal stays clean (passes vs fails reflects OUR code, not
// upstream platform quirks). The CI pipeline that lands in Phase 8 will
// run on Linux and pick them all up.
const WINDOWS_FLAKY = [
  'scripts/q.test.ts',
  'setup/platform.test.ts',
  'src/modules/scheduling/recurrence.test.ts',
  'src/modules/scheduling/db.test.ts',
  'src/host-core.test.ts',
];

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.platform === 'win32' ? WINDOWS_FLAKY : []),
    ],
  },
});
