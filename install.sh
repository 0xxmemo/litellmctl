#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  litellmctl installer — safe for first install AND retroactive re-runs.
#
#    curl -fsSL https://raw.githubusercontent.com/0xxmemo/litellmctl/main/install.sh | bash
#
#  Works on macOS (Homebrew or system Python) and Ubuntu/Debian.
#  Preserves existing config.yaml, .env, and auth token files.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_URL="https://github.com/0xxmemo/litellmctl.git"
INSTALL_DIR="$HOME/.litellm"
VENV_DIR="$INSTALL_DIR/venv"

# ── Helpers ────────────────────────────────────────────────────────────────

info()  { printf "\033[1;34m==> %s\033[0m\n" "$*"; }
warn()  { printf "\033[1;33m==> %s\033[0m\n" "$*"; }
error() { printf "\033[1;31m==> %s\033[0m\n" "$*" >&2; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
skip()  { printf "  \033[33m-\033[0m %s\n" "$*"; }

normalize_submodule_ref() {
  local dir="$1"
  [ -d "$dir/.git" ] || [ -f "$dir/.git" ] || return 0

  local head_sha main_sha current_branch
  head_sha=$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)
  if [ -z "$head_sha" ]; then
    return 0
  fi

  git -C "$dir" fetch --quiet origin main || true
  main_sha=$(git -C "$dir" rev-parse origin/main 2>/dev/null || true)
  if [ -z "$main_sha" ]; then
    main_sha=$(git -C "$dir" rev-parse main 2>/dev/null || true)
  fi
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

if ! command -v git &>/dev/null; then
  error "git is required."
  case "$PLATFORM" in
    macOS) echo "  Install with: xcode-select --install" ;;
    Linux) echo "  Install with: sudo apt install git" ;;
  esac
  exit 1
fi

detect_python() {
  for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
      local ver
      ver=$("$cmd" -c 'import sys; print(sys.version_info[:2] >= (3,9))' 2>/dev/null || echo "False")
      if [ "$ver" = "True" ]; then
        echo "$cmd"
        return
      fi
    fi
  done
  return 1
}

PYTHON=""
if PYTHON=$(detect_python); then
  ok "Python: $($PYTHON --version 2>&1)"
else
  error "Python 3.9+ not found."
  case "$PLATFORM" in
    macOS) echo "  Install with: brew install python3" ;;
    Linux) echo "  Install with: sudo apt install python3 python3-venv" ;;
  esac
  exit 1
fi

if [ "$PLATFORM" = "Linux" ]; then
  if ! $PYTHON -c "import venv" 2>/dev/null; then
    warn "python3-venv not found — installing ..."
    sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv
    ok "python3-venv installed"
  fi
  if ! $PYTHON -c "import ensurepip" 2>/dev/null; then
    warn "python3-pip/ensurepip not found — installing ..."
    sudo apt-get update -qq && sudo apt-get install -y -qq python3-pip
    ok "python3-pip installed"
  fi
fi

echo "  Platform: $PLATFORM ($(uname -m))"
echo ""

# ── 2. Clone or update repo ───────────────────────────────────────────────

if [ -d "$INSTALL_DIR" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Existing installation found — updating ..."
    git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null && ok "Pulled latest" \
      || warn "Could not fast-forward (local changes?). Continuing with current version."
  else
    # ~/.litellm exists but isn't our repo (e.g. litellm's own config dir).
    # Back up user files, clone, then restore.
    info "~/.litellm exists but is not a git repo — merging into litellmctl ..."

    BACKUP_DIR=$(mktemp -d)
    info "Backing up existing files to $BACKUP_DIR ..."

    # Move everything except hidden git stuff
    for f in "$INSTALL_DIR"/*; do
      [ -e "$f" ] && mv "$f" "$BACKUP_DIR/" && ok "Backed up $(basename "$f")"
    done
    for f in "$INSTALL_DIR"/.[!.]* "$INSTALL_DIR"/..?*; do
      [ -e "$f" ] || continue
      local_name="$(basename "$f")"
      [ "$local_name" = ".git" ] && continue
      mv "$f" "$BACKUP_DIR/" && ok "Backed up $local_name"
    done

    rmdir "$INSTALL_DIR" 2>/dev/null || rm -rf "$INSTALL_DIR"

    info "Cloning litellmctl ..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    ok "Cloned"

    # Restore user files (config, .env, auth tokens) without overwriting repo files
    info "Restoring your files ..."
    for f in "$BACKUP_DIR"/*; do
      [ -e "$f" ] || continue
      local_name="$(basename "$f")"
      case "$local_name" in
        venv|litellm|bin|logs|__pycache__) skip "Skipped $local_name (will be rebuilt)" ;;
        *)
          if [ -e "$INSTALL_DIR/$local_name" ]; then
            # User file conflicts with a repo file — keep user's version
            cp -a "$f" "$INSTALL_DIR/$local_name"
            ok "Restored $local_name (kept your version)"
          else
            cp -a "$f" "$INSTALL_DIR/$local_name"
            ok "Restored $local_name"
          fi
          ;;
      esac
    done
    for f in "$BACKUP_DIR"/.[!.]* "$BACKUP_DIR"/..?*; do
      [ -e "$f" ] || continue
      local_name="$(basename "$f")"
      case "$local_name" in
        .git|.DS_Store) continue ;;
        .env|.proxy-port|.proxy.pid)
          cp -a "$f" "$INSTALL_DIR/$local_name"
          ok "Restored $local_name"
          ;;
        *)
          [ ! -e "$INSTALL_DIR/$local_name" ] && cp -a "$f" "$INSTALL_DIR/$local_name" \
            && ok "Restored $local_name"
          ;;
      esac
    done

    info "Backup kept at: $BACKUP_DIR"
    echo ""
  fi
else
  info "Cloning litellmctl ..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# ── 3. Initialize submodule ───────────────────────────────────────────────

SUBMODULE_DIR="$INSTALL_DIR/litellm"

if [ ! -f "$SUBMODULE_DIR/pyproject.toml" ]; then
  info "Initializing litellm submodule ..."
  git -C "$INSTALL_DIR" submodule update --init --depth 1 litellm
  normalize_submodule_ref "$SUBMODULE_DIR"
  ok "Submodule ready"
else
  normalize_submodule_ref "$SUBMODULE_DIR"
  ok "Submodule already initialized"
fi

# ── 4. Python virtualenv ─────────────────────────────────────────────────

if [ -d "$VENV_DIR" ]; then
  ok "Existing virtualenv found — reusing"
else
  info "Creating virtualenv ..."
  $PYTHON -m venv "$VENV_DIR"
  ok "Virtualenv created"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# ── 5. Install litellm fork ──────────────────────────────────────────────

info "Installing litellm[proxy] (editable) ..."
pip install --upgrade pip --quiet 2>/dev/null
pip install -e "$SUBMODULE_DIR[proxy]" --quiet 2>/dev/null
ok "litellm installed"

# ── 6. .env setup ─────────────────────────────────────────────────────────

if [ ! -f "$INSTALL_DIR/.env" ]; then
  if [ -f "$INSTALL_DIR/.env.example" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    # Auto-fill token dirs to the install directory
    if command -v sed &>/dev/null; then
      sed -i.bak "s|/path/to/.litellm|$INSTALL_DIR|g" "$INSTALL_DIR/.env" 2>/dev/null || true
      rm -f "$INSTALL_DIR/.env.bak"
    fi
    ok "Created .env from template (edit to add your API keys)"
  else
    warn "No .env.example found — create .env manually"
  fi
else
  ok ".env already exists — not modified"
fi

# Ensure LITELLM_LOCAL_MODEL_COST_MAP is set (uses fork's model map instead of upstream)
if [ -f "$INSTALL_DIR/.env" ]; then
  if ! grep -q "^LITELLM_LOCAL_MODEL_COST_MAP=" "$INSTALL_DIR/.env" 2>/dev/null; then
    printf '\nLITELLM_LOCAL_MODEL_COST_MAP=true\n' >> "$INSTALL_DIR/.env"
    ok "Added LITELLM_LOCAL_MODEL_COST_MAP=true to .env"
  fi
fi

# ── 7. Sync auth file paths in .env ──────────────────────────────────────

info "Syncing auth file paths ..."
"$INSTALL_DIR/bin/litellmctl" init-env 2>/dev/null || true

# ── 7b. Gateway SQLite DB + sqlite-vec extension ─────────────────────────
#
# The gateway stores all auth/session/usage data in a single SQLite file at
# $INSTALL_DIR/gateway/gateway.db (created on first gateway start). This
# step prepares the directory and tries to install the sqlite-vec extension
# for future vector-search features. All failures here are non-fatal —
# the gateway runs fine without sqlite-vec, it just can't do vec queries.

GATEWAY_DB_DIR="$INSTALL_DIR/gateway"
if [ -d "$GATEWAY_DB_DIR" ]; then
  mkdir -p "$GATEWAY_DB_DIR"
  ok "Gateway SQLite DB directory ready ($GATEWAY_DB_DIR/gateway.db will be created on first start)"
fi

install_sqlite_vec_macos() {
  if ! command -v brew &>/dev/null; then
    warn "Homebrew not found — skipping sqlite-vec install."
    echo "  Install brew first (https://brew.sh) then rerun this installer,"
    echo "  or build sqlite-vec from source: https://github.com/asg017/sqlite-vec"
    return 0
  fi
  # Probe for an already-installed vec0 library in the usual brew locations
  for p in /opt/homebrew/lib/vec0.dylib /usr/local/lib/vec0.dylib; do
    if [ -f "$p" ]; then
      ok "sqlite-vec already installed ($p)"
      return 0
    fi
  done
  info "Installing sqlite-vec via Homebrew (optional, for vector search) ..."
  if brew install asg017/sqlite-vec/sqlite-vec 2>/dev/null; then
    ok "sqlite-vec installed"
  else
    warn "sqlite-vec install via brew failed — vector features disabled (non-fatal)"
    echo "  To install manually later: brew install asg017/sqlite-vec/sqlite-vec"
  fi
}

install_sqlite_vec_linux() {
  for p in /usr/lib/sqlite-vec/vec0.so /usr/local/lib/vec0.so; do
    if [ -f "$p" ]; then
      ok "sqlite-vec already installed ($p)"
      return 0
    fi
  done
  warn "sqlite-vec not found — vector search will be disabled (non-fatal)"
  echo "  To enable vector features, build and install sqlite-vec manually:"
  echo "    git clone https://github.com/asg017/sqlite-vec && cd sqlite-vec"
  echo "    make loadable"
  echo "    sudo cp dist/vec0.so /usr/local/lib/"
  echo "  Then restart the gateway."
}

case "$PLATFORM" in
  macOS) install_sqlite_vec_macos ;;
  Linux) install_sqlite_vec_linux ;;
esac

# ── 8. Shell completions ─────────────────────────────────────────────────

SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  *)    RC_FILE="$HOME/.bashrc" ;;
esac

if grep -qF "alias litellmctl=" "$RC_FILE" 2>/dev/null; then
  ok "Shell alias already configured in $RC_FILE"
else
  info "Setting up shell alias + tab completion ..."
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
  ok "Added to $RC_FILE"
fi

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
info "Installation complete!"
echo ""
echo "  Next steps:"
echo ""
echo "    1. Load the CLI into your current shell:"
echo "       source $RC_FILE"
echo ""
echo "    2. Edit ~/.litellm/.env with your API keys:"
echo "       \$EDITOR ~/.litellm/.env"
echo ""
echo "    3. Authenticate OAuth providers (any or all):"
echo "       litellmctl auth gemini    # Google Gemini CLI"
echo "       litellmctl auth chatgpt   # ChatGPT / Codex"
echo "       litellmctl auth qwen      # Qwen Portal"
echo "       litellmctl auth kimi      # Kimi Code"
echo ""
echo "    4. Start the proxy:"
echo "       litellmctl start"
echo ""
echo "    5. (Optional) Set up additional services:"
echo "       litellmctl install --with-searxng     # Privacy-respecting search server"
echo "       litellmctl install --with-local       # Local embedding + transcription"
echo ""
