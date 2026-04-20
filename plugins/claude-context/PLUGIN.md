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
EMBEDDING_MODEL=local/nomic-embed-text
```

The MCP server is registered in `~/.claude/settings.json` under `mcpServers.claude-context` and runs via `bun run /Users/anon/.litellm/plugins/claude-context/src/index.ts`.

## Environment

| Var | Required | Default |
|---|---|---|
| `LLM_GATEWAY_URL` | yes | — |
| `LLM_GATEWAY_API_KEY` | yes | — |
| `EMBEDDING_MODEL` | no | `local/nomic-embed-text` |
| `CLAUDE_CONTEXT_STATE_DIR` | no | `~/.litellm/plugin-state/claude-context` |
| `EMBEDDING_BATCH_SIZE` | no | `64` |

## Uninstall

```
litellmctl plugins uninstall claude-context
```

Removes the `mcpServers.claude-context` entry and the plugin directory under `~/.claude/plugins/`. Local vector data in the gateway DB can be removed with `clear_index` before uninstalling, or left intact.
