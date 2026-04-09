"""SearXNG search server management."""

from __future__ import annotations

import os
import shutil
import subprocess
import time

from ruamel.yaml import YAML

from ..common.formatting import console, info, warn
from ..common.network import http_check
from ..common.paths import PROJECT_DIR

SETTINGS_FILE = PROJECT_DIR / "searxng" / "settings.yml"

_yaml = YAML()
_yaml.preserve_quotes = True


def _sync_proxy_settings() -> None:
    """Sync SEARXNG_PROXIES env var into settings.yml before container start."""
    proxies_raw = os.environ.get("SEARXNG_PROXIES", "").strip()
    if not SETTINGS_FILE.exists():
        return

    data = _yaml.load(SETTINGS_FILE)
    if data is None:
        data = {}

    if proxies_raw:
        proxy_list = [p.strip() for p in proxies_raw.split(",") if p.strip()]
        data.setdefault("outgoing", {})
        data["outgoing"]["proxies"] = {"all://": proxy_list}
        info(f"Rotating proxies configured ({len(proxy_list)} endpoints)")
    else:
        # Remove proxy config if env var is unset
        if "outgoing" in data and "proxies" in data.get("outgoing", {}):
            del data["outgoing"]["proxies"]
            if not data["outgoing"]:
                del data["outgoing"]

    with open(SETTINGS_FILE, "w") as f:
        _yaml.dump(data, f)


def install_searxng() -> bool:
    port = int(os.environ.get("SEARXNG_PORT", "8888"))
    container = "searxng"

    if not shutil.which("docker"):
        warn("Docker not found — SearXNG requires Docker to run.")
        warn("Install Docker: https://docs.docker.com/get-docker/")
        return False

    info("Setting up SearXNG search server")

    _sync_proxy_settings()

    result = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    if container in result.stdout.splitlines():
        info(f"SearXNG container already running on port {port}")
        return True

    result = subprocess.run(
        ["docker", "ps", "-a", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    if container in result.stdout.splitlines():
        info("Starting existing SearXNG container ...")
        if subprocess.call(["docker", "start", container]) != 0:
            warn("Failed to start SearXNG container")
            return False
        time.sleep(3)
    else:
        info("Creating SearXNG container ...")
        cmd = [
            "docker", "run", "-d",
            "--name", container,
            "--restart", "unless-stopped",
            "-p", f"{port}:8080",
            "-e", f"SEARXNG_BASE_URL=http://localhost:{port}/",
        ]
        # Mount local settings override (enables JSON API format)
        if SETTINGS_FILE.exists():
            cmd += ["-v", f"{SETTINGS_FILE}:/etc/searxng/settings.yml"]
        cmd.append("searxng/searxng:latest")

        ret = subprocess.call(cmd)
        if ret != 0:
            warn("Failed to create SearXNG container")
            return False
        time.sleep(5)

    if http_check(f"http://localhost:{port}/", timeout=5):
        info(f"SearXNG started successfully at http://localhost:{port}")
        info(f"Web UI: http://localhost:{port}")
        info(f"API endpoint: http://localhost:{port}/search")
    else:
        warn("SearXNG container started but not responding yet")
        warn(f"Check logs: docker logs {container}")
    return True


def searxng_status() -> None:
    port = int(os.environ.get("SEARXNG_PORT", "8888"))
    container = "searxng"
    console.print("[bold]SearXNG Search[/]")

    if not shutil.which("docker"):
        console.print("  Docker not installed\n")
        return

    result = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    if container in result.stdout.splitlines():
        if http_check(f"http://localhost:{port}/", timeout=3):
            console.print("  Status:   [green]running[/]")
            console.print(f"  Port:     {port}")
            console.print(f"  Web UI:   http://localhost:{port}")
            console.print(f"  API:      http://localhost:{port}/search")
            proxies_raw = os.environ.get("SEARXNG_PROXIES", "").strip()
            if proxies_raw:
                count = len([p for p in proxies_raw.split(",") if p.strip()])
                console.print(f"  Proxies:  [cyan]{count} rotating[/]")
        else:
            console.print("  Status:   [yellow]running but not responding[/]")
            console.print(f"  Port:     {port}")
            console.print(f"  [dim]Check: docker logs {container}[/]")
    else:
        result2 = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}"],
            capture_output=True, text=True,
        )
        if container in result2.stdout.splitlines():
            console.print("  Status:   [yellow]stopped[/]")
            console.print(f"  [dim]Start: docker start {container}[/]")
        else:
            console.print("  Status:   [yellow]not installed[/]")
            console.print("  [dim]Install: litellmctl install --with-searxng[/]")
    console.print()


def uninstall_searxng() -> None:
    port = int(os.environ.get("SEARXNG_PORT", "8888"))
    container = "searxng"
    console.print("\n  [bold]SearXNG (search server)[/]")

    if not shutil.which("docker"):
        console.print("  Docker not installed.\n")
        return

    result = subprocess.run(
        ["docker", "ps", "-a", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    if container in result.stdout.splitlines():
        result2 = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True, text=True,
        )
        if container in result2.stdout.splitlines():
            console.print(f"  Running at http://localhost:{port}. Stop it:\n")
            console.print(f"      docker stop {container}\n")
        else:
            console.print("  Container exists but is stopped.\n")
        console.print("  Remove container:\n")
        console.print(f"      docker stop {container} && docker rm {container}\n")
    else:
        console.print("  Not installed.\n")
