"""Process management utilities."""

from __future__ import annotations

import re
import shutil
import subprocess
import time

from .formatting import warn
from .paths import PORT_FILE, PIDFILE


def get_proxy_port() -> int:
    """Read proxy port from file, default 4040."""
    if PORT_FILE.exists():
        try:
            return int(PORT_FILE.read_text().strip())
        except ValueError:
            pass
    return 4040


def pids_on_port(port: int) -> list[int]:
    """Return PIDs listening on a port. Works on macOS and Linux."""
    pids: list[int] = []
    if shutil.which("lsof"):
        result = subprocess.run(
            ["lsof", "-i", f":{port}", "-t"],
            capture_output=True, text=True,
        )
        for line in result.stdout.strip().splitlines():
            line = line.strip()
            if line.isdigit():
                pids.append(int(line))
    elif shutil.which("ss"):
        result = subprocess.run(
            ["ss", "-tlnp", f"sport = :{port}"],
            capture_output=True, text=True,
        )
        for m in re.finditer(r"pid=(\d+)", result.stdout):
            pids.append(int(m.group(1)))
    elif shutil.which("fuser"):
        result = subprocess.run(
            ["fuser", f"{port}/tcp"],
            capture_output=True, text=True,
        )
        for token in result.stdout.split():
            token = token.strip()
            if token.isdigit():
                pids.append(int(token))
    return pids


def is_litellm_pid(pid: int) -> bool:
    """Check if a PID is a litellm process."""
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True,
        )
        return "litellm" in result.stdout
    except Exception:
        return False


def find_proxy_pid() -> int | None:
    """Find the first LiteLLM PID on the proxy port."""
    port = get_proxy_port()
    for pid in pids_on_port(port):
        if is_litellm_pid(pid):
            return pid
    return None


def kill_stale(port: int) -> None:
    """Kill stale litellm processes on a port."""
    stale = [p for p in pids_on_port(port) if is_litellm_pid(p)]
    if stale:
        warn(f"Killing {len(stale)} stale litellm process(es) on port {port}: {' '.join(map(str, stale))}")
        for pid in stale:
            try:
                subprocess.call(["kill", "-9", str(pid)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                pass
        time.sleep(1)
