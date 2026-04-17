"""Project paths and service identifiers."""

from pathlib import Path
import os


def _bin_dir() -> Path:
    return Path(__file__).resolve().parent.parent.parent  # bin/lib/common -> bin


INSTALL_ROOT = _bin_dir().parent


def _resolve_project_dir() -> Path:
    """User data directory: config.yaml, .env, auth files, logs.

    Set LITELLMCTL_HOME to separate data from the install tree (e.g. Docker volume).
    """
    env = os.environ.get("LITELLMCTL_HOME")
    if env:
        return Path(env).resolve()
    if (INSTALL_ROOT / "config.yaml").exists():
        return INSTALL_ROOT
    return Path.home() / ".litellm"


PROJECT_DIR = _resolve_project_dir()
BIN_DIR = INSTALL_ROOT / "bin"
VENV_DIR = INSTALL_ROOT / "venv"
PORT_FILE = PROJECT_DIR / ".proxy-port"
LOG_DIR = PROJECT_DIR / "logs"
CONFIG_FILE = PROJECT_DIR / "config.yaml"
ENV_FILE = PROJECT_DIR / ".env"
# Prefer templates and .env.example next to user data when present; otherwise install tree
# (supports LITELLMCTL_HOME pointing at a volume while templates ship in the image).
_tdir = PROJECT_DIR / "templates"
TEMPLATES_DIR = _tdir if _tdir.exists() else (INSTALL_ROOT / "templates")
_env_ex = PROJECT_DIR / ".env.example"
ENV_EXAMPLE = _env_ex if _env_ex.exists() else (INSTALL_ROOT / ".env.example")
PIDFILE = PROJECT_DIR / ".proxy.pid"

# Service identifiers — Proxy
LAUNCHD_LABEL = "com.litellm.proxy"
LAUNCHD_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
SYSTEMD_UNIT = "litellm-proxy"
SYSTEMD_DIR = Path.home() / ".config" / "systemd" / "user"
SYSTEMD_FILE = SYSTEMD_DIR / f"{SYSTEMD_UNIT}.service"

# Service identifiers — Gateway
GATEWAY_LAUNCHD_LABEL = "com.litellm.gateway"
GATEWAY_LAUNCHD_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{GATEWAY_LAUNCHD_LABEL}.plist"
GATEWAY_SYSTEMD_UNIT = "litellm-gateway"
GATEWAY_SYSTEMD_FILE = SYSTEMD_DIR / f"{GATEWAY_SYSTEMD_UNIT}.service"
GATEWAY_PIDFILE = PROJECT_DIR / "gateway" / ".gateway.pid"
