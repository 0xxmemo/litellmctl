"""Status display command."""

from __future__ import annotations

import os
import subprocess
import sys

from ..common.paths import PROJECT_DIR, VENV_DIR, BIN_DIR, LOG_DIR, PIDFILE
from ..common.env import load_env
from ..common.formatting import console, info, warn
from ..common.platform import is_macos, is_linux
from ..common.process import get_proxy_port, find_proxy_pid
from ..common.network import http_check

from .service import (
    _activate_venv, launchd_is_running, systemd_is_running, nohup_is_running,
)
from .local import local_status
from .gateway import gateway_status
from .searxng import searxng_status
from .protonmail import protonmail_status


def proxy_http_health(port: int) -> str:
    if http_check(f"http://127.0.0.1:{port}/health/readiness"):
        return "healthy"
    return "unhealthy"


def quick_status_line() -> None:
    port = get_proxy_port()
    pid = find_proxy_pid()
    if pid:
        console.print(f"  Proxy  [green]running[/]  :{port}")
    else:
        console.print("  Proxy  [yellow]stopped[/]")


def cmd_status() -> None:
    _activate_venv()
    load_env()

    # Auth status
    try:
        from ..auth.status import show_status
        show_status()
    except Exception:
        warn("Could not load auth status.")

    port = get_proxy_port()
    console.print("[bold]Proxy[/]")

    pid = find_proxy_pid()

    if is_macos() and launchd_is_running():
        if pid:
            console.print("  Service: [green]running[/] (launchd, auto-start enabled)")
        else:
            console.print("  Service: [yellow]loaded, but proxy not listening[/] (launchd)")
        console.print(f"  Port:    {port}")
        if pid:
            console.print(f"  PID:     {pid}")
            health = proxy_http_health(port)
            if health == "healthy":
                console.print("  Health:  [green]healthy[/]")
            else:
                console.print("  Health:  [red]unhealthy (HTTP checks timing out/failing)[/]")
        console.print()

    elif is_linux() and systemd_is_running():
        if pid:
            console.print("  Service: [green]running[/] (systemd, auto-start enabled)")
        else:
            console.print("  Service: [yellow]loaded, but proxy not listening[/] (systemd)")
        console.print(f"  Port:    {port}")
        if pid:
            console.print(f"  PID:     {pid}")
            health = proxy_http_health(port)
            if health == "healthy":
                console.print("  Health:  [green]healthy[/]")
            else:
                console.print("  Health:  [red]unhealthy (HTTP checks timing out/failing)[/]")
        console.print()

    elif nohup_is_running():
        if pid is None and PIDFILE.exists():
            try:
                pid = int(PIDFILE.read_text().strip())
            except ValueError:
                pass
        if pid:
            console.print("  Service: [green]running[/] (nohup, background)")
        else:
            console.print("  Service: [yellow]started, but proxy not listening[/] (nohup)")
        console.print(f"  Port:    {port}")
        if pid:
            console.print(f"  PID:     {pid}")
            health = proxy_http_health(port)
            if health == "healthy":
                console.print("  Health:  [green]healthy[/]")
            else:
                console.print("  Health:  [red]unhealthy (HTTP checks timing out/failing)[/]")
        console.print()

    else:
        if pid:
            console.print(f"  PID {pid} running on port {port} (foreground)\n")
        else:
            console.print("  [yellow]Not running[/]\n")

    local_status()
    searxng_status()
    gateway_status()
    protonmail_status()
