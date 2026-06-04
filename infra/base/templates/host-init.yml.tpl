#cloud-config
# Phase 9.2 (STRATEGY.md §24.39) — env-agnostic OS baseline for the shared
# career-pilot VM: Docker + the unprivileged service user + /opt. It deliberately
# installs NO app, env config, OneCLI secrets, cloudflared tunnel — AND NOT the
# Node/pnpm toolchain. Those land via the SSH/IAP deploy step's privileged
# preamble (deploy-backend.yml), which is re-runnable + self-healing — unlike
# fire-once cloud-init, whose Node install proved unreliable (the VM came up with
# the distro's Node 18). Keeping cloud-init to the OS baseline matches this file's
# own philosophy: debuggable, re-runnable setup belongs in the deploy step.
package_update: true
package_upgrade: true
packages:
  - ca-certificates
  - curl
  - git
  - docker.io

runcmd:
  # Docker daemon — the container runtime NanoClaw spawns agents into.
  - systemctl enable --now docker
  # The unprivileged service user: owns the per-env repo checkouts and runs the
  # per-env systemd services; in the docker group so it can spawn agents.
  - id -u ${service_user} >/dev/null 2>&1 || useradd -m -s /bin/bash ${service_user}
  - usermod -aG docker ${service_user}
  # /opt holds the per-env checkouts (/opt/career-pilot, /opt/career-pilot-dev).
  - mkdir -p /opt
  - chown ${service_user}:${service_user} /opt
