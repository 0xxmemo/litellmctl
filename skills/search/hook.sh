#!/usr/bin/env bash
# Search skill hook - provides guidance when search-like prompts are detected
# This hook runs on UserPromptSubmit and outputs context for Claude to see
#
# Installation: The skill installer will copy this to ~/.claude/hooks/search-hook.sh
# and configure it in settings.json hooks

set -euo pipefail

PROMPT="${CLAUDE_USER_PROMPT:-}"

# Exit early if no prompt
[ -z "$PROMPT" ] && exit 0

# Keywords that suggest the user wants to search the web
# When detected, output a hint that Claude will see
SEARCH_KEYWORDS=(
    "research"
    "what is"
    "latest"
    "trending"
    "news"
    "current"
    "recent"
    "find.*information"
    "look up"
    "search for"
    "google.*this"
    "check.*online"
    "202[5-9]"
    "203[0-9]"
)

for keyword in "${SEARCH_KEYWORDS[@]}"; do
    if echo "$PROMPT" | grep -qiE "$keyword"; then
        # Output a system reminder that Claude will see
        cat << 'HINT'
<system-reminder>
The user appears to be asking for current/web information. The native WebSearch tool has been disabled. Use the /search skill instead:

  /search <your query here>

Example: /search latest TypeScript 5.8 features
</system-reminder>
HINT
        exit 0
    fi
done

# No search intent detected - exit silently
exit 0
