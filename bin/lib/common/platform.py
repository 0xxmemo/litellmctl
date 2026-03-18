"""Platform detection utilities."""

from __future__ import annotations

import os
import platform
import subprocess
import sys


def is_macos() -> bool:
    return platform.system() == "Darwin"


def is_linux() -> bool:
    return platform.system() == "Linux"


def is_interactive() -> bool:
    """True if stdin is a TTY."""
    return sys.stdin.isatty()


def detect_os() -> str:
    """Return a human-readable OS name."""
    s = platform.system()
    if s == "Darwin":
        return "macOS"
    if s == "Linux":
        try:
            with open("/etc/os-release") as f:
                for line in f:
                    if line.startswith("PRETTY_NAME="):
                        return line.split("=", 1)[1].strip().strip('"')
        except FileNotFoundError:
            pass
        return "Linux"
    return s


def run_with_sudo(*args: str) -> int:
    """Run a command, trying sudo if needed. Returns exit code."""
    if os.geteuid() == 0:
        return subprocess.call(args)
    # Try non-interactive sudo first
    try:
        ret = subprocess.call(["sudo", "-n", *args],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ret == 0:
            return 0
    except FileNotFoundError:
        pass
    # Interactive sudo if TTY available
    if is_interactive():
        return subprocess.call(["sudo", *args])
    return 1


def has_systemd_user() -> bool:
    """Check if systemd --user is available and responsive."""
    if not os.environ.get("XDG_RUNTIME_DIR"):
        return False
    import shutil
    if not shutil.which("systemctl"):
        return False
    try:
        timeout_bin = shutil.which("timeout")
        if timeout_bin:
            ret = subprocess.call(
                [timeout_bin, "-k", "3", "5", "systemctl", "--user", "status"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            ret = subprocess.call(
                ["systemctl", "--user", "status"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        return ret in (0, 3)  # 3 = no units found but bus works
    except Exception:
        return False
