"""Install command — orchestrates base install + DB + local servers + gateway."""

from __future__ import annotations

import os
import subprocess
import sys

from ..common.paths import PROJECT_DIR, BIN_DIR, VENV_DIR, ENV_FILE
from ..common.env import load_env, patch_db_flags, patch_local_defaults
from ..common.formatting import info, warn, console
from ..common.platform import is_macos, is_linux, is_interactive

from .service import _activate_venv, cmd_restart
from .service import launchd_is_running, systemd_is_running, nohup_is_running
from .local import install_embedding, install_transcription
from .db import ensure_db_ready
from .gateway import install_gateway
from .searxng import install_searxng
from .protonmail import install_protonmail
from ..common.process import find_proxy_pid


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

    # DB setup
    if not db_mode:
        text = ENV_FILE.read_text() if ENV_FILE.exists() else ""
        if "DATABASE_URL=" in text:
            db_mode = "yes"
        elif is_interactive():
            from ..common.deps import require_questionary
            if require_questionary().confirm("Set up local PostgreSQL database for LiteLLM now?", default=True).ask():
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

    # Local inference servers
    import shutil
    os.environ["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{os.path.expanduser('~/.cargo/bin')}:{os.environ.get('PATH', '')}"

    if not embed_mode and shutil.which("ollama"):
        embed_mode = "yes"
    if not transcr_mode:
        if shutil.which("faster-whisper-server") or shutil.which("speaches"):
            transcr_mode = "yes"

    if not embed_mode and is_interactive():
        from ..common.deps import require_questionary
        if require_questionary().confirm("Set up local embedding server (Ollama)?", default=True).ask():
            embed_mode = "yes"
        else:
            embed_mode = "no"

    if not transcr_mode and is_interactive():
        from ..common.deps import require_questionary
        if require_questionary().confirm("Set up local transcription server (faster-whisper-server)?", default=True).ask():
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

    # SearXNG
    if not searxng_mode and shutil.which("docker"):
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True, text=True,
        )
        if "searxng" in result.stdout.splitlines():
            searxng_mode = "yes"

    if not searxng_mode and is_interactive():
        from ..common.deps import require_questionary
        if require_questionary().confirm("Set up SearXNG search server?", default=True).ask():
            searxng_mode = "yes"
        else:
            searxng_mode = "no"

    if searxng_mode == "yes":
        console.print()
        info("Setting up SearXNG search server")
        install_searxng()

    # Gateway
    if not gateway_mode and (PROJECT_DIR / "gateway").exists() and shutil.which("bun"):
        gateway_mode = "yes"

    if not gateway_mode and is_interactive():
        from ..common.deps import require_questionary
        if require_questionary().confirm("Set up LLM API Gateway UI?", default=True).ask():
            gateway_mode = "yes"
        else:
            gateway_mode = "no"

    if gateway_mode == "yes":
        console.print()
        info("Setting up LLM API Gateway UI")
        install_gateway()

    # ProtonMail
    if not proton_mode and shutil.which("hydroxide"):
        proton_mode = "yes"
    if not proton_mode:
        hydroxide_path = os.path.expanduser("~/go/bin/hydroxide")
        if os.path.isfile(hydroxide_path) and os.access(hydroxide_path, os.X_OK):
            proton_mode = "yes"

    if not proton_mode and gateway_mode == "yes" and is_interactive():
        from ..common.deps import require_questionary
        if require_questionary().confirm("Set up ProtonMail SMTP bridge (hydroxide) for OTP emails?", default=False).ask():
            proton_mode = "yes"
        else:
            proton_mode = "no"

    if proton_mode == "yes":
        console.print()
        info("Setting up ProtonMail SMTP bridge")
        install_protonmail()

    # Restart prompt
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
            from ..common.deps import require_questionary
            if require_questionary().confirm("Proxy is running. Restart now?", default=True).ask():
                cmd_restart()
            else:
                info("Skipped restart. Run 'litellmctl restart' when ready.")
        else:
            info("Proxy is running. Run 'litellmctl restart' to apply changes.")
