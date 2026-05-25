resource "random_password" "tunnel_secret" {
  length  = 64
}

resource "cloudflare_tunnel" "backend_tunnel" {
  account_id = var.cloudflare_account_id
  name       = "career-pilot-backend-tunnel"
  secret     = base64sha256(random_password.tunnel_secret.result)
}

resource "cloudflare_record" "backend_tunnel_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "api.${var.frontend_subdomain}"
  value   = "${cloudflare_tunnel.backend_tunnel.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
}

resource "cloudflare_tunnel_config" "backend_tunnel_config" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_tunnel.backend_tunnel.id

  config {
    ingress_rule {
      hostname = "api.${var.frontend_subdomain}.${var.apex_domain}"
      service  = "http://localhost:3000"
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}
