"""Interactive menu for litellmctl (no-args + TTY mode)."""

from __future__ import annotations

from .common.formatting import console, info, warn
from .common.prompts import select, choice, separator


def _build_choices(running: bool, any_running: bool, any_stopped: bool) -> list:
    on  = lambda label: choice(label)
    off = lambda label, reason: choice(label, disabled=reason)

    return [
        separator("  ─ service ─────────────────────────"),
        on("start")    if any_stopped  else off("start",   "all running"),
        on("stop")     if any_running  else off("stop",    "none running"),
        on("restart")  if any_running  else off("restart", "none running"),
        on("status"),
        on("logs")     if running      else off("logs",    "proxy not running"),
        separator("  ─ setup ──────────────────────────"),
        on("install"),
        on("auth"),
        on("wizard"),
        on("gateway"),
        on("uninstall"),
        separator("  ─────────────────────────────────"),
        on("help"),
        on("quit"),
    ]


def interactive_menu() -> None:
    """Main interactive menu loop."""
    while True:
        from .common.process import get_proxy_port, find_proxy_pid
        from .common.features import get_running_features, get_stopped_features
        port    = get_proxy_port()
        running = find_proxy_pid() is not None
        running_feats = get_running_features()
        stopped_feats = get_stopped_features()
        any_running = len(running_feats) > 0
        any_stopped = len(stopped_feats) > 0
        state   = f"[green]running :{port}[/]" if running else "[yellow]stopped[/]"
        feat_summary = ", ".join(f.label for f in running_feats) if running_feats else ""
        console.print(f"\n[bold]litellmctl[/]  [dim]proxy[/] {state}")
        if feat_summary:
            console.print(f"  [dim]Active: {feat_summary}[/]")

        try:
            cmd = select("›", _build_choices(running, any_running, any_stopped))
        except KeyboardInterrupt:
            info("Goodbye.")
            return

        if cmd is None:
            info("Goodbye.")
            return

        cmd = cmd.strip()

        try:
            if cmd == "start":
                from .common.features import (
                    feature_start, multi_select_features,
                )
                stopped = get_stopped_features()
                if not stopped:
                    info("All installed features are already running.")
                else:
                    selected = multi_select_features(stopped, "start")
                    for feat in selected:
                        feature_start(feat)
            elif cmd == "stop":
                from .common.features import (
                    feature_stop, multi_select_features,
                )
                feats = get_running_features()
                if not feats:
                    info("No features are currently running.")
                else:
                    selected = multi_select_features(feats, "stop")
                    for feat in selected:
                        feature_stop(feat)
            elif cmd == "restart":
                from .common.features import (
                    feature_restart, multi_select_features,
                )
                feats = get_running_features()
                if not feats:
                    info("No features are currently running.")
                else:
                    selected = multi_select_features(feats, "restart")
                    for feat in selected:
                        feature_restart(feat)
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
                if not run_wizard():
                    warn("Wizard did not create a config file.")
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

    choices: list = [separator("  ─ login ──────────────────────────")]
    for key, label, _ in AUTH_PROVIDERS:
        choices.append(choice(f"{key}  ({label})"))
    choices += [
        separator("  ─ manage ─────────────────────────"),
        choice("status"),
        choice("refresh"),
        choice("export"),
        separator("  ───────────────────────────────────"),
        choice("back"),
    ]

    try:
        result = select("› auth", choices)
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
        provider = select(
            "› refresh",
            ["chatgpt", "gemini", "qwen", "kimi"],
        )
        if provider:
            auth_dispatch(["refresh", provider])
    elif cmd == "export":
        auth_dispatch(["export"])
