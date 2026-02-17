# LiteLLM Proxy Config

Personal LiteLLM proxy configuration using a [fork of litellm](https://github.com/0xxmemo/litellm) (upstream: [BerriAI/litellm](https://github.com/BerriAI/litellm)).

## Quick Start

```bash
# 1. Install (creates venv + installs fork)
./install.sh

# 2. Set up your secrets
cp .env.example .env
# Edit .env with your API keys

# 3. Start the proxy
source venv/bin/activate
litellm --config config.yaml
```

## Files

| File | Description |
|---|---|
| `config.yaml` | Proxy model routing, fallbacks, and settings |
| `.env` | API keys and secrets (git-ignored) |
| `.env.example` | Template for required environment variables |
| `auth.chatgpt.json` | ChatGPT OAuth token (git-ignored, auto-refreshed) |
| `install.sh` | Installs the litellm fork into a local venv |
| `toggle_claude_llm.sh` | Toggles Claude Code between direct API and proxy |

## Model Tiers

- **Anthropic** -- Claude Opus, Sonnet, Haiku (direct API key)
- **Codex** -- GPT-5.x models via ChatGPT Pro/Max OAuth
- **Z.AI** -- GLM models via z.ai Anthropic-compatible API

## Syncing with Upstream

```bash
# Add upstream remote (one-time)
cd /path/to/litellm-fork
git remote add upstream https://github.com/BerriAI/litellm.git

# Pull latest changes
git fetch upstream
git merge upstream/main
```
