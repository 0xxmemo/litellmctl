#!/usr/bin/env bash
# UserPromptSubmit hook - suggests /web-search for web queries
set -euo pipefail

PROMPT=$(cat)
[ -z "$PROMPT" ] && exit 0

case "$PROMPT" in
    */web-search*|*[Tt]rending*|*[Ll]atest*|*[Nn]ews*|*[Cc]urrent*|*[Rr]ecent*|*[Hh]appening*|*[Uu]pdate*|*[Ee]vents*|*[Ss]cores*|*[Ww]eather*|*[Pp]rices*|*[Ss]tocks*|*[Cc]rypto*|*[Tt]okens*|*[Mm]arket*|*[Tt]oday*|202[5-9]|203[0-9])
        echo "Tip: Use /web-search for web queries. Example: /web-search latest trends"
        ;;
esac
exit 0
