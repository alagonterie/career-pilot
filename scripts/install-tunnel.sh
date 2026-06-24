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
# RUN AS: root (via sudo). ENV: CLOUDFLARED_TOKEN (required); TUNNEL_ENV (dev|prod,
# default dev — selects the unit name + env-file so a prod tunnel coexists with dev).
set -euo pipefail

# §24.165 D5: per-env unit + env-file so a prod tunnel (TUNNEL_ENV=prod →
# cloudflared-prod / prod.env) coexists with dev's cloudflared-dev on the shared
# VM. Defaults to dev → the existing dev deploy path stays byte-identical.
TUNNEL_ENV="${TUNNEL_ENV:-dev}"
UNIT_NAME="cloudflared-${TUNNEL_ENV}"
ENV_FILE="/etc/cloudflared/${TUNNEL_ENV}.env"

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
# Strip any stray whitespace/newline. A cloudflared token is base64 (no internal
# whitespace), so this is safe — and it guards against a token set via a piped
# `gh secret set` carrying a trailing newline, which cloudflared rejects as
# "Provided Tunnel token is not valid."
token="$(printf '%s' "${CLOUDFLARED_TOKEN}" | tr -d '[:space:]')"
printf 'TUNNEL_TOKEN=%s\n' "${token}" > "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"

# 3. System unit — runs the remotely-managed tunnel from the token, restarts on
#    failure so a transient drop self-heals. The unit name + EnvironmentFile are
#    per-env (${UNIT_NAME} / ${ENV_FILE}) so a prod daemon never clobbers dev.
#    NOTE: --no-autoupdate is an APP-level flag → it must precede the `tunnel`
#    subcommand (cloudflared's canonical token-run form). Placing it after
#    `tunnel` crash-loops the daemon on a flag-parse error (the unit shows
#    "activating", never connects). This lives as a shell comment, not inside the
#    unit, so the (now unquoted) heredoc below carries no backticks to expand.
cat > "/etc/systemd/system/${UNIT_NAME}.service" <<UNIT
[Unit]
Description=cloudflared tunnel (career-pilot ${TUNNEL_ENV})
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${UNIT_NAME}" >/dev/null 2>&1 || true
systemctl restart "${UNIT_NAME}" # (re)start; picks up a rotated token

# Verify the daemon is RUNNING STABLY — i.e. not crash-looping, which is the
# real failure mode (an invalid token makes cloudflared exit ~immediately, so
# the unit sits in "activating (auto-restart)" and never holds "active"). A
# healthy daemon goes "active" and stays there. We require 3 consecutive
# "active" reads. (An earlier journal-grep for "Registered tunnel connection"
# proved too fragile — log wording + rotation + a restart-window race produced
# false negatives even when the CF API showed the tunnel healthy. The deploy's
# token-authed edge smoke is the authoritative end-to-end reachability gate;
# this just catches a crash-looping daemon early with cloudflared diagnostics.)
stable=0
for _ in $(seq 1 8); do
  if [ "$(systemctl is-active "${UNIT_NAME}" 2>/dev/null)" = "active" ]; then
    stable=$((stable + 1))
  else
    stable=0
  fi
  [ "$stable" -ge 3 ] && break
  sleep 2
done
if [ "$stable" -ge 3 ]; then
  echo "install-tunnel: ${UNIT_NAME} running stably (active x3)"
else
  {
    echo "install-tunnel: ${UNIT_NAME} not stable (crash-looping?) — diagnostics:"
    systemctl status "${UNIT_NAME}" --no-pager -l 2>&1 | tail -n 20 || true
    echo "--- journalctl -u ${UNIT_NAME} (tail 40) ---"
    journalctl -u "${UNIT_NAME}" --no-pager -n 40 2>&1 || true
  } >&2
  exit 1
fi
