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
removed_mcp = False
if "mcpServers" in settings and "claude-context" in settings["mcpServers"]:
    del settings["mcpServers"]["claude-context"]
    removed_mcp = True

removed_hooks = []
def _strip(group_key, marker_substr):
    group = settings.get("hooks", {}).get(group_key)
    if not isinstance(group, list):
        return
    new_group = []
    for entry in group:
        kept_hooks = [h for h in entry.get("hooks", [])
                      if marker_substr not in (h.get("command") or "")]
        if kept_hooks:
            new_entry = dict(entry)
            new_entry["hooks"] = kept_hooks
            new_group.append(new_entry)
        elif entry.get("hooks"):
            removed_hooks.append(group_key)
    settings["hooks"][group_key] = new_group

_strip("SessionStart", "claude-context/hooks/session-start.sh")
_strip("UserPromptSubmit", "claude-context/hooks/prompt-search.sh")

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
print("  Removed mcpServers.claude-context" if removed_mcp else "  mcpServers.claude-context not registered")
if removed_hooks:
    print(f"  Removed claude-context hooks from: {', '.join(sorted(set(removed_hooks)))}")
PYEOF
    elif command -v jq >/dev/null 2>&1; then
        local tmp
        tmp=$(mktemp)
        jq '
            if .mcpServers then (.mcpServers |= del(.["claude-context"])) else . end |
            if .hooks.SessionStart then
                .hooks.SessionStart |= [.[] | (.hooks //= []) | .hooks |= [.[] | select((.command // "") | test("claude-context/hooks/session-start.sh") | not)] | select((.hooks | length) > 0)]
            else . end |
            if .hooks.UserPromptSubmit then
                .hooks.UserPromptSubmit |= [.[] | (.hooks //= []) | .hooks |= [.[] | select((.command // "") | test("claude-context/hooks/prompt-search.sh") | not)] | select((.hooks | length) > 0)]
            else . end
        ' "$SETTINGS_FILE" > "$tmp" && mv "$tmp" "$SETTINGS_FILE"
        echo "  Removed mcpServers.claude-context + hooks (via jq)"
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
