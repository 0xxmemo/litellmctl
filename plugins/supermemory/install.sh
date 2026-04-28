#!/usr/bin/env bash
# supermemory plugin install.
#
# Wires two things into Claude Code:
#   1. MCP server  → ~/.claude.json      (via `claude mcp add-json -s user`)
#   2. Hook        → ~/.claude/settings.json  (UserPromptSubmit auto-recall)
#
# The MCP entry MUST live in ~/.claude.json — Claude Code's MCP loader ignores
# settings.json. The hook legitimately belongs in settings.json.
set -euo pipefail

# --- Configuration from wrapper ---
SETTINGS_DIR="${SETTINGS_DIR:-$HOME/.claude}"
PLUGIN_DIR="${PLUGIN_DIR:-$SETTINGS_DIR/plugins/supermemory}"
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

for bin in bun claude python3; do
    if ! command -v "$bin" >/dev/null 2>&1; then
        echo "Error: '$bin' is required but not found on PATH." >&2
        exit 1
    fi
done

SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
mkdir -p "$SETTINGS_DIR"

# --- Create settings.json if missing (hook lives here) ---
if [ ! -f "$SETTINGS_FILE" ]; then
    cat > "$SETTINGS_FILE" << 'EOF'
{
  "env": {},
  "permissions": { "allow": [], "deny": [], "ask": [] }
}
EOF
    echo "  Created settings.json"
fi

# --- Register MCP server in ~/.claude.json ---
# TODO: add LITELLMCTL_URL / LITELLMCTL_API_KEY when we migrate env names.
MCP_JSON=$(
  PLUGIN_SRC_DIR="$PLUGIN_SRC_DIR" \
  GATEWAY_ORIGIN="$GATEWAY_ORIGIN" \
  API_KEY="$API_KEY" \
  python3 -c '
import json, os
print(json.dumps({
    "command": "bun",
    "args": ["run", os.path.join(os.environ["PLUGIN_SRC_DIR"], "src", "index.ts")],
    "env": {
        "LLM_GATEWAY_URL": os.environ["GATEWAY_ORIGIN"],
        "LLM_GATEWAY_API_KEY": os.environ["API_KEY"],
    },
}))
'
)

# Idempotent: remove (ignore failure — may not exist) then add.
claude mcp remove -s user supermemory >/dev/null 2>&1 || true
claude mcp add-json -s user supermemory "$MCP_JSON" >/dev/null
echo "  Registered MCP server via \`claude mcp add-json\` (user scope)"

# --- Register UserPromptSubmit auto-recall hook in settings.json ---
python3 - "$SETTINGS_FILE" "$PLUGIN_SRC_DIR" "$GATEWAY_ORIGIN" "$API_KEY" << 'PYEOF'
import json, sys

settings_file, plugin_src, gateway_url, api_key = sys.argv[1:5]

try:
    with open(settings_file, "r") as f:
        settings = json.load(f)
except Exception:
    settings = {"env": {}, "permissions": {"allow": [], "deny": [], "ask": []}}

hook_env = {
    "LLM_GATEWAY_URL": gateway_url,
    "LLM_GATEWAY_API_KEY": api_key,
}
hook_cmd = plugin_src + "/hooks/recall-on-prompt.sh"
marker = "supermemory/hooks/recall-on-prompt.sh"

settings.setdefault("hooks", {})

def _replace_or_append(group_key, marker_substr, hook_obj, matcher=None):
    group = settings["hooks"].setdefault(group_key, [])
    for entry in group:
        for h in entry.get("hooks", []):
            if marker_substr in (h.get("command") or ""):
                h.update(hook_obj)
                if matcher is not None:
                    entry["matcher"] = matcher
                return
    block = {"hooks": [hook_obj]}
    if matcher is not None:
        block["matcher"] = matcher
    group.append(block)

env_prefix = " ".join(f"{k}={json.dumps(v)}" for k, v in hook_env.items())
_replace_or_append(
    "UserPromptSubmit", marker,
    {"type": "command", "command": f"env {env_prefix} {hook_cmd}", "timeout": 5},
)

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
print("  Registered UserPromptSubmit auto-recall hook in settings.json")
PYEOF

# --- Ensure hook script is executable ---
[ -f "${PLUGIN_SRC_DIR}/hooks/recall-on-prompt.sh" ] && chmod +x "${PLUGIN_SRC_DIR}/hooks/recall-on-prompt.sh"

# --- Hydrate plugin node_modules (one-time) ---
if [ -f "${PLUGIN_SRC_DIR}/package.json" ] && [ ! -d "${PLUGIN_SRC_DIR}/node_modules" ]; then
    echo "  Installing plugin dependencies via bun install..."
    (cd "$PLUGIN_SRC_DIR" && bun install --silent) || {
        echo "  Warning: bun install failed. Run manually: (cd $PLUGIN_SRC_DIR && bun install)" >&2
    }
fi

echo "Setup complete — restart Claude Code to load the supermemory MCP server."
