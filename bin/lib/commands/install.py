"""Install command — orchestrates base install + local servers + gateway."""

from __future__ import annotations

import os
import subprocess

from ..common.paths import PROJECT_DIR, BIN_DIR
from ..common.env import load_env, patch_local_defaults, patch_perf_defaults
from ..common.formatting import info, warn, console
from ..common.platform import is_macos, is_linux, is_interactive
from ..common.network import port_in_use

from .service import _activate_venv, cmd_restart
from .service import launchd_is_running, systemd_is_running, nohup_is_running
from .local import install_embedding, install_transcription, _ollama_is_running, _transcription_is_running
from .gateway import install_gateway, gateway_is_running
from .searxng import install_searxng
from .protonmail import install_protonmail
from ..common.process import find_proxy_pid
from ..common.prompts import confirm as _confirm


def _resolve_install_mode(
    current_mode: str,
    *,
    service_name: str,
    running: bool,
    installed: bool,
    setup_prompt: str,
    start_prompt: str,
    start_hint: str,
    running_message: str | None = None,
) -> str:
    """Decide whether to install/start a service, with consistent prompting."""
    if current_mode:
        return current_mode

    if running:
        info(running_message or f"{service_name} already running — skipping")
        return "no"

    if installed:
        if is_interactive():
            if _confirm(start_prompt, default=False):
                return "yes"
            info(f"Skipped starting {service_name}. Run '{start_hint}' when ready.")
        else:
            info(f"{service_name} is installed but not running.")
            info(f"Run '{start_hint}' to start it.")
        return "no"

    if is_interactive():
        return "yes" if _confirm(setup_prompt) else "no"

    return current_mode


def cmd_install(
    *,
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

    patch_local_defaults()
    patch_perf_defaults()
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

    embed_mode = _resolve_install_mode(
        embed_mode,
        service_name="embedding server (Ollama)",
        running=_ollama_is_running(embed_base),
        installed=bool(shutil.which("ollama")),
        setup_prompt="Set up local embedding server (Ollama)?",
        start_prompt="Ollama is installed but not running. Start it now?",
        start_hint="litellmctl install --with-embedding",
        running_message=f"Embedding server already running at {embed_base}",
    )

    transcr_mode = _resolve_install_mode(
        transcr_mode,
        service_name="transcription server",
        running=_transcription_is_running(transcr_base),
        installed=bool(shutil.which("speaches") or shutil.which("faster-whisper-server")),
        setup_prompt="Set up local transcription server (speaches)?",
        start_prompt="Transcription server is installed but not running. Start it now?",
        start_hint="litellmctl install --with-transcription",
        running_message=f"Transcription server already running at {transcr_base}",
    )

    if embed_mode == "yes" or transcr_mode == "yes":
        console.print()
        info("Setting up local inference servers")
        if embed_mode == "yes":
            install_embedding()
        if transcr_mode == "yes":
            install_transcription()

    # ── SearXNG ───────────────────────────────────────────────────────────
    searxng_running = False
    searxng_installed = False
    if shutil.which("docker"):
        running_result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True, text=True,
        )
        searxng_running = "searxng" in running_result.stdout.splitlines()

        installed_result = subprocess.run(
            ["docker", "ps", "-a", "--format", "{{.Names}}"],
            capture_output=True, text=True,
        )
        searxng_installed = "searxng" in installed_result.stdout.splitlines()

    searxng_mode = _resolve_install_mode(
        searxng_mode,
        service_name="SearXNG",
        running=searxng_running,
        installed=searxng_installed,
        setup_prompt="Set up SearXNG search server?",
        start_prompt="SearXNG is installed but stopped. Start it now?",
        start_hint="docker start searxng",
        running_message="SearXNG already running — skipping",
    )

    if searxng_mode == "yes":
        console.print()
        install_searxng()

    # ── Gateway ───────────────────────────────────────────────────────────
    if not gateway_mode:
        if gateway_is_running():
            info("Gateway already running — skipping")
        elif (PROJECT_DIR / "gateway" / "dist").exists():
            info("Gateway already built — start with: litellmctl start gateway")
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
