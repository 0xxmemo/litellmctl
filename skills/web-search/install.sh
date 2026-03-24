#!/usr/bin/env bash
# Web search skill install script - runs inline during installation
set -euo pipefail

SKILLS_DIR="${SKILLS_DIR:-~/.claude/skills}"
SETTINGS_DIR="${SETTINGS_DIR:-~/.claude}"

# Expand tilde
SKILLS_DIR="$(echo "$SKILLS_DIR" | sed "s|^~|$HOME|g")"
SETTINGS_DIR="$(echo "$SETTINGS_DIR" | sed "s|^~|$HOME|g")"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"

# Get gateway URL and API key from environment (passed by gateway/routes/skills.ts)
# API_KEY is injected by the wrapper install script from LLM_GATEWAY_API_KEY
GATEWAY_URL="${GATEWAY_ORIGIN:-http://localhost:14041}"

if [ -z "${API_KEY:-}" ]; then
    echo "Error: API_KEY is not set. This should be passed from the wrapper install script."
    exit 1
fi

echo "Configuring Claude Code settings for web-search skill..."

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

if "permissions" not in settings:
    settings["permissions"] = {"allow": [], "deny": [], "ask": []}
if "deny" not in settings["permissions"]:
    settings["permissions"]["deny"] = []

if "WebSearch" not in settings["permissions"]["deny"]:
    settings["permissions"]["deny"].append("WebSearch")
    print("  Disabled WebSearch")
else:
    print("  WebSearch already disabled")

if "hooks" not in settings:
    settings["hooks"] = {}
if "UserPromptSubmit" not in settings["hooks"]:
    settings["hooks"]["UserPromptSubmit"] = []

hook_file = "${SETTINGS_DIR}/hooks/web-search-skill-hook.sh"
hook_cmd = {"type": "command", "command": hook_file, "timeout": 5}

registered = False
for entry in settings["hooks"]["UserPromptSubmit"]:
    if isinstance(entry, dict) and "hooks" in entry:
        for h in entry["hooks"]:
            if h.get("command") == hook_file:
                registered = True
                break
        if not registered:
            entry["hooks"].append(hook_cmd)
            registered = True
            print("  Registered UserPromptSubmit hook")
        break

if not registered:
    settings["hooks"]["UserPromptSubmit"].append({"hooks": [hook_cmd]})
    print("  Registered UserPromptSubmit hook")

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)

print("  settings.json updated")
PYEOF

# Install hook inline
HOOKS_DIR="${SETTINGS_DIR}/hooks"
mkdir -p "${HOOKS_DIR}"
cat > "${HOOKS_DIR}/web-search-skill-hook.sh" << 'HOOK_EOF'
#!/usr/bin/env bash
set -euo pipefail
PROMPT=$(cat)
[ -z "$PROMPT" ] && exit 0
case "$PROMPT" in
    *[Tt]rending*|*[Ll]atest*|*[Nn]ews*|*[Cc]urrent*|*[Rr]ecent*|*[Hh]appening*|*[Uu]pdate*|*[Ee]vents*|*[Ss]cores*|*[Ww]eather*|*[Pp]rices*|*[Ss]tocks*|202[5-9]|203[0-9])
        echo "Tip: Use /web-search for web queries. Example: /web-search latest trends"
        ;;
esac
exit 0
HOOK_EOF
chmod +x "${HOOKS_DIR}/web-search-skill-hook.sh"
echo "  Hook installed: ${HOOKS_DIR}/web-search-skill-hook.sh"

# Inject gateway URL and API key into SKILL.md
SKILL_MD="${SKILLS_DIR}/web-search/SKILL.md"
if [ -f "$SKILL_MD" ]; then
    echo "  Injecting configuration into SKILL.md..."
    sed -i.bak "s|__GATEWAY_URL__|${GATEWAY_URL}|g" "$SKILL_MD"
    sed -i.bak "s|__API_KEY__|${API_KEY}|g" "$SKILL_MD"
    rm -f "${SKILL_MD}.bak"
    echo "  Configuration injected"
fi

echo "Setup complete!"
