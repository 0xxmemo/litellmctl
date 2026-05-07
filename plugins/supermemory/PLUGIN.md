---
name: supermemory
description: Persistent memory + recall backed by local embeddings and sqlite-vec
type: mcp
---

## What it does

Registers an MCP server that gives Claude Code three tools for building
persistent memory across conversations:

- `memory({ content, action: "save" | "forget", project? })` — save a fact
  the user shares (preferences, goals, project info) or forget one that's
  outdated. Forget resolves by exact `(project, content)` hash first, then
  semantic similarity (threshold 0.85) inside the same project.
- `recall({ query, limit?, project? })` — semantic search over saved
  memories, markdown-formatted with percent-match and project tag.
- `whoAmI()` — identify which gateway account/email/teams this MCP is
  bound to. Useful for debugging.

All embeddings are generated via the LiteLLM gateway's `/v1/embeddings`
and vectors are persisted in the gateway's sqlite-vec store. Your API key
scopes the collection — nothing is sent to `api.supermemory.ai` or any
third party.

### Project scoping

Every memory lives in a named bucket. If you omit `project`, it lands in
`default`. Named buckets (e.g. `work`, `personal`, `gateway`) let you keep
facts about different contexts separate: `recall` with a project returns
only memories from that bucket. Slugs must match
`^[a-z0-9][a-z0-9._-]{0,63}$`.

### Limits

- `content` max 200,000 chars
- `query` max 1,000 chars
- `project` slug max 64 chars, regex above
- `recall.limit` max 50

## Wiring

```bash
GATEWAY_URL=__GATEWAY_URL__
API_KEY=__API_KEY__
```

The MCP server is registered in `~/.claude.json` (Claude Code's MCP loader
ignores `settings.json`) via `claude mcp add-json -s user supermemory ...`
and runs via `bun run /Users/anon/.litellm/plugins/supermemory/src/index.ts`.

Two hooks live in `~/.claude/settings.json` (where hooks do belong) and are
identified by path substrings so uninstall can strip them cleanly:

- `supermemory/hooks/recall-on-prompt.sh` — `UserPromptSubmit` auto-recall
- `supermemory/hooks/session-start.sh`    — `SessionStart` guidance nudge

## Session-start guidance hook (the "make the agent actually use it" path)

Install registers a `hooks.SessionStart` entry that runs
`hooks/session-start.sh` once per session and emits an `additionalContext`
block telling the agent:

- Memory is wired through the supermemory MCP tools (`memory`, `recall`,
  `whoAmI`) — this is the SINGLE source of truth.
- Do NOT use the system prompt's built-in file-based "auto memory" path
  (`~/.claude/projects/<slug>/memory/`, `MEMORY.md`). That backend is
  disabled in favor of MCP.
- Concrete triggers for `save` (preferences, working-style rules, feedback,
  external references, project facts) and `recall` (questions about the
  user, references to past work, start of non-trivial tasks).

Without this nudge, the system-prompt's file-based auto-memory section wins
by default and the agent never reaches for the MCP tools. Override via
`SUPERMEMORY_SESSION_NUDGE=0` in the hook env if you need to disable it.

## Auto-recall hook (the "efficient" path)

Install also registers a `hooks.UserPromptSubmit` entry (matched by the
`supermemory/hooks/recall-on-prompt.sh` path substring for clean uninstall)
that runs `hooks/recall-on-prompt.sh` on every user prompt. The hook:

1. Reads the prompt from the event JSON.
2. Skips trivial prompts (< 6 chars or starting with `!`).
3. Calls `/api/plugins/supermemory/search` with a 1.5 s timeout.
4. Injects hits above `SUPERMEMORY_RECALL_MIN_SIMILARITY` (default 0.50)
   as `hookSpecificOutput.additionalContext`.
5. Silently no-ops on any failure — the user never sees an error.

This means the agent gets relevant memories automatically without having
to decide to call `recall` itself. Override behavior via env on the hook
command (edit `settings.json`):

| Var | Default |
|---|---|
| `SUPERMEMORY_RECALL_MIN_SIMILARITY` | `0.50` |
| `SUPERMEMORY_RECALL_LIMIT` | `5` |
| `SUPERMEMORY_RECALL_PROJECT` | `default` |
| `SUPERMEMORY_RECALL_MAX_PROMPT` | `1000` (gateway cap) |

## Environment

| Var | Required | Default |
|---|---|---|
| `LLM_GATEWAY_URL` | yes | — |
| `LLM_GATEWAY_API_KEY` | yes | — |

<!-- TODO: migrate docs to LITELLMCTL_URL / LITELLMCTL_API_KEY without breaking deployments. -->

Embedding model (`bedrock/titan-embed-v2`, 1024-d) is fixed by the LiteLLM
control plane — not configurable.

## Data layout

Memories live in the gateway's `plugin_chunks` table under collection
`memories`, with vectors in `plugin_chunks_vec_1024`. Isolation is by
gateway user (via `plugin_ref_chunks` overlays); team memberships grant
read access to shared memories tagged under a team ref. Project slug is
stored in each memory's metadata JSON and filtered server-side via
`json_extract`. Forget is user-scoped — you cannot remove a teammate's
memory.
