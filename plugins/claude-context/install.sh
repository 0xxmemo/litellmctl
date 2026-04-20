#!/usr/bin/env bash
# claude-context plugin install — registers MCP server in ~/.claude/settings.json
# Cross-OS: macOS (BSD) and Linux (GNU). Called inline by the gateway-generated wrapper.
set -euo pipefail

# --- Configuration from wrapper ---
SETTINGS_DIR="${SETTINGS_DIR:-$HOME/.claude}"
PLUGIN_DIR="${PLUGIN_DIR:-$SETTINGS_DIR/plugins/claude-context}"
PLUGIN_SRC_DIR="${PLUGIN_SRC_DIR:-}"
GATEWAY_ORIGIN="${GATEWAY_ORIGIN:-http://localhost:14041}"

if [ -z "${API_KEY:-}" ]; then
    echo "Error: API_KEY is not set. Pass via the wrapper install script." >&2
    exit 1
fi
if [ -z "$PLUGIN_SRC_DIR" ]; then
    echo "Error: PLUGIN_SRC_DIR is not set." >&2
    exit 1
fi

# --- Bun availability ---
if ! command -v bun >/dev/null 2>&1; then
    echo "Error: 'bun' is required but not found on PATH." >&2
    echo "Install from https://bun.sh" >&2
    exit 1
fi

SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
STATE_DIR="${HOME}/.litellm/plugin-state/claude-context"
mkdir -p "$SETTINGS_DIR" "$STATE_DIR"

# --- Create settings.json if missing ---
if [ ! -f "$SETTINGS_FILE" ]; then
    cat > "$SETTINGS_FILE" << 'EOF'
{
  "env": {},
  "permissions": { "allow": [], "deny": [], "ask": [] }
}
EOF
    echo "  Created settings.json"
fi

# --- Register MCP server ---
configure_settings() {
    local settings_file="$1"
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$settings_file" "$PLUGIN_SRC_DIR" "$GATEWAY_ORIGIN" "$API_KEY" "$STATE_DIR" << 'PYEOF'
import json, os, sys

settings_file, plugin_src, gateway_url, api_key, state_dir = sys.argv[1:6]
entry_name = "claude-context"

try:
    with open(settings_file, "r") as f:
        settings = json.load(f)
except Exception:
    settings = {"env": {}, "permissions": {"allow": [], "deny": [], "ask": []}}

settings.setdefault("mcpServers", {})
settings["mcpServers"][entry_name] = {
    "command": "bun",
    "args": ["run", os.path.join(plugin_src, "src", "index.ts")],
    "env": {
        "LLM_GATEWAY_URL": gateway_url,
        "LLM_GATEWAY_API_KEY": api_key,
        "EMBEDDING_MODEL": os.environ.get("EMBEDDING_MODEL", "local/nomic-embed-text"),
        "CLAUDE_CONTEXT_STATE_DIR": state_dir,
    },
}

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
print(f"  Registered mcpServers.{entry_name}")
PYEOF
    elif command -v jq >/dev/null 2>&1; then
        local tmp
        tmp=$(mktemp)
        jq --arg plugin_src "$PLUGIN_SRC_DIR" \
           --arg gateway "$GATEWAY_ORIGIN" \
           --arg key "$API_KEY" \
           --arg state "$STATE_DIR" \
           --arg model "${EMBEDDING_MODEL:-local/nomic-embed-text}" '
            if .mcpServers == null then .mcpServers = {} else . end |
            .mcpServers["claude-context"] = {
                "command": "bun",
                "args": ["run", ($plugin_src + "/src/index.ts")],
                "env": {
                    "LLM_GATEWAY_URL": $gateway,
                    "LLM_GATEWAY_API_KEY": $key,
                    "EMBEDDING_MODEL": $model,
                    "CLAUDE_CONTEXT_STATE_DIR": $state
                }
            }
        ' "$settings_file" > "$tmp" && mv "$tmp" "$settings_file"
        echo "  Registered mcpServers.claude-context"
    else
        echo "  Error: need python3 or jq to mutate settings.json" >&2
        exit 1
    fi
}

configure_settings "$SETTINGS_FILE"

# --- Hydrate plugin node_modules (one-time) ---
if [ -f "${PLUGIN_SRC_DIR}/package.json" ] && [ ! -d "${PLUGIN_SRC_DIR}/node_modules" ]; then
    echo "  Installing plugin dependencies via bun install..."
    (cd "$PLUGIN_SRC_DIR" && bun install --silent) || {
        echo "  Warning: bun install failed. Run manually: (cd $PLUGIN_SRC_DIR && bun install)" >&2
    }
fi

echo "Setup complete — restart Claude Code to load the claude-context MCP server."
