#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS_FILE="$HOME/.claude/settings.json"

# Load master key from .env
if [ -f "$SCRIPT_DIR/.env" ]; then
  LITELLM_AUTH_TOKEN=$(grep -E '^LITELLM_MASTER_KEY=' "$SCRIPT_DIR/.env" | cut -d'=' -f2-)
fi

if [ -z "$LITELLM_AUTH_TOKEN" ]; then
  echo "ERROR: LITELLM_MASTER_KEY not found in $SCRIPT_DIR/.env"
  exit 1
fi

# LiteLLM Proxy settings
LITELLM_BASE_URL="http://127.0.0.1:4000"

# Read current settings for ANTHROPIC_BASE_URL
CURRENT_BASE_URL=$(jq -r '.env.ANTHROPIC_BASE_URL // ""' "$SETTINGS_FILE")

if [ "$CURRENT_BASE_URL" == "$LITELLM_BASE_URL" ]; then
  echo "Switching Claude Code to use Direct Anthropic API (via OAuth)..."
  # Remove the entire env object
  jq 'del(.env)' "$SETTINGS_FILE" > tmp.$$.json && mv tmp.$$.json "$SETTINGS_FILE"
  echo "Claude Code now configured for Direct Anthropic API (OAuth)."
else
  echo "Switching Claude Code to use LiteLLM Proxy..."
  # Set env with proxy overrides
  jq '.env = {"ANTHROPIC_BASE_URL": "'"$LITELLM_BASE_URL"'", "ANTHROPIC_AUTH_TOKEN": "'"$LITELLM_AUTH_TOKEN"'"}' "$SETTINGS_FILE" > tmp.$$.json && mv tmp.$$.json "$SETTINGS_FILE"
  echo "Claude Code now configured for LiteLLM Proxy."
fi

echo "Remember to restart Claude Code for changes to take full effect."
