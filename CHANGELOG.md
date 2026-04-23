# Changelog

All notable changes to litellmctl are documented here.

## [1.6.2] - 2026-04-23

### Fixes

- **Plugin/skill install command broken on Linux (bash).** The Copy button in the gateway UI emitted an unquoted URL: `curl -fsSL ${baseUrl}/api/plugins/install.sh?slug=X&target=Y | KEY=... bash`. On bash, the `&` in the query string is parsed as the backgrounding operator, so curl was backgrounded — its stdout streamed the script body to the terminal while bash received empty stdin and exited without executing. The symptom (reported by users) was "pasting prints the bash script body, nothing runs." On Mac zsh with oh-my-zsh the bug was invisible because `url-quote-magic` + `bracketed-paste-magic` auto-escape `?` and `&` on paste; Linux bash has no such handler. Fix: URL is now double-quoted at the source in `plugins-install.tsx`, `skills-install.tsx`, and (defensively) `setup-widget.tsx`. The copied string is now `curl -fsSL "https://.../install.sh?slug=X&target=Y" | KEY=... bash` and pastes-and-runs cleanly in bash, zsh, and every other POSIX shell, regardless of terminal paste magic.

### Tests

- **Linux install-flow harness** (`tests/linux-harness/`, driver `./tests/linux-harness/run.sh`). Brings up a minimal Bun test gateway that imports the real `buildInstallScript` / `buildUninstallScript` and serves real bundles from `plugins/` and `skills/`, then runs an Ubuntu 24.04 container (bash + zsh + curl + tar + python3 + jq + bun, plus a stub `claude` CLI) that exercises every plugin and skill via `curl -fsSL … | bash` — both the unquoted form (negative control, expected XFAIL) and the quoted form (expected PASS) — in both shells. Success is verified via side effects on disk (`~/.claude/plugins/<slug>/PLUGIN.md`, `~/.claude/skills/<slug>/SKILL.md`, `settings.json` mutation), not echo markers, because the script body itself contains the success string and would false-positive when curl is accidentally backgrounded.

## [1.6.1] - 2026-04-22

### Features

- **Supermemory: project scoping.** Memories now carry a `project` slug (default `default`). Save/forget/search/usage all honor it, and the same content in two projects hashes to distinct IDs — no cross-project forget collisions. The MCP `memory` and `recall` tools gained a `project` field; the UI's recent-memories list shows a per-entry chip and a client-side project selector.
- **Supermemory: auto-recall hook.** Installer now registers `hooks.UserPromptSubmit` pointing at `plugins/supermemory/hooks/recall-on-prompt.sh`. On every user prompt the hook POSTs to `/api/plugins/supermemory/search` with a 1.5 s hard timeout and injects hits above a similarity floor (default 0.50) as `hookSpecificOutput.additionalContext` — the agent gets relevant context automatically without having to call `recall`. Fail-open on every error path; a down gateway never surfaces to the user. Tagged with `_tag: "supermemory"` so uninstall strips only our entry. Tunable via `SUPERMEMORY_RECALL_{MIN_SIMILARITY,LIMIT,PROJECT,MAX_PROMPT}`.
- **Supermemory: `whoAmI` tool and `/whoami` endpoint.** Returns `{email, role, teams}` so the agent can verify which gateway account the MCP is bound to without making it guess from side channels.
- **Vectordb: `metadata.<key>` filter.** `parseFilterExpr` now accepts `metadata.<key> in ["a","b"]` backed by SQLite's `json_extract`. Additive — no existing caller changes. `ParsedFilter` became a discriminated union (`{kind: "column"} | {kind: "metadata"}`); `searchVectors`, `searchHybrid` FTS branch, and `queryByFilter` all emit the appropriate WHERE fragment. This unblocked supermemory project scoping without overloading `relativePath`.
- **Hybrid vector + FTS5 search** for code/memory lookups. Vector KNN and BM25 run in parallel, results fused with Reciprocal Rank Fusion (`RRF_K = 60`) so literal-keyword hits the embedder misses (e.g. "heartbeat", "staleness reaper") get rescued by FTS while concept queries stay carried by the vector side.
- **`pick-model` skill.** Ships `/m-<model>` slash commands (one per configured model) for fast switching in Claude Code. Install/uninstall scripts wire them into `~/.claude/commands`.
- **`ssm-ops` skill.** `ssm-run` script + docs for executing commands on the production EC2 instance via AWS SSM (git pull, restart gateway, tail logs, hotfixes) — handles the litellmctl PATH and `systemd --user` gotchas.
- **Claude-context: job controls.** Admin can cancel running indexing jobs, clear completed/failed jobs from the UI, and the background worker now detects and reaps stale jobs (PID dead / heartbeat expired) so a crashed indexer doesn't block future runs. Job failure messages surface cleanly in the status endpoint.
- **Claude-context: grep-nudge hook.** `UserPromptSubmit` hook that detects `grep`/`rg` invocations in the prompt and nudges the agent to use semantic search instead when a codebase is indexed. State lives under `~/.claude/plugin-state/`.
- **Claude-context: scope tree + branch/codebase management.** Directory-structure visualization in the usage panel; codebases are identity-keyed on the `origin` remote with a per-branch working-tree overlay so the same repo indexed on multiple branches shares embeddings for unchanged files.
- **Server-side plugin registry.** `gateway/lib/plugin-registry.ts` now owns plugin route mounting at `/api/plugins/<slug>/<relpath>` with a typed `GatewayPlugin` contract (routes, `migrate()` hook). Both `claude-context` and `supermemory` migrated onto it.
- **Admin: restart gateway from the UI.** New admin endpoint triggers a full gateway restart. The self-restart path was reworked so the service actually completes the restart when invoked from within itself (previously the parent process would kill the reloader mid-exec).
- **AWS Bedrock Titan embeddings.** New `env.example` entries and provider template for `bedrock/titan-embed-v2` (1024-d). Supermemory's embedding model moved off local Ollama to Titan for consistent quality across the install; on startup the plugin's `migrate()` drops stale-dim collections so the 512→1024 cutover is seamless (no memories were in production).

### Fixes

- **Vectordb KNN collection filter.** `vec0` rejects WHERE constraints on auxiliary columns, so filtering by `collection` inside the KNN MATCH was silently dropping rows whenever a dimension was shared across multiple collections. The KNN now runs unscoped with a generous over-fetch proportional to `collections-per-dim`, and `collection` is re-applied in the follow-up join. Without this, collections with many sibling collections at the same dimension returned near-empty result sets.
- **Gateway restart mid-service.** `bin/gateway-launch.sh` and the systemd unit were racing: the admin endpoint kicked off a restart, which killed its own parent before the child had exec'd. Sequencing fixed; restart completes reliably when triggered from the UI.
- **Claude-context validation + staleness.** Tighter validation in vectordb writes and the claude-context job loop; stale jobs (crashed indexer, dead PID) now get reaped automatically instead of blocking new indexing runs for the same codebase.

### Changes

- **Plugins/skills installer refactor.** `plugins-install` and `skills-install` components collapsed to a compact list layout (row-per-entry with select dropdown defaulting to index 0) — scales past the ~4 plugins point where the old stacked-card grid got unwieldy. Skill installers ship as tarball bundles (same pattern plugins already used) so adding a new file no longer needs a new route.
- **Oversized-file chunking** in claude-context: files larger than the token budget are now split along semantic boundaries instead of hard byte cuts, improving retrieval quality on monolithic source files.
- **Plugin-state paths standardized** to `~/.claude/plugin-state/` for every plugin (grep-nudge, claude-context, supermemory) so nothing gets committed to user repos and all state lives in one predictable place.
- **Auth page branding.** Icons replaced with the logo image.

## [1.6.0] - 2026-04-21

### Features

- **Request list: proximity grouping.** `/api/stats/requests` now merges rows with the same `(provider|model|endpoint)` key that fall within a time window *even when rows of other models appeared in between* — so an "opus session" with a stray gpt-5-mini call inside it shows as one opus group instead of being sliced into three. Default window is **60 min**, tunable per request via `?proximity=30m|2h|90m|45s` (min 1 min, max 24 h). Previously the handler only merged immediately-consecutive rows, producing dozens of tiny stacks whenever a workflow hopped between models. Open-group state is held in a `Map<groupKey, OpenGroup>`; groups seal automatically when the next DESC row is more than the window older than the group's oldest item. Scan capped at 5 000 rows as a runaway safety.
- **`image-generation` skill.** New Claude-Code skill installed from `http://<gateway>/api/skills/install.sh?slug=image-generation`. Hits `/v1/images/generations` with the pre-baked gateway API key, auto-discovers the first configured `image_generation` model, decodes the base64 response to a local file, prints the path. Replaces the `/mcp` endpoint (deleted) — no separate credential for the agent.
- **Skill installer: tarball bundles.** Skills now ship as a single gzipped tarball (`/api/skills/bundle.tar.gz?slug=…`) extracted into the target skill dir — same pattern plugins already used. Adding a new file to a skill (e.g. `run.sh`) no longer requires a new gateway route. `/api/skills/hook.sh` and `/api/skills/run.sh` removed.
- **App version in header.** `use-app-version.ts` pulls the latest GitHub release tag and renders it in the dashboard layout so users can tell at a glance which version is running vs available.

### Changes

- **Hook files renamed** from `useFoo.ts` to `use-foo.ts` to match the repo's kebab-case convention; CLAUDE.md updated. Component imports migrated in one pass.
- **UI polish.** Shared `provider-badge-class` utility for consistent styling across pages, standardized role-badge variants, color-consistency pass, glassmorphism pane tweaks, overview/admin/settings/user-stats page cleanups.
- **API keys table:** removed the key-ID column + copy-ID button (internal detail, not actionable — the key itself is still creatable/revokable).

### Removed

- **`web-search` skill.** Redundant — search is handled directly by the gateway's `/api/search` endpoint; the skill was a thin curl wrapper around it.
- **`/mcp` endpoint.** Superseded by the `image-generation` skill. The MCP route required its own `Authorization: Bearer` header which duplicated the LLM API key and confused agents; the skill uses the existing gateway-baked key with no extra config.
- **Per-file skill routes.** `/api/skills/hook.sh` and `/api/skills/run.sh` collapsed into the tarball bundle endpoint.

## [1.5.8] - 2026-04-21

### Fixes

- **Plugin usage endpoints return 500.** `/api/plugins/claude-context/usage` and `/api/plugins/supermemory/usage` were still querying the pre-v2 `api_key_hash` column that was removed by `feat(vectordb): refactor for global shared collections and branch-level isolation`, so every request threw `SQLiteError: no such column: api_key_hash`. Both handlers are rewritten against the v2 schema: claude-context stats report the gateway-wide view of `code_chunks_*` collections (shared across keys in v2), supermemory stats stay user-scoped via the `user:<email>` + team-ref overlays (same auto-scoping the search path uses). UI copy for the claude-context table updated to match the shared model.

## [1.5.7] - 2026-04-21

### Fixes

- **Gateway boot crash on pre-v2 DB.** `connectDB()` dropped legacy `plugin_chunks_vec_*` virtual tables before `tryLoadVec()` ran, so SQLite raised `no such module: vec0` and the bun process exited ~120ms after startup — leaving port 14041 dark and v1.5.6 releases failing the deploy smoke test. The vec0 extension is now loaded up front, and the DROP is wrapped in a fallback that clears `sqlite_master` directly if vec0 is unavailable so startup never crashes on legacy data.

## [1.5.6] - 2026-04-21

### Features

- **Image generation.** New `google` provider template with `nano-banana-pro` (gemini-3-pro-image-preview) and `nano-banana` (gemini-2.5-flash-image). `GOOGLE_AI_API_KEY` gates wizard visibility and the `/api/health` `image` flag. Wizard YAML generator now emits a top-level `image_models` section.
- **Native MCP endpoint.** `POST /mcp` speaks JSON-RPC 2.0 (Streamable HTTP, stateless) and exposes `generate_image` as an MCP tool. Register with `claude mcp add --transport http …` — Claude Code then calls `/v1/images/generations` without the user pasting endpoints. Tool hides from `tools/list` when `imageGenerationHealthy()` is false.
- **Centralized feature health.** `gateway/lib/features.ts` is the single source of truth for feature gating; `/api/health` gains `features.image`.
- **Plugin stats.** New monitoring endpoints for plugin usage.
- **Team management.** Admin panel for team creation / membership; vectordb collections unioned across team members, writes stay per-user.
- **UI.** Glassmorphism styling; ModelSelector dropdown positioning fixes; logout moved into SettingsPanel.
- **Claude-context plugin.** PID-file lock, state dir resolution, session-start + user-prompt-submit hooks, bundled source shipped via the plugin endpoint.
- **Docs.** Added AGENTS.md and CLAUDE.md.

### Fixes

- **`/v1/audio/transcriptions` 422.** Gateway proxy now converts JSON bodies with `{file: "data:audio/...;base64,..."}` into multipart `FormData` before forwarding to LiteLLM. Existing multipart uploads are untouched.
- **sqlite-vec install.** Now pulled from GitHub Releases (macOS + Linux) instead of npm; idempotent.

### Breaking / Rename

- Product name rebranded **"LLM API Gateway" → "LitellmCTL"** across UI and docs. No code imports broke — `bin/litellmctl` CLI name was already the canonical form.

## [1.1.0] - 2026-03-18

### Breaking / Architecture

- `bin/litellmctl` replaced with thin bash shim (~30 lines) + `bin/lib/` Python package
- `bin/auth` (1,487-line Python monolith) removed - logic moved to `bin/lib/auth/`
- `bin/wizard` (822-line Python monolith) removed - logic moved to `bin/lib/wizard/`
- `bin/toggle-claude` (jq-dependent bash) removed - logic moved to `bin/lib/commands/toggle_claude.py`

### Interactive Menu

- questionary-based menu with custom style (cyan pointer, green selection, dark separators)
- Dynamic state-aware choices (start disabled when proxy running; stop/restart/logs disabled when stopped)
- Proxy state shown inline in header (e.g., `litellmctl  proxy running :4040`)
- `>` prompt with arrow-key instruction hint
- Auth submenu with login/manage sections and `back` option

### New Commands / Flags

- `litellmctl start/stop/restart/status/logs gateway` - manage LitellmCTL UI (unified with the other features)
- `litellmctl install --with-protonmail / --without-protonmail` flag
- ProtonMail (hydroxide) install/uninstall support

### Improvements

- `toggle-claude` no longer requires `jq` (pure Python reads/writes `~/.claude/settings.json`)
- PYTHONPATH fix: `litellmctl` shim sets `PYTHONPATH=$BIN_DIR` so `python3 -m lib` works from any directory
- pip install now includes `pytest` + `pytest-timeout` for testing

### Tests

- 87 pytest tests in `bin/tests/`
- pytest.ini: `testpaths = tests`, `pythonpath = .`, `timeout = 10`
- Coverage: env, completions, DB URL parsing, PKCE/JWT (auth/core), wizard models, Typer CLI routing, interactive menu with mocked questionary

## [1.0.0] - 2026-03-05

First stable release. Full-featured personal LiteLLM proxy with OAuth providers,
local inference, PostgreSQL usage tracking, and a complete CLI.

### CLI (`bin/litellmctl`)

- **Interactive mode** — running `litellmctl` with no arguments opens a full
  numbered menu; each sub-flow has graceful Ctrl+C handling via `trap`
- **`litellmctl install`** — installs the venv and editable litellm fork; prompts
  for PostgreSQL setup and local inference servers separately; auto-restores
  previously enabled features on re-run without prompting; new flags:
  `--with-embedding`, `--without-embedding`, `--with-transcription`,
  `--without-transcription` (in addition to `--with-db / --without-db`,
  `--with-local / --without-local`)
- **`litellmctl start [--port N]`** — starts proxy as a background system service
  (launchd on macOS, systemd on Linux, nohup fallback); auto-starts on login,
  restarts on crash
- **`litellmctl stop / restart / logs / status / proxy`** — service lifecycle
- **`litellmctl auth <provider>`** — OAuth login for chatgpt, gemini, qwen, kimi;
  detects headless/SSH environments and prints URL for manual browser auth
- **`litellmctl auth refresh <p>`** — refresh a single provider's token
- **`litellmctl auth export [p...]`** — copy credentials as a self-contained bash
  script to clipboard for machine-to-machine transfer
- **`litellmctl auth import`** — read credentials from stdin
- **`litellmctl auth status`** — show token expiry for all providers
- **`litellmctl wizard`** — interactive `config.yaml` generator; reads provider
  templates from `templates/*.yaml`; backs up existing config before writing
- **`litellmctl update`** — git pull, sync submodule, rebuild venv, restart service
- **`litellmctl uninstall [service|db|embedding|transcription]`** — consolidated
  uninstall; interactive menu when called with no target; replaces former
  `uninstall-service` and `local uninstall` commands
- **`litellmctl local [status]`** — check Ollama and faster-whisper-server
  reachability
- **`litellmctl toggle-claude`** — switch Claude Code between direct Anthropic API
  and the local proxy
- **`litellmctl setup-completions`** — install bash and zsh tab completions

### OAuth providers (`bin/auth`)

- **ChatGPT / Codex** — PKCE flow, tokens stored in `auth.chatgpt.json`
- **Gemini CLI** — PKCE flow via Google Code Assist API; OAuth credentials
  auto-extracted from the installed `@google/gemini-cli` npm binary at runtime
- **Qwen Portal** — device-code flow, tokens stored in `auth.qwen_portal.json`
- **Kimi Code** — device-code flow; syncs with kimi-cli's own credentials;
  tokens stored in `auth.kimi_code.json`
- Dynamic provider discovery: `bin/auth providers` outputs `key|label` pairs;
  `_auth_interactive` in litellmctl reads this at runtime (no hardcoded list)

### Config wizard (`bin/wizard`)

- Loads all provider templates from `templates/*.yaml` dynamically
- Probes each provider for readiness (API key present / OAuth token valid /
  local servers reachable) and shows a readiness summary
- Per-tier primary provider selection and reorderable fallback chains
- Writes a clean `config.yaml` with `model_group_alias` + `fallbacks` pattern
- Correct health check for faster-whisper-server: probes
  `/audio/transcriptions` (accepts any HTTP response) rather than `/v1/models`
  which returns 404
- Strips surrounding quotes from `.env` values so systemd-quoted URLs parse
  correctly

### Database setup

- Auto-bootstraps a local PostgreSQL role and database (`litellm`)
- Writes `DATABASE_URL`, `DISABLE_SCHEMA_UPDATE`, `STORE_MODEL_IN_DB`,
  `STORE_PROMPTS_IN_SPEND_LOGS`, `PROXY_BATCH_WRITE_AT` to `.env`
- `_patch_db_env_flags` is idempotent — restores missing flags on every
  `litellmctl install` run
- Privilege repair: attempts automatic `GRANT` / role creation, uses `sudo`
  when needed
- `litellmctl uninstall db` removes DB config from `.env`; does not drop the
  database

### Local inference servers

- **Embedding (Ollama)** — installs Ollama if missing (Homebrew or curl script);
  starts the service; pulls `nomic-embed-text` and `mxbai-embed-large`;
  uses litellm's built-in `ollama/<model>` provider with
  `api_base: os.environ/LOCAL_EMBEDDING_API_BASE`
- **Transcription (faster-whisper-server)** — installs via `uv tool install
  faster-whisper-server`; patches the missing `pyproject.toml` in the PyPI
  wheel (upstream packaging bug) so `_get_version()` does not crash on import;
  starts server with a configurable model
  (`LOCAL_TRANSCRIPTION_MODEL`, default `Systran/faster-whisper-tiny`);
  uses litellm's `openai/<model>` provider with
  `api_base: os.environ/LOCAL_TRANSCRIPTION_API_BASE`
- `LOCAL_TRANSCRIPTION_API_BASE` must include the `/v1` suffix (e.g.
  `http://localhost:10300/v1`) — LiteLLM's OpenAI SDK appends
  `/audio/transcriptions` directly to `api_base`
- Both env vars are quoted in `.env` to survive systemd's EnvironmentFile
  parser (`://` in unquoted values is silently dropped by systemd ≥ 255)
- `_patch_local_env_defaults` writes both vars unconditionally during install
  so `os.environ/` references in `config.yaml` always resolve even on machines
  without local servers

### LiteLLM fork (`litellm/` submodule → `0xxmemo/litellm`)

New providers on top of upstream `BerriAI/litellm`:

| Provider | Backend | Auth |
|---|---|---|
| `gemini_cli` | Google Code Assist API (`cloudcode-pa.googleapis.com`) | OAuth Bearer |
| `kimi_code` | Moonshot Kimi Code API (`api.kimi.com/coding/v1`) | OAuth Bearer + agent headers |
| `qwen_portal` | Qwen Portal API (`portal.qwen.ai/v1`) | OAuth Bearer |
| `chatgpt` / `codex` | OpenAI Responses API | OAuth Bearer |
| `dashscope` | Alibaba DashScope Coding Plan (`https://coding-intl.dashscope.aliyuncs.com/v1`) | API key (`DASHSCOPE_API_KEY`) |

- System prompt injection callback (`bin/system_prompt_injection.py`) —
  pre-call hook that injects a configurable system prompt on all requests
- Token auto-refresh on expiry for all OAuth providers
- Updated model prices / context windows for all custom providers

### Templates (`templates/`)

| Template | Provider | Role |
|---|---|---|
| `anthropic.yaml` | Anthropic (Claude) | primary |
| `chatgpt.yaml` | ChatGPT / Codex | fallback |
| `kimi_code.yaml` | Kimi Code (K2.5) | fallback |
| `gemini_cli.yaml` | Gemini CLI | fallback |
| `qwen_portal.yaml` | Qwen Portal | fallback |
| `dashscope.yaml` | Alibaba Cloud Coding Plan | fallback |
| `minimax.yaml` | MiniMax | fallback |
| `zai.yaml` | Z.AI (GLM) | fallback |
| `local.yaml` | Local inference (Ollama + faster-whisper) | supplemental |

### Models

Three consumer-facing tiers (`opus`, `sonnet`, `haiku`), each with a
multi-provider fallback chain:

| Tier | Primary | Fallback chain |
|---|---|---|
| `opus` (`claude-opus-4-6`) | Codex `gpt-5.3-codex` | qwen3.5-plus → kimi-for-coding → claude-opus-4-6 → glm-5 → gemini-2.5-pro → MiniMax |
| `sonnet` (`claude-sonnet-4-5`) | Codex `gpt-5.3-codex-spark` | qwen3-coder-plus → qwen3-coder-plus → glm-4.5-air → kimi-for-coding → gemini-2.5-flash → MiniMax |
| `haiku` (`claude-haiku-4-5`) | Codex `gpt-5.1-codex-mini` | qwen3-vl-plus → qwen3-coder-next → claude-haiku-4-5 → glm-4.5-flash → gemini-2.5-flash-lite → MiniMax |

All backend models are directly addressable by full name
(e.g. `codex/gpt-5.3-codex`, `gemini-cli/gemini-2.5-pro`).

### Bug fixes

- `(( var++ ))` with zero-initialized counter silently exits under
  `set -euo pipefail` — fixed all four occurrences in polling loops to
  `var=$(( var + 1 ))`
- `exec python3` in interactive loop replaced with regular subprocess call —
  `exec` replaces the shell process and terminates the interactive menu
- faster-whisper-server PyPI wheel missing `pyproject.toml` — patched with a
  stub so `_get_version()` succeeds without reinstall
- faster-whisper-server health check used `/v1/models` (returns 404) — changed
  to probe `/audio/transcriptions` and accept any HTTP response
- systemd drops unquoted URLs containing `://` from EnvironmentFile — quoted
  `LOCAL_EMBEDDING_API_BASE` and `LOCAL_TRANSCRIPTION_API_BASE` in all `.env`
  writes
- `LOCAL_TRANSCRIPTION_API_BASE` missing `/v1` suffix caused 404s — LiteLLM's
  OpenAI SDK appends `/audio/transcriptions` (not `/v1/audio/transcriptions`)
  to `api_base`
