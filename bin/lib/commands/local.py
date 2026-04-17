"""Local inference server management."""

from __future__ import annotations

import os
import subprocess
import time

from ..common.paths import PROJECT_DIR, LOG_DIR
from ..common.env import load_env
from ..common.formatting import console, info, warn
from ..common.platform import is_macos, is_linux
from ..common.network import ollama_server_check, transcr_http_check, port_in_use


def _extract_port(url: str) -> int:
    """Extract port number from a URL, defaulting to 80."""
    import re
    m = re.search(r":(\d+)", url)
    return int(m.group(1)) if m else 80


def _ollama_is_running(embed_base: str) -> bool:
    """Check if Ollama is running — port check first, then HTTP."""
    port = _extract_port(embed_base)
    if port_in_use(port):
        return True
    return ollama_server_check(embed_base, timeout=2)


def _transcription_is_running(transcr_base: str) -> bool:
    """Check if transcription server is running — port check first, then HTTP."""
    port = _extract_port(transcr_base)
    if port_in_use(port):
        return True
    return transcr_http_check(transcr_base.rstrip("/"), timeout=2)


def local_status() -> None:
    embed_base = os.environ.get(
        "LOCAL_EMBEDDING_API_BASE",
        os.environ.get("OLLAMA_API_BASE", "http://localhost:11434"),
    )
    transcr_base = os.environ.get(
        "LOCAL_TRANSCRIPTION_API_BASE", "http://localhost:10300/v1",
    )

    console.print("[bold]Local inference servers[/]")

    if _ollama_is_running(embed_base):
        console.print(f"  Embedding     ({embed_base}): [green]reachable[/]")
    else:
        console.print(f"  Embedding     ({embed_base}): [yellow]not running[/]")
        console.print("    [dim]Run: litellmctl install --with-local[/]")

    if _transcription_is_running(transcr_base):
        console.print(f"  Transcription ({transcr_base}): [green]reachable[/]")
    else:
        console.print(f"  Transcription ({transcr_base}): [yellow]not running[/]")
        console.print("    [dim]Run: litellmctl install --with-local[/]")

    console.print()


def _ollama_start(embed_base: str) -> bool:
    """Start Ollama and wait for it to respond. Tries systemd first on Linux."""
    import shutil

    if is_macos() and shutil.which("brew"):
        subprocess.call(["brew", "services", "start", "ollama"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif is_linux() and shutil.which("systemctl"):
        # The curl installer creates a system-level ollama.service.
        # Use sudo directly — bare systemctl triggers polkit which prompts
        # for a password (breaks headless/EC2 with key-based auth).
        subprocess.call(["sudo", "systemctl", "start", "ollama"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # If systemd failed (service not installed), fall back to ollama serve
        if subprocess.call(["systemctl", "is-active", "--quiet", "ollama"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
            subprocess.Popen(["ollama", "serve"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    else:
        subprocess.Popen(["ollama", "serve"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)

    for _ in range(15):
        time.sleep(1)
        if _ollama_is_running(embed_base):
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


def _speaches_patch_pyproject() -> None:
    uv_python = os.path.expanduser("~/.local/share/uv/tools/speaches/bin/python")
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
    if not os.path.isdir(f"{site_pkgs}/speaches"):
        return
    if os.path.isfile(f"{site_pkgs}/pyproject.toml"):
        return
    with open(f"{site_pkgs}/pyproject.toml", "w") as f:
        f.write('[project]\nname = "speaches"\nversion = "0.0.0"\n')


def _find_transcription_bin() -> str:
    """Find available transcription binary: speaches or faster-whisper-server."""
    import shutil
    for name in ("speaches", "faster-whisper-server"):
        if shutil.which(name):
            ret = subprocess.call([name, "--help"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ret != 0:
                if name == "faster-whisper-server":
                    _fws_patch_pyproject()
                elif name == "speaches":
                    _speaches_patch_pyproject()
                ret = subprocess.call([name, "--help"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ret == 0:
                return name
    return ""


def _build_transcription_cmd(transcr_bin: str, port: str, model: str) -> list[str]:
    """Build the command to start the transcription server.

    Probe the binary's --help to detect which CLI style it uses:
    - older faster-whisper-server: positional model arg + --port flag
    - speaches / newer: env vars (WHISPER__MODEL, UVICORN_PORT) or --model flag
    """
    # Always set env vars as a safety net
    os.environ["UVICORN_PORT"] = port
    os.environ["UVICORN_HOST"] = "0.0.0.0"
    os.environ["WHISPER__MODEL"] = model

    # Probe --help output to detect supported flags
    try:
        result = subprocess.run(
            [transcr_bin, "--help"],
            capture_output=True, text=True, timeout=10,
        )
        help_text = result.stdout + result.stderr
    except Exception:
        help_text = ""

    if "--model" in help_text:
        # speaches / newer faster-whisper-server with --model flag
        return [transcr_bin, "--host", "0.0.0.0", "--port", port, "--model", model]
    else:
        # older faster-whisper-server: model is a positional arg
        return [transcr_bin, "--host", "0.0.0.0", "--port", port, model]


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
        if _ollama_is_running(embed_base):
            info(f"Ollama already running at {embed_base}")
        else:
            info("Starting Ollama ...")
            if _ollama_start(embed_base):
                info(f"Ollama started at {embed_base}")
            else:
                # Check if systemd service exists but failed
                if is_linux() and shutil.which("systemctl"):
                    svc = subprocess.run(
                        ["systemctl", "is-enabled", "--quiet", "ollama"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                    if svc.returncode == 0:
                        status = subprocess.run(
                            ["systemctl", "status", "ollama", "--no-pager", "-l"],
                            capture_output=True, text=True,
                        )
                        warn("Ollama did not respond. Service status:")
                        for line in status.stdout.strip().splitlines()[:8]:
                            console.print(f"    {line}")
                    else:
                        warn("Ollama did not respond — service not installed.")
                        warn("  Reinstall: curl -fsSL https://ollama.com/install.sh | sh")
                else:
                    warn("Ollama did not respond — start manually: ollama serve")

        embed_model = "nomic-embed-text-v2-moe"
        result = subprocess.run(["ollama", "list"], capture_output=True, text=True)
        if embed_model not in result.stdout:
            info(f"Pulling {embed_model} ...")
            subprocess.call(["ollama", "pull", embed_model])
        else:
            info(f"{embed_model} already present")
    else:
        warn("Ollama install failed — re-run after installing manually: litellmctl install --with-embedding")


def install_transcription() -> None:
    import shutil
    import re

    transcr_base = os.environ.get(
        "LOCAL_TRANSCRIPTION_API_BASE", "http://localhost:10300/v1",
    )

    os.environ["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{os.path.expanduser('~/.cargo/bin')}:{os.environ.get('PATH', '')}"

    transcr_bin = _find_transcription_bin()

    if not transcr_bin:
        if not shutil.which("uv") and shutil.which("curl"):
            info("Installing uv ...")
            subprocess.call(["bash", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"])
            os.environ["PATH"] = f"{os.path.expanduser('~/.local/bin')}:{os.path.expanduser('~/.cargo/bin')}:{os.environ.get('PATH', '')}"

        if shutil.which("uv"):
            # Single supported stack: speaches (actively maintained OpenAI-compatible server)
            info("Installing speaches (transcription server) ...")
            ret = subprocess.call(["uv", "tool", "install", "speaches"])
            if ret == 0:
                _speaches_patch_pyproject()
                transcr_bin = _find_transcription_bin()
            if not transcr_bin:
                warn("speaches install failed or no working binary — see https://github.com/speaches-ai/speaches")
        elif shutil.which("docker"):
            info("Starting transcription server via Docker ...")
            subprocess.call([
                "docker", "run", "-d", "--name", "faster-whisper",
                "-p", "10300:8000",
                "-e", "WHISPER__MODEL=Systran/faster-whisper-tiny",
                "ghcr.io/speaches-ai/speaches:latest-cpu",
            ])
        else:
            warn("No uv or docker found — install uv to enable transcription:")
            warn("  curl -LsSf https://astral.sh/uv/install.sh | sh")
            warn("  uv tool install speaches")

    if transcr_bin:
        if _transcription_is_running(transcr_base):
            info(f"Transcription server already running at {transcr_base}")
        else:
            port_match = re.search(r":(\d+)", transcr_base)
            transcr_port = port_match.group(1) if port_match else "10300"
            transcr_log = LOG_DIR / "faster-whisper.log"
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            transcr_model = os.environ.get("LOCAL_TRANSCRIPTION_MODEL", "Systran/faster-whisper-tiny")

            cmd = _build_transcription_cmd(transcr_bin, transcr_port, transcr_model)
            info(f"Starting {transcr_bin} (first start downloads model — may take a minute) ...")

            log_f = open(transcr_log, "w")
            proc = subprocess.Popen(
                cmd,
                stdout=log_f, stderr=log_f,
                start_new_session=True,
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
                    # Read last few lines of log for diagnostics
                    try:
                        lines = transcr_log.read_text().strip().splitlines()
                        tail = "\n    ".join(lines[-5:]) if lines else "(empty)"
                    except Exception:
                        tail = "(could not read)"
                    warn(f"{transcr_bin} exited unexpectedly (code {proc.returncode})")
                    warn(f"  Log tail:\n    {tail}")
                    warn(f"  Full logs: {transcr_log}")
                    break
                except subprocess.TimeoutExpired:
                    pass
                if _transcription_is_running(transcr_base):
                    print()
                    break

            if transcr_http_check(transcr_base.rstrip("/"), timeout=2):
                info(f"{transcr_bin} started at {transcr_base}")
            elif proc.poll() is None:
                warn(f"{transcr_bin} still loading — check later: curl {transcr_base}/audio/transcriptions")
                info(f"Logs: {transcr_log}")
    elif _transcription_is_running(transcr_base):
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
