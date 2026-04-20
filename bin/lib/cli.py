"""Typer CLI for litellmctl."""

from __future__ import annotations

from typing import Optional

import typer

app = typer.Typer(
    name="litellmctl",
    help="LiteLLM proxy control CLI.",
    add_completion=False,
    no_args_is_help=False,
)


@app.command()
def start(
    features: Optional[list[str]] = typer.Argument(None, help="Features to start (omit for multi-select)"),
    port: int = typer.Option(4040, "--port", help="Port to listen on (proxy only)"),
    config: Optional[str] = typer.Option(None, "--config", help="Config file path (proxy only)"),
) -> None:
    """Start features (proxy, gateway, searxng, protonmail, embedding, transcription)."""
    from .common.features import (
        FEATURE_MAP, get_stopped_features, feature_start, multi_select_features,
    )
    from .common.platform import is_interactive
    from .common.env import load_env
    load_env()

    if features:
        for name in features:
            feat = FEATURE_MAP.get(name)
            if not feat:
                from .common.formatting import error
                error(f"Unknown feature: {name}")
                continue
            if name == "proxy":
                from .commands.service import cmd_start as proxy_start
                proxy_start(port=port, config=config)
            else:
                feature_start(feat)
        return

    if is_interactive():
        stopped = get_stopped_features()
        if not stopped:
            from .common.formatting import info
            info("All installed features are already running.")
            return
        selected = multi_select_features(stopped, "start")
        for feat in selected:
            if feat.key == "proxy":
                from .commands.service import cmd_start as proxy_start
                proxy_start(port=port, config=config)
            else:
                feature_start(feat)
    else:
        from .commands.service import cmd_start as proxy_start
        proxy_start(port=port, config=config)


@app.command()
def stop(
    features: Optional[list[str]] = typer.Argument(None, help="Features to stop (omit for multi-select)"),
) -> None:
    """Stop features (proxy, gateway, searxng, protonmail, embedding, transcription)."""
    from .common.features import (
        FEATURE_MAP, get_running_features, feature_stop, multi_select_features,
    )
    from .common.platform import is_interactive
    from .common.env import load_env
    load_env()

    if features:
        for name in features:
            feat = FEATURE_MAP.get(name)
            if not feat:
                from .common.formatting import error
                error(f"Unknown feature: {name}")
                continue
            feature_stop(feat)
        return

    if is_interactive():
        running = get_running_features()
        if not running:
            from .common.formatting import info
            info("No features are currently running.")
            return
        selected = multi_select_features(running, "stop")
        for feat in selected:
            feature_stop(feat)
    else:
        from .commands.service import cmd_stop
        cmd_stop()


@app.command()
def restart(
    features: Optional[list[str]] = typer.Argument(None, help="Features to restart (omit for multi-select)"),
    port: int = typer.Option(4040, "--port", help="Port to listen on (proxy only)"),
    config: Optional[str] = typer.Option(None, "--config", help="Config file path (proxy only)"),
) -> None:
    """Restart features (proxy, gateway, searxng, protonmail, embedding, transcription)."""
    from .common.features import (
        FEATURE_MAP, get_running_features, feature_restart, multi_select_features,
    )
    from .common.platform import is_interactive
    from .common.env import load_env
    load_env()

    if features:
        for name in features:
            feat = FEATURE_MAP.get(name)
            if not feat:
                from .common.formatting import error
                error(f"Unknown feature: {name}")
                continue
            if feat.key == "proxy":
                from .commands.service import cmd_restart as proxy_restart
                proxy_restart()
            else:
                feature_restart(feat)
        return

    if is_interactive():
        running = get_running_features()
        if not running:
            from .common.formatting import info
            info("No features are currently running.")
            return
        selected = multi_select_features(running, "restart")
        for feat in selected:
            if feat.key == "proxy":
                from .commands.service import cmd_restart as proxy_restart
                proxy_restart()
            else:
                feature_restart(feat)
    else:
        from .commands.service import cmd_restart as proxy_restart
        proxy_restart()


@app.command("r", hidden=True)
def restart_alias() -> None:
    """Alias for restart."""
    restart()


@app.command()
def logs(
    feature: Optional[str] = typer.Argument(None, help="proxy | gateway | protonmail | searxng (default: proxy)"),
) -> None:
    """Tail logs for a feature (proxy, gateway, protonmail, searxng)."""
    from .commands.service import cmd_logs
    cmd_logs(feature)


@app.command()
def proxy(
    port: int = typer.Option(4040, "--port", help="Port to listen on"),
    config: Optional[str] = typer.Option(None, "--config", help="Config file path"),
    extra_args: Optional[list[str]] = typer.Argument(None),
) -> None:
    """Start proxy in foreground (debug)."""
    from .commands.service import cmd_proxy
    cmd_proxy(port=port, config=config, extra_args=extra_args)


@app.command()
def status(
    feature: Optional[str] = typer.Argument(None, help="proxy | gateway | searxng | protonmail | embedding | transcription | auth (default: all)"),
) -> None:
    """Show status for a feature (default: everything)."""
    from .commands.status import cmd_status
    cmd_status(feature)


@app.command()
def local(subcmd: str = typer.Argument("status")) -> None:
    """Check local inference server reachability."""
    from .commands.local import cmd_local
    cmd_local(subcmd)


@app.command()
def wizard() -> None:
    """Interactive config.yaml generator."""
    from .wizard.core import run_wizard
    try:
        success = run_wizard()
        if not success:
            raise typer.Exit(1)
    except KeyboardInterrupt:
        from .common.formatting import console
        console.print("\n[yellow]  Aborted.[/]")
        raise typer.Exit(130)


@app.command()
def install(
    with_embedding: bool = typer.Option(False, "--with-embedding"),
    without_embedding: bool = typer.Option(False, "--without-embedding"),
    with_transcription: bool = typer.Option(False, "--with-transcription"),
    without_transcription: bool = typer.Option(False, "--without-transcription"),
    with_local: bool = typer.Option(False, "--with-local"),
    without_local: bool = typer.Option(False, "--without-local"),
    with_searxng: bool = typer.Option(False, "--with-searxng"),
    without_searxng: bool = typer.Option(False, "--without-searxng"),
    with_gateway: bool = typer.Option(False, "--with-gateway"),
    without_gateway: bool = typer.Option(False, "--without-gateway"),
    with_protonmail: bool = typer.Option(False, "--with-protonmail"),
    without_protonmail: bool = typer.Option(False, "--without-protonmail"),
    _post_sync: bool = typer.Option(False, "--_post-sync", hidden=True),
) -> None:
    """Install / rebuild LiteLLM."""
    from .commands.install import cmd_install

    def _mode(with_: bool, without_: bool) -> str:
        if with_:
            return "yes"
        if without_:
            return "no"
        return ""

    embed_mode = _mode(with_embedding, without_embedding)
    transcr_mode = _mode(with_transcription, without_transcription)

    if with_local:
        embed_mode = embed_mode or "yes"
        transcr_mode = transcr_mode or "yes"
    if without_local:
        embed_mode = embed_mode or "no"
        transcr_mode = transcr_mode or "no"

    try:
        cmd_install(
            embed_mode=embed_mode,
            transcr_mode=transcr_mode,
            searxng_mode=_mode(with_searxng, without_searxng),
            gateway_mode=_mode(with_gateway, without_gateway),
            proton_mode=_mode(with_protonmail, without_protonmail),
            post_sync_only=_post_sync,
        )
    except KeyboardInterrupt:
        from .common.formatting import warn
        warn("Install cancelled.")
        raise typer.Exit(130)


@app.command()
def auth(args: Optional[list[str]] = typer.Argument(None)) -> None:
    """Manage OAuth tokens (chatgpt/gemini/qwen/kimi)."""
    from .common.platform import is_interactive
    if not args and is_interactive():
        from .interactive import auth_interactive
        auth_interactive()
        return
    try:
        from .auth.cli import auth_dispatch
        auth_dispatch(args or [])
    except KeyboardInterrupt:
        from .common.formatting import warn
        warn("Auth cancelled.")
        raise typer.Exit(130)


@app.command("init-env")
def init_env() -> None:
    """Detect auth files and update .env."""
    from .commands.init_env import cmd_init_env
    cmd_init_env()


@app.command()
def uninstall(target: Optional[str] = typer.Argument(None)) -> None:
    """Remove components (service/db/servers/gateway)."""
    from .commands.uninstall import cmd_uninstall
    try:
        cmd_uninstall(target)
    except KeyboardInterrupt:
        from .common.formatting import warn
        warn("Uninstall cancelled.")
        raise typer.Exit(130)


@app.command("toggle-claude")
def toggle_claude() -> None:
    """Toggle Claude Code between direct API and proxy."""
    from .commands.toggle_claude import cmd_toggle_claude
    cmd_toggle_claude()


@app.command("setup-completions")
def setup_completions() -> None:
    """Add litellmctl to your shell."""
    from .commands.completions import cmd_setup_completions
    cmd_setup_completions()


@app.command()
def deploy(
    target: str = typer.Argument("aws", help="Deploy target (aws)"),
) -> None:
    """Interactive one-shot onboarding for a container target (AWS EC2 today)."""
    from .commands.deploy import cmd_deploy
    cmd_deploy(target)


@app.command(hidden=True)
def help() -> None:
    """Show help."""
    _show_help()


@app.command("_fg", hidden=True)
def _foreground(
    service: str = typer.Argument(..., help="proxy | gateway | searxng | ollama | whisper"),
    port: int = typer.Option(4040, "--port", help="Port (proxy only)"),
    config: Optional[str] = typer.Option(None, "--config", help="Config file (proxy only)"),
) -> None:
    """Run a service in the foreground (docker harness / s6-overlay).

    Each branch replaces the current process via os.execvp so the process
    tree is flat and the supervisor sees real exit signals.
    """
    from .common.env import load_env
    load_env()

    svc = service.lower()
    if svc == "proxy":
        from .commands.service import cmd_proxy
        cmd_proxy(port=port, config=config)
    elif svc == "gateway":
        from .commands.gateway import gateway_start_foreground
        gateway_start_foreground()
    elif svc == "searxng":
        from .commands.searxng import searxng_start_foreground
        searxng_start_foreground()
    elif svc == "ollama":
        from .commands.local import ollama_start_foreground
        ollama_start_foreground()
    elif svc in ("whisper", "transcription"):
        from .commands.local import transcription_start_foreground
        transcription_start_foreground()
    else:
        from .common.formatting import error
        error(f"Unknown foreground service: {service}")
        raise typer.Exit(2)


# ── Flat gateway utility commands ────────────────────────────────────────────
# All service lifecycle (start/stop/restart/status/logs) goes through the
# top-level commands, NOT through a nested `gateway` sub-app. These are gateway-
# specific data commands that don't fit elsewhere.

@app.command("users")
def users_cmd() -> None:
    """List all gateway users and their roles."""
    from .commands.gateway import gateway_user_list
    gateway_user_list()


@app.command("set-role")
def set_role_cmd(
    email: str = typer.Argument(..., help="User email address"),
    role: str = typer.Argument(..., help="guest | user | admin"),
) -> None:
    """Set a gateway user's role (guest/user/admin)."""
    from .commands.gateway import gateway_set_role
    gateway_set_role(email, role)


@app.command("routes")
def routes_cmd() -> None:
    """List all gateway API endpoints (parsed from source)."""
    from .commands.gateway import gateway_routes
    gateway_routes()


@app.command(
    "api",
    context_settings={
        "allow_extra_args": True,
        "allow_interspersed_args": True,
        "ignore_unknown_options": True,
    },
)
def api_cmd(ctx: typer.Context) -> None:
    """Call a gateway API endpoint via the CLI (bypasses auth via localhost secret).

    Examples:
        litellmctl api health
        litellmctl api stats requests
        litellmctl api admin users
        litellmctl api keys delete abc123
        litellmctl api search q=hello
        litellmctl api admin approve -d '{"email":"x@y.com"}'
    """
    from .commands.gateway import gateway_api
    # Parse -d/--data from extra args manually (typer can't with allow_extra_args)
    args = list(ctx.args)
    data: str | None = None
    for flag in ("-d", "--data"):
        if flag in args:
            idx = args.index(flag)
            if idx + 1 < len(args):
                data = args[idx + 1]
                del args[idx:idx + 2]
            else:
                del args[idx]
            break
    gateway_api(args, data)


@app.command("migrate-from-mongo")
def migrate_from_mongo_cmd(
    mongo_uri: Optional[str] = typer.Option(None, "--mongo-uri", help="MongoDB URI (defaults to GATEWAY_MONGODB_URI env var)"),
    force: bool = typer.Option(False, "--force", help="Overlay onto a non-empty SQLite DB (may create duplicates in usage_logs)"),
) -> None:
    """One-shot migration of legacy MongoDB data into the gateway SQLite DB."""
    from .commands.gateway import gateway_migrate_from_mongo
    gateway_migrate_from_mongo(mongo_uri=mongo_uri, force=force)


def _show_help() -> None:
    from .common.formatting import console
    console.print("""
[bold]litellmctl — LiteLLM Proxy Control[/]

[bold]Usage:[/]  litellmctl <command> [args...]

[bold]Features[/]  (used as arguments to start/stop/restart/status/logs):
  proxy | gateway | searxng | protonmail | embedding | transcription

[bold]Lifecycle:[/]
  install [options]             Install / rebuild LiteLLM (local servers, gateway, etc.)
  uninstall [target]            Stop and remove components
  start [features...]           Start features (multi-select if omitted)
  stop [features...]            Stop features (multi-select if omitted)
  restart [features...]         Restart features (multi-select if omitted)
  status [feature]              Show status for one feature (default: all)
  logs [feature]                Tail logs for one feature (default: proxy)

[bold]Auth:[/]
  auth chatgpt                  Login to ChatGPT / Codex (browser PKCE)
  auth gemini                   Login to Gemini CLI (browser PKCE)
  auth qwen                     Login to Qwen Portal (device-code)
  auth kimi                     Login to Kimi Code (device-code)
  auth protonmail               Authenticate hydroxide SMTP bridge
  auth refresh <provider>       Refresh token for <chatgpt|gemini|qwen|kimi>
  auth status                   Show auth token status
  auth export [providers...]    Copy credentials as a paste-able transfer script
  auth import                   Read credentials from stdin

[bold]Gateway data:[/]
  users                         List all gateway users and roles
  set-role <email> <role>       Set a gateway user's role (guest/user/admin)
  routes                        List all gateway API endpoints
  api <cmd...> [-d json] [k=v]  Call a gateway API endpoint via CLI
  migrate-from-mongo            Migrate legacy MongoDB data into SQLite

[bold]Other:[/]
  wizard                        Interactive config.yaml generator
  init-env                      Detect auth files and update .env paths
  proxy [--port N]              Start proxy in foreground (for debugging)
  local [status]                Check local inference server reachability
  toggle-claude                 Toggle Claude Code between direct API and proxy
  deploy [target]               One-shot AWS onboarding + deploy (target: aws)
  setup-completions             Add litellmctl to your shell
  help                          Show this help

[bold]Service:[/]
  macOS: launchd agent (~/Library/LaunchAgents/)
  Linux: systemd user unit (~/.config/systemd/user/)
  Fallback: nohup background (servers without systemd user bus)
""")
