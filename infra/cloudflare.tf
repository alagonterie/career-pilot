# Phase 9.1 (STRATEGY.md §24.38) — the deployed frontend per environment + the
# owner-only Cloudflare Access gate.
#
# Division of ownership: the Worker SCRIPT is built + deployed by wrangler
# (frontend/, via `CLOUDFLARE_ENV=<env> vite build` then `wrangler deploy`).
# Terraform owns the custom-domain binding + the Access application, so the real
# hostnames + the owner email live only in the gitignored terraform.tfvars and
# the committed repo stays generic/forkable.
#
# The backend tunnel + VM (destroyed 2026-06-03 as stale e2-small/COS
# scaffolding) return here, corrected to e2-medium/Ubuntu and parameterized, in
# Phase 9.2.

locals {
  # prod -> hire.<apex> ; dev -> dev.hire.<apex>
  frontend_host = var.environment == "prod" ? "${var.frontend_subdomain}.${var.apex_domain}" : "${var.environment}.${var.frontend_subdomain}.${var.apex_domain}"
  # Matches the wrangler-deployed Worker name (top-level "career-pilot-portal"
  # for prod; "<name>-<env>" for a named environment).
  worker_name = var.environment == "prod" ? "career-pilot-portal" : "career-pilot-portal-${var.environment}"
}

# Bind the deployed Worker to its custom domain. A Workers Custom Domain
# auto-provisions the edge TLS cert and routes all paths to the Worker.
# `service` must equal the deployed Worker script name.
resource "cloudflare_workers_domain" "frontend" {
  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id
  hostname   = local.frontend_host
  service    = local.worker_name

  # Gate-before-route: bind the public custom domain only after the env's Access
  # apps exist, so an admin path is never briefly ungated. Dev → the whole-host
  # owner-only app; prod → the two path-scoped /admin + /api/admin apps (the
  # public host is otherwise open). depends_on tolerates count=0 instances, so
  # listing all three is correct in either environment (§24.165 D3).
  depends_on = [
    cloudflare_zero_trust_access_application.frontend,
    cloudflare_zero_trust_access_application.admin,
  ]
}

# Owner-only access: a self-hosted Access application (deny-by-default) gating
# the frontend host, with a single Allow policy for the owner's email. Access is
# an edge auth layer evaluated before the Worker runs. One-time-PIN email login
# is the account-default IdP (no IdP resource needed).
resource "cloudflare_zero_trust_access_policy" "owner_only" {
  account_id = var.cloudflare_account_id
  name       = "career-pilot ${var.environment} owner-only"
  decision   = "allow"

  include {
    email = [var.owner_email]
  }
}

# DEV-ONLY: the whole dev frontend host is owner-gated (the dev surface is private,
# the same trust model the dev inspector + /admin rely on). count=0 on prod removes
# this app — prod's public showcase host is OPEN, its admin paths gated by the two
# path-scoped apps below instead (§24.165 D3).
resource "cloudflare_zero_trust_access_application" "frontend" {
  count                     = var.environment == "prod" ? 0 : 1
  account_id                = var.cloudflare_account_id
  name                      = "career-pilot ${var.environment} portal"
  domain                    = local.frontend_host
  type                      = "self_hosted"
  session_duration          = "24h"
  auto_redirect_to_identity = false
  policies                  = [cloudflare_zero_trust_access_policy.owner_only.id]
}

# PROD-ONLY: ONE owner-only Access app covering BOTH the `/admin` SPA page AND the
# `/api/admin` BFF-proxied data endpoints (each path + everything under it) — the
# PRIMARY admin gate on an otherwise-open public host. A SINGLE app (one `aud`) is
# load-bearing: with two separate apps the SPA's XHR to `/api/admin` can't silently
# obtain the second app's cookie, so the panels read "unavailable" — one app means
# one cookie authorizes both. The backend's origin-JWT (access-jwt.ts) is a separate
# blanket belt validating the api-app assertion the Worker presents at the tunnel —
# NOT the admin identity gate, which is THIS edge app (§24.165 D4).
resource "cloudflare_zero_trust_access_application" "admin" {
  count                     = var.environment == "prod" ? 1 : 0
  account_id                = var.cloudflare_account_id
  name                      = "career-pilot ${var.environment} admin"
  self_hosted_domains       = ["${local.frontend_host}/admin", "${local.frontend_host}/api/admin"]
  type                      = "self_hosted"
  session_duration          = "24h"
  auto_redirect_to_identity = false
  policies                  = [cloudflare_zero_trust_access_policy.owner_only.id]
}

# STANDBY (STRATEGY.md §24.189) — the KV namespace holding the standby flag + the
# entry identity snapshot.
#
# Why KV and not the host DB: standby STOPS the GCP VM, so the flag that says
# "we're on standby" cannot live in `system_modes` — that table is on the disk
# being powered down. KV is the only store the Worker can still read (and the edge
# console still write) with GCP gone.
#
# One namespace PER ENVIRONMENT: dev gets its own, so exercising standby on dev can
# never black out the prod site. Terraform creates it; the id is surfaced as an
# output and set as the `STANDBY_KV_NAMESPACE_ID` GitHub env var, which
# deploy-frontend substitutes into the committed wrangler placeholder at build time
# (so no account resource id is committed).
#
# The console + its endpoint live under `/admin/standby` + `/api/admin/standby`,
# which the owner-only `admin` Access application above ALREADY covers (it matches
# each path and everything under it) — so the edge console needs no new gate.
resource "cloudflare_workers_kv_namespace" "standby" {
  account_id = var.cloudflare_account_id
  title      = "career-pilot-standby-${var.environment}"
}

output "frontend_url" {
  value = "https://${local.frontend_host}"
}

output "standby_kv_namespace_id" {
  value       = cloudflare_workers_kv_namespace.standby.id
  description = "Set as the STANDBY_KV_NAMESPACE_ID GitHub Environment variable for this env."
}
