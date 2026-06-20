#!/usr/bin/env bash
#
# scripts/harden-container-egress.sh — block agent containers from reaching the
# cloud metadata server (the §24.141 S2-0 SSRF belt).
#
# A default-bridge container can otherwise reach 169.254.169.254 and pull the
# VM's service-account token (box-measured 2026-06-20: HTTP 200, a cloud-platform
# token for the default Compute SA). The sandbox tool lockdown (disallowing Bash)
# is the PRIMARY control — it removes the only tool that can set the required
# `Metadata-Flavor: Google` header. THIS is the belt: a host firewall DROP so the
# path stays closed even against a future header-capable tool or WebFetch change.
#
# Mechanism: a DROP rule in Docker's DOCKER-USER chain (the user-ordered chain
# Docker preserves across daemon restarts), installed via a systemd oneshot
# ordered After=docker.service so it re-applies at every boot. Idempotent — safe
# to re-run (the deploy step does, every deploy). Only filters CONTAINER traffic;
# the host's own legitimate metadata access (different path) is untouched.
#
# IMPORTANT: block only the metadata HTTP API (tcp/80) — on GCP the SAME IP
# (169.254.169.254) also serves DNS on port 53, so a blanket DROP breaks all
# container name-resolution. The SA-token endpoint is HTTP/80, so a :80-scoped
# DROP closes the SSRF path while leaving DNS intact.
#
# RUN AS: root (the deploy-backend.yml privileged preamble calls it via sudo;
# also runnable standalone on the box for an immediate apply).
#
set -euo pipefail

METADATA_IP="169.254.169.254"
UNIT="/etc/systemd/system/cp-metadata-block.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "harden-container-egress: must run as root" >&2
  exit 1
fi

cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Block container egress to the cloud metadata server (career-pilot SSRF belt)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
# Drop the metadata HTTP API (tcp/80) only — port 53 (DNS, same IP on GCP) stays
# open. Clean up any prior blanket DROP first; idempotent insert of the :80 rule.
ExecStart=/bin/sh -c 'iptables -D DOCKER-USER -d ${METADATA_IP} -j DROP 2>/dev/null; iptables -C DOCKER-USER -d ${METADATA_IP} -p tcp --dport 80 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d ${METADATA_IP} -p tcp --dport 80 -j DROP'

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable --now cp-metadata-block.service

# Apply immediately too, and clean up any prior blanket DROP (an earlier version
# of this script dropped ALL traffic to the metadata IP, which also killed DNS).
iptables -D DOCKER-USER -d "${METADATA_IP}" -j DROP 2>/dev/null || true
iptables -C DOCKER-USER -d "${METADATA_IP}" -p tcp --dport 80 -j DROP 2>/dev/null \
  || iptables -I DOCKER-USER -d "${METADATA_IP}" -p tcp --dport 80 -j DROP

echo "harden-container-egress: DOCKER-USER DROP tcp/80 -> ${METADATA_IP} active (DNS/53 open):"
iptables -L DOCKER-USER -n --line-numbers | grep -E "DROP|Chain" || true
