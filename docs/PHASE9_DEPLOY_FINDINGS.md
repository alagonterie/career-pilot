# Phase 9 deploy — verified findings (Sub-milestone 9.1)

Captured during the 9.1 build (2026-06-03). Primary-source-verified facts for
the deploy/infra surface, so 9.2–9.4 don't re-derive them. Companion to
STRATEGY.md §24.38 (the drill-in + the build-reconciliation note).

## Toolchain (the dev machine)
- `terraform` v1.15.4; `gcloud` authed (janedoe@gmail.com) + GCP Application
  Default Credentials present; `wrangler` 4.96 driven via `CLOUDFLARE_API_TOKEN`
  (no `wrangler login`). Network egress works from the shell.
- `infra/terraform.tfvars` (gitignored) holds the real values: GCP project
  `career-pilot-497319`, a CF API token, account/zone IDs, apex `example.com`,
  `owner_email`.

## Cloudflare
- **Provider pinned v4** (4.52.7). Use the non-deprecated names:
  `cloudflare_zero_trust_access_application` / `cloudflare_zero_trust_access_policy`
  and `cloudflare_workers_domain`. v5 is a breaking rewrite — out of scope.
- **Access gates Worker-served hosts.** A self-hosted access application
  (deny-by-default) + a standalone access policy (`decision="allow"`,
  `include { email }`, referenced via the application's `policies` list) gate the
  frontend host. Access is an edge layer evaluated before the Worker.
- **Workers Custom Domain** (`cloudflare_workers_domain`: account_id + zone_id +
  hostname + service) auto-provisions the cert + routes all paths; `service` =
  the deployed Worker name. Terraform owns the frontend host binding; wrangler
  only deploys the script → the real domain stays out of the generic committed repo.
- **Token scope:** deploy needs Workers Scripts:Edit + Zone DNS:Edit (the
  existing token `8b55f046…` has these). The **Access apply needs
  `Account > Access: Apps and Policies: Edit`** — the existing token lacks it and
  cannot self-serve a broader token (no `User > API Tokens` permission → 403 on
  token management). Owner grants this once. 9.2 will additionally need
  `Account > Cloudflare Tunnel: Edit`.

## Frontend deploy (@cloudflare/vite-plugin)
- **Env selected at BUILD time:** `CLOUDFLARE_ENV=dev vite build` flattens
  `dist/server/wrangler.json` (verified `name=career-pilot-portal-dev`,
  `workers_dev:false`). No `CLOUDFLARE_ENV` = the top-level (prod) config.
- **Deploy:** bare `wrangler deploy` follows the plugin's
  `.wrangler/deploy/config.json` redirect to the flattened dev config.
  `wrangler deploy --env dev` is a **NO-OP** under the plugin — do not use it.
- Per-env routes/vars/secrets are non-inheritable; the dev worker is `<name>-dev`.
- `VITE_API_BASE` is a build-time var (dev → `https://api.dev.hire.<apex>`) set
  via gitignored env / a GH per-environment variable, never committed.

## GCP (for 9.2)
- VM image: Ubuntu 24.04 = family `ubuntu-2404-lts-amd64`, project
  `ubuntu-os-cloud` (replaces the destroyed e2-small/COS box; machine type →
  e2-medium per §13).

## State / workflow
- The prior experimental apply (live e2-small/COS VM + tunnel + DNS) was
  **destroyed** 2026-06-03 (owner-authorized) — clean slate.
- Terraform uses a **workspace per environment** (`dev` workspace active);
  `environment` is passed via `-var environment=dev` (no default, to avoid a
  stray prod apply).
- Deploy order (gate-before-route): `wrangler deploy` the worker → `terraform
  apply` binds the custom domain + Access (the domain `depends_on` the Access app).
