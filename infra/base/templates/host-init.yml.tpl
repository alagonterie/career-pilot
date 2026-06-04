#cloud-config
# Phase 9.2 (STRATEGY.md §24.39) — env-agnostic host baseline for the shared
# career-pilot VM. Installs the runtime the NanoClaw stacks need (Docker, Node,
# pnpm) + the unprivileged service user. It deliberately installs NO app, env
# config, OneCLI secrets, or cloudflared tunnel — those are per-env and land via
# the SSH/IAP deploy step, so this template stays env-agnostic and the
# (debuggable, re-runnable) app setup is not buried in fire-once cloud-init.
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
  # Node 20 LTS + pnpm 10 — the host tree's toolchain.
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs
  - npm install -g pnpm@10
  # The unprivileged service user: owns the per-env repo checkouts and runs the
  # per-env systemd services; in the docker group so it can spawn agents.
  - id -u ${service_user} >/dev/null 2>&1 || useradd -m -s /bin/bash ${service_user}
  - usermod -aG docker ${service_user}
  # /opt holds the per-env checkouts (/opt/career-pilot, /opt/career-pilot-dev).
  - mkdir -p /opt
  - chown ${service_user}:${service_user} /opt
