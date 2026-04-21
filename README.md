# litellmctl

CLI for managing a personal [LiteLLM](https://github.com/BerriAI/litellm) proxy with OAuth provider auth, a web gateway, local inference servers, and search.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/0xxmemo/litellmctl/main/install.sh | bash
```

Works on **macOS** and **Ubuntu/Debian**. Safe to re-run.

For AWS deployments see [`docs/aws.md`](docs/aws.md). One GitHub Actions
pipeline provisions an ARM Graviton EC2 instance, user-data runs
`install.sh` the same way a laptop does, and subsequent deploys are a
`git pull && litellmctl restart` one-liner executed via SSM. No Docker,
no image builds. Caddy fronts the gateway for auto-HTTPS; an in-UI
admin PTY replaces SSH for ops like running the wizard or logging into
OAuth providers.

```bash
source ~/.zshrc              # or ~/.bashrc
litellmctl wizard            # generate config.yaml (providers, tiers, fallbacks)
litellmctl install           # local servers, gateway, search
litellmctl start             # start proxy (auto-starts on boot)
```

## CLI Reference

### Proxy

```
litellmctl start [--port N]       Start proxy (background, auto-start on boot)
litellmctl stop                   Stop proxy
litellmctl restart                Restart proxy
litellmctl logs                   Tail proxy logs
litellmctl proxy [--port N]       Start proxy in foreground (debug)
litellmctl status                 Auth + proxy + gateway + local servers
```

### Auth (OAuth providers)

```
litellmctl auth chatgpt           Login to ChatGPT / Codex (PKCE)
litellmctl auth gemini            Login to Gemini CLI (PKCE)
litellmctl auth qwen              Login to Qwen Portal (device-code)
litellmctl auth kimi              Login to Kimi Code (device-code)
litellmctl auth status            Show token expiry info
litellmctl auth refresh <p>       Refresh token for a provider
litellmctl auth export [p...]     Copy credentials as transfer script
litellmctl auth import            Read credentials from stdin
```

### Lifecycle (features)

All services (`proxy | gateway | searxng | protonmail | embedding | transcription`) are managed with the same four verbs:

```
litellmctl start [features...]     Start one or more features (multi-select if omitted)
litellmctl stop  [features...]     Stop
litellmctl restart [features...]   Restart
litellmctl status [feature]        Show status for one feature (default: all)
litellmctl logs [feature]          Tail logs for one feature (default: proxy)
```

### Gateway data commands

```
litellmctl users                    List all gateway users
litellmctl set-role <email> <role>  Set a user's role (guest/user/admin)
litellmctl routes                   List all gateway API endpoints
litellmctl api <cmd...>             Call any gateway endpoint (see below)
litellmctl migrate-from-mongo       One-shot migration of legacy MongoDB → SQLite
```

#### Gateway API

Every gateway endpoint is callable using path segments as commands — no HTTP methods, URLs, or auth needed (the CLI uses a localhost-only bypass secret):

```bash
litellmctl api health
litellmctl api stats user
litellmctl api admin users
litellmctl api models extended
litellmctl api search q=hello
litellmctl api admin approve -d '{"email":"user@example.com"}'
litellmctl api admin litellm-config -d '{"router_settings":{"num_retries":5}}'
litellmctl api keys delete abc123
```

Method is auto-inferred (GET by default, write method when `-d` or `key=val` given, `delete`/`create`/`update` action words).

Tab completion discovers commands from route source files (works offline):

```bash
litellmctl api <TAB>                  # health, stats, admin, keys, ...
litellmctl api stats <TAB>            # user, requests, ...
```

Use `litellmctl routes` to see all endpoints with descriptions.

### Config

```
litellmctl wizard                 Interactive config.yaml generator
litellmctl install [flags]        Install / rebuild components
litellmctl init-env               Detect auth files and update .env
litellmctl toggle-claude          Toggle Claude Code between direct API and proxy
litellmctl setup-completions      Add litellmctl alias + tab completion to shell
```

#### Install flags

```
--with-local / --without-local             Ollama + faster-whisper
--with-embedding / --without-embedding     Ollama embedding server
--with-transcription / --without-transcription  faster-whisper-server
--with-searxng / --without-searxng         SearXNG search server
--with-gateway / --without-gateway         Web UI + API gateway
--with-protonmail / --without-protonmail   Hydroxide SMTP bridge for OTP emails
```

### ProtonMail (OTP delivery)

ProtonMail is a feature like any other — use the unified verbs:

```
litellmctl start protonmail       Start hydroxide SMTP bridge
litellmctl stop protonmail        Stop
litellmctl restart protonmail     Restart
litellmctl status protonmail      Show bridge status
litellmctl auth protonmail        Authenticate hydroxide with ProtonMail
```

### Uninstall

```
litellmctl uninstall [target]     Remove components
```

Targets: `service`, `embedding`, `transcription`, `searxng`, `gateway`, `protonmail`

#### Legacy PostgreSQL cleanup (migration)

If you installed when `litellmctl` set up PostgreSQL (or you still have `DATABASE_URL` / related keys in `.env`), run this once to **stop the proxy service** and **strip DB-related environment variables** from `.env`. It does not drop PostgreSQL databases.

Works on **macOS** (LaunchAgent `com.litellm.proxy`) and **Linux** (systemd user unit `litellm-proxy`), and cleans **nohup** + `.proxy.pid` if used.

```bash
~/.litellm/bin/uninstall-legacy-db
# Custom install path:  LITELLM_HOME=/path/to/.litellm ~/.litellm/bin/uninstall-legacy-db
```

Then start the proxy again: `litellmctl start`.

## Features

### Web Gateway

A full web UI and authenticated API layer on top of LiteLLM:

- **Dashboard** with usage stats, model breakdown, daily charts
- **API key management** (create, revoke, rename)
- **User management** with role-based access (admin/user/guest)
- **Model overrides** per user
- **Config editor** for live config.yaml changes
- **Search** via SearXNG proxy
- **Health monitoring** with feature detection

Default port: `14041`. Override with `GATEWAY_PORT` in `.env`.

### Feature Detection

```bash
litellmctl api GET /api/health
```

```json
{
  "status": "ok",
  "uptime": 42.3,
  "features": {
    "search": true,
    "embedding": true,
    "transcription": false,
    "proton": true,
    "database": true
  }
}
```

### Search (SearXNG)

Privacy-respecting metasearch, accessible via gateway or directly:

```bash
# Via CLI (recommended)
litellmctl api GET "/api/search?q=AI+news"

# Direct SearXNG API
curl "http://localhost:8888/search?q=your+query&format=json"
```

### Local Models

Embedding (Ollama) and transcription (faster-whisper-server):

```bash
litellmctl local status           # check reachability
litellmctl install --with-local   # set up both
```

### Credential Transfer

```bash
# Source machine — copies self-contained bash script to clipboard
litellmctl auth export chatgpt kimi

# Target machine — paste the script (no litellmctl required)
```

### Headless / SSH

`litellmctl auth` detects headless environments and prints the OAuth URL.
SSH-tunnel the callback port for automatic capture:

```bash
ssh -L 8085:localhost:8085 server   # Gemini
ssh -L 1455:localhost:1455 server   # ChatGPT
```

## Project Layout

```
~/.litellm/
├── bin/litellmctl        CLI entry point
├── bin/lib/              Python CLI package
├── gateway/              Bun-based web gateway + API
│   ├── routes/           TypeScript route handlers (parsed by CLI for commands)
│   ├── routes/           TypeScript route handlers
│   └── src/              React frontend
├── templates/            Provider YAML templates for wizard
├── litellm/              Git submodule (LiteLLM fork)
├── config.yaml           Proxy model routing config
├── searxng/              SearXNG settings
└── .env                  API keys and env vars (git-ignored)
```

## Running Tests

```bash
cd ~/.litellm/bin
python3 -m pytest           # all tests
python3 -m pytest tests/test_auth_core.py  # specific module
```
