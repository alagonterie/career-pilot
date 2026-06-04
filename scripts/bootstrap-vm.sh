#!/usr/bin/env bash
#
# scripts/bootstrap-vm.sh — codified, idempotent provisioning of a career-pilot
# backend stack on the shared GCP host.
#
# A THIN ORCHESTRATOR over NanoClaw's own setup primitives. It sequences
# `setup.sh` (Node/pnpm/native-module basics) and `setup/index.ts --step <name>`
# (container image, OneCLI gateway, systemd service) and adds the
# career-pilot-specific layer: .env generation + DB provisioning via
# scripts/provision-backend.ts. We do NOT reimplement any install logic.
#
# It deliberately does NOT drive `nanoclaw.sh` / `pnpm run setup:auto`: that is
# the interactive @clack flow with tty gates — including a GCE "Google blocks
# sudo, try anyway? [y/N]" prompt that would hang a headless SSH session. The
# discrete `--step` calls are the non-interactive primitive built for exactly
# this.
#
# Per-checkout isolation is AUTOMATIC: NanoClaw derives the systemd unit name,
# the docker image tag, and every data path (data/v2.db, v2-sessions, sockets)
# from the checkout path (src/install-slug.ts + cwd-relative reads). So a dev
# checkout at /opt/career-pilot-dev and a future prod checkout at
# /opt/career-pilot coexist with no shared mutable state beyond the one OneCLI
# gateway (scoped per-agent) and the Docker daemon.
#
# RUN AS: the unprivileged service user (career-pilot), from the checkout root,
# in a login shell with a working user-systemd session (XDG_RUNTIME_DIR set +
# `loginctl enable-linger <user>` already done by the caller). The
# deploy-backend.yml workflow's privileged preamble handles those; this script
# needs no sudo for the steps it runs — cloud-init laid the host baseline
# (Docker, Node 20, pnpm, the service user in the docker group).
#
# CONFIG — via env (deploy-backend.yml injects these from GH per-env vars +
# secrets). Every var has a safe default except the two required secrets:
#   CP_ENVIRONMENT          dev | production         (default: dev)
#   CP_ASSISTANT_NAME       agent display name       (default: "Career Pilot")
#   CP_TZ                   IANA timezone            (default: America/Chicago)
#   CP_PORTAL_API_PORT      portal /api port         (default: 3002 — dev)
#   CP_WEBHOOK_PORT         webhook listener port    (default: 3001 — dev)
#   CP_PORTKEY_AI_PROVIDER  Portkey provider slug    (default: anthropic-default)
#   CP_ALLOW_PRODUCTION     "1" to permit prod        (default: unset)
#   TELEGRAM_BOT_TOKEN      this env's bot token      (secret; required)
#   PORTKEY_API_KEY         LLM-gateway key           (secret; required)
#   ANTHROPIC_API_KEY       direct-Anthropic bypass   (secret; optional)
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# ─── config (env with safe defaults) ────────────────────────────────────────
CP_ENVIRONMENT="${CP_ENVIRONMENT:-dev}"
CP_ASSISTANT_NAME="${CP_ASSISTANT_NAME:-Career Pilot}"
CP_TZ="${CP_TZ:-America/Chicago}"
CP_PORTAL_API_PORT="${CP_PORTAL_API_PORT:-3002}"
CP_WEBHOOK_PORT="${CP_WEBHOOK_PORT:-3001}"
CP_PORTKEY_AI_PROVIDER="${CP_PORTKEY_AI_PROVIDER:-anthropic-default}"
CP_ALLOW_PRODUCTION="${CP_ALLOW_PRODUCTION:-}"

# The agent image Dockerfile uses BuildKit cache mounts (RUN --mount=type=cache).
# Ubuntu's docker.io defaults to the legacy builder, which rejects --mount; opt
# into the daemon's integrated BuildKit for the `docker build` in the container
# step (setup/container.ts inherits this env).
export DOCKER_BUILDKIT=1

# provision-backend.ts reads these from the environment (the host never loads
# .env into process.env — NanoClaw reads only specific keys from .env via
# readEnvFile). ENVIRONMENT drives the prod guard; CP_PORTAL_API_PORT is written
# to the preferences config tier so getConfig('portal_api_port') picks it up.
export ENVIRONMENT="$CP_ENVIRONMENT"
export CP_PORTAL_API_PORT

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ─── preflight ──────────────────────────────────────────────────────────────
[ -f "$PROJECT_ROOT/package.json" ] || die "not a checkout root: $PROJECT_ROOT"
[ "$(id -u)" -ne 0 ] || die "run as the unprivileged service user, not root"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || die "TELEGRAM_BOT_TOKEN is required"
[ -n "${PORTKEY_API_KEY:-}" ] || die "PORTKEY_API_KEY is required"

say "career-pilot backend bootstrap — env=$CP_ENVIRONMENT  root=$PROJECT_ROOT  user=$(whoami)"

# ─── 1. basics (Node + pnpm + repo deps + native modules) ───────────────────
# NanoClaw's own bash bootstrap. Idempotent; cloud-init already laid Node/pnpm/
# Docker, so in practice this resolves to `pnpm install --frozen-lockfile`.
say "1/6 basics (setup.sh)"
bash setup.sh

# ─── 2. .env (host tunables; secrets land here, never in git) ───────────────
# Written fresh each run from the injected config. The OneCLI step (4) writes
# ONECLI_URL into this file AFTER us, so we don't manage that key here.
say "2/6 .env"
anthropic_line=""
[ -n "${ANTHROPIC_API_KEY:-}" ] && anthropic_line="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
umask 077
cat > "$PROJECT_ROOT/.env" <<EOF
# Generated by scripts/bootstrap-vm.sh — do NOT commit. env=${CP_ENVIRONMENT}
# NanoClaw reads only specific keys from .env (src/env.ts readEnvFile): the host
# does NOT load .env into process.env. ASSISTANT_NAME / ONECLI_URL / TZ are read
# here; the portal port is set via the preferences tier (provision-backend.ts);
# PORTKEY/TELEGRAM reach their consumers via OneCLI + channel wiring (wired 9.3).
ENVIRONMENT=${CP_ENVIRONMENT}
ASSISTANT_NAME=${CP_ASSISTANT_NAME}
TZ=${CP_TZ}
PORTKEY_API_KEY=${PORTKEY_API_KEY}
PORTKEY_AI_PROVIDER=${CP_PORTKEY_AI_PROVIDER}
PORTKEY_BYPASS=false
${anthropic_line}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
EOF
echo "  wrote $PROJECT_ROOT/.env"

# ─── 3. agent container image ───────────────────────────────────────────────
# Image tag is path-derived (nanoclaw-agent-v2-<slug>:latest) → never collides
# with a prod checkout's image.
say "3/6 container image (--step container)"
pnpm exec tsx setup/index.ts --step container

# ─── 4. OneCLI gateway (the sole credential path) ───────────────────────────
# One gateway per host. Reuse it if one is already running (a prior checkout
# installed it) rather than rebinding the listener; otherwise install fresh.
say "4/6 OneCLI gateway (--step onecli)"
if onecli version >/dev/null 2>&1 && onecli config get api-host >/dev/null 2>&1; then
  echo "  existing gateway detected — reusing"
  pnpm exec tsx setup/index.ts --step onecli -- --reuse
else
  echo "  no gateway — installing fresh"
  pnpm exec tsx setup/index.ts --step onecli
fi

# ─── 5. backend DB provisioning (migrations + our agent groups) ─────────────
say "5/6 provision DB (migrations + career-pilot + sandbox groups)"
provision_args=()
[ "$CP_ALLOW_PRODUCTION" = "1" ] && provision_args+=(--allow-production)
pnpm exec tsx scripts/provision-backend.ts ${provision_args[@]+"${provision_args[@]}"}

# ─── 6. service (build dist + install user-systemd unit + start) ────────────
# --step service runs `pnpm run build`, writes the path-derived unit
# (nanoclaw-v2-<slug>.service), enables linger, and restarts. Survives SSH
# logout + reboot.
say "6/6 service (--step service)"
pnpm exec tsx setup/index.ts --step service

# ─── summary ────────────────────────────────────────────────────────────────
unit="nanoclaw-v2-$(node -e 'process.stdout.write(require("crypto").createHash("sha1").update(process.cwd()).digest("hex").slice(0,8))')"
say "bootstrap complete"
cat <<EOF

  systemd unit : ${unit}.service   (systemctl --user status ${unit})
  portal /api  : http://127.0.0.1:${CP_PORTAL_API_PORT}
  logs         : ${PROJECT_ROOT}/logs/nanoclaw.log

  One-time human steps still required (no headless path by design):
    · Pair the owner Telegram account to the career-pilot group.
    · Connect Gmail OAuth via the gated OneCLI UI (dev scope).
EOF
