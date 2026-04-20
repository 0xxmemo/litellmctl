---
name: supermemory
description: Persistent memory + recall backed by local embeddings and sqlite-vec
type: mcp
---

## What it does

Registers an MCP server that gives Claude Code two tools for building
persistent memory across conversations:

- `memory({ content, action: "save" | "forget" })` — save a fact the user
  shares (preferences, goals, project info) or forget one that's outdated.
  Forget resolves by exact content match first, then semantic similarity.
- `recall({ query, limit? })` — semantic search over saved memories.

All embeddings are generated via the LiteLLM gateway's `/v1/embeddings`
(local Ollama, 512-d Matryoshka) and vectors are persisted in the gateway's
sqlite-vec store. Your API key scopes the collection — nothing is sent to
`api.supermemory.ai` or any third party.

## Wiring

```bash
GATEWAY_URL=__GATEWAY_URL__
API_KEY=__API_KEY__
```

The MCP server is registered in `~/.claude/settings.json` under
`mcpServers.supermemory` and runs via
`bun run /Users/anon/.litellm/plugins/supermemory/src/index.ts`.

## Environment

| Var | Required | Default |
|---|---|---|
| `LLM_GATEWAY_URL` | yes | — |
| `LLM_GATEWAY_API_KEY` | yes | — |

Embedding model (`local/nomic-embed-text`) and dimensions (`512`) are fixed
by the LiteLLM control plane — not configurable.

## Data layout

Memories live in the gateway's `plugin_chunks` table under collection
`memories`, with vectors in `plugin_chunks_vec_512`. Scoped by
`api_key_hash`, so rotating a key orphans the old memories. Purge with
the `forget` tool or drop the collection via the gateway admin tooling
before rotating.
