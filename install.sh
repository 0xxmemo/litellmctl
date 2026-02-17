#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
FORK_REPO="https://github.com/0xxmemo/litellm.git"
FORK_BRANCH="main"

echo "==> LiteLLM Proxy Installer (fork: 0xxmemo/litellm)"
echo ""

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

# Install the fork (editable if cloned, otherwise from git)
echo "Installing litellm from fork ..."
pip install "litellm[proxy] @ git+${FORK_REPO}@${FORK_BRANCH}" --upgrade

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
