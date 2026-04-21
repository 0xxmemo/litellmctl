# Changelog

All notable changes to litellmctl are documented here.

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
