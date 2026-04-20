"""Interactive menu for litellmctl (no-args + TTY mode).

This is the menu-driven equivalent of the flat CLI surface in cli.py.
Every top-level command must have a corresponding menu entry here —
when you add a new command in cli.py, add it here too.
"""

from __future__ import annotations

from .common.formatting import console, info, warn
from .common.prompts import ask, select, choice, separator


_FEATURES = ("proxy", "gateway", "searxng", "protonmail", "embedding", "transcription")
_STATUS_TARGETS = _FEATURES + ("auth", "all")
_LOGS_TARGETS = ("proxy", "gateway", "protonmail", "searxng")
_ROLES = ("guest", "user", "admin")


# ── Main menu ────────────────────────────────────────────────────────────────

def _build_main_choices(
    proxy_running: bool,
    any_running: bool,
    any_stopped: bool,
) -> list:
    on  = lambda label: choice(label)
    off = lambda label, reason: choice(label, disabled=reason)

    return [
        separator("  ─ lifecycle ────────────────────────"),
        on("start")    if any_stopped  else off("start",   "all running"),
        on("stop")     if any_running  else off("stop",    "none running"),
        on("restart")  if any_running  else off("restart", "none running"),
        on("status"),
        on("logs"),

        separator("  ─ auth ─────────────────────────────"),
        on("auth"),

        separator("  ─ gateway data ─────────────────────"),
        on("users"),
        on("set-role"),
        on("routes"),
        on("api"),
        on("migrate-from-mongo"),

        separator("  ─ setup ────────────────────────────"),
        on("wizard"),
        on("install"),
        on("init-env"),
        on("toggle-claude"),
        on("setup-completions"),
        on("uninstall"),

        separator("  ─ debug ────────────────────────────"),
        on("proxy")  if not proxy_running else off("proxy", "proxy already running — stop it first"),
        on("local"),

        separator("  ─────────────────────────────────────"),
        on("help"),
        on("quit"),
    ]


def interactive_menu() -> None:
    """Main interactive menu loop — a navigable view of every CLI command."""
    while True:
        from .common.process import get_proxy_port, find_proxy_pid
        from .common.features import get_running_features, get_stopped_features
        port    = get_proxy_port()
        proxy_running = find_proxy_pid() is not None
        running_feats = get_running_features()
        stopped_feats = get_stopped_features()
        any_running = len(running_feats) > 0
        any_stopped = len(stopped_feats) > 0
        state   = f"[green]running :{port}[/]" if proxy_running else "[yellow]stopped[/]"
        feat_summary = ", ".join(f.label for f in running_feats) if running_feats else ""
        console.print(f"\n[bold]litellmctl[/]  [dim]proxy[/] {state}")
        if feat_summary:
            console.print(f"  [dim]Active: {feat_summary}[/]")

        try:
            cmd = select("›", _build_main_choices(proxy_running, any_running, any_stopped))
        except KeyboardInterrupt:
            info("Goodbye.")
            return

        if cmd is None:
            info("Goodbye.")
            return

        cmd = cmd.strip()
        try:
            _dispatch(cmd)
        except KeyboardInterrupt:
            console.print()
            warn("Cancelled.")

        if cmd == "quit":
            return


def _dispatch(cmd: str) -> None:
    # ── Lifecycle ────────────────────────────────────────────────────────────
    if cmd == "start":
        _multi_feature_action("start")
    elif cmd == "stop":
        _multi_feature_action("stop")
    elif cmd == "restart":
        _multi_feature_action("restart")
    elif cmd == "status":
        _status_interactive()
    elif cmd == "logs":
        _logs_interactive()

    # ── Auth ─────────────────────────────────────────────────────────────────
    elif cmd == "auth":
        auth_interactive()

    # ── Gateway data ─────────────────────────────────────────────────────────
    elif cmd == "users":
        from .commands.gateway import gateway_user_list
        gateway_user_list()
    elif cmd == "set-role":
        _set_role_interactive()
    elif cmd == "routes":
        from .commands.gateway import gateway_routes
        gateway_routes()
    elif cmd == "api":
        _api_interactive()
    elif cmd == "migrate-from-mongo":
        _migrate_interactive()

    # ── Setup ────────────────────────────────────────────────────────────────
    elif cmd == "wizard":
        from .wizard.core import run_wizard
        if not run_wizard():
            warn("Wizard did not create a config file.")
    elif cmd == "install":
        from .commands.install import cmd_install
        cmd_install()
    elif cmd == "init-env":
        from .commands.init_env import cmd_init_env
        cmd_init_env()
    elif cmd == "toggle-claude":
        from .commands.toggle_claude import cmd_toggle_claude
        cmd_toggle_claude()
    elif cmd == "setup-completions":
        from .commands.completions import cmd_setup_completions
        cmd_setup_completions()
    elif cmd == "uninstall":
        from .commands.uninstall import cmd_uninstall
        cmd_uninstall()

    # ── Debug ────────────────────────────────────────────────────────────────
    elif cmd == "proxy":
        _proxy_interactive()
    elif cmd == "local":
        from .commands.local import cmd_local
        cmd_local("status")

    # ── Help / quit ──────────────────────────────────────────────────────────
    elif cmd == "help":
        from .cli import _show_help
        _show_help()
    elif cmd == "quit":
        info("Goodbye.")


# ── Lifecycle helpers ────────────────────────────────────────────────────────

def _multi_feature_action(action: str) -> None:
    """Multi-select features and apply start/stop/restart."""
    from .common.features import (
        feature_start, feature_stop, feature_restart,
        get_stopped_features, get_running_features, multi_select_features,
    )
    if action == "start":
        feats = get_stopped_features()
        if not feats:
            info("All installed features are already running.")
            return
        op = feature_start
    elif action == "stop":
        feats = get_running_features()
        if not feats:
            info("No features are currently running.")
            return
        op = feature_stop
    else:  # restart
        feats = get_running_features()
        if not feats:
            info("No features are currently running.")
            return
        op = feature_restart

    selected = multi_select_features(feats, action)
    for feat in selected:
        op(feat)


def _status_interactive() -> None:
    """Ask which feature to show status for (or 'all')."""
    from .commands.status import cmd_status
    target = select(
        "› status for which feature? (Esc = all)",
        [choice(label="all (default)", value="all"), *[choice(label=f, value=f) for f in _STATUS_TARGETS if f != "all"]],
    )
    if target is None:
        return
    cmd_status(None if target == "all" else target)


def _logs_interactive() -> None:
    """Ask which feature's logs to tail."""
    from .commands.service import cmd_logs
    target = select(
        "› tail which log?",
        [choice(label=f, value=f) for f in _LOGS_TARGETS],
    )
    if target is None:
        return
    try:
        cmd_logs(target)
    except KeyboardInterrupt:
        console.print("\n")
        info("Stopped tailing.")


# ── Gateway data helpers ─────────────────────────────────────────────────────

def _set_role_interactive() -> None:
    """Prompt for email + role and set it on the gateway DB."""
    email = ask("User email (empty cancels):")
    if not email:
        return
    role = select("› new role", [choice(label=r, value=r) for r in _ROLES])
    if role is None:
        return
    from .commands.gateway import gateway_set_role
    gateway_set_role(email, role)


def _api_interactive() -> None:
    """Prompt for a gateway API command line and dispatch it."""
    console.print(
        "  [dim]Examples: 'health', 'stats user', 'admin users', 'keys delete <id>'[/]",
    )
    raw = ask("› api command (empty cancels):")
    if not raw or not raw.strip():
        return
    parts = raw.strip().split()
    data: str | None = None
    if "-d" in parts or "--data" in parts:
        flag = "-d" if "-d" in parts else "--data"
        idx = parts.index(flag)
        if idx + 1 < len(parts):
            data = parts[idx + 1]
            del parts[idx:idx + 2]
    from .commands.gateway import gateway_api
    gateway_api(parts, data)


def _migrate_interactive() -> None:
    """Prompt for Mongo URI (+ optional --force) and run the migration."""
    import os
    uri = os.environ.get("GATEWAY_MONGODB_URI", "") or ask(
        "Mongo URI (empty cancels):",
    )
    if not uri:
        info("Cancelled.")
        return
    force_answer = select(
        "› overlay onto existing SQLite data?",
        [
            choice(label="no — refuse if non-empty (safe)", value="no"),
            choice(label="yes — --force (may duplicate usage_logs)", value="yes"),
        ],
    )
    if force_answer is None:
        return
    from .commands.gateway import gateway_migrate_from_mongo
    gateway_migrate_from_mongo(mongo_uri=uri, force=force_answer == "yes")


# ── Debug helpers ────────────────────────────────────────────────────────────

def _proxy_interactive() -> None:
    """Start the proxy in the foreground (debug). Prompts for port override."""
    from .commands.service import cmd_proxy
    port_str = ask("Port (default 4040):", default="4040")
    try:
        port = int(port_str)
    except ValueError:
        warn(f"Invalid port '{port_str}' — using 4040")
        port = 4040
    try:
        cmd_proxy(port=port)
    except KeyboardInterrupt:
        console.print()
        info("Proxy stopped.")


# ── Auth submenu ─────────────────────────────────────────────────────────────

def auth_interactive() -> None:
    """Interactive auth provider selection. Mirrors `litellmctl auth` dispatcher."""
    from .auth.transfer import AUTH_PROVIDERS

    choices: list = [separator("  ─ login ──────────────────────────")]
    for key, label, _ in AUTH_PROVIDERS:
        choices.append(choice(f"{key}  ({label})"))
    choices.append(choice("protonmail  (Hydroxide SMTP bridge)"))
    choices += [
        separator("  ─ manage ─────────────────────────"),
        choice("status"),
        choice("refresh"),
        choice("export"),
        choice("import"),
        choice("providers"),
        separator("  ───────────────────────────────────"),
        choice("back"),
    ]

    try:
        result = select("› auth", choices)
    except KeyboardInterrupt:
        return

    if result is None or result == "back":
        return

    cmd = result.split()[0]
    from .auth.cli import auth_dispatch

    if cmd in ("chatgpt", "gemini", "qwen", "kimi", "protonmail"):
        auth_dispatch([cmd])
    elif cmd in ("status", "export", "import", "providers"):
        auth_dispatch([cmd])
    elif cmd == "refresh":
        provider = select(
            "› refresh",
            ["chatgpt", "gemini", "qwen", "kimi"],
        )
        if provider:
            auth_dispatch(["refresh", provider])
