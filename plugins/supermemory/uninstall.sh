#!/usr/bin/env bash
# supermemory plugin uninstall — removes the MCP entry from settings.json.
set -euo pipefail

SETTINGS_DIR="${SETTINGS_DIR:-$HOME/.claude}"
PLUGIN_DIR="${PLUGIN_DIR:-$SETTINGS_DIR/plugins/supermemory}"
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
removed_mcp = False
if "mcpServers" in settings and "supermemory" in settings["mcpServers"]:
    del settings["mcpServers"]["supermemory"]
    removed_mcp = True

# Strip the auto-recall hook by the _tag marker written at install time.
removed_hook = False
hooks = settings.get("hooks") or {}
ups = hooks.get("UserPromptSubmit")
if isinstance(ups, list):
    before = len(ups)
    ups = [h for h in ups if not (isinstance(h, dict) and h.get("_tag") == "supermemory")]
    if not ups:
        del hooks["UserPromptSubmit"]
    else:
        hooks["UserPromptSubmit"] = ups
    if len(ups) != before:
        removed_hook = True
if hooks is not None and not hooks:
    settings.pop("hooks", None)

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
print("  Removed mcpServers.supermemory" if removed_mcp else "  mcpServers.supermemory not registered")
print("  Removed hooks.UserPromptSubmit (auto-recall)" if removed_hook else "  hooks.UserPromptSubmit (auto-recall) not registered")
PYEOF
    elif command -v jq >/dev/null 2>&1; then
        local tmp
        tmp=$(mktemp)
        jq '
            (if .mcpServers then .mcpServers |= del(.["supermemory"]) else . end) |
            (if (.hooks // {}).UserPromptSubmit then
                .hooks.UserPromptSubmit |= [ .[] | select(._tag != "supermemory") ]
             else . end) |
            (if (.hooks // {}).UserPromptSubmit == [] then .hooks |= del(.UserPromptSubmit) else . end) |
            (if .hooks == {} then del(.hooks) else . end)
        ' "$SETTINGS_FILE" > "$tmp" && mv "$tmp" "$SETTINGS_FILE"
        echo "  Removed mcpServers.supermemory + hooks.UserPromptSubmit (via jq)"
    else
        echo "  Warning: neither python3 nor jq available; skipping settings.json edit" >&2
    fi
fi

if [ -d "$PLUGIN_DIR" ]; then
    rm -rf "$PLUGIN_DIR"
    echo "  Removed $PLUGIN_DIR"
fi

echo "supermemory plugin uninstalled."
echo "Note: saved memories in the gateway DB are NOT deleted. Use the 'memory' tool to forget them one-by-one, or drop the 'memories' collection via admin tooling."
