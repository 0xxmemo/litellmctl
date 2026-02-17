# litellmctl

Personal LiteLLM proxy control using a [fork of litellm](https://github.com/0xxmemo/litellm) (upstream: [BerriAI/litellm](https://github.com/BerriAI/litellm)).

## Quick Start

```bash
# 1. Install (creates venv, installs fork in editable mode)
bin/install

# 2. Set up secrets
cp .env.example .env   # then fill in your API keys

# 3. Authenticate OAuth providers
litellmctl auth gemini    # browser PKCE login for Gemini CLI
litellmctl auth chatgpt   # browser PKCE login for ChatGPT / Codex

# 4. Start the proxy (background service, auto-starts on boot)
litellmctl start

# 5. Add litellmctl to your shell (alias + tab completion)
litellmctl setup-completions
source ~/.zshrc
```

## CLI

```
litellmctl install                Install / reinstall the LiteLLM fork
litellmctl auth chatgpt           Login to ChatGPT / Codex (browser PKCE)
litellmctl auth gemini            Login to Gemini CLI (browser PKCE)
litellmctl auth refresh <p>       Refresh token for chatgpt or gemini
litellmctl auth status            Show token expiry info
litellmctl start [--port N]       Start proxy as background service (auto-start on boot)
litellmctl stop                   Stop the proxy service
litellmctl restart                Restart the proxy service
litellmctl logs                   Tail proxy logs
litellmctl proxy [--port N]       Start proxy in foreground (for debugging)
litellmctl uninstall-service      Remove the system service
litellmctl status                 Auth + proxy status at a glance
litellmctl toggle-claude          Toggle Claude Code between direct API and proxy
litellmctl setup-completions      Add litellmctl to your shell (alias + tab completion)
```

`start` installs a system service (macOS: launchd, Linux: systemd) that
auto-starts on login and restarts on crash. Use `proxy` for foreground
mode when debugging.

## Project Layout

```
.litellm/
├── bin/
│   ├── litellmctl      CLI runner (bash, with tab-completion)
│   ├── auth            OAuth login & refresh for ChatGPT + Gemini CLI (python)
│   ├── install         Installer — venv + editable pip install (bash)
│   └── toggle-claude   Toggle Claude Code between direct API and proxy
├── litellm/            Git submodule → 0xxmemo/litellm fork
├── config.yaml         Proxy model routing, fallbacks, environment vars
├── .env                API keys & OAuth secrets (git-ignored)
├── .env.example        Template for .env
├── auth.chatgpt.json   ChatGPT OAuth tokens (git-ignored, auto-refreshed)
├── auth.gemini_cli.json Gemini CLI OAuth tokens (git-ignored, auto-refreshed)
├── logs/               Service logs (git-ignored)
└── venv/               Python virtualenv (git-ignored)
```

## Model Tiers

| Tier | Auth | Models |
|---|---|---|
| **Anthropic** | API key | `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5` |
| **Codex** | ChatGPT OAuth | `codex/gpt-5.3-codex`, `codex/gpt-5.2-codex`, `codex/gpt-5.1-codex`, etc. |
| **Gemini CLI** | Google OAuth | `gemini-cli/gemini-2.5-pro`, `gemini-cli/gemini-2.5-flash`, `gemini-cli/gemini-2.5-flash-lite`, `gemini-cli/gemini-3-pro-preview`, `gemini-cli/gemini-3-flash-preview` |
| **Z.AI** | API key | `zai/glm-5`, `zai/glm-4.7`, `zai/glm-4.6`, `zai/glm-4.5`, etc. |

Fallback chains are configured in `config.yaml` — e.g. `claude-opus-4-6` falls back through Codex then Z.AI.

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

## Syncing with Upstream

```bash
cd litellm
git remote add upstream https://github.com/BerriAI/litellm.git
git fetch upstream
git merge upstream/main
```
