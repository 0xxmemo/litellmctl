#!/usr/bin/env bash
# UserPromptSubmit hook - suggests /web-search for web queries
set -euo pipefail

PROMPT=$(cat)
[ -z "$PROMPT" ] && exit 0

case "$PROMPT" in
    *[Tt]rending*|*[Ll]atest*|*[Nn]ews*|*[Cc]urrent*|*[Rr]ecent*|*[Hh]appening*|*[Uu]pdate*|*[Ee]vents*|*[Ss]cores*|*[Ww]eather*|*[Pp]rices*|*[Mm]arket*|*[Tt]oday*|*[Yy]esterday*|*[Ww]eek*|*[Mm]onth*|*[Yy]ear*|*[Nn]ow*|*[Aa]nnounce*|*[Rr]elease*|*[Ll]aunch*|*[Dd]ebut*|*[Ff]irst*|*[Nn]ew*|*[Bb]reaking*|*[Dd]eveloping*|*[Jj]ust*|*[Rr]eport*|*[Ss]tudy*|*[Rr]esearch*|*[Pp]aper*|*[Aa]rticle*|*[Bb]log*|*[Pp]ost*|*[Tt]hread*|*[Dd]iscussion*|*[Ff]orum*|*[Rr]eddit*|*[Tt]witter*|*" [Xx] "*|*[Pp]opular*|*"well tested"*|*"well-tested"*|*"well known"*|*"well-known"*|*"well reviewed"*|*"well-reviewed"*|*"well regarded"*|*"well-regarded"*|*[Bb]ulletproof*|*[Rr]eliable*|*[Tt]rustworthy*|*[Pp]roven*|*[Vv]erified*|*[Aa]uthoritative*|*[Oo]fficial*|*[Rr]ecommended*|*"top rated"*|*"top-rated"*|*[Bb]est*|202[5-9]|203[0-9])
        echo "Tip: Use /web-search for web queries. Example: /web-search latest trends"
        ;;
esac
exit 0
