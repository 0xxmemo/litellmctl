"""Interactive menu for litellmctl (no-args + TTY mode)."""

from __future__ import annotations

from .common.deps import require_questionary
from .common.formatting import console, info, warn


def _menu_style():
    q = require_questionary()
    return q.Style([
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
    q = require_questionary()
    on  = lambda label: q.Choice(label)
    off = lambda label, reason: q.Choice(label, disabled=reason)

    return [
        q.Separator("  ─ service ─────────────────────────"),
        on("start")    if not running else off("start",   "already running"),
        on("stop")     if running     else off("stop",    "not running"),
        on("restart")  if running     else off("restart", "not running"),
        on("status"),
        on("logs")     if running     else off("logs",    "not running"),
        q.Separator("  ─ setup ──────────────────────────"),
        on("install"),
        on("auth"),
        on("wizard"),
        on("gateway"),
        on("uninstall"),
        q.Separator("  ─────────────────────────────────"),
        on("help"),
        on("quit"),
    ]


def interactive_menu() -> None:
    """Main interactive menu loop."""
    q = require_questionary()
    style = _menu_style()
    while True:
        from .common.process import get_proxy_port, find_proxy_pid
        port    = get_proxy_port()
        running = find_proxy_pid() is not None
        state   = f"[green]running :{port}[/]" if running else "[yellow]stopped[/]"
        console.print(f"\n[bold]litellmctl[/]  [dim]proxy[/] {state}")

        try:
            choice = q.select(
                "›",
                choices=_build_choices(running, port),
                style=style,
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
    q = require_questionary()
    style = _menu_style()
    from .auth.transfer import AUTH_PROVIDERS

    choices: list = [q.Separator("  ─ login ──────────────────────────")]
    for key, label, _ in AUTH_PROVIDERS:
        choices.append(q.Choice(f"{key}  ({label})"))
    choices += [
        q.Separator("  ─ manage ─────────────────────────"),
        q.Choice("status"),
        q.Choice("refresh"),
        q.Choice("export"),
        q.Separator("  ───────────────────────────────────"),
        q.Choice("back"),
    ]

    try:
        result = q.select(
            "› auth",
            choices=choices,
            style=style,
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
        provider = q.select(
            "› refresh",
            choices=["chatgpt", "gemini", "qwen", "kimi"],
            style=style,
        ).ask()
        if provider:
            auth_dispatch(["refresh", provider])
    elif cmd == "export":
        auth_dispatch(["export"])
