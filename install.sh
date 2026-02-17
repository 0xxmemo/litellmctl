#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
SUBMODULE_DIR="$SCRIPT_DIR/litellm"

echo "==> LiteLLM Proxy Installer (fork: 0xxmemo/litellm)"
echo ""

# Init submodule if not already checked out
if [ ! -f "$SUBMODULE_DIR/pyproject.toml" ]; then
  echo "Initializing litellm submodule ..."
  git -C "$SCRIPT_DIR" submodule update --init --depth 1 litellm
fi

# Create or reuse virtualenv
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtualenv at $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
else
  echo "Using existing virtualenv at $VENV_DIR"
fi

# Activate
source "$VENV_DIR/bin/activate"

# Upgrade pip
pip install --upgrade pip --quiet

# Install from local submodule in editable mode
echo "Installing litellm[proxy] from local submodule (editable) ..."
pip install -e "$SUBMODULE_DIR[proxy]"

# Check for .env
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo ""
  echo "WARNING: No .env file found. Copy .env.example and fill in your keys:"
  echo "  cp $SCRIPT_DIR/.env.example $SCRIPT_DIR/.env"
fi

echo ""
echo "==> Installation complete!"
echo ""
echo "To start the proxy:"
echo "  source $VENV_DIR/bin/activate"
echo "  litellm --config $SCRIPT_DIR/config.yaml"
