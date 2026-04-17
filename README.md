# litellmctl

CLI for managing a personal [LiteLLM](https://github.com/BerriAI/litellm) proxy with OAuth provider auth, a web gateway, local inference servers, and search.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/0xxmemo/litellmctl/main/install.sh | bash
```

Works on **macOS** and **Ubuntu/Debian**. Safe to re-run.

```bash
source ~/.zshrc              # or ~/.bashrc
litellmctl wizard            # generate config.yaml (providers, tiers, fallbacks)
litellmctl install           # local servers, gateway, search
litellmctl start             # start proxy (auto-starts on boot)
```

### Docker Compose

From a clone of this repo (includes the `litellm` submodule), build and run the proxy with data in a named volume. The **wizard** runs in a one-off interactive container that writes `config.yaml` and `.env` under `/data` (`LITELLMCTL_HOME`).

```bash
docker compose --profile wizard run --rm wizard   # interactive: litellmctl wizard
docker compose up -d proxy                        # LiteLLM proxy on port 4000 (override with PROXY_PORT)
```

See `docker-compose.yml` and `docker/Dockerfile` for details.

### Amazon ECS Express (config + auth outside the image)

Use the **`ecs`** image target (`docker build -f docker/Dockerfile --target ecs`) so the task can sync `config.yaml`, `.env`, and OAuth JSON files from S3 into `/data` before starting the proxy — **no wizard in the cluster**. CI can push artifacts to S3, push the image to ECR, then update the Express service.

See [docker/ecs-express.md](docker/ecs-express.md) and [.github/workflows/litellm-ecr.yml](.github/workflows/litellm-ecr.yml).

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

### Gateway

```
litellmctl gateway status         Show gateway status
litellmctl gateway logs           Tail gateway logs
litellmctl gateway routes         List all API endpoints (parsed from source)
litellmctl gateway api <cmd...>   Call any endpoint using human commands
litellmctl gateway users          List all gateway users
litellmctl gateway set-role <email> <role>
                                  Set user role (guest/user/admin)
```

#### Gateway API

Every gateway endpoint is callable using path segments as commands — no HTTP methods, URLs, or auth needed:

```bash
litellmctl gateway api health
litellmctl gateway api stats user
litellmctl gateway api admin users
litellmctl gateway api models extended
litellmctl gateway api search q=hello
litellmctl gateway api admin approve -d '{"email":"user@example.com"}'
litellmctl gateway api admin litellm-config -d '{"router_settings":{"num_retries":5}}'
litellmctl gateway api keys delete abc123
```

Method is auto-inferred (GET by default, write method when `-d` or `key=val` given, `delete`/`create`/`update` action words).

Tab completion discovers commands from route source files (works offline):

```bash
litellmctl gateway api <TAB>          # health, stats, admin, keys, ...
litellmctl gateway api stats <TAB>    # user, requests, ...
```

Use `litellmctl gateway routes` to see all endpoints with descriptions.

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

```
litellmctl protonmail start       Start hydroxide SMTP bridge
litellmctl protonmail stop        Stop hydroxide
litellmctl protonmail restart     Restart hydroxide
litellmctl protonmail status      Show bridge status
litellmctl protonmail auth        Show authentication instructions
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
litellmctl gateway api GET /api/health
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
litellmctl gateway api GET "/api/search?q=AI+news"

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
