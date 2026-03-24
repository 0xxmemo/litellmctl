#!/usr/bin/env bash
# UserPromptSubmit hook - suggests /search for web queries
set -euo pipefail

PROMPT=$(cat)
[ -z "$PROMPT" ] && exit 0

case "$PROMPT" in
    *[Tt]rending*|*[Ll]atest*|*[Nn]ews*|*[Cc]urrent*|*[Rr]ecent*|*[Hh]appening*|*[Uu]pdate*|*[Ee]vents*|*[Ss]cores*|*[Ww]eather*|*[Pp]rices*|*[Ss]tocks*|202[5-9]|203[0-9])
        echo "Tip: Use /search for web queries. Example: /search latest trends"
        ;;
esac
exit 0
