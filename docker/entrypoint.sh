#!/usr/bin/env bash
# Seeds the /data volume on first boot and symlinks mutable paths from
# /app → /data. Idempotent — runs once via the s6 `init-data` oneshot,
# but re-invoking it never overwrites existing files on /data.

set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*"; }

DATA_DIR="${GATEWAY_DATA_DIR:-/data}"
APP_DIR="/app"

mkdir -p \
  "${DATA_DIR}" \
  "${DATA_DIR}/gateway" \
  "${DATA_DIR}/plugins" \
  "${DATA_DIR}/logs" \
  "${DATA_DIR}/caddy"

# ── Seed missing files from image defaults ───────────────────────────────────

seed() {
  local src="$1" dst="$2"
  [ -e "$dst" ] && return
  [ -e "$src" ] || { log "seed source missing: $src (skipping)"; return; }
  cp -a "$src" "$dst"
  log "seeded $(basename "$dst") from image defaults"
}

seed "${APP_DIR}/.env.example" "${DATA_DIR}/.env"

# Default Caddyfile: plain HTTP reverse proxy on :80 + :443-redirect.
# Admin replaces this via the web console once a domain is pointed at the host.
if [ ! -f "${DATA_DIR}/Caddyfile" ]; then
  cat > "${DATA_DIR}/Caddyfile" <<'CADDY'
# Default Caddyfile — proxies all hosts on :80 to the gateway.
#
# To enable HTTPS on a real domain, replace the `:80` block with:
#
#     your.domain.com {
#       reverse_proxy localhost:14041
#     }
#
# Caddy will obtain an ACME certificate automatically. Then reload:
#     caddy reload --config /data/Caddyfile --adapter caddyfile

:80 {
  reverse_proxy localhost:14041
}
CADDY
  log "seeded default Caddyfile"
fi

# Seed bundled plugins on first boot only.
if [ -z "$(ls -A "${DATA_DIR}/plugins" 2>/dev/null)" ] && [ -d "${APP_DIR}/plugins" ]; then
  cp -a "${APP_DIR}/plugins/." "${DATA_DIR}/plugins/"
  log "seeded plugins directory"
fi

# ── Symlink /app paths → /data ───────────────────────────────────────────────

link() {
  local src="$1" dst="$2"
  if [ -L "$src" ]; then
    [ "$(readlink "$src")" != "$dst" ] && { rm -f "$src"; ln -s "$dst" "$src"; }
    return
  fi
  if [ -e "$src" ]; then
    [ -e "$dst" ] || cp -a "$src" "$dst"
    rm -rf "$src"
  fi
  ln -s "$dst" "$src"
}

link "${APP_DIR}/.env"                   "${DATA_DIR}/.env"
link "${APP_DIR}/config.yaml"            "${DATA_DIR}/config.yaml"
link "${APP_DIR}/logs"                   "${DATA_DIR}/logs"
link "${APP_DIR}/plugins"                "${DATA_DIR}/plugins"
link "${APP_DIR}/gateway/gateway.db"     "${DATA_DIR}/gateway/gateway.db"
link "${APP_DIR}/gateway/gateway.db-shm" "${DATA_DIR}/gateway/gateway.db-shm"
link "${APP_DIR}/gateway/gateway.db-wal" "${DATA_DIR}/gateway/gateway.db-wal"

# Claude Code state (conversations, projects, OAuth if the admin links one).
# Seeded from the image's /root/.claude on first boot so settings.json survives.
if [ ! -d "${DATA_DIR}/claude" ]; then
  if [ -d /root/.claude ]; then cp -a /root/.claude "${DATA_DIR}/claude"; else mkdir -p "${DATA_DIR}/claude"; fi
  log "seeded Claude Code state"
fi
link /root/.claude "${DATA_DIR}/claude"

shopt -s nullglob
for f in "${DATA_DIR}"/auth.*.json; do
  link "${APP_DIR}/$(basename "$f")" "$f"
done
shopt -u nullglob

# ── Misc seeds ───────────────────────────────────────────────────────────────

[ -f "${APP_DIR}/.proxy-port" ] || echo "4040" > "${APP_DIR}/.proxy-port"

if ! grep -q "^GATEWAY_SESSION_SECRET=.\+" "${DATA_DIR}/.env" 2>/dev/null; then
  secret="$(head -c 48 /dev/urandom | base64 | tr -d '=+/' | head -c 48)"
  if grep -q "^GATEWAY_SESSION_SECRET=" "${DATA_DIR}/.env" 2>/dev/null; then
    sed -i "s|^GATEWAY_SESSION_SECRET=.*|GATEWAY_SESSION_SECRET=${secret}|" "${DATA_DIR}/.env"
  else
    printf '\nGATEWAY_SESSION_SECRET=%s\n' "${secret}" >> "${DATA_DIR}/.env"
  fi
  log "generated GATEWAY_SESSION_SECRET"
fi

log "/data ready"
