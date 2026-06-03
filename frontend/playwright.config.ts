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
  // Two projects: the desktop suite (everything except the mobile spec) and the
  // mobile suite (§24.37 + PORTAL §13) — a Pixel-5-class ~393px viewport running
  // ONLY e2e/mobile.spec.ts. Both use the chromium engine (CI installs only
  // chromium; `devices['Pixel 5']` is a viewport/touch preset, not a new browser).
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] }, testMatch: /mobile\.spec\.ts/ },
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
