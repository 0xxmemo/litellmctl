#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  litellmctl installer — one entry point for laptop, VPC, and the EC2
#  pipeline. Backward-compatible with the original "just run it" usage.
#
#  Laptop / VPC:
#    curl -fsSL https://raw.githubusercontent.com/0xxmemo/litellmctl/main/install.sh | bash
#
#  Pipeline (EC2 AL2023, run by user-data or the deploy workflow's SSM step):
#    bash install.sh --pipeline
#
#  Individual pipeline flags (mix and match for custom flows):
#    --with-swap[=SIZE]     fallocate a SIZE-GB /swapfile (default 32)
#    --with-caddy           Caddy static binary + systemd unit
#                           (Caddyfile is domain-aware: if APP_DOMAIN is set
#                            in .env, the default template proxies that
#                            hostname over HTTPS; otherwise plain :80.)
#    --with-bun             Bun runtime (curl | bash installer)
#    --with-claude          Claude Code CLI (native binary)
#    --with-node-gyp        nodejs + npm + node-gyp (for native addons)
#    --with-gateway         `litellmctl install --with-gateway`
#    --with-protonmail      `litellmctl install --with-protonmail` + auto-auth
#    --with-embedding       Ollama + nomic-embed-text-v2-moe model (detached)
#    --with-transcription   uv + speaches faster-whisper server (detached)
#    --with-searxng         Docker + SearXNG container (detached; implies --with-docker)
#    --with-docker          dnf install docker + enable service + add APP_USER to group
#                           (Embedding/transcription/searxng detach into the
#                            litellm-install-extras.service systemd unit in
#                            --pipeline mode to avoid SSM IPC timeout on the
#                            multi-GB model downloads — follow with
#                            `journalctl -u litellm-install-extras.service -f`.)
#    --start-services       systemd start proxy + gateway + protonmail
#    --fingerprint          Skip ALL steps on re-run if HEAD + .env + this
#                           script are unchanged and services are healthy
#    --app-user=NAME        Drop privileges to NAME when running as root
#                           (default: ec2-user for pipeline mode, current user otherwise)
#
#  Safe to re-run. macOS and Debian/Ubuntu work without pipeline flags;
#  --pipeline and most Linux-only flags require Amazon Linux 2023.
# ---------------------------------------------------------------------------
set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/0xxmemo/litellmctl.git"
# HOME may be unset when SSM / systemd invokes this as root; fall back to
# /root. The resolve-to-app-user block below fixes INSTALL_DIR when we're
# running as root for a different target user.
INSTALL_DIR="${LITELLM_DIR:-${HOME:-/root}/.litellm}"
VENV_DIR="$INSTALL_DIR/venv"

WITH_SWAP=0;      SWAP_SIZE_GB=32
WITH_CADDY=0;     CADDY_VERSION=2.8.4
SQLITE_VEC_VERSION=0.1.9
WITH_BUN=0
WITH_CLAUDE=0
WITH_NODE_GYP=0
WITH_GATEWAY=0
WITH_PROTONMAIL=0
WITH_EMBEDDING=0
WITH_TRANSCRIPTION=0
WITH_SEARXNG=0
WITH_DOCKER=0
START_SERVICES=0
USE_FINGERPRINT=0
APP_USER=""

# ── Helpers ────────────────────────────────────────────────────────────────

info()  { printf "\033[1;34m==> %s\033[0m\n" "$*"; }
warn()  { printf "\033[1;33m==> %s\033[0m\n" "$*"; }
error() { printf "\033[1;31m==> %s\033[0m\n" "$*" >&2; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
skip()  { printf "  \033[33m-\033[0m %s\n" "$*"; }

print_help() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

# ── CLI flag parsing ────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --pipeline)
      WITH_SWAP=1; WITH_CADDY=1
      WITH_BUN=1; WITH_CLAUDE=1; WITH_NODE_GYP=1
      WITH_GATEWAY=1
      # ProtonMail/hydroxide is disabled by default — Resend (HTTP API) is now
      # the email provider. Pass --with-protonmail explicitly to opt in.
      WITH_EMBEDDING=1; WITH_TRANSCRIPTION=1; WITH_SEARXNG=1; WITH_DOCKER=1
      START_SERVICES=1; USE_FINGERPRINT=1
      APP_USER="${APP_USER:-ec2-user}"
      ;;
    --with-swap)          WITH_SWAP=1 ;;
    --with-swap=*)        WITH_SWAP=1; SWAP_SIZE_GB="${1#*=}" ;;
    --with-caddy)         WITH_CADDY=1 ;;
    --with-bun)            WITH_BUN=1 ;;
    --with-claude)         WITH_CLAUDE=1 ;;
    --with-node-gyp)       WITH_NODE_GYP=1 ;;
    --with-gateway)        WITH_GATEWAY=1 ;;
    --with-protonmail)     WITH_PROTONMAIL=1 ;;
    --with-embedding)      WITH_EMBEDDING=1 ;;
    --with-transcription)  WITH_TRANSCRIPTION=1 ;;
    --with-searxng)        WITH_SEARXNG=1; WITH_DOCKER=1 ;;
    --with-docker)         WITH_DOCKER=1 ;;
    --start-services)     START_SERVICES=1 ;;
    --fingerprint)        USE_FINGERPRINT=1 ;;
    --app-user=*)         APP_USER="${1#*=}" ;;
    -h|--help)            print_help; exit 0 ;;
    *) error "unknown flag: $1  (see: bash install.sh --help)"; exit 2 ;;
  esac
  shift
done

: "${APP_USER:=$(id -un)}"

# When running as root (pipeline mode), INSTALL_DIR should be the app user's
# home directory, not root's. Resolve it from the target user.
if [ "$(id -u)" -eq 0 ] && [ -z "${LITELLM_DIR:-}" ] && [ "$APP_USER" != "root" ]; then
  INSTALL_DIR="$(getent passwd "$APP_USER" | cut -d: -f6)/.litellm"
  VENV_DIR="$INSTALL_DIR/venv"
fi

# Handy invocation helper — runs a command as the app user when we're root,
# otherwise runs directly.
as_user() {
  if [ "$(id -u)" -eq 0 ] && [ "$APP_USER" != "root" ]; then
    sudo -u "$APP_USER" -H bash -lc "$*"
  else
    bash -lc "$*"
  fi
}

normalize_submodule_ref() {
  local dir="$1"
  [ -d "$dir/.git" ] || [ -f "$dir/.git" ] || return 0

  local head_sha main_sha current_branch
  head_sha=$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)
  [ -n "$head_sha" ] || return 0

  git -C "$dir" fetch --quiet origin main || true
  main_sha=$(git -C "$dir" rev-parse origin/main 2>/dev/null || true)
  [ -n "$main_sha" ] || main_sha=$(git -C "$dir" rev-parse main 2>/dev/null || true)
  [ -n "$main_sha" ] || return 0

  if [ "$head_sha" = "$main_sha" ]; then
    current_branch="$(git -C "$dir" symbolic-ref -q --short HEAD 2>/dev/null || true)"
    if [ "$current_branch" != "main" ]; then
      if git -C "$dir" show-ref --verify --quiet refs/heads/main; then
        git -C "$dir" checkout -q main
      else
        git -C "$dir" checkout -q -b main origin/main
      fi
      ok "Submodule aligned to branch main (matches origin/main)"
    fi
  else
    info "Submodule pinned to commit $head_sha (does not match origin/main)"
  fi
}

# ── 1. Prerequisites ──────────────────────────────────────────────────────

info "litellmctl installer"
echo ""

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macOS" ;;
  Linux)  PLATFORM="Linux" ;;
  *)      error "Unsupported platform: $OS"; exit 1 ;;
esac

PM="none"
if [ "$PLATFORM" = "Linux" ]; then
  if command -v dnf &>/dev/null;  then PM="dnf"
  elif command -v apt-get &>/dev/null; then PM="apt"
  fi
fi

echo "  Platform: $PLATFORM ($(uname -m)) [$PM]"
echo "  App user: $APP_USER"
echo "  Install:  $INSTALL_DIR"
echo ""

# ── 2. Fingerprint fast-exit (pipeline re-runs) ───────────────────────────
# Skip every step when HEAD, .env, and this very script are unchanged
# since the last successful run AND the services are healthy. Any of
# those three changing invalidates the cache and forces a full run.

FINGERPRINT_FILE=/var/lib/litellm-install.fingerprint

compute_fingerprint() {
  local sha env_hash script_hash auth_hash
  sha="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || echo none)"
  env_hash="$(md5sum "$INSTALL_DIR/.env" 2>/dev/null | awk '{print $1}')"
  script_hash="$(md5sum "$0" 2>/dev/null | awk '{print $1}')"
  # auth.*.json files (ChatGPT/Gemini/Kimi/Qwen OAuth tokens) live next to
  # config.yaml. They're .gitignore'd and can appear *after* first-boot
  # install.sh runs — e.g. when an operator rsyncs them from an orphan
  # data volume during a single-volume migration, or drops them in by hand
  # from a laptop. Hashing them into the fingerprint means such a drop
  # invalidates the cache on the next pipeline run, forcing `litellmctl
  # init-env` to re-scan and add the CHATGPT_TOKEN_DIR / *_AUTH_FILE vars
  # to .env (without those, the ChatGPT/Gemini/Kimi/Qwen providers fail
  # at load-time and their models silently vanish from /v1/models).
  # Includes mtime + size so regenerated-same-contents tokens still flip.
  auth_hash="$(find "$INSTALL_DIR" -maxdepth 1 -name 'auth.*.json' -printf '%f:%s:%T@\n' 2>/dev/null \
              | sort | md5sum | awk '{print $1}')"
  echo "${sha}:${env_hash}:${script_hash}:${auth_hash}"
}

services_healthy() {
  [ "$START_SERVICES" = 1 ] || return 0
  as_user "cd '$INSTALL_DIR' && ./bin/litellmctl status proxy 2>/dev/null | grep -q running"   || return 1
  as_user "cd '$INSTALL_DIR' && ./bin/litellmctl status gateway 2>/dev/null | grep -q running" || return 1
  if [ "$WITH_CADDY" = 1 ]; then
    systemctl is-active caddy.service >/dev/null 2>&1 || return 1
  fi
  return 0
}

if [ "$USE_FINGERPRINT" = 1 ] && [ -d "$INSTALL_DIR/.git" ] && [ -f "$INSTALL_DIR/.env" ]; then
  CURRENT_PRINT="$(compute_fingerprint)"
  if [ -f "$FINGERPRINT_FILE" ] && [ "$(cat "$FINGERPRINT_FILE" 2>/dev/null || true)" = "$CURRENT_PRINT" ] && services_healthy; then
    ok "fingerprint unchanged (${CURRENT_PRINT%%:*}), services healthy — skipping all steps"
    date -u +%FT%TZ > /var/log/user-data-done 2>/dev/null || true
    exit 0
  fi
  info "fingerprint changed or services unhealthy — running full install"
fi

# ── 3. System packages ────────────────────────────────────────────────────

if ! command -v git &>/dev/null; then
  error "git is required."
  case "$PM" in
    apt) echo "  Install with: sudo apt install git" ;;
    dnf) echo "  Install with: sudo dnf install -y git" ;;
    none) [ "$PLATFORM" = "macOS" ] && echo "  Install with: xcode-select --install" ;;
  esac
  exit 1
fi

# Minimum Python version. Upstream litellm now uses `match` statements and
# PEP 604 (`X | Y`) unions; both are 3.10+ only. Stays in sync with
# bin/install.
PY_MIN_MAJOR=3
PY_MIN_MINOR=10

py_version_ge_min() {
  "$1" -c "import sys; print(sys.version_info[:2] >= ($PY_MIN_MAJOR,$PY_MIN_MINOR))" 2>/dev/null || echo "False"
}

py_short_version() {
  "$1" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true
}

detect_python() {
  for cmd in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command -v "$cmd" &>/dev/null; then
      if [ "$(py_version_ge_min "$cmd")" = "True" ]; then
        echo "$cmd"
        return
      fi
    fi
  done
  return 1
}

# Try once now — we may need to install python3.12 below before we succeed.
PYTHON="$(detect_python || true)"

# Linux-only prereqs install (apt / dnf). Done BEFORE the final python
# detection so we can install python3.12 here when AL2023's stock 3.9 is
# the only thing on PATH.
if [ "$PLATFORM" = "Linux" ]; then
  case "$PM" in
    apt)
      # Debian/Ubuntu: install python3.12 explicitly when current python is
      # too old. Comes from main on Ubuntu 24.04+, deadsnakes on older.
      if [ -z "$PYTHON" ]; then
        info "Installing python3.12 (apt) ..."
        if sudo apt-get update -qq && sudo apt-get install -y -qq python3.12 python3.12-venv 2>/dev/null; then
          :
        else
          warn "python3.12 unavailable in default apt sources — trying deadsnakes PPA"
          sudo apt-get install -y -qq software-properties-common
          sudo add-apt-repository -y ppa:deadsnakes/ppa
          sudo apt-get update -qq && sudo apt-get install -y -qq python3.12 python3.12-venv
        fi
      fi
      # If PYTHON is set but venv/pip stdlib bits are missing, fix that up.
      if [ -n "$PYTHON" ]; then
        if ! $PYTHON -c "import venv"      2>/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv; fi
        if ! $PYTHON -c "import ensurepip" 2>/dev/null; then sudo apt-get update -qq && sudo apt-get install -y -qq python3-pip;  fi
      fi
      ;;
    dnf)
      # AL2023 ships python3 (3.9). Upstream litellm needs 3.10+, and
      # python3.12 is in the AL2023 default repos.
      if [ "$USE_FINGERPRINT" = 1 ] || [ "$WITH_GATEWAY" = 1 ] || [ "$WITH_NODE_GYP" = 1 ] || [ -z "$PYTHON" ]; then
        sudo dnf install -y --allowerasing \
          git jq unzip \
          python3.12 python3.12-pip python3.12-devel \
          python3-pip python3-devel \
          gcc gcc-c++ make \
          sqlite sqlite-devel \
          golang
      fi
      ;;
  esac
fi

# Re-detect after package install so we pick up newly-installed python3.12.
PYTHON="$(detect_python || true)"
if [ -z "$PYTHON" ]; then
  error "Python ${PY_MIN_MAJOR}.${PY_MIN_MINOR}+ not found and could not be installed."
  case "$PM" in
    apt)  echo "  Try: sudo apt install python3.12 python3.12-venv" ;;
    dnf)  echo "  Try: sudo dnf install -y python3.12 python3.12-pip" ;;
    none) [ "$PLATFORM" = "macOS" ] && echo "  Try: brew install python@3.12" ;;
  esac
  exit 1
fi
ok "Python: $($PYTHON --version 2>&1) ($PYTHON)"

# ── 4. Clone or update repo ───────────────────────────────────────────────

clone_into_dir() {
  local dir="$1" branch="${GITHUB_BRANCH:-main}"
  # mkfs.ext4 leaves a lost+found behind; wipe anything non-git so the
  # clone doesn't fail with "destination not empty".
  find "$dir" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  as_user "git clone --branch '$branch' '$REPO_URL' '$dir'"
}

if [ -d "$INSTALL_DIR" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Existing installation found — updating ..."
    as_user "git -C '$INSTALL_DIR' pull --ff-only 2>/dev/null" && ok "Pulled latest" \
      || warn "Could not fast-forward (local changes?). Continuing with current version."
  else
    info "$INSTALL_DIR exists without .git — cloning into it"
    clone_into_dir "$INSTALL_DIR"
  fi
else
  info "Cloning litellmctl ..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  as_user "git clone '$REPO_URL' '$INSTALL_DIR'"
  ok "Cloned to $INSTALL_DIR"
fi

# Ensure the app user owns the install dir (pipeline mode runs as root)
if [ "$(id -u)" -eq 0 ] && [ "$APP_USER" != "root" ]; then
  chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
fi

# Wire repo-tracked git hooks (.githooks/) so post-checkout / post-merge /
# post-rewrite auto-prune the litellm submodule on every git operation.
# Idempotent.
if [ -d "$INSTALL_DIR/.githooks" ]; then
  current_hooks="$(as_user "git -C '$INSTALL_DIR' config --get core.hooksPath 2>/dev/null || true")"
  if [ "$current_hooks" != ".githooks" ]; then
    as_user "git -C '$INSTALL_DIR' config core.hooksPath .githooks"
    ok "Configured git hooks path → .githooks"
  fi
fi

# ── 5. Initialize submodule ───────────────────────────────────────────────

SUBMODULE_DIR="$INSTALL_DIR/litellm"
if [ ! -f "$SUBMODULE_DIR/pyproject.toml" ]; then
  info "Initializing litellm submodule ..."
  as_user "git -C '$INSTALL_DIR' submodule update --init --depth 1 litellm"
  normalize_submodule_ref "$SUBMODULE_DIR"
  ok "Submodule ready"
else
  normalize_submodule_ref "$SUBMODULE_DIR"
  ok "Submodule already initialized"
fi

# Prune the submodule (strip docs/UI/CI bloat). Hooks handle the
# steady-state case; this catches first-run installs and any path that
# bypasses a hook (manual sync, --depth 1 init, etc).
if [ -x "$INSTALL_DIR/bin/litellm-prune" ] && [ -d "$SUBMODULE_DIR" ]; then
  as_user "'$INSTALL_DIR/bin/litellm-prune'" || warn "Pruner failed (non-fatal)"
fi

# ── 6. Python virtualenv ─────────────────────────────────────────────────
#
# Rebuild triggers (in priority order):
#   1. LITELLM_REINSTALL_VENV=1  — explicit override
#   2. venv exists but uses a Python older than $PY_MIN_MAJOR.$PY_MIN_MINOR
#      (e.g. left over from a 3.9 install before the upstream merge that
#      introduced `match` syntax)
#   3. venv exists but its Python X.Y differs from the chosen interpreter's
#      X.Y (system upgrade — old venv's stdlib still points at gone interpreter)

PY_NEW_VER="$(py_short_version "$PYTHON")"
VENV_VER=""
if [ -x "$VENV_DIR/bin/python" ]; then
  VENV_VER="$(py_short_version "$VENV_DIR/bin/python")"
fi
need_rebuild=0
rebuild_reason=""

if [ "${LITELLM_REINSTALL_VENV:-}" = "1" ]; then
  need_rebuild=1
  rebuild_reason="LITELLM_REINSTALL_VENV=1"
elif [ -n "$VENV_VER" ]; then
  if ! "$VENV_DIR/bin/python" -c "import sys; sys.exit(0 if sys.version_info[:2] >= ($PY_MIN_MAJOR,$PY_MIN_MINOR) else 1)" 2>/dev/null; then
    need_rebuild=1
    rebuild_reason="venv Python $VENV_VER < required $PY_MIN_MAJOR.$PY_MIN_MINOR"
  elif [ -n "$PY_NEW_VER" ] && [ "$VENV_VER" != "$PY_NEW_VER" ]; then
    need_rebuild=1
    rebuild_reason="venv Python $VENV_VER ≠ system Python $PY_NEW_VER"
  fi
fi

if [ -d "$VENV_DIR" ]; then
  if [ "$need_rebuild" = "1" ]; then
    warn "Rebuilding virtualenv ($rebuild_reason) ..."
    as_user "rm -rf '$VENV_DIR'"
    as_user "$PYTHON -m venv '$VENV_DIR'"
    ok "Virtualenv rebuilt on Python $PY_NEW_VER"
  else
    ok "Existing virtualenv found (Python $VENV_VER) — reusing"
  fi
else
  info "Creating virtualenv (Python $PY_NEW_VER) ..."
  as_user "$PYTHON -m venv '$VENV_DIR'"
  ok "Virtualenv created"
fi

# ── 7. Install litellm fork ──────────────────────────────────────────────

info "Installing litellm[proxy] (editable) ..."
as_user "'$VENV_DIR/bin/pip' install --upgrade pip --quiet 2>/dev/null"
as_user "'$VENV_DIR/bin/pip' install -e '$SUBMODULE_DIR[proxy]' --quiet 2>/dev/null"
ok "litellm installed"

# CLI deps — MUST stay in sync with bin/install (litellmctl install path).
# Root install.sh historically only installed the litellm submodule; users who
# never ran `litellmctl install` ended up with a venv missing questionary/typer/rich.
info "Installing litellmctl CLI dependencies (questionary, typer, rich) ..."
as_user "'$VENV_DIR/bin/pip' install --quiet questionary typer rich" \
  || warn "CLI deps failed — run: $VENV_DIR/bin/pip install questionary typer rich"

info "Installing test dependencies (pytest, optional) ..."
as_user "'$VENV_DIR/bin/pip' install --quiet pytest pytest-timeout" \
  || warn "pytest not installed — bun tests for bin/ may be unavailable"

info "Ensuring prisma (optional, for litellmctl DB migrations) ..."
as_user "'$VENV_DIR/bin/pip' install --quiet prisma" \
  || warn "prisma not installed — DB migrations may be skipped until fixed"

# ── 8. .env + sqlite-vec + shell completions ─────────────────────────────

if [ ! -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/.env.example" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  [ "$(id -u)" -eq 0 ] && chown "$APP_USER:$APP_USER" "$INSTALL_DIR/.env"
  sed -i.bak "s|/path/to/.litellm|$INSTALL_DIR|g" "$INSTALL_DIR/.env" 2>/dev/null || true
  rm -f "$INSTALL_DIR/.env.bak"
  ok "Created .env from template"
fi

if [ -f "$INSTALL_DIR/.env" ] && ! grep -q "^LITELLM_LOCAL_MODEL_COST_MAP=" "$INSTALL_DIR/.env" 2>/dev/null; then
  printf '\nLITELLM_LOCAL_MODEL_COST_MAP=true\n' >> "$INSTALL_DIR/.env"
  ok "Added LITELLM_LOCAL_MODEL_COST_MAP=true to .env"
fi

info "Syncing auth file paths ..."
as_user "'$INSTALL_DIR/bin/litellmctl' init-env 2>/dev/null || true"

mkdir -p "$INSTALL_DIR/gateway"
ok "Gateway SQLite DB dir ready"

# sqlite-vec — required by the gateway for the vectordb endpoints that
# back claude-context and supermemory plugins. The asg017/sqlite-vec brew
# tap was deleted upstream, so we fetch the loadable extension straight
# from GitHub releases on both macOS and Linux. Idempotent: skip if already
# present at one of the paths the gateway probes (see gateway/lib/db.ts).
install_sqlite_vec() {
  local arch ext target archive_arch
  case "$PLATFORM" in
    macOS) ext=dylib ;;
    Linux) ext=so ;;
    *) skip "sqlite-vec: unsupported platform $PLATFORM"; return 0 ;;
  esac

  # Honor existing installs at any path the gateway probes.
  for p in /opt/homebrew/lib/vec0.$ext /usr/local/lib/vec0.$ext /usr/lib/sqlite-vec/vec0.$ext; do
    if [ -f "$p" ]; then
      ok "sqlite-vec already installed ($p)"
      return 0
    fi
  done

  case "$(uname -m)" in
    aarch64|arm64) archive_arch=aarch64 ;;
    x86_64|amd64)  archive_arch=x86_64 ;;
    *) warn "sqlite-vec: unsupported arch $(uname -m) — skipping"; return 0 ;;
  esac

  case "$PLATFORM" in
    macOS) target=/usr/local/lib/vec0.dylib; archive_os=macos ;;
    Linux) target=/usr/local/lib/vec0.so;    archive_os=linux ;;
  esac

  local url="https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/sqlite-vec-${SQLITE_VEC_VERSION}-loadable-${archive_os}-${archive_arch}.tar.gz"
  local tmp; tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  info "Installing sqlite-vec ${SQLITE_VEC_VERSION} (${archive_os}/${archive_arch}) → $target"
  if ! curl -fsSL "$url" | tar -xz -C "$tmp" 2>/dev/null; then
    error "sqlite-vec: download/extract failed from $url"
    return 1
  fi

  local src="$tmp/vec0.$ext"
  if [ ! -f "$src" ]; then
    # Some release archives nest under a folder; fall back to a search.
    src=$(find "$tmp" -maxdepth 3 -name "vec0.$ext" -type f 2>/dev/null | head -n1)
  fi
  if [ -z "$src" ] || [ ! -f "$src" ]; then
    error "sqlite-vec: vec0.$ext not found in archive"
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    install -d /usr/local/lib && install -m 0755 "$src" "$target"
  else
    sudo install -d /usr/local/lib && sudo install -m 0755 "$src" "$target"
  fi || { error "sqlite-vec: failed to install $target (need sudo?)"; return 1; }

  ok "sqlite-vec installed ($target)"
}

if ! install_sqlite_vec; then
  warn "sqlite-vec install failed — gateway vector endpoints (claude-context, supermemory) will return 503 until resolved"
fi

# Shell completions (only when running as the target user, not root)
if [ "$(id -u)" -ne 0 ]; then
  SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
  RC_FILE="$HOME/.bashrc"; [ "$SHELL_NAME" = "zsh" ] && RC_FILE="$HOME/.zshrc"
  if ! grep -qF "alias litellmctl=" "$RC_FILE" 2>/dev/null; then
    if [ "$SHELL_NAME" = "zsh" ]; then
      cat >> "$RC_FILE" <<'SHELL_BLOCK'

# LiteLLM CLI
alias litellmctl="~/.litellm/bin/litellmctl"
eval "$(~/.litellm/bin/litellmctl --zsh-completions)"
SHELL_BLOCK
    else
      cat >> "$RC_FILE" <<'SHELL_BLOCK'

# LiteLLM CLI
alias litellmctl="~/.litellm/bin/litellmctl"
eval "$(~/.litellm/bin/litellmctl --completions)"
SHELL_BLOCK
    fi
    ok "Added litellmctl alias + completions to $RC_FILE"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════
# PIPELINE EXTENSIONS — only run for flags explicitly passed (or --pipeline)
# ═════════════════════════════════════════════════════════════════════════

# ── Pipeline: 32 GB swap file (fallocate is instant on ext4/xfs) ──────────
if [ "$WITH_SWAP" = 1 ] && [ "$PLATFORM" = "Linux" ]; then
  if [ ! -f /swapfile ]; then
    info "Creating ${SWAP_SIZE_GB} GB swap file ..."
    sudo fallocate -l "${SWAP_SIZE_GB}G" /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
    sudo swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    ok "Swap ready ($(free -h | awk '/^Swap:/ {print $2}'))"
  else
    skip "/swapfile already exists"
  fi
fi

# ── Pipeline: Bun runtime ─────────────────────────────────────────────────
if [ "$WITH_BUN" = 1 ]; then
  if as_user "command -v bun >/dev/null"; then
    skip "bun already installed"
  else
    info "Installing Bun ..."
    as_user "curl -fsSL https://bun.sh/install | bash"
    ok "bun installed"
  fi
fi

# ── Pipeline: Claude Code CLI ─────────────────────────────────────────────
if [ "$WITH_CLAUDE" = 1 ]; then
  if as_user "command -v claude >/dev/null"; then
    skip "claude already installed"
  else
    info "Installing Claude Code ..."
    as_user "curl -fsSL https://claude.ai/install.sh | bash"
    ok "claude installed"
  fi

  # Bypass the interactive onboarding flow and wire Claude Code to the
  # local gateway so the admin PTY console drops the user straight into
  # a working `claude` prompt — no theme picker, cost threshold, or
  # trust-dialog walls. Mirrors what /api/setup/claude-code does, but
  # baked into the image instead of requiring a curl|bash after deploy.
  APP_HOME="$(getent passwd "$APP_USER" 2>/dev/null | cut -d: -f6)"
  [ -n "$APP_HOME" ] || APP_HOME="/home/$APP_USER"

  CC_MASTER_KEY=""
  if [ -f "$INSTALL_DIR/.env" ]; then
    CC_MASTER_KEY="$(grep -E '^LITELLM_MASTER_KEY=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')"
  fi

  # On-host claude talks directly to the underlying LiteLLM proxy (port
  # 4040) — NOT the gateway at :14041. The gateway is a consumer-facing
  # layer that validates per-user API keys; the admin console on this
  # box bypasses that layer and authenticates to litellm natively with
  # LITELLM_MASTER_KEY as ANTHROPIC_API_KEY (no AUTH_TOKEN).
  info "Configuring Claude Code (onboarding bypass + direct litellm wiring) ..."
  sudo -u "$APP_USER" -H \
    env _CC_KEY="$CC_MASTER_KEY" _CC_URL="http://127.0.0.1:4040" _CC_HOME="$APP_HOME" \
    bash <<'CLAUDE_CFG'
set -eu
command -v jq >/dev/null || { echo "jq not found — skipping claude config"; exit 0; }
mkdir -p "$_CC_HOME/.claude"

CJ="$_CC_HOME/.claude.json"
[ -f "$CJ" ] || echo '{}' > "$CJ"
tmp=$(mktemp)
jq '
  .hasCompletedOnboarding = true |
  .bypassPermissionsModeAccepted = true |
  .hasAcknowledgedCostThreshold = true |
  .hasSeenTasksHint = true |
  .hasSeenGAAnnounce = true |
  .subscriptionNoticeCount = 9999
' "$CJ" > "$tmp" && mv "$tmp" "$CJ"
chmod 600 "$CJ"

if [ -n "${_CC_KEY:-}" ]; then
  CS="$_CC_HOME/.claude/settings.json"
  [ -f "$CS" ] || echo '{}' > "$CS"
  tmp=$(mktemp)
  # Upsert the direct-litellm env. del() clears any stale
  # ANTHROPIC_AUTH_TOKEN from a prior deploy that wired through the gateway.
  jq --arg key "$_CC_KEY" --arg url "$_CC_URL" '
    .env.ANTHROPIC_BASE_URL = $url |
    .env.ANTHROPIC_API_KEY = $key |
    .env.ANTHROPIC_DEFAULT_OPUS_MODEL = "ultra" |
    .env.ANTHROPIC_DEFAULT_SONNET_MODEL = "plus" |
    .env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "lite" |
    del(.env.ANTHROPIC_AUTH_TOKEN)
  ' "$CS" > "$tmp" && mv "$tmp" "$CS"
  chmod 600 "$CS"
fi
CLAUDE_CFG

  if [ -n "$CC_MASTER_KEY" ]; then
    ok "claude configured (onboarding bypassed, wired directly to litellm on :4040)"
  else
    ok "claude onboarding bypassed (no LITELLM_MASTER_KEY in .env yet — settings.json skipped)"
  fi

  # Drop a --dangerously-skip-permissions alias into the app user's
  # ~/.bashrc so interactive SSM / PTY sessions land on a zero-friction
  # claude prompt (no per-command trust prompts). Idempotent: only
  # appended if no existing `alias claude=` line is already there.
  BASHRC="$APP_HOME/.bashrc"
  sudo -u "$APP_USER" touch "$BASHRC"
  if sudo -u "$APP_USER" grep -qE '^[[:space:]]*alias[[:space:]]+claude=' "$BASHRC"; then
    skip "claude alias already in $BASHRC"
  else
    sudo -u "$APP_USER" tee -a "$BASHRC" >/dev/null <<'BASHRC_CLAUDE_ALIAS'

# Added by litellmctl install.sh: default to dangerously-skip-permissions
# so the admin PTY console doesn't stall on per-command trust prompts.
alias claude="claude --dangerously-skip-permissions"
BASHRC_CLAUDE_ALIAS
    ok "claude alias appended to $BASHRC"
  fi
fi

# ── Pipeline: node-gyp (for the gateway's node-pty native addon) ─────────
if [ "$WITH_NODE_GYP" = 1 ] && [ "$PLATFORM" = "Linux" ]; then
  case "$PM" in
    dnf) sudo dnf install -y --allowerasing nodejs npm ;;
    apt) sudo apt-get install -y -qq nodejs npm ;;
  esac
  if ! command -v node-gyp >/dev/null 2>&1; then
    info "Installing node-gyp globally ..."
    sudo npm install -g node-gyp --silent
    ok "node-gyp installed"
  else
    skip "node-gyp already installed"
  fi
fi

# ── Pipeline: Caddy static binary + systemd unit ──────────────────────────
if [ "$WITH_CADDY" = 1 ] && [ "$PLATFORM" = "Linux" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    info "Installing Caddy ${CADDY_VERSION} ..."
    case "$(uname -m)" in
      aarch64|arm64) CADDY_ARCH=arm64 ;;
      x86_64|amd64)  CADDY_ARCH=amd64 ;;
      *) error "unsupported arch $(uname -m) for Caddy"; exit 1 ;;
    esac
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz" \
      | sudo tar -C /usr/local/bin -xz caddy
    sudo chmod +x /usr/local/bin/caddy
    ok "caddy installed"
  fi

  CADDYFILE="$INSTALL_DIR/Caddyfile"
  # Pull APP_DOMAIN out of .env if present so we can pre-configure TLS
  # without the operator hand-editing Caddyfile. If .env has no APP_DOMAIN
  # (or no .env yet), we fall through to the plaintext :80 default.
  APP_DOMAIN_VAL=""
  if [ -f "$INSTALL_DIR/.env" ]; then
    APP_DOMAIN_VAL="$(sed -nE 's/^APP_DOMAIN=//p' "$INSTALL_DIR/.env" | head -n1 | tr -d '"'"'"' 	\r\n')"
  fi

  if [ ! -f "$CADDYFILE" ]; then
    if [ -n "$APP_DOMAIN_VAL" ]; then
      info "Writing domain-aware Caddyfile for $APP_DOMAIN_VAL"
      sudo -u "$APP_USER" tee "$CADDYFILE" >/dev/null <<CADDY
# Auto-generated by install.sh from APP_DOMAIN=$APP_DOMAIN_VAL in .env.
# Caddy handles Let's Encrypt cert issuance + renewal automatically.
$APP_DOMAIN_VAL {
  encode zstd gzip
  reverse_proxy localhost:14041
}

# Block plaintext on the raw IP / any other host to prevent
# session-cookie bypass via http://<public-ip>/.
:80 {
  @host host $APP_DOMAIN_VAL
  redir @host https://$APP_DOMAIN_VAL{uri} permanent
  respond "$APP_DOMAIN_VAL only" 421
}
CADDY
    else
      info "APP_DOMAIN not set — writing plaintext :80 Caddyfile (set APP_DOMAIN in .env + delete Caddyfile to regenerate with TLS)"
      sudo -u "$APP_USER" tee "$CADDYFILE" >/dev/null <<'CADDY'
# Default Caddyfile — proxies :80 to the gateway until you configure a
# domain. Set APP_DOMAIN=your.domain.com in .env and delete this file
# to have install.sh regenerate a TLS-enabled config on next run.
:80 {
  reverse_proxy localhost:14041
}
CADDY
    fi
  else
    skip "Caddyfile already exists at $CADDYFILE (edit in place; install.sh never overwrites)"
  fi

  sudo tee /etc/systemd/system/caddy.service >/dev/null <<UNIT
[Unit]
Description=Caddy reverse proxy
After=network.target

[Service]
User=$APP_USER
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/caddy run --config $CADDYFILE --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config $CADDYFILE --adapter caddyfile
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now caddy.service
  sudo systemctl reload caddy.service 2>/dev/null || sudo systemctl restart caddy.service
  ok "caddy.service up"
fi

# ── Pipeline: Docker (prereq for SearXNG) ────────────────────────────────
if [ "$WITH_DOCKER" = 1 ] && [ "$PLATFORM" = "Linux" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    info "Installing Docker ..."
    case "$PM" in
      dnf) sudo dnf install -y --allowerasing docker ;;
      apt) sudo apt-get install -y -qq docker.io ;;
      *)   warn "unknown package manager — install Docker manually" ;;
    esac
  else
    skip "docker already installed"
  fi

  if command -v systemctl >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    sudo systemctl enable --now docker 2>/dev/null || warn "could not start docker.service (non-fatal)"
  fi

  # Put APP_USER in the docker group so `docker ps`/`docker run` work without sudo
  # (matches what install_searxng() expects — it shells out to `docker` directly).
  if [ "$APP_USER" != "root" ] && getent group docker >/dev/null 2>&1; then
    if ! id -nG "$APP_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
      sudo usermod -aG docker "$APP_USER" && ok "added $APP_USER to docker group"
    fi
  fi
fi

# ── Pipeline: litellmctl install — FAST step (gateway + protonmail) ───────
# Kept synchronous because the deploy workflow's health check on :14041 needs
# the gateway built + running before the SSM command returns. bun install +
# frontend build takes ~30–60s on a fresh box, fine inside SSM's IPC window.
if [ "$WITH_GATEWAY" = 1 ] || [ "$WITH_PROTONMAIL" = 1 ]; then
  FAST_FLAGS=""
  [ "$WITH_GATEWAY" = 1 ]    && FAST_FLAGS="$FAST_FLAGS --with-gateway"
  [ "$WITH_PROTONMAIL" = 1 ] && FAST_FLAGS="$FAST_FLAGS --with-protonmail"
  info "Running litellmctl install$FAST_FLAGS (synchronous) ..."
  as_user "cd '$INSTALL_DIR' && ./bin/litellmctl install$FAST_FLAGS"
fi

# ── Pipeline: litellmctl install — SLOW step (embedding/transcription/searxng) ──
# These pull multi-GB assets (Ollama nomic-embed-text-v2-moe ≈ 1.2 GB, Whisper
# large-v3-turbo ≈ 1.5 GB, searxng docker image ≈ 200 MB) with very chatty
# progress output. When invoked under SSM's AWS-RunShellScript the spam fills
# the ssm-document-worker's output buffer and/or the downloads outlive SSM's
# ~3 min IPC heartbeat window — SSM then reports:
#     "document process failed unexpectedly: ipc messaging received timeout
#      signal, check [ssm-document-worker]/[ssm-session-worker] log"
# and the deploy job fails even though the core services are healthy. Detach
# into a transient systemd unit so install.sh returns immediately; watch the
# background job with:
#     journalctl -u litellm-install-extras.service -f
if [ "$WITH_EMBEDDING" = 1 ] || [ "$WITH_TRANSCRIPTION" = 1 ] || [ "$WITH_SEARXNG" = 1 ]; then
  SLOW_FLAGS=""
  [ "$WITH_EMBEDDING" = 1 ]     && SLOW_FLAGS="$SLOW_FLAGS --with-embedding"
  [ "$WITH_TRANSCRIPTION" = 1 ] && SLOW_FLAGS="$SLOW_FLAGS --with-transcription"
  [ "$WITH_SEARXNG" = 1 ]       && SLOW_FLAGS="$SLOW_FLAGS --with-searxng"
  SLOW_UNIT="litellm-install-extras.service"

  if command -v systemd-run >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
    # If a previous deploy's detached unit is still running or left behind,
    # stop it first — systemd-run refuses to reuse a busy unit name.
    sudo systemctl stop "$SLOW_UNIT" 2>/dev/null || true
    sudo systemctl reset-failed "$SLOW_UNIT" 2>/dev/null || true

    APP_HOME="$(getent passwd "$APP_USER" 2>/dev/null | cut -d: -f6)"
    [ -n "$APP_HOME" ] || APP_HOME="/home/$APP_USER"

    info "Launching litellmctl install$SLOW_FLAGS as detached $SLOW_UNIT ..."
    sudo systemd-run \
      --unit="$SLOW_UNIT" \
      --description="LiteLLM heavy service installs (embedding/transcription/searxng)" \
      --working-directory="$INSTALL_DIR" \
      --uid="$APP_USER" --gid="$APP_USER" \
      --setenv=HOME="$APP_HOME" \
      --setenv=PATH="$APP_HOME/.local/bin:$APP_HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin" \
      --collect \
      bash -lc "cd '$INSTALL_DIR' && ./bin/litellmctl install$SLOW_FLAGS"
    ok "detached — follow with: sudo journalctl -u $SLOW_UNIT -f"
  else
    # Fallback for macOS / non-root / no-systemd — run inline and hope output
    # is short enough not to wedge the caller.
    warn "systemd-run unavailable — running litellmctl install$SLOW_FLAGS inline (may be slow)"
    if [ "$WITH_SEARXNG" = 1 ] && getent group docker >/dev/null 2>&1 \
         && ! id -nG "$APP_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
      as_user "cd '$INSTALL_DIR' && sg docker -c './bin/litellmctl install$SLOW_FLAGS'"
    else
      as_user "cd '$INSTALL_DIR' && ./bin/litellmctl install$SLOW_FLAGS"
    fi
  fi
fi

# ── Pipeline: hydroxide (ProtonMail) auto-auth ───────────────────────────
# Install itself happens above via the bundled `litellmctl install` call.
# Auto-auth runs separately because it needs .env creds already written.
if [ "$WITH_PROTONMAIL" = 1 ]; then
  if as_user "grep -q '^GATEWAY_PROTON_PASSWORD=.' '$INSTALL_DIR/.env' 2>/dev/null"; then
    info "Auto-authenticating hydroxide from .env creds ..."
    as_user "cd '$INSTALL_DIR' && ./bin/litellmctl auth protonmail" || warn "hydroxide auto-auth returned non-zero (non-fatal)"
  fi
fi

# ── Pipeline: start services ─────────────────────────────────────────────
if [ "$START_SERVICES" = 1 ]; then
  SERVICES="proxy gateway"
  [ "$WITH_PROTONMAIL" = 1 ] && SERVICES="$SERVICES protonmail"
  for svc in $SERVICES; do
    as_user "cd '$INSTALL_DIR' && ./bin/litellmctl restart $svc" 2>/dev/null \
      || as_user "cd '$INSTALL_DIR' && ./bin/litellmctl start $svc" \
      || warn "could not start $svc (non-fatal)"
  done
  ok "services up"
fi

# ── Pipeline: write fingerprint + user-data breadcrumb ───────────────────
if [ "$USE_FINGERPRINT" = 1 ] && [ -d "$INSTALL_DIR/.git" ] && [ -f "$INSTALL_DIR/.env" ]; then
  sudo mkdir -p "$(dirname "$FINGERPRINT_FILE")" 2>/dev/null || true
  compute_fingerprint | sudo tee "$FINGERPRINT_FILE" >/dev/null
fi
date -u +%FT%TZ | sudo tee /var/log/user-data-done >/dev/null 2>&1 || true

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
if [ "$WITH_GATEWAY" = 1 ] || [ "$START_SERVICES" = 1 ]; then
  info "Pipeline install complete."
  echo "  Gateway: http://<public-ip>:14041"
  echo "  Caddy:   http://<public-ip>/"
  echo "  Logs:    journalctl --user -u litellm-gateway -f  (on the instance)"
else
  info "Installation complete!"
  echo ""
  echo "  Next steps:"
  echo "    1. source $HOME/.bashrc   # (or .zshrc)"
  echo "    2. Edit $INSTALL_DIR/.env with your API keys"
  echo "    3. litellmctl wizard      # generate config.yaml"
  echo "    4. litellmctl start       # start the proxy"
fi
echo ""
