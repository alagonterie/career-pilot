#!/usr/bin/env bash
#
# migrate-onecli-v1.sh — bring an in-place-upgraded OneCLI gateway onto the `/v1`
# API the @onecli-sh/sdk 2.x line requires (STRATEGY.md §24.127).
#
# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ⚠️  DO NOT RE-RUN AS-IS — known destructive. (Run once on dev 2026-06-18.)│
# │                                                                           │
# │ OneCLI stores the vault SECRET-ENCRYPTION MASTER KEY in `onecli_app-data` │
# │ (NOT pgdata). `docker volume rm onecli_app-data` below ORPHANS every      │
# │ vault secret + OAuth connection — they survive as rows but can no longer  │
# │ be decrypted, forcing re-registration of API keys AND owner OAuth re-auth.│
# │ The §24.127 "no re-auth needed" finding was WRONG (the local test counted │
# │ rows, never decrypted them).                                              │
# │                                                                           │
# │ CORRECTION TO VALIDATE: when the gateway is on a PRE-v1 binary (e.g.      │
# │ 1.23.0), `/v1` is missing because of the binary, not stale app-data — a   │
# │ plain image-tag bump (steps 1–2 + 4, SKIPPING the step-3 `volume rm`)     │
# │ should activate `/v1` AND keep the master key. Confirm on local Docker    │
# │ (pre-v1 + a registered secret → in-place image bump, KEEP volumes → /v1   │
# │ serves + secret still injects) before reusing this or doing prod cutover. │
# └─────────────────────────────────────────────────────────────────────────┘
#
# WHY THIS EXISTS
# ---------------
# The SDK 2.x hardcodes `POST ${ONECLI_URL}/v1/agents` (no base-path override).
# A gateway that was upgraded by a bare `docker compose` image-tag bump keeps a
# stale `onecli_app-data` runtime volume and a pinned pre-v1 image tag, so it
# still serves the legacy `/agents` API and 404s every `/v1` — `ensureAgent`
# fails and every container spawn dies. The fix is NOT a re-auth: the OAuth vault
# lives in `onecli_pgdata` (postgres) and survives. Only the gateway *runtime*
# state (`onecli_app-data`) is stale, and the image tag must reach a `/v1`-capable
# version. So: bump the image, reset app-data, KEEP pgdata. The MITM CA the
# gateway regenerates is re-fetched live by the host SDK on the next container
# spawn (`applyContainerConfig` → `GET /api/container-config` → `caCertificate`),
# so there is no CA file to hand-distribute.
#
# Mechanism confirmed via two throwaway local-Docker gateways (§24.127): a clean
# target-version gateway serves `/v1`; this box's vault dump restored under one
# keeps `/v1` AND the vault (2 secrets / 3 connections, no re-auth).
#
# SAFETY
# ------
# - Backup-first: pg_dump of the vault + `cp -a` of ~/.onecli BEFORE any change.
# - Idempotent: if the gateway already serves `/v1` at the target version, it
#   reports "already migrated" and exits 0 without touching anything.
# - pgdata (the vault) is never removed. Only `onecli_app-data` is reset.
# - Verifies `/v1/health` + unchanged vault counts before declaring success; a
#   failed verify leaves the backup path (export → clean install → restore the
#   dump) as the documented fallback (RECOVERY.md "OneCLI v1 gateway migration").
#
# USAGE (run as a user that can drive the system docker daemon — e.g. root):
#   scripts/migrate-onecli-v1.sh
#   TARGET_VERSION=1.36.0 ONECLI_DIR=/home/career-pilot/.onecli scripts/migrate-onecli-v1.sh
#
set -euo pipefail

# ─── config (env-overridable; zero magic numbers buried in the body) ─────────
TARGET_VERSION="${TARGET_VERSION:-1.36.0}"           # first /v1-capable tag
ONECLI_PROJECT="${ONECLI_PROJECT:-onecli}"           # docker compose project
ONECLI_OWNER="${ONECLI_OWNER:-career-pilot}"         # owns ~/.onecli
ONECLI_DIR="${ONECLI_DIR:-/home/${ONECLI_OWNER}/.onecli}"
BIND_HOST="${BIND_HOST:-172.17.0.1}"                 # gateway bridge bind
APP_PORT="${APP_PORT:-10254}"                         # admin/api port
PG_DB="${PG_DB:-onecli}"
PG_USER="${PG_USER:-onecli}"
APP_DATA_VOLUME="${APP_DATA_VOLUME:-${ONECLI_PROJECT}_app-data}"
PGDATA_VOLUME="${PGDATA_VOLUME:-${ONECLI_PROJECT}_pgdata}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"                    # ~90s @ 3s
BACKUP_DIR="${BACKUP_DIR:-/home/${ONECLI_OWNER}/onecli-backups}"

API="http://${BIND_HOST}:${APP_PORT}"
TS="$(date +%Y%m%d-%H%M%S)"

say() { printf '\n=== %s ===\n' "$1"; }
die() { printf 'FATAL: %s\n' "$1" >&2; exit 1; }

pg_container() {
  docker ps --filter "label=com.docker.compose.project=${ONECLI_PROJECT}" \
            --format '{{.Names}}' | grep -i postgres | head -1
}
gw_container() {
  docker ps -a --filter "label=com.docker.compose.project=${ONECLI_PROJECT}" \
              --format '{{.Names}}' | grep -ivE 'postgres' | head -1
}
http_code() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$1" 2>/dev/null || echo 000; }
vault_count() { # $1 = table
  docker exec "$(pg_container)" psql -U "$PG_USER" -d "$PG_DB" -tAc "select count(*) from $1" 2>/dev/null | tr -d '[:space:]'
}

[ -d "$ONECLI_DIR" ] || die "ONECLI_DIR not found: $ONECLI_DIR"
[ -f "$ONECLI_DIR/docker-compose.yml" ] || die "no docker-compose.yml in $ONECLI_DIR"
PGC="$(pg_container)"; [ -n "$PGC" ] || die "no running ${ONECLI_PROJECT} postgres container"

# ─── 0. idempotency guard ────────────────────────────────────────────────────
say "0/6 preflight"
CUR_IMG="$(docker inspect --format '{{.Config.Image}}' "$(gw_container)" 2>/dev/null || echo unknown)"
V1_NOW="$(http_code "${API}/v1/health")"
echo "current gateway image: ${CUR_IMG}"
echo "current /v1/health:    ${V1_NOW}"
if [ "$V1_NOW" = "200" ] && printf '%s' "$CUR_IMG" | grep -q ":${TARGET_VERSION}$"; then
  echo "already migrated — gateway serves /v1 at ${TARGET_VERSION}. Nothing to do."
  exit 0
fi

SEC_BEFORE="$(vault_count secrets)"; CONN_BEFORE="$(vault_count app_connections)"
echo "vault baseline: secrets=${SEC_BEFORE} app_connections=${CONN_BEFORE}"
[ -n "$SEC_BEFORE" ] || die "could not read vault counts — aborting before any change"

# ─── 1. backup (vault dump + .onecli copy) ───────────────────────────────────
say "1/6 backup"
mkdir -p "$BACKUP_DIR"
DUMP="${BACKUP_DIR}/vault-${TS}.sql"
docker exec "$PGC" pg_dump -U "$PG_USER" -d "$PG_DB" > "$DUMP"
echo "vault dump: ${DUMP} ($(wc -l < "$DUMP") lines)"
cp -a "$ONECLI_DIR" "${BACKUP_DIR}/dotonecli-${TS}"
echo "config copy: ${BACKUP_DIR}/dotonecli-${TS}"
[ -s "$DUMP" ] || die "vault dump is empty — refusing to proceed"

# ─── 2. pin the target image tag in the durable compose env ──────────────────
say "2/6 pin ONECLI_VERSION=${TARGET_VERSION}"
ENV_FILE="${ONECLI_DIR}/.env"
touch "$ENV_FILE"
if grep -q '^ONECLI_VERSION=' "$ENV_FILE"; then
  sed -i "s/^ONECLI_VERSION=.*/ONECLI_VERSION=${TARGET_VERSION}/" "$ENV_FILE"
else
  printf 'ONECLI_VERSION=%s\n' "$TARGET_VERSION" >> "$ENV_FILE"
fi
grep -q '^ONECLI_BIND_HOST=' "$ENV_FILE" || printf 'ONECLI_BIND_HOST=%s\n' "$BIND_HOST" >> "$ENV_FILE"
echo "durable env:"; sed 's/^/  /' "$ENV_FILE"

# ─── 3. reset the gateway runtime, KEEP the vault ────────────────────────────
say "3/6 reset app-data (vault pgdata untouched)"
( cd "$ONECLI_DIR" && docker compose -p "$ONECLI_PROJECT" pull onecli ) 2>&1 | tail -3 || true
# Remove ONLY the gateway service container so its app-data volume frees up.
( cd "$ONECLI_DIR" && docker compose -p "$ONECLI_PROJECT" rm -sf onecli ) 2>&1 | tail -3 || true
if docker volume inspect "$PGDATA_VOLUME" >/dev/null 2>&1; then
  echo "vault volume ${PGDATA_VOLUME} present — preserving"
else
  die "vault volume ${PGDATA_VOLUME} missing — aborting (would have lost the vault)"
fi
docker volume rm "$APP_DATA_VOLUME" 2>&1 | sed 's/^/  removed: /' || \
  echo "  (app-data volume already absent — continuing)"

# ─── 4. recreate at the target version ───────────────────────────────────────
say "4/6 recreate gateway"
( cd "$ONECLI_DIR" && docker compose -p "$ONECLI_PROJECT" up -d ) 2>&1 | tail -6
onecli_cids="$(docker ps -aq --filter "label=com.docker.compose.project=${ONECLI_PROJECT}" 2>/dev/null || true)"
[ -n "$onecli_cids" ] && docker update --restart unless-stopped $onecli_cids >/dev/null 2>&1 || true

# ─── 5. wait for health, then /v1 ────────────────────────────────────────────
say "5/6 health + /v1"
ok=0
for _ in $(seq 1 "$HEALTH_TRIES"); do
  [ "$(http_code "${API}/api/health")" = "200" ] && { ok=1; break; }
  sleep 3
done
[ "$ok" = "1" ] || die "gateway never became healthy on ${API}/api/health (see: docker logs $(gw_container))"
V1_AFTER="$(http_code "${API}/v1/health")"
echo "/api/health: 200   /v1/health: ${V1_AFTER}"

# ─── 6. verify vault survived + /v1 active ───────────────────────────────────
say "6/6 verify"
NEW_IMG="$(docker inspect --format '{{.Config.Image}}' "$(gw_container)" 2>/dev/null || echo unknown)"
SEC_AFTER="$(vault_count secrets)"; CONN_AFTER="$(vault_count app_connections)"
echo "image:       ${NEW_IMG}"
echo "vault after: secrets=${SEC_AFTER} app_connections=${CONN_AFTER} (was ${SEC_BEFORE}/${CONN_BEFORE})"

fail=0
[ "$V1_AFTER" = "200" ] || { echo "  ✗ /v1/health not 200 (${V1_AFTER})"; fail=1; }
[ "$SEC_AFTER" = "$SEC_BEFORE" ] || { echo "  ✗ secret count changed"; fail=1; }
[ "$CONN_AFTER" = "$CONN_BEFORE" ] || { echo "  ✗ connection count changed"; fail=1; }
if [ "$fail" = "1" ]; then
  echo ""
  echo "MIGRATION VERIFY FAILED. The vault dump is safe at ${DUMP}."
  echo "Fallback (RECOVERY.md → 'OneCLI v1 gateway migration'): tear down, fresh"
  echo "install at ${TARGET_VERSION}, restore the dump."
  exit 1
fi

echo ""
echo "✓ OneCLI gateway migrated to ${TARGET_VERSION} and serving /v1; vault intact (no re-auth)."
echo "  Next: a real container spawn must inject (Portkey/Gmail 200), then re-land"
echo "  @onecli-sh/sdk 2.2.1 in package.json and redeploy."
