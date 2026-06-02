import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Stack + plugin order per the official TanStack Start + Cloudflare example
// (start-basic-cloudflare). `resolve.tsconfigPaths` is Vite 8 native path
// resolution (drives the `~/*` -> `./src/*` alias from tsconfig.json).
export default defineConfig({
  server: {
    port: 3000,
  },
  // Pre-bundle motion/react at server start. Without this, `vite dev` optimizes
  // it lazily on the first request that imports it (the funnel/architecture
  // pages), triggering a mid-session reload that transiently null-dispatchers
  // React and SSR-errors the page on a cold `dev:mock` start. Pre-including it
  // removes that first-request reload. No effect on the built CI/prod bundle.
  optimizeDeps: {
    include: ['motion/react'],
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [tailwindcss(), cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart(), viteReact()],
})
