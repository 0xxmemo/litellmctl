#!/usr/bin/env bash
# claude-context plugin uninstall — removes the MCP entry from settings.json.
set -euo pipefail

SETTINGS_DIR="${SETTINGS_DIR:-$HOME/.claude}"
PLUGIN_DIR="${PLUGIN_DIR:-$SETTINGS_DIR/plugins/claude-context}"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$SETTINGS_FILE" << 'PYEOF'
import json, sys
settings_file = sys.argv[1]
try:
    with open(settings_file) as f:
        settings = json.load(f)
except Exception:
    settings = {}
removed = False
if "mcpServers" in settings and "claude-context" in settings["mcpServers"]:
    del settings["mcpServers"]["claude-context"]
    removed = True
with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
print("  Removed mcpServers.claude-context" if removed else "  mcpServers.claude-context not registered")
PYEOF
    elif command -v jq >/dev/null 2>&1; then
        local tmp
        tmp=$(mktemp)
        jq 'if .mcpServers then (.mcpServers |= del(.["claude-context"])) else . end' \
            "$SETTINGS_FILE" > "$tmp" && mv "$tmp" "$SETTINGS_FILE"
        echo "  Removed mcpServers.claude-context (via jq)"
    else
        echo "  Warning: neither python3 nor jq available; skipping settings.json edit" >&2
    fi
fi

if [ -d "$PLUGIN_DIR" ]; then
    rm -rf "$PLUGIN_DIR"
    echo "  Removed $PLUGIN_DIR"
fi

echo "claude-context plugin uninstalled."
echo "Note: vector data in the gateway DB is NOT deleted. Use clear_index or admin tooling to purge."
