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
    cloudflare_zero_trust_access_application.admin_page,
    cloudflare_zero_trust_access_application.admin_api,
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

# PROD-ONLY: two path-scoped owner-only Access apps — the PRIMARY admin gate on an
# otherwise-open public host. `/admin` covers the SPA admin page; `/api/admin`
# covers the BFF-proxied admin API (both `<path>` and everything under it). The
# backend's origin-JWT (access-jwt.ts) is a separate blanket belt that validates
# the api-app assertion the Worker presents at the tunnel — NOT the admin identity
# gate, which is these edge apps (§24.165 D4).
resource "cloudflare_zero_trust_access_application" "admin_page" {
  count                     = var.environment == "prod" ? 1 : 0
  account_id                = var.cloudflare_account_id
  name                      = "career-pilot ${var.environment} admin page"
  domain                    = "${local.frontend_host}/admin"
  type                      = "self_hosted"
  session_duration          = "24h"
  auto_redirect_to_identity = false
  policies                  = [cloudflare_zero_trust_access_policy.owner_only.id]
}

resource "cloudflare_zero_trust_access_application" "admin_api" {
  count                     = var.environment == "prod" ? 1 : 0
  account_id                = var.cloudflare_account_id
  name                      = "career-pilot ${var.environment} admin api"
  domain                    = "${local.frontend_host}/api/admin"
  type                      = "self_hosted"
  session_duration          = "24h"
  auto_redirect_to_identity = false
  policies                  = [cloudflare_zero_trust_access_policy.owner_only.id]
}

output "frontend_url" {
  value = "https://${local.frontend_host}"
}
