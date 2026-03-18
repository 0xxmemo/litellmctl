"""Project paths and service identifiers."""

from pathlib import Path
import os

def _resolve_project_dir() -> Path:
    """Resolve project directory, handling symlinks."""
    bin_dir = Path(__file__).resolve().parent.parent.parent  # bin/lib/common -> bin
    project = bin_dir.parent
    if (project / "config.yaml").exists():
        return project
    return Path.home() / ".litellm"

PROJECT_DIR = _resolve_project_dir()
BIN_DIR = PROJECT_DIR / "bin"
VENV_DIR = PROJECT_DIR / "venv"
PORT_FILE = PROJECT_DIR / ".proxy-port"
LOG_DIR = PROJECT_DIR / "logs"
CONFIG_FILE = PROJECT_DIR / "config.yaml"
ENV_FILE = PROJECT_DIR / ".env"
ENV_EXAMPLE = PROJECT_DIR / ".env.example"
TEMPLATES_DIR = PROJECT_DIR / "templates"
PIDFILE = PROJECT_DIR / ".proxy.pid"

# Service identifiers
LAUNCHD_LABEL = "com.litellm.proxy"
LAUNCHD_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
SYSTEMD_UNIT = "litellm-proxy"
SYSTEMD_DIR = Path.home() / ".config" / "systemd" / "user"
SYSTEMD_FILE = SYSTEMD_DIR / f"{SYSTEMD_UNIT}.service"
