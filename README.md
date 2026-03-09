# litellmctl

Personal LiteLLM proxy control using a [fork of litellm](https://github.com/0xxmemo/litellm) (upstream: [BerriAI/litellm](https://github.com/BerriAI/litellm)).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/0xxmemo/litellmctl/main/install.sh | bash
```

Works on **macOS** and **Ubuntu/Debian**. Safe to re-run — it won't clobber your existing
`config.yaml`, `.env`, or auth token files.

If `~/.litellm` already exists (e.g. from litellm's own config), the installer backs up
your files, clones the repo, then restores everything on top.

After install, load the CLI and start the proxy:

```bash
source ~/.zshrc            # or ~/.bashrc
litellmctl auth gemini     # authenticate any OAuth providers you use
litellmctl auth chatgpt
litellmctl auth qwen
litellmctl auth kimi
litellmctl start           # background service, auto-starts on boot
```

`install` now prompts whether to set up a local PostgreSQL database and, by
default, does it automatically.
No manual DB step is required.
If PostgreSQL is installed but not running, it will be started automatically.
`DATABASE_URL` is written to `.env` on first run if not already present.

### Config wizard

Generate a `config.yaml` interactively — pick your primary provider, select
fallback providers, and reorder fallback chains per tier:

```bash
litellmctl wizard
```

The wizard backs up your existing `config.yaml` before writing. It's re-runnable:
each invocation regenerates the config from scratch (after backup). Provider
templates live in `templates/*.yaml` and update automatically with
`litellmctl update`. Edit or add YAML files there to customise providers.

### Manual install (alternative)

```bash
git clone https://github.com/0xxmemo/litellmctl.git ~/.litellm
cd ~/.litellm
bin/install                # installs venv + litellm
cp .env.example .env       # fill in your API keys
litellmctl setup-completions
source ~/.zshrc
litellmctl install         # prompts for local DB setup (recommended)
```

### Update

```bash
litellmctl update          # pull latest, sync submodule, rebuild & restart
```

## CLI

```
litellmctl wizard                       Interactive config.yaml generator (providers, tiers, fallbacks)
litellmctl install [--with-db|--without-db] [--with-local|--without-local]
                   [--with-embedding|--without-embedding]
                   [--with-transcription|--without-transcription]
                                        Install / rebuild LiteLLM (prompts for DB + local server setup)
litellmctl auth chatgpt                 Login to ChatGPT / Codex (PKCE)
litellmctl auth gemini                  Login to Gemini CLI (PKCE)
litellmctl auth qwen                    Login to Qwen Portal (device-code)
litellmctl auth kimi                    Login to Kimi Code (device-code)
litellmctl auth refresh <p>             Refresh token for chatgpt, gemini, qwen, or kimi
litellmctl auth export [p...]           Copy credentials as a paste-able transfer script
litellmctl auth import                  Read credentials from stdin
litellmctl auth status                  Show token expiry info
litellmctl start [--port N]             Start proxy as background service (auto-start on boot)
litellmctl stop                         Stop the proxy service
litellmctl restart                      Restart the proxy service
litellmctl logs                         Tail proxy logs
litellmctl proxy [--port N]             Start proxy in foreground (for debugging)
litellmctl status                       Auth + proxy + local servers + database status at a glance
litellmctl local [status]               Check local inference server reachability
litellmctl uninstall [service|db|embedding|transcription]
                                        Stop and remove the proxy service, DB config, or local servers
litellmctl toggle-claude                Toggle Claude Code between direct API and proxy
litellmctl setup-completions            Add litellmctl to your shell (alias + tab completion)
```

`start` and `restart` install a system service (macOS: launchd, Linux: systemd)
that auto-starts on login and restarts on crash.
Use `proxy` for foreground mode when debugging.

### Database

Usage tracking, spend logs, and key management are stored in a local PostgreSQL
database. Setup is fully automatic:

- **`install`** — prompts for DB setup (default: yes); if already configured, re-ensures it's ready
- **`start` / `restart`** — start the proxy service (do not modify DB setup)
- **Automation flags** — `litellmctl install --with-db` or `--without-db`
- **Permission handling** — installer attempts automatic Postgres role/database
  bootstrap and privileges repair (uses `sudo` when needed)
- **Always uses latest logic** — if install pulls a newer repo version, it
  automatically reloads the updated `litellmctl` script in the same run
- **To disable DB** — use `litellmctl uninstall db` (removes config from `.env`; database is not dropped)

If PostgreSQL is installed but not running, install-time DB setup will start it
automatically. When DB setup is enabled, the following are written to `.env`:

| Variable | Value | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://…/litellm` | Prisma connection string |
| `DISABLE_SCHEMA_UPDATE` | `true` | Skip Prisma schema sync on every boot |
| `STORE_MODEL_IN_DB` | `true` | Persist model/credential info in the DB |
| `STORE_PROMPTS_IN_SPEND_LOGS` | `true` | Store prompt + response content in spend logs |
| `PROXY_BATCH_WRITE_AT` | `10` | Batch-write spend logs every N seconds |

To check database connectivity:

```bash
litellmctl status   # shows DB URL + connection status
```

### Transferring credentials between machines

Export credentials from one machine and paste them on another:

```bash
# On source machine — copies a self-contained bash script to clipboard
litellmctl auth export              # interactive: pick which providers
litellmctl auth export chatgpt kimi # or specify directly

# On target machine — just paste the script into the terminal
# (no litellmctl required on the target)
```

If litellmctl is already installed on the target, the script also runs
`init-env` to sync `.env` paths automatically.

### Server / headless usage

`litellmctl auth` detects headless environments (SSH, no display, Docker)
and prints the OAuth URL for you to open in a local browser. After
authenticating, either:

- **Paste** the redirect URL back into the terminal, or
- **SSH tunnel** the callback port so it's captured automatically:
  ```
  ssh -L 8085:localhost:8085 your-server   # Gemini
  ssh -L 1455:localhost:1455 your-server   # ChatGPT
  ```

## Project Layout

```
.litellm/
├── install.sh          One-line curl installer (bash)
├── bin/
│   ├── litellmctl      CLI runner (bash, with tab-completion)
│   ├── auth            OAuth login & refresh (python)
│   ├── wizard          Config wizard, loads templates/ (python)
│   ├── install         Venv + editable pip install (bash)
│   └── toggle-claude   Toggle Claude Code between direct API and proxy
├── templates/          Provider & defaults YAML for the wizard
│   ├── defaults.yaml   Tiers, fallback order, router/litellm/general settings
│   ├── anthropic.yaml  Anthropic (Claude) — primary
│   ├── kimi_code.yaml  Kimi Code — fallback
│   ├── gemini_cli.yaml Gemini CLI — fallback
│   ├── qwen_portal.yaml Qwen Portal — fallback
│   ├── dashscope.yaml  Alibaba Cloud Coding Plan — fallback
│   ├── chatgpt.yaml    ChatGPT / Codex — fallback
│   ├── minimax.yaml    MiniMax — fallback
│   ├── zai.yaml        Z.AI (GLM) — fallback
│   └── local.yaml      Local inference servers — embedding + transcription
├── litellm/            Git submodule → 0xxmemo/litellm fork
├── config.yaml         Proxy model routing, fallbacks, environment vars
├── .env                API keys & OAuth secrets (git-ignored, DATABASE_URL auto-added)
├── .env.example        Template for .env
├── auth.chatgpt.json   ChatGPT OAuth tokens (git-ignored, auto-refreshed)
├── auth.gemini_cli.json Gemini CLI OAuth tokens (git-ignored, auto-refreshed)
├── auth.qwen_portal.json Qwen Portal OAuth tokens (git-ignored, auto-refreshed)
├── auth.kimi_code.json Kimi Code OAuth tokens (git-ignored, auto-refreshed)
├── logs/               Service logs (git-ignored)
└── venv/               Python virtualenv (git-ignored)
```

## Models & Fallbacks

Three consumer-facing tiers, each with a fallback chain:

| Tier   | Fallback 1 (Codex)          | Fallback 2 (Alibaba Cloud)        | Fallback 3 (Kimi Code)           | Fallback 4 (MiniMax)                | Fallback 5 (Z.AI)   |
| ------ | --------------------------- | --------------------------------- | -------------------------------- | ----------------------------------- | ------------------- |
| `ultra`   | `codex/gpt-5.3-codex`       | `dashscope/qwen3.5-plus`          | `kimi-code/kimi-for-coding`      | `minimax/MiniMax-M2.5-highspeed`    | `zai/glm-5`         |
| `plus`    | `codex/gpt-5.3-codex-spark`  | `dashscope/qwen3-coder-plus`      | `kimi-code/kimi-for-coding`      | `minimax/MiniMax-M2.5-highspeed`    | `zai/glm-4.5-air`   |
| `lite`    | `codex/gpt-5.1-codex-mini`  | `dashscope/qwen3-max`             | `qwen-cli/qwen3-vl-plus`        | `minimax/MiniMax-M2.5-highspeed`    | `zai/glm-4.5-flash` |

All backend models are also directly addressable by their full name
(e.g. `codex/gpt-5.3-codex`, `dashscope/qwen3-coder-plus`, `kimi-code/kimi-for-coding`, `gemini-cli/gemini-2.5-pro`, `zai/glm-5`).

### Available providers

| Provider        | Auth                     | Models                                                                                                                       |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic**   | API key                  | `claude-opus-4-6` (ultra), `claude-sonnet-4-6` (plus), `claude-haiku-4-5` (lite)                                             |
| **Kimi Code**   | Kimi OAuth (device-code) | `kimi-code/kimi-for-coding` (K2.5)                                                                                           |
| **Qwen Portal** | Qwen OAuth (device-code) | `qwen-cli/qwen3-coder-plus` (plus), `qwen-cli/qwen3-vl-plus` (lite)                                                          |
| **Alibaba Cloud** | API key (Coding Plan)  | `dashscope/qwen3.5-plus` (ultra), `dashscope/qwen3-coder-plus` (plus), `dashscope/qwen3-max` (lite)                          |
| **Codex**       | ChatGPT OAuth            | `codex/gpt-5.3-codex` (ultra), `codex/gpt-5.3-codex-spark` (plus), `codex/gpt-5.1-codex-mini` (lite)                         |
| **Gemini CLI**  | Google OAuth             | `gemini-cli/gemini-2.5-pro` (ultra), `gemini-cli/gemini-2.5-flash` (plus), `gemini-cli/gemini-2.5-flash-lite` (lite)         |
| **MiniMax**     | API key                  | `minimax/MiniMax-M2.5-highspeed` (all tiers)                                                                                 |
| **Z.AI**        | API key                  | `zai/glm-5` (ultra), `zai/glm-4.5-air` (plus), `zai/glm-4.5-flash` (lite), plus others                                      |
| **Local**       | none                     | Embedding: `local/nomic-embed-text`, `local/mxbai-embed-large`, `local/bge-m3`, `local/all-minilm` · Transcription: `local/whisper`, `local/whisper-large-v3`, `local/whisper-large-v3-turbo`, `local/distil-whisper-large-v3` |

## Gemini CLI Provider

The fork adds a `gemini_cli` provider that routes through Google's Code Assist API
(`cloudcode-pa.googleapis.com`) using OAuth Bearer tokens — the same backend the
official [Gemini CLI](https://github.com/google-gemini/gemini-cli) uses.

**How it works:**

1. `litellmctl auth gemini` performs an OAuth 2.0 PKCE login with Google, saves
   tokens to `auth.gemini_cli.json`, and discovers your Code Assist project.
2. The provider reuses LiteLLM's existing Gemini request/response transformers
   while adding OAuth Bearer auth and the Code Assist request envelope.
3. Tokens auto-refresh on expiry; re-run `litellmctl auth gemini` if they expire
   completely.

OAuth client credentials are auto-extracted from the installed Gemini CLI binary
(`npm i -g @google/gemini-cli`) at runtime — no manual env vars needed.

## Kimi Code Provider

The fork adds a `kimi_code` provider that routes through Moonshot's Kimi Code API
(`api.kimi.com/coding/v1`) using OAuth Bearer tokens — the same backend the official
[Kimi CLI](https://code.kimi.com) uses.

**Prerequisites:**

```bash
curl -LsSf https://code.kimi.com/install.sh | bash   # install kimi-cli (creates device ID)
```

**How it works:**

1. `litellmctl auth kimi` performs an OAuth 2.0 device-code login with `auth.kimi.com`,
   saves tokens to `auth.kimi_code.json`, and syncs with kimi-cli's own credentials.
2. The provider extends LiteLLM's OpenAI-compatible handler, injecting the OAuth Bearer
   token and required agent identification headers (User-Agent, X-Msh-Platform, etc.).
3. Tokens auto-refresh on expiry; re-run `litellmctl auth kimi` if they expire completely.

Requires an [Allegretto plan](https://www.kimi.com/pricing) ($39/month) or higher for
the K2.5 model via Kimi Code.

## Qwen Portal Provider

The fork adds a `qwen_portal` provider that routes through Qwen's Portal API
(`portal.qwen.ai/v1`) using OAuth Bearer tokens — the same backend the official
[Qwen Code CLI](https://github.com/QwenLM/qwen-code) uses.

**How it works:**

1. `litellmctl auth qwen` performs an OAuth 2.0 device-code login with Qwen,
   saves tokens to `auth.qwen_portal.json`.
2. The provider extends LiteLLM's OpenAI-compatible handler, injecting the OAuth
   Bearer token and Portal API base dynamically.
3. Tokens auto-refresh on expiry; re-run `litellmctl auth qwen` if they expire
   completely.

Free tier: 60 requests/minute, 1,000 requests/day. For higher quotas, subscribe to
the [Alibaba Cloud Coding Plan](https://bailian.console.aliyun.com) and set
`DASHSCOPE_API_KEY` — the `dashscope/` models route through the Coding Plan's
OpenAI-compatible endpoint at `coding-intl.dashscope.aliyuncs.com/v1`.

## Local Models

The fork adds a `local` provider for embedding and transcription models served
by a process running on the same machine — no API key required.

### Setup

Local server setup is part of `litellmctl install`:

```bash
litellmctl install --with-local   # starts Ollama, pulls embedding models, guides transcription setup
```

Or interactively — `install` will prompt after the DB phase:

```
Set up local inference servers (embedding + transcription)? [y/N]
```

**Embedding (Ollama)** — default URL: `http://localhost:11434`.
Override with `LOCAL_EMBEDDING_API_BASE` in `.env`.

```python
# OpenAI SDK pointed at the proxy
client.embeddings.create(model="local/nomic-embed-text", input="hello")
client.embeddings.create(model="local/mxbai-embed-large", input="hello")
```

**Transcription (faster-whisper-server)** — default URL: `http://localhost:10300/v1`.
Override with `LOCAL_TRANSCRIPTION_API_BASE` in `.env`.
The `/v1` suffix is required: LiteLLM's OpenAI SDK appends `/audio/transcriptions` directly to this base.

```python
client.audio.transcriptions.create(model="local/whisper-large-v3-turbo", file=audio)
```

### Status

```bash
litellmctl local           # or: litellmctl local status
litellmctl status          # combined: auth + proxy + local + DB
```

### Uninstall

```bash
litellmctl uninstall                 # service + DB config + local servers
litellmctl uninstall embedding       # Ollama stop/uninstall guide
litellmctl uninstall transcription   # faster-whisper-server stop/uninstall guide
litellmctl uninstall db              # remove DB config from .env
litellmctl uninstall service         # stop and remove launchd/systemd service
```

## Config API Endpoints

The proxy exposes REST endpoints for live config management. All require the
master key (`Authorization: Bearer $LITELLM_MASTER_KEY`).

When a PostgreSQL database is connected (`DATABASE_URL` + `STORE_MODEL_IN_DB=true`),
config changes made via the update endpoints or the Admin UI are persisted to the
`LiteLLM_Config` table. On restart the proxy **merges** DB values on top of the
YAML file — so DB overrides win. Use `POST /config/reset` to clear DB overrides
and revert to the YAML file.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/config` | Return the current in-memory config (no disk/DB reload) |
| `PUT` | `/config` | Replace the entire in-memory config. Body: `{"config": {...}, "save_to_file": false, "update_router": true}` |
| `PATCH` | `/config` | Deep-merge partial updates into the current config. Same body shape as PUT |
| `POST` | `/config/update` | Admin UI config update — writes to DB + hot-reloads router |
| `POST` | `/config/reset` | **Reset to YAML defaults** — deletes all `LiteLLM_Config` DB rows, reloads config from the YAML file, and rebuilds the router |
| `POST` | `/config/field/update` | Update a single `general_settings` field. Body: `{"field_name": "...", "field_value": ...}` |
| `GET` | `/config/list` | List config field names and descriptions |
| `GET` | `/get/config/callbacks` | Return current callbacks, alerts, and router_settings |

### Examples

```bash
PORT=4040
KEY="$LITELLM_MASTER_KEY"

# View current config
curl -s http://localhost:$PORT/config \
  -H "Authorization: Bearer $KEY" | jq .

# Reset to config.yaml defaults (clears DB overrides)
curl -s -X POST http://localhost:$PORT/config/reset \
  -H "Authorization: Bearer $KEY" | jq .

# Hot-reload: replace router_settings in memory (not saved to file)
curl -s -X PATCH http://localhost:$PORT/config \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"config": {"router_settings": {"num_retries": 5}}}'

# Hot-reload: replace entire config and save to file
curl -s -X PUT http://localhost:$PORT/config \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"config": {...}, "save_to_file": true}'
```

## Syncing with Upstream

```bash
cd litellm
git remote add upstream https://github.com/BerriAI/litellm.git
git fetch upstream
git merge upstream/main
```
