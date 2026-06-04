# Phase 9.2 (STRATEGY.md §24.39) — the per-environment cloudflared tunnel + the
# backend edge (api.<host> + onecli.<host>), behind the same owner-only Access
# gate as the frontend.
#
# Division of ownership mirrors cloudflare.tf: Terraform owns the Cloudflare
# surface (tunnel resource + its ingress config + the DNS routes + the Access
# apps). The cloudflared DAEMON that dials this tunnel out from the VM is
# installed by the deploy step (deploy-backend.yml) using the `dev_tunnel_token`
# output below — it never runs here. The VM has no inbound ports; all backend
# traffic arrives through this outbound tunnel.
#
# Remotely-managed tunnel (config_src = "cloudflare"): ingress rules live in
# Terraform (the *_config resource), so the VM daemon needs only `--token`.
# Resource names are the v4.52.7 non-deprecated forms
# (cloudflare_zero_trust_tunnel_cloudflared*, per docs/PHASE9_DEPLOY_FINDINGS.md).

locals {
  # dev -> api.dev.hire.<apex> / onecli.dev.hire.<apex>
  # prod (9.4) -> api.hire.<apex> / onecli.hire.<apex>
  api_host    = "api.${local.frontend_host}"
  onecli_host = "onecli.${local.frontend_host}"

  # The tunnel forwards to the host-local listener; this MUST mirror the port
  # the env's NanoClaw process binds. Dev's portal API binds 3002 (set by the
  # deploy step's CP_PORTAL_API_PORT -> the preferences config tier); prod (9.4)
  # binds 3001. OneCLI is one gateway on its fixed port regardless of env.
  portal_api_port = var.environment == "prod" ? 3001 : 3002
  onecli_port     = 10254
}

# A 32-byte tunnel secret. The tunnel token (consumed by the VM daemon) is
# derived from this + the tunnel/account IDs; rotating it forces a new token.
resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "backend" {
  account_id = var.cloudflare_account_id
  name       = "career-pilot-${var.environment}"
  secret     = random_id.tunnel_secret.b64_std
  config_src = "cloudflare" # ingress managed by the *_config resource below
}

# Ingress: the two backend hosts -> the host-local listeners, then a catch-all
# 404. localhost is the VM loopback (both the portal API and OneCLI bind
# 127.0.0.1 only — never an open port; the tunnel is their sole ingress).
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "backend" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.backend.id

  config {
    ingress_rule {
      hostname = local.api_host
      service  = "http://localhost:${local.portal_api_port}"
    }
    ingress_rule {
      hostname = local.onecli_host
      service  = "http://localhost:${local.onecli_port}"
    }
    # Required terminal catch-all.
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# DNS: proxied CNAMEs pointing the backend hosts at the tunnel. The tunnel's
# routing target is always <tunnel-id>.cfargotunnel.com.
resource "cloudflare_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = local.api_host
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.backend.id}.cfargotunnel.com"
  proxied = true
}

resource "cloudflare_record" "onecli" {
  zone_id = var.cloudflare_zone_id
  name    = local.onecli_host
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.backend.id}.cfargotunnel.com"
  proxied = true
}

# Owner-only Access on the API host. Same single owner_only policy as the
# frontend (cloudflare.tf). Session matched to the frontend's 24h so the
# CF_Authorization cookie the browser presents on the direct EventSource stream
# (the D9 SSE-through-Access path) outlives a long-open portal session.
resource "cloudflare_zero_trust_access_application" "api" {
  account_id                = var.cloudflare_account_id
  name                      = "career-pilot ${var.environment} api"
  domain                    = local.api_host
  type                      = "self_hosted"
  session_duration          = "24h"
  auto_redirect_to_identity = false
  policies                  = [cloudflare_zero_trust_access_policy.owner_only.id]
}

# Owner-only Access on the OneCLI vault UI host — a higher-value target than the
# portal (it manages credentials), so a tighter session than the portal/api.
resource "cloudflare_zero_trust_access_application" "onecli" {
  account_id                = var.cloudflare_account_id
  name                      = "career-pilot ${var.environment} onecli"
  domain                    = local.onecli_host
  type                      = "self_hosted"
  session_duration          = "1h"
  auto_redirect_to_identity = false
  policies                  = [cloudflare_zero_trust_access_policy.owner_only.id]
}

# Consumed by the VM's cloudflared daemon (deploy-backend.yml installs it as a
# root systemd unit reading this from the GH `dev` env secret
# CLOUDFLARED_DEV_TUNNEL_TOKEN). Sensitive: it authorizes dialing the tunnel.
output "dev_tunnel_token" {
  description = "cloudflared --token for the VM daemon. Set as GH dev env secret CLOUDFLARED_DEV_TUNNEL_TOKEN."
  value       = cloudflare_zero_trust_tunnel_cloudflared.backend.tunnel_token
  sensitive   = true
}

output "api_url" {
  value = "https://${local.api_host}"
}

output "onecli_url" {
  value = "https://${local.onecli_host}"
}
