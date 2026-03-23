import { PORT } from "../lib/config";

// GET /setup/claude-code.sh — Configure Claude Code to use LLM Gateway
function claudeCodeSetup(req: Request) {
  const url = new URL(req.url);
  const host = url.hostname;
  // Detect protocol from X-Forwarded-Proto header (for reverse proxy/SSL setups)
  // or from the request URL itself; default to http for local hosting
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const protocol = forwardedProto || (url.protocol === 'https:' ? 'https' : 'http');
  const gatewayOrigin = `${protocol}://${host}${protocol === 'http' && PORT ? ':' + PORT : ''}`;

  const script = `#!/usr/bin/env bash
# Configure Claude Code to use LLM Gateway as your API provider.
#
# Usage:
#   curl -fsSL ${gatewayOrigin}/setup/claude-code.sh | LLM_GATEWAY_API_KEY="sk-..." bash
#
set -euo pipefail

API_KEY="\${LLM_GATEWAY_API_KEY:-}"

if [ -z "\$API_KEY" ]; then
  echo "Error: LLM_GATEWAY_API_KEY is not set." >&2
  echo "" >&2
  echo "Usage:" >&2
  echo "  curl -fsSL ${gatewayOrigin}/setup/claude-code.sh | LLM_GATEWAY_API_KEY=\\"YOUR_KEY\\" bash" >&2
  exit 1
fi

CLAUDE_DIR="\$HOME/.claude"
SETTINGS_FILE="\$CLAUDE_DIR/settings.json"

mkdir -p "\$CLAUDE_DIR"

# Build or merge settings.json
if [ -f "\$SETTINGS_FILE" ]; then
  # Check if jq is available for safe JSON merging
  if command -v jq &>/dev/null; then
    tmp=\$(mktemp)
    jq --arg key "\$API_KEY" --arg url "${gatewayOrigin}/v1" \
       --arg opus "ultra" \
       --arg sonnet "plus" \
       --arg haiku "lite" '
      .env.ANTHROPIC_API_KEY = \$key |
      .env.ANTHROPIC_BASE_URL = \$url |
      .env.ANTHROPIC_DEFAULT_OPUS_MODEL = \$opus |
      .env.ANTHROPIC_DEFAULT_SONNET_MODEL = \$sonnet |
      .env.ANTHROPIC_DEFAULT_HAIKU_MODEL = \$haiku
    ' "\$SETTINGS_FILE" > "\$tmp" && mv "\$tmp" "\$SETTINGS_FILE"
  else
    echo "Warning: jq not found. Overwriting settings.json." >&2
    cat > "\$SETTINGS_FILE" <<JSONEOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${gatewayOrigin}/v1",
    "ANTHROPIC_API_KEY": "\$API_KEY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ultra",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "plus",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "lite"
  }
}
JSONEOF
  fi
else
  cat > "\$SETTINGS_FILE" <<JSONEOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${gatewayOrigin}/v1",
    "ANTHROPIC_API_KEY": "\$API_KEY",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "ultra",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "plus",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "lite"
  }
}
JSONEOF
fi

echo "Claude Code configured successfully!"
echo ""
echo "  API Base URL:  ${gatewayOrigin}/v1"
echo "  Settings file: \$SETTINGS_FILE"
echo ""
echo "Run 'claude' to start using Claude Code through LLM Gateway."
`;

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

// GET /setup/openclaw.sh — Configure OpenClaw to use LLM Gateway
function openclawSetup(req: Request) {
  const url = new URL(req.url);
  const host = url.hostname;
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const protocol = forwardedProto || (url.protocol === 'https:' ? 'https' : 'http');
  const gatewayOrigin = `${protocol}://${host}${protocol === 'http' && PORT ? ':' + PORT : ''}`;

  const script = `#!/usr/bin/env bash
# Configure OpenClaw to use LLM Gateway as your API provider.
#
# Usage:
#   curl -fsSL ${gatewayOrigin}/setup/openclaw.sh | LITELLM_API_KEY="sk-..." bash
#
set -euo pipefail

API_KEY="\${LITELLM_API_KEY:-}"

if [ -z "\$API_KEY" ]; then
  echo "Error: LITELLM_API_KEY is not set." >&2
  echo "" >&2
  echo "Usage:" >&2
  echo "  curl -fsSL ${gatewayOrigin}/setup/openclaw.sh | LITELLM_API_KEY=\\"YOUR_KEY\\" bash" >&2
  exit 1
fi

OPENCLAW_DIR="\$HOME/.openclaw"
CONFIG_FILE="\$OPENCLAW_DIR/openclaw.json"
ENV_FILE="\$OPENCLAW_DIR/.env"

mkdir -p "\$OPENCLAW_DIR"

# Add LITELLM_API_KEY to .env file (non-destructive)
if [ -f "\$ENV_FILE" ]; then
  # Remove existing LITELLM_API_KEY line if present
  grep -v "^LITELLM_API_KEY=" "\$ENV_FILE" > "\$ENV_FILE.tmp" || true
  mv "\$ENV_FILE.tmp" "\$ENV_FILE"
  echo "LITELLM_API_KEY=\$API_KEY" >> "\$ENV_FILE"
else
  echo "LITELLM_API_KEY=\$API_KEY" > "\$ENV_FILE"
fi

# Update openclaw.json with LLM Gateway provider
if [ -f "\$CONFIG_FILE" ]; then
  if command -v jq &>/dev/null; then
    tmp=\$(mktemp)
    jq --arg key "\${API_KEY}" --arg url "${gatewayOrigin}" \
       --arg opus "ultra" \
       --arg sonnet "plus" \
       --arg haiku "lite" '
      .models.providers.litellm = {
        "baseUrl": \$url,
        "apiKey": "\${LITELLM_API_KEY}",
        "api": "anthropic-messages",
        "models": [
          {"id": "ultra", "name": "LLM Gateway Ultra"},
          {"id": "plus", "name": "LLM Gateway Plus"},
          {"id": "lite", "name": "LLM Gateway Lite"}
        ]
      } |
      .agents.defaults.model.primary = "litellm/ultra" |
      .agents.defaults.model.fallbacks = ["litellm/plus", "litellm/lite"]
    ' "\$CONFIG_FILE" > "\$tmp" && mv "\$tmp" "\$CONFIG_FILE"
  else
    echo "Warning: jq not found. Updating openclaw.json models section." >&2
    tmp=\$(mktemp)
    jq --arg url "${gatewayOrigin}" '
      .models.providers.litellm = {
        "baseUrl": \$url,
        "apiKey": "\${LITELLM_API_KEY}",
        "api": "anthropic-messages",
        "models": [
          {"id": "ultra", "name": "LLM Gateway Ultra"},
          {"id": "plus", "name": "LLM Gateway Plus"},
          {"id": "lite", "name": "LLM Gateway Lite"}
        ]
      } |
      .agents.defaults.model.primary = "litellm/ultra" |
      .agents.defaults.model.fallbacks = ["litellm/plus", "litellm/lite"]
    ' "\$CONFIG_FILE" > "\$tmp" && mv "\$tmp" "\$CONFIG_FILE"
  fi
else
  echo "Error: openclaw.json not found at \$CONFIG_FILE" >&2
  echo "Please run the OpenClaw wizard first to create the config file." >&2
  exit 1
fi

echo "OpenClaw configured successfully!"
echo ""
echo "  Gateway URL:   ${gatewayOrigin}"
echo "  Config file:   \$CONFIG_FILE"
echo "  Env file:      \$ENV_FILE"
echo ""
echo "Restart OpenClaw to apply changes."
`;

  return new Response(script, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

export const setupRoutes = {
  "/setup/claude-code.sh": { GET: claudeCodeSetup },
  "/setup/openclaw.sh": { GET: openclawSetup },
};
