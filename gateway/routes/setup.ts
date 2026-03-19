import { PORT } from "../lib/config";

// GET /setup/claude-code.sh — Configure Claude Code to use LLM Gateway
function claudeCodeSetup(req: Request) {
  const url = new URL(req.url);
  const host = url.hostname;
  // Use the gateway's own origin so the script works from any network address
  const gatewayOrigin = `http://${host}:${PORT}`;

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
    jq --arg key "\$API_KEY" --arg url "${gatewayOrigin}/v1" '
      .env.ANTHROPIC_API_KEY = \$key |
      .env.ANTHROPIC_BASE_URL = \$url
    ' "\$SETTINGS_FILE" > "\$tmp" && mv "\$tmp" "\$SETTINGS_FILE"
  else
    echo "Warning: jq not found. Overwriting settings.json." >&2
    cat > "\$SETTINGS_FILE" <<JSONEOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${gatewayOrigin}/v1",
    "ANTHROPIC_API_KEY": "\$API_KEY"
  }
}
JSONEOF
  fi
else
  cat > "\$SETTINGS_FILE" <<JSONEOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${gatewayOrigin}/v1",
    "ANTHROPIC_API_KEY": "\$API_KEY"
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

export const setupRoutes = {
  "/setup/claude-code.sh": { GET: claudeCodeSetup },
};
