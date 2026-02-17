# LiteLLM Proxy Config

Personal LiteLLM proxy configuration using a [fork of litellm](https://github.com/0xxmemo/litellm) (upstream: [BerriAI/litellm](https://github.com/BerriAI/litellm)).

## Quick Start

```bash
# 1. Install (creates venv, installs fork in editable mode)
bin/install

# 2. Set up secrets
cp .env.example .env   # then fill in your API keys

# 3. Authenticate OAuth providers
bin/ctl auth chatgpt   # browser PKCE login for ChatGPT / Codex
bin/ctl auth gemini    # browser PKCE login for Gemini CLI

# 4. Start the proxy
bin/ctl proxy
```

## CLI

Everything runs through `bin/ctl`:

```
bin/ctl install                Install / reinstall the LiteLLM fork
bin/ctl auth chatgpt           Login to ChatGPT / Codex (browser PKCE)
bin/ctl auth gemini            Login to Gemini CLI (browser PKCE)
bin/ctl auth refresh <p>       Refresh token for chatgpt or gemini
bin/ctl auth status            Show token expiry info
bin/ctl proxy                  Start proxy (default port 4000)
bin/ctl proxy --port 8000      Start on a custom port
bin/ctl stop                   Stop the running proxy
bin/ctl status                 Auth + proxy status at a glance
bin/ctl toggle-claude          Toggle Claude Code between direct API and proxy
```

Tab completion — add one line to your shell rc:

```bash
# zsh
eval "$(~/.litellm/bin/ctl --zsh-completions)"
# bash
eval "$(~/.litellm/bin/ctl --completions)"
```

## Project Layout

```
.litellm/
├── bin/
│   ├── ctl             Unified CLI runner (bash, with tab-completion)
│   ├── auth            OAuth login & refresh for ChatGPT + Gemini CLI (python)
│   ├── install         Installer — venv + editable pip install (bash)
│   └── toggle-claude   Toggle Claude Code between direct API and proxy
├── litellm/            Git submodule → 0xxmemo/litellm fork
├── config.yaml         Proxy model routing, fallbacks, environment vars
├── .env                API keys & OAuth secrets (git-ignored)
├── .env.example        Template for .env
├── auth.chatgpt.json   ChatGPT OAuth tokens (git-ignored, auto-refreshed)
├── auth.gemini_cli.json Gemini CLI OAuth tokens (git-ignored, auto-refreshed)
└── venv/               Python virtualenv (git-ignored)
```

## Model Tiers

| Tier | Auth | Models |
|---|---|---|
| **Anthropic** | API key | `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5` |
| **Codex** | ChatGPT OAuth | `codex/gpt-5.3-codex`, `codex/gpt-5.2-codex`, `codex/gpt-5.1-codex`, etc. |
| **Gemini CLI** | Google OAuth | `gemini-cli/gemini-2.5-flash-lite` |
| **Z.AI** | API key | `zai/glm-5`, `zai/glm-4.7`, `zai/glm-4.6`, `zai/glm-4.5`, etc. |

Fallback chains are configured in `config.yaml` — e.g. `claude-opus-4-6` falls back through Codex then Z.AI.

## Syncing with Upstream

```bash
cd litellm
git remote add upstream https://github.com/BerriAI/litellm.git
git fetch upstream
git merge upstream/main
```
