# frontend/ — TanStack Start on Cloudflare Workers

> Phase 0 placeholder. The actual frontend scaffold lands in **Phase 6** of
> STRATEGY.md's milestone plan (§V) — see §24.23 for the Phase 6 decomposition
> and the test-harness-first Sub-milestone 6.0.

## Stack (locked)

- **TanStack Start** (v1, stable since 2026-03 — pin a v1 minor; deep-read captured in STRATEGY.md §24.23)
- **Cloudflare Workers** (deploy via `@cloudflare/vite-plugin` + `wrangler deploy`)
- **Tailwind v4** with `@theme` directive
- **shadcn/ui** (new-york variant)
- **motion/react** for animation
- **@tanstack/react-virtual** for the funnel race scroller and audit-trail list

See PORTAL.md §3.5 ("Frontend stack — locked") for the full rationale and
non-negotiables.

## What goes here

- `routes/` — file-based routes (TanStack Router conventions)
  - `(marketing)/_layout.tsx` + `index.tsx`, `simulator/`, `work.tsx`,
    `contact.tsx`, `about.tsx`
  - `(ops)/_layout.tsx` + `live.tsx`, `funnel.tsx`, `architecture.tsx`
- `components/` — shadcn + custom
- `lib/` — SSE client, API client wrappers, formatting helpers
- `e2e/` — Playwright dual-server harness (seeded portal API + frontend), fixtures, trace-replay util
- `wrangler.jsonc` — Worker deploy config (`main: '@tanstack/react-start/server-entry'`, `nodejs_compat`, bindings, secrets)
- `package.json` — separate pnpm workspace from the host
- `vite.config.ts` — `cloudflare()` + `tanstackStart()` + `react()` plugins

## Why deferred to Phase 6

The frontend depends on the portal backend being live (Phase 5) and the
sanitization pipeline being trustworthy (Phase 4). Starting frontend code
before the backend has data to show would be premature scaffolding for its
own sake. Phase 6 began with a focused TanStack Start docs deep-read (the
gate condition from STRATEGY.md §14, now complete — see §24.23) and is
**test-harness-first**: the Playwright dual-server E2E harness lands before
any real page, so every page is born self-verifiable (the owner works these
phases remotely).

## Deploy target

`hire.<DOMAIN>` (e.g., `hire.example.com`). The `api.hire.<DOMAIN>` subdomain
goes direct to the VM via Cloudflare Tunnel (for SSE efficiency, see
STRATEGY.md §10 + CLOUDFLARE_PATTERNS.md §1).
