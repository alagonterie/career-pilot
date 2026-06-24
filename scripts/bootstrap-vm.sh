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
#   CP_ONECLI_VERSION       OneCLI gateway image tag (default: 1.36.0 — keep in
#                           sync with setup/onecli.ts ONECLI_GATEWAY_VERSION)
#   CP_ONECLI_PUBLIC_URL    gated OneCLI UI URL       (default: unset → install
#                           default; set → OAuth callbacks use it, gated connect)
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
# Portkey Config (forward_headers: anthropic-beta — keeps Claude Code's prompt
# caching through the gateway). Default = the dev workspace config; a prod
# deploy overrides via CP_PORTKEY_CONFIG_ID.
CP_PORTKEY_CONFIG_ID="${CP_PORTKEY_CONFIG_ID:-pc-career-dad06e}"
CP_ALLOW_PRODUCTION="${CP_ALLOW_PRODUCTION:-}"
# OneCLI gateway image tag — keep in sync with setup/onecli.ts ONECLI_GATEWAY_VERSION.
# 1.36.0 is the first tag whose fresh runtime serves the `/v1` API the 2.x SDK
# requires (§24.127). The old 1.23.0 default silently re-pinned the durable
# ~/.onecli/.env to a pre-v1 gateway on every deploy — the version-skew bug that
# blocked the SDK 2.2.1 bump. A box already migrated by scripts/migrate-onecli-v1.sh
# stays put; only the volume reset (done once by that script) activates /v1.
CP_ONECLI_VERSION="${CP_ONECLI_VERSION:-1.36.0}"
# Gated OneCLI UI URL (e.g. https://onecli.dev.hire.<apex>). Unset → install
# default (localhost, OAuth unreachable through the tunnel). Set → NEXTAUTH_URL/
# NEXT_PUBLIC_APP_URL point here so the owner connects Gmail via the gated host.
CP_ONECLI_PUBLIC_URL="${CP_ONECLI_PUBLIC_URL:-}"
# Public portal URL (e.g. https://dev.hire.<apex>). Seeded into the preferences
# tier by provision-backend.ts so getConfig('portal_public_url') drives the
# résumé-PDF footer + the §24.74 attribution-link rewrite. Unset → "" (the footer
# omits the host; minting stays dormant).
CP_PORTAL_PUBLIC_URL="${CP_PORTAL_PUBLIC_URL:-}"
# Salt for the §24.74 visit-telemetry IP hash. A secret kept in .env (read via
# readEnvFile, never loaded into process.env). Unset → attribution.ts falls back
# to a constant (still never stores a raw IP).
VISIT_IP_HASH_SALT="${VISIT_IP_HASH_SALT:-}"
# Origin-JWT (§24.165 D4): the Cloudflare Access team identifier + the api-app AUD
# that access-jwt.ts validates the Cf-Access-Jwt-Assertion against. Written to
# .env (the step-6b drop-in loads .env into the host process env → process.env
# picks them up). Empty on dev → origin-JWT stays inert (fail-safe pass-through);
# prod sets them from the GH `production` env via deploy-backend-prod.yml.
CP_CF_ACCESS_TEAM="${CP_CF_ACCESS_TEAM:-}"
CP_CF_ACCESS_AUD="${CP_CF_ACCESS_AUD:-}"

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
export CP_PORTAL_PUBLIC_URL

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
# here; the portal port is set via the preferences tier (provision-backend.ts).
# Portkey routes ALL LLM paths (§24.44): the agent runtime via ANTHROPIC_BASE_URL
# (read by src/providers/claude.ts → x-portkey-provider/-config headers; OneCLI
# injects x-portkey-api-key for api.portkey.ai) + the host-side sim/scoring.
ENVIRONMENT=${CP_ENVIRONMENT}
ASSISTANT_NAME=${CP_ASSISTANT_NAME}
TZ=${CP_TZ}
# Chat-SDK webhook listener port (src/webhook-server.ts reads WEBHOOK_PORT;
# default 3000, binds 0.0.0.0). Per-env so prod (3003) doesn't collide with dev
# on the shared VM — the listener takes NO inbound traffic (the VM has no public
# ingress; Telegram long-polls) but must bind a FREE port or the host process
# crashes on boot with EADDRINUSE (§24.165 — the third port, beyond portal/api).
WEBHOOK_PORT=${CP_WEBHOOK_PORT}
PORTKEY_API_KEY=${PORTKEY_API_KEY}
PORTKEY_AI_PROVIDER=${CP_PORTKEY_AI_PROVIDER}
PORTKEY_CONFIG_ID=${CP_PORTKEY_CONFIG_ID}
PORTKEY_BYPASS=false
ANTHROPIC_BASE_URL=https://api.portkey.ai
# 1-hour prompt-cache TTL (§24.49) — keeps the ~55K static preamble warm across
# scheduled cron fires >5min apart (the default 5m ephemeral cache expires
# between them). Forwarded into the container by src/providers/claude.ts; set to
# 0 to disable without an image rebuild.
ENABLE_PROMPT_CACHING_1H=1
${anthropic_line}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
# §24.74 visit-telemetry IP-hash salt. Read by src/attribution.ts via readEnvFile
# (kept OUT of process.env). Empty line → readEnvFile skips it → constant fallback.
VISIT_IP_HASH_SALT=${VISIT_IP_HASH_SALT}
# §24.165 D4 origin-JWT — loaded into the host process env by the step-6b drop-in;
# access-jwt.ts reads process.env.CF_ACCESS_TEAM/_AUD (empty → validation inert).
CF_ACCESS_TEAM=${CP_CF_ACCESS_TEAM}
CF_ACCESS_AUD=${CP_CF_ACCESS_AUD}
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

# OneCLI durable runtime config — the install defaults are wrong for our topology
# on TWO axes, and NEITHER is reproducible from a bare `docker compose up`, so we
# pin both via the compose project env-file ($HOME/.onecli/.env, read for ${VAR}
# substitution) + the service env_file ($HOME/.env, the compose's `env_file:
# ../.env`), then recreate:
#   1. BIND HOST — the gateway must publish on the docker BRIDGE gateway IP
#      (172.17.0.1), not host loopback, so spawned agent containers AND the
#      cloudflared tunnel (onecli.<host> ingress) reach it. The install default is
#      127.0.0.1; an un-pinned recreate silently rebinds to loopback → onecli.
#      <host> 502s + credential injection breaks. Pin ONECLI_BIND_HOST so the
#      bridge bind survives any recreate (reset:dev, fresh prod VM).
#   2. OAUTH CALLBACK HOST — the OneCLI web app (Auth.js) derives its OAuth
#      redirect + state-cookie host from NEXTAUTH_URL; the image default is
#      localhost:10254 (unreachable through the tunnel → "Invalid state
#      parameter" on a gated browser connect). Point NEXTAUTH_URL/
#      NEXT_PUBLIC_APP_URL at the public gated host so the owner connects Gmail
#      directly via onecli.<host> with no SSH-forward. Env-specific → only when
#      CP_ONECLI_PUBLIC_URL is set.
# Also pin ONECLI_VERSION (compose defaults to `latest` → drift). The recreate
# preserves the NAMED volumes (onecli_pgdata = the OAuth vault), so connected apps
# survive. Replaces the old `onecli start` (the v2 CLI has no `start` verb — it
# silently no-op'd; this `up` + the restart policy keep the gateway alive).
ONECLI_DIR="$HOME/.onecli"
if [ -f "$ONECLI_DIR/docker-compose.yml" ]; then
  echo "  pinning OneCLI runtime config (bind host + OAuth callback host)"
  cat > "$ONECLI_DIR/.env" <<EOF
ONECLI_BIND_HOST=172.17.0.1
ONECLI_VERSION=${CP_ONECLI_VERSION}
EOF
  if [ -n "${CP_ONECLI_PUBLIC_URL:-}" ]; then
    # Merge into $HOME/.env (OneCLI's service env_file) — replace only the two
    # OAuth-URL lines, preserve anything else OneCLI may have written there.
    touch "$HOME/.env"
    grep -vE '^(NEXTAUTH_URL|NEXT_PUBLIC_APP_URL)=' "$HOME/.env" > "$HOME/.env.tmp" 2>/dev/null || true
    cat >> "$HOME/.env.tmp" <<EOF
NEXTAUTH_URL=${CP_ONECLI_PUBLIC_URL}
NEXT_PUBLIC_APP_URL=${CP_ONECLI_PUBLIC_URL}
EOF
    mv "$HOME/.env.tmp" "$HOME/.env"
    chmod 600 "$HOME/.env"
    echo "  OneCLI OAuth callback host → ${CP_ONECLI_PUBLIC_URL}"
  else
    echo "  CP_ONECLI_PUBLIC_URL unset — leaving NEXTAUTH_URL at the install default"
  fi
  ( cd "$ONECLI_DIR" && docker compose up -d ) 2>&1 | tail -5 || true
  onecli_cids="$(docker ps -aq --filter 'label=com.docker.compose.project=onecli' 2>/dev/null || true)"
  [ -n "$onecli_cids" ] && docker update --restart unless-stopped $onecli_cids >/dev/null 2>&1 || true
fi
# Health-check on the BRIDGE IP (not 127.0.0.1 → false "down"), at /api/health
# (/health is 404). This is the same address the onecli.<host> tunnel ingress
# targets. On failure dump container state + logs (no local SSH to debug).
gw_ok=0
for _ in $(seq 1 20); do
  if curl -fsS -m 3 http://172.17.0.1:10254/api/health >/dev/null 2>&1; then gw_ok=1; break; fi
  sleep 3
done
if [ "$gw_ok" -eq 1 ]; then
  echo "  OneCLI gateway healthy on 172.17.0.1:10254"
else
  {
    echo "WARNING: OneCLI gateway not answering on 172.17.0.1:10254 — diagnostics:"
    docker ps -a --filter 'label=com.docker.compose.project=onecli' --format '{{.Names}}: {{.Status}}' || true
    for c in $(docker ps -aq --filter 'label=com.docker.compose.project=onecli' 2>/dev/null); do echo "--- docker logs $c (tail 30) ---"; docker logs --tail 30 "$c" 2>&1 || true; done
  } >&2
fi

# ─── 5. backend DB provisioning (migrations + our agent groups) ─────────────
say "5/6 provision DB (migrations + career-pilot + sandbox groups)"
provision_args=()
[ "$CP_ALLOW_PRODUCTION" = "1" ] && provision_args+=(--allow-production)
pnpm exec tsx scripts/provision-backend.ts ${provision_args[@]+"${provision_args[@]}"}

# ─── 5.5 upgrade marker (stamp BEFORE the service restart) ──────────────────
# The §24.126 boot tripwire (enforceUpgradeTripwire in src/index.ts) refuses to
# start unless data/upgrade-state.json records the running code version. This
# automated deploy IS a sanctioned upgrade path, so stamp the marker now — the
# next step (--step service) rebuilds dist and restarts, and the guarded process
# must find a fresh, matching marker or it exits(1). Idempotent: re-stamps the
# current version every deploy. (Placed before --step service so a failure here
# leaves the old process running — the service isn't restarted until step 6.)
say "5.5 upgrade marker (stamp)"
pnpm exec tsx scripts/upgrade-state.ts set bootstrap

# ─── 6. service (build dist + install user-systemd unit + start) ────────────
# --step service runs `pnpm run build`, writes the path-derived unit
# (nanoclaw-v2-<slug>.service), enables linger, and restarts. Survives SSH
# logout + reboot.
say "6/6 service (--step service)"
pnpm exec tsx setup/index.ts --step service

# Host process env: the unit setup/service.ts generates sets only HOME/PATH — it
# does NOT load .env. So host-side code that reads process.env gets nothing: the
# Portkey analytics panel (portkey-analytics.ts), the host-side recruiter-sim's
# LLM calls (9.3 — a host cron, not a container agent), and the Telegram
# channel's token all need it. Add a user-unit drop-in that loads .env. SAFE for
# container isolation: container env is an explicit -e allowlist built in
# container-runner.ts (never the host process.env), so agents still never see a
# raw key — this only widens the HOST process's own env.
say "6b/6 host env drop-in (EnvironmentFile=.env)"
unit="nanoclaw-v2-$(node -e 'process.stdout.write(require("crypto").createHash("sha1").update(process.cwd()).digest("hex").slice(0,8))')"
dropin_dir="$HOME/.config/systemd/user/${unit}.service.d"
mkdir -p "$dropin_dir"
cat > "$dropin_dir/cp-env.conf" <<EOF
[Service]
EnvironmentFile=$PROJECT_ROOT/.env
EOF
echo "  wrote $dropin_dir/cp-env.conf"
systemctl --user daemon-reload
systemctl --user restart "${unit}.service"

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
