"""Feature registry — single source of truth for all manageable services."""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable

from .env import load_env
from .formatting import info, warn
from .network import port_in_use
from .paths import PROJECT_DIR
from .process import find_proxy_pid


@dataclass
class Feature:
    """A startable/stoppable service managed by litellmctl."""

    key: str
    label: str
    is_installed: Callable[[], bool]
    is_running: Callable[[], bool]
    start: Callable[[], None]
    stop: Callable[[], None]
    restart: Callable[[], None] | None = None  # falls back to stop+start


# ── Individual feature detection / control ────────────────────────────────────

# Proxy
def _proxy_installed() -> bool:
    from .paths import VENV_DIR
    return VENV_DIR.exists()


def _proxy_running() -> bool:
    return find_proxy_pid() is not None


def _proxy_start() -> None:
    from ..commands.service import cmd_start
    cmd_start()


def _proxy_stop() -> None:
    from ..commands.service import cmd_stop
    cmd_stop()


def _proxy_restart() -> None:
    from ..commands.service import cmd_restart
    cmd_restart()


# Gateway
def _gateway_installed() -> bool:
    return (PROJECT_DIR / "gateway").exists()


def _gateway_running() -> bool:
    from ..commands.gateway import gateway_is_running
    return gateway_is_running()


def _gateway_start() -> None:
    from ..commands.gateway import gateway_start as gs
    gs()


def _gateway_stop() -> None:
    from ..commands.gateway import gateway_stop as gs
    gs()


def _gateway_restart() -> None:
    from ..commands.gateway import cmd_gateway
    cmd_gateway("restart")


# SearXNG
def _searxng_installed() -> bool:
    if not shutil.which("docker"):
        return False
    result = subprocess.run(
        ["docker", "ps", "-a", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    return "searxng" in result.stdout.splitlines()


def _searxng_running() -> bool:
    if not shutil.which("docker"):
        return False
    result = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    return "searxng" in result.stdout.splitlines()


def _searxng_start() -> None:
    if not shutil.which("docker"):
        warn("Docker not found — SearXNG requires Docker")
        return
    ret = subprocess.call(["docker", "start", "searxng"])
    if ret == 0:
        info("SearXNG started")
    else:
        warn("Failed to start SearXNG container")


def _searxng_stop() -> None:
    if not shutil.which("docker"):
        return
    ret = subprocess.call(["docker", "stop", "searxng"])
    if ret == 0:
        info("SearXNG stopped")
    else:
        warn("SearXNG not running")


# ProtonMail (hydroxide)
def _protonmail_installed() -> bool:
    from ..commands.protonmail import _hydroxide_bin
    return _hydroxide_bin() is not None


def _protonmail_running() -> bool:
    return port_in_use(1025)


def _protonmail_start() -> None:
    from ..commands.protonmail import hydroxide_start
    hydroxide_start()


def _protonmail_stop() -> None:
    from ..commands.protonmail import hydroxide_stop
    hydroxide_stop()


# Embedding (Ollama)
def _embedding_installed() -> bool:
    return shutil.which("ollama") is not None


def _embedding_running() -> bool:
    from ..commands.local import _ollama_is_running
    embed_base = os.environ.get(
        "LOCAL_EMBEDDING_API_BASE",
        os.environ.get("OLLAMA_API_BASE", "http://localhost:11434"),
    )
    return _ollama_is_running(embed_base)


def _embedding_start() -> None:
    from ..commands.local import _ollama_start
    embed_base = os.environ.get(
        "LOCAL_EMBEDDING_API_BASE",
        os.environ.get("OLLAMA_API_BASE", "http://localhost:11434"),
    )
    if _ollama_start(embed_base):
        info("Ollama started")
    else:
        warn("Ollama did not start — try: ollama serve")


def _embedding_stop() -> None:
    from .platform import is_macos, is_linux
    if is_macos() and shutil.which("brew"):
        subprocess.call(["brew", "services", "stop", "ollama"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info("Ollama stopped (brew)")
    elif is_linux() and shutil.which("systemctl"):
        subprocess.call(["sudo", "systemctl", "stop", "ollama"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info("Ollama stopped (systemd)")
    else:
        # Kill by name
        subprocess.call(["pkill", "-x", "ollama"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        info("Ollama stopped")


# Transcription (faster-whisper / speaches)
def _transcription_installed() -> bool:
    from ..commands.local import _find_transcription_bin
    return bool(_find_transcription_bin())


def _transcription_running() -> bool:
    from ..commands.local import _transcription_is_running
    transcr_base = os.environ.get(
        "LOCAL_TRANSCRIPTION_API_BASE", "http://localhost:10300/v1",
    )
    return _transcription_is_running(transcr_base)


def _transcription_start() -> None:
    from ..commands.local import install_transcription
    install_transcription()


def _transcription_stop() -> None:
    transcr_base = os.environ.get(
        "LOCAL_TRANSCRIPTION_API_BASE", "http://localhost:10300/v1",
    )
    import re
    m = re.search(r":(\d+)", transcr_base)
    port = int(m.group(1)) if m else 10300
    from .process import pids_on_port
    for pid in pids_on_port(port):
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
    info("Transcription server stopped")


# ── Registry ──────────────────────────────────────────────────────────────────

FEATURES: list[Feature] = [
    Feature(
        key="proxy", label="Proxy",
        is_installed=_proxy_installed, is_running=_proxy_running,
        start=_proxy_start, stop=_proxy_stop, restart=_proxy_restart,
    ),
    Feature(
        key="gateway", label="Gateway UI",
        is_installed=_gateway_installed, is_running=_gateway_running,
        start=_gateway_start, stop=_gateway_stop, restart=_gateway_restart,
    ),
    Feature(
        key="searxng", label="SearXNG",
        is_installed=_searxng_installed, is_running=_searxng_running,
        start=_searxng_start, stop=_searxng_stop,
    ),
    Feature(
        key="protonmail", label="ProtonMail",
        is_installed=_protonmail_installed, is_running=_protonmail_running,
        start=_protonmail_start, stop=_protonmail_stop,
    ),
    Feature(
        key="embedding", label="Embedding (Ollama)",
        is_installed=_embedding_installed, is_running=_embedding_running,
        start=_embedding_start, stop=_embedding_stop,
    ),
    Feature(
        key="transcription", label="Transcription",
        is_installed=_transcription_installed, is_running=_transcription_running,
        start=_transcription_start, stop=_transcription_stop,
    ),
]

FEATURE_MAP: dict[str, Feature] = {f.key: f for f in FEATURES}


def get_running_features() -> list[Feature]:
    """Return all features that are currently running."""
    load_env()
    return [f for f in FEATURES if f.is_running()]


def get_installed_features() -> list[Feature]:
    """Return all features that are installed."""
    load_env()
    return [f for f in FEATURES if f.is_installed()]


def get_stopped_features() -> list[Feature]:
    """Return installed features that are not running."""
    load_env()
    return [f for f in FEATURES if f.is_installed() and not f.is_running()]


def feature_stop(feat: Feature) -> None:
    """Stop a feature."""
    feat.stop()


def feature_start(feat: Feature) -> None:
    """Start a feature."""
    feat.start()


def feature_restart(feat: Feature) -> None:
    """Restart a feature (custom restart or stop+start)."""
    if feat.restart:
        feat.restart()
    else:
        feat.stop()
        import time
        time.sleep(1)
        feat.start()


def multi_select_features(
    candidates: list[Feature],
    action: str,
) -> list[Feature]:
    """Show a questionary multi-select for features. Returns selected list."""
    from .prompts import checkbox, choice

    if not candidates:
        return []

    choices = [
        choice(f.label, value=f, checked=True)
        for f in candidates
    ]

    return checkbox(f"Select features to {action}:", choices=choices)
