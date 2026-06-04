#!/usr/bin/env bash
#
# scripts/install-tunnel.sh — install/refresh the cloudflared tunnel daemon that
# is the dev backend's SOLE ingress. The VM has no inbound ports (the GCP
# firewall allows only IAP SSH); api.dev.hire + onecli.dev.hire arrive through
# this OUTBOUND tunnel, gated at the Cloudflare edge by the owner-only Access
# apps. See infra/tunnel.tf for the edge half.
#
# Idempotent + re-runnable. The unprivileged service user can't install packages
# or write /etc, so .github/workflows/deploy-backend.yml's privileged preamble
# invokes this via sudo (as the deploy SA).
#
# REMOTELY-MANAGED tunnel: Terraform owns the ingress rules in Cloudflare
# (infra/tunnel.tf's *_config resource), so the daemon needs only the token. The
# token is a credential — read from CLOUDFLARED_TOKEN (set from the GH `dev` env
# secret CLOUDFLARED_DEV_TUNNEL_TOKEN, itself the Terraform `dev_tunnel_token`
# output) and written to a root-only env-file; it never lands in the daemon's
# command line or the unit's ExecStart (the deploy step's transient `sudo env`
# pass-in is the same channel every other deploy secret uses).
#
# RUN AS: root (via sudo). ENV: CLOUDFLARED_TOKEN (required).
set -euo pipefail

UNIT_NAME="cloudflared-dev"
ENV_FILE="/etc/cloudflared/dev.env"

[ "$(id -u)" -eq 0 ] || { echo "install-tunnel: must run as root (sudo)" >&2; exit 1; }
[ -n "${CLOUDFLARED_TOKEN:-}" ] || { echo "install-tunnel: CLOUDFLARED_TOKEN is required" >&2; exit 1; }

# 1. cloudflared package — direct .deb (no apt-repo codename/keyring dance).
#    `latest` matches Cloudflare's own guidance; the daemon runs
#    --no-autoupdate (we manage the binary via redeploys). Version-pinning is a
#    9.4 hardening item.
if ! command -v cloudflared >/dev/null 2>&1; then
  arch="$(dpkg --print-architecture)"
  curl -fsSL -o /tmp/cloudflared.deb \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
  dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi

# 2. Token in a root-only env-file (0600). cloudflared honors TUNNEL_TOKEN as
#    the equivalent of `--token` for a token-run.
install -d -m 0750 /etc/cloudflared
umask 077
printf 'TUNNEL_TOKEN=%s\n' "${CLOUDFLARED_TOKEN}" > "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"

# 3. System unit — runs the remotely-managed tunnel from the token, restarts on
#    failure so a transient drop self-heals.
cat > "/etc/systemd/system/${UNIT_NAME}.service" <<'UNIT'
[Unit]
Description=cloudflared tunnel (career-pilot dev)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/cloudflared/dev.env
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${UNIT_NAME}" >/dev/null 2>&1 || true
systemctl restart "${UNIT_NAME}" # (re)start; picks up a rotated token

sleep 2
echo "install-tunnel: ${UNIT_NAME} is $(systemctl is-active "${UNIT_NAME}")"
