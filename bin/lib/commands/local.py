"""Local inference server management."""

from __future__ import annotations

import os
import subprocess
import time

from ..common.paths import PROJECT_DIR, LOG_DIR
from ..common.env import load_env
from ..common.formatting import console, info, warn
from ..common.platform import is_macos
from ..common.network import http_check, transcr_http_check


def local_status() -> None:
    embed_base = os.environ.get(
        "LOCAL_EMBEDDING_API_BASE",
        os.environ.get("OLLAMA_API_BASE", "http://localhost:11434"),
    )
    transcr_base = os.environ.get(
        "LOCAL_TRANSCRIPTION_API_BASE", "http://localhost:10300/v1",
    )

    console.print("[bold]Local inference servers[/]")

    if http_check(f"{embed_base.rstrip('/')}/v1/models"):
        console.print(f"  Embedding     ({embed_base}): [green]reachable[/]")
    else:
        console.print(f"  Embedding     ({embed_base}): [yellow]not running[/]")
        console.print("    [dim]Run: litellmctl install --with-local[/]")

    if transcr_http_check(transcr_base.rstrip("/")):
        console.print(f"  Transcription ({transcr_base}): [green]reachable[/]")
    else:
        console.print(f"  Transcription ({transcr_base}): [yellow]not running[/]")
        console.print("    [dim]Run: litellmctl install --with-local[/]")

    console.print()


def _ollama_start(embed_base: str) -> bool:
    import shutil
    if is_macos() and shutil.which("brew"):
        subprocess.call(["brew", "services", "start", "ollama"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.Popen(["ollama", "serve"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(12):
        time.sleep(1)
        if http_check(f"{embed_base.rstrip('/')}/v1/models", timeout=2):
            return True
    return False


def _fws_patch_pyproject() -> None:
    uv_python = os.path.expanduser("~/.local/share/uv/tools/faster-whisper-server/bin/python")
    if not os.path.isfile(uv_python):
        return
    try:
        result = subprocess.run(
            [uv_python, "-c",
             "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
            capture_output=True, text=True,
        )
        site_pkgs = result.stdout.strip()
    except Exception:
        return
    if not os.path.isdir(f"{site_pkgs}/faster_whisper_server"):
        return
    if os.path.isfile(f"{site_pkgs}/pyproject.toml"):
        return
    with open(f"{site_pkgs}/pyproject.toml", "w") as f:
        f.write('[project]\nname = "faster-whisper-server"\nversion = "0.0.0"\n')


def install_embedding() -> None:
    import shutil
    embed_base = os.environ.get(
        "LOCAL_EMBEDDING_API_BASE",
        os.environ.get("OLLAMA_API_BASE", "http://localhost:11434"),
    )

    if not shutil.which("ollama"):
        info("Ollama not found — installing ...")
        if is_macos() and shutil.which("brew"):
            subprocess.call(["brew", "install", "ollama"])
        elif shutil.which("curl"):
            subprocess.call(["bash", "-c", "curl -fsSL https://ollama.com/install.sh | sh"])
        else:
            warn("No brew or curl found — install Ollama manually: https://ollama.com/download")

    if shutil.which("ollama"):
        if http_check(f"{embed_base.rstrip('/')}/v1/models", timeout=2):
            info(f"Ollama already running at {embed_base}")
        else:
            info("Starting Ollama ...")
            if _ollama_start(embed_base):
                info(f"Ollama started at {embed_base}")
            else:
                warn("Ollama did not respond — start manually: ollama serve")

        for model in ["nomic-embed-text", "mxbai-embed-large"]:
            result = subprocess.run(["ollama", "list"], capture_output=True, text=True)
            if model not in result.stdout:
                info(f"Pulling {model} ...")
                subprocess.call(["ollama", "pull", model])
            else:
                info(f"{model} already present")
    else:
        warn("Ollama install failed — re-run after installing manually: litellmctl install --with-embedding")


def install_transcription() -> None:
    import shutil
    transcr_base = os.environ.get(
        "LOCAL_TRANSCRIPTION_API_BASE", "http://localhost:10300/v1",
    )

    os.environ["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{os.path.expanduser('~/.cargo/bin')}:{os.environ.get('PATH', '')}"

    transcr_bin = ""
    if shutil.which("faster-whisper-server"):
        ret = subprocess.call(["faster-whisper-server", "--help"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ret != 0:
            _fws_patch_pyproject()
        ret = subprocess.call(["faster-whisper-server", "--help"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ret == 0:
            transcr_bin = "faster-whisper-server"

    if not transcr_bin:
        if not shutil.which("uv") and shutil.which("curl"):
            info("Installing uv ...")
            subprocess.call(["bash", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"])
            os.environ["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{os.path.expanduser('~/.cargo/bin')}:{os.environ.get('PATH', '')}"

        if shutil.which("uv"):
            info("Installing faster-whisper-server (transcription server) ...")
            subprocess.call(["uv", "tool", "install", "faster-whisper-server"])
            _fws_patch_pyproject()
            if shutil.which("faster-whisper-server"):
                ret = subprocess.call(["faster-whisper-server", "--help"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if ret == 0:
                    transcr_bin = "faster-whisper-server"
                else:
                    warn("faster-whisper-server install failed")
        elif shutil.which("docker"):
            info("Starting transcription server via Docker ...")
            subprocess.call([
                "docker", "run", "-d", "--name", "faster-whisper",
                "-p", "10300:8000",
                "ghcr.io/fedirz/faster-whisper-server:latest-cpu",
            ])
        else:
            warn("No uv or docker found — install uv to enable transcription:")
            warn("  curl -LsSf https://astral.sh/uv/install.sh | sh")
            warn("  uv tool install faster-whisper-server")

    if transcr_bin:
        if transcr_http_check(transcr_base.rstrip("/"), timeout=2):
            info(f"Transcription server already running at {transcr_base}")
        else:
            info(f"Starting {transcr_bin} (first start downloads model — may take a minute) ...")
            # Extract port from base URL
            import re
            port_match = re.search(r":(\d+)", transcr_base)
            transcr_port = port_match.group(1) if port_match else "10300"
            transcr_log = LOG_DIR / "faster-whisper.log"
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            transcr_model = os.environ.get("LOCAL_TRANSCRIPTION_MODEL", "Systran/faster-whisper-tiny")

            log_f = open(transcr_log, "w")
            proc = subprocess.Popen(
                [transcr_bin, "--port", transcr_port, transcr_model],
                stdout=log_f, stderr=log_f,
            )

            import sys
            sys.stdout.write("  Waiting")
            sys.stdout.flush()
            for j in range(90):
                time.sleep(1)
                sys.stdout.write(".")
                sys.stdout.flush()
                try:
                    proc.wait(timeout=0)
                    print()
                    warn(f"{transcr_bin} exited unexpectedly. Logs: {transcr_log}")
                    break
                except subprocess.TimeoutExpired:
                    pass
                if transcr_http_check(transcr_base.rstrip("/"), timeout=2):
                    print()
                    break

            if transcr_http_check(transcr_base.rstrip("/"), timeout=2):
                info(f"{transcr_bin} started at {transcr_base}")
            elif proc.poll() is None:
                warn(f"{transcr_bin} still loading — check later: curl {transcr_base}/audio/transcriptions")
                info(f"Logs: {transcr_log}")
    elif transcr_http_check(transcr_base.rstrip("/"), timeout=2):
        info(f"Transcription server running at {transcr_base}")
    else:
        warn("Transcription server unavailable — re-run: litellmctl install --with-transcription")


def cmd_local(subcmd: str = "status") -> None:
    load_env()
    if subcmd == "status":
        local_status()
    else:
        from ..common.formatting import error
        error(f"Unknown subcommand: {subcmd}")
        console.print("  Usage: litellmctl local [status]")
        console.print("  To set up:   litellmctl install --with-local")
        console.print("  To uninstall: litellmctl uninstall [embedding|transcription]")
