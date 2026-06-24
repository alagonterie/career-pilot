# Phase 9.4a (STRATEGY.md §24.70) — edge WAF posture for the public showcase.
#
# Free-zone reconciliation (CLOUDFLARE_PATTERNS §6 corrected to what a free zone
# can actually do):
#   - The Cloudflare FREE Managed Ruleset is auto-deployed and always on — it is
#     NOT Terraform-manageable (deployable managed rulesets need Pro+). Nothing to
#     declare here; it just runs.
#   - Bot Fight Mode (free) is a ZONE-WIDE toggle — it cannot be scoped to one
#     host. Enabling it would also evaluate the `api.<host>` tunnel ingress and
#     could challenge the Worker→tunnel fetch (which is automated, not a browser),
#     breaking the BFF. The api host is already deny-by-default behind Cloudflare
#     Access (only the Worker's service token passes), so it needs no bot toggle.
#     We therefore do NOT enable zone-wide Bot Fight Mode; public-host bot
#     protection comes from the host-scoped custom rule below + Turnstile +
#     the backend caps (§24.70).
#
# What IS free + host-scoped (so the api path is untouched): one rate-limiting
# rule + one custom firewall rule, both pinned to the frontend host + the two
# public mutation paths. `local.frontend_host` (cloudflare.tf) makes them
# per-environment.
#
# §24.165 D7 — SAME-ZONE CONSTRAINT: a zone allows exactly ONE ruleset per phase,
# and dev + prod share the `example.com` zone, so both envs can't each own a
# phase ruleset. These are gated DEV-ONLY (count below) and DEFERRED on prod
# because prod's protection doesn't need them: the Worker's Rate Limiting
# (SANDBOX_BURST/CONTACT_BURST = 2/60s) is TIGHTER than the 30/10s rule here, and
# Turnstile (live on both endpoints) + the backend caps (per-IP daily / global
# $-budget / 300s wall) are the real ceiling. Follow-up (post-launch) if a prod
# WAF belt is still wanted: free dev's zone slot and make these prod-only, or
# unify one ruleset across both hosts.

# Rate-limiting rule (http_ratelimit phase): a coarse edge flood-shield in FRONT
# of the Worker — sheds gross floods on the public POST endpoints before the
# Worker's own per-IP burst limiter even runs.
resource "cloudflare_ruleset" "public_ratelimit" {
  count       = var.environment == "prod" ? 0 : 1
  zone_id     = var.cloudflare_zone_id
  name        = "career-pilot ${var.environment} public rate limit"
  description = "Flood-shield the public mutation endpoints (§24.70)"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules {
    ref         = "cp_public_mutations_rl"
    description = "Rate limit POST /api/{simulator,contact} per IP on the public host"
    expression  = "(http.host eq \"${local.frontend_host}\") and (http.request.method eq \"POST\") and (http.request.uri.path eq \"/api/simulator\" or http.request.uri.path eq \"/api/contact\")"
    action      = "block"

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10
      requests_per_period = 30
      mitigation_timeout  = 10
    }
  }
}

# Custom firewall rule (http_request_firewall_custom phase): a managed challenge
# on the same public POST paths when Cloudflare's threat score is elevated — a
# belt for Turnstile against known-bad sources. Managed Challenge (not block)
# keeps false positives recoverable for real humans.
resource "cloudflare_ruleset" "public_custom" {
  count       = var.environment == "prod" ? 0 : 1
  zone_id     = var.cloudflare_zone_id
  name        = "career-pilot ${var.environment} public custom WAF"
  description = "Challenge high-threat requests to the public mutation endpoints (§24.70)"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules {
    ref         = "cp_public_mutations_threat_challenge"
    description = "Managed-challenge elevated-threat POSTs to /api/{simulator,contact} on the public host"
    expression  = "(http.host eq \"${local.frontend_host}\") and (http.request.method eq \"POST\") and (http.request.uri.path eq \"/api/simulator\" or http.request.uri.path eq \"/api/contact\") and (cf.threat_score gt 10)"
    action      = "managed_challenge"
  }
}
