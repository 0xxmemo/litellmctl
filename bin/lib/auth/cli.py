"""Auth CLI command dispatch — replaces the old auth script's main()."""

from __future__ import annotations

import sys

from ..common.formatting import console
from ..common.env import load_env

from .chatgpt import chatgpt_login, chatgpt_refresh
from .gemini import gemini_login, gemini_refresh
from .qwen import qwen_login, qwen_refresh
from .kimi import kimi_login, kimi_refresh
from .transfer import AUTH_PROVIDERS, export_creds, import_creds
from .status import show_status


USAGE = """\
[bold]LiteLLM Auth CLI[/]

[bold]Commands:[/]
  auth chatgpt              Login to ChatGPT / Codex (browser PKCE)
  auth gemini               Login to Gemini CLI (browser PKCE)
  auth qwen                 Login to Qwen Portal (device code)
  auth kimi                 Login to Kimi Code (device code)
  auth protonmail           Authenticate hydroxide SMTP bridge
  auth refresh <name>       Refresh token (chatgpt|gemini|qwen|kimi)
  auth status               Show token status
  auth providers            List available providers (key|label, one per line)
  auth export [providers]   Copy credentials as a paste-able transfer script
  auth import               Read credentials from stdin
"""


def auth_dispatch(args: list[str]) -> None:
    load_env()

    if not args or args[0] in ("-h", "--help", "help"):
        console.print(USAGE); return

    cmd = args[0].lower()
    try:
        if cmd in ("chatgpt", "codex", "openai"):
            chatgpt_login()
        elif cmd in ("gemini", "gemini_cli", "gemini-cli"):
            gemini_login()
        elif cmd in ("qwen", "qwen_portal", "qwen-portal"):
            qwen_login()
        elif cmd in ("kimi", "kimi_code", "kimi-code"):
            kimi_login()
        elif cmd in ("protonmail", "proton", "hydroxide"):
            from ..commands.protonmail import protonmail_auth
            protonmail_auth()
        elif cmd == "refresh":
            if len(args) < 2:
                console.print("[red]Usage: auth refresh <chatgpt|gemini|qwen|kimi>[/]"); sys.exit(1)
            t = args[1].lower()
            if t in ("chatgpt", "codex", "openai"):   chatgpt_refresh()
            elif t in ("gemini", "gemini_cli", "gemini-cli"): gemini_refresh()
            elif t in ("qwen", "qwen_portal", "qwen-portal"): qwen_refresh()
            elif t in ("kimi", "kimi_code", "kimi-code"): kimi_refresh()
            else: console.print(f"[red]Unknown provider: {t}[/]"); sys.exit(1)
        elif cmd == "providers":
            for key, label, _ in AUTH_PROVIDERS:
                print(f"{key}|{label}")
        elif cmd == "export":
            # Export selected providers (or all) to clipboard
            providers = args[1:] if len(args) > 1 else None
            export_creds(providers)
        elif cmd == "import":
            import_creds()
        elif cmd == "status":
            show_status()
        else:
            console.print(f"[red]Unknown command: {cmd}[/]"); console.print(USAGE); sys.exit(1)
    except KeyboardInterrupt:
        console.print("[yellow]\nAborted.[/]"); sys.exit(130)
    except RuntimeError as e:
        console.print(f"[red]\nError: {e}[/]"); sys.exit(1)
    except Exception as e:
        console.print(f"[red]\n{type(e).__name__}: {e}[/]"); sys.exit(1)
