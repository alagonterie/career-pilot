import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

// Dual-server E2E harness (STRATEGY.md §24.23, Sub-milestone 6.0b):
//   1. the real native-http portal API against a seeded in-memory DB
//      (scripts/portal-e2e-server.ts, run from the repo root)
//   2. the built frontend served via `vite preview`, with VITE_API_BASE
//      pointed at (1)
// No Docker, no LLM -> deterministic + free -> runs in hosted CI.
const PORTAL_PORT = 3099
const FRONTEND_PORT = 3000
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'on-first-retry',
  },
  // Note on motion determinism: the funnel board's `motion/react` `layout`
  // animations only fire when a card changes column, which needs the seed to
  // mutate. The E2E server serves a *static* deterministic seed (never runs the
  // generator), so cards never move during a test → no layout animation → the
  // visual baseline is deterministic, and `animations:'disabled'` in the
  // snapshot freezes CSS. Reduced-motion for real users is handled in-component
  // via `MotionConfig reducedMotion="user"` (the real media query).
  // Three projects, chained via `dependencies` so every @visual capture runs
  // BEFORE any state-mutating functional test (§24.62): the smoke live-push
  // inserts a wall-clock audit row and the simulator flows insert run rows into
  // the run's shared in-memory DB — a parallel capture that loses that race
  // bakes a nondeterministic row into the baseline (historically the captures
  // just happened to win). Order: desktop visual → mobile (its own @visual
  // baselines + its sim-run mutation) → desktop functional (the pushers). In
  // CI (`--grep-invert @visual`) the visual project simply runs zero tests and
  // the chain is a no-op. All chromium-engine (CI installs only chromium;
  // `devices['Pixel 5']` is a viewport/touch preset, not a browser).
  //
  // NAMING IS LOAD-BEARING: the default snapshot path embeds the project name
  // (`funnel-chromium-win32.png`), so the project that OWNS visual.spec.ts must
  // stay named `chromium` or every baseline silently forks to a new filename
  // (auto-created, while the old ones rot as orphans — learned the hard way).
  //
  // The chain is LOCAL-ONLY: Playwright does NOT apply test filters (--grep)
  // to dependency projects, so chaining in CI would force the @visual tests to
  // run despite `--grep-invert @visual` — on Linux, where no baselines exist.
  // CI runs workers=1 with no captures to protect; the chain buys nothing there.
  // Declaration order matters in CI (no deps + workers=1 → projects run as
  // declared): desktop functional must precede mobile so live.spec asserts the
  // seeded spend before mobile's simulator flow adds run cost — the pre-§24.62
  // order. Locally the dependency chain (visual → mobile → functional)
  // overrides declaration order.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testMatch: /visual\.spec\.ts/ },
    {
      name: 'chromium-functional',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [/mobile\.spec\.ts/, /visual\.spec\.ts/],
      dependencies: process.env.CI ? [] : ['mobile-chromium'],
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 5'] },
      testMatch: /mobile\.spec\.ts/,
      dependencies: process.env.CI ? [] : ['chromium'],
    },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx scripts/portal-e2e-server.ts',
      cwd: repoRoot,
      url: `http://127.0.0.1:${PORTAL_PORT}/api/system-status`,
      env: { PORTAL_E2E_PORT: String(PORTAL_PORT) },
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview --port ${FRONTEND_PORT} --strictPort`,
      url: `http://localhost:${FRONTEND_PORT}`,
      // VITE_MOCK_SEAM arms the client-side mock seams (the /crash synthetic-crash
      // route — §24.36 36.3) in this production-mode build; real prod omits it.
      env: { VITE_API_BASE: `http://127.0.0.1:${PORTAL_PORT}`, VITE_MOCK_SEAM: '1' },
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
