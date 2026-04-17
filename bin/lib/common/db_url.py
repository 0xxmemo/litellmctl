"""PostgreSQL URL helpers (parsing only — no server management)."""

from __future__ import annotations

import os
from urllib.parse import urlparse

from .platform import is_linux


def append_linux_socket_host_param(url: str) -> str:
    if not is_linux():
        return url
    if "host=" in url:
        return url
    if "?" in url:
        return f"{url}&host=%2Fvar%2Frun%2Fpostgresql"
    return f"{url}?host=%2Fvar%2Frun%2Fpostgresql"


def db_name_from_url(url: str = "") -> str:
    db_url = url or os.environ.get("DATABASE_URL", "")
    if not db_url:
        return "litellm"
    try:
        parsed = urlparse(db_url)
        name = (parsed.path.lstrip("/") or "litellm").split("?")[0]
        return name
    except Exception:
        return "litellm"


def db_user_from_url(url: str = "") -> str:
    db_url = url or os.environ.get("DATABASE_URL", "")
    default_user = os.environ.get("PGUSER", os.environ.get("USER", "postgres"))
    if not db_url:
        return default_user
    try:
        parsed = urlparse(db_url)
        return parsed.username or default_user
    except Exception:
        return default_user
