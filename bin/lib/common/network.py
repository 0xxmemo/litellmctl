"""Network utilities — HTTP checks, port detection."""

from __future__ import annotations

import shutil
import subprocess
import time
import urllib.error
import urllib.request

from .formatting import info, warn


def http_check(url: str, timeout: int = 3) -> bool:
    """Return True if url responds 2xx."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


def transcr_http_check(base_url: str, timeout: int = 3) -> bool:
    """Return True if transcription server accepts connections (any HTTP status)."""
    try:
        urllib.request.urlopen(f"{base_url.rstrip('/')}/audio/transcriptions", timeout=timeout)
        return True
    except urllib.error.HTTPError:
        return True  # any HTTP response = server is up
    except Exception:
        return False


def port_in_use(port: int) -> bool:
    """Return True if something is listening on the given port."""
    if shutil.which("lsof"):
        return subprocess.call(
            ["lsof", "-i", f":{port}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ) == 0
    if shutil.which("ss"):
        result = subprocess.run(
            ["ss", "-tlnH", f"sport = :{port}"],
            capture_output=True, text=True,
        )
        return bool(result.stdout.strip())
    if shutil.which("netstat"):
        result = subprocess.run(
            ["netstat", "-tlnp"],
            capture_output=True, text=True,
        )
        return f":{port} " in result.stdout
    return False


def wait_for_ready(port: int, tries: int = 30) -> bool:
    """Wait for proxy to become healthy. Returns True if healthy."""
    for i in range(tries):
        if http_check(f"http://127.0.0.1:{port}/health/readiness"):
            info(f"Proxy is healthy on port {port}.")
            return True
        time.sleep(1)
    warn(f"Proxy did not become healthy within {tries}s.")
    warn("Check logs with: litellmctl logs")
    return False
