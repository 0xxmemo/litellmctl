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
bin/install
cp .env.example .env       # fill in your API keys
litellmctl setup-completions
source ~/.zshrc
```

### Update

```bash
litellmctl update          # pull latest, sync submodule, rebuild & restart
```

## CLI

```
litellmctl wizard                 Interactive config.yaml generator (providers, tiers, fallbacks)
litellmctl install                Install / reinstall the LiteLLM fork
litellmctl auth chatgpt           Login to ChatGPT / Codex (PKCE)
litellmctl auth gemini            Login to Gemini CLI (PKCE)
litellmctl auth qwen              Login to Qwen Portal (device-code)
litellmctl auth kimi              Login to Kimi Code (device-code)
litellmctl auth refresh <p>       Refresh token for chatgpt, gemini, qwen, or kimi
litellmctl auth export [p...]     Copy credentials as a paste-able transfer script
litellmctl auth import            Read credentials from stdin
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
│   ├── dashscope.yaml  DashScope — fallback
│   ├── chatgpt.yaml    ChatGPT / Codex — fallback
│   ├── minimax.yaml    MiniMax — fallback
│   └── zai.yaml        Z.AI (GLM) — fallback
├── litellm/            Git submodule → 0xxmemo/litellm fork
├── config.yaml         Proxy model routing, fallbacks, environment vars
├── .env                API keys & OAuth secrets (git-ignored)
├── .env.example        Template for .env
├── auth.chatgpt.json   ChatGPT OAuth tokens (git-ignored, auto-refreshed)
├── auth.gemini_cli.json Gemini CLI OAuth tokens (git-ignored, auto-refreshed)
├── auth.qwen_portal.json Qwen Portal OAuth tokens (git-ignored, auto-refreshed)
├── auth.kimi_code.json Kimi Code OAuth tokens (git-ignored, auto-refreshed)
├── logs/               Service logs (git-ignored)
└── venv/               Python virtualenv (git-ignored)
```

## Models & Fallbacks

Three consumer-facing models, each with a tiered fallback chain:

| Model               | Fallback 1 (Qwen Portal) | Fallback 2 (DashScope)       | Fallback 3 (Codex)          | Fallback 4 (Gemini)                | Fallback 5 (Z.AI)   |
| ------------------- | ------------------------ | ---------------------------- | --------------------------- | ---------------------------------- | ------------------- |
| `claude-opus-4-6`   | `qwen/qwen3-coder-plus`  | `dashscope/qwen3-coder-plus` | `codex/gpt-5.3-codex`       | `gemini-cli/gemini-2.5-flash-lite` | `zai/glm-5`         |
| `claude-sonnet-4-5` | `qwen/qwen3-coder-plus`  | `dashscope/qwen3-coder-plus` | `codex/gpt-5.3-codex-spark` | `gemini-cli/gemini-2.5-flash-lite` | `zai/glm-4.5-air`   |
| `claude-haiku-4-5`  | `qwen/qwen3-vl-plus`     | `dashscope/qwen3-coder-plus` | `codex/gpt-5.1-codex-mini`  | `gemini-cli/gemini-2.5-flash-lite` | `zai/glm-4.5-flash` |

All backend models are also directly addressable by their full name
(e.g. `qwen/qwen3-coder-plus`, `dashscope/qwen3-coder-plus`, `codex/gpt-5.3-codex`, `gemini-cli/gemini-2.5-pro`, `zai/glm-5`).

### Available providers

| Provider        | Auth                     | Models                                                                                                                       |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic**   | API key                  | `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`                                                                   |
| **Kimi Code**   | Kimi OAuth (device-code) | `kimi-code/kimi-for-coding` (K2.5)                                                                                           |
| **Qwen Portal** | Qwen OAuth (device-code) | `qwen/qwen3-coder-plus`, `qwen/qwen3-vl-plus`                                                                                |
| **DashScope**   | API key (Coding Plan)    | `dashscope/qwen3-coder-plus`                                                                                                 |
| **Codex**       | ChatGPT OAuth            | `codex/gpt-5.3-codex`, `codex/gpt-5.3-codex-spark`, `codex/gpt-5.2-codex`, `codex/gpt-5.1-codex`, `codex/gpt-5.1-codex-mini` |
| **Gemini CLI**  | Google OAuth             | `gemini-cli/gemini-2.5-pro`, `gemini-cli/gemini-2.5-flash`, `gemini-cli/gemini-2.5-flash-lite`                               |
| **MiniMax**     | API key                  | `minimax/MiniMax-M2.5-highspeed`                                                                                             |
| **Z.AI**        | API key                  | `zai/glm-5`, `zai/glm-5v`, `zai/glm-4.7`, `zai/glm-4.6`, `zai/glm-4.5`, etc.                                                 |

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
