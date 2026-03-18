"""Interactive menu for litellmctl (no-args + TTY mode)."""

from __future__ import annotations

import questionary
from questionary import Style

from .common.formatting import console, info, warn

MENU_STYLE = Style([
    ("qmark",       "fg:ansicyan bold"),
    ("question",    "bold"),
    ("answer",      "fg:ansigreen bold"),
    ("pointer",     "fg:ansicyan bold"),
    ("highlighted", "fg:ansicyan bold"),
    ("selected",    "fg:ansigreen"),
    ("separator",   "fg:ansiblue"),
    ("disabled",    "fg:ansidarkgray italic"),
    ("instruction", "fg:ansidarkgray"),
])


def _build_choices(running: bool, port: int) -> list:
    on  = lambda label: questionary.Choice(label)
    off = lambda label, reason: questionary.Choice(label, disabled=reason)

    return [
        questionary.Separator("  ─ service ─────────────────────────"),
        on("start")    if not running else off("start",   "already running"),
        on("stop")     if running     else off("stop",    "not running"),
        on("restart")  if running     else off("restart", "not running"),
        on("status"),
        on("logs")     if running     else off("logs",    "not running"),
        questionary.Separator("  ─ setup ──────────────────────────"),
        on("install"),
        on("auth"),
        on("wizard"),
        on("gateway"),
        on("uninstall"),
        questionary.Separator("  ─────────────────────────────────"),
        on("help"),
        on("quit"),
    ]


def interactive_menu() -> None:
    """Main interactive menu loop."""
    while True:
        from .common.process import get_proxy_port, find_proxy_pid
        port    = get_proxy_port()
        running = find_proxy_pid() is not None
        state   = f"[green]running :{port}[/]" if running else "[yellow]stopped[/]"
        console.print(f"\n[bold]litellmctl[/]  [dim]proxy[/] {state}")

        try:
            choice = questionary.select(
                "›",
                choices=_build_choices(running, port),
                style=MENU_STYLE,
                instruction="(↑↓ arrows, enter to select)",
            ).ask()
        except KeyboardInterrupt:
            info("Goodbye.")
            return

        if choice is None:
            info("Goodbye.")
            return

        cmd = choice.strip()

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

    choices: list = [questionary.Separator("  ─ login ──────────────────────────")]
    for key, label, _ in AUTH_PROVIDERS:
        choices.append(questionary.Choice(f"{key}  ({label})"))
    choices += [
        questionary.Separator("  ─ manage ─────────────────────────"),
        questionary.Choice("status"),
        questionary.Choice("refresh"),
        questionary.Choice("export"),
        questionary.Separator("  ───────────────────────────────────"),
        questionary.Choice("back"),
    ]

    try:
        result = questionary.select(
            "› auth",
            choices=choices,
            style=MENU_STYLE,
            instruction="(↑↓ arrows, enter to select)",
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
            "› refresh",
            choices=["chatgpt", "gemini", "qwen", "kimi"],
            style=MENU_STYLE,
        ).ask()
        if provider:
            auth_dispatch(["refresh", provider])
    elif cmd == "export":
        auth_dispatch(["export"])
