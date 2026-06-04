#!/usr/bin/env bash
#
# scripts/install-tailscale.sh — join the dev VM to the owner's Tailscale tailnet
# so VM-local services (OneCLI :10254, `ncl`, `--step pair-telegram`, host logs)
# are reachable DIRECTLY over the tailnet — no `gcloud compute ssh` localhost-
# forward, no PuTTY, no broken ~/.ssh keys. Also unblocks the agent: Claude's
# tools run on the owner's (tailnet-joined) machine, so once this is up they can
# `curl` the VM's internal services for instant diagnostics instead of the
# deploy-as-diagnostics CI loop. See STRATEGY.md §24.41.
#
# PRESERVES the no-public-inbound posture: Tailscale joins via OUTBOUND
# connections (no GCP firewall opening); reachability is tailnet-ACL-gated to the
# owner's own devices. This is purely additive to the cloudflared edge — the
# public surface (api.dev.hire / onecli.dev.hire) is unchanged.
#
# Idempotent + re-runnable. The unprivileged service user can't install packages
# or manage the tailscaled daemon, so deploy-backend.yml's privileged preamble
# invokes this via sudo (as the deploy SA) — same channel as install-tunnel.sh.
#
# The auth key is a credential — read from TAILSCALE_AUTHKEY (set from the GH
# `dev` env secret TAILSCALE_AUTHKEY, an owner-generated REUSABLE pre-authorized
# key). It reaches this script via env (the deploy step's transient `sudo env`
# pass-in, the same channel every other deploy secret uses) and never lands in
# the daemon's command line or any unit file — `tailscale up` consumes it once
# and tailscaled persists the resulting node key under /var/lib/tailscale.
#
# RUN AS: root (via sudo). ENV: TAILSCALE_AUTHKEY (required).
set -euo pipefail

HOSTNAME_TS="career-pilot-dev"

[ "$(id -u)" -eq 0 ] || { echo "install-tailscale: must run as root (sudo)" >&2; exit 1; }
[ -n "${TAILSCALE_AUTHKEY:-}" ] || { echo "install-tailscale: TAILSCALE_AUTHKEY is required" >&2; exit 1; }

# Strip any stray whitespace/newline — guards against a key set via a piped
# `gh secret set` carrying a trailing newline (a Tailscale auth key is a single
# token with no internal whitespace, so this is safe). Same defensive strip as
# install-tunnel.sh's token handling.
authkey="$(printf '%s' "${TAILSCALE_AUTHKEY}" | tr -d '[:space:]')"

# 1. tailscale package — the official installer handles distro detection +
#    pins the apt repo; it installs + enables the tailscaled systemd daemon. On
#    re-runs (binary already present) this is a no-op, so skip it.
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# Ensure the daemon is up before we try to authenticate against it.
systemctl enable --now tailscaled >/dev/null 2>&1 || true

# 2. Bring the node onto the tailnet.
#    --ssh        enable Tailscale SSH (owner + agent reach the box via tailnet
#                 identity — no host SSH keys involved).
#    --accept-dns=false  do NOT let MagicDNS rewrite the VM's /etc/resolv.conf;
#                 the box resolves fine on its own and we don't want Tailscale
#                 owning DNS on a server.
#    --hostname   stable tailnet name.
#    --authkey    non-interactive auth (reusable key → safe to re-present).
#
#    Idempotent: if the node is already authenticated + Running, re-presenting a
#    reusable key is harmless, but to avoid touching a key that may have been
#    rotated/expired between deploys we only `up` (with the key) when NOT already
#    Running; when already up we just re-assert --ssh via `tailscale set` (no key
#    needed), so a healthy node survives a deploy untouched.
backend_state="$(tailscale status --json 2>/dev/null | grep -o '"BackendState":[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')"
if [ "${backend_state}" = "Running" ]; then
  echo "install-tailscale: node already Running — re-asserting --ssh without consuming the key"
  tailscale set --ssh >/dev/null 2>&1 || true
else
  tailscale up \
    --ssh \
    --accept-dns=false \
    --hostname="${HOSTNAME_TS}" \
    --authkey="${authkey}"
fi

# 3. Verify the node is Running + report the tailnet IP (the address the owner +
#    agent use to reach VM-local services). Mirror install-tunnel.sh's
#    stability check: require Running, dump diagnostics + fail otherwise.
ts_ok=0
for _ in $(seq 1 10); do
  state="$(tailscale status --json 2>/dev/null | grep -o '"BackendState":[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')"
  if [ "${state}" = "Running" ]; then ts_ok=1; break; fi
  sleep 2
done
if [ "${ts_ok}" -eq 1 ]; then
  ts_ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  echo "install-tailscale: ${HOSTNAME_TS} on the tailnet (Running) ip=${ts_ip:-unknown}"
  echo "install-tailscale: reach VM-local services at http://${ts_ip:-<tailnet-ip>}:10254 (OneCLI) / :3002 (portal)"
else
  {
    echo "install-tailscale: node did not reach Running — diagnostics:"
    tailscale status 2>&1 | head -n 20 || true
    echo "--- systemctl status tailscaled (tail 20) ---"
    systemctl status tailscaled --no-pager -l 2>&1 | tail -n 20 || true
    echo "--- journalctl -u tailscaled (tail 30) ---"
    journalctl -u tailscaled --no-pager -n 30 2>&1 || true
  } >&2
  exit 1
fi
