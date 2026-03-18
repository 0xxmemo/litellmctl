"""Interactive menu for litellmctl (no-args + TTY mode)."""

from __future__ import annotations

import questionary

from .common.formatting import console, info, warn
from .common.platform import is_interactive
from .commands.status import quick_status_line


MAIN_CHOICES = [
    questionary.Separator("── Service ──"),
    "start        Start proxy service",
    "stop         Stop proxy service",
    "restart      Restart proxy service",
    "status       Full status",
    "logs         Tail proxy logs",
    questionary.Separator("── Setup ──"),
    "install      Install / rebuild LiteLLM",
    "auth         Manage authentication",
    "wizard       Config wizard",
    "uninstall    Remove components",
    "gateway      Manage Gateway UI",
    questionary.Separator("──"),
    "help         Show help",
    "quit         Exit",
]


def interactive_menu() -> None:
    """Main interactive menu loop."""
    while True:
        console.print("\n[bold]litellmctl — LiteLLM Proxy Control[/]")
        console.print("[dim]──────────────────────────────────────[/]")
        quick_status_line()
        console.print()

        try:
            choice = questionary.select(
                "Select:",
                choices=MAIN_CHOICES,
            ).ask()
        except KeyboardInterrupt:
            info("Goodbye.")
            return

        if choice is None:
            info("Goodbye.")
            return

        cmd = choice.split()[0]

        try:
            if cmd == "start":
                from .commands.service import cmd_start
                cmd_start()
            elif cmd == "stop":
                from .commands.service import cmd_stop
                cmd_stop()
            elif cmd == "restart":
                from .commands.service import cmd_restart
                cmd_restart()
            elif cmd == "status":
                from .commands.status import cmd_status
                cmd_status()
            elif cmd == "logs":
                from .commands.service import cmd_logs
                try:
                    cmd_logs()
                except KeyboardInterrupt:
                    console.print("\n")
                    info("Stopped tailing.")
            elif cmd == "install":
                from .commands.install import cmd_install
                cmd_install()
            elif cmd == "auth":
                auth_interactive()
            elif cmd == "wizard":
                from .wizard.core import run_wizard
                run_wizard()
            elif cmd == "uninstall":
                from .commands.uninstall import cmd_uninstall
                cmd_uninstall()
            elif cmd == "gateway":
                from .commands.gateway import cmd_gateway
                cmd_gateway()
            elif cmd == "help":
                from .cli import _show_help
                _show_help()
            elif cmd == "quit":
                info("Goodbye.")
                return
        except KeyboardInterrupt:
            console.print()
            warn("Cancelled.")


def auth_interactive() -> None:
    """Interactive auth provider selection using questionary."""
    from .auth.transfer import AUTH_PROVIDERS

    choices = []
    for key, label, _ in AUTH_PROVIDERS:
        choices.append(f"{key:<12} {label}")
    choices.extend([
        questionary.Separator("──"),
        "status       Show token expiry",
        "refresh      Refresh a token",
        "export       Copy credentials",
    ])

    try:
        result = questionary.select(
            "Auth — select provider:",
            choices=choices,
        ).ask()
    except KeyboardInterrupt:
        return

    if result is None:
        return

    cmd = result.split()[0]
    from .auth.cli import auth_dispatch

    if cmd in ("chatgpt", "gemini", "qwen", "kimi"):
        auth_dispatch([cmd])
    elif cmd == "status":
        auth_dispatch(["status"])
    elif cmd == "refresh":
        provider = questionary.select(
            "Refresh which provider?",
            choices=["chatgpt", "gemini", "qwen", "kimi"],
        ).ask()
        if provider:
            auth_dispatch(["refresh", provider])
    elif cmd == "export":
        auth_dispatch(["export"])
