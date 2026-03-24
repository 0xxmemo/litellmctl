#!/usr/bin/env bash
# Search skill setup script
# Called by the skill installer to configure Claude Code settings
# This script disables native WebSearch and installs a guidance hook

set -euo pipefail

# Configuration (passed by installer)
SKILLS_DIR="${SKILLS_DIR:-~/.claude/skills}"
SETTINGS_DIR="${SETTINGS_DIR:-~/.claude}"
GATEWAY_ORIGIN="${GATEWAY_ORIGIN:-}"
SKILL_SLUG="${SKILL_SLUG:-search}"

# Expand tilde
SKILLS_DIR="$(echo "$SKILLS_DIR" | sed "s|^~|$HOME|g")"
SETTINGS_DIR="$(echo "$SETTINGS_DIR" | sed "s|^~|$HOME|g")"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"

echo "Configuring Claude Code settings for search skill..."

# Create settings.json if it doesn't exist
if [ ! -f "$SETTINGS_FILE" ]; then
  cat > "$SETTINGS_FILE" << 'EOF'
{
  "env": {},
  "permissions": {
    "allow": [],
    "deny": [],
    "ask": []
  }
}
EOF
  echo "  Created settings.json"
fi

# Use Python for reliable JSON manipulation
python3 << PYEOF
import json
import sys

settings_file = "${SETTINGS_FILE}"
try:
    with open(settings_file, "r") as f:
        settings = json.load(f)
except Exception as e:
    print(f"Warning: Could not read settings.json: {e}", file=sys.stderr)
    settings = {"env": {}, "permissions": {"allow": [], "deny": [], "ask": []}}

# Ensure permissions structure exists
if "permissions" not in settings:
    settings["permissions"] = {"allow": [], "deny": [], "ask": []}
if "deny" not in settings["permissions"]:
    settings["permissions"]["deny"] = []

# Add WebSearch denial if not present
if "WebSearch" not in settings["permissions"]["deny"]:
    settings["permissions"]["deny"].append("WebSearch")
    print("  Added WebSearch to denied tools")
else:
    print("  WebSearch already disabled")

# Configure hooks for UserPromptSubmit
if "hooks" not in settings:
    settings["hooks"] = {}
if "UserPromptSubmit" not in settings["hooks"]:
    settings["hooks"]["UserPromptSubmit"] = []

# Hook file path
hook_file = "${SETTINGS_DIR}/hooks/search-skill-hook.sh"

hook_entry = {"type": "command", "command": hook_file, "timeout": 5}
# Avoid duplicate hook entries
if not any(h.get("command") == hook_file for h in settings["hooks"]["UserPromptSubmit"]):
    settings["hooks"]["UserPromptSubmit"].append(hook_entry)
    print("  Registered search-skill-hook in UserPromptSubmit")
else:
    print("  Hook already registered")

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)

print("  settings.json updated successfully")
PYEOF

# Install hook script
HOOKS_DIR="${SETTINGS_DIR}/hooks"
HOOK_FILE="${HOOKS_DIR}/search-skill-hook.sh"
mkdir -p "${HOOKS_DIR}"

# Download and install hook script if gateway origin is provided
if [ -n "$GATEWAY_ORIGIN" ]; then
  if curl -fsSL "${GATEWAY_ORIGIN}/api/skills/hook.sh?slug=${SKILL_SLUG}" -o "${HOOK_FILE}" 2>/dev/null; then
    chmod +x "${HOOK_FILE}"
    echo "  Hook script installed: ${HOOK_FILE}"
  else
    echo "  Note: Hook script not available (optional feature)"
  fi
fi

echo "Setup complete!"
