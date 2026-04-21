#!/usr/bin/env bash
# claude-context SessionStart hook.
#
# If the project is in a git repo, fire-and-forget an index/sync against the
# plugin CLI so the codebase is ready by the time the user submits a prompt.
# Honors $CLAUDE_PROJECT_DIR (set by Claude Code) and falls back to PWD.
set -u

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
ROOT=$(git -C "$PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$ROOT" ] || exit 0

[ "${CLAUDE_CONTEXT_AUTO_INDEX:-1}" = "1" ] || exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
    # Resolve from this script's location: hooks/ → plugin root.
    PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

STATE_DIR="${CLAUDE_CONTEXT_STATE_DIR:-$HOME/.litellm/plugin-state/claude-context}"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/auto-index.log"

# Fire-and-forget. Detached so the hook returns immediately.
nohup bun run "$PLUGIN_ROOT/src/index.ts" index --path "$ROOT" \
    >>"$LOG" 2>&1 </dev/null &
disown 2>/dev/null || true

# additionalContext: a one-line note for the model.
printf 'claude-context: indexing/syncing %s in background (log: %s)\n' "$ROOT" "$LOG"
