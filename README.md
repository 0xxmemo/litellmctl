# litellmctl

Personal LiteLLM proxy control using a [fork of litellm](https://github.com/0xxmemo/litellm) (upstream: [BerriAI/litellm](https://github.com/BerriAI/litellm)).

## Quick Start

```bash
# 1. Install (creates venv, installs fork in editable mode)
bin/install

# 2. Set up secrets
cp .env.example .env   # then fill in your API keys

# 3. Authenticate OAuth providers
litellmctl auth gemini    # PKCE login for Gemini CLI
litellmctl auth chatgpt   # PKCE login for ChatGPT / Codex
litellmctl auth qwen      # Device-code login for Qwen Portal

# 4. Start the proxy (background service, auto-starts on boot)
litellmctl start

# 5. Add litellmctl to your shell (alias + tab completion)
litellmctl setup-completions
source ~/.zshrc
```

## CLI

```
litellmctl install                Install / reinstall the LiteLLM fork
litellmctl auth chatgpt           Login to ChatGPT / Codex (PKCE)
litellmctl auth gemini            Login to Gemini CLI (PKCE)
litellmctl auth qwen              Login to Qwen Portal (device-code)
litellmctl auth refresh <p>       Refresh token for chatgpt, gemini, or qwen
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
├── bin/
│   ├── litellmctl      CLI runner (bash, with tab-completion)
│   ├── auth            OAuth login & refresh for ChatGPT, Gemini CLI & Qwen (python)
│   ├── install         Installer — venv + editable pip install (bash)
│   └── toggle-claude   Toggle Claude Code between direct API and proxy
├── litellm/            Git submodule → 0xxmemo/litellm fork
├── config.yaml         Proxy model routing, fallbacks, environment vars
├── .env                API keys & OAuth secrets (git-ignored)
├── .env.example        Template for .env
├── auth.chatgpt.json   ChatGPT OAuth tokens (git-ignored, auto-refreshed)
├── auth.gemini_cli.json Gemini CLI OAuth tokens (git-ignored, auto-refreshed)
├── auth.qwen_portal.json Qwen Portal OAuth tokens (git-ignored, auto-refreshed)
├── logs/               Service logs (git-ignored)
└── venv/               Python virtualenv (git-ignored)
```

## Models & Fallbacks

Three consumer-facing models, each with a tiered fallback chain:

| Model               | Fallback 1 (Qwen Portal) | Fallback 2 (DashScope)       | Fallback 3 (Codex)          | Fallback 4 (Gemini)                 | Fallback 5 (Z.AI)   |
| ------------------- | ------------------------ | ---------------------------- | --------------------------- | ----------------------------------- | ------------------- |
| `claude-opus-4-6`   | `qwen/qwen3.5-plus`      | `dashscope/qwen3.5-plus`     | `codex/gpt-5.3-codex`       | `gemini-cli/gemini-3-pro-preview`   | `zai/glm-5`         |
| `claude-sonnet-4-5` | `qwen/qwen3-coder-plus`  | `dashscope/qwen3-coder-plus` | `codex/gpt-5.3-codex-spark` | `gemini-cli/gemini-3-flash-preview` | `zai/glm-4.5-air`   |
| `claude-haiku-4-5`  | `qwen/qwen3-vl-plus`     | `dashscope/qwen3-max`        | `codex/gpt-5.1-codex-mini`  | `gemini-cli/gemini-2.5-flash-lite`  | `zai/glm-4.5-flash` |

All backend models are also directly addressable by their full name
(e.g. `qwen/qwen3.5-plus`, `dashscope/qwen3-max`, `codex/gpt-5.3-codex`, `gemini-cli/gemini-2.5-pro`, `zai/glm-5`).

### Available providers

| Provider        | Auth                     | Models                                                                                                                                                                 |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic**   | API key                  | `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`                                                                                                             |
| **Qwen Portal** | Qwen OAuth (device-code) | `qwen/qwen3.5-plus`, `qwen/qwen3-coder-plus`, `qwen/qwen3-vl-plus`                                                                                                     |
| **DashScope**   | API key (Coding Plan)    | `dashscope/qwen3.5-plus`, `dashscope/qwen3-max`, `dashscope/qwen3-coder-plus`                                                                                          |
| **Codex**       | ChatGPT OAuth            | `codex/gpt-5.3-codex`, `codex/gpt-5.3-codex-spark`, `codex/gpt-5.2-codex`, `codex/gpt-5.1-codex`, `codex/gpt-5.1-codex-mini`                                           |
| **Gemini CLI**  | Google OAuth             | `gemini-cli/gemini-3-pro-preview`, `gemini-cli/gemini-3-flash-preview`, `gemini-cli/gemini-2.5-pro`, `gemini-cli/gemini-2.5-flash`, `gemini-cli/gemini-2.5-flash-lite` |
| **Z.AI**        | API key                  | `zai/glm-5`, `zai/glm-5v`, `zai/glm-4.7`, `zai/glm-4.6`, `zai/glm-4.5`, etc.                                                                                           |

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

Free tier: 60 requests/minute, 1,000 requests/day. For higher quotas, add a
`DASHSCOPE_API_KEY` from the [Alibaba Cloud Coding Plan](https://bailian.console.aliyun.com)
and the `dashscope/` models will be used as fallbacks when the portal quota is exhausted.

## Syncing with Upstream

```bash
cd litellm
git remote add upstream https://github.com/BerriAI/litellm.git
git fetch upstream
git merge upstream/main
```
