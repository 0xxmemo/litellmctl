---
name: claude-context
description: Semantic code search via local embeddings and sqlite-vec
type: mcp
---

## What it does

Registers an MCP server that exposes four tools to Claude Code:

- `index_codebase(path, force?, customExtensions?, ignorePatterns?)` — chunk + embed a codebase and store vectors in the gateway's sqlite-vec DB.
- `search_code(path, query, limit?, extensionFilter?)` — natural-language semantic search across indexed code.
- `clear_index(path)` — drop the collection and local merkle state.
- `get_indexing_status(path)` — progress / completion info.

All state lives on your machine: embeddings are generated via the LiteLLM gateway's `/v1/embeddings` route (local provider → Ollama), and vectors are persisted in the gateway's sqlite-vec store scoped to your API key.

## How it's wired

```bash
GATEWAY_URL=__GATEWAY_URL__
API_KEY=__API_KEY__
```

Embedding model and dimensions are fixed by the plugin (`local/nomic-embed-text` @ 512-d Matryoshka) — not configurable per install.

The MCP server is registered in `~/.claude.json` under top-level `mcpServers.claude-context` (user scope) via `claude mcp add-json -s user`, and runs via `bun run <plugin-src>/src/index.ts`. The `SessionStart` + `UserPromptSubmit` hooks are registered in `~/.claude/settings.json` — they shell out to the plugin's CLI subcommands because Claude Code's hook runner can't speak MCP stdio.

## Environment

| Var | Required | Default |
|---|---|---|
| `LLM_GATEWAY_URL` | yes | — |
| `LLM_GATEWAY_API_KEY` | yes | — |

<!-- TODO: migrate docs to LITELLMCTL_URL / LITELLMCTL_API_KEY without breaking deployments. -->
| `CLAUDE_CONTEXT_STATE_DIR` | no | `~/.claude/plugin-state/claude-context` |
| `EMBEDDING_BATCH_SIZE` | no | `64` |

## Uninstall

```
litellmctl plugins uninstall claude-context
```

Removes the `mcpServers.claude-context` entry from `~/.claude.json`, the SessionStart/UserPromptSubmit hooks from `~/.claude/settings.json`, and the plugin directory under `~/.claude/plugins/`. Local vector data in the gateway DB can be removed with `clear_index` before uninstalling, or left intact.
