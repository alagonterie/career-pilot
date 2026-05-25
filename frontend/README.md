# frontend/ — TanStack Start on Cloudflare Workers

> Phase 0 placeholder. The actual frontend scaffold lands in **Phase 5** of
> STRATEGY.md's milestone plan (§V).

## Stack (locked)

- **TanStack Start** (latest RC, version pin at Phase 5 deep-read time)
- **Cloudflare Workers** (deploy via `wrangler`)
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
- `wrangler.toml` — Worker deploy config (KV bindings, Durable Objects, secrets)
- `package.json` — separate pnpm workspace from the host
- `vite.config.ts` — Vite + TanStack Start adapter + Cloudflare Workers preset

## Why deferred to Phase 5

The frontend depends on the public API being live (Phase 4) and the
sanitization pipeline being trustworthy (Phase 3). Starting frontend code
before the backend has data to show would be premature scaffolding for its
own sake. Phase 5 begins with a focused TanStack Start docs deep-read (the
gate condition from STRATEGY.md §14) before any code lands.

## Deploy target

`hire.<DOMAIN>` (e.g., `hire.example.com`). The `api.hire.<DOMAIN>` subdomain
goes direct to the VM via Cloudflare Tunnel (for SSE efficiency, see
STRATEGY.md §10 + CLOUDFLARE_PATTERNS.md §1).
