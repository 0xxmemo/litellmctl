"""Install command — orchestrates base install + DB + local servers + gateway."""

from __future__ import annotations

import os
import subprocess

from ..common.paths import PROJECT_DIR, BIN_DIR, ENV_FILE
from ..common.env import load_env, patch_db_flags, patch_local_defaults
from ..common.formatting import info, warn, console
from ..common.platform import is_macos, is_linux, is_interactive
from ..common.network import port_in_use

from .service import _activate_venv, cmd_restart
from .service import launchd_is_running, systemd_is_running, nohup_is_running
from .local import install_embedding, install_transcription, _ollama_is_running, _transcription_is_running
from .db import ensure_db_ready
from .gateway import install_gateway, gateway_is_running
from .searxng import install_searxng
from .protonmail import install_protonmail
from ..common.process import find_proxy_pid


def _confirm(prompt: str, default: bool = True) -> bool:
    """Interactive confirm — lazy-loads questionary."""
    from ..common.deps import require_questionary
    return require_questionary().confirm(prompt, default=default).ask()


def cmd_install(
    *,
    db_mode: str = "",
    embed_mode: str = "",
    transcr_mode: str = "",
    searxng_mode: str = "",
    gateway_mode: str = "",
    proton_mode: str = "",
    install_args: list[str] | None = None,
    post_sync_only: bool = False,
) -> None:
    if not post_sync_only:
        pre_sha = subprocess.run(
            ["git", "-C", str(PROJECT_DIR), "rev-parse", "HEAD"],
            capture_output=True, text=True,
        ).stdout.strip()

        cmd = [str(BIN_DIR / "install")]
        if install_args:
            cmd.extend(install_args)
        subprocess.call(cmd)

        post_sha = subprocess.run(
            ["git", "-C", str(PROJECT_DIR), "rev-parse", "HEAD"],
            capture_output=True, text=True,
        ).stdout.strip()

        if pre_sha and post_sha and pre_sha != post_sha:
            info("Repository updated during install. Reloading latest litellmctl ...")
            reexec = [str(PROJECT_DIR / "bin" / "litellmctl"), "install", "--_post-sync"]
            if db_mode == "yes":
                reexec.append("--with-db")
            elif db_mode == "no":
                reexec.append("--without-db")
            if embed_mode == "yes":
                reexec.append("--with-embedding")
            elif embed_mode == "no":
                reexec.append("--without-embedding")
            if transcr_mode == "yes":
                reexec.append("--with-transcription")
            elif transcr_mode == "no":
                reexec.append("--without-transcription")
            if searxng_mode == "yes":
                reexec.append("--with-searxng")
            elif searxng_mode == "no":
                reexec.append("--without-searxng")
            if gateway_mode == "yes":
                reexec.append("--with-gateway")
            elif gateway_mode == "no":
                reexec.append("--without-gateway")
            if proton_mode == "yes":
                reexec.append("--with-protonmail")
            elif proton_mode == "no":
                reexec.append("--without-protonmail")
            os.execvp(reexec[0], reexec)

    _activate_venv()
    load_env()

    # ── DB setup ──────────────────────────────────────────────────────────
    if not db_mode:
        text = ENV_FILE.read_text() if ENV_FILE.exists() else ""
        if "DATABASE_URL=" in text:
            db_mode = "yes"
        elif is_interactive():
            if _confirm("Set up local PostgreSQL database for LiteLLM now?"):
                db_mode = "yes"
            else:
                db_mode = "no"
        else:
            db_mode = "yes"

    if db_mode == "yes":
        if not ensure_db_ready():
            warn("DB setup incomplete. Run 'litellmctl install --with-db' to retry.")
        load_env()
        patch_db_flags()
    else:
        warn("Skipped local DB setup.")
        info("Run 'litellmctl install --with-db' to enable.")

    patch_local_defaults()
    load_env()

    # ── Local inference servers ────────────────────────────────────────────
    import shutil
    os.environ["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{os.path.expanduser('~/.cargo/bin')}:{os.environ.get('PATH', '')}"

    embed_base = os.environ.get(
        "LOCAL_EMBEDDING_API_BASE",
        os.environ.get("OLLAMA_API_BASE", "http://localhost:11434"),
    )
    transcr_base = os.environ.get(
        "LOCAL_TRANSCRIPTION_API_BASE", "http://localhost:10300/v1",
    )

    # Auto-detect: skip if already running, install if binary found but not running
    if not embed_mode:
        if _ollama_is_running(embed_base):
            info(f"Embedding server already running at {embed_base}")
        elif shutil.which("ollama"):
            embed_mode = "yes"
        elif is_interactive():
            if _confirm("Set up local embedding server (Ollama)?"):
                embed_mode = "yes"
            else:
                embed_mode = "no"

    if not transcr_mode:
        if _transcription_is_running(transcr_base):
            info(f"Transcription server already running at {transcr_base}")
        elif shutil.which("faster-whisper-server") or shutil.which("speaches"):
            transcr_mode = "yes"
        elif is_interactive():
            if _confirm("Set up local transcription server (faster-whisper-server)?"):
                transcr_mode = "yes"
            else:
                transcr_mode = "no"

    if embed_mode == "yes" or transcr_mode == "yes":
        console.print()
        info("Setting up local inference servers")
        if embed_mode == "yes":
            install_embedding()
        if transcr_mode == "yes":
            install_transcription()

    # ── SearXNG ───────────────────────────────────────────────────────────
    if not searxng_mode:
        if shutil.which("docker"):
            result = subprocess.run(
                ["docker", "ps", "--format", "{{.Names}}"],
                capture_output=True, text=True,
            )
            if "searxng" in result.stdout.splitlines():
                info("SearXNG already running — skipping")
            elif is_interactive():
                if _confirm("Set up SearXNG search server?"):
                    searxng_mode = "yes"
                else:
                    searxng_mode = "no"
        elif is_interactive():
            if _confirm("Set up SearXNG search server?"):
                searxng_mode = "yes"
            else:
                searxng_mode = "no"

    if searxng_mode == "yes":
        console.print()
        install_searxng()

    # ── Gateway ───────────────────────────────────────────────────────────
    if not gateway_mode:
        if gateway_is_running():
            info("Gateway already running — skipping")
        elif (PROJECT_DIR / "gateway" / "dist").exists():
            info("Gateway already built — start with: litellmctl gateway start")
        elif (PROJECT_DIR / "gateway").exists() and shutil.which("bun"):
            gateway_mode = "yes"
        elif is_interactive():
            if _confirm("Set up LLM API Gateway UI?"):
                gateway_mode = "yes"
            else:
                gateway_mode = "no"

    if gateway_mode == "yes":
        console.print()
        info("Setting up LLM API Gateway UI")
        install_gateway()

    # ── ProtonMail ────────────────────────────────────────────────────────
    if not proton_mode:
        if port_in_use(1025):
            info("ProtonMail bridge already running — skipping")
        elif shutil.which("hydroxide"):
            pass  # installed but not running — don't reinstall, don't prompt
        else:
            hydroxide_path = os.path.expanduser("~/go/bin/hydroxide")
            if os.path.isfile(hydroxide_path) and os.access(hydroxide_path, os.X_OK):
                pass  # installed but not running
            elif gateway_mode == "yes" and is_interactive():
                if _confirm("Set up ProtonMail SMTP bridge (hydroxide) for OTP emails?", default=False):
                    proton_mode = "yes"
                else:
                    proton_mode = "no"

    if proton_mode == "yes":
        console.print()
        info("Setting up ProtonMail SMTP bridge")
        install_protonmail()

    # ── Restart prompt ────────────────────────────────────────────────────
    running = False
    if is_macos() and launchd_is_running():
        running = True
    if is_linux() and systemd_is_running():
        running = True
    if nohup_is_running():
        running = True
    if find_proxy_pid():
        running = True

    if running:
        if is_interactive():
            if _confirm("Proxy is running. Restart now?"):
                cmd_restart()
            else:
                info("Skipped restart. Run 'litellmctl restart' when ready.")
        else:
            info("Proxy is running. Run 'litellmctl restart' to apply changes.")
