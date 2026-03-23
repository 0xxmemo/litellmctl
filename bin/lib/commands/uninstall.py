"""Uninstall command."""

from __future__ import annotations

import os

from ..common.env import load_env, remove_db_env_config
from ..common.formatting import console, info, warn, error
from ..common.platform import is_macos, is_linux, is_interactive
from ..common.process import get_proxy_port
from ..common.network import http_check, transcr_http_check

from .service import launchd_uninstall, systemd_uninstall, nohup_stop
from .gateway import uninstall_gateway, gateway_is_running
from .searxng import uninstall_searxng
from .protonmail import uninstall_protonmail
from ..common.paths import PROJECT_DIR, PIDFILE, PORT_FILE, SYSTEMD_FILE


def _uninstall_service() -> None:
    if is_macos():
        launchd_uninstall()
    elif is_linux() and SYSTEMD_FILE.exists():
        systemd_uninstall()
    else:
        nohup_stop()
        PIDFILE.unlink(missing_ok=True)
        PORT_FILE.unlink(missing_ok=True)
        info("Cleaned up nohup-managed proxy.")


def _uninstall_db() -> None:
    from .db import db_name_from_url
    env_file = PROJECT_DIR / ".env"
    if not env_file.exists():
        info("No database configuration found in .env.")
        return
    text = env_file.read_text()
    if "DATABASE_URL=" not in text:
        info("No database configuration found in .env.")
        return
    db_url = os.environ.get("DATABASE_URL", "postgresql://localhost/litellm")
    db_name = db_name_from_url(db_url)
    remove_db_env_config()
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("DISABLE_SCHEMA_UPDATE", None)
    info("Removed database config from .env.")
    console.print(f"  The database '{db_name}' was not dropped. To remove it:\n")
    console.print(f"      dropdb {db_name}\n")


def _uninstall_embedding() -> None:
    import shutil
    embed_base = os.environ.get(
        "LOCAL_EMBEDDING_API_BASE",
        os.environ.get("OLLAMA_API_BASE", "http://localhost:11434"),
    )
    console.print("\n  [bold]Ollama (embedding)[/]")
    if not shutil.which("ollama"):
        console.print("  Not installed.\n")
        return
    if http_check(f"{embed_base.rstrip('/')}/v1/models", timeout=2):
        console.print(f"  Running at {embed_base}. Stop it:\n")
        if is_macos() and shutil.which("brew"):
            console.print("      brew services stop ollama\n")
        else:
            console.print("      systemctl --user stop ollama 2>/dev/null || pkill ollama\n")
    else:
        console.print("  Not running.\n")
    console.print("  Uninstall:\n")
    if is_macos() and shutil.which("brew"):
        console.print("      brew uninstall ollama && rm -rf ~/.ollama\n")
    else:
        console.print("      sudo rm /usr/local/bin/ollama && rm -rf ~/.ollama\n")


def _uninstall_transcription() -> None:
    import shutil
    os.environ["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{os.path.expanduser('~/.cargo/bin')}:{os.environ.get('PATH', '')}"
    transcr_base = os.environ.get(
        "LOCAL_TRANSCRIPTION_API_BASE", "http://localhost:10300/v1",
    )
    console.print("\n  [bold]Transcription server[/]")
    found = False
    transcr_bin = ""
    if shutil.which("speaches"):
        transcr_bin = "speaches"
    elif shutil.which("faster-whisper-server"):
        transcr_bin = "faster-whisper-server"
    if transcr_bin:
        found = True
        if transcr_http_check(transcr_base.rstrip("/"), timeout=2):
            console.print(f"  Running at {transcr_base}. Stop it:\n")
            console.print(f"      pkill -f {transcr_bin}\n")
        else:
            console.print("  Not running.\n")
        console.print("  Uninstall:\n")
        if shutil.which("uv"):
            console.print(f"      uv tool uninstall {transcr_bin}\n")
        else:
            console.print(f"      pip uninstall {transcr_bin}\n")
    if shutil.which("docker"):
        import subprocess
        result = subprocess.run(
            ["docker", "ps", "-aq", "--filter", "name=faster-whisper"],
            capture_output=True, text=True,
        )
        if result.stdout.strip():
            found = True
            result2 = subprocess.run(
                ["docker", "ps", "-q", "--filter", "name=faster-whisper"],
                capture_output=True, text=True,
            )
            if result2.stdout.strip():
                console.print("  Docker container running. Stop and remove:\n")
                console.print("      docker stop faster-whisper && docker rm faster-whisper\n")
            else:
                console.print("  Docker container stopped. Remove:\n")
                console.print("      docker rm faster-whisper\n")
    if not found:
        console.print("  Not installed.\n")


UNINSTALL_TARGETS = [
    ("service", "Stop and remove proxy service"),
    ("db", "Remove database config from .env"),
    ("embedding", "Ollama stop/uninstall guide"),
    ("transcription", "faster-whisper-server stop/uninstall guide"),
    ("searxng", "SearXNG search server stop/remove"),
    ("gateway", "Gateway UI stop/remove guide"),
    ("protonmail", "ProtonMail bridge (hydroxide) stop/uninstall guide"),
]


def cmd_uninstall(target: str | None = None) -> None:
    load_env()

    if target is None and is_interactive():
        from ..common.prompts import select
        choices = [f"{name:<16} {desc}" for name, desc in UNINSTALL_TARGETS]
        choices.append("all              All of the above")
        result = select("Uninstall — select component:", choices)
        if result is None:
            return
        target = result.split()[0]

    target = target or "all"

    handlers = {
        "service": _uninstall_service,
        "db": _uninstall_db,
        "embedding": _uninstall_embedding,
        "transcription": _uninstall_transcription,
        "searxng": uninstall_searxng,
        "gateway": uninstall_gateway,
        "protonmail": uninstall_protonmail,
    }

    if target == "all":
        info("Stopping and removing proxy service ...")
        _uninstall_service()
        console.print()
        info("Removing database config ...")
        _uninstall_db()
        console.print("\n[bold]Local inference servers[/]")
        _uninstall_embedding()
        _uninstall_transcription()
        console.print("\n[bold]SearXNG search server[/]")
        uninstall_searxng()
        console.print("\n[bold]Gateway UI[/]")
        uninstall_gateway()
        console.print("\n[bold]ProtonMail bridge[/]")
        uninstall_protonmail()
    elif target in handlers:
        handlers[target]()
    else:
        error(f"Unknown target: {target}")
        console.print("  Usage: litellmctl uninstall [service|db|embedding|transcription|searxng|gateway|protonmail]")
