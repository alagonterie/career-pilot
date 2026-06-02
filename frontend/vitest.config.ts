import { fileURLToPath } from 'node:url'

import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Fast jsdom component/unit tier. Deliberately WITHOUT the Cloudflare +
// TanStack Start plugins (those target the workerd SSR environment, which
// conflicts with jsdom). The full-stack browser tier lives in
// playwright.config.ts; `include` is scoped to src/ so the e2e/ specs (which
// use @playwright/test, not vitest) are never picked up here.
export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
