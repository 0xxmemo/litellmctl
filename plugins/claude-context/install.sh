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
STATE_DIR="${SETTINGS_DIR}/plugin-state/claude-context"
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
# Embedding model + dimensions are fixed by the plugin source, NOT env vars.
settings["mcpServers"][entry_name] = {
    "command": "bun",
    "args": ["run", os.path.join(plugin_src, "src", "index.ts")],
    # TODO: add LITELLMCTL_URL / LITELLMCTL_API_KEY when we migrate env names.
    "env": {
        "LLM_GATEWAY_URL": gateway_url,
        "LLM_GATEWAY_API_KEY": api_key,
        "CLAUDE_CONTEXT_STATE_DIR": state_dir,
    },
}

# Hooks: SessionStart auto-indexes the cwd's git repo; UserPromptSubmit injects
# top-K relevant chunks into the prompt. Both shell out to the same plugin CLI.
# TODO: add LITELLMCTL_* to hook_env when we migrate env names.
hook_env = {
    "LLM_GATEWAY_URL": gateway_url,
    "LLM_GATEWAY_API_KEY": api_key,
    "CLAUDE_CONTEXT_STATE_DIR": state_dir,
    "CLAUDE_PLUGIN_ROOT": plugin_src,
}
session_start_cmd = os.path.join(plugin_src, "hooks", "session-start.sh")
prompt_submit_cmd = os.path.join(plugin_src, "hooks", "prompt-search.sh")

settings.setdefault("hooks", {})

def _replace_or_append(group_key, marker_substr, hook_obj):
    group = settings["hooks"].setdefault(group_key, [])
    for entry in group:
        for h in entry.get("hooks", []):
            if marker_substr in (h.get("command") or ""):
                h.update(hook_obj)
                return
    group.append({"hooks": [hook_obj]})

env_prefix = " ".join(f"{k}={json.dumps(v)}" for k, v in hook_env.items())
_replace_or_append(
    "SessionStart", "claude-context/hooks/session-start.sh",
    {"type": "command", "command": f"env {env_prefix} {session_start_cmd}", "timeout": 30},
)
_replace_or_append(
    "UserPromptSubmit", "claude-context/hooks/prompt-search.sh",
    {"type": "command", "command": f"env {env_prefix} {prompt_submit_cmd}", "timeout": 5},
)

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
print(f"  Registered mcpServers.{entry_name}")
print(f"  Registered hooks.SessionStart and hooks.UserPromptSubmit (claude-context)")
PYEOF
    elif command -v jq >/dev/null 2>&1; then
        local tmp
        tmp=$(mktemp)
        jq --arg plugin_src "$PLUGIN_SRC_DIR" \
           --arg gateway "$GATEWAY_ORIGIN" \
           --arg key "$API_KEY" \
           --arg state "$STATE_DIR" '
            if .mcpServers == null then .mcpServers = {} else . end |
            .mcpServers["claude-context"] = {
                "command": "bun",
                "args": ["run", ($plugin_src + "/src/index.ts")],
                "env": {
                    "LLM_GATEWAY_URL": $gateway,
                    "LLM_GATEWAY_API_KEY": $key,
                    "CLAUDE_CONTEXT_STATE_DIR": $state
                }
            } |
            (.hooks //= {}) |
            (.hooks.SessionStart //= []) |
            (.hooks.UserPromptSubmit //= []) |
            (.hooks.SessionStart |= ([.[] | select((.hooks // [])[]?.command | test("claude-context/hooks/session-start.sh") | not)])) |
            (.hooks.UserPromptSubmit |= ([.[] | select((.hooks // [])[]?.command | test("claude-context/hooks/prompt-search.sh") | not)])) |
            (.hooks.SessionStart += [{
                "hooks": [{
                    "type": "command",
                    "command": ("env LLM_GATEWAY_URL=" + ($gateway|@sh) +
                        " LLM_GATEWAY_API_KEY=" + ($key|@sh) +
                        " CLAUDE_CONTEXT_STATE_DIR=" + ($state|@sh) +
                        " CLAUDE_PLUGIN_ROOT=" + ($plugin_src|@sh) +
                        " " + $plugin_src + "/hooks/session-start.sh"),
                    "timeout": 30
                }]
            }]) |
            (.hooks.UserPromptSubmit += [{
                "hooks": [{
                    "type": "command",
                    "command": ("env LLM_GATEWAY_URL=" + ($gateway|@sh) +
                        " LLM_GATEWAY_API_KEY=" + ($key|@sh) +
                        " CLAUDE_CONTEXT_STATE_DIR=" + ($state|@sh) +
                        " CLAUDE_PLUGIN_ROOT=" + ($plugin_src|@sh) +
                        " " + $plugin_src + "/hooks/prompt-search.sh"),
                    "timeout": 5
                }]
            }])
        ' "$settings_file" > "$tmp" && mv "$tmp" "$settings_file"
        echo "  Registered mcpServers.claude-context + SessionStart/UserPromptSubmit hooks"
    else
        echo "  Error: need python3 or jq to mutate settings.json" >&2
        exit 1
    fi
}

configure_settings "$SETTINGS_FILE"

# --- Ensure hook scripts are executable ---
for hook in "${PLUGIN_SRC_DIR}/hooks/session-start.sh" "${PLUGIN_SRC_DIR}/hooks/prompt-search.sh"; do
    [ -f "$hook" ] && chmod +x "$hook"
done

# --- Hydrate plugin node_modules (one-time) ---
if [ -f "${PLUGIN_SRC_DIR}/package.json" ] && [ ! -d "${PLUGIN_SRC_DIR}/node_modules" ]; then
    echo "  Installing plugin dependencies via bun install..."
    (cd "$PLUGIN_SRC_DIR" && bun install --silent) || {
        echo "  Warning: bun install failed. Run manually: (cd $PLUGIN_SRC_DIR && bun install)" >&2
    }
fi

echo "Setup complete — restart Claude Code to load the claude-context MCP server."
