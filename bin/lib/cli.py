"""Typer CLI for litellmctl."""

from __future__ import annotations

import sys
from typing import Optional

import typer

app = typer.Typer(
    name="litellmctl",
    help="LiteLLM proxy control CLI.",
    add_completion=False,
    no_args_is_help=False,
)

gateway_app = typer.Typer(help="Manage LLM API Gateway UI.")
app.add_typer(gateway_app, name="gateway")

protonmail_app = typer.Typer(help="Manage ProtonMail SMTP bridge (hydroxide).")
app.add_typer(protonmail_app, name="protonmail")


@app.command()
def start(
    port: int = typer.Option(4040, "--port", help="Port to listen on"),
    config: Optional[str] = typer.Option(None, "--config", help="Config file path"),
) -> None:
    """Start proxy as background service."""
    from .commands.service import cmd_start
    cmd_start(port=port, config=config)


@app.command()
def stop() -> None:
    """Stop the proxy service."""
    from .commands.service import cmd_stop
    cmd_stop()


@app.command()
def restart() -> None:
    """Restart the proxy service."""
    from .commands.service import cmd_restart
    cmd_restart()


@app.command("r", hidden=True)
def restart_alias() -> None:
    """Alias for restart."""
    from .commands.service import cmd_restart
    cmd_restart()


@app.command()
def logs() -> None:
    """Tail proxy logs."""
    from .commands.service import cmd_logs
    cmd_logs()


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
def status() -> None:
    """Show auth + proxy + local server status."""
    from .commands.status import cmd_status
    cmd_status()


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
        run_wizard()
    except KeyboardInterrupt:
        from .common.formatting import console
        console.print("\n[yellow]  Aborted.[/]")
        raise typer.Exit(130)


@app.command()
def install(
    with_db: bool = typer.Option(False, "--with-db", help="Enable DB setup"),
    without_db: bool = typer.Option(False, "--without-db", help="Skip DB setup"),
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

    db_mode = _mode(with_db, without_db)
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
            db_mode=db_mode,
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


@app.command(hidden=True)
def help() -> None:
    """Show help."""
    _show_help()


# Gateway subcommands
@gateway_app.command("start")
def gateway_start() -> None:
    """Start the gateway."""
    from .commands.gateway import cmd_gateway
    cmd_gateway("start")


@gateway_app.command("stop")
def gateway_stop() -> None:
    """Stop the gateway."""
    from .commands.gateway import cmd_gateway
    cmd_gateway("stop")


@gateway_app.command("restart")
def gateway_restart() -> None:
    """Restart the gateway."""
    from .commands.gateway import cmd_gateway
    cmd_gateway("restart")


@gateway_app.command("status")
def gateway_status_cmd() -> None:
    """Show gateway status."""
    from .commands.gateway import cmd_gateway
    cmd_gateway("status")


@gateway_app.command("logs")
def gateway_logs() -> None:
    """Tail gateway logs."""
    from .commands.gateway import cmd_gateway
    cmd_gateway("logs")


# ProtonMail subcommands
@protonmail_app.command("start")
def protonmail_start() -> None:
    """Start hydroxide SMTP bridge."""
    from .commands.protonmail import cmd_protonmail
    cmd_protonmail("start")


@protonmail_app.command("stop")
def protonmail_stop() -> None:
    """Stop hydroxide SMTP bridge."""
    from .commands.protonmail import cmd_protonmail
    cmd_protonmail("stop")


@protonmail_app.command("restart")
def protonmail_restart() -> None:
    """Restart hydroxide SMTP bridge."""
    from .commands.protonmail import cmd_protonmail
    cmd_protonmail("restart")


@protonmail_app.command("status")
def protonmail_status_cmd() -> None:
    """Show ProtonMail bridge status."""
    from .commands.protonmail import cmd_protonmail
    cmd_protonmail("status")


@protonmail_app.command("auth")
def protonmail_auth() -> None:
    """Show how to authenticate hydroxide."""
    from .commands.protonmail import cmd_protonmail
    cmd_protonmail("auth")


def _show_help() -> None:
    from .common.formatting import console
    console.print("""
[bold]litellmctl — LiteLLM Proxy Control[/]

[bold]Usage:[/]  litellmctl <command> [args...]

[bold]Commands:[/]
  wizard               Interactive config.yaml generator (providers, tiers, fallbacks)
  install [options]     Install / rebuild LiteLLM (prompts for DB + local server setup)
  init-env             Detect auth files and update .env with correct paths
  auth chatgpt         Login to ChatGPT / Codex (browser PKCE)
  auth gemini          Login to Gemini CLI (browser PKCE)
  auth qwen            Login to Qwen Portal (device-code)
  auth kimi            Login to Kimi Code (device-code)
  auth refresh <p>     Refresh token for <chatgpt|gemini|qwen|kimi>
  auth export [p...]   Copy credentials as a paste-able transfer script
  auth import          Read credentials from stdin
  auth status          Show auth token status
  start [--port N]     Start proxy as background service (auto-start on boot)
  stop                 Stop the proxy service
  restart | r          Restart the proxy service
  logs                 Tail proxy logs
  proxy [--port N]     Start proxy in foreground (for debugging)
  status               Show auth + proxy + local server status
  local [status]       Check local inference server reachability
  gateway [start|stop|restart|status|logs]
                       Manage LLM API Gateway UI (web dashboard)
  protonmail [start|stop|restart|status|auth]
                       Manage hydroxide SMTP bridge for OTP emails
  uninstall [target]   Stop and remove components
  toggle-claude        Toggle Claude Code between direct API and proxy
  setup-completions    Add litellmctl to your shell
  help                 Show this help

[bold]Service:[/]
  macOS: launchd agent (~/Library/LaunchAgents/)
  Linux: systemd user unit (~/.config/systemd/user/)
  Fallback: nohup background (servers without systemd user bus)
""")
