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
  "${DATA_DIR}/caddy" \
  "${DATA_DIR}/home"

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

# ── Admin's home dir — persistence across container rebuilds ────────────────
# The admin has shell access to the container via the web console. Anything
# they install into these dirs (Claude Code auto-updates, `bun install -g`,
# `pip install --user`, conversation history, custom shell scripts) should
# survive a redeploy. We persist a curated set of home-dir subtrees on
# /data/home and let the rest of /root stay container-local.
#
# Note: apt-installed packages (/etc, /usr, /var) are NOT persisted — for
# those, add a /data/bootstrap.sh and have the admin invoke it from the
# console on fresh containers.

persist_home() {
  local name="$1"                            # ".local", ".claude", ...
  local src="/root/${name}"
  local dst="${DATA_DIR}/home/${name}"

  # Already a correctly-pointed symlink? Nothing to do.
  if [ -L "$src" ] && [ "$(readlink "$src")" = "$dst" ]; then
    return
  fi

  # First boot for this name: seed /data with the baked content, then replace
  # the in-container copy with a symlink.
  if [ ! -e "$dst" ] && [ -e "$src" ] && [ ! -L "$src" ]; then
    cp -a "$src" "$dst"
    log "seeded /root/${name} → /data/home/${name}"
  else
    mkdir -p "$dst"
  fi
  rm -rf "$src"
  ln -s "$dst" "$src"
}

persist_home ".local"        # Claude Code binary + auto-updater state; user ~/.local installs
persist_home ".bun"          # bun installs
persist_home ".claude"       # Claude Code settings + conversation history
persist_home ".npm"          # npm cache (harmless if npm is ever added)
persist_home ".cache"        # generic XDG cache
persist_home ".config"       # generic XDG config
persist_home ".ssh"          # admin's own SSH keys if they want the container to act as a client
persist_home ".bashrc"       # admin owns their shell config from first boot onward
persist_home ".bash_profile"

# Drop a scratch dir pointer so `cd ~/scratch` from the console lands on /data.
[ -e /root/scratch ] || ln -s "${DATA_DIR}/home" /root/scratch

# Convenience: the VPC install lives at ~/.litellm. Inside the container the
# project lives at /app, with mutable subpaths (.env, config.yaml, auth.*.json,
# gateway/gateway.db, plugins/, logs/) already symlinked to /data individually.
# Expose the familiar path so habits + tool defaults (LITELLM_DIR=~/.litellm
# in generated auth-transfer scripts) just work.
[ -e /root/.litellm ] || ln -s "${APP_DIR}" /root/.litellm

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

# ── Admin-defined bootstrap hook ─────────────────────────────────────────────
# apt-installed packages don't survive container replacement (they live in
# /etc and /usr, which aren't on /data). Admins who treat this as a remote
# server can drop a /data/bootstrap.sh that reinstates their customizations
# on every boot — apt installs, env tweaks, systemd overrides, etc.
if [ -x "${DATA_DIR}/bootstrap.sh" ]; then
  log "running /data/bootstrap.sh"
  "${DATA_DIR}/bootstrap.sh" || log "bootstrap.sh exited with code $? (continuing)"
fi

log "/data ready"
