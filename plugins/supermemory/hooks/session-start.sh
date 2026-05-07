#!/usr/bin/env bash
# supermemory SessionStart hook.
#
# Injects strong, top-of-session guidance via `additionalContext` so the agent
# routes save/recall through the supermemory MCP tools instead of the system
# prompt's built-in file-based "auto memory" path.
#
# The MCP tool descriptions alone are not enough — Claude Code ships with a
# system-prompt section that directs the agent to write memory files under
# ~/.claude/projects/<slug>/memory/. Without an explicit override at session
# start, that path wins by default. This hook is the override.
#
# Wire: registered by install.sh under hooks.SessionStart in settings.json,
# identified by path substring `supermemory/hooks/session-start.sh` so the
# uninstaller can strip it cleanly. No env required — it just emits text.
set -u

# Skip when the user has explicitly disabled the nudge.
[ "${SUPERMEMORY_SESSION_NUDGE:-1}" = "1" ] || exit 0

cat <<'EOF'
[supermemory] Cross-session memory for this user is backed by the supermemory MCP server.

Tools: `mcp__supermemory__memory` (action: "save" | "forget"), `mcp__supermemory__recall`, `mcp__supermemory__whoAmI`.

This is the SINGLE source of truth for remembering things across conversations. DO NOT use the file-based "auto memory" system described in the system prompt's `auto memory` section — do NOT write to `~/.claude/projects/<slug>/memory/` and do NOT create or update `MEMORY.md`. That backend is disabled in favor of the MCP tools.

PROACTIVELY call `mcp__supermemory__memory` with action="save" when:
- The user shares a preference, working style, or rule ("I prefer X", "always Y", "stop doing Z").
- The user states a fact about themselves, their role, team, or stack.
- The user gives feedback that should shape future behavior — corrections AND confirmations of a non-obvious choice ("yeah that bundled PR was the right call").
- The user names an external resource (Linear project, Slack channel, dashboard, runbook) future-you would need to find again.
- The user shares a project goal, deadline, constraint, or stakeholder context not obvious from the code.
Use action="forget" when a memory is now wrong or the user asks you to drop it.

Call `mcp__supermemory__recall` when:
- The user asks something that depends on prior context about them or their projects.
- The user references past work ("like we did before", "the usual way").
- You're starting a non-trivial task and want relevant prior context — query once up front.

Note: a `UserPromptSubmit` hook auto-injects relevant memories on every prompt. If you see a `[supermemory] Relevant saved memories (auto-recalled):` block in additional context, the recall already ran — only call `recall` again if you need a different angle.
EOF
