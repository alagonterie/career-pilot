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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
      env: { VITE_API_BASE: `http://127.0.0.1:${PORTAL_PORT}` },
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
